// Publishes a recording run to the GitHub release "book-voice-v1": the new takes first, then manifest.json (so the server
// never sees an entry whose file is not up yet), then removes takes no entry uses any more.
//   node scripts/book-voice/publish.js <notes.json> <old manifest.json | -> <takes dir> <voice dir>
// Needs GH_TOKEN (contents: write). A note keeps its old take while its text is unchanged and the voice is the same.
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const { voiceId } = require('./voiceid.js');
const TAG = process.env.BOOK_VOICE_TAG || 'book-voice-v1'; // a test run publishes to its own tag
const gh = (args, o) => execFileSync('gh', args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }, o || {}));
const [notesFile, oldFile, takesDir, voiceDir] = process.argv.slice(2);
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
let old = null; try { old = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch (e) { old = null; }
const voice = JSON.parse(fs.readFileSync(path.join(voiceDir, 'voice.json'), 'utf8'));
const vid = voiceId(voiceDir);
// every take of this run: <takes>/<artifact>/items.jsonl + the mp3s beside it
const takes = new Map();
for (const d of fs.existsSync(takesDir) ? fs.readdirSync(takesDir) : []) {
  const f = path.join(takesDir, d, 'items.jsonl'); if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const it = JSON.parse(line); const mp3 = path.join(takesDir, d, it.file);
    if (fs.existsSync(mp3) && fs.statSync(mp3).size === it.bytes) takes.set(it.id, Object.assign(it, { path: mp3 }));
  }
}
const sameVoice = old && old.voice_id === vid;
const items = {}; const upload = [];
for (const n of notes) {
  const t = takes.get(n.id);
  if (t && t.text === n.hash) { items[n.id] = { file: t.file, sha256: t.sha256, bytes: t.bytes, secs: t.secs, text: t.text }; upload.push(t.path); continue; }
  const o = sameVoice && old.items && old.items[n.id];
  if (o && o.text === n.hash) items[n.id] = o; // unchanged: the published take stays
}
const manifest = { voice: voice.name, license: voice.license, voice_id: vid, made: new Date().toISOString(), items };
console.log('takes this run:', takes.size, '· in the manifest:', Object.keys(items).length, 'of', notes.length, 'notes');
// the release (created once; not marked latest)
try { gh(['release', 'view', TAG, '--json', 'tagName']); }
catch (e) { gh(['release', 'create', TAG, '--title', 'Book voice', '--latest=false', '--notes', 'Bro\'s book notes read by the studio narration voice (' + voice.name + ', ' + voice.license + '). Recorded by .github/workflows/book-voice.yml; the server copies them (modules/bookvoice.js).']); }
for (let i = 0; i < upload.length; i += 20) gh(['release', 'upload', TAG, '--clobber', ...upload.slice(i, i + 20)]);
fs.writeFileSync('manifest.json', JSON.stringify(manifest));
gh(['release', 'upload', TAG, '--clobber', 'manifest.json']);
const keep = new Set(Object.values(items).map(i => i.file).concat('manifest.json'));
const assets = JSON.parse(gh(['release', 'view', TAG, '--json', 'assets'])).assets.map(a => a.name);
let removed = 0; for (const a of assets) if (!keep.has(a)) { gh(['release', 'delete-asset', TAG, a, '-y']); removed++; }
console.log('uploaded', upload.length, 'take(s) and the manifest; removed', removed, 'old take(s)');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'uploaded=' + upload.length + '\n');
