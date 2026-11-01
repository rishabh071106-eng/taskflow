// v33 Books: books only, read in Bro's voice. Each book is the book in 7 chapters (app/bookfull.js: Bro's notes + the
// chapter stories of app/ideas/<id>.json), recorded whole in Bro's studio voice ("book-<id>"); until a book's recording
// is on the server, Listen plays Bro's notes on it (the same 7 parts). The public-domain books also have the original,
// chapter by chapter (app/briefs/<id>.json, "brief-<id>"). No Ideas feed, no quiz.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import { spawn, execFileSync } from 'child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim(); // a test database with two signed-in users
const require = createRequire(ROOT + '/package.json');
const Database = require('better-sqlite3'); const { chromium } = require('playwright');
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 600))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the content ──
const idx = JSON.parse(fs.readFileSync(ROOT + '/app/ideas/index.json', 'utf8')).ids;
let v = ''; try { v = execFileSync(process.execPath, [ROOT + '/scripts/book-ideas/validate.mjs', ROOT + '/app/ideas', ...idx], { encoding: 'utf8' }); } catch (e) { v = String(e.stdout || e.message); }
check('every book has its 7 story chapters (index.json: 104 books)', idx.length === 104, idx.length);
check('…and every chapter file passes the content checks (hero, 7 chapters, story lengths, 3 choices, why, takeaway)', /\b0 with problems/.test(v), v.split('\n').slice(-6).join(' | '));
try { execFileSync(process.execPath, [ROOT + '/scripts/book-ideas/index.js'], { stdio: 'pipe' }); check('scripts/book-ideas/index.js rebuilds the same index', JSON.stringify(JSON.parse(fs.readFileSync(ROOT + '/app/ideas/index.json', 'utf8')).ids) === JSON.stringify(idx)); } catch (e) { check('scripts/book-ideas/index.js rebuilds the same index', false, String(e.stdout || e.message)); }
const heroes = idx.map(id => JSON.parse(fs.readFileSync(ROOT + '/app/ideas/' + id + '.json', 'utf8')).hero.name);
check('each book has its own main character (104 different first names)', new Set(heroes).size === 104, new Set(heroes).size);
const PD = ['babylon', 'discourses', 'lettersstoic', 'medi', 'tao'];
const briefs = fs.readdirSync(ROOT + '/app/briefs').filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
check('the 5 public-domain books are back chapter by chapter (app/briefs)', JSON.stringify(briefs) === JSON.stringify(PD), briefs);
const btxt = PD.map(id => JSON.parse(fs.readFileSync(ROOT + '/app/briefs/' + id + '.json', 'utf8')));
check('…each 6,500-8,500 characters, with its public-domain note', btxt.every(b => b.text.length > 6500 && b.text.length < 8500 && /public domain/.test(b.pd)), btxt.map(b => [b.id, b.text.length]));
check('…quoting only public-domain translations (no modern-translation lines)', btxt.every(b => !/What stands in the way becomes the way|power over your own mind|Knowing others is intelligence|I am rising to do the work|fermented grape juice/.test(b.text)));
const notesOut = TMP + '/p14-notes.json';
execFileSync(process.execPath, [ROOT + '/scripts/book-voice/notes.js', notesOut, 'http://127.0.0.1:9'], { stdio: 'pipe' });
const notes = JSON.parse(fs.readFileSync(notesOut, 'utf8'));
check('the narration recorder lists the 5 briefs as "brief-<id>" (so they get the studio voice)', PD.every(id => notes.some(n => n.id === 'brief-' + id && n.text.length > 6000)), notes.length);
const books = notes.filter(n => n.id.startsWith('book-'));
const NUM = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
check('…and every book in 7 chapters as "book-<id>": 104, each 7 paragraphs "Chapter one." … "Chapter seven.", 7,500-9,500 characters', books.length === 104 && books.every(n => { const p = n.text.split('\n\n'); return p.length === 7 && p.every((x, i) => x.startsWith('Chapter ' + NUM[i] + '. ')) && n.text.length > 7500 && n.text.length < 9500; }), books.length);
const bAtomic = books.find(n => n.id === 'book-atomic'); const jAtomic = JSON.parse(fs.readFileSync(ROOT + '/app/ideas/atomic.json', 'utf8'));
check('…a chapter is Bro\'s explanation, then the story, the takeaway and "Try this today" (never a quiz)', bAtomic && jAtomic.chapters.every(c => bAtomic.text.includes(c.story.b) && bAtomic.text.includes('In short: ' + c.take)) && (bAtomic.text.match(/Try this today: /g) || []).length === 5 && !/What would you do|\?\s*Keep the two pages/.test(bAtomic.text) && bAtomic.text.startsWith('Chapter one. Why this book. This is Atomic Habits, by James Clear.') && /Meet Riya, a second-year/.test(bAtomic.text), bAtomic && bAtomic.text.slice(0, 160));
// the books already recorded keep their text (nothing is recorded again)
const keptNote = notes.find(n => n.id === 'atomic');
check('…and Bro\'s notes stay as they were (their recordings stay valid): the note is still the 7-part note', keptNote && keptNote.text.startsWith("Bro's notes on Atomic Habits"), keptNote && keptNote.text.slice(0, 40));

