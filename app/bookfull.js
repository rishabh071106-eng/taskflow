// Brodoit Books v33: the book as Bro reads it, in 7 chapters. One file for the page (window.BookFull), the server
// (modules: require('../app/bookfull.js')) and the studio recording (scripts/book-voice/notes.js), so the text that is
// recorded, the text the server checks the recording against, and the text the page shows are always the same.
//   compose(book, ideas) -> { id: 'book-<id>', title, author, chapters: [{ n, title, idea, tryIt, h, story, take, bro }], text } | null
// book: an entry of BOOK_SUMMARIES (Bro's note: 7 paragraphs: why this book, ideas one to five, Bro's take).
// ideas: app/ideas/<id>.json (one invented Indian main character carried through 7 chapters, written for Brodoit).
// Chapter 1 is why the book matters and meets the main character, chapters 2 to 6 are the book's five ideas, each
// explained in Bro's words and then lived in a story, and chapter 7 is how it turned out and Bro's take. Each chapter is
// one paragraph of `text`, opening "Chapter one. <title>." (the player's section marks).
// v35 (owner: "at least 10 minutes … the people should get learned … add value to life"): after each story, "Pause and
// think": the story's real decision (ideas/<id>.json `ask`), its three choices, the best one and why; chapter 7 ends with
// the five ideas once more and a week to live them (each day one "Try this today"). ~12,500-14,000 characters, 13-15
// minutes read.
(function (root) {
  'use strict';
  const NUM = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const ORD = ['first', 'second', 'third'];
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
      const ask = c.ask || null;
      if (ask && ask.q && Array.isArray(ask.o) && ask.o.length >= 2 && ask.o[ask.a] != null) ch.think = { q: clean(ask.q), o: ask.o.map(clean), a: ask.a | 0, why: clean(ask.why) };
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
    // the last chapter: the five ideas once more, and a week to live them
    const last = chapters[6];
    last.recap = chapters.slice(1, 6).map(c => c.title);
    last.week = chapters.slice(1, 6).map((c, k) => ({ day: DAYS[k], tryIt: c.tryIt })).filter(d => d.tryIt);
    const text = chapters.map(ch => {
      const parts = ['Chapter ' + NUM[ch.n - 1] + '.', stop(ch.title)];
      if (ch.idea) parts.push(ch.idea);
      if (ch.meet) parts.push(ch.meet);
      if (ch.h) parts.push(stop(ch.h));
      if (ch.story) parts.push(ch.story);
      if (ch.think) {
        const t = ch.think;
        parts.push('Pause and think. ' + stop(t.q), t.o.map((o, k) => NUM[k].charAt(0).toUpperCase() + NUM[k].slice(1) + ': ' + stop(o)).join(' '), 'Take a second and pick one.',
          'The best move is the ' + (ORD[t.a] || NUM[t.a]) + ' one: ' + stop(t.o[t.a]), t.why);
      }
      if (ch.take) parts.push('In short: ' + ch.take);
      if (ch.tryIt) parts.push('Try this today: ' + ch.tryIt);
      if (ch.recap && ch.recap.length) parts.push('Before you go, here is the whole book in one breath. ' + ch.recap.map((t, k) => NUM[k].charAt(0).toUpperCase() + NUM[k].slice(1) + ': ' + stop(t)).join(' '));
      if (ch.week && ch.week.length) parts.push('And here is a simple week to make it real. ' + ch.week.map(d => d.day + ': ' + stop(d.tryIt)).join(' ') + ' And on the weekend, look back at what changed, and keep the one step that helped you most.');
      if (ch.bro) parts.push("Bro's take. " + ch.bro);
      return parts.join(' ');
    }).join('\n\n');
    return { id: 'book-' + book.id, base: book.id, title: String(book.title || ''), author: String(book.author || ''), hero: { name: clean(hero.name), who }, chapters, text };
  }
  // ── v36: the lesson (owner, 7 Nov: "rename it to lessons … every lesson you click goes inside a different UI … give
  // image of that person and then put some words under it … keep it for 8 minutes"). The same book, told as 19 cards:
  // the cover, meet the hero, then for each of the five ideas: the idea (Bro's explanation, its first sentences), the
  // story (whole: it is the teaching) and the lesson ("Pause and think": the question and the best move read out, the
  // three choices and the why on the card; "In short"; "Try this today" on the card), how it turned out with Bro's
  // take, and the end card (the five ideas, a week to live them; nothing read). Each card's narration is one paragraph
  // of `text`, so a recording knows where every card starts (its cues). ~7,000-7,800 characters: about 8 minutes.
  //   lesson(book, ideas) -> { id: 'lesson-<id>', base, title, author, hero, cards: [{ kind, say, … }], text } | null
  function sentences(t) { return (String(t || '').match(/[^.!?]+[.!?]+["'”’)]*\s*/g) || [String(t || '')]).map(x => x.trim()).filter(Boolean); }
  function upTo(t, max, min) { const ss = sentences(t); let out = ''; let n = 0; for (const x of ss) { if (n >= (min || 1) && (out + ' ' + x).length > max) break; out = (out + ' ' + x).trim(); n++; } return out; }
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
  function lesson(book, ideas) {
    const f = compose(book, ideas); if (!f) return null;
    const ch = f.chapters, cards = [];
    cards.push({ kind: 'cover', say: ch[0].idea, why: ch[0].idea });
    cards.push({ kind: 'meet', say: ch[0].meet + ' ' + upTo(ch[0].story, 300, 2), h: ch[0].h, text: upTo(ch[0].story, 300, 2), scene: 0 });
    for (let k = 1; k <= 5; k++) {
      const c = ch[k];
      cards.push({ kind: 'idea', n: k, say: 'Idea ' + NUM[k - 1] + '. ' + stop(c.title) + ' ' + upTo(c.idea, 260, 2), title: c.title, body: upTo(c.idea, 260, 2) });
      cards.push({ kind: 'story', n: k, say: stop(c.h) + ' ' + c.story, h: c.h, story: c.story, scene: k });
      const t = c.think;
      const say = (t ? 'Pause and think. ' + stop(t.q) + ' The best move: ' + stop(t.o[t.a]) + ' ' : '') + (c.take ? 'In short: ' + stop(c.take) : '');
      cards.push({ kind: 'lesson', n: k, say: say.trim(), think: t || null, take: c.take, tryIt: c.tryIt });
    }
    const e = ch[6];
    cards.push({ kind: 'ending', say: 'How it turned out. ' + stop(e.h) + ' ' + upTo(e.story, 420, 3) + (e.take ? ' In short: ' + stop(e.take) : '') + " Bro's take. " + upTo(e.bro, 230, 2), h: e.h, story: upTo(e.story, 420, 3), take: e.take, bro: upTo(e.bro, 230, 2), scene: 6 });
    cards.push({ kind: 'end', say: '', recap: e.recap || [], week: e.week || [] });
    const text = cards.filter(c => c.say).map(c => c.say.replace(/\s+/g, ' ').trim()).join('\n\n');
    return { id: 'lesson-' + f.base, base: f.base, title: f.title, author: f.author, hero: f.hero, cards, text };
  }
  // ── v37: the lesson in Hindi. hi = app/lessons-hi/<id>.json (scripts/lessons/hi.js): the English lesson's words
  // written in natural spoken Hindi, card by card. The narration joins them the Hindi way ("पहला विचार।", "रुकिए और
  // सोचिए।", "सबसे अच्छा कदम:", "सार यह है:", "आख़िर में क्या हुआ।", "ब्रो की राय।"); the pictures and the cues are the same.
  //   lessonHi(enLesson, hi) -> { id: 'lesson-hi-<id>', lang: 'hi', base, title, author, hero, cards, text } | null
  const ORD_HI = ['पहला', 'दूसरा', 'तीसरा', 'चौथा', 'पाँचवाँ'];
  const hstop = s => { s = clean(s); return /[।?!.…"”’)]$/.test(s) ? s : s + '।'; };
  function lessonHi(en, hi) {
    if (!en || !hi || !hi.hero || !Array.isArray(hi.cards) || hi.cards.length !== en.cards.length) return null;
    const cards = [];
    for (let i = 0; i < en.cards.length; i++) {
      const e = en.cards[i], c = hi.cards[i] || {};
      if (c.k !== e.kind) return null;
      const x = Object.assign({}, e);
      switch (e.kind) {
        case 'cover': x.why = clean(c.why); x.say = x.why; break;
        case 'meet': x.text = clean(c.text); x.h = ''; x.say = hstop(hi.hero.meet) + ' ' + x.text; break;
        case 'idea': x.title = clean(c.title).replace(/[।.]+$/, ''); x.body = clean(c.body); x.say = ORD_HI[e.n - 1] + ' विचार। ' + hstop(x.title) + ' ' + x.body; break;
        case 'story': x.h = clean(c.h).replace(/[।.]+$/, ''); x.story = clean(c.story); x.say = hstop(x.h) + ' ' + x.story; break;
        case 'lesson': {
          const t = c.think && e.think ? { q: clean(c.think.q), o: (c.think.o || []).map(clean), a: e.think.a, why: clean(c.think.why) } : null;
          x.think = t; x.take = clean(c.take); x.tryIt = clean(c.tryIt);
          x.say = ((t ? 'रुकिए और सोचिए। ' + hstop(t.q) + ' सबसे अच्छा कदम: ' + hstop(t.o[t.a]) + ' ' : '') + (x.take ? 'सार यह है: ' + hstop(x.take) : '')).trim();
          break;
        }
        case 'ending': x.h = clean(c.h).replace(/[।.]+$/, ''); x.story = clean(c.story); x.take = clean(c.take); x.bro = clean(c.bro);
          x.say = 'आख़िर में क्या हुआ। ' + hstop(x.h) + ' ' + x.story + (x.take ? ' सार यह है: ' + hstop(x.take) : '') + (x.bro ? ' ब्रो की राय। ' + x.bro : ''); break;
        case 'end': x.recap = (c.recap || []).map(clean); x.week = (c.week || []).map(w => ({ day: clean(w.day), tryIt: clean(w.tryIt) })); x.say = ''; break;
        default: break;
      }
      cards.push(x);
    }
    const text = cards.filter(c => c.say).map(c => c.say.replace(/\s+/g, ' ').trim()).join('\n\n');
    return { id: 'lesson-hi-' + en.base, lang: 'hi', base: en.base, title: en.title, author: en.author, hero: { name: clean(hi.hero.name), who: clean(hi.hero.who) }, cards, text };
  }
  const api = { compose, lesson, lessonHi, paras, NUM };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BookFull = api;
})(typeof window !== 'undefined' ? window : globalThis);
