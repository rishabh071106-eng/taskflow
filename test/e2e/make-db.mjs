// Prints the path of a template test database: the real server's schema (it boots once on an empty file) plus two
// signed-in users (tokens tokR and tokK). Built once per checkout into /tmp and reused.
import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process'; import { createRequire } from 'module';
const HERE = path.dirname(new URL(import.meta.url).pathname), ROOT = path.resolve(HERE, '..', '..');
const DB = '/tmp/brodoit-e2e-template.db';
if (!fs.existsSync(DB)) {
  const media = fs.mkdtempSync('/tmp/brodoit-e2e-media-'); const PORT = 3290;
  const env = Object.assign({}, process.env, { DB_PATH: DB, MEDIA_DIR: media, PORT: String(PORT), NEWS_DESK: '0', BROCORE_VOICE: '0', BROCORE_NIGHTLY: '0', BRO_OWN_BRAIN: 'off', ADMIN_AUTO_RECORD: '0', LEARN_WARM: '0', BRO_LIBRARY: '0', BOOK_VOICE_DELAY_MS: '999999999' });
  const child = spawn(process.execPath, ['-r', HERE + '/stub-fetch.cjs', 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let up = false; for (let i = 0; i < 120 && !up; i++) { await new Promise(r => setTimeout(r, 500)); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (e) {} }
  child.kill(); await new Promise(r => setTimeout(r, 500));
  if (!up) { console.error('the server did not boot'); process.exit(1); }
  const Database = createRequire(ROOT + '/package.json')('better-sqlite3'); const d = new Database(DB);
  d.prepare("INSERT OR REPLACE INTO users(phone,name,token,email,created_at) VALUES('+919000000001','Riya','tokR','riya@example.com','2026-01-01 00:00:00')").run();
  d.prepare("INSERT OR REPLACE INTO users(phone,name,token,email,created_at) VALUES('+919000000002','Kabir','tokK','kabir@example.com','2026-01-02 00:00:00')").run();
  d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
}
console.log(DB);
