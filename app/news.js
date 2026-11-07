// Brodoit News (v16): one story per screen, swiped left and right. A big real photo, the full story (never cut off),
// its source, and one Share button. No audio, no counters.
// Mounted into the SPA's News tab: the shell calls NewsChannel.html(), .load(), reads .loaded/._loading,
// and .stop() when leaving the tab. Stories come from the News Desk (modules/newsdesk.js), a page at a time:
// near the end of the deck the next, older page is added behind the last card.
// v21: a story that was on screen for 1.5 s (or swiped past) is seen and never comes back, nor a rewrite of it: this
// phone keeps the list (localStorage news.seen.v1, 30 days) and a signed-in reader's server does too (POST
// /api/news/seen), so it holds on every phone. When nothing unseen is left the deck ends on "You're all caught up"
// (no going round again). Share opens a sheet: the story as a picture (with its brodoit.com/n/<id> link and a QR code),
// the link, or copy the link. No Bro in News.
// v22: News comes in three editions a day (7 am, 1 pm, 7 pm India time). The deck opens on the edition's front page (its
// top headlines, tap one to jump to it; the sections; when the next edition comes), then the stories: each with
// "Why it matters" and its sources (tap: the original reports). A slim bar shows how far you are. Hindi shows only the
// stories written in Hindi (the server sends ?lang=hi), never English ones. A dot on the News tab says a new edition
// is in.
// v28: News opens straight on the first story (no front page). A bar under the story holds the sections (Top, AI, India,
// World, Business, Tech, Science), Readers (pieces readers sent, checked by Brodoit's AI editor), Thought of the day (an
// original thought and the story behind it) and Send (write for Brodoit). Every card has a free photo with its credit.
// v29: the short-news reader. One story fills the screen and you swipe UP for the next (down for the one before); the
// card you leave stays put and the next one slides over it. The photo runs edge to edge with its credit; the story
// always fits its card (the type steps down, the photo gives way, then the text ends on a whole line with "Read the
// full story"), never scrolling inside it. Swipe LEFT (or tap the strip at the bottom) for the original reports. A
// bookmark keeps a story in Saved (on this phone). News opens at once on the stories from your last visit while the
// new ones load, and a "New stories" pill appears when an edition comes in while you read.
// v30: news only, and clean. One feed mixes every section (no section bar, no Readers / Saved / Thought / Send); no
// buttons on the card (no Save, Share, language switch, "Read the full story" or "New stories" pill): the app's language
// decides the language, the whole story is always on its card, and the reports it came from are named in plain text
// (swipe the card left for their links). No "written by" line. Each photo keeps its credit (its free licence asks for it).
// v36 (owner, 7 Nov: "photos are not available … remove that. Why it matters option … keep the photos proper … right
// swipe, not down swipe … a button saying that we have to go right, plus there should be a sharing button"):
//   - The deck runs SIDEWAYS again: one story per screen, a floating card. Drag it left (it follows the finger) and the
//     next story comes in from the right; drag right for the one before. A flick or a third of the width moves on,
//     less springs back. Arrow keys / PageUp/PageDown / j,k and a sideways trackpad swipe work on a computer. The cards
//     are placed with transforms (never scroll-snap), so the drag, the buttons and the keys all move the same deck.
//   - v37 (owner, 7 Nov: "keep whole page as news and next option and share should be small icon inside only so that
//     the experience is seamless"): the story is the whole page (edge to edge on a phone, no card frame, no bar), and
//     Share and Next are two small round icons inside it, bottom right (the text keeps clear of them); Previous is a
//     swipe right or the left arrow key. Share = the Web Share sheet with the headline, one line and the story's link
//     https://brodoit.com/n/<id>; without it, the link is copied.
//   - Photos: only stories with a photo are shown; a photo that fails to load takes its story out of the deck before
//     it counts as seen (the next ones are loaded ahead, so a broken one is gone before you reach it). The WHOLE photo
//     is shown (contained) over a blurred, darkened copy of itself, so portrait and landscape both look right; its
//     credit sits on it. A shared link to a story without a photo still opens it (on its section's colour).
//   - "Why it matters" is gone. The story still always fits its card: the type steps down and the photo gives way.
//   - Tap the reports' names under the headline for their links (the sheet that a left swipe used to open).
(function () {
  'use strict';
  const N = window.NewsChannel = { lang: localStorage.getItem('news.lang') || 'en', stories: [], loaded: false, _loading: false, i: 0 };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const I = (n, s, w) => (window.ico ? window.ico(n, s, w) : '');
  const hi = () => N.lang === 'hi';
  const pick = (st, k) => (hi() && st[k + '_hi']) ? st[k + '_hi'] : st[k];
  const CAT = { india: ['India', 'भारत', '#B5402A', 'landmark'], world: ['World', 'दुनिया', '#2F5FA8', 'globe'], ai: ['AI', 'AI', '#A21CAF', 'sparkles'], business: ['Business', 'कारोबार', '#2F7D4F', 'trending-up'], tech: ['Tech', 'टेक', '#6D28D9', 'smartphone'], science: ['Science', 'विज्ञान', '#0E7C7B', 'rocket'], life: ['Life', 'जीवन', '#A0570F', 'sun'] };
  const SRC = { thehindu: 'The Hindu', indianexpress: 'Indian Express', ndtv: 'NDTV', hindustantimes: 'Hindustan Times', livemint: 'Mint', economictimes: 'Economic Times', timesofindia: 'Times of India', bbc: 'BBC', bbci: 'BBC', theguardian: 'The Guardian', reuters: 'Reuters', aljazeera: 'Al Jazeera', npr: 'NPR', cnbc: 'CNBC', techcrunch: 'TechCrunch', theverge: 'The Verge', wired: 'Wired', arstechnica: 'Ars Technica', sciencedaily: 'ScienceDaily', nasa: 'NASA', scroll: 'Scroll', thewire: 'The Wire', news18: 'News18', indiatoday: 'India Today', moneycontrol: 'Moneycontrol', businessstandard: 'Business Standard', pibgovin: 'PIB · Govt of India', pibgov: 'PIB · Govt of India', rbiorgin: 'Reserve Bank of India', newsun: 'UN News', whoint: 'WHO', nasagov: 'NASA', openai: 'OpenAI', deepmindgoogle: 'Google DeepMind', bloggoogle: 'Google', huggingfaceco: 'Hugging Face', huggingface: 'Hugging Face', blogsnvidia: 'NVIDIA', newsmitedu: 'MIT News', technologyreview: 'MIT Technology Review', analyticsindiamag: 'Analytics India Magazine' };
  const srcName = x => { const k = String(x && x.name || '').toLowerCase().replace(/^www\./, '').replace(/\.(com|in|co\.in|co\.uk|org|net)$/, '').replace(/[^a-z]/g, ''); return SRC[k] || String(x && x.name || '').replace(/^www\./, ''); };
  const ago = d => { const t = Date.parse(d || ''); if (!t) return ''; const m = Math.max(1, Math.round((Date.now() - t) / 60000)), H = hi(); return m < 60 ? m + (H ? ' मि' : 'm') : m < 1440 ? Math.round(m / 60) + (H ? ' घं' : 'h') : Math.round(m / 1440) + (H ? ' दि' : 'd'); };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॣ०-ॿ]+/g, ' ').trim();
  // v36: the address a shared story opens (modules/newsdesk.js serves /n/<id>: the story's own page with link previews)
  const SITE = 'https://brodoit.com';

  // ── No repeats, without losing real stories: the same id is dropped, and so is a headline that says the same
  // thing in nearly the same meaningful words (Jaccard ≥ 0.7, only when both have 4+). Words every headline uses
  // ("the", "says", "India", "के", "भारत" …) never count, so unrelated stories are not taken for each other.
  const STOP = new Set((
    'a an the of to in on at by for from with without into onto over under after before about above below across against along amid among around ' +
    'as is are was were be been being am it its this that these those there here their them they he she his her him we our you your me my ' +
    'and or but nor so yet if then than also not no yes up down out off more most less very much many some any all each every both few other such ' +
    'just only even still will would can could may might must shall should do does did done has have had get gets got make makes made take takes took ' +
    'what why how who whom whose when where which while new says said say tells told report reports reported via per vs now today tonight ' +
    'yesterday tomorrow week weeks month months year years day days time first last next top big india indian indians indias ' +
    'के का की को में से पर ने है हैं था थी थे और या भी तो ही एक यह वह ये वो इस उस इन उन लिए साथ बाद पहले बीच तक कि जो जब अब ' +
    'कर करें करने किया किए गया गई गए हुआ हुई हुए हो होगा होगी होंगे रहा रही रहे दिया दी नए नई नया कहा कहते बताया भारत भारतीय देश आज'
  ).split(/\s+/).filter(Boolean));
  const sig = s => { const w = new Set(); for (const x of norm(s).split(' ')) if (x.length > 1 && !STOP.has(x)) w.add(x); return w; };
  const same = (a, b) => { if (a.size < 4 || b.size < 4) return false; let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / (a.size + b.size - n) >= 0.7; };
  const jac = (a, b) => { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / (a.size + b.size - n || 1); };

  // ── v21: seen memory. ids for 30 days; each story's words (headline + its opening) for 14 days ──
  const SEEN_KEY = 'news.seen.v1', DAY = 864e5;
  const seenSig = st => sig(String(st.headline || '') + ' ' + String(st.summary || '').slice(0, 140));
  const seen = (() => {
    let j = {}; try { j = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { j = {}; }
    const now = Date.now(), ids = {}, sigs = [];
    for (const [id, t] of Object.entries(j.ids || {})) if (now - t < 30 * DAY) ids[id] = t;
    for (const x of Array.isArray(j.sigs) ? j.sigs : []) if (Array.isArray(x) && now - x[0] < 14 * DAY && x[1]) sigs.push([x[0], x[1], new Set(String(x[1]).split(' '))]);
    return { ids, sigs: sigs.slice(-800), queue: [] };
  })();
  function saveSeen() {
    try {
      const ids = Object.entries(seen.ids).sort((a, b) => b[1] - a[1]).slice(0, 4000);
      localStorage.setItem(SEEN_KEY, JSON.stringify({ ids: Object.fromEntries(ids), sigs: seen.sigs.map(x => [x[0], x[1]]) }));
    } catch (e) { /* storage full or blocked */ }
  }
  const isSeen = st => { if (st.id && seen.ids[st.id]) return true; const w = seenSig(st); if (w.size < 3) return false; return seen.sigs.some(x => jac(w, x[2]) >= 0.45); };
  N.isSeen = isSeen;
  function markSeen(st) {
    if (!st || !st.id || seen.ids[st.id]) return;
    const now = Date.now(), w = seenSig(st);
    seen.ids[st.id] = now;
    if (w.size >= 3) { seen.sigs.push([now, [...w].join(' '), w]); if (seen.sigs.length > 800) seen.sigs.shift(); }
    saveSeen();
    seen.queue.push(st.id); clearTimeout(seen.t); seen.t = setTimeout(flushSeen, 3000);
  }
  function flushSeen() {
    clearTimeout(seen.t);
    const ids = seen.queue.splice(0, 200); if (!ids.length) return;
    let tok = ''; try { tok = localStorage.getItem('tf_token') || ''; } catch (e) { tok = ''; }
    if (!tok) return;
    try { fetch('/api/news/seen', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'x-token': tok }, body: JSON.stringify({ ids }) }).catch(() => {}); } catch (e) { /* offline */ }
    if (seen.queue.length) seen.t = setTimeout(flushSeen, 1000);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSeen(); });
  addEventListener('pagehide', flushSeen);

  // v36: News shows only stories with a photo (a story whose photo then fails to load is taken out, see N._img)
  const hasPhoto = st => !!(st && st.image);

  // ── v29: the last deck (News opens on it at once while the new stories load; per language, 36 hours) ──
  const KEEP = ['id', 'kind', 'reader', 'name', 'day', 'category', 'headline', 'summary', 'headline_hi', 'summary_hi', 'image', 'image_credit', 'sources', 'published_at'];
  const slim = st => { const o = {}; for (const k of KEEP) if (st[k] != null && st[k] !== '') o[k] = st[k]; return o; };
  const deckKey = () => 'news.deck.v1.' + (hi() ? 'hi' : 'en');
  function keepDeck(list) {
    if (!list.length) return;
    try { localStorage.setItem(deckKey(), JSON.stringify({ at: Date.now(), edition: N.edition || null, stories: list.slice(0, 12).map(slim) })); } catch (e) { /* storage full or blocked */ }
  }
  function lastDeck() {
    try {
      const j = JSON.parse(localStorage.getItem(deckKey()) || 'null');
      if (!j || !Array.isArray(j.stories) || Date.now() - (j.at || 0) > 36 * 3600e3) return null;
      const list = j.stories.filter(st => st && st.id && st.headline && st.summary && hasPhoto(st) && !isSeen(st));
      return list.length ? { list, edition: j.edition } : null;
    } catch (e) { return null; }
  }
  // v22: a dot on the News tab when an edition is in that this phone has not opened yet
  function sawEdition() {
    const id = N.edition && N.edition.id; if (!id) return;
    try { localStorage.setItem('news.edition.seen', id); } catch (e) { /* ignore */ }
    document.body.classList.remove('nz-fresh');
  }
  N.checkEdition = async function () {
    try {
      const r = await fetch('/api/news/edition', { cache: 'no-store' }); if (!r.ok) return;
      const e = await r.json(); if (!e || !e.ready || !e.id) return;
      N.edition = N.edition && N.edition.id === e.id ? N.edition : e;
      let seenId = ''; try { seenId = localStorage.getItem('news.edition.seen') || ''; } catch (x) { seenId = ''; }
      if (window.S && S.tab === 'news') { sawEdition(); return; }
      document.body.classList.toggle('nz-fresh', seenId !== e.id);
    } catch (e) { /* offline */ }
  };
  setTimeout(() => N.checkEdition(), 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') N.checkEdition(); });
  // the story on screen counts as seen after 1.5 s (only while News is what you are looking at). v36: and only once its
  // photo is showing: a story whose photo fails is taken out of the deck without counting as seen
  let viewT = 0;
  const shown = st => !!(st && (st._ok || !st.image));
  function watch() {
    clearTimeout(viewT);
    const st = N.stories[N.i]; if (N.view !== 'news' || !st || seen.ids[st.id] || !shown(st)) return;
    viewT = setTimeout(() => { if (window.S && S.tab === 'news' && document.visibilityState === 'visible' && N.stories[N.i] === st) markSeen(st); }, 1500);
  }

  // A pass is one walk from the newest story back to the oldest the server has. Repeats are dropped within a pass;
  // when a pass runs dry the next one starts from the newest again.
  let pass = null;
  const newPass = () => (pass = { ids: new Set(), got: [], heads: [], next: undefined });
  function take(P, list) {
    const out = [];
    for (const st of list) {
      if (!st || !st.headline || !st.summary) continue;
      const key = st.id || 'h:' + st.headline;
      if (P.ids.has(key)) continue;
      P.ids.add(key); if (st.id) P.got.push(String(st.id));
      if (!hasPhoto(st)) continue;                             // v36: no photo, not shown
      if (isSeen(st)) continue;                                // v21: on screen once already (or a rewrite of it)
      const w = sig(st.headline);
      if (P.heads.some(h => same(w, h))) continue;
      P.heads.push(w); out.push(st);
    }
    return out;
  }
  // one page: the first is today's ranked desk; after it, `before` = the server's cursor (or the oldest story it sent)
  async function page() {
    const P = pass, first = P.next === undefined, qs = ['limit=' + (first ? 40 : 20)];
    if (hi()) qs.push('lang=hi');
    if (!first) {
      qs.push('before=' + encodeURIComponent(P.next));
      const g = P.got, ex = g.length > 200 ? g.slice(0, 40).concat(g.slice(-160)) : g;
      if (ex.length) qs.push('exclude=' + ex.map(encodeURIComponent).join(','));
    }
    // signed in: the server leaves out what this reader saw on any phone (v21)
    let tok = ''; try { tok = localStorage.getItem('tf_token') || ''; } catch (e) { tok = ''; }
    const r = await fetch('/api/news/desk?' + qs.join('&'), { cache: 'no-store', headers: tok ? { 'x-token': tok } : {} });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), list = j && Array.isArray(j.stories) ? j.stories : [];
    if (P !== pass) return [];                                 // a reload started a new walk meanwhile
    if (j && j.edition) N.edition = j.edition;
    const had = P.ids.size, kept = mix(take(P, list));
    if (j && 'next' in j) P.next = j.next || null;
    else { const t = list.map(s => Date.parse((s && s.published_at) || '')).filter(x => x > 0); P.next = t.length ? new Date(Math.min(...t)).toISOString() : null; }
    if (P.ids.size === had) P.next = null;                     // nothing new came back: this walk is over
    return kept;
  }
  // v30: one feed mixes the sections: the stories keep the desk's order, except that a story from the same section as
  // the one before it waits for the next story from another section (so India or World never comes in a bunch)
  function mix(list) {
    const rest = list.slice(), out = []; let last = (N.stories[N.stories.length - 1] || {}).category;
    while (rest.length) {
      let k = rest.findIndex(st => (st.category || 'other') !== last); if (k < 0) k = 0;
      const st = rest.splice(k, 1)[0]; out.push(st); last = st.category || 'other';
    }
    return out;
  }
  function keep(st) {
    N.stories.push(st);
  }
  N.view = 'news';
  N.load = function () { return loadNews(); };
  async function loadNews() {
    N.err = false; N.caughtUp = false; N._at = Date.now();
    const P = newPass();
    // v29: the first time News opens on this visit, the stories from last time show at once (unseen ones only) while
    // the new ones load; a shared link (?s=) waits for the real deck
    let early = null;
    if (!N._booted && !N._want && !new URLSearchParams(location.search).get('s')) {
      early = lastDeck();
      if (early) { N.stories = early.list; N.i = 0; N.edition = N.edition || early.edition; N.loaded = true; N.rerender(); }
    }
    N._booted = true;
    let got = [], err = false;
    try {
      got = await page();
      for (let k = 0; k < 6 && !got.length && P === pass && P.next !== null; k++) got = await page(); // a first page of seen stories: look further
    } catch (e) { err = true; }
    if (P !== pass) return;
    N._ed = N.edition && N.edition.id;
    if (early && N.loaded && N.stories === early.list) {
      // the reader may be on one of last time's stories: keep those up to the one on screen, then the new ones after
      const kept = N.stories.slice(0, N.i + 1), ks = kept.map(x => sig(x.headline));
      kept.forEach(x => pass.ids.add(x.id));
      const rest = got.filter(x => !kept.some(k => k.id === x.id) && !ks.some(w => same(w, sig(x.headline))));
      if (err && !got.length) { N.loaded = true; N._loading = false; return; }   // offline: last time's stories stay
      N.stories = kept.concat(rest);
      N.caughtUp = !err && !rest.length && P.next === null;
      N.err = false; N.loaded = true; N._loading = false;
      keepDeck(got); sawEdition(); N.rerender();
      return;
    }
    N.stories = []; N.i = 0; got.forEach(keep);
    N.caughtUp = !err && !got.length && P.next === null;
    N.err = err && !got.length;
    keepDeck(got);
    sawEdition();
    // a shared link or a notification (?s=<story id>) opens on that story, even one seen before
    const want = N._want || new URLSearchParams(location.search).get('s'); N._want = null;
    if (want) await openStory(want);
    N.loaded = true; N._loading = false;
    N.rerender();
    // News failed to load (offline): it tries again by itself in 20 seconds (no button to press)
    if (N.err) { clearTimeout(N._retryT); N._retryT = setTimeout(() => { if (N.err && window.S && S.tab === 'news') N.again(); }, 20000); }
  }
  // a link that was shared before v30 to a thought (th_…) or a reader's piece (rd_…) opens it as one card in the feed
  async function linked(id) {
    try {
      if (id.startsWith('th_')) {
        const r = await fetch('/api/news/thought', { cache: 'no-store' }); const items = r.ok ? ((await r.json()) || {}).items || [] : [];
        const x = items.find(t => t && t.id === id); return x && x.thought ? Object.assign({ kind: 'thought', headline: x.thought, summary: x.story, headline_hi: x.thought_hi, summary_hi: x.story_hi, category: 'life' }, x) : null;
      }
      const r = await fetch('/api/news/readers?limit=60', { cache: 'no-store' }); const items = r.ok ? ((await r.json()) || {}).items || [] : [];
      return items.find(t => t && t.id === id && t.headline && t.summary) || null;
    } catch (e) { return null; }
  }
  async function openStory(id) {
    let k = N.stories.findIndex(x => x.id === id);
    if (k < 0) {
      try {
        let st = null;
        if (/^(th|rd)_/.test(id)) st = await linked(id);
        else { const r = await fetch('/api/news/story/' + encodeURIComponent(id), { cache: 'no-store' }); const j = r.ok ? await r.json() : null; st = j && j.story && j.story.headline ? j.story : null; }
        // v36: a story someone sent you opens even without a photo (or with one that fails): it shows on its colour
        if (st) { st._pin = true; k = Math.max(0, Math.min(N.i, N.stories.length)); N.stories.splice(k, 0, st); if (pass) pass.ids.add(st.id); }
      } catch (e) { /* offline */ }
    } else N.stories[k]._pin = true;
    if (k >= 0) { N.i = k; N.caughtUp = N.caughtUp && N.stories.length > 0; }
    else if (typeof toast === 'function') toast(hi() ? 'यह ख़बर अब उपलब्ध नहीं' : 'This story is no longer available');
    return k;
  }
  // a story link inside the app (a tapped notification, a shared link opened in the app)
  N.open = async function (id) {
    if (!id) return;
    if (!N.loaded) { N._want = id; if (!N._loading) { N._loading = true; N.load(); } return; }
    const k = await openStory(id);
    if (k >= 0) { N.rerender(); }
  };
  // Near the end: the next page goes in behind the last card (the card in view never moves). One load at a time.
  // v21: when the desk has nothing unseen left, the deck ends on "You're all caught up" (it no longer goes round again)
  N.more = async function () {
    if (N.view !== 'news' || N._busy || N._loading || !N.loaded || !pass || N.caughtUp || Date.now() < (N._wait || 0)) return;
    N._busy = true; let added = 0;
    try {
      for (let k = 0; k < 6 && !added && pass.next !== null; k++) {
        let got;
        try { got = await page(); } catch (e) { N._wait = Date.now() + 4000; break; }
        if (got.length) { append(got); added = got.length; }
      }
      if (N.view !== 'news') return;
      if (!added && pass.next === null) { N.caughtUp = true; appendEnd(); }
    } finally { N._busy = false; }
    if (added) near(); else if (!N.caughtUp) setTimeout(near, 4100);
  };
  N.again = function () { N.loaded = false; N.caughtUp = false; N.i = 0; N.rerender(); N._loading = true; N.load(); };
  const isCover = st => !!(st && st.kind === 'cover');
  const storyCount = () => N.stories.filter(x => !isCover(x)).length;
  const count = () => N.stories.length + (N.caughtUp && N.stories.length ? 1 : 0);
  const deck = () => document.getElementById('nzDeck');
  function append(list) {
    const base = N.stories.length; list.forEach(keep);
    if (!window.S || S.tab !== 'news') return;
    const d = deck(); if (!d || d.children.length !== base) { N.rerender(); return; }
    d.insertAdjacentHTML('beforeend', list.map((st, k) => card(st, base + k)).join(''));
    refresh();
  }
  function appendEnd() {
    if (!window.S || S.tab !== 'news') return;
    const d = deck(); if (!d || d.children.length !== N.stories.length) { N.rerender(); return; }
    d.insertAdjacentHTML('beforeend', endCard());
    refresh();
  }
  // "1 pm" / "7:30 am"; in Hindi "दोपहर 1 बजे" / "सुबह 7:30 बजे" (no am/pm inside Hindi)
  const fmtTime = iso => {
    const t = Date.parse(iso || ''); if (!t) return '';
    const d = new Date(t), h = d.getHours(), m = d.getMinutes(), hm = (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '');
    return hi() ? (h < 4 ? 'रात' : h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात') + ' ' + hm + ' बजे' : hm + (h < 12 ? ' am' : ' pm');
  };
  const nextText = () => { const t = fmtTime(N.edition && N.edition.next_at); return t ? (hi() ? 'अगला संस्करण ' + t : 'Next edition at ' + t) : (hi() ? 'दिन में तीन बार नई ख़बरें' : 'New stories three times a day'); };
  function endCard() {
    const H = hi(), dv = H ? ' class="dev"' : '';
    return '<article class="nz-card nz-end" role="group" aria-roledescription="slide" aria-label="' + (H ? 'सारी ख़बरें देख लीं' : 'All caught up') + '"><div class="nz-in"><div class="nz-endin">' +
      '<span class="nz-endic" aria-hidden="true">' + I('check', 38, 2.2) + '</span>' +
      '<h2' + dv + '>' + (H ? 'आपने सारी ख़बरें देख लीं' : 'You’re all caught up') + '</h2>' +
      '<p' + dv + '>' + esc(nextText()) + '</p>' +
      '<button type="button" class="nz-again' + (H ? ' dev' : '') + '" onclick="NewsChannel.go(0)">' + I('rotate-ccw', 18, 2) + '<span>' + (H ? 'पहली ख़बर पर लौटें' : 'Back to the first story') + '</span></button>' +
      '</div></div></article>';
  }
  function near() { if (N.view === 'news' && N.loaded && storyCount() && N.i >= N.stories.length - 4) N.more(); }

  N.stop = function () { clearTimeout(viewT); flushSeen(); N._leftAt = Date.now(); };   // nothing plays in News any more
  N.setLang = function (l, fromApp) { if (l === N.lang) return; N.lang = l; try { localStorage.setItem('news.lang', l); } catch (e) {} if (!fromApp && window.setAppLang) setAppLang(l, 'news'); if (N.loaded) N.again(); else N.rerender(); }; // v24: one app language (v28: every view reloads in it)
  // The shell re-renders the tab itself; size the deck and wire swiping after every render.
  N.after = function () {
    // back on News after 20 minutes away: start from what is new (everything you saw stays seen)
    if (N._leftAt && Date.now() - N._leftAt > 20 * 60e3 && N.loaded && !N._loading) { N._leftAt = 0; N.loaded = false; N._loading = true; N.load(); return; }
    N._leftAt = 0;
    requestAnimationFrame(() => { N.size(); N.go(N.i, true); N.hint(); });
  };
  // the first time: the card slides a little to the left and back, showing the next one, and Next's arrow nudges right
  N.hint = function () {
    const d = deck();
    if (!d || storyCount() < 2 || N._hinted) return;
    try { if (localStorage.getItem('news.swiped')) return; localStorage.setItem('news.swiped', '1'); } catch (e) { return; }
    N._hinted = true; N._hintTill = Date.now() + 5000;
    const nx = document.getElementById('nzNext'); if (nx) nx.classList.add('hint');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setTimeout(() => { if (N.i !== 0 || drag) return; place(-Math.min(84, d.clientWidth * 0.2), 'slide'); setTimeout(() => { if (!drag) place(0, 'slide'); }, 560); }, 900);
  };
  N.rerender = function () {
    const r = document.getElementById('newsRoot');
    if (!r || !window.S || S.tab !== 'news') return;
    r.innerHTML = N.html();
    requestAnimationFrame(() => { N.size(); N.go(N.i, true); N.hint(); });
  };

  // v28: every photo carries its credit: who took it, the licence, where it is from (Commons, Openverse)
  const srcOf = cr => (cr && cr.source) || 'Wikimedia Commons';
  const dayName = d => {
    const t = Date.parse((d || '') + 'T12:00:00+05:30'); if (!t) return '';
    const today = new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
    if (d === today) return hi() ? 'आज' : 'Today';
    try { return new Date(t).toLocaleDateString(hi() ? 'hi-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return d; }
  };
  // v36: the photo, whole (contained) over a blurred, darkened copy of itself that fills the frame. Its src is set only
  // when the card comes near (arm), so the next few load ahead and a broken one is found before you reach it.
  function photo(st, c, kind) {
    const H = hi(), cr = st.image_credit;
    const credit = cr && cr.by ? '<small class="nz-cr">' + esc((H ? 'फ़ोटो: ' : 'Photo: ') + cr.by + (cr.license ? ' · ' + cr.license : '')) + '</small>' : '';
    if (!st.image) return '<figure class="nz-img ph"><span aria-hidden="true">' + I(kind === 'thought' ? 'sunrise' : c[3] || 'newspaper', 64, 1.4) + '</span></figure>';
    const u = esc(st.image);
    return '<figure class="nz-img"><img class="nz-bg" data-src="' + u + '" alt="" aria-hidden="true" decoding="async">' +
      '<img class="nz-fg" data-src="' + u + '" alt="' + esc((cr && cr.title) || '') + '" decoding="async" onload="NewsChannel._img(this,1)" onerror="NewsChannel._img(this,0)">' + credit + '</figure>';
  }
  function card(st, i) {
    const H = hi(), kind = st.kind === 'thought' ? 'thought' : st.reader ? 'reader' : 'story';
    const c = CAT[st.category] || CAT.life;
    const label = kind === 'thought' ? (H ? 'आज का विचार' : 'Thought of the day') : kind === 'reader' ? (H ? 'पाठक' : 'Reader') : (H ? c[1] : c[0]);
    const when = kind === 'thought' ? dayName(st.day) : ago(st.published_at);
    const src = (st.sources || []).filter(x => x && (x.name || x.link));
    const names = src.slice(0, 3).map(srcName).filter(Boolean).join(', ') + (src.length > 3 ? ' +' + (src.length - 3) : '');
    const kick = '<p class="nz-kick">' + (label ? '<b' + (H ? ' class="dev"' : '') + '>' + esc(label) + '</b>' : '') + (when ? '<span>' + esc(when) + '</span>' : '') + '</p>';
    const dev = k => (H && st[k + '_hi']) ? ' dev' : '';
    let body;
    if (kind === 'thought') {
      body = kick + '<h2 class="nz-th-t' + dev('headline') + '">' + esc(pick(st, 'headline')) + '</h2>' +
        '<b class="nz-th-k' + (H ? ' dev' : '') + '">' + (H ? 'इसके पीछे की कहानी' : 'The story behind it') + '</b>' +
        '<p class="nz-text' + dev('summary') + '">' + esc(pick(st, 'summary')) + '</p>';
    } else if (kind === 'reader') {
      const by = st.name ? (H ? st.name + ' ने भेजा, एक पाठक' : 'By ' + st.name + ', a reader') : (H ? 'एक पाठक ने भेजा' : 'By a reader');
      body = kick + '<h2 class="' + dev('headline').trim() + '">' + esc(pick(st, 'headline')) + '</h2>' +
        '<p class="nz-by' + (H ? ' dev' : '') + '">' + esc(by) + (st.kind === 'news' ? ' · ' + (H ? 'जाँचा नहीं गया' : 'not checked') : '') + '</p>' +
        '<p class="nz-text' + dev('summary') + '">' + esc(pick(st, 'summary')) + '</p>';
    } else {
      const official = src.some(x => x.official), primary = !official && src.some(x => x.primary);
      const chip = official ? '<em class="nz-off">' + (H ? 'आधिकारिक स्रोत' : 'Official source') + '</em>' : primary ? '<em class="nz-off nz-pri">' + (H ? 'मूल स्रोत' : 'Primary source') + '</em>' : '';
      const links = src.some(x => /^https?:\/\//.test(x.link || ''));
      // the reports this story is from, by name; tap for their links
      const reports = !names ? '' : links
        ? '<button type="button" class="nz-src" onclick="NewsChannel.sourcesOf(this)" aria-label="' + esc((H ? 'मूल रिपोर्टें: ' : 'Sources: ') + names) + '"><span class="nz-src-name">' + esc(names) + '</span>' + chip + I('chevron-right', 15, 2.2) + '</button>'
        : '<p class="nz-src"><span class="nz-src-name">' + esc(names) + '</span>' + chip + '</p>';
      body = kick + '<h2 class="' + dev('headline').trim() + '">' + esc(pick(st, 'headline')) + '</h2>' + reports +
        '<p class="nz-text' + dev('summary') + '">' + esc(pick(st, 'summary')) + '</p>';
    }
    return '<article class="nz-card nz-k-' + kind + (st.image ? '' : ' noimg') + '" data-i="' + i + '" data-id="' + esc(st.id || '') + '" style="--c:' + c[2] + '" role="group" aria-roledescription="slide" aria-label="' + esc(pick(st, 'headline')) + '"><div class="nz-in">' +
      photo(st, c, kind) + '<div class="nz-body">' + body + '</div></div></article>';
  }
  // the reports behind a story (tap their names under the headline): their links and the photo's credit
  N.sourcesOf = function (el) { const c = el && el.closest('.nz-card'), d = deck(); if (c && d && !moving()) N.sources(Array.prototype.indexOf.call(d.children, c)); };
  N.sources = function (i) {
    const st = N.stories[i]; if (!st || isCover(st) || st.kind === 'thought' || st.reader) return;
    const H = hi(), list = (st.sources || []).filter(x => x && /^https?:\/\//.test(x.link || ''));
    if (!list.length) return;
    document.getElementById('nzSrc')?.remove();
    const bg = document.createElement('div'); bg.className = 'nz-sheet-bg'; bg.id = 'nzSrc';
    bg.innerHTML = '<div class="nz-sheet" role="dialog" aria-modal="true" aria-label="' + (H ? 'मूल रिपोर्टें' : 'The original reports') + '"><div class="nz-grab" aria-hidden="true"></div>' +
      '<b class="nz-sh-t">' + (H ? 'मूल रिपोर्टें' : 'The original reports') + '</b><p class="nz-sh-p">' + (H ? 'यह ख़बर इन रिपोर्टों का सार है।' : 'This story is a summary of these reports.') + '</p>' +
      list.map(x => '<a class="nz-sh" href="' + esc(x.link) + '" target="_blank" rel="noopener nofollow">' + I('external-link', 22) + '<span><b>' + esc(srcName(x)) + (x.official ? ' <em class="nz-off">' + (H ? 'आधिकारिक' : 'Official') + '</em>' : x.primary ? ' <em class="nz-off nz-pri">' + (H ? 'मूल स्रोत' : 'Primary source') + '</em>' : '') + '</b><small>' + esc(x.title || x.link) + '</small></span></a>').join('') +
      (st.image_credit && /^https:\/\//.test(st.image_credit.page || '') ? '<a class="nz-sh" href="' + esc(st.image_credit.page) + '" target="_blank" rel="noopener nofollow">' + I('image', 22) + '<span><b>' + (H ? 'फ़ोटो' : 'Photo') + '</b><small>' + esc(st.image_credit.by + ' · ' + st.image_credit.license + ' · ' + srcOf(st.image_credit)) + '</small></span></a>' : '') +
      '<p class="nz-sh-how">' + (H ? 'इसकी हर संख्या इन रिपोर्टों से मिलाई जाती है, और इनका कोई वाक्य या फ़ोटो कॉपी नहीं होता।' : 'Every number in it is checked against these reports, and no sentence or photo of theirs is copied.') + ' <a href="mailto:hello@brodoit.com?subject=' + encodeURIComponent('News correction: ' + (st.headline || '')) + '">' + (H ? 'ग़लती बताएँ' : 'Report a mistake') + '</a></p>' +
      '<button type="button" class="b-btn ghost wide nz-sh-x">' + (H ? 'बंद करें' : 'Close') + '</button></div>';
    document.body.appendChild(bg);
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('.nz-sh-x')) close(); });
    const x = bg.querySelector('.nz-sh-x'); if (x) x.focus({ preventScroll: true });
  };

  // ── v36: Share. The phone's share sheet with the headline, one line of the story and its link; where there is no
  // share sheet (most computers), the link is copied. The server keeps a shared story for 90 days (POST /api/news/share),
  // so the link still opens after the story leaves the feed.
  const linkOf = st => /^(th|rd)_/.test(st.id || '') ? SITE + '/?tab=news&s=' + encodeURIComponent(st.id) : SITE + '/n/' + encodeURIComponent(st.id);
  function oneLine(st) {
    const s = String(pick(st, 'summary') || '').replace(/\s+/g, ' ').trim();
    const m = s.match(/^.{24,240}?[.!?।](?=\s|$)/);
    let t = m ? m[0] : s;
    if (t.length > 240) t = t.slice(0, 237).replace(/\s+\S*$/, '') + '…';
    return t;
  }
  async function copyText(t) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch (e) { /* blocked: the old way */ }
    try {
      const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return !!ok;
    } catch (e) { return false; }
  }
  // a small note above the bar (never the app's toast, which redraws the whole tab)
  function say(msg) {
    let el = document.getElementById('nzToast');
    if (!el) { el = document.createElement('div'); el.id = 'nzToast'; el.className = 'nz-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    const b = document.getElementById('nzBar'), r = b && b.getBoundingClientRect();
    el.style.bottom = (r && r.top > 0 ? Math.round(innerHeight - r.top + 10) : 96) + 'px';
    el.textContent = msg; el.classList.toggle('dev', hi());
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
    clearTimeout(say.t); say.t = setTimeout(() => el.classList.remove('on'), 2600);
  }
  N.share = async function (k) {
    const st = N.stories[k == null ? N.i : k]; if (!st || !st.id) return;
    const H = hi(), url = linkOf(st), title = pick(st, 'headline'), text = oneLine(st);
    if (!/^(th|rd)_/.test(st.id)) { try { fetch('/api/news/share', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: st.id }) }).catch(() => {}); } catch (e) { /* offline: the link works anyway */ } }
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }   // closed the sheet: nothing more to do
    }
    const ok = await copyText(url);
    say(ok ? (H ? 'लिंक कॉपी हो गया' : 'Link copied') : url);
    return ok ? 'copied' : 'shown';
  };

  // a photo loaded (it fades in, and the story can now count as seen) or failed (the story leaves the deck, unseen)
  N._img = function (el, ok) {
    const c = el && el.closest('.nz-card'), d = deck(); if (!c || !d || c.parentNode !== d) return;
    const st = N.stories[Array.prototype.indexOf.call(d.children, c)];
    if (!st || st.id !== c.dataset.id) return;
    if (ok) { c.querySelector('.nz-img').classList.add('ok'); st._ok = true; if (st === N.stories[N.i]) watch(); return; }
    if (st._pin) {   // a story someone sent you stays, on its section's colour
      const box = c.querySelector('.nz-img'), cc = CAT[st.category] || CAT.life;
      box.className = 'nz-img ph'; box.innerHTML = '<span aria-hidden="true">' + I(cc[3] || 'newspaper', 64, 1.4) + '</span>';
      c.classList.add('noimg'); st.image = null; c._fit = ''; fitNear(); watch(); return;
    }
    drop(c, st);
  };
  function drop(c, st) {
    const d = deck(), k = Array.prototype.indexOf.call(d.children, c); if (k < 0) return;
    const cur = k === N.i;
    c.remove(); N.stories.splice(k, 1); st._bad = true;
    for (let j = k; j < d.children.length; j++) d.children[j].dataset.i = j;
    if (k < N.i) N.i--;
    if (!N.stories.length) {
      if (!N.caughtUp && pass && pass.next !== null) { N.rerender(); N.more(); }
      else { N.caughtUp = true; N.rerender(); }
      return;
    }
    N.i = Math.max(0, Math.min(count() - 1, N.i));
    place(0, cur ? 'fade' : 'keep');
    refresh();
  }

  N.html = function () {
    const H = hi(), list = N.stories, n = list.length, dv = H ? ' class="dev"' : '';
    const empty = (icon, title, sub) => '<div class="nz"><div class="nz-empty" id="nzEmpty"><span class="nz-emic" aria-hidden="true">' + I(icon, 40, 1.8) + '</span><b' + dv + '>' + title + '</b>' + (sub ? '<span' + dv + '>' + sub + '</span>' : '') + '</div></div>';
    // v37: two small icons inside the story (bottom right): Share and Next
    const bar = on => '<div class="nz-fab" id="nzBar">' +
      '<button type="button" class="nz-ic nz-share" id="nzShare" onclick="NewsChannel.share()"' + (on ? '' : ' disabled') + ' aria-label="' + (H ? 'यह ख़बर साझा करें' : 'Share this story') + '">' + I('share-2', 18, 2.1) + '</button>' +
      '<button type="button" class="nz-ic nz-next' + (Date.now() < (N._hintTill || 0) ? ' hint' : '') + '" id="nzNext" onclick="NewsChannel.next()"' + (on ? '' : ' disabled') + ' aria-label="' + (H ? 'अगली ख़बर' : 'Next story') + '">' + I('arrow-right', 20, 2.3) + '</button></div>';
    if (!N.loaded) return '<div class="nz"><div class="nz-stage" id="nzStage"><div class="nz-deck" id="nzDeck"><article class="nz-card skel"><div class="nz-in"><div class="nz-img"></div><div class="nz-body"><i></i><i></i><i></i><i></i><i></i></div></div></article></div>' + bar(false) + '</div></div>';
    if (!n && N.err) return empty('wifi-off', H ? 'ख़बरें लोड नहीं हुईं' : 'Couldn’t load the news', H ? 'थोड़ी देर में अपने आप फिर कोशिश होगी' : 'Trying again by itself in a moment');
    if (!n && N.caughtUp) return empty('check-circle', H ? 'आपने सारी ख़बरें देख लीं' : 'You’re all caught up', esc(nextText()));
    if (!n) return empty('newspaper', H ? 'ख़बरें आ रही हैं' : 'Stories are on the way', '');
    return '<div class="nz"><div class="nz-stage" id="nzStage"><div class="nz-prog" aria-hidden="true"><i id="nzProg"></i></div>' +
      '<div class="nz-deck" id="nzDeck" role="region" aria-roledescription="carousel" aria-label="' + (H ? 'ख़बरें' : 'News') + '">' + list.map((st, i) => card(st, i)).join('') + (N.caughtUp ? endCard() : '') + '</div>' +
      bar(true) + '</div></div>';
  };

  // The stage (deck + bar) fills the space between the top of the tab and the app's tab bar on any phone.
  N.size = function () {
    const tabs = document.querySelector('.tabs.page-t') || document.querySelector('.rd-tabbar'); const r = tabs && tabs.getBoundingClientRect();
    const bottom = r && r.top > innerHeight * 0.6 ? r.top : innerHeight - 16;
    const em = document.getElementById('nzEmpty'); if (em) em.style.minHeight = Math.max(200, Math.floor(bottom - em.getBoundingClientRect().top - 4)) + 'px';
    const s = document.getElementById('nzStage'), d = deck(); if (!s || !d) return;
    // a computer (no tab bar at the bottom): the shell's grid can push the column down until the deck is sized, so the
    // stage takes the window's height less the header's room rather than measuring from where it sits now
    const top = s.getBoundingClientRect().top, phone = bottom !== innerHeight - 16;
    s.style.height = Math.max(300, Math.min(900, Math.floor(phone ? bottom - top : innerHeight - 40 - Math.min(top, 120)))) + 'px';
    if (!d._wired) wire(d);
    fitNear();
    if (document.fonts && !N._fontsHook) { N._fontsHook = true; document.fonts.ready.then(() => { fitNear(); }); }
  };

  // ── v36: the sideways deck. Every card sits at (its index − the current one) × the deck's width; a drag adds the
  // finger's offset. Only the card on screen and its two neighbours are visible; the rest wait, hidden, off to the side.
  let drag = null, sup = 0, wheel = { x: 0, lock: 0, t: 0 };
  const moving = () => !!(drag && drag.axis === 'x') || Date.now() < sup;
  function place(dx, mode) {
    const d = deck(); if (!d) return;
    const W = d.clientWidth || innerWidth, cards = d.children;
    if (mode === 'slide') { d.classList.add('anim'); clearTimeout(N._animT); N._animT = setTimeout(() => d.classList.remove('anim'), 520); }
    else if (mode !== 'keep') { clearTimeout(N._animT); d.classList.remove('anim'); }
    for (let k = 0; k < cards.length; k++) {
      const c = cards[k], off = k - N.i + dx / W;
      if (Math.abs(off) >= 1.5) {
        if (c._far !== 1) { c._far = 1; c.style.visibility = 'hidden'; c.style.transform = 'translateX(' + (off < 0 ? -2 : 2) * W + 'px)'; }
      } else {
        c._far = 0; c.style.visibility = '';
        c.style.transform = 'translate3d(' + (off * W).toFixed(1) + 'px,0,0) scale(' + (1 - Math.min(1, Math.abs(off)) * 0.04).toFixed(4) + ')';
      }
      const cur = k === N.i;
      if (c._cur !== cur) { c._cur = cur; c.inert = !cur; c.setAttribute('aria-hidden', cur ? 'false' : 'true'); c.classList.toggle('cur', cur); }
    }
    if (mode === 'fade') { const c = cards[N.i]; if (c) { c.classList.remove('nz-fadein'); void c.offsetWidth; c.classList.add('nz-fadein'); } }
  }
  // the card on screen right now, wherever an animation has got to (so a finger can catch a card mid-slide)
  function liveOffset() {
    const d = deck(), c = d && d.children[N.i]; if (!c || !d.classList.contains('anim')) return 0;
    try { return new DOMMatrixReadOnly(getComputedStyle(c).transform).m41; } catch (e) { return 0; }
  }
  function wire(d) {
    d._wired = true;
    const W = () => d.clientWidth || innerWidth;
    d.addEventListener('pointerdown', e => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !N.stories.length) return;
      const base = liveOffset();
      if (base) place(base, 'none');
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, base, dx: base, axis: null, pts: [[performance.now(), e.clientX]] };
    });
    d.addEventListener('pointermove', e => {
      const g = drag; if (!g || e.pointerId !== g.id) return;
      const mx = e.clientX - g.x, my = e.clientY - g.y;
      if (!g.axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        g.axis = Math.abs(mx) > Math.abs(my) * 1.1 ? 'x' : 'y';
        if (g.axis === 'y') { if (g.base) place(0, 'slide'); drag = null; return; }   // up and down: the page's (or a long story's)
        try { d.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        d.classList.add('dragging'); try { getSelection().removeAllRanges(); } catch (x) { /* ignore */ }
      }
      let dx = g.base + mx;
      // past the first story, or the last card: the deck gives a little and pulls back
      if ((N.i === 0 && dx > 0) || (N.i >= count() - 1 && dx < 0)) dx = dx * 0.32;
      g.dx = dx; g.pts.push([performance.now(), e.clientX]); if (g.pts.length > 8) g.pts.shift();
      if (!g.raf) g.raf = requestAnimationFrame(() => { g.raf = 0; if (drag === g) place(g.dx, 'none'); });
    });
    const end = e => {
      const g = drag; if (!g || e.pointerId !== g.id) return;
      drag = null; if (g.raf) cancelAnimationFrame(g.raf);
      if (g.axis !== 'x') { if (g.base) place(0, 'slide'); return; }   // a tap
      d.classList.remove('dragging'); sup = Date.now() + 350;
      const now = performance.now(), pts = g.pts.filter(p => now - p[0] < 120), v = pts.length > 1 ? (pts[pts.length - 1][1] - pts[0][1]) / Math.max(16, pts[pts.length - 1][0] - pts[0][0]) : 0;
      let to = N.i;
      if (e.type === 'pointerup') {
        if ((g.dx < -W() * 0.3 && v < 0.25) || (v < -0.35 && g.dx < -12)) to = N.i + 1;
        else if ((g.dx > W() * 0.3 && v > -0.25) || (v > 0.35 && g.dx > 12)) to = N.i - 1;
      }
      try { localStorage.setItem('news.swiped', '1'); } catch (x) { /* ignore */ }
      N.go(to);
    };
    d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
    // a tap that ended a drag is not a tap on what was under the finger
    d.addEventListener('click', e => { if (Date.now() < sup) { e.preventDefault(); e.stopPropagation(); } }, true);
    // a sideways swipe on a trackpad moves one story per swipe
    d.addEventListener('wheel', e => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || drag) return;
      e.preventDefault();
      const t = Date.now(); if (t - wheel.t > 220) wheel.x = 0; wheel.t = t;
      if (t < wheel.lock) return;
      wheel.x += e.deltaX;
      if (Math.abs(wheel.x) > 42) { const s = wheel.x > 0 ? 1 : -1; wheel.x = 0; wheel.lock = t + 480; N.go(N.i + s); }
    }, { passive: false });
  }
  N.next = function () { try { localStorage.setItem('news.swiped', '1'); } catch (e) { /* ignore */ } N.go(N.i + 1); };
  N.prev = function () { N.go(N.i - 1); };
  // arrow keys (and PageUp/PageDown, j/k, Home/End) on a computer, anywhere on the News tab
  document.addEventListener('keydown', e => {
    if (!window.S || S.tab !== 'news' || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || !deck() || document.getElementById('nzSrc')) return;
    const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', 'j'].includes(k)) { e.preventDefault(); N.next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'k'].includes(k)) { e.preventDefault(); N.prev(); }
    else if (k === 'Home') { e.preventDefault(); N.go(0); }
    else if (k === 'End') { e.preventDefault(); N.go(count() - 1); }
  });

  // Fit one card: the photo starts at 42% of the card. The whole story is always there to read, never cut: if it is
  // long the type steps down, the photo gives way to 32%, the type steps down once more and the photo to 24%; only if
  // all that is not enough (the smallest phones, a long Hindi story) does the story scroll inside its card. Landscape
  // phones lay the card out side by side (photo left). Only the cards around the one in view are fitted.
  function fit(cardEl) {
    const H = cardEl.clientHeight, body = cardEl.querySelector('.nz-body'), img = cardEl.querySelector('.nz-img');
    if (!H || !body || cardEl.classList.contains('nz-end')) return;
    cardEl.classList.remove('sm', 'xs', 'xxs', 'scroll');
    const row = getComputedStyle(cardEl.querySelector('.nz-in') || cardEl).display === 'grid';
    const over = () => body.scrollHeight > body.clientHeight + 1;
    let ih = img && !row ? Math.round(H * 0.42) : 0;
    if (img) img.style.height = row ? '' : ih + 'px';
    const shrink = floor => { while (img && !row && over() && ih > H * floor) { ih -= 8; img.style.height = ih + 'px'; } };
    if (over()) cardEl.classList.add('sm');
    if (over()) cardEl.classList.add('xs');
    shrink(0.32);
    if (over()) cardEl.classList.add('xxs');
    shrink(0.24);
    if (over()) cardEl.classList.add('scroll');
    cardEl._fit = H + 'x' + cardEl.clientWidth;
  }
  function fitNear() {
    const d = deck(); if (!d) return;
    const cards = d.children;
    for (let k = Math.max(0, N.i - 2); k <= Math.min(cards.length - 1, N.i + 3); k++) { const c = cards[k]; if (c && c.classList.contains('nz-card') && c._fit !== c.clientHeight + 'x' + c.clientWidth) fit(c); }
  }
  // load the photos of the card on screen, the one before and the next three (so a broken one is found early)
  function arm() {
    const d = deck(); if (!d) return;
    const cards = d.children;
    for (let k = Math.max(0, N.i - 1); k <= Math.min(cards.length - 1, N.i + 3); k++) {
      const c = cards[k]; if (!c || c._armed) continue; c._armed = true;
      c.querySelectorAll('img[data-src]').forEach(im => { im.src = im.getAttribute('data-src'); im.removeAttribute('data-src'); });
    }
  }
  function progress() { const b = document.getElementById('nzProg'); if (b) b.style.width = Math.round(Math.min(1, (N.i + 1) / Math.max(1, count())) * 100) + '%'; }
  function bar() {
    const n = count(), p = document.getElementById('nzPrev'), x = document.getElementById('nzNext'), s = document.getElementById('nzShare');
    if (p) p.disabled = N.i <= 0;
    if (x) x.disabled = N.i >= n - 1;
    if (s) { const on = N.i < N.stories.length; s.disabled = !on; s.classList.toggle('off', !on); }
  }
  function refresh() { place(0, 'keep'); fitNear(); arm(); bar(); progress(); watch(); near(); }
  function moved(was) {
    fitNear(); arm(); bar(); near(); progress(); if (was === 0 && N.i > 0) hold();
    if (N.view === 'news') for (let k = was; k < N.i; k++) if (shown(N.stories[k])) markSeen(N.stories[k]); // swiped past: seen
    watch();
  }
  N.go = function (k, instant) {
    const d = deck(); if (!d) return;
    const was = N.i;
    N.i = Math.max(0, Math.min(count() - 1, k | 0));
    place(0, instant ? 'none' : Math.abs(N.i - was) > 1 ? 'fade' : 'slide');
    moved(was);
  };
  window.addEventListener('resize', () => { if (window.S && S.tab === 'news') { N.size(); N.go(N.i, true); } });

  // The phone's back button: once you have moved past the first story, back brings you to the newest story first.
  // One history entry at most (added when you leave the first story), never one per card; at the first story, or on
  // another tab, back does what it always did.
  function hold() {
    if (N._held || !window.S || S.tab !== 'news') return;
    try { if (!(history.state && history.state.nz)) history.pushState({ nz: 1 }, ''); N._held = true; } catch (e) { /* ignore */ }
  }
  window.addEventListener('popstate', () => {
    if (history.state && history.state.nz) { N._held = true; return; }
    if (!N._held) return;
    N._held = false;
    if (window.S && S.tab === 'news' && N.i > 0) N.go(0, N.i > 3);
    else { try { history.back(); } catch (e) { /* ignore */ } }   // the entry was ours alone: step past it
  });

})();
