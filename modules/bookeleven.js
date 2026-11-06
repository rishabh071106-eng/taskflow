// v35: the books read by ElevenLabs, in Bro's voice (owner, 6 Nov: "convert all audio books to nice scripts … read by
// someone in eleven labs … save it in Brodoit … make sure all voices are top class … min 10 min per book").
// Every book in 7 chapters ("book-<id>", app/bookfull.js) and every public-domain walk-through ("brief-<id>") is recorded
// on this server with the ElevenLabs key from Admin: eleven_multilingual_v2 (their long-form narration model) in Bro's
// voice (Admin → Bro's voice; Brian by default), from the spoken words (scripts/book-voice/spoken.js: "9:30" is "nine
// thirty"), each chapter's heading then its text in ~900-character parts stitched together (previous_request_ids, so the
// voice carries on as one reading), joined with natural pauses, loudness-normalised and kept as one mp3 in
// MEDIA_DIR/book-eleven/. A recording is played only while the book's text is the one it reads (textHash, as
// modules/bookvoice.js); an edited book is read again. Credits: each book asks elevenvoice.budget(…, 'bulk') first, so the
// books never use the half of the month's credits that Bro's live voice and the news keep; a free plan (no commercial
// rights to the audio) records nothing. The first books on the shelf go first; it runs after boot and every 30 minutes.
//   create({ mediaDir, getSetting, text: id → text | '', ids: () → [id…], fetch?, log?, minFreeBytes? })
//     → { file(id), ready() → { id: secs }, stats(), run() → Promise<number recorded>, start() }
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const EV = require('./elevenvoice.js');
const { textHash } = require('./bookvoice.js');
const { spoken } = require('../scripts/book-voice/spoken.js');

