// Palm reading (/astro/palm.html). Two ways in, one reading out:
//   • the camera (or a photo): a guide outline and a light meter while framing, a quick blur/light check, then the photo
//     goes once to /api/astro/palm (Gemini, then OpenAI). The server never keeps it.
//   • the self-guided reading: 14 questions with a drawing of each line (no account or internet needed).
// Both fill the same features (astro/assets/text.js PALM), drawn on a palm diagram, grouped into five sections.
// The last reading stays on the phone (astro.palm.v1, with a small thumbnail of the photo).
(function () {
  'use strict';
  const { t, tx, esc, ic } = AX, X = window.AstroText, main = document.getElementById('main');
  bdTopbar({ back: '/astro/', backLabel: t('Jyotish', 'ज्योतिष'), title: t('Palm reading', 'हस्तरेखा') });
  let status = { signedIn: !!AX.token(), vision: true, palmLeft: 1 };
  const S = { hand: AX.get('astro.palm.hand', 'right'), photo: null, thumb: null, check: null, answers: {} };

  // ── the palm diagram: drawn as a left palm seen by its owner (thumb on the left), mirrored for the right hand, so it
  //    matches what you see when you look at your own palm. The camera outline is the other way round: the camera faces
  //    the palm, so a right palm shows its thumb on the left there. ──
  const HAND = 'M62 252L52 205C38 200 20 182 12 162C7 150 13 138 25 142C35 146 41 160 50 164L48 112L48 58Q48 46 60 46Q72 46 72 58L72 104L76 104L76 40Q76 28 88 28Q100 28 100 40L100 104L104 104L104 50Q104 38 116 38Q128 38 128 50L128 106L132 106L132 74Q132 64 142 64Q152 64 152 74L152 118C160 140 162 180 158 210L154 252Z';
  const MOUNT_XY = { venus: [70, 205, 18, 26], jupiter: [60, 124, 11, 8], saturn: [88, 120, 11, 8], apollo: [116, 121, 11, 8], mercury: [141, 125, 10, 8], moon: [138, 214, 14, 22] };
  function palmSvg(f, o) {
    f = f || {}; o = o || {};
    const focus = o.focus || null, dim = k => (focus && focus !== k ? ' dim' : '');
    const end = { jupiter: [60, 118], between: [74, 113], saturn: [90, 121] }[f.heartEnd || 'between'];
    const heart = f.heartShape === 'straight' ? 'M153 128C126 129 100 128 ' + end[0] + ' ' + (end[1] + 6) : 'M153 128C124 138 96 140 ' + end[0] + ' ' + end[1];
    const hx = { short: 100, medium: 128, long: 150 }[f.headLen || 'medium'], hy = { straight: 148, gentle: 168, steep: 198 }[f.headSlope || 'gentle'];
    const hs = f.headStart === 'separate' ? [55, 133] : [50, 146];
    const head = 'M' + hs[0] + ' ' + hs[1] + 'C' + (hs[0] + 30) + ' ' + (hs[1] + 2) + ' ' + (hx - 25) + ' ' + (hy - (f.headSlope === 'steep' ? 30 : 8)) + ' ' + hx + ' ' + hy;
    const cx = { wide: 112, medium: 96, close: 80 }[f.lifeArc || 'medium'];
    const life = 'M50 146C' + cx + ' 170 ' + (cx + 2) + ' 214 80 249';
    let s = '<svg class="ax-palm-fig' + (o.cls ? ' ' + o.cls : '') + '" viewBox="' + (o.cls === 'mini' ? '30 95 140 160' : '0 0 200 260') + '" role="img" aria-label="' + esc(o.label || t('Palm diagram', 'हथेली का चित्र')) + '"' + (S.hand === 'right' ? ' style="transform:scaleX(-1)"' : '') + '>'
      + '<path class="hand" d="' + HAND + '"/>';
    if (f.mount && MOUNT_XY[f.mount]) { const m = MOUNT_XY[f.mount]; s += '<ellipse class="mt' + dim('mount') + '" cx="' + m[0] + '" cy="' + m[1] + '" rx="' + m[2] + '" ry="' + m[3] + '"/>'; }
    s += '<path class="ln life' + dim('life') + '" d="' + life + '"/>';
    if (f.lifeMarks === 'double') s += '<path class="ln life' + dim('life') + '" style="stroke-width:2.5" d="M58 168C' + (cx - 6) + ' 186 ' + (cx - 6) + ' 214 82 236"/>';
    if (f.lifeMarks === 'breaks') s += '<path d="M' + (cx - 4) + ' 196l10 4" stroke="var(--b-card)" stroke-width="7"/>';
    s += '<path class="ln head' + dim('head') + '" d="' + head + '"/>';
    s += '<path class="ln heart' + dim('heart') + '" d="' + heart + '"/>';
    if (f.fate && f.fate !== 'none') s += '<path class="ln fate' + dim('fate') + '"' + (f.fate === 'faint' ? ' style="stroke-dasharray:7 6;stroke-width:3"' : '') + ' d="M106 248C102 200 94 160 90 116"/>';
    if (f.sun && f.sun !== 'none') s += '<path class="ln sun' + dim('sun') + '"' + (f.sun === 'faint' ? ' style="stroke-dasharray:6 6;stroke-width:3"' : '') + ' d="M126 196C124 168 120 140 117 118"/>';
    const nb = Math.min(3, +f.bonds || 0); for (let i = 0; i < nb; i++) s += '<path class="ln heart' + dim('bonds') + '" style="stroke-width:2.5" d="M147 ' + (114 - i * 5) + 'L156 ' + (114 - i * 5) + '"/>';
    return s + '</svg>';
  }
  const LEGEND = () => '<div class="ax-legend"><span><i style="background:#DB2777"></i>' + esc(t('Heart', 'हृदय')) + '</span><span><i style="background:#2563EB"></i>' + esc(t('Head', 'मस्तिष्क')) + '</span><span><i style="background:#16A34A"></i>' + esc(t('Life', 'जीवन')) + '</span><span><i style="background:#7C3AED"></i>' + esc(t('Fate', 'भाग्य')) + '</span><span><i style="background:#D97706"></i>' + esc(t('Sun', 'सूर्य')) + '</span></div>';
  // which line each question draws (and how each answer looks)
  const FOCUS = { heartEnd: 'heart', heartShape: 'heart', headLen: 'head', headSlope: 'head', headStart: 'head', lifeArc: 'life', lifeMarks: 'life', fate: 'fate', sun: 'sun', bonds: 'bonds', mount: 'mount' };
  // later values win, but a missing (null) answer keeps the drawing's default
  const merge = (...xs) => { const o = {}; for (const x of xs) for (const k in x || {}) if (x[k] != null) o[k] = x[k]; return o; };
  const BASE = { shape: 'air', heartEnd: 'between', heartShape: 'curved', headLen: 'medium', headSlope: 'gentle', headStart: 'joined', lifeArc: 'medium', lifeMarks: 'none', fate: 'deep', sun: 'clear', bonds: '1' };

  // ── intro ──
  function intro() {
    const last = AX.get('astro.palm.v1', null);
    let h = '<header class="ui-page-h"><h1>' + esc(t('Palm reading', 'हस्तरेखा')) + '</h1></header>'
      + '<p class="ax-lead">' + esc(t('Your palm, line by line: heart, head, life and fate.', 'आपकी हथेली, रेखा दर रेखा: हृदय, मस्तिष्क, जीवन और भाग्य।')) + '</p>'
      + '<section class="ax-card">' + palmSvg(BASE) + LEGEND() + '</section>'
      + '<div class="ui-sec">' + esc(t('Which hand?', 'कौन-सा हाथ?')) + '</div>'
      + '<div class="ui-seg" role="group" style="display:flex">' + [['right', t('Right hand', 'दायाँ हाथ')], ['left', t('Left hand', 'बायाँ हाथ')]].map(([k, l]) => '<button type="button" style="flex:1" data-hand="' + k + '" aria-pressed="' + (S.hand === k) + '"' + (S.hand === k ? ' class="on"' : '') + '>' + esc(l) + '</button>').join('') + '</div>'
      + '<p class="ax-small" style="margin:8px 4px 0">' + esc(t('Read the hand you write with: it shows the life you are making. The other shows what you were born with.', 'जिस हाथ से लिखते हैं उसे पढ़ें: वह आपकी बनाई राह दिखाता है। दूसरा हाथ जन्म से मिली बातें दिखाता है।')) + '</p>';
    const canAi = status.vision && status.signedIn && status.palmLeft > 0;
    h += '<div class="ax-stack" style="margin-top:18px">';
    if (canAi) h += '<button type="button" class="ui-btn accent wide" id="cam">' + ic('camera', 20) + esc(t('Read with the camera', 'कैमरे से पढ़ें')) + '</button>'
      + '<label class="ui-btn sec wide" for="file">' + ic('image', 20) + esc(t('Use a photo', 'फ़ोटो से पढ़ें')) + '</label><input type="file" id="file" accept="image/*" hidden>';
    h += '<button type="button" class="ui-btn ' + (canAi ? 'ghost' : 'accent') + ' wide" id="quiz">' + ic('list-checks', 20) + esc(t('Read it myself, step by step', 'ख़ुद पढ़ें, एक-एक कदम')) + '</button></div>';
    if (!status.signedIn) h += '<p class="ax-note" style="margin-top:12px">' + ic('info', 18) + '<span>' + esc(t('Sign in to Brodoit to read your palm with the camera. The step-by-step reading works without an account.', 'कैमरे से पढ़ने के लिए Brodoit में साइन इन करें। एक-एक कदम वाली रीडिंग बिना अकाउंट के भी चलती है।')) + ' <a href="' + AX.signInHref + '">' + esc(t('Sign in', 'साइन इन')) + '</a></span></p>';
    else if (!status.vision) h += '<p class="ax-note" style="margin-top:12px">' + ic('info', 18) + '<span>' + esc(t('The camera reader is not switched on yet. The step-by-step reading gives the same kind of reading.', 'कैमरा रीडर अभी चालू नहीं है। एक-एक कदम वाली रीडिंग भी वैसी ही रीडिंग देती है।')) + '</span></p>';
    else if (status.palmLeft <= 0) h += '<p class="ax-note" style="margin-top:12px">' + ic('info', 18) + '<span>' + esc(t("You've used today's camera readings. Try again tomorrow, or read it step by step.", 'आज की कैमरा रीडिंग पूरी हो गईं। कल फिर कोशिश करें, या एक-एक कदम पढ़ें।')) + '</span></p>';
    else h += '<p class="ax-small" style="margin:10px 4px 0">' + esc(t('Good light, palm open and flat, fingers together. Your photo is read once and not stored.', 'अच्छी रोशनी, हथेली खुली और सीधी, उँगलियाँ साथ। आपकी फ़ोटो एक बार पढ़ी जाती है, रखी नहीं जाती।')) + '</p>';
    if (last) h += '<div class="ui-sec">' + esc(t('Your last reading', 'आपकी पिछली रीडिंग')) + '</div><div class="ui-list"><button type="button" class="ui-row" id="last"><span class="ui-ic" style="--ui-accent:var(--g-palm)">' + ic('hand', 22) + '</span><span class="ui-tx"><b>' + esc(AX.fmtDate(new Date(last.at), { day: 'numeric', month: 'long', year: 'numeric' })) + '</b><small>' + esc((last.hand === 'left' ? t('Left hand', 'बायाँ हाथ') : t('Right hand', 'दायाँ हाथ')) + ' · ' + (last.source === 'ai' ? t('camera', 'कैमरा') : t('step by step', 'एक-एक कदम'))) + '</small></span><span class="ui-chev">' + ic('chevron-right', 18) + '</span></button></div>';
    h += AX.disclaimer();
    main.innerHTML = h;
    main.querySelectorAll('[data-hand]').forEach(b => b.addEventListener('click', () => { S.hand = b.dataset.hand; AX.set('astro.palm.hand', S.hand); intro(); }));
    const cam = document.getElementById('cam'); if (cam) cam.addEventListener('click', openCamera);
    const file = document.getElementById('file'); if (file) file.addEventListener('change', () => { const f0 = file.files && file.files[0]; if (f0) fromFile(f0); file.value = ''; });
    document.getElementById('quiz').addEventListener('click', () => { S.answers = {}; AX.nav.go('q', 0); });
    const l = document.getElementById('last'); if (l) l.addEventListener('click', () => AX.nav.go('result', last));
  }

  // ── photo: downscale, check light and sharpness ──
  function prepare(src, w, h) {
    const k = Math.min(1, 1280 / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const tk = 320 / Math.max(c.width, c.height), tc = document.createElement('canvas');
    tc.width = Math.round(c.width * tk); tc.height = Math.round(c.height * tk); tc.getContext('2d').drawImage(c, 0, 0, tc.width, tc.height);
    S.photo = c.toDataURL('image/jpeg', 0.86); S.thumb = tc.toDataURL('image/jpeg', 0.7); S.check = quality(c);
    AX.nav.go('preview');
  }
  function luma(canvas, size) {
    const s = document.createElement('canvas'); s.width = s.height = size;
    const g = s.getContext('2d', { willReadFrequently: true }); g.drawImage(canvas, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size).data, L = new Float32Array(size * size);
    for (let i = 0; i < L.length; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return L;
  }
  function quality(canvas) {
    const n = 192, L = luma(canvas, n); let mean = 0; for (const v of L) mean += v; mean /= L.length;
    let sum = 0, sq = 0, cnt = 0;
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) { const i = y * n + x, lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - n] - L[i + n]; sum += lap; sq += lap * lap; cnt++; }
    const sharp = sq / cnt - (sum / cnt) ** 2;
    return { mean, sharp, dark: mean < 55, bright: mean > 228, blurry: sharp < 25 };
  }
  function fromFile(f) {
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => { prepare(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); AX.toast(t('That file is not a photo we can read.', 'यह फ़ाइल पढ़ी नहीं जा सकी।')); };
    img.src = url;
  }

  // ── the camera ──
  let camEl = null, stream = null, facing = 'environment', meterT = null;
  function closeCamera() {
    clearInterval(meterT); meterT = null;
    if (stream) { stream.getTracks().forEach(tr => { try { tr.stop(); } catch (e) { /* stopped */ } }); stream = null; }
    if (camEl) { camEl.remove(); camEl = null; }
    window.bdBackHandler = () => AX.nav.back();
  }
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { AX.toast(t('This browser cannot open the camera. Use a photo instead.', 'यह ब्राउज़र कैमरा नहीं खोल सकता। फ़ोटो से पढ़ें।')); return; }
    closeCamera();
    camEl = document.createElement('div'); camEl.className = 'ax-cam'; camEl.setAttribute('role', 'dialog'); camEl.setAttribute('aria-label', t('Camera', 'कैमरा'));
    camEl.innerHTML = '<video playsinline muted autoplay></video>'
      + '<svg class="guide" viewBox="0 0 200 260" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g transform="translate(20 22) scale(.8)' + (S.hand === 'left' ? ' translate(200 0) scale(-1 1)' : '') + '"><path d="' + HAND + '"/></g></svg>'
      + '<div class="top"><button type="button" class="cbtn" id="cx" aria-label="' + esc(t('Close camera', 'कैमरा बंद करें')) + '">' + ic('x', 24) + '</button><p>' + esc(t('Fit your open ' + (S.hand === 'left' ? 'left' : 'right') + ' palm in the outline', 'अपनी खुली ' + (S.hand === 'left' ? 'बाईं' : 'दाईं') + ' हथेली को आकृति में रखें')) + '</p><span style="width:48px"></span></div>'
      + '<div class="meter" id="meter">' + esc(t('Starting the camera…', 'कैमरा शुरू हो रहा है…')) + '</div>'
      + '<div class="bot"><span style="width:48px"></span><button type="button" class="shutter" id="shot" aria-label="' + esc(t('Take the photo', 'फ़ोटो लें')) + '"></button>'
      + '<button type="button" class="cbtn" id="flip" aria-label="' + esc(t('Switch camera', 'कैमरा बदलें')) + '">' + ic('refresh-cw', 22) + '</button></div>';
    document.body.appendChild(camEl);
    window.bdBackHandler = () => { closeCamera(); return true; };
    const video = camEl.querySelector('video');
    camEl.querySelector('#cx').addEventListener('click', closeCamera);
    camEl.querySelector('#flip').addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; start(); });
    camEl.querySelector('#shot').addEventListener('click', () => {
      if (!video.videoWidth) return;
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0); closeCamera(); prepare(c, c.width, c.height);
    });
    async function start() {
      if (stream) stream.getTracks().forEach(tr => tr.stop());
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } }); }
      catch (e) { closeCamera(); AX.toast(e && e.name === 'NotAllowedError' ? t('Camera permission was refused. Use a photo instead.', 'कैमरे की अनुमति नहीं मिली। फ़ोटो से पढ़ें।') : t('No camera found. Use a photo instead.', 'कैमरा नहीं मिला। फ़ोटो से पढ़ें।'), 3600); return; }
      if (!camEl) { stream.getTracks().forEach(tr => tr.stop()); return; }
      video.srcObject = stream; try { await video.play(); } catch (e) { /* autoplay muted works */ }
      // the light meter: the middle of the frame, twice a second
      const small = document.createElement('canvas'); small.width = small.height = 48; const g = small.getContext('2d', { willReadFrequently: true });
      clearInterval(meterT);
      meterT = setInterval(() => {
        if (!camEl || !video.videoWidth) return;
        const vw = video.videoWidth, vh = video.videoHeight, s0 = Math.min(vw, vh) * 0.6;
        g.drawImage(video, (vw - s0) / 2, (vh - s0) / 2, s0, s0, 0, 0, 48, 48);
        const d = g.getImageData(0, 0, 48, 48).data; let m = 0; for (let i = 0; i < d.length; i += 4) m += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; m /= d.length / 4;
        const el = camEl.querySelector('#meter'), ok = m >= 70 && m <= 225;
        el.className = 'meter' + (ok ? ' ok' : ''); el.textContent = m < 70 ? t('More light, please', 'थोड़ी और रोशनी चाहिए') : m > 225 ? t('Too bright: move out of direct light', 'बहुत तेज़ रोशनी: सीधी रोशनी से हटें') : t('Good light. Hold steady and tap', 'रोशनी ठीक है। हाथ स्थिर रखें और दबाएँ');
      }, 500);
    }
    start();
  }

  // ── preview and the reader ──
  function preview() {
    if (!S.photo) { AX.nav.replace('intro'); return; }
    const c = S.check || {}, warn = c.dark ? t('The photo looks dark. More light gives a better reading.', 'फ़ोटो अँधेरी लग रही है। ज़्यादा रोशनी में बेहतर पढ़ी जाएगी।') : c.bright ? t('The photo is very bright; the lines may wash out.', 'फ़ोटो बहुत चमकीली है; रेखाएँ फीकी पड़ सकती हैं।') : c.blurry ? t('The photo looks a little blurry. Hold steady or tap to focus.', 'फ़ोटो थोड़ी धुंधली है। हाथ स्थिर रखें या फ़ोकस करें।') : '';
    main.innerHTML = '<header class="ui-page-h"><h1>' + esc(t('Your palm', 'आपकी हथेली')) + '</h1></header>'
      + '<img class="ax-shot" src="' + S.photo + '" alt="' + esc(t('Your palm photo', 'आपकी हथेली की फ़ोटो')) + '">'
      + (warn ? '<p class="ax-note" style="margin-top:12px">' + ic('alert-triangle', 18) + '<span>' + esc(warn) + '</span></p>' : '<p class="ax-note" style="margin-top:12px">' + ic('check-circle', 18) + '<span>' + esc(t('Light and focus look fine.', 'रोशनी और फ़ोकस ठीक हैं।')) + '</span></p>')
      + '<div class="ax-stack" style="margin-top:16px"><button type="button" class="ui-btn accent wide" id="go">' + esc(t('Read my palm', 'मेरी हथेली पढ़ें')) + '</button>'
      + '<button type="button" class="ui-btn sec wide" id="again">' + esc(t('Take another', 'दूसरी फ़ोटो लें')) + '</button></div>'
      + '<p class="ax-small ax-center" style="margin-top:10px">' + esc(t('Your photo is read once and not stored.', 'आपकी फ़ोटो एक बार पढ़ी जाती है, रखी नहीं जाती।')) + '</p>';
    document.getElementById('go').addEventListener('click', read);
    document.getElementById('again').addEventListener('click', () => { AX.nav.replace('intro'); openCamera(); });
  }
  async function read() {
    main.innerHTML = '<div class="ax-load" role="status"><div class="ax-spin"></div><b>' + esc(t('Reading your lines…', 'आपकी रेखाएँ पढ़ी जा रही हैं…')) + '</b><p class="ax-muted">' + esc(t('This takes about 10 seconds.', 'इसमें लगभग 10 सेकंड लगते हैं।')) + '</p></div>';
    try {
      const r = await AX.api('/api/astro/palm', { body: { image: S.photo, hand: S.hand, lang: AX.lang } });
      if (!r.ok) return problem(r.code, r.tip, r.quality);
      status.palmLeft = r.left;
      const reading = { at: Date.now(), hand: S.hand, source: 'ai', features: r.features, notes: r.notes, summary: r.summary, thumb: S.thumb };
      AX.set('astro.palm.v1', reading); AX.nav.replace('result', reading);
    } catch (e) { problem(e.body && e.body.code || (e.status === 401 ? 'auth' : 'error')); }
  }
  function problem(code, tip, q) {
    const msg = code === 'retake' ? (tip || (q === 'not_palm' ? t("That doesn't look like an open palm. Try again with your whole palm in the frame.", 'यह खुली हथेली नहीं लग रही। पूरी हथेली फ़्रेम में रखकर फिर कोशिश करें।') : t('The lines are hard to see. Try brighter light and hold steady.', 'रेखाएँ साफ़ नहीं दिख रहीं। ज़्यादा रोशनी में स्थिर रखकर फिर कोशिश करें।')))
      : code === 'limit' ? t("You've used today's camera readings. Read it step by step, or try tomorrow.", 'आज की कैमरा रीडिंग पूरी हो गईं। एक-एक कदम पढ़ें, या कल कोशिश करें।')
      : code === 'auth' ? t('Sign in to Brodoit to use the camera reader.', 'कैमरा रीडर के लिए Brodoit में साइन इन करें।')
      : t("The reader couldn't answer just now. Try again, or read it step by step.", 'रीडर अभी जवाब नहीं दे पाया। फिर कोशिश करें, या एक-एक कदम पढ़ें।');
    main.innerHTML = '<header class="ui-page-h"><h1>' + esc(t('Let\'s try again', 'फिर कोशिश करें')) + '</h1></header><p class="ax-note">' + ic('alert-triangle', 18) + '<span>' + esc(msg) + '</span></p>'
      + '<div class="ax-stack" style="margin-top:16px">' + (code === 'retake' || code === 'error' || code === 'no-vision' ? '<button type="button" class="ui-btn accent wide" id="re">' + esc(code === 'retake' ? t('Take another photo', 'दूसरी फ़ोटो लें') : t('Try again', 'फिर कोशिश करें')) + '</button>' : '')
      + '<button type="button" class="ui-btn sec wide" id="qz">' + esc(t('Read it myself, step by step', 'ख़ुद पढ़ें, एक-एक कदम')) + '</button></div>';
    const re = document.getElementById('re'); if (re) re.addEventListener('click', () => { if (code === 'retake') { AX.nav.replace('intro'); openCamera(); } else read(); });
    document.getElementById('qz').addEventListener('click', () => { S.answers = {}; AX.nav.replace('q', 0); });
  }

  // ── the self-guided reading ──
  function question(i) {
    const key = X.PALM_ORDER[i], Q = X.PALM[key], n = X.PALM_ORDER.length;
    if (!Q) { AX.nav.replace('intro'); return; }
    let h = '<div class="ax-prog" aria-hidden="true"><i style="width:' + Math.round(i / n * 100) + '%"></i></div>'
      + '<p class="ax-small">' + esc(t('Question ', 'सवाल ') + (i + 1) + t(' of ', ' / ') + n) + '</p>'
      + '<h2 style="font:var(--ui-t-title);margin:6px 0 14px">' + esc(tx(Q.q)) + '</h2><div class="ax-q">';
    for (const k in Q.opts) {
      const f = merge(BASE, S.answers, { [key]: k }), pic = FOCUS[key] ? palmSvg(f, { focus: FOCUS[key], cls: 'mini', label: tx(Q.opts[k].l) }) : '';
      h += '<button type="button" class="ax-opt' + (S.answers[key] === k ? ' on' : '') + '" data-k="' + esc(k) + '">' + pic + '<span>' + esc(tx(Q.opts[k].l)) + '</span></button>';
    }
    h += '</div><button type="button" class="ui-btn ghost wide" style="margin-top:14px" id="skip">' + esc(t('Not sure, skip', 'पक्का नहीं, छोड़ें')) + '</button>';
    main.innerHTML = h;
    const next = v => { if (v == null) delete S.answers[key]; else S.answers[key] = v; if (i + 1 < n) AX.nav.go('q', i + 1); else finishQuiz(); };
    main.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => next(b.dataset.k)));
    document.getElementById('skip').addEventListener('click', () => next(null));
  }
  function finishQuiz() {
    const reading = { at: Date.now(), hand: S.hand, source: 'self', features: Object.assign({}, S.answers), notes: {}, summary: '' };
    AX.set('astro.palm.v1', reading);
    AX.nav.stack = [AX.nav.stack[0]]; AX.nav.go('result', reading);
  }

  // ── the reading ──
  const ICONS = { nature: 'hand', heart: 'heart', mind: 'brain', life: 'activity', work: 'briefcase' };
  function result(r) {
    if (!r) { AX.nav.replace('intro'); return; }
    S.hand = r.hand || S.hand;
    const f = r.features || {}, notes = r.notes || {};
    let h = '<header class="ui-page-h"><h1>' + esc(t('Your palm reading', 'आपकी हस्तरेखा')) + '</h1></header>'
      + '<p class="ax-lead">' + esc((r.hand === 'left' ? t('Left hand', 'बायाँ हाथ') : t('Right hand', 'दायाँ हाथ')) + ' · ' + AX.fmtDate(new Date(r.at), { day: 'numeric', month: 'long', year: 'numeric' })) + '</p>';
    h += '<section class="ax-card">' + (r.thumb ? '<img class="ax-shot" style="max-height:220px;margin-bottom:12px" src="' + r.thumb + '" alt="">' : '') + palmSvg(merge(BASE, f)) + LEGEND()
      + (r.summary ? '<p class="ax-body" style="margin-top:12px">' + esc(r.summary) + '</p>' : '') + '</section>';
    for (const sct of X.PALM_SECTIONS) {
      const items = sct.keys.filter(k => f[k] && X.PALM[k].opts[f[k]]).map(k => '<p class="ax-body">' + esc(tx(X.PALM[k].opts[f[k]].m)) + '</p>' + (k === 'lifeArc' ? '<p class="ax-small" style="margin-top:4px">' + esc(tx(X.PALM.lifeArc.note)) + '</p>' : ''));
      const note = notes[sct.note];
      if (!items.length && !note) continue;
      h += '<section class="ax-card"><div class="ax-sec-t"><span class="ui-ic" style="--ui-accent:var(--g-palm)">' + ic(ICONS[sct.id], 20) + '</span><h2>' + esc(tx(sct.t)) + '</h2></div><div class="ax-stack">' + items.join('') + '</div>'
        + (note ? '<p class="ax-ai">' + esc(note) + '</p>' : '') + '</section>';
    }
    const missing = X.PALM_ORDER.filter(k => !f[k]);
    if (missing.length && missing.length <= 6) {
      const k = missing[0], Q = X.PALM[k];
      h += '<section class="ax-card"><h2>' + esc(t('Add what a photo can\'t show', 'जो फ़ोटो में नहीं दिखता, वह जोड़ें')) + '</h2><p class="ax-muted" style="margin-bottom:10px">' + esc(tx(Q.q)) + '</p><div class="ax-chips wrap">'
        + Object.keys(Q.opts).map(o => '<button type="button" class="ax-chip" data-add="' + k + '" data-v="' + o + '">' + esc(tx(Q.opts[o].l)) + '</button>').join('') + '</div></section>';
    }
    h += '<div class="ax-stack" style="margin-top:16px"><button type="button" class="ui-btn accent wide" id="share">' + ic('share', 18) + esc(t('Share my reading', 'रीडिंग शेयर करें')) + '</button>'
      + '<a class="ui-btn sec wide" href="/astro/kundli.html">' + esc(t('Now see my kundli', 'अब मेरी कुंडली देखें')) + '</a>'
      + '<button type="button" class="ui-btn ghost wide" id="new">' + esc(t('Read again', 'फिर से पढ़ें')) + '</button></div>' + AX.disclaimer();
    main.innerHTML = h;
    main.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      const nr = Object.assign({}, r, { features: Object.assign({}, f, { [b.dataset.add]: b.dataset.v }) });
      AX.set('astro.palm.v1', nr); AX.nav.replace('result', nr);
    }));
    document.getElementById('new').addEventListener('click', () => { AX.nav.stack = []; AX.nav.start('intro'); });
    document.getElementById('share').addEventListener('click', () => share(r));
  }
  function share(r) {
    const f = r.features || {}, lines = [t('My palm reading on Brodoit', 'Brodoit पर मेरी हस्तरेखा')];
    if (r.summary) lines.push(r.summary);
    for (const sct of X.PALM_SECTIONS) { const k = sct.keys.find(x => f[x]); if (k) lines.push(tx(sct.t) + ': ' + tx(X.PALM[k].opts[f[k]].m)); }
    lines.push('https://brodoit.com/astro/palm.html');
    const text = lines.join('\n\n');
    if (navigator.share) navigator.share({ title: t('My palm reading', 'मेरी हस्तरेखा'), text }).catch(() => { /* closed */ });
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => AX.toast(t('Copied', 'कॉपी हो गया'))).catch(() => { /* blocked */ });
  }

  AX.nav.render = v => { if (v.view !== 'camera') closeCamera(); if (v.view === 'preview') preview(); else if (v.view === 'q') question(v.arg || 0); else if (v.view === 'result') result(v.arg); else intro(); };
  AX.nav.start('intro');
  AX.api('/api/astro/status').then(s => { status = s; if ((AX.nav.cur() || {}).view === 'intro') intro(); }).catch(() => { status.vision = false; if ((AX.nav.cur() || {}).view === 'intro') intro(); });
})();
