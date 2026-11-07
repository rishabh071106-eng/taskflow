// v21: phone notifications: a morning and an evening summary, and task reminders (modules/digest.js sends them).
//   Notify.enable({ ask })   asks for permission when ask is true (only from a tap), then subscribes with the server's
//                            current key (a subscription made with an older key is replaced) → 'on' | 'denied' |
//                            'default' | 'unsupported' | 'error'
//   Notify.subscribe({ hydration })  the same without asking (the water reminder toggle uses it)
//   Notify.open()            the Notifications sheet (You → Notifications, or the gear in the inbox): on/off, the morning
//                            and evening summaries and their times, v38: the streak call, the midday story, task nudges,
//                            "Pause for a week", what we promise (at most 3 a day, nothing 22:00-07:00), "Send a test"
// When permission was already granted, the app re-subscribes quietly a few seconds after it starts.
(function () {
  'use strict';
  const N = window.Notify = window.Notify || {};
  const tok = () => { try { return localStorage.getItem('tf_token') || ''; } catch (e) { return ''; } };
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const hi = () => !!(window.S && S.lang === 'hi');
  const L = (en, h) => (hi() ? h : en);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, s) => (window.ico ? window.ico(n, s || 20) : '');
  const say = m => { try { if (typeof window.toast === 'function') window.toast(m); } catch (e) { /* ignore */ } };
  async function call(path, body) {
    const h = { 'Content-Type': 'application/json', 'X-Timezone': tz() }; const t = tok(); if (t) h['x-token'] = t;
    const r = await fetch('/api' + path, body === undefined ? { headers: h, cache: 'no-store' } : { method: 'POST', headers: h, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) { const err = new Error((j && j.error) || 'HTTP ' + r.status); err.status = r.status; throw err; }
    return j;
  }
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  N.permission = () => (supported() ? Notification.permission : 'unsupported');
  const keyBytes = k => Uint8Array.from(atob(String(k).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  function sameKey(buf, bytes) {
    if (!buf) return false;
    const a = new Uint8Array(buf); if (a.length !== bytes.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }
  const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker')), 10000))]);

  N.subscribe = async function (o) {
    o = o || {};
    if (!supported()) return 'unsupported';
    if (Notification.permission !== 'granted') return Notification.permission;
    if (!tok()) return 'default';
    const reg = await ready();
    const { key } = await call('/push/vapid-key');
    const bytes = keyBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, bytes)) { try { await sub.unsubscribe(); } catch (e) { /* ignore */ } sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    const body = { subscription: sub.toJSON(), key };
    if (o.hydration != null) body.hydration = !!o.hydration;
    await call('/push/subscribe', body);
    N.on = true;
    return 'on';
  };
  N.enable = async function (o) {
    o = o || {};
    if (!supported()) return 'unsupported';
    let p = Notification.permission;
    if (p === 'default' && o.ask) {
      try { p = await new Promise(res => { const r = Notification.requestPermission(res); if (r && r.then) r.then(res, () => res(Notification.permission)); }); } catch (e) { p = Notification.permission; }
    }
    if (p !== 'granted') return p;
    try { return await N.subscribe(o); } catch (e) { return 'error'; }
  };

  // ── the sheet ──
  let prefs = null, more = null;
  const css = `
.nt-bg{position:fixed;inset:0;z-index:9000;background:rgba(15,13,20,.5);display:flex;align-items:flex-end;justify-content:center;animation:ntIn .18s ease both}
.nt-sheet{width:100%;max-width:520px;max-height:92dvh;overflow:auto;background:var(--b-card,#fff);color:var(--b-ink,#17141F);border-radius:24px 24px 0 0;padding:10px 20px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -12px 40px -12px rgba(0,0,0,.35);animation:ntUp .24s cubic-bezier(.2,.8,.2,1) both}
.nt-grab{width:40px;height:5px;border-radius:3px;background:var(--b-line,#ddd);margin:0 auto 14px}
.nt-sheet h3{font:400 26px/1.15 var(--b-serif,Georgia,serif);margin:0 0 6px}
.nt-sub{font:500 14px/1.45 var(--b-sans,system-ui);color:var(--b-mute,#6b6875);margin:0 0 14px}
.nt-state{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;background:var(--b-bg-2,#f3efe8);font:600 14px/1.35 var(--b-sans,system-ui);margin-bottom:12px}
.nt-state.on{background:color-mix(in srgb,#2F7D4F 14%,transparent);color:#2F7D4F}
.nt-state .b-btn{margin-left:auto;flex:none;min-height:40px;padding:0 14px}
.nt-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--b-line,#eee);min-height:56px}
.nt-row .tx{flex:1;min-width:0}.nt-row b{display:block;font:700 15px/1.25 var(--b-sans,system-ui)}.nt-row small{display:block;font:500 12.5px/1.35 var(--b-sans,system-ui);color:var(--b-mute,#6b6875);margin-top:2px}
.nt-row input[type=time]{flex:none;width:138px;max-width:138px;margin:0;font:600 15px var(--b-sans,system-ui);color:inherit;background:var(--b-bg-2,#f3efe8);border:1px solid var(--b-line,#ddd);border-radius:12px;padding:8px 8px;min-height:44px;box-sizing:border-box}
.nt-sw{position:relative;width:52px;height:32px;flex:none;border-radius:999px;background:var(--b-line,#ccc);border:0;transition:background .18s}
.nt-sw::after{content:"";position:absolute;top:3px;left:3px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .18s}
.nt-sw[aria-checked=true]{background:var(--b-primary,#B5402A)}.nt-sw[aria-checked=true]::after{transform:translateX(20px)}
.nt-act{display:grid;gap:10px;margin-top:14px}
.nt-promise{display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;padding:12px 14px;border-radius:14px;background:var(--b-bg-2,#f3efe8);font:500 13px/1.45 var(--b-sans,system-ui);color:var(--b-ink-2,#3a3640)}
.nt-promise svg{flex:none;margin-top:1px;color:#2F7D4F}
@keyframes ntIn{from{opacity:0}}@keyframes ntUp{from{transform:translateY(40px);opacity:.6}}
@media (prefers-reduced-motion:reduce){.nt-bg,.nt-sheet{animation:none}.nt-sw,.nt-sw::after{transition:none}}
`;
  function addCss() { if (document.getElementById('nt-css')) return; const st = document.createElement('style'); st.id = 'nt-css'; st.textContent = css; document.head.appendChild(st); }
  function stateHTML() {
    const p = N.permission();
    // inside the Google Play app (its own WebView, no web push): say so, instead of asking people to install the app
    if (p === 'unsupported' && window.BrodoitApp) return `<div class="nt-state">${icon('bell-off', 20)}<span>${L('Notifications in the Brodoit app come with an update soon.', 'Brodoit ऐप में सूचनाएँ जल्द ही एक अपडेट में आएँगी।')}</span></div>`;
    if (p === 'unsupported') return `<div class="nt-state">${icon('bell-off', 20)}<span>${L('This browser can’t show notifications. Install the Brodoit app to get them.', 'यह ब्राउज़र सूचनाएँ नहीं दिखा सकता। सूचनाओं के लिए Brodoit ऐप इंस्टॉल करें।')}</span></div>`;
    if (p === 'denied') return `<div class="nt-state">${icon('bell-off', 20)}<span>${L('Notifications are blocked. Allow them for Brodoit in your phone’s settings.', 'सूचनाएँ बंद हैं। फ़ोन की सेटिंग में Brodoit के लिए चालू करें।')}</span></div>`;
    if (p === 'granted' && N.on) return `<div class="nt-state on">${icon('bell', 20)}<span>${L('On for this phone', 'इस फ़ोन पर चालू')}</span></div>`;
    return `<div class="nt-state">${icon('bell', 20)}<span>${L('Off on this phone', 'इस फ़ोन पर बंद')}</span><button type="button" class="b-btn violet" id="ntOn">${L('Turn on', 'चालू करें')}</button></div>`;
  }
  const sw = (id, on, label) => `<button type="button" class="nt-sw" id="${id}" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}"></button>`;
  function sheetHTML() {
    const p = prefs || { morning: true, evening: true, m_time: '08:00', e_time: '20:30' };
    return `<div class="nt-bg" id="ntBg"><div class="nt-sheet" role="dialog" aria-modal="true" aria-labelledby="ntT"><div class="nt-grab" aria-hidden="true"></div>
      <h3 id="ntT">${L('Notifications', 'सूचनाएँ')}</h3>
      <p class="nt-sub">${L('A morning plan and an evening wrap-up with your tasks, steps and the top story. Task reminders arrive on time.', 'सुबह का प्लान और शाम का हिसाब: आपके काम, कदम और सबसे बड़ी ख़बर। काम के रिमाइंडर समय पर।')}</p>
      <div id="ntState">${stateHTML()}</div>
      <div class="nt-row"><div class="tx"><b>${L('Morning summary', 'सुबह की झलक')}</b><small>${L('Today’s tasks and plan, step goal, top story', 'आज के काम, कदमों का लक्ष्य, बड़ी ख़बर')}</small></div><input type="time" id="ntM" value="${esc(p.m_time)}" aria-label="${esc(L('Morning summary time', 'सुबह का समय'))}">${sw('ntMon', p.morning, L('Morning summary', 'सुबह की झलक'))}</div>
      <div class="nt-row"><div class="tx"><b>${L('Evening summary', 'शाम का हिसाब')}</b><small>${L('Steps against your goal, streak, what’s left', 'लक्ष्य के मुक़ाबले कदम, स्ट्रीक, बचे काम')}</small></div><input type="time" id="ntE" value="${esc(p.e_time)}" aria-label="${esc(L('Evening summary time', 'शाम का समय'))}">${sw('ntEon', p.evening, L('Evening summary', 'शाम का हिसाब'))}</div>
      <div class="nt-row"><div class="tx"><b>${L('Streak call', 'स्ट्रीक की याद')}</b><small>${L('In the evening summary, only if today’s lesson is still to do', 'शाम की झलक में, सिर्फ़ तब जब आज का सबक बाक़ी हो')}</small></div>${sw('ntS', !more || more.streak, L('Streak call', 'स्ट्रीक की याद'))}</div>
      <div class="nt-row"><div class="tx"><b>${L('Midday story', 'दोपहर की ख़बर')}</b><small>${L('The top story with its photo, at 12:30', 'बड़ी ख़बर, फ़ोटो के साथ, साढ़े बारह बजे')}</small></div>${sw('ntN', !more || more.news, L('Midday story', 'दोपहर की ख़बर'))}</div>
      <div class="nt-row"><div class="tx"><b>${L('Task nudges', 'कामों की याद')}</b><small>${L('Now and then at midday, when tasks are still open', 'कभी-कभी दोपहर में, जब काम बाक़ी हों')}</small></div>${sw('ntK', !more || more.tasks, L('Task nudges', 'कामों की याद'))}</div>
      <p class="nt-promise">${icon('shield-check', 16)}${L('Our promise: at most 3 a day besides reminders you set, nothing from 10 pm to 7 am, and everything also waits in the bell. Turn any of it off here.', 'हमारा वादा: आपके ख़ुद के रिमाइंडर के अलावा दिन में ज़्यादा से ज़्यादा 3, रात 10 से सुबह 7 तक कुछ नहीं, और सब कुछ घंटी में भी। यहाँ कभी भी बंद करें।')}</p>
      <div class="nt-act"><button type="button" class="b-btn ghost wide" id="ntPause">${more && more.paused_until && Date.parse(more.paused_until) > Date.now() ? L('Resume notifications', 'सूचनाएँ फिर शुरू करें') : L('Pause for a week', 'एक हफ़्ते के लिए रोकें')}</button><button type="button" class="b-btn wide" id="ntTest">${icon('send', 18)}${L('Send a test', 'टेस्ट भेजें')}</button><button type="button" class="b-btn ghost wide" id="ntDone">${L('Done', 'हो गया')}</button></div>
    </div></div>`;
  }
  async function save() {
    const g = id => document.getElementById(id);
    const body = { morning: g('ntMon').getAttribute('aria-checked') === 'true', evening: g('ntEon').getAttribute('aria-checked') === 'true', m_time: g('ntM').value || '08:00', e_time: g('ntE').value || '20:30' };
    try { prefs = await call('/notify/prefs', body); } catch (e) { say(L('Could not save. Check your connection.', 'सेव नहीं हुआ। इंटरनेट देखें।')); }
  }
  function wire(bg) {
    const g = id => bg.querySelector('#' + id);
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    g('ntDone').onclick = close;
    const redrawState = () => { g('ntState').innerHTML = stateHTML(); const b = g('ntOn'); if (b) b.onclick = turnOn; };
    async function turnOn() {
      const r = await N.enable({ ask: true });
      if (r === 'on') say(L('Notifications on. Your first summary comes at the next morning or evening time.', 'सूचनाएँ चालू। अगली झलक सुबह या शाम के समय आएगी।'));
      else if (r === 'denied') say(L('Blocked. Allow notifications for Brodoit in your phone’s settings.', 'बंद है। फ़ोन की सेटिंग में चालू करें।'));
      else if (r === 'error') say(L('Could not turn on. Try again in a moment.', 'चालू नहीं हुआ। थोड़ी देर में फिर कोशिश करें।'));
      redrawState();
    }
    redrawState();
    for (const id of ['ntMon', 'ntEon']) g(id).onclick = e => { const b = e.currentTarget; b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true')); save(); };
    for (const id of ['ntM', 'ntE']) g(id).onchange = save;
    // v38: the streak call, the midday story, task nudges, pause
    const saveMore = async body => { try { more = await call('/notify/more', body); } catch (e) { say(L('Could not save. Check your connection.', 'सेव नहीं हुआ। इंटरनेट देखें।')); } };
    for (const [id, k] of [['ntS', 'streak'], ['ntN', 'news'], ['ntK', 'tasks']]) g(id).onclick = e => { const b = e.currentTarget, on = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(on)); saveMore({ [k]: on }); };
    g('ntPause').onclick = async e => {
      const btn = e.currentTarget, pausedNow = more && more.paused_until && Date.parse(more.paused_until) > Date.now();
      await saveMore({ pause_days: pausedNow ? 0 : 7 });
      btn.textContent = pausedNow ? L('Pause for a week', 'एक हफ़्ते के लिए रोकें') : L('Resume notifications', 'सूचनाएँ फिर शुरू करें');
      say(pausedNow ? L('Notifications are back on.', 'सूचनाएँ फिर चालू।') : L('Paused for a week. Everything still waits in the bell.', 'एक हफ़्ते के लिए रुकीं। सब कुछ घंटी में मिलेगा।'));
    };
    g('ntTest').onclick = async () => {
      if (!N.on) { const r = await N.enable({ ask: true }); redrawState(); if (r !== 'on') { say(L('Turn notifications on first.', 'पहले सूचनाएँ चालू करें।')); return; } }
      try {
        const r = await call('/notify/test', {});
        say(r && r.sent ? L('Sent. It shows up in a few seconds.', 'भेज दिया। कुछ सेकंड में दिखेगा।') : L('No phone is set up yet. Turn notifications on first.', 'अभी कोई फ़ोन जुड़ा नहीं। पहले सूचनाएँ चालू करें।'));
      } catch (e) { say(e.status === 429 ? L('One test every 20 seconds.', '20 सेकंड में एक टेस्ट।') : L('Could not send. Try again.', 'भेज नहीं सका। फिर कोशिश करें।')); }
    };
  }
  N.open = async function () {
    addCss();
    document.getElementById('ntBg')?.remove();
    const holder = document.createElement('div'); holder.innerHTML = sheetHTML();
    const bg = holder.firstElementChild; document.body.appendChild(bg); wire(bg);
    try { more = await call('/notify/more'); for (const [id, k] of [['ntS', 'streak'], ['ntN', 'news'], ['ntK', 'tasks']]) bg.querySelector('#' + id)?.setAttribute('aria-checked', String(!!more[k])); const pz = bg.querySelector('#ntPause'); if (pz && more.paused_until && Date.parse(more.paused_until) > Date.now()) pz.textContent = L('Resume notifications', 'सूचनाएँ फिर शुरू करें'); } catch (e) { /* defaults */ }
    try { prefs = await call('/notify/prefs'); const m = bg.querySelector('#ntM'), e = bg.querySelector('#ntE'); if (m) m.value = prefs.m_time; if (e) e.value = prefs.e_time; bg.querySelector('#ntMon')?.setAttribute('aria-checked', String(!!prefs.morning)); bg.querySelector('#ntEon')?.setAttribute('aria-checked', String(!!prefs.evening)); } catch (e) { /* defaults stay */ }
    if (N.permission() === 'granted' && !N.on) { try { await N.subscribe(); } catch (e) { /* ignore */ } const s = bg.querySelector('#ntState'); if (s && document.body.contains(bg)) { s.innerHTML = stateHTML(); } }
  };
  N.label = () => { const p = N.permission(); return p === 'granted' ? L('Morning and evening summaries', 'सुबह और शाम की झलक') : p === 'denied' ? L('Blocked in phone settings', 'फ़ोन सेटिंग में बंद') : L('Off', 'बंद'); };

  // already allowed: keep this phone's subscription current (a new server key, or one the push service dropped)
  setTimeout(() => { if (supported() && Notification.permission === 'granted' && tok()) N.subscribe().catch(() => {}); }, 4000);
})();
