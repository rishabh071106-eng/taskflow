// Login probe: a new visitor on a phone opens BASE, waits on the login screen and types a name and an email slowly.
// It reports page loads, re-renders of the screen, whether the typed text and the focus survive, console errors
// and failed requests. Usage: BASE=https://brodoit.com node login-probe.mjs   (needs playwright)
// STALE=1: a returning visitor whose saved login the server no longer knows (an old tf_token in localStorage).
// The app must sign them out once and then leave the login form alone while they type.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch (e) { pw = require(process.env.PW_PATH || '/opt/node22/lib/node_modules/playwright'); }
const BASE = process.env.BASE || 'https://brodoit.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
const STALE = !!process.env.STALE;
if (STALE) await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('__probeSeeded')) { sessionStorage.setItem('__probeSeeded', '1'); localStorage.setItem('tf_token', 'stale-token-from-an-old-server'); localStorage.setItem('tf_name', 'Old Name'); localStorage.setItem('tf_email', 'old@example.com'); localStorage.setItem('tf_phone', ''); } } catch (e) {} });
const page = await ctx.newPage();
const out = { mode: STALE ? 'returning visitor, stale saved login' : 'new visitor', logouts: 0, loads: 0, navs: [], consoleErrors: [], pageErrors: [], failed: [], bad: [] };
page.on('load', () => { out.loads++; });
page.on('framenavigated', f => { if (f === page.mainFrame()) out.navs.push(new Date().toISOString().slice(11, 19) + ' ' + f.url().replace(BASE, '')); });
page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => out.pageErrors.push(String(e.message).slice(0, 200)));
page.on('requestfailed', r => out.failed.push(r.url().replace(BASE, '') + ' ' + (r.failure() || {}).errorText));
page.on('request', r => { if (r.url().endsWith('/api/logout')) out.logouts++; });
page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) out.bad.push(r.status() + ' ' + r.url().replace(BASE, '')); });
const t0 = Date.now();
try { await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { out.gotoError = e.message.slice(0, 200); }
await sleep(4000);
const loginShown = async () => page.evaluate(() => !!document.getElementById('loginEmail')).catch(() => false);
out.loginAfter4s = await loginShown();
// count re-renders of the screen: every render() replaces #app's children
await page.evaluate(() => { window.__renders = 0; try { const app = document.getElementById('app'); if (app) new MutationObserver(m => { if (m.some(x => x.type === 'childList' && x.target === app)) window.__renders++; }).observe(app, { childList: true }); } catch (e) {} }).catch(() => {});
const type = async (sel, text) => {
  const res = { sel, typed: text, kept: null, focusLost: 0 };
  try {
    await page.click(sel, { timeout: 5000 });
    await page.fill(sel, '');
    for (const ch of text) {
      await page.keyboard.type(ch); await sleep(350);
      const f = await page.evaluate(s => document.activeElement && document.activeElement.matches(s), sel).catch(() => false);
      if (!f) { res.focusLost++; try { await page.click(sel, { timeout: 2000 }); } catch (e) {} }
    }
    res.kept = await page.$eval(sel, el => el.value).catch(() => null);
  } catch (e) { res.error = e.message.slice(0, 160); }
  return res;
};
out.name = await type('#loginName', 'Test Visitor');
out.email = await type('#loginEmail', 'tester@example.com');
await sleep(STALE ? 16000 : 8000);
out.renders = await page.evaluate(() => window.__renders).catch(() => 'page gone');
out.loginAfter = await loginShown();
out.emailValueAtEnd = await page.$eval('#loginEmail', el => el.value).catch(() => null);
out.seconds = Math.round((Date.now() - t0) / 1000);
out.sw = await page.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistrations(); return r.map(x => (x.active && x.active.scriptURL) || '?'); } catch (e) { return 'n/a'; } }).catch(() => 'n/a');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
await browser.close();
console.log(JSON.stringify(out, null, 1));
// loads counts real page loads; navs also lists same-page address changes (the sign-out's history.replaceState)
const ok = out.loads <= 1 && out.name.kept === 'Test Visitor' && out.email.kept === 'tester@example.com' && out.emailValueAtEnd === 'tester@example.com' && !out.name.focusLost && !out.email.focusLost && (!STALE || (out.logouts === 1 && out.loginAfter4s));
console.log(ok ? 'LOGIN OK: no reload, the typed text and the focus stay' : 'LOGIN PROBLEM: see loads / navs / focusLost / kept above');
