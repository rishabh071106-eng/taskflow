// Learning backbone for the two schools (Python, Languages):
//  • progress sync — every unit a learner touches, XP, and a log of what they struggled with;
//  • Bro, the mission AI — answers questions with the learner's growth, slide, code and error in view;
//  • narration recorded once — every course line is rendered in Bro's one voice (Bro Core, the voice heard on calls) a
//    single time, kept in MEDIA_DIR/learn-voice/bro-<voice key> and served until the voice changes (a crawler records
//    the whole catalog in the background; a line a learner reaches first is recorded right then).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const EV = require('./elevenvoice.js');

const COURSES = new Set(['py', 'es', 'fr', 'de', 'hi', 'en', 'mind']); // 'mind' = Mind games levels (unit <game>-<level>)
const LANG_NAME = { es: 'Spanish', fr: 'French', de: 'German', hi: 'Hindi', en: 'English' };
// voice key → studio language + role. 'py' is the course narrator; language keys are native speakers.
const VOICES = { es: { lang: 'es', role: 'native' }, fr: { lang: 'fr', role: 'native' }, de: { lang: 'de', role: 'native' }, hi: { lang: 'hi', role: 'native' }, en: { lang: 'en', role: 'native' } };

const sid = (voice, text) => crypto.createHash('sha1').update(voice + '\n' + String(text).trim()).digest('hex').slice(0, 20);

// Every line a learner can hear, in recording order (each language lesson by lesson). v14: the Python course has no
// voice any more (it plays like a game), so only language lines are recorded — all in Bro's one voice.
// v20: the Listen lessons too (lang/audio/<code>.json): the guide's lines in the learner's language (`from`: en or hi),
// the course's lines in the course language. `warm` marks the first lessons of each course (recorded ahead, at boot).
const WARM_LESSONS = 2;
function catalog(appRoot) {
  const out = new Map();
  const add = (voice, text, where, warm) => { text = String(text || '').trim(); if (!text || text.length > 900) return; const id = sid(voice, text); const had = out.get(id); if (!had) out.set(id, { id, voice, text, where, warm: !!warm }); else if (warm) had.warm = true; };
  // v21: Bro's cheers in lessons ("Five in a row!"), in English and Hindi, recorded first with the warm lines
  try { const C = JSON.parse(fs.readFileSync(path.join(appRoot, 'lang', 'data', 'cheers.json'), 'utf8')); for (const v of ['en', 'hi']) for (const t of Object.values(C[v] || {})) add(v, t, 'cheer', true); } catch (e) { /* no cheers */ }
  for (const code of ['es', 'fr', 'de', 'hi', 'en']) {
    try {
      const J = JSON.parse(fs.readFileSync(path.join(appRoot, 'lang', 'audio', code + '.json'), 'utf8'));
      const from = VOICES[J.from] ? J.from : 'en';
      (J.lessons || []).forEach((l, i) => { for (const s of l.steps || []) for (const [voice, text] of audioTexts(s, code, from)) add(voice, text, code + ':' + l.id, i < WARM_LESSONS); });
    } catch (e) { /* no Listen lessons for this language */ }
    try {
      const J = JSON.parse(fs.readFileSync(path.join(appRoot, 'lang', 'data', code + '.json'), 'utf8'));
      (J.units || []).forEach((u, ui) => (u.lessons || []).forEach((l, li) => { for (const it of l.items || []) for (const t of langTexts(it)) add(code, t, code + ':' + l.id, ui === 0 && li < WARM_LESSONS); }));
    } catch (e) { /* language not present */ }
  }
  return out;
}

// The [voice key, text] pairs one Listen step speaks (what lang/audio.html passes to speak()): a target line `t` in the
// course voice, the guide's `n` and questions `q` in the learner's language.
function audioTexts(s, code, from) {
  if (!s || typeof s !== 'object') return [];
  if (typeof s.t === 'string') return [[code, s.t]];
  const n = typeof s.n === 'string' ? s.n : typeof s.q === 'string' ? s.q : '';
  return n ? [[from, n]] : [];
}

