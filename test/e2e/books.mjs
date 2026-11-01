// v32 Books: every book as a story in 7 chapters (app/ideas/<id>.json + Bro's notes), Ideas (a feed of those chapters,
// one per screen), and the public-domain books chapter by chapter (app/briefs/<id>.json, played as "brief-<id>").
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
check('the narration recorder lists the 5 briefs as "brief-<id>" (so they get the studio voice)', PD.every(id => notes.some(n => n.id === 'brief-' + id && n.text.length > 6000)) && notes.length === 109, notes.length);

// ── the real server ──
const DB = TMP + '/ideas.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const { token } = (() => { const db = new Database(DB, { readonly: true }); const u = db.prepare('SELECT token FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get(); db.close(); return u; })();
const MEDIA = fs.mkdtempSync('/tmp/p14ideas-');
const PORT = 3295, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999', STUB_PORT: '3296' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
const browser = await chromium.launch();
try {
  let r = await fetch(BASE + '/api/book-audio/brief-medi?token=' + token);
  check('/api/book-audio/brief-medi before its recording → 404 live (the player reads it in Bro\'s voice)', r.status === 404 && (await r.json()).live === true, r.status);
  await sleep(300);
  let wanted = []; try { wanted = JSON.parse(fs.readFileSync(path.join(MEDIA, 'bro-voice', 'books-wanted.json'), 'utf8')); } catch (e) {}
  check('…and a brief is never queued for Bro\'s live engine (the studio narration records it)', !wanted.some(x => /brief/.test(x)), wanted);
  r = await fetch(BASE + '/app/ideas/atomic.json'); const atomic = await r.json();
  check('/app/ideas/<id>.json is served (no-cache)', r.ok && atomic.chapters.length === 7 && /no-cache/.test(r.headers.get('cache-control') || ''));

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.addInitScript(t => { localStorage.setItem('tf_token', t); localStorage.setItem('bd_onboarded', '1'); }, token);
  await page.goto(BASE + '/?tab=books', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bi-short', { timeout: 45000 });
  await sleep(600);
  const seg = await page.$$eval('.bk-seg button', bs => bs.map(b => [b.textContent.trim(), b.classList.contains('on')]));
  check('Books opens on Ideas: Ideas · Books · Audiobooks', JSON.stringify(seg) === JSON.stringify([['Ideas', true], ['Books', false], ['Audiobooks', false]]), seg);
  const f1 = await page.evaluate(() => { const d = document.querySelector('.bi-deck'), s = d.querySelector('.bi-short'), i = s.querySelector('.bi-sin'); return { dh: d.clientHeight, sh: s.clientHeight, over: i.scrollHeight - i.clientHeight, k: s.dataset.k, story: (s.querySelector('.bi-sstory') || {}).textContent || '', take: (s.querySelector('.bi-stake') || {}).textContent || '', bottomTab: (document.querySelector('.tabs.page-t') || document.body).getBoundingClientRect().top, deckBottom: d.getBoundingClientRect().bottom }; });
  check('an idea fills the screen above the tab bar: the situation and the takeaway, nothing cut off (390×844)', f1.over <= 1 && f1.sh === f1.dh && f1.story.split(' ').length >= 80 && f1.take.length > 10 && f1.deckBottom <= f1.bottomTab + 1, f1);
  // the next one: scroll a screen
  await page.evaluate(() => { const d = document.querySelector('.bi-deck'); d.scrollTop = d.clientHeight; }); await sleep(900);
  const f2 = await page.evaluate(() => { const d = document.querySelector('.bi-deck'); const all = [...d.querySelectorAll('.bi-short')]; const cur = all.find(s => Math.abs(s.getBoundingClientRect().top - d.getBoundingClientRect().top) < 4); return { k: cur && cur.dataset.k, n: all.length, seen: Object.keys(JSON.parse(localStorage.getItem('ideas.seen.v1') || '{}')).length, books: all.map(s => s.dataset.k.split(':')[0]) }; });
  check('swipe up → the next idea snaps into place, from another book (never two from one book in a row)', f2.k && f2.k !== f1.k && f2.books.every((b, i) => i === 0 || b !== f2.books[i - 1]), f2);
  check('…ideas on screen are remembered as seen (unseen ones come first next time)', f2.seen >= 2, f2.seen);
  // passive and full redraws keep the feed where it is
  const top1 = await page.evaluate(() => document.querySelector('.bi-deck').scrollTop);
  await page.evaluate(() => { renderPassive(); }); await sleep(400);
  await page.evaluate(() => { render(); }); await sleep(600);
  const top2 = await page.evaluate(() => { const d = document.querySelector('.bi-deck'); return { top: d.scrollTop, n: document.querySelectorAll('.bi-deck').length }; });
  check('the 10-second background redraw and a full redraw keep the feed on the same idea', top2.n === 1 && Math.abs(top2.top - top1) < 4, { top1, top2 });
  // small phone
  await page.setViewportSize({ width: 360, height: 740 }); await sleep(700);
  const f3 = await page.evaluate(() => [...document.querySelectorAll('.bi-sin')].slice(0, 6).map(i => ({ over: i.scrollHeight - i.clientHeight, step: ['sm', 'xs', 'xxs'].filter(c => i.classList.contains(c)).pop() || '', scroll: getComputedStyle(i).overflowY })));
  check('on a small phone (360×740) the type steps down first; a long story then scrolls inside its card (never cut)', f3.every(x => x.over <= 1 || (x.step === 'xxs' && x.scroll === 'auto')) && f3.some(x => x.over <= 1), f3);
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
  // save one
  await page.evaluate(() => { const d = document.querySelector('.bi-deck'); d.scrollTop = 0; }); await sleep(500);
  await page.click('.bi-short .bi-ssave');
  const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('ideas.saved.v1') || '[]'));
  check('the bookmark saves an idea (on this phone)', sv.length === 1 && sv[0].key === f1.k + ':story', sv);
  // open the chapter
  await page.click('.bi-short .bi-sin'); await page.waitForSelector('#bi-player .bi-card'); await sleep(200);
  const [bid, chs] = f1.k.split(':'); const ch = +chs;
  const p1 = await page.evaluate(() => ({ where: document.querySelector('#bi-player .bi-where small').textContent, eb: document.querySelector('#bi-player .bi-eb').textContent, h: document.querySelector('#bi-player .bi-h').textContent, segs: document.querySelectorAll('#bi-player .bi-segs i').length }));
  check('tap an idea → its chapter opens on the idea card (4 cards: idea, situation, choice, takeaway)', p1.where.startsWith('Chapter ' + (ch + 1) + ' of 7') && /^Idea /.test(p1.eb) && p1.segs === 4, p1);
  await page.click('#bi-player .bi-primary'); await sleep(150);
  const p2 = await page.evaluate(() => ({ eb: document.querySelector('#bi-player .bi-eb').textContent, story: document.querySelector('#bi-player .bi-story').textContent }));
  check('…Next → the situation (the same story as the idea in the feed)', p2.eb === 'The situation' && p2.story === f1.story, p2.eb);
  await page.click('#bi-player .bi-primary'); await sleep(150);
  const right = JSON.parse(fs.readFileSync(ROOT + '/app/ideas/' + bid + '.json', 'utf8')).chapters[ch].ask.a;
  const wrong = (right + 1) % 3;
  const navTxt = await page.$eval('#bi-player .bi-primary', b => b.textContent);
  await page.click('#bi-player .bi-opt >> nth=' + wrong); await sleep(150);
  const p3 = await page.evaluate(() => ({ eb: document.querySelector('#bi-player .bi-eb').textContent, right: [...document.querySelectorAll('#bi-player .bi-opt')].findIndex(o => o.classList.contains('right')), wrong: [...document.querySelectorAll('#bi-player .bi-opt')].findIndex(o => o.classList.contains('wrong')), why: (document.querySelector('#bi-player .bi-why') || {}).textContent || '', locked: [...document.querySelectorAll('#bi-player .bi-opt')].every(o => o.disabled) }));
  check('…the choice: before answering the button says Skip; a wrong pick shows the right one and why', navTxt === 'Skip' && p3.eb === 'What would you do?' && p3.right === right && p3.wrong === wrong && /^Not quite\./.test(p3.why) && p3.locked, Object.assign(p3, { navTxt }));
  await page.click('#bi-player .bi-primary'); await sleep(150);
  const p4 = await page.evaluate(() => ({ eb: document.querySelector('#bi-player .bi-eb').textContent, take: document.querySelector('#bi-player .bi-take').textContent, tryIt: !!document.querySelector('#bi-player .bi-try'), btn: document.querySelector('#bi-player .bi-nav .bi-primary').textContent }));
  check('…the takeaway, with the note\'s "Try it today" and Finish chapter', p4.eb === 'The takeaway' && p4.take.length > 10 && p4.tryIt && p4.btn === 'Finish chapter', p4);
  await page.click('#bi-player .bi-primary'); await sleep(150);
  const p5 = await page.evaluate(() => ({ h: document.querySelector('#bi-player .bi-done h2').textContent, prog: JSON.parse(localStorage.getItem('ideas.prog.v1') || '{}') }));
  check('…Finish → "Chapter N done", saved as read on this phone', p5.h === 'Chapter ' + (ch + 1) + ' done' && p5.prog[bid] && p5.prog[bid].done.includes(ch) && p5.prog[bid].at === ch + 1, p5);
  await page.click('#bi-player .bi-done .bi-primary'); await sleep(150);
  const p6 = await page.evaluate(() => document.querySelector('#bi-player .bi-where small').textContent);
  check('…Next chapter → chapter N+1 from its first card', p6.startsWith('Chapter ' + (ch + 2) + ' of 7'), p6);
  await page.keyboard.press('ArrowRight'); await sleep(100);
  const p7 = await page.evaluate(() => document.querySelector('#bi-player .bi-eb').textContent);
  await page.keyboard.press('Escape'); await sleep(300);
  const closed = !(await page.$('#bi-player'));
  check('arrow keys step cards; Escape closes the player', p7 === 'The situation' && closed, { p7, closed });
  // Saved
  const badge = await page.$eval('.bi-svbtn i', e => e.textContent).catch(() => '');
  await page.click('.bi-svbtn'); await sleep(900);
  const s1 = await page.evaluate(() => ({ on: document.querySelector('.bi-svbtn').classList.contains('on'), head: (document.querySelector('.bi-svhead') || {}).textContent, ks: [...document.querySelectorAll('.bi-short')].map(s => s.dataset.k) }));
  check('the bookmark beside the sections (with the count) shows the saved idea', badge === '1' && s1.on && s1.head === 'Saved ideas' && JSON.stringify(s1.ks) === JSON.stringify([f1.k]), Object.assign(s1, { badge }));
  await page.click('.bi-svbtn'); await sleep(300);
  // the book page
  await page.evaluate(() => { S.booksMode = 'summaries'; render(); }); await sleep(300);
  await page.evaluate(b => openBookSummary(b), bid); await page.waitForSelector('#bi-ch', { timeout: 10000 }); await sleep(600);
  const b1 = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#bi-ch .bi-row')].map(r => [r.querySelector('.bi-t').textContent, r.classList.contains('done')]), start: document.querySelector('#bi-ch .bi-start').textContent, sub: document.querySelector('#bi-ch .bkp-sub').textContent, brief: !!document.getElementById('bi-brief') }));
  check('the book page has its 7 chapters, the ones read ticked, and Continue', b1.rows.length === 7 && b1.rows[0][0] === 'Why this book' && b1.rows[6][0] === "Bro's take" && b1.rows[ch][1] === true && /^(Continue|Start)/.test(b1.start) && /^Follow /.test(b1.sub), b1);
  check('…a book still under copyright has no whole-book section', PD.includes(bid) || b1.brief === false, b1.brief);
  await page.evaluate(() => closeBookReader()); await sleep(200);
  await page.evaluate(() => openBookSummary('medi')); await page.waitForSelector('#bi-brief', { timeout: 10000 }); await sleep(300);
  const m1 = await page.evaluate(() => ({ h: document.querySelector('#bi-brief h2').textContent, btn: document.querySelector('#bi-brief .bi-start').textContent, paras: document.querySelectorAll('#bi-brief .bi-brief-txt p').length, first: (document.querySelector('#bi-brief .bi-brief-txt p b') || {}).textContent }));
  check('Meditations: "Chapter by chapter" with Listen to the whole book and every book of it', m1.h === 'Chapter by chapter' && /^Listen to the whole book · \d+ min$/.test(m1.btn) && m1.paras === 11 && m1.first === 'Book one. Debts and lessons.', m1);
  await page.click('#bi-brief .bi-start'); await sleep(1500);
  const m2 = await page.evaluate(() => ({ id: BKP && BKP.book.id, secs: BKP && BKP.secs.map(s => s.label), mode: BKP && BKP.mode }));
  check('…Listen plays it through the book player with a section per book ("Debts and lessons" … "The bottom line")', m2.id === 'brief-medi' && m2.secs && m2.secs.length === 11 && m2.secs[1] === 'Debts and lessons' && m2.secs[10] === 'The bottom line', m2);
  await page.evaluate(() => { try { bkpStop(true); } catch (e) {} closeBookReader(); });
  // Hindi labels
  await page.evaluate(() => { S.lang = 'hi'; S.booksMode = 'ideas'; render(); }); await sleep(700);
  const hiSeg = await page.$$eval('.bk-seg button', bs => bs.map(b => b.textContent.trim()));
  check('in Hindi the sections read विचार · किताबें · ऑडियोबुक', JSON.stringify(hiSeg) === JSON.stringify(['विचार', 'किताबें', 'ऑडियोबुक']), hiSeg);
  check('no page errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nbooks: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
