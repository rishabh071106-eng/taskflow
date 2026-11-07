// v36 live check: a visitor opens a shared lesson link (/l/atomic?c=3) on a phone. Reports where it lands, whether the
// lesson player opens at that card, the cards, the picture, and page errors; screenshots the cover, a story card and News.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pw = require(process.env.PW_PATH);
const BASE = process.env.BASE || 'https://brodoit.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage(); const errs = [];
page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
await page.goto(BASE + '/l/atomic?c=3', { waitUntil: 'domcontentloaded', timeout: 60000 });
let st = null; for (let i = 0; i < 40; i++) { await sleep(500); st = await page.evaluate(() => window.Lessons && Lessons.state && Lessons.state()).catch(() => null); if (st) break; }
await sleep(1500);
const info = await page.evaluate(() => ({ url: location.pathname + location.search, cards: document.querySelectorAll('.lz-card').length, label: (document.querySelector('.lz-ttl small') || {}).textContent, img: (() => { const i = document.querySelector('.lz-card.on .lz-pic img'); return i ? [i.getAttribute('src'), i.naturalWidth] : null; })(), next: (document.querySelector('.lz-next') || {}).textContent })).catch(e => ({ error: e.message }));
console.log('shared link → player:', JSON.stringify({ st, info }));
await page.screenshot({ path: 'lesson-story.png' });
await page.evaluate(() => Lessons.open('atomic', 0)).catch(() => {}); await sleep(1800);
await page.screenshot({ path: 'lesson-cover.png' });
await page.evaluate(() => Lessons.open('atomic', 4)).catch(() => {}); await sleep(1500);
await page.screenshot({ path: 'lesson-think.png' });
console.log('page errors:', JSON.stringify(errs.slice(0, 5)));
await browser.close();
