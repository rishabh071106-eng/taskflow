// v38: the notifications people can trust (owner, 7 Nov: "add streak daily … notifications on a notifications tab … give
// news in the notifications to excite, like 'complete your streak' … make users want to allow notifications … tasks
// should also go sometimes in notification … I want this to be a trusted app").
// Everything Brodoit tells a user lands in their inbox (the bell in the app), whether or not the phone takes pushes; a
// push goes only to a phone that asked for them. At most three a day besides the reminders the user set on their own
// tasks: the morning summary (with today's lesson), one midday note (the top story with its photo, or now and then the
// tasks still open today) and the evening summary (which turns into the streak call when today's lesson is not done).
// Nothing between 22:00 and 07:00 on the user's clock; each kind can be turned off, or all paused for a week; streak
// milestones only go to the inbox (the user is in the app when they happen). Words are honest: no fake urgency, no
// invented rankings.
//   install(app, { db, auth, push, tzOf(phone), lessonOfDay(phone, lang) → { id, title, hero } | null,
//                  topStory(lang) → { id, headline, summary, image } | null, openTasks(phone, day) → [{ title }], log?, now?, timer? })
//     → { deliver(phone, item, { push }), midday(now), prefsOf(phone), activeUsers(), tick(now), stop }
'use strict';

