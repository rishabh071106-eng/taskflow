// Checks the story-chapter files of Brodoit's books (app/ideas/<id>.json; v32) against the notes in server.js:
//   node scripts/book-ideas/validate.mjs app/ideas [id …]      (no ids: every <id>.json in the folder, except index.json)
// Exit 1 when any file fails. Prints one line per problem.
import fs from 'fs'; import path from 'path';
const dir = process.argv[2]; const want = process.argv.slice(3);
import vm from 'vm';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
const src = vm.runInNewContext('(' + vm.runInNewContext('`' + m[1] + '`') + ')', {}, { timeout: 5000 });
const byId = Object.fromEntries(src.map(b => [b.id, b]));
const words = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const files = want.length ? want.map(id => id + '.json') : fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
let bad = 0, ok = 0;
for (const f of files) {
  const id = f.replace(/\.json$/, ''); const P = [];
  const err = m => P.push(m);
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.log(id + ': not readable JSON (' + e.message + ')'); bad++; continue; }
  const b = byId[id]; if (!b) err('unknown book id');
  if (j.id !== id) err('id field must be "' + id + '"');
  const h = j.hero || {};
  if (!h.name || words(h.name) > 2) err('hero.name: a first name (1-2 words)');
  if (!h.who || words(h.who) < 4 || words(h.who) > 18) err('hero.who: 4-18 words');
  const ch = j.chapters;
  if (!Array.isArray(ch) || ch.length !== 7) { err('chapters: exactly 7 (why this book, the 5 ideas in order, the wrap-up)'); }
  else ch.forEach((c, i) => {
    const at = 'chapter ' + (i + 1) + ': ';
    const s = c.story || {};
    if (!s.h || words(s.h) > 7) err(at + 'story.h: a scene title of at most 7 words');
    const sw = words(s.b); if (sw < 80 || sw > 150) err(at + 'story.b: 80-150 words (has ' + sw + ')');
    if (h.name && !String(s.b || '').includes(h.name.split(' ')[0])) err(at + 'story.b must name ' + h.name);
    if (i < 6) {
      const a = c.ask || {};
      if (!a.q || words(a.q) > 30 || !/\?$/.test(String(a.q).trim())) err(at + 'ask.q: one question, at most 30 words, ending in "?"');
      if (!Array.isArray(a.o) || a.o.length !== 3 || a.o.some(o => !o || words(o) > 24)) err(at + 'ask.o: exactly 3 options, each at most 24 words');
      if (![0, 1, 2].includes(a.a)) err(at + 'ask.a: 0, 1 or 2 (the right option)');
      const ww = words(a.why); if (ww < 20 || ww > 75) err(at + 'ask.why: 20-75 words (has ' + ww + ')');
    } else if (c.ask) err(at + 'the wrap-up chapter has no ask');
    const tw = words(c.take); if (tw < 4 || tw > 22) err(at + 'take: one line, 4-22 words (has ' + tw + ')');
    const all = [s.h, s.b, c.take, ...(c.ask ? [c.ask.q, ...(c.ask.o || []), c.ask.why] : [])].join(' ');
    if (/[*#_`]|\p{Extended_Pictographic}/u.test(all)) err(at + 'plain text only (no markdown, no emoji)');
    for (const q of all.match(/["“”][^"“”]{0,400}["“”]/g) || []) if (words(q) > 14) err(at + 'a quotation longer than 14 words: ' + q.slice(0, 60));
  });
  if (Array.isArray(ch) && ch.length === 7) {
    const ans = ch.slice(0, 6).map(c => c.ask && c.ask.a);
    if (new Set(ans).size === 1) err('the right answer is always option ' + ans[0] + ': vary it');
  }
  if (P.length) { bad++; for (const m of P) console.log(id + ': ' + m); } else ok++;
}
console.log(`\n${ok} ok, ${bad} with problems`);
process.exit(bad ? 1 : 0);
