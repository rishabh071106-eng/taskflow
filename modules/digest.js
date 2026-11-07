// v21: what reaches the phone, on the user's own clock (users.tz; India when unknown).
//   Morning summary (default 08:00): today's tasks with their times, today's plan blocks, the step goal, yesterday's
//     steps and the streak, and the top story → opens /?tab=tasks.
//   Evening summary (default 20:30): today's steps against the goal, the streak, the tasks still open → /?tab=steps.
//   Each is built from the data as it is when it is sent, once a day per kind (push_sent), within 15 minutes of its time
//   (so a restart does not lose it), only for users with a subscription. While the evening summary is on, the steps
//   module's own evening nudge stays quiet (ownsEvening).
//   Task reminders fire at the task's local date and time, up to 10 minutes late, once (tasks.reminded).
// v38 (modules/nudges.js): every summary also lands in the user's inbox (the bell), pushes or not, for everyone who
// opened the app in the last three weeks; the morning names today's lesson; the evening becomes the streak call when
// today's lesson is not done (and says so when it is); Hindi users get it in Hindi.
// Routes: GET/POST /api/notify/prefs {morning, evening, m_time, e_time}, POST /api/notify/test (sends the morning
// summary now; answers how many devices took it), GET /api/notify/status (counts only, for the live check).
//   install(app, { db, auth, push, tzOf(phone), steps() → steps module | null, log, now?, timer? })
//     → { tick(now), reminders(now), morning(phone, now), evening(phone, now), prefsOf(phone), ownsEvening(phone), stop }
'use strict';

