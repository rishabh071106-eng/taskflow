// Brodoit for Android — server side.
// GitHub Actions (.github/workflows/android.yml) builds the app and publishes an *unsigned* APK/AAB plus
// apksigner.jar as a GitHub release. This module fetches the newest release, signs it with an upload key that
// lives on the data volume (generated once with keytool; never leaves the server), and serves the result:
//   GET /download/brodoit.apk      signed APK (sideload: Install → Open → Allow)
//   GET /android                   install page (big button + 3 steps + QR for desktop)
//   GET /api/android/status        { ready, version, build, apk_url, cert_sha256, built_at }
//   GET /.well-known/assetlinks.json gains the com.brodoit.app statement via deps (see server.js)
//   GET /download/upload_certificate.pem  the upload key's certificate (public; Play Console's one-time upload key reset)
//   GET /download/play-api-cert.pem       the certificate of the key Play uploads are signed in with (public; given to the
//                                         Google Cloud service account; its private key stays in MEDIA_DIR/android/play-api)
// v19: the release holds two flavors of one build: the APK is com.brodoit.app (sideload, above) and the bundle is
// com.brodoit.twa, the existing Google Play listing, which modules/play.js uploads to Play's testing tracks.
//   POST /api/admin/android/check  (admin) look for a new build now
//   GET  /api/admin/android/keystore (admin) backup of the upload key (needed once for Play Console)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createPlay } = require('./play.js');

const PKG = 'com.brodoit.app';

