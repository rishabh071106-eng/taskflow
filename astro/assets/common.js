// Brodoit Jyotish pages (v34): the helpers every /astro page shares. Classic script, loaded after icons.js and topbar.js.
//   AX.t(en, hi) / AX.tx({en, hi})  the app's one language (bd_lang)
//   AX.api(path, {method, body})    fetch with the signed-in token; rejects with { status, body }
//   AX.data()                       cities.json + pujas.json, once
//   AX.nav                          in-page screens: go(view, arg), back(), replace(view, arg). The phone's back and the
//                                   top bar's chevron step back through them (inside Brodoit's layer via bdBackHandler,
//                                   on its own via history), and leave the page only from the first screen.
(function () {
  'use strict';
  const AX = window.AX = {};
  let lang = 'en'; try { lang = localStorage.getItem('bd_lang') === 'hi' ? 'hi' : 'en'; } catch (e) { /* default */ }
  AX.lang = lang; AX.hi = lang === 'hi';
  document.documentElement.lang = lang;
  AX.t = (en, hi) => (AX.hi ? hi : en);
  AX.tx = o => (o ? (AX.hi ? o.hi : o.en) : '');
  AX.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  AX.ic = (n, s, w) => { try { return window.ico ? window.ico(n, s || 20, w) : ''; } catch (e) { return ''; } };
  AX.token = () => { try { return localStorage.getItem('tf_token') || ''; } catch (e) { return ''; } };
  AX.get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  AX.set = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  AX.api = async function (p, o) {
    o = o || {};
    const h = { 'x-token': AX.token() }; if (o.body !== undefined) h['Content-Type'] = 'application/json';
    let r; try { r = await fetch(p, { method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers: h, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, cache: 'no-store' }); }
    catch (e) { throw { status: 0, body: { error: 'offline' } }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, body: j };
    return j;
  };
  let dataP = null;
  AX.data = () => dataP || (dataP = Promise.all(['cities', 'pujas'].map(f => fetch('/astro/data/' + f + '.json?v=34').then(r => r.json())))
    .then(([c, p]) => ({ cities: c.cities, tiers: c.tiers, cats: p.cats, pujas: p.pujas, packages: p.packages, langs: p.langs, traditions: p.traditions })));
  AX.name = o => (o ? (AX.hi ? o.h || o.n : o.n) : '');

  // times and dates
  AX.fmtH = h => {
    if (h == null || isNaN(h)) return '–';
    let m = Math.round(h * 60) % 1440, hh = Math.floor(m / 60), mm = m % 60;
    const pm = hh >= 12, h12 = ((hh + 11) % 12) + 1, t = h12 + ':' + String(mm).padStart(2, '0');
    if (!AX.hi) return t + (pm ? ' pm' : ' am');
    const part = hh < 4 ? 'रात' : hh < 12 ? 'सुबह' : hh < 16 ? 'दोपहर' : hh < 19 ? 'शाम' : 'रात';
    return part + ' ' + t;
  };
  AX.fmtRange = r => (r ? AX.fmtH(r[0]) + ' – ' + AX.fmtH(r[1]) : '–');
  AX.fmtDate = (d, o) => {
    const x = typeof d === 'string' ? new Date(d.length === 10 ? d + 'T12:00:00' : d) : d;
    try { return x.toLocaleDateString(AX.hi ? 'hi-IN' : 'en-IN', o || { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return String(d); }
  };
  // a moment's calendar date at a place tz hours east of UTC (the panchang's day), formatted like fmtDate
  AX.fmtDateAt = (d, tz, o) => AX.fmtDate(new Date(d.getTime() + (tz || 0) * 3600000), Object.assign({ timeZone: 'UTC' }, o || {}));
  AX.ymd = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  AX.rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');

  AX.toast = function (msg, ms) {
    const old = document.querySelector('.ax-toast'); if (old) old.remove();
    const el = document.createElement('div'); el.className = 'ax-toast'; el.setAttribute('role', 'status'); el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => { try { el.remove(); } catch (e) { /* gone */ } }, ms || 2600);
  };
  AX.signInHref = '/?tab=you';
  AX.disclaimer = () => '<p class="ax-disc">' + AX.esc(AX.tx(window.AstroText && AstroText.DISCLAIMER)) + '</p>';

  // ── in-page screens ──
  const nav = AX.nav = { stack: [], render: null };
  const framed = () => !!window.bdFramed;
  nav.cur = () => nav.stack[nav.stack.length - 1] || null;
  nav.show = function () { if (nav.render) nav.render(nav.cur()); try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } };
  nav.start = function (view, arg) { nav.stack = [{ view, arg }]; nav.show(); };
  nav.go = function (view, arg) {
    nav.stack.push({ view, arg });
    if (!framed()) { try { history.pushState({ ax: nav.stack.length }, '', location.pathname + location.search + '#' + view); } catch (e) { /* ignore */ } }
    nav.show();
  };
  nav.replace = function (view, arg) { nav.stack[nav.stack.length - 1] = { view, arg }; nav.show(); };
  nav.back = function () {
    if (nav.stack.length <= 1) return false;
    if (!framed() && history.state && history.state.ax) { history.back(); return true; }
    nav.stack.pop(); nav.show(); return true;
  };
  addEventListener('popstate', () => { if (!framed() && nav.stack.length > 1) { nav.stack.pop(); nav.show(); } });
  window.bdBackHandler = () => nav.back();
  // the top bar's chevron steps back through the screens first (window capture runs before inframe.js's link catcher)
  addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('.bd-top .bd-back');
    if (a && nav.stack.length > 1) { e.preventDefault(); e.stopImmediatePropagation(); nav.back(); }
  }, true);
  // page buttons call AX.back()
  AX.back = () => { if (!nav.back()) { const a = document.querySelector('.bd-top .bd-back'); if (a) a.click(); } };
})();
