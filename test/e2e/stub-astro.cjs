// Preloaded into the Jyotish test server (node -r): every outside host answers 404 (stub-fetch.cjs), except a palm
// reading asked of Gemini, which gets a fixed reading. A photo under 3,000 base64 characters is "not a palm"; one
// feature comes back with a value outside the allowed list, which the server must drop.
'use strict';
require('./stub-fetch.cjs');
const before = global.fetch;
global.fetch = async function (url, opts) {
  const u = String(url && url.url || url);
  if (/generativelanguage\.googleapis\.com/.test(u) && opts && /PALM_READER/.test(String(opts.body || ''))) {
    let size = 0; try { const b = JSON.parse(opts.body); size = String(((b.contents[0].parts[1] || {}).inlineData || {}).data || '').length; } catch (e) { size = 0; }
    const hi = /Hindi \(Devanagari/.test(String(opts.body));
    const reading = size < 3000
      ? { is_palm: false, quality: 'not_palm', retake_tip: hi ? 'पूरी हथेली दिखाएँ।' : 'Show your whole open palm.', features: {}, notes: {}, summary: '' }
      : {
        is_palm: true, quality: 'good', retake_tip: '',
        features: { shape: 'water', heartEnd: 'jupiter', heartShape: 'curved', headLen: 'long', headSlope: 'steep', headStart: 'separate', lifeArc: 'wide', lifeMarks: 'double', fate: 'faint', sun: 'clear', bonds: '2', mount: 'apollo', thumb: null, fingers: 'banana' },
        notes: hi
          ? { overall: 'लंबी हथेली और लंबी उँगलियाँ दिखती हैं।', heart: 'हृदय रेखा गहरी है और तर्जनी तक जाती है।', head: 'मस्तिष्क रेखा नीचे की ओर झुकती है।', life: 'जीवन रेखा चौड़ा घेरा बनाती है।', fate: 'भाग्य रेखा हल्की है।' }
          : { overall: 'A long palm with long, slender fingers.', heart: 'Your heart line is deep and sweeps up to the index finger.', head: 'The head line slopes well down towards the wrist.', life: 'The life line makes a wide arc with a sister line beside it.', fate: 'A faint fate line rises from the wrist.' },
        summary: hi ? 'आपकी हथेली एक संवेदनशील और रचनात्मक मन दिखाती है।' : 'Your palm shows a sensitive, creative mind with a warm and loyal heart.',
      };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reading) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return before(url, opts);
};
