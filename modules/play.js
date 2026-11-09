// Brodoit on Google Play: uploads the bundle the server signed (com.brodoit.android; the first listing, com.brodoit.twa,
// kept a name Play never lets change and tester communities refuse, so it stays empty) to Play's
// testing tracks through the Google Play Developer API, as the service account the owner gave in Admin
// (PLAY_SERVICE_ACCOUNT_JSON), or as the uploader account whose key the server made itself: its email
// (PLAY_SERVICE_ACCOUNT_EMAIL or config/play.json) plus the server's own private key (ownKey; only the public certificate
// was given to Google, so the private key never leaves the server). No SDK: a signed JWT for a token, then one "edit":
// insert → upload the bundle → put it on each track → commit.
//   createPlay({ getSetting, dir, fetch, now, log }) → { sync(build), status(), verify(json) }
//   build = { aab, versionCode, version }   (modules/android.js passes its newest signed build)
// status().state: 'no-account' (nothing pasted) | 'no-access' (Play Console has not given the account this app yet)
//   | 'waiting-key-reset' (Play does not accept our upload key yet: the owner's one-time key reset is pending)
//   | 'needs-declaration' (Play Console wants an App content answer first, e.g. Health apps; only the owner can give it)
//   | 'uploading' | 'uploaded' | 'error'. The key, tokens and Google's raw replies never leave this module (logs get
//   Google's message, the status only fixed words; v40: an unexplained error also carries Google's sentence as `detail`,
//   with emails and anything key-shaped blanked). A brand-new app's first release comes back 'uploaded' with a `reason`
//   naming the one button Play wants pressed in Play Console (Start rollout for a draft release; Send changes for review).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PKG = 'com.brodoit.android';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com';

const b64u = b => Buffer.from(b).toString('base64url');
// the pasted service account: { client_email, private_key, token_uri } or an error word
function parseAccount(raw) {
  if (!raw) return { error: 'missing' };
  let j; try { j = JSON.parse(String(raw)); } catch (e) { return { error: 'not JSON' }; }
  if (!j || j.type !== 'service_account' || !/@.+\.iam\.gserviceaccount\.com$/.test(String(j.client_email || '')) || !/BEGIN (RSA )?PRIVATE KEY/.test(String(j.private_key || ''))) return { error: 'not a Google service account key' };
  return { email: j.client_email, key: j.private_key, tokenUrl: TOKEN_URL };
}
// a token for the Play Developer API: an RS256 JWT signed with the account's key, exchanged at Google's token endpoint
async function accessToken(acc, fetchFn, now) {
  const iat = Math.floor((now ? now() : Date.now()) / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: acc.email, scope: SCOPE, aud: acc.tokenUrl, iat, exp: iat + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claims).sign(acc.key).toString('base64url');
  const r = await fetchFn(acc.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claims + '.' + sig, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error('token: ' + (j.error_description || j.error || 'HTTP ' + r.status)), { status: r.status, step: 'token' });
  return { token: j.access_token, exp: (iat + Number(j.expires_in || 3600)) * 1000 };
}

