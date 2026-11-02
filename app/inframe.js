// v21 "one app": loaded first (no defer) by every mini-app page (/lang, /mind, /code). When the page runs inside
// Brodoit's layer (app/frame.js), links and exits back to the app close the layer instead of loading the whole app inside
// it, and a page inside a mini-app replaces the one before (the layer keeps exactly one history entry; the phone's back
// button asks bdFrameBack() first). Opened on its own (a pasted link, a notification), the page behaves as before.
//   window.bdFramed      true inside Brodoit's layer
//   window.bdGo(url, {replace}) go somewhere: a mini-app page loads here; anything else closes the layer and opens it in
//                        the app (on its own the page navigates as before, replacing itself with replace: true)
//   window.bdFrameBack() the phone's back inside the layer: follows the page's own back chevron when it leads to another
//                        mini-app page (lesson → course) and returns true; false = the layer closes. A page can set
//                        window.bdBackHandler = () => boolean to decide itself.
(function () {
  'use strict';
  var framed = false;
  try { framed = window.parent !== window && window.parent.location.origin === location.origin && !!window.parent.BroFrame; } catch (e) { framed = false; }
  window.bdFramed = framed;
  var MINI = /^\/(lang|mind|code|astro)(\/|$)/;
  function go(url, o) {
    var u; try { u = new URL(url, location.href); } catch (e) { return; }
    if (u.origin !== location.origin) { location.href = u.href; return; }
    if (!framed) { if (o && o.replace) location.replace(u.href); else location.href = u.href; return; }
    if (MINI.test(u.pathname)) { location.replace(u.href); return; }
    try { window.parent.postMessage({ type: 'bd-close', url: u.pathname + u.search + u.hash }, location.origin); } catch (e) { location.href = u.href; }
  }
  window.bdGo = go;
  window.bdFrameBack = function () {
    try { if (typeof window.bdBackHandler === 'function') return !!window.bdBackHandler(); } catch (e) { /* the chevron decides */ }
    var a = document.querySelector('.bd-top .bd-back, .ui-back, .bd-back');
    var href = a && a.getAttribute('href');
    if (!href) return false;
    var u; try { u = new URL(href, location.href); } catch (e) { return false; }
    if (u.origin !== location.origin || !MINI.test(u.pathname)) return false;
    location.replace(u.href);
    return true;
  };
  if (!framed) return;
  document.documentElement.classList.add('bd-in-frame');
  // links: within the mini-apps the page is replaced; to the app the layer closes
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var href = a.getAttribute('href'); if (!href || href.charAt(0) === '#') return;
    var u; try { u = new URL(href, location.href); } catch (err) { return; }
    if (u.origin !== location.origin) return;
    e.preventDefault(); go(u.href);
  }, true);
})();
