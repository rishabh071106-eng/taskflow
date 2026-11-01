// Whole-app smoke test: the real server boots, a signed-in
// phone opens every tab (Bro, News, Steps, Tasks, Learn, Books, You) at 390×844 in English and Hindi with no page
// errors and real content drawn, the main pages and APIs answer, and the login screen holds what is typed.
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path'; import { spawn, execFileSync } from 'child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.ROOT || path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync('/tmp/brodoit-e2e-');
const TEMPLATE_DB = execFileSync(process.execPath, [HERE + '/make-db.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim(); // a test database with two signed-in users
const require = createRequire(ROOT + '/package.json'); const { chromium } = require('playwright');
let pass = 0, fail = 0; const failed = [];
const check = (n, c, x) => { c ? pass++ : (fail++, failed.push(n)); console.log((c ? '  ok   ' : '  FAIL ') + n, c ? '' : (x === undefined ? '' : JSON.stringify(x).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DB = TMP + '/smoke.db'; fs.copyFileSync(TEMPLATE_DB, DB); for (const x of ['-wal', '-shm']) try { fs.rmSync(DB + x); } catch (e) {}
const MEDIA = fs.mkdtempSync('/tmp/p0smoke-'); const PORT = 3297, BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: MEDIA, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999' });
const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { up = false; } }
check('the real server boots', up, out.slice(-5));
const browser = await chromium.launch();
try {
  for (const [path, want] of [['/', 'Brodoit'], ['/credits', 'Photo credits'], ['/app/news.js?v=30', 'NewsChannel'], ['/app/ideas.js?v=32', 'BookIdeas'], ['/app/ideas/index.json', 'ids'], ['/app/briefs/medi.json', 'Meditations']]) {
    const r = await fetch(BASE + path); const t = await r.text();
    check('GET ' + path + ' answers', r.ok && t.includes(want), r.status);
  }
  for (const api of ['/api/health', '/api/learn/voice-status', '/api/book-hi', '/api/news/desk?limit=5']) { const r = await fetch(BASE + api); check('GET ' + api + ' answers', r.status < 500, r.status); }
  for (const lang of ['en', 'hi']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.addInitScript(([l]) => { localStorage.setItem('tf_token', 'tokR'); localStorage.setItem('bd_onboarded', '1'); localStorage.setItem('news.swiped', '1'); localStorage.setItem('bd_lang', l); }, [lang]);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof S !== 'undefined' && S.user, null, { timeout: 30000 }); await sleep(800);
    for (const tab of ['bro', 'news', 'steps', 'tasks', 'courses', 'books', 'profile']) {
      await page.evaluate(t => switchTab(t), tab); await sleep(900);
      const st = await page.evaluate(() => ({ tab: S.tab, text: (document.getElementById('app') || document.body).innerText.trim().length, overflowX: document.documentElement.scrollWidth > innerWidth + 1 }));
      check(lang + ' · ' + tab + ': draws content, no sideways scroll', st.text > 40 && !st.overflowX, st);
    }
    check(lang + ': no page errors across the tabs', errs.length === 0, errs.slice(0, 3));
    await ctx.close();
  }
  // the login screen keeps what is typed (v25 fix)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('bd_onboarded', '1'); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await sleep(1500);
  const nameBox = await page.$('#loginName'); const emailBox = await page.$('#loginEmail');
  if (nameBox && emailBox) { await nameBox.fill('Test Person'); await emailBox.fill('t@example.com'); await sleep(11000); const v = await page.evaluate(() => [document.getElementById('loginName').value, document.getElementById('loginEmail').value]); check('a new visitor\'s typed name and email survive 11 s on the login screen', v[0] === 'Test Person' && v[1] === 't@example.com', v); }
  else check('the login screen shows name and email', false, { name: !!nameBox, email: !!emailBox });
  await ctx.close();
} finally { await browser.close(); child.kill(); }
console.log(`\nsmoke: ${pass} passed, ${fail} failed` + (failed.length ? ' (' + failed.join('; ') + ')' : ''));
process.exit(fail ? 1 : 0);
