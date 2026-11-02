// Brodoit Jyotish engine (v34): where the Sun, Moon and planets stand, and the Vedic chart made from them.
// Written for Brodoit from the published low-precision orbital elements (P. Schlyter, "How to compute planetary
// positions": Kepler orbits with the main lunar, Jupiter and Saturn perturbations, good to a few arc-minutes for
// 1900-2100), the IAU mean sidereal time, and the Lahiri (Chitrapaksha) ayanamsa. No code was copied from anywhere.
// Works as a classic script (window.Sky) and in Node (require), so the page and the tests use the same maths.
//
//   Sky.chart({ y, m, d, hh, mm, tz, lat, lon, timeKnown })   → the whole birth chart (see the end of the file)
//   Sky.today(natal, { date, lat, lon, tz })                   → today's horoscope from the Moon's transit
//   Sky.panchang(date, { lat, lon, tz })                       → tithi, nakshatra, yoga, sunrise, Rahu kaal
//   Sky.positions(jd)                                          → sidereal + tropical longitudes of the nine grahas
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sky = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const norm = x => ((x % 360) + 360) % 360;
  const sin = x => Math.sin(x * RAD), cos = x => Math.cos(x * RAD), tan = x => Math.tan(x * RAD);
  const atan2 = (y, x) => norm(Math.atan2(y, x) * DEG);

  // ── time ──
  // Julian day of a civil date and time in UT (Gregorian calendar).
  function julian(y, m, d, hUT) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + (hUT || 0) / 24;
  }
  // a local wall-clock time with a UTC offset in hours → Julian day
  const jdOfLocal = (y, m, d, hh, mm, tz) => julian(y, m, d, (hh || 0) + (mm || 0) / 60 - (tz || 0));
  const jdOfDate = date => date.getTime() / 86400000 + 2440587.5;
  const dateOfJd = jd => new Date((jd - 2440587.5) * 86400000);

  // ── the Sun, Moon and planets (geocentric, ecliptic of date) ──
  const ELEM = { // N, i, w, a, e, M  as [base, rate per day]
    sun: { N: [0, 0], i: [0, 0], w: [282.9404, 4.70935e-5], a: [1, 0], e: [0.016709, -1.151e-9], M: [356.0470, 0.9856002585] },
    moon: { N: [125.1228, -0.0529538083], i: [5.1454, 0], w: [318.0634, 0.1643573223], a: [60.2666, 0], e: [0.054900, 0], M: [115.3654, 13.0649929509] },
    mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.00e-8], w: [29.1241, 1.01444e-5], a: [0.387098, 0], e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
    venus: { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5], a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
    mars: { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
    jupiter: { N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5], a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
    saturn: { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
  };
  function elements(body, d) {
    const E = ELEM[body], o = {};
    for (const k in E) o[k] = E[k][0] + E[k][1] * d;
    o.N = norm(o.N); o.w = norm(o.w); o.M = norm(o.M);
    return o;
  }
  // solve Kepler's equation; returns the true anomaly v and distance r
  function orbit(o) {
    let E = o.M + o.e * DEG * sin(o.M) * (1 + o.e * cos(o.M));
    for (let k = 0; k < 12; k++) {
      const dE = (E - o.e * DEG * sin(E) - o.M) / (1 - o.e * cos(E));
      E -= dE; if (Math.abs(dE) < 1e-7) break;
    }
    const xv = o.a * (cos(E) - o.e), yv = o.a * Math.sqrt(1 - o.e * o.e) * sin(E);
    return { v: atan2(yv, xv), r: Math.hypot(xv, yv) };
  }
  function eclip(o, v, r) {
    const vw = v + o.w;
    const x = r * (cos(o.N) * cos(vw) - sin(o.N) * sin(vw) * cos(o.i));
    const y = r * (sin(o.N) * cos(vw) + cos(o.N) * sin(vw) * cos(o.i));
    const z = r * sin(vw) * sin(o.i);
    return { lon: atan2(y, x), lat: Math.atan2(z, Math.hypot(x, y)) * DEG, r: Math.hypot(x, y, z) };
  }
  // tropical geocentric longitudes (degrees) for d = days since 2000 Jan 0.0 UT
  function tropical(d) {
    const S = elements('sun', d), so = orbit(S), sunLon = norm(so.v + S.w);
    const xs = so.r * cos(sunLon), ys = so.r * sin(sunLon);
    const out = { sun: sunLon };
    // Moon: geocentric orbit + the twelve largest perturbations in longitude
    const Mo = elements('moon', d), mo = orbit(Mo), me = eclip(Mo, mo.v, mo.r);
    const Ls = S.M + S.w, Lm = Mo.M + Mo.w + Mo.N, D = Lm - Ls, F = Lm - Mo.N, Mm = Mo.M, Ms = S.M;
    out.moon = norm(me.lon
      - 1.274 * sin(Mm - 2 * D) + 0.658 * sin(2 * D) - 0.186 * sin(Ms)
      - 0.059 * sin(2 * Mm - 2 * D) - 0.057 * sin(Mm - 2 * D + Ms) + 0.053 * sin(Mm + 2 * D)
      + 0.046 * sin(2 * D - Ms) + 0.041 * sin(Mm - Ms) - 0.035 * sin(D)
      - 0.031 * sin(Mm + Ms) - 0.015 * sin(2 * F - 2 * D) + 0.011 * sin(Mm - 4 * D));
    // planets: heliocentric → geocentric (Jupiter and Saturn with their mutual perturbations)
    const Mj = elements('jupiter', d).M, Msa = elements('saturn', d).M;
    for (const p of ['mercury', 'venus', 'mars', 'jupiter', 'saturn']) {
      const o = elements(p, d), ob = orbit(o), h = eclip(o, ob.v, ob.r);
      let lon = h.lon, lat = h.lat;
      if (p === 'jupiter') lon += -0.332 * sin(2 * Mj - 5 * Msa - 67.6) - 0.056 * sin(2 * Mj - 2 * Msa + 21) + 0.042 * sin(3 * Mj - 5 * Msa + 21)
        - 0.036 * sin(Mj - 2 * Msa) + 0.022 * cos(Mj - Msa) + 0.023 * sin(2 * Mj - 3 * Msa + 52) - 0.016 * sin(Mj - 5 * Msa - 69);
      if (p === 'saturn') {
        lon += 0.812 * sin(2 * Mj - 5 * Msa - 67.6) - 0.229 * cos(2 * Mj - 4 * Msa - 2) + 0.119 * sin(Mj - 2 * Msa - 3)
          + 0.046 * sin(2 * Mj - 6 * Msa - 69) + 0.014 * sin(Mj - 3 * Msa + 32);
        lat += -0.020 * cos(2 * Mj - 4 * Msa - 2) + 0.018 * sin(2 * Mj - 6 * Msa - 49);
      }
      const x = h.r * cos(lon) * cos(lat) + xs, y = h.r * sin(lon) * cos(lat) + ys;
      out[p] = atan2(y, x);
    }
    out.rahu = norm(Mo.N); // the Moon's mean ascending node
    out.ketu = norm(Mo.N + 180);
    return out;
  }

  const dOf = jd => jd - 2451543.5;
  // Lahiri ayanamsa: 23°51'11" at J2000.0, precessing ~50.29" a year
  const ayanamsa = jd => { const T = (jd - 2451545.0) / 36525; return 23.853056 + 1.396971 * T + 0.0003086 * T * T; };
  const obliquity = jd => 23.4393 - 3.563e-7 * dOf(jd);
  // Greenwich mean sidereal time in degrees (IAU 1982)
  function gmst(jd) { const T = (jd - 2451545.0) / 36525; return norm(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000); }
  // the ecliptic degree rising in the east (tropical)
  function ascendant(jd, lat, lon) {
    const ramc = norm(gmst(jd) + lon), eps = obliquity(jd);
    return atan2(cos(ramc), -(sin(ramc) * cos(eps) + tan(lat) * sin(eps)));
  }

  // ── names and fixed tables ──
  const GRAHAS = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'];
  const SIGN_LORD = ['mars', 'venus', 'mercury', 'moon', 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn', 'jupiter'];
  const EXALT = { sun: 0, moon: 1, mars: 9, mercury: 5, jupiter: 3, venus: 11, saturn: 6 };
  const OWN = { sun: [4], moon: [3], mars: [0, 7], mercury: [2, 5], jupiter: [8, 11], venus: [1, 6], saturn: [9, 10] };
  const DASHA = [['ketu', 7], ['venus', 20], ['sun', 6], ['moon', 10], ['mars', 7], ['rahu', 18], ['jupiter', 16], ['saturn', 19], ['mercury', 17]];
  const NAK = 360 / 27, PADA = NAK / 4, YEAR = 365.25;

  function dignity(p, sign) {
    if (!(p in EXALT)) return '';
    if (EXALT[p] === sign) return 'exalted';
    if ((EXALT[p] + 6) % 12 === sign) return 'debilitated';
    if (OWN[p].includes(sign)) return 'own';
    return '';
  }

  // sidereal positions of the nine grahas at a Julian day (+ retrograde flags from the motion over a day)
  function positions(jd) {
    const ay = ayanamsa(jd), t0 = tropical(dOf(jd)), t1 = tropical(dOf(jd + 1));
    const out = {};
    for (const p of GRAHAS) {
      const sid = norm(t0[p] - ay);
      let speed = ((t1[p] - t0[p] + 540) % 360) - 180;
      out[p] = { lon: sid, trop: t0[p], sign: Math.floor(sid / 30), deg: sid % 30, speed, retro: p === 'rahu' || p === 'ketu' ? true : speed < 0 && p !== 'sun' && p !== 'moon' };
    }
    out.ayanamsa = ay;
    return out;
  }
  const nakOf = lon => { const k = Math.floor(norm(lon) / NAK); return { index: k, pada: Math.floor((norm(lon) - k * NAK) / PADA) + 1, lord: DASHA[k % 9][0], frac: (norm(lon) - k * NAK) / NAK }; };

  // ── Vimshottari dasha from the Moon's nakshatra ──
  function dashas(moonLon, birthJd) {
    const n = nakOf(moonLon), first = n.index % 9;
    let start = birthJd - n.frac * DASHA[first][1] * YEAR;
    const list = [];
    for (let k = 0; k < 10; k++) { // ten periods cover more than a lifetime
      const [lord, yrs] = DASHA[(first + k) % 9], end = start + yrs * YEAR;
      const subs = []; let s2 = start;
      for (let j = 0; j < 9; j++) {
        const [l2, y2] = DASHA[(first + k + j) % 9], e2 = s2 + (yrs * y2 / 120) * YEAR;
        subs.push({ lord: l2, start: s2, end: e2 }); s2 = e2;
      }
      list.push({ lord, years: yrs, start, end, subs });
      start = end;
    }
    return list;
  }
  function currentDasha(list, jd) {
    const md = list.find(x => jd >= x.start && jd < x.end); if (!md) return null;
    const ad = md.subs.find(x => jd >= x.start && jd < x.end) || null;
    return { md, ad };
  }

  // ── sunrise and sunset (the almanac method, ±2 min) ──
  // date: the local calendar day {y,m,d}; returns local hours (decimal) or null in polar day/night
  function sunEvent(y, m, d, lat, lon, tz, rising) {
    const N = Math.floor(julian(y, m, d, 12) - julian(y, 1, 1, 12)) + 1;
    const lngHour = lon / 15, t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = norm(M + 1.916 * sin(M) + 0.020 * sin(2 * M) + 282.634);
    let RA = norm(Math.atan(0.91764 * tan(L)) * DEG);
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * sin(L), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (cos(90.833) - sinDec * sin(lat)) / (cosDec * cos(lat));
    if (cosH > 1 || cosH < -1) return null;
    const H = (rising ? 360 - Math.acos(cosH) * DEG : Math.acos(cosH) * DEG) / 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (((T - lngHour + tz) % 24) + 24) % 24;
  }
  // local calendar parts of a moment at a UTC offset
  function localParts(date, tz) {
    const x = new Date(date.getTime() + tz * 3600000);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), wd: x.getUTCDay(), h: x.getUTCHours() + x.getUTCMinutes() / 60 };
  }
  const RAHU_PART = [8, 2, 7, 5, 6, 4, 3];   // which eighth of the day, Sunday..Saturday
  const YAMA_PART = [5, 4, 3, 2, 1, 7, 6];

  function panchang(date, place) {
    place = place || {}; const tz = place.tz != null ? place.tz : 5.5, lat = place.lat != null ? place.lat : 28.6139, lon = place.lon != null ? place.lon : 77.2090;
    const jd = jdOfDate(date), P = positions(jd), L = localParts(date, tz);
    const elong = norm(P.moon.lon - P.sun.lon), tithi = Math.floor(elong / 12) + 1;
    const yoga = Math.floor(norm(P.sun.lon + P.moon.lon) / NAK) + 1;
    const rise = sunEvent(L.y, L.m, L.d, lat, lon, tz, true), set = sunEvent(L.y, L.m, L.d, lat, lon, tz, false);
    let rahu = null, yama = null, abhijit = null;
    if (rise != null && set != null) {
      const part = (set - rise) / 8, mid = (rise + set) / 2, muhurta = (set - rise) / 15;
      rahu = [rise + (RAHU_PART[L.wd] - 1) * part, rise + RAHU_PART[L.wd] * part];
      yama = [rise + (YAMA_PART[L.wd] - 1) * part, rise + YAMA_PART[L.wd] * part];
      abhijit = [mid - muhurta / 2, mid + muhurta / 2];
    }
    return {
      tithi, paksha: tithi <= 15 ? 'shukla' : 'krishna', tithiInPaksha: ((tithi - 1) % 15) + 1,
      nakshatra: nakOf(P.moon.lon), yoga, moonSign: P.moon.sign, sunSign: P.sun.sign, weekday: L.wd,
      sunrise: rise, sunset: set, rahuKaal: rahu, yamaganda: yama, abhijit, positions: P,
    };
  }

  // ── the birth chart ──
  // b: { y, m, d, hh, mm, tz (hours east of UTC), lat, lon (east +), timeKnown (default true) }
  function chart(b) {
    const timeKnown = b.timeKnown !== false;
    const jd = jdOfLocal(b.y, b.m, b.d, timeKnown ? b.hh : 12, timeKnown ? b.mm : 0, b.tz);
    const P = positions(jd), ay = P.ayanamsa;
    const ascTrop = ascendant(jd, b.lat, b.lon), asc = norm(ascTrop - ay), lagna = Math.floor(asc / 30);
    // whole-sign houses from the lagna (from the Moon when the time is unknown: Chandra lagna)
    const base = timeKnown ? lagna : P.moon.sign;
    const planets = GRAHAS.map(p => Object.assign({ id: p }, P[p], {
      house: ((P[p].sign - base + 12) % 12) + 1, nakshatra: nakOf(P[p].lon), dignity: dignity(p, P[p].sign),
    }));
    const by = Object.fromEntries(planets.map(p => [p.id, p]));
    const moonNak = nakOf(P.moon.lon);
    const md = dashas(P.moon.lon, jd);
    // Mangal dosha: Mars in the 1st, 2nd, 4th, 7th, 8th or 12th from the lagna and/or from the Moon
    const MANGAL = [1, 2, 4, 7, 8, 12];
    const marsFromMoon = ((P.mars.sign - P.moon.sign + 12) % 12) + 1;
    const mangal = { fromLagna: timeKnown && MANGAL.includes(by.mars.house), fromMoon: MANGAL.includes(marsFromMoon) };
    mangal.present = mangal.fromLagna || mangal.fromMoon;
    mangal.level = mangal.fromLagna && mangal.fromMoon ? 'full' : mangal.present ? 'partial' : 'none';
    // Kaal Sarp: the seven planets all on one side of the Rahu-Ketu axis
    const side = GRAHAS.slice(0, 7).map(p => norm(P[p].lon - P.rahu.lon) < 180);
    const kaalSarp = side.every(Boolean) || side.every(x => !x);
    return {
      input: b, jd, timeKnown, ayanamsa: ay, ascendant: timeKnown ? asc : null, lagna: timeKnown ? lagna : null,
      lagnaDeg: timeKnown ? asc % 30 : null, base, planets, by, rashi: P.moon.sign, sunSign: P.sun.sign,
      westernSign: Math.floor(P.sun.trop / 30), nakshatra: moonNak, dashas: md, mangal, kaalSarp,
      lord: { lagna: timeKnown ? SIGN_LORD[lagna] : null, rashi: SIGN_LORD[P.moon.sign], nakshatra: moonNak.lord },
    };
  }

  // Sade Sati and Dhaiya: transiting Saturn in the 12th, 1st or 2nd (4th or 8th) from the natal Moon sign
  function saturnPhase(natalMoonSign, jd) {
    const s = positions(jd).saturn.sign, h = ((s - natalMoonSign + 12) % 12) + 1;
    if (h === 12) return { kind: 'sadesati', phase: 1, house: h };
    if (h === 1) return { kind: 'sadesati', phase: 2, house: h };
    if (h === 2) return { kind: 'sadesati', phase: 3, house: h };
    if (h === 4 || h === 8) return { kind: 'dhaiya', house: h };
    return { kind: 'none', house: h };
  }

  // Today from the natal Moon: the Moon's transit house (Chandra gochar) and the day's star strength (Tara bala)
  const GOCHAR = [0, 3, 2, 5, 2, 3, 5, 4, 1, 3, 5, 5, 2];     // index = house 1..12
  const TARA = [0, 3, 5, 2, 4, 2, 5, 1, 4, 5];               // index = tara 1..9
  function today(natal, o) {
    o = o || {}; const date = o.date || new Date();
    const pc = panchang(date, { lat: o.lat, lon: o.lon, tz: o.tz });
    const house = ((pc.moonSign - natal.rashi + 12) % 12) + 1;
    const tara = ((pc.nakshatra.index - natal.nakshatra.index + 27) % 27) % 9 + 1;
    const score = Math.max(1, Math.min(5, Math.round((GOCHAR[house] + TARA[tara]) / 2)));
    return { house, tara, score, panchang: pc, saturn: saturnPhase(natal.rashi, jdOfDate(date)), dasha: currentDasha(natal.dashas, jdOfDate(date)) };
  }
  // the day for someone who only knows their Moon sign (rashi)
  function todayForSign(sign, o) {
    o = o || {}; const date = o.date || new Date();
    const pc = panchang(date, { lat: o.lat, lon: o.lon, tz: o.tz });
    const house = ((pc.moonSign - sign + 12) % 12) + 1;
    return { house, score: GOCHAR[house], panchang: pc, saturn: saturnPhase(sign, jdOfDate(date)) };
  }

  return {
    julian, jdOfLocal, jdOfDate, dateOfJd, tropical: jd => tropical(dOf(jd)), positions, ayanamsa, ascendant, gmst,
    nakOf, dashas, currentDasha, sunEvent, panchang, chart, today, todayForSign, saturnPhase, dignity,
    GRAHAS, SIGN_LORD, DASHA, norm,
  };
});