function install(app, deps) {
  const { MEDIA_DIR, auth, isAdminUser } = deps;
  const PUBLIC_URL = String(deps.PUBLIC_URL || process.env.PUBLIC_URL || 'https://brodoit.com').replace(/\/$/, '');
  const GH_API = (process.env.ANDROID_GH_API || 'https://api.github.com').replace(/\/$/, '');
  const REPOS = [...new Set([process.env.ANDROID_RELEASES_REPO, 'rishabh071106-eng/taskflow', 'rishabh071106-eng/brodoit'].filter(Boolean))];
  const dir = path.join(MEDIA_DIR, 'android');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stateFile = path.join(dir, 'state.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { state = {}; }
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) {} };
  const log = (...a) => console.log('[android]', ...a);
  const run = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 }, opts || {}));
  const hasJava = (() => { try { const r = run('java', ['-version']); return r.status === 0; } catch (e) { return false; } })();
  let checking = null;
  // ───── the Play uploader's key: made here once (openssl), the private half never leaves the volume ─────
  const apiDir = path.join(dir, 'play-api'), apiKeyFile = path.join(apiDir, 'key.pem'), apiCertFile = path.join(apiDir, 'cert.pem');
  let apiKey = null;
  function playApiKey() {
    if (apiKey) return apiKey;
    try { if (fs.existsSync(apiKeyFile) && fs.existsSync(apiCertFile)) { const cert = fs.readFileSync(apiCertFile, 'utf8'); apiKey = { key: fs.readFileSync(apiKeyFile, 'utf8'), cert, sha256: new crypto.X509Certificate(cert).fingerprint256 }; return apiKey; } } catch (e) { log('play-api key unreadable:', e.message); }
    try {
      fs.mkdirSync(apiDir, { recursive: true, mode: 0o700 });
      const r = run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', apiKeyFile + '.tmp', '-out', apiCertFile + '.tmp', '-days', '3650', '-subj', '/CN=Brodoit Play uploader']);
      if (r.status !== 0) { log('openssl failed', (r.stderr || '').slice(0, 200)); return null; }
      fs.chmodSync(apiKeyFile + '.tmp', 0o600); fs.renameSync(apiKeyFile + '.tmp', apiKeyFile); fs.renameSync(apiCertFile + '.tmp', apiCertFile);
      log('play-api key created');
    } catch (e) { log('play-api key:', e.message); return null; }
    return playApiKey();
  }
  // the uploader account's email is not a secret: config/play.json (written when the Google Cloud side was set up)
  const playConfig = () => { try { return JSON.parse(fs.readFileSync(deps.playConfig || path.join(__dirname, '..', 'config', 'play.json'), 'utf8')) || {}; } catch (e) { return {}; } };
  const configEmail = () => String(playConfig().serviceAccountEmail || '');
  // v39: the closed test's tester groups (ours and the tester exchange's) are not secrets either: config/play.json
  const configGroups = () => (Array.isArray(playConfig().testerGroups) ? playConfig().testerGroups : []).map(String);
  const play = createPlay(Object.assign({ getSetting: deps.getSetting || (k => process.env[k] || ''), dir, log: (...a) => console.log('[play]', ...a), ownKey: () => { const k = playApiKey(); return k && k.key; }, configEmail, configGroups }, deps.playOptions || {}));
  // the signed bundle goes to Play only when it is the Play flavor (builds before v19 were com.brodoit.app)
  const playBuild = () => state.ready && state.aab && state.aabPackage === play.status().package ? { aab: state.aab, versionCode: state.versionCode, version: state.version } : null;
  const syncPlay = () => play.sync(playBuild()).catch(e => log('play', e.message));

  // ───── upload key (one per server, kept on the volume) ─────
  const ksPath = path.join(dir, 'upload.jks'), ksMeta = path.join(dir, 'keystore.json');
  function keystore() {
    try { const m = JSON.parse(fs.readFileSync(ksMeta, 'utf8')); if (fs.existsSync(ksPath) && m.pass) return m; } catch (e) {}
    if (!hasJava) return null;
    const pass = crypto.randomBytes(18).toString('base64url');
    const r = run('keytool', ['-genkeypair', '-v', '-keystore', ksPath, '-storepass', pass, '-keypass', pass, '-alias', 'brodoit', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Brodoit, OU=Mobile, O=Brodoit, L=New Delhi, C=IN']);
    if (r.status !== 0) { log('keytool failed', (r.stderr || r.stdout || '').slice(0, 300)); return null; }
    const meta = { alias: 'brodoit', pass, created_at: new Date().toISOString(), sha256: fingerprint(pass) };
    fs.writeFileSync(ksMeta, JSON.stringify(meta, null, 1));
    log('upload key created', meta.sha256);
    return meta;
  }
  function fingerprint(pass) {
    const r = run('keytool', ['-list', '-v', '-keystore', ksPath, '-storepass', pass, '-alias', 'brodoit']);
    const m = (r.stdout || '').match(/SHA256:\s*([0-9A-F:]{95})/i);
    return m ? m[1].toUpperCase() : null;
  }
  function cert() { const m = keystore(); return m && (m.sha256 || (m.sha256 = fingerprint(m.pass), fs.writeFileSync(ksMeta, JSON.stringify(m, null, 1)), m.sha256)); }

  // ───── releases ─────
  async function gh(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'brodoit-server', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('github ' + r.status + ' for ' + url);
    return r.json();
  }
  async function newestRelease() {
    for (const repo of REPOS) {
      try {
        const list = await gh(`${GH_API}/repos/${repo}/releases?per_page=20`);
        const ok = (list || []).filter(x => !x.draft && (x.assets || []).some(a => a.name === 'brodoit-unsigned.apk') && (x.assets || []).some(a => a.name === 'apksigner.jar'))
          .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at));
        if (ok.length) return Object.assign(ok[0], { repo });
      } catch (e) { log('releases', repo, e.message); }
    }
    return null;
  }
  async function download(url, to) {
    const r = await fetch(url, { headers: { 'User-Agent': 'brodoit-server' }, redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error('download ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(to + '.part', buf); fs.renameSync(to + '.part', to);
    return buf.length;
  }
  async function check(force) {
    if (checking) return checking;
    checking = (async () => {
      const rel = await newestRelease();
      if (!rel) { state.last_check = new Date().toISOString(); state.note = 'no build published yet'; save(); return state; }
      if (!force && state.tag === rel.tag_name && state.ready) { state.last_check = new Date().toISOString(); save(); return state; }
      if (!hasJava) { state.note = 'java missing on server (Dockerfile installs openjdk-17-jdk-headless)'; state.last_check = new Date().toISOString(); save(); return state; }
      const ks = keystore(); if (!ks) { state.note = 'keystore unavailable'; save(); return state; }
      const rdir = path.join(dir, rel.tag_name.replace(/[^A-Za-z0-9._-]/g, '_'));
      fs.mkdirSync(rdir, { recursive: true });
      const asset = n => (rel.assets || []).find(a => a.name === n);
      for (const n of ['brodoit-unsigned.apk', 'apksigner.jar', 'brodoit-unsigned.aab', 'build.json']) {
        const a = asset(n); if (!a) continue;
        const to = path.join(rdir, n);
        if (fs.existsSync(to) && fs.statSync(to).size === a.size) continue;
        log('downloading', n, Math.round(a.size / 1024) + 'KB');
        await download(a.browser_download_url, to);
      }
      let build = {}; try { build = JSON.parse(fs.readFileSync(path.join(rdir, 'build.json'), 'utf8')); } catch (e) {}
      const apkOut = path.join(rdir, 'brodoit.apk');
      const s = run('java', ['-jar', path.join(rdir, 'apksigner.jar'), 'sign', '--ks', ksPath, '--ks-key-alias', ks.alias, '--ks-pass', 'pass:' + ks.pass, '--key-pass', 'pass:' + ks.pass, '--out', apkOut, path.join(rdir, 'brodoit-unsigned.apk')], { timeout: 300000 });
      if (s.status !== 0) { state.note = 'apksigner: ' + (s.stderr || s.stdout || '').slice(0, 300); save(); log(state.note); return state; }
      const v = run('java', ['-jar', path.join(rdir, 'apksigner.jar'), 'verify', '--print-certs', apkOut]);
      const fp = ((v.stdout || '').match(/SHA-256 digest:\s*([0-9a-f]{64})/i) || [])[1];
      let aab = null;
      if (fs.existsSync(path.join(rdir, 'brodoit-unsigned.aab'))) {
        const j = run('jarsigner', ['-keystore', ksPath, '-storepass', ks.pass, '-keypass', ks.pass, '-signedjar', path.join(rdir, 'brodoit.aab'), path.join(rdir, 'brodoit-unsigned.aab'), ks.alias], { timeout: 300000 });
        if (j.status === 0) aab = path.join(rdir, 'brodoit.aab'); else log('jarsigner', (j.stderr || j.stdout || '').slice(0, 200));
      }
      state = { ready: true, tag: rel.tag_name, repo: rel.repo, build: build.build || null, version: build.version || rel.tag_name.replace(/^android-v/, ''), sha: build.sha || null,
        versionCode: build.versionCode || build.build || null, aabPackage: build.aabPackage || PKG,
        apk: apkOut, aab, size: fs.statSync(apkOut).size, cert_sha256: fp ? fp.match(/../g).join(':').toUpperCase() : cert(), built_at: rel.published_at || rel.created_at, signed_at: new Date().toISOString(), last_check: new Date().toISOString(), note: '' };
      save(); log('signed', state.version, state.cert_sha256);
      // keep only the newest two builds on disk
      try { fs.readdirSync(dir).filter(n => n.startsWith('android-') && n !== path.basename(rdir)).sort().slice(0, -1).forEach(n => fs.rmSync(path.join(dir, n), { recursive: true, force: true })); } catch (e) {}
      return state;
    })().catch(e => { log('check failed', e.message); state.note = e.message; state.last_check = new Date().toISOString(); save(); return state; }).finally(() => { checking = null; });
    return checking;
  }
  const status = () => ({ ready: !!(state.ready && state.apk && fs.existsSync(state.apk)), version: state.version || null, build: state.build || null, tag: state.tag || null,
    apk_url: PUBLIC_URL + '/download/brodoit.apk', page_url: PUBLIC_URL + '/android', size: state.size || null, cert_sha256: state.cert_sha256 || null, package: PKG, built_at: state.built_at || null, last_check: state.last_check || null, note: state.note || '',
    versionCode: state.versionCode || null, play: Object.assign(play.status(), { apiCertSha256: apiKey ? apiKey.sha256 : null }) });

  // ───── routes ─────
  const isAdmin = req => !!(req.user && isAdminUser && isAdminUser(req.user));
  app.get('/api/android/status', (_, res) => res.json(status()));
  app.get('/download/brodoit.apk', (req, res) => {
    if (!state.ready || !state.apk || !fs.existsSync(state.apk)) return res.status(404).type('text/plain').send('The Android app is being built. Try again in a few minutes.');
    res.set('Content-Type', 'application/vnd.android.package-archive');
    res.set('Content-Disposition', `attachment; filename="Brodoit-${state.version}.apk"`);
    res.set('Cache-Control', 'no-cache');
    fs.createReadStream(state.apk).pipe(res);
  });
  app.get('/download/brodoit.aab', auth, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    if (!state.aab || !fs.existsSync(state.aab)) return res.status(404).json({ error: 'no bundle yet' });
    res.set('Content-Disposition', `attachment; filename="Brodoit-${state.version}.aab"`); fs.createReadStream(state.aab).pipe(res);
  });
  // the upload key's certificate (no secret in it): Play Console → App integrity → Upload key → Request upload key reset
  app.get('/download/upload_certificate.pem', (req, res) => {
    const m = keystore(); if (!m) return res.status(503).type('text/plain').send('The upload key is not ready yet.');
    const r = run('keytool', ['-exportcert', '-rfc', '-alias', m.alias, '-keystore', ksPath, '-storepass', m.pass]);
    const pem = String(r.stdout || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (r.status !== 0 || !pem) return res.status(500).type('text/plain').send('Could not read the certificate.');
    res.set('Content-Type', 'application/x-pem-file'); res.set('Content-Disposition', 'attachment; filename="upload_certificate.pem"');
    res.send(pem[0] + '\n');
  });
  app.get('/download/play-api-cert.pem', (req, res) => {
    const k = playApiKey(); if (!k) return res.status(503).type('text/plain').send('The Play uploader key is not ready.');
    res.set('Content-Type', 'application/x-pem-file'); res.set('Content-Disposition', 'attachment; filename="play-api-cert.pem"'); res.send(k.cert);
  });
  app.post('/api/admin/android/check', auth, async (req, res) => { if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' }); await check(true); await syncPlay(); res.json(status()); });
  app.get('/api/admin/android/keystore', auth, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    const m = keystore(); if (!m) return res.status(404).json({ error: 'no keystore' });
    res.json({ alias: m.alias, password: m.pass, sha256: m.sha256 || cert(), keystore_base64: fs.readFileSync(ksPath).toString('base64'), note: 'Play Console → App integrity → upload key certificate. Keep this private.' });
  });
  app.get('/android', (_, res) => {
    const s = status(); const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Brodoit for Android</title>
<meta name="theme-color" content="#FBF8F3"><link rel="icon" href="/icon-192.png?v=5"><link rel="stylesheet" href="/app/theme.css?v=11">
<style>body{margin:0;background:var(--b-bg,#FBF8F3);color:var(--b-ink,#1F1E1C);font-family:var(--b-sans,system-ui)}.w{max-width:440px;margin:0 auto;padding:36px 20px 60px;text-align:center}.hero{width:120px;height:120px;border-radius:34px;background:linear-gradient(135deg,#B5402A,#8E2F1E 55%,#1F1E1C);margin:0 auto 18px;display:grid;place-items:center;box-shadow:0 20px 40px -18px rgba(255,45,122,.6)}h1{font:800 30px/1.1 var(--b-sans,system-ui);letter-spacing:-.03em;margin:0 0 8px}p{font:500 15px/1.5 var(--b-sans,system-ui);color:#6F697D;margin:0 0 18px}.btn{display:block;background:#1F1E1C;color:#fff;text-decoration:none;font:800 17px var(--b-sans,system-ui);padding:17px 20px;border-radius:18px;box-shadow:0 5px 0 0 #000}.btn.dis{background:#C9C5D2;box-shadow:none}.meta{font:700 12px var(--b-sans,system-ui);color:#8A8496;margin-top:10px}ol{text-align:left;padding-left:22px;font:600 15px/1.6 var(--b-sans,system-ui)}ol li{margin:8px 0}.qr{margin:26px auto 0;width:180px;height:180px;background:#fff;border:1px solid #E8E3DA;border-radius:16px;display:grid;place-items:center}.small{font:600 12px/1.5 var(--b-sans,system-ui);color:#8A8496;margin-top:24px}</style></head><body><div class="w">
<div class="hero"><svg width="72" height="72" viewBox="0 0 108 108"><path fill="#fff" d="M30,28 h48 a12,12 0 0 1 12,12 v26 a12,12 0 0 1 -12,12 h-27 l-12,11 v-11 h-9 a12,12 0 0 1 -12,-12 v-26 a12,12 0 0 1 12,-12 z"/><circle cx="44" cy="44" r="4" fill="#1F1E1C"/><circle cx="64" cy="44" r="4" fill="#1F1E1C"/><path d="M42,58 q12,10 24,0" stroke="#1F1E1C" stroke-width="4" fill="none" stroke-linecap="round"/></svg></div>
<h1>Brodoit for Android</h1><p>Counts your steps all day, even with the app closed. One tap to install, one tap to allow.</p>
${s.ready ? `<a class="btn" href="/download/brodoit.apk">Install · v${esc(s.version)}</a><div class="meta">${Math.round((s.size || 0) / 1024 / 102.4) / 10} MB · Android 8+ · no Play account needed</div>` : `<span class="btn dis">Building the app…</span><div class="meta">${esc(s.note || 'Come back in a few minutes.')}</div>`}
<ol><li>Tap <b>Install</b>, then open the downloaded file.</li><li>If asked, allow installs from Chrome (one time).</li><li>Open Brodoit and tap <b>Allow</b> for Physical activity. Done.</li></ol>
<div class="qr" id="qr" hidden></div>
<div class="small">Prefer Google Play? <a href="/beta">Join the Play test</a> and install it from the Play Store instead.</div>
<div class="small">Already use the web app? Your account and streak carry over: the app is the same Brodoit, plus background steps. iPhone: the Steps tab has a 2-minute Shortcut setup instead.</div>
</div><script>if(!/Android/i.test(navigator.userAgent)){var q=document.getElementById('qr');q.hidden=false;q.innerHTML='<img width="160" height="160" alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data='+encodeURIComponent(location.origin+'/android')+'">'}</script></body></html>`);
  });

  // ───── schedule ─────
  setTimeout(() => { playApiKey(); check(false).catch(() => {}).then(syncPlay); }, 8000);
  setInterval(() => check(false).catch(() => {}).then(syncPlay), 10 * 60 * 1000); // a new build is live within 10 minutes
  log(hasJava ? 'signing ready (java ✅)' : 'java ❌ — APKs cannot be signed on this server', '· releases from', REPOS.join(', '));
  return { status, check, cert, PKG, play, syncPlay };
}

module.exports = { install, PKG };
