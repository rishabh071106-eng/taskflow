// ElevenLabs voice helpers shared by Bro (live replies), the News bulletin, Hindi books and language lessons.
//  • pickVoice(key, lang, getSetting): a proper narrator voice per language. Order: Admin setting ELEVEN_VOICE_<LANG>
//    → env → the account's voices matched by preferred names (warm, mature, male narrators) → the Adam default.
//  • speak(key, text, lang, voiceId, opts): text → mp3 Buffer with eleven_turbo_v2_5, which accepts language_code
//    (eleven_multilingual_v2 rejects language_code with HTTP 400 — the bug that left every recording silent).
'use strict';
const DEFAULT = 'pNInz6obpgDQGcFmaJgB'; // Adam
const MODEL = 'eleven_turbo_v2_5';
const PREF = {
  en: ['Brian', 'George', 'Daniel', 'Adam', 'Antoni', 'Josh', 'Liam', 'Will'],
  hi: ['Adam', 'Brian', 'George', 'Daniel', 'Antoni'],
  es: ['Antoni', 'Josh', 'Adam', 'Brian', 'George'],
  fr: ['Antoni', 'George', 'Adam', 'Brian'],
  de: ['Daniel', 'George', 'Adam', 'Brian'],
  ja: ['Adam', 'Brian', 'George'],
};
// v14: Bro has ONE deep voice everywhere (chat, language lessons, books). Admin → "Bro's voice" picks one of these
// premade voices (or pastes any voice id) as BRO_VOICE; Brian is the default.
const BRO_VOICES = { brian: 'nPczCjzI2devNBz1zQrb', adam: 'pNInz6obpgDQGcFmaJgB', daniel: 'onwK4e9ZLuTAKqWW03F9', george: 'JBFqnCBsd6RMkjVDRZzb' };
function broVoice(getSetting) {
  const v = String((typeof getSetting === 'function' && getSetting('BRO_VOICE')) || process.env.BRO_VOICE || '').trim();
  return BRO_VOICES[v.toLowerCase()] || (/^[A-Za-z0-9]{16,40}$/.test(v) ? v : BRO_VOICES.brian);
}
let cache = { at: 0, key: '', voices: null };

async function listVoices(key) {
  if (!key) return [];
  if (cache.voices && cache.key === key && Date.now() - cache.at < 3600e3) return cache.voices;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: ctrl.signal });
    if (!r.ok) { cache = { at: Date.now() - 3000e3, key, voices: cache.voices || [] }; return cache.voices; } // retry in 10 min, not on every call
    const j = await r.json();
    cache = { at: Date.now(), key, voices: (j.voices || []).map(v => ({ id: v.voice_id, name: String(v.name || ''), labels: v.labels || {}, category: v.category || '', preview: v.preview_url || '' })) };
    return cache.voices;
  } catch (e) { cache = { at: Date.now() - 3000e3, key, voices: cache.voices || [] }; return cache.voices; } finally { clearTimeout(t); }
}

async function pickVoice(key, lang, getSetting) {
  const l = String(lang || 'en').toLowerCase().slice(0, 2);
  const k = 'ELEVEN_VOICE_' + l.toUpperCase();
  try { const s = typeof getSetting === 'function' ? getSetting(k) : ''; if (s) return s; } catch (e) {}
  if (process.env[k]) return process.env[k];
  try {
    const vs = await listVoices(key);
    for (const n of (PREF[l] || PREF.en)) { const v = vs.find(x => x.name.toLowerCase() === n.toLowerCase()); if (v) return v.id; }
    const male = vs.find(x => /^male$/i.test(String(x.labels.gender || '')) && /premade|professional/i.test(x.category));
    if (male) return male.id;
  } catch (e) { /* fall through */ }
  return DEFAULT;
}

