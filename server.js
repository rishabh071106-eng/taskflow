require('dotenv').config();
const express=require('express'),cors=require('cors'),Database=require('better-sqlite3'),twilio=require('twilio'),path=require('path'),crypto=require('crypto');
const app=express();app.use(cors());app.use(express.json());app.use(express.urlencoded({extended:true}));

const DB_PATH=process.env.DB_PATH||path.join(__dirname,'taskflow.db');
try{require('fs').mkdirSync(path.dirname(DB_PATH),{recursive:true})}catch(e){}
console.log('[db] using',DB_PATH);
const db=new Database(DB_PATH);db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY,name TEXT DEFAULT'',token TEXT,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_phone TEXT NOT NULL,title TEXT NOT NULL,notes TEXT DEFAULT'',priority TEXT DEFAULT'medium',status TEXT DEFAULT'pending',due_date TEXT DEFAULT'',reminder_time TEXT DEFAULT'',reminded INTEGER DEFAULT 0,source TEXT DEFAULT'app',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT,expires_at TEXT);`);
// email column + unique index (idempotent)
try{db.exec("ALTER TABLE users ADD COLUMN email TEXT")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email!=''")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS steps(id INTEGER PRIMARY KEY AUTOINCREMENT,user_phone TEXT NOT NULL,date TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,source TEXT DEFAULT'manual',updated_at TEXT DEFAULT(datetime('now')))")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_user_date ON steps(user_phone,date)")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS book_listens(user_phone TEXT NOT NULL,date TEXT NOT NULL,seconds INTEGER DEFAULT 120,PRIMARY KEY(user_phone,date))")}catch(e){}

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
// ═══ STEPS API ═══
app.get('/api/steps',auth,(req,res)=>{
  const days=Math.min(Math.max(parseInt(req.query.days)||30,1),365);
  const since=new Date(Date.now()-(days-1)*864e5).toISOString().slice(0,10);
  res.json(db.prepare('SELECT date,count,source FROM steps WHERE user_phone=? AND date>=? ORDER BY date').all(req.user.phone,since));
});
app.post('/api/steps',auth,(req,res)=>{
  const{date,count,source}=req.body;
  if(!date||typeof count!=='number'||!isFinite(count)||count<0||count>200000)return res.status(400).json({error:'Bad input'});
  const d=String(date).slice(0,10),n=Math.floor(count),src=(source||'manual').slice(0,20);
  db.prepare("INSERT INTO steps(user_phone,date,count,source,updated_at)VALUES(?,?,?,?,datetime('now'))ON CONFLICT(user_phone,date)DO UPDATE SET count=excluded.count,source=excluded.source,updated_at=excluded.updated_at").run(req.user.phone,d,n,src);
  res.json({ok:true,date:d,count:n,source:src});
});
// ═══ BOOK LISTENING STREAK ═══
function calcStreak(rows){
  // rows: [{date}] sorted DESC
  if(!rows.length)return 0;
  const today=new Date().toISOString().slice(0,10);
  const yest=new Date(Date.now()-864e5).toISOString().slice(0,10);
  // Streak only continues if last listen was today or yesterday
  if(rows[0].date!==today&&rows[0].date!==yest)return 0;
  let streak=0;
  let cur=new Date(rows[0].date);
  for(const r of rows){
    const expected=cur.toISOString().slice(0,10);
    if(r.date===expected){streak++;cur.setDate(cur.getDate()-1)}
    else if(r.date<expected)break;
  }
  return streak;
}
app.get('/api/book-streak',auth,(req,res)=>{
  const rows=db.prepare('SELECT date FROM book_listens WHERE user_phone=? ORDER BY date DESC LIMIT 365').all(req.user.phone);
  const today=new Date().toISOString().slice(0,10);
  res.json({streak:calcStreak(rows),total:rows.length,today:rows.some(r=>r.date===today),days:rows.slice(0,30).map(r=>r.date)});
});
app.post('/api/book-streak',auth,(req,res)=>{
  const d=String(req.body?.date||new Date().toISOString().slice(0,10)).slice(0,10);
  const sec=Math.min(Math.max(parseInt(req.body?.seconds)||120,60),24*3600);
  // Insert if missing; otherwise sum the seconds (cap at 24h)
  const ex=db.prepare('SELECT seconds FROM book_listens WHERE user_phone=? AND date=?').get(req.user.phone,d);
  if(ex){db.prepare('UPDATE book_listens SET seconds=MIN(seconds+?,86400) WHERE user_phone=? AND date=?').run(sec,req.user.phone,d)}
  else{db.prepare('INSERT INTO book_listens(user_phone,date,seconds)VALUES(?,?,?)').run(req.user.phone,d,sec)}
  const rows=db.prepare('SELECT date FROM book_listens WHERE user_phone=? ORDER BY date DESC LIMIT 365').all(req.user.phone);
  res.json({ok:true,streak:calcStreak(rows),total:rows.length});
});
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

// Inject Twilio sandbox code into the HTML so frontend can build the wa.me link
app.get('/api/config',(_,res)=>res.json({sandboxCode:process.env.TWILIO_SANDBOX_CODE||''}));

// ═══ NEWS (shorts feed, RSS aggregator, 15-min server cache) ═══
const NEWS_FEEDS={
  ai:['https://techcrunch.com/category/artificial-intelligence/feed/','https://venturebeat.com/category/ai/feed/','https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
  sports:['https://feeds.bbci.co.uk/sport/rss.xml','https://www.espn.com/espn/rss/news','https://www.skysports.com/rss/12040'],
  technology:['https://techcrunch.com/feed/','https://www.theverge.com/rss/index.xml','https://feeds.arstechnica.com/arstechnica/index','https://www.wired.com/feed/rss'],
  movies:['https://variety.com/v/film/feed/','https://www.hollywoodreporter.com/c/movies/movie-news/feed/','https://www.indiewire.com/c/film/feed/'],
  global:['https://feeds.bbci.co.uk/news/world/rss.xml','https://feeds.reuters.com/reuters/topNews','https://rss.nytimes.com/services/xml/rss/nyt/World.xml','https://feeds.npr.org/1004/rss.xml']
};
const newsCache={};
function stripXmlTags(s){return (s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()}
function parseRSS(xml,sourceUrl){
  const items=[];let host='';try{host=new URL(sourceUrl).hostname.replace(/^www\./,'').split('.')[0]}catch(e){}
  const isAtom=xml.includes('<entry');
  const re=isAtom?/<entry[^>]*>([\s\S]*?)<\/entry>/gi:/<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while((m=re.exec(xml))!==null&&items.length<15){
    const block=m[1];
    const getTag=(t)=>{const r=block.match(new RegExp('<'+t+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+t+'>','i'));return r?stripXmlTags(r[1]):''};
    const getAttr=(tag,attr)=>{const r=block.match(new RegExp('<'+tag+'[^>]*\\s'+attr+'=["\']([^"\']+)["\']','i'));return r?r[1]:''};
    const title=getTag('title');
    let link=getTag('link');if(!link)link=getAttr('link','href');
    const desc=getTag('description')||getTag('summary')||getTag('content:encoded')||getTag('content');
    const date=getTag('pubDate')||getTag('published')||getTag('updated')||getTag('dc:date');
    let img=getAttr('media:content','url')||getAttr('media:thumbnail','url')||getAttr('enclosure','url');
    if(!img){const im=(block.match(/<img[^>]+src=["']([^"']+)["']/i));if(im)img=im[1]}
    if(title&&link)items.push({title:title.slice(0,200),link,desc:desc.slice(0,280),date,img:img||null,source:host});
  }
  return items;
}
async function fetchFeed(url){
  try{const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),9000);const r=await fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0 (+https://brodoit.com)','Accept':'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*'}});clearTimeout(t);if(!r.ok)return [];const x=await r.text();return parseRSS(x,url)}catch(e){return []}
}
app.get('/api/news',async(req,res)=>{
  const cat=(req.query.cat||'technology').toLowerCase();
  const feeds=NEWS_FEEDS[cat];
  if(!feeds)return res.json({items:[],cat});
  const c=newsCache[cat];
  if(c&&Date.now()-c.ts<15*60*1000)return res.json({items:c.items,cat,cached:true});
  const results=await Promise.all(feeds.map(fetchFeed));
  let all=results.flat();
  all.sort((a,b)=>{const da=new Date(a.date||0).getTime()||0,db=new Date(b.date||0).getTime()||0;return db-da});
  const seen=new Set();const dedup=[];
  for(const it of all){const k=(it.title||'').toLowerCase().slice(0,60);if(seen.has(k))continue;seen.add(k);dedup.push(it);if(dedup.length>=25)break}
  newsCache[cat]={ts:Date.now(),items:dedup};
  res.json({items:dedup,cat,cached:false});
});

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
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;background:#FAFAFC;color:#0F172A;min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}
/* Ambient mesh background (Classic theme only) */
body:not([data-theme=aurora])::before{content:'';position:fixed;inset:-100px;pointer-events:none;z-index:0;background:
  radial-gradient(680px 480px at 8% 12%,rgba(99,102,241,.13),transparent 65%),
  radial-gradient(560px 440px at 92% 18%,rgba(236,72,153,.09),transparent 65%),
  radial-gradient(620px 460px at 50% 108%,rgba(16,185,129,.08),transparent 65%);filter:blur(20px);animation:mesh-shift 24s ease-in-out infinite alternate}
@keyframes mesh-shift{0%{transform:translate(0,0)}50%{transform:translate(-24px,18px)}100%{transform:translate(18px,-22px)}}
button{cursor:pointer;border:none;background:none;font-family:inherit;color:inherit}
input,textarea,select{font-family:inherit;border:1.5px solid #E8E9EF;border-radius:12px;padding:13px 14px;font-size:15px;background:#fff;width:100%;color:#0F172A}
input:focus,textarea:focus{outline:none;border-color:#0F172A}textarea{resize:vertical;min-height:56px}select{-webkit-appearance:none;appearance:none}
.app{max-width:520px;margin:0 auto;padding:18px 18px 120px;position:relative;z-index:1}
.main-col{display:block}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:4px 2px}.logo{font-family:'Space Mono',monospace;font-size:30px;font-weight:700;letter-spacing:-.8px;line-height:1.1}.logo .k{color:#3DAE5C;display:inline-block;transition:transform .4s cubic-bezier(.4,1.5,.5,1)}.logo:hover .k{transform:scale(1.15) rotate(-6deg)}
.hdr-st{font-size:11px;font-weight:700;padding:8px 14px;border-radius:10px;background:#FFFFFF;border:1px solid #E8E9EF;display:flex;align-items:center;gap:7px;letter-spacing:.8px;box-shadow:0 2px 6px rgba(0,0,0,.04)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;animation:pulse-dot 2s ease-in-out infinite}
.hdr-sub{font-size:13px;color:#94A3B8;margin-top:2px;font-weight:500}
.moral{display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,#FFFFFF,#F5E6C4);border:1px solid #F3D9A0;border-radius:16px;padding:16px 18px;margin-bottom:14px;position:relative;overflow:hidden;box-shadow:0 2px 10px rgba(232,145,44,.06)}
.moral::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:linear-gradient(180deg,#E8912C,#3DAE5C)}
.moral-emoji{font-size:26px;flex-shrink:0;filter:drop-shadow(0 2px 4px rgba(232,145,44,.3))}.moral-body{flex:1;min-width:0}
.moral-lbl{font-size:10px;font-weight:700;color:#B57B00;text-transform:uppercase;letter-spacing:1.2px}
.moral-txt{font-size:15px;line-height:1.45;color:#0F172A;font-weight:600;margin-top:3px;letter-spacing:-.1px}
.moral-by{font-size:12px;color:#94A3B8;margin-top:4px;font-style:italic;font-weight:500}
.moral-ref{width:34px;height:34px;border-radius:50%;background:#FFFFFF;color:#B57B00;font-size:15px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid #F3D9A0;transition:all .3s cubic-bezier(.4,1.5,.5,1)}
.moral-ref:hover{background:#B57B00;color:#fff;transform:rotate(180deg) scale(1.1)}
.moral-ref:hover{transform:rotate(180deg);background:#0F172A;color:#F8FAFC}
@keyframes slideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.tabs{display:flex;gap:5px;background:#FFFFFF;border:1px solid #E8E9EF;border-radius:14px;padding:5px;margin-bottom:14px;overflow-x:auto;scrollbar-width:none;box-shadow:0 2px 8px rgba(45,42,38,.04)}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:0 0 auto;padding:12px 14px;border-radius:11px;font-size:13px;font-weight:600;color:#64748B;transition:all .18s cubic-bezier(.2,.8,.2,1);white-space:nowrap;display:inline-flex;align-items:center;gap:6px;position:relative}
.tab .ti{font-size:16px;line-height:1}
.tab .tl{font-weight:700;letter-spacing:.1px}
.tab:active{transform:scale(.95)}
.tab:hover:not(.on){background:#F8FAFC;color:#0F172A}
.tab.on{background:linear-gradient(135deg,#0F172A,#312E81);color:#F8FAFC;box-shadow:0 4px 14px rgba(45,42,38,.28);transform:translateY(-1px)}
.tab.on .ti{transform:scale(1.08)}
@media (max-width:600px){.tabs{padding:4px;gap:4px}.tab{padding:11px 12px;font-size:12px}.tab .ti{font-size:15px}.tab .tl{font-size:11.5px}}
/* Desktop sidebar layout */
@media (min-width:1024px){
  .app{max-width:1240px;padding:28px 36px 60px;display:grid;grid-template-columns:250px 1fr;grid-template-areas:"hdr hdr" "moral moral" "nav main";column-gap:32px;row-gap:20px}
  .app>.hdr{grid-area:hdr;margin-bottom:0}
  .app>.moral{grid-area:moral;margin-bottom:0}
  .app>.tabs.page-t{grid-area:nav;flex-direction:column;align-self:start;position:sticky;top:28px;padding:10px;gap:3px;overflow:visible;max-height:calc(100vh - 56px);margin-bottom:0}
  .app>.tabs.page-t .tab{width:100%;flex:0 0 auto;padding:14px 16px;font-size:14px;justify-content:flex-start;border-radius:12px}
  .app>.tabs.page-t .tab .ti{font-size:20px;margin-right:4px}
  .app>.tabs.page-t .tab .tl{font-size:14px}
  .app>.main-col{grid-area:main;min-width:0}
  .fab{display:none}
  /* Wider hero elements on desktop */
  .steps-hero{padding:26px;gap:28px}
  .steps-ring{width:170px;height:170px}
  .ring-v b{font-size:30px}
  .ring-v small{font-size:12px}
  .dash-grid{grid-template-columns:repeat(4,1fr);gap:14px}
  .dash-card{padding:20px}
  .dash-card .v{font-size:34px}
  .dash-hero{padding:28px}
  .dash-hero h2{font-size:22px}
  .dash-hero .big{font-size:64px}
  .board{padding:0;margin:0 0 20px;gap:14px}
  .col{flex:1 1 0;max-width:none;padding:16px}
  .col-body{max-height:70vh}
  .step-bars{height:180px;gap:10px}
  .sb-c{font-size:11px}.sb-d{font-size:12px}
  .logo{font-size:28px}
  .moral{padding:18px 20px}
  .moral-txt{font-size:16px}
  .moral-emoji{font-size:26px}
  .add-bar{padding:18px 20px}
  .add-bar .plus{width:44px;height:44px;font-size:28px}
  .add-bar .txt b{font-size:16px}
  .stats{grid-template-columns:repeat(4,1fr);gap:12px}
  .st{padding:14px 10px}
  .st b{font-size:26px}
  .st small{font-size:11px}
  .tc{padding:16px}
  .tc-t{font-size:16px}
  .cal-grid{padding:14px;gap:6px}
  .cal-day{font-size:15px}
}
@media (min-width:1400px){.app{max-width:1320px}}
/* Tablet: expand column, richer spacing, 3-col stats */
@media (min-width:700px) and (max-width:1023px){
  .app{max-width:720px;padding:24px 24px 100px}
  .dash-grid{grid-template-columns:repeat(4,1fr)}
  .dash-card{padding:18px}
  .dash-card .v{font-size:30px}
  .steps-hero{padding:26px}
  .steps-ring{width:170px;height:170px}
  .ring-v b{font-size:30px}
  .dash-hero{padding:28px}
  .dash-hero .big{font-size:60px}
  .logo{font-size:32px}
  .tab{padding:13px 16px;font-size:14px}
  .tab .ti{font-size:18px}
  .tab .tl{font-size:13px}
  .st b{font-size:26px}
  .step-bars{height:160px}
}
/* Extra tactile feedback */
button{transition:all .15s cubic-bezier(.2,.8,.2,1)}
input,textarea,select{transition:all .15s}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
/* News Shorts feed */
/* Listening streak card (Books tab) */
.streak-card{display:flex;align-items:center;gap:16px;padding:18px 20px;border-radius:18px;background:linear-gradient(135deg,#FFF7ED 0%,#FED7AA 100%);border:1px solid rgba(249,115,22,.25);margin-bottom:16px;box-shadow:0 4px 16px rgba(249,115,22,.1)}
.streak-ico{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#F97316,#EA580C);color:#fff;flex-shrink:0;box-shadow:0 4px 12px rgba(249,115,22,.35)}
.streak-body{flex:1;min-width:0}
.streak-n{font-family:'Space Mono',monospace;font-size:34px;font-weight:800;letter-spacing:-1px;color:#7C2D12;line-height:1}
.streak-n span{font-size:14px;font-weight:600;color:#9A3412;margin-left:4px;letter-spacing:0}
.streak-lbl{font-size:12px;font-weight:600;color:#9A3412;margin-top:3px;letter-spacing:.2px}
.streak-tot{text-align:center;flex-shrink:0;padding-left:16px;border-left:1px solid rgba(249,115,22,.3)}
.streak-tot b{font-family:'Space Mono',monospace;font-size:22px;font-weight:700;display:block;color:#7C2D12;line-height:1}
.streak-tot small{font-size:9px;color:#9A3412;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
body[data-theme=aurora] .streak-card{background:linear-gradient(135deg,rgba(249,115,22,.18),rgba(217,119,6,.12));border-color:rgba(251,146,60,.3);box-shadow:0 4px 20px rgba(249,115,22,.2)}
body[data-theme=aurora] .streak-n,body[data-theme=aurora] .streak-tot b{color:#FDBA74}
body[data-theme=aurora] .streak-n span,body[data-theme=aurora] .streak-lbl,body[data-theme=aurora] .streak-tot small{color:#FB923C}
body[data-theme=aurora] .streak-tot{border-left-color:rgba(251,146,60,.3)}
/* Section header (uniform across Books/Steps/Board/News tabs) */
.section-hd{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.section-ic{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:#0F172A;color:#fff;flex-shrink:0}
.section-hd h3{font-size:22px;font-weight:700;letter-spacing:-.5px;color:#0F172A;margin-bottom:2px}
.section-hd p{font-size:13px;color:#64748B}
body[data-theme=aurora] .section-ic{background:linear-gradient(135deg,#8B5CF6,#EC4899)}
body[data-theme=aurora] .section-hd h3{color:#F5F5FA}
body[data-theme=aurora] .section-hd p{color:#9999B5}
body[data-theme=aurora] .news-hero-ic{background:linear-gradient(135deg,#8B5CF6,#EC4899)}
body[data-theme=aurora] .news-hero h2{color:#F5F5FA}
.news-hero{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.news-hero-l{display:flex;align-items:center;gap:14px}
.news-hero-ic{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:#0F172A;color:#fff;flex-shrink:0}
.news-hero h2{font-size:22px;font-weight:700;letter-spacing:-.5px;margin-bottom:2px;color:#0F172A}
.news-hero p{font-size:13px;color:#64748B}
.news-refresh{width:42px;height:42px;border-radius:12px;background:#fff;border:1px solid #E8E9EF;color:#475569;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 12px rgba(15,23,42,.05);transition:all .25s ease}
.news-refresh:hover{border-color:#0F172A;color:#0F172A;background:#F8FAFC}
.news-refresh:active{transform:scale(.93)}
.flt-icons .fb{display:inline-flex;align-items:center;gap:6px}
.fb-ic{display:inline-flex;align-items:center;color:inherit;opacity:.85}
.news-feed{display:flex;flex-direction:column;gap:14px}
.news-card{background:#fff;border:1px solid rgba(15,23,42,.06);border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 14px rgba(15,23,42,.06);transition:all .25s cubic-bezier(.2,.8,.2,1)}
.news-card:hover{transform:translateY(-3px);box-shadow:0 6px 12px rgba(15,23,42,.06),0 16px 32px rgba(15,23,42,.1);border-color:rgba(99,102,241,.25)}
.news-img{display:block;position:relative;width:100%;height:200px;background-size:cover;background-position:center;background-color:#F1F5F9;text-decoration:none}
.news-img::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 50%,rgba(0,0,0,.4) 100%);pointer-events:none}
.news-src-chip{position:absolute;bottom:12px;left:12px;z-index:1;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);color:#6366F1;padding:5px 12px;border-radius:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.news-body{padding:16px 18px 18px}
.news-meta{display:flex;gap:10px;align-items:center;font-size:11px;color:#94A3B8;font-weight:700;margin-bottom:8px}
.news-src{color:#6366F1;background:#EEF2FF;padding:3px 10px;border-radius:7px;text-transform:uppercase;letter-spacing:.6px}
.news-time{font-weight:600;letter-spacing:0;text-transform:none;color:#94A3B8}
.news-title{font-size:17px;font-weight:700;line-height:1.35;letter-spacing:-.2px;margin-bottom:8px}
.news-title a{color:#0F172A;text-decoration:none}
.news-title a:hover{color:#6366F1}
.news-desc{font-size:14px;line-height:1.6;color:#64748B;margin-bottom:4px}
.news-acts{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid #F1F5F9}
.news-share{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:11px;background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff;font-size:13px;font-weight:700;box-shadow:0 4px 12px rgba(99,102,241,.3);cursor:pointer;border:none}
.news-share:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(99,102,241,.4)}
.news-share:active{transform:scale(.95)}
.news-read{color:#6366F1;font-size:13px;font-weight:700;text-decoration:none;transition:color .15s}
.news-read:hover{color:#EC4899;text-decoration:underline}
@media (max-width:600px){.news-img{height:170px}.news-title{font-size:16px}.news-desc{font-size:13.5px}.news-body{padding:14px 16px 16px}}
body[data-theme=aurora] .news-card{background:rgba(26,26,44,.7);border-color:rgba(255,255,255,.08);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
body[data-theme=aurora] .news-card:hover{border-color:rgba(167,139,250,.35)}
body[data-theme=aurora] .news-hero h2{color:#F5F5FA}
body[data-theme=aurora] .news-hero p{color:#9999B5}
body[data-theme=aurora] .news-refresh{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#A78BFA}
body[data-theme=aurora] .news-refresh:hover{background:#A78BFA;color:#0A0A14}
body[data-theme=aurora] .news-img{background-color:#15152A}
body[data-theme=aurora] .news-src-chip{background:rgba(10,10,20,.85);color:#A78BFA}
body[data-theme=aurora] .news-src{color:#A78BFA;background:rgba(167,139,250,.15)}
body[data-theme=aurora] .news-time{color:#7373A0}
body[data-theme=aurora] .news-title a{color:#F5F5FA}
body[data-theme=aurora] .news-title a:hover{color:#A78BFA}
body[data-theme=aurora] .news-desc{color:#9999B5}
body[data-theme=aurora] .news-acts{border-top-color:rgba(255,255,255,.06)}
body[data-theme=aurora] .news-read{color:#A78BFA}
body[data-theme=aurora] .news-read:hover{color:#F472B6}
body[data-theme=aurora] .news-share{background:linear-gradient(135deg,#A78BFA,#F472B6);box-shadow:0 4px 14px rgba(167,139,250,.35)}

/* ============================================== */
/* NEXT-GEN CLASSIC \u2014 modern indigo/violet system */
/* ============================================== */
body:not([data-theme=aurora]) .app{position:relative;z-index:1}
body:not([data-theme=aurora]) .logo{background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 50%,#EC4899 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 2px 10px rgba(79,70,229,.2))}
body:not([data-theme=aurora]) .logo .k{-webkit-text-fill-color:#EC4899}
body:not([data-theme=aurora]) .hdr-sub{color:#64748B;font-weight:500}
body:not([data-theme=aurora]) .hdr-st{background:#fff;border-color:#E8E9EF;color:#0F172A;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 12px rgba(15,23,42,.05)}
body:not([data-theme=aurora]) .tc,body:not([data-theme=aurora]) .st,body:not([data-theme=aurora]) .dash-card,body:not([data-theme=aurora]) .col,body:not([data-theme=aurora]) .kc,body:not([data-theme=aurora]) .user-bar,body:not([data-theme=aurora]) .cal-selected-box,body:not([data-theme=aurora]) .book-card,body:not([data-theme=aurora]) .insight,body:not([data-theme=aurora]) .calc-hist,body:not([data-theme=aurora]) .calc-screen{background:#fff;border-color:rgba(15,23,42,.06);box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 12px rgba(15,23,42,.06)}
body:not([data-theme=aurora]) .tc:hover,body:not([data-theme=aurora]) .st:hover,body:not([data-theme=aurora]) .dash-card:hover{box-shadow:0 4px 8px rgba(15,23,42,.06),0 12px 28px rgba(15,23,42,.1);border-color:rgba(99,102,241,.2)}
body:not([data-theme=aurora]) .moral{background:linear-gradient(135deg,#EEF2FF 0%,#FCE7F3 100%);border-color:rgba(99,102,241,.2);box-shadow:0 4px 16px rgba(99,102,241,.1)}
body:not([data-theme=aurora]) .moral-lbl{color:#6366F1}
body:not([data-theme=aurora]) .moral-ref{background:#fff;color:#6366F1;border-color:rgba(99,102,241,.3)}
body:not([data-theme=aurora]) .moral-ref:hover{background:#6366F1;color:#fff}
body:not([data-theme=aurora]) .tabs{background:#fff;border-color:#E8E9EF;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 12px rgba(15,23,42,.06)}
body:not([data-theme=aurora]) .tab{color:#64748B}
body:not([data-theme=aurora]) .tab:hover:not(.on){background:#F1F5F9;color:#0F172A}
body:not([data-theme=aurora]) .tab.on{background:#0F172A;color:#fff;box-shadow:0 2px 8px rgba(15,23,42,.2)}
body:not([data-theme=aurora]) .add-bar{background:linear-gradient(135deg,#6366F1 0%,#8B5CF6 60%,#EC4899 100%);box-shadow:0 8px 28px rgba(99,102,241,.35)}
body:not([data-theme=aurora]) .add-bar .plus{background:rgba(255,255,255,.2);color:#fff}
body:not([data-theme=aurora]) .fab{background:linear-gradient(135deg,#6366F1,#EC4899);box-shadow:0 10px 28px rgba(99,102,241,.45),0 0 0 8px rgba(99,102,241,.1);animation:fabPulseClassic 3.2s ease-in-out infinite}
@keyframes fabPulseClassic{0%,100%{box-shadow:0 10px 28px rgba(99,102,241,.45),0 0 0 8px rgba(99,102,241,.1)}50%{box-shadow:0 14px 34px rgba(236,72,153,.5),0 0 0 14px rgba(236,72,153,.08)}}
body:not([data-theme=aurora]) .steps-hero{background:linear-gradient(135deg,#FFFFFF 0%,#EEF2FF 60%,#FCE7F3 100%);border-color:rgba(99,102,241,.2);box-shadow:0 8px 32px rgba(99,102,241,.1)}
body:not([data-theme=aurora]) .steps-hero::before{background:radial-gradient(circle,rgba(99,102,241,.15) 0%,transparent 70%)}
body:not([data-theme=aurora]) .ring-v b{background:linear-gradient(135deg,#4F46E5,#EC4899);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
body:not([data-theme=aurora]) .sb-fill{background:linear-gradient(180deg,#8B5CF6,#6366F1)}
body:not([data-theme=aurora]) .sb-fill.met{background:linear-gradient(180deg,#34D399,#10B981);box-shadow:0 0 12px rgba(16,185,129,.35)}
body:not([data-theme=aurora]) .sb-fill.today{background:linear-gradient(180deg,#FBBF24,#F59E0B);box-shadow:0 0 12px rgba(245,158,11,.35)}
body:not([data-theme=aurora]) .sb-fill.today.met{background:linear-gradient(180deg,#34D399,#10B981)}
body:not([data-theme=aurora]) .btn-tr{background:linear-gradient(135deg,#10B981,#06B6D4);box-shadow:0 6px 18px rgba(6,182,212,.35)}
body:not([data-theme=aurora]) .btn-tr.stop{background:linear-gradient(135deg,#EF4444,#EC4899);box-shadow:0 6px 18px rgba(239,68,68,.35)}
body:not([data-theme=aurora]) .health-note{background:linear-gradient(135deg,#FEF3C7 0%,#FCE7F3 100%);border:1px solid rgba(245,158,11,.25);border-radius:16px;padding:18px 20px;margin-bottom:14px;box-shadow:0 4px 16px rgba(245,158,11,.08)}
body:not([data-theme=aurora]) .health-note .lbl{color:#B57B00;font-size:12px;font-weight:700;letter-spacing:.4px}
body:not([data-theme=aurora]) .fb{background:#fff;border-color:#E8E9EF;color:#64748B;box-shadow:0 1px 2px rgba(15,23,42,.04)}
body:not([data-theme=aurora]) .fb:hover{border-color:#6366F1;color:#6366F1}
body:not([data-theme=aurora]) .fb.on{background:linear-gradient(135deg,#6366F1,#EC4899);border-color:transparent;color:#fff;box-shadow:0 4px 14px rgba(99,102,241,.35)}
body:not([data-theme=aurora]) .dash-hero{background:linear-gradient(135deg,#6366F1 0%,#8B5CF6 50%,#EC4899 100%);box-shadow:0 12px 40px rgba(99,102,241,.25)}
body:not([data-theme=aurora]) .kc-mv{background:#F1F5F9;color:#475569}
body:not([data-theme=aurora]) .kc-mv:active{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff}
body:not([data-theme=aurora]) .col.over{background:#EEF2FF;border-color:#6366F1}
body:not([data-theme=aurora]) .live-ind{color:#10B981}
body:not([data-theme=aurora]) .pulse-d{background:#10B981;box-shadow:0 0 10px rgba(16,185,129,.5)}
body:not([data-theme=aurora]) .ai-badge{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff}
body:not([data-theme=aurora]) .cal-day.today{background:#ECFDF5;color:#10B981;border-color:rgba(16,185,129,.3)}
body:not([data-theme=aurora]) .cal-day.sel{background:linear-gradient(135deg,#6366F1,#EC4899)!important;color:#fff!important;border-color:transparent!important;box-shadow:0 4px 14px rgba(99,102,241,.35)}
body:not([data-theme=aurora]) .cal-nav:hover{background:#6366F1;color:#fff;border-color:#6366F1}
body:not([data-theme=aurora]) input:focus,body:not([data-theme=aurora]) textarea:focus,body:not([data-theme=aurora]) select:focus{border-color:#6366F1;box-shadow:0 0 0 4px rgba(99,102,241,.15)}
body:not([data-theme=aurora]) .book-play{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff;box-shadow:0 4px 12px rgba(99,102,241,.3)}
body:not([data-theme=aurora]) .ck.op{background:#EEF2FF;color:#6366F1}
body:not([data-theme=aurora]) .ck.eq{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff;box-shadow:0 3px 10px rgba(99,102,241,.3)}
body:not([data-theme=aurora]) .ck.sci{background:#ECFEFF;color:#06B6D4}
body:not([data-theme=aurora]) .ck.sp{background:#FEE2E2;color:#EF4444}
body:not([data-theme=aurora]) .calc-tgl button.on{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff}
body:not([data-theme=aurora]) .chk.on{background:linear-gradient(135deg,#10B981,#34D399);border-color:#10B981;box-shadow:0 2px 8px rgba(16,185,129,.35)}

/* ============================================== */
/* MOBILE BOTTOM TAB BAR \u2014 iOS/Fitness-style */
/* ============================================== */
@media (max-width:1023px){
  .app{padding-bottom:104px}
  .tabs.page-t{position:fixed;bottom:0;left:0;right:0;top:auto;padding:8px 6px calc(8px + env(safe-area-inset-bottom));margin:0;border-radius:0;border:none;border-top:1px solid rgba(15,23,42,.06);background:rgba(255,255,255,.92);backdrop-filter:saturate(160%) blur(20px);-webkit-backdrop-filter:saturate(160%) blur(20px);z-index:60;gap:2px;justify-content:space-between;box-shadow:0 -4px 24px rgba(15,23,42,.05);overflow-x:auto;scrollbar-width:none;max-height:none;align-items:stretch}
  .tabs.page-t::-webkit-scrollbar{display:none}
  body[data-theme=aurora] .tabs.page-t{background:rgba(14,14,28,.88);border-top-color:rgba(255,255,255,.08)}
  .tabs.page-t .tab{flex:1 1 0;flex-direction:column;padding:8px 2px 4px;min-width:58px;gap:2px;border-radius:14px;font-size:10px;font-weight:700;position:relative;transform:none}
  .tabs.page-t .tab .ti{font-size:22px;line-height:1;transition:transform .25s cubic-bezier(.4,1.5,.5,1);margin:0}
  .tabs.page-t .tab .tl{font-size:10px;line-height:1;letter-spacing:.1px;margin-top:2px;opacity:.9;font-weight:700}
  .tabs.page-t .tab.on{background:transparent!important;color:#6366F1!important;transform:none!important;box-shadow:none!important}
  body[data-theme=aurora] .tabs.page-t .tab.on{color:#A78BFA!important;background:transparent!important}
  .tabs.page-t .tab.on .ti{transform:translateY(-2px) scale(1.15)}
  .tabs.page-t .tab.on::before{content:'';position:absolute;top:-9px;left:35%;right:35%;height:3px;border-radius:0 0 4px 4px;background:linear-gradient(90deg,#6366F1,#EC4899)}
  body[data-theme=aurora] .tabs.page-t .tab.on::before{background:linear-gradient(90deg,#A78BFA,#F472B6)}
  .fab{bottom:calc(94px + env(safe-area-inset-bottom));right:18px;width:58px;height:58px;font-size:28px;z-index:55}
  .player{bottom:calc(80px + env(safe-area-inset-bottom))}
}

@media (max-width:600px){
  .steps-hero{padding:18px;gap:16px}
  .steps-ring{width:140px;height:140px}
  .ring-v b{font-size:24px}
  .dash-hero .big{font-size:46px}
  .logo{font-size:26px}
  .hdr-sub{font-size:12px}
  .hdr-st{padding:6px 11px;font-size:10px}
  .st b{font-size:22px}
  .dash-card .v{font-size:26px}
}

@keyframes bounceIn{0%{opacity:0;transform:scale(.9) translateY(10px)}60%{transform:scale(1.03) translateY(-2px)}100%{opacity:1;transform:scale(1) translateY(0)}}
/* (removed) per-card bounceIn \u2014 was replaying on every tab switch */

.hdr-actions{display:flex;align-items:center;gap:10px}
.theme-tg{width:38px;height:38px;border-radius:50%;background:#FFFFFF;border:1px solid #E8E9EF;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;transition:all .3s cubic-bezier(.4,1.5,.5,1);box-shadow:0 2px 8px rgba(0,0,0,.05)}
.theme-tg:hover{transform:rotate(25deg) scale(1.1);box-shadow:0 4px 14px rgba(0,0,0,.1)}
.theme-tg:active{transform:scale(.92)}

/* ============================================== */
/* AURORA THEME \u2014 modern dark with gradient accents */
/* ============================================== */
body[data-theme=aurora]{background:#0A0A14;color:#E8E8F4}
body[data-theme=aurora]::before{content:'';position:fixed;inset:-60px;background:
  radial-gradient(600px 400px at 10% 10%,rgba(139,92,246,.25),transparent 60%),
  radial-gradient(520px 380px at 90% 20%,rgba(236,72,153,.18),transparent 60%),
  radial-gradient(580px 420px at 50% 100%,rgba(6,182,212,.18),transparent 60%);
  pointer-events:none;z-index:0;animation:aurora-drift 20s ease-in-out infinite alternate;filter:blur(40px)}
@keyframes aurora-drift{0%{transform:translate(0,0) scale(1)}50%{transform:translate(-30px,20px) scale(1.05)}100%{transform:translate(20px,-30px) scale(.98)}}
body[data-theme=aurora] .app{position:relative;z-index:1}
/* Typography */
body[data-theme=aurora] .logo{color:#F5F5FA;background:linear-gradient(135deg,#A78BFA,#F472B6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 2px 16px rgba(167,139,250,.3))}
body[data-theme=aurora] .logo .k{color:#F472B6;-webkit-text-fill-color:#F472B6}
body[data-theme=aurora] .hdr-sub{color:#9999B5}
/* Cards (glassmorphic) */
body[data-theme=aurora] .moral,body[data-theme=aurora] .user-bar,body[data-theme=aurora] .tc,body[data-theme=aurora] .st,body[data-theme=aurora] .dash-card,body[data-theme=aurora] .col,body[data-theme=aurora] .kc,body[data-theme=aurora] .tabs,body[data-theme=aurora] .hdr-st,body[data-theme=aurora] .cal-grid,body[data-theme=aurora] .cal-selected-box,body[data-theme=aurora] .calc-screen,body[data-theme=aurora] .book-card,body[data-theme=aurora] .insight,body[data-theme=aurora] .calc-hist{
  background:rgba(26,26,44,.65);border-color:rgba(255,255,255,.08);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:#E8E8F4
}
body[data-theme=aurora] .moral{background:linear-gradient(135deg,rgba(139,92,246,.18),rgba(236,72,153,.12));border-color:rgba(167,139,250,.3);box-shadow:0 4px 24px rgba(139,92,246,.15)}
body[data-theme=aurora] .moral-lbl{color:#A78BFA}
body[data-theme=aurora] .moral-txt{color:#F5F5FA}
body[data-theme=aurora] .moral-by{color:#9999B5}
body[data-theme=aurora] .moral-ref{background:rgba(167,139,250,.15);color:#A78BFA;border-color:rgba(167,139,250,.3)}
body[data-theme=aurora] .moral-ref:hover{background:#A78BFA;color:#0A0A14}
/* Tabs */
body[data-theme=aurora] .tab{color:#9999B5}
body[data-theme=aurora] .tab:hover:not(.on){background:rgba(255,255,255,.04);color:#F5F5FA}
body[data-theme=aurora] .tab.on{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff;box-shadow:0 6px 20px rgba(139,92,246,.45),0 0 0 1px rgba(255,255,255,.08)}
/* Buttons */
body[data-theme=aurora] .add-bar{background:linear-gradient(135deg,#8B5CF6 0%,#EC4899 100%);box-shadow:0 8px 28px rgba(139,92,246,.4)}
body[data-theme=aurora] .add-bar .plus{background:rgba(255,255,255,.2);color:#fff;box-shadow:0 3px 12px rgba(255,255,255,.1)}
body[data-theme=aurora] .fab{background:linear-gradient(135deg,#8B5CF6,#EC4899);box-shadow:0 10px 30px rgba(139,92,246,.5),0 0 0 8px rgba(139,92,246,.12);animation:fabPulseAurora 3s ease-in-out infinite}
@keyframes fabPulseAurora{0%,100%{box-shadow:0 10px 30px rgba(139,92,246,.5),0 0 0 8px rgba(139,92,246,.12)}50%{box-shadow:0 14px 36px rgba(236,72,153,.6),0 0 0 16px rgba(236,72,153,.08)}}
body[data-theme=aurora] .btn-tr{background:linear-gradient(135deg,#10B981,#06B6D4);box-shadow:0 6px 20px rgba(6,182,212,.4)}
body[data-theme=aurora] .btn-tr.stop{background:linear-gradient(135deg,#F43F5E,#EC4899);box-shadow:0 6px 20px rgba(244,63,94,.4)}
body[data-theme=aurora] .btn-log{background:rgba(255,255,255,.05);color:#E8E8F4;border-color:rgba(255,255,255,.12)}
body[data-theme=aurora] .btn-log:hover{background:rgba(255,255,255,.1);border-color:rgba(167,139,250,.4)}
/* Task cards */
body[data-theme=aurora] .tc-t{color:#F5F5FA}
body[data-theme=aurora] .tc-n,body[data-theme=aurora] .tc-m{color:#9999B5}
body[data-theme=aurora] .chk{border-color:rgba(255,255,255,.2)}
body[data-theme=aurora] .chk:hover{border-color:#10B981}
body[data-theme=aurora] .chk.on{background:#10B981;border-color:#10B981;box-shadow:0 0 16px rgba(16,185,129,.5)}
body[data-theme=aurora] .badge{background:rgba(255,255,255,.08)!important;color:#E8E8F4!important}
/* Stats strip */
body[data-theme=aurora] .st b{color:#F5F5FA}
body[data-theme=aurora] .st small{color:#7373A0}
/* Dash hero */
body[data-theme=aurora] .dash-hero{background:linear-gradient(135deg,#8B5CF6 0%,#EC4899 50%,#06B6D4 100%);box-shadow:0 12px 40px rgba(139,92,246,.3)}
body[data-theme=aurora] .dash-card .v{color:#F5F5FA}
body[data-theme=aurora] .dash-card .lbl{color:#A78BFA}
body[data-theme=aurora] .dash-card .sub{color:#9999B5}
/* Inputs */
body[data-theme=aurora] input,body[data-theme=aurora] textarea,body[data-theme=aurora] select{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:#F5F5FA}
body[data-theme=aurora] input::placeholder,body[data-theme=aurora] textarea::placeholder{color:#6F6F95}
body[data-theme=aurora] input:focus,body[data-theme=aurora] textarea:focus,body[data-theme=aurora] select:focus{border-color:#A78BFA;box-shadow:0 0 0 3px rgba(167,139,250,.2)}
/* Filter pills */
body[data-theme=aurora] .fb{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:#9999B5}
body[data-theme=aurora] .fb:hover{border-color:#A78BFA;color:#F5F5FA}
body[data-theme=aurora] .fb.on{background:linear-gradient(135deg,#8B5CF6,#EC4899);border-color:transparent;color:#fff;box-shadow:0 4px 16px rgba(139,92,246,.4)}
/* Steps ring + hero */
body[data-theme=aurora] .steps-hero{background:linear-gradient(135deg,rgba(139,92,246,.15),rgba(6,182,212,.1));border-color:rgba(167,139,250,.25);box-shadow:0 8px 32px rgba(139,92,246,.15)}
body[data-theme=aurora] .steps-hero::before{background:radial-gradient(circle,rgba(167,139,250,.2) 0%,transparent 70%)}
body[data-theme=aurora] .steps-ring svg circle:first-child{stroke:rgba(255,255,255,.08)}
body[data-theme=aurora] .ring-v b{color:#F5F5FA;background:linear-gradient(135deg,#A78BFA,#F472B6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
body[data-theme=aurora] .ring-v small{color:#9999B5}
body[data-theme=aurora] .steps-main h2{color:#F5F5FA}
body[data-theme=aurora] .pct-lbl{color:#9999B5}
body[data-theme=aurora] .sb-bar{background:rgba(255,255,255,.05)}
body[data-theme=aurora] .sb-fill{background:linear-gradient(180deg,#A78BFA,#8B5CF6)}
body[data-theme=aurora] .sb-fill.met{background:linear-gradient(180deg,#34D399,#10B981);box-shadow:0 0 12px rgba(16,185,129,.4)}
body[data-theme=aurora] .sb-fill.today{background:linear-gradient(180deg,#FBBF24,#F59E0B);box-shadow:0 0 12px rgba(245,158,11,.4)}
body[data-theme=aurora] .sb-fill.today.met{background:linear-gradient(180deg,#34D399,#10B981)}
body[data-theme=aurora] .sb-c{color:#9999B5}
body[data-theme=aurora] .sb-d{color:#7373A0}
body[data-theme=aurora] .sb-d.today{color:#FBBF24}
body[data-theme=aurora] .live-ind{color:#34D399}
body[data-theme=aurora] .pulse-d{background:#34D399;box-shadow:0 0 12px rgba(52,211,153,.6)}
/* Calendar */
body[data-theme=aurora] .cal-day{color:#E8E8F4}
body[data-theme=aurora] .cal-day:hover{background:rgba(255,255,255,.05);border-color:rgba(167,139,250,.3)}
body[data-theme=aurora] .cal-day.other{color:#4A4A6E}
body[data-theme=aurora] .cal-day.today{background:rgba(16,185,129,.15);color:#34D399;border-color:rgba(16,185,129,.4)}
body[data-theme=aurora] .cal-day.sel{background:linear-gradient(135deg,#8B5CF6,#EC4899)!important;color:#fff!important;border-color:transparent!important;box-shadow:0 4px 16px rgba(139,92,246,.4)}
body[data-theme=aurora] .cal-dow{color:#7373A0}
body[data-theme=aurora] .cal-nav{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:#E8E8F4}
body[data-theme=aurora] .cal-nav:hover{background:#A78BFA;color:#0A0A14}
body[data-theme=aurora] .cal-selected-box h4{color:#F5F5FA}
body[data-theme=aurora] .muted,body[data-theme=aurora] .cal-selected-box .muted{color:#9999B5}
/* Books + Calc */
body[data-theme=aurora] .book-title{color:#F5F5FA}
body[data-theme=aurora] .book-author,body[data-theme=aurora] .book-meta{color:#9999B5}
body[data-theme=aurora] .book-play{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff}
body[data-theme=aurora] .calc-result{color:#F5F5FA}
body[data-theme=aurora] .calc-expr{color:#7373A0}
body[data-theme=aurora] .ck{background:rgba(255,255,255,.04);color:#E8E8F4;border-color:rgba(255,255,255,.06)}
body[data-theme=aurora] .ck:hover{background:rgba(255,255,255,.08)}
body[data-theme=aurora] .ck.op{background:rgba(139,92,246,.15);color:#A78BFA}
body[data-theme=aurora] .ck.eq{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff}
body[data-theme=aurora] .ck.sci{background:rgba(6,182,212,.12);color:#06B6D4}
body[data-theme=aurora] .ck.sp{background:rgba(244,63,94,.12);color:#F43F5E}
body[data-theme=aurora] .calc-tgl button{background:rgba(255,255,255,.05);color:#9999B5;border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .calc-tgl button.on{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff}
body[data-theme=aurora] .smart-hint{background:rgba(139,92,246,.1);border-color:rgba(167,139,250,.2);color:#C4B5FD}
body[data-theme=aurora] .calc-input-row input{background:rgba(255,255,255,.04);color:#F5F5FA;border-color:rgba(255,255,255,.1)}
/* Kanban */
body[data-theme=aurora] .col-h h3{color:#F5F5FA}
body[data-theme=aurora] .col-h .cnt{background:rgba(255,255,255,.08);color:#E8E8F4}
body[data-theme=aurora] .col-empty{color:#4A4A6E;border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .col.over{background:rgba(167,139,250,.12);border-color:#A78BFA}
body[data-theme=aurora] .kc{background:rgba(10,10,20,.7)}
body[data-theme=aurora] .kc-t{color:#F5F5FA}
body[data-theme=aurora] .kc-mv{background:rgba(255,255,255,.06);color:#E8E8F4}
body[data-theme=aurora] .kc-mv:active{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff}
/* Modals */
body[data-theme=aurora] .ov{background:rgba(10,10,20,.75);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
body[data-theme=aurora] .mdl{background:#15152A;border:1px solid rgba(255,255,255,.1);color:#F5F5FA}
body[data-theme=aurora] .lbl{color:#A78BFA}
body[data-theme=aurora] .mb-c{background:rgba(255,255,255,.05);color:#E8E8F4;border-color:rgba(255,255,255,.1)}
body[data-theme=aurora] .mb-s{background:linear-gradient(135deg,#8B5CF6,#EC4899)}
body[data-theme=aurora] .mb-d{background:linear-gradient(135deg,#F43F5E,#EC4899)}
/* Toast + player */
body[data-theme=aurora] .toast-ok{background:rgba(16,185,129,.15);color:#34D399;border-color:rgba(16,185,129,.3)}
body[data-theme=aurora] .toast-err{background:rgba(244,63,94,.15);color:#FB7185;border-color:rgba(244,63,94,.3)}
body[data-theme=aurora] .player{background:linear-gradient(135deg,#15152A,#1F1F3A);border-top:1px solid rgba(167,139,250,.2)}
body[data-theme=aurora] .hdr-st{background:rgba(255,255,255,.04);color:#E8E8F4}
body[data-theme=aurora] .theme-tg{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:#F5F5FA}
body[data-theme=aurora] .theme-tg:hover{background:rgba(167,139,250,.15);border-color:#A78BFA}
/* Alert banners */
body[data-theme=aurora] .al{background:rgba(16,185,129,.12)!important;border-color:rgba(16,185,129,.3)!important;color:#34D399!important}
/* AI badge */
body[data-theme=aurora] .ai-badge{background:linear-gradient(135deg,#A78BFA,#F472B6);color:#fff}
body[data-theme=aurora] .goal-row input{background:rgba(255,255,255,.06);color:#F5F5FA;border-color:rgba(255,255,255,.15)}
body[data-theme=aurora] .srch input{background:rgba(255,255,255,.05);color:#F5F5FA;border:1px solid rgba(255,255,255,.1)}
/* Entrance animations (both themes) */
/* (removed) cardPop entrance \u2014 was replaying on every render */
@keyframes cardPop{0%{opacity:0;transform:translateY(10px) scale(.98)}100%{opacity:1;transform:translateY(0) scale(1)}}
/* (removed) main-col fadeInUp \u2014 caused flicker on every tab switch */
@keyframes fadeInUp{0%{opacity:0;transform:translateY(12px)}100%{opacity:1;transform:translateY(0)}}
/* Number gradient shimmer on Aurora hero */
body[data-theme=aurora] .dash-hero .big{background:linear-gradient(90deg,#fff,#F0ABFC,#fff);background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 4s linear infinite}
/* Kanban Board */
.board-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:0 2px}
.board-hd h3{font-family:'Space Mono',monospace;font-size:15px;font-weight:700}
.board-hd .hint{font-size:11px;color:#94A3B8}
.board{display:flex;gap:10px;overflow-x:auto;padding-bottom:14px;margin:0 -16px 14px;padding-left:16px;padding-right:16px;scroll-snap-type:x mandatory;scrollbar-width:none}
.board::-webkit-scrollbar{display:none}
.col{flex:0 0 82%;max-width:340px;background:#FFFFFF;border:1px solid #E8E9EF;border-radius:14px;padding:12px;scroll-snap-align:start;display:flex;flex-direction:column;min-height:340px;transition:background .15s,border-color .15s}
.col.over{background:#FFF8EE;border-color:#E8912C;border-style:dashed}
.col-h{display:flex;align-items:center;justify-content:space-between;padding:0 2px 9px;border-bottom:1px solid #F1F5F9;margin-bottom:9px}
.col-h h3{font-family:'Space Mono',monospace;font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:.5px}
.col-h .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.col-h .cnt{background:#F8FAFC;color:#64748B;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;min-width:22px;text-align:center}
.col-body{flex:1;overflow-y:auto;max-height:60vh;padding:2px}
.col-empty{text-align:center;padding:24px 10px;color:#CBD5E1;font-size:11px;border:1.5px dashed #E8E9EF;border-radius:10px}
.kc{background:#fff;border-radius:10px;padding:10px 11px;border:1px solid #E8E9EF;border-left:3px solid;margin-bottom:7px;cursor:grab;user-select:none;transition:transform .12s,box-shadow .12s}
.kc:hover{box-shadow:0 2px 10px rgba(0,0,0,.06);transform:translateY(-1px)}
.kc.drag{opacity:.4;cursor:grabbing;transform:rotate(-1deg)}
.kc-t{font-size:13px;font-weight:600;line-height:1.3;word-break:break-word;color:#0F172A}
.kc-m{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center;font-size:10px;color:#94A3B8}
.kc-m .pri{padding:1px 6px;border-radius:8px;font-weight:700;color:#fff;text-transform:uppercase;font-size:9px;letter-spacing:.3px}
.kc-m .due{font-weight:600}
.kc-acts{display:flex;gap:4px;margin-top:7px;flex-wrap:wrap}
.kc-mv{font-size:10px;padding:3px 8px;border-radius:6px;background:#F8FAFC;color:#64748B;font-weight:600;border:1px solid transparent;transition:all .1s}
.kc-mv:active{background:#0F172A;color:#fff}
@media (min-width: 700px){.board{padding-left:0;padding-right:0;margin:0 0 14px}.col{flex:1 1 0;max-width:none}}
/* Steps */
.steps-hero{display:flex;gap:20px;background:linear-gradient(135deg,#FFFFFF 0%,#FFF8EE 100%);border:1px solid #F3D9A0;border-radius:18px;padding:22px;margin-bottom:16px;align-items:center;flex-wrap:wrap;box-shadow:0 4px 20px rgba(232,145,44,.08);position:relative;overflow:hidden}
.steps-hero::before{content:'';position:absolute;top:-40px;right:-40px;width:180px;height:180px;background:radial-gradient(circle,rgba(61,174,92,.12) 0%,transparent 70%);pointer-events:none}
.steps-ring{position:relative;width:150px;height:150px;flex-shrink:0;filter:drop-shadow(0 6px 14px rgba(61,174,92,.15))}
.steps-ring svg{width:100%;height:100%}
.ring-v{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none}
.ring-v b{font-family:'Space Mono',monospace;font-size:26px;font-weight:700;color:#0F172A;line-height:1}
.ring-v small{font-size:11px;color:#94A3B8;margin-top:4px;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.steps-main{flex:1;min-width:200px;position:relative;z-index:1}
.steps-main h2{font-family:'Space Mono',monospace;font-size:19px;margin-bottom:4px;font-weight:700}
.pct-lbl{font-size:13px;color:#64748B;margin-bottom:12px;font-weight:500}
.btn-tr{background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;padding:12px 18px;border-radius:11px;font-size:14px;font-weight:700;margin-right:7px;margin-bottom:7px;display:inline-flex;align-items:center;gap:7px;box-shadow:0 4px 12px rgba(61,174,92,.3);transition:all .2s cubic-bezier(.2,.8,.2,1)}
.btn-tr:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(61,174,92,.4)}
.btn-tr:active{transform:translateY(0) scale(.97)}
.btn-tr.stop{background:linear-gradient(135deg,#E8453C,#C8372E);box-shadow:0 4px 12px rgba(232,69,60,.3)}
.btn-tr.stop:hover{box-shadow:0 6px 18px rgba(232,69,60,.4)}
.btn-log{background:#FFFFFF;color:#0F172A;padding:12px 18px;border-radius:11px;font-size:14px;font-weight:700;border:1.5px solid #CBD5E1;display:inline-flex;align-items:center;gap:7px;transition:all .18s}
.btn-log:hover{background:#F8FAFC;border-color:#0F172A;transform:translateY(-1px)}
.btn-log:active{transform:scale(.97)}
.live-ind{display:flex;align-items:center;gap:6px;font-size:12px;color:#3DAE5C;font-weight:700;margin-bottom:10px}
.pulse-d{width:9px;height:9px;border-radius:50%;background:#3DAE5C;animation:pulse-dot 1.4s ease-in-out infinite}
@keyframes pulse-dot{0%,100%{transform:scale(.9);opacity:.6}50%{transform:scale(1.25);opacity:1}}
.step-bars{display:flex;gap:5px;align-items:flex-end;height:130px;margin-top:10px;padding:0 4px}
.sb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.sb-bar{flex:1;width:100%;background:#F1F5F9;border-radius:5px;display:flex;align-items:flex-end;overflow:hidden;min-height:4px}
.sb-fill{width:100%;background:#3B82F6;border-radius:5px 5px 0 0;transition:height .4s cubic-bezier(.2,.8,.2,1);min-height:2px}
.sb-fill.met{background:#3DAE5C}
.sb-fill.today{background:#E8912C;box-shadow:0 0 0 2px rgba(232,145,44,.15)}
.sb-fill.today.met{background:#3DAE5C}
.sb-c{font-size:9px;color:#94A3B8;font-weight:600;font-family:'Space Mono',monospace;line-height:1}
.sb-d{font-size:10px;color:#64748B;font-weight:700}
.sb-d.today{color:#E8912C}
.goal-row{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #F1F5F9;font-size:12px;color:#64748B}
.goal-row input{width:90px;padding:5px 8px;border-radius:7px;border:1px solid #CBD5E1;font-size:12px;text-align:center;background:#fff}
/* Calendar */
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:0 4px}
.cal-head h3{font-family:'Space Mono',monospace;font-size:17px;font-weight:700}
.cal-nav{width:34px;height:34px;border-radius:50%;background:#FFFFFF;border:1px solid #E8E9EF;color:#0F172A;font-size:16px;transition:background .15s;display:inline-flex;align-items:center;justify-content:center}
.cal-nav:hover{background:#0F172A;color:#F8FAFC}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;padding:10px;margin-bottom:12px}
.cal-dow{font-size:10px;color:#94A3B8;text-align:center;padding:4px 0;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.cal-day{aspect-ratio:1;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:13px;font-weight:600;cursor:pointer;background:transparent;border:1.5px solid transparent;color:#0F172A;position:relative;transition:all .15s}
.cal-day:hover{background:#F8FAFC;border-color:#CBD5E1}
.cal-day.other{color:#CBD5E1}
.cal-day.today{background:#EDFCF2;color:#1A9E47;border-color:#B7E8C4;font-weight:800}
.cal-day.sel{background:#0F172A!important;color:#F8FAFC!important;border-color:#0F172A!important}
.cal-day .ind{display:flex;gap:2px;margin-top:2px;align-items:center;height:5px}
.cal-day .ind i{width:4px;height:4px;border-radius:50%;display:inline-block}
.cal-selected-box{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;padding:14px;margin-bottom:12px}
.cal-selected-box h4{font-family:'Space Mono',monospace;font-size:15px;margin-bottom:8px}
.cal-selected-box .muted{font-size:12px;color:#94A3B8;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:16px}
.st{background:#FFFFFF;border-radius:14px;padding:14px 6px;text-align:center;border:1px solid #E8E9EF;transition:all .2s cubic-bezier(.2,.8,.2,1);cursor:default}
.st:hover{transform:translateY(-3px);box-shadow:0 6px 16px rgba(0,0,0,.06);border-color:#CBD5E1}
.st b{font-family:'Space Mono',monospace;font-size:24px;display:block;color:#0F172A;line-height:1.1;letter-spacing:-.5px}
.st small{font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-top:4px;display:block}
.al{border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:10px;text-align:center}
.srch{margin-bottom:14px}.srch input{background:#FFFFFF;padding:13px 16px;font-size:15px;border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.03);transition:all .18s}.srch input:focus{box-shadow:0 4px 12px rgba(0,0,0,.08)}
.flt{display:flex;gap:7px;margin-bottom:16px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}.flt::-webkit-scrollbar{display:none}.fb{padding:9px 17px;border-radius:22px;border:1.5px solid #E8E9EF;background:#FFFFFF;font-size:13px;font-weight:700;color:#64748B;white-space:nowrap;transition:all .18s cubic-bezier(.2,.8,.2,1);letter-spacing:-.1px}.fb:hover{border-color:#0F172A;color:#0F172A;transform:translateY(-1px)}.fb:active{transform:scale(.95)}.fb.on{background:linear-gradient(135deg,#0F172A,#312E81);color:#F8FAFC;border-color:#0F172A;box-shadow:0 3px 10px rgba(45,42,38,.2)}
.bwa{width:100%;padding:10px;border-radius:10px;border:1px solid #25D366;background:#EDFCF2;color:#1A9E47;font-size:13px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px}
.tc{background:#FFFFFF;border-radius:14px;padding:16px;border:1px solid #E8E9EF;border-left:5px solid;margin-bottom:10px;transition:all .2s cubic-bezier(.2,.8,.2,1)}.tc:hover{transform:translateX(3px);box-shadow:0 4px 14px rgba(0,0,0,.05)}.tc.dn{opacity:.55}
.tc-top{display:flex;gap:14px;align-items:flex-start}.chk{width:28px;height:28px;min-width:28px;border-radius:8px;border:2.5px solid #CBD5E1;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent;transition:all .2s cubic-bezier(.4,1.5,.5,1);cursor:pointer}.chk:hover{border-color:#3DAE5C;transform:scale(1.1)}.chk.on{background:#3DAE5C;border-color:#3DAE5C}.chk:active{transform:scale(.9)}
.tc-t{font-size:16px;font-weight:600;line-height:1.4;word-break:break-word;color:#0F172A;letter-spacing:-.1px}.tc-t.dn{text-decoration:line-through;color:#94A3B8}
.tc-n{font-size:13px;color:#64748B;margin-top:2px}.tc-m{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;align-items:center}
.badge{padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase}
.tc-acts{display:flex;justify-content:flex-end;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid #F1F5F9}
.ib{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#94A3B8}.ib:active{background:#F8FAFC;transform:scale(.9)}
.fab{position:fixed;bottom:26px;right:26px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(61,174,92,.4),0 0 0 6px rgba(61,174,92,.1);z-index:50;font-size:32px;font-weight:400;transition:all .2s cubic-bezier(.2,.8,.2,1)}
.fab:hover{transform:scale(1.1) rotate(90deg);box-shadow:0 12px 32px rgba(61,174,92,.5)}
.fab:active{transform:scale(.95)}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:100}
.mdl{background:#FFFFFF;border-radius:18px 18px 0 0;padding:20px 18px 32px;width:100%;max-width:480px;max-height:85vh;overflow-y:auto}
.mdl h2{font-family:'Space Mono',monospace;font-size:18px;margin-bottom:14px}
.lbl{font-size:11px;font-weight:700;color:#94A3B8;margin:12px 0 4px;display:block;text-transform:uppercase;letter-spacing:.5px}
.row{display:flex;gap:10px}.row>div{flex:1}.macts{display:flex;gap:10px;margin-top:18px}
.mb{flex:1;padding:12px;border-radius:10px;font-size:15px;font-weight:600;text-align:center}.mb-c{border:1.5px solid #CBD5E1;color:#64748B}.mb-s{background:#0F172A;color:#F8FAFC}.mb-d{background:#E8453C;color:#fff;margin-top:10px;width:100%}
.empty{text-align:center;padding:40px 20px;color:#94A3B8}
.loading{text-align:center;padding:30px;color:#94A3B8;font-size:13px}
.toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.08);border:1px solid}
.toast-ok{background:#F2FBF4;border-color:#B7E8C4;color:#2D8A4E}.toast-err{background:#FEF1F0;border-color:#F5C6C2;color:#E8453C}
.login{max-width:460px;margin:0 auto;padding:40px 28px;text-align:center;min-height:100vh;display:flex;flex-direction:column;justify-content:center}
.login-logo{font-family:'Space Mono',monospace;font-size:48px;font-weight:700;margin-bottom:8px;letter-spacing:-1px}.login-logo .k{color:#3DAE5C}
.login-sub{font-size:16px;color:#64748B;margin-bottom:28px;line-height:1.5;font-weight:500}
.login-features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:8px 0 28px}
.login-feature{padding:18px 8px;border-radius:18px;background:#FFFFFF;border:1.5px solid #EEF2F7;transition:transform .2s ease,box-shadow .2s ease}
.login-feature:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(15,23,42,.06)}
.login-feature .lf-ic{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:28px;color:#fff}
.login-feature .lf-ic.tasks{background:linear-gradient(135deg,#3DAE5C,#2D8A4E);box-shadow:0 8px 20px rgba(61,174,92,.32)}
.login-feature .lf-ic.books{background:linear-gradient(135deg,#7C3AED,#A855F7);box-shadow:0 8px 20px rgba(124,58,237,.32)}
.login-feature .lf-ic.wisdom{background:linear-gradient(135deg,#E8912C,#F59E0B);box-shadow:0 8px 20px rgba(232,145,44,.32)}
.login-feature .lf-lbl{font-size:13px;font-weight:700;color:#0F172A}
.login-feature .lf-sub{font-size:11px;color:#94A3B8;margin-top:2px}
@keyframes featIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.login-feature{animation:featIn .5s ease backwards}
.login-feature:nth-child(1){animation-delay:.05s}.login-feature:nth-child(2){animation-delay:.15s}.login-feature:nth-child(3){animation-delay:.25s}
.login input{margin-bottom:12px;text-align:center;font-size:18px;letter-spacing:1px;padding:14px}
.login-btn{width:100%;padding:14px;font-size:16px;border-radius:12px;font-weight:700;background:#0F172A;color:#F8FAFC;border:none;margin-top:4px}
.login-btn:disabled{opacity:.5}.login-btn.sec{background:transparent;border:1.5px solid #CBD5E1;color:#64748B;margin-top:8px}
.login-hint{font-size:12px;color:#94A3B8;margin-top:16px;line-height:1.5}
.otp-inputs{display:flex;gap:8px;justify-content:center;margin:16px 0}
.otp-inputs input{width:44px;height:52px;text-align:center;font-size:22px;font-family:'Space Mono',monospace;font-weight:700;padding:0;border-radius:10px}
.user-bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;margin-bottom:14px;font-size:14px;font-weight:600;transition:all .18s;box-shadow:0 2px 8px rgba(0,0,0,.03)}
.user-bar:hover{border-color:#CBD5E1;box-shadow:0 4px 12px rgba(0,0,0,.06)}
.user-bar button{font-size:13px;color:#E8453C;font-weight:700;padding:6px 12px;border-radius:8px;transition:all .15s}
.user-bar button:hover{background:#FEF1F0}
.step-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}.step-dot{width:8px;height:8px;border-radius:50%;background:#CBD5E1}.step-dot.on{background:#0F172A}
.voice-lg{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:30px;border:2px solid #CBD5E1;background:#F8FAFC;font-size:13px;color:#64748B;font-weight:600;transition:all .2s}
.voice-lg.rec{border-color:#E8453C;background:#FEF1F0;color:#E8453C;animation:recPulse 1.5s infinite}
@keyframes recPulse{0%{box-shadow:0 0 0 0 rgba(232,69,60,.4)}70%{box-shadow:0 0 0 10px rgba(232,69,60,0)}100%{box-shadow:0 0 0 0 rgba(232,69,60,0)}}
.vw{display:inline-flex;gap:2px;align-items:center}.vw span{width:3px;background:currentColor;border-radius:2px;animation:wave 1s infinite ease}
.vw span:nth-child(1){height:6px}.vw span:nth-child(2){height:12px;animation-delay:.1s}.vw span:nth-child(3){height:8px;animation-delay:.2s}.vw span:nth-child(4){height:14px;animation-delay:.3s}
@keyframes wave{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1)}}
.book-list{display:grid;gap:10px}
.book-card{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;padding:12px;display:flex;gap:12px;align-items:flex-start;transition:transform .15s}
.book-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.book-cover{width:56px;height:78px;border-radius:6px;background:linear-gradient(135deg,#E8912C,#3DAE5C);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:10px;padding:4px;text-align:center}
.book-cover img{width:100%;height:100%;object-fit:cover}
.book-info{flex:1;min-width:0}.book-title{font-size:14px;font-weight:700;line-height:1.3;margin-bottom:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.book-author{font-size:12px;color:#64748B;margin-bottom:6px}
.book-meta{font-size:11px;color:#94A3B8;display:flex;gap:8px;flex-wrap:wrap}
.book-play{width:36px;height:36px;border-radius:50%;background:#0F172A;color:#F8FAFC;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:center;transition:transform .15s}
.book-play:hover{transform:scale(1.08);background:#3DAE5C}
.player{position:fixed;bottom:0;left:0;right:0;background:#0F172A;color:#F8FAFC;padding:10px 14px;box-shadow:0 -4px 20px rgba(0,0,0,.3);display:none;z-index:80}
.player.on{display:flex;align-items:center;gap:10px}
.player-info{flex:1;min-width:0}.player-title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player-author{font-size:11px;color:#94A3B8}
.player audio{height:36px;max-width:220px}.player-close{padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.1);font-size:11px;font-weight:600;color:#fff}
.guide-card{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;padding:14px;margin-bottom:10px;border-left:4px solid #3DAE5C}
.guide-card h3{font-size:14px;font-weight:700;margin-bottom:6px;color:#0F172A;display:flex;align-items:center;gap:8px}
.guide-card h3 .num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:#3DAE5C;color:#fff;border-radius:50%;font-size:12px;font-family:'Space Mono',monospace}
.guide-card p{font-size:13px;line-height:1.55;color:#312E81;margin-bottom:6px}
.guide-card code{background:#EEF2FF;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#E8453C}
.guide-card ul{margin-left:18px;margin-top:4px}.guide-card li{font-size:12px;line-height:1.55;color:#312E81;margin-bottom:3px}
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
/* (removed) staggered card entrance + page transition \u2014 caused flicker on every tab switch */
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
*::-webkit-scrollbar{width:6px;height:6px}*::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:3px}*::-webkit-scrollbar-track{background:transparent}
/* Inline Add Task button */
.add-bar{background:linear-gradient(135deg,#0F172A,#312E81);color:#F8FAFC;padding:18px 20px;border-radius:16px;display:flex;align-items:center;gap:14px;margin-bottom:16px;cursor:pointer;transition:all .2s cubic-bezier(.2,.8,.2,1);border:none;width:100%;font-family:inherit;box-shadow:0 4px 14px rgba(45,42,38,.15)}
.add-bar:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(45,42,38,.3)}
.add-bar:active{transform:translateY(0) scale(.98)}
.add-bar .plus{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;flex-shrink:0;box-shadow:0 3px 10px rgba(61,174,92,.4)}
.add-bar .txt{flex:1;text-align:left}
.add-bar .txt b{display:block;font-size:16px;font-weight:700;letter-spacing:-.2px}
.add-bar .txt small{display:block;font-size:12px;color:rgba(245,242,237,.7);margin-top:2px;font-weight:500}
/* Dashboard */
.dash-hero{background:linear-gradient(135deg,#3DAE5C 0%,#2D8A4E 60%,#1A6E3B 100%);color:#F8FAFC;border-radius:18px;padding:24px;margin-bottom:16px;position:relative;overflow:hidden;box-shadow:0 8px 24px rgba(61,174,92,.2)}
.dash-hero::before{content:'';position:absolute;top:-60px;right:-60px;width:220px;height:220px;background:rgba(255,255,255,.1);border-radius:50%}
.dash-hero::after{content:'';position:absolute;bottom:-40px;left:-40px;width:140px;height:140px;background:rgba(255,255,255,.06);border-radius:50%}
.dash-hero h2{font-family:'Space Mono',monospace;font-size:24px;margin-bottom:4px;position:relative;z-index:1;letter-spacing:-.3px}
.dash-hero p{font-size:14px;opacity:.9;position:relative;z-index:1;font-weight:500}
.dash-hero .big{font-size:52px;font-weight:800;font-family:'Space Mono',monospace;margin-top:10px;position:relative;z-index:1;line-height:1;letter-spacing:-1px}
.dash-hero .big small{font-size:14px;font-weight:500;opacity:.85;margin-left:8px;letter-spacing:normal}
.dash-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:11px;margin-bottom:16px}
.dash-card{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:14px;padding:16px;transition:all .2s cubic-bezier(.2,.8,.2,1);position:relative;overflow:hidden}
.dash-card:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.06);border-color:#CBD5E1}
.dash-card .lbl{font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700;letter-spacing:.5px;display:flex;align-items:center;gap:4px}
.dash-card .v{font-family:'Space Mono',monospace;font-size:28px;font-weight:700;margin-top:6px;color:#0F172A;letter-spacing:-.5px;line-height:1.1}
.dash-card .sub{font-size:12px;color:#64748B;margin-top:3px;font-weight:500}
.ring{width:80px;height:80px;margin:0 auto;position:relative}
.ring svg{transform:rotate(-90deg)}
.ring .center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:18px;font-weight:700}
.prio-bars{display:flex;gap:4px;margin-top:8px;height:20px}
.prio-bars .b{flex:1;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700}
.insights{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.insight{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:12px;padding:12px 14px;border-left:4px solid #3DAE5C;font-size:13px;line-height:1.5}
.insight.warn{border-left-color:#E8912C;background:#FFF8EE}
.insight.alert{border-left-color:#E8453C;background:#FEF1F0}
.ai-badge{display:inline-block;font-size:9px;background:linear-gradient(135deg,#7C3AED,#3DAE5C);color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;letter-spacing:.5px;margin-right:6px;text-transform:uppercase}
/* Calculator */
.calc-screen{background:#0F172A;color:#F8FAFC;border-radius:14px;padding:16px;margin-bottom:12px;text-align:right}
.calc-expr{font-family:'Space Mono',monospace;font-size:14px;color:#94A3B8;min-height:18px;word-wrap:break-word;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.calc-result{font-family:'Space Mono',monospace;font-size:32px;font-weight:700;margin-top:6px;word-wrap:break-word;overflow-wrap:anywhere}
.calc-input-row{display:flex;gap:6px;margin-bottom:10px}
.calc-input-row input{flex:1;font-family:'Space Mono',monospace;font-size:14px}
.calc-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.calc-grid.sci{grid-template-columns:repeat(4,1fr)}
.ck{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:10px;padding:14px 6px;font-size:17px;font-weight:600;color:#0F172A;transition:all .1s;font-family:'Space Mono',monospace}
.ck:active{background:#E8E9EF;transform:scale(.96)}
.ck.op{background:#E8912C;color:#fff;border-color:#E8912C}
.ck.eq{background:#3DAE5C;color:#fff;border-color:#3DAE5C}
.ck.sp{background:#E8453C;color:#fff;border-color:#E8453C}
.ck.sci{background:#7C3AED15;color:#7C3AED;border-color:#7C3AED40;font-size:13px}
.calc-tgl{display:flex;gap:6px;margin-bottom:10px}
.calc-tgl button{flex:1;padding:8px;border-radius:8px;font-size:12px;font-weight:600;background:#FFFFFF;border:1px solid #E8E9EF;color:#64748B}
.calc-tgl button.on{background:#0F172A;color:#F8FAFC;border-color:#0F172A}
.calc-hist{background:#FFFFFF;border:1px solid #E8E9EF;border-radius:10px;padding:10px 12px;margin-top:10px;max-height:140px;overflow-y:auto}
.calc-hist h4{font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.calc-hist .hi{font-family:'Space Mono',monospace;font-size:12px;color:#64748B;padding:4px 0;border-bottom:1px solid #F1F5F9;cursor:pointer}
.calc-hist .hi:hover{color:#0F172A}
.calc-hist .hi b{color:#3DAE5C}
.smart-hint{background:#EEF2FF;border-radius:8px;padding:8px 12px;font-size:11px;color:#64748B;margin-bottom:10px;line-height:1.5}
.smart-hint code{background:#fff;padding:1px 5px;border-radius:3px;color:#E8453C;font-family:ui-monospace,Menlo,monospace}
</style></head><body>
<div class="bg-blob a"></div><div class="bg-blob b"></div><div class="bg-blob c"></div><div class="bg-blob d"></div>
<div class="app" id="app"></div>
<script>
const MORALS=[{t:"The secret of getting ahead is getting started.",a:"Mark Twain"},{t:"It does not matter how slowly you go as long as you do not stop.",a:"Confucius"},{t:"Small daily improvements are the key to staggering long-term results.",a:"Robin Sharma"},{t:"Discipline is choosing between what you want now and what you want most.",a:"Abraham Lincoln"},{t:"Don't count the days. Make the days count.",a:"Muhammad Ali"},{t:"The best way to predict the future is to create it.",a:"Peter Drucker"},{t:"Focus on being productive instead of busy.",a:"Tim Ferriss"},{t:"You don't have to be great to start, but you have to start to be great.",a:"Zig Ziglar"},{t:"The journey of a thousand miles begins with a single step.",a:"Lao Tzu"},{t:"Either you run the day or the day runs you.",a:"Jim Rohn"},{t:"A year from now you may wish you had started today.",a:"Karen Lamb"},{t:"Success is the sum of small efforts repeated day in and day out.",a:"Robert Collier"},{t:"Done is better than perfect.",a:"Sheryl Sandberg"},{t:"The way to get started is to quit talking and begin doing.",a:"Walt Disney"},{t:"You cannot escape the responsibility of tomorrow by evading it today.",a:"Abraham Lincoln"},{t:"Motivation gets you going, but discipline keeps you growing.",a:"John C. Maxwell"},{t:"Do something today that your future self will thank you for.",a:"Sean Patrick Flanery"},{t:"The harder I work, the luckier I get.",a:"Samuel Goldwyn"},{t:"Don't watch the clock; do what it does. Keep going.",a:"Sam Levenson"},{t:"Great things never come from comfort zones.",a:"Neil Strauss"},{t:"Sometimes later becomes never. Do it now.",a:"Anonymous"},{t:"Wake up with determination. Go to bed with satisfaction.",a:"Anonymous"},{t:"A goal without a plan is just a wish.",a:"Antoine de Saint-Exupéry"},{t:"Little by little, day by day, what is meant for you will find its way.",a:"Anonymous"},{t:"Success doesn't just find you — you have to go out and get it.",a:"Anonymous"},{t:"Push yourself, because no one else is going to do it for you.",a:"Anonymous"},{t:"Dream big. Start small. Act now.",a:"Robin Sharma"},{t:"Hard work beats talent when talent doesn't work hard.",a:"Tim Notke"},{t:"The only impossible journey is the one you never begin.",a:"Tony Robbins"},{t:"Opportunities don't happen. You create them.",a:"Chris Grosser"}];
let S={tasks:[],view:'all',search:'',tab:'tasks',showAdd:false,editing:null,listening:false,toast:null,toastType:'ok',waOk:false,sending:{},user:null,
books:[],booksLoading:false,booksCat:'all',bookSearch:'',playing:null,moralIdx:Math.floor(Math.random()*MORALS.length),
waConnected:localStorage.getItem('wa_connected')==='1',showWAOnboard:false,
calMonth:new Date(),calSelectedDate:new Date().toISOString().slice(0,10),
steps:[],stepGoal:parseInt(localStorage.getItem('step_goal')||'10000',10),stepLive:{active:false,count:0},
theme:localStorage.getItem('theme')||'classic',
news:{},newsCat:'technology',newsLoading:false,
bookStreak:{streak:0,total:0,today:false,days:[]},_bkSec:0,

loginStep:'phone',loginMethod:'email',loginPhone:'',loginEmail:'',loginName:'',loginOTP:['','','','','',''],loginLoading:false,loginError:'',emailOk:false,
form:{title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'}};
let rec=null,token=localStorage.getItem('tf_token');
if(token){S.user={phone:localStorage.getItem('tf_phone'),name:localStorage.getItem('tf_name'),token}}

const api=async(p,o={})=>{try{const h={'Content-Type':'application/json'};if(token)h['x-token']=token;const r=await fetch('/api'+p,{headers:h,...o});if(r.status===401){logout();return null}return await r.json()}catch(e){return null}};
const P={high:{c:'#E8453C',d:'\\u{1F534}'},medium:{c:'#E8912C',d:'\\u{1F7E0}'},low:{c:'#3DAE5C',d:'\\u{1F7E2}'}};
function ic(n,sz){sz=sz||20;const s='width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';const m={
tasks:'<svg '+s+'><rect x="3" y="4" width="18" height="18" rx="2.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M9 16l2 2 4-4"/></svg>',
board:'<svg '+s+'><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
cal:'<svg '+s+'><rect x="3" y="4" width="18" height="18" rx="2.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
dash:'<svg '+s+'><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
news:'<svg '+s+'><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8z"/></svg>',
books:'<svg '+s+'><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
steps:'<svg '+s+'><path d="M4 16v-2.4C4 11.5 3 10.5 3 8c0-2.7 1.5-6 4.5-6C9.4 2 10 3.8 10 5.5c0 3.1-2 5.7-2 8.7V16a2 2 0 1 1-4 0z"/><path d="M20 20v-2.4c0-2.1 1-3.1 1-5.6 0-2.7-1.5-6-4.5-6-1.9 0-2.5 1.8-2.5 3.5 0 3.1 2 5.7 2 8.7V20a2 2 0 1 0 4 0z"/></svg>',
calc:'<svg '+s+'><rect x="4" y="2" width="16" height="20" rx="2.5"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><circle cx="8" cy="10" r=".8" fill="currentColor"/><circle cx="12" cy="10" r=".8" fill="currentColor"/><circle cx="16" cy="10" r=".8" fill="currentColor"/><circle cx="8" cy="14" r=".8" fill="currentColor"/><circle cx="12" cy="14" r=".8" fill="currentColor"/><circle cx="8" cy="18" r=".8" fill="currentColor"/><circle cx="12" cy="18" r=".8" fill="currentColor"/></svg>',
ai:'<svg '+s+'><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
sport:'<svg '+s+'><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20"/><path d="M12 2a14.5 14.5 0 0 1 0 20"/><path d="M2 12h20"/></svg>',
tech:'<svg '+s+'><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
movies:'<svg '+s+'><rect x="3" y="3" width="18" height="18" rx="2.5"/><line x1="3" y1="8" x2="7" y2="8"/><line x1="3" y1="16" x2="7" y2="16"/><line x1="17" y1="8" x2="21" y2="8"/><line x1="17" y1="16" x2="21" y2="16"/><polygon points="10 9 15 12 10 15"/></svg>',
globe:'<svg '+s+'><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
share:'<svg '+s+'><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>',
play:'<svg '+s+'><polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/></svg>',
flame:'<svg '+s+'><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2.4-1.5-3.5C8 7 7 5.5 7 3c0 0 6 4.5 6 11.5A4.5 4.5 0 0 1 8.5 14.5z"/><path d="M16 18a3 3 0 0 1-2-5c1-1 2-2 2-4.5C16 8.5 19 9 19 12c0 3.5-1.5 6-3 6z"/></svg>',
moon:'<svg '+s+'><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>',
sun:'<svg '+s+'><circle cx="12" cy="12" r="4" fill="currentColor"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>',
refresh:'<svg '+s+'><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
plus:'<svg '+s+'><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'};return m[n]||''}
const ST={pending:{l:'To Do',c:'#94A3B8',bg:'#F1F5F9'},'in-progress':{l:'Doing',c:'#3B82F6',bg:'#EFF6FF'},done:{l:'Done',c:'#3DAE5C',bg:'#F2FBF4'}};
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
async function load(){const a=document.getElementById('audioEl');if(a&&!a.paused)return;const t=await api('/tasks');if(!t)return;const h=JSON.stringify(t);if(h===S._lastTasksHash)return;S._lastTasksHash=h;S.tasks=t;render()}
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

function switchTab(t){if(t==='steps')t='tasks';S.tab=t;if(t==='books'&&!S.books.length)loadBooks('all');if(t==='news'&&!S.news[S.newsCat])loadNews(S.newsCat);render()}
async function loadNews(cat){S.newsCat=cat;S.newsLoading=true;render();try{const r=await fetch('/api/news?cat='+encodeURIComponent(cat),{cache:'no-store'});const j=await r.json();S.news[cat]=j.items||[]}catch(e){S.news[cat]=[]}S.newsLoading=false;render()}
function shareNews(idx){const item=(S.news[S.newsCat]||[])[idx];if(!item)return;const url=item.link,title=item.title,text=(item.desc||'').slice(0,140);if(navigator.share){navigator.share({title,text,url}).catch(()=>{})}else{navigator.clipboard?.writeText(title+'\\n\\n'+url).then(()=>toast('\\u{1F517} Link copied')).catch(()=>toast('\\u26A0\\uFE0F Share unavailable','err'))}}
function timeAgo(ds){if(!ds)return '';const d=new Date(ds);if(isNaN(d))return '';const s=(Date.now()-d.getTime())/1000;if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';if(s<604800)return Math.floor(s/86400)+'d ago';return d.toLocaleDateString()}
async function loadSteps(){const r=await api('/steps?days=30');if(Array.isArray(r)){S.steps=r;render()}}
function setStepGoal(v){const n=parseInt(v,10);if(isFinite(n)&&n>=500&&n<=100000){S.stepGoal=n;localStorage.setItem('step_goal',String(n));render()}}
async function logSteps(){const today=new Date().toISOString().slice(0,10);const current=(S.steps.find(s=>s.date===today)?.count)||0;const v=prompt('Enter today\\'s steps (from Samsung Health, Apple Health, or any tracker):',current||'');if(v===null)return;const n=parseInt(String(v).replace(/[^0-9]/g,''),10);if(!isFinite(n)||n<0){toast('\\u26A0\\uFE0F Enter a positive number','err');return}await postSteps(today,n,'manual')}
async function postSteps(date,count,source){const r=await api('/steps',{method:'POST',body:JSON.stringify({date,count,source})});if(r?.ok){const i=S.steps.findIndex(s=>s.date===date);const rec={date,count,source};if(i>=0)S.steps[i]=rec;else S.steps.push(rec);toast('\\u2705 '+count.toLocaleString()+' steps saved');render()}else toast('\\u26A0\\uFE0F Save failed','err')}
let _ped=null,_pedT=null,_wakeLock=null;
async function acquireWake(){try{if('wakeLock' in navigator){_wakeLock=await navigator.wakeLock.request('screen');_wakeLock.addEventListener('release',()=>{_wakeLock=null})}}catch(e){}}
async function releaseWake(){try{if(_wakeLock){await _wakeLock.release();_wakeLock=null}}catch(e){}}
async function flushPedCount(){const added=S.stepLive.count||0;if(added>0){const today=new Date().toISOString().slice(0,10);const current=(S.steps.find(s=>s.date===today)?.count)||0;await postSteps(today,current+added,'device');S.stepLive.count=0}}
async function startPed(){if(typeof DeviceMotionEvent==='undefined'){toast('\\u26A0\\uFE0F Motion sensor unavailable on this device','err');return}if(typeof DeviceMotionEvent.requestPermission==='function'){try{const p=await DeviceMotionEvent.requestPermission();if(p!=='granted'){toast('\\u26A0\\uFE0F Permission denied','err');return}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');return}}S.stepLive={active:true,count:0,lastPeak:0,lastMag:9.8,_pending:false};_ped=function(e){if(!S.stepLive.active)return;const a=e.accelerationIncludingGravity||e.acceleration;if(!a)return;const mag=Math.sqrt((a.x||0)**2+(a.y||0)**2+(a.z||0)**2);const now=Date.now(),delta=mag-S.stepLive.lastMag;S.stepLive.lastMag=mag;if(delta>2.5&&(now-S.stepLive.lastPeak)>280){S.stepLive.count++;S.stepLive.lastPeak=now;if(!S.stepLive._pending){S.stepLive._pending=true;setTimeout(()=>{S.stepLive._pending=false;if(S.tab==='steps')render()},600)}}};window.addEventListener('devicemotion',_ped);await acquireWake();toast('\\u{1F6B6} Tracking \\u2014 screen will stay on');render()}
async function stopPed(){if(_ped){window.removeEventListener('devicemotion',_ped);_ped=null}await releaseWake();const added=S.stepLive.count||0;S.stepLive={active:false,count:0};if(added>0){const today=new Date().toISOString().slice(0,10);const current=(S.steps.find(s=>s.date===today)?.count)||0;await postSteps(today,current+added,'device')}else{toast('\\u23F8 Stopped \\u2014 no steps detected');render()}}
/* When the tab is backgrounded, flush whatever we counted so we don't lose it, and re-acquire wake lock on return. */
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='hidden'){if(S.stepLive&&S.stepLive.active)await flushPedCount()}else if(document.visibilityState==='visible'){if(S.stepLive&&S.stepLive.active&&!_wakeLock)await acquireWake()}});
function toggleTheme(){S.theme=S.theme==='aurora'?'classic':'aurora';localStorage.setItem('theme',S.theme);document.body.setAttribute('data-theme',S.theme);toast(S.theme==='aurora'?'\\u{1F30C} Aurora theme on':'\\u2728 Classic theme on');render()}
function applyTheme(){document.body.setAttribute('data-theme',S.theme||'classic')}
let _drag=null;
function dragS(e,id){_drag=id;if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id)}setTimeout(()=>{const el=document.querySelector('[data-tid="'+id+'"]');if(el)el.classList.add('drag')},0)}
function dragE(){if(_drag){const el=document.querySelector('[data-tid="'+_drag+'"]');if(el)el.classList.remove('drag')}_drag=null;document.querySelectorAll('.col.over').forEach(c=>c.classList.remove('over'))}
function dragO(e){e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';e.currentTarget.classList.add('over')}
function dragL(e){if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove('over')}
async function dragD(e,status){e.preventDefault();e.currentTarget.classList.remove('over');const id=_drag||(e.dataTransfer?e.dataTransfer.getData('text/plain'):null);if(!id)return;await mvT(id,status)}
async function mvT(id,status){const t=S.tasks.find(x=>x.id===id);if(!t||t.status===status)return;const oldStatus=t.status;t.status=status;render();const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render();toast('\\u2705 Moved to '+(status==='pending'?'To Do':status==='in-progress'?'Doing':'Done'))}else{t.status=oldStatus;render();toast('\\u26A0\\uFE0F Move failed','err')}}
const TAB_INTROS={
tasks:"Welcome to Tasks. Add and organize your daily to-dos. Tap the plus button to create a task, or use the voice button to speak your task out loud.",
board:"This is the Kanban board. Drag your cards between To Do, Doing, and Done columns to track your progress visually.",
cal:"Your calendar view. Tap any date to see scheduled tasks or add new ones for that day.",
dash:"Your productivity dashboard. See completed tasks, streaks, and your progress over time.",
news:"Stay informed with daily curated news. Browse different categories like technology, sports, and entertainment.",
books:"Free audiobook library from Libri Vox. Search, browse, and listen. Keep a streak by listening for two minutes a day."
};
function speakIntro(){try{if(!('speechSynthesis' in window)){toast('\\u26A0\\uFE0F Voice not supported on this device','err');return}const t=TAB_INTROS[S.tab];if(!t)return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.rate=1;u.pitch=1;u.volume=1;speechSynthesis.speak(u);toast('\\u{1F50A} Playing intro')}catch(e){toast('\\u26A0\\uFE0F Voice error','err')}}
function stopSpeak(){try{speechSynthesis.cancel()}catch(e){}}
function filterBooks(v){S.bookSearch=v;const grid=document.getElementById('books-grid');if(!grid){render();return}const q=(v||'').toLowerCase().trim();const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});grid.innerHTML=renderBookCards(fb)}
function renderBookCards(fb){if(!fb.length)return '<div class="empty"><div style="font-size:36px">\\u{1F4DA}</div><div style="font-size:14px;margin-top:8px">No books found</div></div>';let h='<div class="book-list">';fb.forEach(b=>{const id=b.identifier;const cover='https://archive.org/services/img/'+id;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');const title=Array.isArray(b.title)?b.title[0]:b.title;h+='<div class="book-card"><div class="book-cover"><img src="'+cover+'" loading="lazy" onerror="this.style.display=\\'none\\'"/></div><div class="book-info"><div class="book-title">'+esc(title)+'</div><div class="book-author">'+esc(author)+'</div><div class="book-meta"><span>\\u{1F3A7} '+(b.downloads?(+b.downloads).toLocaleString():'\\u2014')+' plays</span><span>\\u{1F4D6} LibriVox</span></div></div><button class="book-play" onclick="playBook(\\''+id+'\\')">\\u25B6</button></div>'});h+='</div>';return h}
function openWAOnboard(){S.showWAOnboard=true;render()}
function closeWAOnboard(){S.showWAOnboard=false;render()}
function openWAJoin(){const code=window.__TWILIO_SANDBOX_CODE||'along-wool';window.open('https://wa.me/14155238886?text='+encodeURIComponent('join '+code),'_blank')}
function confirmWAJoined(){S.waConnected=true;localStorage.setItem('wa_connected','1');S.showWAOnboard=false;toast('\\u2705 WhatsApp connected');render()}
function disconnectWA(){S.waConnected=false;localStorage.removeItem('wa_connected');toast('\\u23F8 WhatsApp disconnected');render()}
async function openProfile(){S.showProfile=true;render();const me=await api('/me');if(me&&!me.error)S.profile=me;render()}
function closeProfile(){S.showProfile=false;render()}
async function saveName(){const n=(document.getElementById('pfName')||{}).value;if(!n||!n.trim())return;const r=await api('/me',{method:'PUT',body:JSON.stringify({name:n.trim()})});if(r&&r.name){S.user.name=r.name;localStorage.setItem('tf_name',r.name);S.profile=Object.assign(S.profile||{},{name:r.name});toast('\\u2705 Name updated');render()}}
async function refreshSession(){if(!token)return;const r=await api('/me');if(r&&!r.error){S.user={phone:r.phone,name:r.name,token};localStorage.setItem('tf_name',r.name||'');render()}else if(r&&r.error){logout()}}
function calPrev(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()-1);S.calMonth=d;render()}
function calNext(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()+1);S.calMonth=d;render()}
function calSelect(d){S.calSelectedDate=d;render()}
function calAddForDate(){S.form={title:'',notes:'',priority:'medium',dueDate:S.calSelectedDate||'',reminderTime:'',status:'pending'};S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
function rotateMoral(){const a=document.getElementById('audioEl');if(a&&!a.paused)return;S.moralIdx=(S.moralIdx+1)%MORALS.length;render()}
setInterval(()=>{if(S.user)rotateMoral()},45000);

async function loadBooks(cat){S.booksCat=cat;S.booksLoading=true;render();try{const q=cat==='all'?'collection:librivoxaudio AND mediatype:audio':'collection:librivoxaudio AND mediatype:audio AND subject:'+cat;const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=30&output=json&sort[]=downloads+desc';const r=await fetch(url);const j=await r.json();S.books=j.response.docs;}catch(e){S.books=[];toast('\\u26A0\\uFE0F Failed to load books','err')}S.booksLoading=false;render()}
async function playBook(id){const b=S.books.find(x=>x.identifier===id);if(!b){toast('\\u26A0\\uFE0F Book not found','err');return}const title=Array.isArray(b.title)?b.title[0]:b.title;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');S.playing={id,title,author,loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F No files \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=j.files.find(f=>/_64kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/_32kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.mp3$/i.test(f.name)&&!/sample|test|spoken/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const directUrl='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');const dlUrl='https://archive.org/download/'+encodeURIComponent(id)+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title,author,url:directUrl,altUrl:dlUrl,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(!a)return;a.setAttribute('playsinline','');a.setAttribute('webkit-playsinline','');a.preload='auto';a.addEventListener('error',function onErr(){a.removeEventListener('error',onErr);if(a.src!==dlUrl){a.src=dlUrl;a.load()}},{once:true});a.load();a.addEventListener('play',startBookListenTimer);a.addEventListener('pause',()=>{/* keep timer; checks paused itself */});const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap the play button on the bar','err'))},250)}else{toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing={id,title,author,url:null,external:'https://archive.org/details/'+id,error:e.message};render()}}
function closePlayer(){stopBookListenTimer();S.playing=null;render()}
let _bkTimer=null;
function startBookListenTimer(){if(_bkTimer)return;S._bkSec=0;_bkTimer=setInterval(async()=>{const a=document.getElementById('audioEl');if(!a||a.paused||a.ended)return;S._bkSec+=5;if(S._bkSec===120&&S.user&&!S.bookStreak.today){const r=await api('/book-streak',{method:'POST',body:JSON.stringify({date:new Date().toISOString().slice(0,10),seconds:120})});if(r?.ok){S.bookStreak={streak:r.streak,total:r.total,today:true,days:S.bookStreak.days};toast('\\u{1F389} '+r.streak+'-day listening streak!');render()}}},5000)}
function stopBookListenTimer(){if(_bkTimer){clearInterval(_bkTimer);_bkTimer=null}}
async function loadBookStreak(){if(!S.user)return;const r=await api('/book-streak');if(r)S.bookStreak={streak:r.streak||0,total:r.total||0,today:!!r.today,days:r.days||[]}}

function render(){
// Preserve focus + cursor across re-renders so typing isn't interrupted
const _fs=(function(){try{const a=document.activeElement;if(!a||(a.tagName!=='INPUT'&&a.tagName!=='TEXTAREA'))return null;return{id:a.id,name:a.name,type:a.type,placeholder:a.placeholder,start:a.selectionStart,end:a.selectionEnd}}catch(e){return null}})();
const _restore=function(){if(!_fs)return;try{let el=null;if(_fs.id)el=document.getElementById(_fs.id);if(!el){const inputs=document.querySelectorAll('input,textarea');for(const i of inputs){if((_fs.placeholder&&i.placeholder===_fs.placeholder)||(_fs.name&&i.name===_fs.name)){el=i;break}}}if(el){try{el.focus({preventScroll:true})}catch(e){el.focus()}if(typeof _fs.start==='number'&&el.setSelectionRange){try{el.setSelectionRange(_fs.start,_fs.end)}catch(e){}}}}catch(e){}};
setTimeout(_restore,0);
if(!S.user){let h='<div class="login">';
h+='<div class="login-logo">Bro<span class="k">Do</span>it</div>';
if(S.loginStep==='phone'){
h+='<div class="login-sub">Your calm productivity companion.<br>Tasks, audiobooks &amp; daily wisdom in one place.</div>';
h+='<div class="login-features">';
h+='<div class="login-feature"><div class="lf-ic tasks"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div class="lf-lbl">Tasks</div><div class="lf-sub">Stay on track</div></div>';
h+='<div class="login-feature"><div class="lf-ic books"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18.5V5a2 2 0 0 1 2-2h12.5"/><path d="M3 18.5A2.5 2.5 0 0 1 5.5 16H20a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5.5A2.5 2.5 0 0 1 3 18.5z"/></svg></div><div class="lf-lbl">Audiobooks</div><div class="lf-sub">Free &amp; classic</div></div>';
h+='<div class="login-feature"><div class="lf-ic wisdom"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6L12 2z"/></svg></div><div class="lf-lbl">Wisdom</div><div class="lf-sub">Daily quotes</div></div>';
h+='</div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot"></div><div class="step-dot"></div></div>';
// Force email-only login. WhatsApp Sandbox blocks new users (Twilio limitation).
S.loginMethod='email';
h+='<input type="text" placeholder="Your name" value="'+esc(S.loginName)+'" oninput="S.loginName=this.value" style="font-size:15px;letter-spacing:0">';
h+='<input type="email" placeholder="you@example.com" value="'+esc(S.loginEmail)+'" oninput="S.loginEmail=this.value" autocomplete="email" style="font-size:15px;letter-spacing:0">';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Sending code...':'\\u2709\\uFE0F Send code to email')+'</button>';
h+='<div class="login-hint">We\\'ll email a 6-digit code. Check your inbox (and spam folder).</div>';
h+='<div class="login-hint" style="margin-top:14px;font-size:11px;opacity:.6">Sign in with email \\u2014 you can connect WhatsApp later from inside the app.</div>';
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

let h='<div class="hdr"><div><div class="logo">Bro<span class="k">Do</span>it</div><div class="hdr-sub">'+new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div></div><div class="hdr-actions"><button class="theme-tg" onclick="speakIntro()" title="Hear what this tab does" aria-label="Play voice introduction"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button><button class="theme-tg" onclick="toggleTheme()" title="Switch theme">'+(S.theme==='aurora'?ic('sun',18):ic('moon',18))+'</button><div class="hdr-st"><span class="dot" style="background:'+(S.waConnected&&S.waOk?'#10B981':'#CBD5E1')+'"></span>'+(S.waConnected&&S.waOk?'LIVE':'OFF')+'</div></div></div>';

// Moral chip
const m=MORALS[S.moralIdx];
h+='<div class="moral"><div class="moral-emoji">\\u{1F4A1}</div><div class="moral-body"><div class="moral-lbl">Moral of the Day</div><div class="moral-txt">"'+esc(m.t)+'"</div><div class="moral-by">\\u2014 '+esc(m.a)+'</div></div><button class="moral-ref" onclick="rotateMoral()" title="New quote">\\u21BB</button></div>';

// Tabs
h+='<nav class="tabs page-t">'+[{k:'tasks',l:'Tasks'},{k:'board',l:'Board'},{k:'cal',l:'Calendar'},{k:'dash',l:'Stats'},{k:'news',l:'News'},{k:'books',l:'Books'}].map(x=>'<button class="tab'+(S.tab===x.k?' on':'')+'" onclick="stopSpeak();switchTab(\\''+x.k+'\\')"><span class="ti">'+ic(x.k,20)+'</span><span class="tl">'+x.l+'</span></button>').join('')+'</nav>';

h+='<main class="main-col">';
h+='<div class="user-bar" style="cursor:pointer" onclick="openProfile()"><span>\\u{1F464} '+esc(S.user.name||S.user.phone)+' <span style="color:#94A3B8;font-size:11px">\\u203A Profile</span></span><button onclick="event.stopPropagation();logout()">Logout</button></div>';

// TASKS TAB
if(S.tab==='tasks'){
  h+='<button class="add-bar" onclick="opA()"><span class="plus">+</span><span class="txt"><b>Add a new task</b><small>'+(S.waConnected?'Type, speak, or send via WhatsApp':'Type or use voice input')+'</small></span></button>';
  if(S.waConnected&&S.waOk)h+='<div class="al" style="background:#EDFCF2;border:1px solid #B7E8C4;color:#1A9E47">\\u{1F4F1} WhatsApp connected</div>';
  else h+='<div class="al" style="background:#F0F9FF;border:1px solid #BAE6FD;color:#0369A1;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px" onclick="openWAOnboard()"><span>'+WI+' &nbsp;Connect WhatsApp for reminders <small style="opacity:.8">(optional)</small></span><span style="font-weight:700">\\u203A</span></div>';
  h+='<div class="stats">'+[{l:'Total',v:s.total,c:'#0F172A'},{l:'To Do',v:s.pend,c:'#94A3B8'},{l:'Active',v:s.act,c:'#3B82F6'},{l:'Done',v:s.dn,c:'#3DAE5C'}].map(x=>'<div class="st"><b style="color:'+x.c+'">'+x.v+'</b><small>'+x.l+'</small></div>').join('')+'</div>';
  if(s.od>0)h+='<div class="al" style="background:#FEF1F0;border:1px solid #F5C6C2;color:#E8453C;cursor:pointer" onclick="S.view=\\'overdue\\';render()">\\u26A0\\uFE0F '+s.od+' overdue</div>';
  h+='<div class="srch"><input placeholder="Search tasks..." value="'+esc(S.search)+'" oninput="S.search=this.value;render()"></div>';
  h+='<div class="flt">'+[{k:'all',l:'All'},{k:'pending',l:'To Do'},{k:'in-progress',l:'Doing'},{k:'done',l:'Done'},{k:'today',l:'Today'}].map(x=>'<button class="fb'+(S.view===x.k?' on':'')+'" onclick="S.view=\\''+x.k+'\\';render()">'+x.l+'</button>').join('')+'</div>';
  if((s.pend+s.act)>0&&S.waConnected&&S.waOk)h+='<button class="bwa" onclick="sAll()">'+WI+' Send all to WhatsApp</button>';
  h+='<div>';
  if(!f.length)h+='<div class="empty"><div style="font-size:36px;margin-bottom:8px">\\u2728</div><div style="font-size:15px;font-weight:600">No tasks yet</div><div style="font-size:13px;margin-top:4px">Tap + to add your first task</div></div>';
  else f.forEach(t=>{const p=P[t.priority]||P.medium,st=ST[t.status]||ST.pending,d=t.status==='done';
    h+='<div class="tc'+(d?' dn':'')+'" style="border-left-color:'+p.c+'"><div class="tc-top"><button class="chk'+(d?' on':'')+'" onclick="tog(\\''+t.id+'\\')">'+(d?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':'')+'</button><div style="flex:1;min-width:0"><div class="tc-t'+(d?' dn':'')+'">'+esc(t.title)+'</div>'+(t.notes?'<div class="tc-n">'+esc(t.notes)+'</div>':'')+'<div class="tc-m"><button class="badge" style="background:'+st.bg+';color:'+st.c+'" onclick="cyc(\\''+t.id+'\\')">'+st.l+'</button>'+(t.due_date?'<span style="font-size:12px;font-weight:500;color:'+(isOD(t.due_date,t.status)?'#E8453C':isTd(t.due_date)?'#E8912C':'#94A3B8')+'">\\u{1F4C5} '+fD(t.due_date)+(isOD(t.due_date,t.status)?' overdue':'')+'</span>':'')+(t.reminder_time&&!d?'<span style="font-size:11px;color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>':'')+(t.source==='whatsapp'?'<span style="font-size:10px;color:#CBD5E1">via WA</span>':'')+'</div></div></div>';
    h+='<div class="tc-acts"><button class="ib" onclick="opE(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'+(S.waConnected?'<button class="ib" onclick="sWA(\\''+t.id+'\\')">'+WI+'</button>':'')+'<button class="ib" style="color:#E8453C" onclick="del(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div></div>'});
  h+='</div><button class="fab" onclick="opA()">+</button>';
}

// BOARD TAB (Kanban: To Do / Doing / Done with drag-and-drop)
else if(S.tab==='board'){
  h+='<button class="add-bar" onclick="opA()"><span class="plus">+</span><span class="txt"><b>Add a new task</b><small>It will land in To Do</small></span></button>';
  h+='<div class="section-hd"><span class="section-ic">'+ic('board',22)+'</span><div><h3>Task Board</h3><p>Drag cards between columns or tap a move button</p></div></div>';
  const cols=[{k:'pending',l:'To Do',i:'\\u{1F4E5}',c:'#94A3B8'},{k:'in-progress',l:'Doing',i:'\\u26A1',c:'#3B82F6'},{k:'done',l:'Done',i:'\\u2705',c:'#3DAE5C'}];
  h+='<div class="board">';
  cols.forEach(col=>{
    const items=ts.filter(t=>t.status===col.k);
    h+='<div class="col" ondragover="dragO(event)" ondragleave="dragL(event)" ondrop="dragD(event,\\''+col.k+'\\')">';
    h+='<div class="col-h"><h3><span class="dot" style="background:'+col.c+'"></span>'+col.i+' '+col.l+'</h3><span class="cnt">'+items.length+'</span></div>';
    h+='<div class="col-body">';
    if(!items.length)h+='<div class="col-empty">'+(col.k==='done'?'Nothing finished yet':col.k==='in-progress'?'Nothing in progress':'Inbox empty \\u2728')+'<br><span style="font-size:10px;opacity:.7">Drop a card here</span></div>';
    else items.forEach(t=>{
      const p=P[t.priority]||P.medium;
      h+='<div class="kc" draggable="true" data-tid="'+t.id+'" ondragstart="dragS(event,\\''+t.id+'\\')" ondragend="dragE()" style="border-left-color:'+p.c+'">';
      h+='<div onclick="opE(\\''+t.id+'\\')" style="cursor:pointer"><div class="kc-t'+(t.status==='done'?'" style="text-decoration:line-through;color:#94A3B8':'')+'">'+esc(t.title)+'</div>';
      h+='<div class="kc-m"><span class="pri" style="background:'+p.c+'">'+t.priority+'</span>';
      if(t.due_date)h+='<span class="due" style="color:'+(isOD(t.due_date,t.status)?'#E8453C':isTd(t.due_date)?'#E8912C':'#94A3B8')+'">\\u{1F4C5} '+fD(t.due_date)+'</span>';
      if(t.reminder_time&&t.status!=='done')h+='<span style="color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>';
      h+='</div></div>';
      h+='<div class="kc-acts">';
      cols.filter(c2=>c2.k!==col.k).forEach(c2=>{h+='<button class="kc-mv" onclick="event.stopPropagation();mvT(\\''+t.id+'\\',\\''+c2.k+'\\')">'+(c2.k==='pending'?'\\u2190 To Do':c2.k==='in-progress'?'\\u2192 Doing':'\\u2192 Done')+'</button>'});
      h+='</div></div>';
    });
    h+='</div></div>';
  });
  h+='</div>';
  h+='<button class="fab" onclick="opA()">+</button>';
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
  h+='<div class="dash-card"><div class="lbl">\\u{1F525} Streak</div><div class="v">'+streak+'<small style="font-size:13px;color:#94A3B8;margin-left:4px">days</small></div><div class="sub">keep it alive</div></div>';
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

// NEWS TAB (shorts feed with categories + share)
else if(S.tab==='news'){
  const cats=[{k:'ai',l:'AI',ic:'ai'},{k:'sports',l:'Sports',ic:'sport'},{k:'technology',l:'Tech',ic:'tech'},{k:'movies',l:'Movies',ic:'movies'},{k:'global',l:'World',ic:'globe'}];
  h+='<div class="news-hero"><div class="news-hero-l"><span class="news-hero-ic">'+ic('news',22)+'</span><div><h2>News</h2><p>Fresh headlines \\u2022 Tap share to send to any app</p></div></div><button class="news-refresh" onclick="loadNews(S.newsCat)" title="Refresh">'+ic('refresh',18)+'</button></div>';
  h+='<div class="flt flt-icons">';
  cats.forEach(c=>{h+='<button class="fb'+(S.newsCat===c.k?' on':'')+'" onclick="loadNews(\\''+c.k+'\\')"><span class="fb-ic">'+ic(c.ic,15)+'</span>'+c.l+'</button>'});
  h+='</div>';
  if(S.newsLoading&&!(S.news[S.newsCat]||[]).length){
    h+='<div class="loading">\\u{1F4E1} Fetching latest '+esc((cats.find(c=>c.k===S.newsCat)||{}).l||'')+' stories\\u2026</div>';
  } else {
    const items=S.news[S.newsCat]||[];
    if(!items.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F914}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No headlines right now</div><div style="font-size:12px;margin-top:4px">Try a different category or refresh</div></div>'}
    else{
      h+='<div class="news-feed">';
      items.forEach((it,i)=>{
        const img=it.img||'';
        const when=timeAgo(it.date);
        const srcName=(it.source||'').charAt(0).toUpperCase()+(it.source||'').slice(1);
        h+='<article class="news-card">';
        if(img){h+='<a class="news-img" href="'+esc(it.link||'#')+'" target="_blank" rel="noopener" style="background-image:url(\\''+esc(img).replace(/\\\\/g,"\\\\").replace(/\\'/g,"\\\\\\'")+'\\')"><div class="news-src-chip">'+esc(srcName)+'</div></a>'}
        h+='<div class="news-body">';
        if(!img)h+='<div class="news-meta"><span class="news-src">'+esc(srcName)+'</span>'+(when?'<span class="news-time">'+esc(when)+'</span>':'')+'</div>';
        else if(when)h+='<div class="news-meta" style="margin-bottom:6px"><span class="news-time">\\u{1F552} '+esc(when)+'</span></div>';
        h+='<h3 class="news-title"><a href="'+esc(it.link||'#')+'" target="_blank" rel="noopener">'+esc(it.title||'')+'</a></h3>';
        if(it.desc)h+='<p class="news-desc">'+esc(it.desc)+'</p>';
        h+='<div class="news-acts"><button class="news-share" onclick="shareNews('+i+')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>Share</button><a class="news-read" href="'+esc(it.link||'#')+'" target="_blank" rel="noopener">Read full story \\u2197</a></div>';
        h+='</div></article>';
      });
      h+='</div>';
    }
  }
}

// BOOKS TAB
else if(S.tab==='books'){
  const bs=S.bookStreak||{streak:0,total:0,today:false};
  h+='<div class="section-hd"><span class="section-ic">'+ic('books',22)+'</span><div><h3>Audiobooks</h3><p>Free LibriVox library \\u2022 listen 2 minutes a day to keep your streak</p></div></div>';
  h+='<div class="streak-card"><div class="streak-ico">'+ic('flame',24)+'</div><div class="streak-body"><div class="streak-n">'+bs.streak+'<span>day'+(bs.streak===1?'':'s')+'</span></div><div class="streak-lbl">Listening streak'+(bs.today?' \\u2022 done today \\u2705':'')+'</div></div><div class="streak-tot"><b>'+bs.total+'</b><small>total days</small></div></div>';
  h+='<div class="srch"><input id="bsearch" placeholder="Search audiobooks..." value="'+esc(S.bookSearch)+'" oninput="filterBooks(this.value)"></div>';
  h+='<div class="flt">'+['all','fiction','mystery','philosophy','adventure','kids'].map(c=>'<button class="fb'+(S.booksCat===c?' on':'')+'" onclick="loadBooks(\\''+c+'\\')">'+c.charAt(0).toUpperCase()+c.slice(1)+'</button>').join('')+'</div>';
  if(S.booksLoading)h+='<div class="loading">Loading audiobooks...</div>';
  else{
    const q=S.bookSearch.toLowerCase().trim();
    const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});
    h+='<div id="books-grid">'+renderBookCards(fb)+'</div>';
  }
}


h+='</main>';

// Player bar (any tab)
if(S.playing){
  h+='<div class="player on"><div class="player-info"><div class="player-title">'+esc(S.playing.title)+'</div><div class="player-author">'+esc(S.playing.author)+(S.playing.external?' \\u2022 <a href="'+esc(S.playing.external)+'" target="_blank" style="color:#3DAE5C;text-decoration:none">Open \\u2197</a>':'')+'</div></div>';
  if(S.playing.url)h+='<audio id="audioEl" controls preload="auto" src="'+esc(S.playing.url)+'"></audio>';
  else if(S.playing.error)h+='<span style="font-size:11px;color:#E8453C">\\u26A0\\uFE0F '+esc(S.playing.error)+'</span>';
  else h+='<span style="font-size:11px;color:#94A3B8">Loading\\u2026</span>';
  h+='<button class="player-close" onclick="closePlayer()">\\u2715</button></div>';
}

if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';

if(S.showWAOnboard){
  h+='<div class="ov" onclick="closeWAOnboard()"><div class="mdl" onclick="event.stopPropagation()" style="max-width:420px">';
  h+='<div style="text-align:center;margin-bottom:14px"><div style="width:64px;height:64px;border-radius:50%;background:#25D366;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">'+WI+'</div><h2 style="margin:0">Connect WhatsApp</h2><div style="font-size:13px;color:#94A3B8;margin-top:4px">Optional \\u2014 enables WhatsApp reminders &amp; quick task creation</div></div>';
  if(!S.waConnected){
    h+='<div style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:10px;padding:12px;font-size:13px;color:#0369A1;margin-bottom:14px"><b>While in beta, Brodoit uses Twilio\\'s WhatsApp Sandbox.</b> Each tester must opt in once.</div>';
    h+='<div style="font-size:13px;font-weight:600;margin-bottom:8px">Step 1 \\u2014 Send the join code on WhatsApp</div>';
    h+='<button class="mb mb-s" style="width:100%;background:#25D366;border-color:#25D366" onclick="openWAJoin()">Open WhatsApp &amp; send <code style="background:rgba(255,255,255,.25);padding:2px 6px;border-radius:4px;margin-left:4px">join along-wool</code></button>';
    h+='<div style="font-size:12px;color:#64748B;margin:8px 0 14px;text-align:center">to <b>+1 415 523 8886</b> \\u2014 you should get a "Sandbox: Connected" reply</div>';
    h+='<div style="font-size:13px;font-weight:600;margin-bottom:8px">Step 2 \\u2014 Confirm you\\'re connected</div>';
    h+='<div class="macts"><button class="mb mb-c" onclick="closeWAOnboard()">Maybe later</button><button class="mb mb-s" onclick="confirmWAJoined()">I\\'ve sent the message</button></div>';
  }else{
    h+='<div style="background:#EDFCF2;border:1px solid #B7E8C4;border-radius:10px;padding:12px;font-size:13px;color:#1A9E47;margin-bottom:14px"><b>\\u2705 WhatsApp is connected.</b> You\\'ll receive reminders and can send tasks via WhatsApp.</div>';
    h+='<div class="macts"><button class="mb mb-d" onclick="disconnectWA()">Disconnect</button><button class="mb mb-s" onclick="closeWAOnboard()">Done</button></div>';
  }
  h+='</div></div>';
}

if(S.showProfile){
  const p=S.profile||{phone:S.user.phone,name:S.user.name,created_at:''};
  const initials=((S.user.name||S.user.phone).match(/\\b\\w/g)||['U']).slice(0,2).join('').toUpperCase();
  const mem=p.created_at?new Date(p.created_at.replace(' ','T')+'Z').toLocaleDateString('en-US',{month:'long',year:'numeric'}):'—';
  const masked=p.phone?p.phone.slice(0,3)+' \\u2022\\u2022\\u2022\\u2022\\u2022 '+p.phone.slice(-3):'';
  const streak=(function(){let c=0;for(let i=0;i<30;i++){const d=new Date(Date.now()-i*864e5).toISOString().slice(0,10);const ok=ts.some(t=>t.status==='done'&&(t.updated_at||'').slice(0,10)===d);if(ok)c++;else if(i>0)break}return c})();
  h+='<div class="ov" onclick="closeProfile()"><div class="mdl" onclick="event.stopPropagation()" style="text-align:center">';
  h+='<div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#3DAE5C,#7C3AED);color:#fff;display:flex;align-items:center;justify-content:center;font-family:\\'Space Mono\\',monospace;font-size:32px;font-weight:700;margin:0 auto 12px">'+esc(initials)+'</div>';
  h+='<h2 style="margin-bottom:4px">'+esc(S.user.name||'Brodoit User')+'</h2>';
  h+='<div style="font-size:12px;color:#94A3B8;font-family:\\'Space Mono\\',monospace;margin-bottom:18px">'+esc(masked)+'</div>';
  h+='<div class="dash-grid" style="text-align:left"><div class="dash-card"><div class="lbl">Total tasks</div><div class="v">'+ts.length+'</div></div><div class="dash-card"><div class="lbl">Completed</div><div class="v" style="color:#3DAE5C">'+s.dn+'</div></div><div class="dash-card"><div class="lbl">Streak</div><div class="v">'+streak+'<small style="font-size:12px;color:#94A3B8;margin-left:4px">days</small></div></div><div class="dash-card"><div class="lbl">Member since</div><div class="v" style="font-size:14px">'+esc(mem)+'</div></div></div>';
  h+='<label class="lbl" style="text-align:left">Display name</label><div class="row"><input id="pfName" value="'+esc(S.user.name||'')+'" placeholder="Your name"><button class="mb mb-s" style="flex:0 0 auto;padding:11px 18px" onclick="saveName()">Save</button></div>';
  h+='<div class="macts" style="margin-top:22px"><button class="mb mb-c" onclick="closeProfile()">Close</button><button class="mb mb-d" style="margin-top:0" onclick="logout()">Log out</button></div>';
  h+='</div></div>';
}
if(S.showAdd){const isE=!!S.editing;
h+='<div class="ov" onclick="clM()"><div class="mdl" onclick="event.stopPropagation()"><h2>'+(isE?'Edit Task':'\\u2728 New Task')+'</h2>';
h+='<div style="text-align:center;margin-bottom:10px"><button class="voice-lg'+(S.listening?' rec':'')+'" onclick="'+(S.listening?'rec&&rec.stop();S.listening=false;render()':'stV()')+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'+(S.listening?'<span class="vw"><span></span><span></span><span></span><span></span></span>Listening...':'\\u{1F3A4} Speak to add')+'</button><div style="font-size:11px;color:#94A3B8;margin-top:6px">Try: "Buy groceries tomorrow urgent"</div></div>';
h+='<div style="height:1px;background:#E8E9EF;margin:10px 0 14px"></div>';
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
fetch('/api/config').then(r=>r.json()).then(c=>{window.__TWILIO_SANDBOX_CODE=c.sandboxCode||'';render()}).catch(()=>{});
applyTheme();
if(S.user){refreshSession();load();loadBookStreak();chk();setInterval(load,10000)}else render();
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
  background_color:"#F8FAFC",
  theme_color:"#0F172A",
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
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Privacy Policy — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#0F172A;background:#F8FAFC;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#312E81}a{color:#3DAE5C}</style></head><body><h1>Privacy Policy</h1><p><em>Last updated: April 2026</em></p><p><strong>Brodoit</strong> ("we", "our", "the app") values your privacy. This page explains what data we collect, why, and your rights.</p><h2>1. What we collect</h2><ul><li><strong>Email address</strong> or <strong>phone number</strong> — used only to authenticate you via one-time verification codes.</li><li><strong>Your name</strong> — displayed in the app's profile screen.</li><li><strong>Your tasks, notes, due dates, reminders</strong> — stored so we can show them back to you and send reminders.</li><li><strong>Session token</strong> — a random string stored in your browser so you stay logged in.</li></ul><p>We do <strong>not</strong> collect: location, contacts, advertising IDs, device IDs, photos, payment info, or any data we don't explicitly list here.</p><h2>2. How we use it</h2><ul><li>Deliver one-time codes by email or WhatsApp (via Resend and Twilio respectively).</li><li>Show your tasks and books library.</li><li>Send WhatsApp reminders at the times you set.</li></ul><h2>3. Who we share with</h2><p>We share data only with the following service providers, strictly to operate the service:</p><ul><li><strong>Resend</strong> — to deliver verification emails (<a href="https://resend.com/privacy">privacy policy</a>).</li><li><strong>Twilio</strong> — to deliver WhatsApp messages (<a href="https://www.twilio.com/legal/privacy">privacy policy</a>).</li><li><strong>Railway</strong> — our hosting provider (<a href="https://railway.app/legal/privacy">privacy policy</a>).</li><li><strong>Internet Archive (LibriVox)</strong> — we fetch public audiobook metadata; no personal data is sent.</li></ul><p>We never sell data, never show ads, never track you across other apps or sites.</p><h2>4. Data retention</h2><p>Your tasks and account persist until you delete them or ask us to delete your account. Verification codes expire after 5 minutes and are deleted after use.</p><h2>5. Your rights</h2><p>Email us at <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> to: export your data, correct your data, or permanently delete your account.</p><h2>6. Children</h2><p>Brodoit is not directed at children under 13. We do not knowingly collect data from children under 13.</p><h2>7. Changes</h2><p>If we make material changes, we'll update the date at the top and notify you via email if we have your address.</p><h2>8. Contact</h2><p>Questions? <a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#94A3B8"><a href="/">← Back to Brodoit</a></p></body></html>`);
});

