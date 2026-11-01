// v31 Book voice: Bro's book notes read by a studio-grade, openly licensed voice model. The notes are recorded in GitHub
// Actions (.github/workflows/book-voice.yml: free runners, nothing on this server's CPU) and published as the GitHub
// release "book-voice-v1" with a manifest; this module copies the recordings to MEDIA_DIR/book-voice/ and
// /api/book-audio/:id plays them before Bro's own recording (modules/brolibrary.js), which stays the fallback.
//   create({ mediaDir, text: id → current note text | '', base?, fetch?, log?, minFreeBytes? })
//     → { file(id) → path | '', sync() → Promise<number downloaded>, stats(), start() }
// manifest.json: { voice, license, made, items: { <id>: { file, sha256, bytes, secs, text } } }, where <id> is a book id
// ("atomic") or a Hindi note ("hi-atomic") and text = textHash(the note it reads). A recording is used only while the
// note's text is still the one it reads (an edited note goes back to Bro's voice until the next recording run), and only
// after its sha256 checks out.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const REPO = 'rishabh071106-eng/taskflow', TAG = 'book-voice-v1';
// the recorder (scripts/book-voice/record.py) hashes the same way: whitespace runs → one space, trimmed, sha1, 12 hex
const textHash = t => crypto.createHash('sha1').update(String(t || '').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 12);
const ID_RE = /^(hi-)?[a-z0-9_-]{1,60}$/i, FILE_RE = /^[a-z0-9_-]{1,80}\.mp3$/i;

function create(o) {
  const dir = path.join(o.mediaDir, 'book-voice');
  const base = String(o.base || process.env.BOOK_VOICE_URL || `https://github.com/${REPO}/releases/download/${TAG}/`).replace(/\/?$/, '/');
  const fetchFn = o.fetch || ((...a) => fetch(...a));
  const log = o.log || ((...a) => console.log('[book-voice]', ...a));
  const minFree = o.minFreeBytes == null ? 1024 * 1024 * 1024 : o.minFreeBytes; // the volume keeps 1 GB free
  const manFile = path.join(dir, 'manifest.json');
  let man = null; try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch (e) { man = null; }
  const st = { synced_at: null, error: '', last_downloaded: 0, running: null };
  const refused = new Set(); // file:sha256 that failed its checksum (not fetched again until the manifest changes it)

  function item(id) { const it = man && man.items && Object.prototype.hasOwnProperty.call(man.items, id) ? man.items[id] : null; return it && FILE_RE.test(String(it.file || '')) ? it : null; }
  function file(id) {
    id = String(id || ''); if (!ID_RE.test(id)) return '';
    const it = item(id); if (!it) return '';
    let t = ''; try { t = o.text(id) || ''; } catch (e) { t = ''; }
    if (!t || textHash(t) !== it.text) return '';
    const f = path.join(dir, it.file);
    try { return fs.statSync(f).size === it.bytes ? f : ''; } catch (e) { return ''; }
  }
  function freeBytes() { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; } }

  async function get(url, ms) {
    const r = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'brodoit-book-voice' } });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' for ' + url.split('/').pop()), { status: r.status });
    return Buffer.from(await r.arrayBuffer());
  }

  // the newest manifest, then every recording that matches today's note text and is not here yet, one at a time
  function sync() {
    if (st.running) return st.running;
    st.running = (async () => {
      let got = 0;
      try {
        fs.mkdirSync(dir, { recursive: true });
        let next;
        try { next = JSON.parse((await get(base + 'manifest.json', 30000)).toString('utf8')); }
        catch (e) { if (e.status === 404) { st.error = 'not published yet'; return 0; } throw e; }
        if (!next || typeof next.items !== 'object') throw new Error('manifest without items');
        man = next;
        const tmp = manFile + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(man)); fs.renameSync(tmp, manFile);
        const want = new Set();
        for (const [id, it] of Object.entries(man.items)) {
          if (!ID_RE.test(id) || !it || !FILE_RE.test(String(it.file || '')) || !/^[0-9a-f]{64}$/.test(String(it.sha256 || ''))) continue;
          let t = ''; try { t = o.text(id) || ''; } catch (e) { t = ''; }
          if (!t || textHash(t) !== it.text) continue; // recorded from another version of the note
          want.add(it.file);
          const f = path.join(dir, it.file);
          try { if (fs.statSync(f).size === it.bytes) continue; } catch (e) { /* not here yet */ }
          if (refused.has(it.file + ':' + it.sha256)) continue;
          if (freeBytes() - (it.bytes || 0) < minFree) { st.error = 'disk nearly full: stopped downloading'; log(st.error); break; }
          let buf;
          try { buf = await get(base + it.file, 180000); }
          catch (e) { log('could not fetch', it.file + ':', e.message); continue; }
          const sum = crypto.createHash('sha256').update(buf).digest('hex');
          if (sum !== it.sha256 || buf.length !== it.bytes) { refused.add(it.file + ':' + it.sha256); log('checksum mismatch for', it.file, '(skipped)'); continue; }
          const t2 = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t2, buf); fs.renameSync(t2, f);
          got++;
        }
        // recordings no manifest entry uses any more (an older take of an edited note)
        for (const n of fs.readdirSync(dir)) if (FILE_RE.test(n) && !want.has(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* next time */ } }
        st.error = st.error === 'not published yet' ? '' : st.error;
        st.synced_at = new Date().toISOString(); st.last_downloaded = got;
        if (got) log('downloaded', got, 'recording(s) ·', stats().ready, 'ready ·', man.voice || '');
      } catch (e) { st.error = String(e.message || e).slice(0, 200); log('sync failed:', st.error); }
      return got;
    })().finally(() => { st.running = null; });
    return st.running;
  }
  function stats() {
    const ids = man && man.items ? Object.keys(man.items) : [];
    let ready = 0; for (const id of ids) if (file(id)) ready++;
    return { voice: (man && man.voice) || '', license: (man && man.license) || '', made: (man && man.made) || null, published: ids.length, ready, synced_at: st.synced_at, error: st.error };
  }
  // boot + every 6 hours (a recording run publishes at most a few times a day)
  function start(delayMs) {
    const env = Number(process.env.BOOK_VOICE_DELAY_MS);
    const d = delayMs != null ? delayMs : process.env.BOOK_VOICE_DELAY_MS && Number.isFinite(env) ? env : 90e3;
    const t = setTimeout(() => { sync().catch(() => {}); const iv = setInterval(() => sync().catch(() => {}), 6 * 3600e3); if (iv.unref) iv.unref(); }, d);
    if (t.unref) t.unref();
  }
  return { file, sync, stats, start, dir: () => dir };
}

module.exports = { create, textHash, REPO, TAG };
