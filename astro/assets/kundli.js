// Kundli (/astro/kundli.html): birth details → the Vedic chart (astro/assets/sky.js) with today's horoscope, the North
// Indian chart, planets, a reading of the lagna and Moon, planets in houses, doshas, lucky things and the dashas.
// Everything is worked out on the phone; the birth details stay in localStorage (astro.birth.v1).
(function () {
  'use strict';
  const { t, tx, esc, ic } = AX, X = window.AstroText, main = document.getElementById('main');
  bdTopbar({ back: '/astro/', backLabel: t('Jyotish', 'ज्योतिष'), title: t('Kundli', 'कुंडली') });
  let D = null, tab = 'today', dayOff = 0;
  const P = id => X.PLANETS[id], pn = id => (AX.hi ? P(id).h : P(id).n), sn = i => (AX.hi ? X.SIGNS[i].h : X.SIGNS[i].v + ' (' + X.SIGNS[i].n + ')');
  // English 1st…12th; Hindi in the oblique form ("दसवें भाव में")
  const HI_ORD = ['', 'पहले', 'दूसरे', 'तीसरे', 'चौथे', 'पाँचवें', 'छठे', 'सातवें', 'आठवें', 'नौवें', 'दसवें', 'ग्यारहवें', 'बारहवें'];
  const ord = n => (AX.hi ? HI_ORD[n] : n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'));
  const dms = d => Math.floor(d) + '°' + String(Math.floor((d % 1) * 60)).padStart(2, '0') + "'";
  const dateOfJd = jd => Sky.dateOfJd(jd);

  // ── birth details ──
  function form(err) {
    const b = AX.get('astro.birth.v1', null) || {}, cities = D.cities.slice().sort((a, c) => AX.name(a).localeCompare(AX.name(c)));
    const val = b.y ? b.y + '-' + String(b.m).padStart(2, '0') + '-' + String(b.d).padStart(2, '0') : '';
    const tm = b.y && b.timeKnown !== false ? String(b.hh).padStart(2, '0') + ':' + String(b.mm).padStart(2, '0') : '';
    const other = b.y && !b.city;
    main.innerHTML = '<header class="ui-page-h"><h1>' + esc(t('Your birth details', 'आपके जन्म की जानकारी')) + '</h1></header>'
      + '<p class="ax-lead">' + esc(t('The kundli is made on your phone and the details stay on it.', 'कुंडली आपके फ़ोन पर ही बनती है और जानकारी वहीं रहती है।')) + '</p>'
      + '<form class="ax-form ax-card" id="bf" novalidate>'
      + '<label>' + esc(t('Name', 'नाम')) + '<input class="ui-field" name="name" autocomplete="name" maxlength="60" value="' + esc(b.name || '') + '"></label>'
      + '<label>' + esc(t('Date of birth', 'जन्म तिथि')) + '<input class="ui-field" type="date" name="date" required min="1900-01-01" max="2100-12-31" value="' + esc(val) + '"></label>'
      + '<label>' + esc(t('Time of birth', 'जन्म का समय')) + '<input class="ui-field" type="time" name="time" value="' + esc(tm) + '"' + (b.y && b.timeKnown === false ? ' disabled' : '') + '></label>'
      + '<label class="ax-check"><input type="checkbox" name="notime"' + (b.y && b.timeKnown === false ? ' checked' : '') + '>' + esc(t("I don't know my birth time", 'मुझे जन्म का समय नहीं पता')) + '</label>'
      + '<label>' + esc(t('Place of birth', 'जन्म स्थान')) + '<select class="ui-field" name="city">'
      + cities.map(c => '<option value="' + c.id + '"' + (b.city === c.id || (!b.y && c.id === 'delhi') ? ' selected' : '') + '>' + esc(AX.name(c)) + '</option>').join('')
      + '<option value=""' + (other ? ' selected' : '') + '>' + esc(t('Another place…', 'कोई और जगह…')) + '</option></select></label>'
      + '<div id="other"' + (other ? '' : ' hidden') + ' class="ax-form"><label>' + esc(t('Place name', 'जगह का नाम')) + '<input class="ui-field" name="place" maxlength="60" value="' + esc(other ? b.place || '' : '') + '"></label>'
      + '<div class="ax-two"><label>' + esc(t('Latitude (north +)', 'अक्षांश (उत्तर +)')) + '<input class="ui-field" name="lat" inputmode="decimal" value="' + esc(other ? b.lat : '') + '"></label>'
      + '<label>' + esc(t('Longitude (east +)', 'देशांतर (पूर्व +)')) + '<input class="ui-field" name="lon" inputmode="decimal" value="' + esc(other ? b.lon : '') + '"></label></div>'
      + '<label>' + esc(t('Hours ahead of UTC (India 5.5)', 'UTC से घंटे आगे (भारत 5.5)')) + '<input class="ui-field" name="tz" inputmode="decimal" value="' + esc(other ? b.tz : '5.5') + '"></label></div>'
      + (err ? '<p class="ax-err" role="alert">' + esc(err) + '</p>' : '')
      + '<button class="ui-btn accent wide" type="submit">' + esc(t('Make my kundli', 'मेरी कुंडली बनाएँ')) + '</button></form>'
      + AX.disclaimer();
    const f = document.getElementById('bf');
    f.city.addEventListener('change', () => { document.getElementById('other').hidden = !!f.city.value; });
    f.notime.addEventListener('change', () => { f.time.disabled = f.notime.checked; });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date.value); if (!m) return form(t('Pick your date of birth.', 'जन्म तिथि चुनें।'));
      const timeKnown = !f.notime.checked, tm = /^(\d{2}):(\d{2})$/.exec(f.time.value || '');
      if (timeKnown && !tm) return form(t('Add the time of birth, or tick "I don\'t know".', 'जन्म का समय डालें, या "मुझे नहीं पता" चुनें।'));
      const nb = { name: f.name.value.trim().slice(0, 60), y: +m[1], m: +m[2], d: +m[3], hh: tm ? +tm[1] : 12, mm: tm ? +tm[2] : 0, timeKnown };
      if (f.city.value) { const c = D.cities.find(x => x.id === f.city.value); Object.assign(nb, { city: c.id, lat: c.lat, lon: c.lon, tz: 5.5, place: c.n }); }
      else {
        const lat = parseFloat(f.lat.value), lon = parseFloat(f.lon.value), tz = parseFloat(f.tz.value);
        if (!(Math.abs(lat) <= 66) || !(Math.abs(lon) <= 180) || !(Math.abs(tz) <= 14)) return form(t('Check the latitude, longitude and UTC hours.', 'अक्षांश, देशांतर और UTC घंटे जाँचें।'));
        Object.assign(nb, { city: '', lat, lon, tz, place: f.place.value.trim().slice(0, 60) });
      }
      AX.set('astro.birth.v1', nb); tab = 'today'; dayOff = 0;
      AX.nav.start('chart');
    });
  }

  // ── the North Indian chart (houses fixed, signs move; house 1 at the top) ──
  const HOUSE_XY = [null, [150, 82, 150, 136], [75, 30, 75, 63], [27, 77, 62, 77], [80, 152, 135, 152], [27, 227, 62, 227], [75, 276, 75, 242],
    [150, 222, 150, 168], [225, 276, 225, 242], [273, 227, 238, 227], [220, 152, 166, 152], [273, 77, 238, 77], [225, 30, 225, 63]];
  function chartSvg(ch) {
    const per = n => (n === 1 || n === 4 || n === 7 || n === 10 ? 3 : 2);
    let s = '<svg class="ax-chart" viewBox="-4 -4 308 308" role="img" aria-label="' + esc(t('North Indian chart', 'उत्तर भारतीय कुंडली चार्ट')) + '">'
      + '<polygon class="h1" points="150,0 225,75 150,150 75,75"/>'
      + '<rect class="ln" x="0" y="0" width="300" height="300"/><path class="ln" d="M0 0L300 300M300 0L0 300M150 0L300 150L150 300L0 150Z"/>';
    for (let h = 1; h <= 12; h++) {
      const [cx, cy, sx, sy] = HOUSE_XY[h], sign = (ch.base + h - 1) % 12;
      s += '<text class="sg" x="' + sx + '" y="' + sy + '" text-anchor="middle" dominant-baseline="middle">' + (sign + 1) + '</text>';
      const items = ch.planets.filter(p => p.house === h).map(p => ({ c: '', l: (AX.hi ? P(p.id).abh : P(p.id).ab) + (p.retro && p.id !== 'rahu' && p.id !== 'ketu' ? '*' : '') }));
      if (h === 1 && ch.timeKnown) items.unshift({ c: ' asc', l: AX.hi ? 'ल' : 'Asc' });
      const lines = []; for (let i = 0; i < items.length; i += per(h)) lines.push(items.slice(i, i + per(h)));
      const y0 = cy - (lines.length - 1) * 8;
      lines.forEach((ln, i) => {
        s += '<text x="' + cx + '" y="' + (y0 + i * 16) + '" text-anchor="middle" dominant-baseline="middle">' + ln.map(it => '<tspan class="pl' + it.c + '">' + esc(it.l) + '</tspan>').join('<tspan> </tspan>') + '</text>';
      });
    }
    return s + '</svg>';
  }

  const dots = n => '<span class="ax-score" role="img" aria-label="' + esc(t(n + ' of 5', '5 में ' + n)) + '">' + [1, 2, 3, 4, 5].map(i => '<i class="' + (i <= n ? 'on' : '') + '"></i>').join('') + '</span>';
  const kv = (k, v) => '<div><small>' + esc(k) + '</small><b>' + esc(v) + '</b></div>';
  const sec = (title, body) => '<section class="ax-card"><h2>' + esc(title) + '</h2>' + body + '</section>';

  function todayTab(ch, b) {
    const date = new Date(Date.now() + dayOff * 86400000), city = D.cities.find(c => c.id === (AX.get('astro.city', '') || b.city)) || null;
    const pl = city ? { lat: city.lat, lon: city.lon, tz: 5.5, name: AX.name(city) } : { lat: b.lat, lon: b.lon, tz: b.tz, name: b.place || '' };
    const day = Sky.today(ch, { date, lat: pl.lat, lon: pl.lon, tz: pl.tz }), pc = day.panchang;
    const tithi = pc.tithi === 30 ? tx(X.AMAVASYA) : tx(X.TITHIS[pc.tithiInPaksha - 1]);
    let h = '<div class="ax-chips wrap" style="margin-bottom:12px">' + [[0, t('Today', 'आज')], [1, t('Tomorrow', 'कल')]].map(([o, l]) => '<button type="button" class="ax-chip' + (dayOff === o ? ' on' : '') + '" data-day="' + o + '">' + esc(l) + '</button>').join('') + '</div>';
    h += '<section class="ax-card ax-today"><div class="ax-th"><div><h2>' + esc(AX.fmtDateAt(date, pl.tz, { weekday: 'long', day: 'numeric', month: 'long' })) + '</h2>'
      + '<p class="ax-muted">' + esc(AX.hi ? 'चंद्रमा आपकी चंद्र राशि से ' + ord(day.house) + ' भाव में' : 'Moon in your ' + ord(day.house) + ' house from your Moon sign') + '</p></div>' + dots(day.score) + '</div>'
      + '<p class="ax-body">' + esc(tx(X.GOCHAR[day.house])) + '</p>'
      + '<p class="ax-muted">' + esc(t('Star of the day: ', 'आज का तारा: ') + tx(X.TARA[day.tara])) + '</p></section>';
    h += sec(t('Panchang', 'पंचांग'), '<div class="ax-kv">' + kv(t('Tithi', 'तिथि'), tithi + ', ' + tx(X.PAKSHA[pc.paksha])) + kv(t('Nakshatra', 'नक्षत्र'), tx(X.NAKSHATRAS[pc.nakshatra.index]))
      + kv(t('Yoga', 'योग'), tx(X.YOGAS[pc.yoga - 1])) + kv(t('Day', 'वार'), tx(X.WEEKDAYS[pc.weekday]))
      + kv(t('Sunrise', 'सूर्योदय'), AX.fmtH(pc.sunrise)) + kv(t('Sunset', 'सूर्यास्त'), AX.fmtH(pc.sunset))
      + kv(t('Rahu kaal (avoid starts)', 'राहु काल (शुरुआत टालें)'), AX.fmtRange(pc.rahuKaal)) + kv(t('Abhijit muhurat (good)', 'अभिजीत मुहूर्त (शुभ)'), AX.fmtRange(pc.abhijit)) + '</div>'
      + '<p class="ax-small" style="margin-top:8px">' + esc(t('Times for ', 'समय: ') + pl.name + t('. The tithi and nakshatra are at this moment.', '। तिथि और नक्षत्र इस समय के हैं।')) + '</p>');
    const sat = day.saturn;
    h += sec(t('Saturn and your dasha now', 'शनि और आपकी अभी की दशा'), '<p class="ax-body">' + esc(sat.kind === 'sadesati' ? tx(X.DOSHA.sadesati[sat.phase]) : sat.kind === 'dhaiya' ? tx(X.DOSHA.dhaiya) : tx(X.DOSHA.nosadesati)) + '</p>'
      + (day.dasha ? '<p class="ax-body"><b>' + esc(pn(day.dasha.md.lord) + (day.dasha.ad ? ' / ' + pn(day.dasha.ad.lord) : '') + t(' dasha', ' दशा')) + '</b> · ' + esc(AX.fmtDate(dateOfJd(day.dasha.md.end), { month: 'short', year: 'numeric' }) + t(' end', ' तक')) + '</p>'
        + '<p class="ax-body">' + esc(tx(X.DASHA_TEXT[day.dasha.md.lord])) + '</p>' : ''));
    return h;
  }

  function chartTab(ch) {
    let h = sec(ch.timeKnown ? t('Birth chart (Lagna kundli)', 'जन्म कुंडली (लग्न कुंडली)') : t('Moon chart (Chandra kundli)', 'चंद्र कुंडली'),
      chartSvg(ch) + '<p class="ax-small ax-center" style="margin-top:6px">' + esc(t('Numbers are signs (1 Aries … 12 Pisces). * retrograde.', 'अंक राशियाँ हैं (1 मेष … 12 मीन)। * वक्री।')) + '</p>'
      + (ch.timeKnown ? '' : '<p class="ax-note" style="margin-top:10px">' + ic('info', 18) + '<span>' + esc(t('Without a birth time the houses are counted from your Moon sign. The lagna needs the time.', 'जन्म समय के बिना भाव चंद्र राशि से गिने गए हैं। लग्न के लिए समय चाहिए।')) + '</span></p>'));
    const rows = ch.planets.map(p => '<tr><td><b>' + esc(pn(p.id)) + '</b>' + (p.retro && p.id !== 'rahu' && p.id !== 'ketu' ? '<span class="ax-tag">' + esc(t('R', 'व')) + '</span>' : '')
      + (p.dignity === 'exalted' ? '<span class="ax-tag good">' + esc(t('exalted', 'उच्च')) + '</span>' : p.dignity === 'debilitated' ? '<span class="ax-tag bad">' + esc(t('debilitated', 'नीच')) + '</span>' : p.dignity === 'own' ? '<span class="ax-tag good">' + esc(t('own', 'स्वगृही')) + '</span>' : '')
      + '</td><td>' + esc(AX.hi ? X.SIGNS[p.sign].h : X.SIGNS[p.sign].v) + ' ' + dms(p.deg) + '</td><td>' + esc(tx(X.NAKSHATRAS[p.nakshatra.index])) + ' ' + p.nakshatra.pada + '</td><td>' + p.house + '</td></tr>').join('');
    h += sec(t('Planets', 'ग्रह'), '<table class="ax-table"><thead><tr><th>' + esc(t('Planet', 'ग्रह')) + '</th><th>' + esc(t('Sign', 'राशि')) + '</th><th>' + esc(t('Nakshatra', 'नक्षत्र')) + '</th><th>' + esc(t('House', 'भाव')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="ax-small" style="margin-top:8px">' + esc(t('Sidereal (Lahiri ayanamsa ', 'निरयण (लाहिड़ी अयनांश ') + dms(ch.ayanamsa) + t('), whole-sign houses, mean Rahu.', '), पूर्ण राशि भाव, मध्यम राहु।')) + '</p>');
    return h;
  }

  function lifeTab(ch) {
    let h = '';
    if (ch.timeKnown) h += sec(t('Your lagna: ', 'आपका लग्न: ') + sn(ch.lagna), '<p class="ax-muted">' + esc(t('How the world sees you', 'दुनिया आपको कैसे देखती है')) + '</p><p class="ax-body">' + esc(tx(X.SIGN_TRAIT[ch.lagna])) + '</p>');
    h += sec(t('Your Moon sign: ', 'आपकी चंद्र राशि: ') + sn(ch.rashi), '<p class="ax-muted">' + esc(t('Your inner mind and feelings', 'आपका मन और भावनाएँ')) + '</p><p class="ax-body">' + esc(tx(X.SIGN_TRAIT[ch.rashi])) + '</p>'
      + '<p class="ax-body">' + esc(t('Born in ', 'जन्म नक्षत्र: ') + tx(X.NAKSHATRAS[ch.nakshatra.index]) + t(' nakshatra, pada ', ', चरण ') + ch.nakshatra.pada + t(', ruled by ', ', स्वामी ') + pn(ch.nakshatra.lord) + '.') + '</p>');
    h += sec(t('Planets in your houses', 'आपके भावों में ग्रह'), '<div class="ax-stack">' + ch.planets.map(p => '<div><h3>' + esc(AX.hi ? pn(p.id) + ' ' + ord(p.house) + ' भाव में' : pn(p.id) + ' in the ' + ord(p.house) + ' house') + '</h3>'
      + '<p class="ax-body">' + esc(AX.hi ? P(p.id).kw.hi + ' आपके ' + X.HOUSES[p.house].hi + ' पर असर डालते हैं' : cap(P(p.id).kw.en) + ' shape your ' + X.HOUSES[p.house].en) + (p.dignity ? '; ' + esc(tx(X.DIGNITY[p.dignity])) : '') + '.</p></div>').join('') + '</div>');
    const ph = Sky.saturnPhase(ch.rashi, Sky.jdOfDate(new Date()));
    h += sec(t('Doshas', 'दोष'), '<div class="ax-stack"><div><h3>' + esc(t('Mangal dosha', 'मंगल दोष')) + '</h3><p class="ax-body">' + esc(tx(X.DOSHA.mangal[ch.mangal.level])) + '</p>' + (ch.mangal.present ? '<a class="ui-btn sm sec" style="margin-top:8px" href="/astro/pandit.html?puja=mangaldosh">' + esc(t('Book Mangal dosh puja', 'मंगल दोष पूजा बुक करें')) + '</a>' : '') + '</div>'
      + '<div><h3>' + esc(t('Kaal Sarp', 'काल सर्प')) + '</h3><p class="ax-body">' + esc(tx(ch.kaalSarp ? X.DOSHA.kaalsarp.yes : X.DOSHA.kaalsarp.no)) + '</p>' + (ch.kaalSarp ? '<a class="ui-btn sm sec" style="margin-top:8px" href="/astro/pandit.html?puja=kaalsarp">' + esc(t('Book Kaal Sarp puja', 'काल सर्प पूजा बुक करें')) + '</a>' : '') + '</div>'
      + '<div><h3>' + esc(t('Sade Sati', 'साढ़े साती')) + '</h3><p class="ax-body">' + esc(ph.kind === 'sadesati' ? tx(X.DOSHA.sadesati[ph.phase]) : ph.kind === 'dhaiya' ? tx(X.DOSHA.dhaiya) : tx(X.DOSHA.nosadesati)) + '</p>' + (ph.kind !== 'none' ? '<a class="ui-btn sm sec" style="margin-top:8px" href="/astro/pandit.html?puja=shanishanti">' + esc(t('Book Shani shanti', 'शनि शांति बुक करें')) + '</a>' : '') + '</div></div>');
    const lord = ch.lord.lagna || ch.lord.rashi, L = X.LUCKY[lord];
    h += sec(t('Lucky for you', 'आपके लिए शुभ'), '<div class="ax-kv">' + kv(t('Number', 'अंक'), String(L.num)) + kv(t('Colour', 'रंग'), tx(L.col)) + kv(t('Day', 'दिन'), tx(X.WEEKDAYS[X.WEEKDAY_OF[lord]])) + kv(t('Gemstone', 'रत्न'), tx(L.gem)) + '</div>'
      + '<p class="ax-small" style="margin-top:8px">' + esc(t('From your ', 'आपके ') + (ch.lord.lagna ? t('lagna', 'लग्न') : t('rashi', 'राशि')) + t(' lord, ', ' स्वामी ') + pn(lord) + t('. Ask a jyotishi before wearing a gemstone.', ' से। रत्न पहनने से पहले ज्योतिषी से पूछें।')) + '</p>'
      + '<a class="ui-btn sm sec" style="margin-top:10px" href="/astro/pandit.html?puja=kundli">' + esc(t('Talk to a jyotishi', 'ज्योतिषी से बात करें')) + '</a>');
    return h;
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function dashaTab(ch) {
    const now = Sky.jdOfDate(new Date()), cur = Sky.currentDasha(ch.dashas, now);
    let h = '';
    if (cur) {
      h += sec(t('Now: ', 'अभी: ') + pn(cur.md.lord) + t(' mahadasha', ' महादशा'), '<p class="ax-muted">' + esc(AX.fmtDate(dateOfJd(cur.md.start), { month: 'short', year: 'numeric' }) + ' – ' + AX.fmtDate(dateOfJd(cur.md.end), { month: 'short', year: 'numeric' })) + '</p>'
        + '<p class="ax-body">' + esc(tx(X.DASHA_TEXT[cur.md.lord])) + '</p>'
        + '<div class="ui-sec" style="margin:16px 0 8px">' + esc(t('Antardashas in this period', 'इस दशा की अंतर्दशाएँ')) + '</div><div class="ax-dasha">'
        + cur.md.subs.map(s => '<div class="d' + (s === cur.ad ? ' now' : '') + '"><b>' + esc(pn(cur.md.lord) + ' / ' + pn(s.lord)) + '</b><small>' + esc(AX.fmtDate(dateOfJd(s.start), { month: 'short', year: 'numeric' }) + ' – ' + AX.fmtDate(dateOfJd(s.end), { month: 'short', year: 'numeric' })) + '</small></div>').join('') + '</div>');
    }
    h += sec(t('Vimshottari mahadashas', 'विंशोत्तरी महादशा'), '<div class="ax-dasha">' + ch.dashas.filter(m => m.end > ch.jd && Sky.dateOfJd(m.start).getFullYear() < ch.input.y + 100).map(m => '<div class="d' + (cur && m === cur.md ? ' now' : '') + '"><b>' + esc(pn(m.lord)) + ' <span class="ax-small">' + m.years + t(' yrs', ' वर्ष') + '</span></b><small>'
      + esc(AX.fmtDate(dateOfJd(Math.max(m.start, ch.jd)), { month: 'short', year: 'numeric' }) + ' – ' + AX.fmtDate(dateOfJd(m.end), { month: 'short', year: 'numeric' })) + '</small></div>').join('') + '</div>'
      + '<p class="ax-small" style="margin-top:8px">' + esc(t('The first period is the balance left at birth, from your Moon nakshatra.', 'पहली दशा जन्म के समय बची अवधि है, चंद्र नक्षत्र से।')) + '</p>');
    return h;
  }

  function chartView() {
    const b = AX.get('astro.birth.v1', null); if (!b) { AX.nav.replace('form'); return; }
    let ch; try { ch = Sky.chart(b); } catch (e) { AX.nav.replace('form'); return; }
    const when = AX.fmtDate(new Date(Date.UTC(b.y, b.m - 1, b.d, 12)), { day: 'numeric', month: 'long', year: 'numeric' }) + (b.timeKnown !== false ? ', ' + AX.fmtH(b.hh + b.mm / 60) : '');
    const city = D.cities.find(c => c.id === b.city);
    let h = '<header class="ui-page-h"><h1>' + esc(b.name || t('My kundli', 'मेरी कुंडली')) + '</h1></header>'
      + '<p class="ax-lead">' + esc(when + ' · ' + (city ? AX.name(city) : b.place || (b.lat.toFixed(2) + ', ' + b.lon.toFixed(2)))) + '</p>';
    h += '<section class="ax-card"><div class="ax-kv">' + kv(t('Rashi (Moon sign)', 'राशि (चंद्र)'), sn(ch.rashi)) + kv(t('Nakshatra', 'नक्षत्र'), tx(X.NAKSHATRAS[ch.nakshatra.index]) + ' · ' + t('pada ', 'चरण ') + ch.nakshatra.pada)
      + kv(t('Lagna (ascendant)', 'लग्न'), ch.timeKnown ? sn(ch.lagna) : t('Needs birth time', 'जन्म समय चाहिए')) + kv(t('Sun sign', 'सूर्य राशि'), sn(ch.sunSign) + (AX.hi ? '' : ' · Western ' + X.SIGNS[ch.westernSign].n)) + '</div>'
      + '<div class="ax-row-btns"><button type="button" class="ui-btn ghost sm" id="edit">' + ic('pencil', 16) + esc(t('Edit details', 'जानकारी बदलें')) + '</button></div></section>';
    h += '<div style="margin:16px 0 12px;overflow-x:auto"><div class="ui-seg" role="tablist">' + [['today', t('Today', 'आज')], ['chart', t('Chart', 'चार्ट')], ['life', t('Reading', 'फलादेश')], ['dasha', t('Dasha', 'दशा')]]
      .map(([k, l]) => '<button type="button" role="tab" data-tab="' + k + '" aria-pressed="' + (tab === k) + '"' + (tab === k ? ' class="on"' : '') + '>' + esc(l) + '</button>').join('') + '</div></div>';
    h += '<div id="tabBody">' + (tab === 'today' ? todayTab(ch, b) : tab === 'chart' ? chartTab(ch) : tab === 'life' ? lifeTab(ch) : dashaTab(ch)) + '</div>';
    h += AX.disclaimer();
    main.innerHTML = h;
    document.getElementById('edit').addEventListener('click', () => AX.nav.go('form'));
    main.querySelectorAll('[data-tab]').forEach(x => x.addEventListener('click', () => { tab = x.dataset.tab; chartView(); }));
    main.querySelectorAll('[data-day]').forEach(x => x.addEventListener('click', () => { dayOff = +x.dataset.day; chartView(); }));
  }

  AX.nav.render = v => { if (!D) return; if (v.view === 'form') form(); else chartView(); };
  main.innerHTML = '<i class="ui-skel" style="height:220px;margin-top:12px"></i>';
  AX.data().then(d => { D = d; AX.nav.start(AX.get('astro.birth.v1', null) ? 'chart' : 'form'); }).catch(() => { main.innerHTML = '<p class="tk-none">' + esc(t('Could not load. Check your connection.', 'लोड नहीं हुआ। इंटरनेट जाँचें।')) + '</p>'; });
})();
