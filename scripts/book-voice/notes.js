// The book notes the studio narration reads, with the hash the server checks (modules/bookvoice.js textHash):
//   node scripts/book-voice/notes.js <out.json> [site]   → [{ id, lang, text, hash }]
// English notes come from BOOK_SUMMARIES in server.js (the same text the app shows), the public-domain books'
// chapter-by-chapter briefs from app/briefs/ ("brief-<id>"), the books in 7 chapters ("book-<id>", v33: app/bookfull.js
// from the notes and app/ideas/<id>.json), Hindi notes from the live site's /api/book-hi (written there by
// modules/booknotes-hi.js). The text is taken exactly as the server reads it.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { textHash } = require('../../modules/bookvoice.js');

function englishNotes(serverJs) {
  const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(serverJs);
  if (!m) throw new Error('BOOK_SUMMARIES not found in server.js');
  // server.js holds the SPA in a template literal: "\\" there is one backslash in the served page
  const arr = vm.runInNewContext('(' + m[1].replace(/\\\\/g, '\\') + ')', {}, { timeout: 5000 });
  return arr.filter(b => b && b.id && b.summary);
}
// v33: each book in 7 chapters, in the app's order (the first books on the shelf are recorded first)
function fullBooks(books) {
  const { compose } = require('../../app/bookfull.js'); const out = [];
  for (const b of books) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'ideas', b.id + '.json'), 'utf8')); } catch (e) { continue; }
    const f = compose(b, j); if (f) out.push({ id: f.id, lang: 'en', text: f.text });
  }
  return out;
}
async function hindiNotes(site) {
  const out = [];
  try {
    const r = await fetch(site + '/api/book-hi', { signal: AbortSignal.timeout(30000) });
    const ids = ((await r.json()).ids || []).filter(id => /^[a-zA-Z0-9_-]{1,60}$/.test(id));
    for (const id of ids) {
      try {
        const j = await (await fetch(site + '/api/book-hi/' + encodeURIComponent(id), { signal: AbortSignal.timeout(30000) })).json();
        if (j && j.notes === 2 && j.summary) out.push({ id: 'hi-' + id, lang: 'hi', text: String(j.summary).replace(/\\/g, '') });
      } catch (e) { console.log('no Hindi note for', id + ':', e.message); }
    }
  } catch (e) { console.log('Hindi notes unavailable:', e.message); }
  return out;
}
(async () => {
  const outFile = process.argv[2] || 'notes.json', site = (process.argv[3] || 'https://brodoit.com').replace(/\/$/, '');
  const books = englishNotes(fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8'));
  const en = books.map(b => ({ id: String(b.id), lang: 'en', text: String(b.summary).replace(/\\/g, '') }));
  const hi = await hindiNotes(site);
  // v32: the public-domain books' chapter-by-chapter briefs (app/briefs/<id>.json), played as "brief-<id>"
  const bdir = path.join(__dirname, '..', '..', 'app', 'briefs'); const briefs = [];
  for (const f of fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => /^[a-z0-9_-]+\.json$/i.test(f)).sort() : []) {
    const j = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8')); if (j && j.text) briefs.push({ id: 'brief-' + f.slice(0, -5), lang: 'en', text: String(j.text) });
  }
  const full = fullBooks(books);
  const all = [...en, ...briefs, ...full, ...hi].map(n => Object.assign(n, { hash: textHash(n.text) }));
  fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
  console.log('notes:', en.length, 'English,', briefs.length, 'chapter-by-chapter briefs,', full.length, 'books in 7 chapters,', hi.length, 'Hindi,', all.reduce((s, n) => s + n.text.length, 0), 'characters');
})().catch(e => { console.error(e); process.exit(1); });
