// v36 Lessons: every book is a full-screen lesson of 19 cards (app/lessons.js, app/bookfull.js lesson()), with the story's
// hero drawn on its cards (app/lessons/img), read by ElevenLabs' storyteller with a cue per card. Before v36 (kept below):
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
check('…and every book in 7 chapters as "book-<id>": 104, each 7 paragraphs "Chapter one." … "Chapter seven.", 12,000-15,000 characters (v35: 13-15 minutes, with Pause and think and the closing week)', books.length === 104 && books.every(n => { const p = n.text.split('\n\n'); return p.length === 7 && p.every((x, i) => x.startsWith('Chapter ' + NUM[i] + '. ')) && n.text.length > 12000 && n.text.length < 15000; }), books.length);
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
// v36: Atomic Habits' lesson is "recorded" by ElevenLabs: an index entry in MEDIA/book-eleven read from the lesson's own
// text (the server only plays it while it builds the same text) and a silent 7-minute mp3 with a cue per card
const SPA = fs.readFileSync(ROOT + '/server.js', 'utf8'); const BS = require('vm').runInNewContext('(' + /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(SPA)[1].replace(/\\\\/g, '\\') + ')');
const { lesson } = require(ROOT + '/app/bookfull.js');
const LA = lesson(BS.find(b => b.id === 'atomic'), jAtomic); const LP = LA.text.split(/\n\n/);
const LSECS = 420; const LCUES = []; { let t = 0.35; const tot = LP.reduce((n, p) => n + p.length, 0); for (const p of LP) { LCUES.push(Math.round(t * 100) / 100); t += p.length / tot * (LSECS - 20); } }
const EL = path.join(MEDIA, 'book-eleven'); fs.mkdirSync(EL, { recursive: true });
const LMP3 = 'lesson-atomic-' + textHash(LA.text) + '.mp3'; execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(LSECS), '-b:a', '16k', path.join(EL, LMP3)]);
fs.writeFileSync(path.join(EL, 'index.json'), JSON.stringify({ 'lesson-atomic': { file: LMP3, text: textHash(LA.text), bytes: fs.statSync(path.join(EL, LMP3)).size, sha256: 'x', secs: LSECS, voice: 'test', model: 'test', chars: LA.text.length, at: new Date().toISOString(), cues: LCUES } }));
// the pictures: 7 per lesson, the hero of each lesson's own story, nothing loaded from elsewhere
const PIX = JSON.parse(fs.readFileSync(ROOT + '/app/lessons/img/index.json', 'utf8'));
const pixBad = idx.filter(id => { const j = JSON.parse(fs.readFileSync(ROOT + '/app/ideas/' + id + '.json', 'utf8')); if (!PIX[id] || PIX[id].hero !== j.hero.name || !Array.isArray(PIX[id].pal) || PIX[id].pal.length !== 5) return true; for (let k = 0; k < 7; k++) { const f = ROOT + '/app/lessons/img/' + id + '/' + k + '.svg'; if (!fs.existsSync(f)) return true; const t = fs.readFileSync(f, 'utf8'); if (!/^<svg [^>]*viewBox="0 0 600 450"/.test(t) || /<script|https?:\/\/(?!www\.w3\.org)|xlink:href="http|<image/.test(t)) return true; } return false; });
check('every lesson has its 7 pictures (meet, the five stories, the ending: the story\'s own hero, drawn here; no scripts, nothing loaded from elsewhere) and its colours', pixBad.length === 0 && Object.keys(PIX).length === 104, pixBad.slice(0, 5));
check('…and the people in them are Notionists (CC0), credited in the script that draws them', /Notionists by Zoish \(CC0 1\.0/.test(fs.readFileSync(ROOT + '/scripts/lessons/illustrate.js', 'utf8')));
// v37: every lesson written in Hindi too (app/lessons-hi, scripts/lessons/hi.js), and Atomic Habits' Hindi lesson "recorded"
const HIX = JSON.parse(fs.readFileSync(ROOT + '/app/lessons-hi/index.json', 'utf8'));
let hv = ''; try { hv = execFileSync(process.execPath, [ROOT + '/scripts/lessons/hi.js', 'check'], { encoding: 'utf8' }); } catch (e) { hv = String(e.stdout || e.message); }
check('every lesson is written in Hindi too (104: the same cards, Devanagari, no digits, the hero named in the stories, written from today\'s English)', /^104 of 104 Hindi lessons are good/m.test(hv) && HIX.ids.length === 104 && Object.keys(HIX.heroes).length === 104, hv.split('\n').slice(-4).join(' | '));
const LHA = require(ROOT + '/app/bookfull.js').lessonHi(LA, JSON.parse(fs.readFileSync(ROOT + '/app/lessons-hi/atomic.json', 'utf8')));
check('…a Hindi lesson has the same 19 cards (18 read aloud) in natural Hindi joins ("पहला विचार।", "रुकिए और सोचिए।", "ब्रो की राय।")', LHA && LHA.cards.length === 19 && LHA.text.split(/\n\n/).length === 18 && /पहला विचार।/.test(LHA.text) && /रुकिए और सोचिए।/.test(LHA.text) && /ब्रो की राय।/.test(LHA.text) && LHA.hero.name === 'रिया', LHA && LHA.text.slice(0, 200));
{ const ix = JSON.parse(fs.readFileSync(path.join(EL, 'index.json'), 'utf8')); const f = 'lesson-hi-atomic-' + textHash(LHA.text) + '.mp3'; fs.copyFileSync(path.join(EL, LMP3), path.join(EL, f));
  ix['lesson-hi-atomic'] = Object.assign({}, ix['lesson-atomic'], { file: f, text: textHash(LHA.text), chars: LHA.text.length, voice: 'test-hi' }); fs.writeFileSync(path.join(EL, 'index.json'), JSON.stringify(ix)); }
const PORT = 3295, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999', STUB_PORT: '3296' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  let r = await fetch(BASE + '/api/book-voice/ready'); const rd = await r.json();
  check('/api/book-voice/ready lists the recordings here in Bro\'s studio voice ({ "book-atomic": 560, "deep": 190 })', r.ok && rd.items && rd.items['book-atomic'] === 560 && rd.items.deep === 190 && Object.keys(rd.items).filter(k => !k.startsWith('lesson-')).length === 2, rd);
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
  r = await fetch(BASE + '/app/bookfull.js?v=35');
  check('/app/bookfull.js is served (the same builder the server and the recorder use)', r.ok && /BookFull/.test(await r.text()));
  // v34: Brodoit's own covers, one per book, drawn by scripts/covers; nothing from a publisher or a cover site
  const noCover = books.map(b => b.id.slice(5)).filter(id => !fs.existsSync(path.join(ROOT, 'app', 'covers', id + '.webp')));
  r = await fetch(BASE + '/app/covers/atomic.webp?v=1'); const cvBytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
  const page0 = await (await fetch(BASE + '/')).text();
  check('every book has its own cover (app/covers/<id>.webp, served as image/webp) and the page names no cover site', noCover.length === 0 && r.ok && /image\/webp/.test(r.headers.get('content-type') || '') && cvBytes > 3000 && !/openlibrary\.org\/b\/|covers\.openlibrary|books\.google|amazon\.com\/images/.test(page0), { noCover, type: r.headers.get('content-type'), cvBytes });
  // v35.3: what the cloud backup reads (the ElevenLabs recordings: none on a test server) and nothing else by name
  r = await fetch(BASE + '/api/book-eleven/index.json'); const bix = r.ok ? await r.json() : null;
  const bf404 = (await fetch(BASE + '/api/book-eleven/file/..%2Fserver.js')).status, bf404b = (await fetch(BASE + '/api/book-eleven/file/book-atomic-x.mp3')).status;
  check('/api/book-eleven/index.json lists the ElevenLabs recordings for the cloud backup; /api/book-eleven/file/ serves only those', bix && typeof bix.items === 'object' && bf404 === 404 && bf404b === 404, { bix, bf404, bf404b });

  // v36: the lesson's recording, its cues, its public audio and its share page
  r = await fetch(BASE + '/api/book-voice/ready'); const rd2 = await r.json();
  check('/api/book-voice/ready also lists the recorded lesson with where each card starts ({ cues: { "lesson-atomic": [18 times] } })', rd2.items['lesson-atomic'] === LSECS && JSON.stringify(rd2.cues['lesson-atomic']) === JSON.stringify(LCUES), rd2.cues);
  r = await fetch(BASE + '/api/lesson-audio/atomic'); const la = Buffer.from(await r.arrayBuffer());
  const la404 = (await fetch(BASE + '/api/lesson-audio/deep')).status, la404b = (await fetch(BASE + '/api/lesson-audio/..%2Fserver.js')).status;
  check('/api/lesson-audio/atomic plays the lesson to anyone (a shared lesson plays before sign-up); a lesson not recorded yet → 404', r.status === 200 && la.length === fs.statSync(path.join(EL, LMP3)).size && /public/.test(r.headers.get('cache-control') || '') && la404 === 404 && la404b === 404, { s: r.status, la404, la404b });
  r = await fetch(BASE + '/l/atomic?c=4', { redirect: 'manual' }); const sh = await r.text();
  check('/l/atomic?c=4 (a shared card): a page with the lesson\'s title, words and own cover for the chat preview, that opens it at card 4', r.status === 200 && /<meta property="og:title" content="Atomic Habits · a Brodoit lesson">/.test(sh) && /og:image" content="[^"]+\/app\/covers\/atomic\.webp\?v=1"/.test(sh) && /told through Riya&#39;s story/.test(sh) && /url=\/\?bk=atomic&amp;c=4/.test(sh), sh.slice(0, 300));
  check('…an unknown lesson goes to the Lessons tab', (await fetch(BASE + '/l/nope', { redirect: 'manual' })).status === 302);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: false });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.addInitScript(t => { localStorage.setItem('tf_token', t); localStorage.setItem('bd_onboarded', '1'); window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: d => { window.__shared.push(d); return Promise.resolve(); } }); }, token);
  await page.goto(BASE + '/?tab=books', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lz-tile', { timeout: 45000 }); await sleep(500);
  const tab = await page.evaluate(() => ({ h1: (document.querySelector('.bk-head h1') || {}).textContent, seg: !!document.querySelector('.bk-seg'), tiles: document.querySelectorAll('.lz-tile').length, today: !!document.querySelector('.lz-today'), nav: [...document.querySelectorAll('nav button, .tabs button, [class*="tab"] button')].map(b => b.textContent.trim()).filter(t => /Lessons|Books/.test(t)), atomic: (() => { const t = [...document.querySelectorAll('.lz-tile')].find(x => /'atomic'/.test(x.getAttribute('onclick') || '')); return t && t.querySelector('.lz-tile-min').textContent + ' · ' + t.querySelector('.lz-tile-t small').textContent; })(), audiobooks: /Audiobooks/.test(document.body.innerText) }));
  check('the tab is Lessons: 104 lessons on their own covers, today\'s lesson on top, no Audiobooks shelf', tab.h1 === 'Lessons' && !tab.seg && tab.tiles === 104 && tab.today && !tab.audiobooks && tab.nav.includes('Lessons') && !tab.nav.includes('Books'), tab);
  check('…a recorded lesson shows its length (7 min) and its hero ("with Riya")', tab.atomic === '7 min · with Riya', tab.atomic);

  // open a lesson: full screen, 19 cards, the cover first
  await page.click('.lz-tile[onclick*="\'atomic\'"]'); await page.waitForSelector('.lz .lz-card.on', { timeout: 10000 }); await sleep(700);
  const o1 = await page.evaluate(() => { const r = document.querySelector('.lz').getBoundingClientRect(); return { st: Lessons.state(), cards: document.querySelectorAll('.lz-card').length, bars: document.querySelectorAll('.lz-bars i').length, full: r.width === innerWidth && r.height === innerHeight, h1: document.querySelector('.lz-card.on h1').textContent, next: document.querySelector('.lz-next').textContent.trim(), share: !!document.querySelector('.lz-top [aria-label="Share"]'), lock: document.documentElement.classList.contains('lz-open'), cover: document.querySelector('.lz-card.on .lz-cv img').getAttribute('src') }; });
  check('a lesson opens full screen: 19 cards, a progress bar per card, Share, the cover (Brodoit\'s own) first with "Start"', o1.st && o1.st.id === 'atomic' && o1.st.i === 0 && o1.st.voice && o1.cards === 19 && o1.bars === 19 && o1.full && o1.h1 === 'Atomic Habits' && o1.next === 'Start' && o1.share && o1.lock && o1.cover === '/app/covers/atomic.webp?v=1', o1);
  // Next → card 2: meet the hero, with her picture and words under it
  // Start plays the lesson from its cover (the voice reads why the book matters), then Next moves on
  await page.click('.lz-next'); let s0 = null; for (let k = 0; k < 30; k++) { await sleep(200); s0 = await page.evaluate(() => ({ st: Lessons.state(), next: document.querySelector('.lz-next').textContent.trim(), lit: document.querySelectorAll('.lz-card.on .w.lit').length })); if (s0.st.playing) break; }
  check('Start plays the lesson from the cover in the narrator\'s voice (the button becomes Next)', s0.st.playing && s0.st.i === 0 && s0.next === 'Next', s0);
  await page.click('.lz-next'); await sleep(900);
  const o2 = await page.evaluate(() => { const c = document.querySelector('.lz-card.on'); const img = c.querySelector('.lz-pic img'); return { st: Lessons.state(), img: img && img.getAttribute('src'), nat: img && img.naturalWidth, h2: c.querySelector('h2').textContent, who: c.querySelector('.lz-who').textContent, words: c.querySelectorAll('.lz-say .w').length, label: document.querySelector('.lz-ttl small').textContent, x: getComputedStyle(document.querySelector('.lz-track')).transform }; });
  check('Next → "Meet Riya": her picture (whole, 4:3), her name and who she is, the words under it', o2.st.i === 1 && o2.st.kind === 'meet' && /\/app\/lessons\/img\/atomic\/0\.svg/.test(o2.img) && o2.nat > 0 && o2.h2 === 'Riya' && /^A second-year engineering student/.test(o2.who) && o2.words > 20 && /^Meet Riya · 2 \/ 19$/.test(o2.label), o2);
  await page.click('.lz-play'); await sleep(300); // paused while we look around
  // a sideways drag (mouse or finger) turns the card; a short one springs back
  const box = await page.locator('.lz-stage').boundingBox();
  const drag = async (dx) => { const x0 = box.x + box.width * (dx < 0 ? 0.8 : 0.2); await page.mouse.move(x0, box.y + box.height * 0.5); await page.mouse.down(); for (let k = 1; k <= 8; k++) await page.mouse.move(x0 + dx * k / 8, box.y + box.height * 0.5 + k); await page.mouse.up(); await sleep(700); };
  await drag(-220); const sw1 = await page.evaluate(() => Lessons.state().i);
  await drag(-40); const sw2 = await page.evaluate(() => Lessons.state().i);
  await drag(220); const sw3 = await page.evaluate(() => Lessons.state().i);
  check('swipe left → the next card (it comes in from the right); a short drag springs back; swipe right → back', sw1 === 2 && sw2 === 2 && sw3 === 1, { sw1, sw2, sw3 });
  await page.keyboard.press('ArrowRight'); await sleep(600);
  check('…and the arrow keys turn the cards too', (await page.evaluate(() => Lessons.state().i)) === 2);
  // the voice leads: Play starts the recording at this card's cue; when the voice reaches the next card's cue the card
  // turns by itself, and the words light up as they are read
  const src = await page.evaluate(() => Lessons.state().src);
  check('the lesson plays its ElevenLabs recording (/api/lesson-audio/atomic), with the 18 cues', /\/api\/lesson-audio\/atomic\?v=\d+$/.test(src), src);
  await page.click('.lz-play'); let pl = null; for (let k = 0; k < 30; k++) { await sleep(200); pl = await page.evaluate(() => Lessons.state()); if (pl.playing) break; }
  check('…Play starts the voice at the card you are on (card 3 → its cue)', pl.playing && Math.abs(pl.t - LCUES[2]) < 2, pl);
  await page.evaluate(t => { Lessons.audio().currentTime = t; }, LCUES[3] + 2); await sleep(900);
  const fol = await page.evaluate(() => ({ st: Lessons.state(), lit: document.querySelectorAll('.lz-card.on .w.lit').length, dim: document.querySelectorAll('.lz-card.on .lz-say .w:not(.lit)').length, bar: document.querySelectorAll('.lz-bars i')[3].querySelector('b').style.transform }));
  check('…the voice reaching card 4 turns the card by itself; its words light up as they are read; its bar fills', fol.st.i === 3 && fol.st.playing && fol.lit > 0 && fol.dim > 0 && /scaleX\(0\.0\d/.test(fol.bar), fol);
  await page.click('.lz-next'); await sleep(700);
  const nx = await page.evaluate(() => Lessons.state());
  check('…Next while it plays moves the voice to the next card\'s cue', nx.i === 4 && nx.playing && Math.abs(nx.t - LCUES[4]) < 1.5, nx);
  await page.click('.lz-play'); await sleep(300);
  check('…and Pause pauses it', (await page.evaluate(() => Lessons.state().playing)) === false);
  // pause and think: tap a choice → the best move and why
  await page.evaluate(() => Lessons.open('atomic', 4)); await page.waitForSelector('.lz .lzk-lesson.on', { timeout: 8000 }); await sleep(600);
  const t0 = await page.evaluate(() => { const c = document.querySelector('.lz-card.on'); return { q: c.querySelector('.lz-q').textContent, opts: c.querySelectorAll('.lz-opt').length, why: getComputedStyle(c.querySelector('.lz-whyb')).opacity, shown: c.classList.contains('shown') }; });
  await page.click('.lz-card.on .lz-opt >> nth=1'); await sleep(700);
  const t1 = await page.evaluate(() => { const c = document.querySelector('.lz-card.on'); return { shown: c.classList.contains('shown'), best: c.querySelector('.lz-opt.best').textContent, mine: c.querySelector('.lz-opt.mine').textContent, why: getComputedStyle(c.querySelector('.lz-whyb')).opacity }; });
  check('"Pause and think": the question and 3 choices; tap one → the best move lights up and the why opens', t0.opts === 3 && /Riya/.test(t0.q) && !t0.shown && t0.why === '0' && t1.shown && t1.best.includes(jAtomic.chapters[1].think ? '' : '') && /Keep the two pages going/.test(t1.best) && /Switch to a longer weekend/.test(t1.mine) && t1.why === '1', { t0, t1 });
  await page.click('.lz-card.on .lz-try button'); await sleep(1500);
  const tr = await page.evaluate(() => ({ added: !!(S.bkTried && S.bkTried['atomic:L1']), btn: document.querySelector('.lz-card.on .lz-try button').textContent }));
  check('…"Try it today" → Add to my tasks adds it as today\'s task', tr.added && tr.btn === 'Added to today', tr);
  // share the card you are on
  await page.click('.lz-top [aria-label="Share"]'); await sleep(500);
  const shared = await page.evaluate(() => window.__shared.slice(-1)[0]);
  check('Share (on every card) opens the phone\'s share sheet with a link to this card (/l/atomic?c=4) and its words', shared && /\/l\/atomic\?c=4$/.test(shared.url) && /Atomic Habits/.test(shared.title) && /Riya/.test(shared.text), shared);
  // the end: the five ideas, a week, share, the next lesson; marked done on this phone
  await page.evaluate(() => Lessons.open('atomic', 18)); await page.waitForSelector('.lz .lzk-end.on', { timeout: 8000 }); await sleep(700);
  const e1 = await page.evaluate(() => { const c = document.querySelector('.lz-card.on'); return { recap: [...c.querySelectorAll('.lz-recap li')].map(l => l.textContent), week: c.querySelectorAll('.lz-week p').length, btns: [...c.querySelectorAll('.lz-endbtns button')].map(b => b.textContent.trim()), next: document.querySelector('.lz-next').textContent.trim(), done: JSON.parse(localStorage.getItem('bd_lessons_v1') || '{}').atomic }; });
  check('the end card: the five ideas, a week to live them, Share this lesson, the next lesson; the lesson is marked done here', e1.recap.length === 5 && e1.week === 5 && e1.btns[0] === 'Share this lesson' && /^Next lesson: /.test(e1.btns[1]) && e1.next === 'Done' && e1.done && e1.done.done === true, e1);
  await page.click('.lz-next'); await sleep(600);
  const cl = await page.evaluate(() => ({ open: !!document.querySelector('.lz'), lock: document.documentElement.classList.contains('lz-open'), st: Lessons.state(), done: !!document.querySelector('.lz-tile[onclick*="\'atomic\'"] .lz-tile-done') }));
  check('Done closes it (back on the Lessons tab, the lesson ticked)', !cl.open && !cl.lock && cl.st === null && cl.done, cl);
  // a public-domain book ends with its whole original, chapter by chapter
  await page.evaluate(() => Lessons.open('medi', 18)); await page.waitForSelector('.lz .lzk-end.on', { timeout: 8000 }); await sleep(500);
  const pd = await page.evaluate(() => [...document.querySelectorAll('.lz-card.on .lz-endbtns button')].map(b => b.textContent.trim()));
  await page.click('.lz-card.on .lz-endbtns button >> text=The whole original, every chapter'); await sleep(1500);
  const pd2 = await page.evaluate(() => ({ open: !!document.querySelector('.lz'), id: typeof BKP !== 'undefined' && BKP && BKP.book.id }));
  check('Meditations (public domain) ends with "The whole original, every chapter", played in the book player', pd.includes('The whole original, every chapter') && !pd2.open && pd2.id === 'brief-medi', { pd, pd2 });
  await page.evaluate(() => { try { bkpStop(true); } catch (e) {} });
  // a lesson not recorded yet: read along (every word shown), and Play says the narrator is recording it
  await page.evaluate(() => Lessons.open('deep', 3)); await page.waitForSelector('.lz .lz-card.on', { timeout: 8000 }); await sleep(600);
  const d1 = await page.evaluate(() => { Lessons.toggle(); return { st: Lessons.state(), mute: document.querySelector('.lz-play').classList.contains('mute'), dim: getComputedStyle(document.querySelector('.lz-card.on .lz-say .w')).opacity }; }); await sleep(300);
  const toastTxt = await page.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
  check('a lesson not recorded yet opens to read along (every word shown), and Play says the narrator is still recording it', d1.st.id === 'deep' && d1.st.i === 3 && !d1.st.voice && d1.mute && d1.dim === '1' && /still recording this lesson/.test(toastTxt), { d1, toastTxt });
  // no sideways scroll, back button closes it
  const ox = await page.evaluate(() => document.querySelector('.lz-card.on .lz-body').scrollWidth > document.querySelector('.lz-card.on .lz-body').clientWidth + 1);
  await page.goBack(); await sleep(600);
  const bk = await page.evaluate(() => ({ open: !!document.querySelector('.lz'), tab: S.tab }));
  check('no sideways scroll in a card, and the phone\'s back button closes the lesson (staying on Lessons)', !ox && !bk.open && bk.tab === 'books', { ox, bk });
  // a shared link opens the lesson at its card
  await page.goto(BASE + '/?bk=atomic&c=6', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.lz .lz-card.on', { timeout: 20000 }); await sleep(800);
  const dl = await page.evaluate(() => ({ st: Lessons.state(), url: location.search }));
  check('a shared link (/?bk=atomic&c=6) opens the lesson at card 7, and tidies the address bar', dl.st && dl.st.id === 'atomic' && dl.st.i === 6 && dl.url === '', dl);
  await page.evaluate(() => Lessons.close()); await sleep(400);
  // v37: Hindi: the tab is सबक; a book opens its lesson in Hindi (Adam's recording, its cues); EN / हिं switches in place
  r = await fetch(BASE + '/api/book-voice/ready'); const rd3 = await r.json();
  const ha = await fetch(BASE + '/api/lesson-audio/hi-atomic');
  check('the server plays the Hindi lesson\'s recording (/api/lesson-audio/hi-atomic) with its cues, only while it reads today\'s Hindi', rd3.cues['lesson-hi-atomic'] && rd3.cues['lesson-hi-atomic'].length === 18 && ha.status === 200, { cues: !!rd3.cues['lesson-hi-atomic'], s: ha.status });
  await page.evaluate(() => { S.lang = 'hi'; S.tab = 'books'; render(); }); await sleep(500);
  const hiH = await page.evaluate(() => ({ h1: (document.querySelector('.bk-head h1') || {}).textContent, tile: (() => { const t = [...document.querySelectorAll('.lz-tile')].find(x => /'atomic'/.test(x.getAttribute('onclick') || '')); return t && t.querySelector('.lz-tile-t small').textContent; })() }));
  await page.evaluate(() => openBookSummary('atomic')); await page.waitForSelector('.lz.lz-hi .lz-card.on', { timeout: 10000 }); await sleep(600);
  await page.keyboard.press('ArrowRight'); await sleep(700);
  const h1 = await page.evaluate(() => { const c = document.querySelector('.lz-card.on'); return { st: Lessons.state(), h2: c.querySelector('h2').textContent, who: c.querySelector('.lz-who').textContent, kick: c.querySelector('.lz-kick').textContent, say: c.querySelector('.lz-say').textContent.slice(0, 40), lang: document.querySelector('.lz-lang').textContent, next: document.querySelector('.lz-next').textContent.trim() }; });
  check('in Hindi: the tab is सबक, a tile names the hero in Hindi, and a book opens its Hindi lesson ("मिलिए", रिया, her story in Hindi, Adam\'s recording)', hiH.h1 === 'सबक' && hiH.tile === 'रिया के साथ' && h1.st.lang === 'hi' && h1.st.i === 1 && h1.st.voice && /\/api\/lesson-audio\/hi-atomic\?/.test(h1.st.src) && h1.h2 === 'रिया' && /^पुणे/.test(h1.who) && h1.kick === 'मिलिए' && /रिया/.test(h1.say) && h1.lang === 'EN' && h1.next === 'आगे', { hiH, h1 });
  await page.click('.lz-lang'); await page.waitForSelector('.lz:not(.lz-hi) .lz-card.on', { timeout: 8000 }); await sleep(600);
  const h2 = await page.evaluate(() => ({ st: Lessons.state(), h2: document.querySelector('.lz-card.on h2').textContent, lang: document.querySelector('.lz-lang').textContent, n: document.querySelectorAll('.lz').length }));
  check('…EN switches the same card to English (Riya, George\'s recording), and हिं back', h2.st.lang === 'en' && h2.st.i === 1 && h2.h2 === 'Riya' && h2.lang === 'हिं' && /\/api\/lesson-audio\/atomic\?/.test(h2.st.src) && h2.n === 1, h2);
  await page.click('.lz-lang'); await page.waitForSelector('.lz.lz-hi .lz-card.on', { timeout: 8000 }); await sleep(500);
  await page.click('.lz-top [aria-label="साझा करें"], .lz-top [aria-label="शेयर"]'); await sleep(400);
  const shHi = await page.evaluate(() => window.__shared.slice(-1)[0]);
  check('…sharing a Hindi card links to it in Hindi (/l/atomic?c=1&hl=hi)', shHi && /\/l\/atomic\?c=1&hl=hi$/.test(shHi.url), shHi);
  await page.goBack(); await sleep(500);
  const hb = await page.evaluate(() => !!document.querySelector('.lz'));
  check('…and one back press closes it, after switching language twice', !hb, hb);
  r = await fetch(BASE + '/l/atomic?c=2&hl=hi', { redirect: 'manual' }); const shp = await r.text();
  check('/l/atomic?c=2&hl=hi opens the Hindi lesson at that card', /url=\/\?bk=atomic&amp;c=2&amp;hl=hi/.test(shp), shp.slice(0, 200));
  await page.evaluate(() => { S.lang = 'en'; render(); });
  check('no page errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nbooks: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
