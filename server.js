require('dotenv').config();
const express=require('express'),cors=require('cors'),Database=require('better-sqlite3'),twilio=require('twilio'),path=require('path'),crypto=require('crypto');
const app=express();app.use(cors());app.use(express.json());app.use(express.urlencoded({extended:true}));

const db=new Database(path.join(__dirname,'taskflow.db'));db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY,name TEXT DEFAULT'',token TEXT,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_phone TEXT NOT NULL,title TEXT NOT NULL,notes TEXT DEFAULT'',priority TEXT DEFAULT'medium',status TEXT DEFAULT'pending',due_date TEXT DEFAULT'',reminder_time TEXT DEFAULT'',reminded INTEGER DEFAULT 0,source TEXT DEFAULT'app',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT,expires_at TEXT);`);
// email column + unique index (idempotent)
try{db.exec("ALTER TABLE users ADD COLUMN email TEXT")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email!=''")}catch(e){}

let tw=null;const TW_FROM=process.env.TWILIO_WHATSAPP_FROM||'whatsapp:+14155238886';
try{if(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN){tw=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);console.log('✅ Twilio connected')}}catch(e){console.log('⚠️',e.message)}

const genId=()=>'t_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
const genToken=()=>crypto.randomBytes(32).toString('hex');
const genOTP=()=>String(Math.floor(100000+Math.random()*900000));
const PRI={high:'🔴',medium:'🟠',low:'🟢'};
const fmtD=d=>d?new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const todayStr=()=>new Date().toISOString().split('T')[0];
const cleanPhone=p=>{let c=(p||'').replace(/[^0-9+]/g,'');if(!c.startsWith('+'))c='+'+c;return c};

async function sendWA(to,body){
  if(!tw)return{ok:false};
  try{const n=to.startsWith('whatsapp:')?to:'whatsapp:'+to;const m=await tw.messages.create({from:TW_FROM,to:n,body});return{ok:true}}catch(e){return{ok:false,reason:e.message}}
}

// Email via Resend (free tier: 3000/mo, 100/day)
const EMAIL_FROM=process.env.EMAIL_FROM||'Brodoit <onboarding@resend.dev>';
async function sendEmail(to,subject,html){
  if(!process.env.RESEND_API_KEY)return{ok:false,reason:'RESEND_API_KEY not set'};
  try{
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:EMAIL_FROM,to:[to],subject,html})});
    if(!r.ok){const err=await r.text();return{ok:false,reason:err}}
    return{ok:true}
  }catch(e){return{ok:false,reason:e.message}}
}
const isEmail=s=>/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i.test(s||'');

// Simple per-identifier rate limiter (max 3 requests per 10 min)
const _otpAttempts=new Map();
function rateLimited(identifier){
  const now=Date.now();
  const list=(_otpAttempts.get(identifier)||[]).filter(t=>now-t<10*60*1000);
  if(list.length>=3)return true;
  list.push(now);_otpAttempts.set(identifier,list);
  return false;
}

function auth(req,res,next){
  const t=req.headers['x-token'];if(!t)return res.status(401).json({error:'Login required'});
  const u=db.prepare('SELECT * FROM users WHERE token=?').get(t);if(!u)return res.status(401).json({error:'Invalid token'});
  req.user=u;next();
}

// ═══ OTP AUTH ═══
app.post('/api/send-otp',async(req,res)=>{
  const phone=cleanPhone(req.body.phone);
  if(phone.length<10)return res.status(400).json({error:'Invalid phone number'});
  if(rateLimited('wa:'+phone))return res.status(429).json({error:'Too many requests. Try again in 10 minutes.'});
  const code=genOTP();
  const expires=new Date(Date.now()+5*60*1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at)VALUES(?,?,?)').run(phone,code,expires);
  const r=await sendWA(phone,`🔐 Your Brodoit verification code is: *${code}*\n\nThis code expires in 5 minutes.\nDo not share this code with anyone.`);
  if(r.ok)res.json({ok:true,message:'OTP sent to your WhatsApp'});
  else res.status(500).json({ok:false,error:'Failed to send OTP. Make sure you have joined the Twilio WhatsApp sandbox first.',detail:r.reason});
});

// Email OTP
app.post('/api/send-otp-email',async(req,res)=>{
  const email=(req.body.email||'').trim().toLowerCase();
  if(!isEmail(email))return res.status(400).json({error:'Invalid email address'});
  if(rateLimited('em:'+email))return res.status(429).json({error:'Too many requests. Try again in 10 minutes.'});
  const code=genOTP();
  const expires=new Date(Date.now()+5*60*1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at)VALUES(?,?,?)').run('em:'+email,code,expires);
  const html=`<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#F5F2ED;border-radius:16px">
    <div style="text-align:center"><h1 style="font-family:monospace;font-size:30px;margin:0;color:#2D2A26">Bro<span style="color:#3DAE5C">Do</span>it</h1></div>
    <h2 style="font-size:18px;margin:24px 0 8px;color:#2D2A26">Your verification code</h2>
    <p style="color:#6B665E;font-size:14px;line-height:1.5">Use this 6-digit code to sign in:</p>
    <div style="background:#fff;border:2px dashed #3DAE5C;border-radius:12px;padding:20px;text-align:center;font-family:monospace;font-size:40px;font-weight:700;letter-spacing:8px;color:#2D2A26;margin:16px 0">${code}</div>
    <p style="color:#9C968D;font-size:13px">This code expires in 5 minutes. If you didn't request it, ignore this email.</p>
    <hr style="border:none;border-top:1px solid #E8E4DD;margin:24px 0">
    <p style="color:#9C968D;font-size:11px;text-align:center">Brodoit — Tasks, Books &amp; Wisdom in one place.</p>
  </div>`;
  const r=await sendEmail(email,'Your Brodoit code: '+code,html);
  if(r.ok)res.json({ok:true,message:'Check your email (and spam folder)'});
  else res.status(500).json({ok:false,error:'Failed to send email',detail:r.reason});
});

app.post('/api/verify-otp-email',(req,res)=>{
  const email=(req.body.email||'').trim().toLowerCase();
  const code=req.body.code,name=req.body.name||'';
  if(!isEmail(email))return res.status(400).json({error:'Invalid email'});
  const key='em:'+email;
  const otp=db.prepare('SELECT * FROM otps WHERE phone=?').get(key);
  if(!otp)return res.status(400).json({error:'No OTP sent. Request a new one.'});
  if(new Date(otp.expires_at)<new Date()){db.prepare('DELETE FROM otps WHERE phone=?').run(key);return res.status(400).json({error:'OTP expired. Request a new one.'})}
  if(otp.code!==code)return res.status(400).json({error:'Wrong code. Try again.'});
  db.prepare('DELETE FROM otps WHERE phone=?').run(key);
  let user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const token=genToken();
  if(!user){db.prepare('INSERT INTO users(phone,name,email,token)VALUES(?,?,?,?)').run(key,name,email,token);user={phone:key,name,email,token}}
  else{db.prepare('UPDATE users SET token=?,name=COALESCE(NULLIF(?,\'\'),name)WHERE email=?').run(token,name,email);user.token=token;if(name)user.name=name}
  res.json({phone:user.phone,name:user.name||name,email,token});
});

app.post('/api/verify-otp',(req,res)=>{
  const phone=cleanPhone(req.body.phone),code=req.body.code,name=req.body.name||'';
  const otp=db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
  if(!otp)return res.status(400).json({error:'No OTP sent to this number. Request a new one.'});
  if(new Date(otp.expires_at)<new Date()){db.prepare('DELETE FROM otps WHERE phone=?').run(phone);return res.status(400).json({error:'OTP expired. Request a new one.'})}
  if(otp.code!==code)return res.status(400).json({error:'Wrong code. Try again.'});
  db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
  let user=db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  const token=genToken();
  if(!user){db.prepare('INSERT INTO users(phone,name,token)VALUES(?,?,?)').run(phone,name,token);user={phone,name,token}}
  else{db.prepare('UPDATE users SET token=?,name=COALESCE(NULLIF(?,\'\'),name)WHERE phone=?').run(token,name,phone);user.token=token;if(name)user.name=name}
  res.json({phone:user.phone,name:user.name||name,token});
});

// ═══ TASKS API ═══
app.get('/api/tasks',auth,(req,res)=>{res.json(db.prepare('SELECT * FROM tasks WHERE user_phone=? ORDER BY created_at DESC').all(req.user.phone))});
app.post('/api/tasks',auth,async(req,res)=>{
  const{title,notes,priority,status,due_date,reminder_time}=req.body;if(!title?.trim())return res.status(400).json({error:'Title required'});
  const id=genId();db.prepare('INSERT INTO tasks(id,user_phone,title,notes,priority,status,due_date,reminder_time,source)VALUES(?,?,?,?,?,?,?,?,?)').run(id,req.user.phone,title.trim(),notes||'',priority||'medium',status||'pending',due_date||'',reminder_time||'','app');
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});
app.put('/api/tasks/:id',auth,(req,res)=>{
  const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_phone=?').get(req.params.id,req.user.phone);if(!t)return res.status(404).json({error:'Not found'});
  const{title,notes,priority,status,due_date,reminder_time}=req.body;
  db.prepare("UPDATE tasks SET title=?,notes=?,priority=?,status=?,due_date=?,reminder_time=?,reminded=0,updated_at=datetime('now')WHERE id=?").run(title??t.title,notes??t.notes,priority??t.priority,status??t.status,due_date??t.due_date,reminder_time??t.reminder_time,req.params.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id));
});
app.delete('/api/tasks/:id',auth,(req,res)=>{db.prepare('DELETE FROM tasks WHERE id=? AND user_phone=?').run(req.params.id,req.user.phone);res.json({ok:true})});
app.post('/api/send-task/:id',auth,async(req,res)=>{
  const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_phone=?').get(req.params.id,req.user.phone);if(!t)return res.status(404).json({error:'Not found'});
  let msg=`📋 *Task Reminder*\n\n${PRI[t.priority]||'🟠'} *${t.title}*`;if(t.notes)msg+='\n'+t.notes;if(t.due_date)msg+='\n📅 Due: '+fmtD(t.due_date);
  msg+='\n\n_Reply "done '+t.title.slice(0,20)+'" to complete_';res.json(await sendWA(req.user.phone,msg));
});
app.post('/api/send-all',auth,async(req,res)=>{
  const tasks=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' ORDER BY priority DESC").all(req.user.phone);if(!tasks.length)return res.json({ok:true});
  let msg='📋 *Pending Tasks ('+tasks.length+')*\n';tasks.forEach((t,i)=>{msg+='\n'+(i+1)+'. '+PRI[t.priority]+' '+t.title+(t.due_date?' _('+fmtD(t.due_date)+')_':'')});
  msg+='\n\n_Reply "done <task>" to complete_';res.json(await sendWA(req.user.phone,msg));
});
app.get('/api/health',(_,res)=>res.json({status:'ok',twilio:!!tw,email:!!process.env.RESEND_API_KEY,users:db.prepare('SELECT COUNT(*)as c FROM users').get().c,tasks:db.prepare('SELECT COUNT(*)as c FROM tasks').get().c}));

// ═══ PROFILE (/api/me) ═══
app.get('/api/me',auth,(req,res)=>{
  const u=db.prepare('SELECT phone,name,created_at FROM users WHERE phone=?').get(req.user.phone);
  res.json(u||{error:'not found'});
});
app.put('/api/me',auth,(req,res)=>{
  const name=(req.body.name||'').trim();
  if(!name)return res.status(400).json({error:'Name required'});
  db.prepare('UPDATE users SET name=? WHERE phone=?').run(name,req.user.phone);
  res.json({phone:req.user.phone,name});
});

// ═══ WHATSAPP WEBHOOK ═══
function parseIn(text){const r={title:text.trim(),priority:'medium',dueDate:'',command:null};const l=text.toLowerCase().trim();
if(/^(list|tasks|pending|show)$/i.test(l))return{...r,command:'list'};if(/^(help|\?)$/i.test(l))return{...r,command:'help'};
if(/^done\b/i.test(l))return{...r,command:'done',title:l.replace(/^done\s*/i,'')};if(/^(delete|remove)\b/i.test(l))return{...r,command:'delete',title:l.replace(/^(delete|remove)\s*/i,'')};
if(/^(doing|start)\b/i.test(l))return{...r,command:'doing',title:l.replace(/^(doing|start)\s*/i,'')};
if(/\b(urgent|important|asap|high priority)\b/i.test(l)){r.priority='high';r.title=r.title.replace(/\b(urgent|important|asap|high priority)\b/gi,'')}
if(/\btoday\b/i.test(l)){r.dueDate=todayStr();r.title=r.title.replace(/\btoday\b/gi,'')}
else if(/\btomorrow\b/i.test(l)){const d=new Date();d.setDate(d.getDate()+1);r.dueDate=d.toISOString().split('T')[0];r.title=r.title.replace(/\btomorrow\b/gi,'')}
r.title=r.title.replace(/\s+/g,' ').trim();return r}

app.post('/api/webhook/whatsapp',async(req,res)=>{
  const body=req.body.Body||'',from=req.body.From||'',phone=from.replace('whatsapp:','');
  let user=db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if(!user){const tk=genToken();db.prepare('INSERT INTO users(phone,token)VALUES(?,?)').run(phone,tk);user={phone,token:tk}}
  const p=parseIn(body);const twiml=new twilio.twiml.MessagingResponse();
  if(p.command==='help')twiml.message('🤖 *Brodoit*\n\n📝 Type task to add\n📋 "list" — your tasks\n✅ "done <task>" — complete\n🔄 "doing <task>" — start\n🗑️ "delete <task>" — remove\n\n🌐 App: https://brodoit.com');
  else if(p.command==='list'){const ts=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' ORDER BY priority DESC").all(phone);if(!ts.length)twiml.message('✨ No pending tasks!');else{let m='📋 *Your Tasks ('+ts.length+')*\n';ts.forEach((t,i)=>m+='\n'+(i+1)+'. '+PRI[t.priority]+' '+t.title+(t.due_date?' _('+fmtD(t.due_date)+')_':''));twiml.message(m)}}
  else if(p.command==='done'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' AND LOWER(title) LIKE ?").get(phone,'%'+p.title+'%');if(t){db.prepare("UPDATE tasks SET status='done',updated_at=datetime('now')WHERE id=?").run(t.id);twiml.message('✅ Done: *'+t.title+'* 🎉')}else twiml.message('❌ No task matching "'+p.title+'"')}
  else if(p.command==='doing'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status='pending' AND LOWER(title) LIKE ?").get(phone,'%'+p.title+'%');if(t){db.prepare("UPDATE tasks SET status='in-progress',updated_at=datetime('now')WHERE id=?").run(t.id);twiml.message('🔄 Started: *'+t.title+'*')}else twiml.message('❌ Not found')}
  else if(p.command==='delete'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND LOWER(title) LIKE ?").get(phone,'%'+p.title+'%');if(t){db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);twiml.message('🗑️ Deleted: *'+t.title+'*')}else twiml.message('❌ Not found')}
  else if(p.title){const id=genId();db.prepare("INSERT INTO tasks(id,user_phone,title,priority,due_date,source)VALUES(?,?,?,?,?,'whatsapp')").run(id,phone,p.title,p.priority,p.dueDate);let m='✅ *Added!*\n\n'+PRI[p.priority]+' '+p.title;if(p.dueDate)m+='\n📅 '+fmtD(p.dueDate);twiml.message(m)}
  else twiml.message('Type "help" for commands');
  res.type('text/xml').send(twiml.toString());
});

// ═══ REMINDERS ═══
setInterval(async()=>{const now=new Date(),nd=todayStr(),nt=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
const due=db.prepare("SELECT * FROM tasks WHERE status!='done' AND due_date=? AND reminder_time=? AND reminded=0").all(nd,nt);
for(const t of due){await sendWA(t.user_phone,'⏰ *Reminder*\n\n'+PRI[t.priority]+' *'+t.title+'*'+(t.notes?'\n'+t.notes:'')+(t.due_date?'\n📅 '+fmtD(t.due_date):'')+'\n\n_Reply "done '+t.title.slice(0,20)+'" to complete_');db.prepare('UPDATE tasks SET reminded=1 WHERE id=?').run(t.id)}
},60000);

// ═══ FRONTEND ═══
const HTML=`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#1A1816"><link rel="manifest" href="/manifest.json"><title>Brodoit</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:'DM Sans',sans-serif;background:#F5F2ED;color:#2D2A26;min-height:100vh}
button{cursor:pointer;border:none;background:none;font-family:inherit;color:inherit}
input,textarea,select{font-family:inherit;border:1.5px solid #DDD8D1;border-radius:10px;padding:11px;font-size:15px;background:#F5F2ED;width:100%;color:#2D2A26}
input:focus,textarea:focus{outline:none;border-color:#2D2A26}textarea{resize:vertical;min-height:56px}select{-webkit-appearance:none;appearance:none}
.app{max-width:480px;margin:0 auto;padding:16px 16px 100px}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.logo{font-family:'Space Mono',monospace;font-size:26px;font-weight:700;letter-spacing:-.5px}.logo .k{color:#3DAE5C}
.hdr-st{font-size:11px;font-weight:700;padding:6px 10px;border-radius:8px;background:#FFFDF9;border:1px solid #E8E4DD;display:flex;align-items:center;gap:5px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.moral{display:flex;align-items:center;gap:10px;background:linear-gradient(135deg,#FFFDF9,#F0EBE3);border:1px solid #E8E4DD;border-radius:14px;padding:11px 13px;margin-bottom:12px;position:relative;overflow:hidden;animation:slideIn .4s ease}
.moral::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:linear-gradient(180deg,#E8912C,#3DAE5C)}
.moral-emoji{font-size:20px;flex-shrink:0}.moral-body{flex:1;min-width:0}
.moral-lbl{font-size:9px;font-weight:700;color:#9C968D;text-transform:uppercase;letter-spacing:1px}
.moral-txt{font-size:13px;line-height:1.4;color:#2D2A26;font-weight:500;margin-top:1px}
.moral-by{font-size:11px;color:#7A756E;margin-top:2px;font-style:italic}
.moral-ref{width:28px;height:28px;border-radius:50%;background:#F5F2ED;color:#6B665E;font-size:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid #E8E4DD;transition:transform .2s}
.moral-ref:hover{transform:rotate(180deg);background:#2D2A26;color:#F5F2ED}
@keyframes slideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.tabs{display:flex;gap:4px;background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:4px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:1 0 auto;padding:9px 10px;border-radius:9px;font-size:11px;font-weight:600;color:#6B665E;transition:all .15s;white-space:nowrap}
.tab.on{background:#2D2A26;color:#F5F2ED;box-shadow:0 2px 6px rgba(0,0,0,.15)}
/* Calendar */
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:0 4px}
.cal-head h3{font-family:'Space Mono',monospace;font-size:17px;font-weight:700}
.cal-nav{width:34px;height:34px;border-radius:50%;background:#FFFDF9;border:1px solid #E8E4DD;color:#2D2A26;font-size:16px;transition:background .15s;display:inline-flex;align-items:center;justify-content:center}
.cal-nav:hover{background:#2D2A26;color:#F5F2ED}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:10px;margin-bottom:12px}
.cal-dow{font-size:10px;color:#9C968D;text-align:center;padding:4px 0;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.cal-day{aspect-ratio:1;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:13px;font-weight:600;cursor:pointer;background:transparent;border:1.5px solid transparent;color:#2D2A26;position:relative;transition:all .15s}
.cal-day:hover{background:#F5F2ED;border-color:#DDD8D1}
.cal-day.other{color:#C4BFB7}
.cal-day.today{background:#EDFCF2;color:#1A9E47;border-color:#B7E8C4;font-weight:800}
.cal-day.sel{background:#2D2A26!important;color:#F5F2ED!important;border-color:#2D2A26!important}
.cal-day .ind{display:flex;gap:2px;margin-top:2px;align-items:center;height:5px}
.cal-day .ind i{width:4px;height:4px;border-radius:50%;display:inline-block}
.cal-selected-box{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:14px;margin-bottom:12px}
.cal-selected-box h4{font-family:'Space Mono',monospace;font-size:15px;margin-bottom:8px}
.cal-selected-box .muted{font-size:12px;color:#9C968D;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:14px}
.st{background:#FFFDF9;border-radius:12px;padding:10px 4px;text-align:center;border:1px solid #E8E4DD}.st b{font-family:'Space Mono',monospace;font-size:20px;display:block}.st small{font-size:9px;color:#9C968D;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.al{border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:10px;text-align:center}
.srch{margin-bottom:12px}.srch input{background:#FFFDF9}
.flt{display:flex;gap:5px;margin-bottom:14px;overflow-x:auto}.fb{padding:6px 14px;border-radius:20px;border:1px solid #E8E4DD;background:#FFFDF9;font-size:12px;font-weight:600;color:#6B665E;white-space:nowrap}.fb.on{background:#2D2A26;color:#F5F2ED;border-color:#2D2A26}
.bwa{width:100%;padding:10px;border-radius:10px;border:1px solid #25D366;background:#EDFCF2;color:#1A9E47;font-size:13px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px}
.tc{background:#FFFDF9;border-radius:12px;padding:12px;border:1px solid #E8E4DD;border-left:4px solid;margin-bottom:8px}.tc.dn{opacity:.5}
.tc-top{display:flex;gap:10px;align-items:flex-start}.chk{width:22px;height:22px;min-width:22px;border-radius:6px;border:2px solid #DDD8D1;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent}.chk.on{background:#3DAE5C;border-color:#3DAE5C}
.tc-t{font-size:15px;font-weight:600;line-height:1.35;word-break:break-word}.tc-t.dn{text-decoration:line-through;color:#9C968D}
.tc-n{font-size:13px;color:#6B665E;margin-top:2px}.tc-m{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;align-items:center}
.badge{padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase}
.tc-acts{display:flex;justify-content:flex-end;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid #F0EDEA}
.ib{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#9C968D}.ib:active{background:#F5F2ED;transform:scale(.9)}
.fab{position:fixed;bottom:22px;right:22px;width:56px;height:56px;border-radius:50%;background:#2D2A26;color:#F5F2ED;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,.3);z-index:50;font-size:28px}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:100}
.mdl{background:#FFFDF9;border-radius:18px 18px 0 0;padding:20px 18px 32px;width:100%;max-width:480px;max-height:85vh;overflow-y:auto}
.mdl h2{font-family:'Space Mono',monospace;font-size:18px;margin-bottom:14px}
.lbl{font-size:11px;font-weight:700;color:#9C968D;margin:12px 0 4px;display:block;text-transform:uppercase;letter-spacing:.5px}
.row{display:flex;gap:10px}.row>div{flex:1}.macts{display:flex;gap:10px;margin-top:18px}
.mb{flex:1;padding:12px;border-radius:10px;font-size:15px;font-weight:600;text-align:center}.mb-c{border:1.5px solid #DDD8D1;color:#6B665E}.mb-s{background:#2D2A26;color:#F5F2ED}.mb-d{background:#E8453C;color:#fff;margin-top:10px;width:100%}
.empty{text-align:center;padding:40px 20px;color:#9C968D}
.loading{text-align:center;padding:30px;color:#9C968D;font-size:13px}
.toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.08);border:1px solid}
.toast-ok{background:#F2FBF4;border-color:#B7E8C4;color:#2D8A4E}.toast-err{background:#FEF1F0;border-color:#F5C6C2;color:#E8453C}
.login{max-width:400px;margin:0 auto;padding:50px 24px;text-align:center}
.login-logo{font-family:'Space Mono',monospace;font-size:32px;font-weight:700;margin-bottom:6px}.login-logo .k{color:#3DAE5C}
.login-sub{font-size:14px;color:#6B665E;margin-bottom:28px;line-height:1.5}
.login input{margin-bottom:12px;text-align:center;font-size:18px;letter-spacing:1px;padding:14px}
.login-btn{width:100%;padding:14px;font-size:16px;border-radius:12px;font-weight:700;background:#2D2A26;color:#F5F2ED;border:none;margin-top:4px}
.login-btn:disabled{opacity:.5}.login-btn.sec{background:transparent;border:1.5px solid #DDD8D1;color:#6B665E;margin-top:8px}
.login-hint{font-size:12px;color:#9C968D;margin-top:16px;line-height:1.5}
.otp-inputs{display:flex;gap:8px;justify-content:center;margin:16px 0}
.otp-inputs input{width:44px;height:52px;text-align:center;font-size:22px;font-family:'Space Mono',monospace;font-weight:700;padding:0;border-radius:10px}
.user-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#FFFDF9;border:1px solid #E8E4DD;border-radius:8px;margin-bottom:12px;font-size:13px}
.user-bar button{font-size:12px;color:#E8453C;font-weight:600}
.step-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}.step-dot{width:8px;height:8px;border-radius:50%;background:#DDD8D1}.step-dot.on{background:#2D2A26}
.voice-lg{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:30px;border:2px solid #DDD8D1;background:#F5F2ED;font-size:13px;color:#6B665E;font-weight:600;transition:all .2s}
.voice-lg.rec{border-color:#E8453C;background:#FEF1F0;color:#E8453C;animation:recPulse 1.5s infinite}
@keyframes recPulse{0%{box-shadow:0 0 0 0 rgba(232,69,60,.4)}70%{box-shadow:0 0 0 10px rgba(232,69,60,0)}100%{box-shadow:0 0 0 0 rgba(232,69,60,0)}}
.vw{display:inline-flex;gap:2px;align-items:center}.vw span{width:3px;background:currentColor;border-radius:2px;animation:wave 1s infinite ease}
.vw span:nth-child(1){height:6px}.vw span:nth-child(2){height:12px;animation-delay:.1s}.vw span:nth-child(3){height:8px;animation-delay:.2s}.vw span:nth-child(4){height:14px;animation-delay:.3s}
@keyframes wave{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1)}}
.book-list{display:grid;gap:10px}
.book-card{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:12px;display:flex;gap:12px;align-items:flex-start;transition:transform .15s}
.book-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.book-cover{width:56px;height:78px;border-radius:6px;background:linear-gradient(135deg,#E8912C,#3DAE5C);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:10px;padding:4px;text-align:center}
.book-cover img{width:100%;height:100%;object-fit:cover}
.book-info{flex:1;min-width:0}.book-title{font-size:14px;font-weight:700;line-height:1.3;margin-bottom:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.book-author{font-size:12px;color:#6B665E;margin-bottom:6px}
.book-meta{font-size:11px;color:#9C968D;display:flex;gap:8px;flex-wrap:wrap}
.book-play{width:36px;height:36px;border-radius:50%;background:#2D2A26;color:#F5F2ED;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:center;transition:transform .15s}
.book-play:hover{transform:scale(1.08);background:#3DAE5C}
.player{position:fixed;bottom:0;left:0;right:0;background:#2D2A26;color:#F5F2ED;padding:10px 14px;box-shadow:0 -4px 20px rgba(0,0,0,.3);display:none;z-index:80}
.player.on{display:flex;align-items:center;gap:10px}
.player-info{flex:1;min-width:0}.player-title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player-author{font-size:11px;color:#9C968D}
.player audio{height:36px;max-width:220px}.player-close{padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.1);font-size:11px;font-weight:600;color:#fff}
.guide-card{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:14px;margin-bottom:10px;border-left:4px solid #3DAE5C}
.guide-card h3{font-size:14px;font-weight:700;margin-bottom:6px;color:#2D2A26;display:flex;align-items:center;gap:8px}
.guide-card h3 .num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:#3DAE5C;color:#fff;border-radius:50%;font-size:12px;font-family:'Space Mono',monospace}
.guide-card p{font-size:13px;line-height:1.55;color:#4A453E;margin-bottom:6px}
.guide-card code{background:#F0EBE3;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#E8453C}
.guide-card ul{margin-left:18px;margin-top:4px}.guide-card li{font-size:12px;line-height:1.55;color:#4A453E;margin-bottom:3px}
.callout{background:#FEFBEE;border:1px solid #F0DDA0;border-radius:10px;padding:10px 12px;margin:8px 0;font-size:12px;line-height:1.5}
.callout b{color:#B8860B}
/* animated gradient background blobs */
.bg-blob{position:fixed;border-radius:50%;filter:blur(70px);opacity:.38;pointer-events:none;z-index:0;animation:float 20s ease-in-out infinite}
.bg-blob.a{width:340px;height:340px;background:#E8912C;top:8%;left:-90px}
.bg-blob.b{width:300px;height:300px;background:#3DAE5C;top:55%;right:-70px;animation-delay:-7s}
.bg-blob.c{width:240px;height:240px;background:#7C3AED;bottom:-60px;left:35%;animation-delay:-14s;opacity:.22}
.bg-blob.d{width:180px;height:180px;background:#E8453C;top:30%;left:40%;animation-delay:-4s;opacity:.15}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(50px,-40px) scale(1.12)}66%{transform:translate(-40px,30px) scale(.92)}}
.app{position:relative;z-index:1}
/* staggered card appearance */
.tc,.book-card{animation:cardIn .4s ease both}
.tc:nth-child(1),.book-card:nth-child(1){animation-delay:.04s}.tc:nth-child(2),.book-card:nth-child(2){animation-delay:.08s}
.tc:nth-child(3),.book-card:nth-child(3){animation-delay:.12s}.tc:nth-child(4),.book-card:nth-child(4){animation-delay:.16s}
.tc:nth-child(5),.book-card:nth-child(5){animation-delay:.2s}.tc:nth-child(6),.book-card:nth-child(6){animation-delay:.24s}
@keyframes cardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
/* page transition */
.page-t{animation:pageIn .32s ease}
@keyframes pageIn{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
/* FAB subtle pulse */
.fab{animation:fabPulse 3.2s ease-in-out infinite;transition:transform .15s}
.fab:hover{transform:scale(1.08)}
@keyframes fabPulse{0%,100%{box-shadow:0 4px 20px rgba(0,0,0,.3)}50%{box-shadow:0 4px 28px rgba(61,174,92,.45),0 4px 20px rgba(0,0,0,.3)}}
/* moral chip hover lift */
.moral{transition:transform .2s,box-shadow .2s}.moral:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(0,0,0,.08)}
/* stats cards hover */
.st{transition:transform .15s}.st:hover{transform:translateY(-2px)}
/* tab shine effect */
.tab{position:relative;overflow:hidden}
.tab.on::before{content:'';position:absolute;top:0;left:-50%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent);animation:shine 2.5s ease-in-out infinite}
@keyframes shine{0%{left:-50%}100%{left:150%}}
/* login hero */
.hero{width:220px;height:160px;margin:0 auto 18px;display:block;animation:heroIn .8s ease}
@keyframes heroIn{from{opacity:0;transform:scale(.85) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
/* login screen background accent */
.login{position:relative}
.login::before{content:'';position:absolute;top:-40px;left:50%;transform:translateX(-50%);width:240px;height:240px;background:radial-gradient(circle,rgba(61,174,92,.15),transparent 70%);z-index:-1;animation:glow 4s ease-in-out infinite alternate}
@keyframes glow{from{transform:translateX(-50%) scale(1);opacity:.5}to{transform:translateX(-50%) scale(1.15);opacity:.8}}
/* checkbox toggle satisfying pop */
.chk.on{animation:chkPop .25s ease}
@keyframes chkPop{0%{transform:scale(1)}50%{transform:scale(1.3)}100%{transform:scale(1)}}
/* book cover shimmer */
.book-cover{position:relative}
.book-cover::after{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.25) 50%,transparent 60%);animation:shimmer 3s infinite}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
/* smooth scrollbar */
*::-webkit-scrollbar{width:6px;height:6px}*::-webkit-scrollbar-thumb{background:#DDD8D1;border-radius:3px}*::-webkit-scrollbar-track{background:transparent}
/* Inline Add Task button */
.add-bar{background:linear-gradient(135deg,#2D2A26,#4A453E);color:#F5F2ED;padding:14px 16px;border-radius:14px;display:flex;align-items:center;gap:12px;margin-bottom:14px;cursor:pointer;transition:transform .15s,box-shadow .15s;border:none;width:100%;font-family:inherit}
.add-bar:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(45,42,38,.25)}
.add-bar .plus{width:34px;height:34px;border-radius:50%;background:#3DAE5C;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0}
.add-bar .txt{flex:1;text-align:left}
.add-bar .txt b{display:block;font-size:14px;font-weight:700}
.add-bar .txt small{display:block;font-size:11px;color:#9C968D;margin-top:1px}
/* Dashboard */
.dash-hero{background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#F5F2ED;border-radius:16px;padding:18px;margin-bottom:14px;position:relative;overflow:hidden}
.dash-hero::before{content:'';position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:rgba(255,255,255,.08);border-radius:50%}
.dash-hero h2{font-family:'Space Mono',monospace;font-size:22px;margin-bottom:4px;position:relative;z-index:1}
.dash-hero p{font-size:13px;opacity:.9;position:relative;z-index:1}
.dash-hero .big{font-size:42px;font-weight:800;font-family:'Space Mono',monospace;margin-top:8px;position:relative;z-index:1}
.dash-hero .big small{font-size:14px;font-weight:500;opacity:.85;margin-left:6px}
.dash-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
.dash-card{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:12px}
.dash-card .lbl{font-size:10px;color:#9C968D;text-transform:uppercase;font-weight:700;letter-spacing:.5px}
.dash-card .v{font-family:'Space Mono',monospace;font-size:24px;font-weight:700;margin-top:4px}
.dash-card .sub{font-size:11px;color:#6B665E;margin-top:2px}
.ring{width:80px;height:80px;margin:0 auto;position:relative}
.ring svg{transform:rotate(-90deg)}
.ring .center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:18px;font-weight:700}
.prio-bars{display:flex;gap:4px;margin-top:8px;height:20px}
.prio-bars .b{flex:1;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700}
.insights{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.insight{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:12px;padding:12px 14px;border-left:4px solid #3DAE5C;font-size:13px;line-height:1.5;animation:cardIn .4s ease both}
.insight.warn{border-left-color:#E8912C;background:#FFF8EE}
.insight.alert{border-left-color:#E8453C;background:#FEF1F0}
.ai-badge{display:inline-block;font-size:9px;background:linear-gradient(135deg,#7C3AED,#3DAE5C);color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;letter-spacing:.5px;margin-right:6px;text-transform:uppercase}
/* Calculator */
.calc-screen{background:#2D2A26;color:#F5F2ED;border-radius:14px;padding:16px;margin-bottom:12px;text-align:right}
.calc-expr{font-family:'Space Mono',monospace;font-size:14px;color:#9C968D;min-height:18px;word-wrap:break-word;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.calc-result{font-family:'Space Mono',monospace;font-size:32px;font-weight:700;margin-top:6px;word-wrap:break-word;overflow-wrap:anywhere}
.calc-input-row{display:flex;gap:6px;margin-bottom:10px}
.calc-input-row input{flex:1;font-family:'Space Mono',monospace;font-size:14px}
.calc-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.calc-grid.sci{grid-template-columns:repeat(4,1fr)}
.ck{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:10px;padding:14px 6px;font-size:17px;font-weight:600;color:#2D2A26;transition:all .1s;font-family:'Space Mono',monospace}
.ck:active{background:#E8E4DD;transform:scale(.96)}
.ck.op{background:#E8912C;color:#fff;border-color:#E8912C}
.ck.eq{background:#3DAE5C;color:#fff;border-color:#3DAE5C}
.ck.sp{background:#E8453C;color:#fff;border-color:#E8453C}
.ck.sci{background:#7C3AED15;color:#7C3AED;border-color:#7C3AED40;font-size:13px}
.calc-tgl{display:flex;gap:6px;margin-bottom:10px}
.calc-tgl button{flex:1;padding:8px;border-radius:8px;font-size:12px;font-weight:600;background:#FFFDF9;border:1px solid #E8E4DD;color:#6B665E}
.calc-tgl button.on{background:#2D2A26;color:#F5F2ED;border-color:#2D2A26}
.calc-hist{background:#FFFDF9;border:1px solid #E8E4DD;border-radius:10px;padding:10px 12px;margin-top:10px;max-height:140px;overflow-y:auto}
.calc-hist h4{font-size:11px;color:#9C968D;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.calc-hist .hi{font-family:'Space Mono',monospace;font-size:12px;color:#6B665E;padding:4px 0;border-bottom:1px solid #F0EDEA;cursor:pointer}
.calc-hist .hi:hover{color:#2D2A26}
.calc-hist .hi b{color:#3DAE5C}
.smart-hint{background:#F0EBE3;border-radius:8px;padding:8px 12px;font-size:11px;color:#6B665E;margin-bottom:10px;line-height:1.5}
.smart-hint code{background:#fff;padding:1px 5px;border-radius:3px;color:#E8453C;font-family:ui-monospace,Menlo,monospace}
</style></head><body>
<div class="bg-blob a"></div><div class="bg-blob b"></div><div class="bg-blob c"></div><div class="bg-blob d"></div>
<div class="app" id="app"></div>
<script>
const MORALS=[{t:"The secret of getting ahead is getting started.",a:"Mark Twain"},{t:"It does not matter how slowly you go as long as you do not stop.",a:"Confucius"},{t:"Small daily improvements are the key to staggering long-term results.",a:"Robin Sharma"},{t:"Discipline is choosing between what you want now and what you want most.",a:"Abraham Lincoln"},{t:"Don't count the days. Make the days count.",a:"Muhammad Ali"},{t:"The best way to predict the future is to create it.",a:"Peter Drucker"},{t:"Focus on being productive instead of busy.",a:"Tim Ferriss"},{t:"You don't have to be great to start, but you have to start to be great.",a:"Zig Ziglar"},{t:"The journey of a thousand miles begins with a single step.",a:"Lao Tzu"},{t:"Either you run the day or the day runs you.",a:"Jim Rohn"},{t:"A year from now you may wish you had started today.",a:"Karen Lamb"},{t:"Success is the sum of small efforts repeated day in and day out.",a:"Robert Collier"},{t:"Done is better than perfect.",a:"Sheryl Sandberg"},{t:"The way to get started is to quit talking and begin doing.",a:"Walt Disney"},{t:"You cannot escape the responsibility of tomorrow by evading it today.",a:"Abraham Lincoln"},{t:"Motivation gets you going, but discipline keeps you growing.",a:"John C. Maxwell"},{t:"Do something today that your future self will thank you for.",a:"Sean Patrick Flanery"},{t:"The harder I work, the luckier I get.",a:"Samuel Goldwyn"},{t:"Don't watch the clock; do what it does. Keep going.",a:"Sam Levenson"},{t:"Great things never come from comfort zones.",a:"Neil Strauss"},{t:"Sometimes later becomes never. Do it now.",a:"Anonymous"},{t:"Wake up with determination. Go to bed with satisfaction.",a:"Anonymous"},{t:"A goal without a plan is just a wish.",a:"Antoine de Saint-Exupéry"},{t:"Little by little, day by day, what is meant for you will find its way.",a:"Anonymous"},{t:"Success doesn't just find you — you have to go out and get it.",a:"Anonymous"},{t:"Push yourself, because no one else is going to do it for you.",a:"Anonymous"},{t:"Dream big. Start small. Act now.",a:"Robin Sharma"},{t:"Hard work beats talent when talent doesn't work hard.",a:"Tim Notke"},{t:"The only impossible journey is the one you never begin.",a:"Tony Robbins"},{t:"Opportunities don't happen. You create them.",a:"Chris Grosser"}];
let S={tasks:[],view:'all',search:'',tab:'tasks',showAdd:false,editing:null,listening:false,toast:null,toastType:'ok',waOk:false,sending:{},user:null,
books:[],booksLoading:false,booksCat:'all',bookSearch:'',playing:null,moralIdx:Math.floor(Math.random()*MORALS.length),
calcExpr:'',calcResult:'0',calcHistory:[],calcSci:false,
calMonth:new Date(),calSelectedDate:new Date().toISOString().slice(0,10),
loginStep:'phone',loginMethod:'email',loginPhone:'',loginEmail:'',loginName:'',loginOTP:['','','','','',''],loginLoading:false,loginError:'',emailOk:false,
form:{title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'}};
let rec=null,token=localStorage.getItem('tf_token');
if(token){S.user={phone:localStorage.getItem('tf_phone'),name:localStorage.getItem('tf_name'),token}}

const api=async(p,o={})=>{try{const h={'Content-Type':'application/json'};if(token)h['x-token']=token;const r=await fetch('/api'+p,{headers:h,...o});if(r.status===401){logout();return null}return await r.json()}catch(e){return null}};
const P={high:{c:'#E8453C',d:'\\u{1F534}'},medium:{c:'#E8912C',d:'\\u{1F7E0}'},low:{c:'#3DAE5C',d:'\\u{1F7E2}'}};
const ST={pending:{l:'To Do',c:'#7A756E',bg:'#F0EDEA'},'in-progress':{l:'Doing',c:'#3B82F6',bg:'#EFF6FF'},done:{l:'Done',c:'#3DAE5C',bg:'#F2FBF4'}};
const fD=d=>d?new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const fT=t=>{if(!t)return'';const[h,m]=t.split(':');const hr=+h;return(hr>12?hr-12:hr||12)+':'+m+' '+(hr>=12?'PM':'AM')};
const isOD=(d,s)=>d&&s!=='done'&&new Date(d+'T00:00:00')<new Date(new Date().setHours(0,0,0,0));
const isTd=d=>d===new Date().toISOString().split('T')[0];
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function toast(m,t){S.toast=m;S.toastType=t||'ok';render();setTimeout(()=>{S.toast=null;render()},3000)}
const WI='<svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

async function sendOTP(){S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){const em=(S.loginEmail||'').trim().toLowerCase();if(!/^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$/i.test(em)){S.loginError='Enter a valid email address';S.loginLoading=false;render();return}url='/api/send-otp-email';body={email:em}}else{let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;if(ph.length<10){S.loginError='Enter valid phone with country code';S.loginLoading=false;render();return}url='/api/send-otp';body={phone:ph}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({ok:false,error:'Network error'}));S.loginLoading=false;if(r.ok){S.loginStep='otp';S.loginOTP=['','','','','',''];S.loginError='';render();setTimeout(()=>{const el=document.getElementById('otp0');if(el)el.focus()},100)}else{S.loginError=r.error||'Failed to send OTP';render()}}
async function verifyOTP(){const code=S.loginOTP.join('');if(code.length<6){S.loginError='Enter the 6-digit code';render();return}S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){url='/api/verify-otp-email';body={email:(S.loginEmail||'').trim().toLowerCase(),code,name:S.loginName}}else{let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;url='/api/verify-otp';body={phone:ph,code,name:S.loginName}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({error:'Network error'}));S.loginLoading=false;if(r.token){token=r.token;localStorage.setItem('tf_token',r.token);localStorage.setItem('tf_phone',r.phone);localStorage.setItem('tf_name',r.name||'');if(r.email)localStorage.setItem('tf_email',r.email);S.user=r;S.loginStep='phone';load();chk();toast('\\u2705 Welcome!')}else{S.loginError=r.error||'Verification failed';render()}}
function otpInput(i,v){S.loginOTP[i]=v.slice(-1);render();if(v&&i<5)setTimeout(()=>{const el=document.getElementById('otp'+(i+1));if(el)el.focus()},10)}
function otpKey(i,e){if(e.key==='Backspace'&&!S.loginOTP[i]&&i>0){S.loginOTP[i-1]='';render();setTimeout(()=>{const el=document.getElementById('otp'+(i-1));if(el)el.focus()},10)}}
function logout(){token=null;S.user=null;S.tasks=[];S.loginStep='phone';S.loginOTP=['','','','','',''];localStorage.removeItem('tf_token');localStorage.removeItem('tf_phone');localStorage.removeItem('tf_name');render()}
async function load(){const t=await api('/tasks');if(t){S.tasks=t;render()}}
async function chk(){const h=await api('/health');if(h)S.waOk=h.twilio;render()}
async function addT(){if(!S.form.title.trim())return;const r=await api('/tasks',{method:'POST',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:'pending',due_date:S.form.dueDate,reminder_time:S.form.reminderTime})});if(r?.id){S.tasks.unshift(r);clM();toast('\\u2705 Task added!')}}
async function savE(){if(!S.form.title.trim()||!S.editing)return;const r=await api('/tasks/'+S.editing,{method:'PUT',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:S.form.status,due_date:S.form.dueDate,reminder_time:S.form.reminderTime})});if(r){const i=S.tasks.findIndex(t=>t.id===S.editing);if(i>-1)S.tasks[i]=r;clM();toast('\\u2705 Updated!')}}
async function del(id){await api('/tasks/'+id,{method:'DELETE'});S.tasks=S.tasks.filter(t=>t.id!==id);render()}
async function tog(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:t.status==='done'?'pending':'done'})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function cyc(id){const o=['pending','in-progress','done'],t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:o[(o.indexOf(t.status)+1)%3]})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function sWA(id){S.sending[id]=1;render();const r=await api('/send-task/'+id,{method:'POST'});delete S.sending[id];toast(r?.ok?'\\u{1F4F1} Sent!':'\\u26A0\\uFE0F Failed',r?.ok?'ok':'err');render()}
async function sAll(){S.sending._a=1;render();const r=await api('/send-all',{method:'POST'});delete S.sending._a;toast(r?.ok?'\\u{1F4F1} All sent!':'\\u26A0\\uFE0F Failed',r?.ok?'ok':'err');render()}
function opA(){S.form={title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'};S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
function opE(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;S.form={title:t.title,notes:t.notes||'',priority:t.priority,dueDate:t.due_date||'',reminderTime:t.reminder_time||'',status:t.status};S.editing=id;S.showAdd=true;render()}
function clM(){S.showAdd=false;S.editing=null;if(rec)try{rec.stop()}catch(e){}S.listening=false;render()}
function stV(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){toast('\\u26A0\\uFE0F Voice not supported','err');return}rec=new SR();rec.continuous=false;rec.interimResults=true;rec.lang='en-US';rec.onresult=e=>{let t='';for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;if(e.results[0].isFinal){S.form.title=t;const l=t.toLowerCase();if(/urgent|important|asap/.test(l)){S.form.priority='high';S.form.title=S.form.title.replace(/urgent|important|asap/gi,'').trim()}if(/\\btoday\\b/.test(l))S.form.dueDate=new Date().toISOString().split('T')[0];else if(/\\btomorrow\\b/.test(l)){const d=new Date();d.setDate(d.getDate()+1);S.form.dueDate=d.toISOString().split('T')[0]}}else S.form.title=t;render()};rec.onend=()=>{S.listening=false;render()};rec.onerror=e=>{S.listening=false;toast('\\u26A0\\uFE0F '+e.error,'err');render()};rec.start();S.listening=true;render()}

function switchTab(t){S.tab=t;if(t==='books'&&!S.books.length)loadBooks('all');render()}
function calcAppend(v){S.calcExpr=(S.calcExpr||'')+v;calcEval();render()}
function calcClear(){S.calcExpr='';S.calcResult='0';render()}
function calcBack(){S.calcExpr=(S.calcExpr||'').slice(0,-1);calcEval();render()}
function calcEnter(){if(S.calcExpr&&S.calcResult!=='...'&&S.calcResult!=='0'){S.calcHistory=[{expr:S.calcExpr,result:S.calcResult},...(S.calcHistory||[])].slice(0,8);S.calcExpr=S.calcResult;calcEval()}render()}
function calcEval(){if(!S.calcExpr){S.calcResult='0';return}try{let e=S.calcExpr.replace(/\\u00D7/g,'*').replace(/\\u00F7/g,'/').replace(/\\u2212/g,'-');e=e.replace(/(\\d+\\.?\\d*)\\s*%\\s*of\\s*(\\d+\\.?\\d*)/gi,(_,a,b)=>'('+a+'/100)*'+b);e=e.replace(/(\\d+\\.?\\d*)%/g,'($1/100)');e=e.replace(/\\bsqrt\\b/g,'Math.sqrt').replace(/\\bsin\\b/g,'Math.sin').replace(/\\bcos\\b/g,'Math.cos').replace(/\\btan\\b/g,'Math.tan').replace(/\\blog\\b/g,'Math.log10').replace(/\\bln\\b/g,'Math.log').replace(/\\babs\\b/g,'Math.abs');e=e.replace(/\\bpi\\b/gi,'Math.PI').replace(/\\be\\b/g,'Math.E').replace(/\\^/g,'**');if(!/^[\\d\\s\\+\\-\\*\\/\\(\\)\\.,\\w]+$/.test(e))throw 0;const r=Function('"use strict";return ('+e+')')();if(isNaN(r)||!isFinite(r))throw 0;S.calcResult=String(+(+r).toFixed(10)).replace(/\\.?0+$/,'')||'0'}catch(e){S.calcResult='\\u2026'}}
function calcTyped(v){S.calcExpr=v;calcEval();render()}
async function openProfile(){S.showProfile=true;render();const me=await api('/me');if(me&&!me.error)S.profile=me;render()}
function closeProfile(){S.showProfile=false;render()}
async function saveName(){const n=(document.getElementById('pfName')||{}).value;if(!n||!n.trim())return;const r=await api('/me',{method:'PUT',body:JSON.stringify({name:n.trim()})});if(r&&r.name){S.user.name=r.name;localStorage.setItem('tf_name',r.name);S.profile=Object.assign(S.profile||{},{name:r.name});toast('\\u2705 Name updated');render()}}
async function refreshSession(){if(!token)return;const r=await api('/me');if(r&&!r.error){S.user={phone:r.phone,name:r.name,token};localStorage.setItem('tf_name',r.name||'');render()}else if(r&&r.error){logout()}}
function calPrev(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()-1);S.calMonth=d;render()}
function calNext(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()+1);S.calMonth=d;render()}
function calSelect(d){S.calSelectedDate=d;render()}
function calAddForDate(){S.form={title:'',notes:'',priority:'medium',dueDate:S.calSelectedDate||'',reminderTime:'',status:'pending'};S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
function rotateMoral(){S.moralIdx=(S.moralIdx+1)%MORALS.length;render()}
setInterval(()=>{if(S.user)rotateMoral()},45000);

async function loadBooks(cat){S.booksCat=cat;S.booksLoading=true;render();try{const q=cat==='all'?'collection:librivoxaudio AND mediatype:audio':'collection:librivoxaudio AND mediatype:audio AND subject:'+cat;const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=30&output=json&sort[]=downloads+desc';const r=await fetch(url);const j=await r.json();S.books=j.response.docs;}catch(e){S.books=[];toast('\\u26A0\\uFE0F Failed to load books','err')}S.booksLoading=false;render()}
async function playBook(id){const b=S.books.find(x=>x.identifier===id);if(!b){toast('\\u26A0\\uFE0F Book not found','err');return}const title=Array.isArray(b.title)?b.title[0]:b.title;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');S.playing={id,title,author,loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F This book has no files. Opening on archive.org...','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=j.files.find(f=>/_64kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.mp3$/i.test(f.name)&&!/sample|test|spoken/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const url='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title,author,url,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(a){a.load();const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap play on the bar below','err'))}},200)}else{toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing={id,title,author,url:null,external:'https://archive.org/details/'+id,error:e.message};render()}}
function closePlayer(){S.playing=null;render()}

function render(){
if(!S.user){let h='<div class="login">';
h+='<svg class="hero" viewBox="0 0 220 160" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#3DAE5C"/><stop offset="100%" stop-color="#E8912C"/></linearGradient><linearGradient id="g2" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#E8453C"/></linearGradient></defs><circle cx="110" cy="80" r="62" fill="url(#g1)" opacity=".15"/><rect x="42" y="40" width="86" height="90" rx="10" fill="#FFFDF9" stroke="#2D2A26" stroke-width="2"/><line x1="54" y1="58" x2="116" y2="58" stroke="#DDD8D1" stroke-width="2" stroke-linecap="round"/><line x1="54" y1="72" x2="100" y2="72" stroke="#DDD8D1" stroke-width="2" stroke-linecap="round"/><line x1="54" y1="86" x2="110" y2="86" stroke="#DDD8D1" stroke-width="2" stroke-linecap="round"/><line x1="54" y1="100" x2="90" y2="100" stroke="#DDD8D1" stroke-width="2" stroke-linecap="round"/><circle cx="46" cy="58" r="4" fill="#3DAE5C"/><circle cx="46" cy="72" r="4" fill="#3DAE5C"/><circle cx="46" cy="86" r="4" fill="#E8912C"/><circle cx="46" cy="100" r="4" fill="#DDD8D1"/><rect x="138" y="30" width="60" height="84" rx="6" fill="url(#g2)" transform="rotate(8 168 72)"/><rect x="144" y="38" width="48" height="4" rx="2" fill="#fff" opacity=".8" transform="rotate(8 168 72)"/><rect x="144" y="48" width="38" height="4" rx="2" fill="#fff" opacity=".6" transform="rotate(8 168 72)"/><circle cx="168" cy="88" r="10" fill="#fff" opacity=".9" transform="rotate(8 168 72)"/><polygon points="165,84 165,92 172,88" fill="#7C3AED" transform="rotate(8 168 72)"/><circle cx="30" cy="30" r="6" fill="#E8912C"><animate attributeName="cy" values="30;26;30" dur="2.5s" repeatCount="indefinite"/></circle><circle cx="190" cy="140" r="5" fill="#3DAE5C"><animate attributeName="cy" values="140;136;140" dur="3s" repeatCount="indefinite"/></circle><circle cx="20" cy="130" r="4" fill="#7C3AED" opacity=".7"><animate attributeName="cy" values="130;126;130" dur="2.8s" repeatCount="indefinite"/></circle></svg>';
h+='<div class="login-logo">Bro<span class="k">Do</span>it</div>';
if(S.loginStep==='phone'){
h+='<div class="login-sub">Tasks + Books + Wisdom, all in one place.</div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot"></div><div class="step-dot"></div></div>';
h+='<div class="tabs" style="max-width:320px;margin:0 auto 14px"><button class="tab'+(S.loginMethod==='email'?' on':'')+'" onclick="S.loginMethod=\\'email\\';S.loginError=\\'\\';render()">\\u2709\\uFE0F Email</button><button class="tab'+(S.loginMethod==='whatsapp'?' on':'')+'" onclick="S.loginMethod=\\'whatsapp\\';S.loginError=\\'\\';render()">\\u{1F4F1} WhatsApp</button></div>';
h+='<input type="text" placeholder="Your name" value="'+esc(S.loginName)+'" oninput="S.loginName=this.value" style="font-size:15px;letter-spacing:0">';
if(S.loginMethod==='email')h+='<input type="email" placeholder="you@example.com" value="'+esc(S.loginEmail)+'" oninput="S.loginEmail=this.value" autocomplete="email" style="font-size:15px;letter-spacing:0">';
else h+='<input type="tel" placeholder="+91 98765 43210" value="'+esc(S.loginPhone)+'" oninput="S.loginPhone=this.value" autocomplete="tel" style="font-family:\\'Space Mono\\',monospace">';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Sending code...':(S.loginMethod==='email'?'\\u2709\\uFE0F Send code to email':'\\u{1F4F1} Send code on WhatsApp'))+'</button>';
if(S.loginMethod==='email')h+='<div class="login-hint">We\\'ll email a 6-digit code. Check your inbox (and spam folder).</div>';
else h+='<div class="login-hint">We\\'ll send a 6-digit code to your WhatsApp.<br><b>First time?</b> Join the sandbox: send "join &lt;code&gt;" to <b>+1 415 523 8886</b></div>';
}else if(S.loginStep==='otp'){
h+='<div class="login-sub">Enter the code sent to<br><strong>'+esc(S.loginMethod==='email'?S.loginEmail:S.loginPhone)+'</strong></div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot on"></div><div class="step-dot"></div></div>';
h+='<div class="otp-inputs">';
for(let i=0;i<6;i++)h+='<input id="otp'+i+'" type="tel" maxlength="1" value="'+S.loginOTP[i]+'" oninput="otpInput('+i+',this.value)" onkeydown="otpKey('+i+',event)">';
h+='</div>';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="verifyOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Verifying...':'Verify & Login')+'</button>';
h+='<button class="login-btn sec" onclick="S.loginStep=\\'phone\\';S.loginError=\\'\\';render()">\\u2190 Change number</button>';
h+='<div class="login-hint">Didn\\'t get the code? '+(S.loginMethod==='email'?'Check your spam folder or click "Change number" to retry.':'Make sure you joined the WhatsApp sandbox first.')+'</div>';
}
h+='</div>';
if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
document.getElementById('app').innerHTML=h;return;
}

const ts=S.tasks,f=ts.filter(t=>{if(S.search){const q=S.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||'').toLowerCase().includes(q))return false}if(S.view==='all')return true;if(S.view==='today')return isTd(t.due_date);if(S.view==='overdue')return isOD(t.due_date,t.status);return t.status===S.view});
const s={total:ts.length,pend:ts.filter(t=>t.status==='pending').length,act:ts.filter(t=>t.status==='in-progress').length,dn:ts.filter(t=>t.status==='done').length,od:ts.filter(t=>isOD(t.due_date,t.status)).length};

let h='<div class="hdr"><div><div class="logo">Bro<span class="k">Do</span>it</div><div style="font-size:12px;color:#9C968D;margin-top:1px">'+new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div></div><div class="hdr-st"><span class="dot" style="background:'+(S.waOk?'#3DAE5C':'#D4D0CA')+'"></span>'+(S.waOk?'LIVE':'OFF')+'</div></div>';

// Moral chip
const m=MORALS[S.moralIdx];
h+='<div class="moral"><div class="moral-emoji">\\u{1F4A1}</div><div class="moral-body"><div class="moral-lbl">Moral of the Day</div><div class="moral-txt">"'+esc(m.t)+'"</div><div class="moral-by">\\u2014 '+esc(m.a)+'</div></div><button class="moral-ref" onclick="rotateMoral()" title="New quote">\\u21BB</button></div>';

// Tabs
h+='<div class="tabs page-t"><button class="tab'+(S.tab==='tasks'?' on':'')+'" onclick="switchTab(\\'tasks\\')">\\u{1F4CB} Tasks</button><button class="tab'+(S.tab==='cal'?' on':'')+'" onclick="switchTab(\\'cal\\')">\\u{1F4C5} Calendar</button><button class="tab'+(S.tab==='dash'?' on':'')+'" onclick="switchTab(\\'dash\\')">\\u{1F4CA} Stats</button><button class="tab'+(S.tab==='books'?' on':'')+'" onclick="switchTab(\\'books\\')">\\u{1F4DA} Books</button><button class="tab'+(S.tab==='calc'?' on':'')+'" onclick="switchTab(\\'calc\\')">\\u{1F9EE} Calc</button></div>';

h+='<div class="user-bar" style="cursor:pointer" onclick="openProfile()"><span>\\u{1F464} '+esc(S.user.name||S.user.phone)+' <span style="color:#9C968D;font-size:11px">\\u203A Profile</span></span><button onclick="event.stopPropagation();logout()">Logout</button></div>';

// TASKS TAB
if(S.tab==='tasks'){
  h+='<button class="add-bar" onclick="opA()"><span class="plus">+</span><span class="txt"><b>Add a new task</b><small>Type, speak, or send via WhatsApp</small></span></button>';
  if(S.waOk)h+='<div class="al" style="background:#EDFCF2;border:1px solid #B7E8C4;color:#1A9E47">\\u{1F4F1} WhatsApp connected</div>';
  h+='<div class="stats">'+[{l:'Total',v:s.total,c:'#2D2A26'},{l:'To Do',v:s.pend,c:'#7A756E'},{l:'Active',v:s.act,c:'#3B82F6'},{l:'Done',v:s.dn,c:'#3DAE5C'}].map(x=>'<div class="st"><b style="color:'+x.c+'">'+x.v+'</b><small>'+x.l+'</small></div>').join('')+'</div>';
  if(s.od>0)h+='<div class="al" style="background:#FEF1F0;border:1px solid #F5C6C2;color:#E8453C;cursor:pointer" onclick="S.view=\\'overdue\\';render()">\\u26A0\\uFE0F '+s.od+' overdue</div>';
  h+='<div class="srch"><input placeholder="Search tasks..." value="'+esc(S.search)+'" oninput="S.search=this.value;render()"></div>';
  h+='<div class="flt">'+[{k:'all',l:'All'},{k:'pending',l:'To Do'},{k:'in-progress',l:'Doing'},{k:'done',l:'Done'},{k:'today',l:'Today'}].map(x=>'<button class="fb'+(S.view===x.k?' on':'')+'" onclick="S.view=\\''+x.k+'\\';render()">'+x.l+'</button>').join('')+'</div>';
  if((s.pend+s.act)>0&&S.waOk)h+='<button class="bwa" onclick="sAll()">'+WI+' Send all to WhatsApp</button>';
  h+='<div>';
  if(!f.length)h+='<div class="empty"><div style="font-size:36px;margin-bottom:8px">\\u2728</div><div style="font-size:15px;font-weight:600">No tasks yet</div><div style="font-size:13px;margin-top:4px">Tap + or send via WhatsApp</div></div>';
  else f.forEach(t=>{const p=P[t.priority]||P.medium,st=ST[t.status]||ST.pending,d=t.status==='done';
    h+='<div class="tc'+(d?' dn':'')+'" style="border-left-color:'+p.c+'"><div class="tc-top"><button class="chk'+(d?' on':'')+'" onclick="tog(\\''+t.id+'\\')">'+(d?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':'')+'</button><div style="flex:1;min-width:0"><div class="tc-t'+(d?' dn':'')+'">'+esc(t.title)+'</div>'+(t.notes?'<div class="tc-n">'+esc(t.notes)+'</div>':'')+'<div class="tc-m"><button class="badge" style="background:'+st.bg+';color:'+st.c+'" onclick="cyc(\\''+t.id+'\\')">'+st.l+'</button>'+(t.due_date?'<span style="font-size:12px;font-weight:500;color:'+(isOD(t.due_date,t.status)?'#E8453C':isTd(t.due_date)?'#E8912C':'#9C968D')+'">\\u{1F4C5} '+fD(t.due_date)+(isOD(t.due_date,t.status)?' overdue':'')+'</span>':'')+(t.reminder_time&&!d?'<span style="font-size:11px;color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>':'')+(t.source==='whatsapp'?'<span style="font-size:10px;color:#C4BFB7">via WA</span>':'')+'</div></div></div>';
    h+='<div class="tc-acts"><button class="ib" onclick="opE(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="ib" onclick="sWA(\\''+t.id+'\\')">'+WI+'</button><button class="ib" style="color:#E8453C" onclick="del(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div></div>'});
  h+='</div><button class="fab" onclick="opA()">+</button>';
}

// DASHBOARD TAB
else if(S.tab==='dash'){
  const today=new Date().toISOString().slice(0,10);
  const wAgo=new Date(Date.now()-7*864e5).toISOString().slice(0,10);
  const doneToday=ts.filter(t=>t.status==='done'&&(t.updated_at||'').slice(0,10)===today).length;
  const doneWeek=ts.filter(t=>t.status==='done'&&(t.updated_at||'').slice(0,10)>=wAgo).length;
  const rate=ts.length?Math.round(100*s.dn/ts.length):0;
  const hT=ts.filter(t=>t.priority==='high').length,hD=ts.filter(t=>t.priority==='high'&&t.status==='done').length;
  const mT=ts.filter(t=>t.priority==='medium').length,mD=ts.filter(t=>t.priority==='medium'&&t.status==='done').length;
  const lT=ts.filter(t=>t.priority==='low').length,lD=ts.filter(t=>t.priority==='low'&&t.status==='done').length;
  // streak
  let streak=0;for(let i=0;i<30;i++){const d=new Date(Date.now()-i*864e5).toISOString().slice(0,10);const ok=ts.some(t=>t.status==='done'&&(t.updated_at||'').slice(0,10)===d);if(ok)streak++;else if(i>0)break;else continue}
  // day of week
  const dow=[0,0,0,0,0,0,0],dowN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  ts.forEach(t=>{if(t.status==='done'&&t.updated_at){const d=new Date(t.updated_at);dow[d.getDay()]++}});
  const bestDay=dowN[dow.indexOf(Math.max(...dow))]||'—';
  // AI insights
  const ins=[];
  const greet=(new Date().getHours()<12?'Good morning':new Date().getHours()<18?'Good afternoon':'Good evening');
  if(doneToday>=3)ins.push({t:'\\u{1F525} Strong momentum — '+doneToday+' tasks done today. Keep going!',c:''});
  if(s.od>0)ins.push({t:'\\u26A0\\uFE0F '+s.od+' overdue — tackle these first to unblock yourself.',c:'alert'});
  if(hT>0&&hD/hT>0.7)ins.push({t:'\\u{1F3AF} Crushing high-priority work — '+Math.round(100*hD/hT)+'% done.',c:''});
  if(streak>=3)ins.push({t:'\\u{1F3C6} '+streak+'-day streak — consistency pays off.',c:''});
  if(doneWeek>=10)ins.push({t:'\\u{1F4AA} '+doneWeek+' tasks this week — above your normal pace.',c:''});
  if(s.act>0&&s.pend>5)ins.push({t:'\\u{1F4A1} Focus tip: finish your '+s.act+' active task'+(s.act>1?'s':'')+' before starting new ones.',c:'warn'});
  if(bestDay!=='—'&&dow[dow.indexOf(Math.max(...dow))]>=3)ins.push({t:'\\u{1F4C5} Your most productive day is '+bestDay+' ('+dow[dow.indexOf(Math.max(...dow))]+' tasks completed).',c:''});
  if(!ins.length)ins.push({t:'\\u{1F44B} '+greet+', '+(S.user.name||'friend')+'! Add a task and complete it to unlock insights.',c:''});
  // Render
  h+='<div class="dash-hero"><h2>'+greet+(S.user.name?', '+esc(S.user.name.split(' ')[0]):'')+'!</h2><p>Here\\'s your productivity snapshot</p><div class="big">'+doneWeek+'<small>tasks done this week</small></div></div>';
  h+='<div class="dash-grid">';
  h+='<div class="dash-card"><div class="lbl">\\u{1F4C5} Today</div><div class="v">'+doneToday+'</div><div class="sub">completed</div></div>';
  h+='<div class="dash-card"><div class="lbl">\\u{1F3AF} Completion</div><div class="v">'+rate+'%</div><div class="sub">'+s.dn+' of '+ts.length+'</div></div>';
  h+='<div class="dash-card"><div class="lbl">\\u{1F525} Streak</div><div class="v">'+streak+'<small style="font-size:13px;color:#9C968D;margin-left:4px">days</small></div><div class="sub">keep it alive</div></div>';
  h+='<div class="dash-card"><div class="lbl">\\u{1F31F} Best Day</div><div class="v" style="font-size:18px">'+bestDay+'</div><div class="sub">'+(Math.max(...dow)||0)+' tasks</div></div>';
  h+='</div>';
  // priority bars
  const tot=hT+mT+lT;
  if(tot){
    h+='<div class="dash-card" style="margin-bottom:14px"><div class="lbl">\\u{1F4CA} Priority breakdown</div><div class="prio-bars">';
    if(hT)h+='<div class="b" style="background:#E8453C;flex:'+hT+'" title="High">High '+hD+'/'+hT+'</div>';
    if(mT)h+='<div class="b" style="background:#E8912C;flex:'+mT+'" title="Med">Med '+mD+'/'+mT+'</div>';
    if(lT)h+='<div class="b" style="background:#3DAE5C;flex:'+lT+'" title="Low">Low '+lD+'/'+lT+'</div>';
    h+='</div></div>';
  }
  // insights
  h+='<div class="insights">';
  ins.forEach(i=>{h+='<div class="insight '+i.c+'"><span class="ai-badge">AI</span>'+i.t+'</div>'});
  h+='</div>';
}

// CALENDAR TAB
else if(S.tab==='cal'){
  const cm=S.calMonth instanceof Date?S.calMonth:new Date();
  const year=cm.getFullYear(),month=cm.getMonth();
  const monthName=cm.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  const firstDay=new Date(year,month,1);
  const lastDay=new Date(year,month+1,0);
  const startDow=firstDay.getDay();
  const daysInMonth=lastDay.getDate();
  const prevLast=new Date(year,month,0).getDate();
  // build grid of 42 cells
  const cells=[];
  for(let i=startDow-1;i>=0;i--)cells.push({d:prevLast-i,m:month-1,y:month===0?year-1:year,other:true});
  for(let d=1;d<=daysInMonth;d++)cells.push({d,m:month,y:year,other:false});
  while(cells.length<42){const last=cells[cells.length-1];let nd=last.d+1,nm=last.m,ny=last.y;if(last.other&&last.m===month-1){nm=month;nd=1}else{const lim=new Date(ny,nm+1,0).getDate();if(nd>lim){nd=1;nm++;if(nm>11){nm=0;ny++}}}cells.push({d:nd,m:nm,y:ny,other:nm!==month})}
  // tasks-by-date index
  const byDate={};
  ts.forEach(t=>{if(t.due_date){(byDate[t.due_date]=byDate[t.due_date]||[]).push(t)}});
  const todayK=new Date().toISOString().slice(0,10);
  const sel=S.calSelectedDate;
  h+='<div class="cal-head"><button class="cal-nav" onclick="calPrev()">\\u2039</button><h3>'+esc(monthName)+'</h3><button class="cal-nav" onclick="calNext()">\\u203A</button></div>';
  h+='<div class="cal-grid">';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>h+='<div class="cal-dow">'+d+'</div>');
  cells.forEach(c=>{
    const dk=c.y+'-'+String(c.m+1).padStart(2,'0')+'-'+String(c.d).padStart(2,'0');
    const tasksHere=byDate[dk]||[];
    let cls='cal-day';
    if(c.other)cls+=' other';
    if(dk===todayK)cls+=' today';
    if(dk===sel)cls+=' sel';
    let dots='';
    if(tasksHere.length){
      const hi=tasksHere.some(t=>t.priority==='high');
      const me=tasksHere.some(t=>t.priority==='medium');
      const lo=tasksHere.some(t=>t.priority==='low');
      if(hi)dots+='<i style="background:#E8453C"></i>';
      if(me)dots+='<i style="background:#E8912C"></i>';
      if(lo)dots+='<i style="background:#3DAE5C"></i>';
    }
    h+='<button class="'+cls+'" onclick="calSelect(\\''+dk+'\\')">'+c.d+'<span class="ind">'+dots+'</span></button>';
  });
  h+='</div>';
  // selected date panel
  if(sel){
    const selTasks=byDate[sel]||[];
    const selDate=new Date(sel+'T00:00:00');
    const selLabel=selDate.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    h+='<div class="cal-selected-box"><h4>\\u{1F4CD} '+esc(selLabel)+'</h4>';
    if(!selTasks.length)h+='<div class="muted">No tasks for this date yet.</div>';
    else{
      h+='<div class="muted">'+selTasks.length+' task'+(selTasks.length>1?'s':'')+' scheduled</div>';
      selTasks.forEach(t=>{const p=P[t.priority]||P.medium,st=ST[t.status]||ST.pending,d=t.status==='done';
        h+='<div class="tc'+(d?' dn':'')+'" style="border-left-color:'+p.c+';margin-bottom:6px"><div class="tc-top"><button class="chk'+(d?' on':'')+'" onclick="tog(\\''+t.id+'\\')">'+(d?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':'')+'</button><div style="flex:1;min-width:0"><div class="tc-t'+(d?' dn':'')+'">'+esc(t.title)+'</div>'+(t.notes?'<div class="tc-n">'+esc(t.notes)+'</div>':'')+'<div class="tc-m"><button class="badge" style="background:'+st.bg+';color:'+st.c+'" onclick="cyc(\\''+t.id+'\\')">'+st.l+'</button>'+(t.reminder_time&&!d?'<span style="font-size:11px;color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>':'')+'</div></div></div></div>';
      });
    }
    h+='<button class="add-bar" style="margin-top:10px;margin-bottom:0" onclick="calAddForDate()"><span class="plus">+</span><span class="txt"><b>Add task / note for this date</b><small>'+esc(selLabel)+'</small></span></button>';
    h+='</div>';
  }
}

// BOOKS TAB
else if(S.tab==='books'){
  h+='<div class="srch"><input placeholder="Search audiobooks..." value="'+esc(S.bookSearch)+'" oninput="S.bookSearch=this.value;render()"></div>';
  h+='<div class="flt">'+['all','fiction','mystery','philosophy','adventure','kids'].map(c=>'<button class="fb'+(S.booksCat===c?' on':'')+'" onclick="loadBooks(\\''+c+'\\')">'+c.charAt(0).toUpperCase()+c.slice(1)+'</button>').join('')+'</div>';
  if(S.booksLoading)h+='<div class="loading">Loading audiobooks...</div>';
  else{
    const q=S.bookSearch.toLowerCase().trim();
    const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});
    if(!fb.length)h+='<div class="empty"><div style="font-size:36px">\\u{1F4DA}</div><div style="font-size:14px;margin-top:8px">No books found</div></div>';
    else{h+='<div class="book-list">';fb.forEach(b=>{const id=b.identifier;const cover='https://archive.org/services/img/'+id;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');const title=Array.isArray(b.title)?b.title[0]:b.title;h+='<div class="book-card"><div class="book-cover"><img src="'+cover+'" loading="lazy" onerror="this.style.display=\\'none\\'"/></div><div class="book-info"><div class="book-title">'+esc(title)+'</div><div class="book-author">'+esc(author)+'</div><div class="book-meta"><span>\\u{1F3A7} '+(b.downloads?(+b.downloads).toLocaleString():'—')+' plays</span><span>\\u{1F4D6} LibriVox</span></div></div><button class="book-play" onclick="playBook(\\''+id+'\\')">\\u25B6</button></div>';});h+='</div>'}
  }
}

// CALCULATOR TAB
else if(S.tab==='calc'){
  h+='<div class="smart-hint">\\u{1F4A1} <b>Smart mode:</b> type expressions like <code>15% of 200</code>, <code>sqrt(144)</code>, <code>5*3+2</code>, or <code>pi*4</code> — live-evaluated.</div>';
  h+='<div class="calc-input-row"><input placeholder="Type expression..." value="'+esc(S.calcExpr)+'" oninput="calcTyped(this.value)"/></div>';
  h+='<div class="calc-screen"><div class="calc-expr">'+(esc(S.calcExpr)||'&nbsp;')+'</div><div class="calc-result">'+esc(S.calcResult)+'</div></div>';
  h+='<div class="calc-tgl"><button class="'+(!S.calcSci?'on':'')+'" onclick="S.calcSci=false;render()">Basic</button><button class="'+(S.calcSci?'on':'')+'" onclick="S.calcSci=true;render()">Scientific</button></div>';
  if(S.calcSci){
    h+='<div class="calc-grid"><button class="ck sci" onclick="calcAppend(\\'sqrt(\\')">\\u221A</button><button class="ck sci" onclick="calcAppend(\\'sin(\\')">sin</button><button class="ck sci" onclick="calcAppend(\\'cos(\\')">cos</button><button class="ck sci" onclick="calcAppend(\\'tan(\\')">tan</button><button class="ck sci" onclick="calcAppend(\\'log(\\')">log</button><button class="ck sci" onclick="calcAppend(\\'ln(\\')">ln</button><button class="ck sci" onclick="calcAppend(\\'pi\\')">π</button><button class="ck sci" onclick="calcAppend(\\'^\\')">xʸ</button></div>';
  }
  h+='<div class="calc-grid">';
  h+='<button class="ck sp" onclick="calcClear()">C</button>';
  h+='<button class="ck sp" onclick="calcBack()">\\u232B</button>';
  h+='<button class="ck op" onclick="calcAppend(\\'%\\')">%</button>';
  h+='<button class="ck op" onclick="calcAppend(\\'/\\')">\\u00F7</button>';
  ['7','8','9'].forEach(n=>h+='<button class="ck" onclick="calcAppend(\\''+n+'\\')">'+n+'</button>');
  h+='<button class="ck op" onclick="calcAppend(\\'*\\')">\\u00D7</button>';
  ['4','5','6'].forEach(n=>h+='<button class="ck" onclick="calcAppend(\\''+n+'\\')">'+n+'</button>');
  h+='<button class="ck op" onclick="calcAppend(\\'-\\')">\\u2212</button>';
  ['1','2','3'].forEach(n=>h+='<button class="ck" onclick="calcAppend(\\''+n+'\\')">'+n+'</button>');
  h+='<button class="ck op" onclick="calcAppend(\\'+\\')">+</button>';
  h+='<button class="ck" onclick="calcAppend(\\'(\\')">(</button>';
  h+='<button class="ck" onclick="calcAppend(\\'0\\')">0</button>';
  h+='<button class="ck" onclick="calcAppend(\\'.\\')">.</button>';
  h+='<button class="ck eq" onclick="calcEnter()">=</button>';
  h+='</div>';
  if(S.calcHistory&&S.calcHistory.length){
    h+='<div class="calc-hist"><h4>\\u{1F4DC} History</h4>';
    S.calcHistory.forEach(x=>{h+='<div class="hi" onclick="S.calcExpr=\\''+esc(x.expr).replace(/'/g,"\\\\'")+'\\';calcEval();render()">'+esc(x.expr)+' = <b>'+esc(x.result)+'</b></div>'});
    h+='</div>';
  }
}

// Player bar (any tab)
if(S.playing){
  h+='<div class="player on"><div class="player-info"><div class="player-title">'+esc(S.playing.title)+'</div><div class="player-author">'+esc(S.playing.author)+(S.playing.external?' \\u2022 <a href="'+esc(S.playing.external)+'" target="_blank" style="color:#3DAE5C;text-decoration:none">Open \\u2197</a>':'')+'</div></div>';
  if(S.playing.url)h+='<audio id="audioEl" controls preload="auto" src="'+esc(S.playing.url)+'"></audio>';
  else if(S.playing.error)h+='<span style="font-size:11px;color:#E8453C">\\u26A0\\uFE0F '+esc(S.playing.error)+'</span>';
  else h+='<span style="font-size:11px;color:#9C968D">Loading\\u2026</span>';
  h+='<button class="player-close" onclick="closePlayer()">\\u2715</button></div>';
}

if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';

if(S.showProfile){
  const p=S.profile||{phone:S.user.phone,name:S.user.name,created_at:''};
  const initials=((S.user.name||S.user.phone).match(/\\b\\w/g)||['U']).slice(0,2).join('').toUpperCase();
  const mem=p.created_at?new Date(p.created_at.replace(' ','T')+'Z').toLocaleDateString('en-US',{month:'long',year:'numeric'}):'—';
  const masked=p.phone?p.phone.slice(0,3)+' \\u2022\\u2022\\u2022\\u2022\\u2022 '+p.phone.slice(-3):'';
  const streak=(function(){let c=0;for(let i=0;i<30;i++){const d=new Date(Date.now()-i*864e5).toISOString().slice(0,10);const ok=ts.some(t=>t.status==='done'&&(t.updated_at||'').slice(0,10)===d);if(ok)c++;else if(i>0)break}return c})();
  h+='<div class="ov" onclick="closeProfile()"><div class="mdl" onclick="event.stopPropagation()" style="text-align:center">';
  h+='<div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#3DAE5C,#7C3AED);color:#fff;display:flex;align-items:center;justify-content:center;font-family:\\'Space Mono\\',monospace;font-size:32px;font-weight:700;margin:0 auto 12px">'+esc(initials)+'</div>';
  h+='<h2 style="margin-bottom:4px">'+esc(S.user.name||'Brodoit User')+'</h2>';
  h+='<div style="font-size:12px;color:#9C968D;font-family:\\'Space Mono\\',monospace;margin-bottom:18px">'+esc(masked)+'</div>';
  h+='<div class="dash-grid" style="text-align:left"><div class="dash-card"><div class="lbl">Total tasks</div><div class="v">'+ts.length+'</div></div><div class="dash-card"><div class="lbl">Completed</div><div class="v" style="color:#3DAE5C">'+s.dn+'</div></div><div class="dash-card"><div class="lbl">Streak</div><div class="v">'+streak+'<small style="font-size:12px;color:#9C968D;margin-left:4px">days</small></div></div><div class="dash-card"><div class="lbl">Member since</div><div class="v" style="font-size:14px">'+esc(mem)+'</div></div></div>';
  h+='<label class="lbl" style="text-align:left">Display name</label><div class="row"><input id="pfName" value="'+esc(S.user.name||'')+'" placeholder="Your name"><button class="mb mb-s" style="flex:0 0 auto;padding:11px 18px" onclick="saveName()">Save</button></div>';
  h+='<div class="macts" style="margin-top:22px"><button class="mb mb-c" onclick="closeProfile()">Close</button><button class="mb mb-d" style="margin-top:0" onclick="logout()">Log out</button></div>';
  h+='</div></div>';
}
if(S.showAdd){const isE=!!S.editing;
h+='<div class="ov" onclick="clM()"><div class="mdl" onclick="event.stopPropagation()"><h2>'+(isE?'Edit Task':'\\u2728 New Task')+'</h2>';
h+='<div style="text-align:center;margin-bottom:10px"><button class="voice-lg'+(S.listening?' rec':'')+'" onclick="'+(S.listening?'rec&&rec.stop();S.listening=false;render()':'stV()')+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'+(S.listening?'<span class="vw"><span></span><span></span><span></span><span></span></span>Listening...':'\\u{1F3A4} Speak to add')+'</button><div style="font-size:11px;color:#9C968D;margin-top:6px">Try: "Buy groceries tomorrow urgent"</div></div>';
h+='<div style="height:1px;background:#E8E4DD;margin:10px 0 14px"></div>';
h+='<label class="lbl">Task</label><input id="ft" value="'+esc(S.form.title)+'" placeholder="What needs to be done?" oninput="S.form.title=this.value">';
h+='<label class="lbl">Notes</label><textarea oninput="S.form.notes=this.value" placeholder="Details...">'+esc(S.form.notes)+'</textarea>';
h+='<div class="row"><div><label class="lbl">Priority</label><select onchange="S.form.priority=this.value"><option value="high"'+(S.form.priority==='high'?' selected':'')+'>High</option><option value="medium"'+(S.form.priority==='medium'?' selected':'')+'>Medium</option><option value="low"'+(S.form.priority==='low'?' selected':'')+'>Low</option></select></div>';
h+='<div><label class="lbl">Due Date</label><input type="date" value="'+S.form.dueDate+'" onchange="S.form.dueDate=this.value"></div></div>';
h+='<label class="lbl">Reminder</label><input type="time" value="'+S.form.reminderTime+'" onchange="S.form.reminderTime=this.value">';
if(isE)h+='<label class="lbl">Status</label><select onchange="S.form.status=this.value"><option value="pending"'+(S.form.status==='pending'?' selected':'')+'>To Do</option><option value="in-progress"'+(S.form.status==='in-progress'?' selected':'')+'>Doing</option><option value="done"'+(S.form.status==='done'?' selected':'')+'>Done</option></select>';
h+='<div class="macts"><button class="mb mb-c" onclick="clM()">Cancel</button><button class="mb mb-s" onclick="'+(isE?'savE()':'addT()')+'">'+(isE?'Update':'Add Task')+'</button></div>';
if(isE)h+='<button class="mb mb-d" onclick="del(\\''+S.editing+'\\');clM()">Delete</button>';
h+='</div></div>';}

document.getElementById('app').innerHTML=h;
}
if(S.user){refreshSession();load();chk();setInterval(load,10000)}else render();
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
</script></body></html>`;

// PWA manifest (TWA-compliant for Google Play Store)
app.get('/manifest.json',(_,res)=>res.json({
  name:"Brodoit — Tasks, Books & Wisdom",
  short_name:"Brodoit",
  description:"Manage tasks with WhatsApp reminders, listen to free audiobooks, get daily wisdom, and track your productivity with AI insights.",
  start_url:"/",
  scope:"/",
  id:"/",
  display:"standalone",
  orientation:"portrait",
  background_color:"#F5F2ED",
  theme_color:"#2D2A26",
  lang:"en",
  dir:"ltr",
  categories:["productivity","lifestyle","utilities","education"],
  icons:[
    {src:"/icon-192.png",sizes:"192x192",type:"image/png",purpose:"any"},
    {src:"/icon-512.png",sizes:"512x512",type:"image/png",purpose:"any"},
    {src:"/icon-maskable-512.png",sizes:"512x512",type:"image/png",purpose:"maskable"}
  ],
  screenshots:[
    {src:"/screenshot-phone-1.png",sizes:"1080x1920",type:"image/png",form_factor:"narrow"}
  ]
}));

// Icon endpoints — generate on the fly via ui-avatars until custom PNGs uploaded
app.get(['/icon-192.png','/icon-512.png','/icon-maskable-512.png'],(req,res)=>{
  const size=req.path.includes('512')?512:192;
  res.redirect(302,'https://ui-avatars.com/api/?name=Bd&background=2D2A26&color=3DAE5C&size='+size+'&bold=true&format=png&font-size=0.5');
});

// Digital Asset Links for TWA (Google Play Store verification)
// Fill SHA256_FINGERPRINT after running `bubblewrap init` — it prints the fingerprint
app.get('/.well-known/assetlinks.json',(_,res)=>{
  const fp=process.env.ANDROID_SHA256_FINGERPRINT||'REPLACE_AFTER_BUBBLEWRAP_INIT';
  res.json([{
    relation:["delegate_permission/common.handle_all_urls"],
    target:{
      namespace:"android_app",
      package_name:process.env.ANDROID_PACKAGE_NAME||"com.brodoit.twa",
      sha256_cert_fingerprints:[fp]
    }
  }]);
});

// Privacy Policy (required by Play Store)
app.get('/privacy',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Privacy Policy — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#2D2A26;background:#F5F2ED;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#4A453E}a{color:#3DAE5C}</style></head><body><h1>Privacy Policy</h1><p><em>Last updated: April 2026</em></p><p><strong>Brodoit</strong> ("we", "our", "the app") values your privacy. This page explains what data we collect, why, and your rights.</p><h2>1. What we collect</h2><ul><li><strong>Email address</strong> or <strong>phone number</strong> — used only to authenticate you via one-time verification codes.</li><li><strong>Your name</strong> — displayed in the app's profile screen.</li><li><strong>Your tasks, notes, due dates, reminders</strong> — stored so we can show them back to you and send reminders.</li><li><strong>Session token</strong> — a random string stored in your browser so you stay logged in.</li></ul><p>We do <strong>not</strong> collect: location, contacts, advertising IDs, device IDs, photos, payment info, or any data we don't explicitly list here.</p><h2>2. How we use it</h2><ul><li>Deliver one-time codes by email or WhatsApp (via Resend and Twilio respectively).</li><li>Show your tasks and books library.</li><li>Send WhatsApp reminders at the times you set.</li></ul><h2>3. Who we share with</h2><p>We share data only with the following service providers, strictly to operate the service:</p><ul><li><strong>Resend</strong> — to deliver verification emails (<a href="https://resend.com/privacy">privacy policy</a>).</li><li><strong>Twilio</strong> — to deliver WhatsApp messages (<a href="https://www.twilio.com/legal/privacy">privacy policy</a>).</li><li><strong>Railway</strong> — our hosting provider (<a href="https://railway.app/legal/privacy">privacy policy</a>).</li><li><strong>Internet Archive (LibriVox)</strong> — we fetch public audiobook metadata; no personal data is sent.</li></ul><p>We never sell data, never show ads, never track you across other apps or sites.</p><h2>4. Data retention</h2><p>Your tasks and account persist until you delete them or ask us to delete your account. Verification codes expire after 5 minutes and are deleted after use.</p><h2>5. Your rights</h2><p>Email us at <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> to: export your data, correct your data, or permanently delete your account.</p><h2>6. Children</h2><p>Brodoit is not directed at children under 13. We do not knowingly collect data from children under 13.</p><h2>7. Changes</h2><p>If we make material changes, we'll update the date at the top and notify you via email if we have your address.</p><h2>8. Contact</h2><p>Questions? <a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#9C968D"><a href="/">← Back to Brodoit</a></p></body></html>`);
});

// Terms of Service
app.get('/terms',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Terms — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#2D2A26;background:#F5F2ED;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#4A453E}a{color:#3DAE5C}</style></head><body><h1>Terms of Service</h1><p><em>Last updated: April 2026</em></p><h2>1. The service</h2><p>Brodoit is a personal productivity app that lets you track tasks, listen to free public-domain audiobooks, and view daily motivational quotes.</p><h2>2. Your account</h2><p>You register with an email address or phone number. Keep your verification codes private. You're responsible for activity on your account.</p><h2>3. Acceptable use</h2><p>Don't abuse the service: no spam, no impersonation, no automated scraping, no attempts to disrupt the service. We may suspend accounts that do.</p><h2>4. Content</h2><p>You own your tasks and notes. We store them to show back to you. Audiobook content belongs to its respective public-domain authors and is served from the Internet Archive's LibriVox collection.</p><h2>5. No warranty</h2><p>The service is provided "as is". We try hard to keep it running but can't promise zero downtime or that reminders will always be delivered (WhatsApp/email providers can fail).</p><h2>6. Limitation of liability</h2><p>Brodoit is a personal tool. We're not liable for missed deadlines, lost data, or any consequential damages from using (or not using) the service.</p><h2>7. Changes</h2><p>We may update these terms. Continued use after a change means you accept the new terms.</p><h2>8. Contact</h2><p><a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#9C968D"><a href="/">← Back to Brodoit</a></p></body></html>`);
});
app.get('/sw.js',(_,res)=>{res.set('Content-Type','application/javascript');res.send('self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){self.clients.claim()});self.addEventListener("fetch",function(e){});')});
app.get('/',(_,res)=>res.type('html').send(HTML));
app.get('*',(_,res)=>res.type('html').send(HTML));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('🚀 Brodoit running on port '+PORT));