const QUIET_FROM = 22 * 60, QUIET_TO = 7 * 60;
const MIDDAY = 12 * 60 + 30;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const firstSentence = s => { const m = /^(.{20,160}?[.!?।])\s/.exec(String(s || '') + ' '); return m ? m[1] : clip(s, 140); };
const fmtCache = new Map();
function local(now, tz) {
  let f = fmtCache.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return local(now, 'Asia/Kolkata'); } fmtCache.set(tz, f); }
  const p = {}; for (const x of f.formatToParts(now)) p[x.type] = x.value;
  return { key: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
const dayNo = key => Math.floor(Date.parse(key + 'T00:00:00Z') / 864e5);
const quiet = min => min >= QUIET_FROM || min < QUIET_TO;

function install(app, deps) {
  const { db, auth, push } = deps;
  const log = deps.log || ((...a) => console.log('[nudges]', ...a));
  const nowOf = () => (deps.now ? deps.now() : new Date());
  const tzOf = phone => { try { return (deps.tzOf && deps.tzOf(phone)) || 'Asia/Kolkata'; } catch (e) { return 'Asia/Kolkata'; } };
  const q = s => db.prepare(s);
  db.exec("CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', url TEXT DEFAULT '/', image TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), read_at TEXT)");
  db.exec('CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_phone, id)');
  db.exec("CREATE TABLE IF NOT EXISTS notify_more(user_phone TEXT PRIMARY KEY, news INTEGER DEFAULT 1, tasks INTEGER DEFAULT 1, streak INTEGER DEFAULT 1, lang TEXT DEFAULT 'en', paused_until TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE IF NOT EXISTS push_sent(user_phone TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_phone, day, kind))");

  const DEF = { news: true, tasks: true, streak: true, lang: 'en', paused_until: '' };
  function prefsOf(phone) {
    const r = q('SELECT news, tasks, streak, lang, paused_until FROM notify_more WHERE user_phone=?').get(phone);
    return r ? { news: !!r.news, tasks: !!r.tasks, streak: !!r.streak, lang: r.lang === 'hi' ? 'hi' : 'en', paused_until: r.paused_until || '' } : Object.assign({}, DEF);
  }
  function savePrefs(phone, p) {
    q("INSERT INTO notify_more(user_phone, news, tasks, streak, lang, paused_until, updated_at) VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(user_phone) DO UPDATE SET news=excluded.news, tasks=excluded.tasks, streak=excluded.streak, lang=excluded.lang, paused_until=excluded.paused_until, updated_at=excluded.updated_at")
      .run(phone, p.news ? 1 : 0, p.tasks ? 1 : 0, p.streak ? 1 : 0, p.lang === 'hi' ? 'hi' : 'en', p.paused_until || '');
  }
  const paused = p => !!(p.paused_until && Date.parse(p.paused_until) > Date.now());

  // ── one notification: always in the inbox; a push too when the phone takes them and it is not paused ──
  function deliver(phone, it, o) {
    o = o || {};
    const url = typeof it.url === 'string' && it.url.charAt(0) === '/' && it.url.charAt(1) !== '/' ? it.url : '/';
    const image = typeof it.image === 'string' && /^(https:\/\/|\/)/.test(it.image) ? it.image : '';
    const id = Number(q('INSERT INTO inbox(user_phone, kind, title, body, url, image) VALUES(?,?,?,?,?,?)').run(phone, String(it.kind || 'note').slice(0, 20), clip(it.title, 120), clip(it.body, 400), url, image).lastInsertRowid);
    if (Math.random() < 0.05) { try { q("DELETE FROM inbox WHERE created_at < datetime('now','-45 days')").run(); } catch (e) { /* ignore */ } }
    if (o.push === false || paused(prefsOf(phone))) return { id, pushed: 0 };
    const abs = image && image.charAt(0) === '/' ? (process.env.PUBLIC_URL || 'https://brodoit.com').replace(/\/$/, '') + image : image;
    const pushed = push.send(phone, { type: it.kind, title: clip(it.title, 120), body: clip(it.body, 240), url: url + (url.includes('?') ? '&' : '?') + 'nid=' + id, image: abs || undefined, tag: it.tag || it.kind, renotify: true, nid: id, requireInteraction: !!it.requireInteraction });
    return { id, pushed };
  }
  const claim = (phone, day, kind) => { try { return q('INSERT OR IGNORE INTO push_sent(user_phone, day, kind) VALUES(?,?,?)').run(phone, day, kind).changes > 0; } catch (e) { return false; } };
  // who hears from us: anyone who opened the app in the last three weeks, and every phone that takes pushes
  function activeUsers() {
    const out = new Set();
    try { for (const r of q("SELECT phone FROM users WHERE last_seen > datetime('now','-21 days')").all()) out.add(r.phone); } catch (e) { /* no last_seen */ }
    try { for (const r of q('SELECT DISTINCT user_phone FROM push_subs').all()) out.add(r.user_phone); } catch (e) { /* none */ }
    return [...out].filter(Boolean);
  }

  // ── midday: the top story with its photo; now and then (every third day, or when there is no story) the open tasks ──
  function middayFor(phone, now) {
    const t = local(now, tzOf(phone)); const d = t.min - MIDDAY;
    if (d < 0 || d >= 20 || quiet(t.min)) return null;
    const p = prefsOf(phone); if (!p.news && !p.tasks) return null;
    if (!claim(phone, t.key, 'midday')) return null;
    const hi = p.lang === 'hi';
    const tasks = p.tasks && deps.openTasks ? (deps.openTasks(phone, t.key) || []) : [];
    const story = p.news && deps.topStory ? deps.topStory(hi ? 'hi' : 'en') : null;
    if (tasks.length && (dayNo(t.key) % 3 === 0 || !story)) {
      const n = tasks.length, list = tasks.slice(0, 2).map(x => clip(x.title, 36)).join(', ') + (n > 2 ? (hi ? ' और ' + (n - 2) + ' और' : ' +' + (n - 2) + ' more') : '');
      return deliver(phone, { kind: 'tasks', title: hi ? '✅ आज के ' + n + ' काम बाक़ी हैं' : '✅ ' + n + ' task' + (n > 1 ? 's' : '') + ' left today', body: (hi ? 'एक अभी निपटा दें? ' : 'Tick one off now? ') + list, url: '/?tab=tasks', tag: 'midday' });
    }
    if (story) return deliver(phone, { kind: 'news', title: '📰 ' + clip(story.headline, 100), body: firstSentence(story.summary), url: '/?tab=news&s=' + encodeURIComponent(story.id), image: story.image || '', tag: 'midday' });
    return null;
  }
  function midday(now) { let n = 0; for (const phone of activeUsers()) { try { if (middayFor(phone, now)) n++; } catch (e) { log('midday', e.message); } } return n; }
  function tick(now) { now = now instanceof Date ? now : new Date(now || nowOf()); try { return { midday: midday(now) }; } catch (e) { log('tick', e.message); return { midday: 0 }; } }

  // ── routes: the inbox, its count (the bell), read marks, and the extra switches ──
  const rowOut = r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, image: r.image || '', at: String(r.created_at).replace(' ', 'T') + 'Z', read: !!r.read_at });
  const setLang = (phone, l) => { if (l !== 'hi' && l !== 'en') return; const p = prefsOf(phone); if (p.lang !== l) { p.lang = l; savePrefs(phone, p); } };
  app.get('/api/inbox', auth, (req, res) => {
    setLang(req.user.phone, req.query.lang);
    const rows = q('SELECT * FROM inbox WHERE user_phone=? ORDER BY id DESC LIMIT 60').all(req.user.phone);
    res.set('Cache-Control', 'no-store').json({ items: rows.map(rowOut), unread: rows.filter(r => !r.read_at).length });
  });
  app.get('/api/inbox/count', auth, (req, res) => {
    setLang(req.user.phone, req.query.lang);
    res.set('Cache-Control', 'no-store').json({ unread: q('SELECT COUNT(*) n FROM inbox WHERE user_phone=? AND read_at IS NULL').get(req.user.phone).n });
  });
  app.post('/api/inbox/read', auth, require('express').json({ limit: '2kb' }), (req, res) => {
    const b = req.body || {};
    if (b.all) q("UPDATE inbox SET read_at=datetime('now') WHERE user_phone=? AND read_at IS NULL").run(req.user.phone);
    else if (Number.isFinite(+b.id)) q("UPDATE inbox SET read_at=datetime('now') WHERE user_phone=? AND id=? AND read_at IS NULL").run(req.user.phone, +b.id);
    res.json({ ok: true, unread: q('SELECT COUNT(*) n FROM inbox WHERE user_phone=? AND read_at IS NULL').get(req.user.phone).n });
  });
  app.get('/api/notify/more', auth, (req, res) => { res.set('Cache-Control', 'no-store').json(prefsOf(req.user.phone)); });
  app.post('/api/notify/more', auth, require('express').json({ limit: '2kb' }), (req, res) => {
    const b = req.body || {}, p = prefsOf(req.user.phone);
    for (const k of ['news', 'tasks', 'streak']) if (b[k] != null) p[k] = !!b[k];
    if (b.lang === 'hi' || b.lang === 'en') p.lang = b.lang;
    if (b.pause_days != null) { const d = Math.max(0, Math.min(30, +b.pause_days || 0)); p.paused_until = d ? new Date(Date.now() + d * 864e5).toISOString() : ''; }
    savePrefs(req.user.phone, p); res.json(p);
  });

  let timer = null;
  if (deps.timer !== false) { timer = setInterval(() => tick(nowOf()), 60000); if (timer.unref) timer.unref(); }
  const api = { deliver, midday, middayFor, prefsOf, activeUsers, tick, local, quiet, stop() { if (timer) clearInterval(timer); } };
  global._nudges = api;
  log('ready · inbox · midday', '12:30', '· quiet 22:00-07:00');
  return api;
}

