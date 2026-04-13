require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const twilio = require('twilio');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ═══ DATABASE ═══
const db = new Database(path.join(__dirname, 'taskflow.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT DEFAULT '',
  priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'pending',
  due_date TEXT DEFAULT '', reminder_time TEXT DEFAULT '',
  reminded INTEGER DEFAULT 0, source TEXT DEFAULT 'app',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);`);

// ═══ TWILIO ═══
let tw = null;
const TW_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const MY_NUM = process.env.MY_WHATSAPP_NUMBER || '';
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio connected');
  } else console.log('⚠️ No Twilio — WhatsApp disabled');
} catch (e) { console.log('⚠️ Twilio error:', e.message); }

// ═══ HELPERS ═══
const genId = () => 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
const PRI = { high: '🔴', medium: '🟠', low: '🟢' };
const fmtD = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
const todayStr = () => new Date().toISOString().split('T')[0];

async function sendWA(body) {
  if (!tw || !MY_NUM) return { ok: false, reason: 'Twilio not configured' };
  try {
    const msg = await tw.messages.create({ from: TW_FROM, to: MY_NUM, body });
    return { ok: true, sid: msg.sid };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function parseIncoming(text) {
  const r = { title: text.trim(), priority: 'medium', dueDate: '', command: null };
  const low = text.toLowerCase().trim();
  if (/^(list|tasks|pending|show)$/i.test(low)) return { ...r, command: 'list' };
  if (/^(help|\?)$/i.test(low)) return { ...r, command: 'help' };
  if (/^done\b/i.test(low)) return { ...r, command: 'done', title: low.replace(/^done\s*/i, '') };
  if (/^(delete|remove)\b/i.test(low)) return { ...r, command: 'delete', title: low.replace(/^(delete|remove)\s*/i, '') };
  if (/^(doing|start)\b/i.test(low)) return { ...r, command: 'doing', title: low.replace(/^(doing|start)\s*/i, '') };
  if (/\b(urgent|important|asap|critical|high priority)\b/i.test(low)) {
    r.priority = 'high'; r.title = r.title.replace(/\b(urgent|important|asap|critical|high priority)\b/gi, '');
  } else if (/\b(low priority|no rush|whenever)\b/i.test(low)) {
    r.priority = 'low'; r.title = r.title.replace(/\b(low priority|no rush|whenever)\b/gi, '');
  }
  if (/\btoday\b/i.test(low)) { r.dueDate = todayStr(); r.title = r.title.replace(/\btoday\b/gi, ''); }
  else if (/\btomorrow\b/i.test(low)) { const d = new Date(); d.setDate(d.getDate()+1); r.dueDate = d.toISOString().split('T')[0]; r.title = r.title.replace(/\btomorrow\b/gi, ''); }
  else if (/\bnext week\b/i.test(low)) { const d = new Date(); d.setDate(d.getDate()+7); r.dueDate = d.toISOString().split('T')[0]; r.title = r.title.replace(/\bnext week\b/gi, ''); }
  r.title = r.title.replace(/\s+/g, ' ').trim();
  return r;
}

// ═══ API ═══
app.get('/api/tasks', (_, res) => res.json(db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()));

app.post('/api/tasks', (req, res) => {
  const { title, notes, priority, status, due_date, reminder_time } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const id = genId();
  db.prepare('INSERT INTO tasks (id,title,notes,priority,status,due_date,reminder_time,source) VALUES (?,?,?,?,?,?,?,?)').run(id, title.trim(), notes||'', priority||'medium', status||'pending', due_date||'', reminder_time||'', 'app');
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});

app.put('/api/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { title, notes, priority, status, due_date, reminder_time } = req.body;
  db.prepare("UPDATE tasks SET title=?,notes=?,priority=?,status=?,due_date=?,reminder_time=?,reminded=0,updated_at=datetime('now') WHERE id=?")
    .run(title??t.title, notes??t.notes, priority??t.priority, status??t.status, due_date??t.due_date, reminder_time??t.reminder_time, req.params.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id));
});

app.delete('/api/tasks/:id', (req, res) => { db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.post('/api/send-task/:id', async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const p = PRI[t.priority]||'🟠';
  let msg = `📋 *Task Reminder*\n\n${p} *${t.title}*`;
  if (t.notes) msg += `\n${t.notes}`;
  if (t.due_date) msg += `\n📅 Due: ${fmtD(t.due_date)}`;
  msg += `\n\n_Reply "done ${t.title.slice(0,20)}" to complete_`;
  res.json(await sendWA(msg));
});

app.post('/api/send-all', async (req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks WHERE status!='done' ORDER BY priority DESC").all();
  if (!tasks.length) return res.json({ ok: true });
  let msg = `📋 *Pending Tasks (${tasks.length})*\n`;
  tasks.forEach((t, i) => { msg += `\n${i+1}. ${PRI[t.priority]} ${t.title}${t.due_date?' _('+fmtD(t.due_date)+')_':''}`; });
  msg += `\n\n_Reply "done <task>" to complete_`;
  res.json(await sendWA(msg));
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', twilio: !!tw, tasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c }));

// ═══ WHATSAPP WEBHOOK ═══
app.post('/api/webhook/whatsapp', async (req, res) => {
  const body = req.body.Body || '', from = req.body.From || '';
  console.log(`📨 WA from ${from}: ${body}`);
  const parsed = parseIncoming(body);
  const twiml = new twilio.twiml.MessagingResponse();

  if (parsed.command === 'help') {
    twiml.message(`🤖 *TaskFlow Commands*\n\n📝 Just type a task to add it\n   Ex: "Buy groceries tomorrow urgent"\n\n📋 "list" — see all tasks\n✅ "done buy groceries" — mark done\n🔄 "doing fix bug" — mark in progress\n🗑️ "delete buy groceries" — remove\n\n_Priority: add "urgent" or "low priority"_\n_Dates: "today", "tomorrow", "next week"_`);
  } else if (parsed.command === 'list') {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status!='done' ORDER BY priority DESC").all();
    if (!tasks.length) twiml.message("✨ No pending tasks!");
    else { let m = `📋 *Pending (${tasks.length})*\n`; tasks.forEach((t,i) => { m += `\n${i+1}. ${PRI[t.priority]} ${t.title}${t.status==='in-progress'?' 🔄':''}${t.due_date?' _('+fmtD(t.due_date)+')_':''}`; }); twiml.message(m); }
  } else if (parsed.command === 'done') {
    const t = db.prepare("SELECT * FROM tasks WHERE status!='done' AND LOWER(title) LIKE ? ORDER BY created_at DESC").get(`%${parsed.title}%`);
    if (t) { db.prepare("UPDATE tasks SET status='done',updated_at=datetime('now') WHERE id=?").run(t.id); twiml.message(`✅ Done: *${t.title}* 🎉`); }
    else twiml.message(`❌ No task matching "${parsed.title}"\nType "list" to see tasks`);
  } else if (parsed.command === 'doing') {
    const t = db.prepare("SELECT * FROM tasks WHERE status='pending' AND LOWER(title) LIKE ?").get(`%${parsed.title}%`);
    if (t) { db.prepare("UPDATE tasks SET status='in-progress',updated_at=datetime('now') WHERE id=?").run(t.id); twiml.message(`🔄 Started: *${t.title}*`); }
    else twiml.message(`❌ No pending task matching "${parsed.title}"`);
  } else if (parsed.command === 'delete') {
    const t = db.prepare("SELECT * FROM tasks WHERE LOWER(title) LIKE ?").get(`%${parsed.title}%`);
    if (t) { db.prepare('DELETE FROM tasks WHERE id=?').run(t.id); twiml.message(`🗑️ Deleted: *${t.title}*`); }
    else twiml.message(`❌ No task matching "${parsed.title}"`);
  } else if (parsed.title) {
    const id = genId();
    db.prepare("INSERT INTO tasks (id,title,priority,due_date,source) VALUES (?,?,?,?,'whatsapp')").run(id, parsed.title, parsed.priority, parsed.dueDate);
    let m = `✅ *Added!*\n\n${PRI[parsed.priority]} ${parsed.title}`;
    if (parsed.dueDate) m += `\n📅 Due: ${fmtD(parsed.dueDate)}`;
    m += `\n\nType "list" to see all tasks`;
    twiml.message(m);
  } else twiml.message('Type "help" for commands');
  res.type('text/xml').send(twiml.toString());
});

// ═══ REMINDERS (every 60s) ═══
setInterval(async () => {
  const now = new Date(), nd = todayStr();
  const nt = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const due = db.prepare("SELECT * FROM tasks WHERE status!='done' AND due_date=? AND reminder_time=? AND reminded=0").all(nd, nt);
  for (const t of due) {
    await sendWA(`⏰ *Reminder*\n\n${PRI[t.priority]} *${t.title}*${t.notes?'\n'+t.notes:''}${t.due_date?'\n📅 '+fmtD(t.due_date):''}\n\n_Reply "done ${t.title.slice(0,20)}" to complete_`);
    db.prepare('UPDATE tasks SET reminded=1 WHERE id=?').run(t.id);
  }
}, 60000);

// ═══ FRONTEND (embedded) ═══
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#1A1816">
<title>TaskFlow</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:'DM Sans',sans-serif;background:#F5F2ED;color:#2D2A26;min-height:100vh}
button{cursor:pointer;border:none;background:none;font-family:inherit;color:inherit}
input,textarea,select{font-family:inherit;border:1.5px solid #DDD8D1;border-radius:10px;padding:11px;font-size:15px;background:#F5F2ED;width:100%;color:#2D2A26}
input:focus,textarea:focus{outline:none;border-color:#2D2A26}textarea{resize:vertical;min-height:56px}
select{-webkit-appearance:none;appearance:none}
.app{max-width:480px;margin:0 auto;padding:16px 16px 100px}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.logo{font-family:'Space Mono',monospace;font-size:24px;font-weight:700}
.hdr-st{font-size:11px;font-weight:700;padding:6px 10px;border-radius:8px;background:#FFFDF9;border:1px solid #E8E4DD;display:flex;align-items:center;gap:5px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:14px}
.st{background:#FFFDF9;border-radius:12px;padding:10px 4px;text-align:center;border:1px solid #E8E4DD}
.st b{font-family:'Space Mono',monospace;font-size:20px;display:block}
.st small{font-size:9px;color:#9C968D;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.al{border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:10px;text-align:center}
.srch{margin-bottom:12px}.srch input{background:#FFFDF9}
.flt{display:flex;gap:5px;margin-bottom:14px;overflow-x:auto}
.fb{padding:6px 14px;border-radius:20px;border:1px solid #E8E4DD;background:#FFFDF9;font-size:12px;font-weight:600;color:#6B665E;white-space:nowrap}
.fb.on{background:#2D2A26;color:#F5F2ED;border-color:#2D2A26}
.bwa{width:100%;padding:10px;border-radius:10px;border:1px solid #25D366;background:#EDFCF2;color:#1A9E47;font-size:13px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px}
.tc{background:#FFFDF9;border-radius:12px;padding:12px;border:1px solid #E8E4DD;border-left:4px solid;margin-bottom:8px}
.tc.dn{opacity:.5}
.tc-top{display:flex;gap:10px;align-items:flex-start}
.chk{width:22px;height:22px;min-width:22px;border-radius:6px;border:2px solid #DDD8D1;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent}
.chk.on{background:#3DAE5C;border-color:#3DAE5C}
.tc-t{font-size:15px;font-weight:600;line-height:1.35;word-break:break-word}
.tc-t.dn{text-decoration:line-through;color:#9C968D}
.tc-n{font-size:13px;color:#6B665E;margin-top:2px}
.tc-m{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;align-items:center}
.badge{padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase}
.tc-acts{display:flex;justify-content:flex-end;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid #F0EDEA}
.ib{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#9C968D}
.ib:active{background:#F5F2ED;transform:scale(.9)}
.fab{position:fixed;bottom:22px;right:22px;width:56px;height:56px;border-radius:50%;background:#2D2A26;color:#F5F2ED;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,.3);z-index:50;font-size:28px}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:100}
.mdl{background:#FFFDF9;border-radius:18px 18px 0 0;padding:20px 18px 32px;width:100%;max-width:480px;max-height:85vh;overflow-y:auto}
.mdl h2{font-family:'Space Mono',monospace;font-size:18px;margin-bottom:14px}
.lbl{font-size:11px;font-weight:700;color:#9C968D;margin:12px 0 4px;display:block;text-transform:uppercase;letter-spacing:.5px}
.row{display:flex;gap:10px}.row>div{flex:1}
.macts{display:flex;gap:10px;margin-top:18px}
.mb{flex:1;padding:12px;border-radius:10px;font-size:15px;font-weight:600;text-align:center}
.mb-c{border:1.5px solid #DDD8D1;color:#6B665E}.mb-s{background:#2D2A26;color:#F5F2ED}.mb-d{background:#E8453C;color:#fff;margin-top:10px;width:100%}
.empty{text-align:center;padding:40px 20px;color:#9C968D}
.toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.08);border:1px solid;background:#F2FBF4;border-color:#B7E8C4;color:#2D8A4E}
.vc{text-align:center;margin-bottom:10px}
.vc button{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:30px;border:2px solid #DDD8D1;background:#F5F2ED;font-size:13px;color:#6B665E}
.vc button.on{border-color:#E8453C;background:#FEF1F0;color:#E8453C}
</style>
</head>
<body>
<div class="app" id="app"></div>
<script>
let S={tasks:[],view:'all',search:'',showAdd:false,editing:null,listening:false,vt:'',toast:null,waOk:false,sending:{},form:{title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'}};
let rec=null;
const api=async(p,o={})=>{try{const r=await fetch('/api'+p,{headers:{'Content-Type':'application/json'},...o});return await r.json()}catch(e){return null}};
const P={high:{c:'#E8453C',d:'\\u{1F534}'},medium:{c:'#E8912C',d:'\\u{1F7E0}'},low:{c:'#3DAE5C',d:'\\u{1F7E2}'}};
const ST={pending:{l:'To Do',c:'#7A756E',bg:'#F0EDEA'},'in-progress':{l:'Doing',c:'#3B82F6',bg:'#EFF6FF'},done:{l:'Done',c:'#3DAE5C',bg:'#F2FBF4'}};
const fD=d=>d?new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const fT=t=>{if(!t)return'';const[h,m]=t.split(':');const hr=+h;return(hr>12?hr-12:hr||12)+':'+m+' '+(hr>=12?'PM':'AM')};
const isOD=(d,s)=>d&&s!=='done'&&new Date(d+'T00:00:00')<new Date(new Date().setHours(0,0,0,0));
const isTd=d=>d===new Date().toISOString().split('T')[0];
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function toast(m){S.toast=m;render();setTimeout(()=>{S.toast=null;render()},2500)}
const WI='<svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

async function load(){const t=await api('/tasks');if(t){S.tasks=t;render()}}
async function chk(){const h=await api('/health');if(h)S.waOk=h.twilio;render()}
async function addT(){if(!S.form.title.trim())return;const r=await api('/tasks',{method:'POST',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:'pending',due_date:S.form.dueDate,reminder_time:S.form.reminderTime})});if(r?.id){S.tasks.unshift(r);clM();toast('\\u2705 Task added!')}}
async function savE(){if(!S.form.title.trim()||!S.editing)return;const r=await api('/tasks/'+S.editing,{method:'PUT',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:S.form.status,due_date:S.form.dueDate,reminder_time:S.form.reminderTime})});if(r){const i=S.tasks.findIndex(t=>t.id===S.editing);if(i>-1)S.tasks[i]=r;clM();toast('\\u2705 Updated!')}}
async function del(id){await api('/tasks/'+id,{method:'DELETE'});S.tasks=S.tasks.filter(t=>t.id!==id);render()}
async function tog(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:t.status==='done'?'pending':'done'})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function cyc(id){const o=['pending','in-progress','done'],t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:o[(o.indexOf(t.status)+1)%3]})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function sWA(id){S.sending[id]=1;render();const r=await api('/send-task/'+id,{method:'POST'});delete S.sending[id];toast(r?.ok?'\\u{1F4F1} Sent to WhatsApp!':'\\u26A0\\uFE0F Failed');render()}
async function sAll(){S.sending._a=1;render();const r=await api('/send-all',{method:'POST'});delete S.sending._a;toast(r?.ok?'\\u{1F4F1} All sent!':'\\u26A0\\uFE0F Failed');render()}
function opA(){S.form={title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'};S.vt='';S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
function opE(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;S.form={title:t.title,notes:t.notes||'',priority:t.priority,dueDate:t.due_date||'',reminderTime:t.reminder_time||'',status:t.status};S.editing=id;S.showAdd=true;render()}
function clM(){S.showAdd=false;S.editing=null;S.vt='';render()}
function stV(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return;rec=new SR();rec.continuous=false;rec.interimResults=true;rec.lang='en-US';rec.onresult=e=>{let t='';for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;S.vt=t;if(e.results[0].isFinal){S.form.title=t;const l=t.toLowerCase();if(/urgent|important|asap/.test(l))S.form.priority='high';if(/\\btoday\\b/.test(l))S.form.dueDate=new Date().toISOString().split('T')[0];else if(/\\btomorrow\\b/.test(l)){const d=new Date();d.setDate(d.getDate()+1);S.form.dueDate=d.toISOString().split('T')[0]}}render()};rec.onend=()=>{S.listening=false;render()};rec.start();S.listening=true;render()}

function render(){
const ts=S.tasks;
const f=ts.filter(t=>{if(S.search){const q=S.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||'').toLowerCase().includes(q))return false}if(S.view==='all')return true;if(S.view==='today')return isTd(t.due_date);if(S.view==='overdue')return isOD(t.due_date,t.status);return t.status===S.view});
const s={total:ts.length,pend:ts.filter(t=>t.status==='pending').length,act:ts.filter(t=>t.status==='in-progress').length,dn:ts.filter(t=>t.status==='done').length,od:ts.filter(t=>isOD(t.due_date,t.status)).length};
let h='<div class="hdr"><div><div class="logo">TaskFlow</div><div style="font-size:12px;color:#9C968D;margin-top:1px">'+new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div></div><div class="hdr-st"><span class="dot" style="background:'+(S.waOk?'#3DAE5C':'#D4D0CA')+'"></span>'+(S.waOk?'WA ON':'WA OFF')+'</div></div>';
if(S.waOk)h+='<div class="al" style="background:#EDFCF2;border:1px solid #B7E8C4;color:#1A9E47">\\u{1F4F1} WhatsApp connected \\u2014 send & receive tasks via chat</div>';
h+='<div class="stats">'+[{l:'Total',v:s.total,c:'#2D2A26'},{l:'To Do',v:s.pend,c:'#7A756E'},{l:'Active',v:s.act,c:'#3B82F6'},{l:'Done',v:s.dn,c:'#3DAE5C'}].map(x=>'<div class="st"><b style="color:'+x.c+'">'+x.v+'</b><small>'+x.l+'</small></div>').join('')+'</div>';
if(s.od>0)h+='<div class="al" style="background:#FEF1F0;border:1px solid #F5C6C2;color:#E8453C;cursor:pointer" onclick="S.view=\\'overdue\\';render()">\\u26A0\\uFE0F '+s.od+' overdue</div>';
h+='<div class="srch"><input placeholder="Search tasks..." value="'+esc(S.search)+'" oninput="S.search=this.value;render()"></div>';
h+='<div class="flt">'+[{k:'all',l:'All'},{k:'pending',l:'To Do'},{k:'in-progress',l:'Doing'},{k:'done',l:'Done'},{k:'today',l:'Today'}].map(x=>'<button class="fb'+(S.view===x.k?' on':'')+'" onclick="S.view=\\''+x.k+'\\';render()">'+x.l+'</button>').join('')+'</div>';
if((s.pend+s.act)>0&&S.waOk)h+='<button class="bwa'+(S.sending._a?' style=opacity:.5':'')+ '" onclick="sAll()">'+WI+(S.sending._a?' Sending...':' Send all pending to WhatsApp')+'</button>';
h+='<div>';
if(!f.length){h+='<div class="empty"><div style="font-size:36px;margin-bottom:8px">'+(S.search?'\\u{1F50D}':'\\u2728')+'</div><div style="font-size:15px;font-weight:600">'+(S.search?'No matches':'No tasks yet')+'</div>'+(S.search?'':'<div style="font-size:13px;margin-top:4px">Tap + to add, or send via WhatsApp</div>')+'</div>'}
else f.forEach(t=>{
const p=P[t.priority]||P.medium,st=ST[t.status]||ST.pending,d=t.status==='done';
h+='<div class="tc'+(d?' dn':'')+'" style="border-left-color:'+p.c+'"><div class="tc-top"><button class="chk'+(d?' on':'')+'" onclick="tog(\\''+t.id+'\\')">'+(d?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':'')+'</button><div style="flex:1;min-width:0"><div class="tc-t'+(d?' dn':'')+'">'+esc(t.title)+'</div>'+(t.notes?'<div class="tc-n">'+esc(t.notes)+'</div>':'')+'<div class="tc-m"><button class="badge" style="background:'+st.bg+';color:'+st.c+'" onclick="cyc(\\''+t.id+'\\')">'+st.l+'</button>'+(t.due_date?'<span style="font-size:12px;font-weight:500;color:'+(isOD(t.due_date,t.status)?'#E8453C':isTd(t.due_date)?'#E8912C':'#9C968D')+'">\\u{1F4C5} '+fD(t.due_date)+(isOD(t.due_date,t.status)?' overdue':'')+'</span>':'')+(t.reminder_time&&!d?'<span style="font-size:11px;color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>':'')+(t.source==='whatsapp'?'<span style="font-size:10px;color:#C4BFB7;font-weight:600">via WhatsApp</span>':'')+'</div></div></div>';
h+='<div class="tc-acts"><button class="ib" onclick="opE(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="ib'+(S.sending[t.id]?' style=opacity:.3':'')+'" onclick="sWA(\\''+t.id+'\\')">'+WI+'</button><button class="ib" style="color:#E8453C" onclick="del(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div></div>';
});
h+='</div>';
h+='<button class="fab" onclick="opA()">+</button>';
if(S.toast)h+='<div class="toast">'+S.toast+'</div>';
if(S.showAdd){const isE=!!S.editing;
h+='<div class="ov" onclick="clM()"><div class="mdl" onclick="event.stopPropagation()"><h2>'+(isE?'Edit Task':'New Task')+'</h2>';
h+='<div class="vc"><button class="'+(S.listening?'on':'')+'" onclick="'+(S.listening?'rec&&rec.stop();S.listening=false;render()':'stV()')+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="'+(S.listening?'#E8453C':'#6B665E')+'" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> '+(S.listening?'Listening...':'Tap to speak')+'</button></div>';
h+='<div style="height:1px;background:#E8E4DD;margin:10px 0 14px"></div>';
h+='<label class="lbl">Task</label><input id="ft" value="'+esc(S.form.title)+'" placeholder="What needs to be done?" oninput="S.form.title=this.value">';
h+='<label class="lbl">Notes</label><textarea oninput="S.form.notes=this.value" placeholder="Details...">'+esc(S.form.notes)+'</textarea>';
h+='<div class="row"><div><label class="lbl">Priority</label><select onchange="S.form.priority=this.value"><option value="high"'+(S.form.priority==='high'?' selected':'')+'>High</option><option value="medium"'+(S.form.priority==='medium'?' selected':'')+'>Medium</option><option value="low"'+(S.form.priority==='low'?' selected':'')+'>Low</option></select></div>';
h+='<div><label class="lbl">Due Date</label><input type="date" value="'+S.form.dueDate+'" onchange="S.form.dueDate=this.value"></div></div>';
h+='<label class="lbl">Reminder</label><input type="time" value="'+S.form.reminderTime+'" onchange="S.form.reminderTime=this.value">';
h+='<div style="font-size:11px;color:#C4BFB7;margin-top:3px">'+(S.waOk?'Auto-sends WhatsApp reminder':'Set time for reminder')+'</div>';
if(isE)h+='<label class="lbl">Status</label><select onchange="S.form.status=this.value"><option value="pending"'+(S.form.status==='pending'?' selected':'')+'>To Do</option><option value="in-progress"'+(S.form.status==='in-progress'?' selected':'')+'>Doing</option><option value="done"'+(S.form.status==='done'?' selected':'')+'>Done</option></select>';
h+='<div class="macts"><button class="mb mb-c" onclick="clM()">Cancel</button><button class="mb mb-s" onclick="'+(isE?'savE()':'addT()')+'">'+(isE?'Update':'Add Task')+'</button></div>';
if(isE)h+='<button class="mb mb-d" onclick="del(\\''+S.editing+'\\');clM()">Delete</button>';
h+='</div></div>';}
document.getElementById('app').innerHTML=h;
}
load();chk();setInterval(load,10000);
</script>
</body>
</html>`;

app.get('/', (_, res) => res.type('html').send(HTML));
app.get('*', (_, res) => res.type('html').send(HTML));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\\n\\u{1F680} TaskFlow on port ' + PORT);
  console.log('\\u{1F4F1} WhatsApp: ' + (tw ? 'Connected' : 'Not configured'));
  console.log('\\u{1F4BE} Tasks: ' + db.prepare('SELECT COUNT(*) as c FROM tasks').get().c + '\\n');
});
