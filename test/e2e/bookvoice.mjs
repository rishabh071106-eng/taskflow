// v31 Book voice (modules/bookvoice.js): Bro's book notes read by the studio narration (an openly licensed voice model,
// recorded in GitHub Actions and published as the release "book-voice-v1"). The server copies the recordings that match
// today's note text (sha256-checked) and /api/book-audio/:id plays them before Bro's own recording, which stays the
// fallback; a note the studio voice reads is not recorded again in Bro's voice.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import http from 'http'; import crypto from 'crypto'; import { spawn, execFileSync } from 'child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim(); // a test database with two signed-in users
const require = createRequire(ROOT + '/package.json');
const express = require('express'); const Database = require('better-sqlite3');
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BV = require(ROOT + '/modules/bookvoice.js');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// a fake GitHub release: manifest.json + mp3 files (one behind a redirect, as GitHub serves assets)
const mp3 = tag => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=' + (200 + tag) + ':duration=0.6', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
const rel = { files: {}, manifest: null, hits: [] };
const app = express();
app.use((req, res, next) => { rel.hits.push(req.path); next(); });
app.get('/rel/manifest.json', (req, res) => rel.manifest ? res.json(rel.manifest) : res.status(404).end());
app.get('/rel/:f', (req, res) => { const f = req.params.f; if (/^redir-/.test(f) && !req.query.r) return res.redirect(302, '/rel/' + f + '?r=1'); const b = rel.files[f]; b ? res.type('audio/mpeg').send(b) : res.status(404).end(); });
const srv = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
const BASE_REL = 'http://127.0.0.1:' + srv.address().port + '/rel/';
const entry = (id, text, file, buf, over) => Object.assign({ file, sha256: sha(buf), bytes: buf.length, secs: 0.6, text: BV.textHash(text) }, over || {});

// ── the module ──
const TEXTS = { atomic: 'Bro\'s notes on Atomic Habits.\n\nIdea one.  Tiny gains add up.', deep: 'Bro\'s notes on Deep Work.', 'hi-atomic': 'Atomic Habits पर Bro के नोट्स।' };
const text = id => TEXTS[id] || '';
const A = mp3(1), D = mp3(2), H = mp3(3), X = mp3(4);
rel.files['atomic-aaa.mp3'] = A; rel.files['redir-deep.mp3'] = D; rel.files['hi-atomic-1.mp3'] = H; rel.files['stale-1.mp3'] = X; rel.files['bad-1.mp3'] = X;
rel.manifest = { voice: 'test voice', license: 'MIT', made: '2026-11-01', items: {
  atomic: entry('atomic', TEXTS.atomic, 'atomic-aaa.mp3', A),
  deep: entry('deep', TEXTS.deep, 'redir-deep.mp3', D),
  'hi-atomic': entry('hi-atomic', TEXTS['hi-atomic'], 'hi-atomic-1.mp3', H),
  stale: entry('stale', 'an older version of the note', 'stale-1.mp3', X),
  bad: entry('bad', 'x', 'bad-1.mp3', X, { sha256: 'f'.repeat(64) }),
  '../evil': entry('x', 'x', 'atomic-aaa.mp3', A),
  odd: entry('odd', 'x', '../../etc/passwd', A),
} };
TEXTS.stale = 'today\'s version of the note'; TEXTS.bad = 'x';
const media = fs.mkdtempSync('/tmp/p13bv-');
const logs = [];
const bv = BV.create({ mediaDir: media, text, base: BASE_REL, minFreeBytes: 0, log: (...a) => logs.push(a.join(' ')) });
check('textHash ignores whitespace runs (the recorder and the server agree on the same note)', BV.textHash('a  b\n\nc ') === BV.textHash('a b c') && /^[0-9a-f]{12}$/.test(BV.textHash('x')));
check('nothing published here yet → no file (Bro\'s voice keeps reading)', bv.file('atomic') === '' && bv.stats().ready === 0);
let got = await bv.sync();
check('sync copies the recordings that match today\'s text: English, Hindi and one behind a redirect', got === 3 && fs.readFileSync(bv.file('atomic')).equals(A) && fs.readFileSync(bv.file('deep')).equals(D) && fs.readFileSync(bv.file('hi-atomic')).equals(H), { got, logs });
check('…a recording of another version of the note is not fetched or used', bv.file('stale') === '' && !rel.hits.includes('/rel/stale-1.mp3'));
check('…a file whose sha256 does not match is refused', bv.file('bad') === '' && !fs.existsSync(path.join(media, 'book-voice', 'bad-1.mp3')) && logs.some(l => /checksum mismatch/.test(l)), logs);
check('…bad ids and file names in the manifest are ignored (no path tricks)', bv.file('../evil') === '' && !fs.existsSync('/etc/passwd.mp3') && fs.readdirSync(path.join(media, 'book-voice')).every(f => /^[a-z0-9_.-]+$/i.test(f)));
const s1 = bv.stats();
check('stats: the voice, its licence, published and ready counts', s1.voice === 'test voice' && s1.license === 'MIT' && s1.published === 7 && s1.ready === 3 && !!s1.synced_at, s1);
rel.hits.length = 0; got = await bv.sync();
check('a second sync downloads nothing (only the manifest)', got === 0 && rel.hits.length === 1 && rel.hits[0] === '/rel/manifest.json', rel.hits);
TEXTS.deep = 'Bro\'s notes on Deep Work, edited.';
check('a note edited after it was recorded → back to Bro\'s voice until the next recording run', bv.file('deep') === '' && bv.file('atomic') !== '');
TEXTS.deep = 'Bro\'s notes on Deep Work.';
// the manifest drops a recording → its file is removed
delete rel.manifest.items['hi-atomic']; await bv.sync();
check('a recording the manifest no longer lists is deleted from the volume', !fs.existsSync(path.join(media, 'book-voice', 'hi-atomic-1.mp3')) && bv.file('hi-atomic') === '');
// not published (404) → no crash, the files stay
const keep = rel.manifest; rel.manifest = null; got = await bv.sync();
check('no release yet (404) → nothing breaks and what is here stays', got === 0 && bv.stats().error === 'not published yet' && bv.file('atomic') !== '', bv.stats());
rel.manifest = keep;
// a restart reads the saved manifest: works offline
const bvb = BV.create({ mediaDir: media, text, base: 'http://127.0.0.1:9/none/', minFreeBytes: 0, log: () => {} });
check('after a restart the saved manifest is used at once (no network needed)', fs.readFileSync(bvb.file('atomic')).equals(A));
// the disk guard
const media2 = fs.mkdtempSync('/tmp/p13bv2-'); const logs2 = [];
const bvd = BV.create({ mediaDir: media2, text, base: BASE_REL, minFreeBytes: 1e18, log: (...a) => logs2.push(a.join(' ')) });
got = await bvd.sync();
check('the volume keeps its free space: no download when the disk is nearly full', got === 0 && /disk nearly full/.test(bvd.stats().error) && bvd.file('atomic') === '', bvd.stats());
// two syncs at once share one run
const media3 = fs.mkdtempSync('/tmp/p13bv3-');
const bv3 = BV.create({ mediaDir: media3, text, base: BASE_REL, minFreeBytes: 0, log: () => {} });
const [g1, g2] = await Promise.all([bv3.sync(), bv3.sync()]);
check('two syncs at the same time are one run', g1 === g2 && g1 === 2, { g1, g2 });