function chunk(text, max) {
  const out = []; let cur = '';
  for (const s of String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?।])\s+/)) {
    if ((cur + ' ' + s).length > max && cur) { out.push(cur.trim()); cur = s; } else cur += ' ' + s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function speak(key, text, lang, voiceId, opts) {
  opts = opts || {};
  const l = String(lang || 'en').toLowerCase().slice(0, 2);
  const voice = voiceId || DEFAULT;
  const bufs = [];
  for (const c of chunk(text, opts.chunk || 3800)) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${opts.format || 'mp3_44100_128'}`, {
        method: 'POST', signal: ctrl.signal, headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: c, model_id: opts.model || MODEL, language_code: l, voice_settings: Object.assign({ stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true }, opts.speed ? { speed: opts.speed } : {}, opts.voice_settings || {}) }),
      });
      if (!r.ok) { const body = (await r.text()).slice(0, 300); const e = new Error('ElevenLabs ' + r.status + ' ' + body.slice(0, 200)); e.status = r.status; if (isQuota(r.status, body)) { e.code = 'credits'; markOut(key); } else if (r.status === 401) e.code = 'key'; throw e; }
      bufs.push(Buffer.from(await r.arrayBuffer()));
    } finally { clearTimeout(t); }
  }
  return Buffer.concat(bufs);
}

// ── credit guard ──
// ElevenLabs bills credits per character (turbo/flash ≈ 0.5 credit per character). We read the plan's monthly allowance and
// keep a reserve so bulk recordings never eat the credits Bro's live voice and the daily bulletin need, and nothing ever
// runs past the allowance into overage. Purposes: 'live' (Bro talking) may use everything that is left; 'daily' (bulletin,
// News headlines, first plays of course lines) stops with 15% of the month left for Bro; 'bulk' (Python + language narration,
// language lessons, Hindi books: recorded once, kept forever) may use the first 70%.
const PER_CHAR = () => parseFloat(process.env.ELEVEN_CREDITS_PER_CHAR || '') || 0.5;
const subs = new Map(); // key → { at, tier, used, limit, reset, ok, error, out }
// Credits approved but not yet visible in the plan's count. Kept apart from the plan snapshot so a refresh can't wipe them;
// a hold is dropped once a refresh taken a minute after it (ElevenLabs has counted it by then) or when its call fails.
const holds = new Map(); // key → [{ id, credits, at }]
const inflight = new Map(); // key → pending subscription fetch (one request at a time per key)
let holdSeq = 0;
const held = key => (holds.get(key) || []).reduce((n, h) => n + h.credits, 0);
function release(key, id) { const l = holds.get(key); if (l) holds.set(key, l.filter(h => h.id !== id)); }
const isQuota = (status, body) => status === 402 || /quota_exceeded|exceeds your quota|insufficient.*credits|credits? (remaining|left)|payment_required/i.test(String(body || ''));
function markOut(key) { const s = subs.get(key) || {}; s.out = Date.now(); subs.set(key, s); }
async function subscription(key, fresh) {
  if (!key) return null;
  const s = subs.get(key);
  if (s && !fresh && Date.now() - s.at < 10 * 60e3) return s;
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchSubscription(key, s).finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
async function fetchSubscription(key, s) {
  const started = Date.now();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(String(process.env.ELEVEN_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '') + '/v1/user/subscription', { headers: { 'xi-api-key': key }, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const n = Object.assign(s || {}, { at: Date.now() - 8 * 60e3, ok: false, error: 'subscription ' + r.status }); subs.set(key, n); return n; } // keep last known numbers; retry in 2 min
    const n = { at: Date.now(), ok: true, tier: String(j.tier || ''), used: +j.character_count || 0, limit: +j.character_limit || 0, reset: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null, overage: !!(j.can_extend_character_limit && j.allowed_to_extend_character_limit), out: s && s.out };
    if (n.out && n.limit && n.used < n.limit * 0.98 && Date.now() - n.out > 30 * 60e3) n.out = 0; // credits came back (new month / top-up)
    const l = holds.get(key); if (l) holds.set(key, l.filter(h => h.at > started - 60e3)); // older holds are in the count now
    subs.set(key, n); return n;
  } catch (e) { const n = Object.assign(s || {}, { at: Date.now() - 8 * 60e3, ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }); subs.set(key, n); return n; }
  finally { clearTimeout(t); }
}
const RESERVE = { live: 0, daily: 0.08, bulk: 0.5, books: 0.012 }; // v15: recordings stop at half the plan, so Bro's live voice always has the other half; v36: the lessons (owner, 7 Nov: "use fully") may use all but ~1% (at least 4,000 credits), kept for Bro's live voice
const LIVE_MIN = 2000; // a live Bro session needs at least ~2 minutes of credit, or it would cut out mid-sentence
// Can this purpose spend `chars` characters now? { ok, reason, left }. Approval reserves the credits immediately, so parallel
// requests can't all squeeze through the same gap; the next plan refresh (≤10 min) replaces the estimate with real numbers.
// A failed refresh keeps the last known numbers. Never-known plan (key without "user read" access) → left:null, and the
// caller (studio.js) applies fixed monthly caps instead.
async function budget(key, chars, purpose) {
  const s = await subscription(key);
  if (s && s.out && Date.now() - s.out < 6 * 3600e3) return { ok: false, reason: 'ElevenLabs credits are used up for this month', left: 0 };
  if (!s || !s.limit) return { ok: true, reason: 'plan unknown', left: null };
  const left = s.limit - s.used - held(key), need = Math.ceil((chars || 0) * PER_CHAR());
  const keep = Math.max(purpose === 'bulk' || purpose === 'books' ? 4000 : purpose === 'daily' ? 1500 : (s.overage ? LIVE_MIN * 3 : LIVE_MIN), s.limit * (RESERVE[purpose] || 0));
  if (left - need < keep) return { ok: false, reason: purpose === 'bulk' || purpose === 'books' ? 'keeping the rest of this month\'s ElevenLabs credits for Bro and the daily news' : 'ElevenLabs credits are nearly used up', left };
  const id = ++holdSeq; if (need) holds.set(key, (holds.get(key) || []).concat({ id, credits: need, at: Date.now() }));
  return { ok: true, left: left - need, hold: need ? id : 0 };
}
const snapshot = key => { const s = subs.get(key); return s ? { at: s.at || 0, tier: s.tier || '', used: (s.used || 0) + held(key), limit: s.limit || 0, reset: s.reset || null, ok: !!s.ok, out: !!(s.out && Date.now() - s.out < 6 * 3600e3), error: s.error || '', overage: !!s.overage } : null; };

module.exports = { pickVoice, broVoice, BRO_VOICES, speak, listVoices, chunk, subscription, budget, release, snapshot, isQuota, MODEL, DEFAULT, PREF, PER_CHAR };