// ── the real server ──
const DB = TMP + '/ideas.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const { token } = (() => { const db = new Database(DB, { readonly: true }); const u = db.prepare('SELECT token FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get(); db.close(); return u; })();
const MEDIA = fs.mkdtempSync('/tmp/p14ideas-');
// Atomic Habits is "recorded": a manifest and an mp3 in MEDIA/book-voice, hashed from the recorder's own text, so the
// server only plays it if it builds exactly the same book text (app/bookfull.js on both sides)
const { textHash } = require(ROOT + '/modules/bookvoice.js');
const BV = path.join(MEDIA, 'book-voice'); fs.mkdirSync(BV, { recursive: true });
const MP3 = path.join(TMP, 'a.mp3'); execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-ac', '1', '-b:a', '64k', MP3]);
const mbuf = fs.readFileSync(MP3); const ah = textHash(bAtomic.text); const afile = 'book-atomic-' + ah + '.mp3';
fs.writeFileSync(path.join(BV, afile), mbuf);
const nDeep = notes.find(n => n.id === 'deep'); const dh = textHash(nDeep.text); const dfile = 'deep-' + dh + '.mp3'; fs.writeFileSync(path.join(BV, dfile), mbuf);
const sha = require('crypto').createHash('sha256').update(mbuf).digest('hex');
fs.writeFileSync(path.join(BV, 'manifest.json'), JSON.stringify({ voice: 'test', license: 'test', made: new Date().toISOString(), items: { 'book-atomic': { file: afile, sha256: sha, bytes: mbuf.length, secs: 560, text: ah }, deep: { file: dfile, sha256: sha, bytes: mbuf.length, secs: 190, text: dh } } }));
const PORT = 3295, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999', STUB_PORT: '3296' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
const browser = await chromium.launch();
try {
  let r = await fetch(BASE + '/api/book-voice/ready'); const rd = await r.json();
  check('/api/book-voice/ready lists the recordings here in Bro\'s studio voice ({ "book-atomic": 560, "deep": 190 })', r.ok && rd.items && rd.items['book-atomic'] === 560 && rd.items.deep === 190 && Object.keys(rd.items).length === 2, rd);
  r = await fetch(BASE + '/api/book-audio/book-atomic?token=' + token);
  const ab = Buffer.from(await r.arrayBuffer());
  check('/api/book-audio/book-atomic plays the recording: the server builds the same book text as the recorder', r.status === 200 && ab.length === mbuf.length, r.status);
  r = await fetch(BASE + '/api/book-audio/book-deep?token=' + token);
  check('a book not recorded yet → 404, never a live voice (the page plays Bro\'s notes instead)', r.status === 404 && (await r.json()).live !== true, r.status);
  r = await fetch(BASE + '/api/book-audio/brief-medi?token=' + token);
  check('/api/book-audio/brief-medi before its recording → 404 live', r.status === 404 && (await r.json()).live === true, r.status);
  await sleep(300);
  let wanted = []; try { wanted = JSON.parse(fs.readFileSync(path.join(MEDIA, 'bro-voice', 'books-wanted.json'), 'utf8')); } catch (e) {}
  check('…and neither a book nor a brief is queued for Bro\'s live engine (the studio narration records them)', !wanted.some(x => /brief|book-/.test(x)), wanted);
  r = await fetch(BASE + '/app/bookfull.js?v=33');
  check('/app/bookfull.js is served (the same builder the server and the recorder use)', r.ok && /BookFull/.test(await r.text()));

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.addInitScript(t => { localStorage.setItem('tf_token', t); localStorage.setItem('bd_onboarded', '1'); }, token);
  await page.goto(BASE + '/?tab=books', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bk-sum-card', { timeout: 45000 });
  await page.waitForFunction(() => window.BookIdeas && BookIdeas.index && BookIdeas.ready, null, { timeout: 15000 }); await sleep(500);
  const seg = await page.$$eval('.bk-seg button', bs => bs.map(b => [b.textContent.trim(), b.classList.contains('on')]));
  check('Books opens on the books: Books · Audiobooks (no Ideas feed)', JSON.stringify(seg) === JSON.stringify([['Books', true], ['Audiobooks', false]]) && !(await page.$('.bi-deck')) && !(await page.$('.bi-svbtn')), seg);
  const cards = await page.evaluate(() => { const m = {}; document.querySelectorAll('.bk-sum-card').forEach(c => { const k = (c.getAttribute('onclick') || '').match(/openBookSummary\('([^']+)'/); if (k) m[k[1]] = c.querySelector('.bk-sum-mins').textContent; }); return { n: Object.keys(m).length, atomic: m.atomic, deep: m.deep }; });
  const deepMins = await page.evaluate(() => BOOK_SUMMARIES.find(b => b.id === 'deep').mins);
  check('every book is on the shelf; a recorded book shows its length (9 min), the others their notes\' length', cards.n === 104 && cards.atomic === '9 min' && cards.deep === deepMins + ' min', Object.assign(cards, { deepMins }));
  // an old phone that last had Ideas open still lands on the books
  await page.evaluate(() => { S.booksMode = 'ideas'; render(); }); await sleep(300);
  check('a phone that last had Ideas open lands on Books', await page.evaluate(() => S.booksMode === 'summaries' && !!document.querySelector('.bk-sum-card')));

  // the book page: Atomic Habits (recorded)
  await page.evaluate(() => openBookSummary('atomic')); await page.waitForSelector('#bi-read .bi-rd', { timeout: 10000 }); await sleep(300);
  const ins = await page.evaluate(() => BOOK_SUMMARIES.find(b => b.id === 'atomic').insights.map(i => i[0]));
  const b1 = await page.evaluate(() => ({ lbl: document.querySelector('.bkp-lbl').textContent, stats: document.querySelector('.bkp-stats').textContent, listen: document.querySelector('.bkp-listen').textContent, ghost: document.querySelector('.bkp-ghost').textContent, rows: [...document.querySelectorAll('#bi-ch .bi-row .bi-t')].map(r => r.textContent), sub: document.querySelector('#bi-ch .bkp-sub').textContent, rec: !!document.querySelector('#bi-ch .bi-rec'), quiz: !!document.querySelector('.bi-opt,#bi-player,.bi-why'), keyIdeas: !!document.getElementById('bkp-ideas'), dock: (document.querySelector('.bkp-dock b') || {}).textContent }));
  check('the book page: "Book · 9 min", 7 chapters, Listen, the chapter list (Why this book, the five ideas, How it turned out)', /^Book · 9 min · /.test(b1.lbl) && /7\s*chapters/.test(b1.stats) && /Listen/.test(b1.listen) && b1.ghost === 'Chapters' && JSON.stringify(b1.rows) === JSON.stringify(['Why this book', ...ins, 'How it turned out']) && /^Read by Bro\. Follow Riya, /.test(b1.sub) && b1.dock === 'Listen to the book', b1);
  check('…no quiz, no Ideas cards, no separate key-ideas list, and no "being recorded" note for a recorded book', !b1.quiz && !b1.keyIdeas && !b1.rec, b1);
  const rd1 = await page.evaluate(() => [...document.querySelectorAll('#bi-read .bi-rd')].map(a => ({ h: a.querySelector('h4').textContent, story: (a.querySelector('.bi-story') || {}).textContent || '', take: (a.querySelector('.bi-take') || {}).textContent || '', tryIt: !!a.querySelector('.bkp-try'), bro: !!a.querySelector('.bi-bro'), meet: (a.querySelector('.bi-meet') || {}).textContent || '' })));
  check('read along: the 7 chapters with the story, the takeaway, "Try it today" in chapters 2-6 and Bro\'s take at the end', rd1.length === 7 && rd1.every((c, i) => c.story === jAtomic.chapters[i].story.b && c.take === jAtomic.chapters[i].take && c.tryIt === (i >= 1 && i <= 5)) && rd1[6].bro && /^Meet Riya, /.test(rd1[0].meet), rd1.map(c => [c.h, c.story.length, c.tryIt, c.bro]));
  // Listen → the whole book in Bro's voice
  await page.click('.bkp-listen'); await sleep(1200);
  const l1 = await page.evaluate(() => ({ id: BKP && BKP.book.id, full: BKP && BKP.book._full, mode: BKP && BKP.mode, secs: BKP && BKP.secs.map(s => s.label), src: (document.getElementById('bk-narr-audio') || {}).src || '', np: (document.querySelector('.bkp-np-src b') || {}).textContent }));
  check('Listen plays the whole book from Bro\'s studio recording ("book-atomic"), one section per chapter', l1.id === 'book-atomic' && l1.full === 'atomic' && l1.mode === 'static' && /\/api\/book-audio\/book-atomic\?/.test(l1.src) && JSON.stringify(l1.secs) === JSON.stringify(['Why this book', ...ins, 'How it turned out']) && l1.np === '9-min book', l1);
  await page.evaluate(() => { S.bkNP = false; render(); }); await sleep(300);
  await page.click('#bi-ch .bi-row >> nth=3'); await sleep(500);
  const l2 = await page.evaluate(() => ({ id: BKP.book.id, sec: _bkSecAt(BKP.pendingChar != null ? BKP.pendingChar : _bkPos().ch), n: document.querySelectorAll('.bkp-np').length }));
  check('…tap chapter 4 → the book from chapter 4', l2.id === 'book-atomic' && l2.sec === 3 && l2.n === 1, l2);
  await page.evaluate(() => { S.bkNP = false; render(); }); await sleep(300);
  const mini = await page.evaluate(() => ({ t: (document.querySelector('.bk-mini-info b') || {}).textContent, cover: bookCover(BKP.book.id) === bookCover('atomic') && !!bookCover('atomic') }));
  check('…the mini player shows the book (its title, and the book\'s cover for "book-atomic")', mini.t === 'Atomic Habits' && mini.cover, mini);
  await page.evaluate(() => { try { bkpStop(true); } catch (e) {} closeBookReader(); }); await sleep(200);

  // Deep Work: not recorded yet → Bro's notes, the same 7 parts
  await page.evaluate(() => openBookSummary('deep')); await page.waitForSelector('#bi-read .bi-rd', { timeout: 10000 }); await sleep(300);
  const d1 = await page.evaluate(() => ({ rec: (document.querySelector('#bi-ch .bi-rec') || {}).textContent || '', lbl: document.querySelector('.bkp-lbl').textContent }));
  check('a book not recorded yet says Bro is recording it, and Listen will play his notes for now', /^Bro is recording this book in his voice\./.test(d1.rec) && new RegExp('^Book · ' + deepMins + ' min').test(d1.lbl), d1);
  await page.click('#bi-ch .bi-row >> nth=2'); await sleep(800);
  const d2 = await page.evaluate(() => ({ id: BKP && BKP.book.id, secs: BKP && BKP.secs.length, mode: BKP && BKP.mode, sec: BKP && _bkSecAt(BKP.pendingChar != null ? BKP.pendingChar : _bkPos().ch), src: (document.getElementById('bk-narr-audio') || {}).src || '' }));
  check('…tap chapter 3 → Bro\'s recorded notes from his third part (never a live voice)', d2.id === 'deep' && d2.secs === 7 && d2.mode === 'static' && d2.sec === 2 && /\/api\/book-audio\/deep\?/.test(d2.src), d2);
  await page.evaluate(() => { try { bkpStop(true); } catch (e) {} closeBookReader(); }); await sleep(200);

  // Try it today from the read-along
  await page.evaluate(() => openBookSummary('atomic')); await page.waitForSelector('#bi-read .bkp-try button', { timeout: 10000 });
  await page.click('#bi-read .bkp-try button >> nth=0'); await sleep(1500);
  const tried = await page.evaluate(() => !!(S.bkTried && S.bkTried['atomic:0']));
  check('"Add to my tasks" in chapter 2 adds its "Try it today" as a task', tried, tried);
  await page.evaluate(() => closeBookReader()); await sleep(200);

  // the public-domain original
  await page.evaluate(() => openBookSummary('medi')); await page.waitForSelector('#bi-brief', { timeout: 10000 }); await sleep(300);
  const m1 = await page.evaluate(() => ({ h: document.querySelector('#bi-brief h2').textContent, btn: document.querySelector('#bi-brief .bi-start').textContent, paras: document.querySelectorAll('#bi-brief .bi-brief-txt p').length, first: (document.querySelector('#bi-brief .bi-brief-txt p b') || {}).textContent, chapters: document.querySelectorAll('#bi-ch .bi-row').length }));
  check('Meditations: its 7 chapters, and the original chapter by chapter with "Listen to the original"', m1.h === 'The original, chapter by chapter' && /^Listen to the original · \d+ min$/.test(m1.btn) && m1.paras === 11 && m1.first === 'Book one. Debts and lessons.' && m1.chapters === 7, m1);
  await page.click('#bi-brief .bi-start'); await sleep(1500);
  const m2 = await page.evaluate(() => ({ id: BKP && BKP.book.id, secs: BKP && BKP.secs.map(s => s.label) }));
  check('…which plays through the book player, a section per book ("Debts and lessons" … "The bottom line")', m2.id === 'brief-medi' && m2.secs && m2.secs.length === 11 && m2.secs[1] === 'Debts and lessons' && m2.secs[10] === 'The bottom line', m2);
  await page.evaluate(() => { try { bkpStop(true); } catch (e) {} closeBookReader(); });
  await page.evaluate(() => openBookSummary('atomic')); await sleep(600);
  const nc = await page.evaluate(() => !!document.getElementById('bi-brief'));
  check('…a book still under copyright has no original section', nc === false, nc);
  await page.evaluate(() => closeBookReader()); await sleep(200);

  // Hindi labels
  await page.evaluate(() => { S.lang = 'hi'; render(); }); await sleep(500);
  const hiSeg = await page.$$eval('.bk-seg button', bs => bs.map(b => b.textContent.trim()));
  await page.evaluate(() => openBookSummary('atomic')); await sleep(500);
  const hiRows = await page.$$eval('#bi-ch .bi-row .bi-t', rs => rs.map(r => r.textContent));
  check('in Hindi: किताबें · ऑडियोबुक, and the chapter list opens with "यह किताब क्यों"', JSON.stringify(hiSeg) === JSON.stringify(['किताबें', 'ऑडियोबुक']) && hiRows[0] === 'यह किताब क्यों' && hiRows[6] === 'आख़िर में क्या हुआ', { hiSeg, hiRows });
  // a phone screen: no sideways scroll on the book page
  const ox = await page.evaluate(() => { const p = document.querySelector('.bkp-page'); return p ? p.scrollWidth > p.clientWidth + 1 : true; });
  check('the book page has no sideways scroll at 390 px', !ox, ox);
  check('no page errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nbooks: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