// ── the recorder's note list hashes exactly what the server reads ──
const notesFile = path.join(media, 'notes.json');
execFileSync(process.execPath, [ROOT + '/scripts/book-voice/notes.js', notesFile, 'http://127.0.0.1:9'], { stdio: 'pipe' });
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
const plain = notes.filter(n => !/^(brief|book)-/.test(n.id)), briefN = notes.filter(n => n.id.startsWith('brief-')), bookN = notes.filter(n => n.id.startsWith('book-'));
check('scripts/book-voice/notes.js lists all 104 English notes (v32: the 5 public-domain briefs; v33: the 104 books in 7 chapters) with their hash', plain.length === 104 && briefN.length === 5 && bookN.length === 104 && notes.every(n => n.lang === 'en' && /^[0-9a-f]{12}$/.test(n.hash) && n.text.length > 2000), [plain.length, briefN.length, bookN.length]);

// ── v34: the voice is given the spoken words (times, numbers and short forms written out) ──
const { spoken } = require(ROOT + '/scripts/book-voice/spoken.js');
const SAY = [
  ['Wake at 5:30, run three kilometres.', 'Wake at five thirty, run three kilometres.'],
  ['Then 7:10, 7:20, 7:30. At 7:45 he jumps up.', 'Then seven ten, seven twenty, seven thirty. At seven forty-five he jumps up.'],
  ['His alarm rings at 7:00. He hits snooze.', "His alarm rings at seven o'clock. He hits snooze."],
  ['He reaches the office at 9:30 and calls at 9.15.', 'He reaches the office at nine thirty and calls at nine fifteen.'],
  ['It is 2 a.m. and she is awake. He wakes at 6 a.m. Then he runs.', 'It is two A. M. and she is awake. He wakes at six A. M. Then he runs.'],
  ['This is The 5 AM Club, by Robin Sharma.', 'This is The five A. M. Club, by Robin Sharma.'],
  ['Meet Dinesh, a 36-year-old AC repair contractor.', 'Meet Dinesh, a thirty-six-year-old A. C. repair contractor.'],
  ['She starts a SIP and pays by UPI.', 'She starts an S. I. P. and pays by U. P. I.'],
  ['in 1987, the 1920s, 40% off, ₹1,200, 5-10 minutes, 24/7, the 21st time', 'in nineteen eighty-seven, the nineteen twenties, forty percent off, one thousand two hundred rupees, five to ten minutes, twenty-four seven, the twenty-first time'],
  ['Dr. Minz says no. Then a BATNA — a backup.', 'Doctor Minz says no. Then a Batna, a backup.'],
];
const sayBad = SAY.filter(([a, b]) => spoken(a) !== b).map(([a]) => [a, spoken(a)]);
check('spoken.js writes out times (5:30 → five thirty, never "five thousand thirty"), numbers, a.m., percentages, rupees and short forms (SIP → S. I. P.)', sayBad.length === 0, sayBad);
check('…and the check side spells letters as words, so a take that said "sip" for SIP fails', spoken('SIP at 5:30 a.m.', { letters: 'names' }) === 'ess eye pee at five thirty ay em.' && spoken('S. I. P. at five thirty A. M.', { letters: 'names' }) === 'ess eye pee at five thirty ay em.', spoken('SIP at 5:30 a.m.', { letters: 'names' }));
const said = notes.filter(n => n.lang === 'en');
check('every English note carries the spoken words (no digits, ₹ or % left; same chapters) and their hash; the books in 7 chapters come first', said.every(n => n.say && !/[0-9₹%$]/.test(n.say) && n.say.split('\n\n').length === n.text.split('\n\n').length && /^[0-9a-f]{12}$/.test(n.sayHash)) && notes[0].id.startsWith('book-') && notes.findIndex(n => !n.id.startsWith('book-')) === bookN.length, said.filter(n => !n.say || /[0-9₹%$]/.test(n.say)).map(n => n.id).slice(0, 5));
const lines = execFileSync(process.execPath, [ROOT + '/scripts/book-voice/spoken.js', '--lines', 'names'], { input: JSON.stringify('nine thousand thirty') + '\n' + JSON.stringify('9:30') + '\n' }).toString().trim().split('\n').map(l => JSON.parse(l));
check('spoken.js --lines (the recorder checks each take through it): "9:30" and "nine thousand thirty" differ', lines[0] === 'nine thousand thirty' && lines[1] === 'nine thirty', lines);
const { check: chk } = require(ROOT + '/scripts/book-voice/spoken.js'); const flat = t => chk(t).toLowerCase().replace(/[^a-z0-9]/g, '');
check('…the check form (record.py, --lines check) reads numbers however Whisper writes them, and still catches a misreading', flat('Then seven ten, seven thirty. At seven forty-five he wakes in nineteen eighty-seven.') === flat('Then 710, 7:30. At 7.45 he wakes in 1987.') && flat('three kilometres; she realises') === flat('3 kilometers; she realizes') && flat('Wake at five thirty') !== flat('Wake at 5,030') && flat('an S. I. P.') !== flat('a sip'), [chk('Then 710, 7:30.'), chk('Wake at 5,030')]);

