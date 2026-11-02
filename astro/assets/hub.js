// Jyotish home (/astro/): today's horoscope (from your kundli, else your rashi), then Palm reading, Kundli and pandit
// booking. Birth details live on the phone only (astro.birth.v1); a rashi picked here is astro.rashi.v1.
(function () {
  'use strict';
  const { t, tx, esc, ic } = AX, X = window.AstroText, main = document.getElementById('main');
  bdTopbar({ title: t('Jyotish', 'ज्योतिष') });
  let status = { signedIn: !!AX.token() }, cities = null;

  function row(o) {
    return '<a class="ui-row" href="' + o.href + '"' + (o.id ? ' data-id="' + o.id + '"' : '') + '><span class="ui-ic" style="--ui-accent:' + o.accent + '" aria-hidden="true">' + ic(o.icon, 22) + '</span>'
      + '<span class="ui-tx"><b>' + esc(o.title) + '</b>' + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</span><span class="ui-chev">' + ic('chevron-right', 18) + '</span></a>';
  }
  const dots = n => '<span class="ax-score" role="img" aria-label="' + esc(t(n + ' of 5', '5 में ' + n)) + '">' + [1, 2, 3, 4, 5].map(i => '<i class="' + (i <= n ? 'on' : '') + '"></i>').join('') + '</span>';
  function place() {
    const b = AX.get('astro.birth.v1', null), id = AX.get('astro.city', '') || (b && b.city) || 'delhi';
    const c = (cities || []).find(x => x.id === id);
    return c ? { lat: c.lat, lon: c.lon, tz: 5.5, name: AX.name(c) } : b && b.lat != null ? { lat: b.lat, lon: b.lon, tz: b.tz, name: b.place || '' } : { lat: 28.6139, lon: 77.209, tz: 5.5, name: t('Delhi NCR', 'दिल्ली एनसीआर') };
  }

  function todayCard() {
    const b = AX.get('astro.birth.v1', null), rashi = AX.get('astro.rashi.v1', null), P = place(), now = new Date();
    let day = null, sign = null;
    if (b) { try { const ch = Sky.chart(b); day = Sky.today(ch, { date: now, lat: P.lat, lon: P.lon, tz: P.tz }); sign = ch.rashi; } catch (e) { day = null; } }
    else if (rashi != null) { day = Sky.todayForSign(rashi, { date: now, lat: P.lat, lon: P.lon, tz: P.tz }); sign = rashi; }
    const date = AX.fmtDateAt(now, P.tz, { weekday: 'long', day: 'numeric', month: 'long' });
    if (!day) {
      return '<section class="ax-card"><h2>' + esc(t('Your day, in the stars', 'आपका दिन, सितारों में')) + '</h2>'
        + '<p class="ax-muted">' + esc(t('Add your birth details for a daily horoscope from your own kundli, or pick your rashi (Moon sign).', 'अपनी कुंडली से रोज़ का राशिफल पाने के लिए जन्म की जानकारी जोड़ें, या अपनी राशि (चंद्र राशि) चुनें।')) + '</p>'
        + '<div class="ax-row-btns"><a class="ui-btn accent" href="/astro/kundli.html">' + esc(t('Add birth details', 'जन्म की जानकारी जोड़ें')) + '</a></div>'
        + '<div class="ui-sec" style="margin:18px 0 8px">' + esc(t('Or pick your rashi', 'या अपनी राशि चुनें')) + '</div>'
        + '<div class="ax-chips wrap">' + X.SIGNS.map((s, i) => '<button type="button" class="ax-chip" data-rashi="' + i + '">' + esc(AX.hi ? s.h : s.v + ' · ' + s.n) + '</button>').join('') + '</div></section>';
    }
    const pc = day.panchang, s = X.SIGNS[sign];
    const tithi = pc.tithi === 30 ? tx(X.AMAVASYA) : tx(X.TITHIS[pc.tithiInPaksha - 1]);
    return '<section class="ax-card ax-today" aria-labelledby="axTodayT"><div class="ax-th"><div><h2 id="axTodayT">' + esc(AX.hi ? 'आज का दिन: ' + s.h + ' राशि' : 'Today for ' + s.v + ' (' + s.n + ')') + '</h2>'
      + '<p class="ax-muted">' + esc(date) + '</p></div>' + dots(day.score) + '</div>'
      + '<p class="ax-body">' + esc(tx(X.GOCHAR[day.house])) + '</p>'
      + (day.tara ? '<p class="ax-muted">' + esc(t('Star of the day: ', 'आज का तारा: ') + tx(X.TARA[day.tara])) + '</p>' : '')
      + '<div class="ax-kv"><div><small>' + esc(t('Tithi', 'तिथि')) + '</small><b>' + esc(tithi + ', ' + tx(X.PAKSHA[pc.paksha])) + '</b></div>'
      + '<div><small>' + esc(t('Nakshatra', 'नक्षत्र')) + '</small><b>' + esc(tx(X.NAKSHATRAS[pc.nakshatra.index])) + '</b></div>'
      + '<div><small>' + esc(t('Rahu kaal', 'राहु काल')) + '</small><b>' + esc(AX.fmtRange(pc.rahuKaal)) + '</b></div>'
      + '<div><small>' + esc(t('Abhijit muhurat', 'अभिजीत मुहूर्त')) + '</small><b>' + esc(AX.fmtRange(pc.abhijit)) + '</b></div></div>'
      + '<p class="ax-small">' + esc(t('Times for ', 'समय: ') + P.name) + '</p>'
      + '<div class="ax-row-btns"><a class="ui-btn sec" href="/astro/kundli.html">' + esc(b ? t('Full horoscope', 'पूरा राशिफल') : t('Make my kundli', 'मेरी कुंडली बनाएँ')) + '</a></div></section>';
  }

  function draw() {
    const H = AX.hi;
    let h = '<header class="ui-page-h"><h1 id="axTitle">' + esc(t('Jyotish', 'ज्योतिष')) + '</h1></header>'
      + '<p class="ax-lead">' + esc(t('Palm reading, your kundli and a pandit for every occasion.', 'हस्तरेखा, आपकी कुंडली, और हर मौक़े के लिए पंडित जी।')) + '</p>';
    h += todayCard();
    h += '<div class="ui-sec">' + esc(t('Read', 'पढ़ें')) + '</div><div class="ui-list">'
      + row({ id: 'palm', href: '/astro/palm.html', accent: 'var(--g-palm)', icon: 'hand', title: t('Palm reading', 'हस्तरेखा'), sub: t('Camera or photo · heart, head, life, fate', 'कैमरा या फ़ोटो · हृदय, मस्तिष्क, जीवन, भाग्य') })
      + row({ id: 'kundli', href: '/astro/kundli.html', accent: 'var(--g-kundli)', icon: 'moon', title: t('Kundli and horoscope', 'कुंडली और राशिफल'), sub: t('Chart, planets, dashas, doshas, today', 'चार्ट, ग्रह, दशा, दोष, आज') })
      + '</div>';
    h += '<div class="ui-sec">' + esc(t('Pandit ji', 'पंडित जी')) + '</div><div class="ui-list">'
      + row({ id: 'pandit', href: '/astro/pandit.html', accent: 'var(--g-pandit)', icon: 'landmark', title: t('Book a pandit', 'पंडित बुक करें'), sub: t('34 pujas · 50 cities · usual local rates', '34 पूजाएँ · 50 शहर · स्थानीय दर') })
      + (status.signedIn ? row({ id: 'bookings', href: '/astro/pandit.html?v=bookings', accent: 'var(--g-pandit)', icon: 'calendar', title: t('My bookings', 'मेरी बुकिंग') }) : '')
      + row({ id: 'join', href: '/astro/pandit.html?v=' + (status.pandit ? 'me' : 'join'), accent: 'var(--g-pandit)', icon: 'user-plus', title: status.pandit ? t('My pandit listing', 'मेरी पंडित लिस्टिंग') : t('Are you a pandit? Join', 'क्या आप पंडित हैं? जुड़ें'), sub: status.pandit ? statusWord(status.pandit) : t('Get bookings from families in your city', 'अपने शहर के परिवारों से बुकिंग पाएँ') })
      + (status.admin ? row({ id: 'admin', href: '/astro/admin.html', accent: 'var(--b-ink)', icon: 'shield-check', title: t('Bookings admin', 'बुकिंग एडमिन'), sub: t('Verify pandits, confirm bookings', 'पंडित सत्यापित करें, बुकिंग पक्की करें') }) : '')
      + '</div>';
    h += AX.disclaimer();
    main.innerHTML = h;
    main.querySelectorAll('[data-rashi]').forEach(b => b.addEventListener('click', () => { AX.set('astro.rashi.v1', +b.dataset.rashi); draw(); }));
  }
  const statusWord = s => ({ pending: t('Waiting for verification', 'सत्यापन बाकी'), verified: t('Verified and listed', 'सत्यापित और सूचीबद्ध'), rejected: t('Not verified', 'सत्यापित नहीं'), paused: t('Paused', 'रुका हुआ') }[s] || '');

  AX.data().then(d => { cities = d.cities; draw(); }).catch(draw);
  draw();
  AX.api('/api/astro/status').then(s => { status = s; draw(); }).catch(() => { /* offline: the page still works */ });
})();
