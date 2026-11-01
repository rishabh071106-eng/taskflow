// Brodoit Books v33: the book as Bro reads it, in 7 chapters. One file for the page (window.BookFull), the server
// (modules: require('../app/bookfull.js')) and the studio recording (scripts/book-voice/notes.js), so the text that is
// recorded, the text the server checks the recording against, and the text the page shows are always the same.
//   compose(book, ideas) -> { id: 'book-<id>', title, author, chapters: [{ n, title, idea, tryIt, h, story, take, bro }], text } | null
// book: an entry of BOOK_SUMMARIES (Bro's note: 7 paragraphs: why this book, ideas one to five, Bro's take).
// ideas: app/ideas/<id>.json (one invented Indian main character carried through 7 chapters, written for Brodoit).
// Chapter 1 is why the book matters and meets the main character, chapters 2 to 6 are the book's five ideas, each
// explained in Bro's words and then lived in a story, and chapter 7 is how it turned out and Bro's take. Each chapter is
// one paragraph of `text`, opening "Chapter one. <title>." (the player's section marks).
(function (root) {
  'use strict';
  const NUM = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const clean = s => String(s == null ? '' : s).replace(/\\/g, '').replace(/\s+/g, ' ').trim();
  const stop = s => /[.!?]["'”’)]?$/.test(s) ? s : s + '.';
  function paras(summary) { return String(summary || '').replace(/\\/g, '').split(/\n\s*\n/).map(clean).filter(Boolean); }
  function compose(book, ideas) {
    if (!book || !book.id || !ideas || !Array.isArray(ideas.chapters) || ideas.chapters.length !== 7 || !ideas.hero) return null;
    const p = paras(book.summary);
    if (p.length !== 7) return null;
    const hero = ideas.hero, who = clean(hero.who);
    const meet = 'Meet ' + clean(hero.name) + ', ' + (/^(a|an|the) /i.test(who) ? who : 'who ' + who) + '.';
    const chapters = [];
    for (let i = 0; i < 7; i++) {
      const c = ideas.chapters[i] || {}, st = c.story || {};
      const ch = { n: i + 1, title: '', idea: '', tryIt: '', h: clean(st.h), story: clean(st.b), take: clean(c.take), bro: '' };
      if (i === 0) { ch.title = 'Why this book'; ch.idea = p[0].replace(/^Bro's notes on /, 'This is '); ch.meet = meet; }
      else if (i === 6) { ch.title = 'How it turned out'; ch.bro = p[6].replace(/^Bro's take[.:]\s*/, ''); }
      else {
        const m = /^Idea [a-z]+\.\s*([^.!?]{3,90})[.!?]\s*/i.exec(p[i]);
        const ins = (book.insights || [])[i - 1] || [];
        ch.title = m ? m[1].trim() : clean(ins[0]);
        let body = m ? p[i].slice(m[0].length) : p[i];
        const k = body.indexOf('Try this today:');
        if (k >= 0) { ch.tryIt = clean(body.slice(k + 15)); body = body.slice(0, k).trim(); }
        ch.idea = body;
      }
      chapters.push(ch);
    }
    const text = chapters.map(ch => {
      const parts = ['Chapter ' + NUM[ch.n - 1] + '.', stop(ch.title)];
      if (ch.idea) parts.push(ch.idea);
      if (ch.meet) parts.push(ch.meet);
      if (ch.h) parts.push(stop(ch.h));
      if (ch.story) parts.push(ch.story);
      if (ch.take) parts.push('In short: ' + ch.take);
      if (ch.tryIt) parts.push('Try this today: ' + ch.tryIt);
      if (ch.bro) parts.push("Bro's take. " + ch.bro);
      return parts.join(' ');
    }).join('\n\n');
    return { id: 'book-' + book.id, base: book.id, title: String(book.title || ''), author: String(book.author || ''), hero: { name: clean(hero.name), who }, chapters, text };
  }
  const api = { compose, paras, NUM };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BookFull = api;
})(typeof window !== 'undefined' ? window : globalThis);