// ── v34: a new reading goes through run by run without losing a published recording ──
{
  const dir = fs.mkdtempSync('/tmp/p34plan-'), voiceDir = ROOT + '/scripts/book-voice/voice';
  const { voiceId } = require(ROOT + '/scripts/book-voice/voiceid.js'); const vid = voiceId(voiceDir);
  const few = [bookN[0], bookN[1], plain[0]];
  fs.writeFileSync(dir + '/notes.json', JSON.stringify(few));
  const oldMan = { voice_id: vid, items: {
    [few[0].id]: { file: 'a.mp3', text: few[0].hash },                              // before v34: no spoken words
    [few[1].id]: { file: 'b.mp3', text: few[1].hash, say: few[1].sayHash, v: vid },  // read from today's words
    [few[2].id]: { file: 'c.mp3', text: few[2].hash, say: few[2].sayHash, v: 'another-voice' } } };
  fs.writeFileSync(dir + '/old.json', JSON.stringify(oldMan));
  const env = Object.assign({}, process.env); delete env.GITHUB_OUTPUT;
  const out = execFileSync(process.execPath, [ROOT + '/scripts/book-voice/plan.js', dir + '/notes.json', dir + '/old.json', voiceDir, dir + '/todo.json'], { env }).toString();
  const todo = JSON.parse(fs.readFileSync(dir + '/todo.json', 'utf8')).map(n => n.id);
  check('plan.js reads again a recording made before v34 and one from another voice, and keeps one made from today\'s spoken words', todo.includes(few[0].id) && todo.includes(few[2].id) && !todo.includes(few[1].id) && /en=2\b/.test(out), { todo, out });
}

