// v35.3: the cloud copy of the books ElevenLabs read on the server (modules/bookeleven.js). Each recording is paid for
// once: this copies every new one to the GitHub release "book-eleven-v1" (manifest.json + one mp3 per book), and a server
// that lost its volume takes them back from there instead of paying ElevenLabs again.
//   node scripts/book-eleven/backup.js <site>      (needs GH_TOKEN with contents: write; .github/workflows/book-eleven-backup.yml)
// Recordings the site no longer lists stay in the copy (that is the point of a backup); a book's older take is removed
// once a newer one of the same book is up.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const TAG = process.env.BOOK_ELEVEN_TAG || 'book-eleven-v1';
const REPO = process.env.GITHUB_REPOSITORY || 'rishabh071106-eng/taskflow';
const site = String(process.argv[2] || 'https://brodoit.com').replace(/\/$/, '');
const gh = args => execFileSync('gh', [...args, '-R', REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const FILE_RE = /^[a-z0-9_-]{1,80}\.mp3$/i;
const get = async (url, ms) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'brodoit-backup' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url); return r; };

(async () => {
  const now = (await (await get(site + '/api/book-eleven/index.json', 30000)).json()).items || {};
  try { gh(['release', 'view', TAG, '--json', 'tagName']); }
  catch (e) { gh(['release', 'create', TAG, '--title', 'Books read by ElevenLabs', '--latest=false', '--notes', 'The books in Bro\'s voice, read once by ElevenLabs on the Brodoit server and kept here so they are never paid for twice (modules/bookeleven.js, .github/workflows/book-eleven-backup.yml).']); }
  let man = { items: {} };
  try { fs.mkdirSync('old', { recursive: true }); gh(['release', 'download', TAG, '-p', 'manifest.json', '-D', 'old', '--clobber']); man = JSON.parse(fs.readFileSync('old/manifest.json', 'utf8')); } catch (e) { man = { items: {} }; }
  if (!man.items || typeof man.items !== 'object') man.items = {};
  fs.mkdirSync('up', { recursive: true }); let added = 0;
  for (const [id, it] of Object.entries(now)) {
    if (!FILE_RE.test(String(it.file || '')) || !/^[0-9a-f]{64}$/.test(String(it.sha256 || ''))) continue;
    if (man.items[id] && man.items[id].sha256 === it.sha256) continue;
    const buf = Buffer.from(await (await get(site + '/api/book-eleven/file/' + encodeURIComponent(it.file), 300000)).arrayBuffer());
    if (buf.length !== it.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== it.sha256) { console.log('checksum mismatch for', it.file, '(skipped)'); continue; }
    const f = path.join('up', it.file); fs.writeFileSync(f, buf);
    gh(['release', 'upload', TAG, f, '--clobber']); fs.unlinkSync(f);
    man.items[id] = it; added++;
    console.log('backed up', id, (buf.length / 1048576).toFixed(1) + ' MB');
  }
  man.made = new Date().toISOString(); man.voice = 'ElevenLabs, in Bro\'s voice';
  fs.writeFileSync('manifest.json', JSON.stringify(man));
  gh(['release', 'upload', TAG, 'manifest.json', '--clobber']);
  const keep = new Set(Object.values(man.items).map(i => i.file).concat('manifest.json'));
  const assets = JSON.parse(gh(['release', 'view', TAG, '--json', 'assets'])).assets.map(a => a.name);
  let removed = 0; for (const a of assets) if (!keep.has(a)) { gh(['release', 'delete-asset', TAG, a, '-y']); removed++; }
  console.log('cloud copy:', Object.keys(man.items).length, 'books ·', added, 'new ·', removed, 'older takes removed · the site has', Object.keys(now).length);
})().catch(e => { console.error(e.message || e); process.exit(1); });
