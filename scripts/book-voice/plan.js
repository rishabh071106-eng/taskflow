// Which notes the recording run reads: the new ones, the edited ones, and all of them when the voice changed.
//   node scripts/book-voice/plan.js <notes.json> <old manifest.json | -> <voice dir> <todo.json> [redo]
// Writes to $GITHUB_OUTPUT: en (English notes to read), en_shards ([0,1,…], at most 20 runners at once, about 5 notes
// characters each, see below; Chatterbox on a 4-vCPU runner reads ~1 s of audio in ~8 s), en_n, hi (Hindi notes, one
// runner: Kokoro is quick). Each English note carries its runner in `shard`.
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
// English runners by length, not count: a 3-minute note and a 9-minute brief differ 3x; about 15,000 characters
// (~17 minutes of audio, ~2.5 hours of CPU) per runner, at most 20; the longest notes go first to the emptiest runner
const enChars = todo.filter(n => n.lang === 'en').reduce((s, n) => s + n.text.length, 0);
const shards = en ? Math.min(20, en, Math.max(1, Math.ceil(enChars / 15000))) : 0;
const load = Array(shards).fill(0);
for (const n of todo.filter(n => n.lang === 'en').sort((a, b) => b.text.length - a.text.length)) { const k = load.indexOf(Math.min(...load)); n.shard = k; load[k] += n.text.length; }
fs.writeFileSync(todoFile, JSON.stringify(todo));
console.log((fresh ? 'every note (a new voice, or the first run): ' : 'new or edited notes: ') + en + ' English + ' + hi + ' Hindi of ' + notes.length + '; ' + shards + ' English runner(s)');
const lines = 'en=' + en + '\nen_shards=' + JSON.stringify([...Array(shards).keys()]) + '\nen_n=' + shards + '\nhi=' + hi + '\ncount=' + todo.length + '\nvoice_id=' + vid + '\n';
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines); else process.stdout.write(lines);
