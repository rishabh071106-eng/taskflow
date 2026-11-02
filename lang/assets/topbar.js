// Brodoit mini-app chrome — shared by /lang and /mind. Classic script (load with `defer`, after /app/icons.js) so
// ES-module pages and plain pages get the same markup from one place. Rules: /DESIGN.md (Navigation).
//
//   window.bdTopbar({ back, backLabel, backIcon, title, subtitle, right, mount, inner })
//     → <header class="bd-top"> with exactly one way out: a back chevron (‹) to `back`, or, when the page has no
//     parent, to this mini-app's list in the Learn tab. Then the title (optional) and a right slot (optional).
//     `backLabel` names the place the chevron returns to ("Languages" → aria-label "Back to Languages"); a label that
//     already reads as an action ("Quit lesson", "Back to course", or a Hindi label) is used as is.
//     `backIcon: 'x'` draws a close mark instead of the chevron (inside a lesson). `mount` (default: prepend to body)
//     is an element to prepend into; `inner: true` returns only the inner markup. `title`/`right` are HTML.
//   window.bdLearnHref — this mini-app's list in the Learn tab (Games, Coding or Languages).
//   window.bdTitleOnScroll(el) — keeps the bar's title hidden while the page's large title `el` is on screen and
//     fades it in once that title scrolls under the bar (iOS-style large title).
//
// Back guard: when a mini-app page is opened cold (push, app shortcut, pasted link) the tab has no
// history, so the Android back button closes the app. We insert one entry so the first back press lands
// on the Brodoit app instead.
(function () {
  // v15: each mini-app returns to its own list in the Learn tab (Games, Coding, Languages)
  var HUB = /^\/mind\//.test(location.pathname) ? 'games' : /^\/lang\//.test(location.pathname) ? 'languages' : /^\/code\//.test(location.pathname) ? 'coding' : '';
  // v34: Jyotish (/astro) opens from the You tab and returns there
  var ASTRO = /^\/astro\//.test(location.pathname);
  var HOME = ASTRO ? '/?tab=you' : '/?tab=learn' + (HUB ? '&hub=' + HUB : '');
  var HOME_LABEL = ASTRO ? 'You' : { games: 'Games', languages: 'Languages', coding: 'Coding' }[HUB] || 'Learn';
  window.bdLearnHref = HOME;

  var ICON = {
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  function ic(name, size) {
    try { if (window.ico && (!window.ico.has || window.ico.has(name))) { var s = window.ico(name, size); if (s) return s; } } catch (e) { /* fall through */ }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function label(l) {
    l = String(l || '').trim();
    if (!l) return 'Back to ' + HOME_LABEL;
    return /^(back|quit|close|exit|leave)\b/i.test(l) || /[^\x00-\x7f]/.test(l) ? l : 'Back to ' + l;
  }

  function inner(o) {
    o = o || {};
    // One exit only: the chevron goes to the parent when there is one, else to this mini-app's list in Learn.
    var href = o.back || HOME;
    var h = '<a class="bd-back press" href="' + esc(href) + '" aria-label="' + esc(o.back ? label(o.backLabel) : label(o.backLabel || HOME_LABEL)) + '">' + ic(o.backIcon === 'x' ? 'x' : 'chevron-left', 24) + '</a>';
    h += '<div class="bd-title">' + (o.title || '') + (o.subtitle ? '<small>' + o.subtitle + '</small>' : '') + '</div>';
    h += '<div class="bd-right">' + (o.right || '') + '</div>';
    return h;
  }
  window.bdTopbar = function (o) {
    o = o || {};
    if (o.inner) return inner(o);
    var top = document.createElement('header');
    top.className = 'bd-top';
    top.innerHTML = '<div class="bd-top-in">' + inner(o) + '</div>';
    (o.mount || document.body).prepend(top);
    return top;
  };

  // ---- large title → small bar title once it scrolls under the bar ----
  var titleIO = null;
  window.bdTitleOnScroll = function (el) {
    var bar = document.querySelector('.bd-top');
    if (!el || !bar) return;
    bar.classList.add('bd-collapse');
    if (titleIO) titleIO.disconnect();
    try {
      titleIO = new IntersectionObserver(function (es) {
        var e = es[0]; bar.classList.toggle('bd-titled', !e.isIntersecting && e.boundingClientRect.top < 120);
      }, { rootMargin: '-64px 0px 0px 0px' });
      titleIO.observe(el);
    } catch (e) { bar.classList.add('bd-titled'); }
  };

  // ---- back guard ---- (v21: not inside Brodoit's layer: the layer owns the phone's back button there)
  if (!window.bdFramed) try {
    // Cold open = no same-origin page before us in this tab (push, shortcut, pasted link, fresh tab).
    var ref = ''; try { ref = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) {}
    var guarded = false; try { guarded = sessionStorage.getItem('bd_guard') === location.pathname + location.search; } catch (e) {}
    if (ref !== location.origin && !guarded && !(history.state && history.state.bd)) {
      var here = location.href;
      history.replaceState({ bd: 1 }, '', HOME);
      history.pushState({ bd: 2 }, '', here);
      try { sessionStorage.setItem('bd_guard', location.pathname + location.search); } catch (e) {}
    }
    window.addEventListener('popstate', function (e) {
      if (e.state && e.state.bd === 1) location.replace(HOME);
    });
  } catch (e) { /* history API unavailable (sandboxed frame) */ }
})();
