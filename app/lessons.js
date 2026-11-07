// Brodoit Lessons v36 (owner, 7 Nov: "rename it to lessons … every lesson you click goes inside a different UI … give the
// image of that person and put some words under it while the background sound is going on … right swipe, a button to go
// right, a sharing button … keep the books UI as a dynamic motion video … it should be like an addiction"). Every book is
// a lesson of 19 cards (app/bookfull.js lesson(): the cover, meet the hero, five ideas each told as the idea, the story and
// "Pause and think", how it turned out, the end), played full screen like a short film: the card's picture of the story's
// own hero (app/lessons/img/<id>/<0-6>.svg, scripts/lessons/illustrate.js) drifts slowly, the words light up as the
// narrator reads them, and the card turns by itself when the voice moves on (the recording's cues,
// /api/book-voice/ready). Swipe right or tap Next to move on; Share on every card. Brodoit's own design: no other app's
// layout, art or words.
//   window.Lessons: has(id), open(id, card?, autoplay?), close(), listHtml(books), mins(id), next(), prev(), toggle(),
//   share(), pick(i), tryIt(k, btn)
(function () {
  'use strict';
  const L = window.Lessons = {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hiUI = () => { try { return S.lang === 'hi'; } catch (e) { return false; } };
  // v37: an open lesson speaks its own language (EN / हिं on the lesson); elsewhere the app's
  const T = (en, hi) => (P && P.lang ? P.lang === 'hi' : hiUI()) ? hi : en;
  const books = () => { try { return BOOK_SUMMARIES; } catch (e) { return []; } };
  const book = id => books().find(b => b.id === id) || null;
  const rerender = () => { try { if (S.tab === 'books') render(); } catch (e) { /* the shell */ } };
  const NUMW = ['one', 'two', 'three', 'four', 'five'];
  const PAL0 = ['#1F2A44', '#E9B44C', '#F6EFE3', '#3B4E78', '#141C2F'];
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  // ── what the lessons need: the pictures' index (hero, colours), each lesson's stories, which are recorded ──
  let IMG = null; const ideas = {}, inflight = {}, lessons = {}, his = {};
  let REC = { items: {}, cues: {} }, HI = { ids: [], heroes: {} };
  fetch('/app/lessons/img/index.json?v=36').then(r => r.json()).then(j => { IMG = j || {}; rerender(); }).catch(() => { IMG = {}; });
  // v37: the lessons written in Hindi (app/lessons-hi/index.json, scripts/lessons/hi.js)
  fetch('/app/lessons-hi/index.json?v=37').then(r => r.json()).then(j => { HI = { ids: j.ids || [], heroes: j.heroes || {}, loaded: true }; rerender(); }).catch(() => { HI.loaded = true; });
  L.hasHi = id => HI.ids.indexOf(id) >= 0;
  function getHi(id) {
    if (his[id]) return Promise.resolve(his[id]);
    if (!inflight['hi:' + id]) inflight['hi:' + id] = fetch('/app/lessons-hi/' + encodeURIComponent(id) + '.json?v=37').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => (his[id] = j)).finally(() => { delete inflight['hi:' + id]; });
    return inflight['hi:' + id];
  }
  function loadRec() { return fetch('/api/book-voice/ready').then(r => r.json()).then(j => { REC = { items: j.items || {}, cues: j.cues || {} }; rerender(); }).catch(() => {}); }
  loadRec(); setInterval(loadRec, 10 * 60e3);
  function getIdeas(id) {
    if (ideas[id]) return Promise.resolve(ideas[id]);
    if (!inflight[id]) inflight[id] = fetch('/app/ideas/' + encodeURIComponent(id) + '.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => (ideas[id] = j)).finally(() => { delete inflight[id]; });
    return inflight[id];
  }
  function lessonOf(id, lang) {
    const key = (lang === 'hi' ? 'hi:' : '') + id;
    if (lessons[key]) return lessons[key];
    const b = book(id), j = ideas[id]; if (!b || !j || !window.BookFull || !BookFull.lesson) return null;
    const en = lessons[id] || (lessons[id] = BookFull.lesson(b, j));
    if (lang !== 'hi') return en;
    return his[id] && BookFull.lessonHi ? (lessons[key] = BookFull.lessonHi(en, his[id])) : null;
  }
  L.has = id => !!(IMG && IMG[id] && book(id));
  const pal = id => (IMG && IMG[id] && IMG[id].pal) || PAL0;
  const heroName = id => (hiUI() && HI.heroes[id]) || (IMG && IMG[id] && IMG[id].hero) || '';
  const rec = (id, lang) => { const k = 'lesson-' + (lang === 'hi' ? 'hi-' : '') + id; return REC.items[k] && REC.cues[k] ? { secs: REC.items[k], cues: REC.cues[k] } : null; };
  L.mins = id => { const r = rec(id); return r ? Math.max(1, Math.round(r.secs / 60)) : 8; };
  const cover = id => { try { return bookCover(id); } catch (e) { return '/app/covers/' + id + '.webp?v=1'; } };
  const pic = (id, k) => '/app/lessons/img/' + encodeURIComponent(id) + '/' + k + '.svg?v=36';

  // ── where you are in each lesson (this device) ──
  const KEY = 'bd_lessons_v1';
  let prog = {}; try { prog = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { prog = {}; }
  const saveProg = () => { try { localStorage.setItem(KEY, JSON.stringify(prog)); } catch (e) { /* private window */ } };
  function mark(id, c, done) {
    const p = prog[id] || { c: 0, max: 0, done: false };
    p.c = c; p.max = Math.max(p.max || 0, c); if (done) p.done = true; p.at = Date.now(); prog[id] = p; saveProg();
  }

  // ── the Lessons tab ──
  L.listHtml = function (list) {
    let h = '';
    if (!IMG) return '<div class="lz-load">' + T('Loading lessons…', 'सबक लोड हो रहे हैं…') + '</div>';
    const avail = (list || books()).filter(b => L.has(b.id));
    // carry on where you stopped
    const going = Object.keys(prog).filter(id => L.has(id) && !prog[id].done && prog[id].max > 0).sort((a, b) => (prog[b].at || 0) - (prog[a].at || 0)).slice(0, 6);
    if (going.length && !(S.bkSearch || '').trim() && (!S.bkCat || S.bkCat === 'all')) {
      h += '<div class="lz-sec"><h3>' + T('Continue', 'जारी रखें') + '</h3></div><div class="lz-cont">';
      going.forEach(id => {
        const b = book(id), p = pal(id), n = (lessonOf(id) || { cards: { length: 19 } }).cards.length;
        h += '<button class="lz-cc" style="--bg:' + p[0] + ';--ac:' + p[1] + '" onclick="Lessons.open(\'' + id + '\')"><img src="' + pic(id, Math.min(6, Math.max(0, Math.round((prog[id].c / n) * 6)))) + '" alt="" loading="lazy"><span class="lz-cc-t"><b>' + esc(b.title) + '</b><small>' + T('Card ', 'कार्ड ') + (prog[id].c + 1) + ' / ' + n + '</small></span><i style="width:' + Math.round(100 * (prog[id].c + 1) / n) + '%"></i></button>';
      });
      h += '</div>';
    }
    // today's lesson: one a day, the same for everyone
    if (avail.length && !(S.bkSearch || '').trim() && (!S.bkCat || S.bkCat === 'all')) {
      const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60e3) / 864e5);
      const t = avail[day % avail.length], p = pal(t.id), hn = heroName(t.id);
      h += '<button class="lz-today" style="--bg:' + p[0] + ';--ac:' + p[1] + ';--lt:' + p[2] + ';--md:' + p[3] + '" onclick="Lessons.open(\'' + t.id + '\',0,true)">'
        + '<span class="lz-today-txt"><small>' + T('Today\'s lesson', 'आज का सबक') + '</small><b>' + esc(t.title) + '</b><span>' + L.mins(t.id) + T(' min · ', ' मिनट · ') + (hn ? T(esc(hn) + '\'s story', esc(hn) + ' की कहानी') : esc(t.author)) + '</span><em>' + PLAYI + T('Play lesson', 'सबक चलाएँ') + '</em></span>'
        + '<img src="' + pic(t.id, 0) + '" alt="" loading="lazy"></button>';
    }
    h += '<div class="lz-grid">';
    avail.forEach(b => {
      const p = pal(b.id), pr = prog[b.id], n = 19;
      h += '<button class="lz-tile" style="--ac:' + p[1] + ';--bg:' + p[0] + '" onclick="openBookSummary(\'' + b.id + '\')">'
        + '<span class="lz-tile-cv" style="background:' + p[0] + '"><img src="' + esc(cover(b.id)) + '" alt="" loading="lazy" onerror="this.remove()"><span class="lz-tile-min">' + L.mins(b.id) + T(' min', ' मिनट') + '</span>'
        + (pr && pr.done ? '<span class="lz-tile-done">✓</span>' : '') + (pr && !pr.done && pr.max ? '<i style="width:' + Math.round(100 * (pr.c + 1) / n) + '%"></i>' : '') + '</span>'
        + '<span class="lz-tile-t"><b>' + esc(b.title) + '</b><small>' + (heroName(b.id) ? T('with ' + esc(heroName(b.id)), esc(heroName(b.id)) + ' के साथ') : esc(b.author)) + '</small></span></button>';
    });
    h += '</div>';
    // books without a lesson keep their book page
    const rest = (list || books()).filter(b => !L.has(b.id));
    if (rest.length && IMG && Object.keys(IMG).length) {
      h += '<div class="lz-grid">';
      rest.forEach(b => { h += '<button class="lz-tile" onclick="openBookSummary(\'' + b.id + '\')"><span class="lz-tile-cv" style="background:' + esc(b.grad || '#333') + '"><img src="' + esc(cover(b.id) || '') + '" alt="" loading="lazy" onerror="this.remove()"></span><span class="lz-tile-t"><b>' + esc(b.title) + '</b><small>' + esc(b.author) + '</small></span></button>'; });
      h += '</div>';
    }
    return h;
  };
  const PLAYI = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12.2-7.4a1 1 0 0 0 0-1.72L8.5 3.74A1 1 0 0 0 7 4.6z"/></svg>';
  const PAUSEI = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1.4"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4"/></svg>';
  const SHAREI = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
  const XI = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const PREVI = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
  const NEXTI = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

  // ── the player ──
  let P = null; // { id, b, l, i, el, audio, rec, playing, raf, drag }
  // the words of a narrated block, each its own span, with where the block sits in the card's narration (o, s: fractions)
  function words(text, say, cls, tag) {
    text = String(text || '').trim(); if (!text) return '';
    const sy = String(say || ''), at = sy.indexOf(text.slice(0, Math.min(28, text.length)));
    const o = at >= 0 && sy.length ? at / sy.length : 0, s = sy.length ? Math.min(1, text.length / sy.length) : 1;
    const w = text.split(/\s+/).map(x => '<span class="w">' + esc(x) + '</span>').join(' ');
    return '<' + (tag || 'p') + ' class="lz-say ' + (cls || '') + '" data-o="' + o.toFixed(4) + '" data-s="' + s.toFixed(4) + '">' + w + '</' + (tag || 'p') + '>';
  }
  const stop = t => { t = String(t || '').trim(); return /[.!?…"”’)।]$/.test(t) ? t : t + (/[ऀ-ॿ]/.test(t) ? '।' : '.'); };
  function cardHtml(c, i, id, l) {
    const say = c.say || ''; const d = (n) => ' style="--d:' + n + '"';
    let h = '<section class="lz-card lzk-' + c.kind + '" data-i="' + i + '" aria-roledescription="slide"><div class="lz-body">';
    if (c.kind === 'cover') {
      const b = book(id);
      h += '<div class="lz-cv a"' + d(0) + '><span class="lz-halo"></span><img src="' + esc(cover(id)) + '" alt=""><span class="lz-spark s1"></span><span class="lz-spark s2"></span><span class="lz-spark s3"></span></div>'
        + '<div class="lz-kick a"' + d(1) + '>' + T('A Brodoit lesson', 'Brodoit का सबक') + '</div><h1 class="lz-h1 a"' + d(2) + '>' + esc(b.title) + '</h1><p class="lz-by a"' + d(3) + '>' + esc(b.author) + '</p>'
        + '<div class="lz-chips a"' + d(4) + '><span>' + L.mins(id) + T(' min', ' मिनट') + '</span><span>' + T('5 big ideas', '5 बड़े विचार') + '</span><span>' + T(esc(l.hero.name) + '\'s story', esc(l.hero.name) + ' की कहानी') + '</span></div>'
        + '<div class="a"' + d(5) + '>' + words(c.why, say, 'lz-why') + '</div>';
    } else if (c.kind === 'meet') {
      h += '<figure class="lz-pic a"' + d(0) + '><img src="' + pic(id, 0) + '" alt="' + esc(l.hero.name) + '"></figure>'
        + '<div class="lz-kick a"' + d(1) + '>' + T('Meet', 'मिलिए') + '</div><h2 class="lz-h2 a"' + d(2) + '>' + esc(l.hero.name) + '</h2><p class="lz-who a"' + d(3) + '>' + esc(String(l.hero.who || '').replace(/^./, x => x.toUpperCase())) + '</p>'
        + '<div class="a"' + d(4) + '>' + words(c.text, say, 'lz-story') + '</div>';
    } else if (c.kind === 'idea') {
      h += '<div class="lz-num a"' + d(0) + ' aria-hidden="true">0' + c.n + '</div><div class="lz-kick a"' + d(1) + '>' + T('Idea ' + NUMW[c.n - 1], 'विचार ' + c.n) + '</div>'
        + words(stop(c.title), say, 'lz-h2 a', 'h2').replace('class="lz-say lz-h2 a"', 'class="lz-say lz-h2 a"' + d(2))
        + '<div class="lz-rule a"' + d(3) + '></div><div class="a"' + d(4) + '>' + words(c.body, say, 'lz-idea') + '</div>';
    } else if (c.kind === 'story') {
      h += '<figure class="lz-pic a"' + d(0) + '><img src="' + pic(id, c.scene) + '" alt="' + esc(l.hero.name) + '"></figure>'
        + '<div class="lz-kick a"' + d(1) + '>' + T('The story · idea ' + NUMW[c.n - 1], 'कहानी · विचार ' + c.n) + '</div>'
        + '<div class="a"' + d(2) + '>' + words(stop(c.h), say, 'lz-h3', 'h3') + '</div><div class="a"' + d(3) + '>' + words(c.story, say, 'lz-story') + '</div>';
    } else if (c.kind === 'lesson') {
      const t = c.think;
      h += '<div class="lz-kick a"' + d(0) + '>' + T('Pause and think', 'रुकिए और सोचिए') + '</div>';
      if (t) {
        h += '<div class="a"' + d(1) + '>' + words(t.q, say, 'lz-q', 'h2') + '</div><div class="lz-opts a"' + d(2) + '>';
        t.o.forEach((o, k) => { h += '<button class="lz-opt' + (k === t.a ? ' best' : '') + '" onclick="Lessons.pick(' + k + ')"><span>' + 'ABC'[k] + '</span>' + esc(o) + '</button>'; });
        h += '</div><span class="lz-cue" hidden>' + words(t.o[t.a], say, 'lz-bestcue') + '</span><p class="lz-whyb">' + esc(t.why) + '</p>';
      }
      if (c.take) h += '<div class="lz-take a"' + d(3) + '><b>' + T('In short', 'सार') + '</b>' + words(c.take, say, '') + '</div>';
      if (c.tryIt) {
        const done = (() => { try { return !!(S.bkTried && S.bkTried[id + ':L' + c.n]); } catch (e) { return false; } })();
        h += '<div class="lz-try a"' + d(4) + '><b>' + T('Try it today', 'आज आज़माएँ') + '</b><p>' + esc(c.tryIt) + '</p><button' + (done ? ' class="on" disabled>' + T('Added to today', 'आज में जुड़ गया') : ' onclick="Lessons.tryIt(' + c.n + ',this)">' + T('Add to my tasks', 'मेरे कामों में जोड़ें')) + '</button></div>';
      }
    } else if (c.kind === 'ending') {
      h += '<figure class="lz-pic a"' + d(0) + '><img src="' + pic(id, 6) + '" alt="' + esc(l.hero.name) + '"></figure>'
        + '<div class="lz-kick a"' + d(1) + '>' + T('How it turned out', 'आख़िर में क्या हुआ') + '</div>'
        + '<div class="a"' + d(2) + '>' + words(stop(c.h), say, 'lz-h3', 'h3') + '</div><div class="a"' + d(3) + '>' + words(c.story, say, 'lz-story') + '</div>'
        + (c.take ? '<div class="lz-take a"' + d(4) + '><b>' + T('In short', 'सार') + '</b>' + words(c.take, say, '') + '</div>' : '')
        + (c.bro ? '<div class="lz-bro a"' + d(5) + '><b>' + T('Bro\'s take', 'Bro की राय') + '</b>' + words(c.bro, say, '') + '</div>' : '');
    } else if (c.kind === 'end') {
      const nx = nextLesson(id), nb = nx && book(nx);
      h += '<div class="lz-burst" aria-hidden="true">' + Array.from({ length: 16 }, (_, k) => '<i style="--k:' + k + '"></i>').join('') + '</div>'
        + '<div class="lz-kick a"' + d(0) + '>' + T('Lesson complete', 'सबक पूरा') + '</div><h2 class="lz-h2 a"' + d(1) + '>' + T('The five ideas', 'पाँच विचार') + '</h2><ol class="lz-recap a"' + d(2) + '>' + (c.recap || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>';
      h += '<div class="lz-endbtns a"' + d(3) + '><button class="lz-btn" onclick="Lessons.share(true)">' + SHAREI + T('Share this lesson', 'यह सबक शेयर करें') + '</button>'
        + (window.BookIdeas && BookIdeas.isPD && BookIdeas.isPD(id) ? '<button class="lz-btn" onclick="Lessons.close();BookIdeas.playBrief(\'' + id + '\')">' + PLAYI + T('The whole original, every chapter', 'पूरी मूल किताब, हर अध्याय') + '</button>' : '')
        + (nb ? '<button class="lz-btn lz-btn-p" onclick="Lessons.open(\'' + nx + '\',0,true,\'' + (l.lang || 'en') + '\')">' + T('Next lesson: ', 'अगला सबक: ') + esc(nb.title) + NEXTI + '</button>' : '') + '</div>'
      if (c.week && c.week.length) h += '<div class="lz-week a"' + d(4) + '><b>' + T('Your week', 'आपका हफ़्ता') + '</b>' + c.week.map(w => '<p><span>' + esc(w.day) + '</span>' + esc(w.tryIt) + '</p>').join('') + '</div>';
        + '<p class="lz-note">' + T('Brodoit\'s own lesson on the ideas in ' + esc(book(id).title) + ', with an invented story. Not affiliated with the author or publisher.', esc(book(id).title) + ' के विचारों पर Brodoit का अपना सबक, एक गढ़ी हुई कहानी के साथ। लेखक या प्रकाशक से कोई संबंध नहीं।') + '</p>';
    }
    return h + '</div></section>';
  }
  function nextLesson(id) {
    const all = books().filter(b => L.has(b.id)); const i = all.findIndex(b => b.id === id);
    for (let k = 1; k <= all.length; k++) { const b = all[(i + k) % all.length]; if (!(prog[b.id] && prog[b.id].done)) return b.id; }
    return all[(i + 1) % all.length] ? all[(i + 1) % all.length].id : null;
  }

  L.open = async function (id, card, autoplay, lang) {
    const b = book(id); if (!b) return;
    // in Hindi the lesson opens in Hindi when it is written (else in English, with Hindi buttons); EN / हिं switches
    lang = lang === 'hi' || lang === 'en' ? lang : hiUI() && L.hasHi(id) ? 'hi' : 'en';
    if (lang === 'hi' && !L.hasHi(id)) lang = 'en';
    if (!L.has(id)) { try { openBookSummary(id); } catch (e) { /* none */ } return; }
    const reuse = !!(P && P.pushed); // switching language: the same place in the phone's history
    if (P) { P.pushed = false; L.close(true); }
    // pause any other sound (the books' mini player, an audiobook, Bro)
    try { if (typeof BKP !== 'undefined' && BKP && !BKP.paused) bkpToggle(); } catch (e) { /* none */ }
    try { const a = document.getElementById('audioEl'); if (a && !a.paused) a.pause(); } catch (e) { /* none */ }
    const p = pal(id);
    const el = document.createElement('div'); el.className = 'lz' + (lang === 'hi' ? ' lz-hi' : ''); el.setAttribute('lang', lang); el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', b.title);
    el.style.cssText = '--bg:' + p[0] + ';--ac:' + p[1] + ';--lt:' + p[2] + ';--md:' + p[3] + ';--dp:' + p[4];
    el.innerHTML = '<div class="lz-fx" aria-hidden="true"><i></i><i></i><i></i></div><div class="lz-wait">' + T('Opening the lesson…', 'सबक खुल रहा है…') + '</div>';
    document.body.appendChild(el); document.documentElement.classList.add('lz-open');
    P = { id, b, l: null, i: 0, el, audio: null, playing: false, raf: 0, gen: 0, lang };
    const me = P;
    if (reuse) me.pushed = true; else { try { history.pushState(Object.assign({}, history.state || {}, { lz: id }), ''); me.pushed = true; } catch (e) { /* no history */ } }
    try { await getIdeas(id); if (lang === 'hi') await getHi(id); } catch (e) { if (P === me) { el.querySelector('.lz-wait').textContent = T('Could not open this lesson. Check your connection.', 'सबक नहीं खुला। इंटरनेट देखें।'); } return; }
    if (P !== me) return;
    const l = lessonOf(id, lang); if (!l) { L.close(); return; }
    me.l = l; me.rec = rec(id, lang);
    const n = l.cards.length;
    el.innerHTML = '<div class="lz-fx" aria-hidden="true"><i></i><i></i><i></i></div>'
      + '<header class="lz-top"><div class="lz-bars">' + l.cards.map((c, k) => '<i data-k="' + k + '"><b></b></i>').join('') + '</div>'
      + '<div class="lz-row"><button class="lz-ic" onclick="Lessons.close()" aria-label="' + T('Close', 'बंद करें') + '">' + XI + '</button><div class="lz-ttl"><b>' + esc(b.title) + '</b><small></small></div>'
      + (L.hasHi(id) ? '<button class="lz-ic lz-lang" onclick="Lessons.lang()" aria-label="' + T('हिंदी में सुनें', 'Listen in English') + '">' + (lang === 'hi' ? 'EN' : 'हिं') + '</button>' : '')
      + '<button class="lz-ic" onclick="Lessons.share()" aria-label="' + T('Share', 'शेयर') + '">' + SHAREI + '</button></div></header>'
      + '<main class="lz-stage"><div class="lz-track">' + l.cards.map((c, k) => cardHtml(c, k, id, l)).join('') + '</div></main>'
      + '<footer class="lz-bot"><button class="lz-ic lz-prev" onclick="Lessons.prev()" aria-label="' + T('Previous', 'पिछला') + '">' + PREVI + '</button>'
      + '<button class="lz-play" onclick="Lessons.toggle()" aria-label="' + T('Play', 'चलाएँ') + '">' + PLAYI + '</button>'
      + '<button class="lz-next" onclick="Lessons.next()"><span>' + T('Next', 'आगे') + '</span>' + NEXTI + '</button></footer>';
    me.track = el.querySelector('.lz-track'); me.cards = [...el.querySelectorAll('.lz-card')];
    // the cards' narration slots (the end card has none)
    me.slot = []; let s = 0; l.cards.forEach((c, k) => { me.slot[k] = c.say ? s++ : -1; });
    if (me.rec && me.rec.cues.length !== s) me.rec = null; // a recording of another text: read along only
    if (me.rec) {
      const a = me.audio = new Audio(); a.preload = 'metadata';
      a.src = '/api/lesson-audio/' + (lang === 'hi' ? 'hi-' : '') + encodeURIComponent(id) + '?v=' + Math.round(me.rec.secs * 10);
      a.addEventListener('play', () => { me.playing = true; me.started = true; paint(); loop(); listened(); });
      a.addEventListener('pause', () => { me.playing = false; paint(); });
      a.addEventListener('ended', () => { me.playing = false; paint(); if (P === me) go(n - 1); });
      a.addEventListener('error', () => { if (P === me && me.audio === a) { me.rec = null; me.audio = null; paint(); } });
    }
    swipe(me); media(me);
    const start = Math.max(0, Math.min(n - 1, card != null ? card : (prog[id] && !prog[id].done ? prog[id].c : 0)));
    go(start, true);
    if (autoplay && me.audio) L.toggle(true);
  };
  L.lang = function () {
    const me = P; if (!me || !me.l || !L.hasHi(me.id)) return;
    const to = me.lang === 'hi' ? 'en' : 'hi', at = me.i, play = me.playing;
    L.open(me.id, at, play, to);
  };
  L.close = function (quiet) {
    const me = P; if (!me) return; P = null;
    try { if (me.audio) { me.audio.pause(); me.audio.removeAttribute('src'); me.audio.load(); } } catch (e) { /* gone */ }
    cancelAnimationFrame(me.raf); clearInterval(me.tick);
    me.el.classList.add('out'); setTimeout(() => me.el.remove(), reduced() ? 0 : 260);
    document.documentElement.classList.remove('lz-open');
    try { if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; } } catch (e) { /* none */ }
    if (!quiet && me.pushed && history.state && history.state.lz) { me.pushed = false; try { history.back(); } catch (e) { /* none */ } }
    rerender();
  };
  addEventListener('popstate', () => { if (P) { P.pushed = false; L.close(true); } });
  addEventListener('keydown', e => {
    if (!P || !P.l || e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (P.i < P.l.cards.length - 1) L.next(true); } else if (e.key === 'ArrowLeft') { e.preventDefault(); L.prev(); }
    else if (e.key === 'Escape') L.close(); else if (e.key === ' ') { e.preventDefault(); L.toggle(); }
  });

  // go to card i (seek the voice there when it is playing or paused mid-lesson)
  function go(i, first) {
    const me = P; if (!me || !me.l) return;
    const n = me.l.cards.length; i = Math.max(0, Math.min(n - 1, i));
    const was = me.i; me.i = i;
    me.track.style.transition = first || reduced() ? 'none' : '';
    me.track.style.transform = 'translate3d(' + (-100 * i) + '%,0,0)';
    me.cards.forEach((c, k) => { c.classList.toggle('on', k === i); c.setAttribute('aria-hidden', k === i ? 'false' : 'true'); if (k !== i) c.querySelectorAll('.w.lit').forEach(w => w.classList.remove('lit')); });
    const body = me.cards[i].querySelector('.lz-body'); if (body) body.scrollTop = 0;
    // a fresh card plays its entrance again
    const card = me.cards[i]; card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    if (me.audio && me.rec && !me.seeking) {
      const sl = me.slot[i];
      if (sl >= 0) { const t = me.rec.cues[sl]; if (Math.abs(me.audio.currentTime - t) > 0.6 && (first ? t > 0 || me.audio.currentTime > 1 : true)) { try { me.audio.currentTime = t; } catch (e) { /* not loaded yet */ me.wantAt = t; } } }
      else if (me.playing) me.audio.pause();
    }
    if (me.l.cards[i].kind === 'end') { mark(me.id, i, true); finished(me); } else mark(me.id, i, false);
    paint(); setMeta(me);
    if (!first && was !== i) { try { if (window.haptic) haptic('select'); } catch (e) { /* none */ } }
  }
  // Next on the cover starts the voice ("Start"); the arrow key always turns the card
  L.next = (turn) => { if (P && P.l) { if (P.i >= P.l.cards.length - 1) return L.close(); if (turn !== true && P.i === 0 && P.audio && !P.playing && !P.started) { P.started = true; return L.toggle(true); } go(P.i + 1); } };
  L.prev = () => { if (P && P.l) go(P.i - 1); };
  L.toggle = function (force) {
    const me = P; if (!me) return;
    if (!me.audio) { try { toast(T('The narrator is still recording this lesson. Read along for now; the voice arrives soon.', 'नैरेटर यह सबक अभी रिकॉर्ड कर रहे हैं। तब तक पढ़ें, आवाज़ जल्द आएगी।')); } catch (e) { /* none */ } return; }
    if (me.audio.paused || force === true) {
      if (me.slot[me.i] < 0) go(0);
      const sl = me.slot[me.i]; if (sl >= 0) { const t = me.rec.cues[sl], e = me.rec.cues[sl + 1] || me.rec.secs; if (me.audio.currentTime < t - 0.3 || me.audio.currentTime > e) { try { me.audio.currentTime = t; } catch (e2) { me.wantAt = t; } } }
      me.audio.play().catch(() => { me.playing = false; paint(); });
    } else me.audio.pause();
  };
  // the voice leads: words light up as they are read, the card turns when the next one starts
  function loop() {
    const me = P; if (!me) return; cancelAnimationFrame(me.raf);
    const step = () => {
      if (P !== me || !me.audio) return;
      if (me.wantAt != null && me.audio.readyState >= 1) { try { me.audio.currentTime = me.wantAt; } catch (e) { /* later */ } me.wantAt = null; }
      const t = me.audio.currentTime, cues = me.rec.cues;
      let sl = 0; while (sl + 1 < cues.length && t >= cues[sl + 1] - 0.05) sl++;
      const at = me.slot.indexOf(sl);
      if (me.playing && at >= 0 && at !== me.i) { me.seeking = true; go(at); me.seeking = false; }
      light(me, t); bar(me, t);
      if (me.playing) me.raf = requestAnimationFrame(step);
    };
    me.raf = requestAnimationFrame(step);
  }
  function light(me, t) {
    const sl = me.slot[me.i]; if (sl < 0 || !me.rec) return;
    const a = me.rec.cues[sl], e = (me.rec.cues[sl + 1] || me.rec.secs) - 1.0, f = Math.max(0, Math.min(1, (t - a) / Math.max(1, e - a)));
    const card = me.cards[me.i]; let last = null;
    card.querySelectorAll('.lz-say').forEach(p => {
      const o = +p.dataset.o, s = +p.dataset.s, ws = p.querySelectorAll('.w'), k = Math.floor(Math.max(0, Math.min(1, (f - o) / Math.max(0.0001, s))) * ws.length + (f >= o ? 1 : 0));
      ws.forEach((w, j) => { const on = j < k; if (on !== w.classList.contains('lit')) w.classList.toggle('lit', on); if (on) last = w; });
      if (p.classList.contains('lz-bestcue') && k > 0) card.classList.add('shown');
    });
    // keep the word being read in view
    const body = card.querySelector('.lz-body');
    if (last && body && body.scrollHeight > body.clientHeight + 4) {
      const y = last.offsetTop - body.offsetTop; if (y > body.scrollTop + body.clientHeight * 0.68) body.scrollTo({ top: y - body.clientHeight * 0.32, behavior: reduced() ? 'auto' : 'smooth' });
    }
  }
  function bar(me, t) {
    const bars = me.el.querySelectorAll('.lz-bars b');
    bars.forEach((b, k) => {
      let w = k < me.i ? 1 : k > me.i ? 0 : 0;
      if (k === me.i) {
        const sl = me.slot[k];
        if (me.rec && sl >= 0) { const a = me.rec.cues[sl], e = me.rec.cues[sl + 1] || me.rec.secs; w = Math.max(0, Math.min(1, (t - a) / Math.max(1, e - a))); }
        else w = 1;
      }
      b.style.transform = 'scaleX(' + w + ')';
    });
  }
  function paint() {
    const me = P; if (!me || !me.l) return;
    const n = me.l.cards.length, c = me.l.cards[me.i];
    me.el.classList.toggle('playing', !!me.playing);
    const pl = me.el.querySelector('.lz-play'); pl.innerHTML = me.playing ? PAUSEI : PLAYI; pl.classList.toggle('on', me.playing); pl.classList.toggle('mute', !me.audio);
    pl.setAttribute('aria-label', me.playing ? T('Pause', 'रोकें') : T('Play', 'चलाएँ'));
    const nx = me.el.querySelector('.lz-next span'); nx.textContent = me.i >= n - 1 ? T('Done', 'पूरा') : me.i === 0 && !me.started ? T('Start', 'शुरू') : T('Next', 'आगे');
    me.el.querySelector('.lz-prev').disabled = me.i === 0;
    const lab = { cover: T('Lesson', 'सबक'), meet: T('Meet ', 'मिलिए ') + me.l.hero.name, idea: T('Idea ', 'विचार ') + c.n + ' / 5', story: T('Story ', 'कहानी ') + c.n + ' / 5', lesson: T('Think ', 'सोचें ') + c.n + ' / 5', ending: T('The ending', 'अंत'), end: T('Complete', 'पूरा') }[c.kind] || '';
    me.el.querySelector('.lz-ttl small').textContent = lab + ' · ' + (me.i + 1) + ' / ' + n;
    if (!me.playing) bar(me, me.audio ? me.audio.currentTime : 0);
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = me.playing ? 'playing' : 'paused'; } catch (e) { /* none */ }
  }
  // tap a choice: the best move and why show either way
  L.pick = function (k) {
    const me = P; if (!me) return; const card = me.cards[me.i]; const c = me.l.cards[me.i]; if (!c.think) return;
    card.classList.add('shown', 'picked'); card.querySelectorAll('.lz-opt').forEach((b, j) => b.classList.toggle('mine', j === k));
    try { if (window.haptic) haptic(k === c.think.a ? 'success' : 'light'); } catch (e) { /* none */ }
  };
  L.tryIt = async function (k, btn) {
    const me = P; if (!me) return; const c = me.l.cards.find(x => x.kind === 'lesson' && x.n === k); if (!c || !c.tryIt) return;
    if (btn) btn.disabled = true;
    const d = new Date(), due = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let r = null; try { r = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: c.tryIt, notes: T('From the lesson on ', 'सबक से: ') + me.b.title, priority: 'medium', status: 'pending', due_date: due, board: 'home' }) }); } catch (e) { r = null; }
    if (r && r.id) {
      try { if (S.tasks) S.tasks.unshift(r); S.bkTried = S.bkTried || {}; S.bkTried[me.id + ':L' + k] = 1; } catch (e) { /* none */ }
      if (btn) { btn.textContent = T('Added to today', 'आज में जुड़ गया'); btn.classList.add('on'); }
      try { toast(T('Added to today\'s tasks', 'आज के कामों में जुड़ गया')); } catch (e) { /* none */ }
    } else if (btn) { btn.disabled = false; try { toast(T('Sign in to add it to your tasks', 'कामों में जोड़ने के लिए साइन इन करें'), 'err'); } catch (e) { /* none */ } }
  };
  // share the lesson, or the card you are on (a link that opens it there, with the lesson's cover as its picture)
  L.share = async function (whole) {
    const me = P; if (!me || !me.l) return;
    const c = me.l.cards[me.i], at = whole || me.i === 0 || c.kind === 'end' ? 0 : me.i;
    const qs = [at ? 'c=' + at : '', me.lang === 'hi' ? 'hl=hi' : ''].filter(Boolean).join('&');
    const url = location.origin + '/l/' + encodeURIComponent(me.id) + (qs ? '?' + qs : '');
    const line = c.kind === 'idea' ? stop(c.title) : c.kind === 'lesson' && c.take ? c.take : c.kind === 'story' || c.kind === 'ending' ? stop(c.h) : '';
    const text = (line && at ? '“' + line + '”\n\n' : '') + T(me.b.title + ': an ' + L.mins(me.id) + '-minute lesson on Brodoit, told through ' + me.l.hero.name + '\'s story.', me.b.title + ': Brodoit पर ' + L.mins(me.id) + ' मिनट का सबक, ' + me.l.hero.name + ' की कहानी से।');
    try { if (navigator.share) { await navigator.share({ title: me.b.title + ' · Brodoit', text, url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text + '\n' + url); toast(T('Link copied. Paste it anywhere to share.', 'लिंक कॉपी हो गया।')); }
    catch (e) { try { prompt(T('Copy this link', 'यह लिंक कॉपी करें'), url); } catch (e2) { /* none */ } }
  };

  // what the player is doing (tests, and anything that needs to know whether a lesson is open)
  L.audio = () => (P ? P.audio : null);
  L.state = () => (P && P.l ? { id: P.id, lang: P.lang, i: P.i, n: P.l.cards.length, kind: P.l.cards[P.i].kind, playing: !!P.playing, voice: !!P.rec, src: P.audio ? P.audio.src : '', t: P.audio ? P.audio.currentTime : 0, cues: P.rec ? P.rec.cues : null } : null);
  // horizontal swipe: the card follows the finger; let go past a third (or flick) to turn it
  function swipe(me) {
    const st = me.el.querySelector('.lz-stage'); let x0 = 0, y0 = 0, t0 = 0, dx = 0, on = false, dir = '';
    st.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button,a,input,textarea,summary')) return;
      x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); dx = 0; on = true; dir = '';
    });
    st.addEventListener('pointermove', e => {
      if (!on || P !== me) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!dir) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; dir = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'; if (dir === 'x') { try { st.setPointerCapture(e.pointerId); } catch (e2) { /* none */ } } }
      if (dir !== 'x') return;
      dx = mx; const n = me.l.cards.length; const edge = (me.i === 0 && dx > 0) || (me.i === n - 1 && dx < 0) ? 0.3 : 1;
      me.track.style.transition = 'none'; me.track.style.transform = 'translate3d(calc(' + (-100 * me.i) + '% + ' + (dx * edge) + 'px),0,0)';
    });
    const end = () => {
      if (!on) return; on = false; if (dir !== 'x' || P !== me) return;
      const w = st.clientWidth || 360, v = Math.abs(dx) / Math.max(1, Date.now() - t0);
      me.track.style.transition = '';
      if ((dx < -w / 3 || (dx < -30 && v > 0.5)) && me.i < me.l.cards.length - 1) go(me.i + 1);
      else if ((dx > w / 3 || (dx > 30 && v > 0.5)) && me.i > 0) go(me.i - 1);
      else go(me.i);
    };
    st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
    st.addEventListener('dragstart', e => e.preventDefault()); // a picture or words dragged by the mouse would cancel the swipe
  }
  // the phone's lock screen and headphones: play, pause, next card, previous card
  function media(me) {
    if (!('mediaSession' in navigator) || !me.audio) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => L.toggle(true));
      navigator.mediaSession.setActionHandler('pause', () => { if (P && P.audio) P.audio.pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', () => L.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => L.prev());
    } catch (e) { /* older browsers */ }
  }
  function setMeta(me) {
    if (!('mediaSession' in navigator) || !me.audio) return;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: me.b.title, artist: T('Brodoit lesson · ', 'Brodoit सबक · ') + me.l.hero.name, album: 'Brodoit', artwork: [{ src: cover(me.id), sizes: '512x768', type: 'image/webp' }] }); } catch (e) { /* none */ }
  }
  // two minutes of listening counts for the listening streak (as the books did)
  function listened() {
    const me = P; if (!me || me.tick) return; let secs = 0;
    me.tick = setInterval(async () => {
      if (P !== me) return clearInterval(me.tick);
      if (!me.playing) return; secs += 5;
      try {
        if (secs === 120 && S.user && S.bookStreak && !S.bookStreak.today) {
          const r = await api('/book-streak', { method: 'POST', body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), seconds: 120 }) });
          if (r && r.ok) { S.bookStreak = { streak: r.streak, total: r.total, today: true, days: S.bookStreak.days }; toast('\u{1F525} ' + r.streak + T('-day learning streak!', ' दिन की लगातार सीख!')); }
        }
      } catch (e) { /* offline */ }
    }, 5000);
  }
  function finished(me) {
    if (me.doneOnce) return; me.doneOnce = true;
    const card = me.cards[me.i]; card.classList.add('party');
    try { if (window.haptic) haptic('success'); } catch (e) { /* none */ }
  }

  // a shared link (/l/<id>?c=<card> → /?bk=<id>&c=<card>) opens the lesson there
  try {
    const q = new URLSearchParams(location.search), id = q.get('bk');
    if (id && /^[a-z0-9_-]{1,60}$/i.test(id)) {
      const c = Math.max(0, parseInt(q.get('c'), 10) || 0);
      try { history.replaceState(history.state, '', location.pathname); } catch (e) { /* none */ }
      const t0 = Date.now();
      const hl = q.get('hl') === 'hi' ? 'hi' : q.get('hl') === 'en' ? 'en' : undefined;
      const wait = () => { if (L.has(id) && window.BookFull && HI.loaded) { try { S.tab = 'books'; render(); } catch (e) { /* none */ } L.open(id, c, false, hl); } else if (Date.now() - t0 < 15000) setTimeout(wait, 250); };
      setTimeout(wait, 300);
    }
  } catch (e) { /* no deep link */ }
})();
