// Brodoit Books v33: every book is a book, read in Bro's voice, in 7 chapters (app/bookfull.js composes them from Bro's
// notes, BOOK_SUMMARIES in the SPA, and the chapter stories of app/ideas/<id>.json, written for Brodoit with one
// invented Indian main character per book). Chapter 1 is why the book matters, chapters 2 to 6 its five ideas (Bro's
// explanation, then the idea lived in a story, the takeaway and a "Try this today"), chapter 7 how it turned out and
// Bro's take. Never the book's own stories or words.
// The whole book is recorded in Bro's studio voice ("book-<id>", .github/workflows/book-voice.yml); until a book's
// recording is on the server, Listen plays Bro's notes on it (recorded already, the same 7 parts), never a live voice.
// The public-domain books also have the original, chapter by chapter (app/briefs/<id>.json), played as "brief-<id>".
//   window.BookIdeas: has(id), full(id), mins(id), play(id, chapter?), chaptersHtml(book), readHtml(book),
//   briefHtml(book), playBrief(id), isPD(id)
(function () {
  'use strict';
  const BI = window.BookIdeas = { index: null, books: {}, briefs: {}, ready: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hiUI = () => { try { return S.lang === 'hi'; } catch (e) { return false; } };
  const T = (en, hi) => hiUI() ? hi : en;
  const PD = ['medi', 'discourses', 'lettersstoic', 'tao', 'babylon']; // public domain in India and the US
  const book = id => { try { return BOOK_SUMMARIES.find(b => b.id === id) || null; } catch (e) { return null; } };
  const rerender = () => { try { if (S.tab === 'books' || (S.bookReader && S.bookReader.open)) render(); } catch (e) {} };
  const PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12.2-7.4a1 1 0 0 0 0-1.72L8.5 3.74A1 1 0 0 0 7 4.6z"/></svg>';

  BI.has = id => !!(BI.index && BI.index.indexOf(id) >= 0);
  BI.isPD = id => PD.indexOf(id) >= 0;
  const inflight = {}; // one fetch per file, however many renders ask for it
  function once(key, url, store) {
    if (store[key]) return Promise.resolve(store[key]);
    if (!inflight[url]) inflight[url] = fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { store[key] = j; return j; }).finally(() => { delete inflight[url]; });
    return inflight[url];
  }
  const getBook = id => once(id, '/app/ideas/' + encodeURIComponent(id) + '.json', BI.books);
  const getBrief = id => once(id, '/app/briefs/' + encodeURIComponent(id) + '.json', BI.briefs);
  fetch('/app/ideas/index.json').then(r => r.json()).then(j => { BI.index = j.ids || []; rerender(); }).catch(() => { BI.index = []; });
  // which books the server has in Bro's studio voice ({ "book-atomic": seconds, ... }), again every 10 minutes
  function loadReady() { return fetch('/api/book-voice/ready').then(r => r.json()).then(j => { const was = JSON.stringify(BI.ready); BI.ready = j.items || {}; if (was !== JSON.stringify(BI.ready)) rerender(); }).catch(() => { BI.ready = BI.ready || {}; }); }
  loadReady(); setInterval(loadReady, 10 * 60e3);
  const isReady = id => !!(BI.ready && BI.ready['book-' + id]);

  // the book in 7 chapters (null until its chapters have loaded; asking starts the load)
  const fulls = {};
  BI.full = function (id) {
    if (fulls[id]) return fulls[id];
    const b = book(id); if (!b || !BI.has(id) || !window.BookFull) return null;
    const j = BI.books[id];
    if (!j) { getBook(id).then(rerender).catch(() => {}); return null; }
    return (fulls[id] = BookFull.compose(b, j));
  };
  // minutes of listening: the whole book once it is in Bro's voice, his notes until then (what Listen plays)
  BI.mins = function (id) {
    const b = book(id); if (isReady(id)) return Math.max(1, Math.round(BI.ready['book-' + id] / 60));
    return b ? b.mins : 0;
  };
  BI.play = function (id, ch) {
    const b = book(id); if (!b) return;
    const go = (pid, ob) => { try { bkpPlay(pid, ob); if (ch != null && BKP && BKP.book.id === pid) bkpJump(ch); } catch (e) { /* the player is part of the shell */ } };
    const f = isReady(id) && BI.full(id);
    if (f) return go(f.id, Object.assign({}, b, { id: f.id, summary: f.text, mins: BI.mins(id), _full: id }));
    if (isReady(id) && !BI.books[id]) { getBook(id).then(() => BI.play(id, ch)).catch(() => go(id)); return; }
    go(id); // Bro's notes: the same 7 parts, so "from chapter 3" starts at his third part
  };

  // chapter titles: from the composed book, or from Bro's notes while its chapters load
  function titles(b) {
    const f = BI.full(b.id);
    const t = f ? f.chapters.map(c => c.title) : ['Why this book'].concat((b.insights || []).slice(0, 5).map(it => it[0]), ['How it turned out']);
    if (hiUI()) { t[0] = 'यह किताब क्यों'; t[6] = 'आख़िर में क्या हुआ'; }
    return t;
  }
  function liveChapter(id) {
    try { if (!BKP || (BKP.book.id !== id && BKP.book._full !== id)) return -1; return _bkSecAt(_bkPos().ch); } catch (e) { return -1; }
  }

  // ── the book page: the 7 chapters (tap one to listen from there) ──
  BI.chaptersHtml = function (b) {
    if (!b || !BI.has(b.id)) return '';
    const t = titles(b), f = BI.full(b.id), live = liveChapter(b.id);
    let h = '<section class="bkp-sec bi-ch" id="bi-ch"><div class="bkp-eyebrow">' + T('The book in 7 chapters', 'किताब, 7 अध्यायों में') + '</div><h2>' + T('Chapters', 'अध्याय') + '</h2>';
    h += '<p class="bkp-sub">' + (f ? T('Read by Bro. Follow ' + esc(f.hero.name) + ', ' + esc(f.hero.who) + '. Tap a chapter to listen from there.', 'Bro की आवाज़ में। ' + esc(f.hero.name) + ' की कहानी के साथ चलें। किसी अध्याय पर टैप करें, वहीं से सुनें।') : T('Read by Bro. Tap a chapter to listen from there.', 'Bro की आवाज़ में। किसी अध्याय पर टैप करें, वहीं से सुनें।')) + '</p>';
    if (BI.ready && !isReady(b.id)) h += '<p class="bi-rec">' + T('Bro is recording this book in his voice. Until it is ready, Listen plays his notes on it (' + b.mins + ' min).', 'Bro यह किताब अपनी आवाज़ में रिकॉर्ड कर रहा है। तब तक सुनें दबाने पर उसके नोट्स चलेंगे (' + b.mins + ' मिनट)।') + '</p>';
    h += '<div class="bi-chs">';
    t.forEach((x, i) => {
      h += '<button class="bi-row' + (i === live ? ' on' : '') + '" onclick="BookIdeas.play(\'' + b.id + '\',' + i + ')"><span class="bi-n">' + (i + 1) + '</span><span class="bi-t">' + esc(x) + '</span><span class="bi-go" aria-hidden="true">' + PLAY + '</span></button>';
    });
    return h + '</div></section>';
  };

  // ── read along: the text Bro reads, chapter by chapter ──
  BI.readHtml = function (b) {
    if (!b || !BI.has(b.id)) return '';
    const f = BI.full(b.id);
    let h = '<section class="bkp-sec bi-read" id="bi-read"><div class="bkp-eyebrow">' + T('Read along', 'साथ में पढ़ें') + '</div><h2>' + T('The book', 'किताब') + '</h2>';
    if (!f) return h + '<p class="bkp-sub">' + T('Loading the chapters…', 'अध्याय लोड हो रहे हैं…') + '</p></section>';
    const t = titles(b), base = b.id;
    f.chapters.forEach((c, i) => {
      h += '<article class="bi-rd" id="bic-' + i + '"><div class="bkp-part-h"><span>' + String(i + 1).padStart(2, '0') + '</span><h4>' + esc(t[i]) + '</h4><button onclick="BookIdeas.play(\'' + base + '\',' + i + ')" aria-label="' + T('Listen from here', 'यहाँ से सुनें') + '">' + PLAY + '</button></div>';
      if (c.idea) h += '<p>' + esc(c.idea) + '</p>';
      if (c.meet) h += '<p class="bi-meet">' + esc(c.meet) + '</p>';
      if (c.h) h += '<h5>' + esc(c.h) + '</h5>';
      if (c.story) h += '<p class="bi-story">' + esc(c.story) + '</p>';
      if (c.take) h += '<p class="bi-take">' + esc(c.take) + '</p>';
      if (c.tryIt) {
        const k = i - 1, tried = (() => { try { return !!(S.bkTried && S.bkTried[base + ':' + k]); } catch (e) { return false; } })();
        h += '<div class="bkp-try"><b>' + T('Try it today', 'आज आज़माएँ') + '</b><span>' + esc(c.tryIt) + '</span>' + (tried ? '<button class="on" disabled>' + T('Added to today', 'आज में जुड़ गया') + '</button>' : '<button onclick="bkTry(\'' + base + '\',' + k + ',this)">' + T('Add to my tasks', 'मेरे कामों में जोड़ें') + '</button>') + '</div>';
      }
      if (c.bro) h += '<p class="bi-bro"><b>' + T("Bro's take", 'Bro की राय') + '</b> ' + esc(c.bro) + '</p>';
      h += '</article>';
    });
    return h + '</section>';
  };

  // ── the public-domain books: the original, chapter by chapter, read whole ──
  BI.briefHtml = function (b) {
    if (!b || !BI.isPD(b.id)) return '';
    const br = BI.briefs[b.id];
    if (!br) { getBrief(b.id).then(rerender).catch(() => {}); return ''; }
    const paras = br.text.split(/\n\s*\n/); paras[0] = paras[0].replace(/^[^\n]*?The whole book, chapter by chapter\.\s*/, '');
    const mins = Math.max(1, Math.round(br.text.length / 15 / 60));
    let h = '<section class="bkp-sec bi-brief" id="bi-brief"><div class="bkp-eyebrow">' + T('Public domain · the original', 'पब्लिक डोमेन · मूल किताब') + '</div><h2>' + T('The original, chapter by chapter', 'मूल किताब, अध्याय दर अध्याय') + '</h2>';
    h += '<p class="bkp-sub">' + T('This book is old enough to belong to everyone, so here is the original from start to end: ' + mins + ' minutes, read in Bro\'s voice.', 'यह किताब इतनी पुरानी है कि सबकी है, इसलिए यहाँ मूल किताब शुरू से अंत तक: ' + mins + ' मिनट, Bro की आवाज़ में।') + '</p>';
    h += '<button class="bi-start" onclick="BookIdeas.playBrief(\'' + b.id + '\')">' + T('Listen to the original', 'मूल किताब सुनें') + ' · ' + mins + ' ' + T('min', 'मिनट') + '</button><div class="bi-brief-txt">';
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
})();
