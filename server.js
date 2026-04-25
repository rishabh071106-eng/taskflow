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
try{db.exec("CREATE TABLE IF NOT EXISTS google_tokens(user_phone TEXT NOT NULL,email TEXT NOT NULL,access_token TEXT NOT NULL,refresh_token TEXT,expires_at INTEGER NOT NULL,scope TEXT,is_default INTEGER DEFAULT 1,created_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_phone,email))")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,user_phone TEXT NOT NULL,created_at INTEGER NOT NULL)")}catch(e){}

let tw=null;const TW_FROM=process.env.TWILIO_WHATSAPP_FROM||'whatsapp:+14155238886';
try{if(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN){tw=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);console.log('✅ Twilio connected')}}catch(e){console.log('⚠️',e.message)}

const genId=()=>'t_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
const genToken=()=>crypto.randomBytes(32).toString('hex');
const genOTP=()=>String(Math.floor(100000+Math.random()*900000));
const PRI={high:'🔴',medium:'🟠',low:'🟢'};
const fmtD=d=>d?new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const todayStr=()=>new Date().toISOString().split('T')[0];
const cleanPhone=p=>{let c=(p||'').replace(/[^0-9+]/g,'');if(!c.startsWith('+'))c='+'+c;return c};
function looksLikeMissingCountryCode(p){
  // Heuristic: 10 digits without + and starting with a non-1, non-7-9 digit isn't a country code.
  // If user types exactly 10 digits we suspect missing country code.
  const digits=(p||'').replace(/[^0-9]/g,'');
  return digits.length===10;
}

async function sendWA(to,body){
  if(!tw)return{ok:false,reason:'Twilio not configured',code:'NO_TWILIO'};
  try{const n=to.startsWith('whatsapp:')?to:'whatsapp:'+to;const m=await tw.messages.create({from:TW_FROM,to:n,body});return{ok:true,sid:m.sid,status:m.status}}catch(e){return{ok:false,reason:e.message||String(e),code:e.code||0,moreInfo:e.moreInfo||''}}
}
function waErrorMessage(r){
  const c=r.code;
  if(c===21211||c===21214||c===21217)return 'Phone number format is invalid. Include the country code (e.g. +91 9876543210 for India).';
  if(c===63007)return 'WhatsApp number not registered for this account.';
  if(c===63015||c===63016)return 'WhatsApp link to BroDoit has expired. Tap "Re-send join code" below to refresh it (links expire after 72h of inactivity).';
  if(c===63018)return 'Daily message limit reached. Try again in a few hours or use email login.';
  if(c===21610)return 'This number opted out of BroDoit messages. Tap "Re-send join code" below to opt back in.';
  return 'WhatsApp delivery failed. Tap "Re-send join code" below \\u2014 you may need to reconnect to BroDoit on WhatsApp.';
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
  const rawPhone=String(req.body.phone||'');
  if(looksLikeMissingCountryCode(rawPhone))return res.status(400).json({error:'Add your country code (e.g. +91 for India, +1 for US/Canada). 10 digits alone are ambiguous.',hint:'missing_country_code'});
  const phone=cleanPhone(rawPhone);
  if(phone.length<10||!/^\+\d{8,15}$/.test(phone))return res.status(400).json({error:'Phone number must look like +<country><number>, e.g. +91 9876543210.'});
  if(rateLimited('wa:'+phone))return res.status(429).json({error:'Too many requests. Try again in 10 minutes.'});
  const code=genOTP();
  const expires=new Date(Date.now()+5*60*1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at)VALUES(?,?,?)').run(phone,code,expires);
  const r=await sendWA(phone,`🔐 Your Brodoit verification code is: *${code}*\n\nThis code expires in 5 minutes.\nDo not share this code with anyone.`);
  if(r.ok)res.json({ok:true,message:'OTP sent to your WhatsApp',phone,sid:r.sid});
  else{
    console.log('[send-otp] failed for',phone,'code:',r.code,'reason:',r.reason);
    res.status(500).json({ok:false,error:waErrorMessage(r),detail:r.reason,code:r.code,sentTo:phone});
  }
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

// ═══ GOOGLE CALENDAR INTEGRATION (OAuth 2.0) ═══
const G_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const G_CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET||'';
const G_REDIRECT=process.env.GOOGLE_REDIRECT_URI||(process.env.PUBLIC_URL?process.env.PUBLIC_URL.replace(/\/$/,'')+'/api/google/callback':'https://brodoit.com/api/google/callback');
const G_SCOPES=['https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/userinfo.email','openid'].join(' ');
const googleConfigured=()=>!!(G_CLIENT_ID&&G_CLIENT_SECRET);
app.get('/api/google/status',auth,(req,res)=>{
  const accounts=db.prepare('SELECT email,is_default,created_at FROM google_tokens WHERE user_phone=? ORDER BY is_default DESC,created_at ASC').all(req.user.phone);
  res.json({configured:googleConfigured(),accounts,redirectUri:G_REDIRECT});
});
app.get('/api/google/auth-url',auth,(req,res)=>{
  if(!googleConfigured())return res.status(503).json({error:'Google integration not configured. Admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'});
  const state=crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_states(state,user_phone,created_at)VALUES(?,?,?)').run(state,req.user.phone,Date.now());
  // expire old states (>10 min)
  db.prepare('DELETE FROM oauth_states WHERE created_at<?').run(Date.now()-10*60*1000);
  const params=new URLSearchParams({client_id:G_CLIENT_ID,redirect_uri:G_REDIRECT,response_type:'code',scope:G_SCOPES,access_type:'offline',prompt:'consent select_account',state,include_granted_scopes:'true'});
  res.json({url:'https://accounts.google.com/o/oauth2/v2/auth?'+params.toString()});
});
app.get('/api/google/callback',async(req,res)=>{
  const{code,state,error:authErr}=req.query;
  if(authErr)return res.send('<html><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Connection cancelled</h2><p>'+String(authErr).replace(/[<>]/g,'')+'</p><a href="/">Back to Brodoit</a></body></html>');
  if(!code||!state)return res.status(400).send('Missing code or state');
  const row=db.prepare('SELECT user_phone FROM oauth_states WHERE state=?').get(state);
  if(!row)return res.status(400).send('Invalid or expired state');
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
  try{
    const tokenResp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:G_CLIENT_ID,client_secret:G_CLIENT_SECRET,redirect_uri:G_REDIRECT,grant_type:'authorization_code'}).toString()});
    const tj=await tokenResp.json();
    if(!tj.access_token)return res.status(400).send('<html><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Token exchange failed</h2><pre>'+JSON.stringify(tj).replace(/[<>]/g,'')+'</pre></body></html>');
    const ui=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+tj.access_token}}).then(r=>r.json()).catch(()=>({}));
    const email=(ui.email||'').toLowerCase();
    if(!email)return res.status(400).send('Could not read your Google email.');
    const expires_at=Date.now()+(tj.expires_in||3600)*1000;
    const existing=db.prepare('SELECT email FROM google_tokens WHERE user_phone=?').all(row.user_phone);
    const isFirst=existing.length===0?1:0;
    db.prepare("INSERT INTO google_tokens(user_phone,email,access_token,refresh_token,expires_at,scope,is_default)VALUES(?,?,?,?,?,?,?)ON CONFLICT(user_phone,email) DO UPDATE SET access_token=excluded.access_token,refresh_token=COALESCE(excluded.refresh_token,google_tokens.refresh_token),expires_at=excluded.expires_at,scope=excluded.scope").run(row.user_phone,email,tj.access_token,tj.refresh_token||null,expires_at,tj.scope||'',isFirst);
    res.send('<html><head><title>Brodoit \\u2014 Google connected</title></head><body style="font-family:system-ui;padding:40px;text-align:center;background:linear-gradient(135deg,#EDFCF2,#FFF);min-height:100vh;display:flex;align-items:center;justify-content:center"><div><div style="font-size:72px">\\u2705</div><h2 style="margin:8px 0;font-size:26px">Google Calendar connected</h2><p style="color:#64748B;font-size:15px;margin-bottom:24px"><b>'+email.replace(/[<>]/g,'')+'</b> is now linked. Closing this tab\\u2026</p><a href="/" style="display:inline-block;padding:12px 24px;background:#0F172A;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Open Brodoit</a><script>setTimeout(()=>{try{if(window.opener){window.opener.postMessage({type:"google-connected",email:"'+email.replace(/[^a-z0-9@._-]/gi,'')+'"},"*");window.close()}else{location.href="/?google=connected"}}catch(e){location.href="/?google=connected"}},1500);<\\/script></div></body></html>');
  }catch(e){res.status(500).send('Auth error: '+String(e.message).replace(/[<>]/g,''))}
});
async function gAccessToken(user_phone,email){
  const row=email?db.prepare('SELECT * FROM google_tokens WHERE user_phone=? AND email=?').get(user_phone,email):db.prepare('SELECT * FROM google_tokens WHERE user_phone=? ORDER BY is_default DESC LIMIT 1').get(user_phone);
  if(!row)return null;
  if(Date.now()<row.expires_at-30000)return{token:row.access_token,email:row.email};
  if(!row.refresh_token)return null;
  try{
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:G_CLIENT_ID,client_secret:G_CLIENT_SECRET,refresh_token:row.refresh_token,grant_type:'refresh_token'}).toString()});
    const j=await r.json();
    if(!j.access_token)return null;
    const expires_at=Date.now()+(j.expires_in||3600)*1000;
    db.prepare('UPDATE google_tokens SET access_token=?,expires_at=? WHERE user_phone=? AND email=?').run(j.access_token,expires_at,user_phone,row.email);
    return{token:j.access_token,email:row.email};
  }catch(e){return null}
}
app.post('/api/google/disconnect',auth,(req,res)=>{
  const email=(req.body.email||'').toLowerCase();
  if(email)db.prepare('DELETE FROM google_tokens WHERE user_phone=? AND email=?').run(req.user.phone,email);
  else db.prepare('DELETE FROM google_tokens WHERE user_phone=?').run(req.user.phone);
  res.json({ok:true});
});
app.post('/api/google/set-default',auth,(req,res)=>{
  const email=(req.body.email||'').toLowerCase();if(!email)return res.status(400).json({error:'email required'});
  const exists=db.prepare('SELECT 1 FROM google_tokens WHERE user_phone=? AND email=?').get(req.user.phone,email);
  if(!exists)return res.status(404).json({error:'not connected'});
  db.prepare('UPDATE google_tokens SET is_default=0 WHERE user_phone=?').run(req.user.phone);
  db.prepare('UPDATE google_tokens SET is_default=1 WHERE user_phone=? AND email=?').run(req.user.phone,email);
  res.json({ok:true});
});
app.get('/api/calendar/events',auth,async(req,res)=>{
  const email=req.query.email;const ga=await gAccessToken(req.user.phone,email);
  if(!ga)return res.status(400).json({error:'Google Calendar not connected'});
  const now=new Date();const from=req.query.from||new Date(now.getFullYear(),now.getMonth()-1,1).toISOString();const to=req.query.to||new Date(now.getFullYear(),now.getMonth()+2,0).toISOString();
  const url='https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin='+encodeURIComponent(from)+'&timeMax='+encodeURIComponent(to)+'&singleEvents=true&orderBy=startTime&maxResults=100';
  try{
    const r=await fetch(url,{headers:{Authorization:'Bearer '+ga.token}});
    const j=await r.json();
    if(j.error)return res.status(400).json({error:j.error.message||'fetch failed'});
    const items=(j.items||[]).map(e=>({id:e.id,title:e.summary||'(no title)',start:e.start?.dateTime||e.start?.date||'',end:e.end?.dateTime||e.end?.date||'',allDay:!!(e.start&&e.start.date&&!e.start.dateTime),link:e.htmlLink,location:e.location||''}));
    res.json({email:ga.email,events:items});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/calendar/events',auth,async(req,res)=>{
  const{title,date,time,duration,notes,email}=req.body;
  if(!title||!date)return res.status(400).json({error:'title and date required'});
  const ga=await gAccessToken(req.user.phone,email);if(!ga)return res.status(400).json({error:'Google Calendar not connected'});
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  let body;
  if(time){const startISO=date+'T'+time+':00';const endTime=new Date(new Date(startISO).getTime()+(duration||30)*60000).toISOString().slice(0,19);body={summary:title,description:notes||'Created via Brodoit',start:{dateTime:startISO,timeZone:tz},end:{dateTime:endTime,timeZone:tz}}}
  else body={summary:title,description:notes||'Created via Brodoit',start:{date},end:{date}};
  try{
    const r=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events',{method:'POST',headers:{Authorization:'Bearer '+ga.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(j.error)return res.status(400).json({error:j.error.message});
    res.json({ok:true,event:{id:j.id,title:j.summary,link:j.htmlLink,start:j.start?.dateTime||j.start?.date}});
  }catch(e){res.status(500).json({error:e.message})}
});
app.delete('/api/calendar/events/:id',auth,async(req,res)=>{
  const ga=await gAccessToken(req.user.phone,req.query.email);if(!ga)return res.status(400).json({error:'not connected'});
  try{
    const r=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+encodeURIComponent(req.params.id),{method:'DELETE',headers:{Authorization:'Bearer '+ga.token}});
    if(r.status===204||r.ok)return res.json({ok:true});
    const j=await r.json().catch(()=>({}));
    res.status(400).json({error:j.error?.message||'delete failed'});
  }catch(e){res.status(500).json({error:e.message})}
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
app.get('/brodoit.vcf',(_,res)=>{
  const num=(process.env.TWILIO_WHATSAPP_FROM||'whatsapp:+14155238886').replace(/^whatsapp:/,'');
  const vcf=['BEGIN:VCARD','VERSION:3.0','FN:BroDoit','N:BroDoit;;;;','ORG:BroDoit','TITLE:Productivity Assistant','TEL;TYPE=CELL,VOICE,WHATSAPP:'+num,'EMAIL:hello@brodoit.com','URL:https://brodoit.com','NOTE:Your BroDoit assistant. Send tasks here and get reminders.','END:VCARD'].join('\\r\\n');
  res.setHeader('Content-Type','text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="BroDoit.vcf"');
  res.send(vcf);
});

// ═══ NEWS (shorts feed, RSS aggregator, 15-min server cache) ═══
const NEWS_FEEDS={
  ai:['https://techcrunch.com/category/artificial-intelligence/feed/','https://venturebeat.com/category/ai/feed/','https://www.theverge.com/rss/ai-artificial-intelligence/index.xml','https://www.technologyreview.com/feed/','https://openai.com/blog/rss.xml'],
  sports:['https://feeds.bbci.co.uk/sport/rss.xml','https://www.espn.com/espn/rss/news','https://www.skysports.com/rss/12040','https://feeds.bbci.co.uk/sport/cricket/rss.xml'],
  technology:['https://techcrunch.com/feed/','https://www.theverge.com/rss/index.xml','https://feeds.arstechnica.com/arstechnica/index','https://www.wired.com/feed/rss'],
  movies:['https://variety.com/v/film/feed/','https://www.hollywoodreporter.com/c/movies/movie-news/feed/','https://www.indiewire.com/c/film/feed/'],
  global:['https://feeds.bbci.co.uk/news/world/rss.xml','https://feeds.reuters.com/reuters/topNews','https://rss.nytimes.com/services/xml/rss/nyt/World.xml','https://feeds.npr.org/1004/rss.xml']
};
// Scenic Unsplash fallbacks (hot-link friendly CDN) — used when an article has no image
const UNSPLASH=(id)=>'https://images.unsplash.com/photo-'+id+'?w=900&q=80&auto=format&fit=crop';
const FALLBACK_IMAGES={
  ai:[UNSPLASH('1677442136019-21780ecad995'),UNSPLASH('1620712943543-bcc4688e7485'),UNSPLASH('1488229297570-58520851e868'),UNSPLASH('1518770660439-4636190af475'),UNSPLASH('1551434678-e076c223a692'),UNSPLASH('1485827404703-89b55fcc595e')],
  sports:[UNSPLASH('1461896836934-ffe607ba8211'),UNSPLASH('1517649763962-0c623066013b'),UNSPLASH('1556056504-5c7696c4c28d'),UNSPLASH('1431324155629-1a6deb1dec8d'),UNSPLASH('1574629810360-7efbbe195018'),UNSPLASH('1552674605-db6ffd4facb5')],
  technology:[UNSPLASH('1518770660439-4636190af475'),UNSPLASH('1451187580459-43490279c0fa'),UNSPLASH('1531297484001-80022131f5a1'),UNSPLASH('1550751827-4bd374c3f58b'),UNSPLASH('1581091226825-a6a2a5aee158'),UNSPLASH('1460925895917-afdab827c52f')],
  movies:[UNSPLASH('1489599849927-2ee91cede3ba'),UNSPLASH('1536440136628-849c177e76a1'),UNSPLASH('1517604931442-7e0c8ed2963c'),UNSPLASH('1542204165-65bf26472b9b'),UNSPLASH('1485846234645-a62644f84728'),UNSPLASH('1440404653325-ab127d49abc1')],
  global:[UNSPLASH('1506905925346-21bda4d32df4'),UNSPLASH('1469854523086-cc02fe5d8800'),UNSPLASH('1501785888041-af3ef285b470'),UNSPLASH('1502602898657-3e91760cbb34'),UNSPLASH('1480714378408-67cf0d13bc1b'),UNSPLASH('1564507592333-c60657eea523')]
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
async function fetchOgImage(url){
  try{const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),3500);const r=await fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Mozilla/5.0 (compatible; Brodoit/1.0; +https://brodoit.com)','Accept':'text/html,application/xhtml+xml'}});clearTimeout(t);if(!r.ok)return null;const html=await r.text();const head=html.slice(0,80000);const patterns=[/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i];for(const p of patterns){const m=head.match(p);if(m&&m[1])return m[1].replace(/&amp;/g,'&')}return null;}catch(e){return null}
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
  // Enrich items missing img by scraping og:image (top 12 in parallel, ~3.5s each, capped overall)
  const toEnrich=dedup.filter(it=>!it.img&&it.link).slice(0,12);
  if(toEnrich.length){
    await Promise.race([
      Promise.all(toEnrich.map(async it=>{const og=await fetchOgImage(it.link);if(og)it.img=og})),
      new Promise(r=>setTimeout(r,7000))
    ]);
  }
  // Anything still without an image gets a curated scenic Unsplash fallback
  const fb=FALLBACK_IMAGES[cat]||FALLBACK_IMAGES.global;
  let fbIdx=0;
  for(const it of dedup){if(!it.img){it.img=fb[fbIdx%fb.length];it.imgFallback=true;fbIdx++}}
  newsCache[cat]={ts:Date.now(),items:dedup};
  res.json({items:dedup,cat,cached:false});
});

// ═══ HISTORY (Wikipedia "On This Day", 6-hour server cache) ═══
const historyCache={};
app.get('/api/history/today',async(req,res)=>{
  const now=new Date();
  const m=String(now.getMonth()+1).padStart(2,'0');
  const d=String(now.getDate()).padStart(2,'0');
  const key=m+'-'+d;
  const c=historyCache[key];
  if(c&&Date.now()-c.ts<6*60*60*1000)return res.json({events:c.events,date:key,cached:true});
  try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),6000);
    const url='https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/'+m+'/'+d;
    const r=await fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0 (+https://brodoit.com)','Accept':'application/json'}});
    clearTimeout(t);
    if(!r.ok)return res.json({events:[],date:key,error:'fetch '+r.status});
    const j=await r.json();
    const events=(j.events||[]).slice(0,30).map(ev=>{
      const page=(ev.pages||[])[0]||{};
      return{year:ev.year,text:ev.text,title:page.normalizedtitle||page.title||'',url:(page.content_urls&&page.content_urls.desktop&&page.content_urls.desktop.page)||'',thumb:(page.thumbnail&&page.thumbnail.source)||null,extract:page.extract||''};
    }).sort((a,b)=>b.year-a.year);
    historyCache[key]={ts:Date.now(),events};
    res.json({events,date:key,cached:false});
  }catch(e){res.json({events:[],date:key,error:String(e)})}
});