// Terms of Service
app.get('/terms',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Terms — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#0F172A;background:#F8FAFC;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#312E81}a{color:#3DAE5C}</style></head><body><h1>Terms of Service</h1><p><em>Last updated: April 2026</em></p><h2>1. The service</h2><p>Brodoit is a personal productivity app that lets you track tasks, listen to free public-domain audiobooks, and view daily motivational quotes.</p><h2>2. Your account</h2><p>You register with an email address or phone number. Keep your verification codes private. You're responsible for activity on your account.</p><h2>3. Acceptable use</h2><p>Don't abuse the service: no spam, no impersonation, no automated scraping, no attempts to disrupt the service. We may suspend accounts that do.</p><h2>4. Content</h2><p>You own your tasks and notes. We store them to show back to you. Audiobook content belongs to its respective public-domain authors and is served from the Internet Archive's LibriVox collection.</p><h2>5. No warranty</h2><p>The service is provided "as is". We try hard to keep it running but can't promise zero downtime or that reminders will always be delivered (WhatsApp/email providers can fail).</p><h2>6. Limitation of liability</h2><p>Brodoit is a personal tool. We're not liable for missed deadlines, lost data, or any consequential damages from using (or not using) the service.</p><h2>7. Changes</h2><p>We may update these terms. Continued use after a change means you accept the new terms.</p><h2>8. Contact</h2><p><a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#94A3B8"><a href="/">← Back to Brodoit</a></p></body></html>`);
});
app.get('/sw.js',(_,res)=>{res.set('Content-Type','application/javascript');res.send('self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){self.clients.claim()});self.addEventListener("fetch",function(e){});')});
app.get('/',(_,res)=>res.type('html').send(HTML));
app.get('*',(_,res)=>res.type('html').send(HTML));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('🚀 Brodoit running on port '+PORT));
