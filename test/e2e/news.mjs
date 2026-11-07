// v36 News: one story per screen, moved SIDEWAYS (drag the card left for the next story, right for the one before; a
// Next button with an arrow, Previous, and the arrow keys), Share on every story (the Web Share sheet with the headline,
// one line and https://brodoit.com/n/<id>; else the link is copied), no "Why it matters", only stories with a photo
// (a photo that fails to load takes its story out, unseen), the whole photo over a blurred copy of itself, credits on
// every photo, the story fitting its card, seen after 1.5 s, the end card, deep links and Hindi.
// The real server boots on a test database with News Desk stories from news-seed.mjs. NEWS_SHOTS=<dir> also saves
// screenshots (a story and the end card, light and dark, at 390×844).
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import { spawn, execFileSync } from 'child_process';
import { seedNews, STORIES, WITH_PHOTO, HIDDEN } from './news-seed.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim(); // a test database with two signed-in users
const require = createRequire(ROOT + '/package.json');
const Database = require('better-sqlite3'); const { chromium } = require('playwright');
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 600))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.NEWS_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ── the code itself ──
const js = fs.readFileSync(ROOT + '/app/news.js', 'utf8'), css = fs.readFileSync(ROOT + '/app/news.css', 'utf8'), srv = fs.readFileSync(ROOT + '/server.js', 'utf8');
const code = (js + '\n' + css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // the code without its comments (the history notes may name it)
const WHY = /Why it matters|क्यों मायने|nz-why|nowhy|'why'|why_hi/;
check('"Why it matters" is gone from the News code (the box, its Hindi and the fit step that set it aside)', !WHY.test(code), code.match(WHY));
check('the deck is no longer the v29 swipe-up deck (no vertical scroll-snap)', !/scroll-snap-type\s*:\s*y/.test(css) && !/scrollTo\(\{\s*top/.test(js));
check('the app loads News v36 (/app/news.js?v=36, /app/news.css?v=36)', srv.includes('/app/news.js?v=36') && srv.includes('/app/news.css?v=36') && !/\/app\/news\.(js|css)\?v=30/.test(srv));

// ── the real server, with News Desk stories ──
const DB = TMP + '/news.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const MEDIA = fs.mkdtempSync('/tmp/p36news-');
seedNews(DB, MEDIA);
const PORT = 3313, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
const head = id => STORIES.find(s => s.id === id).headline;
const browser = await chromium.launch();
// each phone starts with nothing seen on the server (the user is the same signed-in reader)
const clearSeen = () => { const d = new Database(DB); try { d.prepare('DELETE FROM news_seen').run(); } finally { d.close(); } };
const ctxOf = async (o = {}) => {
  clearSeen();
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, o.ctx || {}));
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // one photo the server has answers 404 here (a photo that went missing)
  await page.route('**/api/news/img/n36gone', r => r.fulfill({ status: 404, body: '' }));
  await page.addInitScript(([l, t, sw, share]) => {
    localStorage.setItem('tf_token', 'tokR'); localStorage.setItem('bd_onboarded', '1'); localStorage.setItem('bd_lang', l);
    localStorage.setItem('v104_theme_reset', '1'); localStorage.setItem('theme', t === 'dark' ? 'aurora' : 'classic');
    if (sw) localStorage.setItem('news.swiped', '1');
    window.__shared = [];
    if (share) Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: async function (d) { window.__shared.push(d); } });
    else { try { delete Navigator.prototype.share; } catch (e) { /* none */ } }
  }, [o.lang || 'en', o.theme || 'light', o.swiped !== false, o.share !== false]);
  await page.goto(BASE + (o.path || '/?tab=news'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.user, null, { timeout: 30000 });
  await page.evaluate(() => { if (S.tab !== 'news') switchTab('news'); });
  await page.waitForFunction(() => window.NewsChannel && NewsChannel.loaded && document.querySelector('#nzDeck .nz-card.cur .nz-img.ok, #nzDeck .nz-card.cur .nz-img.ph'), null, { timeout: 20000 }).catch(() => {});
  await sleep(600);
  return { ctx, page, errs };
};
const state = page => page.evaluate(() => {
  const d = document.getElementById('nzDeck'), dr = d.getBoundingClientRect(), cards = [...d.children];
  return { i: NewsChannel.i, ids: NewsChannel.stories.map(s => s.id), cur: (NewsChannel.stories[NewsChannel.i] || {}).id || 'end', n: cards.length, deck: { l: dr.left, r: dr.right, w: dr.width },
    rects: cards.map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.id || 'end', x: Math.round(r.left), right: Math.round(r.right), vis: getComputedStyle(c).visibility, cur: c.classList.contains('cur') }; }) };
});
// a finger on the screen (Chrome's own touch events, so the page sees real pointer events)
async function swipe(ctx, page, dx, dy = 0, { steps = 12, hold = false } = {}) {
  const cdp = await ctx.newCDPSession(page);
  const c = await page.evaluate(() => { const r = document.getElementById('nzDeck').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
  for (let s = 1; s <= steps; s++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + dx * s / steps, y: c.y + dy * s / steps }] }); await sleep(16); }
  if (hold) return cdp;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(650);
  return cdp;
}
try {
  // ── the desk and the share link on the server ──
  const desk = await (await fetch(BASE + '/api/news/desk?limit=40')).json();
  check('the desk serves the seeded stories (with and without photos)', STORIES.every(s => desk.stories.some(x => x.id === s.id)), desk.stories.map(s => s.id));
  const n1 = await fetch(BASE + '/n/n36land'); const n1t = await n1.text();
  check('a story\'s link /n/<id> is its own page (headline, link previews, photo credit)', n1.ok && n1t.includes(head('n36land')) && /og:title/.test(n1t) && /Asha Menon/.test(n1t), n1.status);
  const sh = await (await fetch(BASE + '/api/news/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'n36port' }) })).json();
  check('POST /api/news/share keeps the story and answers https://brodoit.com/n/<id>', sh.url === 'https://brodoit.com/n/n36port', sh);

  // ── a phone, light theme ──
  let { ctx, page, errs } = await ctxOf();
  let s = await state(page);
  check('News opens on the first story with a photo', s.cur === 'n36land' && s.i === 0, s.cur);
  await sleep(1200);   // the next photos load ahead; a broken one leaves the deck
  s = await state(page);
  check('a story whose photo answers 404 is taken out of the deck before you reach it', !s.ids.includes('n36gone') && !s.rects.some(r => r.id === 'n36gone'), s.ids);
  check('a story without a photo is never shown', !s.ids.includes('n36none') && !s.rects.some(r => r.id === 'n36none'), s.ids);
  const txt = await page.evaluate(() => document.getElementById('app').innerText);
  check('no "Why it matters" anywhere on the News tab', !/Why it matters/i.test(txt) && !(await page.$('.nz-why')), txt.slice(0, 200));
  // the photo: whole (contained) over a blurred copy, with its credit
  const ph = await page.evaluate(() => { const c = document.querySelector('#nzDeck .nz-card.cur'), fg = c.querySelector('.nz-fg'), bg = c.querySelector('.nz-bg'), cr = c.querySelector('.nz-cr');
    return { fit: getComputedStyle(fg).objectFit, loaded: fg.complete && fg.naturalWidth > 0, same: bg && bg.src === fg.src, blur: bg && /blur/.test(getComputedStyle(bg).filter), credit: cr && cr.textContent, cs: cr && getComputedStyle(cr).color, h: c.querySelector('.nz-img').getBoundingClientRect().height }; });
  check('the photo is shown whole (object-fit: contain) over a blurred copy of itself', ph.fit === 'contain' && ph.loaded && ph.same && ph.blur && ph.h > 150, ph);
  check('…with its credit on it ("Photo: Asha Menon · CC BY-SA 4.0")', ph.credit === 'Photo: Asha Menon · CC BY-SA 4.0', ph.credit);
  // the bar: Share, Previous, Next; 44 px or more, labelled
  const bar = await page.evaluate(() => ['nzShare', 'nzPrev', 'nzNext'].map(id => { const b = document.getElementById(id), r = b.getBoundingClientRect(); return { id, w: r.width, h: r.height, label: b.getAttribute('aria-label'), text: b.innerText.trim(), dis: b.disabled, bottom: r.bottom }; }));
  check('the bar has Share, Previous and Next, each at least 44 px and labelled', bar.every(b => b.w >= 44 && b.h >= 44 && b.label) && bar[0].text === 'Share' && bar[2].text === 'Next' && bar[2].label === 'Next story' && bar[1].label === 'Previous story', bar);
  check('…Next has an arrow pointing right; Previous is off on the first story', await page.evaluate(() => !!document.querySelector('#nzNext svg.ico-arrow-right')) && bar[1].dis && !bar[2].dis, bar);
  check('…and sits above the app\'s tab bar, inside the screen', await page.evaluate(b => { const t = document.querySelector('.tabs.page-t'); return b < (t ? t.getBoundingClientRect().top + 1 : innerHeight); }, bar[2].bottom), bar[2].bottom);

  // Next → the next story comes in from the right
  await page.click('#nzNext'); await sleep(650);
  s = await state(page);
  const r1 = s.rects;
  check('Next: the next story becomes current, in view, and the first moved off to the LEFT', s.i === 1 && s.cur === s.ids[1] && Math.abs(r1[1].x - s.deck.l) < 2 && r1[0].right <= s.deck.l + 1, { i: s.i, rects: r1.slice(0, 3), deck: s.deck });
  check('…the card after it waits to the RIGHT', r1[2] && r1[2].x >= s.deck.r - 2, r1[2]);
  await page.click('#nzPrev'); await sleep(650);
  s = await state(page);
  check('Previous brings the first story back', s.i === 0 && s.cur === 'n36land', s.cur);

  // a finger: drag left (it follows the finger), let go → next; a short drag springs back; drag right → back
  const cdp = await swipe(ctx, page, -150, 4, { hold: true }); await sleep(80);
  s = await state(page);
  check('while dragging left, the card follows the finger and the next one comes in from the right', s.i === 0 && s.rects[0].x < s.deck.l - 100 && s.rects[0].x > s.deck.l - 200 && s.rects[1].vis === 'visible' && s.rects[1].x < s.deck.r && s.rects[1].x > s.deck.l, s.rects.slice(0, 2));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(650);
  s = await state(page);
  check('…let go: the next story is current (swipe LEFT = next)', s.i === 1 && Math.abs(s.rects[1].x - s.deck.l) < 2, { i: s.i, x: s.rects[1].x });
  await swipe(ctx, page, -40, 0, { steps: 10 }); await sleep(150);
  s = await state(page);
  check('a short, slow drag springs back to the same story', s.i === 1 && Math.abs(s.rects[1].x - s.deck.l) < 2, { i: s.i, x: s.rects[1].x });
  await swipe(ctx, page, 170, 0);
  s = await state(page);
  check('swipe RIGHT goes back a story', s.i === 0, s.i);
  await swipe(ctx, page, 6, -260);
  s = await state(page);
  check('an up/down swipe does not change the story (the deck is not vertical any more)', s.i === 0, s.i);
  await swipe(ctx, page, 200, 0);
  s = await state(page);
  check('a right swipe on the first story gives a little and stays', s.i === 0 && Math.abs(s.rects[0].x - s.deck.l) < 2, s.rects[0]);

  // keys on a computer keyboard
  await page.keyboard.press('ArrowRight'); await sleep(600);
  const k1 = (await state(page)).i;
  await page.keyboard.press('ArrowLeft'); await sleep(600);
  check('ArrowRight / ArrowLeft move to the next story and back', k1 === 1 && (await state(page)).i === 0, k1);

  // Share → the phone's share sheet with the headline, one line and the story's link
  await page.evaluate(() => { window.__shared = []; });
  await page.click('#nzShare'); await sleep(400);
  const sd = await page.evaluate(() => window.__shared);
  check('Share opens the share sheet (navigator.share) with the headline, one line of the story and https://brodoit.com/n/<id>',
    sd.length === 1 && sd[0].title === head('n36land') && sd[0].url === 'https://brodoit.com/n/n36land' && sd[0].text.length > 20 && sd[0].text.length <= 240 && /[.!?]$/.test(sd[0].text) && !sd[0].text.includes('\n'), sd);
  await sleep(500);
  const kept = (() => { const d = new Database(DB, { readonly: true }); try { return d.prepare('SELECT id FROM news_shared WHERE id=?').get('n36land'); } finally { d.close(); } })();
  check('…and the server keeps the shared story (news_shared), so the link outlives the feed', !!kept);
  const shareOn = await page.evaluate(() => [...document.querySelectorAll('#nzDeck .nz-card')].map(c => c.dataset.id).filter(Boolean));
  let allShared = true;
  for (let k = 0; k < shareOn.length; k++) {
    await page.evaluate(k => { NewsChannel.go(k, true); window.__shared = []; }, k); await sleep(120);
    await page.click('#nzShare'); await sleep(150);
    const got = await page.evaluate(() => window.__shared[0]);
    if (!got || got.url !== 'https://brodoit.com/n/' + shareOn[k]) allShared = false;
  }
  check('…Share works on every story in the deck (each with its own link)', allShared && shareOn.length >= 3, shareOn);
  await page.evaluate(() => NewsChannel.go(0, true)); await sleep(200);

  // every story fits its card; credits on every photo; the reports open from their names
  const fits = await page.evaluate(async () => {
    const out = [];
    for (let k = 0; k < NewsChannel.stories.length; k++) {
      NewsChannel.go(k, true); await new Promise(r => setTimeout(r, 120));
      const c = document.querySelector('#nzDeck .nz-card.cur'), b = c.querySelector('.nz-body'), st = NewsChannel.stories[k];
      out.push({ id: st.id, fits: b.scrollHeight <= b.clientHeight + 1, scroll: c.classList.contains('scroll'), credit: (c.querySelector('.nz-cr') || {}).textContent || '', want: st.image_credit ? 'Photo: ' + st.image_credit.by + ' · ' + st.image_credit.license : '', img: c.querySelector('.nz-img').getBoundingClientRect().height / c.getBoundingClientRect().height });
    }
    NewsChannel.go(0, true); return out;
  });
  check('at 390×844 every story fits its card whole (no scrolling inside a card)', fits.every(f => f.fits && !f.scroll), fits);
  check('…and its photo keeps at least a quarter of the card', fits.every(f => f.img >= 0.24), fits.map(f => [f.id, f.img.toFixed(2)]));
  check('every photo carries its credit (photographer · licence)', fits.every(f => f.want && f.credit === f.want), fits.map(f => [f.id, f.credit]));
  await page.click('#nzDeck .nz-card.cur .nz-src'); await sleep(400);
  const sheet = await page.evaluate(() => { const s = document.getElementById('nzSrc'); return s ? { links: [...s.querySelectorAll('a.nz-sh')].map(a => a.href), text: s.innerText } : null; });
  check('tapping the reports\' names opens their links (and the photo\'s Commons page)', sheet && sheet.links.some(l => /thehindu\.com/.test(l)) && sheet.links.some(l => /commons\.wikimedia\.org/.test(l)), sheet);
  await page.keyboard.press('Escape'); await sleep(200);
  check('…Escape closes it and the keys do not move the deck meanwhile', !(await page.$('#nzSrc')) && (await state(page)).i === 0);

  // seen: 1.5 s on screen (photo showing); the broken ones never count
  await sleep(1800);
  const seen1 = await page.evaluate(() => Object.keys((JSON.parse(localStorage.getItem('news.seen.v1') || '{}').ids) || {}));
  check('a story on screen for 1.5 s is seen (news.seen.v1)', seen1.includes('n36land'), seen1);
  check('…the stories whose photo failed are not counted as seen', HIDDEN.every(id => !seen1.includes(id)), seen1);
  await sleep(3200);
  const srvSeen = (() => { const d = new Database(DB, { readonly: true }); try { return d.prepare("SELECT story_id FROM news_seen WHERE user_phone='+919000000001'").all().map(r => r.story_id); } finally { d.close(); } })();
  check('…and the signed-in reader\'s server keeps it too (POST /api/news/seen)', srvSeen.includes('n36land') && HIDDEN.every(id => !srvSeen.includes(id)), srvSeen);

  // to the end: the last photo story, then "You're all caught up"
  for (let k = 0; k < 8 && !(await page.$('#nzNext[disabled]')); k++) { await page.click('#nzNext'); await sleep(550); }
  s = await state(page);
  check('the deck holds exactly the stories with a working photo', JSON.stringify([...s.ids].sort()) === JSON.stringify([...WITH_PHOTO].sort()), s.ids);
  const end = await page.evaluate(() => { const c = document.querySelector('#nzDeck .nz-card.cur'); return { end: c.classList.contains('nz-end'), text: c.innerText, next: document.getElementById('nzNext').disabled, share: getComputedStyle(document.getElementById('nzShare')).visibility }; });
  check('it ends on "You’re all caught up" with the next edition; Next is off there (and Share hidden)', end.end && /You’re all caught up/.test(end.text) && /Next edition at/.test(end.text) && end.next && end.share === 'hidden', end);
  if (SHOTS) await page.screenshot({ path: SHOTS + '/end-light.png' });
  await page.click('.nz-again'); await sleep(700);
  check('…"Back to the first story" goes back to the start', (await state(page)).i === 0);
  if (SHOTS) { await page.evaluate(() => NewsChannel.go(1, true)); await sleep(400); await page.screenshot({ path: SHOTS + '/story-light.png' }); }
  const noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  check('no sideways page scroll', noSideScroll);
  check('no page errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();

  // ── no share sheet (a computer): the link is copied, with a note ──
  ({ ctx, page, errs } = await ctxOf({ share: false, ctx: { permissions: ['clipboard-read', 'clipboard-write'] } }));
  await page.click('#nzShare'); await sleep(500);
  const cp = await page.evaluate(async () => ({ toast: (document.getElementById('nzToast') || {}).textContent, on: !!document.querySelector('#nzToast.on'), clip: await navigator.clipboard.readText().catch(e => 'ERR ' + e) }));
  check('without navigator.share, Share copies the link and says "Link copied"', cp.clip === 'https://brodoit.com/n/' + (await state(page)).cur && cp.toast === 'Link copied' && cp.on, cp);
  await ctx.close();

  // ── dark theme, first visit (the hint), deep link to a story without a photo ──
  ({ ctx, page, errs } = await ctxOf({ theme: 'dark', swiped: false }));
  const dk = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector('#nzDeck .nz-card.cur .nz-in')).backgroundColor, ink: getComputedStyle(document.querySelector('#nzDeck .nz-card.cur h2')).color, next: getComputedStyle(document.getElementById('nzNext')).backgroundColor, hint: document.getElementById('nzNext').classList.contains('hint') }));
  const lum = c => { const m = String(c).match(/\d+(\.\d+)?/g) || [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  check('dark theme: a dark card, light type and a light Next button', lum(dk.bg) < 0.2 && lum(dk.ink) > 0.8 && lum(dk.next) > 0.8, dk);
  check('the first visit hints at the way to go (Next\'s arrow nudges right)', dk.hint, dk);
  if (SHOTS) { await sleep(2600); await page.screenshot({ path: SHOTS + '/story-dark.png' }); await page.evaluate(() => NewsChannel.go(999, true)); await sleep(500); await page.screenshot({ path: SHOTS + '/end-dark.png' }); }
  check('no page errors (dark)', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
  ({ ctx, page, errs } = await ctxOf({ path: '/?tab=news&s=n36none' }));
  s = await state(page);
  const pinned = await page.evaluate(() => { const c = document.querySelector('#nzDeck .nz-card.cur'); return { ph: !!c.querySelector('.nz-img.ph'), h: c.querySelector('h2').textContent }; });
  check('a shared link (?s=<id>) still opens its story, even one without a photo (on its section\'s colour)', s.cur === 'n36none' && pinned.ph && pinned.h === head('n36none'), { cur: s.cur, pinned });
  await ctx.close();

  // ── Hindi ──
  ({ ctx, page, errs } = await ctxOf({ lang: 'hi' }));
  s = await state(page);
  const hiv = await page.evaluate(() => ({ h: document.querySelector('#nzDeck .nz-card.cur h2').textContent, next: document.getElementById('nzNext').innerText.trim(), share: document.getElementById('nzShare').innerText.trim(), label: document.getElementById('nzNext').getAttribute('aria-label'), text: document.getElementById('app').innerText }));
  check('Hindi: only the stories written in Hindi, with a photo; Hindi buttons ("अगली", "साझा करें")', s.ids.length === 3 && s.ids.every(id => ['n36land', 'n36port', 'n36sq'].includes(id)) && /[ऀ-ॿ]/.test(hiv.h) && hiv.next === 'अगली' && hiv.share === 'साझा करें' && hiv.label === 'अगली ख़बर', { ids: s.ids, hiv: Object.assign({}, hiv, { text: undefined }) });
  check('…and no "why it matters" in Hindi either', !/क्यों मायने/.test(hiv.text));
  await page.evaluate(() => { window.__shared = []; }); await page.click('#nzShare'); await sleep(300);
  const hs = await page.evaluate(() => window.__shared[0]);
  check('…Share sends the Hindi headline and line', hs && /[ऀ-ॿ]/.test(hs.title) && /[ऀ-ॿ]/.test(hs.text) && /^https:\/\/brodoit\.com\/n\//.test(hs.url), hs);
  check('no page errors (Hindi)', errs.length === 0, errs.slice(0, 3));
  await ctx.close();

  // ── a computer: the mouse can drag too ──
  ({ ctx, page, errs } = await ctxOf({ ctx: { viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 } }));
  const dr = await page.evaluate(() => { const r = document.getElementById('nzDeck').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; });
  await page.mouse.move(dr.x, dr.y); await page.mouse.down();
  for (let k = 1; k <= 10; k++) { await page.mouse.move(dr.x - k * 22, dr.y); await sleep(16); }
  await page.mouse.up(); await sleep(650);
  check('a computer: dragging the card left with the mouse goes to the next story', (await state(page)).i === 1, (await state(page)).i);
  check('no page errors (computer)', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nnews: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