// ═══ WIKIPEDIA SUMMARIES (24-hour cache) — powers History & Geography magazine cards ═══
const wikiCache={};
app.get('/api/wiki/summaries',async(req,res)=>{
  const titles=String(req.query.titles||'').split(',').map(t=>t.trim()).filter(Boolean).slice(0,12);
  if(!titles.length)return res.json({summaries:[]});
  const key=titles.join('|');
  const c=wikiCache[key];
  if(c&&Date.now()-c.ts<24*60*60*1000)return res.json({summaries:c.data,cached:true});
  const results=await Promise.all(titles.map(async t=>{
    try{
      const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),5000);
      const r=await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(t.replace(/ /g,'_')),{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0 (+https://brodoit.com)','Accept':'application/json'}});
      clearTimeout(tm);
      if(!r.ok)return null;
      const j=await r.json();
      return{
        title:j.normalizedtitle||j.title||t,
        slug:t,
        extract:j.extract||'',
        thumb:(j.thumbnail&&j.thumbnail.source)||null,
        hero:(j.originalimage&&j.originalimage.source)||(j.thumbnail&&j.thumbnail.source)||null,
        url:(j.content_urls&&j.content_urls.desktop&&j.content_urls.desktop.page)||('https://en.wikipedia.org/wiki/'+encodeURIComponent(t)),
        description:j.description||''
      };
    }catch(e){return null}
  }));
  const summaries=results.filter(Boolean);
  wikiCache[key]={ts:Date.now(),data:summaries};
  res.json({summaries,cached:false});
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
<meta name="google-site-verification" content="0dus2qjhVhSPP2gWIDJlVBb7LxvrMDbrhECxY8tiO4U" />
<meta name="theme-color" content="#1A1816"><link rel="manifest" href="/manifest.json"><title>Brodoit</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
--bg:#FAFAF7;--bg-elev:#FFFFFF;--bg-sunken:#F4F3EE;
--ink:#1A1A1A;--ink-2:#3D3D3D;--ink-3:#6B6B6B;--ink-4:#9A9A9A;--ink-5:#CFCFCF;
--line:#E8E6E0;--line-2:#DEDBD3;
--accent:#1F4D3F;--accent-soft:#E6EFEA;--accent-ink:#0E2E25;
--shadow-1:0 1px 2px rgba(26,26,26,.04),0 1px 3px rgba(26,26,26,.06);
--shadow-2:0 4px 8px rgba(26,26,26,.04),0 8px 24px rgba(26,26,26,.06);
--radius:12px}
body{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'cv11','ss01','ss03';letter-spacing:-.011em;font-weight:450}
::selection{background:rgba(31,77,63,.18);color:var(--ink)}
button{cursor:pointer;font-family:inherit;-webkit-font-smoothing:inherit}
input,textarea,select{font-family:inherit;-webkit-font-smoothing:inherit}
h1,h2,h3,h4{font-family:'Instrument Serif','Playfair Display',Georgia,serif;font-weight:400;letter-spacing:-.02em;color:var(--ink)}
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
.hdr-tagline{display:none;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:13px;color:#94A3B8;margin-top:2px;letter-spacing:.04em}
/* Phone scenic masthead — desktop hidden by default */
.phone-banner{display:none}
@media (max-width:700px){
  .phone-banner{display:block;position:relative;width:100%;height:110px;margin:0 0 14px;overflow:hidden;border-radius:14px;background:#0F172A;box-sizing:border-box;max-width:100%}
  .phone-banner-img{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;animation:phoneCycle 15s ease-in-out infinite;will-change:opacity,transform}
  .phone-banner-img:nth-child(1){opacity:.9;animation-delay:0s}
  .phone-banner-img:nth-child(2){animation-delay:5s}
  .phone-banner-img:nth-child(3){animation-delay:10s}
  @keyframes phoneCycle{
    0%{opacity:0;transform:scale(1.05)}
    7%,30%{opacity:.9;transform:scale(1)}
    37%,100%{opacity:0;transform:scale(1.14)}
  }
  .phone-banner::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.18) 0%,rgba(15,23,42,.5) 100%);pointer-events:none;z-index:1}
  .phone-banner-tag{position:absolute;bottom:7px;left:0;right:0;text-align:center;font-size:9px;font-weight:800;letter-spacing:2px;color:rgba(255,255,255,.85);z-index:2;text-shadow:0 1px 4px rgba(0,0,0,.5)}
  .hdr-tagline{display:block}
  .hdr{padding:0 2px;margin-bottom:14px}
  .app{overflow-x:hidden}
}
@media (max-width:380px){.phone-banner{height:90px}}
body[data-theme=aurora] .phone-banner{background:#0A0A14}
body[data-theme=aurora] .hdr-tagline{color:#9999B5}
.hdr-st{font-size:11px;font-weight:700;padding:8px 14px;border-radius:10px;background:#FFFFFF;border:1px solid #E8E9EF;display:flex;align-items:center;gap:7px;letter-spacing:.8px;box-shadow:0 2px 6px rgba(0,0,0,.04)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;animation:pulse-dot 2s ease-in-out infinite}
.hdr-sub{margin-top:4px;font-weight:500;display:flex;align-items:center;gap:14px;font-family:'Instrument Serif',Georgia,serif;font-size:15px;letter-spacing:.02em;color:#64748B}
/* Jump-rope figure in the header */
.hdr-jumper{width:50px;height:50px;flex-shrink:0;color:#6366F1;filter:drop-shadow(0 2px 8px rgba(99,102,241,.32))}
.hdr-jumper .jumper{transform-origin:30px 32px;animation:hdrJump .85s ease-in-out infinite}
.hdr-jumper .leg-l{transform-origin:30px 32px;animation:jumpLegL .85s ease-in-out infinite}
.hdr-jumper .leg-r{transform-origin:30px 32px;animation:jumpLegR .85s ease-in-out infinite}
.hdr-jumper .rope-top{animation:ropeTop .85s linear infinite}
.hdr-jumper .rope-bottom{animation:ropeBottom .85s linear infinite}
.hdr-jumper .ground{stroke:#94A3B8;opacity:.35}
.hdr-jumper .puff{animation:puffPop .85s ease-out infinite}
@keyframes hdrJump{0%,100%{transform:translateY(0)}40%{transform:translateY(-7px)}50%{transform:translateY(-7px)}}
@keyframes jumpLegL{0%,100%{transform:translateY(0) rotate(0deg)}40%,50%{transform:translateY(-7px) rotate(-12deg)}}
@keyframes jumpLegR{0%,100%{transform:translateY(0) rotate(0deg)}40%,50%{transform:translateY(-7px) rotate(12deg)}}
@keyframes ropeTop{0%,49%{opacity:0}50%,100%{opacity:1}}
@keyframes ropeBottom{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes puffPop{0%{opacity:0;transform:scale(.4)}10%{opacity:.85;transform:scale(1)}40%,100%{opacity:0;transform:scale(1.3)}}
/* Live time block in the header */
.hdr-time{display:flex;align-items:baseline;gap:6px;font-family:'Instrument Serif',Georgia,serif}
.hdr-time-hm{font-size:24px;font-weight:400;letter-spacing:-.02em;color:#0F172A;line-height:1}
.hdr-time-sec{font-size:14px;color:#E8453C;animation:secBlink 1s steps(2) infinite;font-weight:400}
.hdr-time-sep{color:#CBD5E1;font-size:18px;margin:0 4px}
.hdr-time-date{font-size:14px;color:#64748B;font-style:italic}
body[data-theme=aurora] .hdr-time-hm{color:#F5F5FA}
body[data-theme=aurora] .hdr-time-date{color:#9999B5}
@media (max-width:700px){
  /* Single timer on phone: drop the header time entirely; LOCAL TIME card below is enough */
  .hdr-time{display:none}
  .hdr-jumper{width:42px;height:42px}
  .hdr-sub{gap:10px;flex-wrap:wrap;font-size:13px}
}
/* Section dividers — thin gradient line with a pulsing centered node */
.section-div{height:1px;background:linear-gradient(90deg,transparent 0%,rgba(99,102,241,.18) 30%,rgba(232,145,44,.22) 50%,rgba(99,102,241,.18) 70%,transparent 100%);margin:18px 0;position:relative}
/* Tap Sprint mini-game */
.game-card{background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(236,72,153,.05));border:1px solid rgba(99,102,241,.18);border-radius:16px;padding:18px 22px 20px;margin-bottom:18px;display:flex;flex-direction:column;gap:12px;position:relative;overflow:hidden}
.game-card::before{content:'';position:absolute;top:-30px;right:-30px;width:140px;height:140px;background:radial-gradient(circle,rgba(99,102,241,.18),transparent 65%);pointer-events:none}
.game-hd{display:flex;align-items:center;justify-content:space-between;gap:12px}
.game-ttl{font-family:'Instrument Serif',Georgia,serif;font-size:20px;color:#0F172A;display:flex;align-items:center;gap:8px;letter-spacing:-.01em}
.game-emoji{display:inline-block;animation:gemPulse 2s ease-in-out infinite}
@keyframes gemPulse{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.12) rotate(-6deg)}}
.game-best{font-size:12px;color:#64748B;font-weight:600;background:rgba(255,255,255,.7);padding:5px 10px;border-radius:99px;border:1px solid rgba(15,23,42,.06)}
.game-best b{color:#6366F1;font-family:'Space Mono',monospace;font-weight:700;margin-left:4px;font-size:13px}
.game-cta{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.game-prompt{font-size:13px;color:#475569;line-height:1.4;flex:1;min-width:200px}
.game-btn{font-size:13px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6366F1,#EC4899);border:none;padding:10px 20px;border-radius:11px;cursor:pointer;box-shadow:0 6px 18px rgba(99,102,241,.3);transition:transform .15s ease,box-shadow .15s ease}
.game-btn:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(99,102,241,.4)}
.game-btn:active{transform:scale(.96)}
.game-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:260px;margin:0 auto}
.game-cell{aspect-ratio:1;border-radius:14px;background:rgba(255,255,255,.85);border:2px solid rgba(99,102,241,.14);cursor:pointer;transition:border-color .15s ease,background .15s ease,transform .12s ease;position:relative;font-family:'Instrument Serif',Georgia,serif;font-size:42px;font-weight:400;color:#0F172A;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.game-cell:focus{outline:none}
.game-cell:focus-visible{outline:2px solid rgba(99,102,241,.4);outline-offset:2px}
.game-cell:hover:not(.ttt-filled){border-color:rgba(99,102,241,.5);background:#fff}
.game-cell:active:not(.ttt-filled){transform:scale(.96)}
.game-cell.ttt-x{color:#E8453C;border-color:rgba(232,69,60,.4);background:linear-gradient(135deg,#fff,#FFE4E1);cursor:default}
.game-cell.ttt-o{color:#3B82F6;border-color:rgba(59,130,246,.4);background:linear-gradient(135deg,#fff,#EFF6FF);cursor:default}
.game-cell.ttt-filled{cursor:default}
.game-cell.ttt-win{animation:tttWinPulse 1s ease-in-out infinite;border-width:3px}
@keyframes tttWinPulse{0%,100%{box-shadow:0 0 0 0 rgba(232,145,44,.45),0 6px 18px rgba(15,23,42,.12);transform:scale(1)}50%{box-shadow:0 0 0 8px rgba(232,145,44,0),0 8px 22px rgba(15,23,42,.18);transform:scale(1.05)}}
.game-status-line{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:13px}
.game-status{font-weight:700;letter-spacing:-.01em;transition:color .2s ease}
.status-you{color:#E8453C}
.status-bot{color:#3B82F6}
.game-best b{color:#0F172A;font-family:'Space Mono',monospace;font-weight:700;margin:0 1px;font-size:13px}
.ttt-grid{max-width:280px}
.game-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;font-weight:700;margin-top:2px}
.game-hint{color:#94A3B8;font-weight:600;letter-spacing:.4px}
.game-score{font-family:'Instrument Serif',Georgia,serif;font-size:20px;color:#6366F1;font-weight:400}
.game-prompt b{color:#6366F1;font-weight:800}
.game-stop{font-size:11.5px;font-weight:700;padding:6px 12px;border-radius:8px;background:rgba(15,23,42,.06);border:none;color:#64748B;cursor:pointer}
.game-stop:hover{background:rgba(232,69,60,.1);color:#E8453C}
body[data-theme=aurora] .game-card{background:linear-gradient(135deg,rgba(167,139,250,.1),rgba(244,114,182,.08));border-color:rgba(167,139,250,.2)}
body[data-theme=aurora] .game-ttl{color:#F5F5FA}
body[data-theme=aurora] .game-best{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#9999B5}
body[data-theme=aurora] .game-best b{color:#A78BFA}
body[data-theme=aurora] .game-prompt{color:#9999B5}
body[data-theme=aurora] .game-cell{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .game-time{color:#F5F5FA}
body[data-theme=aurora] .game-score{color:#A78BFA}
body[data-theme=aurora] .game-stop{background:rgba(255,255,255,.05);color:#9999B5}
@media (max-width:600px){.game-grid{max-width:220px;gap:6px}.game-ttl{font-size:18px}.game-prompt{font-size:12px;min-width:0}.game-btn{padding:9px 16px;font-size:12.5px}}
/* Top strip + climb + side-now base styles (work on all viewports) */
.top-strip{display:flex;flex-direction:column;align-items:stretch;background:linear-gradient(135deg,rgba(99,102,241,.06) 0%,rgba(232,145,44,.06) 100%);border:1px solid rgba(99,102,241,.18);border-radius:14px;min-height:auto;position:relative;overflow:hidden;margin-bottom:0;box-shadow:0 4px 16px rgba(15,23,42,.04)}
.top-strip .climb-scene,.top-strip .bro-mascot{position:relative;flex:0 0 auto;border-radius:0;background:transparent;border:none;min-height:56px;overflow:hidden;padding:6px 12px;display:flex;align-items:center;justify-content:center}
.top-strip .bro-svg{width:100%;height:auto;max-height:54px}
.bro-mascot .bro-figure{transform-origin:48px 110px;animation:broNod 2.4s ease-in-out infinite}
@keyframes broNod{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-3px) rotate(1.5deg)}}
.bro-mascot .bro-arm-r{transform-origin:48px 72px;animation:broWave 1.4s ease-in-out infinite}
@keyframes broWave{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-12deg)}}
.bro-mascot .bro-bubble{transform-origin:216px 50px;animation:broBubble 3s ease-in-out infinite}
@keyframes broBubble{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
.bro-mascot .bro-spark{transform-origin:323px 38px;animation:broSpin 6s linear infinite}
@keyframes broSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.bro-mascot .bro-spark2{animation:broTwinkle 1.6s ease-in-out infinite}
@keyframes broTwinkle{0%,100%{opacity:.3;transform:scale(.7)}50%{opacity:1;transform:scale(1.1)}}
body[data-theme=aurora] .bro-mascot .bro-bubble path{fill:rgba(255,255,255,.06);stroke:rgba(167,139,250,.6)}
body[data-theme=aurora] .bro-mascot .bro-bubble text:first-of-type{fill:#F5F5FA}
body[data-theme=aurora] .bro-mascot .bro-bubble text:last-of-type{fill:#A78BFA}
body[data-theme=aurora] .bro-mascot .bro-figure circle:first-child{fill:#A78BFA}
body[data-theme=aurora] .bro-mascot .bro-figure line{stroke:#A78BFA}
.top-strip .side-now{flex:0 0 auto;background:linear-gradient(135deg,rgba(99,102,241,.04),rgba(232,145,44,.04));border-top:1px dashed rgba(99,102,241,.25);border-left:none;padding:8px 14px 10px;display:flex;flex-direction:column;justify-content:center;gap:2px;position:relative;overflow:hidden;margin-top:0}
.top-strip .side-now-lbl{font-size:9px;font-weight:800;color:#6366F1;letter-spacing:1.2px;text-transform:uppercase}
.top-strip .side-now-time{font-family:'Instrument Serif',Georgia,serif;font-size:22px;font-weight:400;color:#0F172A;line-height:1;letter-spacing:-.03em;margin-top:0}
.top-strip .side-now-time .sec{color:#E8453C;animation:secBlink 1s steps(2) infinite;font-size:13px;margin-left:2px;display:inline-block;vertical-align:top;margin-top:4px}
.top-strip .side-now-date{font-size:12px;color:#64748B;font-weight:600}
.top-strip .side-now-stat{font-size:11px;color:#475569;font-weight:600;margin-top:4px;display:flex;align-items:center;gap:5px}
.top-strip .side-now-stat b{font-family:'Instrument Serif',Georgia,serif;font-size:15px;font-weight:400;color:#E8453C;letter-spacing:-.02em;line-height:1}
.top-strip .side-now-bar{height:5px;border-radius:99px;background:rgba(99,102,241,.14);overflow:hidden;margin-top:6px;position:relative}
.top-strip .side-now-fill{height:100%;background:linear-gradient(90deg,#6366F1,#8B5CF6,#EC4899,#E8912C);background-size:200% 100%;border-radius:99px;position:relative;overflow:hidden;animation:gradientShift 4s ease-in-out infinite}
@keyframes gradientShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.top-strip .side-now-fill::after{content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:fillShine 2.6s ease-in-out infinite}
/* Comet that travels the full year-progress bar */
.top-strip .side-now-comet{position:absolute;top:50%;left:0;width:10px;height:10px;border-radius:50%;background:#fff;box-shadow:0 0 12px rgba(255,255,255,.85),0 0 20px rgba(99,102,241,.6);transform:translate(-50%,-50%);animation:cometRun 6s linear infinite;z-index:2;pointer-events:none}
@keyframes cometRun{from{left:0%}to{left:100%}}
body[data-theme=aurora] .top-strip .side-now-stat{color:#9999B5}
body[data-theme=aurora] .top-strip .side-now-stat b{color:#F472B6}
.top-strip .side-now-foot{font-size:9px;color:#94A3B8;font-weight:700;letter-spacing:.5px;display:flex;justify-content:space-between;margin-top:2px}
.top-strip .side-now-wave{position:absolute;bottom:0;left:0;right:0;height:30px;opacity:.15;pointer-events:none}
@media (max-width:900px){.top-strip{flex-direction:column;min-height:auto}.top-strip .bro-mascot{min-height:120px;padding:4px 8px}.top-strip .side-now{flex:0 0 auto;border-left:none;border-top:1px dashed rgba(99,102,241,.25)}.top-strip .side-now-time{font-size:30px}.top-strip .side-now-time .sec{font-size:18px}}
@media (max-width:600px){
  /* Hide the bro-mascot on phones — the masthead photo banner above already gives the visual hook */
  .top-strip .bro-mascot{display:none}
  .top-strip{border-radius:14px;min-height:auto}
  .top-strip .side-now{padding:14px 16px;border-top:none}
  .top-strip .side-now-time{font-size:28px}
  .top-strip .side-now-time .sec{font-size:16px}
  .top-strip .side-now-lbl{font-size:9.5px;letter-spacing:1.2px}
  .top-strip .side-now-bar{margin-top:6px}
  .top-strip .side-now-foot{font-size:9.5px}
}
body[data-theme=aurora] .top-strip{background:linear-gradient(135deg,rgba(167,139,250,.08) 0%,rgba(232,145,44,.06) 100%);border-color:rgba(167,139,250,.18)}
body[data-theme=aurora] .top-strip .side-now{background:linear-gradient(135deg,rgba(167,139,250,.06),rgba(232,145,44,.04));border-left-color:rgba(167,139,250,.2)}
body[data-theme=aurora] .top-strip .side-now-time{color:#F5F5FA}
body[data-theme=aurora] .top-strip .side-now-date{color:#9999B5}
/* Climb scene base styles (used inside .top-strip on every screen) */
.climb-stairs{position:absolute;inset:0;width:100%;height:100%;opacity:.55}
.climb-caption{position:absolute;top:8px;left:0;right:0;text-align:center;font-size:9.5px;font-weight:800;color:#6366F1;letter-spacing:1.4px;opacity:.7;z-index:2}
.climber{position:absolute;width:18px;height:24px;color:#0F172A;animation:climbStairs 16s linear infinite;will-change:left,bottom;z-index:1}
.climber-1{color:#6366F1;animation-delay:0s}
.climber-2{color:#3DAE5C;animation-delay:5.3s}
.climber-3{color:#E8453C;animation-delay:10.6s}
.climb-peak{position:absolute;top:6px;right:10px;width:18px;height:18px;color:#E8912C;animation:peakBlink 1.8s ease-in-out infinite;z-index:2}
.walker{position:absolute;width:14px;height:20px;animation:walkAcross 14s linear infinite;will-change:left;z-index:1;opacity:.55}
.walker-a{color:#94A3B8;bottom:4%;animation-delay:0s}
.walker-b{color:#6366F1;bottom:4%;animation-delay:7s;animation-duration:11s}
.walker-c{color:#3DAE5C;bottom:32%;animation-delay:3.5s;animation-duration:13s}
@keyframes walkAcross{from{left:-6%}to{left:104%}}
.celebrator{position:absolute;top:6px;right:36px;width:20px;height:24px;color:#E8912C;z-index:2;animation:celebrate 1.1s ease-in-out infinite;transform-origin:50% 100%}
@keyframes celebrate{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-4px) rotate(4deg)}}
.section-div::before{content:'';position:absolute;top:50%;left:50%;width:8px;height:8px;border-radius:50%;background:#fff;border:2px solid rgba(99,102,241,.55);transform:translate(-50%,-50%);box-shadow:0 0 0 0 rgba(99,102,241,.45);animation:nodePulse 3s ease-in-out infinite}
@keyframes nodePulse{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.45)}50%{box-shadow:0 0 0 8px rgba(99,102,241,0)}}
body[data-theme=aurora] .section-div{background:linear-gradient(90deg,transparent 0%,rgba(167,139,250,.22) 50%,transparent 100%)}
body[data-theme=aurora] .section-div::before{background:#1A1A2E;border-color:rgba(167,139,250,.7)}
/* Tab hero floating particles — drift up over 6-9s with staggered delays */
.tab-hero{isolation:isolate}
.tab-hero-particles{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;opacity:.85}
.tab-hero-particles span{position:absolute;display:block;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 12px rgba(255,255,255,.6);animation:rise 7s ease-out infinite;bottom:-10px}
.tab-hero-particles span:nth-child(1){left:8%;width:4px;height:4px;animation-duration:8s;animation-delay:0s}
.tab-hero-particles span:nth-child(2){left:18%;width:3px;height:3px;animation-duration:6s;animation-delay:1.2s}
.tab-hero-particles span:nth-child(3){left:32%;width:5px;height:5px;animation-duration:9s;animation-delay:.4s}
.tab-hero-particles span:nth-child(4){left:45%;width:3px;height:3px;animation-duration:7s;animation-delay:2.5s}
.tab-hero-particles span:nth-child(5){left:58%;width:4px;height:4px;animation-duration:8.5s;animation-delay:1.8s}
.tab-hero-particles span:nth-child(6){left:72%;width:5px;height:5px;animation-duration:6.5s;animation-delay:.9s}
.tab-hero-particles span:nth-child(7){left:85%;width:3px;height:3px;animation-duration:7.5s;animation-delay:3.2s}
.tab-hero-particles span:nth-child(8){left:92%;width:4px;height:4px;animation-duration:8s;animation-delay:2s}
@keyframes rise{0%{transform:translateY(0);opacity:0}10%{opacity:.95}80%{opacity:.55}100%{transform:translateY(-260px) translateX(var(--drift,8px));opacity:0}}
@media (prefers-reduced-motion:reduce){.hdr-orbit *,.tab-hero-particles *,.section-div::before,.moral-comet{animation:none!important}}
.moral{display:flex;align-items:center;gap:10px;background:linear-gradient(135deg,#FFFBF1 0%,#FEF3E0 50%,#EAF6EE 100%);border:1px solid #F3D9A0;border-radius:12px;padding:10px 14px;margin-bottom:0;position:relative;overflow:hidden;min-height:auto;box-shadow:0 2px 10px rgba(232,145,44,.06)}
.moral::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:linear-gradient(180deg,#E8912C,#3DAE5C);z-index:2}
.moral-doodle{position:absolute;top:0;right:0;bottom:0;width:62%;max-width:640px;height:100%;pointer-events:none;z-index:0;opacity:1;filter:drop-shadow(0 1px 2px rgba(15,23,42,.05))}
.moral::after{content:'';position:absolute;top:0;left:0;bottom:0;width:38%;background:linear-gradient(90deg,rgba(255,251,241,.96) 0%,rgba(254,243,224,.65) 75%,rgba(254,243,224,0) 100%);pointer-events:none;z-index:0}
@media (max-width:700px){.moral-doodle{width:36%;opacity:.8}.moral::after{width:64%}.moral{min-height:auto;padding:18px 18px 16px}.moral-txt{font-size:14.5px;line-height:1.4}.moral-by{font-size:12px}.moral-emoji{font-size:22px}}
@media (max-width:480px){.moral-doodle{display:none}.moral::after{display:none}.moral-txt{font-size:14px}}
body[data-theme=aurora] .moral::after{background:linear-gradient(90deg,rgba(20,20,40,.9) 0%,rgba(20,20,40,.65) 70%,rgba(20,20,40,0) 100%)}
.moral-emoji{font-size:20px;flex-shrink:0;filter:drop-shadow(0 2px 4px rgba(232,145,44,.3));position:relative;z-index:1}
.moral-body{flex:1;min-width:0;position:relative;z-index:1}
.moral-lbl{font-size:9px;font-weight:700;color:#B57B00;text-transform:uppercase;letter-spacing:1.1px}
.moral-txt{font-size:13px;line-height:1.35;color:#0F172A;font-weight:600;margin-top:2px;letter-spacing:-.1px}
.moral-by{font-size:11px;color:#94A3B8;margin-top:2px;font-style:italic;font-weight:500}
.moral-ref{width:26px;height:26px;border-radius:50%;background:#FFFFFF;color:#B57B00;font-size:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid #F3D9A0;transition:all .3s cubic-bezier(.4,1.5,.5,1);position:relative;z-index:1}
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
  .app{max-width:1440px;padding:32px 40px 64px;display:grid;grid-template-columns:280px 1.1fr 1fr;grid-template-areas:"hdr hdr hdr" "topstrip moral moral" "nav main main";column-gap:32px;row-gap:20px}
  .app>.hdr{grid-area:hdr;margin-bottom:0}
  .app>.top-strip{grid-area:topstrip;margin-bottom:0}
  .app>.moral{grid-area:moral;margin-bottom:0}
  .app>.tabs.page-t{grid-area:nav;flex-direction:column;align-self:start;position:sticky;top:28px;padding:14px;gap:8px;overflow:visible;margin-bottom:0;justify-content:flex-start}
  .app>.tabs.page-t .tab{width:100%;flex:0 0 auto;min-height:78px;padding:14px 16px;font-size:16px;font-weight:600;justify-content:flex-start;border-radius:14px;gap:14px;align-items:center;border:1px solid transparent;border-bottom:1px solid rgba(15,23,42,.06)}
  .app>.tabs.page-t .tab:last-of-type{border-bottom-color:transparent}
  .app>.tabs.page-t .tab.on{border-color:rgba(15,23,42,.08);border-bottom-color:rgba(15,23,42,.08)}
  body[data-theme=aurora] .app>.tabs.page-t .tab{border-bottom-color:rgba(255,255,255,.06)}
  .app>.tabs.page-t .tab .ti{width:60px;height:60px;border-radius:14px;background-size:cover;background-position:center;background-color:#0F172A;background-repeat:no-repeat;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:0;transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease;position:relative;overflow:hidden;box-shadow:0 4px 14px rgba(15,23,42,.18)}
  .app>.tabs.page-t .tab .ti::after{content:'';position:absolute;inset:0;background:var(--tab-tint,linear-gradient(135deg,rgba(99,102,241,.55),rgba(15,23,42,.35)));z-index:0;transition:opacity .2s ease}
  .app>.tabs.page-t .tab .ti svg{width:28px;height:28px;position:relative;z-index:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
  .app>.tabs.page-t .tab .tl{font-size:16px;letter-spacing:-.01em}
  /* Each tab gets a distinct scenic background image */
  .app>.tabs.page-t .tab.tab-tasks .ti{background-image:url("https://images.unsplash.com/photo-1499951360447-b19be8fe80f5?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-tasks{--tab-tint:linear-gradient(135deg,rgba(79,70,229,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-board .ti{background-image:url("https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-board{--tab-tint:linear-gradient(135deg,rgba(217,119,6,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-cal .ti{background-image:url("https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-cal{--tab-tint:linear-gradient(135deg,rgba(219,39,119,.5),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-news .ti{background-image:url("https://images.unsplash.com/photo-1495020689067-958852a7765e?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-news{--tab-tint:linear-gradient(135deg,rgba(13,148,136,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-books .ti{background-image:url("https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-books{--tab-tint:linear-gradient(135deg,rgba(5,150,105,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-meditation .ti{background-image:url("https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-meditation{--tab-tint:linear-gradient(135deg,rgba(124,58,237,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-history .ti{background-image:url("https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-history{--tab-tint:linear-gradient(135deg,rgba(180,83,9,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab.tab-geography .ti{background-image:url("https://images.unsplash.com/photo-1446776877081-d282a0f896e2?w=200&q=70&auto=format&fit=crop")}
  .app>.tabs.page-t .tab.tab-geography{--tab-tint:linear-gradient(135deg,rgba(8,145,178,.55),rgba(15,23,42,.45))}
  .app>.tabs.page-t .tab:hover:not(.on) .ti{transform:scale(1.06);box-shadow:0 8px 22px rgba(15,23,42,.24)}
  .app>.tabs.page-t .tab.on .ti{box-shadow:0 8px 24px rgba(15,23,42,.32),0 0 0 3px var(--ring,rgba(255,255,255,.7))}
  .app>.tabs.page-t .tab.on .ti::after{opacity:.45}
  .app>.tabs.page-t .tab.tab-tasks.on{--ring:rgba(99,102,241,.85)}
  .app>.tabs.page-t .tab.tab-board.on{--ring:rgba(232,145,44,.85)}
  .app>.tabs.page-t .tab.tab-cal.on{--ring:rgba(236,72,153,.85)}
  .app>.tabs.page-t .tab.tab-news.on{--ring:rgba(13,148,136,.85)}
  .app>.tabs.page-t .tab.tab-books.on{--ring:rgba(5,150,105,.85)}
  .app>.tabs.page-t .tab.tab-meditation.on{--ring:rgba(139,92,246,.85)}
  .app>.tabs.page-t .tab.tab-history.on{--ring:rgba(180,83,9,.85)}
  .app>.tabs.page-t .tab.tab-geography.on{--ring:rgba(8,145,178,.85)}
  /* Active tab tile pulses softly */
  .app>.tabs.page-t .tab.on .ti{animation:tilePulse 2.4s ease-in-out infinite}
  @keyframes tilePulse{0%,100%{box-shadow:0 8px 24px rgba(15,23,42,.32),0 0 0 3px var(--ring,rgba(255,255,255,.7))}50%{box-shadow:0 12px 30px rgba(15,23,42,.36),0 0 0 6px var(--ring,rgba(255,255,255,.4))}}
  /* Hover shimmer across tile */
  .app>.tabs.page-t .tab .ti::before{content:'';position:absolute;top:0;left:-60%;width:50%;height:100%;background:linear-gradient(120deg,transparent 0%,rgba(255,255,255,.45) 50%,transparent 100%);transform:skewX(-20deg);z-index:2;transition:left .6s ease;pointer-events:none}
  .app>.tabs.page-t .tab:hover .ti::before{left:120%}
  /* Sidebar footer "now" panel — fills the bottom blank space */
  .app>.tabs.page-t .side-now{margin-top:auto;background:linear-gradient(135deg,rgba(99,102,241,.08),rgba(232,145,44,.08));border:1px solid rgba(99,102,241,.18);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden}
  .app>.tabs.page-t .side-now-lbl{font-size:10px;font-weight:800;color:#6366F1;letter-spacing:1.4px;text-transform:uppercase}
  .app>.tabs.page-t .side-now-time{font-family:'Instrument Serif',Georgia,serif;font-size:30px;font-weight:400;color:#0F172A;line-height:1;letter-spacing:-.03em;margin-top:2px}
  .app>.tabs.page-t .side-now-time .sec{color:#E8453C;animation:secBlink 1s steps(2) infinite;font-size:18px;margin-left:2px;display:inline-block;vertical-align:top;margin-top:6px}
  @keyframes secBlink{50%{opacity:.35}}
  .app>.tabs.page-t .side-now-date{font-size:12px;color:#64748B;font-weight:600}
  .app>.tabs.page-t .side-now-bar{height:6px;border-radius:99px;background:rgba(99,102,241,.14);overflow:hidden;margin-top:8px;position:relative}
  .app>.tabs.page-t .side-now-fill{height:100%;background:linear-gradient(90deg,#6366F1,#E8912C);border-radius:99px;transition:width .4s ease;position:relative;overflow:hidden}
  .app>.tabs.page-t .side-now-fill::after{content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:fillShine 2.6s ease-in-out infinite}
  @keyframes fillShine{0%{left:-30%}100%{left:130%}}
  .app>.tabs.page-t .side-now-foot{font-size:10px;color:#94A3B8;font-weight:700;letter-spacing:.6px;display:flex;justify-content:space-between;margin-top:2px}
  .app>.tabs.page-t .side-now-wave{position:absolute;bottom:0;left:0;right:0;height:30px;opacity:.15;pointer-events:none}
  /* Top strip — wide horizontal banner with the climb scene + live time at the very top */
  /* Climb scene — stick figures climbing stairs, fills the visible blank space */
  .app>.tabs.page-t .climb-scene{position:relative;width:100%;height:170px;border-radius:14px;background:linear-gradient(180deg,rgba(99,102,241,.04) 0%,rgba(232,145,44,.06) 100%);border:1px dashed rgba(99,102,241,.22);overflow:hidden;flex-shrink:0;margin-top:auto}
  .app>.tabs.page-t .side-now{margin-top:0!important}
  .climb-stairs{position:absolute;inset:0;width:100%;height:100%;opacity:.55}
  .climb-caption{position:absolute;top:8px;left:0;right:0;text-align:center;font-size:9.5px;font-weight:800;color:#6366F1;letter-spacing:1.4px;opacity:.7;z-index:2}
  .climber{position:absolute;width:18px;height:24px;color:#0F172A;animation:climbStairs 16s linear infinite;will-change:left,bottom;z-index:1}
  .climber-1{color:#6366F1;animation-delay:0s}
  .climber-2{color:#3DAE5C;animation-delay:5.3s}
  .climber-3{color:#E8453C;animation-delay:10.6s}
  @keyframes climbStairs{
    0%{left:4%;bottom:6%;opacity:0}
    3%{opacity:1}
    14%{left:24%;bottom:6%}
    17%{left:24%;bottom:24%}
    31%{left:43%;bottom:24%}
    34%{left:43%;bottom:42%}
    48%{left:62%;bottom:42%}
    51%{left:62%;bottom:60%}
    65%{left:80%;bottom:60%}
    68%{left:80%;bottom:78%}
    82%{left:90%;bottom:78%}
    97%{opacity:1}
    100%{left:92%;bottom:78%;opacity:0}
  }
  .climber .leg-l{transform-origin:9px 14px;animation:legL .5s linear infinite}
  .climber .leg-r{transform-origin:9px 14px;animation:legR .5s linear infinite}
  @keyframes legL{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(22deg)}}
  @keyframes legR{0%,100%{transform:rotate(22deg)}50%{transform:rotate(-22deg)}}
  .climber .arm-l{transform-origin:9px 9px;animation:armL .5s linear infinite}
  .climber .arm-r{transform-origin:9px 9px;animation:armR .5s linear infinite}
  @keyframes armL{0%,100%{transform:rotate(18deg)}50%{transform:rotate(-18deg)}}
  @keyframes armR{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(18deg)}}
  /* Sparkle trail at the top of the climb scene */
  .climb-peak{position:absolute;top:6px;right:10px;width:18px;height:18px;color:#E8912C;animation:peakBlink 1.8s ease-in-out infinite;z-index:2}
  @keyframes peakBlink{0%,100%{opacity:.4;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
  /* Ambient horizontal walkers + celebrator at the peak (extra people moving around) */
  .walker{position:absolute;width:14px;height:20px;animation:walkAcross 14s linear infinite;will-change:left;z-index:1;opacity:.55}
  .walker-a{color:#94A3B8;bottom:4%;animation-delay:0s}
  .walker-b{color:#6366F1;bottom:4%;animation-delay:7s;animation-duration:11s}
  .walker-c{color:#3DAE5C;bottom:32%;animation-delay:3.5s;animation-duration:13s}
  @keyframes walkAcross{from{left:-6%}to{left:104%}}
  .celebrator{position:absolute;top:6px;right:36px;width:20px;height:24px;color:#E8912C;z-index:2;animation:celebrate 1.1s ease-in-out infinite;transform-origin:50% 100%}
  @keyframes celebrate{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-4px) rotate(4deg)}}
  body[data-theme=aurora] .app>.tabs.page-t .climb-scene{background:linear-gradient(180deg,rgba(167,139,250,.06) 0%,rgba(232,145,44,.05) 100%);border-color:rgba(167,139,250,.2)}
  body[data-theme=aurora] .climb-caption{color:#A78BFA}
  body[data-theme=aurora] .app>.tabs.page-t .side-now{background:linear-gradient(135deg,rgba(167,139,250,.12),rgba(232,145,44,.08));border-color:rgba(167,139,250,.2)}
  /* Top strip layout (climb scene + live time, side-by-side) */
  .top-strip{display:flex;align-items:stretch;gap:0;background:linear-gradient(135deg,rgba(99,102,241,.06) 0%,rgba(232,145,44,.06) 100%);border:1px solid rgba(99,102,241,.18);border-radius:18px;min-height:180px;position:relative;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.04)}
  .top-strip .climb-scene{position:relative;flex:1;border:none;background:transparent;border-radius:0;height:auto;min-height:180px;margin-top:0;padding:8px 0;overflow:hidden}
  .top-strip .climb-scene .climb-stairs{transform:scaleX(1.05)}
  .top-strip .side-now{flex:0 0 280px;margin-top:0!important;border-radius:0;border:none;border-left:1px dashed rgba(99,102,241,.25);background:linear-gradient(135deg,rgba(99,102,241,.04),rgba(232,145,44,.04));padding:18px 22px;justify-content:center}
  .top-strip .side-now .side-now-time{font-size:38px}
  .top-strip .side-now .side-now-time .sec{font-size:22px;margin-top:8px}
  body[data-theme=aurora] .top-strip{background:linear-gradient(135deg,rgba(167,139,250,.08) 0%,rgba(232,145,44,.06) 100%);border-color:rgba(167,139,250,.18)}
  body[data-theme=aurora] .top-strip .side-now{background:linear-gradient(135deg,rgba(167,139,250,.06),rgba(232,145,44,.04));border-left-color:rgba(167,139,250,.2)}
  @media (max-width:900px){.top-strip{flex-direction:column}.top-strip .side-now{flex:0 0 auto;border-left:none;border-top:1px dashed rgba(99,102,241,.25)}}
  body[data-theme=aurora] .app>.tabs.page-t .side-now-time{color:#F5F5FA}
  body[data-theme=aurora] .app>.tabs.page-t .side-now-date{color:#9999B5}
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
.tab-hero{position:relative;height:96px;border-radius:14px;overflow:hidden;background-size:cover;background-position:center;margin-bottom:12px;display:flex;align-items:flex-end;padding:12px 18px;box-shadow:0 6px 20px rgba(15,23,42,.12);transition:transform .3s ease}
.tab-hero:hover{transform:translateY(-2px)}
.tab-hero-body{color:#fff;position:relative;z-index:1;max-width:80%}
.tab-hero-h{font-family:'Instrument Serif',Georgia,serif;font-size:22px;font-weight:400;letter-spacing:-.02em;color:#fff;line-height:1.1;margin-bottom:2px;text-shadow:0 2px 14px rgba(0,0,0,.4)}
.tab-hero-s{font-size:14px;color:rgba(255,255,255,.94);font-weight:450;text-shadow:0 1px 8px rgba(0,0,0,.45)}
.tab-hero-credit{position:absolute;top:10px;right:14px;font-size:10px;color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.6px;font-weight:600;z-index:1}
@media (max-width:600px){.tab-hero{height:140px;padding:18px 20px;border-radius:16px}.tab-hero-h{font-size:24px}.tab-hero-s{font-size:13px}}
body[data-theme=aurora] .tab-hero{box-shadow:0 12px 32px rgba(0,0,0,.4)}
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
.news-card{background:#fff;border:1px solid rgba(15,23,42,.06);border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 14px rgba(15,23,42,.06);transition:all .25s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:row;align-items:stretch}
.news-card:hover{transform:translateY(-3px);box-shadow:0 6px 12px rgba(15,23,42,.06),0 16px 32px rgba(15,23,42,.1);border-color:rgba(99,102,241,.25)}
.news-img{display:block;position:relative;flex:0 0 50%;width:50%;align-self:stretch;min-height:200px;background-size:cover;background-position:center;background-color:#F1F5F9;text-decoration:none}
.news-img::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent 60%,rgba(0,0,0,.25) 100%);pointer-events:none}
.news-src-chip{position:absolute;bottom:12px;left:12px;z-index:1;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);color:#6366F1;padding:5px 12px;border-radius:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.news-body{padding:16px 18px 18px;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
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
@media (max-width:600px){.news-card{flex-direction:column}.news-img{flex:0 0 auto;width:100%;min-height:170px;height:170px}.news-img::after{background:linear-gradient(180deg,transparent 50%,rgba(0,0,0,.4) 100%)}.news-title{font-size:16px}.news-desc{font-size:13.5px}.news-body{padding:14px 16px 16px}}
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
body:not([data-theme=aurora]) .add-bar{background:var(--bg-elev);border:1px solid var(--line);color:var(--ink);box-shadow:var(--shadow-1)}
body:not([data-theme=aurora]) .add-bar:hover{border-color:var(--line-2);box-shadow:var(--shadow-2)}
body:not([data-theme=aurora]) .add-bar .plus{background:var(--ink);color:#FAFAF7}
body:not([data-theme=aurora]) .add-bar .txt small{color:var(--ink-3)}
body:not([data-theme=aurora]) .add-bar .plus{background:rgba(255,255,255,.2);color:#fff}
body:not([data-theme=aurora]) .fab{background:var(--ink);color:#FAFAF7;box-shadow:0 8px 24px rgba(0,0,0,.18);animation:none}
body:not([data-theme=aurora]) .fab:hover{background:#000;transform:scale(1.05)}
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
  .tabs.page-t .tab{flex:1 1 0;flex-direction:column;padding:10px 2px 5px;min-width:64px;gap:3px;border-radius:14px;font-size:11px;font-weight:700;position:relative;transform:none}
  .tabs.page-t .tab .ti{font-size:30px;line-height:1;transition:transform .25s cubic-bezier(.4,1.5,.5,1);margin:0;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center}
  .tabs.page-t .tab .ti svg{width:30px!important;height:30px!important}
  .tabs.page-t .tab .tl{font-size:11px;line-height:1;letter-spacing:.1px;margin-top:3px;opacity:.9;font-weight:700}
  .tabs.page-t .tab.on{background:transparent!important;color:#6366F1!important;transform:none!important;box-shadow:none!important}
  body[data-theme=aurora] .tabs.page-t .tab.on{color:#A78BFA!important;background:transparent!important}
  .tabs.page-t .tab.on .ti{transform:translateY(-2px) scale(1.18)}
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
.login{max-width:440px;margin:0 auto;padding:32px 24px 48px;text-align:center;min-height:100vh;display:flex;flex-direction:column;justify-content:center;gap:0}
.hero-photo{position:relative;width:100%;aspect-ratio:5/3;border-radius:14px;overflow:hidden;margin-bottom:32px;background:var(--bg-sunken);box-shadow:var(--shadow-2)}
.hero-photo img{width:100%;height:100%;object-fit:cover;display:block;animation:photoFade .9s ease}
.hero-photo-overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 60%,rgba(0,0,0,.18) 100%);pointer-events:none}
@keyframes photoFade{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}
.login-logo{font-family:'Instrument Serif',Georgia,serif;font-size:46px;font-weight:400;margin-bottom:6px;letter-spacing:-1.5px;color:var(--ink);line-height:1}
.login-tagline{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:18px;color:var(--ink-3);margin-bottom:20px;letter-spacing:.01em}
.login-sub{font-size:15px;color:var(--ink-3);margin-bottom:28px;line-height:1.6;font-weight:450;max-width:360px;margin-left:auto;margin-right:auto}
.hero-stage{width:100%;max-width:380px;margin:0 auto 6px;position:relative;animation:heroIn .9s cubic-bezier(.2,.8,.2,1) backwards}
.hero-art{width:100%;height:auto;display:block;filter:drop-shadow(0 24px 48px rgba(99,102,241,.22))}
.hero-bubble{transform-origin:240px 70px;animation:bubbleFloat 4s ease-in-out infinite alternate}
.hero-thumb{transform-origin:296px 232px;animation:thumbWave 2.4s ease-in-out infinite alternate}
.hero-bolt{transform-origin:323px 152px;animation:boltPulse 1.8s ease-in-out infinite alternate}
.hero-sparkle{transform-origin:center;animation:twinkle 2.2s ease-in-out infinite alternate}
.hero-sparkle.s2{animation-delay:.3s}
.hero-sparkle.s3{animation-delay:.6s}
.hero-sparkle.s4{animation-delay:.9s}
.hero-sparkle.s5{animation-delay:1.2s}
.hero-eyes{transform-origin:180px 162px;animation:blink 5.5s steps(1) infinite}
.hero-headphones{animation:hpBob 2.8s ease-in-out infinite alternate}
@keyframes heroIn{from{opacity:0;transform:translateY(14px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes bubbleFloat{0%{transform:translate(0,0) rotate(0)}100%{transform:translate(2px,-6px) rotate(.6deg)}}
@keyframes thumbWave{0%{transform:rotate(-6deg)}100%{transform:rotate(8deg)}}
@keyframes boltPulse{0%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(245,158,11,0))}100%{transform:scale(1.15);filter:drop-shadow(0 0 14px rgba(245,158,11,.7))}}
@keyframes twinkle{0%{opacity:.35;transform:scale(.7)}100%{opacity:1;transform:scale(1.15)}}
@keyframes blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.05)}}
@keyframes hpBob{0%{transform:translateY(0)}100%{transform:translateY(-1.5px)}}
.login-features,.login-feature{display:none}
@keyframes featIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.login-feature{animation:featIn .5s ease backwards}
.login-feature:nth-child(1){animation-delay:.05s}.login-feature:nth-child(2){animation-delay:.15s}.login-feature:nth-child(3){animation-delay:.25s}
.login-tabs{display:flex;gap:0;margin:0 0 18px;padding:0;background:transparent;border-bottom:1px solid var(--line);border-radius:0}
.login-tab{flex:1;padding:12px 8px 14px;border-radius:0;font-size:13.5px;font-weight:500;color:var(--ink-3);border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:color .15s ease,border-color .15s ease;border-bottom:2px solid transparent;margin-bottom:-1px;letter-spacing:.005em}
.login-tab:hover{color:var(--ink-2)}
.login-tab.on{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.wa-login-step{display:flex;gap:14px;align-items:flex-start;padding:14px;background:var(--bg-elev);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;text-align:left;box-shadow:var(--shadow-1)}
.wa-step-num{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:var(--bg-sunken);color:var(--ink);font-weight:600;display:flex;align-items:center;justify-content:center;font-size:12px;border:1px solid var(--line)}
.wa-step-body{flex:1;min-width:0}
.wa-step-title{font-size:14px;font-weight:500;color:var(--ink);margin-bottom:3px}
.wa-step-desc{font-size:12.5px;color:var(--ink-3);line-height:1.55}
.wa-join-btn{margin-top:10px;display:flex;align-items:center;gap:8px;background:#1F8A4F;color:#FAFAF7;border:none;padding:11px 14px;border-radius:8px;font-weight:500;font-size:13.5px;cursor:pointer;width:100%;justify-content:center;transition:background .15s ease}
.wa-join-btn:hover{background:#176B3D}
.wa-save-btn{margin-top:10px;display:flex;align-items:center;gap:8px;background:transparent;color:var(--ink-2);border:1px solid var(--line-2);padding:10px 14px;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer;width:100%;justify-content:center;transition:all .15s ease}
.wa-save-btn:hover{background:var(--bg-sunken);border-color:var(--ink-4);color:var(--ink)}
.wa-login-step input{margin-bottom:0!important;text-align:left!important}
.phone-row{display:flex;gap:8px;margin-top:8px;align-items:stretch}
.cc-select{flex:0 0 auto;width:140px;padding:12px 8px;border:1.5px solid #E8E9EF;border-radius:10px;background:#fff;font-size:14px;font-weight:600;color:#0F172A;cursor:pointer;-webkit-appearance:menulist;appearance:menulist}
.cc-select:focus{outline:none;border-color:#25D366}
.phone-num{flex:1;min-width:0;font-size:15px!important;letter-spacing:.5px!important;padding:12px 14px!important;text-align:left!important}
@media (max-width:420px){.cc-select{width:118px;font-size:13px;padding:12px 6px}}
.login-err{background:#FEF2F2;border:1px solid #FCA5A5;border-radius:12px;padding:12px 14px;margin:12px 0;text-align:left}
.login-err-msg{font-size:13px;font-weight:600;color:#B91C1C;line-height:1.5}
.login-err-code{font-size:11px;color:#7F1D1D;margin-top:6px;font-family:'Space Mono',monospace;opacity:.85}
.login-err-acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.login-err-acts button{font-size:12px;font-weight:700;padding:7px 12px;border-radius:8px;background:#fff;color:#0F172A;border:1px solid #E2E8F0;cursor:pointer}
.login-err-acts button:hover{background:#F8FAFC;border-color:#CBD5E1}
.login input{margin-bottom:12px;text-align:left;font-size:15px;letter-spacing:0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--bg-elev);color:var(--ink);transition:border-color .15s ease,box-shadow .15s ease;width:100%;font-weight:450}
.login input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.login input::placeholder{color:var(--ink-4)}
.login-btn{width:100%;padding:14px;font-size:15px;border-radius:10px;font-weight:600;background:var(--ink);color:#FAFAF7;border:none;margin-top:6px;letter-spacing:-.005em;transition:background .15s ease,transform .1s ease}
.login-btn:hover{background:#000}
.login-btn:active{transform:scale(.99)}
.login-btn:disabled{opacity:.5;cursor:not-allowed}
.login-btn.sec{background:transparent;border:1px solid var(--line-2);color:var(--ink-2);margin-top:8px}
.login-btn.sec:hover{background:var(--bg-sunken);border-color:var(--ink-4)}
.login-hint{font-size:12px;color:#94A3B8;margin-top:16px;line-height:1.5}
.login-foot{margin-top:32px;padding-top:18px;border-top:1px solid rgba(15,23,42,.06);display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;color:#94A3B8;flex-wrap:wrap}
.login-foot a{color:#64748B;text-decoration:none;font-weight:600}
.login-foot a:hover{color:#0F172A;text-decoration:underline}
.login-foot span{opacity:.5}
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
.bg-blob{display:none}
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
.add-bar .plus{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;flex-shrink:0;box-shadow:0 3px 10px rgba(61,174,92,.4);position:relative;animation:plusBreathe 2.4s ease-in-out infinite;transition:transform .3s cubic-bezier(.4,1.5,.5,1)}
.add-bar .plus::before{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid rgba(61,174,92,.4);animation:plusRing 2.4s ease-in-out infinite;pointer-events:none}
@keyframes plusBreathe{0%,100%{transform:scale(1);box-shadow:0 3px 10px rgba(61,174,92,.4),0 0 0 0 rgba(61,174,92,.55)}50%{transform:scale(1.06);box-shadow:0 5px 16px rgba(61,174,92,.5),0 0 0 8px rgba(61,174,92,0)}}
@keyframes plusRing{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:0;transform:scale(1.4)}}
.add-bar:hover .plus{transform:scale(1.12) rotate(90deg)}
.add-bar:hover .plus::before{opacity:0}
.add-bar.gcal-add-bar .plus{animation:none;box-shadow:0 3px 10px rgba(66,133,244,.35)}
.add-bar.gcal-add-bar .plus::before{display:none}
.add-bar.gcal-add-bar:hover .plus{transform:scale(1.1) rotate(0)}
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

.ocean{display:none}
.app{position:relative;z-index:1}

/* Google Calendar integration */
.gcal-card{background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.06);border-radius:18px;padding:16px;margin-bottom:14px;box-shadow:0 6px 24px rgba(15,23,42,.05)}
.gcal-card.gcal-loading{text-align:center;color:#94A3B8;padding:14px;font-size:13px}
.gcal-card.gcal-cta{display:flex;gap:14px;align-items:flex-start;padding:18px;background:linear-gradient(135deg,#FFFFFF,#EEF6FF)}
.gcal-icon{flex-shrink:0;width:54px;height:54px;border-radius:14px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(66,133,244,.15)}
.gcal-card h3{font-size:17px;margin-bottom:6px}
.gcal-card p{font-size:13.5px;color:#64748B;line-height:1.5;margin-bottom:12px}
.gcal-acc-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.gcal-acc-l{display:flex;align-items:center;gap:10px}
.gcal-acc-list{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.gcal-chip{font-size:11.5px;background:rgba(66,133,244,.08);color:#1A56DB;border:1px solid rgba(66,133,244,.18);padding:5px 10px;border-radius:30px;font-weight:600;cursor:pointer;transition:all .15s}
.gcal-chip:hover{background:rgba(66,133,244,.15)}
.gcal-chip.on{background:#4285F4;color:#fff;border-color:#4285F4}
.gcal-chip-add{background:rgba(15,23,42,.04);color:#64748B;border-color:rgba(15,23,42,.08)}
.gcal-acc-foot{display:flex;flex-wrap:wrap;gap:14px;padding-top:10px;border-top:1px solid rgba(15,23,42,.06);margin-top:10px}
.gcal-link{font-size:12px;color:#4285F4;background:none;border:none;cursor:pointer;font-weight:600;padding:0}
.gcal-link:hover{text-decoration:underline}
.gcal-link-d{color:#E8453C}
.gcal-day-list{margin-top:14px;padding:12px;background:rgba(66,133,244,.04);border:1px solid rgba(66,133,244,.12);border-radius:12px}
.gcal-day-h{font-size:11.5px;font-weight:700;color:#4285F4;letter-spacing:.4px;text-transform:uppercase;display:flex;align-items:center;gap:6px;margin-bottom:8px}
.gcal-evt{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(15,23,42,.05)}
.gcal-evt:last-child{border-bottom:none}
.gcal-evt-time{font-family:'Space Mono',monospace;font-size:12px;color:#64748B;min-width:64px;font-weight:600;display:flex;flex-direction:column;line-height:1.3}
.gcal-evt-time small{font-size:10.5px;opacity:.85}
.gcal-evt-body{flex:1;min-width:0}
.gcal-evt-title{font-size:13.5px;font-weight:600;color:#0F172A}
.gcal-evt-loc{font-size:11px;color:#94A3B8;margin-top:2px}
.gcal-evt-open{font-size:11.5px;color:#4285F4;text-decoration:none;font-weight:600;flex-shrink:0}
.gcal-evt-open:hover{text-decoration:underline}
.gcal-upcoming{margin-top:14px;padding:14px 16px;background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.06);border-radius:16px}
.gcal-upcoming h4{font-size:13px;font-weight:700;margin-bottom:8px;color:#0F172A}
.gcal-add-bar{background:linear-gradient(135deg,#FFFFFF,#EEF6FF)!important;border-color:rgba(66,133,244,.2)!important}
.gcal-add-bar .plus{background:#4285F4!important;color:#fff!important}
body[data-theme=aurora] .gcal-card,body[data-theme=aurora] .gcal-upcoming{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .gcal-card h3,body[data-theme=aurora] .gcal-evt-title,body[data-theme=aurora] .gcal-upcoming h4{color:#F5F5FA}
body[data-theme=aurora] .gcal-card p,body[data-theme=aurora] .gcal-evt-time{color:#9999B5}

/* Inshorts-style news cards */
.inshort-feed{display:flex;flex-direction:column;gap:18px;padding-bottom:8px}
.inshort{background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.06);border-radius:22px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,.06);transition:transform .25s ease,box-shadow .25s ease;display:flex;flex-direction:row;align-items:stretch}
.inshort:hover{transform:translateY(-3px);box-shadow:0 14px 38px rgba(15,23,42,.1)}
.inshort-img{position:relative;flex:0 0 38%;width:38%;align-self:stretch;min-height:180px;aspect-ratio:auto;background-color:#0F172A;overflow:hidden}
.inshort-img img{width:100%;height:100%;object-fit:cover;display:block}
.inshort-img-placeholder{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6366F1,#EC4899)}
.inshort-src{position:absolute;top:12px;left:12px;background:rgba(15,23,42,.85);color:#fff;font-size:11px;font-weight:700;padding:5px 10px;border-radius:30px;letter-spacing:.3px;backdrop-filter:blur(10px)}
.inshort-body{padding:18px 20px 16px;flex:1;min-width:0;display:flex;flex-direction:column}
.inshort-title{font-size:18px;font-weight:800;line-height:1.3;color:#0F172A;margin-bottom:10px;letter-spacing:-.3px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.inshort-desc{font-size:14px;line-height:1.55;color:#475569;margin-bottom:14px;flex:1;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.inshort-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:12px;border-top:1px solid rgba(15,23,42,.06);margin-top:auto}
.inshort-time{font-size:12px;color:#94A3B8;font-weight:600}
.inshort-share{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#6366F1;background:rgba(99,102,241,.1);border:none;padding:8px 14px;border-radius:10px;cursor:pointer;transition:all .15s}
.inshort-share:hover{background:#6366F1;color:#fff}
@media (max-width:600px){
  .inshort{flex-direction:column}
  .inshort-img{flex:0 0 auto;width:100%;min-height:0;aspect-ratio:16/9}
  .inshort-title{font-size:17px;-webkit-line-clamp:unset}
  .inshort-desc{font-size:14px;-webkit-line-clamp:4}
  .inshort-body{padding:16px 16px 14px}
}
body[data-theme=aurora] .inshort{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .inshort-title{color:#F5F5FA}
body[data-theme=aurora] .inshort-desc{color:#9999B5}
body[data-theme=aurora] .inshort-foot{border-top-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .inshort-share{background:rgba(167,139,250,.18);color:#A78BFA}

/* Meditation tab */
.med-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:14px}
.med-card{display:flex;align-items:center;gap:14px;padding:18px 18px;border-radius:18px;background:linear-gradient(135deg,rgba(255,255,255,.92),rgba(255,255,255,.78));border:1.5px solid rgba(15,23,42,.06);text-align:left;cursor:pointer;transition:transform .2s ease,box-shadow .25s ease,border-color .2s ease;position:relative;overflow:hidden;width:100%;color:#0F172A}
.med-card::before{content:'';position:absolute;top:0;left:0;width:6px;height:100%;background:var(--mc,#6366F1)}
.med-card:hover{transform:translateY(-3px);box-shadow:0 14px 38px rgba(15,23,42,.08);border-color:var(--mc,#6366F1)}
.med-card-mins{flex:0 0 auto;width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,var(--mc,#6366F1),rgba(0,0,0,.12));color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(0,0,0,.12)}
.med-card-mins b{font-family:'Space Mono',monospace;font-size:22px;font-weight:700;line-height:1}
.med-card-mins small{font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-top:2px;opacity:.95}
.med-card-body{flex:1;min-width:0}
.med-card-title{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;font-weight:700;color:#0F172A;margin-bottom:3px;letter-spacing:-.011em}
.med-card-desc{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;color:#64748B;line-height:1.4}
.med-card-play{flex:0 0 auto;width:38px;height:38px;border-radius:50%;background:rgba(15,23,42,.06);color:var(--mc,#6366F1);display:flex;align-items:center;justify-content:center;transition:transform .2s ease,background .2s ease}
.med-card:hover .med-card-play{transform:scale(1.1);background:var(--mc,#6366F1);color:#fff}
.med-foot{font-size:13px;color:#64748B;text-align:center;margin-top:10px;opacity:.85}
.med-card.loading{cursor:wait;opacity:.85}
.med-card.loading .med-card-play{background:transparent}
.med-load-dot{width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(99,102,241,.25);border-top-color:var(--mc,#6366F1);animation:medSpin .9s linear infinite}
@keyframes medSpin{to{transform:rotate(360deg)}}

.med-player{background:rgba(255,255,255,.94);border:1.5px solid rgba(15,23,42,.06);border-radius:20px;padding:16px;margin-bottom:14px;box-shadow:0 12px 38px rgba(15,23,42,.06)}
.med-back{font-size:13px;font-weight:700;color:#6366F1;background:rgba(99,102,241,.1);border:none;padding:8px 14px;border-radius:10px;cursor:pointer;margin-bottom:14px}
.med-back:hover{background:rgba(99,102,241,.18)}
.med-player-hd{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.med-player-hd .med-mins{flex:0 0 auto;width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,#6366F1,#8B5CF6,#EC4899);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-size:22px;font-weight:700;box-shadow:0 8px 22px rgba(99,102,241,.32)}
.med-player-hd h2{font-size:18px;font-weight:700;color:#0F172A;margin-bottom:2px}
.med-player-hd p{font-size:13px;color:#64748B}
.med-frame{position:relative;padding-bottom:56.25%;height:0;border-radius:14px;overflow:hidden;background:#000}
.med-frame iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}
.med-tip{font-size:12.5px;color:#64748B;text-align:center;margin-top:14px;padding:10px 14px;background:rgba(99,102,241,.06);border-radius:10px}

body[data-theme=aurora] .med-card{background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border-color:rgba(255,255,255,.08);color:#F5F5FA}
body[data-theme=aurora] .med-card-title{color:#F5F5FA}
body[data-theme=aurora] .med-card-desc{color:#9999B5}
body[data-theme=aurora] .med-card-play{background:rgba(255,255,255,.08)}
body[data-theme=aurora] .med-player{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .med-player-hd h2{color:#F5F5FA}
body[data-theme=aurora] .med-player-hd p{color:#9999B5}
body[data-theme=aurora] .med-tip{color:#9999B5;background:rgba(167,139,250,.1)}
body[data-theme=aurora] .med-foot{color:#9999B5}

/* IPL tab */
.ipl-live{position:relative;background:linear-gradient(135deg,#0F172A 0%,#312E81 60%,#E8453C 140%);color:#fff;border-radius:18px;padding:22px 24px;margin-bottom:18px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,.18)}
.ipl-live::before{content:'';position:absolute;inset:0;background-image:url("https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=1200&q=70&auto=format&fit=crop");background-size:cover;background-position:center;opacity:.18;mix-blend-mode:screen}
.ipl-live-body{position:relative;z-index:1}
.ipl-live-lbl{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:1.6px;color:#FCA5A5;background:rgba(255,255,255,.06);padding:6px 12px;border-radius:99px;margin-bottom:12px}
.ipl-live-dot{width:8px;height:8px;border-radius:50%;background:#E8453C;animation:livePulse 1.4s ease-in-out infinite;box-shadow:0 0 0 0 rgba(232,69,60,.7)}
@keyframes livePulse{0%,100%{box-shadow:0 0 0 0 rgba(232,69,60,.7)}50%{box-shadow:0 0 0 8px rgba(232,69,60,0)}}
.ipl-live-h{font-family:'Instrument Serif',Georgia,serif;font-size:26px;line-height:1.15;margin-bottom:6px}
.ipl-live-s{font-size:13.5px;color:rgba(255,255,255,.78);line-height:1.5;margin-bottom:16px;max-width:520px}
.ipl-live-acts{display:flex;flex-wrap:wrap;gap:10px}
.ipl-cta{display:inline-flex;align-items:center;padding:11px 20px;border-radius:11px;background:#E8453C;color:#fff;font-size:13px;font-weight:800;text-decoration:none;letter-spacing:.2px;box-shadow:0 6px 18px rgba(232,69,60,.4);transition:transform .15s ease,box-shadow .15s ease}
.ipl-cta:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(232,69,60,.5)}
.ipl-cta-sec{display:inline-flex;align-items:center;padding:11px 18px;border-radius:11px;background:rgba(255,255,255,.1);color:#fff;font-size:13px;font-weight:700;text-decoration:none;border:1px solid rgba(255,255,255,.2);transition:background .15s ease,border-color .15s ease}
.ipl-cta-sec:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.3)}
.ipl-matches{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:18px}
.ipl-match{background:#fff;border:1px solid #E8E9EF;border-radius:14px;padding:14px 16px;opacity:0;animation:iplFadeIn .55s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes iplFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.ipl-match-status{font-size:11px;font-weight:800;color:#E8453C;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.ipl-match-teams{font-size:15px;font-weight:700;color:#0F172A;margin-bottom:4px}
.ipl-match-meta{font-size:12px;color:#64748B}
body[data-theme=aurora] .ipl-match{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .ipl-match-teams{color:#F5F5FA}
body[data-theme=aurora] .ipl-match-meta{color:#9999B5}
.ipl-section-ttl{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;letter-spacing:-.02em;color:#0F172A;margin:24px 0 14px;display:flex;align-items:center;gap:10px}
body[data-theme=aurora] .ipl-section-ttl{color:#F5F5FA}
/* All-time records — animated stat cards */
.ipl-records{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:8px}
.ipl-rec{position:relative;background:#fff;border:1px solid #E8E9EF;border-radius:16px;padding:18px 20px;overflow:hidden;opacity:0;transform:translateY(12px);animation:iplFadeIn .6s cubic-bezier(.2,.8,.2,1) forwards;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 14px rgba(15,23,42,.05);transition:transform .25s ease,box-shadow .25s ease}
.ipl-rec:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(15,23,42,.1)}
.ipl-rec::before{content:'';position:absolute;top:0;left:0;width:5px;height:100%;background:var(--rc,#6366F1)}
.ipl-rec::after{content:'';position:absolute;top:0;right:0;width:80px;height:80px;background:radial-gradient(circle at 70% 30%,var(--rc,#6366F1),transparent 70%);opacity:.15;pointer-events:none}
.ipl-rec-ic{font-size:22px;margin-bottom:8px}
.ipl-rec-v{font-family:'Instrument Serif',Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-.02em;color:var(--rc,#6366F1);line-height:1;margin-bottom:6px;animation:numPop .9s cubic-bezier(.2,.8,.2,1) forwards;opacity:0;transform:scale(.9)}
@keyframes numPop{from{opacity:0;transform:scale(.85)}60%{opacity:1;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}
.ipl-rec-l{font-size:12.5px;font-weight:700;color:#0F172A;margin-bottom:3px}
.ipl-rec-sub{font-size:11.5px;color:#64748B;font-weight:500}
body[data-theme=aurora] .ipl-rec{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .ipl-rec-l{color:#F5F5FA}
body[data-theme=aurora] .ipl-rec-sub{color:#9999B5}
/* Champions timeline — horizontal scrollable strip */
.ipl-champs{display:grid;grid-auto-flow:column;grid-auto-columns:140px;gap:12px;overflow-x:auto;padding:6px 2px 14px;scrollbar-width:thin;margin-bottom:8px}
.ipl-champs::-webkit-scrollbar{height:6px}
.ipl-champs::-webkit-scrollbar-thumb{background:rgba(99,102,241,.3);border-radius:99px}
.ipl-champ{position:relative;background:linear-gradient(160deg,#fff 0%,rgba(255,255,255,.85) 100%);border:1.5px solid var(--cc,#6366F1);border-radius:14px;padding:14px 12px 16px;text-align:center;opacity:0;transform:translateY(10px);animation:iplFadeIn .6s cubic-bezier(.2,.8,.2,1) forwards;box-shadow:0 4px 14px rgba(15,23,42,.06);transition:transform .25s ease,box-shadow .25s ease}
.ipl-champ:hover{transform:translateY(-4px) rotate(-1deg);box-shadow:0 12px 28px rgba(15,23,42,.14)}
.ipl-champ::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,var(--cc,#6366F1),transparent 70%);opacity:.18;pointer-events:none;border-radius:14px}
.ipl-champ-trophy{font-size:32px;line-height:1;margin-bottom:4px;animation:trophyBob 2.2s ease-in-out infinite;display:inline-block}
@keyframes trophyBob{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-3px) rotate(3deg)}}
.ipl-champ-y{font-family:'Space Mono',monospace;font-size:18px;font-weight:700;color:var(--cc,#6366F1);line-height:1;margin-bottom:4px;position:relative;z-index:1}
.ipl-champ-t{font-size:11.5px;font-weight:700;color:#0F172A;line-height:1.25;position:relative;z-index:1}
body[data-theme=aurora] .ipl-champ{background:linear-gradient(160deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.02) 100%)}
body[data-theme=aurora] .ipl-champ-t{color:#F5F5FA}
/* Title tally — animated horizontal bars */
.ipl-titles{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.ipl-ttl-row{display:grid;grid-template-columns:180px 1fr 36px;align-items:center;gap:14px;opacity:0;transform:translateX(-12px);animation:iplBarIn .6s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes iplBarIn{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
.ipl-ttl-name{font-size:13.5px;font-weight:700;color:#0F172A}
.ipl-ttl-bar{height:14px;background:rgba(15,23,42,.06);border-radius:99px;overflow:hidden;position:relative}
.ipl-ttl-fill{height:100%;width:var(--pct,0);border-radius:99px;animation:barGrow 1.2s cubic-bezier(.2,.8,.2,1) forwards;transform-origin:left;transform:scaleX(0);position:relative;overflow:hidden}
@keyframes barGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.ipl-ttl-fill::after{content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:barShine 2.4s ease-in-out infinite}
@keyframes barShine{0%{left:-30%}100%{left:130%}}
.ipl-ttl-n{font-family:'Instrument Serif',Georgia,serif;font-size:22px;font-weight:400;color:#0F172A;text-align:right;letter-spacing:-.02em}
body[data-theme=aurora] .ipl-ttl-name,body[data-theme=aurora] .ipl-ttl-n{color:#F5F5FA}
body[data-theme=aurora] .ipl-ttl-bar{background:rgba(255,255,255,.08)}
@media (max-width:600px){.ipl-ttl-row{grid-template-columns:120px 1fr 30px;gap:10px}.ipl-ttl-name{font-size:12px}.ipl-ttl-n{font-size:18px}}

/* Magazine layout — shared by History & Geography */
.mag-pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;padding:4px 0}
.mag-pill{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;padding:9px 14px;border-radius:99px;background:#fff;border:1.5px solid #E8E9EF;color:#475569;cursor:pointer;transition:all .2s ease}
.mag-pill:hover{border-color:#6366F1;color:#0F172A;transform:translateY(-1px)}
.mag-pill.on{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff;border-color:transparent;box-shadow:0 6px 18px rgba(99,102,241,.3)}
.mag-pill-e{font-size:15px;line-height:1}
.mag-section-ttl{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;letter-spacing:-.01em;color:#0F172A;margin:6px 0 18px;display:flex;align-items:center;gap:14px}
.mag-section-ttl::before{content:'';flex:0 0 24px;height:1px;background:linear-gradient(90deg,transparent,rgba(99,102,241,.6))}
.mag-section-ttl::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,rgba(99,102,241,.6),transparent)}
.mag-section-ttl span{flex:0 0 auto}
.mag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;margin-bottom:18px}
.mag-card{display:flex;flex-direction:column;background:#fff;border:1px solid #E8E9EF;border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.04),0 6px 18px rgba(15,23,42,.06);opacity:0;transform:translateY(12px);animation:magCardIn .55s cubic-bezier(.2,.8,.2,1) forwards;transition:transform .25s ease,box-shadow .25s ease}
.mag-card:hover{transform:translateY(-3px);box-shadow:0 14px 32px rgba(15,23,42,.1)}
@keyframes magCardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.mag-card-img{position:relative;width:100%;height:180px;background:linear-gradient(135deg,#EEF2FF,#FCE7F3);overflow:hidden}
.mag-card-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s ease}
.mag-card:hover .mag-card-img img{transform:scale(1.04)}
.mag-card-img-empty{display:flex;align-items:center;justify-content:center;font-size:60px;color:rgba(15,23,42,.18)}
.mag-card-body{flex:1;padding:18px 20px 20px;display:flex;flex-direction:column}
.mag-card-kicker{font-size:11px;font-weight:800;color:#6366F1;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px}
.mag-card-h{font-family:'Instrument Serif',Georgia,serif;font-size:22px;font-weight:400;letter-spacing:-.015em;color:#0F172A;line-height:1.2;margin-bottom:6px}
.mag-card-d{font-size:12px;color:#94A3B8;font-weight:600;font-style:italic;margin-bottom:10px}
.mag-card-x{font-size:14px;line-height:1.55;color:#475569;margin-bottom:14px;flex:1;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.mag-card-cta{display:inline-block;font-size:13px;font-weight:700;color:#6366F1;text-decoration:none;align-self:flex-start;border-bottom:1.5px solid currentColor;padding-bottom:1px;transition:color .15s ease}
.mag-card-cta:hover{color:#EC4899}
body[data-theme=aurora] .mag-pill{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#9999B5}
body[data-theme=aurora] .mag-pill:hover{border-color:#A78BFA;color:#F5F5FA}
body[data-theme=aurora] .mag-section-ttl{color:#F5F5FA}
body[data-theme=aurora] .mag-card{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .mag-card-img{background:linear-gradient(135deg,rgba(99,102,241,.18),rgba(236,72,153,.12))}
body[data-theme=aurora] .mag-card-h{color:#F5F5FA}
body[data-theme=aurora] .mag-card-x{color:#9999B5}
body[data-theme=aurora] .mag-card-d{color:#6B6B85}
body[data-theme=aurora] .mag-card-kicker{color:#A78BFA}
body[data-theme=aurora] .mag-card-cta{color:#A78BFA}
body[data-theme=aurora] .mag-card-cta:hover{color:#F472B6}

/* History "On This Day" feed (legacy items kept for the Today section) */
.hist-feed{display:flex;flex-direction:column;gap:14px}
.hist-item{display:flex;gap:16px;background:#fff;border:1px solid #E8E9EF;border-radius:16px;padding:18px 20px;box-shadow:0 1px 3px rgba(15,23,42,.04),0 4px 14px rgba(15,23,42,.05);transition:transform .2s ease,box-shadow .2s ease}
.hist-item:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(15,23,42,.08)}
.hist-year{flex:0 0 90px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;border-right:1px dashed rgba(99,102,241,.3);padding-right:16px}
.hist-year b{font-family:'Instrument Serif',Georgia,serif;font-size:30px;font-weight:400;color:#B45309;line-height:1;letter-spacing:-.02em}
.hist-year small{font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-top:4px}
.hist-body{flex:1;min-width:0;display:flex;gap:14px;align-items:flex-start}
.hist-thumb{width:80px;height:80px;border-radius:10px;object-fit:cover;flex-shrink:0;background:#F1F5F9}
.hist-text{flex:1;min-width:0}
.hist-event{font-size:14.5px;line-height:1.55;color:#0F172A;margin-bottom:6px}
.hist-link{font-size:12.5px;font-weight:600}
.hist-link a{color:#6366F1;text-decoration:none}
.hist-link a:hover{text-decoration:underline;color:#4F46E5}
@media (max-width:600px){.hist-item{flex-direction:column;gap:10px}.hist-year{flex:0 0 auto;flex-direction:row;align-items:baseline;gap:8px;border-right:none;border-bottom:1px dashed rgba(99,102,241,.3);padding:0 0 8px;width:100%}.hist-thumb{width:64px;height:64px}}
body[data-theme=aurora] .hist-item{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .hist-event{color:#F5F5FA}
body[data-theme=aurora] .hist-year b{color:#FCD34D}
body[data-theme=aurora] .hist-link a{color:#A78BFA}
body[data-theme=aurora] .hist-link a:hover{color:#C4B5FD}

/* Refined editorial tab nav */
.tabs.page-t .tab{font-size:14px;font-weight:500;letter-spacing:-.005em;transition:color .15s ease,background .15s ease;color:var(--ink-3)}
.tabs.page-t .tab .ti svg{width:20px;height:20px;transition:transform .15s ease,opacity .15s ease;opacity:.85}
.tabs.page-t .tab:hover{color:var(--ink-2)}
.tabs.page-t .tab:hover .ti svg{opacity:1}
.tabs.page-t .tab.on{background:var(--bg-sunken)!important;color:var(--ink)!important;box-shadow:none!important;transform:none}
.tabs.page-t .tab.on .ti svg{opacity:1;transform:none;filter:none}
@media (max-width:600px){
  .tabs.page-t .tab{padding:8px 4px 6px;min-width:60px}
  .tabs.page-t .tab .ti svg{width:22px!important;height:22px!important}
  .tabs.page-t .tab .tl{font-size:11px;font-weight:500;letter-spacing:0;color:inherit}
  .tabs.page-t .tab.on{background:transparent!important;color:var(--ink)!important}
  .tabs.page-t .tab.on .ti svg{stroke-width:2;filter:none}
  .tabs.page-t .tab.on::after{content:'';position:absolute;bottom:3px;left:50%;transform:translateX(-50%);width:14px;height:2px;border-radius:2px;background:var(--ink)}
}
@media (min-width:992px){
  .app>.tabs.page-t .tab{padding:10px 14px;font-size:14px;font-weight:500;gap:10px;border-radius:8px}
  .app>.tabs.page-t .tab .ti svg{width:18px;height:18px}
  .app>.tabs.page-t{padding:14px 12px;gap:2px}
}
.section-hd{display:flex;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.section-hd h3{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;letter-spacing:-.02em}
.section-hd p{font-size:13px;color:var(--ink-3);margin-top:2px;font-weight:450}
.section-ic{width:36px;height:36px;border-radius:8px;background:var(--bg-sunken);color:var(--ink-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:none;border:1px solid var(--line)}
.section-ic svg{width:18px;height:18px}

</style></head><body>
<div class="bg-blob a"></div><div class="bg-blob b"></div><div class="bg-blob c"></div><div class="bg-blob d"></div>
<div class="ocean" aria-hidden="true">
<svg viewBox="0 0 1440 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="oc1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7DD3FC" stop-opacity=".55"/><stop offset="100%" stop-color="#0EA5E9" stop-opacity=".75"/></linearGradient>
<linearGradient id="oc2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#A5F3FC" stop-opacity=".5"/><stop offset="100%" stop-color="#06B6D4" stop-opacity=".7"/></linearGradient>
<linearGradient id="oc3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#C7F3FE" stop-opacity=".4"/><stop offset="100%" stop-color="#22D3EE" stop-opacity=".6"/></linearGradient></defs>
<path class="wv wv3" fill="url(#oc3)" d="M0,224 C240,160 480,288 720,224 C960,160 1200,288 1440,224 L1440,320 L0,320 Z"/>
<path class="wv wv2" fill="url(#oc2)" d="M0,256 C240,192 480,288 720,240 C960,192 1200,288 1440,240 L1440,320 L0,320 Z"/>
<path class="wv wv1" fill="url(#oc1)" d="M0,272 C240,224 480,304 720,272 C960,240 1200,304 1440,272 L1440,320 L0,320 Z"/>
</svg></div>
<div class="app" id="app"></div>
<noscript><div style="text-align:center;padding:40px 20px"><h1>Brodoit</h1><p>Brodoit needs JavaScript to run. Please enable JavaScript in your browser.</p><p><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p></div></noscript>
<footer id="seo-foot" style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:11px;color:rgba(100,116,139,.7);z-index:1;pointer-events:auto;display:flex;gap:8px;background:rgba(255,255,255,.6);backdrop-filter:blur(8px);padding:4px 10px;border-radius:8px"><a href="/privacy" style="color:inherit;text-decoration:none">Privacy</a><span>&middot;</span><a href="/terms" style="color:inherit;text-decoration:none">Terms</a></footer>
<style>@media (max-width:1023px){#seo-foot{display:none!important}}</style>
<script>
const MORALS=[{t:"The secret of getting ahead is getting started.",a:"Mark Twain"},{t:"It does not matter how slowly you go as long as you do not stop.",a:"Confucius"},{t:"Small daily improvements are the key to staggering long-term results.",a:"Robin Sharma"},{t:"Discipline is choosing between what you want now and what you want most.",a:"Abraham Lincoln"},{t:"Don't count the days. Make the days count.",a:"Muhammad Ali"},{t:"The best way to predict the future is to create it.",a:"Peter Drucker"},{t:"Focus on being productive instead of busy.",a:"Tim Ferriss"},{t:"You don't have to be great to start, but you have to start to be great.",a:"Zig Ziglar"},{t:"The journey of a thousand miles begins with a single step.",a:"Lao Tzu"},{t:"Either you run the day or the day runs you.",a:"Jim Rohn"},{t:"A year from now you may wish you had started today.",a:"Karen Lamb"},{t:"Success is the sum of small efforts repeated day in and day out.",a:"Robert Collier"},{t:"Done is better than perfect.",a:"Sheryl Sandberg"},{t:"The way to get started is to quit talking and begin doing.",a:"Walt Disney"},{t:"You cannot escape the responsibility of tomorrow by evading it today.",a:"Abraham Lincoln"},{t:"Motivation gets you going, but discipline keeps you growing.",a:"John C. Maxwell"},{t:"Do something today that your future self will thank you for.",a:"Sean Patrick Flanery"},{t:"The harder I work, the luckier I get.",a:"Samuel Goldwyn"},{t:"Don't watch the clock; do what it does. Keep going.",a:"Sam Levenson"},{t:"Great things never come from comfort zones.",a:"Neil Strauss"},{t:"Sometimes later becomes never. Do it now.",a:"Anonymous"},{t:"Wake up with determination. Go to bed with satisfaction.",a:"Anonymous"},{t:"A goal without a plan is just a wish.",a:"Antoine de Saint-Exupéry"},{t:"Little by little, day by day, what is meant for you will find its way.",a:"Anonymous"},{t:"Success doesn't just find you — you have to go out and get it.",a:"Anonymous"},{t:"Push yourself, because no one else is going to do it for you.",a:"Anonymous"},{t:"Dream big. Start small. Act now.",a:"Robin Sharma"},{t:"Hard work beats talent when talent doesn't work hard.",a:"Tim Notke"},{t:"The only impossible journey is the one you never begin.",a:"Tony Robbins"},{t:"Opportunities don't happen. You create them.",a:"Chris Grosser"}];
let S={tasks:[],view:'all',search:'',tab:'tasks',showAdd:false,editing:null,listening:false,toast:null,toastType:'ok',waOk:false,sending:{},user:null,
books:[],booksLoading:false,booksCat:'all',bookSearch:'',playing:null,moralIdx:Math.floor(Math.random()*MORALS.length),
history:{loading:false,loaded:{},events:[],articles:{}},historySec:'today',geography:{loading:false,loaded:{},articles:{}},geoSec:'earth',
game:{active:false,board:Array(9).fill(null),turn:'X',status:'idle',winLine:null,wins:Number(localStorage.getItem('tf_ttt_wins')||0),losses:Number(localStorage.getItem('tf_ttt_losses')||0),draws:Number(localStorage.getItem('tf_ttt_draws')||0)},
waConnected:localStorage.getItem('wa_connected')==='1',showWAOnboard:false,activeMeditation:null,
google:{configured:false,accounts:[],loaded:false},gcalEvents:[],gcalLoading:false,showGcalAdd:false,gcalForm:{title:'',date:'',time:'',duration:30,notes:'',email:''},
calMonth:new Date(),calSelectedDate:new Date().toISOString().slice(0,10),
steps:[],stepGoal:parseInt(localStorage.getItem('step_goal')||'10000',10),stepLive:{active:false,count:0},
theme:localStorage.getItem('theme')||'classic',
news:{},newsCat:'technology',newsLoading:false,
bookStreak:{streak:0,total:0,today:false,days:[]},_bkSec:0,

loginStep:'phone',loginMethod:'email',loginPhone:'',loginCountryCode:localStorage.getItem('tf_cc')||'+91',loginEmail:'',loginName:'',loginOTP:['','','','','',''],loginLoading:false,loginError:'',loginErrorDetail:'',loginErrorCode:0,loginSentTo:'',emailOk:false,
form:{title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'}};
let rec=null,token=localStorage.getItem('tf_token');
if(token){S.user={phone:localStorage.getItem('tf_phone'),name:localStorage.getItem('tf_name'),token}}else{restoreLoginState()}

const api=async(p,o={})=>{try{const h={'Content-Type':'application/json'};if(token)h['x-token']=token;const r=await fetch('/api'+p,{headers:h,...o});if(r.status===401){logout();return null}return await r.json()}catch(e){return null}};
const P={high:{c:'#E8453C',d:'\\u{1F534}'},medium:{c:'#E8912C',d:'\\u{1F7E0}'},low:{c:'#3DAE5C',d:'\\u{1F7E2}'}};
// Scenic Unsplash hero banners per tab (free, hot-link friendly)
// Per-tab illustrated doodles (sidebar) — colorful filled SVGs that read as illustrations
const ID={
tasks:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="4" width="20" height="24" rx="3.5" fill="currentColor" opacity="0.18"/><rect x="11" y="2.5" width="10" height="4" rx="1.5" fill="currentColor" opacity="0.5"/><circle cx="11" cy="12" r="1.6" fill="currentColor"/><circle cx="11" cy="18" r="1.6" fill="currentColor"/><circle cx="11" cy="24" r="1.6" fill="currentColor" opacity="0.45"/><line x1="15" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="15" y1="18" x2="22" y2="18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="15" y1="24" x2="20" y2="24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.45"/></svg>',
board:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="6" width="7.5" height="20" rx="2" fill="currentColor" opacity="0.5"/><rect x="12.25" y="6" width="7.5" height="13" rx="2" fill="currentColor" opacity="0.85"/><rect x="21.5" y="6" width="7.5" height="9" rx="2" fill="currentColor" opacity="0.3"/><circle cx="6.75" cy="10.5" r="1.2" fill="#fff"/><circle cx="16" cy="10.5" r="1.2" fill="#fff"/><circle cx="25.25" cy="10.5" r="1.2" fill="#fff"/></svg>',
cal:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="6" width="24" height="22" rx="3" fill="currentColor" opacity="0.18"/><rect x="4" y="6" width="24" height="6.5" rx="3" fill="currentColor" opacity="0.55"/><rect x="9" y="3" width="2" height="6" rx="1" fill="currentColor"/><rect x="21" y="3" width="2" height="6" rx="1" fill="currentColor"/><path d="M16 18.5l-1.4 2.8-3.1.45 2.25 2.2-.53 3.1L16 25.6l2.78 1.45-.53-3.1 2.25-2.2-3.1-.45z" fill="currentColor"/></svg>',
news:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="22" height="22" rx="2.5" fill="currentColor" opacity="0.18"/><rect x="25" y="10" width="4" height="17" rx="1.5" fill="currentColor" opacity="0.4"/><rect x="6" y="9" width="9" height="6" rx="1" fill="currentColor" opacity="0.55"/><line x1="17" y1="10" x2="22" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="17" y1="13.5" x2="22" y2="13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="6" y1="19" x2="22" y2="19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="6" y1="22.5" x2="20" y2="22.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/></svg>',
books:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 8 C 16 8 11 5 4 6 L 4 25 C 11 24 16 27 16 27 L 16 8 Z" fill="currentColor" opacity="0.55"/><path d="M16 8 C 16 8 21 5 28 6 L 28 25 C 21 24 16 27 16 27 L 16 8 Z" fill="currentColor" opacity="0.85"/><line x1="8" y1="11" x2="13" y2="11.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/><line x1="8" y1="15" x2="13" y2="15.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/><line x1="19" y1="11.6" x2="24" y2="11" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/><line x1="19" y1="15.6" x2="24" y2="15" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/></svg>',
meditation:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.14"/><circle cx="16" cy="16" r="9" fill="currentColor" opacity="0.18"/><circle cx="16" cy="9.5" r="3" fill="currentColor"/><path d="M9 22 C 11 17 14 16 16 16 C 18 16 21 17 23 22 C 22 23.5 18.5 24 16 24 C 13.5 24 10 23.5 9 22 Z" fill="currentColor"/><path d="M5 19 C 8 22 11 22 12 21" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" opacity="0.75"/><path d="M27 19 C 24 22 21 22 20 21" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" opacity="0.75"/></svg>',
history:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor" opacity="0.18"/><circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7"/><line x1="16" y1="16" x2="16" y2="9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="16" y1="16" x2="20.5" y2="18.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/><path d="M16 4 A12 12 0 0 0 4 16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.85"/><polyline points="4 12 4 16 8 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
geography:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor" opacity="0.2"/><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.85"/><path d="M4 16 H 28" stroke="currentColor" stroke-width="1.4" opacity="0.55"/><path d="M16 4 A 9 12 0 0 1 16 28 A 9 12 0 0 1 16 4 Z" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.55"/><path d="M16 4 A 14 12 0 0 1 16 28" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.4"/><path d="M16 4 A 14 12 0 0 0 16 28" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.4"/></svg>'
};
// "Rise Together" doodle — 4 animated figures climbing the same curve, holding hands; full SMIL animation
const MORAL_DOODLE='<svg class="moral-doodle" viewBox="0 0 520 200" preserveAspectRatio="xMaxYMid meet" xmlns="http://www.w3.org/2000/svg">'
// dashed shadow under curve (hand-drawn vibe)
+'<path d="M 30 175 C 150 172 240 162 330 130 S 460 40 510 18" stroke="#E8912C" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-dasharray="2 6" opacity="0.55" transform="translate(2 3)"/>'
+'<path d="M 30 175 C 150 172 240 162 330 130 S 460 40 510 18 L 510 180 L 30 180 Z" fill="url(#grow)" opacity="0.22"/>'
+'<defs><linearGradient id="grow" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#3DAE5C"/><stop offset="100%" stop-color="#E8912C"/></linearGradient></defs>'
// main rising curve — animate stroke draw on a slow loop
+'<path d="M 30 175 C 150 172 240 162 330 130 S 460 40 510 18" stroke="#6366F1" stroke-width="3.2" fill="none" stroke-linecap="round" opacity="0.85" stroke-dasharray="700" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" values="700;0;0;-700" keyTimes="0;0.45;0.55;1" dur="6s" repeatCount="indefinite"/></path>'
// chain of hands connecting figures — animate dashoffset to look like it\\'s being drawn between climbs
+'<path d="M 95 152 Q 175 148 215 132 T 320 102 T 415 60 T 490 22" stroke="#0F172A" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.55" stroke-dasharray="6 4"><animate attributeName="stroke-dashoffset" values="0;-40" dur="2.2s" repeatCount="indefinite"/></path>'
// FIGURE 1 (purple) — bobs as it climbs, with swinging legs
+'<g stroke="#6366F1" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  +'<circle cx="105" cy="148" r="6" fill="#6366F1"/><line x1="105" y1="154" x2="105" y2="170"/><line x1="105" y1="160" x2="93" y2="166"/><line x1="105" y1="160" x2="118" y2="152"/>'
  +'<line x1="105" y1="170" x2="98" y2="180"><animate attributeName="x2" values="98;112;98" dur=".6s" repeatCount="indefinite"/><animate attributeName="y2" values="180;176;180" dur=".6s" repeatCount="indefinite"/></line>'
  +'<line x1="105" y1="170" x2="112" y2="180"><animate attributeName="x2" values="112;98;112" dur=".6s" repeatCount="indefinite"/><animate attributeName="y2" values="180;176;180" dur=".6s" repeatCount="indefinite"/></line>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur=".6s" repeatCount="indefinite"/>'
+'</g>'
// FIGURE 2 (green) — same walk-bob, slightly offset
+'<g stroke="#3DAE5C" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  +'<circle cx="215" cy="128" r="6.5" fill="#3DAE5C"/><line x1="215" y1="135" x2="215" y2="152"/><line x1="215" y1="142" x2="200" y2="138"/><line x1="215" y1="142" x2="232" y2="132"/>'
  +'<line x1="215" y1="152" x2="208" y2="164"><animate attributeName="x2" values="208;222;208" dur=".55s" repeatCount="indefinite"/><animate attributeName="y2" values="164;160;164" dur=".55s" repeatCount="indefinite"/></line>'
  +'<line x1="215" y1="152" x2="222" y2="164"><animate attributeName="x2" values="222;208;222" dur=".55s" repeatCount="indefinite"/><animate attributeName="y2" values="164;160;164" dur=".55s" repeatCount="indefinite"/></line>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -2.5;0 0" dur=".55s" begin="0.15s" repeatCount="indefinite"/>'
+'</g>'
// FIGURE 3 (orange) — also bobs
+'<g stroke="#E8912C" stroke-width="2.7" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  +'<circle cx="320" cy="98" r="7" fill="#E8912C"/><line x1="320" y1="105" x2="320" y2="124"/><line x1="320" y1="112" x2="305" y2="108"/><line x1="320" y1="112" x2="338" y2="100"/>'
  +'<line x1="320" y1="124" x2="312" y2="138"><animate attributeName="x2" values="312;328;312" dur=".58s" repeatCount="indefinite"/><animate attributeName="y2" values="138;134;138" dur=".58s" repeatCount="indefinite"/></line>'
  +'<line x1="320" y1="124" x2="328" y2="138"><animate attributeName="x2" values="328;312;328" dur=".58s" repeatCount="indefinite"/><animate attributeName="y2" values="138;134;138" dur=".58s" repeatCount="indefinite"/></line>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur=".58s" begin="0.3s" repeatCount="indefinite"/>'
+'</g>'
// FIGURE 4 (red) — celebration at the peak with raised arms; small jubilant bounce
+'<g stroke="#E8453C" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  +'<circle cx="490" cy="22" r="7" fill="#E8453C"/><line x1="490" y1="29" x2="490" y2="48"/><line x1="490" y1="34" x2="478" y2="22"/><line x1="490" y1="34" x2="502" y2="22"/><line x1="490" y1="48" x2="482" y2="60"/><line x1="490" y1="48" x2="498" y2="60"/>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -4;0 0" dur=".5s" repeatCount="indefinite"/>'
+'</g>'
// flag — waves
+'<g><line x1="502" y1="22" x2="502" y2="4" stroke="#0F172A" stroke-width="1.8" stroke-linecap="round"/>'
  +'<path d="M 502 4 L 520 8 L 502 14 Z" fill="#E8453C" opacity="0.95"><animate attributeName="d" values="M 502 4 L 520 8 L 502 14 Z;M 502 4 L 516 6 L 502 14 Z;M 502 4 L 520 8 L 502 14 Z" dur="1.4s" repeatCount="indefinite"/></path>'
+'</g>'
// sparkle stars — rotate + pulse
+'<g fill="#E8912C">'
  +'<path d="M 460 10 l 1.5 -4 1.5 4 4 0 -3 2.5 1.2 4 -3.7 -2.4 -3.7 2.4 1.2 -4 -3 -2.5 z" opacity="0.85"><animateTransform attributeName="transform" type="rotate" from="0 463 12" to="360 463 12" dur="9s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.4;1;0.4" dur="2s" repeatCount="indefinite"/></path>'
  +'<path d="M 510 50 l 1.2 -3 1.2 3 3.2 0 -2.4 2 1 3.2 -3 -2 -3 2 1 -3.2 -2.4 -2 z" opacity="0.85"><animateTransform attributeName="transform" type="rotate" from="0 511 50" to="-360 511 50" dur="7s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.3;1" dur="2.4s" repeatCount="indefinite"/></path>'
+'</g>'
// "+1% daily" pill — breathes
+'<g>'
  +'<line x1="120" y1="140" x2="142" y2="118" stroke="#1A9E47" stroke-width="1.4" opacity="0.7"/>'
  +'<rect x="138" y="100" width="76" height="22" rx="11" fill="#3DAE5C" opacity="0.95"><animate attributeName="opacity" values="0.85;1;0.85" dur="2.2s" repeatCount="indefinite"/></rect>'
  +'<text x="176" y="115" font-family="Inter, sans-serif" font-size="11.5" font-weight="800" fill="#FFFFFF" text-anchor="middle">+1% daily</text>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0" dur="2.4s" repeatCount="indefinite"/>'
+'</g>'
// "Rise Together" pill — breathes opposite phase
+'<g>'
  +'<line x1="445" y1="42" x2="380" y2="62" stroke="#B57B00" stroke-width="1.4" opacity="0.7"/>'
  +'<rect x="270" y="62" width="118" height="24" rx="12" fill="#E8912C" opacity="0.95"><animate attributeName="opacity" values="0.85;1;0.85" dur="2.2s" begin="1.1s" repeatCount="indefinite"/></rect>'
  +'<text x="329" y="78" font-family="Inter, sans-serif" font-size="12" font-weight="800" fill="#FFFFFF" text-anchor="middle">Rise together \\u2197</text>'
  +'<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0" dur="2.4s" begin="1.1s" repeatCount="indefinite"/>'
+'</g>'
// rising "+1" floaters from each step (motivational)
+'<g font-family="Inter, sans-serif" font-size="10" font-weight="800" fill="#3DAE5C">'
  +'<text x="115" y="140" text-anchor="middle" opacity="0">+1<animate attributeName="y" values="140;115" dur="2s" begin="0s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.85;0" dur="2s" begin="0s" repeatCount="indefinite"/></text>'
  +'<text x="225" y="120" text-anchor="middle" opacity="0">+1<animate attributeName="y" values="120;90" dur="2s" begin="0.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.85;0" dur="2s" begin="0.6s" repeatCount="indefinite"/></text>'
  +'<text x="330" y="92" text-anchor="middle" opacity="0">+1<animate attributeName="y" values="92;60" dur="2s" begin="1.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.85;0" dur="2s" begin="1.2s" repeatCount="indefinite"/></text>'
+'</g>'
// caption at top
+'<text x="270" y="14" font-family="Inter, sans-serif" font-size="9.5" font-weight="800" fill="#6366F1" text-anchor="middle" letter-spacing="1.4">GROW \\u2022 TOGETHER \\u2022 TRACK \\u2022 REPEAT</text>'
// Comet — a glowing dot that travels along the growth curve every 8s
+'<g class="moral-comet"><circle r="3.5" fill="#FFFFFF" stroke="#6366F1" stroke-width="1.4" filter="url(#cometGlow)"><animateMotion dur="8s" repeatCount="indefinite" rotate="auto" path="M 30 175 C 150 172 240 162 330 130 S 460 40 510 18"/></circle></g>'
+'<defs><filter id="cometGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
+'</svg>';
const TAB_HERO={
  tasks:{img:'1499951360447-b19be8fe80f5',h:'Make today count',s:'Small wins, stacked daily'},
  board:{img:'1454165804606-c3d57bc86b40',h:'Move it forward',s:'Drag, drop, ship'},
  cal:{img:'1506905925346-21bda4d32df4',h:'Plan with intention',s:'Your week, beautifully laid out'},
  dash:{img:'1551288049-bebda4e38f71',h:'Track your progress',s:'Numbers that tell your story'},
  news:{img:'1495020689067-958852a7765e',h:'What\\u2019s new today',s:'Curated stories from across the web'},
  books:{img:'1507842217343-583bb7270b66',h:'Read &amp; grow',s:'Free public-domain audio \\u2022 a few minutes a day'},
  meditation:{img:'1518609878373-06d740f60d8b',h:'Pause and breathe',s:'Guided sessions for a calm mind'},
  history:{img:'1481627834876-b7833e8f5570',h:'A library of yesterdays',s:'Civilisations, science, art \\u2022 stories that built our world'},
  geography:{img:'1446776877081-d282a0f896e2',h:'Earth, oceans, the cosmos',s:'Read about the world we live in \\u2022 from atoms to galaxies'}
};
function ic(n,sz){sz=sz||20;const s='width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';const m={
tasks:'<svg '+s+'><path d="M9 11l2 2 4-4"/><path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c1.66 0 3.22.45 4.56 1.23"/></svg>',
board:'<svg '+s+'><path d="M3 3h7v18H3z"/><path d="M14 3h7v10h-7z"/><path d="M14 17h7v4h-7z"/></svg>',
cal:'<svg '+s+'><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>',
dash:'<svg '+s+'><path d="M3 18l6-6 4 4 8-8"/><path d="M14 8h7v7"/></svg>',
news:'<svg '+s+'><path d="M4 4h13v16H4z"/><path d="M17 8h3v10a2 2 0 0 1-2 2h-1"/><path d="M8 8h5M8 12h9M8 16h9"/></svg>',
books:'<svg '+s+'><path d="M3 4.5c0-.83.67-1.5 1.5-1.5H8a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4.5c-.83 0-1.5-.67-1.5-1.5z"/><path d="M21 4.5c0-.83-.67-1.5-1.5-1.5H16a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h4.5c.83 0 1.5-.67 1.5-1.5z"/></svg>',
meditation:'<svg '+s+'><circle cx="12" cy="5" r="2"/><path d="M5 22c1-3 3-5 4-6l-3-1.5c-.5-.2-.5-.8 0-1l4-1c1-2.5 2-3 2-3s1 .5 2 3l4 1c.5.2.5.8 0 1L15 16c1 1 3 3 4 6"/><path d="M12 16v6"/></svg>',
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
plus:'<svg '+s+'><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
history:'<svg '+s+'><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/><path d="M3 12 a9 9 0 0 1 9 -9"/></svg>',
geography:'<svg '+s+'><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3 a14 9 0 0 1 0 18"/><path d="M12 3 a14 9 0 0 0 0 18"/></svg>'};return m[n]||''}
const ST={pending:{l:'To Do',c:'#94A3B8',bg:'#F1F5F9'},'in-progress':{l:'Doing',c:'#3B82F6',bg:'#EFF6FF'},done:{l:'Done',c:'#3DAE5C',bg:'#F2FBF4'}};
const fD=d=>d?new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const fT=t=>{if(!t)return'';const[h,m]=t.split(':');const hr=+h;return(hr>12?hr-12:hr||12)+':'+m+' '+(hr>=12?'PM':'AM')};
const isOD=(d,s)=>d&&s!=='done'&&new Date(d+'T00:00:00')<new Date(new Date().setHours(0,0,0,0));
const isTd=d=>d===new Date().toISOString().split('T')[0];
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function toast(m,t){S.toast=m;S.toastType=t||'ok';render();setTimeout(()=>{S.toast=null;render()},3000)}
const WI='<svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

const COUNTRY_CODES=[
{c:'+91',n:'India',f:'\\u{1F1EE}\\u{1F1F3}'},{c:'+1',n:'United States / Canada',f:'\\u{1F1FA}\\u{1F1F8}'},{c:'+44',n:'United Kingdom',f:'\\u{1F1EC}\\u{1F1E7}'},
{c:'+61',n:'Australia',f:'\\u{1F1E6}\\u{1F1FA}'},{c:'+971',n:'United Arab Emirates',f:'\\u{1F1E6}\\u{1F1EA}'},{c:'+966',n:'Saudi Arabia',f:'\\u{1F1F8}\\u{1F1E6}'},
{c:'+65',n:'Singapore',f:'\\u{1F1F8}\\u{1F1EC}'},{c:'+60',n:'Malaysia',f:'\\u{1F1F2}\\u{1F1FE}'},{c:'+62',n:'Indonesia',f:'\\u{1F1EE}\\u{1F1E9}'},
{c:'+92',n:'Pakistan',f:'\\u{1F1F5}\\u{1F1F0}'},{c:'+880',n:'Bangladesh',f:'\\u{1F1E7}\\u{1F1E9}'},{c:'+94',n:'Sri Lanka',f:'\\u{1F1F1}\\u{1F1F0}'},
{c:'+977',n:'Nepal',f:'\\u{1F1F3}\\u{1F1F5}'},{c:'+86',n:'China',f:'\\u{1F1E8}\\u{1F1F3}'},{c:'+81',n:'Japan',f:'\\u{1F1EF}\\u{1F1F5}'},
{c:'+82',n:'South Korea',f:'\\u{1F1F0}\\u{1F1F7}'},{c:'+49',n:'Germany',f:'\\u{1F1E9}\\u{1F1EA}'},{c:'+33',n:'France',f:'\\u{1F1EB}\\u{1F1F7}'},
{c:'+39',n:'Italy',f:'\\u{1F1EE}\\u{1F1F9}'},{c:'+34',n:'Spain',f:'\\u{1F1EA}\\u{1F1F8}'},{c:'+31',n:'Netherlands',f:'\\u{1F1F3}\\u{1F1F1}'},
{c:'+46',n:'Sweden',f:'\\u{1F1F8}\\u{1F1EA}'},{c:'+47',n:'Norway',f:'\\u{1F1F3}\\u{1F1F4}'},{c:'+45',n:'Denmark',f:'\\u{1F1E9}\\u{1F1F0}'},
{c:'+41',n:'Switzerland',f:'\\u{1F1E8}\\u{1F1ED}'},{c:'+353',n:'Ireland',f:'\\u{1F1EE}\\u{1F1EA}'},{c:'+27',n:'South Africa',f:'\\u{1F1FF}\\u{1F1E6}'},
{c:'+234',n:'Nigeria',f:'\\u{1F1F3}\\u{1F1EC}'},{c:'+254',n:'Kenya',f:'\\u{1F1F0}\\u{1F1EA}'},{c:'+20',n:'Egypt',f:'\\u{1F1EA}\\u{1F1EC}'},
{c:'+972',n:'Israel',f:'\\u{1F1EE}\\u{1F1F1}'},{c:'+90',n:'Turkey',f:'\\u{1F1F9}\\u{1F1F7}'},{c:'+7',n:'Russia / Kazakhstan',f:'\\u{1F1F7}\\u{1F1FA}'},
{c:'+55',n:'Brazil',f:'\\u{1F1E7}\\u{1F1F7}'},{c:'+52',n:'Mexico',f:'\\u{1F1F2}\\u{1F1FD}'},{c:'+54',n:'Argentina',f:'\\u{1F1E6}\\u{1F1F7}'},
{c:'+64',n:'New Zealand',f:'\\u{1F1F3}\\u{1F1FF}'},{c:'+852',n:'Hong Kong',f:'\\u{1F1ED}\\u{1F1F0}'},{c:'+886',n:'Taiwan',f:'\\u{1F1F9}\\u{1F1FC}'},
{c:'+66',n:'Thailand',f:'\\u{1F1F9}\\u{1F1ED}'},{c:'+84',n:'Vietnam',f:'\\u{1F1FB}\\u{1F1F3}'},{c:'+63',n:'Philippines',f:'\\u{1F1F5}\\u{1F1ED}'}
];
function formatPhonePreview(p){const d=(p||'').replace(/[^0-9+]/g,'');if(!d)return '';if(d.length===10&&!d.startsWith('+'))return null;let out=d;if(!out.startsWith('+'))out='+'+out;return out}
function updatePhonePreview(){const el=document.getElementById('phPreview');if(!el)return;const cc=S.loginCountryCode||'+91';const local=(S.loginPhone||'').replace(/[^0-9]/g,'');if(!local){el.innerHTML='<span style="color:#94A3B8">Type your number above</span>';return}if(local.length<6){el.innerHTML='<span style="color:#94A3B8">Keep typing\\u2026</span>';return}el.innerHTML='<span style="color:#16A34A">\\u2713 Will send to '+cc+' '+local+'</span>'}
function persistLoginState(){try{localStorage.setItem('tf_login_state',JSON.stringify({step:S.loginStep,method:S.loginMethod,phone:S.loginPhone,cc:S.loginCountryCode,email:S.loginEmail,name:S.loginName,sentTo:S.loginSentTo,ts:Date.now()}));if(S.loginCountryCode)localStorage.setItem('tf_cc',S.loginCountryCode)}catch(e){}}
function restoreLoginState(){try{const raw=localStorage.getItem('tf_login_state');if(!raw)return;const d=JSON.parse(raw);if(!d||!d.ts||Date.now()-d.ts>15*60*1000){localStorage.removeItem('tf_login_state');return}S.loginStep=d.step||'phone';S.loginMethod=d.method||'email';S.loginPhone=d.phone||'';S.loginCountryCode=d.cc||S.loginCountryCode||'+91';S.loginEmail=d.email||'';S.loginName=d.name||'';S.loginSentTo=d.sentTo||''}catch(e){}}
function clearLoginState(){try{localStorage.removeItem('tf_login_state')}catch(e){}}
async function sendOTP(){S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){const em=(S.loginEmail||'').trim().toLowerCase();if(!/^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$/i.test(em)){S.loginError='Enter a valid email address';S.loginLoading=false;render();return}url='/api/send-otp-email';body={email:em}}else{const cc=(S.loginCountryCode||'+91').replace(/[^0-9+]/g,'');const local=(S.loginPhone||'').replace(/[^0-9]/g,'');if(!local){S.loginError='Enter your WhatsApp number';S.loginLoading=false;render();return}if(local.length<6){S.loginError='Phone number too short';S.loginLoading=false;render();return}const ph=cc+local;url='/api/send-otp';body={phone:ph}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({ok:false,error:'Network error \\u2014 check your connection'}));S.loginLoading=false;if(r.ok){S.loginStep='otp';S.loginOTP=['','','','','',''];S.loginError='';S.loginSentTo=r.phone||S.loginEmail||((S.loginCountryCode||'')+S.loginPhone);persistLoginState();render();setTimeout(()=>{const el=document.getElementById('otp0');if(el)el.focus()},100)}else{S.loginError=r.error||'Failed to send OTP';S.loginErrorDetail=r.detail||'';S.loginErrorCode=r.code||0;render()}}
async function verifyOTP(){const code=S.loginOTP.join('');if(code.length<6){S.loginError='Enter the 6-digit code';render();return}S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){url='/api/verify-otp-email';body={email:(S.loginEmail||'').trim().toLowerCase(),code,name:S.loginName}}else{let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;url='/api/verify-otp';body={phone:ph,code,name:S.loginName}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({error:'Network error'}));S.loginLoading=false;if(r.token){token=r.token;localStorage.setItem('tf_token',r.token);localStorage.setItem('tf_phone',r.phone);localStorage.setItem('tf_name',r.name||'');if(r.email)localStorage.setItem('tf_email',r.email);S.user=r;S.loginStep='phone';clearLoginState();load();chk();toast('\\u2705 Welcome!')}else{S.loginError=r.error||'Verification failed';render()}}
function otpInput(i,v){const d=v.slice(-1);S.loginOTP[i]=d;const el=document.getElementById('otp'+i);if(el)el.value=d;if(d&&i<5){const nx=document.getElementById('otp'+(i+1));if(nx)nx.focus()}else if(d&&i===5){if(S.loginOTP.every(x=>x))verifyOTP()}}
function otpKey(i,e){if(e.key==='Backspace'&&!S.loginOTP[i]&&i>0){const prev=document.getElementById('otp'+(i-1));if(prev){prev.focus();S.loginOTP[i-1]='';prev.value=''}}}
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

// History magazine sections — each is a curated list of Wikipedia article slugs
const HISTORY_SECTIONS=[
  {k:'today',l:'On This Day',e:'\\u{1F4C5}'},
  {k:'ancient',l:'Ancient World',e:'\\u{1F3DB}\\uFE0F',titles:['Ancient_Egypt','Ancient_Rome','Ancient_Greece','Indus_Valley_Civilisation','Mesopotamia','Maya_civilization','Ancient_China','Persian_Empire']},
  {k:'science',l:'Science & Discovery',e:'\\u{1F52C}',titles:['Isaac_Newton','Albert_Einstein','Marie_Curie','Charles_Darwin','Nikola_Tesla','Galileo_Galilei','Ada_Lovelace','Alan_Turing']},
  {k:'empires',l:'Empires & Wars',e:'\\u{2694}\\uFE0F',titles:['Roman_Empire','Mongol_Empire','British_Empire','Ottoman_Empire','Mughal_Empire','Byzantine_Empire','World_War_II','World_War_I']},
  {k:'art',l:'Art & Culture',e:'\\u{1F3A8}',titles:['Leonardo_da_Vinci','Renaissance','Michelangelo','William_Shakespeare','Wolfgang_Amadeus_Mozart','Vincent_van_Gogh','Pablo_Picasso','Frida_Kahlo']},
  {k:'innov',l:'Innovations',e:'\\u{1F4A1}',titles:['Printing_press','Industrial_Revolution','History_of_the_Internet','Telephone','Electricity','Steam_engine','Wright_brothers','Penicillin']}
];
const GEOGRAPHY_SECTIONS=[
  {k:'earth',l:'Earth',e:'\\u{1F30D}',titles:['Earth','Plate_tectonics','Continental_drift','Atmosphere_of_Earth','Pangaea','Earth%27s_inner_core','Geosphere','Volcano']},
  {k:'universe',l:'Universe',e:'\\u{1F30C}',titles:['Universe','Big_Bang','Solar_System','Galaxy','Black_hole','Milky_Way','Cosmic_microwave_background','Dark_matter']},
  {k:'oceans',l:'Oceans & Seas',e:'\\u{1F30A}',titles:['Pacific_Ocean','Atlantic_Ocean','Indian_Ocean','Arctic_Ocean','Mariana_Trench','Coral_reef','Great_Barrier_Reef','Ocean_current']},
  {k:'land',l:'Mountains & Land',e:'\\u{1F3D4}\\uFE0F',titles:['Mount_Everest','Sahara','Amazon_rainforest','Grand_Canyon','Antarctica','Himalayas','Andes','Yellowstone_National_Park']},
  {k:'climate',l:'Climate & Weather',e:'\\u{1F324}\\uFE0F',titles:['Climate_change','Monsoon','Tropical_cyclone','Desert','Permafrost','Aurora','Tornado','Glacier']},
  {k:'space',l:'Space',e:'\\u{1F680}',titles:['Mars','Moon','Sun','Saturn','Jupiter','International_Space_Station','James_Webb_Space_Telescope','Voyager_program']}
];
function switchTab(t){if(t==='steps'||t==='dash')t='tasks';S.tab=t;if(t==='books'&&!S.books.length)loadBooks('all');if(t==='meditation'&&!S.meditations)loadMeditations();if(t==='news'&&!S.news[S.newsCat])loadNews(S.newsCat);if(t==='history'&&!S.history.loaded[S.historySec||'today'])loadHistorySec(S.historySec||'today');if(t==='geography'&&!S.geography.loaded[S.geoSec||'earth'])loadGeoSec(S.geoSec||'earth');if(t==='cal'){if(!S.google.loaded)loadGoogleStatus();else if(S.google.accounts.length&&!S.gcalEvents.length&&!S.gcalLoading)loadGcalEvents()}render()}
async function loadHistorySec(k){S.historySec=k;S.history.loading=true;render();try{if(k==='today'){const r=await fetch('/api/history/today');const j=await r.json();S.history.events=j.events||[]}else{const sec=HISTORY_SECTIONS.find(s=>s.k===k);if(!sec){S.history.loaded[k]=true;S.history.loading=false;render();return}const r=await fetch('/api/wiki/summaries?titles='+encodeURIComponent(sec.titles.join(',')));const j=await r.json();S.history.articles=S.history.articles||{};S.history.articles[k]=j.summaries||[]}}catch(e){}S.history.loaded[k]=true;S.history.loading=false;render()}
async function loadGeoSec(k){S.geoSec=k;S.geography.loading=true;render();try{const sec=GEOGRAPHY_SECTIONS.find(s=>s.k===k);if(!sec){S.geography.loaded[k]=true;S.geography.loading=false;render();return}const r=await fetch('/api/wiki/summaries?titles='+encodeURIComponent(sec.titles.join(',')));const j=await r.json();S.geography.articles=S.geography.articles||{};S.geography.articles[k]=j.summaries||[]}catch(e){}S.geography.loaded[k]=true;S.geography.loading=false;render()}
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
books:"Free audiobook library from Libri Vox. Search, browse, and listen. Keep a streak by listening for two minutes a day.",
meditation:"Take a mindful break. Pick a one, five, ten, twenty, or thirty minute guided meditation and let your breath settle."
};
function pickBestVoice(){try{const vs=speechSynthesis.getVoices()||[];if(!vs.length)return null;const pref=['Samantha','Google UK English Female','Microsoft Aria Online (Natural) - English (United States)','Microsoft Jenny Online (Natural) - English (United States)','Google US English','Karen','Moira','Tessa','Veena','Fiona','Allison','Ava','Susan'];for(const name of pref){const v=vs.find(x=>x.name===name||x.name.indexOf(name)===0);if(v)return v}const en=vs.filter(v=>(v.lang||'').toLowerCase().startsWith('en'));const natural=en.find(v=>/natural|neural|premium|enhanced/i.test(v.name));if(natural)return natural;const female=en.find(v=>/female|samantha|karen|moira|tessa|veena|fiona|allison|ava|susan|aria|jenny/i.test(v.name));if(female)return female;return en[0]||vs[0]}catch(e){return null}}
function speakIntro(){try{if(!('speechSynthesis' in window)){toast('\\u26A0\\uFE0F Voice not supported on this device','err');return}const t=TAB_INTROS[S.tab];if(!t)return;speechSynthesis.cancel();const go=()=>{const u=new SpeechSynthesisUtterance(t);const v=pickBestVoice();if(v){u.voice=v;u.lang=v.lang}u.rate=.92;u.pitch=1.05;u.volume=1;speechSynthesis.speak(u);toast('\\u{1F50A} Playing intro')};const vs=speechSynthesis.getVoices();if(!vs||!vs.length){speechSynthesis.onvoiceschanged=()=>{speechSynthesis.onvoiceschanged=null;go()};setTimeout(go,250)}else go()}catch(e){toast('\\u26A0\\uFE0F Voice error','err')}}
function stopSpeak(){try{speechSynthesis.cancel()}catch(e){}}
function filterBooks(v){S.bookSearch=v;const grid=document.getElementById('books-grid');if(!grid){render();return}const q=(v||'').toLowerCase().trim();const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});grid.innerHTML=renderBookCards(fb)}
function renderBookCards(fb){if(!fb.length)return '<div class="empty"><div style="font-size:36px">\\u{1F4DA}</div><div style="font-size:14px;margin-top:8px">No books found</div></div>';let h='<div class="book-list">';fb.forEach(b=>{const id=b.identifier;const cover='https://archive.org/services/img/'+id;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');const title=Array.isArray(b.title)?b.title[0]:b.title;h+='<div class="book-card"><div class="book-cover"><img src="'+cover+'" loading="lazy" onerror="this.style.display=\\'none\\'"/></div><div class="book-info"><div class="book-title">'+esc(title)+'</div><div class="book-author">'+esc(author)+'</div><div class="book-meta"><span>\\u{1F3A7} '+(b.downloads?(+b.downloads).toLocaleString():'\\u2014')+' plays</span><span>\\u{1F4D6} LibriVox</span></div></div><button class="book-play" onclick="playBook(\\''+id+'\\')">\\u25B6</button></div>'});h+='</div>';return h}
function openWAOnboard(){S.showWAOnboard=true;render()}
function closeWAOnboard(){S.showWAOnboard=false;render()}
function openWAJoin(){const code=window.__TWILIO_SANDBOX_CODE||'along-wool';window.open('https://wa.me/14155238886?text='+encodeURIComponent('join '+code),'_blank')}
function saveBroDoitContact(){const a=document.createElement('a');a.href='/brodoit.vcf';a.download='BroDoit.vcf';document.body.appendChild(a);a.click();setTimeout(()=>document.body.removeChild(a),1000);toast('\\u{1F4D2} Downloading BroDoit contact \\u2014 open it to save')}
function confirmWAJoined(){S.waConnected=true;localStorage.setItem('wa_connected','1');S.showWAOnboard=false;toast('\\u2705 WhatsApp connected');render()}
function disconnectWA(){S.waConnected=false;localStorage.removeItem('wa_connected');toast('\\u23F8 WhatsApp disconnected');render()}
// Vipassana-focused guided meditations with verified Internet Archive identifiers (audio plays directly)
const MED_SLOTS=[
{mins:10,title:'Mini Anāpāna',desc:'Goenka 10-min breath awareness — a calm starting point',color:'#06B6D4',directId:'MiniAnapanaTel'},
{mins:15,title:'Anāpāna + Mettā',desc:'Breath awareness followed by loving-kindness',color:'#3B82F6',directId:'AnapanaEnglishMetta'},
{mins:30,title:'Vipassana Body Scan',desc:'Full body sweep, observing sensations equanimously',color:'#8B5CF6',directId:'intro-practice-francais-mini-anapana-various-2017'},
{mins:45,title:'Vipassana Standard Sit',desc:'Classic 45-minute body sweep — the core practice',color:'#EC4899',directId:'VipassanaBodyScanMeditation'},
{mins:60,title:'Vipassana Long Sit',desc:'Extended seated practice — work seriously, work patiently',color:'#F59E0B',directId:'OshoOnVipassanaMeditation01'}
];
async function loadMeditations(){if(S.medLoading)return;S.medLoading=true;S.meditations=S.meditations||{};render();await Promise.all(MED_SLOTS.map(async s=>{if(S.meditations[s.mins])return;if(s.directId){S.meditations[s.mins]={identifier:s.directId,title:s.title};return}try{const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(s.q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=1&output=json&sort[]=downloads+desc';const r=await fetch(url);const j=await r.json();S.meditations[s.mins]=(j.response&&j.response.docs&&j.response.docs[0])||null}catch(e){S.meditations[s.mins]=null}}));S.medLoading=false;render()}
async function loadGoogleStatus(){const r=await api('/google/status');if(r){S.google={configured:!!r.configured,accounts:r.accounts||[],loaded:true};render();if(S.google.accounts.length&&S.tab==='cal')loadGcalEvents()}}
async function connectGoogle(){const r=await api('/google/auth-url');if(!r||!r.url){toast('\\u26A0\\uFE0F Google integration is not configured yet. Ask admin to set GOOGLE_CLIENT_ID/SECRET.','err');return}const w=window.open(r.url,'_blank','width=520,height=640');if(!w){location.href=r.url;return}window.addEventListener('message',function onMsg(e){if(e.data&&e.data.type==='google-connected'){window.removeEventListener('message',onMsg);toast('\\u2705 Connected '+e.data.email);loadGoogleStatus()}},{once:false});const poll=setInterval(()=>{if(w.closed){clearInterval(poll);loadGoogleStatus()}},900)}
async function disconnectGoogle(email){if(!confirm('Disconnect '+(email||'all Google accounts')+' from Brodoit Calendar?'))return;const r=await api('/google/disconnect',{method:'POST',body:JSON.stringify({email:email||''})});if(r&&r.ok){toast('\\u23F8 Disconnected');S.gcalEvents=[];loadGoogleStatus()}}
async function setDefaultGoogle(email){const r=await api('/google/set-default',{method:'POST',body:JSON.stringify({email})});if(r&&r.ok){toast('\\u2705 Default account set to '+email);loadGoogleStatus()}}
async function loadGcalEvents(){if(!S.google.accounts.length)return;S.gcalLoading=true;render();const def=S.google.accounts.find(a=>a.is_default)||S.google.accounts[0];const r=await api('/calendar/events?email='+encodeURIComponent(def.email));S.gcalLoading=false;if(r&&r.events){S.gcalEvents=r.events;render()}else{S.gcalEvents=[];render();if(r&&r.error)toast('\\u26A0\\uFE0F '+r.error,'err')}}
function openGcalAdd(){const def=S.google.accounts.find(a=>a.is_default)||S.google.accounts[0];S.gcalForm={title:'',date:S.calSelectedDate||new Date().toISOString().slice(0,10),time:'',duration:30,notes:'',email:def?def.email:''};S.showGcalAdd=true;render()}
function closeGcalAdd(){S.showGcalAdd=false;render()}
async function saveGcalEvent(){const f=S.gcalForm;if(!f.title.trim()){toast('\\u26A0\\uFE0F Title required','err');return}const r=await api('/calendar/events',{method:'POST',body:JSON.stringify({title:f.title.trim(),date:f.date,time:f.time||null,duration:f.duration||30,notes:f.notes,email:f.email})});if(r&&r.ok){toast('\\u2705 Event added to '+(f.email||'Google Calendar'));S.showGcalAdd=false;loadGcalEvents()}else if(r&&r.error){toast('\\u26A0\\uFE0F '+r.error,'err')}}
function playMedSlot(mins){const doc=(S.meditations||{})[mins];if(!doc){toast('\\u23F3 Loading audio...','err');return}const t=Array.isArray(doc.title)?doc.title[0]:doc.title;playMeditation(doc.identifier,t,mins)}
async function playMeditation(id,title,mins){S.playing={id,title:title||(mins+'-minute meditation'),author:'Guided meditation \\u2022 Internet Archive',loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=j.files.find(f=>/\\.mp3$/i.test(f.name)&&!/sample|preview/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const directUrl='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');const dlUrl='https://archive.org/download/'+encodeURIComponent(id)+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title:title||mins+'-min meditation',author:'\\u{1F9D8} Guided meditation \\u2022 Archive.org',url:directUrl,altUrl:dlUrl,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(!a)return;a.setAttribute('playsinline','');a.preload='auto';a.addEventListener('error',function onErr(){a.removeEventListener('error',onErr);if(a.src!==dlUrl){a.src=dlUrl;a.load()}},{once:true});a.load();const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap play on the bar','err'))},250)}else{toast('\\u26A0\\uFE0F No mp3 \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing=null;render()}}
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
// Tic Tac Toe vs a simple bot (you play X, bot plays O)
const TTT_LINES=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttCheck(b,p){for(const l of TTT_LINES){if(l.every(i=>b[i]===p))return l}return null}
function tttBotMove(b){
  for(let i=0;i<9;i++){if(b[i])continue;b[i]='O';if(tttCheck(b,'O')){b[i]=null;return i}b[i]=null}
  for(let i=0;i<9;i++){if(b[i])continue;b[i]='X';if(tttCheck(b,'X')){b[i]=null;return i}b[i]=null}
  if(!b[4])return 4;
  const corners=[0,2,6,8].filter(c=>!b[c]);if(corners.length)return corners[Math.floor(Math.random()*corners.length)];
  const empty=[];for(let i=0;i<9;i++)if(!b[i])empty.push(i);
  return empty[Math.floor(Math.random()*empty.length)];
}
function gameStart(){
  S.game.active=true;S.game.board=Array(9).fill(null);S.game.turn='X';S.game.status='playing';S.game.winLine=null;render();
}
function gameTap(i){
  if(!S.game.active||S.game.status!=='playing'||S.game.turn!=='X'||S.game.board[i])return;
  S.game.board[i]='X';
  const winLine=tttCheck(S.game.board,'X');
  if(winLine){S.game.winLine=winLine;return tttFinish('won')}
  if(S.game.board.every(c=>c))return tttFinish('draw');
  S.game.turn='O';render();
  setTimeout(()=>{
    if(!S.game.active||S.game.status!=='playing')return;
    const idx=tttBotMove(S.game.board);S.game.board[idx]='O';
    const wl=tttCheck(S.game.board,'O');
    if(wl){S.game.winLine=wl;return tttFinish('lost')}
    if(S.game.board.every(c=>c))return tttFinish('draw');
    S.game.turn='X';render();
  },520);
}
function tttFinish(result){
  S.game.status=result;
  if(result==='won'){S.game.wins++;localStorage.setItem('tf_ttt_wins',S.game.wins)}
  else if(result==='lost'){S.game.losses++;localStorage.setItem('tf_ttt_losses',S.game.losses)}
  else if(result==='draw'){S.game.draws++;localStorage.setItem('tf_ttt_draws',S.game.draws)}
  S.game.active=false;render();
}
function gameEnd(){S.game.active=false;S.game.status='idle';render()}
// Live-tick the sidebar AND header clocks without re-rendering the whole tree
setInterval(()=>{const n=new Date();const hm=n.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});const sec=String(n.getSeconds()).padStart(2,'0');const t=document.getElementById('sideNowTime');const s=document.getElementById('sideNowSec');if(t&&s){if(t.firstChild&&t.firstChild.nodeValue!==hm)t.firstChild.nodeValue=hm;s.textContent=sec}const ht=document.getElementById('hdrTimeHm');const hs=document.getElementById('hdrTimeSec');if(ht&&hs){if(ht.textContent!==hm)ht.textContent=hm;hs.textContent=':'+sec}},1000);

async function loadBooks(cat){S.booksCat=cat;S.booksLoading=true;render();try{const subjectMap={'self-help':'(subject:"self-help" OR subject:"self help" OR subject:"self improvement" OR subject:"non-fiction")'};const subj=subjectMap[cat]||('subject:'+cat);const q=cat==='all'?'collection:librivoxaudio AND mediatype:audio':'collection:librivoxaudio AND mediatype:audio AND '+subj;const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=30&output=json&sort[]=downloads+desc';const r=await fetch(url);const j=await r.json();S.books=j.response.docs;}catch(e){S.books=[];toast('\\u26A0\\uFE0F Failed to load books','err')}S.booksLoading=false;render()}
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
if(S.loginStep==='phone'){
h+='<div class="hero-photo"><img src="https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1200&q=80" alt="Calm productive workspace" loading="eager"/><div class="hero-photo-overlay"></div></div>';
h+='<div class="login-logo">Brodoit</div>';
h+='<div class="login-tagline">Tasks. Books. Wisdom.</div>';
h+='<div class="login-sub">A calm, focused space for the work that matters.</div>';
h+='<div class="login-tabs"><button class="login-tab'+(S.loginMethod==='email'?' on':'')+'" onclick="S.loginMethod=\\'email\\';S.loginError=\\'\\';persistLoginState();render()"><span style="font-size:18px">\\u2709\\uFE0F</span>Email</button><button class="login-tab'+(S.loginMethod==='whatsapp'?' on':'')+'" onclick="S.loginMethod=\\'whatsapp\\';S.loginError=\\'\\';persistLoginState();render()"><span style="font-size:18px">\\u{1F4F1}</span>WhatsApp</button></div>';
h+='<input id="loginName" type="text" placeholder="Your name" value="'+esc(S.loginName)+'" oninput="S.loginName=this.value;persistLoginState()" style="font-size:15px;letter-spacing:0">';
if(S.loginMethod==='email'){
  h+='<input id="loginEmail" type="email" placeholder="you@example.com" value="'+esc(S.loginEmail)+'" oninput="S.loginEmail=this.value;persistLoginState()" autocomplete="email" style="font-size:15px;letter-spacing:0">';
  if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
  h+='<button class="login-btn" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Sending code...':'\\u2709\\uFE0F Send code to email')+'</button>';
  h+='<div class="login-hint">We\\'ll email a 6-digit code. Check your inbox (and spam folder).</div>';
}else{
  h+='<div class="wa-login-step"><div class="wa-step-num">1</div><div class="wa-step-body"><div class="wa-step-title">Save BroDoit on WhatsApp</div><div class="wa-step-desc">First save BroDoit to your contacts \\u2014 then sending the message feels safe and familiar.</div><button class="wa-save-btn" onclick="saveBroDoitContact()">\\u{1F4C7} Save BroDoit to contacts</button></div></div>';
  h+='<div class="wa-login-step"><div class="wa-step-num">2</div><div class="wa-step-body"><div class="wa-step-title">Say hi to BroDoit</div><div class="wa-step-desc">Tap below \\u2014 WhatsApp opens with a pre-filled message to BroDoit. Just hit <b>Send</b>.</div><button class="wa-join-btn" onclick="openWAJoin()"><svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>Open WhatsApp &amp; tap Send</button></div></div>';
  h+='<div class="wa-login-step"><div class="wa-step-num">3</div><div class="wa-step-body"><div class="wa-step-title">Enter your WhatsApp number</div><div class="wa-step-desc">Pick your country, then type the number without the country code.</div>';
  h+='<div class="phone-row"><select id="loginCC" class="cc-select" onchange="S.loginCountryCode=this.value;persistLoginState();updatePhonePreview()" aria-label="Country code">';
  COUNTRY_CODES.forEach(c=>{h+='<option value="'+c.c+'"'+(c.c===S.loginCountryCode?' selected':'')+'>'+c.f+' '+c.n+' ('+c.c+')</option>'});
  h+='</select>';
  h+='<input id="loginPhone" type="tel" placeholder="98765 43210" value="'+esc(S.loginPhone)+'" oninput="S.loginPhone=this.value;persistLoginState();updatePhonePreview()" autocomplete="tel-national" inputmode="tel" class="phone-num"></div>';
  h+='<div id="phPreview" style="font-size:12px;margin-top:6px;font-weight:600;min-height:16px"></div>';
  h+='</div></div>';
  if(S.loginError)h+='<div class="login-err"><div class="login-err-msg">'+S.loginError+'</div>'+(S.loginErrorCode?'<div class="login-err-code">Twilio code '+S.loginErrorCode+(S.loginErrorDetail?' \\u2014 '+esc(S.loginErrorDetail.slice(0,140)):'')+'</div>':'')+'<div class="login-err-acts"><button onclick="openWAJoin()">\\u{1F501} Re-send join code</button><button onclick="S.loginMethod=\\'email\\';S.loginError=\\'\\';render()">\\u2709\\uFE0F Use email instead</button></div></div>';
  h+='<button class="login-btn" style="background:linear-gradient(135deg,#25D366,#128C7E);box-shadow:0 6px 18px rgba(37,211,102,.32);border:none" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Sending code...':'\\u{1F4F1} Send code via WhatsApp')+'</button>';
  h+='<div class="login-hint">After step 1, your code arrives instantly on WhatsApp.</div>';
}
}else if(S.loginStep==='otp'){
h+='<div class="login-logo" style="margin-top:48px">Bro<span class="k">Do</span>it</div>';
h+='<div class="login-sub">Code sent via '+(S.loginMethod==='email'?'\\u2709\\uFE0F email':'\\u{1F4F1} WhatsApp')+' to<br><strong>'+esc(S.loginSentTo||(S.loginMethod==='email'?S.loginEmail:S.loginPhone))+'</strong></div>';
h+='<div class="step-dots"><div class="step-dot on"></div><div class="step-dot on"></div><div class="step-dot"></div></div>';
h+='<div class="otp-inputs">';
for(let i=0;i<6;i++)h+='<input id="otp'+i+'" type="tel" maxlength="1" value="'+S.loginOTP[i]+'" oninput="otpInput('+i+',this.value)" onkeydown="otpKey('+i+',event)">';
h+='</div>';
if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
h+='<button class="login-btn" onclick="verifyOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Verifying...':'Verify & Login')+'</button>';
h+='<button class="login-btn sec" onclick="S.loginStep=\\'phone\\';S.loginError=\\'\\';render()">\\u2190 Change number</button>';
h+='<div class="login-hint">Didn\\'t get the code? Check your spam folder or click "Change number" to retry.</div>';
}
h+='<footer class="login-foot"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a><span>\\u2022</span><a href="/terms" target="_blank" rel="noopener">Terms of Service</a><span>\\u2022</span><a href="mailto:hello@brodoit.com">Contact</a></footer>';
h+='</div>';
if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
document.getElementById('app').innerHTML=h;
if(S.loginMethod==='whatsapp'&&S.loginStep==='phone')updatePhonePreview();
return;
}

const ts=S.tasks,f=ts.filter(t=>{if(S.search){const q=S.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||'').toLowerCase().includes(q))return false}if(S.view==='all')return true;if(S.view==='today')return isTd(t.due_date);if(S.view==='overdue')return isOD(t.due_date,t.status);return t.status===S.view});
const s={total:ts.length,pend:ts.filter(t=>t.status==='pending').length,act:ts.filter(t=>t.status==='in-progress').length,dn:ts.filter(t=>t.status==='done').length,od:ts.filter(t=>isOD(t.due_date,t.status)).length};

const JUMPER='<svg class="hdr-jumper" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">'
  +'<line class="ground" x1="6" y1="48" x2="54" y2="48" stroke-width="1.2" stroke-linecap="round"/>'
  +'<path class="rope-top" d="M 8 32 Q 30 6 52 32" stroke="#E8453C" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
  +'<path class="rope-bottom" d="M 8 32 Q 30 56 52 32" stroke="#E8453C" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
  +'<g class="jumper">'
    +'<circle cx="30" cy="14" r="3.4" fill="currentColor"/>'
    +'<line x1="30" y1="17" x2="30" y2="32" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    +'<line x1="30" y1="22" x2="22" y2="30" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    +'<line x1="30" y1="22" x2="38" y2="30" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    +'<g class="leg-l"><line x1="30" y1="32" x2="26" y2="44" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></g>'
    +'<g class="leg-r"><line x1="30" y1="32" x2="34" y2="44" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></g>'
  +'</g>'
  +'<g class="puff" opacity="0" fill="#94A3B8"><circle cx="20" cy="48" r="1.8"/><circle cx="40" cy="48" r="1.8"/></g>'
  +'</svg>';
const _now=new Date();
const _hm=_now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
const _sec=String(_now.getSeconds()).padStart(2,'0');
const _date=_now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
const HDR_TIME='<div class="hdr-time">'
  +'<span class="hdr-time-hm" id="hdrTimeHm">'+_hm+'</span>'
  +'<span class="hdr-time-sec" id="hdrTimeSec">:'+_sec+'</span>'
  +'<span class="hdr-time-sep">|</span>'
  +'<span class="hdr-time-date">'+_date+'</span>'
+'</div>';
// Phone-only scenic masthead — three Ken-Burns-zooming photos cycling above the logo
const PHONE_BANNER='<div class="phone-banner" aria-hidden="true">'
  +'<div class="phone-banner-img" style="background-image:url(&quot;https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=900&q=70&auto=format&fit=crop&quot;)"></div>'
  +'<div class="phone-banner-img" style="background-image:url(&quot;https://images.unsplash.com/photo-1499951360447-b19be8fe80f5?w=900&q=70&auto=format&fit=crop&quot;)"></div>'
  +'<div class="phone-banner-img" style="background-image:url(&quot;https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=900&q=70&auto=format&fit=crop&quot;)"></div>'
  +'<div class="phone-banner-tag">\\u2022  T A S K S  \\u2022  B O O K S  \\u2022  W I S D O M  \\u2022  C A L M  \\u2022</div>'
+'</div>';
let h=PHONE_BANNER+'<div class="hdr"><div><div class="logo">Bro<span class="k">Do</span>it</div><div class="hdr-tagline">tasks &middot; books &middot; wisdom &middot; calm</div><div class="hdr-sub">'+JUMPER+HDR_TIME+'</div></div><div class="hdr-actions"><button class="theme-tg" onclick="toggleTheme()" title="Switch theme">'+(S.theme==='aurora'?ic('sun',18):ic('moon',18))+'</button><div class="hdr-st"><span class="dot" style="background:'+(S.waConnected&&S.waOk?'#10B981':'#CBD5E1')+'"></span>'+(S.waConnected&&S.waOk?'LIVE':'OFF')+'</div></div></div>';

// Moral chip
const m=MORALS[S.moralIdx];
h+='<div class="moral">'+MORAL_DOODLE+'<div class="moral-emoji">\\u{1F4A1}</div><div class="moral-body"><div class="moral-lbl">Moral of the Day</div><div class="moral-txt">"'+esc(m.t)+'"</div><div class="moral-by">\\u2014 '+esc(m.a)+'</div></div><button class="moral-ref" onclick="rotateMoral()" title="New quote">\\u21BB</button></div>';

// Tabs
{
  const now=new Date();
  const yStart=new Date(now.getFullYear(),0,0);
  const dayOfYear=Math.floor((now-yStart)/86400000);
  const yearPct=Math.round(dayOfYear/365*100);
  const dateStr=now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const tabsHtml=[{k:'tasks',l:'Tasks'},{k:'board',l:'Board'},{k:'cal',l:'Calendar'},{k:'news',l:'News'},{k:'history',l:'History'},{k:'geography',l:'Geography'},{k:'books',l:'Books'},{k:'meditation',l:'Meditate'}].map(x=>'<button class="tab tab-'+x.k+(S.tab===x.k?' on':'')+'" onclick="stopSpeak();switchTab(\\''+x.k+'\\')"><span class="ti">'+(ID[x.k]||ic(x.k,26))+'</span><span class="tl">'+x.l+'</span></button>').join('');
  // "Bro, do it!" mascot — a character with a speech bubble that animates
  const climbScene='<div class="bro-mascot" aria-hidden="true">'
    +'<svg class="bro-svg" viewBox="0 0 340 130" xmlns="http://www.w3.org/2000/svg">'
    +  '<defs><filter id="broShadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceGraphic" stdDeviation="2"/></filter></defs>'
    +  '<g class="bro-figure">'
    +    '<circle cx="48" cy="44" r="16" fill="#6366F1"/>'
    +    '<circle cx="42" cy="42" r="2.2" fill="#fff"/><circle cx="54" cy="42" r="2.2" fill="#fff"/>'
    +    '<path d="M 42 50 Q 48 54 54 50" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    +    '<line x1="48" y1="60" x2="48" y2="92" stroke="#6366F1" stroke-width="3.4" stroke-linecap="round"/>'
    +    '<g class="bro-arm-r"><line x1="48" y1="72" x2="76" y2="58" stroke="#6366F1" stroke-width="3.2" stroke-linecap="round"/></g>'
    +    '<line x1="48" y1="72" x2="28" y2="84" stroke="#6366F1" stroke-width="3.2" stroke-linecap="round"/>'
    +    '<line x1="48" y1="92" x2="36" y2="118" stroke="#6366F1" stroke-width="3.2" stroke-linecap="round"/>'
    +    '<line x1="48" y1="92" x2="60" y2="118" stroke="#6366F1" stroke-width="3.2" stroke-linecap="round"/>'
    +  '</g>'
    +  '<g class="bro-bubble">'
    +    '<path d="M 100 18 Q 100 4 116 4 L 316 4 Q 332 4 332 18 L 332 78 Q 332 92 316 92 L 130 92 L 110 110 L 116 92 L 116 92 Q 100 92 100 78 Z" fill="#FFFFFF" stroke="#6366F1" stroke-width="2.2" filter="drop-shadow(0 4px 10px rgba(99,102,241,0.18))"/>'
    +    '<text x="216" y="42" text-anchor="middle" font-family="Instrument Serif, Georgia, serif" font-size="26" font-style="italic" fill="#0F172A">Bro,</text>'
    +    '<text x="216" y="74" text-anchor="middle" font-family="Instrument Serif, Georgia, serif" font-size="32" font-weight="400" fill="#6366F1">do it!</text>'
    +  '</g>'
    +  '<g class="bro-spark"><path d="M 320 38 l 1.5 -4 1.5 4 4 0 -3 2.5 1.2 4 -3.7 -2.4 -3.7 2.4 1.2 -4 -3 -2.5 z" fill="#E8912C"/></g>'
    +  '<g class="bro-spark2"><circle cx="86" cy="14" r="2.4" fill="#3DAE5C"/></g>'
    +'</svg>'
    +'</div>';
  const daysLeft=365-dayOfYear;
  const sideNow='<div class="side-now" aria-hidden="true">'
    +'<div class="side-now-lbl">Local time</div>'
    +'<div class="side-now-time" id="sideNowTime">'+now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})+'<span class="sec" id="sideNowSec">'+String(now.getSeconds()).padStart(2,'0')+'</span></div>'
    +'<div class="side-now-date">'+dateStr+'</div>'
    +'<div class="side-now-stat">\\u23F3 <b>'+daysLeft+'</b> days left in '+now.getFullYear()+'</div>'
    +'<div class="side-now-bar"><div class="side-now-fill" style="width:'+yearPct+'%"></div><div class="side-now-comet"></div></div>'
    +'<div class="side-now-foot"><span>YEAR PROGRESS \\u2022 '+yearPct+'%</span><span>Day '+dayOfYear+' / 365</span></div>'
    +'<svg class="side-now-wave" viewBox="0 0 100 30" preserveAspectRatio="none"><path d="M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15" stroke="#6366F1" stroke-width="1.6" fill="none"><animate attributeName="d" dur="4s" repeatCount="indefinite" values="M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15;M 0 15 Q 12.5 25 25 15 T 50 15 T 75 15 T 100 15;M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15"/></path></svg>'
    +'</div>';
  h+='<nav class="tabs page-t">'+tabsHtml+'</nav>';
  h+='<section class="top-strip" aria-hidden="true">'+climbScene+sideNow+'</section>';
}

h+='<main class="main-col">';
h+='<div class="user-bar" style="cursor:pointer" onclick="openProfile()"><span>\\u{1F464} '+esc(S.user.name||S.user.phone)+' <span style="color:#94A3B8;font-size:11px">\\u203A Profile</span></span><button onclick="event.stopPropagation();logout()">Logout</button></div>';
h+='<div class="section-div" aria-hidden="true"></div>';

// Scenic tab hero — sets the mood for the section
{
  const hero=TAB_HERO[S.tab];
  if(hero){
    const url='https://images.unsplash.com/photo-'+hero.img+'?w=1400&q=80&auto=format&fit=crop';
    h+='<div class="tab-hero" style="background-image:linear-gradient(135deg,rgba(15,23,42,.62) 0%,rgba(15,23,42,.32) 55%,rgba(15,23,42,.18) 100%),url(&quot;'+url+'&quot;)"><div class="tab-hero-particles"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><div class="tab-hero-body"><h2 class="tab-hero-h">'+hero.h+'</h2><p class="tab-hero-s">'+hero.s+'</p></div></div>';
  }
}

// TASKS TAB
if(S.tab==='dash')S.tab='tasks'; // Stats tab removed; redirect any stale state to Tasks
if(S.tab==='tasks'){
  // Tic Tac Toe vs a simple bot
  {
    const g=S.game;
    h+='<div class="game-card"><div class="game-hd"><div class="game-ttl"><span class="game-emoji">\\u{1F3AF}</span> Tic Tac Toe</div><div class="game-best">W <b>'+g.wins+'</b> \\u2022 L <b>'+g.losses+'</b> \\u2022 D <b>'+g.draws+'</b></div></div>';
    if(!g.active){
      let prompt='You play X, the bot plays O. Want a quick game?';
      if(g.status==='won')prompt='\\u{1F3C6} You won! Want another round?';
      else if(g.status==='lost')prompt='Bot got that one. Try again?';
      else if(g.status==='draw')prompt='Draw \\u2014 nobody wins. One more?';
      h+='<div class="game-cta"><div class="game-prompt">'+prompt+'</div><button class="game-btn" onclick="gameStart()">'+(g.status==='idle'?'Start game':'Play again')+'</button></div>';
    }else{
      const status=g.turn==='X'?'Your turn (X)':'Bot thinking\\u2026';
      h+='<div class="game-status-line"><span class="game-status'+(g.turn==='X'?' status-you':' status-bot')+'">'+status+'</span></div>';
      h+='<div class="game-grid ttt-grid">';
      for(let i=0;i<9;i++){
        const v=g.board[i];const won=g.winLine&&g.winLine.includes(i);
        h+='<button class="game-cell ttt-cell'+(v?' ttt-'+v.toLowerCase():'')+(won?' ttt-win':'')+(v?' ttt-filled':'')+'" onclick="gameTap('+i+')" aria-label="cell">'+(v||'')+'</button>';
      }
      h+='</div>';
      h+='<div class="game-foot"><div class="game-hint">tap any empty square</div><button class="game-stop" onclick="gameEnd()">Stop</button></div>';
    }
    h+='</div>';
  }
  h+='<button class="add-bar" onclick="opA()"><span class="plus">+</span><span class="txt"><b>Add a new task</b><small>'+(S.waConnected?'Type, speak, or send via WhatsApp':'Type or use voice input')+'</small></span></button>';
  if(S.waConnected&&S.waOk)h+='<div class="al" style="background:#EDFCF2;border:1px solid #B7E8C4;color:#1A9E47">\\u{1F4F1} WhatsApp connected</div>';
  else h+='<div class="al" style="background:var(--bg-elev);border:1px solid var(--line);color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-radius:10px" onclick="openWAOnboard()"><span style="display:flex;align-items:center;gap:12px;line-height:1.4">'+WI+'<span><b style="font-size:14px;font-weight:500;color:var(--ink)">WhatsApp reminders</b><div style="font-size:12px;color:var(--ink-3);font-weight:450;margin-top:2px">Optional setup \\u2014 takes 10 seconds</div></span></span><span style="font-weight:400;font-size:18px;color:var(--ink-3)">\\u2192</span></div>';
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
  // Google Calendar integration banner / accounts
  if(!S.google.loaded)h+='<div class="gcal-card gcal-loading">Connecting to Google\\u2026</div>';
  else if(!S.google.accounts.length){
    h+='<div class="gcal-card gcal-cta"><div class="gcal-icon"><svg width="38" height="38" viewBox="0 0 48 48"><path fill="#fbbc04" d="M37 6h-3V4a2 2 0 1 0-4 0v2H18V4a2 2 0 1 0-4 0v2h-3a5 5 0 0 0-5 5v26a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V11a5 5 0 0 0-5-5z"/><path fill="#fff" d="M11 18h26v18H11z"/><path fill="#1a73e8" d="M16 22h6v6h-6zm10 0h6v6h-6zm-10 8h6v6h-6zm10 0h6v6h-6z"/></svg></div><div class="gcal-body"><h3>Sync with Google Calendar</h3><p>See your Gmail events here, and let Brodoit add new ones to your calendar with one tap.</p><button class="mb mb-s" style="background:linear-gradient(135deg,#4285F4,#34A853);border:none;color:#fff" onclick="connectGoogle()">'+(S.google.configured?'\\u{1F517} Connect Google Calendar':'Set up Google integration')+'</button>'+(!S.google.configured?'<div style="font-size:11px;color:#94A3B8;margin-top:8px">Admin needs to set GOOGLE_CLIENT_ID/SECRET first.</div>':'')+'</div></div>';
  } else {
    const def=S.google.accounts.find(a=>a.is_default)||S.google.accounts[0];
    h+='<div class="gcal-card gcal-connected"><div class="gcal-acc-row">';
    h+='<div class="gcal-acc-l"><svg width="22" height="22" viewBox="0 0 48 48"><path fill="#fbbc04" d="M37 6h-3V4a2 2 0 1 0-4 0v2H18V4a2 2 0 1 0-4 0v2h-3a5 5 0 0 0-5 5v26a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V11a5 5 0 0 0-5-5z"/><path fill="#fff" d="M11 18h26v18H11z"/><path fill="#1a73e8" d="M16 22h6v6h-6zm10 0h6v6h-6zm-10 8h6v6h-6zm10 0h6v6h-6z"/></svg><div><b style="font-size:13.5px">Google Calendar synced</b><div style="font-size:12px;color:#64748B">'+esc(def.email)+(S.google.accounts.length>1?' +'+(S.google.accounts.length-1)+' more':'')+'</div></div></div>';
    h+='<div class="gcal-acc-r"><button class="mb mb-s" style="padding:8px 14px;font-size:13px" onclick="openGcalAdd()">+ New event</button></div></div>';
    if(S.google.accounts.length>1){
      h+='<div class="gcal-acc-list">';
      S.google.accounts.forEach(a=>{h+='<button class="gcal-chip'+(a.is_default?' on':'')+'" onclick="setDefaultGoogle(\\''+esc(a.email)+'\\')" title="Set as default">'+esc(a.email)+(a.is_default?' \\u2713':'')+'</button>'});
      h+='<button class="gcal-chip gcal-chip-add" onclick="connectGoogle()" title="Add another account">+ Add account</button>';
      h+='</div>';
    }
    h+='<div class="gcal-acc-foot"><button class="gcal-link" onclick="connectGoogle()">+ Add another Gmail</button><button class="gcal-link" onclick="loadGcalEvents()">\\u21BB Refresh</button><button class="gcal-link gcal-link-d" onclick="disconnectGoogle(\\''+esc(def.email)+'\\')">Disconnect '+esc(def.email)+'</button></div>';
    h+='</div>';
  }
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
  // gcal events by date
  const gByDate={};
  (S.gcalEvents||[]).forEach(e=>{const k=(e.start||'').slice(0,10);if(k)(gByDate[k]=gByDate[k]||[]).push(e)});
  const todayK=new Date().toISOString().slice(0,10);
  const sel=S.calSelectedDate;
  h+='<div class="cal-head"><button class="cal-nav" onclick="calPrev()">\\u2039</button><h3>'+esc(monthName)+'</h3><button class="cal-nav" onclick="calNext()">\\u203A</button></div>';
  h+='<div class="cal-grid">';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>h+='<div class="cal-dow">'+d+'</div>');
  cells.forEach(c=>{
    const dk=c.y+'-'+String(c.m+1).padStart(2,'0')+'-'+String(c.d).padStart(2,'0');
    const tasksHere=byDate[dk]||[];
    const gHere=gByDate[dk]||[];
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
    if(gHere.length)dots+='<i style="background:#4285F4" title="Google Calendar"></i>';
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
    const gSelHere=gByDate[sel]||[];
    if(gSelHere.length){
      h+='<div class="gcal-day-list"><div class="gcal-day-h"><svg width="14" height="14" viewBox="0 0 48 48"><path fill="#4285F4" d="M37 6h-3V4a2 2 0 1 0-4 0v2H18V4a2 2 0 1 0-4 0v2h-3a5 5 0 0 0-5 5v26a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V11a5 5 0 0 0-5-5z"/></svg> Google Calendar events</div>';
      gSelHere.forEach(e=>{const tm=e.allDay?'All day':(e.start?new Date(e.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'');h+='<div class="gcal-evt"><div class="gcal-evt-time">'+esc(tm)+'</div><div class="gcal-evt-body"><div class="gcal-evt-title">'+esc(e.title)+'</div>'+(e.location?'<div class="gcal-evt-loc">\\u{1F4CD} '+esc(e.location)+'</div>':'')+'</div><a class="gcal-evt-open" href="'+esc(e.link||'#')+'" target="_blank" rel="noopener">Open \\u2197</a></div>'});
      h+='</div>';
    }
    h+='<div class="cal-add-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px"><button class="add-bar" style="margin:0" onclick="calAddForDate()"><span class="plus">+</span><span class="txt"><b>Brodoit task</b><small>'+esc(selLabel)+'</small></span></button>';
    if(S.google.accounts.length)h+='<button class="add-bar gcal-add-bar" style="margin:0" onclick="openGcalAdd()"><span class="plus" style="background:#4285F4">G</span><span class="txt"><b>Google Calendar</b><small>Adds event to Gmail</small></span></button>';
    h+='</div>';
    h+='</div>';
  }
  // Upcoming Google events list
  if(S.google.accounts.length){
    const upcoming=(S.gcalEvents||[]).filter(e=>(e.start||'')>=todayK).slice(0,8);
    if(upcoming.length){
      h+='<div class="gcal-upcoming"><h4>\\u{1F4C5} Upcoming on Google Calendar</h4>';
      upcoming.forEach(e=>{const dt=e.start?new Date(e.start):null;const dlbl=dt?dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}):'';const tlbl=e.allDay?'All day':(dt?dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'');h+='<div class="gcal-evt"><div class="gcal-evt-time"><b>'+esc(dlbl)+'</b><small>'+esc(tlbl)+'</small></div><div class="gcal-evt-body"><div class="gcal-evt-title">'+esc(e.title)+'</div></div><a class="gcal-evt-open" href="'+esc(e.link||'#')+'" target="_blank" rel="noopener">Open \\u2197</a></div>'});
      h+='</div>';
    } else if(S.gcalLoading) h+='<div class="muted" style="margin-top:10px;text-align:center">Loading Google events\\u2026</div>';
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
      h+='<div class="inshort-feed">';
      items.forEach((it,i)=>{
        const img=it.img||'';
        const when=timeAgo(it.date);
        const srcName=(it.source||'').charAt(0).toUpperCase()+(it.source||'').slice(1);
        h+='<article class="inshort">';
        if(img)h+='<div class="inshort-img"><img src="'+esc(img)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add(\\'inshort-img-placeholder\\');this.remove()"><div class="inshort-src">'+esc(srcName)+'</div></div>';
        else h+='<div class="inshort-img inshort-img-placeholder"><div class="inshort-src">'+esc(srcName)+'</div><div style="font-size:64px;opacity:.25">\\u{1F4F0}</div></div>';
        h+='<div class="inshort-body">';
        h+='<h3 class="inshort-title">'+esc(it.title||'')+'</h3>';
        if(it.desc)h+='<p class="inshort-desc">'+esc(it.desc)+'</p>';
        h+='<div class="inshort-foot"><span class="inshort-time">'+(when?'\\u{1F552} '+esc(when):'')+'</span>';
        h+='<button class="inshort-share" onclick="shareNews('+i+')" aria-label="Share"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>Share</button></div>';
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
  h+='<div class="flt">'+[{k:'all',l:'All'},{k:'fiction',l:'Fiction'},{k:'self-help',l:'Self Development'},{k:'mystery',l:'Mystery'},{k:'philosophy',l:'Philosophy'},{k:'adventure',l:'Adventure'},{k:'kids',l:'Kids'}].map(c=>'<button class="fb'+(S.booksCat===c.k?' on':'')+'" onclick="loadBooks(\\''+c.k+'\\')">'+c.l+'</button>').join('')+'</div>';
  if(S.booksLoading)h+='<div class="loading">Loading audiobooks...</div>';
  else{
    const q=S.bookSearch.toLowerCase().trim();
    const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});
    h+='<div id="books-grid">'+renderBookCards(fb)+'</div>';
  }
}

// MEDITATION TAB
else if(S.tab==='meditation'){
  h+='<div class="section-hd"><span class="section-ic">'+ic('meditation',22)+'</span><div><h3>Vipassana Meditation</h3><p>Guided sittings from Anāpāna to a full hour \\u2022 standard durations</p></div></div>';
  if(S.medLoading&&!S.meditations)h+='<div class="loading">Finding guided meditations...</div>';
  h+='<div class="med-grid">';
  MED_SLOTS.forEach(x=>{
    const doc=(S.meditations||{})[x.mins];
    const ready=!!doc;
    const id=ready?doc.identifier:'';
    const realTitle=ready?(Array.isArray(doc.title)?doc.title[0]:doc.title):'';
    const subtitle=ready?(realTitle.length>72?realTitle.slice(0,72)+'\\u2026':realTitle):x.desc;
    const onclick=ready?('playMedSlot('+x.mins+')'):'toast(\\'\\u23F3 Loading audio...\\',\\'err\\')';
    h+='<button class="med-card'+(ready?'':' loading')+'" onclick="'+onclick+'" style="--mc:'+x.color+'">';
    h+='<div class="med-card-mins"><b>'+x.mins+'</b><small>min</small></div>';
    h+='<div class="med-card-body"><div class="med-card-title">'+esc(x.title)+'</div><div class="med-card-desc">'+esc(subtitle)+'</div></div>';
    h+='<div class="med-card-play">'+(ready?'<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>':'<div class="med-load-dot"></div>')+'</div>';
    h+='</button>';
  });
  h+='</div>';
  h+='<div class="med-foot">\\u{1F50A} Use headphones, find a quiet spot, and let the guide lead you.</div>';
}

// HISTORY TAB — magazine layout with section pills
else if(S.tab==='history'){
  const hist=S.history;
  const today=new Date();
  const sec=S.historySec||'today';
  h+='<div class="section-hd"><span class="section-ic" style="background:linear-gradient(135deg,#B45309,#7C2D12)">'+ic('history',22)+'</span><div><h3>The History magazine</h3><p>Civilisations \\u2022 science \\u2022 art \\u2022 empires</p></div></div>';
  // Section pills
  h+='<div class="mag-pills">';
  HISTORY_SECTIONS.forEach(s=>{h+='<button class="mag-pill'+(sec===s.k?' on':'')+'" onclick="loadHistorySec(\\''+s.k+'\\')"><span class="mag-pill-e">'+s.e+'</span>'+esc(s.l)+'</button>'});
  h+='</div>';
  if(hist.loading&&!hist.loaded[sec]){h+='<div class="loading">\\u{1F4DC} Pulling stories from history\\u2026</div>';}
  else if(sec==='today'){
    const dayStr=today.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    h+='<div class="mag-section-ttl"><span>'+esc(dayStr)+' \\u2014 events on this day</span></div>';
    if(!hist.events.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DC}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No events loaded</div></div>';}
    else{
      h+='<div class="hist-feed">';
      hist.events.slice(0,20).forEach(ev=>{
        const yearsAgo=today.getFullYear()-Number(ev.year);
        h+='<article class="hist-item">';
        h+='<div class="hist-year"><b>'+esc(String(ev.year))+'</b><small>'+(yearsAgo>0?yearsAgo+' yrs ago':'this year')+'</small></div>';
        h+='<div class="hist-body">';
        if(ev.thumb)h+='<img class="hist-thumb" src="'+esc(ev.thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
        h+='<div class="hist-text"><div class="hist-event">'+esc(ev.text||'')+'</div>';
        if(ev.title)h+='<div class="hist-link">'+(ev.url?'<a href="'+esc(ev.url)+'" target="_blank" rel="noopener">'+esc(ev.title)+' \\u2197</a>':esc(ev.title))+'</div>';
        h+='</div></div></article>';
      });
      h+='</div>';
    }
  }
  else{
    const arts=(hist.articles&&hist.articles[sec])||[];
    const secObj=HISTORY_SECTIONS.find(x=>x.k===sec)||{l:''};
    h+='<div class="mag-section-ttl"><span>'+esc(secObj.l)+' \\u2014 read with intention</span></div>';
    if(!arts.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DA}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No articles yet</div></div>';}
    else{
      h+='<div class="mag-grid">';
      arts.forEach((a,i)=>{
        h+='<article class="mag-card" style="animation-delay:'+(i*0.05)+'s">';
        if(a.thumb)h+='<div class="mag-card-img"><img src="'+esc(a.thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add(\\'mag-card-img-empty\\');this.remove()"></div>';
        else h+='<div class="mag-card-img mag-card-img-empty">\\u{1F4DC}</div>';
        h+='<div class="mag-card-body"><div class="mag-card-kicker">'+esc(secObj.l)+'</div>';
        h+='<h3 class="mag-card-h">'+esc(a.title)+'</h3>';
        if(a.description)h+='<div class="mag-card-d">'+esc(a.description)+'</div>';
        if(a.extract)h+='<p class="mag-card-x">'+esc(a.extract.slice(0,300))+(a.extract.length>300?'\\u2026':'')+'</p>';
        h+='<a class="mag-card-cta" href="'+esc(a.url)+'" target="_blank" rel="noopener">Read full article \\u2197</a>';
        h+='</div></article>';
      });
      h+='</div>';
    }
  }
}

// GEOGRAPHY TAB — magazine layout: Earth, oceans, universe
else if(S.tab==='geography'){
  const geo=S.geography;
  const sec=S.geoSec||'earth';
  h+='<div class="section-hd"><span class="section-ic" style="background:linear-gradient(135deg,#0891B2,#0F172A)">'+ic('geography',22)+'</span><div><h3>The Geography magazine</h3><p>Earth \\u2022 oceans \\u2022 mountains \\u2022 the cosmos</p></div></div>';
  h+='<div class="mag-pills">';
  GEOGRAPHY_SECTIONS.forEach(s=>{h+='<button class="mag-pill'+(sec===s.k?' on':'')+'" onclick="loadGeoSec(\\''+s.k+'\\')"><span class="mag-pill-e">'+s.e+'</span>'+esc(s.l)+'</button>'});
  h+='</div>';
  const arts=(geo.articles&&geo.articles[sec])||[];
  const secObj=GEOGRAPHY_SECTIONS.find(x=>x.k===sec)||{l:''};
  h+='<div class="mag-section-ttl"><span>'+esc(secObj.l)+' \\u2014 a closer look</span></div>';
  if(geo.loading&&!geo.loaded[sec]){h+='<div class="loading">\\u{1F30D} Loading articles\\u2026</div>';}
  else if(!arts.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DA}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No articles yet</div></div>';}
  else{
    h+='<div class="mag-grid">';
    arts.forEach((a,i)=>{
      h+='<article class="mag-card" style="animation-delay:'+(i*0.05)+'s">';
      if(a.thumb)h+='<div class="mag-card-img"><img src="'+esc(a.thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add(\\'mag-card-img-empty\\');this.remove()"></div>';
      else h+='<div class="mag-card-img mag-card-img-empty">\\u{1F30D}</div>';
      h+='<div class="mag-card-body"><div class="mag-card-kicker">'+esc(secObj.l)+'</div>';
      h+='<h3 class="mag-card-h">'+esc(a.title)+'</h3>';
      if(a.description)h+='<div class="mag-card-d">'+esc(a.description)+'</div>';
      if(a.extract)h+='<p class="mag-card-x">'+esc(a.extract.slice(0,300))+(a.extract.length>300?'\\u2026':'')+'</p>';
      h+='<a class="mag-card-cta" href="'+esc(a.url)+'" target="_blank" rel="noopener">Read full article \\u2197</a>';
      h+='</div></article>';
    });
    h+='</div>';
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
  h+='<div class="ov" onclick="closeWAOnboard()"><div class="mdl" onclick="event.stopPropagation()" style="max-width:440px">';
  h+='<div style="text-align:center;margin-bottom:18px"><div style="width:78px;height:78px;border-radius:50%;background:linear-gradient(135deg,#25D366,#128C7E);display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;box-shadow:0 12px 30px rgba(37,211,102,.35)"><svg width="42" height="42" viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></div><h2 style="margin:0;font-size:22px">Get reminders on WhatsApp</h2><div style="font-size:14px;color:#64748B;margin-top:6px;line-height:1.5">Send and receive tasks the easy way \\u2014 without leaving your favorite chat app.</div></div>';
  if(!S.waConnected){
    h+='<ul style="list-style:none;padding:0;margin:0 0 18px;display:flex;flex-direction:column;gap:10px;font-size:13.5px;color:#334155">';
    h+='<li style="display:flex;align-items:center;gap:10px"><span style="width:28px;height:28px;border-radius:50%;background:#EDFCF2;color:#1A9E47;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:800">\\u23F0</span><span><b>Smart reminders</b> the moment your task is due</span></li>';
    h+='<li style="display:flex;align-items:center;gap:10px"><span style="width:28px;height:28px;border-radius:50%;background:#F0F9FF;color:#0284C7;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:800">\\u270D\\uFE0F</span><span><b>Add tasks by texting Brodoit</b> \\u2014 no app needed</span></li>';
    h+='<li style="display:flex;align-items:center;gap:10px"><span style="width:28px;height:28px;border-radius:50%;background:#FEF3C7;color:#B45309;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:800">\\u{1F510}</span><span><b>One-time setup</b>, takes 10 seconds</span></li>';
    h+='</ul>';
    h+='<div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:14px"><div style="font-size:12px;font-weight:700;color:#94A3B8;letter-spacing:.5px;margin-bottom:8px">HOW IT WORKS</div><div style="font-size:13.5px;color:#334155;line-height:1.6">Save BroDoit to your contacts, then say hi on WhatsApp. We\\'ll connect your number instantly. Your phone stays private.</div></div>';
    h+='<button class="mb" style="width:100%;background:#FFFFFF;border:1.5px solid #25D366;color:#0F172A;font-size:14px;padding:12px;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px;font-weight:700;cursor:pointer;border-radius:12px" onclick="saveBroDoitContact()">\\u{1F4C7} Save BroDoit to contacts</button>';
    h+='<button class="mb mb-s" style="width:100%;background:linear-gradient(135deg,#25D366,#128C7E);border:none;color:#fff;font-size:15px;padding:14px;display:flex;align-items:center;justify-content:center;gap:10px;box-shadow:0 8px 22px rgba(37,211,102,.32)" onclick="openWAJoin()">'+WI+' Open WhatsApp &amp; tap Send</button>';
    h+='<div class="macts" style="margin-top:12px"><button class="mb mb-c" onclick="closeWAOnboard()">Maybe later</button><button class="mb mb-s" style="background:#0F172A" onclick="confirmWAJoined()">I\\'ve sent it \\u2014 connect me</button></div>';
  }else{
    h+='<div style="background:#EDFCF2;border:1px solid #B7E8C4;border-radius:12px;padding:14px;font-size:13.5px;color:#1A9E47;margin-bottom:16px;display:flex;align-items:center;gap:10px"><span style="font-size:22px">\\u2705</span><span><b>You\\'re connected.</b> Reminders and quick task creation are now active.</span></div>';
    h+='<div class="macts"><button class="mb mb-d" onclick="disconnectWA()">Disconnect</button><button class="mb mb-s" onclick="closeWAOnboard()">Done</button></div>';
  }
  h+='</div></div>';
}

if(S.showGcalAdd){
  const f=S.gcalForm;
  h+='<div class="ov" onclick="closeGcalAdd()"><div class="mdl" onclick="event.stopPropagation()" style="max-width:440px">';
  h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><svg width="32" height="32" viewBox="0 0 48 48"><path fill="#fbbc04" d="M37 6h-3V4a2 2 0 1 0-4 0v2H18V4a2 2 0 1 0-4 0v2h-3a5 5 0 0 0-5 5v26a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V11a5 5 0 0 0-5-5z"/><path fill="#fff" d="M11 18h26v18H11z"/><path fill="#1a73e8" d="M16 22h6v6h-6zm10 0h6v6h-6zm-10 8h6v6h-6zm10 0h6v6h-6z"/></svg><h2 style="margin:0">New Google Calendar event</h2></div>';
  if(S.google.accounts.length>1){h+='<label class="lbl">Add to</label><select onchange="S.gcalForm.email=this.value">';S.google.accounts.forEach(a=>{h+='<option value="'+esc(a.email)+'"'+(a.email===f.email?' selected':'')+'>'+esc(a.email)+'</option>'});h+='</select>'}
  else h+='<div style="font-size:12px;color:#94A3B8;margin-bottom:10px">Adding to <b>'+esc(f.email)+'</b></div>';
  h+='<label class="lbl">Title</label><input value="'+esc(f.title)+'" placeholder="What\\'s happening?" oninput="S.gcalForm.title=this.value">';
  h+='<div class="row"><div><label class="lbl">Date</label><input type="date" value="'+esc(f.date)+'" onchange="S.gcalForm.date=this.value"></div>';
  h+='<div><label class="lbl">Time (optional)</label><input type="time" value="'+esc(f.time)+'" onchange="S.gcalForm.time=this.value"></div></div>';
  if(f.time)h+='<label class="lbl">Duration (minutes)</label><input type="number" value="'+(f.duration||30)+'" min="5" max="600" step="5" onchange="S.gcalForm.duration=parseInt(this.value)||30">';
  h+='<label class="lbl">Notes</label><textarea oninput="S.gcalForm.notes=this.value" placeholder="Optional details">'+esc(f.notes||'')+'</textarea>';
  h+='<div class="macts"><button class="mb mb-c" onclick="closeGcalAdd()">Cancel</button><button class="mb mb-s" style="background:linear-gradient(135deg,#4285F4,#34A853);border:none" onclick="saveGcalEvent()">Add to Calendar</button></div>';
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
if(S.user){refreshSession();load();loadBookStreak();loadGoogleStatus();chk();setInterval(load,10000)}else render();
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
