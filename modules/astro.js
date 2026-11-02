// Brodoit Jyotish (v34): the palm reader's eyes, the pandit directory and puja bookings. The pages live in /astro.
//
//   GET  /api/astro/status                 { vision, signedIn, admin, pandit, palmLeft }
//   POST /api/astro/palm                   { image: data:image/jpeg;base64,…, hand, lang } → { ok, features, notes, summary }
//        The photo is read once by Gemini (then OpenAI) and never stored. Features use the same names and choices as the
//        self-guided reading (astro/assets/text.js PALM), so both give the same reading; notes are the model's own
//        description of the lines it sees. ASTRO_PALM_DAILY readings a day per account (default 5; the admin has no limit).
//   GET  /api/astro/pandits?city=&puja=    verified pandits (no phone numbers)
//   POST /api/astro/pandits                join as a pandit (or edit your listing) → pending until the admin verifies
//   GET  /api/astro/pandit/me              your listing and the bookings assigned to you (with the family's contact)
//   POST /api/astro/bookings               book a puja; the price is worked out here from astro/data (never sent by the page)
//   GET  /api/astro/bookings               your bookings (the pandit's name and phone once confirmed)
//   POST /api/astro/bookings/:id/cancel
//   GET  /api/astro/admin                  admin: every pandit and booking
//   POST /api/astro/admin/pandits          admin: add a pandit (verified)
//   POST /api/astro/admin/pandits/:id      admin: { status: verified|rejected|paused|pending }
//   POST /api/astro/admin/bookings/:id     admin: { status, pandit_id, note }
// Push notices: a new booking → the admin; confirmed → the family and the pandit; cancelled → the admin.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const GEM = require('./gemini.js');

const PALM_ENUMS = {
  shape: ['earth', 'air', 'fire', 'water'], heartEnd: ['jupiter', 'between', 'saturn'], heartShape: ['curved', 'straight'],
  headLen: ['long', 'medium', 'short'], headSlope: ['straight', 'gentle', 'steep'], headStart: ['joined', 'separate'],
  lifeArc: ['wide', 'medium', 'close'], lifeMarks: ['none', 'breaks', 'double', 'chained'], fate: ['deep', 'faint', 'none'],
  sun: ['clear', 'faint', 'none'], bonds: ['0', '1', '2', '3'], mount: ['venus', 'jupiter', 'saturn', 'apollo', 'mercury', 'moon'],
  thumb: ['flexible', 'firm'], fingers: ['index', 'equal', 'ring'],
};
const NOTE_KEYS = ['overall', 'heart', 'head', 'life', 'fate'];
const QUALITY = ['good', 'blurry', 'dark', 'partial', 'not_palm'];
const STATUSES = ['requested', 'confirmed', 'done', 'cancelled'];
const P_STATUSES = ['pending', 'verified', 'rejected', 'paused'];

function palmPrompt(lang, hand) {
  const L = lang === 'hi' ? 'Hindi (Devanagari script, simple everyday Hindi)' : 'English (plain, warm, second person)';
  return [
    'PALM_READER. You are an experienced palm reader trained in Indian hast rekha shastra and Western palmistry.',
    'Look at the photo of a person\'s ' + (hand === 'left' ? 'left' : 'right') + ' hand and describe what you actually see.',
    'Answer with JSON only, exactly this shape:',
    '{"is_palm": true|false, "quality": "good|blurry|dark|partial|not_palm", "retake_tip": "<one short sentence in ' + L + ', only when quality is not good>",',
    ' "features": {',
    Object.entries(PALM_ENUMS).map(([k, v]) => '  "' + k + '": ' + v.map(x => '"' + x + '"').join('|') + '|null').join(',\n'),
    ' },',
    ' "notes": {"overall": "...", "heart": "...", "head": "...", "life": "...", "fate": "..."},',
    ' "summary": "..."}',
    'Feature meanings: shape = palm square/long with fingers short/long (earth square+short, air square+long, fire long+short, water long+long);',
    'heartEnd = where the heart line (top horizontal line) ends: under the index finger (jupiter), between index and middle (between), under the middle finger (saturn);',
    'headLen/headSlope = the head line across the middle; headStart = whether head and life lines start joined near the thumb;',
    'lifeArc = how far the life line swings into the palm around the thumb; lifeMarks = breaks, a parallel sister line (double), chains/islands;',
    'fate = vertical line towards the middle finger; sun = vertical line towards the ring finger; bonds = short horizontal lines on the edge below the little finger (0-3, 3 means 3 or more);',
    'mount = the most padded area; thumb = flexibility (usually not visible: use null); fingers = index vs ring finger length.',
    'Use null for any feature you cannot see clearly. Do not guess wildly.',
    'notes: for each key, 1-2 sentences in ' + L + ' describing what you see in THIS palm (depth, curve, length, marks) and what tradition says it means.',
    'summary: 3-4 sentences in ' + L + ' bringing the reading together, encouraging and specific to this palm.',
    'Never predict illness, death, lifespan, accidents, divorce or exact dates. Speak of tendencies and strengths.',
    'If the photo is not a palm (or the lines cannot be seen), set is_palm false or quality accordingly, features all null, notes empty strings.',
  ].join('\n');
}

