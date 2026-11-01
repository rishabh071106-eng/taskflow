// Which notes the recording run reads: the new ones, the edited ones, and all of them when the voice changed.
//   node scripts/book-voice/plan.js <notes.json> <old manifest.json | -> <voice dir> <todo.json> [redo]
// Writes to $GITHUB_OUTPUT: en (English notes to read), en_shards ([0,1,…], at most 20 runners at once, about 15,000
// characters each, see below; Chatterbox on a 4-vCPU runner reads ~1 s of audio in ~8 s), en_n, hi (Hindi notes, one
// runner: Kokoro is quick), more (true when English notes were left for the next run). Each English note carries its
// runner in `shard`.
'use strict';
const fs = require('fs');
const { voiceId } = require('./voiceid.js');
const [notesFile, oldFile, voiceDir, todoFile, redo] = process.argv.slice(2);
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
let old = null; try { old = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch (e) { old = null; }
const vid = voiceId(voiceDir);
const fresh = !old || old.voice_id !== vid || redo === 'true';
let todo = notes.filter(n => fresh || !old.items || !old.items[n.id] || old.items[n.id].text !== n.hash);
// a test run reads only the first few notes of each language (BOOK_VOICE_LIMIT)
const limit = parseInt(process.env.BOOK_VOICE_LIMIT || '', 10);
if (limit > 0) todo = ['en', 'hi'].flatMap(l => todo.filter(n => n.lang === l).slice(0, limit));
const en = todo.filter(n => n.lang === 'en').length, hi = todo.filter(n => n.lang === 'hi').length;
// English runners by length, not count: a 3-minute note and a 9-minute book differ 3x; about 15,000 characters
// (~17 minutes of audio, ~2 hours of CPU) per runner, at most 20. v33: no runner gets more than RUNNER_CHARS (27,000
// characters, ~3.5 hours at the slowest pace seen, inside the job's 350 minutes); what does not fit waits for the next
// run (more=true: the publish job starts it at once). Notes go in the order notes.js lists them (notes, the
// public-domain books, then the books in 7 chapters, the first on the shelf first), each to the emptiest runner it fits.
const RUNNER_CHARS = Number(process.env.BOOK_VOICE_RUNNER_CHARS) || 27000;
const enAll = todo.filter(n => n.lang === 'en');
const enChars = enAll.reduce((s, n) => s + n.text.length, 0);
const shards = en ? Math.min(20, en, Math.max(1, Math.ceil(enChars / 15000))) : 0;
const load = Array(shards).fill(0); const later = new Set();
for (const n of enAll) {
  const k = load.indexOf(Math.min(...load));
  if (load[k] && load[k] + n.text.length > RUNNER_CHARS) { later.add(n); continue; }
  n.shard = k; load[k] += n.text.length;
}
todo = todo.filter(n => !later.has(n));
const enNow = en - later.size;
fs.writeFileSync(todoFile, JSON.stringify(todo));
console.log((fresh ? 'every note (a new voice, or the first run): ' : 'new or edited notes: ') + en + ' English + ' + hi + ' Hindi of ' + notes.length + '; ' + shards + ' English runner(s)' + (later.size ? '; ' + enNow + ' English now, ' + later.size + ' in the next run' : ''));
const lines = 'en=' + enNow + '\nen_shards=' + JSON.stringify([...Array(shards).keys()]) + '\nen_n=' + shards + '\nhi=' + hi + '\ncount=' + todo.length + '\nmore=' + (later.size > 0) + '\nvoice_id=' + vid + '\n';
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines); else process.stdout.write(lines);