const ID_RE = /^(book|brief)-[a-z0-9_-]{1,60}$/i;
const CREDITS = { eleven_multilingual_v2: 1, eleven_v3: 1, eleven_turbo_v2_5: 0.5, eleven_flash_v2_5: 0.5 };
const SR = 44100;
const run = (cmd, args, opts) => new Promise((resolve, reject) => execFile(cmd, args, Object.assign({ maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, opts || {}), (e, out, err) => e ? reject(Object.assign(e, { stderr: String(err || '').slice(-300) })) : resolve(out)));

// a chapter: its heading on its own, then its text in parts of up to ~900 characters (sentences kept whole; "S. I. P." is
// one word)
function parts(chapter) {
  const p = String(chapter).replace(/\s+/g, ' ').trim(); if (!p) return [];
  const h = /^(Chapter [a-z]+\. [^.!?]{2,90}[.!?])\s+(.+)$/.exec(p);
  const body = h ? h[2] : p; const out = h ? [{ text: h[1], head: true }] : [];
  let cur = '';
  for (const s of body.split(/(?<=[.!?])(?<!\b[A-Z]\.)(?<!\bDr\.)\s+/)) {
    if (cur && (cur + ' ' + s).length > 900) { out.push({ text: cur }); cur = s; } else cur = (cur + ' ' + s).trim();
  }
  if (cur) out.push({ text: cur });
  return out;
}

function create(o) {
  const dir = path.join(o.mediaDir, 'book-eleven');
  const idxFile = path.join(dir, 'index.json');
  const gs = k => { try { return (typeof o.getSetting === 'function' && o.getSetting(k)) || process.env[k] || ''; } catch (e) { return process.env[k] || ''; } };
  const fetchFn = o.fetch || ((...a) => fetch(...a));
  const log = o.log || ((...a) => console.log('[book-eleven]', ...a));
  const minFree = o.minFreeBytes == null ? 1024 * 1024 * 1024 : o.minFreeBytes;
  const base = () => String(process.env.ELEVEN_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
  let idx = {}; try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || {}; } catch (e) { idx = {}; }
  const st = { state: 'idle', reason: '', running: null, last: null, recorded: 0, error: '', tier: '', left: null, at: null };

  const textOf = id => { try { return String(o.text(id) || ''); } catch (e) { return ''; } };
  function file(id) {
    id = String(id || ''); if (!ID_RE.test(id)) return '';
    const it = idx[id]; if (!it || !/^[a-z0-9_-]+\.mp3$/i.test(String(it.file || ''))) return '';
    const t = textOf(id); if (!t || textHash(t) !== it.text) return '';
    const f = path.join(dir, it.file);
    try { return fs.statSync(f).size === it.bytes ? f : ''; } catch (e) { return ''; }
  }
  function ready() { const out = {}; for (const id of Object.keys(idx)) if (file(id)) out[id] = Number(idx[id].secs) || 0; return out; }
  const freeBytes = () => { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; } };
  const save = () => { const tmp = idxFile + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(idx)); fs.renameSync(tmp, idxFile); };

  async function tts(key, voice, model, text, prev, next) {
    const body = { text, model_id: model, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: 0.96 } };
    if (prev.length) body.previous_request_ids = prev.slice(-3);
    if (next) body.next_text = next.slice(0, 600);
    const r = await fetchFn(base() + '/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128', {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 300);
      const e = new Error('ElevenLabs ' + r.status + ': ' + t.replace(/\s+/g, ' ').slice(0, 160)); e.status = r.status;
      if (EV.isQuota(r.status, t)) e.code = 'credits'; else if (r.status === 401) e.code = 'key';
      throw e;
    }
    return { buf: Buffer.from(await r.arrayBuffer()), rid: r.headers.get('request-id') || r.headers.get('x-request-id') || '' };
  }
  // mp3 → 16-bit mono PCM at 44.1 kHz
  const pcm = f => run('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-']);
  const silence = s => Buffer.alloc(Math.round(SR * s) * 2);

  async function record(id, key, voice, model) {
    const text = textOf(id); const hash = textHash(text);
    const chapters = spoken(text).split(/\n\s*\n/).map(c => c.trim()).filter(Boolean);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'book-eleven-'));
    try {
      // the reading goes straight to disk as raw PCM (a 14-minute book is ~75 MB of it; never all in memory)
      const all = chapters.map(parts); const flat = all.flat(); const prev = []; let n = 0, bytes = 0;
      const rawFile = path.join(tmp, 'all.pcm'); const add = b => { fs.appendFileSync(rawFile, b); bytes += b.length; };
      for (let c = 0; c < all.length; c++) {
        for (let k = 0; k < all[c].length; k++) {
          const p = all[c][k]; const next = flat[n + 1] ? flat[n + 1].text : '';
          const { buf, rid } = await tts(key, voice, model, p.text, prev, next);
          if (rid) prev.push(rid);
          const f = path.join(tmp, String(n).padStart(3, '0') + '.mp3'); fs.writeFileSync(f, buf);
          add(await pcm(f)); try { fs.unlinkSync(f); } catch (e) { /* tmp */ }
          // after a heading, a breath; between parts, a short pause; between chapters, a longer one
          add(silence(p.head ? 0.7 : k === all[c].length - 1 ? 1.4 : 0.25));
          n++;
        }
      }
      const secs = bytes / 2 / SR;
      const name = id + '-' + hash + '.mp3'; const out = path.join(tmp, name);
      await run('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', rawFile, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-ar', String(SR), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-id3v2_version', '0', out]);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name); fs.copyFileSync(out, dest);
      const old = idx[id] && idx[id].file;
      idx[id] = { file: name, text: hash, bytes: fs.statSync(dest).size, secs: Math.round(secs * 10) / 10, voice, model, chars: text.length, at: new Date().toISOString() };
      save();
      if (old && old !== name) { try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* gone */ } }
      try { require('./studio.js').track('eleven', text.length, 'books'); } catch (e) { /* usage page only */ }
      return idx[id];
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
  }

  // one pass: every book not recorded from its current text, the first on the shelf first, while credits allow
  function runOnce() {
    if (st.running) return st.running;
    st.running = (async () => {
      let got = 0;
      try {
        const key = gs('ELEVENLABS_API_KEY');
        if (!key) { st.state = 'off'; st.reason = 'no ElevenLabs key in Admin'; return 0; }
        if (gs('BOOK_ELEVEN') === 'off') { st.state = 'off'; st.reason = 'turned off in Admin (BOOK_ELEVEN=off)'; return 0; }
        const model = gs('BOOK_ELEVEN_MODEL') || 'eleven_multilingual_v2';
        const voice = gs('BOOK_ELEVEN_VOICE') || EV.broVoice(gs);
        const sub = await EV.subscription(key, true).catch(() => null);
        st.tier = (sub && sub.tier) || ''; st.left = sub && sub.limit ? Math.max(0, sub.limit - sub.used) : null; st.at = new Date().toISOString();
        if (/^free$/i.test(st.tier)) { st.state = 'waiting'; st.reason = 'the ElevenLabs free plan gives no commercial rights to its audio: a paid plan is needed'; return 0; }
        fs.mkdirSync(dir, { recursive: true });
        const todo = (o.ids() || []).filter(id => ID_RE.test(id) && textOf(id) && !file(id));
        // a key that cannot read its plan: no credit guard to lean on, so a few books a day only (BOOK_ELEVEN_DAILY, 5)
        const known = !!(sub && sub.ok && sub.limit); const today = new Date().toISOString().slice(0, 10);
        const daily = Number(gs('BOOK_ELEVEN_DAILY')) || 5; const doneToday = Object.values(idx).filter(x => String(x.at || '').startsWith(today)).length;
        if (!todo.length) { st.state = 'done'; st.reason = ''; return 0; }
        st.state = 'recording'; st.reason = '';
        let thisPass = 0;
        for (const id of todo) {
          const chars = spoken(textOf(id)).length;
          if (!known && doneToday + thisPass >= daily) { st.state = 'waiting'; st.reason = 'the ElevenLabs plan could not be read, so at most ' + daily + ' books a day'; break; }
          if (freeBytes() < minFree + 30 * 1024 * 1024) { st.state = 'waiting'; st.reason = 'the volume is nearly full'; break; }
          const per = CREDITS[model] || 1, b = await EV.budget(key, Math.ceil(chars * per / EV.PER_CHAR()), 'bulk');
          if (!b.ok) { st.state = 'waiting'; st.reason = b.reason || 'waiting for ElevenLabs credits'; break; }
          try {
            const it = await record(id, key, voice, model); got++; thisPass++; st.recorded++; st.last = { id, secs: it.secs, at: it.at };
            log('recorded', id, Math.round(it.secs / 6) / 10, 'min ·', model);
          } catch (e) {
            if (b.hold) EV.release(key, b.hold);
            st.error = String(e.message || e).slice(0, 200); log('could not record', id + ':', st.error);
            if (e.code === 'credits') { st.state = 'waiting'; st.reason = 'ElevenLabs credits are used up for now'; break; }
            if (e.code === 'key' || e.status === 401 || e.status === 403) { st.state = 'waiting'; st.reason = 'the ElevenLabs key was refused (' + (e.status || '') + ')'; break; }
            if (e.status === 429) { st.state = 'waiting'; st.reason = 'ElevenLabs is busy (rate limit): next pass'; break; }
          }
        }
        if (st.state === 'recording') st.state = (o.ids() || []).every(id => !ID_RE.test(id) || !textOf(id) || file(id)) ? 'done' : 'idle';
      } catch (e) { st.error = String(e.message || e).slice(0, 200); log('pass failed:', st.error); }
      return got;
    })().finally(() => { st.running = null; });
    return st.running;
  }
  function stats() {
    const ids = (() => { try { return (o.ids() || []).filter(id => ID_RE.test(id)); } catch (e) { return []; } })();
    const r = ready(); const done = ids.filter(id => r[id]).length;
    return { state: st.running ? 'recording' : st.state, reason: st.reason, ready: done, total: ids.length, minutes: Math.round(Object.values(r).reduce((s, x) => s + x, 0) / 60), last: st.last, error: st.error, plan: st.tier || null, credits_left: st.left, checked_at: st.at, model: gs('BOOK_ELEVEN_MODEL') || 'eleven_multilingual_v2' };
  }
  function start(delayMs) {
    const env = Number(process.env.BOOK_ELEVEN_DELAY_MS);
    const d = delayMs != null ? delayMs : process.env.BOOK_ELEVEN_DELAY_MS && Number.isFinite(env) ? env : 120e3;
    const t = setTimeout(() => { runOnce().catch(() => {}); const iv = setInterval(() => runOnce().catch(() => {}), 30 * 60e3); if (iv.unref) iv.unref(); }, d);
    if (t.unref) t.unref();
  }
  return { file, ready, stats, run: runOnce, start, dir: () => dir };
}

module.exports = { create, parts };
