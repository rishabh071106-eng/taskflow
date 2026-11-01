// Preloaded into the test server (node -r): every outside host answers 404 at once (no network in tests);
// localhost passes through. (Rebuilt after a container restart; the earlier v20 stub also faked Groq/Google streams.)
'use strict';
const realFetch = global.fetch;
global.fetch = async function (url, opts) {
  const u = String(url && url.url || url); let host = '';
  try { host = new URL(u).hostname; } catch (e) { /* relative */ }
  if (host === '127.0.0.1' || host === 'localhost') return realFetch(url, opts);
  return new Response(JSON.stringify({ error: 'stubbed in tests' }), { status: 404, headers: { 'content-type': 'application/json' } });
};
