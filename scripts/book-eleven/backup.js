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
// v36: a busy server answers a 502 now and then (7 Nov, mid-copy): try a file 4 times, then leave it for the next run
const getRetry = async (url, ms) => { let last; for (let k = 0; k < 4; k++) { try { return await get(url, ms); } catch (e) { last = e; if (k < 3) await new Promise(r => setTimeout(r, Number(process.env.BACKUP_RETRY_MS || 5000) * (k + 1))); } } throw last; };

(async () => {
  const now = (await (await get(site + '/api/book-eleven/index.json', 30000)).json()).items || {};
  try { gh(['release', 'view', TAG, '--json', 'tagName']); }
  catch (e) { gh(['release', 'create', TAG, '--title', 'Books read by ElevenLabs', '--latest=false', '--notes', 'The books in Bro\'s voice, read once by ElevenLabs on the Brodoit server and kept here so they are never paid for twice (modules/bookeleven.js, .github/workflows/book-eleven-backup.yml).']); }
  let man = { items: {} };
  try { fs.mkdirSync('old', { recursive: true }); gh(['release', 'download', TAG, '-p', 'manifest.json', '-D', 'old', '--clobber']); man = JSON.parse(fs.readFileSync('old/manifest.json', 'utf8')); } catch (e) { man = { items: {} }; }
  if (!man.items || typeof man.items !== 'object') man.items = {};
  fs.mkdirSync('up', { recursive: true }); let added = 0; const failed = [];
  // the manifest goes up every 10 recordings (and at the end), so a run that stops halfway keeps what it copied
  const saveMan = () => { man.made = new Date().toISOString(); man.voice = 'ElevenLabs (the lessons: George; the books: Bro\'s voice)'; fs.writeFileSync('manifest.json', JSON.stringify(man)); gh(['release', 'upload', TAG, 'manifest.json', '--clobber']); };
  for (const [id, it] of Object.entries(now)) {
    if (!FILE_RE.test(String(it.file || '')) || !/^[0-9a-f]{64}$/.test(String(it.sha256 || ''))) continue;
    if (man.items[id] && man.items[id].sha256 === it.sha256) continue;
    let buf; try { buf = Buffer.from(await (await getRetry(site + '/api/book-eleven/file/' + encodeURIComponent(it.file), 300000)).arrayBuffer()); }
    catch (e) { failed.push(id); console.log('could not fetch', id + ':', String(e.message || e).slice(0, 160), '(next run)'); continue; }
    if (buf.length !== it.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== it.sha256) { console.log('checksum mismatch for', it.file, '(skipped)'); continue; }
    const f = path.join('up', it.file); fs.writeFileSync(f, buf);
    gh(['release', 'upload', TAG, f, '--clobber']); fs.unlinkSync(f);
    man.items[id] = it; added++;
    console.log('backed up', id, (buf.length / 1048576).toFixed(1) + ' MB');
    if (added % 10 === 0) saveMan();
  }
  saveMan();
  const keep = new Set(Object.values(man.items).map(i => i.file).concat('manifest.json'));
  const assets = JSON.parse(gh(['release', 'view', TAG, '--json', 'assets'])).assets.map(a => a.name);
  let removed = 0; for (const a of assets) if (!keep.has(a)) { gh(['release', 'delete-asset', TAG, a, '-y']); removed++; }
  console.log('cloud copy:', Object.keys(man.items).length, 'recordings ·', added, 'new ·', removed, 'older takes removed · the site has', Object.keys(now).length + (failed.length ? ' · not fetched (next run): ' + failed.join(', ') : ''));
  if (failed.length) process.exitCode = 1; // shown as a failed run, after everything else was kept
})().catch(e => { console.error(e.message || e); process.exit(1); });
