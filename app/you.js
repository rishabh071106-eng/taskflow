// You tab dashboard — card UI v12. window.YouUI.html() replaces _youDash() in server.js (the legacy one stays as the fallback).
// Profile cover, three stat cards, the week card (empty state above the bars — never on top of them), and shortcut rows.
// Data: localStorage usage.v1 (minutes in the app per day, written by the shell), StepsTab.sum (steps + streak).
(function () {
  const Y = window.YouUI = window.YouUI || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, s) => (window.ico ? window.ico(n, s || 20) : '');
  const fmtT = sec => (sec < 60 ? '0' : sec < 3600 ? String(Math.round(sec / 60)) : (sec / 3600).toFixed(1));
  const unitT = sec => (sec < 3600 ? 'min' : 'h');

  Y.html = function () {
    const C = window.Cards; if (!C) return '';
    const hi = window.S && S.lang === 'hi';
    let d = {}; try { d = JSON.parse(localStorage.getItem('usage.v1') || '{}') || {}; } catch (e) {}
    const sumDay = dt => { const u = d[dt.toDateString()] || {}; return Object.keys(u).reduce((n, k) => n + (Number(u[k]) || 0), 0); };
    const today = sumDay(new Date());
    const week = []; for (let i = 6; i >= 0; i--) { const dt = new Date(); dt.setDate(dt.getDate() - i); week.push({ l: dt.toLocaleDateString(hi ? 'hi-IN' : 'en-IN', { weekday: 'narrow' }), v: sumDay(dt), today: i === 0 }); }
    const mx = Math.max(600, ...week.map(w => w.v));
    const T = window.StepsTab, st = T && T.sum;
    const steps = T && T.counted && st ? T.counted() : (st && st.today ? Number(st.today.counted) || 0 : 0);
    const streak = st ? Number(st.streak) || 0 : 0;
    const name = ((S.user && S.user.name) || '').trim() || (hi ? 'दोस्त' : 'Friend');
    const first = name.split(/\s+/)[0];
    const initial = (first[0] || 'B').toUpperCase();

    let h = '<div class="yu12 cv-anim">';
    // profile cover
    h += '<button type="button" class="cv wide tone-brick yu-cover" onclick="openProfile()" aria-label="' + esc(hi ? 'प्रोफ़ाइल' : 'Profile') + '">' +
      '<span class="cv-art" aria-hidden="true">' + icon('sparkles', 120) + '</span>' +
      '<span class="yu-av" aria-hidden="true">' + esc(initial) + '</span>' +
      '<span class="cv-body"><span class="cv-row"><span><span class="cv-title">' + esc(name) + '</span>' +
      (streak ? '<span class="cv-sub">' + esc(hi ? streak + ' दिन की लय' : streak + '-day streak') + '</span>' : '') + '</span>' +
      '<span class="cv-go" aria-hidden="true">' + icon('pencil', 18) + '</span></span></span></button>';
    // stats
    h += '<div class="yu-stats">' +
      C.mini({ icon: 'footprints', num: steps.toLocaleString('en-IN'), title: hi ? 'कदम आज' : 'Steps today', onclick: "switchTab('steps')" }) +
      C.mini({ icon: 'flame', num: String(streak), title: hi ? 'दिन की लय' : 'Day streak', onclick: "switchTab('steps')" }) +
      C.mini({ icon: 'graduation-cap', num: String(Math.round(today / 60)), title: (hi ? 'मिनट सीखे' : 'Min learned'), onclick: "switchTab('courses')" }) + '</div>';
    // week
    const empty = week.every(w => !w.v);
    h += '<section class="yu-week12" aria-label="' + esc(hi ? 'यह हफ़्ता' : 'This week') + '"><div class="yu-wh"><b>' + esc(hi ? 'यह हफ़्ता' : 'This week') + '</b></div>' +
      '<div class="yu-bars12' + (empty ? ' empty' : '') + '">' + week.map(w => '<div class="yu-b' + (w.today ? ' t' : '') + '"><i style="height:' + Math.max(4, Math.round(w.v / mx * 72)) + 'px"></i><span>' + esc(w.l) + '</span></div>').join('') + '</div></section>';
    // shortcuts
    h += '<div class="yu-rows">' +
      // v34: Jyotish — palm reading, kundli and pandit booking (/astro, opened in the app's layer)
      C.row({ icon: 'hand', tone: 'sand', title: hi ? 'हस्तरेखा, कुंडली और पंडित' : 'Palm, kundli and pandit', sub: hi ? 'हथेली पढ़ें, आज का राशिफल, पूजा बुक करें' : 'Read your palm, today\'s horoscope, book a puja', onclick: "(window.BroFrame?BroFrame.go('/astro/'):location.href='/astro/')" }) +
      // v21: the morning and evening summaries, reminders (app/notify.js)
      C.row({ icon: 'bell', tone: 'clay', title: hi ? 'सूचनाएँ' : 'Notifications', sub: window.Notify && Notify.label ? Notify.label() : '', onclick: 'Notify.open()' }) +
      // v24: one language for the whole app (Bro, News and every screen)
      C.row({ icon: 'languages', tone: 'umber', title: hi ? 'भाषा' : 'Language', sub: hi ? 'हिंदी · English पर जाएँ' : 'English · switch to हिंदी', onclick: "setAppLang(S.lang==='hi'?'en':'hi')" }) +
      C.row({ icon: 'moon', tone: 'umber', title: hi ? 'थीम' : 'Theme', onclick: 'toggleTheme()' }) +
      C.row({ key: 'hero-books', icon: 'image', tone: 'wine', title: hi ? 'फ़ोटो क्रेडिट' : 'Photo credits', onclick: "location.href='/credits'" }) + '</div>';
    return h + '</div>';
  };

  const css = `
#app .yu12{display:grid;gap:12px;margin:6px 0 14px}
#app .yu12 .yu-cover{aspect-ratio:auto;min-height:200px}
#app .yu12 .yu-av{position:absolute;top:16px;left:16px;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.18);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fff;font:400 28px/1 var(--b-serif);box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
#app .yu12 .yu-cover .cv-title{font-size:30px}
#app .yu12 .yu-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
#app .yu12 .yu-stats .mini{min-height:122px;padding:12px}
#app .yu12 .yu-stats .mini .mi-num{font-size:30px}
#app .yu12 .yu-stats .mini b{font-size:13px;font-weight:600}
#app .yu12 .yu-week12{padding:16px 16px 12px;border-radius:22px;background:var(--b-card);box-shadow:0 1px 2px rgba(31,30,28,.05),0 12px 26px -18px rgba(31,30,28,.45)}
#app .yu12 .yu-wh{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:14px}
#app .yu12 .yu-wh b{font:400 22px/1.1 var(--b-serif);color:var(--b-ink)}
#app .yu12 .yu-wh small{font:500 12.5px/1.3 var(--b-sans);color:var(--b-mute);text-align:right}
#app .yu12 .yu-bars12{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:end;height:96px}
#app .yu12 .yu-b{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%}
#app .yu12 .yu-b i{display:block;width:100%;max-width:26px;border-radius:8px;background:var(--b-bg-2)}
#app .yu12 .yu-b.t i{background:var(--b-primary)}
#app .yu12 .yu-bars12.empty{height:56px}
#app .yu12 .yu-b span{font:600 11px var(--b-sans);color:var(--b-mute)}
#app .yu12 .yu-b.t span{color:var(--b-primary)}
#app .yu12 .yu-rows .rowc+.rowc{margin-top:8px}
html[data-theme="dark"] #app .yu12 .yu-week12,body[data-theme=aurora] #app .yu12 .yu-week12{box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 12px 26px -18px rgba(0,0,0,.8)}
@media (max-width:370px){#app .yu12 .yu-stats .mini .mi-num{font-size:26px}#app .yu12 .yu-stats .mini{padding:11px}}
`;
  try { if (!document.getElementById('yu12-css')) { const st = document.createElement('style'); st.id = 'yu12-css'; st.textContent = css; document.head.appendChild(st); } } catch (e) {}
})();
