// Jyotish (v34): the sky maths against known events, the pandit and booking API (prices worked out on the server, admin
// only where it must be), the palm reader with a fake Gemini (stub-astro.cjs), and the pages in a real phone-sized
// browser in English and Hindi: the hub, the kundli, the self-guided and the camera palm readings (Chromium's fake
// camera), booking a puja, the admin page, and opening Jyotish from the You tab inside the app's layer.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import { spawn, execFileSync } from 'child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-astro-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim();
const require = createRequire(ROOT + '/package.json'); const { chromium } = require('playwright');
const Sky = require(ROOT + '/astro/assets/sky.js'), Price = require(ROOT + '/astro/assets/price.js');
const PUJAS = JSON.parse(fs.readFileSync(ROOT + '/astro/data/pujas.json', 'utf8')), CITIES = JSON.parse(fs.readFileSync(ROOT + '/astro/data/cities.json', 'utf8'));
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ── 1. the sky maths ──
const sep = (a, b) => { const x = Math.abs(a - b) % 360; return x > 180 ? 360 - x : x; };
{ const r = Sky.tropical(Sky.julian(2000, 1, 6, 18 + 14 / 60)); check('new moon of 6 Jan 2000: Sun and Moon together', sep(r.sun, r.moon) < 0.5, sep(r.sun, r.moon)); }
{ const r = Sky.tropical(Sky.julian(2024, 4, 8, 18.3)); check('solar eclipse of 8 Apr 2024: Sun and Moon together', sep(r.sun, r.moon) < 0.5, sep(r.sun, r.moon)); }
{ const r = Sky.tropical(Sky.julian(2020, 12, 21, 18)); check('great conjunction of 21 Dec 2020 near 300.3°', sep(r.jupiter, 300.3) < 0.6 && sep(r.saturn, 300.3) < 0.6, [r.jupiter, r.saturn]); }
{ const r = Sky.tropical(Sky.julian(2019, 11, 11, 15.33)); check('transit of Mercury, 11 Nov 2019', sep(r.mercury, r.sun) < 0.5, [r.mercury, r.sun]); }
{ const sign = (y, m, d, p) => Sky.positions(Sky.julian(y, m, d, 6))[p].sign;
  check('Saturn enters sidereal Aquarius around 17 Jan 2023', sign(2023, 1, 10, 'saturn') === 9 && sign(2023, 1, 25, 'saturn') === 10);
  check('Saturn enters sidereal Pisces around 29 Mar 2025', sign(2025, 3, 20, 'saturn') === 10 && sign(2025, 4, 5, 'saturn') === 11);
  check('Jupiter enters sidereal Gemini around 14 May 2025', sign(2025, 5, 8, 'jupiter') === 1 && sign(2025, 5, 20, 'jupiter') === 2); }
{ const rise = Sky.sunEvent(2026, 11, 2, 28.6139, 77.209, 5.5, true), set = Sky.sunEvent(2026, 11, 2, 28.6139, 77.209, 5.5, false);
  check('Delhi, 2 Nov 2026: sunrise ~6:34, sunset ~17:36', Math.abs(rise - (6 + 34 / 60)) < 0.07 && Math.abs(set - (17 + 36 / 60)) < 0.07, [rise, set]);
  const jd = Sky.jdOfLocal(2026, 11, 2, Math.floor(rise), (rise % 1) * 60, 5.5);
  check('the ascendant at sunrise is the Sun', sep(Sky.ascendant(jd, 28.6139, 77.209), Sky.tropical(jd).sun) < 2); }
check('Diwali 2026 evening (8 Nov) is Amavasya', Sky.panchang(new Date('2026-11-08T14:30:00Z'), {}).tithi === 30);
{ const ch = Sky.chart({ y: 1995, m: 8, d: 15, hh: 6, mm: 30, tz: 5.5, lat: 19.076, lon: 72.8777 });
  const total = ch.dashas.slice(0, 9).reduce((n, d) => n + d.years, 0);
  check('a chart has 9 grahas, a lagna, a nakshatra and 120 years of dasha', ch.planets.length === 9 && ch.lagna >= 0 && ch.lagna < 12 && ch.nakshatra.pada >= 1 && total === 120, { lagna: ch.lagna, total });
  check('Rahu and Ketu are opposite', Math.abs(sep(ch.by.rahu.lon, ch.by.ketu.lon) - 180) < 1e-6); }

