require('dotenv').config();
const express=require('express'),cors=require('cors'),Database=require('better-sqlite3'),twilio=require('twilio'),path=require('path'),crypto=require('crypto');
const app=express();app.use(cors());app.use(express.json());app.use(express.urlencoded({extended:true}));

const db=new Database(path.join(__dirname,'taskflow.db'));db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY,name TEXT DEFAULT'',token TEXT,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_phone TEXT NOT NULL,title TEXT NOT NULL,notes TEXT DEFAULT'',priority TEXT DEFAULT'medium',status TEXT DEFAULT'pending',due_date TEXT DEFAULT'',reminder_time TEXT DEFAULT'',reminded INTEGER DEFAULT 0,source TEXT DEFAULT'app',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT,expires_at TEXT);`);

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

function auth(req,res,next){
  const t=req.headers['x-token'];if(!t)return res.status(401).json({error:'Login required'});
  const u=db.prepare('SELECT * FROM users WHERE token=?').get(t);if(!u)return res.status(401).json({error:'Invalid token'});
  req.user=u;next();
}

// ═══ OTP AUTH ═══
app.post('/api/send-otp',async(req,res)=>{
  const phone=cleanPhone(req.body.phone);
  if(phone.length<10)return res.status(400).json({error:'Invalid phone number'});
  const code=genOTP();
  const expires=new Date(Date.now()+5*60*1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at)VALUES(?,?,?)').run(phone,code,expires);
  const r=await sendWA(phone,`🔐 Your TaskFlow verification code is: *${code}*\n\nThis code expires in 5 minutes.\nDo not share this code with anyone.`);
  if(r.ok)res.json({ok:true,message:'OTP sent to your WhatsApp'});
  else res.status(500).json({ok:false,error:'Failed to send OTP. Make sure you have joined the Twilio WhatsApp sandbox first.',detail:r.reason});
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
app.get('/api/health',(_,res)=>res.json({status:'ok',twilio:!!tw,users:db.prepare('SELECT COUNT(*)as c FROM users').get().c,tasks:db.prepare('SELECT COUNT(*)as c FROM tasks').get().c}));

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
  if(p.command==='help')twiml.message('🤖 *TaskFlow*\n\n📝 Type task to add\n📋 "list" — your tasks\n✅ "done <task>" — complete\n🔄 "doing <task>" — start\n🗑️ "delete <task>" — remove\n\n🌐 App: https://taskit.up.railway.app');
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
<meta name="theme-color" content="#1A1816"><title>TaskFlow</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:'DM Sans',sans-serif;background:#F5F2ED;color:#2D2A26;min-height:100vh}
button{cursor:pointer;border:none;background:none;font-family:inherit;color:inherit}
input,textarea,select{font-family:inherit;border:1.5px solid #DDD8D1;border-radius:10px;padding:11px;font-size:15px;background:#F5F2ED;width:100%;color:#2D2A26}
input:focus,textarea:focus{outline:none;border-color:#2D2A26}textarea{resize:vertical;min-height:56px}select{-webkit-appearance:none;appearance:none}
.app{max-width:480px;margin:0 auto;padding:16px 16px 100px}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.logo{font-family:'Space Mono',monospace;font-size:24px;font-weight:700}
.hdr-st{font-size:11px;font-weight:700;padding:6px 10px;border-radius:8px;background:#FFFDF9;border:1px solid #E8E4DD;display:flex;align-items:center;gap:5px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
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
.toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.08);border:1px solid}
.toast-ok{background:#F2FBF4;border-color:#B7E8C4;color:#2D8A4E}.toast-err{background:#FEF1F0;border-color:#F5C6C2;color:#E8453C}
.login{max-width:400px;margin:0 auto;padding:50px 24px;text-align:center}
.login-logo{font-family:'Space Mono',monospace;font-size:32px;font-weight:700;margin-bottom:6px}
.login-sub{font-size:14px;color:#6B665E;margin-bottom:28px;line-height:1.5}
.login input{margin-bottom:12px;text-align:center;font-size:18px;letter-spacing:1px;padding:14px}
.login-btn{width:100%;padding:14px;font-size:16px;border-radius:12px;font-weight:700;background:#2D2A26;color:#F5F2ED;border:none;margin-top:4px}
.login-btn:disabled{opacity:.5}
.login-btn.sec{background:transparent;border:1.5px solid #DDD8D1;color:#6B665E;margin-top:8px}
.login-hint{font-size:12px;color:#9C968D;margin-top:16px;line-height:1.5}
.otp-inputs{display:flex;gap:8px;justify-content:center;margin:16px 0}
.otp-inputs input{width:44px;height:52px;text-align:center;font-size:22px;font-family:'Space Mono',monospace;font-weight:700;padding:0;border-radius:10px}
.user-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#FFFDF9;border:1px solid #E8E4DD;border-radius:8px;margin-bottom:12px;font-size:13px}
.user-bar button{font-size:12px;color:#E8453C;font-weight:600}
.step-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}.step-dot{width:8px;height:8px;border-radius:50%;background:#DDD8D1}.step-dot.on{background:#2D2A26}
</style></head><body>
<div class="app" id="app"></div>
<script>
let S={tasks:[],view:'all',search:'',showAdd:false,editing:null,listening:false,toast:null,toastType:'ok',waOk:false,sending:{},user:null,
loginStep:'phone',loginPhone:'',loginName:'',loginOTP:['','','','','',''],loginLoading:false,loginError:'',
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

// ═══ AUTH ═══
async function sendOTP(){
  let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;
  if(ph.length<10){S.loginError='Enter valid phone with country code';render();return}
  S.loginLoading=true;S.loginError='';render();
  const r=await fetch('/api/send-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ph})}).then(r=>r.json()).catch(()=>({ok:false,error:'Network error'}));
  S.loginLoading=false;
  if(r.ok){S.loginStep='otp';S.loginOTP=['','','','','',''];S.loginError='';render();setTimeout(()=>{const el=document.getElementById('otp0');if(el)el.focus()},100)}
  else{S.loginError=r.error||'Failed to send OTP';render()}
}
async function verifyOTP(){
  const code=S.loginOTP.join('');if(code.length<6){S.loginError='Enter the 6-digit code';render();return}
  let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;
  S.loginLoading=true;S.loginError='';render();
  const r=await fetch('/api/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ph,code,name:S.loginName})}).then(r=>r.json()).catch(()=>({error:'Network error'}));
  S.loginLoading=false;
  if(r.token){token=r.token;localStorage.setItem('tf_token',r.token);localStorage.setItem('tf_phone',r.phone);localStorage.setItem('tf_name',r.name||'');S.user=r;S.loginStep='phone';load();chk();toast('\\u2705 Welcome!')}
  else{S.loginError=r.error||'Verification failed';render()}
}
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
function clM(){S.showAdd=false;S.editing=null;render()}
function stV(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return;rec=new SR();rec.continuous=false;rec.interimResults=true;rec.lang='en-US';rec.onresult=e=>{let t='';for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;if(e.results[0].isFinal){S.form.title=t;const l=t.toLowerCase();if(/urgent|important|asap/.test(l))S.form.priority='high';if(/\\btoday\\b/.test(l))S.form.dueDate=new Date().toISOString().split('T')[0];else if(/\\btomorrow\\b/.test(l)){const d=new Date();d.setDate(d.getDate()+1);S.form.dueDate=d.toISOString().split('T')[0]}}render()};rec.onend=()=>{S.listening=false;render()};rec.start();S.listening=true;render()}

function render(){
// ═══ LOGIN SCREEN ═══
if(!S.user){let h='<div class="login"><div class="login-logo">TaskFlow</div>';
if(S.loginStep==='phone'){
h+='<div class="login-sub">Your tasks + WhatsApp, one place.</div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot"></div><div class="step-dot"></div></div>';
h+='<input type="text" placeholder="Your name" value="'+esc(S.loginName)+'" oninput="S.loginName=this.value" style="font-size:15px;letter-spacing:0">';
h+='<input type="tel" placeholder="+91 98765 43210" value="'+esc(S.loginPhone)+'" oninput="S.loginPhone=this.value" style="font-family:\\'Space Mono\\',monospace">';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+( S.loginLoading?'Sending OTP...':'Send OTP via WhatsApp')+'</button>';
h+='<div class="login-hint">We\\'ll send a 6-digit code to your WhatsApp.<br>Use the same number as your WhatsApp account.</div>';
}
else if(S.loginStep==='otp'){
h+='<div class="login-sub">Enter the code sent to<br><strong>'+esc(S.loginPhone)+'</strong></div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot on"></div><div class="step-dot"></div></div>';
h+='<div class="otp-inputs">';
for(let i=0;i<6;i++)h+='<input id="otp'+i+'" type="tel" maxlength="1" value="'+S.loginOTP[i]+'" oninput="otpInput('+i+',this.value)" onkeydown="otpKey('+i+',event)">';
h+='</div>';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="verifyOTP()"'+(S.loginLoading?' disabled':'')+'>'+( S.loginLoading?'Verifying...':'Verify & Login')+'</button>';
h+='<button class="login-btn sec" onclick="S.loginStep=\\'phone\\';S.loginError=\\'\\';render()">\\u2190 Change number</button>';
h+='<div class="login-hint">Didn\\'t get the code? Check WhatsApp for a message from the TaskFlow bot.</div>';
}
h+='</div>';
if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
document.getElementById('app').innerHTML=h;return;
}

// ═══ MAIN APP ═══
const ts=S.tasks,f=ts.filter(t=>{if(S.search){const q=S.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||'').toLowerCase().includes(q))return false}if(S.view==='all')return true;if(S.view==='today')return isTd(t.due_date);if(S.view==='overdue')return isOD(t.due_date,t.status);return t.status===S.view});
const s={total:ts.length,pend:ts.filter(t=>t.status==='pending').length,act:ts.filter(t=>t.status==='in-progress').length,dn:ts.filter(t=>t.status==='done').length,od:ts.filter(t=>isOD(t.due_date,t.status)).length};
let h='<div class="hdr"><div><div class="logo">TaskFlow</div><div style="font-size:12px;color:#9C968D;margin-top:1px">'+new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div></div><div class="hdr-st"><span class="dot" style="background:'+(S.waOk?'#3DAE5C':'#D4D0CA')+'"></span>'+(S.waOk?'WA ON':'WA OFF')+'</div></div>';
h+='<div class="user-bar"><span>\\u{1F464} '+(S.user.name||S.user.phone)+'</span><button onclick="logout()">Logout</button></div>';
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
if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
if(S.showAdd){const isE=!!S.editing;
h+='<div class="ov" onclick="clM()"><div class="mdl" onclick="event.stopPropagation()"><h2>'+(isE?'Edit Task':'New Task')+'</h2>';
h+='<div style="text-align:center;margin-bottom:10px"><button style="display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:30px;border:2px solid '+(S.listening?'#E8453C':'#DDD8D1')+';background:'+(S.listening?'#FEF1F0':'#F5F2ED')+';font-size:13px;color:'+(S.listening?'#E8453C':'#6B665E')+'" onclick="'+(S.listening?'rec&&rec.stop();S.listening=false;render()':'stV()')+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="'+(S.listening?'#E8453C':'#6B665E')+'" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'+(S.listening?' Listening...' :' Speak')+'</button></div>';
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
if(S.user){load();chk();setInterval(load,10000)}else render();
</script></body></html>`;

app.get('/',(_,res)=>res.type('html').send(HTML));
app.get('*',(_,res)=>res.type('html').send(HTML));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log('\\n\\u{1F680} TaskFlow on port '+PORT+'\\n\\u{1F4F1} WhatsApp: '+(tw?'ON':'OFF'))});