function createPlay(o) {
  const getSetting = o.getSetting || (() => '');
  const fetchFn = o.fetch || ((...a) => fetch(...a));
  const now = o.now || (() => Date.now());
  const log = o.log || ((...a) => console.log('[play]', ...a));
  const api = String(o.api || API).replace(/\/$/, '');
  const pkg = o.pkg || PKG;
  const file = path.join(o.dir, 'play.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { st = {}; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st, null, 1)); } catch (e) { /* the next try writes it */ } };
  // the pasted key file wins; else the uploader email with the server's own key
  function account() {
    const raw = getSetting('PLAY_SERVICE_ACCOUNT_JSON');
    if (raw) return parseAccount(raw);
    const email = String(getSetting('PLAY_SERVICE_ACCOUNT_EMAIL') || (o.configEmail ? o.configEmail() : '') || '').trim();
    if (!email) return { error: 'missing' };
    if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)) return { error: 'not a service account email' };
    const key = o.ownKey ? o.ownKey() : null;
    if (!key) return { error: 'without its key on this server' };
    return { email, key, tokenUrl: TOKEN_URL, own: true };
  }
  const tracks = () => String(getSetting('PLAY_TRACKS') || 'internal,alpha').split(',').map(s => s.trim()).filter(s => /^[a-z0-9:_-]{2,40}$/i.test(s));
  // v39 launch: the Google Groups whose members may join the closed test — our own testers' group and a tester
  // exchange's (Testers Community gives each developer one), from config/play.json `testerGroups` and the
  // PLAY_TESTER_GROUPS setting. They go on every closed track (not internal: it takes email lists only); a group is only
  // ever added, never taken off, so one the owner added in Play Console stays.
  const groups = () => [...new Set([...(o.configGroups ? o.configGroups() : []), ...String(getSetting('PLAY_TESTER_GROUPS') || '').split(/[\s,]+/)]
    .map(s => String(s || '').trim().toLowerCase()).filter(s => /^[a-z0-9][a-z0-9._-]{0,62}@googlegroups\.com$/.test(s)))].sort();
  const closedTracks = () => tracks().filter(t => t !== 'internal');
  let tok = null, running = null;

  async function call(method, url, body, type) {
    if (!tok || tok.exp - 60e3 < now()) tok = await accessToken(account(), fetchFn, now);
    const headers = { Authorization: 'Bearer ' + tok.token };
    let data;
    if (Buffer.isBuffer(body)) { headers['Content-Type'] = type || 'application/octet-stream'; data = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
    const r = await fetchFn(url, { method, headers, body: data, signal: AbortSignal.timeout(Buffer.isBuffer(body) ? 600000 : 30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const m = (j.error && (j.error.message || j.error.status)) || ('HTTP ' + r.status); throw Object.assign(new Error(String(m)), { status: r.status }); }
    return j;
  }
  // Google's message → one of our fixed words
  function classify(e) {
    const m = String(e && e.message || '');
    if (e && e.step === 'token') return { state: 'error', reason: 'Google refused the service account key' };
    if (/wrong key|signed with the wrong|upload certificate|not signed with the upload|signature/i.test(m)) return { state: 'waiting-key-reset', reason: 'Play does not accept our upload key yet (the upload key reset is pending)' };
    if (/already been used|already exists|versionCode.*used/i.test(m)) return { state: 'uploaded', reason: '' };
    // Play Console still wants an App content answer ("You must let us know whether your app includes any health
    // features."): Google answers 403, but the account has access; the build goes up by itself once it is given
    if (/must let us know|declaration|questionnaire|app content|data safety|content rating|target audience|health features/i.test(m)) {
      const what = /health/i.test(m) ? 'Health apps' : /data safety/i.test(m) ? 'Data safety' : /rating/i.test(m) ? 'Content rating' : /target audience|children|famil/i.test(m) ? 'Target audience and content' : /\bads\b/i.test(m) ? 'Ads' : 'App content';
      return { state: 'needs-declaration', reason: 'Play Console is waiting for the "' + what + '" answer (Policy and programs → App content); the build goes up by itself within 10 minutes of it' };
    }
    // Google answers the same 403 for an app that does not exist yet and for one the account is not on
    if (e && (e.status === 401 || e.status === 403) || /permission|caller does not have|not authorized|forbidden/i.test(m)) return { state: 'no-access', reason: 'Play Console has no app ' + pkg + ' for this account yet, or the service account is not on it (Users and permissions)' };
    if (e && e.status === 404 || /not found|no application/i.test(m)) return { state: 'error', reason: 'Play has no app ' + pkg + ' for this account' };
    // v40: Google's words (no secrets in them: emails and anything key-shaped are blanked) so the owner can see why
    return { state: 'error', reason: 'the upload failed; it is tried again within the hour', detail: m.replace(/[\w.+-]+@[\w.-]+/g, '…').replace(/[A-Za-z0-9_-]{24,}/g, '…').slice(0, 160) };
  }

  // one edit: insert → upload the bundle → each track → tester groups → commit. Returns the versionCode and the notes a
  // brand-new app earns on its first release (Play wants a person to press one button in Play Console for each).
  async function upload(b) {
    const notes = [];
    const edit = await call('POST', `${api}/androidpublisher/v3/applications/${pkg}/edits`, {});
    const up = await call('POST', `${api}/upload/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`, fs.readFileSync(b.aab), 'application/octet-stream');
    const vc = String(up.versionCode || b.versionCode);
    for (const t of tracks()) {
      const rel = { track: t, releases: [{ name: String(b.version || vc), versionCodes: [vc], status: 'completed' }] };
      try { await call('PUT', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}/tracks/${encodeURIComponent(t)}`, rel); }
      catch (e) {
        // an app that was never released anywhere takes draft releases only
        if (!/draft/i.test(String(e.message))) throw e;
        rel.releases[0].status = 'draft';
        await call('PUT', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}/tracks/${encodeURIComponent(t)}`, rel);
        if (!notes.length || !/Start rollout/.test(notes[notes.length - 1])) notes.push('a draft release (first release of a new app): Play Console → Testing → Closed testing → ' + t + ' → Review release → Start rollout');
      }
    }
    await addGroups(edit.id);
    try { await call('POST', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}:commit`); }
    catch (e) {
      // v40: a new app's changes cannot be sent for review by the API ("set the query parameter changesNotSentForReview to
      // true"): commit them unsent, and the owner presses "Send changes for review" once in Play Console
      if (!/changesNotSentForReview/i.test(String(e.message))) throw e;
      await call('POST', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}:commit?changesNotSentForReview=true`);
      notes.push('the changes are up but not sent for review: Play Console → Publishing overview → Send changes for review');
    }
    markGroups();
    return { vc: Number(vc), note: notes.join('; ') };
  }
  // the tester groups onto each closed track, in an open edit (merged with what is there). A refusal here does not stop
  // the build going up: it is noted and tried again on the next sync.
  async function addGroups(editId) {
    const want = groups(); if (!want.length) return false;
    let changed = false; st.groups_error = '';
    for (const t of closedTracks()) {
      const url = `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(editId)}/testers/${encodeURIComponent(t)}`;
      try {
        const have = ((await call('GET', url)).googleGroups || []).map(g => String(g).toLowerCase());
        const all = [...new Set([...have, ...want])];
        if (all.length !== have.length) { await call('PUT', url, { googleGroups: all }); changed = true; }
      } catch (e) { st.groups_error = String(e && e.message || e).slice(0, 200); log('tester groups on', t, '→', st.groups_error); return changed; }
    }
    return changed;
  }
  // after a commit: these groups are on these tracks
  const markGroups = () => { if (!st.groups_error) { st.groups = groups(); st.groups_tracks = closedTracks(); } };
  // a group added after the build went up (a new tester exchange): its own small edit
  async function attachGroups() {
    const edit = await call('POST', `${api}/androidpublisher/v3/applications/${pkg}/edits`, {});
    const changed = await addGroups(edit.id);
    if (st.groups_error) { await call('DELETE', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}`).catch(() => {}); return; }
    if (changed) { await call('POST', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}:commit`); log('tester groups on', closedTracks().join(' + ') + ':', groups().join(', ')); }
    else await call('DELETE', `${api}/androidpublisher/v3/applications/${pkg}/edits/${encodeURIComponent(edit.id)}`).catch(() => {});
    markGroups();
  }
  const groupsDone = () => String(st.groups || []) === String(groups()) && String(st.groups_tracks || []) === String(closedTracks()) && !st.groups_error;

  // the newest signed build goes up once; until it is up, every call (hourly, after a new build, after the key is
  // pasted) tries again
  function sync(b) {
    if (running) return running;
    running = (async () => {
      if (!b || !b.aab || !fs.existsSync(b.aab) || !b.versionCode) return status();
      const acc = account();
      if (acc.error) { Object.assign(st, { state: acc.error === 'missing' ? 'no-account' : 'error', reason: acc.error === 'missing' ? '' : 'the service account is ' + acc.error, pending: b.versionCode }); save(); return status(); }
      // a new account (or key) gets a fresh token
      const who = acc.email + (acc.own ? ' (server key)' : ''); if (st.account !== who) { tok = null; st.account = who; }
      if (st.uploaded >= b.versionCode) {
        // the build is up; a tester group that is not on the closed track yet goes on now
        if (groups().length && closedTracks().length && !groupsDone()) {
          try { await attachGroups(); } catch (e) { st.groups_error = String(e && e.message || e).slice(0, 200); log('tester groups →', st.groups_error); if (e && e.step === 'token') tok = null; }
          save();
        }
        return status();
      }
      Object.assign(st, { state: 'uploading', pending: b.versionCode, tried_at: new Date(now()).toISOString() }); save();
      try {
        const r = await upload(b);
        Object.assign(st, { state: 'uploaded', reason: r.note || '', detail: '', uploaded: Math.max(r.vc, b.versionCode), tracks: tracks(), uploaded_at: new Date(now()).toISOString(), pending: null });
        log('uploaded', pkg, 'versionCode', b.versionCode, 'to', tracks().join(' + '), r.note ? '(' + r.note + ')' : '');
      } catch (e) {
        const c = classify(e);
        if (c.state === 'uploaded') Object.assign(st, { state: 'uploaded', reason: '', detail: '', uploaded: b.versionCode, pending: null });
        else Object.assign(st, { detail: '' }, c, { pending: b.versionCode });
        log('upload of versionCode', b.versionCode, '→', st.state + ':', String(e && e.message || e).slice(0, 300));
        if (e && e.step === 'token') tok = null;
      }
      save(); return status();
    })().finally(() => { running = null; });
    return running;
  }
  // testers: the groups wanted on the closed tracks and whether Play has them (Google's message stays in the log)
  const status = () => ({ state: st.state || (account().error === 'missing' ? 'no-account' : 'waiting'), versionCode: st.uploaded || null, pending: st.pending || null, tracks: st.tracks || tracks(), reason: st.reason || '', detail: st.detail || '', at: st.uploaded_at || st.tried_at || null, package: pkg,
    testers: { groups: groups(), on: closedTracks(), done: groups().length ? groupsDone() : true } });
  // Admin: does this pasted key work? (a token is enough; access to the app shows on the first upload)
  async function verify(raw) {
    const acc = parseAccount(raw);
    if (acc.error) return { valid: false, error: acc.error === 'missing' ? 'Paste the service account key (the .json file Google gave you).' : 'This is ' + acc.error + '.' };
    try { await accessToken(acc, fetchFn, now); return { valid: true }; } catch (e) { return { valid: false, error: 'Google refused this key (' + String(e.message).replace(/^token: /, '').slice(0, 120) + ').' }; }
  }
  return { sync, status, verify, _st: () => st };
}

module.exports = { createPlay, parseAccount, accessToken, PKG };