// the words: varied, warm, honest (no fake urgency, no invented numbers); en + hi
const MILESTONES = [3, 7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
function streakLine(o) {
  // o: { n (streak before today), done (today done), hi, title, hero, k (variety seed) }
  const { n, hi, title, hero } = o; const k = (o.k || 0) % 3;
  if (o.done) return { title: hi ? '🔥 ' + n + ' दिन की लगातार सीख, आज का सबक पूरा' : '🔥 ' + n + '-day streak, today done', body: '' };
  if (n > 0) {
    const t = hi ? ['🔥 आपकी ' + n + ' दिन की लौ आज रात बुझने न दें', '🔥 दिन ' + (n + 1) + ' बस एक सबक दूर है', '🔥 ' + n + ' दिन लगातार। आज भी?'][k]
      : ['🔥 Your ' + n + '-day streak ends at midnight', '🔥 Day ' + (n + 1) + ' is one lesson away', '🔥 ' + n + ' days in a row. Make it ' + (n + 1) + '?'][k];
    const b = title ? (hi ? 'आठ मिनट काफ़ी हैं: ' + title + (hero ? ', ' + hero + ' की कहानी।' : '।') : '8 minutes keeps it alive: ' + title + (hero ? ', told through ' + hero + '\'s story.' : '.')) : '';
    return { title: t, body: b };
  }
  return { title: hi ? '🌱 आज रात एक नई लौ जलाएँ' : '🌱 Start a streak tonight', body: title ? (hi ? 'एक सबक, आठ मिनट: ' + title + (hero ? ', ' + hero + ' की कहानी।' : '।') : 'One 8-minute lesson: ' + title + (hero ? ', told through ' + hero + '\'s story.' : '.')) : '' };
}
function milestone(n, hi) {
  if (MILESTONES.indexOf(n) < 0) return null;
  const big = n >= 30;
  return hi ? { title: '🏆 ' + n + ' दिन लगातार!', body: big ? 'यह अब आदत है। आपने ' + n + ' दिन बिना चूके कुछ नया सीखा।' : n + ' दिन, ' + n + ' सबक। लौ जलती रहे।' }
    : { title: '🏆 ' + n + '-day streak!', body: big ? 'This is a habit now: ' + n + ' days in a row of learning something new.' : n + ' days, ' + n + ' lessons. Keep the flame going.' };
}

module.exports = { install, streakLine, milestone, MILESTONES, local, quiet };
