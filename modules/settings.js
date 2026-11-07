// App settings — API keys and voice names pasted from You → Admin live in the app's own database
// (table app_settings on the persistent volume) and take effect immediately; Railway env vars stay
// the fallback. Only the whitelisted keys below are ever stored; getSetting() for any other key
// simply reads process.env so callers can treat it as the single source of truth.
'use strict';

// Every name the modules read through getSetting must be here, or reads fall through to env and saves throw — that is how
// pasted Gemini/Groq keys and Bro's ElevenLabs agent id were silently lost before.
const KEYS = [
  'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY',
  'OPENAI_REALTIME_VOICE', 'OPENAI_CHAT_MODEL', 'OPENAI_TTS_VOICE', 'OPENAI_TTS_VOICE_NATIVE',
  'ELEVEN_VOICE_EN', 'ELEVEN_VOICE_HI', 'ELEVEN_VOICE_ES', 'ELEVEN_VOICE_FR', 'ELEVEN_VOICE_DE', 'ELEVEN_VOICE_JA',
  'ELEVEN_AGENT_ID', 'ELEVEN_AGENT_HASH', 'ELEVEN_AGENT_LLM', 'ELEVEN_AGENT_TTS',
  'GEMINI_MODEL', 'GEMINI_LITE_MODEL', 'GEMINI_TTS_MODEL', 'GEMINI_TTS_VOICE', 'GEMINI_TTS_VOICE_NATIVE', 'GEMINI_TTS_VOICE_BRO',
  'BULK_VOICE', 'STUDIO_VOICE', 'NEWS_VOICE_FULL', 'NEWS_VOICE_PROVIDER', 'BULLETIN_AUDIO',
  'ELEVEN_BRAIN_ID', 'ELEVEN_BRAIN_HASH', 'ELEVEN_BRAIN_LLM',
  'BRO_VOICE', // Bro's ElevenLabs voice pick (Admin) — was missing, so saving it threw
  // v16 Bro Core: the model Bro thinks on, the next one to try at night, the old-provider switch ('on'|'off'),
  // the Kokoro voice per language (JSON, written by the nightly tuner) and the synthesis thread count
  'BROCORE_MODEL', 'BROCORE_MODEL_NEXT', 'BROCORE_EMERGENCY', 'BRO_VOICE_SPECS', 'BROCORE_THREADS',
  // v16 live calls (modules/voice.js): the call-token secret (generated once) and the ElevenLabs/Realtime emergency switch;
  // v16 optional GPU voice (modules/brocore/gpu.js, RunPod)
  'BROCORE_CALL_SECRET', 'BROCORE_EMERGENCY_ELEVEN', 'BROCORE_GPU', 'BROCORE_GPU_IMAGE', 'RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID',
  // v18 Bro's own brain (modules/brocore/mind.js): on/off, which model ('auto' | 'big' | 'small'), and how long a live
  // turn waits for its first sentence before the cloud answers (ms)
  'BRO_OWN_BRAIN', 'BRO_OWN_MODEL', 'BRO_OWN_BUDGET_MS',
  // v19 Google Play (modules/play.js): the service account key that uploads each build, and the testing tracks
  'PLAY_SERVICE_ACCOUNT_JSON', 'PLAY_TRACKS', 'PLAY_SERVICE_ACCOUNT_EMAIL',
  // v39 the closed test's extra tester groups (x@googlegroups.com, comma-separated), added to config/play.json's
  'PLAY_TESTER_GROUPS',
  // v20 Bro's voice style on our CPU (modules/brocore/voice.js STYLES): energetic (default) | bright | deep
  'BRO_VOICE_STYLE',
];

// "sk-…k9Qz" — enough to recognise a key, never enough to use it.
function maskKey(v) {
  v = String(v == null ? '' : v);
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  return v.slice(0, 3) + '…' + v.slice(-4);
}

function install(db) {
  db.exec("CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '',updated_at TEXT DEFAULT(datetime('now')))");
  const qGet = db.prepare('SELECT value FROM app_settings WHERE key=?');
  const qPut = db.prepare("INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,datetime('now'))");
  const qDel = db.prepare('DELETE FROM app_settings WHERE key=?');

  function appValue(k) {
    if (!KEYS.includes(k)) return '';
    try { const r = qGet.get(k); return r && r.value ? String(r.value) : ''; } catch (e) { return ''; }
  }
  // Value the app should use right now: pasted-in-app first, env second, '' when neither.
  function getSetting(k) {
    k = String(k || '');
    return appValue(k) || process.env[k] || '';
  }
  // Where the current value comes from: 'app' | 'env' | null.
  function settingSource(k) {
    k = String(k || '');
    if (appValue(k)) return 'app';
    if (process.env[k]) return 'env';
    return null;
  }
  // Store (or, with an empty value, remove) a whitelisted key. Returns the new source.
  function setSetting(k, v) {
    k = String(k || '');
    if (!KEYS.includes(k)) throw new Error('unknown setting ' + k);
    v = String(v == null ? '' : v).trim();
    if (!v) qDel.run(k); else qPut.run(k, v);
    return settingSource(k);
  }
  // When the in-app value was last saved (ms since epoch), 0 when none — lets sealed settings skip values the owner changed later.
  const qAt = db.prepare('SELECT updated_at FROM app_settings WHERE key=?');
  function settingUpdatedAt(k) { try { const r = qAt.get(String(k || '')); return r && r.updated_at ? Date.parse(String(r.updated_at).replace(' ', 'T') + 'Z') || 0 : 0; } catch (e) { return 0; } }
  return { getSetting, setSetting, settingSource, settingUpdatedAt, maskKey, KEYS };
}

module.exports = { install, maskKey, KEYS };
