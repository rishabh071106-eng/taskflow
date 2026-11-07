// v21 "one app": the mini-apps (/lang, /mind, /code) open inside Brodoit in a full-screen layer, not as a new page, so
// moving between the app and a game or lesson never reloads anything and the phone's back button comes straight back.
//   BroFrame.open(url)   slides in a layer holding the page (same origin iframe, microphone and autoplay allowed). One
//                        history entry (?frame=<page>, so a reload, a deep link or a notification can open it again).
//   BroFrame.close(o)    removes it (o.url: then go there in the app: a tab, the Learn hub, …)
// The page inside (app/inframe.js) asks the layer to close (postMessage 'bd-close' {url}) when it leads back to the app,
// and reports XP ('brodoit-xp' {xp}). The phone's back asks the page first (bdFrameBack: lesson → course); at its top the
// layer closes. Links to the mini-apps are caught here, so the Learn hub and every other link use the layer.
// localStorage bd.frame = 'off' goes back to plain page loads. If the whole app is ever loaded inside the layer (an exit a
// page did not route through bdGo), it closes the layer and opens there instead.
(function () {
  'use strict';
  var MINI = /^\/(lang|mind|code)(\/|$)/;
  try {
    if (window.parent !== window && window.parent.BroFrame && window.parent.location.origin === location.origin) {
      window.__bdNested = true;
      document.documentElement.style.visibility = 'hidden';
      window.parent.postMessage({ type: 'bd-close', url: location.pathname + location.search + location.hash }, location.origin);
      return;
    }
  } catch (e) { /* not ours */ }
  var off = function () { try { return localStorage.getItem('bd.frame') === 'off'; } catch (e) { return false; } };
  var reduce = function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  var css = document.createElement('style');
  css.textContent = '.bd-frame{position:fixed;inset:0;z-index:9000;display:flex;background:var(--bd-bg,var(--bg,#fff))}'
    + '.bd-frame iframe{flex:1;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}'
    + '.bd-frame.in{animation:bdFrIn .24s cubic-bezier(.2,.8,.2,1)}'
    + '.bd-frame.out{animation:bdFrOut .18s ease-in forwards}'
    + '@keyframes bdFrIn{from{transform:translateX(6%);opacity:0}to{transform:none;opacity:1}}'
    + '@keyframes bdFrOut{to{transform:translateX(6%);opacity:0}}'
    + '.bd-frame-xp{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);z-index:2;padding:8px 14px;border-radius:999px;background:#16a34a;color:#fff;font:800 14px/1 inherit;box-shadow:0 6px 18px rgba(0,0,0,.2);pointer-events:none;animation:bdFrXp 1.6s ease forwards}'
    + '@keyframes bdFrXp{0%{opacity:0;transform:translate(-50%,-6px)}12%,80%{opacity:1;transform:translate(-50%,0)}100%{opacity:0}}'
    + 'body.bd-framed{overflow:hidden}body.bd-framed #app{visibility:hidden}'
    + '@media (prefers-reduced-motion:reduce){.bd-frame.in,.bd-frame.out{animation:none}}';
  (document.head || document.documentElement).appendChild(css);

  var F = window.BroFrame = { el: null, url: '', isOpen: function () { return !!F.el; } };
  var frameWin = function () { try { return F.el && F.el.querySelector('iframe').contentWindow; } catch (e) { return null; } };
  var withFrame = function (u) { var here = new URL(location.href); here.searchParams.set('frame', u.pathname + u.search + u.hash); return here.pathname + here.search; };
  var withoutFrame = function () { var here = new URL(location.href); here.searchParams.delete('frame'); return here.pathname + here.search + here.hash; };

  F.open = function (url, o) {
    o = o || {};
    var u; try { u = new URL(url, location.href); } catch (e) { return false; }
    if (u.origin !== location.origin || !MINI.test(u.pathname) || off() || !document.body) { location.href = u.href; return false; }
    var path = u.pathname + u.search + u.hash;
    if (F.el) { try { frameWin().location.replace(path); } catch (e) { F.el.querySelector('iframe').src = path; } F.url = path; return true; }
    var wrap = document.createElement('div'); wrap.className = 'bd-frame' + (reduce() ? '' : ' in');
    var fr = document.createElement('iframe');
    fr.setAttribute('allow', 'microphone; autoplay; fullscreen; screen-wake-lock');
    fr.setAttribute('title', 'Brodoit');
    fr.src = path;
    wrap.appendChild(fr); document.body.appendChild(wrap);
    F.el = wrap; F.url = path; F.scrollY = window.scrollY;
    document.body.classList.add('bd-framed');
    if (!o.fromHistory) { try { history.pushState(Object.assign({}, history.state || {}, { bdFrame: path }), '', withFrame(u)); } catch (e) { /* no history */ } }
    else { try { history.replaceState(Object.assign({}, history.state || {}, { bdFrame: path }), '', withFrame(u)); } catch (e) { /* ignore */ } }
    try { fr.focus(); } catch (e) { /* ignore */ }
    return true;
  };
  F.close = function (o) {
    o = o || {};
    if (!F.el) { if (o.url) route(o.url); return; }
    var el = F.el; F.el = null; F.url = '';
    var done = function () { try { el.remove(); } catch (e) { /* gone */ } };
    if (reduce()) done(); else { el.classList.remove('in'); el.classList.add('out'); setTimeout(done, 190); }
    document.body.classList.remove('bd-framed');
    try { window.scrollTo(0, F.scrollY || 0); } catch (e) { /* ignore */ }
    var after = o.url ? function () { route(o.url); } : null;
    if (!o.fromHistory && history.state && history.state.bdFrame) {
      // step off the layer's own history entry first; the app route (if any) follows once that has happened
      F.skipPop = true; F.afterPop = after;
      try { history.back(); } catch (e) { F.skipPop = false; F.afterPop = null; if (after) after(); }
      setTimeout(function () { if (F.afterPop) { var f = F.afterPop; F.afterPop = null; F.skipPop = false; f(); } }, 600);
    } else {
      try { history.replaceState(Object.assign({}, history.state || {}, { bdFrame: undefined }), '', withoutFrame()); } catch (e) { /* ignore */ }
      if (after) after();
    }
    if (typeof window.render === 'function' && window.S && window.S.tab === 'courses') { try { window.render(); } catch (e) { /* ignore */ } } // progress made inside shows at once
  };
  // a place in the app: /?tab=…&hub=… → that tab (and Learn hub); another page of the site → load it
  function route(url) {
    var u; try { u = new URL(url, location.href); } catch (e) { return; }
    if (u.origin !== location.origin) { location.href = u.href; return; }
    if (MINI.test(u.pathname)) { F.open(u.href); return; }
    if (u.pathname !== '/') { location.href = u.href; return; }
    var p = u.searchParams, tab = p.get('tab'), S = window.S;
    // v38: a lesson (a notification, a shared link): /?bk=<id>&c=<card>&hl=hi opens it over the Lessons tab
    if (p.get('bk') && window.Lessons && S) { try { if (S.tab !== 'books' && typeof window.switchTab === 'function') window.switchTab('books'); } catch (e) { /* ignore */ } window.Lessons.open(p.get('bk'), p.get('c') != null ? +p.get('c') || 0 : null, false, p.get('hl') || undefined); return; }
    if (!tab || !S || typeof window.render !== 'function') return;
    var t = tab === 'learn' ? 'courses' : tab === 'you' ? 'profile' : tab, hub = p.get('hub');
    var same = S.tab === t && (t !== 'courses' || (S.learnHub || null) === (hub || null));
    if (same && !p.get('persona') && !p.get('s')) return;
    if (typeof window.switchTab === 'function' && S.tab !== t) { try { window.switchTab(t); } catch (e) { S.tab = t; } } else S.tab = t; // switchTab renders
    if (t === 'courses') {
      if (hub && ['games', 'coding', 'languages'].indexOf(hub) >= 0) { S.learnHub = hub; try { history.pushState({ learn: 1, hub: hub }, '', '/?tab=learn&hub=' + hub); } catch (e) { /* ignore */ } }
      else S.learnHub = null;
    }
    // "Talk to Bro in Spanish" (Languages): Bro's language-practice mode for that course
    if (t === 'bro' && p.get('persona') && window.BroVoice) { try { if (p.get('course')) window.BroVoice.setCourse(p.get('course')); window.BroVoice.setPersona(p.get('persona')); } catch (e) { /* ignore */ } }
    try { window.render(); window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    // v21: a story (a notification, a shared link) opens on that story
    if (t === 'news' && p.get('s') && window.NewsChannel && window.NewsChannel.open) { try { window.NewsChannel.open(p.get('s')); } catch (e) { /* ignore */ } }
  }
  F.route = route;
  // go anywhere from app code: a mini-app → the layer, a place in the app → that tab, else a plain page load
  F.go = function (url) { var u; try { u = new URL(url, location.href); } catch (e) { return; } if (u.origin === location.origin && MINI.test(u.pathname) && !off()) F.open(u.href); else if (u.origin === location.origin && u.pathname === '/' && u.searchParams.get('tab')) route(u.href); else location.href = u.href; };
  // the phone's back: the page inside steps back first (lesson → course); at its top the layer closes
  window.addEventListener('popstate', function (e) {
    if (F.skipPop) { F.skipPop = false; if (F.afterPop) { var f = F.afterPop; F.afterPop = null; f(); } return; }
    if (F.el) {
      var handled = false; var w = frameWin();
      try { handled = !!(w && typeof w.bdFrameBack === 'function' && w.bdFrameBack()); } catch (err) { handled = false; }
      if (handled) { try { history.pushState(Object.assign({}, history.state || {}, { bdFrame: F.url }), '', withFrame(new URL(F.url, location.href))); } catch (err) { /* ignore */ } return; }
      F.close({ fromHistory: true });
    } else if (e.state && e.state.bdFrame) F.open(e.state.bdFrame, { fromHistory: true }); // forward again
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    var w = frameWin(); if (!w || e.source !== w) return;
    if (e.data.type === 'bd-close') F.close({ url: String(e.data.url || '') });
    else if (e.data.type === 'brodoit-xp' && F.el) {
      var xp = +e.data.xp || 0; if (!xp) return;
      var b = document.createElement('div'); b.className = 'bd-frame-xp'; b.textContent = '+' + xp + ' XP';
      F.el.appendChild(b); setTimeout(function () { try { b.remove(); } catch (err) { /* gone */ } }, 1700);
    }
  });
  // every link to a mini-app opens in the layer
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || off()) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var u; try { u = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
    if (u.origin !== location.origin || !MINI.test(u.pathname)) return;
    e.preventDefault(); F.open(u.href);
  }, true);
  // ?frame=/lang/… (a reload, a deep link, a notification) opens that page in the layer
  var start = function () {
    var q; try { q = new URL(location.href).searchParams.get('frame'); } catch (e) { q = null; }
    if (q && MINI.test(q.split('?')[0])) { try { history.replaceState(Object.assign({}, history.state || {}, { bdFrame: undefined }), '', withoutFrame()); } catch (e) { /* ignore */ } F.open(q); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // v21: a tapped notification routes the app that is already open (a tab, a lesson in the layer, a story)
  try { if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { var d = e.data || {}; if (d.type === 'bd-route' && typeof d.url === 'string' && d.url.charAt(0) === '/') F.go(d.url); }); } catch (e) { /* no service worker */ }
})();
