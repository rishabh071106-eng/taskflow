// Book a pandit (/astro/pandit.html): pick a city and an occasion, see the three packages at the city's usual rate
// (astro/assets/price.js), choose a verified pandit or let Brodoit assign one, and book. Also: my bookings, joining as a
// pandit, and a pandit's own listing with the bookings assigned to them. ?v=bookings|join|me|jobs and ?puja=<id> open there.
(function () {
  'use strict';
  const { t, tx, esc, ic } = AX, main = document.getElementById('main'), PR = window.AstroPrice;
  bdTopbar({ back: '/astro/', backLabel: t('Jyotish', 'ज्योतिष'), title: t('Book a pandit', 'पंडित बुक करें') });
  let D = null, status = { signedIn: !!AX.token() }, cat = 'all';
  let cityId = AX.get('astro.city', '') || ((AX.get('astro.birth.v1', null) || {}).city) || 'delhi';
  const city = () => D.cities.find(c => c.id === cityId) || D.cities[0];
  const pujaOf = id => D.pujas.find(p => p.id === id);
  const price = (p, k) => PR.price(p, k, city(), D.tiers);
  const pkgName = k => AX.name(D.packages[k]);
  const pkgDesc = (p, k) => (p.pk ? (AX.hi ? p.pkh : p.pk)[PR.PKGS.indexOf(k)] : k === 'premium' ? (AX.hi ? 'स्टैंडर्ड का सब कुछ, साथ में: ' + p.pxh + '।' : 'Everything in Standard, plus: ' + p.px + '.') : AX.hi ? D.packages[k].dh : D.packages[k].d);
  const hrs = p => (/day/.test(p.hrs) ? (AX.hi ? p.hrs.replace('days', 'दिन') : p.hrs) : p.hrs + (AX.hi ? ' घंटे' : ' hours'));
  const statusWord = s => ({ requested: t('Requested', 'अनुरोध भेजा'), confirmed: t('Confirmed', 'पक्की'), done: t('Done', 'पूरी'), cancelled: t('Cancelled', 'रद्द'), pending: t('Waiting for verification', 'सत्यापन बाकी'), verified: t('Verified', 'सत्यापित'), rejected: t('Not verified', 'सत्यापित नहीं'), paused: t('Paused', 'रुका हुआ') }[s] || s);
  const TIMES = () => [['muhurat', t('Shubh muhurat (pandit ji suggests)', 'शुभ मुहूर्त (पंडित जी बताएँगे)')], ['morning', t('Morning, 7 to 11', 'सुबह, 7 से 11')], ['afternoon', t('Afternoon, 12 to 4', 'दोपहर, 12 से 4')], ['evening', t('Evening, 5 to 8', 'शाम, 5 से 8')], ['exact', t('An exact time…', 'तय समय…')]];
  const timeWord = v => { const x = TIMES().find(a => a[0] === v); return x ? x[1] : /^\d\d:\d\d$/.test(v || '') ? AX.fmtH(+v.slice(0, 2) + +v.slice(3) / 60) : ''; };
  const needSignIn = msg => '<section class="ax-card"><h2>' + esc(t('Sign in first', 'पहले साइन इन करें')) + '</h2><p class="ax-muted">' + esc(msg) + '</p><div class="ax-row-btns"><a class="ui-btn accent" href="' + AX.signInHref + '">' + esc(t('Sign in to Brodoit', 'Brodoit में साइन इन करें')) + '</a></div></section>';
  const header = (h, sub) => '<header class="ui-page-h"><h1>' + esc(h) + '</h1></header>' + (sub ? '<p class="ax-lead">' + esc(sub) + '</p>' : '');
  const citySelect = () => '<label class="ax-form" style="display:grid;gap:6px;font:600 13px var(--ui-font);color:var(--b-ink-2)">' + esc(t('Your city', 'आपका शहर'))
    + '<select class="ui-field" id="city">' + D.cities.slice().sort((a, b) => AX.name(a).localeCompare(AX.name(b))).map(c => '<option value="' + c.id + '"' + (c.id === cityId ? ' selected' : '') + '>' + esc(AX.name(c)) + '</option>').join('') + '</select></label>';
  const bindCity = then => { const s = document.getElementById('city'); if (s) s.addEventListener('change', () => { cityId = s.value; AX.set('astro.city', cityId); then(); }); };

  // ── the list ──
  function list() {
    const C = city();
    let h = header(t('Book a pandit', 'पंडित बुक करें'), t('Verified pandits for every occasion, at the usual rate in your city.', 'हर मौक़े के लिए सत्यापित पंडित, आपके शहर की सामान्य दर पर।')) + citySelect();
    h += '<div class="ax-chips" style="margin-top:14px" role="group" aria-label="' + esc(t('Occasions', 'अवसर')) + '">' + [{ id: 'all', n: 'All', h: 'सभी' }].concat(D.cats).map(c => '<button type="button" class="ax-chip' + (cat === c.id ? ' on' : '') + '" data-cat="' + c.id + '">' + esc(AX.name(c)) + '</button>').join('') + '</div>';
    const ps = D.pujas.filter(p => (cat === 'all' || p.cat === cat) && PR.available(p, C.id));
    const groups = cat === 'all' ? D.cats.map(c => ({ c, ps: ps.filter(p => p.cat === c.id) })).filter(g => g.ps.length) : [{ c: D.cats.find(c => c.id === cat), ps }];
    for (const g of groups) {
      h += '<div class="ui-sec">' + esc(AX.name(g.c)) + '</div><div class="ui-list">' + g.ps.map(p => '<a class="ui-row" href="?puja=' + p.id + '" data-puja="' + p.id + '"><span class="ui-ic" style="--ui-accent:var(--g-pandit)" aria-hidden="true">' + ic(p.cat === 'astro' ? 'moon' : p.cat === 'home' ? 'home' : p.cat === 'pitru' ? 'flame' : p.cat === 'fest' ? 'sparkles' : 'landmark', 22) + '</span>'
        + '<span class="ui-tx"><b>' + esc(AX.name(p)) + '</b><small>' + esc(hrs(p) + (PR.famous(p, C.id) ? t(' · famous here', ' · यहाँ प्रसिद्ध') : '')) + '</small></span><span class="ui-meta">' + esc(t('from ', '') + AX.rupees(price(p, 'basic')) + t('', ' से')) + '</span></a>').join('') + '</div>';
    }
    const off = D.pujas.filter(p => !PR.available(p, C.id) && (cat === 'all' || p.cat === cat));
    if (off.length) h += '<p class="ax-small" style="margin:12px 4px 0">' + esc(off.map(p => AX.name(p)).join(', ') + t(' are done at tirths (Gaya, Varanasi, Prayagraj, Haridwar). Pick one of those cities to book.', ' तीर्थों (गया, वाराणसी, प्रयागराज, हरिद्वार) में होते हैं। बुक करने के लिए इनमें से कोई शहर चुनें।')) + '</p>';
    if (status.signedIn) h += '<div class="ui-sec">' + esc(t('Yours', 'आपका')) + '</div><div class="ui-list">'
      + '<button type="button" class="ui-row" data-go="bookings"><span class="ui-ic" style="--ui-accent:var(--g-pandit)">' + ic('calendar', 22) + '</span><span class="ui-tx"><b>' + esc(t('My bookings', 'मेरी बुकिंग')) + '</b></span><span class="ui-chev">' + ic('chevron-right', 18) + '</span></button>'
      + '<button type="button" class="ui-row" data-go="' + (status.pandit ? 'me' : 'join') + '"><span class="ui-ic" style="--ui-accent:var(--g-pandit)">' + ic('user-plus', 22) + '</span><span class="ui-tx"><b>' + esc(status.pandit ? t('My pandit listing', 'मेरी पंडित लिस्टिंग') : t('Are you a pandit? Join', 'क्या आप पंडित हैं? जुड़ें')) + '</b>' + (status.pandit ? '<small>' + esc(statusWord(status.pandit)) + '</small>' : '') + '</span><span class="ui-chev">' + ic('chevron-right', 18) + '</span></button></div>';
    h += '<p class="ax-small" style="margin:18px 4px 0">' + esc(t('Prices follow the usual rates of pandit services in each city. Pay the pandit after the puja, in cash or UPI.', 'दाम हर शहर में पंडित सेवाओं की सामान्य दर के हिसाब से हैं। भुगतान पूजा के बाद पंडित जी को, नकद या UPI से।')) + '</p>';
    main.innerHTML = h;
    bindCity(list);
    main.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { cat = b.dataset.cat; list(); }));
    main.querySelectorAll('[data-puja]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); AX.nav.go('puja', a.dataset.puja); }));
    main.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => AX.nav.go(b.dataset.go)));
  }

  // ── one puja: packages, pandits, continue ──
  let sel = { pkg: 'standard', pandit: '' }, pandits = null;
  function puja(id) {
    const p = pujaOf(id); if (!p) { AX.nav.replace('list'); return; }
    const C = city();
    let h = header(AX.name(p), hrs(p) + ' · ' + (p.pandits > 1 ? p.pandits + t(' pandits', ' पंडित') : t('1 pandit', '1 पंडित')) + (PR.famous(p, C.id) ? t(' · famous in ', ' · ') + AX.name(C) + (AX.hi ? ' में प्रसिद्ध' : '') : ''));
    h += '<p class="ax-body" style="margin-bottom:14px">' + esc(AX.hi ? p.dh : p.d) + '</p>' + citySelect();
    if (!PR.available(p, C.id)) {
      h += '<p class="ax-note" style="margin-top:12px">' + ic('map-pin', 18) + '<span>' + esc(t('This is done at a tirth. Pick ', 'यह तीर्थ पर होता है। चुनें: ') + p.only.map(x => AX.name(D.cities.find(c => c.id === x))).join(', ') + '.') + '</span></p>';
      main.innerHTML = h; bindCity(() => puja(id)); return;
    }
    h += '<div class="ui-sec">' + esc(t('Choose a package', 'पैकेज चुनें')) + '</div><div class="ax-pkgs" role="radiogroup">' + PR.PKGS.map(k => '<button type="button" role="radio" aria-checked="' + (sel.pkg === k) + '" class="ax-pkg' + (sel.pkg === k ? ' on' : '') + '" data-pkg="' + k + '"><span class="dot" aria-hidden="true"></span><span><b>' + esc(pkgName(k)) + '</b><small>' + esc(pkgDesc(p, k)) + '</small></span><span class="pr">' + esc(AX.rupees(price(p, k))) + '</span></button>').join('') + '</div>';
    h += '<div class="ui-sec">' + esc(t('Pandit ji in ', '') + AX.name(C) + t('', ' में पंडित जी')) + '</div><div id="pl"><i class="ui-skel" style="height:68px"></i></div>';
    h += '<div class="ax-sticky"><button type="button" class="ui-btn accent wide" id="next">' + esc(t('Continue', 'आगे बढ़ें') + ' · ' + AX.rupees(price(p, sel.pkg))) + '</button></div>';
    main.innerHTML = h;
    bindCity(() => { pandits = null; sel.pandit = ''; puja(id); });
    main.querySelectorAll('[data-pkg]').forEach(b => b.addEventListener('click', () => { sel.pkg = b.dataset.pkg; puja(id); }));
    document.getElementById('next').addEventListener('click', () => AX.nav.go('book', id));
    const drawPandits = () => {
      const el = document.getElementById('pl'); if (!el) return;
      const opt = (pid, title, sub, av) => '<button type="button" role="radio" aria-checked="' + (sel.pandit === pid) + '" class="ax-pkg' + (sel.pandit === pid ? ' on' : '') + '" data-pid="' + pid + '"><span class="dot" aria-hidden="true"></span><span class="ax-pandit"><span class="ax-av" aria-hidden="true">' + av + '</span><span><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span></span><span></span></button>';
      let x = '<div class="ax-pkgs" role="radiogroup">' + opt('', t('Any verified pandit', 'कोई भी सत्यापित पंडित'), t('We match your tradition and language, and share their name and number when we confirm.', 'हम आपकी परंपरा और भाषा के हिसाब से पंडित चुनेंगे, और पक्का होने पर नाम और नंबर बताएँगे।'), ic('shield-check', 20));
      for (const q of pandits || []) x += opt(q.id, q.name, [q.experience ? q.experience + t(' years', ' वर्ष') : '', q.langs.map(l => AX.name(D.langs.find(a => a.id === l))).filter(Boolean).join(', '), q.traditions.map(l => AX.name(D.traditions.find(a => a.id === l))).filter(Boolean).join(', ')].filter(Boolean).join(' · ') + (q.about ? '. ' + q.about : ''), esc((q.name.replace(/^(pt\.?|pandit)\s+/i, '')[0] || 'P').toUpperCase()));
      x += '</div>';
      if (pandits && !pandits.length) x += '<p class="ax-small" style="margin:8px 4px 0">' + esc(t('No pandit has listed this puja in this city yet, so Brodoit assigns one when confirming.', 'इस शहर में अभी किसी पंडित ने यह पूजा नहीं जोड़ी है, इसलिए पक्का करते समय Brodoit पंडित तय करेगा।')) + '</p>';
      el.innerHTML = x;
      el.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => { sel.pandit = b.dataset.pid; drawPandits(); }));
    };
    if (pandits && pandits.city === C.id && pandits.puja === id) drawPandits();
    else AX.api('/api/astro/pandits?city=' + encodeURIComponent(C.id) + '&puja=' + encodeURIComponent(id)).then(r => { pandits = r.items; pandits.city = C.id; pandits.puja = id; drawPandits(); }).catch(() => { pandits = []; drawPandits(); });
  }

  // ── the booking form ──
  function book(id, err, keep) {
    const p = pujaOf(id); if (!p) { AX.nav.replace('list'); return; }
    if (!status.signedIn) { main.innerHTML = header(t('Book ', '') + AX.name(p) + t('', ' बुक करें')) + needSignIn(t('Bookings are saved to your Brodoit account so we can confirm them with you.', 'बुकिंग आपके Brodoit अकाउंट में रहती है ताकि हम आपसे पक्का कर सकें।')); return; }
    const C = city(), v = keep || {}, remote = p.cat === 'astro', pr = price(p, sel.pkg);
    const pd = sel.pandit && pandits ? pandits.find(q => q.id === sel.pandit) : null;
    const tomorrow = AX.ymd(new Date(Date.now() + 86400000)), min = AX.ymd(new Date());
    let h = header(t('Book ', '') + AX.name(p) + t('', ' बुक करें'), pkgName(sel.pkg) + ' · ' + AX.name(C) + ' · ' + AX.rupees(pr) + (pd ? ' · ' + pd.name : ''));
    h += '<form class="ax-form ax-card" id="bk" novalidate>'
      + '<label>' + esc(t('Date', 'तारीख़')) + '<input class="ui-field" type="date" name="date" required min="' + min + '" value="' + esc(v.date || tomorrow) + '"></label>'
      + '<label>' + esc(t('Time', 'समय')) + '<select class="ui-field" name="slot">' + TIMES().map(([k, l]) => '<option value="' + k + '"' + ((v.slot || 'muhurat') === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>'
      + '<label id="exactL"' + (v.slot === 'exact' ? '' : ' hidden') + '>' + esc(t('Start time', 'शुरू होने का समय')) + '<input class="ui-field" type="time" name="time" value="' + esc(v.time || '09:00') + '"></label>'
      + (remote ? '' : '<label>' + esc(t('Address in ', 'पता: ') + AX.name(C)) + '<textarea class="ui-field" name="address" rows="3" maxlength="300" autocomplete="street-address" required>' + esc(v.address || '') + '</textarea></label>')
      + '<div class="ax-two"><label>' + esc(t('Language', 'भाषा')) + '<select class="ui-field" name="lang"><option value="">' + esc(t('Any', 'कोई भी')) + '</option>' + D.langs.map(l => '<option value="' + l.id + '"' + (v.lang === l.id ? ' selected' : '') + '>' + esc(AX.name(l)) + '</option>').join('') + '</select></label>'
      + '<label>' + esc(t('Tradition', 'परंपरा')) + '<select class="ui-field" name="tradition"><option value="">' + esc(t('Any', 'कोई भी')) + '</option>' + D.traditions.map(l => '<option value="' + l.id + '"' + (v.tradition === l.id ? ' selected' : '') + '>' + esc(AX.name(l)) + '</option>').join('') + '</select></label></div>'
      + '<label>' + esc(t('Your name', 'आपका नाम')) + '<input class="ui-field" name="contact_name" autocomplete="name" maxlength="60" value="' + esc(v.contact_name != null ? v.contact_name : status.name || '') + '"></label>'
      + '<label>' + esc(t('Phone (we call to confirm)', 'फ़ोन (पक्का करने के लिए कॉल करेंगे)')) + '<input class="ui-field" type="tel" name="contact_phone" autocomplete="tel" inputmode="tel" maxlength="16" placeholder="+91" value="' + esc(v.contact_phone || '') + '"></label>'
      + '<label>' + esc(t('Anything pandit ji should know (optional)', 'पंडित जी को कुछ बताना हो (ज़रूरी नहीं)')) + '<textarea class="ui-field" name="notes" rows="2" maxlength="500">' + esc(v.notes || '') + '</textarea></label>'
      + '<ul class="ax-ticks">' + [t('We call you to confirm, usually within a few hours.', 'हम पक्का करने के लिए कॉल करेंगे, आमतौर पर कुछ घंटों में।'), t('You get the pandit\'s name and number once confirmed.', 'पक्का होने पर पंडित जी का नाम और नंबर मिलेगा।'), t('Pay ' + AX.rupees(pr) + ' to the pandit after the puja, in cash or UPI. No advance.', 'पूजा के बाद पंडित जी को ' + AX.rupees(pr) + ' दें, नकद या UPI से। कोई एडवांस नहीं।'), t('Free to cancel before it is done.', 'पूजा से पहले मुफ़्त में रद्द कर सकते हैं।')].map(x => '<li>' + ic('check', 16) + '<span>' + esc(x) + '</span></li>').join('') + '</ul>'
      + (err ? '<p class="ax-err" role="alert">' + esc(err) + '</p>' : '')
      + '<button class="ui-btn accent wide" type="submit">' + esc(t('Request booking', 'बुकिंग भेजें') + ' · ' + AX.rupees(pr)) + '</button></form>';
    main.innerHTML = h;
    const f = document.getElementById('bk');
    f.slot.addEventListener('change', () => { document.getElementById('exactL').hidden = f.slot.value !== 'exact'; });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const val = { date: f.date.value, slot: f.slot.value, time: f.time.value, address: f.address ? f.address.value : '', lang: f.lang.value, tradition: f.tradition.value, contact_name: f.contact_name.value, contact_phone: f.contact_phone.value, notes: f.notes.value };
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await AX.api('/api/astro/bookings', { body: { puja: id, city: C.id, pkg: sel.pkg, pandit_id: sel.pandit || undefined, date: val.date, time: val.slot === 'exact' ? val.time : val.slot, address: val.address, lang: val.lang, tradition: val.tradition, contact_name: val.contact_name, contact_phone: val.contact_phone, notes: val.notes } });
        AX.nav.stack = [AX.nav.stack[0]]; AX.nav.go('done', r.booking);
      } catch (x) {
        const fld = x.body && x.body.field, msg = { date: t('Pick a date from today onwards.', 'आज या आगे की तारीख़ चुनें।'), address: t('Add the full address.', 'पूरा पता लिखें।'), contact_name: t('Add your name.', 'अपना नाम लिखें।'), contact_phone: t('Add a phone number with 10 digits or more.', '10 या ज़्यादा अंकों का फ़ोन नंबर लिखें।') }[fld]
          || (x.status === 429 ? t('You have several open bookings. Finish or cancel one first.', 'आपकी कई बुकिंग खुली हैं। पहले कोई पूरी या रद्द करें।') : x.status === 401 ? t('Please sign in again.', 'कृपया फिर से साइन इन करें।') : t('Could not book. Check your connection and try again.', 'बुकिंग नहीं हो सकी। इंटरनेट जाँचकर फिर कोशिश करें।'));
        book(id, msg, val);
        if (fld && document.getElementById('bk')[fld]) document.getElementById('bk')[fld].classList.add('ax-field-err');
      }
    });
  }

  function done(b) {
    const p = pujaOf(b.puja) || { n: b.puja }, C = D.cities.find(c => c.id === b.city);
    main.innerHTML = header(t('Booking requested', 'बुकिंग भेज दी गई'), t('Booking ', 'बुकिंग ') + b.id)
      + '<section class="ax-card"><div class="ax-kv">' + [[t('Puja', 'पूजा'), AX.name(p)], [t('Package', 'पैकेज'), pkgName(b.pkg)], [t('Date', 'तारीख़'), AX.fmtDate(b.date)], [t('Time', 'समय'), timeWord(b.time)], [t('City', 'शहर'), C ? AX.name(C) : b.city], [t('Price', 'दाम'), AX.rupees(b.price)]].map(([k, v]) => '<div><small>' + esc(k) + '</small><b>' + esc(v) + '</b></div>').join('') + '</div>'
      + '<p class="ax-body" style="margin-top:12px">' + esc(t('We will call ' + b.contact_phone + ' to confirm and to share pandit ji\'s name and number. You will also get a notification.', 'हम ' + b.contact_phone + ' पर कॉल करके पक्का करेंगे और पंडित जी का नाम-नंबर बताएँगे। आपको सूचना भी मिलेगी।')) + '</p></section>'
      + '<div class="ax-stack" style="margin-top:16px"><button type="button" class="ui-btn accent wide" id="mine">' + esc(t('My bookings', 'मेरी बुकिंग')) + '</button><button type="button" class="ui-btn sec wide" id="more">' + esc(t('Book another puja', 'दूसरी पूजा बुक करें')) + '</button></div>';
    document.getElementById('mine').addEventListener('click', () => { AX.nav.stack = [AX.nav.stack[0]]; AX.nav.go('bookings'); });
    document.getElementById('more').addEventListener('click', () => { AX.nav.stack = []; AX.nav.start('list'); });
  }

  // ── my bookings ──
  function bookings() {
    main.innerHTML = header(t('My bookings', 'मेरी बुकिंग')) + (status.signedIn ? '<i class="ui-skel" style="height:140px"></i>' : needSignIn(t('Your bookings are kept in your Brodoit account.', 'आपकी बुकिंग आपके Brodoit अकाउंट में रहती है।')));
    if (!status.signedIn) return;
    AX.api('/api/astro/bookings').then(r => {
      if ((AX.nav.cur() || {}).view !== 'bookings') return;
      if (!r.items.length) { main.innerHTML = header(t('My bookings', 'मेरी बुकिंग')) + '<p class="tk-none">' + esc(t('No bookings yet.', 'अभी कोई बुकिंग नहीं।')) + '</p><button type="button" class="ui-btn accent wide" id="bk0">' + esc(t('Book a pandit', 'पंडित बुक करें')) + '</button>'; document.getElementById('bk0').addEventListener('click', () => { AX.nav.stack = []; AX.nav.start('list'); }); return; }
      main.innerHTML = header(t('My bookings', 'मेरी बुकिंग')) + r.items.map(b => {
        const p = pujaOf(b.puja) || { n: b.puja }, C = D.cities.find(c => c.id === b.city);
        return '<section class="ax-card"><div class="ax-th" style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h3>' + esc(AX.name(p)) + '</h3><p class="ax-muted">' + esc(AX.fmtDate(b.date) + ' · ' + timeWord(b.time) + ' · ' + (C ? AX.name(C) : b.city)) + '</p></div><span class="ax-pill ' + b.status + '">' + esc(statusWord(b.status)) + '</span></div>'
          + '<p class="ax-body" style="margin-top:6px">' + esc(pkgName(b.pkg) + ' · ' + AX.rupees(b.price)) + ' <span class="ax-small">' + esc(b.id) + '</span></p>'
          + (b.pandit ? '<div class="ax-pandit" style="margin-top:10px"><span class="ax-av">' + esc((b.pandit.name[0] || 'P').toUpperCase()) + '</span><div><b>' + esc(b.pandit.name) + '</b>' + (b.pandit.phone ? '<br><a href="tel:' + esc(b.pandit.phone) + '">' + esc(b.pandit.phone) + '</a>' : '<p class="ax-small">' + esc(t('Number shared once confirmed', 'पक्का होने पर नंबर मिलेगा')) + '</p>') + '</div></div>' : '')
          + (b.admin_note ? '<p class="ax-note" style="margin-top:10px">' + ic('info', 18) + '<span>' + esc(b.admin_note) + '</span></p>' : '')
          + (b.status === 'requested' || b.status === 'confirmed' ? '<div class="ax-row-btns"><button type="button" class="ui-btn ghost sm" data-cancel="' + esc(b.id) + '">' + esc(t('Cancel booking', 'बुकिंग रद्द करें')) + '</button></div>' : '') + '</section>';
      }).join('');
      main.querySelectorAll('[data-cancel]').forEach(x => x.addEventListener('click', async () => {
        if (!confirm(t('Cancel this booking?', 'यह बुकिंग रद्द करें?'))) return;
        try { await AX.api('/api/astro/bookings/' + encodeURIComponent(x.dataset.cancel) + '/cancel', { body: {} }); AX.toast(t('Booking cancelled', 'बुकिंग रद्द हो गई')); bookings(); }
        catch (e) { AX.toast(t('Could not cancel. Try again.', 'रद्द नहीं हो सकी। फिर कोशिश करें।')); }
      }));
    }).catch(() => { main.innerHTML = header(t('My bookings', 'मेरी बुकिंग')) + '<p class="tk-none">' + esc(t('Could not load. Check your connection.', 'लोड नहीं हुआ। इंटरनेट जाँचें।')) + '</p>'; });
  }

  // ── join as a pandit / my listing ──
  function multi(name, items, chosen) { return '<div class="ax-chips wrap" data-multi="' + name + '">' + items.map(x => '<button type="button" class="ax-chip' + (chosen.includes(x.id) ? ' on' : '') + '" aria-pressed="' + chosen.includes(x.id) + '" data-v="' + x.id + '">' + esc(AX.name(x)) + '</button>').join('') + '</div>'; }
  function join(cur, err) {
    if (!status.signedIn) { main.innerHTML = header(t('Join as a pandit', 'पंडित के रूप में जुड़ें')) + needSignIn(t('Sign in with your own account to list yourself.', 'ख़ुद को सूचीबद्ध करने के लिए अपने अकाउंट से साइन इन करें।')); return; }
    const v = cur || { name: status.name || '', city: cityId, langs: ['hi', 'sa'], traditions: ['north'], pujas: [], experience: '', about: '', phone: '' };
    let h = header(cur && cur.id ? t('Edit my listing', 'मेरी लिस्टिंग बदलें') : t('Join as a pandit', 'पंडित के रूप में जुड़ें'), t('Families in your city book you at the usual local rate. We verify every pandit before listing.', 'आपके शहर के परिवार आपको सामान्य स्थानीय दर पर बुक करेंगे। सूची में डालने से पहले हम हर पंडित की जाँच करते हैं।'));
    h += '<form class="ax-form ax-card" id="jf" novalidate><label>' + esc(t('Name as families should see it', 'नाम, जैसा परिवार देखें')) + '<input class="ui-field" name="name" maxlength="60" placeholder="' + esc(t('Pt. Ramesh Sharma', 'पं. रमेश शर्मा')) + '" value="' + esc(v.name) + '"></label>'
      + '<label>' + esc(t('Phone (shared only with families you are booked by)', 'फ़ोन (सिर्फ़ बुक करने वाले परिवारों को दिखेगा)')) + '<input class="ui-field" type="tel" name="phone" inputmode="tel" maxlength="16" placeholder="+91" value="' + esc(v.phone || '') + '"></label>'
      + '<div class="ax-two"><label>' + esc(t('City', 'शहर')) + '<select class="ui-field" name="city">' + D.cities.slice().sort((a, b) => AX.name(a).localeCompare(AX.name(b))).map(c => '<option value="' + c.id + '"' + (c.id === v.city ? ' selected' : '') + '>' + esc(AX.name(c)) + '</option>').join('') + '</select></label>'
      + '<label>' + esc(t('Years of experience', 'अनुभव (वर्ष)')) + '<input class="ui-field" name="experience" inputmode="numeric" maxlength="2" value="' + esc(v.experience || '') + '"></label></div>'
      + '<label>' + esc(t('Languages', 'भाषाएँ')) + '</label>' + multi('langs', D.langs, v.langs)
      + '<label>' + esc(t('Traditions', 'परंपराएँ')) + '</label>' + multi('traditions', D.traditions, v.traditions)
      + '<label>' + esc(t('Pujas you perform', 'आप कौन-सी पूजाएँ करते हैं')) + '</label>' + D.cats.map(c => '<p class="ax-small">' + esc(AX.name(c)) + '</p>' + multi('pujas', D.pujas.filter(p => p.cat === c.id), v.pujas)).join('')
      + '<label>' + esc(t('About you (optional)', 'आपके बारे में (ज़रूरी नहीं)')) + '<textarea class="ui-field" name="about" rows="3" maxlength="400" placeholder="' + esc(t('Studied at… Performs pujas in…', 'शिक्षा… किन जगहों पर पूजा करते हैं…')) + '">' + esc(v.about || '') + '</textarea></label>'
      + (err ? '<p class="ax-err" role="alert">' + esc(err) + '</p>' : '')
      + '<button class="ui-btn accent wide" type="submit">' + esc(cur && cur.id ? t('Save', 'सेव करें') : t('Send for verification', 'जाँच के लिए भेजें')) + '</button></form>';
    main.innerHTML = h;
    main.querySelectorAll('[data-multi] [data-v]').forEach(b => b.addEventListener('click', () => { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); }));
    const f = document.getElementById('jf');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const pick = n => [...main.querySelectorAll('[data-multi="' + n + '"] .on')].map(b => b.dataset.v);
      const body = { name: f.name.value, phone: f.phone.value, city: f.city.value, experience: f.experience.value, langs: pick('langs'), traditions: pick('traditions'), pujas: pick('pujas'), about: f.about.value };
      try { const r = await AX.api('/api/astro/pandits', { body }); status.pandit = r.pandit.status; AX.toast(t('Saved', 'सेव हो गया')); AX.nav.stack = [AX.nav.stack[0]]; AX.nav.go('me'); }
      catch (x) {
        const fld = x.body && x.body.field;
        join(Object.assign({}, cur || {}, body), { name: t('Add your name.', 'अपना नाम लिखें।'), phone: t('Add a phone number with 10 digits or more.', '10 या ज़्यादा अंकों का फ़ोन नंबर लिखें।'), langs: t('Pick at least one language.', 'कम से कम एक भाषा चुनें।'), pujas: t('Pick the pujas you perform.', 'आप जो पूजाएँ करते हैं वे चुनें।'), city: t('Pick your city.', 'अपना शहर चुनें।') }[fld] || t('Could not save. Try again.', 'सेव नहीं हुआ। फिर कोशिश करें।'));
      }
    });
  }
  function me() {
    if (!status.signedIn) { join(); return; }
    main.innerHTML = header(t('My pandit listing', 'मेरी पंडित लिस्टिंग')) + '<i class="ui-skel" style="height:140px"></i>';
    AX.api('/api/astro/pandit/me').then(r => {
      if (!r.pandit) { AX.nav.replace('join'); return; }
      const p = r.pandit, C = D.cities.find(c => c.id === p.city);
      let h = header(t('My pandit listing', 'मेरी पंडित लिस्टिंग'))
        + '<section class="ax-card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div class="ax-pandit"><span class="ax-av">' + esc((p.name[0] || 'P').toUpperCase()) + '</span><div><h3>' + esc(p.name) + '</h3><p class="ax-muted">' + esc((C ? AX.name(C) : p.city) + (p.experience ? ' · ' + p.experience + t(' years', ' वर्ष') : '')) + '</p></div></div><span class="ax-pill ' + p.status + '">' + esc(statusWord(p.status)) + '</span></div>'
        + '<p class="ax-body" style="margin-top:10px">' + esc(p.pujas.map(id => AX.name(pujaOf(id) || { n: id })).join(', ')) + '</p>'
        + (p.status === 'pending' ? '<p class="ax-note" style="margin-top:10px">' + ic('clock', 18) + '<span>' + esc(t('We will call you to verify, then families in your city can book you.', 'हम जाँच के लिए कॉल करेंगे, फिर आपके शहर के परिवार आपको बुक कर सकेंगे।')) + '</span></p>' : '')
        + '<div class="ax-row-btns"><button type="button" class="ui-btn ghost sm" id="edit">' + ic('pencil', 16) + esc(t('Edit', 'बदलें')) + '</button></div></section>';
      h += '<div class="ui-sec">' + esc(t('Your bookings', 'आपकी बुकिंग')) + '</div>';
      h += r.jobs.length ? r.jobs.map(b => '<section class="ax-card"><div style="display:flex;justify-content:space-between;gap:10px"><h3>' + esc(AX.name(pujaOf(b.puja) || { n: b.puja })) + '</h3><span class="ax-pill ' + b.status + '">' + esc(statusWord(b.status)) + '</span></div>'
        + '<p class="ax-muted">' + esc(AX.fmtDate(b.date) + ' · ' + timeWord(b.time) + ' · ' + pkgName(b.pkg) + ' · ' + AX.rupees(b.price)) + '</p>'
        + '<p class="ax-body" style="margin-top:6px">' + esc(b.contact_name) + ' · <a href="tel:' + esc(b.contact_phone) + '">' + esc(b.contact_phone) + '</a></p>'
        + (b.address ? '<p class="ax-body">' + esc(b.address) + '</p>' : '') + (b.notes ? '<p class="ax-small">' + esc(b.notes) + '</p>' : '') + '</section>').join('')
        : '<p class="tk-none">' + esc(t('No bookings yet. Confirmed bookings appear here with the family\'s contact.', 'अभी कोई बुकिंग नहीं। पक्की बुकिंग परिवार के संपर्क के साथ यहाँ दिखेंगी।')) + '</p>';
      main.innerHTML = h;
      document.getElementById('edit').addEventListener('click', () => AX.nav.go('edit', Object.assign({}, p)));
    }).catch(() => { main.innerHTML = header(t('My pandit listing', 'मेरी पंडित लिस्टिंग')) + '<p class="tk-none">' + esc(t('Could not load. Check your connection.', 'लोड नहीं हुआ। इंटरनेट जाँचें।')) + '</p>'; });
  }

  AX.nav.render = v => {
    if (!D) return;
    if (v.view === 'puja') puja(v.arg); else if (v.view === 'book') book(v.arg); else if (v.view === 'done') done(v.arg);
    else if (v.view === 'bookings') bookings(); else if (v.view === 'join') join(); else if (v.view === 'edit') join(v.arg); else if (v.view === 'me' || v.view === 'jobs') me(); else list();
  };
  main.innerHTML = '<i class="ui-skel" style="height:260px;margin-top:12px"></i>';
  Promise.all([AX.data(), AX.api('/api/astro/status').catch(() => status)]).then(([d, s]) => {
    D = d; status = s;
    const q = new URLSearchParams(location.search), v = q.get('v'), pj = q.get('puja');
    AX.nav.start('list');
    if (pj && pujaOf(pj)) AX.nav.go('puja', pj);
    else if (['bookings', 'join', 'me', 'jobs'].includes(v)) AX.nav.go(v);
  }).catch(() => { main.innerHTML = '<p class="tk-none">' + esc(t('Could not load. Check your connection.', 'लोड नहीं हुआ। इंटरनेट जाँचें।')) + '</p>'; });
})();
