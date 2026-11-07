// v38 the streak and the notifications: the inbox (every notification waits in the bell, pushes or not), the day's
// three nudges at most (the morning with today's lesson, the midday story with its photo or now and then the open
// tasks, the evening streak call), quiet hours, pause, milestones; and in the app: the flame and the bell in the
// header, the inbox, the streak card on Lessons, a streak day won by reading 6 cards (the celebration, and the offer to
// turn notifications on, made only then), and the Notifications sheet's new switches.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import { spawn, execFileSync } from 'child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim();
const require = createRequire(ROOT + '/package.json');
const Database = require('better-sqlite3'); const { chromium } = require('playwright');
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 600))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the nudges on their own (an in-memory database, a stand-in push) ──
{
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users(phone TEXT PRIMARY KEY, name TEXT, last_seen TEXT, tz TEXT)");
  db.exec("CREATE TABLE push_subs(user_phone TEXT, endpoint TEXT UNIQUE, keys_p256dh TEXT, keys_auth TEXT, hydration INTEGER, vapid TEXT DEFAULT '')");
  db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY, user_phone TEXT, title TEXT, notes TEXT, status TEXT, due_date TEXT, reminder_time TEXT, reminded INTEGER DEFAULT 0, priority TEXT, created_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE schedule_blocks(user_phone TEXT, label TEXT, start_time TEXT, date TEXT)");
  db.exec("CREATE TABLE news_stories(id TEXT, headline TEXT, source_count INTEGER, published_at TEXT, created_at TEXT DEFAULT (datetime('now')))");
  db.prepare("INSERT INTO users VALUES('A','Asha Rao',datetime('now'),'Asia/Kolkata')").run();
  db.prepare("INSERT INTO users VALUES('B','Bina',datetime('now'),'Asia/Kolkata')").run();
  db.prepare("INSERT INTO push_subs VALUES('A','https://push/a','p','a',0,'')").run();
  const sent = []; const push = { publicKey: 'k', send: (phone, p) => { const n = db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_phone=?').get(phone).n; if (n) sent.push({ phone, p }); return n; }, sendNow: async () => 1 };
  const app = { get() {}, post() {} };
  const NU = require(ROOT + '/modules/nudges.js'), DG = require(ROOT + '/modules/digest.js');
  let story = { id: 's1', headline: 'Kerala adds evening ferries on the backwaters', summary: 'The state will run four more ferries every evening. Tickets stay the same.', image: '/api/news/photo/s1.jpg' };
  let tasksOpen = [];
  const nu = NU.install(app, { db, auth: () => {}, push, tzOf: () => 'Asia/Kolkata', topStory: () => story, openTasks: () => tasksOpen, timer: false, log: () => {} });
  const at = (day, hh, mm) => new Date(Date.parse(day + 'T00:00:00Z') + ((hh * 60 + mm) - 330) * 60e3); // IST clock → a Date
  const inbox = phone => db.prepare('SELECT * FROM inbox WHERE user_phone=? ORDER BY id').all(phone);

  const r1 = nu.deliver('A', { kind: 'news', title: 'Hello', body: 'World', url: '/?tab=news&s=s1', image: '/x.jpg' });
  check('deliver(): the notification waits in the inbox, and goes to the phone with its inbox id and the photo\'s full address', inbox('A').length === 1 && r1.pushed === 1 && /[?&]nid=\d+$/.test(sent[0].p.url) && sent[0].p.image === 'https://brodoit.com/x.jpg' && sent[0].p.nid === r1.id, sent[0]);
  const r2 = nu.deliver('B', { kind: 'streak', title: 'Hi', url: '//evil.example/x' });
  check('…a phone without pushes still gets it in its inbox (the bell); an address off the site becomes "/"', r2.pushed === 0 && inbox('B').length === 1 && inbox('B')[0].url === '/', inbox('B'));
  // midday: the top story with its photo; once a day
  sent.length = 0;
  let day = '2026-11-08'; while (Math.floor(Date.parse(day + 'T00:00:00Z') / 864e5) % 3 === 0) day = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  nu.tick(at(day, 12, 10));
  check('midday: nothing before 12:30', sent.length === 0, sent);
  nu.tick(at(day, 12, 35)); const m1 = sent.filter(x => x.phone === 'A');
  check('midday (12:30-12:50 on the user\'s clock): the top story, with its photo, opening it in News', m1.length === 1 && m1[0].p.type === 'news' && /^📰 Kerala adds/.test(m1[0].p.title) && m1[0].p.image === 'https://brodoit.com/api/news/photo/s1.jpg' && /^\/\?tab=news&s=s1&nid=/.test(m1[0].p.url) && m1[0].p.body === 'The state will run four more ferries every evening.', m1);
  nu.tick(at(day, 12, 40));
  check('…once a day', sent.filter(x => x.phone === 'A').length === 1);
  // every third day (or with no story), the tasks still open
  let tday = day; while (Math.floor(Date.parse(tday + 'T00:00:00Z') / 864e5) % 3 !== 0) tday = new Date(Date.parse(tday) + 864e5).toISOString().slice(0, 10);
  tasksOpen = [{ title: 'Pay the electricity bill' }, { title: 'Call the bank' }, { title: 'Book the tickets' }]; sent.length = 0;
  nu.tick(at(tday, 12, 31)); const m2 = sent.filter(x => x.phone === 'A');
  check('…now and then (every third day) the tasks still open instead ("✅ 3 tasks left today")', m2.length === 1 && m2[0].p.type === 'tasks' && m2[0].p.title === '✅ 3 tasks left today' && /Pay the electricity bill, Call the bank \+1 more/.test(m2[0].p.body), m2);
  check('quiet hours: 22:00 to 07:00 on the user\'s clock', NU.quiet(22 * 60) && NU.quiet(3 * 60) && !NU.quiet(7 * 60) && !NU.quiet(21 * 60 + 59));
  // pause: the inbox still, no push
  db.prepare("INSERT INTO notify_more(user_phone, paused_until) VALUES('A', ?)").run(new Date(Date.now() + 864e5).toISOString()); sent.length = 0;
  const r3 = nu.deliver('A', { kind: 'news', title: 'Paused?', url: '/' });
  check('paused for a week: still in the inbox, no push', r3.pushed === 0 && sent.length === 0 && inbox('A').some(x => x.title === 'Paused?'));
  db.prepare("UPDATE notify_more SET paused_until='' WHERE user_phone='A'").run();
  // the words
  const s1 = NU.streakLine({ n: 4, done: false, hi: false, title: 'Deep Work', hero: 'Vikram', k: 0 }), s2 = NU.streakLine({ n: 0, done: false, hi: false, title: 'Deep Work', hero: 'Vikram', k: 0 }), s3 = NU.streakLine({ n: 4, done: false, hi: true, title: 'Deep Work', hero: 'विक्रम', k: 1 });
  check('the streak call: "🔥 Your 4-day streak ends at midnight", "8 minutes keeps it alive: Deep Work, told through Vikram\'s story."; a new one: "🌱 Start a streak tonight"; in Hindi too', s1.title === '🔥 Your 4-day streak ends at midnight' && s1.body === '8 minutes keeps it alive: Deep Work, told through Vikram\'s story.' && s2.title === '🌱 Start a streak tonight' && s3.title === '🔥 दिन 5 बस एक सबक दूर है' && /विक्रम की कहानी/.test(s3.body), { s1, s2, s3 });
  check('milestones (3, 7, 14, 30 … days) in honest words, none on other days', NU.milestone(7, false).title === '🏆 7-day streak!' && NU.milestone(30, false).body.includes('30 days in a row') && NU.milestone(8, false) === null && NU.milestone(3, true).title === '🏆 3 दिन लगातार!');
  // the summaries through the inbox: the morning with today's lesson, the evening as the streak call
  let sk = { streak: 4, today: false }, lang = 'en';
  const dg = DG.install(app, { db, auth: () => {}, push, tzOf: () => 'Asia/Kolkata', timer: false, log: () => {}, deliver: (p, it) => nu.deliver(p, it), users: () => nu.activeUsers(), langOf: () => lang,
    lessonOfDay: (p, l) => ({ id: 'deep', title: 'Deep Work', hero: l === 'hi' ? 'विक्रम' : 'Vikram' }), streakOf: () => sk });
  const mo = dg.morning('A', at(day, 8, 5)), ev = dg.evening('A', at(day, 20, 35));
  check('the morning summary names today\'s lesson and opens it ("Today\'s lesson: Deep Work, told through Vikram\'s story (8 min)")', /^☀️ Good morning, Asha$/.test(mo.title) && /Today's lesson: Deep Work, told through Vikram's story \(8 min\)/.test(mo.body) && mo.url === '/?bk=deep', mo);
  check('the evening, today\'s lesson still to do: the streak call leads ("🔥 …4-day streak…"), opening the lesson', /^🔥 .*4/.test(ev.title) && /8 minutes keeps it alive: Deep Work/.test(ev.body) && ev.url === '/?bk=deep' && ev.kind === 'streak', ev);
  sk = { streak: 5, today: true }; const ev2 = dg.evening('A', at(day, 20, 35));
  check('…today done: the usual evening, with "🔥 5-day streak, today done"', ev2.title === 'Your day' && /^🔥 5-day streak, today done/.test(ev2.body), ev2);
  lang = 'hi'; sk = { streak: 2, today: false }; const mh = dg.morning('A', at(day, 8, 5)), eh = dg.evening('A', at(day, 20, 35));
  check('…in Hindi for a Hindi user ("☀️ सुप्रभात", "आज का सबक: Deep Work, विक्रम की कहानी", the streak call in Hindi)', /^☀️ सुप्रभात/.test(mh.title) && /आज का सबक: Deep Work, विक्रम की कहानी/.test(mh.body) && /^🔥/.test(eh.title) && /[ऀ-ॿ]/.test(eh.title), { mh, eh });
  lang = 'en'; sk = { streak: 4, today: false };
  // a whole day: at most three pushes (morning, midday, evening), all in the inbox; B (no pushes) has them in the inbox
  let d2 = new Date(Date.parse(day) + 864e5 * 2).toISOString().slice(0, 10); while (Math.floor(Date.parse(d2 + 'T00:00:00Z') / 864e5) % 3 === 0) d2 = new Date(Date.parse(d2) + 864e5).toISOString().slice(0, 10);
  tasksOpen = []; sent.length = 0; const before = inbox('B').length;
  for (let mm = 0; mm < 24 * 60; mm += 5) { const t = at(d2, Math.floor(mm / 60), mm % 60); dg.tick(t); nu.tick(t); }
  const aDay = sent.filter(x => x.phone === 'A');
  check('a whole day: three pushes at most (the morning, the midday story, the evening streak call), none between 22:00 and 07:00', aDay.length === 3 && aDay.map(x => x.p.type).join(',') === 'digest,news,streak', aDay.map(x => x.p.type + ' ' + x.p.title));
  check('…and a user whose phone takes no pushes finds the same three in the inbox', inbox('B').length - before === 3, inbox('B').slice(before).map(x => x.kind + ' ' + x.title));
}

// ── the real server, the real app ──
const DB = TMP + '/nt.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const { token, phone } = (() => { const db = new Database(DB, { readonly: true }); const u = db.prepare('SELECT token, phone FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get(); db.close(); return u; })();
const MEDIA = fs.mkdtempSync('/tmp/p38nt-');
const PORT = 3341, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999', BOOK_ELEVEN_DELAY_MS: '999999999', STUB_PORT: '3342' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots (with the inbox and the nudges)', up && /\[nudges\] ready/.test(out.join('')), out.slice(-5));
const H = { 'Content-Type': 'application/json', 'x-token': token };
const browser = await chromium.launch();
try {
  const sw = await (await fetch(BASE + '/sw.js')).text();
  check('the service worker shows a story\'s photo and marks a tapped notification read in the inbox', /opts\.image=d\.image/.test(sw) && /\/api\/inbox\/read/.test(sw) && /nid:\+d\.nid/.test(sw));
  let r = await (await fetch(BASE + '/api/inbox', { headers: H })).json();
  check('/api/inbox: empty to start', Array.isArray(r.items) && r.items.length === 0 && r.unread === 0, r);
  check('/api/inbox needs a signed-in user', (await fetch(BASE + '/api/inbox')).status === 401);
  // two notifications waiting
  { const db = new Database(DB); db.prepare("INSERT INTO inbox(user_phone, kind, title, body, url) VALUES(?,?,?,?,?)").run(phone, 'streak', '🔥 Your 3-day streak ends at midnight', '8 minutes keeps it alive: Atomic Habits.', '/?bk=atomic');
    db.prepare("INSERT INTO inbox(user_phone, kind, title, body, url) VALUES(?,?,?,?,?)").run(phone, 'news', '📰 Kerala adds evening ferries', 'The state will run four more ferries every evening.', '/?tab=news'); db.close(); }
  r = await (await fetch(BASE + '/api/inbox/count', { headers: H })).json();
  check('/api/inbox/count: 2 unread', r.unread === 2, r);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(String(e.stack || e).slice(0, 400)));
  // a phone that has not been asked yet (headless Chromium says "denied" by itself)
  await page.addInitScript(t => { localStorage.setItem('tf_token', t); localStorage.setItem('bd_onboarded', '1'); try { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' }); } catch (e) {} }, token);
  await page.goto(BASE + '/?tab=books', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lz-tile', { timeout: 45000 }); await sleep(3500);
  const hd = await page.evaluate(() => ({ flame: !!document.querySelector('.hdr .hd-flame.cold'), n: (document.querySelector('.hdr .hd-flame b') || {}).textContent, bell: (document.querySelector('.hdr .hd-bell i') || {}).textContent, label: (document.querySelector('.hdr .hd-bell') || { getAttribute: () => '' }).getAttribute('aria-label'), card: !!document.querySelector('.sk-card.cold'), go: (document.querySelector('.sk-card .sk-go') || {}).textContent, week: document.querySelectorAll('.sk-card .sk-d').length }));
  check('the header: the streak flame (grey, flickering: today still to do, 0) and the bell with 2 new', hd.flame && hd.n === '0' && hd.bell === '2' && /Notifications \(2 new\)/.test(hd.label), hd);
  check('Lessons opens on the streak card: the week (7 days) and "Play today\'s lesson"', hd.card && hd.week === 7 && /Play today's lesson/.test(hd.go), hd);
  // the inbox
  await page.click('.hdr .hd-bell'); await page.waitForSelector('#nbInbox .nb-it', { timeout: 8000 }); await sleep(400);
  const ib = await page.evaluate(() => ({ items: [...document.querySelectorAll('#nbInbox .nb-it b')].map(b => b.textContent), fresh: document.querySelectorAll('#nbInbox .nb-it.new').length, ask: !!document.querySelector('#nbInbox .nb-ask'), promise: (document.querySelector('#nbInbox .nb-promise') || {}).textContent, streak: (document.querySelector('#nbInbox .nb-streak b') || {}).textContent }));
  check('the bell opens the inbox: the newest first, unread marked, the streak on top', ib.items[0] === '📰 Kerala adds evening ferries' && ib.items[1] === '🔥 Your 3-day streak ends at midnight' && ib.fresh === 2 && ib.streak === '0 day streak', ib);
  check('…and, notifications not yet allowed, a card that offers them with its promise ("At most 3 a day. Never between 10 pm and 7 am.")', ib.ask && /At most 3 a day\. Never between 10 pm and 7 am\./.test(ib.promise), ib);
  await sleep(1800);
  const rd = await page.evaluate(() => ({ bell: !!document.querySelector('.hd-bell i'), unread: Inbox.unread }));
  check('…seen: read a moment later (the badge goes)', !rd.bell && rd.unread === 0, rd);
  await page.click('#nbInbox .nb-it >> nth=1'); await page.waitForSelector('.lz .lz-card.on', { timeout: 10000 }); await sleep(500);
  check('a notification tapped in the inbox opens where it points (the streak call → its lesson)', (await page.evaluate(() => Lessons.state() && Lessons.state().id)) === 'atomic');
  await page.evaluate(() => Lessons.close()); await sleep(400);
  // a streak day: 6 cards read
  await page.evaluate(() => Lessons.open('deep', 0)); await page.waitForSelector('.lz .lz-card.on', { timeout: 10000 }); await sleep(500);
  for (let k = 0; k < 6; k++) { await page.keyboard.press('ArrowRight'); await sleep(250); }
  await page.waitForSelector('#skCele', { timeout: 8000 }); await sleep(900);
  const ce = await page.evaluate(() => ({ n: document.getElementById('skBig').textContent, lbl: document.querySelector('#skCele .sk-lbl').textContent, ask: !!document.querySelector('#skCele .nb-ask'), week: document.querySelectorAll('#skCele .sk-d.on').length, st: S.bookStreak }));
  check('6 cards read: the day is won (the server keeps it), and it is celebrated: "1", "day streak!", today\'s flame lit', ce.n === '1' && ce.lbl === 'day streak!' && ce.week === 1 && ce.st.streak === 1 && ce.st.today === true, ce);
  check('…and that moment offers notifications (with its promise)', ce.ask, ce);
  await page.click('#skCele .nb-btn:not(.nb-btn-p)'); await sleep(200);
  const asked = await page.evaluate(() => ({ a: JSON.parse(localStorage.getItem('bd_ask_v1') || '{}'), again: Inbox.canAsk() }));
  check('…"Not now" is remembered (not asked again for 5 days)', asked.a.n === 1 && asked.again === false, asked);
  await page.click('#skCele .sk-cont'); await sleep(300);
  await page.evaluate(() => Lessons.close()); await sleep(500);
  const hd2 = await page.evaluate(() => ({ cold: !!document.querySelector('.hdr .hd-flame.cold'), n: (document.querySelector('.hdr .hd-flame b') || {}).textContent, card: !!document.querySelector('.sk-card.cold'), go: !!document.querySelector('.sk-card .sk-go') }));
  check('after: the flame burns in the header (1) and on the card (no more "Play today\'s lesson")', !hd2.cold && hd2.n === '1' && !hd2.card && !hd2.go, hd2);
  r = await (await fetch(BASE + '/api/book-streak', { headers: H })).json();
  check('/api/book-streak: the day is the user\'s own, with the best streak', r.streak === 1 && r.today === true && r.best === 1 && /^\d{4}-\d{2}-\d{2}$/.test(r.day), r);
  r = await (await fetch(BASE + '/api/book-streak', { method: 'POST', headers: H, body: JSON.stringify({ date: '2020-01-01', seconds: 120 }) })).json();
  check('…a second win the same day is not "fresh" (no second celebration), and a date far off is taken as today', r.ok && r.fresh === false && r.streak === 1 && r.total === 1, r);
  // the Notifications sheet: the new switches, the promise, pause
  await page.evaluate(() => Notify.open()); await page.waitForSelector('#ntS', { timeout: 8000 }); await sleep(500);
  const nt = await page.evaluate(() => ({ s: document.getElementById('ntS').getAttribute('aria-checked'), n: document.getElementById('ntN').getAttribute('aria-checked'), k: document.getElementById('ntK').getAttribute('aria-checked'), promise: (document.querySelector('.nt-promise') || {}).textContent, pause: document.getElementById('ntPause').textContent }));
  check('the Notifications sheet: the streak call, the midday story, task nudges (all on), our promise, "Pause for a week"', nt.s === 'true' && nt.n === 'true' && nt.k === 'true' && /at most 3 a day/.test(nt.promise) && nt.pause === 'Pause for a week', nt);
  await page.click('#ntN'); await sleep(400); await page.click('#ntPause'); await sleep(500);
  r = await (await fetch(BASE + '/api/notify/more', { headers: H })).json();
  check('…a switch saves (midday story off) and "Pause for a week" pauses', r.news === false && r.streak === true && Date.parse(r.paused_until) > Date.now() + 6 * 864e5, r);
  // a milestone goes to the inbox (no push)
  { const db = new Database(DB); const d = new Date(); const key = k => { const x = new Date(d.getTime() - k * 864e5); return new Date(x.getTime() - x.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };
    db.prepare('DELETE FROM book_listens WHERE user_phone=?').run(phone); for (const k of [1, 2]) db.prepare('INSERT INTO book_listens(user_phone,date,seconds) VALUES(?,?,120)').run(phone, key(k)); db.close(); }
  r = await (await fetch(BASE + '/api/book-streak', { method: 'POST', headers: H, body: JSON.stringify({ seconds: 120 }) })).json();
  const ib2 = await (await fetch(BASE + '/api/inbox', { headers: H })).json();
  check('day 3: "🏆 3-day streak!" waits in the inbox', r.fresh && r.streak === 3 && r.milestone === '🏆 3-day streak!' && ib2.items[0].title === '🏆 3-day streak!', { r, first: ib2.items[0] });
  check('no page errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nnotify: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