const parseJson = s => {
  s = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in the answer');
  return JSON.parse(s.slice(a, b + 1));
};
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function cleanReading(j) {
  const f = {}, src = (j && j.features) || {};
  for (const k in PALM_ENUMS) { const v = src[k] == null ? null : String(src[k]); f[k] = PALM_ENUMS[k].includes(v) ? v : null; }
  const notes = {}; for (const k of NOTE_KEYS) notes[k] = clip(j && j.notes && j.notes[k], 420);
  const quality = QUALITY.includes(j && j.quality) ? j.quality : 'good';
  const seen = Object.values(f).filter(Boolean).length;
  return { is_palm: !!(j && j.is_palm !== false) && quality !== 'not_palm', quality, retake_tip: clip(j && j.retake_tip, 200), features: f, notes, summary: clip(j && j.summary, 900), seen };
}

function install(app, deps) {
  const { db, getSetting } = deps;
  const appRoot = deps.appRoot || path.join(__dirname, '..');
  const push = typeof deps.pushTo === 'function' ? deps.pushTo : () => 0;
  const isAdmin = u => { try { return !!(u && deps.isAdminUser && deps.isAdminUser(u)); } catch (e) { return false; } };
  const adminPhones = () => { try { return (deps.adminPhones && deps.adminPhones()) || []; } catch (e) { return []; } };
  const setting = k => { try { return (getSetting && getSetting(k)) || process.env[k] || ''; } catch (e) { return process.env[k] || ''; } };
  const PRICE = require(path.join(appRoot, 'astro', 'assets', 'price.js'));
  const load = f => JSON.parse(fs.readFileSync(path.join(appRoot, 'astro', 'data', f), 'utf8'));
  const PUJAS = load('pujas.json'), CITIES = load('cities.json');
  const pujaOf = id => PUJAS.pujas.find(p => p.id === id) || null;
  const cityOf = id => CITIES.cities.find(c => c.id === id) || null;
  const LANG_IDS = PUJAS.langs.map(l => l.id), TRAD_IDS = PUJAS.traditions.map(t => t.id);

  db.exec(`CREATE TABLE IF NOT EXISTS astro_pandits(id TEXT PRIMARY KEY,user_phone TEXT,name TEXT NOT NULL,city TEXT NOT NULL,langs TEXT DEFAULT '[]',traditions TEXT DEFAULT '[]',pujas TEXT DEFAULT '[]',experience INTEGER DEFAULT 0,about TEXT DEFAULT '',phone TEXT DEFAULT '',status TEXT DEFAULT 'pending',added_by TEXT DEFAULT 'self',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE INDEX IF NOT EXISTS astro_pandits_city ON astro_pandits(city,status);
CREATE TABLE IF NOT EXISTS astro_bookings(id TEXT PRIMARY KEY,user_phone TEXT NOT NULL,puja TEXT NOT NULL,city TEXT NOT NULL,pkg TEXT NOT NULL,price INTEGER NOT NULL,date TEXT NOT NULL,time TEXT DEFAULT '',address TEXT DEFAULT '',lang TEXT DEFAULT '',tradition TEXT DEFAULT '',notes TEXT DEFAULT '',contact_name TEXT DEFAULT '',contact_phone TEXT DEFAULT '',pandit_id TEXT DEFAULT '',status TEXT DEFAULT 'requested',admin_note TEXT DEFAULT '',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE INDEX IF NOT EXISTS astro_bookings_user ON astro_bookings(user_phone);
CREATE INDEX IF NOT EXISTS astro_bookings_pandit ON astro_bookings(pandit_id);
CREATE TABLE IF NOT EXISTS astro_usage(user_phone TEXT NOT NULL,day TEXT NOT NULL,n INTEGER DEFAULT 0,PRIMARY KEY(user_phone,day));`);

  const userOf = req => {
    let t = String(req.headers['x-token'] || '');
    if (!t) { const m = String(req.headers.cookie || '').match(/tf_token=([^;]+)/); if (m) { try { t = decodeURIComponent(m[1]); } catch (e) { t = ''; } } }
    if (!t) return null;
    try { return db.prepare('SELECT * FROM users WHERE token=?').get(t) || null; } catch (e) { return null; }
  };
  const need = (req, res) => { const u = userOf(req); if (!u) { res.status(401).json({ error: 'sign in first', code: 'auth' }); return null; } return u; };
  const needAdmin = (req, res) => { const u = need(req, res); if (!u) return null; if (!isAdmin(u)) { res.status(403).json({ error: 'admin only' }); return null; } return u; };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const arr = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const digits = s => String(s || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const newId = p => p + '-' + Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString('hex').toUpperCase();
  const pub = p => p && ({ id: p.id, name: p.name, city: p.city, langs: arr(p.langs), traditions: arr(p.traditions), pujas: arr(p.pujas), experience: p.experience, about: p.about, status: p.status });
  const palmDaily = () => Math.max(0, parseInt(setting('ASTRO_PALM_DAILY') || '5', 10) || 5);
  const usedToday = phone => { try { const r = db.prepare('SELECT n FROM astro_usage WHERE user_phone=? AND day=?').get(phone, today()); return r ? r.n : 0; } catch (e) { return 0; } };
  const visionKeys = () => ({ gemini: setting('GEMINI_API_KEY'), openai: setting('OPENAI_API_KEY') });

  // ── status ──
  app.get('/api/astro/status', (req, res) => {
    const u = userOf(req), k = visionKeys(), admin = isAdmin(u);
    let pandit = null; if (u) { try { const p = db.prepare('SELECT status FROM astro_pandits WHERE user_phone=?').get(u.phone); pandit = p ? p.status : null; } catch (e) { /* none */ } }
    res.set('Cache-Control', 'no-store').json({ vision: !!(k.gemini || k.openai), signedIn: !!u, admin, pandit, palmLeft: u ? (admin ? 99 : Math.max(0, palmDaily() - usedToday(u.phone))) : 0, name: u ? (u.name || '') : '' });
  });

  // ── the palm reader ──
  async function readWithGemini(key, b64, mime, prompt) {
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 1600 } };
    const { json, model } = await GEM.generate(key, body, { timeout: 45000, getSetting: setting });
    return { j: parseJson(GEM.textOf(json)), model };
  }
  async function readWithOpenAI(key, dataUrl, prompt) {
    const model = setting('ASTRO_OPENAI_MODEL') || 'gpt-4o-mini';
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, response_format: { type: 'json_object' }, max_tokens: 1400, temperature: 0.4, messages: [{ role: 'system', content: prompt }, { role: 'user', content: [{ type: 'text', text: 'Read this palm.' }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI HTTP ' + r.status);
      return { j: parseJson(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content), model };
    } finally { clearTimeout(t); }
  }
  app.post('/api/astro/palm', async (req, res) => {
    const u = need(req, res); if (!u) return;
    const b = req.body || {}, lang = b.lang === 'hi' ? 'hi' : 'en', hand = b.hand === 'left' ? 'left' : 'right';
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
    if (!m) return res.status(400).json({ ok: false, code: 'image', error: 'send a JPEG, PNG or WebP photo' });
    if (m[2].length > 4.5e6) return res.status(413).json({ ok: false, code: 'image', error: 'photo too large' });
    const admin = isAdmin(u);
    if (!admin && usedToday(u.phone) >= palmDaily()) return res.status(429).json({ ok: false, code: 'limit', error: 'daily limit reached' });
    const k = visionKeys(); if (!k.gemini && !k.openai) return res.status(503).json({ ok: false, code: 'no-vision', error: 'no vision model configured' });
    const prompt = palmPrompt(lang, hand); let out = null, model = '', last = null;
    if (k.gemini) { try { const r = await readWithGemini(k.gemini, m[2], m[1], prompt); out = r.j; model = r.model; } catch (e) { last = e; console.log('[astro] gemini palm failed:', e.message); } }
    if (!out && k.openai) { try { const r = await readWithOpenAI(k.openai, String(b.image), prompt); out = r.j; model = r.model; } catch (e) { last = e; console.log('[astro] openai palm failed:', e.message); } }
    if (!out) return res.status(502).json({ ok: false, code: 'no-vision', error: (last && last.message) || 'the reader is unavailable' });
    const r = cleanReading(out);
    if (!r.is_palm || r.quality !== 'good' && r.seen < 4) return res.json({ ok: false, code: 'retake', quality: r.is_palm ? r.quality : 'not_palm', tip: r.retake_tip });
    try { db.prepare("INSERT INTO astro_usage(user_phone,day,n) VALUES(?,?,1) ON CONFLICT(user_phone,day) DO UPDATE SET n=n+1").run(u.phone, today()); } catch (e) { /* counting is best effort */ }
    res.json({ ok: true, hand, lang, features: r.features, notes: r.notes, summary: r.summary, quality: r.quality, model, left: admin ? 99 : Math.max(0, palmDaily() - usedToday(u.phone)) });
  });

  // ── pandits ──
  function cleanPandit(b) {
    const name = clip(b.name, 60), city = String(b.city || ''), exp = Math.max(0, Math.min(70, parseInt(b.experience, 10) || 0));
    const langs = (Array.isArray(b.langs) ? b.langs : []).map(String).filter(x => LANG_IDS.includes(x)).slice(0, 12);
    const traditions = (Array.isArray(b.traditions) ? b.traditions : []).map(String).filter(x => TRAD_IDS.includes(x)).slice(0, 8);
    const pujas = (Array.isArray(b.pujas) ? b.pujas : []).map(String).filter(x => pujaOf(x)).slice(0, 40);
    const phone = digits(b.phone).slice(0, 16), about = clip(b.about, 400);
    if (name.length < 2) return { error: 'name' };
    if (!cityOf(city)) return { error: 'city' };
    if (!langs.length) return { error: 'langs' };
    if (!pujas.length) return { error: 'pujas' };
    if (phone.replace(/\D/g, '').length < 10) return { error: 'phone' };
    return { name, city, langs, traditions, pujas, experience: exp, about, phone };
  }
  app.get('/api/astro/pandits', (req, res) => {
    const city = String(req.query.city || ''), puja = String(req.query.puja || '');
    let rows = []; try { rows = db.prepare("SELECT * FROM astro_pandits WHERE status='verified'" + (city ? ' AND city=?' : '') + ' ORDER BY experience DESC, created_at ASC').all(...(city ? [city] : [])); } catch (e) { rows = []; }
    const items = rows.map(pub).filter(p => !puja || p.pujas.includes(puja));
    res.set('Cache-Control', 'no-cache').json({ items });
  });
  app.post('/api/astro/pandits', (req, res) => {
    const u = need(req, res); if (!u) return;
    const c = cleanPandit(req.body || {}); if (c.error) return res.status(400).json({ error: 'check ' + c.error, field: c.error });
    const cur = db.prepare('SELECT * FROM astro_pandits WHERE user_phone=?').get(u.phone);
    if (cur) {
      // a verified listing stays verified unless the name or city changes
      const status = cur.status === 'verified' && (cur.name !== c.name || cur.city !== c.city) ? 'pending' : cur.status === 'rejected' ? 'pending' : cur.status;
      db.prepare("UPDATE astro_pandits SET name=?,city=?,langs=?,traditions=?,pujas=?,experience=?,about=?,phone=?,status=?,updated_at=datetime('now') WHERE id=?")
        .run(c.name, c.city, JSON.stringify(c.langs), JSON.stringify(c.traditions), JSON.stringify(c.pujas), c.experience, c.about, c.phone, status, cur.id);
      return res.json({ ok: true, pandit: pub(db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(cur.id)) });
    }
    const id = newId('PD');
    db.prepare('INSERT INTO astro_pandits(id,user_phone,name,city,langs,traditions,pujas,experience,about,phone,status,added_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, u.phone, c.name, c.city, JSON.stringify(c.langs), JSON.stringify(c.traditions), JSON.stringify(c.pujas), c.experience, c.about, c.phone, 'pending', 'self');
    for (const p of adminPhones()) push(p, { title: 'New pandit to verify', body: c.name + ' · ' + cityOf(c.city).n, tag: 'astro-pandit', url: '/astro/admin.html' });
    res.json({ ok: true, pandit: pub(db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(id)) });
  });
  app.get('/api/astro/pandit/me', (req, res) => {
    const u = need(req, res); if (!u) return;
    const p = db.prepare('SELECT * FROM astro_pandits WHERE user_phone=?').get(u.phone);
    if (!p) return res.json({ pandit: null, jobs: [] });
    const jobs = db.prepare("SELECT * FROM astro_bookings WHERE pandit_id=? AND status IN ('confirmed','done') ORDER BY date ASC").all(p.id)
      .map(b => ({ id: b.id, puja: b.puja, city: b.city, pkg: b.pkg, price: b.price, date: b.date, time: b.time, address: b.address, lang: b.lang, tradition: b.tradition, notes: b.notes, contact_name: b.contact_name, contact_phone: b.contact_phone, status: b.status }));
    res.json({ pandit: Object.assign(pub(p), { phone: p.phone }), jobs });
  });

  // ── bookings ──
  const bookingOut = (b, withPandit) => {
    const o = { id: b.id, puja: b.puja, city: b.city, pkg: b.pkg, price: b.price, date: b.date, time: b.time, address: b.address, lang: b.lang, tradition: b.tradition, notes: b.notes, contact_name: b.contact_name, contact_phone: b.contact_phone, status: b.status, admin_note: b.admin_note, created_at: b.created_at };
    if (withPandit && b.pandit_id) { const p = db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(b.pandit_id); if (p) o.pandit = Object.assign(pub(p), b.status === 'confirmed' || b.status === 'done' ? { phone: p.phone } : {}); }
    return o;
  };
  app.post('/api/astro/bookings', (req, res) => {
    const u = need(req, res); if (!u) return;
    const b = req.body || {}, puja = pujaOf(String(b.puja || '')), city = cityOf(String(b.city || '')), pkg = String(b.pkg || '');
    if (!puja) return res.status(400).json({ error: 'unknown puja', field: 'puja' });
    if (!city) return res.status(400).json({ error: 'unknown city', field: 'city' });
    if (!PRICE.available(puja, city.id)) return res.status(400).json({ error: 'not offered in this city', field: 'city' });
    const price = PRICE.price(puja, pkg, city, CITIES.tiers); if (price == null) return res.status(400).json({ error: 'unknown package', field: 'pkg' });
    const date = String(b.date || ''), t0 = today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return res.status(400).json({ error: 'pick a date', field: 'date' });
    const days = (Date.parse(date + 'T00:00:00Z') - Date.parse(t0 + 'T00:00:00Z')) / 86400000;
    if (days < 0 || days > 400) return res.status(400).json({ error: 'pick a date from today to a year ahead', field: 'date' });
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || '')) ? String(b.time) : ['morning', 'afternoon', 'evening', 'muhurat'].includes(b.time) ? String(b.time) : 'muhurat';
    const remote = puja.cat === 'astro';
    const address = clip(b.address, 300); if (!remote && address.length < 8) return res.status(400).json({ error: 'add the address', field: 'address' });
    const name = clip(b.contact_name || u.name, 60); if (name.length < 2) return res.status(400).json({ error: 'add a name', field: 'contact_name' });
    const phone = digits(b.contact_phone || (String(u.phone || '').startsWith('+') ? u.phone : '')).slice(0, 16);
    if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'add a phone number', field: 'contact_phone' });
    const lang = LANG_IDS.includes(b.lang) ? b.lang : '', tradition = TRAD_IDS.includes(b.tradition) ? b.tradition : '';
    let panditId = '';
    if (b.pandit_id) {
      const p = db.prepare("SELECT * FROM astro_pandits WHERE id=? AND status='verified'").get(String(b.pandit_id));
      if (!p || p.city !== city.id || !arr(p.pujas).includes(puja.id)) return res.status(400).json({ error: 'that pandit is not available for this puja here', field: 'pandit_id' });
      panditId = p.id;
    }
    const open = db.prepare("SELECT COUNT(*) n FROM astro_bookings WHERE user_phone=? AND status IN ('requested','confirmed')").get(u.phone).n;
    const madeToday = db.prepare("SELECT COUNT(*) n FROM astro_bookings WHERE user_phone=? AND created_at>=datetime('now','-1 day')").get(u.phone).n;
    if (open >= 8 || madeToday >= 10) return res.status(429).json({ error: 'too many open bookings', code: 'limit' });
    const id = newId('BK');
    db.prepare('INSERT INTO astro_bookings(id,user_phone,puja,city,pkg,price,date,time,address,lang,tradition,notes,contact_name,contact_phone,pandit_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, u.phone, puja.id, city.id, pkg, price, date, time, address, lang, tradition, clip(b.notes, 500), name, phone, panditId, 'requested');
    for (const p of adminPhones()) push(p, { title: 'New puja booking', body: puja.n + ' · ' + city.n + ' · ' + date + ' · ' + PRICE.rupees(price), tag: 'astro-book-' + id, url: '/astro/admin.html' });
    res.json({ ok: true, booking: bookingOut(db.prepare('SELECT * FROM astro_bookings WHERE id=?').get(id), true) });
  });
  app.get('/api/astro/bookings', (req, res) => {
    const u = need(req, res); if (!u) return;
    const rows = db.prepare('SELECT * FROM astro_bookings WHERE user_phone=? ORDER BY created_at DESC LIMIT 50').all(u.phone);
    res.set('Cache-Control', 'no-store').json({ items: rows.map(b => bookingOut(b, true)) });
  });
  app.post('/api/astro/bookings/:id/cancel', (req, res) => {
    const u = need(req, res); if (!u) return;
    const b = db.prepare('SELECT * FROM astro_bookings WHERE id=? AND user_phone=?').get(String(req.params.id), u.phone);
    if (!b) return res.status(404).json({ error: 'no such booking' });
    if (!['requested', 'confirmed'].includes(b.status)) return res.status(400).json({ error: 'this booking can no longer be cancelled' });
    db.prepare("UPDATE astro_bookings SET status='cancelled',updated_at=datetime('now') WHERE id=?").run(b.id);
    for (const p of adminPhones()) push(p, { title: 'Booking cancelled', body: (pujaOf(b.puja) || {}).n + ' · ' + b.date, tag: 'astro-book-' + b.id, url: '/astro/admin.html' });
    if (b.pandit_id) { const p = db.prepare('SELECT user_phone FROM astro_pandits WHERE id=?').get(b.pandit_id); if (p && p.user_phone) push(p.user_phone, { title: 'Booking cancelled', body: (pujaOf(b.puja) || {}).n + ' · ' + b.date, tag: 'astro-job-' + b.id, url: '/astro/pandit.html?v=jobs' }); }
    res.json({ ok: true, booking: bookingOut(db.prepare('SELECT * FROM astro_bookings WHERE id=?').get(b.id), true) });
  });

  // ── admin ──
  app.get('/api/astro/admin', (req, res) => {
    if (!needAdmin(req, res)) return;
    const pandits = db.prepare('SELECT * FROM astro_pandits ORDER BY CASE status WHEN \'pending\' THEN 0 ELSE 1 END, created_at DESC LIMIT 500').all().map(p => Object.assign(pub(p), { phone: p.phone, added_by: p.added_by, created_at: p.created_at }));
    const bookings = db.prepare('SELECT * FROM astro_bookings ORDER BY CASE status WHEN \'requested\' THEN 0 WHEN \'confirmed\' THEN 1 ELSE 2 END, date ASC LIMIT 500').all().map(b => Object.assign(bookingOut(b, true), { pandit_id: b.pandit_id }));
    res.set('Cache-Control', 'no-store').json({ pandits, bookings });
  });
  app.post('/api/astro/admin/pandits', (req, res) => {
    if (!needAdmin(req, res)) return;
    const c = cleanPandit(req.body || {}); if (c.error) return res.status(400).json({ error: 'check ' + c.error, field: c.error });
    const id = newId('PD');
    db.prepare('INSERT INTO astro_pandits(id,user_phone,name,city,langs,traditions,pujas,experience,about,phone,status,added_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, null, c.name, c.city, JSON.stringify(c.langs), JSON.stringify(c.traditions), JSON.stringify(c.pujas), c.experience, c.about, c.phone, 'verified', 'admin');
    res.json({ ok: true, pandit: pub(db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(id)) });
  });
  app.post('/api/astro/admin/pandits/:id', (req, res) => {
    if (!needAdmin(req, res)) return;
    const st = String((req.body || {}).status || ''); if (!P_STATUSES.includes(st)) return res.status(400).json({ error: 'bad status' });
    const p = db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(String(req.params.id)); if (!p) return res.status(404).json({ error: 'no such pandit' });
    db.prepare("UPDATE astro_pandits SET status=?,updated_at=datetime('now') WHERE id=?").run(st, p.id);
    if (p.user_phone && st !== p.status && (st === 'verified' || st === 'rejected')) push(p.user_phone, { title: st === 'verified' ? 'You are listed on Brodoit' : 'Your pandit listing', body: st === 'verified' ? 'Families in your city can now book you.' : 'We could not verify your listing. Open it to see why.', tag: 'astro-pandit', url: '/astro/pandit.html?v=me' });
    res.json({ ok: true });
  });
  app.post('/api/astro/admin/bookings/:id', (req, res) => {
    if (!needAdmin(req, res)) return;
    const b = db.prepare('SELECT * FROM astro_bookings WHERE id=?').get(String(req.params.id)); if (!b) return res.status(404).json({ error: 'no such booking' });
    const body = req.body || {};
    const st = body.status == null ? b.status : String(body.status); if (!STATUSES.includes(st)) return res.status(400).json({ error: 'bad status' });
    let pid = body.pandit_id == null ? b.pandit_id : String(body.pandit_id || '');
    if (pid) { const p = db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(pid); if (!p || p.status !== 'verified') return res.status(400).json({ error: 'assign a verified pandit' }); }
    if (st === 'confirmed' && !pid) return res.status(400).json({ error: 'assign a pandit to confirm' });
    const note = body.note == null ? b.admin_note : clip(body.note, 300);
    db.prepare("UPDATE astro_bookings SET status=?,pandit_id=?,admin_note=?,updated_at=datetime('now') WHERE id=?").run(st, pid, note, b.id);
    const puja = pujaOf(b.puja) || { n: b.puja };
    if (st === 'confirmed' && (b.status !== 'confirmed' || b.pandit_id !== pid)) {
      const p = db.prepare('SELECT * FROM astro_pandits WHERE id=?').get(pid);
      push(b.user_phone, { title: 'Puja confirmed', body: puja.n + ' on ' + b.date + ' with ' + p.name, tag: 'astro-book-' + b.id, url: '/astro/pandit.html?v=bookings' });
      if (p.user_phone) push(p.user_phone, { title: 'New booking', body: puja.n + ' · ' + b.date + ' · ' + PRICE.rupees(b.price), tag: 'astro-job-' + b.id, url: '/astro/pandit.html?v=jobs' });
    } else if (st === 'cancelled' && b.status !== 'cancelled') push(b.user_phone, { title: 'Booking cancelled', body: puja.n + ' on ' + b.date + (note ? ': ' + note : ''), tag: 'astro-book-' + b.id, url: '/astro/pandit.html?v=bookings' });
    res.json({ ok: true, booking: Object.assign(bookingOut(db.prepare('SELECT * FROM astro_bookings WHERE id=?').get(b.id), true), { pandit_id: pid }) });
  });

  console.log('[astro] palm reader, pandits and bookings ready (' + PUJAS.pujas.length + ' pujas, ' + CITIES.cities.length + ' cities, vision ' + (visionKeys().gemini ? 'gemini' : visionKeys().openai ? 'openai' : 'off') + ')');
  return { palmPrompt, cleanReading };
}

module.exports = { install, palmPrompt, cleanReading, PALM_ENUMS };