// ── 2. the server ──
const DB = TMP + '/astro.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const MEDIA = fs.mkdtempSync('/tmp/astro-media-'); const PORT = 3298, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: '' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-astro.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots with the astro module', up && out.join('').includes('[astro] palm reader'), out.slice(-5));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || (o.body ? 'POST' : 'GET'), headers: Object.assign({ 'Content-Type': 'application/json' }, o.tok ? { 'x-token': o.tok } : {}), body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  for (const p of ['/astro/', '/astro/palm.html', '/astro/kundli.html', '/astro/pandit.html', '/astro/admin.html', '/astro/assets/sky.js', '/astro/data/pujas.json']) { const r = await fetch(BASE + p); check('GET ' + p, r.ok, r.status); }
  const sw = await (await fetch(BASE + '/sw.js')).text(); check('the service worker caches /astro', sw.includes('app|lang|mind|code|astro'));
  { const r = await api('/api/astro/status', { tok: 'tokK' }); check('status: vision on, signed in, not admin', r.j.vision && r.j.signedIn && !r.j.admin && r.j.palmLeft === 5, r.j); }

  // pandits and bookings
  const D = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  let r = await api('/api/astro/pandits', { tok: 'tokK', body: { name: 'Pt. Kabir Joshi', phone: '+91 98765 43210', city: 'pune', experience: 12, langs: ['hi', 'mr', 'xx'], traditions: ['marathi'], pujas: ['grihapravesh', 'satyanarayan', 'nope'] } });
  check('a pandit joins (unknown languages and pujas dropped), pending', r.j.ok && r.j.pandit.status === 'pending' && r.j.pandit.langs.join() === 'hi,mr' && r.j.pandit.pujas.length === 2, r.j);
  const pid = r.j.pandit && r.j.pandit.id;
  check('a pending pandit is not listed', (await api('/api/astro/pandits?city=pune')).j.items.length === 0);
  check('only the admin can verify', (await api('/api/astro/admin/pandits/' + pid, { tok: 'tokK', body: { status: 'verified' } })).status === 403);
  await api('/api/astro/admin/pandits/' + pid, { tok: 'tokR', body: { status: 'verified' } });
  r = await api('/api/astro/pandits?city=pune&puja=grihapravesh'); check('a verified pandit is listed, without a phone number', r.j.items.length === 1 && !('phone' in r.j.items[0]), r.j);
  check('…and not for a puja they do not perform', (await api('/api/astro/pandits?city=pune&puja=vivah')).j.items.length === 0);
  r = await api('/api/astro/bookings', { tok: 'tokR', body: { puja: 'grihapravesh', city: 'pune', pkg: 'standard', price: 1, pandit_id: pid, date: D, time: 'morning', address: 'Flat 4B, Baner Road, Pune', contact_name: 'Riya', contact_phone: '+91 90000 00001' } });
  const pune = CITIES.cities.find(c => c.id === 'pune'), gp = PUJAS.pujas.find(p => p.id === 'grihapravesh');
  check('a booking is priced by the server (Pune standard griha pravesh = 9,900)', r.j.ok && r.j.booking.price === 9900 && r.j.booking.price === Price.price(gp, 'standard', pune, CITIES.tiers), r.j);
  const bid = r.j.booking && r.j.booking.id;
  check('the pandit phone is hidden until confirmed', r.j.booking && r.j.booking.pandit && !r.j.booking.pandit.phone);
  for (const [n, b, f] of [['unknown puja', { puja: 'x', city: 'pune', pkg: 'basic' }, 'puja'], ['pind daan outside a tirth', { puja: 'pinddaan', city: 'pune', pkg: 'basic' }, 'city'], ['a past date', { puja: 'havan', city: 'delhi', pkg: 'basic', date: '2020-01-01' }, 'date'], ['no address', { puja: 'havan', city: 'delhi', pkg: 'basic', date: D, contact_name: 'R', contact_phone: '9999999999' }, 'address'], ['a phone too short', { puja: 'havan', city: 'delhi', pkg: 'basic', date: D, address: '12 Main Road, Delhi', contact_name: 'Riya', contact_phone: '12345' }, 'contact_phone'], ['a pandit from another city', { puja: 'grihapravesh', city: 'delhi', pkg: 'basic', date: D, address: '12 Main Road, Delhi', contact_name: 'Riya', contact_phone: '9999999999', pandit_id: pid }, 'pandit_id']]) {
    const x = await api('/api/astro/bookings', { tok: 'tokR', body: b }); check('refused: ' + n, x.status === 400 && x.j.field === f, x.j);
  }
  check('booking needs sign-in', (await api('/api/astro/bookings', { body: { puja: 'havan' } })).status === 401);
  check('confirming needs a pandit', (await api('/api/astro/admin/bookings/' + bid, { tok: 'tokR', body: { status: 'confirmed', pandit_id: '' } })).status === 400);
  r = await api('/api/astro/admin/bookings/' + bid, { tok: 'tokR', body: { status: 'confirmed', note: 'Pandit ji will call a day before' } });
  check('the admin confirms', r.j.ok && r.j.booking.status === 'confirmed');
  r = await api('/api/astro/bookings', { tok: 'tokR' }); check('the family sees the pandit phone once confirmed', r.j.items[0].pandit.phone === '+919876543210', r.j.items[0]);
  r = await api('/api/astro/pandit/me', { tok: 'tokK' }); check('the pandit sees the job with the family contact', r.j.jobs.length === 1 && r.j.jobs[0].contact_phone === '+919000000001', r.j);
  check('another user cannot cancel it', (await api('/api/astro/bookings/' + bid + '/cancel', { tok: 'tokK', body: {} })).status === 404);
  r = await api('/api/astro/bookings/' + bid + '/cancel', { tok: 'tokR', body: {} }); check('the family cancels', r.j.ok && r.j.booking.status === 'cancelled');

  // the palm reader (fake Gemini)
  const photo = 'data:image/jpeg;base64,' + fs.readFileSync(ROOT + '/app/img/cards/cat-cs.jpg').toString('base64');
  r = await api('/api/astro/palm', { tok: 'tokK', body: { image: photo, hand: 'left', lang: 'en' } });
  check('a palm photo is read: features kept, a bad value dropped, notes and summary', r.j.ok && r.j.features.heartEnd === 'jupiter' && r.j.features.fingers === null && r.j.features.thumb === null && /index finger/.test(r.j.notes.heart) && r.j.summary.length > 20 && r.j.left === 4, r.j);
  r = await api('/api/astro/palm', { tok: 'tokK', body: { image: 'data:image/jpeg;base64,' + 'A'.repeat(800), hand: 'right' } });
  check('not a palm → retake, not counted', r.j.ok === false && r.j.code === 'retake' && r.j.quality === 'not_palm');
  for (let i = 0; i < 4; i++) await api('/api/astro/palm', { tok: 'tokK', body: { image: photo } });
  r = await api('/api/astro/palm', { tok: 'tokK', body: { image: photo } }); check('five camera readings a day, then 429', r.status === 429 && r.j.code === 'limit', r);
  check('the admin has no daily limit', (await api('/api/astro/palm', { tok: 'tokR', body: { image: photo } })).j.ok === true);
  check('palm reading needs sign-in', (await api('/api/astro/palm', { body: { image: photo } })).status === 401);

  // ── 3. the pages ──
  for (const lang of ['en', 'hi']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.addInitScript(([l]) => { localStorage.setItem('tf_token', 'tokR'); localStorage.setItem('bd_onboarded', '1'); localStorage.setItem('bd_lang', l); }, [lang]);
    const shot = async n => { if (SHOTS) await page.screenshot({ path: SHOTS + '/' + lang + '-' + n + '.png', fullPage: true }); };
    const noSideways = async n => { const o = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); check(lang + ' · ' + n + ': no sideways scroll', !o); };
    const hiOk = async n => { if (lang !== 'hi') return; const txt = await page.evaluate(() => document.getElementById('main').innerText); check(lang + ' · ' + n + ': Hindi on screen', /[ऀ-ॿ]{3}/.test(txt)); };

    await page.goto(BASE + '/astro/', { waitUntil: 'networkidle' }); await sleep(400);
    check(lang + ' · hub: rows for palm, kundli, pandit and admin', await page.evaluate(() => ['palm', 'kundli', 'pandit', 'admin'].every(id => document.querySelector('[data-id="' + id + '"]'))));
    await page.click('[data-rashi="4"]'); await sleep(300);
    check(lang + ' · hub: picking a rashi shows today with a score', await page.evaluate(() => document.querySelectorAll('.ax-score i.on').length >= 1));
    await shot('hub'); await noSideways('hub'); await hiOk('hub');

    await page.goto(BASE + '/astro/kundli.html', { waitUntil: 'networkidle' }); await sleep(300);
    await page.fill('input[name=name]', 'Riya'); await page.fill('input[name=date]', '1995-08-15'); await page.fill('input[name=time]', '06:30'); await page.selectOption('select[name=city]', 'mumbai');
    await page.click('#bf button[type=submit]'); await sleep(400);
    check(lang + ' · kundli: the chart page opens on today', await page.evaluate(() => !!document.querySelector('.ax-today') && !!document.querySelector('[data-tab="chart"]')));
    await shot('kundli-today'); await noSideways('kundli today'); await hiOk('kundli today');
    for (const tb of ['chart', 'life', 'dasha']) {
      await page.click('[data-tab="' + tb + '"]'); await sleep(250);
      const ok = await page.evaluate(t => t === 'chart' ? document.querySelectorAll('.ax-chart text.sg').length === 12 && document.querySelectorAll('.ax-table tbody tr').length === 9 : t === 'dasha' ? document.querySelectorAll('.ax-dasha .d.now').length >= 1 : document.querySelectorAll('.ax-card').length >= 5, tb);
      check(lang + ' · kundli: ' + tb + ' tab', ok); await shot('kundli-' + tb); await noSideways('kundli ' + tb);
    }

    await page.goto(BASE + '/astro/palm.html', { waitUntil: 'networkidle' }); await sleep(400);
    check(lang + ' · palm: camera, photo and step-by-step offered', await page.evaluate(() => !!document.getElementById('cam') && !!document.getElementById('file') && !!document.getElementById('quiz')));
    await shot('palm-intro'); await noSideways('palm intro');
    await page.click('#quiz');
    for (let i = 0; i < 14; i++) { await page.waitForSelector('.ax-opt', { timeout: 5000 }); if (i === 2) await shot('palm-question'); await page.click(i === 12 ? '#skip' : '.ax-opt >> nth=0'); await sleep(80); }
    await sleep(200);
    check(lang + ' · palm: the step-by-step reading has its sections', await page.evaluate(() => document.querySelectorAll('.ax-sec-t').length >= 4));
    await shot('palm-self'); await noSideways('palm self reading');
    // the camera (Chromium's fake device) → preview → the reading from the fake Gemini
    await page.goto(BASE + '/astro/palm.html', { waitUntil: 'networkidle' }); await sleep(300);
    await page.click('#cam'); await page.waitForSelector('.ax-cam video'); await page.waitForFunction(() => { const v = document.querySelector('.ax-cam video'); return v && v.videoWidth > 0; }, null, { timeout: 10000 });
    await sleep(700); await shot('palm-camera');
    check(lang + ' · palm: the light meter speaks', await page.evaluate(() => document.getElementById('meter').textContent.length > 5));
    await page.click('#shot'); await page.waitForSelector('#go'); await shot('palm-preview');
    check(lang + ' · palm: the camera is released after the shot', await page.evaluate(() => !document.querySelector('.ax-cam')));
    await page.click('#go'); await page.waitForSelector('.ax-ai, .ax-note', { timeout: 15000 }); await sleep(200);
    // the fake camera frame is small and plain, so the reading may ask for a retake; a real photo is read either way
    const camOut = await page.evaluate(() => ({ ai: document.querySelectorAll('.ax-ai').length, retake: !!document.getElementById('re') }));
    check(lang + ' · palm: the camera photo is read (or a retake is asked)', camOut.ai >= 3 || camOut.retake, camOut);
    await page.goto(BASE + '/astro/palm.html', { waitUntil: 'networkidle' }); await sleep(300);
    await page.setInputFiles('#file', ROOT + '/app/img/cards/cat-cs.jpg'); await page.waitForSelector('#go'); await page.click('#go');
    await page.waitForSelector('.ax-ai', { timeout: 15000 }); await sleep(200);
    check(lang + ' · palm: an uploaded photo gives the reading with the reader\'s notes', await page.evaluate(() => document.querySelectorAll('.ax-ai').length >= 4 && document.querySelectorAll('.ax-sec-t').length >= 4));
    await shot('palm-ai'); await noSideways('palm AI reading'); await hiOk('palm AI reading');

    await page.goto(BASE + '/astro/pandit.html', { waitUntil: 'networkidle' }); await sleep(300);
    await page.selectOption('#city', 'pune'); await sleep(200);
    check(lang + ' · pandit: the list shows every group with prices', await page.evaluate(() => document.querySelectorAll('.ui-row[data-puja]').length >= 25 && /₹/.test(document.querySelector('.ui-meta').textContent)));
    await shot('pandit-list'); await noSideways('pandit list'); await hiOk('pandit list');
    await page.click('[data-puja="grihapravesh"]'); await page.waitForSelector('[data-pid]'); await sleep(200);
    const prices = await page.evaluate(() => [...document.querySelectorAll('.ax-pkg .pr')].map(x => x.textContent));
    check(lang + ' · pandit: Pune prices 4,600 / 9,900 / 18,900', prices.join('|') === '₹4,600|₹9,900|₹18,900', prices);
    check(lang + ' · pandit: the verified pandit is offered', await page.evaluate(() => document.querySelectorAll('[data-pid]').length === 2));
    await page.click('[data-pid]:not([data-pid=""])'); await shot('pandit-puja'); await noSideways('pandit puja');
    await page.click('#next'); await page.waitForSelector('#bk');
    await page.fill('textarea[name=address]', 'Flat 4B, Baner Road, Pune'); await page.fill('input[name=contact_phone]', '+91 90000 00001');
    await shot('pandit-form'); await noSideways('pandit form');
    await page.click('#bk button[type=submit]'); await page.waitForSelector('#mine', { timeout: 8000 });
    check(lang + ' · pandit: booked', await page.evaluate(() => /BK-/.test(document.getElementById('main').innerText)));
    await shot('pandit-done');
    await page.click('#mine'); await page.waitForSelector('[data-cancel]', { timeout: 8000 });
    check(lang + ' · pandit: my bookings lists it', await page.evaluate(() => document.querySelectorAll('[data-cancel]').length >= 1));
    await shot('pandit-bookings');

    await page.goto(BASE + '/astro/admin.html', { waitUntil: 'networkidle' }); await sleep(500);
    check(lang + ' · admin: the bookings are listed', await page.evaluate(() => document.querySelectorAll('[data-b]').length >= 1));
    await shot('admin');
    check(lang + ': no page errors', errs.length === 0, errs.slice(0, 3));
    await ctx.close();
  }
  // a non-admin sees the admin page refuse
  { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.setItem('tf_token', 'tokK'); }); await page.goto(BASE + '/astro/admin.html', { waitUntil: 'networkidle' }); await sleep(400);
    check('admin page: refused for a non-admin', await page.evaluate(() => !document.querySelector('[data-b]') && /admin/i.test(document.getElementById('main').innerText)));
    await ctx.close(); }
  // inside the app: You → Jyotish opens in the layer (camera allowed), and the phone's back closes it
  { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.addInitScript(() => { localStorage.setItem('tf_token', 'tokR'); localStorage.setItem('bd_onboarded', '1'); localStorage.setItem('news.swiped', '1'); localStorage.setItem('bd_lang', 'en'); });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof S !== 'undefined' && S.user, null, { timeout: 30000 }); await sleep(600);
    await page.evaluate(() => switchTab('profile')); await sleep(800);
    const row = page.locator('button.rowc', { hasText: 'Palm, kundli and pandit' });
    check('You tab: the Jyotish row is there', await row.count() === 1);
    await row.click(); await page.waitForSelector('.bd-frame iframe'); await sleep(1500);
    const fr = await page.evaluate(() => { const f = document.querySelector('.bd-frame iframe'); return { src: f.getAttribute('src'), allow: f.getAttribute('allow'), title: f.contentDocument && f.contentDocument.title }; });
    check('Jyotish opens in the layer with the camera allowed', fr.src === '/astro/' && /camera/.test(fr.allow) && /Jyotish/.test(fr.title), fr);
    await page.goBack(); await sleep(800);
    check('the phone\'s back closes the layer', await page.evaluate(() => !document.querySelector('.bd-frame')));
    check('app: no page errors', errs.length === 0, errs.slice(0, 3));
    await ctx.close(); }
} finally { await browser.close(); child.kill(); }
console.log(`\nastro: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
