// v38: the bell, the inbox and the streak flame (owner, 7 Nov: "add streak daily … notifications on a notifications tab
// … give news in the notifications to excite … make users want to allow notifications … the streak should be flashing
// … I want this to be a trusted app").
// Everything Brodoit tells a user waits in the inbox (modules/nudges.js: the morning summary with today's lesson, the
// midday story or task nudge, the evening streak call, task reminders, streak milestones), whether or not the phone
// takes pushes. The bell in the header shows how many are unread; the flame next to it is the learning streak: it
// burns when today's lesson is done and flickers grey when it is still to do. Notifications are only ever asked for
// after a tap (the inbox's card, or after a streak day is won), at most every 5 days and 4 times in all.
//   window.Inbox: headerHtml(), open(), close(), refresh(), unread, flame(size, cold), weekHtml(), askHtml(where), ask()
(function () {
  'use strict';
  const I = window.Inbox = { unread: 0, items: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hi = () => { try { return S.lang === 'hi'; } catch (e) { return false; } };
  const T = (en, h) => hi() ? h : en;
  const signedIn = () => { try { return !!(S.user && localStorage.getItem('tf_token')); } catch (e) { return false; } };
  const call = async (p, body) => { try { return await api(p, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }); } catch (e) { return null; } };
  let fid = 0;

  // ── the flame (an SVG drawn here; it flickers and glows, grey and pulsing when today is still to do) ──
  I.flame = function (size, cold) {
    const id = 'skf' + (++fid), s = size || 22;
    return '<span class="sk-flame' + (cold ? ' cold' : '') + '" style="--s:' + s + 'px" aria-hidden="true"><svg viewBox="0 0 64 80" width="' + s + '" height="' + Math.round(s * 1.25) + '"><defs><linearGradient id="' + id + '" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FF4D1F"/><stop offset=".55" stop-color="#FF9A1F"/><stop offset="1" stop-color="#FFD25E"/></linearGradient></defs>'
      + '<path class="o" d="M32 3c3 13 19 22 19 43a19 19 0 0 1-38 0c0-10 5-17 9-23 1 8 5 12 9 12-3-11-2-22 1-32z" fill="url(#' + id + ')"/>'
      + '<path class="i" d="M32 40c3 6 10 9 10 17a10 10 0 0 1-20 0c0-5 3-8 6-11 1 3 2 5 4 5-1-4-1-8 0-11z" fill="#FFF1B8"/></svg></span>';
  };
  const streak = () => { try { return S.bookStreak || { streak: 0, today: false, days: [] }; } catch (e) { return { streak: 0, today: false, days: [] }; } };
  const BELL = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  // the header: the streak flame (tap: Lessons) and the bell (tap: the inbox)
  I.headerHtml = function () {
    if (!signedIn()) return '';
    const st = streak(), cold = !st.today;
    const flame = '<button class="hd-flame' + (cold ? ' cold' : '') + '" onclick="switchTab(\'books\')" aria-label="' + esc(T(st.streak + '-day streak' + (cold ? ', today still to do' : ', done today'), st.streak + ' दिन की स्ट्रीक' + (cold ? ', आज बाक़ी' : ', आज पूरी'))) + '">' + I.flame(16, cold) + '<b>' + (st.streak || 0) + '</b></button>';
    const bell = '<button class="hd-bell' + (I.unread ? ' on' : '') + '" onclick="Inbox.open()" aria-label="' + esc(T('Notifications' + (I.unread ? ' (' + I.unread + ' new)' : ''), 'सूचनाएँ' + (I.unread ? ' (' + I.unread + ' नई)' : ''))) + '">' + BELL + (I.unread ? '<i>' + (I.unread > 9 ? '9+' : I.unread) + '</i>' : '') + '</button>';
    return flame + bell;
  };
  // the week: Monday to Sunday, a flame on every day learned, today ringed
  I.weekHtml = function () {
    const st = streak(), days = new Set(st.days || []);
    const now = new Date(), dow = (now.getDay() + 6) % 7, L = hi() ? ['सो', 'मं', 'बु', 'गु', 'शु', 'श', 'र'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    let h = '<div class="sk-week" role="list">';
    for (let k = 0; k < 7; k++) {
      const d = new Date(now.getTime() + (k - dow) * 864e5), key = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
      const on = days.has(key), today = k === dow, future = k > dow;
      h += '<span role="listitem" class="sk-d' + (on ? ' on' : '') + (today ? ' now' : '') + (future ? ' fut' : '') + '"><em>' + (on ? I.flame(14, false) : '') + '</em><small>' + L[k] + '</small></span>';
    }
    return h + '</div>';
  };

  // ── asking for notifications: only after a tap, at a moment that earned it; not too often ──
  const supported = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const perm = () => (supported() ? Notification.permission : 'unsupported');
  const AK = 'bd_ask_v1';
  const askState = () => { try { return JSON.parse(localStorage.getItem(AK) || '{}') || {}; } catch (e) { return {}; } };
  I.canAsk = () => { if (perm() !== 'default') return false; const a = askState(); return (a.n || 0) < 4 && Date.now() - (a.at || 0) > 5 * 864e5; };
  const asked = () => { const a = askState(); try { localStorage.setItem(AK, JSON.stringify({ n: (a.n || 0) + 1, at: Date.now() })); } catch (e) { /* private */ } };
  I.askHtml = function (where) {
    if (perm() !== 'default') return '';
    return '<div class="nb-ask"' + (where ? ' data-where="' + esc(where) + '"' : '') + '><div class="nb-ask-h">' + BELL + '<b>' + T('Keep the flame going', 'लौ जलती रहे') + '</b></div>'
      + '<p>' + T('One gentle nudge in the evening if today’s lesson is still to do, the day’s top story with its photo, and the reminders you set.', 'शाम को एक हल्की याद, अगर आज का सबक बाक़ी हो; दिन की बड़ी ख़बर फ़ोटो के साथ; और आपके अपने रिमाइंडर।') + '</p>'
      + '<p class="nb-promise">' + T('At most 3 a day. Never between 10 pm and 7 am. Off in one tap.', 'दिन में ज़्यादा से ज़्यादा 3। रात 10 से सुबह 7 तक कभी नहीं। एक टैप में बंद।') + '</p>'
      + '<div class="nb-ask-b"><button class="nb-btn nb-btn-p" onclick="Inbox.ask(this)">' + T('Turn on notifications', 'सूचनाएँ चालू करें') + '</button><button class="nb-btn" onclick="Inbox.later(this)">' + T('Not now', 'अभी नहीं') + '</button></div></div>';
  };
  I.ask = async function (btn) {
    asked();
    let r = 'error'; try { r = window.Notify ? await Notify.enable({ ask: true }) : 'unsupported'; } catch (e) { r = 'error'; }
    const box = btn && btn.closest('.nb-ask');
    if (r === 'on') { if (box) box.outerHTML = '<div class="nb-ask on">' + T('✓ Notifications are on. See you this evening.', '✓ सूचनाएँ चालू। शाम को मिलते हैं।') + '</div>'; try { toast(T('Notifications on', 'सूचनाएँ चालू')); } catch (e) { /* none */ } }
    else if (r === 'denied') { if (box) box.outerHTML = '<div class="nb-ask off">' + T('Blocked in this browser. You can allow Brodoit in your phone’s settings any time; everything still waits in the bell.', 'इस ब्राउज़र में बंद है। फ़ोन की सेटिंग में कभी भी चालू करें; सब कुछ घंटी में मिलता रहेगा।') + '</div>'; }
    else if (box) box.remove();
    return r;
  };
  I.later = function (btn) { asked(); const box = btn && btn.closest('.nb-ask'); if (box) box.remove(); };

  // ── the inbox ──
  const KIND = { streak: '🔥', news: '📰', tasks: '✅', reminder: '⏰', digest: '☀️', lesson: '📚', note: '🔔' };
  function ago(at) {
    const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
    if (s < 60) return T('now', 'अभी'); if (s < 3600) return Math.floor(s / 60) + T('m', ' मि'); if (s < 86400) return Math.floor(s / 3600) + T('h', ' घं');
    return Math.floor(s / 86400) + T('d', ' दि');
  }
  function listHtml() {
    const items = I.items || [];
    if (I.items === null) return '<div class="nb-empty">' + T('Loading…', 'लोड हो रहा है…') + '</div>';
    if (!items.length) return '<div class="nb-empty">' + I.flame(54, !streak().today) + '<b>' + T('Nothing yet', 'अभी कुछ नहीं') + '</b><span>' + T('Your streak calls, the day’s top story and your reminders will show up here.', 'स्ट्रीक की याद, दिन की बड़ी ख़बर और आपके रिमाइंडर यहाँ दिखेंगे।') + '</span></div>';
    const today = new Date().toDateString(); let h = '', group = '';
    items.forEach(it => {
      const g = new Date(it.at).toDateString() === today ? T('Today', 'आज') : T('Earlier', 'पहले');
      if (g !== group) { group = g; h += '<h4 class="nb-g">' + g + '</h4>'; }
      h += '<button class="nb-it' + (it.read ? '' : ' new') + ' k-' + esc(it.kind) + '" onclick="Inbox.go(' + it.id + ')"><span class="nb-ic" aria-hidden="true">' + (it.kind === 'streak' ? I.flame(22, false) : KIND[it.kind] || '🔔') + '</span>'
        + '<span class="nb-tx"><b>' + esc(it.title) + '</b>' + (it.body ? '<span>' + esc(it.body).replace(/\n/g, '<br>') + '</span>' : '') + '<small>' + ago(it.at) + '</small></span>'
        + (it.image ? '<img src="' + esc(it.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</button>';
    });
    return h;
  }
  I.open = async function () {
    I.close(true);
    const el = document.createElement('div'); el.className = 'nb'; el.id = 'nbInbox'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', T('Notifications', 'सूचनाएँ'));
    const st = streak();
    el.innerHTML = '<div class="nb-top"><button class="nb-x" onclick="Inbox.close()" aria-label="' + T('Close', 'बंद करें') + '"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button><h3>' + T('Notifications', 'सूचनाएँ') + '</h3>'
      + '<button class="nb-x" onclick="Notify.open()" aria-label="' + T('Notification settings', 'सूचना सेटिंग') + '"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></div>'
      + '<div class="nb-body"><div class="nb-streak' + (st.today ? '' : ' cold') + '" onclick="Inbox.close();switchTab(\'books\')">' + I.flame(38, !st.today) + '<span><b>' + (st.streak || 0) + ' ' + T('day streak', 'दिन की स्ट्रीक') + '</b><small>' + (st.today ? T('Done for today. See you tomorrow.', 'आज का पूरा। कल मिलते हैं।') : T('One lesson today keeps it burning.', 'आज एक सबक, और लौ जलती रहेगी।')) + '</small></span>' + I.weekHtml() + '</div>'
      + I.askHtml('inbox') + '<div class="nb-list" id="nbList">' + listHtml() + '</div></div>';
    document.body.appendChild(el); document.documentElement.classList.add('nb-open');
    try { history.pushState(Object.assign({}, history.state || {}, { nb: 1 }), ''); el._pushed = true; } catch (e) { /* none */ }
    const r = await call('/inbox?lang=' + (hi() ? 'hi' : 'en'));
    I.items = r && r.items ? r.items : (I.items || []); const box = document.getElementById('nbList'); if (box) box.innerHTML = listHtml();
    // seen: everything here is read a moment after the inbox opens
    setTimeout(async () => { if (!document.getElementById('nbInbox') || !I.unread) return; const x = await call('/inbox/read', { all: true }); I.unread = x && x.unread != null ? x.unread : 0; badge(); }, 1500);
  };
  I.close = function (quiet) {
    const el = document.getElementById('nbInbox'); if (!el) return;
    el.remove(); document.documentElement.classList.remove('nb-open');
    if (!quiet && el._pushed && history.state && history.state.nb) { try { history.back(); } catch (e) { /* none */ } }
    try { render(); } catch (e) { /* none */ }
  };
  addEventListener('popstate', () => { if (document.getElementById('nbInbox')) I.close(true); });
  // a notification tapped in the inbox: read, then where it points (a lesson, a story, a tab)
  I.go = function (id) {
    const it = (I.items || []).find(x => x.id === id); if (!it) return;
    if (!it.read) { it.read = true; call('/inbox/read', { id }); }
    I.close(true);
    let u; try { u = new URL(it.url, location.href); } catch (e) { return; }
    const bk = u.searchParams.get('bk');
    if (bk && window.Lessons) { try { S.tab = 'books'; render(); } catch (e) { /* none */ } Lessons.open(bk, null, false); return; }
    try { if (window.BroFrame && BroFrame.go) BroFrame.go(u.pathname + u.search); else location.href = u.href; } catch (e) { location.href = u.href; }
  };
  function badge() {
    document.querySelectorAll('.hd-bell').forEach(b => {
      b.classList.toggle('on', I.unread > 0); let i = b.querySelector('i');
      b.setAttribute('aria-label', T('Notifications' + (I.unread ? ' (' + I.unread + ' new)' : ''), 'सूचनाएँ' + (I.unread ? ' (' + I.unread + ' नई)' : '')));
      if (I.unread > 0) { if (!i) { i = document.createElement('i'); b.appendChild(i); } i.textContent = I.unread > 9 ? '9+' : I.unread; } else if (i) i.remove();
    });
  }
  I.refresh = async function () {
    if (!signedIn()) return;
    // a new day on this phone: the streak is fetched again (the flame goes back to "to do")
    try { const d = new Date(), k = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); if (S.bookStreak && S.bookStreak.day && S.bookStreak.day !== k && typeof loadBookStreak === 'function') loadBookStreak(); } catch (e) { /* none */ }
    const r = await call('/inbox/count?lang=' + (hi() ? 'hi' : 'en'));
    if (r && r.unread != null && r.unread !== I.unread) { I.unread = r.unread; badge(); }
  };
  setTimeout(() => I.refresh(), 2500); setInterval(() => { if (!document.hidden) I.refresh(); }, 3 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) I.refresh(); });
  // a notification opened the app (…&nid=12): it is read
  try { const nid = +new URLSearchParams(location.search).get('nid'); if (nid) setTimeout(() => call('/inbox/read', { id: nid }).then(I.refresh), 1500); } catch (e) { /* none */ }
})();
