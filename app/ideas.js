// Brodoit Books v32: every book as a story in 7 chapters, plus Ideas (a swipeable feed of them).
// Each book's chapters come from Bro's notes (BOOK_SUMMARIES in the SPA: the hook, the 5 ideas, Bro's take) and
// app/ideas/<id>.json (written for Brodoit: one invented Indian main character carried through all 7 chapters).
// Chapter 1 shows the problem, chapters 2-6 the book's five ideas in order, chapter 7 how it turned out. Every chapter
// is four cards: the idea, the situation (a short story), "What would you do?" (three choices, then why one is
// right) and the takeaway (with the note's "Try it today", one tap to add it as a task). Never the book's own
// stories or words. The public-domain books also have the whole book chapter by chapter (app/briefs/<id>.json),
// played through the book player as "brief-<id>".
//   window.BookIdeas: feedHtml() / after() (the Ideas tab, mounted by the shell), chaptersHtml(book) and
//   briefHtml(book) (sections of the book page), open(id, chapter) (the chapter player: a full-screen overlay outside
//   the shell, so its re-renders never touch it), has(id), playBrief(id).
// On this phone: progress (ideas.prog.v1: chapters done per book, the chapter to resume), seen feed cards
// (ideas.seen.v1) and saved cards (ideas.saved.v1).
(function () {
  'use strict';
  const BI = window.BookIdeas = { index: null, books: {}, briefs: {}, _feed: null, _deck: [], _seenOnce: false };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hiUI = () => { try { return S.lang === 'hi'; } catch (e) { return false; } };
  const T = (en, hi) => hiUI() ? hi : en;
  const PD = ['medi', 'discourses', 'lettersstoic', 'tao', 'babylon']; // public domain in India and the US
  const book = id => { try { return BOOK_SUMMARIES.find(b => b.id === id) || null; } catch (e) { return null; } };
  const cover = id => { try { return typeof bookCover === 'function' ? bookCover(id) : ''; } catch (e) { return ''; } };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const prog = () => load('ideas.prog.v1', {});
  const saved = () => load('ideas.saved.v1', []);
  const NUM = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];

  // the 7 chapter titles and idea texts, from Bro's notes
  function chapterMeta(b) {
    const out = [{ t: T('Why this book', 'यह किताब क्यों'), idea: b.why }];
    (b.insights || []).slice(0, 5).forEach(it => out.push({ t: it[0], idea: it[1], tryIt: it[2] || '' }));
    out.push({ t: T("Bro's take", 'Bro की राय'), idea: b.take });
    return out;
  }
  BI.has = id => !!(BI.index && BI.index.indexOf(id) >= 0);
  BI.isPD = id => PD.indexOf(id) >= 0;
  async function getIndex() {
    if (BI.index) return BI.index;
    try { const r = await fetch('/app/ideas/index.json'); BI.index = (await r.json()).ids || []; } catch (e) { BI.index = []; }
    return BI.index;
  }
  const inflight = {}; // one fetch per file, however many renders ask for it
  function once(key, url, store) {
    if (store[key]) return Promise.resolve(store[key]);
    if (!inflight[url]) inflight[url] = fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { store[key] = j; return j; }).finally(() => { delete inflight[url]; });
    return inflight[url];
  }
  const getBook = id => once(id, '/app/ideas/' + encodeURIComponent(id) + '.json', BI.books);
  const getBrief = id => once(id, '/app/briefs/' + encodeURIComponent(id) + '.json', BI.briefs);
  getIndex().then(() => { try { if (S.tab === 'books') render(); } catch (e) {} });

  // ── the book page: chapters (and, for public-domain books, the whole book) ──
  BI.chaptersHtml = function (b) {
    if (!b || !BI.has(b.id)) return '';
    const p = prog()[b.id] || {}; const done = p.done || []; const meta = chapterMeta(b);
    const j = BI.books[b.id]; if (!j) getBook(b.id).then(() => { try { render(); } catch (e) {} }).catch(() => {});
    const next = meta.findIndex((_, i) => done.indexOf(i) < 0); const all = next < 0;
    let h = '<section class="bkp-sec bi-ch" id="bi-ch"><div class="bkp-eyebrow">' + T('Read it as a story', 'कहानी की तरह पढ़ें') + '</div><h2>' + T('7 chapters', '7 अध्याय') + '</h2>';
    h += '<p class="bkp-sub">' + (j ? T('Follow ' + esc(j.hero.name) + ', ' + esc(j.hero.who) + '. Each chapter: the idea, a real-life situation, what you would do, and the takeaway.', esc(j.hero.name) + ' की कहानी के साथ चलें। हर अध्याय में: विचार, एक असली स्थिति, आप क्या करते, और सीख।') : T('The idea, a real-life situation, what you would do, and the takeaway.', 'विचार, एक असली स्थिति, आप क्या करते, और सीख।')) + '</p>';
    h += '<div class="bi-chs">';
    meta.forEach((m, i) => {
      const d = done.indexOf(i) >= 0;
      h += '<button class="bi-row' + (d ? ' done' : '') + '" onclick="BookIdeas.open(\'' + b.id + '\',' + i + ')"><span class="bi-n">' + (d ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : (i + 1)) + '</span><span class="bi-t">' + esc(m.t) + '</span><span class="bi-go" aria-hidden="true">›</span></button>';
    });
    h += '</div><button class="bi-start" onclick="BookIdeas.open(\'' + b.id + '\',' + (all ? 0 : next) + ')">' + (all ? T('Read again', 'फिर से पढ़ें') : done.length ? T('Continue: chapter ' + (next + 1), 'आगे पढ़ें: अध्याय ' + (next + 1)) : T('Start chapter 1', 'अध्याय 1 शुरू करें')) + '</button>';
    if (done.length) h += '<div class="bi-prog"><i style="width:' + Math.round(done.length / 7 * 100) + '%"></i></div><div class="bi-prog-t">' + done.length + ' / 7 ' + T('chapters read', 'अध्याय पढ़े') + '</div>';
    return h + '</section>';
  };
  BI.briefHtml = function (b) {
    if (!b || !BI.isPD(b.id)) return '';
    const br = BI.briefs[b.id];
    if (!br) { getBrief(b.id).then(() => { try { render(); } catch (e) {} }).catch(() => {}); return ''; }
    const paras = br.text.split(/\n\s*\n/); paras[0] = paras[0].replace(/^[^\n]*?The whole book, chapter by chapter\.\s*/, '');
    const mins = Math.max(1, Math.round(br.text.length / 15 / 60));
    let h = '<section class="bkp-sec bi-brief" id="bi-brief"><div class="bkp-eyebrow">' + T('Public domain · the whole book', 'पब्लिक डोमेन · पूरी किताब') + '</div><h2>' + T('Chapter by chapter', 'अध्याय दर अध्याय') + '</h2>';
    h += '<p class="bkp-sub">' + T('This book is old enough to belong to everyone, so here it is from start to end: ' + mins + ' minutes, read in Bro\'s voice.', 'यह किताब इतनी पुरानी है कि सबकी है, इसलिए यहाँ शुरू से अंत तक: ' + mins + ' मिनट, Bro की आवाज़ में।') + '</p>';
    h += '<button class="bi-start" onclick="BookIdeas.playBrief(\'' + b.id + '\')">' + T('Listen to the whole book', 'पूरी किताब सुनें') + ' · ' + mins + ' ' + T('min', 'मिनट') + '</button><div class="bi-brief-txt">';
    paras.forEach(p => { const m = /^((?:Book|Chapter) [a-z]+\.\s*[^.]{3,80}\.|The bottom line[.:])\s*/i.exec(p); h += m ? '<p><b>' + esc(m[1].replace(/[.:]$/, '')) + '.</b> ' + esc(p.slice(m[0].length)) + '</p>' : '<p>' + esc(p) + '</p>'; });
    h += '</div><p class="bi-pd">' + esc(br.title) + ' · ' + esc(br.author) + ' · ' + esc(br.pd) + '</p></section>';
    return h;
  };
  BI.playBrief = async function (id) {
    const b = book(id); if (!b) return;
    let br; try { br = await getBrief(id); } catch (e) { return; }
    const mins = Math.max(1, Math.round(br.text.length / 15 / 60));
    const ob = Object.assign({}, b, { id: 'brief-' + id, summary: br.text, mins, _brief: id });
    try { bkpPlay(ob.id, ob); } catch (e) { /* the player is part of the shell */ }
  };

  // ── the chapter player (full-screen, outside the shell) ──
  let P = null; // { id, ch, card, picked, el }
  const cardsOf = (b, j, ch) => {
    const m = chapterMeta(b)[ch], c = (j.chapters || [])[ch] || {};
    const out = [{ k: 'idea', m }, { k: 'story', c }];
    if (c.ask) out.push({ k: 'ask', c });
    out.push({ k: 'take', m, c });
    return out;
  };
  BI.open = async function (id, ch) {
    const b = book(id); if (!b) return;
    let j; try { j = await getBook(id); } catch (e) { try { toast(T('Chapters are not ready yet', 'अध्याय अभी तैयार नहीं')); } catch (x) {} return; }
    P = { id, b, j, ch: Math.max(0, Math.min(6, ch | 0)), card: 0, picked: null };
    const p = prog(); p[id] = p[id] || { done: [] }; p[id].at = P.ch; keep('ideas.prog.v1', p);
    let el = document.getElementById('bi-player');
    if (!el) { el = document.createElement('div'); el.id = 'bi-player'; el.className = 'bi-player'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); document.body.appendChild(el); }
    P.el = el; document.body.classList.add('bi-open');
    paint(); bindKeys(true);
  };
  BI.close = function () {
    stopVoice();
    const el = document.getElementById('bi-player'); if (el) el.remove();
    document.body.classList.remove('bi-open'); bindKeys(false); P = null;
    try { render(); } catch (e) {}
  };
  function markDone() {
    const p = prog(); const r = p[P.id] = p[P.id] || { done: [] };
    if (r.done.indexOf(P.ch) < 0) r.done.push(P.ch);
    r.at = P.ch < 6 ? P.ch + 1 : 0; keep('ideas.prog.v1', p);
  }
  BI.next = function () {
    if (!P) return; stopVoice();
    const cards = cardsOf(P.b, P.j, P.ch);
    if (P.card < cards.length) { P.card++; P.picked = null; if (P.card === cards.length) markDone(); paint(); }
  };
  BI.prev = function () { if (!P) return; stopVoice(); if (P.card > 0) { P.card--; P.picked = null; paint(); } };
  BI.go = function (ch) { if (!P) return; stopVoice(); P.ch = ch; P.card = 0; P.picked = null; const p = prog(); (p[P.id] = p[P.id] || { done: [] }).at = ch; keep('ideas.prog.v1', p); paint(); };
  BI.pick = function (i) { if (!P || P.picked != null) return; P.picked = i; paint(); };
  BI.save = function () {
    if (!P) return; const cards = cardsOf(P.b, P.j, P.ch); const c = cards[P.card]; if (!c) return;
    const s = saved(); const key = P.id + ':' + P.ch + ':' + c.k; const at = s.findIndex(x => x.key === key);
    if (at >= 0) s.splice(at, 1); else s.unshift({ key, id: P.id, ch: P.ch, k: c.k, at: Date.now() });
    keep('ideas.saved.v1', s.slice(0, 300)); paint();
  };
  // read the card aloud in Bro's voice (BroSay), when the phone has it
  let speaking = false;
  function stopVoice() { if (speaking) { speaking = false; try { if (window.BroSay && BroSay.stop) BroSay.stop(); else speechSynthesis.cancel(); } catch (e) {} } }
  BI.listen = function () {
    if (!P) return; if (speaking) { stopVoice(); paint(); return; }
    const c = cardsOf(P.b, P.j, P.ch)[P.card]; if (!c) return;
    const text = c.k === 'idea' ? c.m.t + '. ' + c.m.idea : c.k === 'story' ? c.c.story.h + '. ' + c.c.story.b : c.k === 'ask' ? c.c.ask.q + ' ' + c.c.ask.o.map((o, i) => (i + 1) + '. ' + o).join(' ') : c.c.take + (c.m.tryIt ? ' ' + T('Try it today: ', 'आज आज़माएँ: ') + c.m.tryIt : '');
    speaking = true; paint();
    const done = () => { speaking = false; if (P) paint(); };
    try { if (window.BroSay && BroSay.one) BroSay.one(text, { rate: 1, onend: done }); else { const u = new SpeechSynthesisUtterance(text); u.onend = done; speechSynthesis.speak(u); } } catch (e) { done(); }
  };
  const IC = {
    x: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    save: on => '<svg width="20" height="20" viewBox="0 0 24 24" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    ear: on => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/>' + (on ? '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>' : '<path d="M15.5 8.5a5 5 0 0 1 0 7"/>') + '</svg>',
  };
  function paint() {
    if (!P || !P.el) return;
    const { b, j } = P; const cards = cardsOf(b, j, P.ch); const meta = chapterMeta(b)[P.ch];
    const end = P.card >= cards.length; const c = cards[P.card];
    const isSaved = c && saved().some(x => x.key === P.id + ':' + P.ch + ':' + c.k);
    let h = '<div class="bi-top"><button class="bi-ib" onclick="BookIdeas.close()" aria-label="' + T('Close', 'बंद करें') + '">' + IC.x + '</button>';
    h += '<div class="bi-where"><b>' + esc(b.title) + '</b><small>' + T('Chapter ' + (P.ch + 1) + ' of 7', 'अध्याय ' + (P.ch + 1) + ' / 7') + ' · ' + esc(meta.t) + '</small></div>';
    h += c ? '<button class="bi-ib' + (speaking ? ' on' : '') + '" onclick="BookIdeas.listen()" aria-label="' + T('Listen', 'सुनें') + '">' + IC.ear(speaking) + '</button><button class="bi-ib' + (isSaved ? ' on' : '') + '" onclick="BookIdeas.save()" aria-label="' + T('Save', 'सेव करें') + '"' + (c.k === 'ask' ? ' disabled' : '') + '>' + IC.save(isSaved) + '</button>' : '<span class="bi-ib" aria-hidden="true"></span><span class="bi-ib" aria-hidden="true"></span>';
    h += '</div><div class="bi-segs">' + cards.map((_, i) => '<i class="' + (i < P.card || end ? 'on' : i === P.card ? 'cur' : '') + '"></i>').join('') + '</div>';
    h += '<div class="bi-card" style="--bi-grad:' + esc(b.grad || '') + '">';
    if (end) {
      const last = P.ch >= 6;
      h += '<div class="bi-done"><div class="bi-tick"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></div>';
      h += '<h2>' + (last ? T('Book finished', 'किताब पूरी हुई') : T('Chapter ' + (P.ch + 1) + ' done', 'अध्याय ' + (P.ch + 1) + ' पूरा')) + '</h2>';
      h += '<p>' + (last ? T('You followed ' + esc(j.hero.name) + ' through all 7 chapters. If an idea clicked, read the whole book.', 'आपने ' + esc(j.hero.name) + ' के साथ सातों अध्याय पढ़े। कोई बात जँची हो तो पूरी किताब पढ़ें।') : T('Next: ', 'अगला: ') + esc(chapterMeta(b)[P.ch + 1].t)) + '</p>';
      h += last ? '<button class="bi-primary" onclick="BookIdeas.close()">' + T('Back to the book', 'किताब पर लौटें') + '</button>' : '<button class="bi-primary" onclick="BookIdeas.go(' + (P.ch + 1) + ')">' + T('Next chapter', 'अगला अध्याय') + '</button><button class="bi-ghost" onclick="BookIdeas.close()">' + T('Later', 'बाद में') + '</button>';
      h += '</div>';
    } else if (c.k === 'idea') {
      h += '<div class="bi-eb">' + (P.ch === 0 ? T('The problem', 'समस्या') : P.ch === 6 ? T('Looking back', 'पीछे मुड़कर') : T('Idea ' + NUM[P.ch - 1], 'विचार ' + P.ch)) + '</div><h2 class="bi-h">' + esc(c.m.t) + '</h2><p class="bi-p">' + esc(c.m.idea) + '</p>';
      if (P.ch === 0) h += '<div class="bi-hero"><b>' + esc(j.hero.name) + '</b><span>' + esc(j.hero.who) + '</span></div>';
    } else if (c.k === 'story') {
      h += '<div class="bi-eb">' + T('The situation', 'स्थिति') + '</div><h2 class="bi-h">' + esc(c.c.story.h) + '</h2><p class="bi-p bi-story">' + esc(c.c.story.b) + '</p>';
    } else if (c.k === 'ask') {
      const a = c.c.ask; const ok = P.picked != null;
      h += '<div class="bi-eb">' + T('What would you do?', 'आप क्या करते?') + '</div><h2 class="bi-h bi-q">' + esc(a.q) + '</h2><div class="bi-opts">';
      a.o.forEach((o, i) => { const cls = !ok ? '' : i === a.a ? ' right' : i === P.picked ? ' wrong' : ' dim'; h += '<button class="bi-opt' + cls + '" onclick="BookIdeas.pick(' + i + ')"' + (ok ? ' disabled' : '') + '><span>' + 'ABC'[i] + '</span>' + esc(o) + '</button>'; });
      h += '</div>';
      if (ok) h += '<div class="bi-why ' + (P.picked === a.a ? 'yes' : 'no') + '"><b>' + (P.picked === a.a ? T('Right.', 'सही।') : T('Not quite.', 'पूरी तरह नहीं।')) + '</b> ' + esc(a.why) + '</div>';
    } else if (c.k === 'take') {
      h += '<div class="bi-eb">' + T('The takeaway', 'सीख') + '</div><p class="bi-take">' + esc(c.c.take) + '</p>';
      if (c.m.tryIt) {
        const tk = (P.id + ':' + (P.ch - 1)); let tried = false; try { tried = !!(S.bkTried && S.bkTried[tk]); } catch (e) {}
        h += '<div class="bi-try"><b>' + T('Try it today', 'आज आज़माएँ') + '</b><span>' + esc(c.m.tryIt) + '</span>' + (tried ? '<button disabled class="on">' + T('Added to today', 'आज में जुड़ गया') + '</button>' : '<button onclick="BookIdeas.tryIt(this)">' + T('Add to my tasks', 'मेरे कामों में जोड़ें') + '</button>') + '</div>';
      }
    }
    h += '</div>';
    if (!end) {
      const blocked = c.k === 'ask' && P.picked == null;
      h += '<div class="bi-nav"><button class="bi-ghost" onclick="BookIdeas.prev()"' + (P.card === 0 ? ' disabled' : '') + '>' + T('Back', 'पीछे') + '</button><button class="bi-primary" onclick="BookIdeas.next()">' + (blocked ? T('Skip', 'छोड़ें') : P.card === cards.length - 1 ? T('Finish chapter', 'अध्याय पूरा करें') : T('Next', 'आगे')) + '</button></div>';
    }
    P.el.innerHTML = h;
    const card = P.el.querySelector('.bi-card'); if (card) card.scrollTop = 0;
  }
  BI.tryIt = function (btn) { if (!P) return; try { bkTry(P.id, P.ch - 1, btn); } catch (e) {} setTimeout(paint, 900); };
  // swipe left/right on the card, arrows on a keyboard
  let sx = 0, sy = 0;
  document.addEventListener('touchstart', e => { if (!P || !e.target.closest || !e.target.closest('#bi-player .bi-card')) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!P || !sx || !e.target.closest || !e.target.closest('#bi-player .bi-card')) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = 0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { const c = cardsOf(P.b, P.j, P.ch)[P.card]; if (dx < 0) { if (!(c && c.k === 'ask' && P.picked == null)) BI.next(); } else BI.prev(); }
  }, { passive: true });
  const onKey = e => { if (!P) return; if (e.key === 'Escape') BI.close(); else if (e.key === 'ArrowRight') BI.next(); else if (e.key === 'ArrowLeft') BI.prev(); };
  function bindKeys(on) { document.removeEventListener('keydown', onKey); if (on) document.addEventListener('keydown', onKey); }

  // ── Ideas: the feed (one chapter per screen, swipe up) ──
  // Each short is one idea chapter (2-6) of a book: the idea, the situation, the takeaway; tap to read the chapter.
  // A day's order is fixed (shuffled by the date), never two from the same book in a row, unseen ones first.
  BI.mode = load('ideas.mode.v1', 'feed'); // 'feed' | 'saved'
  BI.setMode = function (m) { BI.mode = m; keep('ideas.mode.v1', m); BI._feed = null; try { render(); } catch (e) {} };
  BI.feedHtml = function () {
    // the deck alone (the Saved toggle sits beside the sections, savedBtn())
    return (BI.mode === 'saved' ? '<div class="bi-svhead">' + T('Saved ideas', 'सेव किए विचार') + '</div>' : '') + '<div id="bi-feed-slot" class="bi-feed-slot"></div>';
  };
  BI.savedBtn = function () {
    const on = BI.mode === 'saved', n = saved().length;
    return '<button class="bi-svbtn' + (on ? ' on' : '') + '" onclick="BookIdeas.setMode(\'' + (on ? 'feed' : 'saved') + '\')" aria-label="' + (on ? T('Back to ideas', 'विचारों पर लौटें') : T('Saved ideas', 'सेव किए विचार')) + '" aria-pressed="' + on + '">' + IC.save(on) + (n ? '<i>' + n + '</i>' : '') + '</button>';
  };
  function seed() { const d = new Date(); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); }
  function shuffle(a, s) { a = a.slice(); let x = s || 1; for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) & 0x7fffffff; const k = x % (i + 1); [a[i], a[k]] = [a[k], a[i]]; } return a; }
  function plan(ids) {
    const seen = load('ideas.seen.v1', {}); const pairs = [];
    for (const id of shuffle(ids, seed())) for (let ch = 1; ch <= 5; ch++) pairs.push({ id, ch });
    // spread: round-robin over books in today's order, unseen first
    const byBook = {}; for (const p of pairs) (byBook[p.id] = byBook[p.id] || []).push(p);
    for (const id in byBook) byBook[id] = shuffle(byBook[id], seed() + id.length);
    const order = []; let left = true;
    while (left) { left = false; for (const id of Object.keys(byBook)) { const p = byBook[id].shift(); if (p) { order.push(p); left = true; } } }
    return order.filter(p => !seen[p.id + ':' + p.ch]).concat(order.filter(p => seen[p.id + ':' + p.ch]));
  }
  function shortHtml(p) {
    const b = book(p.id), j = BI.books[p.id]; if (!b || !j) return '';
    const m = chapterMeta(b)[p.ch], c = j.chapters[p.ch]; const cv = cover(p.id);
    const isSaved = saved().some(x => x.key === p.id + ':' + p.ch + ':story');
    let h = '<article class="bi-short" data-k="' + p.id + ':' + p.ch + '"><div class="bi-sin" onclick="BookIdeas.open(\'' + p.id + '\',' + p.ch + ')">';
    h += '<div class="bi-sbook"><span class="bi-scv" style="background:' + esc(b.grad || '') + '">' + (cv ? '<img src="' + cv + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span><span><b>' + esc(b.title) + '</b><small>' + esc(b.author) + ' · ' + T('Idea ' + p.ch, 'विचार ' + p.ch) + '</small></span></div>';
    // situation first: the idea's name, the story, the lesson (the idea in full is one tap away, in the chapter)
    h += '<div class="bi-eb">' + esc(m.t) + '</div><h2 class="bi-sh">' + esc(c.story.h) + '</h2><p class="bi-sstory">' + esc(c.story.b) + '</p>';
    h += '<p class="bi-stake">' + esc(c.take) + '</p><div class="bi-sopen">' + T('Read the chapter', 'अध्याय पढ़ें') + ' ›</div></div>';
    h += '<button class="bi-ssave' + (isSaved ? ' on' : '') + '" onclick="BookIdeas.saveShort(\'' + p.id + '\',' + p.ch + ',this)" aria-label="' + T('Save', 'सेव करें') + '">' + IC.save(isSaved) + '</button></article>';
    return h;
  }
  BI.saveShort = function (id, ch, btn) {
    const s = saved(); const key = id + ':' + ch + ':story'; const at = s.findIndex(x => x.key === key);
    if (at >= 0) s.splice(at, 1); else s.unshift({ key, id, ch, k: 'story', at: Date.now() });
    keep('ideas.saved.v1', s.slice(0, 300));
    if (btn) { const on = at < 0; btn.classList.toggle('on', on); btn.innerHTML = IC.save(on); }
  };
  function size(deck) {
    const bar = document.querySelector('.tabs.page-t') || document.querySelector('.rd-tabbar'); const r = bar && bar.getBoundingClientRect();
    const bottom = r && r.top > innerHeight * 0.6 ? r.top : innerHeight - 8;
    deck.style.height = Math.max(320, Math.floor(bottom - deck.getBoundingClientRect().top - 6)) + 'px';
  }
  function fit(el) {
    const inn = el && el.querySelector && el.querySelector('.bi-sin'); if (!inn) return;
    for (const c of ['sm', 'xs', 'xxs']) { if (inn.scrollHeight <= inn.clientHeight + 1) return; inn.classList.add(c); }
  }
  async function fill(deck, n) {
    const st = deck._st; let added = 0;
    while (added < n && st.i < st.order.length) {
      const p = st.order[st.i++];
      if (!BI.books[p.id]) { try { await getBook(p.id); } catch (e) { continue; } }
      deck.insertAdjacentHTML('beforeend', shortHtml(p)); added++; fit(deck.lastElementChild);
    }
    if (st.i >= st.order.length && !deck.querySelector('.bi-end')) deck.insertAdjacentHTML('beforeend', '<div class="bi-end">' + (st.order.length ? T('That is every idea for today. New order tomorrow.', 'आज के लिए सारे विचार हो गए। कल नया क्रम।') : BI.mode === 'saved' ? T('Nothing saved yet. Tap the bookmark on an idea to keep it here.', 'अभी कुछ सेव नहीं। किसी विचार पर बुकमार्क दबाएँ।') : T('Ideas are on their way.', 'विचार आ रहे हैं।')) + '</div>');
    observe(deck);
  }
  function observe(deck) {
    if (deck._io) deck._io.disconnect();
    const io = deck._io = new IntersectionObserver(es => {
      for (const e of es) {
        if (!e.isIntersecting) continue; const k = e.target.dataset.k; if (!k) continue;
        const s = load('ideas.seen.v1', {}); if (!s[k]) { s[k] = Date.now(); keep('ideas.seen.v1', s); }
        const all = deck.querySelectorAll('.bi-short'); if (e.target === all[all.length - 2] || e.target === all[all.length - 1]) fill(deck, 4);
      }
    }, { root: deck, threshold: 0.6 });
    deck.querySelectorAll('.bi-short').forEach(el => io.observe(el));
  }
  BI.after = async function () {
    const slot = document.getElementById('bi-feed-slot'); if (!slot) return;
    if (BI._feed && BI._feed._mode === BI.mode) { if (!slot.contains(BI._feed)) { const top = BI._feed._top || 0; slot.appendChild(BI._feed); size(BI._feed); BI._feed.scrollTop = top; } return; }
    const deck = document.createElement('div'); deck.className = 'bi-deck'; deck._mode = BI.mode;
    deck.addEventListener('scroll', () => { deck._top = deck.scrollTop; }, { passive: true });
    slot.innerHTML = ''; slot.appendChild(deck); BI._feed = deck; size(deck);
    const ids = await getIndex();
    const order = BI.mode === 'saved' ? saved().filter(x => x.ch >= 1 && x.ch <= 5).map(x => ({ id: x.id, ch: x.ch })).filter((p, i, a) => a.findIndex(q => q.id === p.id && q.ch === p.ch) === i) : plan(ids.filter(id => book(id)));
    deck._st = { order, i: 0 };
    await fill(deck, 5);
  };
  addEventListener('resize', () => { if (BI._feed && document.body.contains(BI._feed)) { size(BI._feed); BI._feed.querySelectorAll('.bi-sin').forEach(x => x.classList.remove('sm', 'xs', 'xxs')); BI._feed.querySelectorAll('.bi-short').forEach(fit); } });
})();