// ── the real server ──
const DB = TMP + '/bv.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const { token } = (() => { const db = new Database(DB, { readonly: true }); const u = db.prepare('SELECT token FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get(); db.close(); return u; })();
const MEDIA = fs.mkdtempSync('/tmp/p13bv-srv-');
const atomic = notes.find(n => n.id === 'atomic'), deep = notes.find(n => n.id === 'deep-work') || plain[1];
const HI_TEXT = 'Atomic Habits पर Bro के नोट्स, James Clear की किताब।\n\nपहला आइडिया। छोटे कदम जुड़ते हैं।';
fs.mkdirSync(path.join(MEDIA, 'books-hi'), { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'books-hi', 'atomic.json'), JSON.stringify({ notes: 2, title: 'Atomic Habits', summary: HI_TEXT }));
const S1 = mp3(5), S2 = mp3(6), BRO = mp3(7);
rel.files['atomic-' + atomic.hash + '.mp3'] = S1; rel.files['hi-atomic-x.mp3'] = S2;
rel.manifest = { voice: 'studio narrator', license: 'MIT', made: '2026-11-01', items: {
  atomic: entry('atomic', atomic.text, 'atomic-' + atomic.hash + '.mp3', S1),
  'hi-atomic': entry('hi-atomic', HI_TEXT, 'hi-atomic-x.mp3', S2),
  [deep.id]: entry(deep.id, 'an older version', 'stale-1.mp3', X),
} };
const PRE = HERE + '/voicekey.cjs';
const PORT = 3283, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_URL: BASE_REL, BOOK_VOICE_DELAY_MS: '500', STUB_PORT: '3284' });
const child = spawn(process.execPath, ['-r', PRE, '-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
try {
  let st = null; for (let i = 0; i < 40; i++) { st = (await (await fetch(BASE + '/api/learn/voice-status')).json()).book_voice; if (st && st.ready >= 2) break; await sleep(250); }
  check('at boot the server copies the studio recordings (voice-status: book_voice)', st && st.ready === 2 && st.published === 3 && st.voice === 'studio narrator' && st.license === 'MIT', { st, log: out.join('').split('\n').filter(l => /book-voice/.test(l)) });
  const get = async u => { const x = await fetch(BASE + u); return { s: x.status, cc: x.headers.get('cache-control'), ar: x.headers.get('accept-ranges'), body: Buffer.from(await x.arrayBuffer()) }; };
  let a = await get('/api/book-audio/atomic?token=' + token);
  check('/api/book-audio/atomic → the studio narration (no-cache, Range for iOS)', a.s === 200 && a.body.equals(S1) && a.cc === 'no-cache' && a.ar === 'bytes', { s: a.s, len: a.body.length });
  a = await get('/api/book-audio/hi-atomic?token=' + token);
  check('/api/book-audio/hi-atomic → the Hindi studio narration', a.s === 200 && a.body.equals(S2), { s: a.s, len: a.body.length });
  a = await get('/api/book-audio/' + deep.id + '?token=' + token);
  check('a note whose studio take reads an older text → not played (404 live: Bro reads it)', a.s === 404 && JSON.parse(a.body).live === true, a.s);
  // Bro's recording exists for that note → Bro's
  const d = path.join(MEDIA, 'bro-voice', 'energetic-srv00001'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'note-' + deep.id + '.mp3'), BRO); fs.writeFileSync(path.join(d, 'note-atomic.mp3'), BRO);
  a = await get('/api/book-audio/' + deep.id + '?token=' + token);
  check('…and with Bro\'s recording of it → Bro\'s recording (the fallback)', a.s === 200 && a.body.equals(BRO), a.s);
  a = await get('/api/book-audio/atomic?token=' + token);
  check('the studio narration wins over Bro\'s recording of the same note', a.s === 200 && a.body.equals(S1), a.s);
  a = await get('/api/book-audio/atomic');
  check('/api/book-audio still needs a signed-in token', a.s === 401, a.s);
  const lib = (await (await fetch(BASE + '/api/learn/voice-status')).json()).library;
  check('Bro\'s library no longer queues the notes the studio voice reads (117 − 1 English = 116; the Hindi one is played on demand)', lib && lib.total === 116, lib);
  const cr = await (await fetch(BASE + '/credits')).text();
  check('/credits names the narration voice and its licence (from the manifest)', /Book notes are read by/.test(cr) && /studio narrator/.test(cr) && /MIT/.test(cr));
} finally { child.kill(); srv.close(); }
console.log(`\nbookvoice: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