// The target-language strings an exercise item speaks (what lang.js passes to speak()).
function langTexts(it) {
  const t = [];
  if (!it || typeof it !== 'object') return t;
  if (it.t === 'learn') { t.push(it.word, it.example); }
  else if (it.t === 'listen') t.push(it.text);
  else if (it.t === 'translate') t.push(it.dir === 'to' ? it.answer : it.text);
  else if (it.t === 'speak') t.push(it.text || it.phrase);
  else if (it.t === 'match') (it.pairs || []).forEach(p => t.push(p[0]));
  else if (it.t === 'choose') { if (it.audio) t.push(it.audio); }
  else if (it.t === 'fill') { // `answer` is the index of the right option (lesson.html speaks the sentence with it filled in)
    const word = Array.isArray(it.options) && Number.isInteger(it.answer) ? it.options[it.answer] : typeof it.answer === 'string' ? it.answer : '';
    if (it.full) t.push(it.full); else if (it.sentence && word) t.push(String(it.sentence).replace(/_{2,}/, word));
  }
  return t.filter(x => typeof x === 'string' && x.trim());
}

function install(app, deps) {
  const { db, auth, getSetting, appRoot, mediaDir, STUDIO } = deps;
  const log = (...a) => console.log('[learn]', ...a);
  const q = s => db.prepare(s);
  db.exec(`CREATE TABLE IF NOT EXISTS learn_units(user_phone TEXT, course TEXT, unit TEXT, done INTEGER DEFAULT 0, best INTEGER DEFAULT 0, slide INTEGER DEFAULT 0, data TEXT, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_phone, course, unit));
    CREATE TABLE IF NOT EXISTS learn_stats(user_phone TEXT, course TEXT, xp INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_phone, course));
    CREATE TABLE IF NOT EXISTS learn_events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT, course TEXT, unit TEXT, kind TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_learn_events_user ON learn_events(user_phone, created_at);
    CREATE TABLE IF NOT EXISTS learn_daily(user_phone TEXT, day TEXT, xp INTEGER DEFAULT 0, PRIMARY KEY(user_phone, day));`);
  const who = req => String(req.user && (req.user.phone || req.user.id) || '');

  // ── progress ──
  function units(phone, course) {
    const out = {};
    for (const r of q('SELECT * FROM learn_units WHERE user_phone=? AND course=?').all(phone, course)) {
      let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (e) { /* ignore */ }
      out[r.unit] = Object.assign(d, { done: !!r.done, best: r.best, slide: r.slide });
    }
    return out;
  }
  const xpOf = (phone, course) => (q('SELECT xp FROM learn_stats WHERE user_phone=? AND course=?').get(phone, course) || {}).xp || 0;
  function save(phone, course, body) {
    const put = q(`INSERT INTO learn_units(user_phone,course,unit,done,best,slide,data,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_phone,course,unit) DO UPDATE SET done=MAX(done,excluded.done), best=MAX(best,excluded.best), slide=CASE WHEN excluded.done=1 THEN 0 ELSE excluded.slide END, data=excluded.data, updated_at=datetime('now')`);
    const tx = db.transaction(() => {
      const u = body.units && typeof body.units === 'object' ? body.units : {};
      for (const [unit, v] of Object.entries(u).slice(0, 120)) {
        if (!/^[a-z0-9_-]{1,24}$/i.test(unit) || !v || typeof v !== 'object') continue;
        const keep = {}; for (const k of ['title', 'started', 'doneAt']) if (typeof v[k] === 'string') keep[k] = v[k].slice(0, 80);
        put.run(phone, course, unit, v.done ? 1 : 0, Math.max(0, Math.min(100, parseInt(v.best) || 0)), Math.max(0, Math.min(99, parseInt(v.slide) || 0)), JSON.stringify(keep));
      }
      const xp = Math.max(0, Math.min(1e6, parseInt(body.xp) || 0));
      q(`INSERT INTO learn_stats(user_phone,course,xp) VALUES(?,?,?) ON CONFLICT(user_phone,course) DO UPDATE SET xp=MAX(xp,excluded.xp), updated_at=datetime('now')`).run(phone, course, xp);
      // v21: the XP of each day (the phone sends its last 14 days; never lowered), so a streak survives a new phone
      const daily = body.daily && typeof body.daily === 'object' ? body.daily : {};
      const putDay = q(`INSERT INTO learn_daily(user_phone,day,xp) VALUES(?,?,?) ON CONFLICT(user_phone,day) DO UPDATE SET xp=MAX(xp,excluded.xp)`);
      const oldest = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10), newest = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
      for (const [d, x] of Object.entries(daily).slice(0, 31)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= oldest && d <= newest) putDay.run(phone, d, Math.max(0, Math.min(100000, parseInt(x) || 0)));
      const ev = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
      const ins = q('INSERT INTO learn_events(user_phone,course,unit,kind,detail) VALUES(?,?,?,?,?)');
      for (const e of ev) if (e && typeof e.kind === 'string') ins.run(phone, course, String(body.unit || e.unit || '').slice(0, 24), e.kind.slice(0, 20), JSON.stringify(e).slice(0, 600));
    });
    tx();
    q("DELETE FROM learn_events WHERE user_phone=? AND id NOT IN (SELECT id FROM learn_events WHERE user_phone=? ORDER BY id DESC LIMIT 600)").run(phone, phone);
  }
  const dailyOf = phone => { const out = {}; for (const r of q("SELECT day, xp FROM learn_daily WHERE user_phone=? AND day >= ? ORDER BY day").all(phone, new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10))) out[r.day] = r.xp; return out; };
  app.get('/api/learn/progress', auth, (req, res) => {
    const course = String(req.query.course || 'py');
    // v21: ?course=lang → every language course at once, plus the daily XP of the last 60 days (a new phone restores it)
    if (course === 'lang') { const courses = {}; for (const c of ['es', 'fr', 'de', 'hi', 'en']) courses[c] = { units: units(who(req), c), xp: xpOf(who(req), c) }; return res.json({ courses, daily: dailyOf(who(req)) }); }
    if (!COURSES.has(course)) return res.status(400).json({ error: 'course' });
    res.json({ course, units: units(who(req), course), xp: xpOf(who(req), course), daily: dailyOf(who(req)) });
  });
  app.post('/api/learn/progress', auth, (req, res) => {
    const course = String(req.body && req.body.course || 'py'); if (!COURSES.has(course)) return res.status(400).json({ error: 'course' });
    try { save(who(req), course, req.body || {}); } catch (e) { log('save', e.message); return res.status(500).json({ error: 'save failed' }); }
    res.json({ course, units: units(who(req), course), xp: xpOf(who(req), course) });
  });

  // What Bro knows about a learner, as short plain text (also used by the Home Bro tool).
  function profile(phone) {
    const lines = [];
    const py = units(phone, 'py');
    const doneDays = Object.keys(py).filter(k => py[k].done).map(k => parseInt(k.slice(1))).sort((a, b) => a - b);
    const cur = (() => { for (let d = 1; d <= 60; d++) if (!(py['d' + d] || {}).done) return d; return 60; })();
    if (Object.keys(py).length) {
      const scores = doneDays.map(d => py['d' + d].best);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      lines.push(`Python course: ${doneDays.length} of 60 days done, now on Day ${cur}. Average practice score ${avg}%. XP ${xpOf(phone, 'py')}.`);
      const weak = doneDays.filter(d => py['d' + d].best < 60);
      if (weak.length) lines.push(`Days with low practice scores: ${weak.slice(-5).join(', ')}.`);
    } else lines.push('Python course: not started yet.');
    for (const c of ['es', 'fr', 'de', 'hi', 'en']) {
      const u = units(phone, c), n = Object.values(u).filter(x => x.done).length;
      if (n) lines.push(`${LANG_NAME[c]}: ${n} lessons done, XP ${xpOf(phone, c)}.`);
    }
    // Mind games: units are '<game>-<level>'; the highest level passed per game, with its best score
    const mind = units(phone, 'mind'), mtop = {};
    for (const [k, v] of Object.entries(mind)) { const m = /^(.+)-(\d+)$/.exec(k); if (!m || !v.done) continue; const lv = +m[2]; if (!mtop[m[1]] || lv > mtop[m[1]].lv) mtop[m[1]] = { lv, best: v.best }; }
    const games = Object.entries(mtop).map(([g, t]) => `${g} level ${t.lv}`);
    if (games.length) lines.push('Mind games: ' + games.join(', ') + '.');
    const ev = q('SELECT course, kind, detail, created_at FROM learn_events WHERE user_phone=? ORDER BY id DESC LIMIT 60').all(phone);
    const errs = {}, fails = [];
    for (const e of ev) {
      let d = {}; try { d = JSON.parse(e.detail); } catch (x) { /* ignore */ }
      if (e.kind === 'error' && d.type) errs[d.type] = (errs[d.type] || 0) + 1;
      if ((e.kind === 'check' || e.kind === 'quiz' || e.kind === 'predict') && d.ok === false && fails.length < 5) fails.push((d.title || e.kind) + (d.msg ? ' (' + String(d.msg).slice(0, 80) + ')' : ''));
    }
    const top = Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} x${n}`);
    if (top.length) lines.push('Recent errors: ' + top.join(', ') + '.');
    if (fails.length) lines.push('Recently struggled with: ' + fails.join('; ') + '.');
    const days = q("SELECT COUNT(DISTINCT date(created_at)) n FROM learn_events WHERE user_phone=? AND created_at > datetime('now','-7 days')").get(phone).n;
    lines.push(`Active on ${days} of the last 7 days.`);
    return { text: lines.join('\n'), current: cur, done: doneDays.length };
  }

  // ── Bro, the mission AI ──
  const openaiKey = () => getSetting('OPENAI_API_KEY');
  async function openaiChat(messages, maxTokens) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { Authorization: 'Bearer ' + openaiKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: getSetting('OPENAI_CHAT_MODEL') || 'gpt-4o-mini', messages, max_tokens: maxTokens, temperature: 0.6 }) });
      const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI ' + r.status);
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } finally { clearTimeout(t); }
  }
  // v16: Bro Core (open models on Groq; its emergency fallback covers Gemini) answers first. The old brains are used only
  // when Bro Core is absent, or as extra emergency answers while its BROCORE_EMERGENCY switch is on.
  function brains() {
    const out = [], B = global._broCore;
    if (B && B.brainReady && B.brainReady()) {
      out.push(['brocore', async (m, n) => (await B.chat({ messages: m, maxTokens: n, purpose: 'learn' })).text]);
      if (B.emergencyOn() && openaiKey()) out.push(['openai', (m, n) => openaiChat(m, n)]);
      return out;
    }
    if (B && !B.emergencyOn()) return out;
    if (openaiKey()) out.push(['openai', (m, n) => openaiChat(m, n)]);
    if (deps._callGroq && deps.hasGroq && deps.hasGroq()) out.push(['groq', async (m, n) => (await deps._callGroq(m, { maxTokens: n })).reply]);
    if (deps._callGemini && ((deps.hasGemini && deps.hasGemini()) || (global._elevenBrain && global._elevenBrain.available()))) out.push(['gemini', async (m, n) => (await deps._callGemini(m.filter(x => x.role !== 'system'), { maxTokens: n, systemPrompt: (m.find(x => x.role === 'system') || {}).content || '' })).reply]);
    return out;
  }
  const hits = new Map();
  function limited(phone) {
    const now = Date.now(), h = (hits.get(phone) || []).filter(t => t > now - 864e5);
    if (h.filter(t => t > now - 60e3).length >= 12 || h.length >= 300) return true;
    h.push(now); hits.set(phone, h); return false;
  }
  const SYS = (course, prof, name) => `You are Bro, the mission AI of Brodoit's learning school: a brilliant, warm senior ${course === 'py' ? 'Python developer and teacher' : LANG_NAME[course] + ' teacher'} who sits next to the learner like a co-pilot on a space mission. You know their journey:
${prof}
Rules:
- Be concise: at most 120 words unless they ask for detail. Plain friendly language; short paragraphs; code in backticks or a short code block.
- Coach, don't spoon-feed: for exercises give a hint or a guiding question first. Give a full solution only if they ask for it explicitly after trying, and then explain it line by line.
- When they share an error, explain what it means in plain words, point to the exact line, and how to fix it.
- Connect to what they already learned (by day) and encourage real progress; never flatter.
- If they write in Hinglish or Hindi, reply the same way.
- Stay on learning ${course === 'py' ? 'Python and software development' : LANG_NAME[course]}; politely steer back if asked about unrelated things.
The learner's name is ${name || 'unknown'}.`;
  app.post('/api/learn/coach', auth, async (req, res) => {
    const phone = who(req), b = req.body || {};
    const course = COURSES.has(b.course) ? b.course : 'py';
    if (limited(phone)) return res.status(429).json({ error: 'slow down' });
    const prof = profile(phone);
    const ctx = b.context && typeof b.context === 'object' ? b.context : {};
    const ctxText = [
      ctx.dayTitle ? `They are on Day ${ctx.day}: ${ctx.dayTitle}.` : '',
      ctx.slide ? `Current slide ${ctx.slide.n}/${ctx.slide.of} (${ctx.slide.type}): "${String(ctx.slide.title || '').slice(0, 120)}". ${String(ctx.slide.task || '').slice(0, 600)}` : '',
      ctx.code ? `Their code right now:\n\`\`\`python\n${String(ctx.code).slice(0, 3000)}\n\`\`\`` : '',
      ctx.lastError ? `Their last error: ${String(ctx.lastError.text || '').slice(0, 300)}${ctx.lastError.line ? ' (line ' + ctx.lastError.line + ')' : ''}` : '',
    ].filter(Boolean).join('\n');
    const name = (req.user && req.user.name) || '';
    const ws = brains();
    if (b.greet) {
      const first = (name || '').split(' ')[0];
      const fallback = prof.done ? `Welcome back${first ? ', ' + first : ''}! Day ${prof.current} is ready. Ask me anything while you learn.` : `Hey${first ? ' ' + first : ''}! I am Bro, your mission AI. I will be right here for every lesson. Ask me anything, any time.`;
      return res.json({ reply: fallback, brain: 'template' });
    }
    if (!ws.length) return res.status(503).json({ error: 'no AI key configured' });
    const question = String(b.question || '').slice(0, 1200);
    if (!question) return res.status(400).json({ error: 'question required' });
    const hist = Array.isArray(b.history) ? b.history.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1500) })) : [];
    const messages = [{ role: 'system', content: SYS(course, prof.text, name) }, ...hist, { role: 'user', content: (ctxText ? ctxText + '\n\n' : '') + 'Question: ' + question }];
    let lastErr = '';
    for (const [nm, fn] of ws) {
      try { const reply = String(await fn(messages, 500) || '').trim(); if (reply) return res.json({ reply, brain: nm }); }
      catch (e) { lastErr = nm + ': ' + e.message; }
    }
    log('coach failed', lastErr);
    res.status(502).json({ error: 'Bro could not answer right now' });
  });

  // ── narration recorded once, in Bro's one voice (v21) ──
  // Clips live in learn-voice/bro-<voice key>/. The key names Bro's voice as it sounds now (style + every language's
  // voice and pace), so a new voice records each line again and an old recording is never played. Every line is recorded
  // by Bro Core's CPU voice, the one heard on calls: in the 'course' lane when a learner is waiting for it (p=now), else
  // at low priority. A busy voice makes the request wait its turn; the page is asked to try again only after that.
  // A crawler records the whole catalog in the background, the first lessons of each course first.
  const VDIR = path.join(mediaDir, 'learn-voice');
  const core = () => global._broCore || null;
  const coreVoice = () => { const B = core(); try { return !!(B && B.voiceReady && B.voiceReady()); } catch (e) { return false; } };
  const style = () => { const B = core(); try { return String((B && typeof B.voiceStyle === 'function' && B.voiceStyle()) || '').replace(/[^a-z0-9]/gi, ''); } catch (e) { return ''; } };
  const vkey = () => { const B = core(); try { return String((B && typeof B.voiceKey === 'function' && B.voiceKey()) || '').replace(/[^a-z0-9-]/gi, ''); } catch (e) { return ''; } };
  const made = new Set();
  const mk = d => { if (made.has(d)) return d; try { fs.mkdirSync(d, { recursive: true }); made.add(d); } catch (e) { /* read-only */ } return d; };
  // with Bro Core: bro-<voice key> (bro-none while the voice module is missing, so nothing old is served); without it
  // (a server with no Bro Core at all) the studio's folder, as before
  const folder = () => (core() ? 'bro-' + (vkey() || 'none') : EV.broVoice(getSetting) + (style() ? '-' + style() : ''));
  const voiceDir = () => mk(path.join(VDIR, folder()));
  mk(VDIR);
  let CAT = catalog(appRoot);
  const inflight = new Map(), miss = new Map(), ipHits = new Map();
  const fileOf = id => path.join(voiceDir(), id + '.mp3');
  const LOAD_WAIT_MS = deps.loadWaitMs != null ? deps.loadWaitMs : 20000;   // Bro's voice still loading after a deploy
  const NOW_WAIT_MS = deps.nowWaitMs != null ? deps.nowWaitMs : 25000;     // the line a learner waits for: its turn in the queue
  const AHEAD_WAIT_MS = deps.aheadWaitMs != null ? deps.aheadWaitMs : 60000; // lines fetched ahead, and the crawler
  const nap = ms => new Promise(r => setTimeout(r, ms));
  const VOICE_DOWN = new Set(['VOICE_NOT_READY', 'VOICE_STALLED', 'VOICE_ENGINE_DOWN']);
  // → { file } kept on disk · { buf } not kept (the paid studio chain behind the emergency switch) · { busy } · { loading }
  //   · null (nothing can record it)
  async function record(item, o) {
    o = o || {};
    const v = VOICES[item.voice] || { lang: 'en', role: 'narrator' };
    const B = core();
    let out = null;
    if (B && coreVoice()) {
      try {
        const r = await B.speak(item.text, { lang: v.lang, format: 'mp3', priority: o.priority || 'low', wait: o.wait || 0, noCache: true, purpose: 'course' });
        if (r && r.audio && r.audio.length && r.mime === 'audio/mpeg') out = { buf: r.audio, provider: 'brocore' };
      } catch (e) {
        if (e && e.code === 'VOICE_BUSY') return { busy: true };
        if (e && VOICE_DOWN.has(e.code)) return { loading: true };
        throw e;
      }
    } else if (!B || (B.emergencyOn && B.emergencyOn())) {
      const s = await STUDIO.speak({ text: item.text, lang: v.lang, role: v.role, purpose: 'daily', getSetting, mp3: true, timeout: 45000, eleven: { format: 'mp3_44100_64', timeout: 40000, chunk: 1500 } });
      if (s && s.buf && s.mime === 'audio/mpeg') out = { buf: s.buf, provider: s.provider };
    } else return { loading: true };
    if (!out) return null;
    if (B && out.provider !== 'brocore') return { buf: out.buf, provider: out.provider }; // another voice: played, never kept
    const f = fileOf(item.id), tmp = f + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, out.buf); fs.renameSync(tmp, f);
    return { file: f, provider: out.provider };
  }
  // one recording per line and lane at a time, shared by players and the crawler. A line fetched ahead joins one a learner
  // already waits for; a learner's request starts its own in the course lane (the voice engine shares the work).
  function ensure(item, o) {
    o = o || {};
    const lane = o.priority === 'course' ? 'course' : 'low';
    if (lane === 'low' && inflight.has(item.id + '|course')) return inflight.get(item.id + '|course');
    const k = item.id + '|' + lane;
    // the entry goes as soon as the recording settles: a busy or failed try is never handed to the next ask
    if (!inflight.has(k)) { const p = record(item, { priority: lane, wait: o.wait }).catch(e => { log('record', e.message); return null; }).finally(() => { if (inflight.get(k) === p) inflight.delete(k); }); inflight.set(k, p); }
    return inflight.get(k);
  }
  // no-cache + ETag: a phone keeps the clip but checks it is still Bro's current voice (a 304 costs nothing)
  const sendClip = (res, f) => { res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' }); res.sendFile(f); };
  const retry = (res, sec) => { res.set('Retry-After', String(sec)); res.status(503).end(); };
  app.get('/api/learn/say/:id', async (req, res) => {
    const id = String(req.params.id || '').replace(/\.mp3$/, '');
    if (!/^[0-9a-f]{20}$/.test(id)) return res.status(404).end();
    const f = fileOf(id);
    if (fs.existsSync(f)) return sendClip(res, f);
    const item = CAT.get(id);
    if (!item) return res.status(404).end();
    const m = miss.get(id);
    if (m && m.until > Date.now()) return res.status(404).end();
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const h = (ipHits.get(ip) || []).filter(t => t > Date.now() - 60e3);
    if (!inflight.has(id + '|course') && !inflight.has(id + '|low') && h.length >= 60) return retry(res, 10);
    h.push(Date.now()); ipHits.set(ip, h);
    let gone = false; res.on('close', () => { gone = true; });
    // Bro's voice is still loading (after a deploy): wait a little for it, then ask the page to try again
    if (core() && !coreVoice()) {
      const t0 = Date.now();
      while (!coreVoice() && !gone && Date.now() - t0 < LOAD_WAIT_MS) await nap(250);
      if (gone) return;
      const B = core();
      if (!coreVoice() && !(B.emergencyOn && B.emergencyOn())) return retry(res, 5);
    }
    const now = req.query.p === 'now';
    const r = await ensure(item, now ? { priority: 'course', wait: NOW_WAIT_MS } : { priority: 'low', wait: AHEAD_WAIT_MS });
    if (gone) return;
    if (r && r.file && fs.existsSync(f)) return sendClip(res, f);
    if (r && r.buf) { res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }); return res.send(r.buf); }
    if (r && (r.busy || r.loading)) return retry(res, r.busy ? 2 : 5);
    // nothing can record this line: the page reads it another way; asked again in 10 minutes
    miss.set(id, { until: Date.now() + 10 * 60e3 });
    res.status(404).end();
  });

  // v21: the crawler records every line in Bro's voice, one at a time at low priority: the first lessons of each course
  // first, then the rest in course order. It steps aside while a live call talks (for up to 3 minutes at a time, so it
  // still moves on a busy day), stops when the disk runs low (under 1.5 GB free) and runs again every 10 minutes while
  // lines are missing. It replaces v20's warm-up of the first lessons.
  const MIN_FREE = deps.minFreeBytes != null ? deps.minFreeBytes : 1.5 * 1024 * 1024 * 1024;
  const crawlState = { state: 'idle', made: 0, at: null };
  const liveCalls = () => { try { return global._liveCalls ? +global._liveCalls() || 0 : 0; } catch (e) { return 0; } };
  async function freeDisk() { try { const st = await fs.promises.statfs(VDIR); return Number(st.bavail) * Number(st.bsize); } catch (e) { return Infinity; } }
  function recordedIds() { try { return new Set(fs.readdirSync(voiceDir()).filter(n => /^[0-9a-f]{20}\.mp3$/.test(n)).map(n => n.slice(0, 20))); } catch (e) { return new Set(); } }
  let crawlRun = null;
  function crawl(o) {
    o = o || {};
    if (crawlRun) return crawlRun;
    const busyMs = o.busyMs != null ? o.busyMs : 5000, gapMs = o.gapMs != null ? o.gapMs : 250, callMs = o.callMs != null ? o.callMs : 2000, maxPauseMs = o.maxPauseMs != null ? o.maxPauseMs : 180e3;
    crawlRun = (async () => {
      let n = 0;
      const have = recordedIds(), all = [...CAT.values()];
      const todo = all.filter(x => x.warm).concat(all.filter(x => !x.warm)).filter(x => !have.has(x.id) && (!o.onlyWarm || x.warm));
      crawlState.state = todo.length ? 'recording' : 'done';
      for (const it of todo) {
        if (o.limit && n >= o.limit) break;
        if (!coreVoice()) { crawlState.state = 'waiting for the voice'; break; }
        if ((await freeDisk()) < MIN_FREE) { crawlState.state = 'disk low'; log('crawler: under 1.5 GB free, stopping'); break; }
        const t0 = Date.now();
        while (liveCalls() > 0 && Date.now() - t0 < maxPauseMs) { crawlState.state = 'paused for a call'; await nap(callMs); }
        crawlState.state = 'recording';
        if (fs.existsSync(fileOf(it.id))) continue;
        const r = await ensure(it, { priority: 'low', wait: AHEAD_WAIT_MS });
        if (r && r.file) { n++; crawlState.made++; crawlState.at = new Date().toISOString(); }
        await nap(r && (r.busy || r.loading) ? busyMs : gapMs);
      }
      if (crawlState.state === 'recording') crawlState.state = recordedIds().size >= CAT.size ? 'done' : 'idle';
      if (n) log(`crawler: ${n} lines recorded in Bro's voice`);
      return n;
    })().finally(() => { crawlRun = null; });
    return crawlRun;
  }
  // v21: recordings in an older voice (other folders, and the oldest flat learn-voice/<id>.mp3) are never played; they are
  // deleted once untouched for 14 days (so a quick switch of style and back keeps them)
  function sweep(o) {
    o = o || {};
    const keep = folder(), cutoff = Date.now() - (o.ageMs != null ? o.ageMs : 14 * 864e5);
    let removed = 0;
    let names = []; try { names = fs.readdirSync(VDIR); } catch (e) { return 0; }
    for (const n of names) {
      if (n === keep) continue;
      const p = path.join(VDIR, n);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > cutoff) continue;
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true }); else if (n.endsWith('.mp3')) fs.unlinkSync(p); else continue;
        removed++;
      } catch (e) { /* gone or busy */ }
    }
    if (removed) log(`sweep: ${removed} recordings in an older voice removed`);
    return removed;
  }
  if (process.env.LEARN_WARM !== '0') {
    const t1 = setTimeout(() => crawl(), 90e3), t2 = setInterval(() => crawl(), 10 * 60e3);
    const t3 = setTimeout(() => sweep(), 120e3), t4 = setInterval(() => sweep(), 864e5);
    for (const t of [t1, t2, t3, t4]) if (t.unref) t.unref();
  }
  function stats() {
    const have = recordedIds(); const by = {};
    for (const it of CAT.values()) { const k = it.voice; by[k] = by[k] || [0, 0]; by[k][1]++; if (have.has(it.id)) by[k][0]++; }
    return { total: CAT.size, recorded: [...CAT.keys()].filter(id => have.has(id)).length, by, voice: folder(), crawler: Object.assign({}, crawlState), library: (() => { try { return global._broLibrary ? global._broLibrary.stats() : null; } catch (e) { return null; } })(), book_voice: (() => { try { return global._bookVoice ? global._bookVoice.stats() : null; } catch (e) { return null; } })(), book_eleven: (() => { try { return global._bookEleven ? global._bookEleven.stats() : null; } catch (e) { return null; } })() };
  }
  app.get('/api/learn/voice-status', (req, res) => res.json(stats()));
  global._learnVoice = { stats, profile };
  log(`ready · ${CAT.size} narration lines (${stats().recorded} recorded) · coach brains: ${brains().map(b => b[0]).join(', ') || 'none'}`);
  return { profile, stats, reload: () => { CAT = catalog(appRoot); return CAT.size; }, catalog: () => CAT, record, ensure, crawl, warm: o => crawl(Object.assign({ onlyWarm: true }, o)), sweep, voiceDir };
}

module.exports = { install, catalog, sid, langTexts, audioTexts, VOICES, WARM_LESSONS };