const DEF = { morning: true, evening: true, m_time: '08:00', e_time: '20:30' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = s => { const m = HHMM.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : -1; };
const fmtN = n => Number(n || 0).toLocaleString('en-IN');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const fmtTime = s => { const m = toMin(s); if (m < 0) return ''; const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' am' : ' pm'); };
const fmtCache = new Map();
function parts(now, tz) {
  let f = fmtCache.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return parts(now, 'Asia/Kolkata'); } fmtCache.set(tz, f); }
  const p = {}; for (const x of f.formatToParts(now)) p[x.type] = x.value;
  return { key: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
const addDays = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function install(app, deps) {
  const { db, auth, push } = deps;
  const log = deps.log || ((...a) => console.log('[digest]', ...a));
  const nowOf = () => (deps.now ? deps.now() : new Date());
  const tzOf = phone => { try { return (deps.tzOf && deps.tzOf(phone)) || 'Asia/Kolkata'; } catch (e) { return 'Asia/Kolkata'; } };
  const q = s => db.prepare(s);
  db.exec("CREATE TABLE IF NOT EXISTS notify_prefs(user_phone TEXT PRIMARY KEY, morning INTEGER DEFAULT 1, evening INTEGER DEFAULT 1, m_time TEXT DEFAULT '08:00', e_time TEXT DEFAULT '20:30', updated_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE IF NOT EXISTS push_sent(user_phone TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_phone, day, kind))");

  function prefsOf(phone) {
    const r = q('SELECT morning, evening, m_time, e_time FROM notify_prefs WHERE user_phone=?').get(phone);
    return r ? { morning: !!r.morning, evening: !!r.evening, m_time: HHMM.test(r.m_time) ? r.m_time : DEF.m_time, e_time: HHMM.test(r.e_time) ? r.e_time : DEF.e_time } : Object.assign({}, DEF);
  }
  const devices = phone => { try { return q('SELECT COUNT(*) n FROM push_subs WHERE user_phone=? AND (vapid IS NULL OR vapid=\'\' OR vapid=?)').get(phone, push.publicKey).n; } catch (e) { return 0; } };
  const ownsEvening = phone => { try { return prefsOf(phone).evening && devices(phone) > 0; } catch (e) { return false; } };

  const firstName = phone => { try { const u = q('SELECT name FROM users WHERE phone=?').get(phone); return String((u && u.name) || '').trim().split(/\s+/)[0] || ''; } catch (e) { return ''; } };
  const openTasks = (phone, day) => { try { return q("SELECT id, title, reminder_time FROM tasks WHERE user_phone=? AND status!='done' AND due_date=? ORDER BY (reminder_time IS NULL OR reminder_time=''), reminder_time, priority DESC, created_at").all(phone, day); } catch (e) { return []; } };
  const blocks = (phone, day) => { try { return q('SELECT label, start_time FROM schedule_blocks WHERE user_phone=? AND date=? ORDER BY start_time').all(phone, day); } catch (e) { return []; } };
  const topStory = () => { try { return q("SELECT id, headline FROM news_stories WHERE created_at > datetime('now','-1 day') ORDER BY source_count DESC, published_at DESC LIMIT 1").get() || null; } catch (e) { return null; } };
  const stepsOf = phone => { try { const S = deps.steps && deps.steps(); return S && S.summaryFor ? S.summaryFor(phone) : null; } catch (e) { return null; } };
  const listTasks = (ts, n) => ts.slice(0, n).map(t => clip(t.title, 40) + (fmtTime(t.reminder_time) ? ' (' + fmtTime(t.reminder_time) + ')' : '')).join(', ') + (ts.length > n ? ' +' + (ts.length - n) + ' more' : '');
  // v38: the user's language, today's lesson and the learning streak (from the server; all optional)
  const langOf = phone => { try { return deps.langOf && deps.langOf(phone) === 'hi' ? 'hi' : 'en'; } catch (e) { return 'en'; } };
  const lessonOf = (phone, lang) => { try { return deps.lessonOfDay ? deps.lessonOfDay(phone, lang) : null; } catch (e) { return null; } };
  const streakOf = phone => { try { return deps.streakOf ? deps.streakOf(phone) : null; } catch (e) { return null; } };
  const streakOn = phone => { try { return !global._nudges || global._nudges.prefsOf(phone).streak; } catch (e) { return true; } };
  const NU = (() => { try { return require('./nudges.js'); } catch (e) { return null; } })();

  // ── the two summaries, from the data as it is now ──
  function morning(phone, now) {
    now = now || nowOf();
    const t = parts(now, tzOf(phone)), name = firstName(phone), lines = [], hi = langOf(phone) === 'hi';
    const ts = openTasks(phone, t.key), bl = blocks(phone, t.key);
    const ls = lessonOf(phone, hi ? 'hi' : 'en');
    if (ls) lines.push(hi ? `आज का सबक: ${ls.title}, ${ls.hero} की कहानी (8 मिनट)` : `Today's lesson: ${ls.title}, told through ${ls.hero}'s story (8 min)`);
    lines.push(ts.length ? (hi ? `आज ${ts.length} काम: ${listTasks(ts, 3)}` : `${ts.length} task${ts.length > 1 ? 's' : ''} today: ${listTasks(ts, 3)}`) : (hi ? 'आज के लिए अभी कोई काम नहीं।' : 'No tasks for today yet.'));
    if (bl.length) lines.push('Plan: ' + bl.slice(0, 3).map(b => (fmtTime(b.start_time) ? fmtTime(b.start_time) + ' ' : '') + clip(b.label, 30)).join(', '));
    const st = stepsOf(phone);
    if (st && st.goal) {
      const y = (st.week || []).find(d => d.date === addDays(t.key, -1));
      lines.push(`Steps: goal ${fmtN(st.goal)}` + (y ? ` · yesterday ${fmtN(y.counted)}` : '') + (st.streak ? ` · ${st.streak}-day streak` : ''));
    }
    const top = topStory(); if (top && !hi) lines.push('Top story: ' + clip(top.headline, 90));
    return { type: 'digest', kind: 'morning', title: (hi ? '☀️ सुप्रभात' : '☀️ Good morning') + (name ? ', ' + name : ''), body: lines.join('\n'), tag: 'digest-morning', renotify: true, url: ls ? '/?bk=' + encodeURIComponent(ls.id) : '/?tab=tasks' };
  }
  function evening(phone, now) {
    now = now || nowOf();
    const t = parts(now, tzOf(phone)), lines = [], hi = langOf(phone) === 'hi';
    const st = stepsOf(phone), ts = openTasks(phone, t.key);
    let title = hi ? 'आपका दिन' : 'Your day', url = '/?tab=steps';
    if (st && st.goal) {
      const n = (st.today && st.today.counted) || 0, pct = Math.round(n / st.goal * 100);
      title = `${fmtN(n)} steps today`;
      lines.push(n >= st.goal ? `Goal reached (${pct}% of ${fmtN(st.goal)})` + (st.streak ? ` · ${st.streak}-day streak` : '') : `${pct}% of your ${fmtN(st.goal)} goal · ${fmtN(st.goal - n)} to go` + (st.streak ? ` · keep your ${st.streak}-day streak` : ''));
    }
    lines.push(ts.length ? (hi ? `${ts.length} काम अभी बाक़ी: ${listTasks(ts, 3)}` : `${ts.length} task${ts.length > 1 ? 's' : ''} still open: ${listTasks(ts, 3)}`) : (hi ? 'आज के सारे काम पूरे।' : 'Every task for today is done.'));
    const tomorrow = openTasks(phone, addDays(t.key, 1)); if (tomorrow.length) lines.push((hi ? 'कल: ' : 'Tomorrow: ') + listTasks(tomorrow, 2));
    // v38: the learning streak leads the evening when today's lesson is still to do
    const sk = streakOn(phone) ? streakOf(phone) : null;
    // someone who has never done a lesson hears "start a streak" every third evening only (no nagging)
    const dn = Math.floor(Date.parse(t.key + 'T00:00:00Z') / 864e5);
    if (sk && NU && (sk.total > 0 || sk.streak > 0 || dn % 3 === 0)) {
      const ls = lessonOf(phone, hi ? 'hi' : 'en');
      const line = NU.streakLine({ n: sk.streak, done: sk.today, hi, title: ls && ls.title, hero: ls && ls.hero, k: Math.floor(Date.parse(t.key + 'T00:00:00Z') / 864e5) });
      if (!sk.today) { title = line.title; if (line.body) lines.unshift(line.body); url = ls ? '/?bk=' + encodeURIComponent(ls.id) : '/?tab=books'; }
      else if (sk.streak > 0) lines.unshift(line.title);
    }
    return { type: 'digest', kind: sk && !sk.today ? 'streak' : 'evening', title, body: lines.join('\n'), tag: 'digest-evening', renotify: true, url };
  }

  // ── the minute tick ──
  function claim(phone, day, kind) { try { return q('INSERT OR IGNORE INTO push_sent(user_phone, day, kind) VALUES(?,?,?)').run(phone, day, kind).changes > 0; } catch (e) { return false; } }
  function summaries(now) {
    let users = []; try { users = deps.users ? deps.users() : q('SELECT DISTINCT user_phone FROM push_subs').all().map(r => r.user_phone); } catch (e) { return 0; }
    let sent = 0;
    for (const phone of users) {
      try {
        const p = prefsOf(phone), t = parts(now, tzOf(phone));
        for (const [kind, on, at, make] of [['morning', p.morning, p.m_time, morning], ['evening', p.evening, p.e_time, evening]]) {
          const d = t.min - toMin(at);
          if (!on || d < 0 || d >= 15) continue;
          if (!claim(phone, t.key, kind)) continue;
          const m = make(phone, now);
          // v38: through the inbox (and a push where the phone takes them)
          if (deps.deliver) { const r = deps.deliver(phone, { kind: m.kind === 'streak' ? 'streak' : 'digest', title: m.title, body: m.body, url: m.url, tag: m.tag }); if (r && r.pushed) sent++; }
          else if (push.send(phone, m)) sent++;
        }
      } catch (e) { log('summary', e.message); }
    }
    return sent;
  }
  function reminders(now) {
    const utc = now.toISOString().slice(0, 10);
    let rows = [];
    try { rows = q("SELECT id, user_phone, title, notes, due_date, reminder_time FROM tasks WHERE status!='done' AND reminded=0 AND reminder_time IS NOT NULL AND reminder_time!='' AND due_date BETWEEN ? AND ?").all(addDays(utc, -1), addDays(utc, 1)); } catch (e) { return 0; }
    let n = 0;
    for (const r of rows) {
      const t = parts(now, tzOf(r.user_phone)), at = toMin(r.reminder_time);
      if (at < 0 || t.key !== r.due_date || t.min < at || t.min - at > 10) continue;
      if (!q('UPDATE tasks SET reminded=1 WHERE id=? AND reminded=0').run(r.id).changes) continue;
      const rm = { type: 'reminder', kind: 'reminder', title: '⏰ ' + r.title, body: r.notes || 'Time for: ' + r.title, tag: 'reminder-' + r.id, renotify: true, requireInteraction: true, url: '/?tab=tasks' };
      if (deps.deliver) deps.deliver(r.user_phone, rm); else push.send(r.user_phone, rm); // v38: in the inbox too
      n++;
    }
    return n;
  }
  function tick(now) {
    now = now instanceof Date ? now : new Date(now || nowOf());
    let r = 0, s = 0;
    try { r = reminders(now); } catch (e) { log('reminders', e.message); }
    try { s = summaries(now); } catch (e) { log('summaries', e.message); }
    if (Math.random() < 0.01) { try { q("DELETE FROM push_sent WHERE day < date('now','-14 days')").run(); } catch (e) { /* ignore */ } }
    return { reminders: r, summaries: s };
  }

  // ── routes ──
  app.get('/api/notify/prefs', auth, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(Object.assign(prefsOf(req.user.phone), { devices: devices(req.user.phone), tz: tzOf(req.user.phone) })); });
  app.post('/api/notify/prefs', auth, require('express').json({ limit: '4kb' }), (req, res) => {
    const b = req.body || {}, cur = prefsOf(req.user.phone);
    const p = { morning: b.morning == null ? cur.morning : !!b.morning, evening: b.evening == null ? cur.evening : !!b.evening, m_time: HHMM.test(b.m_time) ? b.m_time : cur.m_time, e_time: HHMM.test(b.e_time) ? b.e_time : cur.e_time };
    q("INSERT INTO notify_prefs(user_phone, morning, evening, m_time, e_time, updated_at) VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(user_phone) DO UPDATE SET morning=excluded.morning, evening=excluded.evening, m_time=excluded.m_time, e_time=excluded.e_time, updated_at=excluded.updated_at")
      .run(req.user.phone, p.morning ? 1 : 0, p.evening ? 1 : 0, p.m_time, p.e_time);
    res.json(Object.assign(p, { devices: devices(req.user.phone) }));
  });
  const testAt = new Map();
  app.post('/api/notify/test', auth, async (req, res) => {
    const phone = req.user.phone, last = testAt.get(phone) || 0;
    if (Date.now() - last < 20000) return res.status(429).json({ error: 'one test every 20 seconds', sent: 0 });
    testAt.set(phone, Date.now());
    const m = morning(phone, nowOf());
    const sent = await push.sendNow(phone, Object.assign(m, { tag: 'digest-test', title: m.title + ' (test)' }));
    res.json({ sent, devices: devices(phone) });
  });

  // counts only (the live check reads it): phones subscribed with the current key, ones still on an older key, sent today
  app.get('/api/notify/status', (req, res) => {
    const n = sql => { try { return q(sql).get(push.publicKey).n; } catch (e) { return 0; } };
    res.set('Cache-Control', 'no-store');
    res.json({ ready: true, devices: n("SELECT COUNT(*) n FROM push_subs WHERE vapid=? OR vapid IS NULL OR vapid=''"), olderKey: n("SELECT COUNT(*) n FROM push_subs WHERE vapid!='' AND vapid IS NOT NULL AND vapid!=?"),
      summariesToday: (() => { try { return q("SELECT COUNT(*) n FROM push_sent WHERE at > datetime('now','-1 day')").get().n; } catch (e) { return 0; } })() });
  });

  let timer = null;
  if (deps.timer !== false) { timer = setInterval(() => tick(nowOf()), 60000); if (timer.unref) timer.unref(); }
  global._digestOwnsEvening = ownsEvening;
  log('ready · morning', DEF.m_time, '· evening', DEF.e_time, '· reminders on local time');
  return { tick, reminders, summaries, morning, evening, prefsOf, ownsEvening, devices, stop() { if (timer) clearInterval(timer); } };
}

module.exports = { install, parts, toMin };
