// Writes app/ideas/index.json: the books whose 7 story chapters are ready (app/ideas/<id>.json), each checked for shape
// (a hero, 7 chapters, a situation in each, three choices in chapters 1-6) and for a matching book in BOOK_SUMMARIES.
//   node scripts/book-ideas/index.js        (exit 1 when a file is malformed)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..'), dir = path.join(root, 'app', 'ideas');
const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
const books = new Set(vm.runInNewContext('(' + vm.runInNewContext('`' + m[1] + '`') + ')', {}, { timeout: 5000 }).map(b => b.id));
const ids = [], bad = [];
for (const f of fs.readdirSync(dir).filter(f => /^[a-z0-9_-]+\.json$/i.test(f) && f !== 'index.json').sort()) {
  const id = f.slice(0, -5); let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { bad.push(id + ': not JSON'); continue; }
  const ok = j && j.id === id && books.has(id) && j.hero && j.hero.name && Array.isArray(j.chapters) && j.chapters.length === 7 &&
    j.chapters.every((c, i) => c && c.story && c.story.h && c.story.b && c.take && (i === 6 ? !c.ask : c.ask && Array.isArray(c.ask.o) && c.ask.o.length === 3 && [0, 1, 2].includes(c.ask.a) && c.ask.why));
  if (ok) ids.push(id); else bad.push(id + ': wrong shape or no such book');
}
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ ids }));
console.log('book ideas:', ids.length, 'books ready' + (bad.length ? '; problems: ' + bad.join(', ') : ''));
process.exit(bad.length ? 1 : 0);
