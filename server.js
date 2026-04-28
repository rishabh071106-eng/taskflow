require('dotenv').config();
const express=require('express'),cors=require('cors'),Database=require('better-sqlite3'),twilio=require('twilio'),path=require('path'),crypto=require('crypto');
const app=express();app.use(cors());app.use(express.json());app.use(express.urlencoded({extended:true}));

// DB path — explicit DB_PATH env var wins. Otherwise, if /data exists (Railway Volume convention),
// use /data/taskflow.db so the SQLite file SURVIVES redeploys. Last resort: __dirname (NOT durable
// across deploys — every Railway redeploy spins a fresh container and that file is wiped). Set up
// a Railway Volume at /data and restart to make this auto-pick the durable path.
const _resolveDbPath=()=>{
  if(process.env.DB_PATH)return process.env.DB_PATH;
  try{if(require('fs').existsSync('/data')&&require('fs').statSync('/data').isDirectory())return '/data/taskflow.db'}catch(e){}
  return path.join(__dirname,'taskflow.db');
};
const DB_PATH=_resolveDbPath();
try{require('fs').mkdirSync(path.dirname(DB_PATH),{recursive:true})}catch(e){}
const _isDurable=DB_PATH.startsWith('/data')||(process.env.DB_PATH&&!DB_PATH.includes(__dirname));
console.log('[db] using',DB_PATH,_isDurable?'\\u2705 (durable across deploys)':'\\u26A0\\uFE0F  (EPHEMERAL — set DB_PATH or mount /data on Railway to keep tasks across redeploys)');
const db=new Database(DB_PATH);db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY,name TEXT DEFAULT'',token TEXT,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_phone TEXT NOT NULL,title TEXT NOT NULL,notes TEXT DEFAULT'',priority TEXT DEFAULT'medium',status TEXT DEFAULT'pending',due_date TEXT DEFAULT'',reminder_time TEXT DEFAULT'',reminded INTEGER DEFAULT 0,source TEXT DEFAULT'app',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT,expires_at TEXT);`);
// email column + unique index (idempotent)
try{db.exec("ALTER TABLE users ADD COLUMN email TEXT")}catch(e){}
// task board column (Home / Office) — existing rows default to 'home'
try{db.exec("ALTER TABLE tasks ADD COLUMN board TEXT DEFAULT 'home'")}catch(e){}
try{db.exec("UPDATE tasks SET board='home' WHERE board IS NULL OR board=''")}catch(e){}
// WhatsApp number linked to a (typically email-login) user account
try{db.exec("ALTER TABLE users ADD COLUMN wa_phone TEXT")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wa_phone ON users(wa_phone) WHERE wa_phone IS NOT NULL AND wa_phone!=''")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email!=''")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS steps(id INTEGER PRIMARY KEY AUTOINCREMENT,user_phone TEXT NOT NULL,date TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,source TEXT DEFAULT'manual',updated_at TEXT DEFAULT(datetime('now')))")}catch(e){}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_user_date ON steps(user_phone,date)")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS book_listens(user_phone TEXT NOT NULL,date TEXT NOT NULL,seconds INTEGER DEFAULT 120,PRIMARY KEY(user_phone,date))")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS google_tokens(user_phone TEXT NOT NULL,email TEXT NOT NULL,access_token TEXT NOT NULL,refresh_token TEXT,expires_at INTEGER NOT NULL,scope TEXT,is_default INTEGER DEFAULT 1,created_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_phone,email))")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,user_phone TEXT NOT NULL,created_at INTEGER NOT NULL)")}catch(e){}
// Mind Gym progress — one row per (user, game). xp climbs, level derived from xp/100. best is game-specific (lowest ms for reaction, highest sequence for memory, etc.)
try{db.exec("CREATE TABLE IF NOT EXISTS user_progress(user_phone TEXT NOT NULL,game TEXT NOT NULL,level INTEGER DEFAULT 1,xp INTEGER DEFAULT 0,best INTEGER DEFAULT 0,plays INTEGER DEFAULT 0,updated_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_phone,game))")}catch(e){}
// Voice Trainer — per-user lesson completions for the 90-day accent + functional-English course
try{db.exec("CREATE TABLE IF NOT EXISTS voice_progress(user_phone TEXT NOT NULL,day INTEGER NOT NULL,score INTEGER DEFAULT 0,points INTEGER DEFAULT 0,completed_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_phone,day))")}catch(e){}
// Daily-play log so we can compute streaks for both Mind Gym and Voice Trainer
try{db.exec("CREATE TABLE IF NOT EXISTS play_log(user_phone TEXT NOT NULL,kind TEXT NOT NULL,played_on TEXT NOT NULL,PRIMARY KEY(user_phone,kind,played_on))")}catch(e){}
// Voice curriculum — Duolingo-style step-by-step lesson progress per user
try{db.exec("CREATE TABLE IF NOT EXISTS voice_lesson_progress(user_phone TEXT NOT NULL,unit_id INTEGER NOT NULL,lesson_id INTEGER NOT NULL,score INTEGER DEFAULT 0,stars INTEGER DEFAULT 0,xp INTEGER DEFAULT 0,completed_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(user_phone,unit_id,lesson_id))")}catch(e){}
// Community articles — Medium-style user submissions
try{db.exec("CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY,author_phone TEXT NOT NULL,author_name TEXT DEFAULT'',title TEXT NOT NULL,body TEXT NOT NULL,image_url TEXT DEFAULT'',category TEXT DEFAULT'general',likes INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')))")}catch(e){}
try{db.exec("CREATE TABLE IF NOT EXISTS article_likes(article_id TEXT NOT NULL,user_phone TEXT NOT NULL,liked_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(article_id,user_phone))")}catch(e){}
try{db.exec("CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC)")}catch(e){}

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
  if(r.ok){
    // Cookie survives iOS Safari tab kills better than localStorage. Read on / to force the OTP screen
    // even if the user's localStorage was wiped while they were in Gmail. 10-min expiry.
    // 30-min TTL (was 10) — gives generous slack for slow email delivery / multi-step iOS app switches.
    // Secure flag because brodoit.com is HTTPS-only — without it, some browsers reject the cookie on reload.
    res.set('Set-Cookie','pending_otp_email='+encodeURIComponent(email)+'; Path=/; Max-Age=1800; SameSite=Lax; Secure');
    return res.json({ok:true,message:'Check your email (and spam folder)'});
  }
  res.status(500).json({ok:false,error:'Failed to send email',detail:r.reason});
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
  res.set('Set-Cookie','pending_otp_email=; Path=/; Max-Age=0; SameSite=Lax; Secure');
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

// ═══ AI COACH — proxy endpoints for Claude, Whisper, ElevenLabs ═══
// API keys stay on the server. The browser never sees them.
const ANTHROPIC_KEY=process.env.ANTHROPIC_API_KEY||'';
const OPENAI_KEY=process.env.OPENAI_API_KEY||'';
const ELEVENLABS_KEY=process.env.ELEVENLABS_API_KEY||'';
// George — warm, calm British male narrator. Widely regarded as the closest ElevenLabs voice
// to Headspace-style soothing narration. Override via ELEVENLABS_VOICE env var.
// Other strong narration choices: Brian (nPczCjzI2devNBz1zQrb), Daniel (onwK4e9ZLuTAKqWW03F9),
// Bill (pqHfZKP75CvOlQylNhV4 — older, calming).
const ELEVENLABS_VOICE=process.env.ELEVENLABS_VOICE||'JBFqnCBsd6RMkjVDRZzb';  // George (warm British male)
console.log('[ai] anthropic',ANTHROPIC_KEY?'\\u2705':'\\u274C','openai',OPENAI_KEY?'\\u2705':'\\u274C','elevenlabs',ELEVENLABS_KEY?'\\u2705':'\\u274C');

const COACH_SYSTEM=`You are an expert Business English coach speaking with a fluent professional who wants to sound MORE polished and use more sophisticated vocabulary in business contexts.

When they say something, structure your reply in this exact short format:

1. Brief acknowledgment of what they said (one sentence)
2. A more polished/business-appropriate rewrite of their last sentence
3. ONE vocabulary or idiom tip relevant to it (a sophisticated word/phrase + meaning + how to use it)
4. A follow-up question that pushes the conversation forward

Keep total response under 90 words. Use sophisticated vocabulary yourself naturally — words like "leverage", "nuance", "cadence", "granular", "alignment", "downstream", "actionable", "stakeholder", "throughput", "paradigm", "by and large", "in lieu of", "tantamount to", "circle back", "drill down".

Be warm but direct. Never explain that you are an AI.`;

app.post('/api/coach/chat',auth,async(req,res)=>{
  if(!ANTHROPIC_KEY)return res.status(503).json({error:'AI coach not configured (ANTHROPIC_API_KEY missing).'});
  const messages=Array.isArray(req.body&&req.body.messages)?req.body.messages.slice(-20):null;
  if(!messages||!messages.length)return res.status(400).json({error:'messages required'});
  const sys=req.body.system||COACH_SYSTEM;
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-5',max_tokens:600,system:sys,messages:messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,4000)}))})
    });
    const j=await r.json();
    if(!r.ok)return res.status(502).json({error:(j.error&&j.error.message)||'Claude error',detail:j});
    const reply=(j.content&&j.content[0]&&j.content[0].text)||'';
    res.json({reply,usage:j.usage});
  }catch(e){res.status(500).json({error:String(e.message||e)})}
});

app.post('/api/coach/transcribe',auth,express.raw({type:'audio/*',limit:'10mb'}),async(req,res)=>{
  if(!OPENAI_KEY)return res.status(503).json({error:'Transcription not configured (OPENAI_API_KEY missing).'});
  const buf=req.body;if(!buf||!buf.length)return res.status(400).json({error:'audio required'});
  const ct=req.get('content-type')||'audio/webm';
  const ext=ct.includes('mp4')?'mp4':ct.includes('mpeg')?'mp3':ct.includes('wav')?'wav':'webm';
  try{
    const fd=new FormData();
    fd.append('file',new Blob([buf],{type:ct}),'audio.'+ext);
    fd.append('model','whisper-1');
    fd.append('response_format','json');
    fd.append('language','en');
    const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'POST',
      headers:{'Authorization':'Bearer '+OPENAI_KEY},
      body:fd
    });
    const j=await r.json();
    if(!r.ok)return res.status(502).json({error:(j.error&&j.error.message)||'Whisper error'});
    res.json({text:j.text||''});
  }catch(e){res.status(500).json({error:String(e.message||e)})}
});

app.post('/api/coach/speak',auth,async(req,res)=>{
  if(!ELEVENLABS_KEY)return res.status(503).json({error:'TTS not configured',fallback:'browser-tts'});
  const text=String((req.body&&req.body.text)||'').slice(0,2000);
  if(!text)return res.status(400).json({error:'text required'});
  const voice=String((req.body&&req.body.voice)||ELEVENLABS_VOICE).replace(/[^a-zA-Z0-9]/g,'');
  try{
    const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+voice,{
      method:'POST',
      headers:{'Content-Type':'application/json','xi-api-key':ELEVENLABS_KEY,'Accept':'audio/mpeg'},
      // turbo_v2_5 = ~3-5x lower latency than multilingual_v2 with very close audio quality.
      // For book narration we want fast first-byte over the marginal quality bump.
      // stability 0.7 keeps the narrator measured. style 0.05 = barely any stylization (calm).
      // similarity_boost 0.85 stays loyal to George's natural British timbre.
      body:JSON.stringify({text,model_id:'eleven_turbo_v2_5',voice_settings:{stability:0.7,similarity_boost:0.85,style:0.05,use_speaker_boost:true}})
    });
    if(!r.ok){const t=await r.text();return res.status(502).json({error:t.slice(0,200)})}
    const audio=Buffer.from(await r.arrayBuffer());
    res.set('Content-Type','audio/mpeg').set('Cache-Control','no-store').send(audio);
  }catch(e){res.status(500).json({error:String(e.message||e)})}
});

// AI status — client-only check, no key exposure
app.get('/api/coach/status',(req,res)=>{
  res.json({chat:!!ANTHROPIC_KEY,transcribe:!!OPENAI_KEY,tts:!!ELEVENLABS_KEY});
});

// ═══ VOICE TRAINER — 90-day "zero to hero" English accent + functional-English course ═══
// Curriculum is a 30-theme cycle, repeated 3 times across 3 phases (Foundation / Conversation / Mastery).
// Each user's progress (completed days + points) is server-tracked so they pick up where they left off.
const VOICE_THEMES=[
  {t:"Welcome to your voice journey",intro:"Hello! I am your AI accent coach. Over 90 days we will go from beginner to confident speaker. Let's start. Repeat each phrase clearly and naturally. Don't worry about speed — focus on clarity.",drills:["Hello, my name is...","Nice to meet you","How are you today?"],tip:"Speak slowly. Clarity beats speed every time."},
  {t:"Greetings & introductions",intro:"Greetings open every conversation. Let's master the most useful ones. Speak with a smile in your voice.",drills:["Good morning, everyone","I'd like to introduce myself","It's a pleasure to meet you","Where are you from?"],tip:"Lift your tone slightly at the end of questions."},
  {t:"Short vowel sound /æ/",intro:"Today we work on the short A sound, as in 'cat' and 'apple'. This sound does not exist in many languages, so we drill it carefully.",drills:["The cat sat on the mat","Pack a bag of apples","That man has a happy plan"],tip:"Keep the jaw relaxed and slightly open."},
  {t:"Long vowel sound /iː/",intro:"The long E sound, as in 'see' and 'tree'. Stretch the sound a fraction longer than feels natural.",drills:["Please see me","Each green leaf","She agrees to read three pieces"],tip:"Smile slightly while you say it — it lengthens the vowel naturally."},
  {t:"Polite small talk",intro:"Small talk is the bridge to real conversation. Today's phrases work in every social setting.",drills:["How was your weekend?","The weather's lovely today","Have you been here before?","I hope you're doing well"],tip:"Pause a beat after each phrase — let it breathe."},
  {t:"Word stress: nouns vs verbs",intro:"Same spelling, different meaning, different stress. 'Record' the noun versus 'record' the verb. Listen carefully and copy.",drills:["I bought a new RECord","Please reCORD this meeting","That's a perfect PREsent","I'd like to preSENT my idea"],tip:"Nouns: stress the first syllable. Verbs: stress the second."},
  {t:"The sound /θ/ — 'think'",intro:"The English TH is unique. Place your tongue lightly between your teeth and blow.",drills:["I think therefore I am","Three thoughtful thinkers","Thursday's the third"],tip:"You should feel air on your tongue. If not, try again."},
  {t:"The sound /ð/ — 'this'",intro:"The voiced TH, as in 'this' and 'that'. Same tongue position as before but vibrate your vocal cords.",drills:["This is the way","That's their brother","The leather feather"],tip:"Place your hand on your throat — you should feel a buzz."},
  {t:"Asking polite questions",intro:"Politeness is built into English questions. Today's patterns make any request sound respectful.",drills:["Could you help me, please?","Would you mind repeating that?","May I ask a quick question?","Do you have a moment?"],tip:"Soften your voice on 'please' and 'mind'."},
  {t:"Saying numbers naturally",intro:"Numbers in conversation flow differently from when you read them on paper. Let's practise the natural rhythm.",drills:["Twenty-two thirty","Three hundred and forty-five","One thousand two hundred","The year nineteen ninety-nine"],tip:"Group digits in pairs or triples — never digit by digit."},
  {t:"Connected speech: linking",intro:"Native speakers link words together. 'Pick it up' becomes 'pi-ki-tup'. Today we practise the smooth glue.",drills:["Pick it up","Turn it on","An apple a day","Best of all"],tip:"Don't pause between words ending and starting with vowels."},
  {t:"Intonation: rising vs falling",intro:"Your pitch tells the listener whether you're asking or telling. Today we drill both shapes.",drills:["You're coming. (statement)","You're coming? (question)","She left already. (statement)","She left already? (question)"],tip:"Falling = certainty. Rising = uncertainty or invitation."},
  {t:"At work: meetings",intro:"Office meetings demand a specific register. These phrases sound natural in any boardroom.",drills:["Could we get back to that point?","I'd like to add something","Just to clarify","Let's move on to the next item"],tip:"Drop your tone slightly — sound calm, in control."},
  {t:"At work: emails out loud",intro:"Speaking emails out loud trains your written register. Today we read three short ones.",drills:["Thanks for getting back to me","I'm following up on yesterday's email","Please find the attached document","Looking forward to your reply"],tip:"Read at conversation pace, not slower."},
  {t:"Restaurants & ordering",intro:"Confidence at the table starts with these phrases. Order without hesitation.",drills:["Could I see the menu, please?","I'll have the chicken, medium-rare","Can we get the bill?","Is service included?"],tip:"Keep it crisp. Waiters appreciate clarity."},
  {t:"Travel: airports & hotels",intro:"Travel English is mostly about precision. Numbers, names, times. We drill the survival kit.",drills:["I have a reservation under...","Could I check in, please?","What time is breakfast?","Where's the boarding gate?"],tip:"Speak slightly louder than normal — airports are noisy."},
  {t:"Difficult consonant clusters",intro:"English loves stacking consonants. 'Strengths', 'twelfths', 'sixths'. Slow them down to learn them.",drills:["The strengths of his argument","Twelfths and sixths","Asked, helped, walked","Texts and exams"],tip:"Whisper the consonants first; voice them after."},
  {t:"Schwa /ə/ — the secret sound",intro:"Half of English vowels reduce to schwa, a lazy 'uh' sound. It's the most common vowel and the hardest to hear.",drills:["A banana for the teacher","About a moment ago","The capital of America","Computer support"],tip:"Unstressed syllables = schwa. Almost always."},
  {t:"Phrasal verbs in daily life",intro:"Phrasal verbs are everywhere. Replace fancy words with them and you sound instantly natural.",drills:["Let's catch up tomorrow","I'll figure it out","Things are picking up","Don't put it off"],tip:"Stress the second word: catch UP, figure OUT."},
  {t:"Storytelling rhythm",intro:"A good story has rhythm — pauses, peaks, releases. Today we practise the wave.",drills:["So... yesterday I was walking home","And then — out of nowhere — it started to rain","I had no umbrella, of course","But here's the funny part..."],tip:"Pauses are punctuation. Use them."},
  {t:"Apologising gracefully",intro:"Knowing how to apologise in English builds trust. There's a hierarchy — from light to formal.",drills:["My bad","Sorry about that","I do apologise","Please accept my sincere apologies"],tip:"Match the apology to the situation."},
  {t:"Disagreeing politely",intro:"You don't have to say 'no'. English has elegant ways to push back without offending.",drills:["I see your point, but...","I'm not sure I agree","That's an interesting view, however","With respect, I think..."],tip:"Always start with acknowledgement before disagreement."},
  {t:"Expressing preferences",intro:"Going beyond 'I like'. These structures sound mature and confident.",drills:["I'd rather walk than drive","I'm more of a tea person","I tend to prefer mornings","If I had to choose..."],tip:"'I'd' is everywhere — practise the contraction."},
  {t:"Casual conversation fillers",intro:"Native speakers use fillers — 'you know', 'I mean', 'kind of'. Used right, they buy thinking time.",drills:["You know what I mean?","It's kind of difficult","I mean, basically","Like, totally"],tip:"Don't overuse — one or two per sentence is enough."},
  {t:"Interview English",intro:"Job interviews demand specific patterns. These open and close strong answers.",drills:["My biggest strength is...","A challenge I'd love to take on","I'm passionate about...","Where do I see myself in five years?"],tip:"Speak with calm energy. Never rush."},
  {t:"Numbers in finance & data",intro:"Talking about money, percentages, and trends. Daily corporate English.",drills:["Revenue's up by twelve percent","We grew quarter on quarter","The figure stands at forty thousand","A two-fold increase"],tip:"Stress the unit, not just the number."},
  {t:"Phone calls",intro:"Phone English is a special discipline — no body language, just voice. Phrases for openings and closings.",drills:["Hello, this is... speaking","Could I speak to...?","I'll put you through","Thanks for calling, have a great day"],tip:"Smile while speaking on the phone — it carries through."},
  {t:"Negotiation phrases",intro:"Today we drill the subtle art of give-and-take.",drills:["Would you consider...?","If we could agree on...","I'm afraid that won't work for us","Let's find a middle ground"],tip:"Soft openers, firm core, calm close."},
  {t:"Idioms that travel well",intro:"Idioms make your English vivid. These are universally understood and natural.",drills:["A piece of cake","Hit the nail on the head","Once in a blue moon","Break the ice"],tip:"Use them sparingly — one per conversation, max."},
  {t:"Public speaking",intro:"Today we work on the speaker's voice — slower pace, fuller tone, deliberate pauses.",drills:["Good evening, everyone","It's an honour to be here","Allow me to begin by saying","Thank you for your time"],tip:"Drop your pitch one note. Authority lives in the lower register."}
];
const VOICE_PHASES=['Foundation','Conversation','Mastery'];
function _voiceLessonForDay(d){
  const idx=(d-1)%30;const phase=Math.floor((d-1)/30);  // 0..2
  const base=VOICE_THEMES[idx];
  const phaseLabel=VOICE_PHASES[phase]||'Mastery';
  // Mastery phase adds a "challenge" sentence; Conversation phase adds a roleplay prompt
  const drills=base.drills.slice();
  if(phase>=1)drills.push('Use this in your own sentence');
  if(phase>=2)drills.push('Now say it twice — once slow, once at full pace');
  return {day:d,phase:phaseLabel,phaseNum:phase+1,title:base.t,intro:base.intro,drills,tip:base.tip,points:10+phase*5};
}
app.get('/api/voice/curriculum',(req,res)=>{
  const days=Array.from({length:90},(_,i)=>{const l=_voiceLessonForDay(i+1);return {day:l.day,phase:l.phase,phaseNum:l.phaseNum,title:l.title,points:l.points}});
  res.json({days,phases:VOICE_PHASES});
});
app.get('/api/voice/lesson/:day',(req,res)=>{
  const d=parseInt(req.params.day,10);if(!d||d<1||d>90)return res.status(400).json({error:'Invalid day'});
  res.json(_voiceLessonForDay(d));
});
app.get('/api/voice/progress',auth,(req,res)=>{
  const rows=db.prepare('SELECT day,score,points,completed_at FROM voice_progress WHERE user_phone=? ORDER BY day').all(req.user.phone);
  const totalPoints=rows.reduce((s,r)=>s+(r.points||0),0);
  const completed=rows.length;
  const pct=Math.round((completed/90)*100);
  // Level: 1 per phase (3 phases of 30 days each)
  const level=completed<30?1:completed<60?2:completed<90?3:4;
  res.json({completed,totalPoints,pct,level,maxLevel:4,rows});
});
app.post('/api/voice/complete',auth,(req,res)=>{
  const day=parseInt(req.body&&req.body.day,10);
  const score=Math.max(0,Math.min(100,parseInt(req.body&&req.body.score,10)||0));
  if(!day||day<1||day>90)return res.status(400).json({error:'Invalid day'});
  const lesson=_voiceLessonForDay(day);
  const points=Math.round(lesson.points*(score/100));
  db.prepare("INSERT INTO voice_progress(user_phone,day,score,points,completed_at)VALUES(?,?,?,?,datetime('now'))ON CONFLICT(user_phone,day)DO UPDATE SET score=MAX(score,excluded.score),points=MAX(points,excluded.points),completed_at=excluded.completed_at").run(req.user.phone,day,score,points);
  const rows=db.prepare('SELECT day,score,points FROM voice_progress WHERE user_phone=?').all(req.user.phone);
  res.json({ok:true,day,score,points,completed:rows.length,totalPoints:rows.reduce((s,r)=>s+r.points,0)});
});

// ═══ VOICE CURRICULUM — Duolingo-style step-by-step lessons ═══
app.get('/api/voice/lessons',auth,(req,res)=>{
  const rows=db.prepare('SELECT unit_id,lesson_id,score,stars,xp,completed_at FROM voice_lesson_progress WHERE user_phone=?').all(req.user.phone);
  const map={};rows.forEach(r=>{map[r.unit_id+':'+r.lesson_id]={score:r.score,stars:r.stars,xp:r.xp,completed_at:r.completed_at}});
  const totalXp=rows.reduce((s,r)=>s+(r.xp||0),0);
  const totalStars=rows.reduce((s,r)=>s+(r.stars||0),0);
  res.json({progress:map,totalXp,totalStars,completed:rows.length});
});
// ═══ COMMUNITY ARTICLES — Medium-style user contributions ═══
app.get('/api/articles',(req,res)=>{
  const cat=String(req.query.cat||'').slice(0,40);
  const sort=req.query.sort==='top'?'likes DESC,created_at DESC':'created_at DESC';
  const where=cat&&cat!=='all'?'WHERE category=?':'';
  const params=cat&&cat!=='all'?[cat]:[];
  const rows=db.prepare('SELECT id,author_name,title,SUBSTR(body,1,400) as preview,LENGTH(body) as full_len,image_url,category,likes,created_at FROM articles '+where+' ORDER BY '+sort+' LIMIT 50').all(...params);
  res.json({items:rows.map(r=>Object.assign({},r,{preview:r.preview+(r.full_len>400?'...':''),read_min:Math.max(1,Math.round(r.full_len/1200))}))});
});
app.get('/api/articles/:id',(req,res)=>{
  const a=db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id);
  if(!a)return res.status(404).json({error:'Not found'});
  res.json(Object.assign({},a,{read_min:Math.max(1,Math.round((a.body||'').length/1200))}));
});
app.post('/api/articles',auth,(req,res)=>{
  const{title,body,image_url,category}=req.body||{};
  if(!title||!String(title).trim())return res.status(400).json({error:'Title required'});
  if(!body||String(body).trim().length<50)return res.status(400).json({error:'Article must be at least 50 characters'});
  const id='art_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const cleanImage=String(image_url||'').slice(0,400);
  // Validate image URL is http(s)
  const safeImg=/^https?:\/\//i.test(cleanImage)?cleanImage:'';
  db.prepare("INSERT INTO articles(id,author_phone,author_name,title,body,image_url,category)VALUES(?,?,?,?,?,?,?)").run(id,req.user.phone,String(req.user.name||'Anonymous').slice(0,60),String(title).slice(0,180),String(body).slice(0,20000),safeImg,String(category||'general').slice(0,40));
  res.json({ok:true,id});
});
app.post('/api/articles/:id/like',auth,(req,res)=>{
  const a=db.prepare('SELECT id FROM articles WHERE id=?').get(req.params.id);
  if(!a)return res.status(404).json({error:'Not found'});
  const ex=db.prepare('SELECT 1 FROM article_likes WHERE article_id=? AND user_phone=?').get(req.params.id,req.user.phone);
  if(ex){
    db.prepare('DELETE FROM article_likes WHERE article_id=? AND user_phone=?').run(req.params.id,req.user.phone);
    db.prepare('UPDATE articles SET likes=MAX(0,likes-1) WHERE id=?').run(req.params.id);
    const a2=db.prepare('SELECT likes FROM articles WHERE id=?').get(req.params.id);
    return res.json({ok:true,liked:false,likes:a2.likes});
  }
  db.prepare('INSERT INTO article_likes(article_id,user_phone)VALUES(?,?)').run(req.params.id,req.user.phone);
  db.prepare('UPDATE articles SET likes=likes+1 WHERE id=?').run(req.params.id);
  const a2=db.prepare('SELECT likes FROM articles WHERE id=?').get(req.params.id);
  res.json({ok:true,liked:true,likes:a2.likes});
});
app.delete('/api/articles/:id',auth,(req,res)=>{
  const a=db.prepare('SELECT author_phone FROM articles WHERE id=?').get(req.params.id);
  if(!a)return res.status(404).json({error:'Not found'});
  if(a.author_phone!==req.user.phone)return res.status(403).json({error:'Not your article'});
  db.prepare('DELETE FROM article_likes WHERE article_id=?').run(req.params.id);
  db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.post('/api/voice/lesson-complete',auth,(req,res)=>{
  const unit=parseInt(req.body&&req.body.unit_id,10);
  const lesson=parseInt(req.body&&req.body.lesson_id,10);
  const score=Math.max(0,Math.min(100,parseInt(req.body&&req.body.score,10)||0));
  if(!unit||unit<1||unit>20||!lesson||lesson<1||lesson>10)return res.status(400).json({error:'Invalid unit or lesson'});
  const stars=score>=85?3:score>=65?2:score>=40?1:0;
  const xp=Math.round((score/100)*30); // up to 30 XP per lesson
  db.prepare("INSERT INTO voice_lesson_progress(user_phone,unit_id,lesson_id,score,stars,xp,completed_at)VALUES(?,?,?,?,?,?,datetime('now'))ON CONFLICT(user_phone,unit_id,lesson_id)DO UPDATE SET score=MAX(score,excluded.score),stars=MAX(stars,excluded.stars),xp=MAX(xp,excluded.xp),completed_at=excluded.completed_at").run(req.user.phone,unit,lesson,score,stars,xp);
  // Log today's play for streak
  try{db.prepare("INSERT OR IGNORE INTO play_log(user_phone,kind,played_on)VALUES(?,?,?)").run(req.user.phone,'voice',todayStr())}catch(e){}
  const rows=db.prepare('SELECT unit_id,lesson_id,score,stars,xp FROM voice_lesson_progress WHERE user_phone=?').all(req.user.phone);
  const totalXp=rows.reduce((s,r)=>s+(r.xp||0),0);
  res.json({ok:true,unit,lesson,score,stars,xp,totalXp,completed:rows.length});
});

// ═══ MIND GYM — per-user game progress (level + xp + best) ═══
// Game keys: 'math' | 'memory' | 'reaction'. 'best' meaning is per-game (highest score/round
// for math+memory; LOWEST reaction time in ms — clamped to 0..2000 — for reaction).
const MAX_LEVEL=5;
const _xpForLevel=lvl=>lvl*100;  // 100 xp = 1 level. L5 capped.
function _streakFor(userPhone,kind){
  // Count consecutive days (today backwards) the user logged a play of this kind.
  const today=todayStr();
  const rows=db.prepare("SELECT played_on FROM play_log WHERE user_phone=? AND kind=? ORDER BY played_on DESC").all(userPhone,kind);
  const set=new Set(rows.map(r=>r.played_on));
  let streak=0;let cur=new Date(today+'T00:00:00Z');
  // Allow today OR yesterday as the starting anchor so streak survives until tomorrow
  if(!set.has(today)&&!set.has(new Date(cur.getTime()-86400000).toISOString().slice(0,10)))return {current:0,longest:0,total:rows.length};
  if(!set.has(today))cur=new Date(cur.getTime()-86400000);
  while(set.has(cur.toISOString().slice(0,10))){streak++;cur=new Date(cur.getTime()-86400000)}
  // longest
  let longest=0,run=0,prev=null;
  rows.slice().reverse().forEach(r=>{const d=new Date(r.played_on+'T00:00:00Z');if(prev&&(d-prev)===86400000)run++;else run=1;if(run>longest)longest=run;prev=d});
  return {current:streak,longest,total:rows.length};
}
app.get('/api/games/progress',auth,(req,res)=>{
  const rows=db.prepare("SELECT game,level,xp,best,plays,updated_at FROM user_progress WHERE user_phone=?").all(req.user.phone);
  const map={};rows.forEach(r=>{map[r.game]=r});
  ['math','memory','reaction','word'].forEach(g=>{if(!map[g])map[g]={game:g,level:1,xp:0,best:0,plays:0,updated_at:null}});
  const streak=_streakFor(req.user.phone,'mindgym');
  res.json({progress:map,maxLevel:MAX_LEVEL,xpPerLevel:100,streak});
});
app.post('/api/games/progress',auth,(req,res)=>{
  const game=String((req.body&&req.body.game)||'').toLowerCase();
  if(!['math','memory','reaction','word'].includes(game))return res.status(400).json({error:'Unknown game'});
  const xpAdd=Math.max(0,Math.min(50,parseInt(req.body.xpAdd,10)||0));
  const newBest=req.body.best!=null?Math.max(0,Math.min(99999,parseInt(req.body.best,10)||0)):null;
  // Reaction: lower-is-better. Other games: higher-is-better.
  const lowerBest=game==='reaction';
  const cur=db.prepare('SELECT * FROM user_progress WHERE user_phone=? AND game=?').get(req.user.phone,game);
  let nextXp=(cur?cur.xp:0)+xpAdd;
  let nextLevel=Math.min(MAX_LEVEL,1+Math.floor(nextXp/100));
  if(nextLevel>=MAX_LEVEL){nextLevel=MAX_LEVEL;nextXp=Math.min(nextXp, MAX_LEVEL*100);}
  let bestVal=cur?cur.best:0;
  if(newBest!=null){
    if(!cur||cur.best===0)bestVal=newBest;
    else if(lowerBest)bestVal=Math.min(cur.best,newBest);
    else bestVal=Math.max(cur.best,newBest);
  }
  const plays=(cur?cur.plays:0)+(xpAdd>0||newBest!=null?1:0);
  db.prepare("INSERT INTO user_progress(user_phone,game,level,xp,best,plays,updated_at)VALUES(?,?,?,?,?,?,datetime('now'))ON CONFLICT(user_phone,game)DO UPDATE SET level=excluded.level,xp=excluded.xp,best=excluded.best,plays=excluded.plays,updated_at=excluded.updated_at").run(req.user.phone,game,nextLevel,nextXp,bestVal,plays);
  // Log today's play for streak
  try{db.prepare("INSERT OR IGNORE INTO play_log(user_phone,kind,played_on)VALUES(?,?,?)").run(req.user.phone,'mindgym',todayStr())}catch(e){}
  const streak=_streakFor(req.user.phone,'mindgym');
  res.json({ok:true,game,level:nextLevel,xp:nextXp,best:bestVal,plays,leveledUp:!!(cur&&nextLevel>cur.level),streak});
});

// ═══ USER EXPORT / IMPORT — last-resort safety net ═══
// Lets a user pull all their tasks as JSON ("download backup") and push the same JSON back if the
// server DB ever loses them (e.g. a Railway redeploy without a persistent volume mounted). Auth-scoped
// so users can only ever see/restore their own data.
app.get('/api/me/export',auth,(req,res)=>{
  const u=db.prepare('SELECT phone,name,email,wa_phone,created_at FROM users WHERE phone=?').get(req.user.phone)||{};
  const tasks=db.prepare('SELECT * FROM tasks WHERE user_phone=? ORDER BY created_at ASC').all(req.user.phone);
  res.set('Content-Type','application/json').set('Content-Disposition','attachment; filename="brodoit-backup-'+new Date().toISOString().slice(0,10)+'.json"');
  res.send(JSON.stringify({version:1,exportedAt:new Date().toISOString(),account:u,tasks},null,2));
});
app.post('/api/me/import',auth,(req,res)=>{
  const tasks=Array.isArray(req.body&&req.body.tasks)?req.body.tasks:null;
  if(!tasks)return res.status(400).json({ok:false,error:'Body must be {tasks:[...]}'});
  let inserted=0,skipped=0;
  const exists=new Set(db.prepare('SELECT id FROM tasks WHERE user_phone=?').all(req.user.phone).map(r=>r.id));
  const ins=db.prepare("INSERT INTO tasks(id,user_phone,title,notes,priority,status,due_date,reminder_time,source,board,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const tx=db.transaction(rows=>{for(const t of rows){if(!t||!t.title)continue;const id=t.id||genId();if(exists.has(id)){skipped++;continue}ins.run(id,req.user.phone,String(t.title).slice(0,500),t.notes||'',t.priority||'medium',t.status||'pending',t.due_date||'',t.reminder_time||'',t.source||'app',t.board||'home',t.created_at||new Date().toISOString().replace('T',' ').slice(0,19),t.updated_at||new Date().toISOString().replace('T',' ').slice(0,19));inserted++}});
  try{tx(tasks);res.json({ok:true,inserted,skipped})}catch(e){res.status(500).json({ok:false,error:String(e)})}
});

// ═══ TASKS API ═══
app.get('/api/tasks',auth,(req,res)=>{res.json(db.prepare('SELECT * FROM tasks WHERE user_phone=? ORDER BY created_at DESC').all(req.user.phone))});
app.post('/api/tasks',auth,async(req,res)=>{
  const{title,notes,priority,status,due_date,reminder_time,board}=req.body;if(!title?.trim())return res.status(400).json({error:'Title required'});
  const b=board==='office'?'office':'home';
  const id=genId();db.prepare('INSERT INTO tasks(id,user_phone,title,notes,priority,status,due_date,reminder_time,source,board)VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,req.user.phone,title.trim(),notes||'',priority||'medium',status||'pending',due_date||'',reminder_time||'','app',b);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});
app.put('/api/tasks/:id',auth,(req,res)=>{
  const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_phone=?').get(req.params.id,req.user.phone);if(!t)return res.status(404).json({error:'Not found'});
  const{title,notes,priority,status,due_date,reminder_time,board}=req.body;
  const b=(board==='office'||board==='home')?board:t.board;
  db.prepare("UPDATE tasks SET title=?,notes=?,priority=?,status=?,due_date=?,reminder_time=?,board=?,reminded=0,updated_at=datetime('now')WHERE id=?").run(title??t.title,notes??t.notes,priority??t.priority,status??t.status,due_date??t.due_date,reminder_time??t.reminder_time,b,req.params.id);
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

// WhatsApp send endpoints disabled for closed-test phase (Twilio Sandbox requires
// each recipient to text 'join <code>' first, which would break the tester experience).
app.post('/api/send-task/:id',auth,async(req,res)=>{
  const u=db.prepare('SELECT wa_phone FROM users WHERE phone=?').get(req.user.phone);
  if(!u||!u.wa_phone)return res.status(400).json({ok:false,error:'Connect your WhatsApp from your profile first.'});
  const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_phone=?').get(req.params.id,req.user.phone);
  if(!t)return res.status(404).json({ok:false,error:'Task not found'});
  const body='📝 *'+t.title+'*'+(t.notes?'\n'+t.notes:'')+(t.due_date?'\n📅 '+fmtD(t.due_date):'')+'\n\n_Reply "done '+t.title.slice(0,20)+'" to mark complete_';
  const r=await sendWA(u.wa_phone,body);
  if(r.ok)return res.json({ok:true,sid:r.sid});
  res.status(502).json({ok:false,error:waErrorMessage(r),code:r.code});
});
app.post('/api/send-all',auth,async(req,res)=>{
  const u=db.prepare('SELECT wa_phone FROM users WHERE phone=?').get(req.user.phone);
  if(!u||!u.wa_phone)return res.status(400).json({ok:false,error:'Connect your WhatsApp from your profile first.'});
  const board=(req.body&&req.body.board)==='home'?'home':(req.body&&req.body.board)==='office'?'office':null;
  const label=board==='home'?'Home Tasks':board==='office'?'Office Tasks':'All Tasks';
  const ts=board
    ? db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' AND COALESCE(board,'home')=? ORDER BY priority DESC,created_at DESC").all(req.user.phone,board)
    : db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' ORDER BY priority DESC,created_at DESC").all(req.user.phone);
  if(!ts.length)return res.json({ok:true,sent:0,empty:true,label});
  const emoji=board==='home'?'🏠':board==='office'?'💼':'📋';
  let m=emoji+' *'+label+' ('+ts.length+')*\n';ts.slice(0,20).forEach((t,i)=>{m+='\n'+(i+1)+'. '+(PRI[t.priority]||'')+' '+t.title+(t.due_date?' _('+fmtD(t.due_date)+')_':'')});
  if(ts.length>20)m+='\n\n_+ '+(ts.length-20)+' more in the app_';
  const r=await sendWA(u.wa_phone,m);
  if(r.ok)return res.json({ok:true,sent:ts.length,sid:r.sid,label});
  res.status(502).json({ok:false,error:waErrorMessage(r),code:r.code});
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
  // Tech & AI — AI-first ordering: AI-only feeds come first so dedupe favors them.
  tech:['https://techcrunch.com/category/artificial-intelligence/feed/','https://www.theverge.com/rss/ai-artificial-intelligence/index.xml','https://venturebeat.com/category/ai/feed/','https://www.technologyreview.com/feed/','https://www.theinformation.com/feed','https://feeds.arstechnica.com/arstechnica/index','https://techcrunch.com/feed/','https://www.theverge.com/rss/index.xml','https://www.wired.com/feed/rss'],
  // Sports — IPL/cricket + football scores up top, then general
  sports:['https://www.thehindu.com/sport/cricket/feeder/default.rss','https://indianexpress.com/section/sports/cricket/feed/','https://feeds.bbci.co.uk/sport/cricket/rss.xml','https://feeds.bbci.co.uk/sport/football/rss.xml','https://www.espn.com/espn/rss/news','https://www.espn.com/espn/rss/soccer/news','https://feeds.bbci.co.uk/sport/rss.xml','https://www.skysports.com/rss/12040'],
  // World — critical/breaking world news first
  world:['https://feeds.reuters.com/reuters/topNews','https://feeds.bbci.co.uk/news/world/rss.xml','https://rss.nytimes.com/services/xml/rss/nyt/World.xml','https://feeds.npr.org/1004/rss.xml','https://feeds.bbci.co.uk/news/rss.xml']
};
// Legacy aliases — old client state pointing at ai/technology/global/movies should still resolve
NEWS_FEEDS.ai=NEWS_FEEDS.tech;NEWS_FEEDS.technology=NEWS_FEEDS.tech;NEWS_FEEDS.global=NEWS_FEEDS.world;NEWS_FEEDS.movies=NEWS_FEEDS.world;
// Scenic Unsplash fallbacks (hot-link friendly CDN) — used when an article has no image
const UNSPLASH=(id)=>'https://images.unsplash.com/photo-'+id+'?w=900&q=80&auto=format&fit=crop';
const FALLBACK_IMAGES={
  tech:[UNSPLASH('1677442136019-21780ecad995'),UNSPLASH('1518770660439-4636190af475'),UNSPLASH('1620712943543-bcc4688e7485'),UNSPLASH('1451187580459-43490279c0fa'),UNSPLASH('1531297484001-80022131f5a1'),UNSPLASH('1551434678-e076c223a692'),UNSPLASH('1550751827-4bd374c3f58b'),UNSPLASH('1485827404703-89b55fcc595e')],
  sports:[UNSPLASH('1461896836934-ffe607ba8211'),UNSPLASH('1517649763962-0c623066013b'),UNSPLASH('1556056504-5c7696c4c28d'),UNSPLASH('1431324155629-1a6deb1dec8d'),UNSPLASH('1574629810360-7efbbe195018'),UNSPLASH('1552674605-db6ffd4facb5')],
  world:[UNSPLASH('1506905925346-21bda4d32df4'),UNSPLASH('1469854523086-cc02fe5d8800'),UNSPLASH('1501785888041-af3ef285b470'),UNSPLASH('1502602898657-3e91760cbb34'),UNSPLASH('1480714378408-67cf0d13bc1b'),UNSPLASH('1564507592333-c60657eea523')]
};
FALLBACK_IMAGES.ai=FALLBACK_IMAGES.tech;FALLBACK_IMAGES.technology=FALLBACK_IMAGES.tech;FALLBACK_IMAGES.global=FALLBACK_IMAGES.world;FALLBACK_IMAGES.movies=FALLBACK_IMAGES.world;
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
  let cat=(req.query.cat||'tech').toLowerCase();
  // Normalise old aliases
  if(cat==='ai'||cat==='technology')cat='tech';
  else if(cat==='global'||cat==='movies')cat='world';
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

// ═══ IPL LIVE (CricAPI when CRICAPI_KEY env var set, plus Wikipedia summary, 60-sec cache) ═══
const iplCache={live:null,wiki:null};
app.get('/api/ipl/today',async(req,res)=>{
  const out={matches:[],wiki:null,source:'wiki-only'};
  // Wikipedia summary for the current season — always works, free, no key
  try{
    if(!iplCache.wiki||Date.now()-iplCache.wiki.ts>6*60*60*1000){
      const yr=new Date().getFullYear();
      const wk=await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/'+yr+'_Indian_Premier_League',{headers:{'User-Agent':'Brodoit/1.0','Accept':'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
      if(wk&&wk.extract){iplCache.wiki={ts:Date.now(),data:{title:wk.normalizedtitle||wk.title,extract:wk.extract,thumb:(wk.thumbnail||{}).source||null,url:((wk.content_urls||{}).desktop||{}).page||''}}}
    }
    if(iplCache.wiki)out.wiki=iplCache.wiki.data;
  }catch(e){}
  // Live matches via CricAPI (only if key present)
  if(process.env.CRICAPI_KEY){
    try{
      if(!iplCache.live||Date.now()-iplCache.live.ts>60*1000){
        const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),5000);
        const r=await fetch('https://api.cricapi.com/v1/currentMatches?apikey='+encodeURIComponent(process.env.CRICAPI_KEY)+'&offset=0',{signal:ctrl.signal}).then(r=>r.ok?r.json():null).catch(()=>null);
        clearTimeout(t);
        if(r&&r.data){const matches=(r.data||[]).filter(m=>/IPL|Indian Premier League/i.test((m.name||'')+' '+(m.series||''))).slice(0,8);iplCache.live={ts:Date.now(),matches}}
      }
      if(iplCache.live){out.matches=iplCache.live.matches;out.source='cricapi'}
    }catch(e){}
  }
  res.json(out);
});

// ═══ REMEMBER (Wikipedia "On This Day" births/deaths, 24-hour cache) — daily notable person ═══
const rememberCache={};
app.get('/api/remember/today',async(req,res)=>{
  const now=new Date();
  const m=String(now.getMonth()+1).padStart(2,'0');
  const d=String(now.getDate()).padStart(2,'0');
  const key='r-'+m+'-'+d;
  const c=rememberCache[key];
  if(c&&Date.now()-c.ts<24*60*60*1000)return res.json({person:c.data,cached:true});
  try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),6000);
    const url='https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/'+m+'/'+d;
    const r=await fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0','Accept':'application/json'}});
    clearTimeout(t);
    if(!r.ok)return res.json({person:null});
    const j=await r.json();
    const cand=[];
    (j.births||[]).forEach(b=>{const p=(b.pages||[])[0];if(p&&p.thumbnail)cand.push({type:'born',year:b.year,page:p})});
    (j.deaths||[]).forEach(b=>{const p=(b.pages||[])[0];if(p&&p.thumbnail)cand.push({type:'died',year:b.year,page:p})});
    if(!cand.length)return res.json({person:null});
    const pick=cand.sort((a,b)=>(b.year||0)-(a.year||0))[Math.min(2,cand.length-1)];
    const p=pick.page;
    const person={type:pick.type,year:pick.year,title:p.normalizedtitle||p.title||'',extract:(p.extract||'').slice(0,220),thumb:(p.thumbnail||{}).source||null,url:((p.content_urls||{}).desktop||{}).page||''};
    rememberCache[key]={ts:Date.now(),data:person};
    res.json({person});
  }catch(e){res.json({person:null,error:String(e)})}
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

// ═══ WEATHER + AQI (Open-Meteo, free, no key needed) ═══
// Caches successful temps for 15 min. Caches AQI-only/partial responses for only 90s so they
// retry quickly. NEVER caches a fully-null response.
const weatherCache={};
function _fetchT(url,ms){return new Promise((resolve)=>{const ctrl=new AbortController();const tm=setTimeout(()=>{try{ctrl.abort()}catch(e){}resolve({})},ms);fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0'}}).then(r=>r.json()).then(j=>{clearTimeout(tm);resolve(j||{})}).catch(()=>{clearTimeout(tm);resolve({})})})}
app.get('/api/weather',async(req,res)=>{
  const city=String(req.query.city||'Bangalore').slice(0,80).trim();
  const key=city.toLowerCase();
  const c=weatherCache[key];
  // Only honor cache if it has a real temp (or has a fresh partial that's <90s old)
  if(c&&c.data){
    const fresh=Date.now()-c.ts;
    if(c.data.temp!=null&&fresh<15*60*1000)return res.json({...c.data,cached:true});
    if(c.data.temp==null&&fresh<90*1000)return res.json({...c.data,cached:true,partial:true});
  }
  try{
    const geoJ=await _fetchT('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name='+encodeURIComponent(city),5000);
    const place=(geoJ.results||[])[0];
    if(!place)return res.json({error:'city_not_found',city});
    const lat=place.latitude,lon=place.longitude,cityName=place.name,country=place.country_code||'';
    // Use the modern Open-Meteo "current" param (current_weather is legacy and occasionally drops fields)
    const [wxR,aqR]=await Promise.all([
      _fetchT('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m,weather_code',5000),
      _fetchT('https://air-quality-api.open-meteo.com/v1/air-quality?latitude='+lat+'&longitude='+lon+'&current=us_aqi',5000)
    ]);
    // Modern shape first, then fall back to legacy
    const cur=(wxR&&wxR.current)||null;
    const legacy=(wxR&&wxR.current_weather)||null;
    const tRaw=cur&&typeof cur.temperature_2m==='number'?cur.temperature_2m:(legacy&&typeof legacy.temperature==='number'?legacy.temperature:null);
    const temp=tRaw!=null?Math.round(tRaw):null;
    const code=cur&&cur.weather_code!=null?cur.weather_code:(legacy?legacy.weathercode:null);
    const aqRaw=aqR&&aqR.current&&aqR.current.us_aqi;
    const aqi=typeof aqRaw==='number'?Math.round(aqRaw):null;
    const data={city:cityName,country,lat,lon,temp,aqi,weatherCode:code};
    // Only cache if at least temp came back. Partial caches fall through faster (90s).
    weatherCache[key]={ts:Date.now(),data};
    res.json(data);
  }catch(e){res.json({error:String(e&&e.message||e),city})}
});

// Force-refresh endpoint to bust the cache (used by retry button + deploy hooks)
app.post('/api/weather/refresh',(req,res)=>{const key=String(req.body&&req.body.city||'').toLowerCase().trim();if(key)delete weatherCache[key];res.json({ok:true,cleared:!!key})});

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
  const u=db.prepare('SELECT phone,name,email,wa_phone,created_at FROM users WHERE phone=?').get(req.user.phone);
  res.json(u||{error:'not found'});
});
// ═══ WHATSAPP LINK (connect a real WA number to an email-login account) ═══
function normWA(p){let n=String(p||'').replace(/[^0-9+]/g,'');if(!n)return '';if(!n.startsWith('+'))n='+'+n;return n}
app.post('/api/wa/connect',auth,async(req,res)=>{
  const phone=normWA(req.body.phone);
  if(phone.length<8)return res.status(400).json({error:'Enter your WhatsApp number with country code (e.g. +91 9876543210).'});
  if(rateLimited('wac:'+req.user.phone))return res.status(429).json({error:'Too many attempts. Try again in 10 minutes.'});
  // Block if this WA number is already linked to a different account
  const owner=db.prepare("SELECT phone FROM users WHERE wa_phone=? AND phone!=?").get(phone,req.user.phone);
  if(owner)return res.status(409).json({error:'That WhatsApp number is already linked to another Brodoit account.'});
  if(!tw)return res.status(503).json({error:'WhatsApp is not configured on the server.'});
  const code=genOTP();const expires=new Date(Date.now()+10*60*1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at)VALUES(?,?,?)').run('wac:'+phone,code,expires);
  const r=await sendWA(phone,`🔗 *Brodoit — link this WhatsApp*\n\nYour code: *${code}*\n\nEnter it on brodoit.com to connect this number to your account.\nExpires in 10 minutes.`);
  if(r.ok)return res.json({ok:true,sentTo:phone,sid:r.sid});
  // Sandbox-not-joined cases — tell the client so the UI can show the join instructions.
  const needsJoin=(r.code===63007||r.code===63015||r.code===63016||r.code===21610);
  res.status(502).json({ok:false,error:waErrorMessage(r),code:r.code,needsJoin});
});
app.post('/api/wa/verify',auth,(req,res)=>{
  const phone=normWA(req.body.phone),code=String(req.body.code||'').trim();
  if(!phone||!code)return res.status(400).json({error:'Phone and code required'});
  const key='wac:'+phone;
  const otp=db.prepare('SELECT * FROM otps WHERE phone=?').get(key);
  if(!otp)return res.status(400).json({error:'No verification code requested for this number.'});
  if(new Date(otp.expires_at)<new Date()){db.prepare('DELETE FROM otps WHERE phone=?').run(key);return res.status(400).json({error:'Code expired. Request a new one.'})}
  if(otp.code!==code)return res.status(400).json({error:'Wrong code. Try again.'});
  db.prepare('DELETE FROM otps WHERE phone=?').run(key);
  // Final dup check before commit
  const owner=db.prepare("SELECT phone FROM users WHERE wa_phone=? AND phone!=?").get(phone,req.user.phone);
  if(owner)return res.status(409).json({error:'That WhatsApp number is already linked to another Brodoit account.'});
  db.prepare('UPDATE users SET wa_phone=? WHERE phone=?').run(phone,req.user.phone);
  res.json({ok:true,wa_phone:phone});
});
app.post('/api/wa/disconnect',auth,(req,res)=>{
  db.prepare('UPDATE users SET wa_phone=NULL WHERE phone=?').run(req.user.phone);
  res.json({ok:true});
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
  const twiml=new twilio.twiml.MessagingResponse();
  // Find the Brodoit account that linked this WhatsApp number. NEVER auto-create users from incoming WA;
  // that orphans tasks from the email-login account they belong to.
  const linked=db.prepare('SELECT phone,name FROM users WHERE wa_phone=?').get(phone);
  if(!linked){
    twiml.message('👋 Hi! This number isn\'t linked to a Brodoit account yet.\n\nTo connect:\n1. Sign in at https://brodoit.com\n2. Tap your profile (top-right)\n3. Tap "📲 Connect WhatsApp"\n4. Enter this number and the code we send\n\nThen come back here and your tasks will sync. 🚀');
    return res.type('text/xml').send(twiml.toString());
  }
  const acct=linked.phone; // account ID (email-derived for email users)
  const p=parseIn(body);
  if(p.command==='help')twiml.message('🤖 *Brodoit*\n\n📝 Type any task to add\n📋 "list" — your open tasks\n✅ "done <task>" — complete\n🔄 "doing <task>" — start\n🗑️ "delete <task>" — remove\n\n🌐 App: https://brodoit.com');
  else if(p.command==='list'){const ts=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' ORDER BY priority DESC").all(acct);if(!ts.length)twiml.message('✨ No pending tasks!');else{let m='📋 *Your Tasks ('+ts.length+')*\n';ts.forEach((t,i)=>m+='\n'+(i+1)+'. '+PRI[t.priority]+' '+t.title+(t.due_date?' _('+fmtD(t.due_date)+')_':''));twiml.message(m)}}
  else if(p.command==='done'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status!='done' AND LOWER(title) LIKE ?").get(acct,'%'+p.title+'%');if(t){db.prepare("UPDATE tasks SET status='done',updated_at=datetime('now')WHERE id=?").run(t.id);twiml.message('✅ Done: *'+t.title+'* 🎉')}else twiml.message('❌ No task matching "'+p.title+'"')}
  else if(p.command==='doing'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND status='pending' AND LOWER(title) LIKE ?").get(acct,'%'+p.title+'%');if(t){db.prepare("UPDATE tasks SET status='in-progress',updated_at=datetime('now')WHERE id=?").run(t.id);twiml.message('🔄 Started: *'+t.title+'*')}else twiml.message('❌ Not found')}
  else if(p.command==='delete'){const t=db.prepare("SELECT * FROM tasks WHERE user_phone=? AND LOWER(title) LIKE ?").get(acct,'%'+p.title+'%');if(t){db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);twiml.message('🗑️ Deleted: *'+t.title+'*')}else twiml.message('❌ Not found')}
  else if(p.title){const id=genId();db.prepare("INSERT INTO tasks(id,user_phone,title,priority,due_date,source,board)VALUES(?,?,?,?,?,'whatsapp','home')").run(id,acct,p.title,p.priority,p.dueDate);let m='✅ *Added to Home Tasks!*\n\n'+PRI[p.priority]+' '+p.title;if(p.dueDate)m+='\n📅 '+fmtD(p.dueDate);twiml.message(m)}
  else twiml.message('Type "help" for commands');
  res.type('text/xml').send(twiml.toString());
});

// ═══ REMINDERS ═══
setInterval(async()=>{const now=new Date(),nd=todayStr(),nt=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
const due=db.prepare("SELECT * FROM tasks WHERE status!='done' AND due_date=? AND reminder_time=? AND reminded=0").all(nd,nt);
for(const t of due){
  const u=db.prepare('SELECT wa_phone FROM users WHERE phone=?').get(t.user_phone);
  if(u&&u.wa_phone){await sendWA(u.wa_phone,'⏰ *Reminder*\n\n'+PRI[t.priority]+' *'+t.title+'*'+(t.notes?'\n'+t.notes:'')+(t.due_date?'\n📅 '+fmtD(t.due_date):'')+'\n\n_Reply "done '+t.title.slice(0,20)+'" to complete_')}
  // Mark reminded either way so we don't loop on users without WA linked.
  db.prepare('UPDATE tasks SET reminded=1 WHERE id=?').run(t.id);
}
},60000);

// ═══ FRONTEND ═══
const HTML=`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="google-site-verification" content="0dus2qjhVhSPP2gWIDJlVBb7LxvrMDbrhECxY8tiO4U" />
<title>Brodoit — Tasks, audiobooks &amp; daily wisdom</title>
<meta name="description" content="Brodoit is your calm productivity companion. Manage tasks with WhatsApp reminders, listen to free public-domain audiobooks, sharpen your mind, and build a daily ritual that sticks.">
<link rel="canonical" href="https://brodoit.com/">
<meta name="theme-color" content="#1A1816">
<meta name="format-detection" content="telephone=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Brodoit">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Brodoit">
<meta property="og:title" content="Brodoit — Tasks, audiobooks &amp; daily wisdom">
<meta property="og:description" content="Your calm productivity companion. Tasks, WhatsApp reminders, free audiobooks, mind-gym drills, and daily wisdom — in one quiet place.">
<meta property="og:url" content="https://brodoit.com/">
<meta property="og:image" content="https://brodoit.com/icon-512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:locale" content="en_US">
<!-- Twitter -->
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Brodoit — Tasks, audiobooks &amp; daily wisdom">
<meta name="twitter:description" content="Your calm productivity companion. Tasks, WhatsApp reminders, free audiobooks, mind-gym drills, and daily wisdom — in one quiet place.">
<meta name="twitter:image" content="https://brodoit.com/icon-512.png">
<!-- Structured data for Google rich results -->
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://brodoit.com/#org","name":"Brodoit","url":"https://brodoit.com/","logo":"https://brodoit.com/icon-512.png","email":"hello@brodoit.com","sameAs":["https://github.com/rishabh071106-eng/taskflow"]},{"@type":"WebSite","@id":"https://brodoit.com/#site","url":"https://brodoit.com/","name":"Brodoit","description":"Tasks, audiobooks and daily wisdom — your calm productivity companion.","publisher":{"@id":"https://brodoit.com/#org"},"inLanguage":"en"},{"@type":"WebApplication","@id":"https://brodoit.com/#app","name":"Brodoit","url":"https://brodoit.com/","description":"A calm productivity app: manage tasks with WhatsApp reminders, listen to free public-domain audiobooks, sharpen your mind with daily drills, and build a streak that sticks.","applicationCategory":"ProductivityApplication","operatingSystem":"Web, Android, iOS","browserRequirements":"Requires JavaScript. Requires HTML5.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD","availability":"https://schema.org/InStock"},"featureList":["Task management","WhatsApp reminders","Email reminders","Free public-domain audiobooks","Daily wisdom quotes","Mind Gym brain games","Voice training","Step tracking","Google Calendar sync"],"publisher":{"@id":"https://brodoit.com/#org"},"inLanguage":"en"}]}</script>
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
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding:0 2px}.logo{font-family:'Space Mono',monospace;font-size:26px;font-weight:700;letter-spacing:-.8px;line-height:1}.logo .k{color:#3DAE5C;display:inline-block;transition:transform .4s cubic-bezier(.4,1.5,.5,1)}.logo:hover .k{transform:scale(1.15) rotate(-6deg)}
.hdr-tagline{display:none;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:13px;color:#94A3B8;margin-top:2px;letter-spacing:.04em}
/* Phone scenic masthead — desktop hidden by default */
.phone-banner{display:none}
@media (max-width:700px){
  .phone-banner{display:block;position:relative;width:100%;height:60px;margin:0 0 8px;overflow:hidden;border-radius:10px;background:#0F172A;box-sizing:border-box;max-width:100%}
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
  .hdr{padding:0 2px;margin-bottom:8px}
  .app{overflow-x:hidden}
}
@media (max-width:380px){.phone-banner{height:48px}}
/* (Mobile-hide rules for top-news, top-strip, bottom-strip live further down in the file,
   AFTER their default-display rules, to win the CSS cascade.) */
/* Home / Office / Combined board picker — image-backed cards with Ken-Burns zoom + tinted overlay */
.board-pick{display:flex;gap:10px;margin:0 0 8px;padding:0;background:transparent;border:none}
.board-pick .bp{flex:1;position:relative;overflow:hidden;border:none;background:#0F172A;color:#fff;border-radius:14px;padding:16px 14px;cursor:pointer;min-height:84px;display:flex;align-items:center;justify-content:flex-start;text-align:left;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease;isolation:isolate;box-shadow:0 2px 8px rgba(15,23,42,.08)}
.board-pick .bp:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(15,23,42,.18)}
.board-pick .bp:active{transform:translateY(-1px) scale(.99)}
.board-pick .bp-bg{position:absolute;inset:0;background-size:cover;background-position:center;z-index:-2;animation:bpKenBurns 16s ease-in-out infinite alternate;will-change:transform}
.board-pick .bp.on .bp-bg{animation-duration:8s}
.board-pick .bp-overlay{position:absolute;inset:0;z-index:-1;transition:opacity .25s ease,background .25s ease}
/* Per-board scenic photo + warm/cool/purple tint */
.board-pick .bp-home .bp-bg{background-image:url("https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=600&q=70&auto=format&fit=crop")}
.board-pick .bp-home .bp-overlay{background:linear-gradient(135deg,rgba(232,145,44,.78) 0%,rgba(180,83,9,.55) 55%,rgba(15,23,42,.45) 100%)}
.board-pick .bp-home.on .bp-overlay{background:linear-gradient(135deg,rgba(232,145,44,.55) 0%,rgba(180,83,9,.35) 55%,rgba(15,23,42,.28) 100%)}
.board-pick .bp-home.on{box-shadow:0 10px 28px rgba(232,145,44,.36),0 0 0 2px rgba(255,255,255,.85),0 0 0 4px rgba(232,145,44,.55)}
.board-pick .bp-office .bp-bg{background-image:url("https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=600&q=70&auto=format&fit=crop")}
.board-pick .bp-office .bp-overlay{background:linear-gradient(135deg,rgba(99,102,241,.78) 0%,rgba(49,46,129,.55) 55%,rgba(15,23,42,.45) 100%)}
.board-pick .bp-office.on .bp-overlay{background:linear-gradient(135deg,rgba(99,102,241,.55) 0%,rgba(49,46,129,.35) 55%,rgba(15,23,42,.28) 100%)}
.board-pick .bp-office.on{box-shadow:0 10px 28px rgba(99,102,241,.4),0 0 0 2px rgba(255,255,255,.85),0 0 0 4px rgba(99,102,241,.6)}
.board-pick .bp-combined .bp-bg{background-image:url("https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=600&q=70&auto=format&fit=crop")}
.board-pick .bp-combined .bp-overlay{background:linear-gradient(135deg,rgba(167,139,250,.78) 0%,rgba(124,58,237,.55) 55%,rgba(15,23,42,.45) 100%)}
.board-pick .bp-combined.on .bp-overlay{background:linear-gradient(135deg,rgba(167,139,250,.55) 0%,rgba(124,58,237,.35) 55%,rgba(15,23,42,.28) 100%)}
.board-pick .bp-combined.on{box-shadow:0 10px 28px rgba(167,139,250,.4),0 0 0 2px rgba(255,255,255,.85),0 0 0 4px rgba(167,139,250,.6)}
.board-pick .bp-emoji{font-size:34px;line-height:1;flex-shrink:0;filter:drop-shadow(0 2px 8px rgba(0,0,0,.45));animation:bpFloat 3.5s ease-in-out infinite}
.board-pick .bp-home .bp-emoji{animation-name:bpFloatHome}
.board-pick .bp-office .bp-emoji{animation-name:bpFloatOffice}
.board-pick .bp-combined .bp-emoji{animation-name:bpFloatCombined}
.board-pick .bp-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.board-pick .bp-l{font-weight:800;font-size:14.5px;letter-spacing:-.02em;text-shadow:0 1px 3px rgba(0,0,0,.5);line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-pick .bp-s{font-size:11.5px;font-weight:500;color:rgba(255,255,255,.92);line-height:1.3;letter-spacing:.005em;text-shadow:0 1px 2px rgba(0,0,0,.45);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.board-pick .bp-c{position:absolute;top:8px;right:10px;font-size:11px;font-weight:700;background:rgba(255,255,255,.95);color:#0F172A;padding:2px 9px;border-radius:9px;font-family:'Space Mono',monospace;box-shadow:0 2px 6px rgba(0,0,0,.2)}
.board-pick .bp.on .bp-c{background:#fff;color:#0F172A}
@keyframes bpKenBurns{0%{transform:scale(1.04) translate(0,0)}100%{transform:scale(1.18) translate(-3%,-2%)}}
@keyframes bpFloatHome{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-4px) rotate(3deg)}}
@keyframes bpFloatOffice{0%,100%{transform:translateX(0) rotate(-2deg)}50%{transform:translateX(3px) rotate(2deg)}}
@keyframes bpFloatCombined{0%,100%{transform:scale(1) rotate(-3deg)}50%{transform:scale(1.08) rotate(3deg)}}
@media (prefers-reduced-motion:reduce){.board-pick .bp-bg,.board-pick .bp-emoji{animation:none}}
/* Helper line + Add Task bar pick up the active board's accent so the page reads as one continuous theme */
.board-pick-hint{font-size:12px;font-weight:600;color:var(--bk,#475569);margin:10px 4px 14px;padding:10px 12px 10px 14px;letter-spacing:.005em;background:var(--bk-soft,rgba(15,23,42,.04));border-left:3px solid var(--bk,#94A3B8);border-radius:0 8px 8px 0;line-height:1.45;position:relative;animation:bkHintIn .25s ease}
@keyframes bkHintIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
.board-pick[data-bk] + .board-pick-hint{margin-top:14px}
/* Downward arrow pointing from active pill into the helper line — visual handshake */
.board-pick{position:relative}
.board-pick .bp.on::before{content:'';position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:0;height:0;border-style:solid;border-width:8px 8px 0 8px;border-color:var(--bk,#0F172A) transparent transparent transparent;z-index:4;filter:drop-shadow(0 1px 2px rgba(0,0,0,.18))}
/* Active board's color used by helper-line/add-bar — set via inline --bk on .board-pick */
/* Quick-start intro — first-visit orientation card at the very top of Tasks tab */
.intro-card{background:linear-gradient(135deg,#FFFBF1 0%,#FEF3E0 50%,#EAF6EE 100%);border:1px solid #F3D9A0;border-radius:14px;padding:14px 14px 12px;margin:0 0 10px;animation:introIn .4s cubic-bezier(.2,.8,.2,1)}
@keyframes introIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.intro-hd{margin-bottom:10px}
.intro-logo{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;color:#0F172A;letter-spacing:-.02em;line-height:1}
.intro-logo .k{color:#3DAE5C}
.intro-tag{font-size:12px;color:#7C5A00;font-style:italic;font-family:'Instrument Serif',Georgia,serif;margin-top:3px;line-height:1.4}
.intro-steps{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.intro-steps li{display:flex;align-items:flex-start;gap:11px;background:rgba(255,255,255,.55);border:1px solid rgba(232,145,44,.12);border-radius:10px;padding:9px 11px}
.intro-ic{font-size:20px;line-height:1;flex-shrink:0;width:30px;height:30px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.intro-steps li > div{flex:1;min-width:0;font-size:13px;line-height:1.45;color:#0F172A}
.intro-steps li > div b{font-weight:700}
.intro-d{color:#475569;font-weight:500}
.intro-acts{margin-top:10px;text-align:right}
.intro-btn-skip{background:#0F172A;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit;letter-spacing:.01em;box-shadow:0 3px 10px rgba(15,23,42,.2);transition:transform .12s ease}
.intro-btn-skip:hover{transform:translateY(-1px)}
.intro-btn-skip:active{transform:scale(.97)}
@media (max-width:600px){.intro-card{padding:12px 12px 10px}.intro-logo{font-size:22px}.intro-tag{font-size:11.5px}.intro-steps li{padding:8px 10px;gap:9px}.intro-ic{width:26px;height:26px;font-size:17px}.intro-steps li > div{font-size:12.5px;line-height:1.4}}
body[data-theme=aurora] .intro-card{background:linear-gradient(135deg,rgba(232,145,44,.08),rgba(167,139,250,.06));border-color:rgba(232,145,44,.22)}
body[data-theme=aurora] .intro-logo{color:#F5F5FA}
body[data-theme=aurora] .intro-tag{color:#FCD34D}
body[data-theme=aurora] .intro-steps li{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);color:#F5F5FA}
body[data-theme=aurora] .intro-steps li > div{color:#F5F5FA}
body[data-theme=aurora] .intro-d{color:#9999B5}
body[data-theme=aurora] .intro-ic{background:rgba(255,255,255,.08)}
/* Restore-from-backup banner — shows only when server tasks=0 but localStorage has a backup */
.restore-banner{display:flex;align-items:center;gap:11px;padding:12px 14px;margin:0 0 12px;background:linear-gradient(135deg,rgba(232,145,44,.1),rgba(180,83,9,.06));border:1.5px solid rgba(232,145,44,.32);border-radius:12px;animation:bkHintIn .3s ease}
.restore-emoji{font-size:24px;line-height:1;flex-shrink:0}
.restore-body{flex:1;min-width:0}
.restore-t{font-weight:800;font-size:14px;color:#7C5A00;letter-spacing:-.01em}
.restore-s{font-size:11.5px;color:#5D4400;line-height:1.4;margin-top:2px}
.restore-go{flex-shrink:0;background:linear-gradient(135deg,#E8912C,#B45309);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;box-shadow:0 3px 10px rgba(232,145,44,.32)}
.restore-x{flex-shrink:0;background:transparent;border:none;color:#94A3B8;font-size:14px;cursor:pointer;padding:4px 6px;border-radius:6px;font-family:inherit;line-height:1}
.restore-x:hover{background:rgba(15,23,42,.06);color:#0F172A}
@media (max-width:480px){.restore-s{display:none}}
body[data-theme=aurora] .restore-banner{background:linear-gradient(135deg,rgba(232,145,44,.14),rgba(180,83,9,.08));border-color:rgba(232,145,44,.4)}
body[data-theme=aurora] .restore-t{color:#FCD34D}
body[data-theme=aurora] .restore-s{color:#F5D687}
/* Backup section in profile modal */
.bkp-sec{margin:18px 0 4px;padding:14px;background:linear-gradient(135deg,rgba(99,102,241,.05),rgba(232,145,44,.03));border:1px solid rgba(99,102,241,.16);border-radius:14px;text-align:left}
.bkp-sec-hd{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.bkp-sec-emoji{font-size:24px;line-height:1}
.bkp-sec-t{font-weight:800;font-size:14.5px;color:var(--ink,#0F172A);letter-spacing:-.01em}
.bkp-sec-s{font-size:11.5px;color:#94A3B8;font-weight:500;line-height:1.4;margin-top:2px}
.bkp-btn{width:100%;padding:11px 14px;font-size:13.5px;margin-top:0}
body[data-theme=aurora] .bkp-sec{background:linear-gradient(135deg,rgba(167,139,250,.08),rgba(232,145,44,.04));border-color:rgba(167,139,250,.2)}
body[data-theme=aurora] .bkp-sec-t{color:#F5F5FA}
/* Connect-WhatsApp promo banner — top of Tasks tab when WA not linked yet */
.wa-promo{display:flex;align-items:center;gap:10px;padding:11px 12px;margin:0 0 10px;background:linear-gradient(135deg,rgba(37,211,102,.1),rgba(18,140,126,.06));border:1px solid rgba(37,211,102,.28);border-radius:12px;position:relative}
.wa-promo-emoji{font-size:24px;line-height:1;flex-shrink:0}
.wa-promo-body{flex:1;min-width:0}
.wa-promo-t{font-weight:700;font-size:13px;color:#0F172A;letter-spacing:-.01em}
.wa-promo-s{font-size:11px;color:#475569;line-height:1.35;margin-top:1px}
.wa-promo-go{flex-shrink:0;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:700;font-size:12.5px;cursor:pointer;box-shadow:0 3px 10px rgba(37,211,102,.28);font-family:inherit;transition:transform .12s ease}
.wa-promo-go:active{transform:scale(.96)}
.wa-promo-x{flex-shrink:0;background:transparent;border:none;color:#94A3B8;font-size:14px;cursor:pointer;padding:4px 6px;border-radius:6px;font-family:inherit;line-height:1}
.wa-promo-x:hover{background:rgba(15,23,42,.06);color:#0F172A}
@media (max-width:480px){.wa-promo-s{display:none}.wa-promo{padding:10px}}
body[data-theme=aurora] .wa-promo{background:linear-gradient(135deg,rgba(37,211,102,.12),rgba(18,140,126,.08));border-color:rgba(37,211,102,.3)}
body[data-theme=aurora] .wa-promo-t{color:#F5F5FA}
body[data-theme=aurora] .wa-promo-s{color:#9999B5}
body[data-theme=aurora] .wa-promo-x{color:#7C7C97}
body[data-theme=aurora] .wa-promo-x:hover{background:rgba(255,255,255,.06);color:#F5F5FA}
/* Mobile: vertical layout (emoji on top, label below); subtitle hidden — the helper-line below the pills covers it.
   Inactive pills are visibly DIMMED so the active board jumps out at a glance. */
@media (max-width:600px){
  .board-pick{gap:8px}
  .board-pick .bp{flex-direction:column;justify-content:center;align-items:center;text-align:center;min-height:64px;padding:12px 6px;gap:0;opacity:.55;filter:saturate(.7)}
  .board-pick .bp.on{opacity:1;filter:none;transform:scale(1.04);z-index:2}
  .board-pick .bp:not(.on) .bp-bg{animation:none}
  .board-pick .bp-emoji{font-size:28px}
  .board-pick .bp:not(.on) .bp-emoji{animation:none}
  .board-pick .bp-text{align-items:center;gap:0}
  .board-pick .bp-l{font-size:12.5px;letter-spacing:-.01em;font-weight:800}
  .board-pick .bp-s{display:none}
  .board-pick .bp-c{font-size:10px;padding:1px 6px;top:5px;right:5px}
  /* Mobile-only: bigger triangle so the connection between pill and content is unmistakable */
  .board-pick .bp.on::before{border-width:9px 9px 0 9px;bottom:-9px}
}
body[data-theme=aurora] .board-pick .bp-c{background:rgba(255,255,255,.92);color:#0F172A}
body[data-theme=aurora] .board-pick-hint{color:#7C7C97}
/* WhatsApp connect section in profile modal */
.wa-sec{margin:24px 0 4px;padding:14px;background:linear-gradient(135deg,rgba(37,211,102,.06),rgba(18,140,126,.04));border:1px solid rgba(37,211,102,.18);border-radius:14px;text-align:left}
.wa-sec-hd{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.wa-sec-emoji{font-size:28px;line-height:1}
.wa-sec-t{font-weight:800;font-size:15px;color:var(--ink,#0F172A);letter-spacing:-.01em}
.wa-sec-s{font-size:11.5px;color:#94A3B8;font-weight:500}
.wa-connect-btn{width:100%;background:linear-gradient(135deg,#25D366,#128C7E)!important;color:#fff!important;border:none!important;font-weight:700;letter-spacing:.01em;padding:13px;font-size:14px;box-shadow:0 6px 18px rgba(37,211,102,.28)}
.wa-linked{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #B7E8C4;color:#0F172A;padding:10px 12px;border-radius:10px;font-size:13.5px;flex-wrap:wrap}
.wa-link-x{margin-left:auto;background:transparent;border:1px solid #FCA5A5;color:#B91C1C;font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:8px;cursor:pointer}
.wa-link-x:hover{background:#FEF2F2}
.wa-linked-hint{font-size:11.5px;color:#64748B;margin-top:8px;line-height:1.5}
.wa-helper{background:#FFF8E1;border:1px solid #F5D687;border-radius:10px;padding:11px 13px;margin-top:10px}
.wa-helper-t{font-weight:700;font-size:12.5px;color:#7C5A00;margin-bottom:4px}
.wa-helper-d{font-size:12px;color:#5D4400;line-height:1.5;margin-bottom:8px}
.wa-helper-mini{font-size:11.5px;color:#1A9E47;background:#EDFCF2;border:1px solid #B7E8C4;padding:7px 10px;border-radius:8px;margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wa-helper-reset{background:transparent;border:none;color:#6366F1;font-size:11px;font-weight:600;text-decoration:underline;cursor:pointer;padding:0;margin-left:auto;font-family:inherit}
.wa-card{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:13px;margin-top:10px}
.wa-card-t{font-weight:700;font-size:13.5px;color:#0F172A;margin-bottom:3px}
.wa-card-d{font-size:11.5px;color:#64748B;line-height:1.5;margin-bottom:10px}
.wa-resend{display:block;width:100%;margin-top:8px;background:transparent;border:none;color:#64748B;font-size:11.5px;font-weight:600;cursor:pointer;padding:6px 0;text-decoration:underline;font-family:inherit}
.wa-step{display:flex;gap:12px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:12px;margin-top:10px}
.wa-step-n{flex:0 0 28px;height:28px;width:28px;border-radius:50%;background:#25D366;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:13px;font-family:'Space Mono',monospace}
.wa-step-b{flex:1;min-width:0}
.wa-step-t{font-weight:700;font-size:13.5px;color:#0F172A;margin-bottom:4px}
.wa-step-d{font-size:12px;color:#475569;line-height:1.5;margin-bottom:8px}
.wa-jb{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;border:none;border-radius:8px;padding:10px 14px;font-weight:700;font-size:12.5px;cursor:pointer;box-shadow:0 4px 12px rgba(37,211,102,.28)}
.wa-jb svg{width:14px;height:14px;fill:#fff}
.wa-skip{display:block;margin-top:8px;background:transparent;border:none;color:#6366F1;font-size:11.5px;font-weight:600;cursor:pointer;padding:4px 0;text-decoration:underline}
.wa-row{display:flex;gap:8px;margin-top:6px}
.wa-cc{flex:0 0 auto;padding:10px 8px;border:1px solid #E2E8F0;border-radius:8px;background:#FAFAF7;font-size:13px;font-weight:600;font-family:inherit}
.wa-num{flex:1;padding:10px 12px;border:1px solid #E2E8F0;border-radius:8px;font-size:14px;background:#fff;color:#0F172A;font-family:inherit}
.wa-num:focus,.wa-cc:focus{outline:none;border-color:#25D366}
.wa-code{width:100%;padding:14px;text-align:center;letter-spacing:8px;font-size:22px;font-weight:700;font-family:'Space Mono',monospace;border:1.5px solid #E2E8F0;border-radius:10px;background:#FAFAF7;color:#0F172A;margin-top:6px}
.wa-code:focus{outline:none;border-color:#25D366;background:#fff}
.wa-err{margin-top:8px;font-size:12px;color:#B91C1C;font-weight:600;background:#FEF2F2;border:1px solid #FCA5A5;padding:7px 10px;border-radius:8px}
.wa-acts{display:flex;gap:8px;margin-top:10px}
.wa-acts .mb{flex:1;margin-top:0;padding:10px;font-size:13px}
body[data-theme=aurora] .wa-sec{background:linear-gradient(135deg,rgba(37,211,102,.1),rgba(18,140,126,.06));border-color:rgba(37,211,102,.25)}
body[data-theme=aurora] .wa-sec-t{color:#F5F5FA}
body[data-theme=aurora] .wa-linked,body[data-theme=aurora] .wa-step{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:#F5F5FA}
body[data-theme=aurora] .wa-step-t{color:#F5F5FA}
body[data-theme=aurora] .wa-step-d,body[data-theme=aurora] .wa-linked-hint{color:#9999B5}
body[data-theme=aurora] .wa-cc,body[data-theme=aurora] .wa-num,body[data-theme=aurora] .wa-code{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .wa-helper{background:rgba(245,214,135,.08);border-color:rgba(245,214,135,.25)}
body[data-theme=aurora] .wa-helper-t,body[data-theme=aurora] .wa-helper-d{color:#F5D687}
body[data-theme=aurora] .wa-helper-mini{background:rgba(37,211,102,.1);border-color:rgba(37,211,102,.25);color:#3DAE5C}
body[data-theme=aurora] .wa-card{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)}
body[data-theme=aurora] .wa-card-t{color:#F5F5FA}
body[data-theme=aurora] .wa-card-d{color:#9999B5}
body[data-theme=aurora] .wa-resend{color:#9999B5}
/* In-form Board picker (modal: New / Edit Task) */
.form-board-pick{display:flex;gap:10px;margin-bottom:10px}
.fbp{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 8px;border:1.5px solid var(--line,#E2E8F0);background:var(--bg-elev,#fff);border-radius:12px;cursor:pointer;color:var(--ink-2,#475569);transition:border-color .15s ease,background .15s ease,transform .1s ease;text-align:center}
.fbp:hover{border-color:#94A3B8}
.fbp:active{transform:scale(.98)}
.fbp.on{border-color:#6366F1;background:rgba(99,102,241,.06);color:#0F172A;box-shadow:0 0 0 3px rgba(99,102,241,.12)}
.fbp-emoji{font-size:22px;line-height:1}
.fbp-l{font-weight:700;font-size:14px}
.fbp-s{font-size:10.5px;color:#94A3B8;font-weight:500;letter-spacing:.01em}
.fbp.on .fbp-s{color:#6B7280}
body[data-theme=aurora] .fbp{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12);color:#9999B5}
body[data-theme=aurora] .fbp.on{border-color:#A78BFA;background:rgba(167,139,250,.1);color:#F5F5FA;box-shadow:0 0 0 3px rgba(167,139,250,.16)}
body[data-theme=aurora] .fbp-s{color:#7C7C97}
body[data-theme=aurora] .phone-banner{background:#0A0A14}
body[data-theme=aurora] .hdr-tagline{color:#9999B5}
.hdr-st{font-size:11px;font-weight:700;padding:8px 14px;border-radius:10px;background:#FFFFFF;border:1px solid #E8E9EF;display:flex;align-items:center;gap:7px;letter-spacing:.8px;box-shadow:0 2px 6px rgba(0,0,0,.04)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;animation:pulse-dot 2s ease-in-out infinite}
.hdr-sub{margin-top:1px;font-weight:500;display:flex;align-items:center;gap:10px;font-family:'Instrument Serif',Georgia,serif;font-size:13px;letter-spacing:.02em;color:#64748B}
/* Jump-rope figure in the header */
.hdr-jumper{width:36px;height:36px;flex-shrink:0;color:#6366F1;filter:drop-shadow(0 1px 4px rgba(99,102,241,.3))}
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
.hdr-time{display:flex;align-items:baseline;gap:4px;font-family:'Instrument Serif',Georgia,serif}
.hdr-time-hm{font-size:20px;font-weight:400;letter-spacing:-.02em;color:#0F172A;line-height:1}
.hdr-time-sec{font-size:12px;color:#E8453C;animation:secBlink 1s steps(2) infinite;font-weight:400}
.hdr-time-sep{color:#CBD5E1;font-size:14px;margin:0 3px}
.hdr-time-date{font-size:13px;color:#64748B;font-style:italic}
body[data-theme=aurora] .hdr-time-hm{color:#F5F5FA}
body[data-theme=aurora] .hdr-time-date{color:#9999B5}
@media (max-width:700px){
  /* Single timer on phone: drop the header time entirely; LOCAL TIME card below is enough */
  .hdr-time{display:none}
  .hdr-jumper{width:42px;height:42px}
  .hdr-sub{gap:10px;flex-wrap:wrap;font-size:13px}
}
/* Section dividers — thin gradient line with a pulsing centered node */
.section-div{height:1px;background:linear-gradient(90deg,transparent 0%,rgba(99,102,241,.18) 30%,rgba(232,145,44,.22) 50%,rgba(99,102,241,.18) 70%,transparent 100%);margin:6px 0;position:relative}
/* Tap Sprint mini-game */
/* AI COACH (Voice tab) */
.cc-hero{position:relative;border-radius:20px;overflow:hidden;margin-bottom:14px;background:linear-gradient(135deg,#0F172A 0%,#1E1B4B 50%,#7C3AED 100%);color:#fff;box-shadow:0 18px 44px rgba(15,23,42,.32);padding:22px;min-height:130px}
.cc-hero-orb{position:absolute;top:-40%;right:-15%;width:380px;height:380px;background:radial-gradient(circle,rgba(167,139,250,.42),transparent 60%);pointer-events:none;animation:ccOrb 8s ease-in-out infinite alternate}
@keyframes ccOrb{from{transform:translate(0,0) scale(1)}to{transform:translate(-30px,18px) scale(1.07)}}
.cc-hero-l{position:relative;max-width:520px}
.cc-hero-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:2px;color:rgba(255,255,255,.74);margin-bottom:8px}
.cc-hero-t{margin:0;font-size:30px;font-weight:900;line-height:1.05;letter-spacing:-.025em;color:#fff}
@media (min-width:600px){.cc-hero-t{font-size:36px}}
.cc-hero-s{font-size:14px;color:rgba(255,255,255,.82);line-height:1.55;margin-top:10px}
.cc-caps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.cc-cap{font-size:11px;font-weight:700;padding:5px 10px;border-radius:99px;background:#FEF2F2;color:#B91C1C;border:1px solid #FCA5A5}
.cc-cap-on{background:#EDFCF2;color:#16A34A;border-color:#B7E8C4}
.cc-scenarios{margin-bottom:14px}
.cc-scenarios-t{font-size:12px;font-weight:700;color:#475569;letter-spacing:.4px;text-transform:uppercase;margin-bottom:8px}
.cc-scenario-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
.cc-scenario-row::-webkit-scrollbar{display:none}
.cc-sc{flex-shrink:0;scroll-snap-align:start;padding:10px 14px;border:1.5px solid #E2E8F0;background:#fff;border-radius:11px;cursor:pointer;font-size:12.5px;font-weight:700;color:#0F172A;font-family:inherit;letter-spacing:-.005em;transition:transform .12s ease,border-color .12s ease,background .12s ease}
.cc-sc:hover{border-color:#7C3AED;background:#F5F3FF}
.cc-sc:active{transform:scale(.97)}
.cc-sc-on{background:#7C3AED;color:#fff;border-color:#7C3AED}
.cc-active-scenario{padding:10px 14px;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:11px;font-size:13px;color:#5B21B6;display:flex;align-items:center;gap:8px;margin-bottom:14px}
.cc-active-scenario b{color:#0F172A}
.cc-end{margin-left:auto;background:transparent;border:1px solid #DDD6FE;color:#7C3AED;border-radius:8px;padding:5px 10px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit}
.cc-end:hover{background:#7C3AED;color:#fff}
.cc-thread{display:flex;flex-direction:column;gap:11px;padding:6px 2px 12px;max-height:60vh;overflow-y:auto}
.cc-msg{display:flex;gap:8px;align-items:flex-end}
.cc-coach{justify-content:flex-start}
.cc-me{justify-content:flex-end}
.cc-avatar{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#7C3AED,#1E1B4B);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px}
.cc-bubble{max-width:78%;padding:11px 14px;border-radius:16px;line-height:1.5;font-size:14px;white-space:pre-wrap;word-wrap:break-word;position:relative}
.cc-coach .cc-bubble{background:#F5F3FF;color:#0F172A;border:1px solid #DDD6FE;border-bottom-left-radius:4px}
.cc-me .cc-bubble{background:linear-gradient(135deg,#0F172A,#312E81);color:#fff;border-bottom-right-radius:4px}
.cc-bubble b{font-weight:800}
.cc-replay{display:inline-block;margin-left:6px;background:rgba(124,58,237,.12);border:none;color:#7C3AED;font-size:13px;padding:2px 8px;border-radius:7px;cursor:pointer;font-family:inherit;line-height:1}
.cc-replay:hover{background:#7C3AED;color:#fff}
.cc-typing{display:flex;gap:4px;padding:14px}
.cc-typing span{width:7px;height:7px;border-radius:50%;background:#7C3AED;opacity:.4;animation:ccTyping 1.2s ease-in-out infinite}
.cc-typing span:nth-child(2){animation-delay:.18s}
.cc-typing span:nth-child(3){animation-delay:.36s}
@keyframes ccTyping{0%,80%,100%{opacity:.3;transform:scale(.85)}40%{opacity:1;transform:scale(1.1)}}
.cc-composer-rec{background:linear-gradient(135deg,#FEF2F2,#FEE2E2);border-color:#FCA5A5}
.cc-wave{flex:1;height:40px;display:block;background:transparent}
.cc-composer{display:flex;align-items:flex-end;gap:8px;padding:10px;background:#fff;border:1.5px solid #E2E8F0;border-radius:18px;box-shadow:0 4px 16px rgba(15,23,42,.08);position:sticky;bottom:0;margin-top:8px}
.cc-composer textarea{flex:1;min-width:0;resize:none;border:none;outline:none;font-family:inherit;font-size:15px;line-height:1.45;padding:8px 4px;color:#0F172A;background:transparent;max-height:120px;min-height:24px}
.cc-mic{flex-shrink:0;width:42px;height:42px;border-radius:50%;background:#F1F5F9;border:none;font-size:18px;cursor:pointer;color:#0F172A;font-family:inherit;transition:background .12s ease,transform .1s ease}
.cc-mic:hover{background:#E2E8F0}
.cc-mic:active{transform:scale(.94)}
.cc-rec{background:#DC2626!important;color:#fff!important;animation:ccRecPulse 1s ease-in-out infinite}
@keyframes ccRecPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.6)}50%{box-shadow:0 0 0 14px rgba(220,38,38,0)}}
.cc-send{flex-shrink:0;width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#7C3AED,#5B21B6);border:none;color:#fff;font-size:22px;font-weight:900;cursor:pointer;font-family:inherit;line-height:1;transition:transform .1s ease}
.cc-send:hover:not(:disabled){transform:scale(1.05)}
.cc-send:active:not(:disabled){transform:scale(.92)}
.cc-send:disabled{opacity:.4;cursor:not-allowed}
.cc-quick{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.cc-quick-btn{padding:7px 12px;font-size:12px;font-weight:600;background:#fff;border:1px solid #E2E8F0;border-radius:99px;cursor:pointer;color:#475569;font-family:inherit;letter-spacing:-.005em;transition:border-color .12s ease,background .12s ease,color .12s ease}
.cc-quick-btn:hover{border-color:#7C3AED;background:#F5F3FF;color:#7C3AED}
.cc-quick-reset{margin-left:auto;color:#64748B;border-color:#CBD5E1}
.cc-playing{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0F172A;color:#fff;padding:8px 14px;border-radius:99px;font-size:12px;font-weight:600;z-index:90;box-shadow:0 6px 16px rgba(15,23,42,.3)}
.cc-playing button{background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;margin-left:8px;cursor:pointer;font-family:inherit}
@media (max-width:600px){.cc-thread{max-height:50vh}.cc-bubble{max-width:84%;font-size:13.5px}}
body[data-theme=aurora] .cc-cap{background:rgba(220,38,38,.12);color:#FCA5A5;border-color:rgba(220,38,38,.3)}
body[data-theme=aurora] .cc-cap-on{background:rgba(34,197,94,.14);color:#4ADE80;border-color:rgba(34,197,94,.3)}
body[data-theme=aurora] .cc-sc{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .cc-sc:hover{background:rgba(124,58,237,.18);border-color:#A78BFA}
body[data-theme=aurora] .cc-sc-on{background:#A78BFA;color:#1A1A2E;border-color:#A78BFA}
body[data-theme=aurora] .cc-active-scenario{background:rgba(124,58,237,.14);border-color:rgba(167,139,250,.3);color:#C4B5FD}
body[data-theme=aurora] .cc-coach .cc-bubble{background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.22);color:#F5F5FA}
body[data-theme=aurora] .cc-composer{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12)}
body[data-theme=aurora] .cc-composer textarea{color:#F5F5FA}
body[data-theme=aurora] .cc-mic{background:rgba(255,255,255,.08);color:#F5F5FA}
body[data-theme=aurora] .cc-quick-btn{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12);color:#9999B5}
/* Math Sprint v2 — time-pressure quiz with animated tiles + particles */
.ms-body{padding:18px;background:#fff;display:flex;flex-direction:column;gap:14px}
.ms-stats{display:flex;align-items:center;gap:14px}
.ms-stat{display:flex;align-items:baseline;gap:3px;background:rgba(15,23,42,.05);padding:7px 11px;border-radius:10px}
.ms-stat b{font-family:'Space Mono',monospace;font-size:18px;font-weight:900;color:#0F172A}
.ms-stat small{font-size:10px;font-weight:700;color:#94A3B8;letter-spacing:.5px;text-transform:uppercase}
.ms-stat-streak b{color:#7C3AED}
.ms-streak-hot{background:linear-gradient(135deg,#FCD34D,#FB923C);animation:msHotPulse 1s ease-in-out infinite alternate}
.ms-streak-hot b,.ms-streak-hot small{color:#7C2D12!important}
@keyframes msHotPulse{from{box-shadow:0 0 0 0 rgba(252,211,77,.6)}to{box-shadow:0 0 0 8px rgba(252,211,77,0)}}
.ms-combo{margin-left:auto;font-family:'Space Mono',monospace;font-weight:900;font-size:22px;color:#A855F7;letter-spacing:-.02em;animation:msPop .35s cubic-bezier(.2,1.5,.5,1)}
@keyframes msPop{from{transform:scale(.5) rotate(-8deg);opacity:0}to{transform:scale(1) rotate(0);opacity:1}}
.ms-time-track{height:6px;background:rgba(15,23,42,.06);border-radius:99px;overflow:hidden}
.ms-time-fill{height:100%;background:linear-gradient(90deg,#22D3EE,#34D399);border-radius:99px;transition:width .1s linear,background .3s ease}
.ms-problem-wrap{padding:18px 0;text-align:center}
.ms-problem{display:inline-flex;gap:14px;align-items:center;justify-content:center;font-family:'Space Mono',monospace;font-weight:900;font-size:46px;color:#0F172A;letter-spacing:-.03em;animation:msSlideIn .35s cubic-bezier(.2,1.4,.5,1)}
@keyframes msSlideIn{from{transform:translateX(40px) scale(.92);opacity:0}to{transform:translateX(0) scale(1);opacity:1}}
.ms-num{display:inline-block}
.ms-op{color:#7C3AED;font-size:38px}
.ms-eq{color:#94A3B8;font-size:38px;margin-left:4px}
.ms-q{color:#FB923C;font-size:46px;animation:msBlink 1.6s ease-in-out infinite}
@keyframes msBlink{0%,100%{opacity:1}50%{opacity:.5}}
.ms-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ms-choice{position:relative;padding:24px 14px;font-family:'Space Mono',monospace;font-size:30px;font-weight:900;background:#fff;border:2px solid #E2E8F0;border-radius:16px;color:#0F172A;cursor:pointer;font-family:inherit;font-weight:900;font-family:'Space Mono',monospace;transition:transform .12s cubic-bezier(.2,1.5,.5,1),background .15s ease,border-color .15s ease,box-shadow .15s ease;letter-spacing:-.02em}
.ms-choice:hover:not(:disabled){border-color:#7C3AED;background:#F5F3FF;transform:translateY(-2px);box-shadow:0 8px 22px rgba(124,58,237,.18)}
.ms-choice:active:not(:disabled){transform:scale(.96)}
.ms-choice-ok{background:linear-gradient(135deg,#34D399,#10B981)!important;border-color:#10B981!important;color:#fff!important;box-shadow:0 12px 30px rgba(16,185,129,.5)!important;animation:msChoiceOk .45s cubic-bezier(.2,1.6,.5,1)}
@keyframes msChoiceOk{0%{transform:scale(1)}40%{transform:scale(1.12)}100%{transform:scale(1.05)}}
.ms-choice-wrong{background:linear-gradient(135deg,#F87171,#DC2626)!important;border-color:#DC2626!important;color:#fff!important;animation:msShake .4s ease-in-out}
@keyframes msShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}50%{transform:translateX(6px)}75%{transform:translateX(-3px)}}
.ms-choice-fade{opacity:.4}
.ms-bolt{position:absolute;top:6px;right:9px;font-size:14px;animation:msBoltSpin .5s ease-out}
@keyframes msBoltSpin{from{transform:scale(.3) rotate(-180deg);opacity:0}to{transform:scale(1) rotate(0);opacity:1}}
.ms-fb{text-align:center;font-size:14.5px;font-weight:800;padding:11px;border-radius:11px;letter-spacing:-.005em}
.ms-fb-ok{background:#EDFCF2;color:#16A34A}
.ms-fb-bad{background:#FEF2F2;color:#DC2626}
.ms-bonus{text-align:center;font-size:18px;font-weight:900;background:linear-gradient(135deg,#FCD34D,#FB923C);color:#7C2D12;padding:12px;border-radius:12px;animation:msPop .4s cubic-bezier(.2,1.5,.5,1)}
.ms-particle{position:fixed;width:9px;height:9px;border-radius:50%;pointer-events:none;z-index:200;animation:msFly .9s cubic-bezier(.4,0,.6,1) forwards}
@keyframes msFly{0%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(.4);opacity:0}}
body[data-theme=aurora] .ms-body{background:#1A1A2E}
body[data-theme=aurora] .ms-problem,body[data-theme=aurora] .ms-stat b{color:#F5F5FA}
body[data-theme=aurora] .ms-choice{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .ms-choice:hover:not(:disabled){border-color:#A78BFA;background:rgba(167,139,250,.12)}
body[data-theme=aurora] .ms-time-track{background:rgba(255,255,255,.08)}
body[data-theme=aurora] .ms-stat{background:rgba(255,255,255,.06)}
/* Memory Tap canvas-game */
.mt-shell{padding:0;background:linear-gradient(180deg,#1E1B4B,#0F172A);border-radius:0 0 18px 18px;overflow:hidden;position:relative}
.mt-hud{display:flex;justify-content:space-between;align-items:center;padding:14px 18px 4px;background:transparent;color:rgba(255,255,255,.85);font-family:'Space Mono',monospace;font-size:12px;letter-spacing:1.2px;font-weight:700}
.mt-hud b{color:#FCD34D;font-size:18px;letter-spacing:-.02em;margin-left:6px}
.mt-canvas{display:block;width:100%;aspect-ratio:1/1;max-height:60vh;background:transparent;cursor:pointer;touch-action:manipulation}
.mt-end{text-align:center;padding:32px 22px 24px}
.mt-end-stars{display:flex;justify-content:center;gap:14px;margin-bottom:18px}
.mt-star{font-size:46px;color:rgba(15,23,42,.18);line-height:1;transition:transform .25s ease,color .25s ease}
.mt-star-on{color:#FCD34D;animation:mtStarPop .5s cubic-bezier(.2,1.6,.5,1) backwards}
.mt-star-on:nth-child(1){animation-delay:.05s}
.mt-star-on:nth-child(2){animation-delay:.18s}
.mt-star-on:nth-child(3){animation-delay:.32s}
@keyframes mtStarPop{0%{transform:scale(.3) rotate(-12deg);opacity:0}100%{transform:scale(1) rotate(0);opacity:1}}
.mt-end-t{font-size:22px;font-weight:800;color:#0F172A;margin-bottom:6px}
.mt-end-t b{color:#7C3AED;font-family:'Space Mono',monospace;font-size:24px}
.mt-end-s{font-size:13px;color:#64748B;margin-bottom:20px}
body[data-theme=aurora] .mt-end-t{color:#F5F5FA}body[data-theme=aurora] .mt-end-t b{color:#A78BFA}
body[data-theme=aurora] .mt-end-s{color:#9999B5}body[data-theme=aurora] .mt-star{color:rgba(255,255,255,.16)}
/* MIND GYM Daily Workout card + confetti */
.mg-daily{display:flex;align-items:center;gap:14px;padding:14px 16px;margin-bottom:14px;background:linear-gradient(135deg,#FCD34D 0%,#FB923C 100%);border-radius:14px;color:#0F172A;box-shadow:0 8px 22px rgba(252,211,77,.32)}
.mg-daily-l{flex:1;min-width:0}
.mg-daily-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:1.6px;color:rgba(15,23,42,.6);margin-bottom:4px}
.mg-daily-t{font-size:15px;font-weight:800;color:#0F172A;letter-spacing:-.005em;margin-bottom:8px;line-height:1.3}
.mg-daily-t s{color:rgba(15,23,42,.5)}
.mg-daily-pills{display:flex;gap:6px;flex-wrap:wrap}
.mg-daily-pill{font-size:11px;font-weight:700;padding:4px 9px;border-radius:7px;background:rgba(255,255,255,.55);color:#0F172A;letter-spacing:.005em}
.mg-daily-pill.mg-daily-done{background:rgba(15,23,42,.85);color:#FCD34D}
.mg-daily-btn{flex-shrink:0;background:#0F172A;color:#FCD34D;border:none;border-radius:11px;padding:13px 18px;font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit;letter-spacing:.005em;box-shadow:0 6px 18px rgba(15,23,42,.32);transition:transform .12s ease}
.mg-daily-btn:active{transform:scale(.96)}
.mg-daily-done-tag{flex-shrink:0;background:rgba(15,23,42,.85);color:#FCD34D;border-radius:11px;padding:11px 14px;font-weight:800;font-size:13px;letter-spacing:.005em;font-family:'Space Mono',monospace}
@media (max-width:600px){.mg-daily{flex-direction:column;align-items:stretch;text-align:center}.mg-daily-pills{justify-content:center}}
/* Confetti — pure CSS, triggers via .mg-confetti class on body for 1.5s */
.mg-confetti{position:fixed;inset:0;pointer-events:none;z-index:200;overflow:hidden}
.mg-confetti i{position:absolute;width:9px;height:14px;background:#FCD34D;top:-10px;animation:mgFall 1.5s ease-in forwards;opacity:0}
.mg-confetti i:nth-child(1){left:8%;background:#FCD34D;animation-delay:0s}
.mg-confetti i:nth-child(2){left:16%;background:#FB923C;animation-delay:.05s}
.mg-confetti i:nth-child(3){left:24%;background:#A855F7;animation-delay:.1s}
.mg-confetti i:nth-child(4){left:32%;background:#22D3EE;animation-delay:.04s}
.mg-confetti i:nth-child(5){left:40%;background:#34D399;animation-delay:.12s}
.mg-confetti i:nth-child(6){left:48%;background:#F472B6;animation-delay:.07s}
.mg-confetti i:nth-child(7){left:56%;background:#FCD34D;animation-delay:.15s}
.mg-confetti i:nth-child(8){left:64%;background:#FB923C;animation-delay:.02s}
.mg-confetti i:nth-child(9){left:72%;background:#A855F7;animation-delay:.18s}
.mg-confetti i:nth-child(10){left:80%;background:#22D3EE;animation-delay:.06s}
.mg-confetti i:nth-child(11){left:88%;background:#34D399;animation-delay:.13s}
.mg-confetti i:nth-child(12){left:92%;background:#F472B6;animation-delay:.09s}
@keyframes mgFall{0%{opacity:0;transform:translateY(0) rotate(0)}10%{opacity:1}100%{opacity:0;transform:translateY(110vh) rotate(720deg)}}
/* MIND GYM dedicated tab — hero + cards + value strip */
.mg-hero{position:relative;border-radius:20px;overflow:hidden;margin-bottom:18px;background:linear-gradient(135deg,#0F172A 0%,#312E81 50%,#5B21B6 100%);color:#fff;box-shadow:0 16px 40px rgba(15,23,42,.22)}
.mg-hero-grad{position:absolute;inset:0;background:radial-gradient(circle at 80% 0%,rgba(252,211,77,.18),transparent 60%),radial-gradient(circle at 0% 100%,rgba(167,139,250,.32),transparent 55%);pointer-events:none}
.mg-hero-inner{position:relative;padding:24px 22px;display:flex;flex-direction:column;gap:18px}
.mg-hero-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:2px;color:rgba(255,255,255,.7);margin-bottom:6px}
.mg-hero-t{margin:0;font-size:30px;font-weight:900;line-height:1.05;letter-spacing:-.025em;color:#fff}
.mg-hero-s{font-size:14px;color:rgba(255,255,255,.78);line-height:1.5;margin-top:8px;max-width:520px}
.mg-hero-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (min-width:600px){.mg-hero-inner{flex-direction:row;align-items:flex-end;gap:24px}.mg-hero-l{flex:1;min-width:0}.mg-hero-stats{flex:0 0 auto;grid-template-columns:repeat(4,minmax(74px,1fr));gap:12px}.mg-hero-t{font-size:38px}}
.mg-stat{padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:12px;backdrop-filter:saturate(140%) blur(6px);-webkit-backdrop-filter:saturate(140%) blur(6px);min-width:0}
.mg-stat b{display:block;font-family:'Space Mono',monospace;font-size:24px;font-weight:900;color:#FCD34D;letter-spacing:-.02em;line-height:1}
.mg-stat small{display:block;font-size:9.5px;font-weight:700;letter-spacing:.7px;color:rgba(255,255,255,.65);text-transform:uppercase;margin-top:5px}
.mg-stat-streak b{color:#FB923C}
.mg-grid-tab{grid-template-columns:repeat(1,minmax(0,1fr));gap:12px;margin-bottom:18px}
@media (min-width:600px){.mg-grid-tab{grid-template-columns:repeat(3,minmax(0,1fr))}}
.mg-grid-tab .mg-card{background:linear-gradient(135deg,#fff,#FAFAF7);color:#0F172A;border:1.5px solid #E2E8F0;min-height:180px;padding:18px}
.mg-grid-tab .mg-card-name{color:#0F172A}
.mg-grid-tab .mg-card-d{color:#64748B}
.mg-grid-tab .mg-bar{background:rgba(15,23,42,.06)}
.mg-grid-tab .mg-card-foot{color:#475569}
.mg-grid-tab .mg-card-foot b{color:#0F172A}
.mg-grid-tab .mg-card-lvl{background:rgba(99,102,241,.14);color:#6366F1}
.mg-grid-tab .mg-math{border-color:rgba(99,102,241,.32);background:linear-gradient(135deg,rgba(99,102,241,.08),#fff)}
.mg-grid-tab .mg-memory{border-color:rgba(236,72,153,.32);background:linear-gradient(135deg,rgba(236,72,153,.08),#fff)}
.mg-grid-tab .mg-reaction{border-color:rgba(245,158,11,.32);background:linear-gradient(135deg,rgba(245,158,11,.1),#fff)}
.mg-why{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:24px}
@media (min-width:600px){.mg-why{grid-template-columns:repeat(3,minmax(0,1fr))}}
.mg-why-card{display:flex;gap:12px;padding:14px;background:#FAFAF7;border:1px solid #E2E8F0;border-radius:14px;align-items:flex-start}
.mg-why-emoji{font-size:24px;line-height:1;flex-shrink:0}
.mg-why-t{font-weight:800;font-size:13.5px;color:#0F172A;letter-spacing:-.005em}
.mg-why-d{font-size:12px;color:#64748B;line-height:1.45;margin-top:3px}
body[data-theme=aurora] .mg-grid-tab .mg-card{background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(255,255,255,.02));color:#F5F5FA;border-color:rgba(255,255,255,.12)}
body[data-theme=aurora] .mg-grid-tab .mg-card-name,body[data-theme=aurora] .mg-grid-tab .mg-card-foot b{color:#F5F5FA}
body[data-theme=aurora] .mg-grid-tab .mg-card-d{color:#9999B5}
body[data-theme=aurora] .mg-why-card{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1)}
body[data-theme=aurora] .mg-why-t{color:#F5F5FA}
body[data-theme=aurora] .mg-why-d{color:#9999B5}
/* VOICE TRAINER */
.vc-hero{position:relative;border-radius:20px;overflow:hidden;margin-bottom:18px;background:linear-gradient(135deg,#0F172A 0%,#1E3A8A 50%,#0E7490 100%);color:#fff;box-shadow:0 16px 40px rgba(15,23,42,.22)}
.vc-hero::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 78% 100%,rgba(34,211,238,.28),transparent 55%),radial-gradient(circle at 10% 0%,rgba(252,211,77,.15),transparent 50%);pointer-events:none}
.vc-hero-inner{position:relative;padding:24px 22px;display:flex;flex-direction:column;gap:18px}
.vc-hero-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:2px;color:rgba(255,255,255,.74);margin-bottom:6px}
.vc-hero-t{margin:0;font-size:30px;font-weight:900;line-height:1.05;letter-spacing:-.025em;color:#fff}
.vc-hero-s{font-size:14px;color:rgba(255,255,255,.82);line-height:1.55;margin-top:8px;max-width:560px}
.vc-hero-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (min-width:600px){.vc-hero-inner{flex-direction:row;align-items:flex-end;gap:24px}.vc-hero-l{flex:1;min-width:0}.vc-hero-stats{flex:0 0 auto;grid-template-columns:repeat(4,minmax(74px,1fr));gap:12px}.vc-hero-t{font-size:38px}}
.vc-stat{padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:12px}
.vc-stat b{display:block;font-family:'Space Mono',monospace;font-size:24px;font-weight:900;color:#67E8F9;letter-spacing:-.02em;line-height:1}
.vc-stat b small{font-size:14px;color:rgba(103,232,249,.65)}
.vc-stat small{display:block;font-size:9.5px;font-weight:700;letter-spacing:.7px;color:rgba(255,255,255,.65);text-transform:uppercase;margin-top:5px}
.vc-phase{margin-bottom:18px}
.vc-phase-hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;padding:0 4px}
.vc-phase-t{margin:0;font-size:16px;font-weight:800;color:#0F172A;letter-spacing:-.005em}
.vc-phase-s{font-size:11.5px;color:#94A3B8;font-weight:600}
.vc-day-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
@media (min-width:600px){.vc-day-grid{grid-template-columns:repeat(10,minmax(0,1fr));gap:8px}}
.vc-day{aspect-ratio:1;background:#fff;border:1.5px solid #E2E8F0;border-radius:10px;cursor:pointer;font-family:'Space Mono',monospace;font-weight:800;font-size:13px;color:#475569;transition:transform .12s ease,border-color .12s ease,background .12s ease;position:relative;display:flex;align-items:center;justify-content:center}
.vc-day:hover{border-color:#0E7490;background:#F0FDFF;transform:translateY(-2px)}
.vc-day:active{transform:scale(.95)}
.vc-day-done{background:linear-gradient(135deg,#0E7490,#0891B2);border-color:#0891B2;color:#fff}
.vc-day-check{position:absolute;top:2px;right:3px;font-size:10px;color:#FCD34D}
.vc-day-num{position:relative;z-index:1}
body[data-theme=aurora] .vc-phase-t{color:#F5F5FA}
body[data-theme=aurora] .vc-day{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);color:#9999B5}
body[data-theme=aurora] .vc-day:hover{background:rgba(14,116,144,.2);border-color:#0E7490}
/* Voice lesson modal */
.vc-mdl{max-width:540px;padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:92vh}
.vc-mdl-hd{display:flex;align-items:center;gap:12px;padding:18px 18px 14px;background:linear-gradient(135deg,#0F172A,#0E7490);color:#fff;position:relative;flex-shrink:0}
.vc-mdl-hd > div:first-child{flex:1;min-width:0}
.vc-mdl-eyebrow{font-size:10px;font-weight:800;letter-spacing:1.6px;color:rgba(255,255,255,.7)}
.vc-mdl-t{margin:6px 0 0;font-size:18px;font-weight:900;color:#fff;letter-spacing:-.01em;line-height:1.2}
.vc-mdl-progress{height:3px;background:rgba(0,0,0,.05)}
.vc-mdl-progress-bar{height:100%;background:linear-gradient(90deg,#22D3EE,#0E7490);transition:width .35s cubic-bezier(.2,.8,.2,1)}
.vc-mdl-body{padding:18px;background:#fff;flex:1;overflow-y:auto}
.vc-coach{background:linear-gradient(135deg,#F0FDFF,#ECFEFF);border:1px solid #A5F3FC;border-radius:14px;padding:14px;margin-bottom:14px}
.vc-coach-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.vc-coach-emoji{font-size:24px;line-height:1}
.vc-coach-name{flex:1;font-weight:800;color:#0F172A;font-size:13.5px}
.vc-coach-name small{display:block;font-size:11px;font-weight:600;color:#0E7490;margin-top:1px}
.vc-coach-btn{background:#0E7490;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;flex-shrink:0}
.vc-coach-btn:hover{background:#0891B2}
.vc-coach-text{font-size:13.5px;line-height:1.55;color:#0F172A}
.vc-drill-card{background:#fff;border:1.5px solid #E2E8F0;border-radius:14px;padding:16px}
.vc-drill-meta{font-size:10.5px;font-weight:800;letter-spacing:1.5px;color:#94A3B8;text-transform:uppercase;margin-bottom:8px}
.vc-drill-text{font-size:24px;font-weight:800;color:#0F172A;letter-spacing:-.01em;line-height:1.3;margin-bottom:10px;font-family:'Instrument Serif',Georgia,serif;font-style:italic}
.vc-drill-tip{font-size:12px;color:#7C5A00;background:#FFFBF1;border:1px solid #F3D9A0;padding:8px 11px;border-radius:9px;margin-bottom:12px;line-height:1.45}
.vc-drill-row{display:flex;gap:10px}
.vc-drill-btn{flex:1;padding:13px;font-weight:800;font-size:13.5px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;transition:transform .1s ease,background .12s ease}
.vc-drill-listen{background:#F1F5F9;color:#0F172A;border:1.5px solid #E2E8F0}
.vc-drill-listen:hover{background:#E2E8F0}
.vc-drill-rec{background:linear-gradient(135deg,#DC2626,#991B1B);color:#fff;box-shadow:0 4px 12px rgba(220,38,38,.3)}
.vc-rec-on{animation:vcPulse 1s ease-in-out infinite}
@keyframes vcPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.5)}50%{box-shadow:0 0 0 12px rgba(220,38,38,0)}}
.vc-heard{margin-top:12px;font-size:13px;color:#475569;background:#F8FAFC;border:1px dashed #CBD5E1;padding:9px 12px;border-radius:9px;line-height:1.4}
.vc-score{margin-top:10px;text-align:center;font-size:14px;font-weight:700;padding:10px;border-radius:10px}
.vc-score b{font-family:'Space Mono',monospace;font-size:18px}
.vc-score-good{background:#EDFCF2;color:#16A34A}
.vc-score-ok{background:#FEF3C7;color:#B45309}
.vc-score-bad{background:#FEF2F2;color:#DC2626}
.vc-mdl-nav{display:flex;gap:10px;padding:14px 18px;border-top:1px solid #E2E8F0;background:#FAFAF7;flex-shrink:0}
.vc-mdl-nav .mb{flex:1;margin-top:0}
body[data-theme=aurora] .vc-mdl-body{background:#1A1A2E}
body[data-theme=aurora] .vc-coach{background:rgba(14,116,144,.1);border-color:rgba(34,211,238,.3)}
body[data-theme=aurora] .vc-coach-name,body[data-theme=aurora] .vc-coach-text,body[data-theme=aurora] .vc-drill-text{color:#F5F5FA}
body[data-theme=aurora] .vc-drill-card{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12)}
body[data-theme=aurora] .vc-mdl-nav{background:rgba(255,255,255,.02);border-color:rgba(255,255,255,.08)}
/* MIND GYM — header + 4-card grid */
.mg-sec{margin:24px 0 18px;padding:18px 16px;background:linear-gradient(135deg,#0F172A 0%,#312E81 60%,#5B21B6 100%);border-radius:18px;color:#fff;box-shadow:0 12px 32px rgba(15,23,42,.18);position:relative;overflow:hidden}
.mg-sec::before{content:'';position:absolute;top:-30%;right:-15%;width:300px;height:300px;background:radial-gradient(circle,rgba(167,139,250,.35),transparent 60%);pointer-events:none}
.mg-sec-hd{display:flex;align-items:center;gap:14px;margin-bottom:14px;position:relative}
.mg-sec-l{display:flex;align-items:center;gap:13px;flex:1;min-width:0}
.mg-sec-emoji{font-size:38px;line-height:1;flex-shrink:0;filter:drop-shadow(0 4px 10px rgba(0,0,0,.35))}
.mg-sec-t{margin:0;font-size:22px;font-weight:900;letter-spacing:-.02em;color:#fff;line-height:1.05}
.mg-sec-s{font-size:11.5px;color:rgba(255,255,255,.74);font-weight:500;margin-top:3px;letter-spacing:.005em}
.mg-sec-overall{flex-shrink:0;text-align:right}
.mg-sec-overall b{display:block;font-family:'Space Mono',monospace;font-size:30px;color:#FCD34D;line-height:1;letter-spacing:-.02em}
.mg-sec-overall small{font-size:10px;color:rgba(255,255,255,.65);font-weight:700;letter-spacing:.7px;text-transform:uppercase}
.mg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;position:relative}
@media (min-width:768px){.mg-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.mg-card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:13px 12px 12px;color:#fff;cursor:pointer;text-align:left;font-family:inherit;display:flex;flex-direction:column;gap:7px;transition:transform .15s ease,background .15s ease,box-shadow .2s ease;position:relative;overflow:hidden;backdrop-filter:saturate(140%) blur(6px);-webkit-backdrop-filter:saturate(140%) blur(6px)}
.mg-card:hover{background:rgba(255,255,255,.14);transform:translateY(-2px);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.mg-card:active{transform:translateY(0) scale(.98)}
.mg-math::after,.mg-memory::after,.mg-reaction::after,.mg-coin::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 20% 0%,rgba(255,255,255,.18),transparent 60%);z-index:0}
.mg-math{background:linear-gradient(135deg,rgba(99,102,241,.32),rgba(15,23,42,.4))}
.mg-memory{background:linear-gradient(135deg,rgba(236,72,153,.28),rgba(15,23,42,.4))}
.mg-reaction{background:linear-gradient(135deg,rgba(245,158,11,.32),rgba(15,23,42,.4))}
.mg-coin{background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(15,23,42,.4))}
.mg-card>*{position:relative;z-index:1}
.mg-card-hd{display:flex;align-items:center;gap:8px}
.mg-card-emoji{font-size:22px;line-height:1;flex-shrink:0}
.mg-card-name{flex:1;min-width:0;font-weight:900;font-size:14.5px;letter-spacing:-.01em;text-transform:uppercase;letter-spacing:.3px}
.mg-card-lvl{flex-shrink:0;font-family:'Space Mono',monospace;font-size:11px;font-weight:800;background:rgba(255,255,255,.18);color:#fff;padding:2px 8px;border-radius:7px;letter-spacing:.5px}
.mg-card-lvl-utility{background:rgba(255,255,255,.12);color:rgba(255,255,255,.7);font-size:9.5px}
.mg-card-d{font-size:11.5px;color:rgba(255,255,255,.78);line-height:1.3;font-weight:500}
.mg-bar{height:6px;background:rgba(255,255,255,.12);border-radius:99px;overflow:hidden}
.mg-bar-fill{height:100%;background:linear-gradient(90deg,#FCD34D,#FB923C);border-radius:99px;transition:width .4s cubic-bezier(.2,.8,.2,1);box-shadow:0 0 12px rgba(252,211,77,.45)}
.mg-card-foot{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:rgba(255,255,255,.7);font-weight:600}
.mg-card-foot b{color:#FCD34D;font-family:'Space Mono',monospace;font-size:11.5px}
.mg-coin-face{align-self:center;font-family:'Space Mono',monospace;font-size:36px;font-weight:900;color:#FCD34D;line-height:1;padding:6px 0}
/* Gameplay modal */
.mg-mdl{max-width:480px;padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:92vh}
.mg-hd{display:flex;align-items:center;gap:12px;padding:16px 18px 14px;background:linear-gradient(135deg,#0F172A,#5B21B6);color:#fff;position:relative;flex-shrink:0}
.mg-hd > div{flex:1;min-width:0}
.mg-t{margin:0;font-size:18px;font-weight:900;color:#fff;letter-spacing:-.01em}
.mg-s{font-size:12px;color:rgba(255,255,255,.78);margin-top:2px}
.mg-body{padding:18px;background:#fff;flex:1;overflow-y:auto}
.mg-progress{height:6px;background:#F1F5F9;border-radius:99px;overflow:hidden;margin-bottom:18px}
.mg-progress-bar{height:100%;background:linear-gradient(90deg,#6366F1,#A855F7);border-radius:99px;transition:width .35s cubic-bezier(.2,.8,.2,1)}
.mg-math-q{text-align:center;font-size:42px;font-weight:900;color:#0F172A;letter-spacing:-.02em;margin:18px 0 22px;font-family:'Space Mono',monospace}
.mg-math-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mg-choice{padding:18px;font-size:22px;font-weight:800;font-family:'Space Mono',monospace;background:#F8FAFC;border:2px solid #E2E8F0;border-radius:14px;color:#0F172A;cursor:pointer;font-family:inherit;font-weight:800;transition:transform .12s ease,border-color .12s ease,background .12s ease}
.mg-choice:hover:not(:disabled){border-color:#6366F1;background:#F5F7FF}
.mg-choice:active:not(:disabled){transform:scale(.97)}
.mg-choice-ok{background:#EDFCF2!important;border-color:#16A34A!important;color:#16A34A!important;animation:mgPulse .35s ease}
.mg-choice-wrong{background:#FEF2F2!important;border-color:#DC2626!important;color:#DC2626!important}
@keyframes mgPulse{0%{transform:scale(1)}50%{transform:scale(1.06)}100%{transform:scale(1)}}
.mg-feedback{margin-top:12px;text-align:center;font-size:14px;font-weight:700;padding:9px;border-radius:10px}
.mg-fb-ok{background:#EDFCF2;color:#16A34A}
.mg-fb-bad{background:#FEF2F2;color:#DC2626}
.mg-meta{margin-top:14px;text-align:center;font-size:13px;color:#64748B;font-weight:600}
.mg-meta b{color:#0F172A;font-family:'Space Mono',monospace}
.mg-end{text-align:center;padding:30px 18px}
.mg-end-emoji{font-size:64px;margin-bottom:12px}
.mg-end-t{font-size:24px;font-weight:900;color:#0F172A;margin-bottom:6px}
.mg-end-s{font-size:14px;color:#475569;margin-bottom:20px}
.mg-end .was-acts{margin-top:0}
.mg-mem-status{text-align:center;font-size:14.5px;font-weight:700;color:#0F172A;margin-bottom:14px;min-height:22px}
.mg-mem-grid{display:grid;gap:10px;margin-bottom:14px}
.mg-mem-tile{aspect-ratio:1;background:#F1F5F9;border:2px solid #E2E8F0;border-radius:14px;cursor:pointer;font-family:inherit;transition:background .12s ease,transform .1s ease,border-color .12s ease}
.mg-mem-tile:hover:not(:disabled){background:#E2E8F0}
.mg-mem-tile:active{transform:scale(.95)}
.mg-mem-lit{background:linear-gradient(135deg,#A855F7,#EC4899)!important;border-color:#A855F7!important;box-shadow:0 0 24px rgba(168,85,247,.55);animation:mgFlash .3s ease}
@keyframes mgFlash{0%{transform:scale(.95)}50%{transform:scale(1.04)}100%{transform:scale(1)}}
.mg-react-stage{height:280px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-weight:900;font-size:22px;text-align:center;padding:18px;transition:background .2s ease}
.mg-react-wait{background:linear-gradient(135deg,#DC2626,#991B1B)}
.mg-react-go{background:linear-gradient(135deg,#16A34A,#15803D);animation:mgReactPulse .6s ease infinite alternate}
.mg-react-early{background:linear-gradient(135deg,#7C2D12,#451A03);font-size:16px}
.mg-react-done{background:linear-gradient(135deg,#312E81,#5B21B6);cursor:default}
@keyframes mgReactPulse{from{box-shadow:0 0 0 rgba(34,197,94,0)}to{box-shadow:0 0 36px rgba(34,197,94,.7)}}
.mg-react-time{font-family:'Space Mono',monospace;font-size:64px;font-weight:900;letter-spacing:-.02em;color:#FCD34D}
.mg-react-time small{font-size:18px;font-weight:700;color:rgba(252,211,77,.7);margin-left:4px}
.mg-react-msg{margin-top:8px;font-size:18px;color:rgba(255,255,255,.95)}
body[data-theme=aurora] .mg-body{background:#1A1A2E}
body[data-theme=aurora] .mg-math-q{color:#F5F5FA}
body[data-theme=aurora] .mg-choice{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .mg-end-t{color:#F5F5FA}
body[data-theme=aurora] .mg-end-s{color:#9999B5}
body[data-theme=aurora] .mg-mem-status{color:#F5F5FA}
body[data-theme=aurora] .mg-mem-tile{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14)}
.games-row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:18px}
@media (min-width:768px){.games-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}
@media (min-width:1200px){.games-row{grid-template-columns:repeat(3,minmax(0,1fr))}}
.games-row > .game-card.mini-game{min-height:340px}
.rps-show{display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(99,102,241,.05);border-radius:12px;margin:8px 0}
.rps-show-empty{font-size:38px;letter-spacing:8px}
.rps-vs{display:flex;align-items:center;gap:24px}
.rps-emoji{font-size:48px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.rps-vs-txt{font-size:13px;color:#94A3B8;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
.rps-pick{display:flex;gap:8px;margin-top:10px}
.rps-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 6px;background:#fff;border:1.5px solid #E2E8F0;border-radius:12px;cursor:pointer;font-size:30px;font-family:inherit;color:#0F172A;transition:transform .12s ease,border-color .12s ease,background .12s ease}
.rps-btn:hover{border-color:#6366F1;background:#F5F7FF}
.rps-btn:active{transform:scale(.96)}
.rps-btn span{font-size:11.5px;font-weight:700;color:#475569;letter-spacing:.3px}
@keyframes diceRoll{0%{transform:rotate(0)}25%{transform:rotate(90deg)}50%{transform:rotate(180deg)}75%{transform:rotate(270deg)}100%{transform:rotate(360deg)}}
.dice-roll{animation:diceRoll .55s linear infinite}
body[data-theme=aurora] .rps-show{background:rgba(167,139,250,.1)}
body[data-theme=aurora] .rps-btn{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .rps-btn:hover{border-color:#A78BFA;background:rgba(167,139,250,.12)}
body[data-theme=aurora] .rps-btn span{color:#9999B5}
.game-card{background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(236,72,153,.05));border:1px solid rgba(99,102,241,.18);border-radius:16px;padding:18px 22px 20px;margin-bottom:0;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden;min-height:440px}
.coin-card{background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(99,102,241,.05));border-color:rgba(245,158,11,.22)}
.coin-stage{flex:1;display:flex;align-items:center;justify-content:center;perspective:800px}
.coin{width:140px;height:140px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#FCD34D,#B45309 80%);box-shadow:0 12px 28px rgba(180,83,9,.35),inset 0 -6px 14px rgba(0,0,0,.2),inset 0 6px 12px rgba(255,255,255,.4);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .25s cubic-bezier(.2,.8,.2,1);position:relative;transform-style:preserve-3d}
.coin:hover{transform:scale(1.05)}
.coin-face{font-size:62px;font-weight:900;color:#7C2D12;text-shadow:0 2px 4px rgba(255,255,255,.5);font-family:Georgia,serif}
.coin-flipping{animation:coinFlip .9s cubic-bezier(.4,0,.2,1) forwards}
@keyframes coinFlip{0%{transform:rotateY(0) translateY(0)}25%{transform:rotateY(540deg) translateY(-40px)}50%{transform:rotateY(1080deg) translateY(-60px)}75%{transform:rotateY(1620deg) translateY(-30px)}100%{transform:rotateY(2160deg) translateY(0)}}
.coin-heads{animation:coinSettle .35s ease-out}.coin-tails{animation:coinSettle .35s ease-out}
@keyframes coinSettle{0%{transform:scale(1.15)}100%{transform:scale(1)}}
.coin-btn{background:linear-gradient(135deg,#F59E0B,#B45309);color:#fff;border:none;padding:8px 16px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;letter-spacing:.02em}
.coin-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 14px rgba(180,83,9,.3)}
.coin-btn:disabled{opacity:.6;cursor:wait}
.game-card.game-idle .game-grid{opacity:.55;filter:saturate(.6);pointer-events:none}
.game-card.game-idle .game-status-line{opacity:.6}
.game-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(255,251,247,.85) 0%,rgba(254,243,231,.78) 100%);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);z-index:5;border-radius:16px;animation:overlayFade .25s ease-out}
@keyframes overlayFade{from{opacity:0}to{opacity:1}}
.game-overlay-inner{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:18px 24px;max-width:80%}
.game-overlay .game-prompt{font-size:14px;color:#475569;line-height:1.5;font-weight:500}
.game-overlay .game-btn{padding:12px 26px;font-size:14px;letter-spacing:.2px}
body[data-theme=aurora] .game-overlay{background:linear-gradient(135deg,rgba(20,20,40,.85),rgba(20,20,40,.78))}
body[data-theme=aurora] .game-overlay .game-prompt{color:#9999B5}
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
.game-grid{display:grid;grid-template-columns:repeat(3,96px);grid-template-rows:repeat(3,96px);gap:10px;width:max-content;margin:14px auto;justify-content:center}
@media (max-width:600px){.game-grid{grid-template-columns:repeat(3,80px);grid-template-rows:repeat(3,80px);gap:8px}}
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
.ttt-grid{}
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
@media (max-width:600px){.game-ttl{font-size:18px}.game-prompt{font-size:12px;min-width:0}.game-btn{padding:9px 16px;font-size:12.5px}}
/* Top strip + climb + side-now base styles (work on all viewports) */
.top-strip{display:flex;flex-direction:column;align-items:stretch;background:linear-gradient(135deg,rgba(99,102,241,.06) 0%,rgba(232,145,44,.06) 100%);border:1px solid rgba(99,102,241,.18);border-radius:12px;min-height:auto;position:relative;overflow:hidden;margin-bottom:0;box-shadow:0 2px 10px rgba(15,23,42,.04)}
.top-strip .climb-scene,.top-strip .bro-mascot{position:relative;flex:0 0 auto;border-radius:0;background:transparent;border:none;min-height:auto;overflow:hidden;padding:3px 10px 0;display:flex;align-items:center;justify-content:center;width:auto}
.top-strip .bro-svg{width:auto;height:auto;max-height:24px;max-width:80%}
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
.top-strip .side-now{flex:0 0 auto;background:transparent;border-top:1px dashed rgba(99,102,241,.18);border-left:none;padding:5px 12px 6px;display:flex;flex-direction:column;justify-content:center;gap:2px;position:relative;overflow:hidden;margin-top:0;min-width:0}
.top-strip .side-now-lbl{font-size:9px;font-weight:800;color:#6366F1;letter-spacing:1.2px;text-transform:uppercase}
.top-strip .side-now-time{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;color:#0F172A;line-height:1;letter-spacing:-.03em;margin-top:0}
.top-strip .side-now-time .sec{color:#E8453C;animation:secBlink 1s steps(2) infinite;font-size:15px;margin-left:1px;font-family:'Instrument Serif',Georgia,serif}
.top-strip .side-now-row{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;line-height:1}
.top-strip .side-now-sep{color:#CBD5E1;font-size:11px}
.top-strip .side-now-date{font-size:13px;color:#64748B;font-weight:600;font-style:italic;font-family:'Instrument Serif',Georgia,serif}
.top-strip .side-now-days{font-size:12.5px;color:#475569;font-weight:600}
.top-strip .side-now-days b{font-family:'Instrument Serif',Georgia,serif;color:#E8453C;font-weight:400;font-size:17px;letter-spacing:-.02em}
.top-strip .side-now-walker{position:absolute;top:50%;width:14px;height:18px;transform:translate(-50%,-58%);z-index:2;pointer-events:none;transition:left .8s ease-out}
.top-strip .side-now-walker svg{width:100%;height:100%;filter:drop-shadow(0 1px 2px rgba(15,23,42,.3))}
.top-strip .side-now-walker .snw-leg-l{transform-origin:7px 11px;animation:snwLegL .42s ease-in-out infinite}
.top-strip .side-now-walker .snw-leg-r{transform-origin:7px 11px;animation:snwLegR .42s ease-in-out infinite}
.top-strip .side-now-walker .snw-arm-l{transform-origin:7px 7px;animation:snwArmL .42s ease-in-out infinite}
.top-strip .side-now-walker .snw-arm-r{transform-origin:7px 7px;animation:snwArmR .42s ease-in-out infinite}
@keyframes snwLegL{0%,100%{transform:rotate(-25deg)}50%{transform:rotate(25deg)}}
@keyframes snwLegR{0%,100%{transform:rotate(25deg)}50%{transform:rotate(-25deg)}}
@keyframes snwArmL{0%,100%{transform:rotate(20deg)}50%{transform:rotate(-20deg)}}
@keyframes snwArmR{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(20deg)}}
body[data-theme=aurora] .top-strip .side-now-walker svg circle,body[data-theme=aurora] .top-strip .side-now-walker svg line{stroke:#A78BFA!important;fill:#A78BFA}
.top-strip .side-now-date{font-size:12px;color:#64748B;font-weight:600}
.top-strip .side-now-stat{font-size:10px;color:#475569;font-weight:600;margin-top:2px;display:flex;align-items:center;gap:4px}
.top-strip .side-now-stat b{font-family:'Instrument Serif',Georgia,serif;font-size:12px;font-weight:400;color:#E8453C;letter-spacing:-.02em;line-height:1}
.top-strip .side-now-date{font-size:10.5px}
.top-strip .side-now-bar{height:4px;border-radius:99px;background:rgba(99,102,241,.14);overflow:visible;margin:4px 0 2px;position:relative}
.top-strip .side-now-fill{height:100%;background:linear-gradient(90deg,#6366F1,#8B5CF6,#EC4899,#E8912C);background-size:200% 100%;border-radius:99px;position:relative;overflow:hidden;animation:gradientShift 4s ease-in-out infinite}
@keyframes gradientShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.top-strip .side-now-fill::after{content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:fillShine 2.6s ease-in-out infinite}
body[data-theme=aurora] .top-strip .side-now-days{color:#9999B5}
body[data-theme=aurora] .top-strip .side-now-days b{color:#F472B6}
body[data-theme=aurora] .top-strip .side-now-date{color:#9999B5}
.top-strip .side-now-foot{font-size:10px;color:#94A3B8;font-weight:700;letter-spacing:.5px;display:flex;justify-content:space-between;margin-top:0}
/* World clocks row inside the side-now panel */
.top-strip .side-now-cities{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:3px;font-size:10.5px;color:#475569;font-weight:600;line-height:1}
.top-strip .city-clock{display:inline-flex;align-items:baseline;gap:3px;font-family:'Space Mono',monospace;font-size:10.5px;color:#475569}
.top-strip .city-clock b{color:#6366F1;font-size:9px;font-weight:800;letter-spacing:.4px;font-family:'Inter',sans-serif}
.top-strip .city-sep{color:#CBD5E1;font-size:9px}
body[data-theme=aurora] .top-strip .side-now-cities{color:#9999B5}
body[data-theme=aurora] .top-strip .city-clock{color:#C4B5FD}
body[data-theme=aurora] .top-strip .city-clock b{color:#A78BFA}
/* News ticker — 3 stacked headlines below the moral chip, rotates every 9s */
.news-ticker-stack{flex:1;display:flex;flex-direction:column;gap:5px;background:linear-gradient(135deg,rgba(99,102,241,.04),rgba(236,72,153,.04));border:1px solid rgba(99,102,241,.14);border-radius:10px;padding:8px;overflow:hidden}
.news-ticker-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;background:rgba(255,255,255,.55);text-decoration:none;font-size:12px;line-height:1.3;transition:background .2s ease,transform .2s ease;opacity:0;animation:tickerRowIn .4s ease forwards}
.news-ticker-row:hover{background:rgba(255,255,255,.85);transform:translateX(2px)}
@keyframes tickerRowIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.news-ticker-pulse{width:6px;height:6px;border-radius:50%;background:#E8453C;flex-shrink:0;box-shadow:0 0 0 0 rgba(232,69,60,.6);animation:tickerLive 1.6s ease-in-out infinite}
@keyframes tickerLive{0%,100%{box-shadow:0 0 0 0 rgba(232,69,60,.6)}50%{box-shadow:0 0 0 5px rgba(232,69,60,0)}}
.news-ticker-src{font-size:9px;font-weight:800;color:#6366F1;letter-spacing:1.1px;text-transform:uppercase;flex-shrink:0;background:rgba(99,102,241,.1);padding:3px 6px;border-radius:5px;min-width:60px;text-align:center;display:inline-flex;align-items:center;justify-content:center}
.news-ticker-link{font-weight:600;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;transition:color .15s ease}
@media (max-width:1023px){.news-ticker-link{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}.news-ticker-row{align-items:flex-start;gap:10px}.news-ticker-stack{padding:10px;gap:7px}.news-ticker-src{min-width:64px;font-size:9.5px;align-self:flex-start;margin-top:2px}}
.news-ticker-row:hover .news-ticker-link{color:#6366F1}
body[data-theme=aurora] .news-ticker-stack{background:linear-gradient(135deg,rgba(167,139,250,.08),rgba(244,114,182,.06));border-color:rgba(167,139,250,.18)}
body[data-theme=aurora] .news-ticker-row{background:rgba(255,255,255,.04)}
body[data-theme=aurora] .news-ticker-row:hover{background:rgba(255,255,255,.08)}
body[data-theme=aurora] .news-ticker-link{color:#F5F5FA}
body[data-theme=aurora] .news-ticker-row:hover .news-ticker-link{color:#A78BFA}
body[data-theme=aurora] .news-ticker-src{color:#A78BFA;background:rgba(167,139,250,.16)}
/* Remember Someone Today — daily notable birth/death from Wikipedia */
.remember-card{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,rgba(232,145,44,.08),rgba(99,102,241,.06));border:1px solid rgba(232,145,44,.2);border-radius:10px;padding:8px 12px 8px 8px;text-decoration:none;color:inherit;transition:transform .2s ease,box-shadow .2s ease;animation:rememberIn .5s cubic-bezier(.2,.8,.2,1)}
@keyframes rememberIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.remember-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(232,145,44,.18)}
.remember-thumb{width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#FEF3E0;display:flex;align-items:center;justify-content:center;font-size:22px}
.remember-thumb.remember-thumb-empty{color:#B57B00}
.remember-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.remember-kicker{font-size:9.5px;font-weight:800;color:#B57B00;text-transform:uppercase;letter-spacing:1.2px;line-height:1.2}
.remember-kicker b{font-family:'Space Mono',monospace;color:#E8453C;font-weight:700;letter-spacing:.4px}
.remember-name{font-family:'Instrument Serif',Georgia,serif;font-size:16px;font-weight:400;color:#0F172A;line-height:1.15;letter-spacing:-.01em}
.remember-extract{font-size:11.5px;color:#475569;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:1px}
.remember-arrow{flex-shrink:0;color:#B57B00;opacity:.6;transition:opacity .15s ease}
.remember-card:hover .remember-arrow{opacity:1}
body[data-theme=aurora] .remember-card{background:linear-gradient(135deg,rgba(232,145,44,.14),rgba(167,139,250,.08));border-color:rgba(232,145,44,.3)}
body[data-theme=aurora] .remember-name{color:#F5F5FA}
body[data-theme=aurora] .remember-extract{color:#9999B5}
body[data-theme=aurora] .remember-thumb{background:rgba(255,255,255,.05)}
@media (max-width:600px){.remember-thumb{width:40px;height:40px}.remember-name{font-size:14.5px}.remember-extract{font-size:11px}}
/* World clocks — west-to-east horizon strip with sun/moon day-night indicator */
.world-clocks{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;background:linear-gradient(90deg,#0F172A 0%,#312E81 30%,#7C3AED 50%,#F59E0B 75%,#FCD34D 100%);background-size:200% 100%;animation:dayShift 60s ease-in-out infinite;border:1px solid rgba(99,102,241,.18);border-radius:10px;padding:8px;position:relative;overflow:hidden}
@keyframes dayShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.world-clocks::before{content:'';position:absolute;inset:0;background:rgba(255,255,255,.85);backdrop-filter:blur(2px);z-index:0}
.world-clocks .wc-item{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.1;padding:4px 0;border-radius:8px;background:rgba(255,255,255,.4);transition:transform .25s ease;opacity:0;animation:wcItemIn .4s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes wcItemIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.world-clocks .wc-item.wc-day{background:linear-gradient(180deg,rgba(254,243,199,.65),rgba(254,215,170,.45))}
.world-clocks .wc-item.wc-night{background:linear-gradient(180deg,rgba(91,33,182,.18),rgba(15,23,42,.18))}
.world-clocks .wc-item:hover{transform:translateY(-2px)}
.world-clocks .wc-icon-wrap{width:18px;height:18px;display:flex;align-items:center;justify-content:center}
.world-clocks .wc-icon{width:18px;height:18px;display:block}
.world-clocks .wc-sun{animation:wcSunSpin 20s linear infinite}
@keyframes wcSunSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.world-clocks .wc-moon{animation:wcMoonFloat 4s ease-in-out infinite}
@keyframes wcMoonFloat{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-1px) rotate(8deg)}}
.world-clocks .wc-star{animation:wcStarTwinkle 1.8s ease-in-out infinite}
.world-clocks .wc-star:nth-child(2){animation-delay:.6s}
@keyframes wcStarTwinkle{0%,100%{opacity:.3}50%{opacity:1}}
.world-clocks .wc-item b{font-size:9px;font-weight:800;color:#6366F1;letter-spacing:1.1px}
.world-clocks .wc-item.wc-night b{color:#7C3AED}
.world-clocks .wc-time{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:#0F172A;letter-spacing:-.02em}
.world-clocks .wc-temp{font-family:'Instrument Serif',Georgia,serif;font-size:13px;font-weight:400;color:#E8912B;letter-spacing:-.02em;margin-top:0}
body[data-theme=aurora] .world-clocks .wc-temp{color:#FCD34D}
/* Your Life Goal — editable card that fills the bottom of the left chip */
.life-goal{flex:1;display:flex;flex-direction:column;justify-content:flex-start;background:linear-gradient(135deg,rgba(99,102,241,.06),rgba(232,145,44,.05));border-top:1px dashed rgba(99,102,241,.22);padding:10px 12px 12px;cursor:pointer;transition:background .2s ease;position:relative;min-height:90px}
.life-goal:hover{background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(232,145,44,.08))}
.life-goal-empty{background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(232,145,44,.08));animation:lgEmptyPulse 3.6s ease-in-out infinite}
@keyframes lgEmptyPulse{0%,100%{box-shadow:inset 0 0 0 1px rgba(99,102,241,.2)}50%{box-shadow:inset 0 0 0 2px rgba(99,102,241,.45)}}
.life-goal .lg-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.life-goal .lg-label{font-size:9px;font-weight:800;color:#6366F1;letter-spacing:1.4px;text-transform:uppercase;display:inline-flex;align-items:center;gap:5px}
.life-goal .lg-star{color:#E8912C;font-size:11px;animation:lgStarPulse 3s ease-in-out infinite;display:inline-block}
@keyframes lgStarPulse{0%,100%{transform:scale(1) rotate(0);opacity:.85}50%{transform:scale(1.18) rotate(15deg);opacity:1}}
.life-goal .lg-edit-btn{display:inline-flex;align-items:center;gap:4px;background:rgba(99,102,241,.15);color:#6366F1;border:1px solid rgba(99,102,241,.3);border-radius:99px;padding:3px 9px 3px 7px;font-size:10px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;transition:background .15s ease,transform .15s ease;line-height:1}
.life-goal:hover .lg-edit-btn{background:#6366F1;color:#fff;border-color:#6366F1;transform:scale(1.04)}
.life-goal .lg-pencil{width:11px;height:11px;flex-shrink:0}
.life-goal-empty .lg-edit-btn{background:linear-gradient(135deg,#6366F1,#EC4899);color:#fff;border-color:transparent;animation:lgEditNudge 2.2s ease-in-out infinite;box-shadow:0 4px 12px rgba(99,102,241,.3)}
@keyframes lgEditNudge{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
.life-goal .lg-text{font-family:'Instrument Serif',Georgia,serif;font-size:15.5px;font-weight:400;color:#0F172A;line-height:1.4;letter-spacing:-.005em;font-style:italic;margin-top:6px;flex:1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;text-overflow:ellipsis}
.life-goal .lg-text.lg-empty{color:#64748B;font-style:italic}
.life-goal .lg-empty-hint{font-size:10px;color:#94A3B8;font-weight:600;text-align:center;margin-top:4px;font-style:italic}
body[data-theme=aurora] .life-goal{background:linear-gradient(135deg,rgba(167,139,250,.12),rgba(232,145,44,.06));border-top-color:rgba(167,139,250,.22)}
body[data-theme=aurora] .life-goal:hover{background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(232,145,44,.1))}
body[data-theme=aurora] .life-goal .lg-text{color:#F5F5FA}
body[data-theme=aurora] .life-goal .lg-text.lg-empty{color:#9999B5}
body[data-theme=aurora] .life-goal .lg-label{color:#A78BFA}
body[data-theme=aurora] .life-goal .lg-edit-btn{background:rgba(167,139,250,.18);color:#A78BFA;border-color:rgba(167,139,250,.35)}
body[data-theme=aurora] .life-goal:hover .lg-edit-btn{background:#A78BFA;color:#0A0A14;border-color:#A78BFA}
/* Indian cities mini-grid in the left chip — denser fonts to use the space */
.top-strip .india-cities{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 10px;margin-top:6px;padding-top:8px;border-top:1px dashed rgba(99,102,241,.18);line-height:1.2}
.top-strip .ic-item{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:2px 0}
.top-strip .ic-name{color:#475569;font-weight:500;font-style:italic;font-family:'Instrument Serif',Georgia,serif;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em}
.top-strip .ic-temp{font-family:'Instrument Serif',Georgia,serif;color:#E8912C;font-weight:400;font-size:14.5px;flex-shrink:0;letter-spacing:-.02em}
body[data-theme=aurora] .top-strip .india-cities{border-top-color:rgba(167,139,250,.22)}
body[data-theme=aurora] .top-strip .ic-name{color:#9999B5}
body[data-theme=aurora] .top-strip .ic-temp{color:#FCD34D}
body[data-theme=aurora] .world-clocks::before{background:rgba(20,20,40,.85)}
body[data-theme=aurora] .world-clocks .wc-item{background:rgba(255,255,255,.06)}
body[data-theme=aurora] .world-clocks .wc-item.wc-day{background:linear-gradient(180deg,rgba(252,211,77,.18),rgba(252,165,165,.12))}
body[data-theme=aurora] .world-clocks .wc-item.wc-night{background:linear-gradient(180deg,rgba(167,139,250,.18),rgba(15,23,42,.4))}
body[data-theme=aurora] .world-clocks .wc-item b{color:#A78BFA}
body[data-theme=aurora] .world-clocks .wc-item.wc-night b{color:#C4B5FD}
body[data-theme=aurora] .world-clocks .wc-time{color:#F5F5FA}
/* Mobile: hide world clocks entirely; only news is shown */
@media (max-width:1023px){.world-clocks{display:none}}
.top-strip .side-now-row-w{transition:opacity .15s ease;user-select:none}
.top-strip .side-now-row-w:hover{opacity:.85}
.top-strip .weather-pin{font-size:11px}
.top-strip .weather-city{font-size:12px;color:#475569;font-weight:600;font-family:'Instrument Serif',Georgia,serif;font-style:italic;border-bottom:1px dashed rgba(99,102,241,.4)}
.top-strip .weather-temp{font-size:12px;color:#475569;font-weight:600}
.top-strip .weather-temp b{font-family:'Instrument Serif',Georgia,serif;color:#E8912C;font-weight:400;font-size:15px;letter-spacing:-.02em}
.top-strip .weather-aqi{font-size:11px;color:#64748B;font-weight:600}
.top-strip .weather-aqi b{color:var(--aqi-c,#94A3B8);font-family:'Space Mono',monospace;font-weight:700;margin-left:1px;font-size:12px}
.top-strip .weather-loading{font-size:14px;color:#94A3B8;animation:secBlink 1s steps(2) infinite}
body[data-theme=aurora] .top-strip .weather-city{color:#9999B5;border-bottom-color:rgba(167,139,250,.3)}
body[data-theme=aurora] .top-strip .weather-temp{color:#9999B5}
body[data-theme=aurora] .top-strip .weather-temp b{color:#FCD34D}
body[data-theme=aurora] .top-strip .weather-aqi{color:#9999B5}
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
.moral{display:flex;align-items:center;gap:10px;background:linear-gradient(135deg,#FFFBF1 0%,#FEF3E0 50%,#EAF6EE 100%);border:1px solid #F3D9A0;border-radius:12px;padding:6px 12px;margin-bottom:0;position:relative;overflow:hidden;min-height:auto;box-shadow:0 2px 8px rgba(232,145,44,.05)}
.moral::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:linear-gradient(180deg,#E8912C,#3DAE5C);z-index:2}
.moral-doodle{position:absolute;top:0;right:0;bottom:0;width:42%;max-width:480px;height:100%;pointer-events:none;z-index:0;opacity:.95;filter:drop-shadow(0 1px 2px rgba(15,23,42,.05))}
.moral::after{content:'';position:absolute;top:0;left:0;bottom:0;width:58%;background:linear-gradient(90deg,rgba(255,251,241,.97) 0%,rgba(254,243,224,.75) 80%,rgba(254,243,224,0) 100%);pointer-events:none;z-index:0}
@media (max-width:700px){.moral-doodle{width:36%;opacity:.8}.moral::after{width:64%}.moral{min-height:auto;padding:8px 12px;gap:8px}.moral-txt{font-size:13px;line-height:1.35}.moral-by{font-size:11px;margin-top:1px}.moral-emoji{font-size:16px}.moral-lbl{font-size:9px}}
@media (max-width:480px){.moral-doodle{display:none}.moral::after{display:none}.moral-txt{font-size:12.5px}}
.bottom-strip{display:flex;flex-direction:column;gap:12px;margin-top:28px;padding-top:20px;border-top:1px solid var(--line)}
@media (min-width:1024px){.bottom-strip{grid-column:1/-1}}
/* Person-of-the-day card next to the BroDoit logo (desktop only) */
.hdr-remember{display:none}
@media (min-width:1024px){.hdr-remember{display:block;flex:1;max-width:540px;margin:0 18px}.hdr-remember .remember-card{margin:0;padding:8px 12px}.hdr-remember .remember-extract{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;color:#64748B;line-height:1.35;margin-top:2px}}
/* 3-headline floating top news — auto-fades each row in/out */
.top-news{display:flex;flex-direction:column;gap:8px;margin-top:10px}
/* Mobile: hide news + time chip up top so the task list is the focus.
   Placed AFTER the default display rules above so the cascade wins. */
@media (max-width:1023px){.top-news,.app .top-strip,.bottom-strip{display:none!important}}
.top-news-row{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:12px;background:var(--bg-elev,#fff);border:1px solid var(--line,#E2E8F0);text-decoration:none;color:inherit;font-size:14px;line-height:1.4;animation:topNewsFade 14s ease-in-out infinite;opacity:0}
.top-news-pulse{width:7px;height:7px;border-radius:50%;background:#3DAE5C;flex-shrink:0;box-shadow:0 0 0 0 rgba(61,174,92,.5);animation:topNewsPulse 2s ease-in-out infinite}
.top-news-src{font-size:10px;font-weight:800;color:#94A3B8;letter-spacing:.6px;text-transform:uppercase;flex-shrink:0}
.top-news-link{flex:1;min-width:0;color:var(--ink,#0F172A);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:700px){.top-news-row{padding:12px 14px;font-size:14.5px;align-items:flex-start}.top-news-link{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.35}}
@keyframes topNewsFade{0%,5%{opacity:0;transform:translateY(-4px)}10%,90%{opacity:1;transform:translateY(0)}95%,100%{opacity:0;transform:translateY(4px)}}
@keyframes topNewsPulse{0%,100%{box-shadow:0 0 0 0 rgba(61,174,92,.5)}50%{box-shadow:0 0 0 6px rgba(61,174,92,0)}}
body[data-theme=aurora] .moral::after{background:linear-gradient(90deg,rgba(20,20,40,.9) 0%,rgba(20,20,40,.65) 70%,rgba(20,20,40,0) 100%)}
.moral-emoji{font-size:16px;flex-shrink:0;filter:drop-shadow(0 1px 3px rgba(232,145,44,.3));position:relative;z-index:1}
.moral-body{flex:1;min-width:0;position:relative;z-index:1}
.moral-lbl{font-size:9px;font-weight:700;color:#B57B00;text-transform:uppercase;letter-spacing:1.1px}
.moral-txt{font-size:14px;line-height:1.35;color:#0F172A;font-weight:600;margin-top:2px;letter-spacing:-.1px}
.moral-by{font-size:11px;color:#94A3B8;margin-top:2px;font-style:italic;font-weight:500}
.moral-ref{width:22px;height:22px;border-radius:50%;background:#FFFFFF;color:#B57B00;font-size:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid #F3D9A0;transition:all .3s cubic-bezier(.4,1.5,.5,1);position:relative;z-index:1}
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
/* Mobile tab nav — substantially bigger, sticky at top, per-tab scenic photo backgrounds */
@media (max-width:1023px){
  .tabs.page-t{padding:8px;gap:8px;border-radius:18px;position:sticky;top:6px;z-index:30;backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);background:rgba(255,255,255,.94);border:1px solid rgba(15,23,42,.08);box-shadow:0 4px 18px rgba(15,23,42,.1)}
  .tabs.page-t .tab{padding:16px 16px;font-size:15px;border-radius:14px;gap:10px;min-height:56px;letter-spacing:-.01em;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  .tabs.page-t .tab .ti{font-size:22px;width:32px;height:32px;display:flex;align-items:center;justify-content:center}
  .tabs.page-t .tab .ti svg{width:24px!important;height:24px!important}
  .tabs.page-t .tab .tl{font-size:13.5px;font-weight:700;letter-spacing:.005em}
  .tabs.page-t .tab.on{transform:translateY(-2px);box-shadow:0 8px 22px rgba(45,42,38,.36),0 0 0 2px rgba(99,102,241,.5)}
}
/* International-app touch sizing for tabs on every mobile + tablet width below the desktop sidebar.
   Covers iPhones, iPads in portrait, foldables, large Android — anything <=1023px gets these. */
@media (max-width:1023px){
  .tabs.page-t{padding:10px !important;gap:10px !important;border-radius:22px !important}
  .tabs.page-t .tab{padding:20px 16px 16px !important;font-size:17px !important;gap:11px !important;min-height:96px !important;border-radius:18px !important}
  .tabs.page-t .tab .ti{font-size:34px !important;width:48px !important;height:48px !important}
  .tabs.page-t .tab .ti svg{width:36px !important;height:36px !important}
  .tabs.page-t .tab .tl{font-size:15px !important;font-weight:600 !important;letter-spacing:-.005em !important}
  .tabs.page-t .tab.on{box-shadow:0 8px 24px rgba(45,42,38,.36),0 0 0 3px rgba(99,102,241,.55) !important}
  /* Filter buttons (Tasks: All/Doing/Done, Mind Gym filter, etc.) also juiced up */
  .flt button.fb,.fb{padding:14px 18px !important;font-size:15px !important;min-height:48px !important;border-radius:14px !important}
  /* Add-bar button (the big "+ Add a new task" CTA) */
  .add-bar{padding:18px 18px !important}
  .add-bar .plus{font-size:34px !important;width:50px !important;height:50px !important}
  .add-bar .txt b{font-size:16px !important}
  .add-bar .txt small{font-size:13px !important}
  /* Section headers */
  .section-hd h3{font-size:20px !important}
  .section-hd p{font-size:13.5px !important}
  /* Stat cards */
  .stats .st b{font-size:24px !important}
  .stats .st small{font-size:11.5px !important}
  /* Books mode toggle (Summaries / Audiobooks) */
  .bk-mode-toggle button{padding:13px 22px !important;font-size:15px !important}
  /* Generic body buttons */
  .mb,button.mb{padding:14px 20px !important;font-size:15px !important;min-height:48px !important}
}
/* Even bigger on phones specifically */
@media (max-width:480px){
  .tabs.page-t .tab{padding:22px 18px 18px !important;min-height:104px !important}
  .tabs.page-t .tab .ti{font-size:38px !important;width:54px !important;height:54px !important}
  .tabs.page-t .tab .ti svg{width:40px !important;height:40px !important}
  .tabs.page-t .tab .tl{font-size:16px !important}
}
body[data-theme=aurora] .tabs.page-t{background:rgba(20,20,40,.85);border-color:rgba(167,139,250,.18)}
/* Desktop sidebar layout */
@media (min-width:1024px){
  .app{max-width:1440px;padding:12px 24px 40px;display:grid;grid-template-columns:220px 1fr;grid-template-areas:"hdr hdr" "side main";column-gap:22px;row-gap:6px;align-items:start}
  .app>.hdr{grid-area:hdr;margin-bottom:0}
  .app>.side-col{grid-area:side;display:flex;flex-direction:column;gap:14px;align-self:start}
  .app>.side-col>.tabs.page-t{margin:0;position:static}
  .app>.side-col>.top-strip{margin:0}
  .main-col>.moral-wrap{margin:0 0 14px;display:flex;flex-direction:column;gap:8px}
  .moral-wrap .moral{margin-bottom:0}
  .app .tabs.page-t{flex-direction:column;padding:8px;gap:4px;overflow:visible;margin-bottom:0;justify-content:flex-start}
  .app .tabs.page-t .tab{width:100%;flex:0 0 auto;min-height:50px;padding:8px 10px;font-size:13.5px;font-weight:600;justify-content:flex-start;border-radius:10px;gap:10px;align-items:center;border:none}
  .app .tabs.page-t .tab .ti{width:36px;height:36px;border-radius:9px;background-size:cover;background-position:center;background-color:#0F172A;background-repeat:no-repeat;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:0;transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease;position:relative;overflow:hidden;box-shadow:0 2px 6px rgba(15,23,42,.14)}
  .app .tabs.page-t .tab .ti::after{content:'';position:absolute;inset:0;background:var(--tab-tint,linear-gradient(135deg,rgba(99,102,241,.55),rgba(15,23,42,.35)));z-index:0;transition:opacity .2s ease}
  .app .tabs.page-t .tab .ti svg{width:18px!important;height:18px!important;position:relative;z-index:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));stroke-width:1.7!important}
  .app .tabs.page-t .tab .tl{font-size:13.5px;letter-spacing:-.01em}
  /* Each tab gets a distinct scenic background image */
  .app .tabs.page-t .tab.tab-tasks .ti{background-image:url("https://images.unsplash.com/photo-1499951360447-b19be8fe80f5?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-tasks{--tab-tint:linear-gradient(135deg,rgba(79,70,229,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-board .ti{background-image:url("https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-board{--tab-tint:linear-gradient(135deg,rgba(217,119,6,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-cal .ti{background-image:url("https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-cal{--tab-tint:linear-gradient(135deg,rgba(219,39,119,.5),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-news .ti{background-image:url("https://images.unsplash.com/photo-1495020689067-958852a7765e?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-news{--tab-tint:linear-gradient(135deg,rgba(13,148,136,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-books .ti{background-image:url("https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-books{--tab-tint:linear-gradient(135deg,rgba(5,150,105,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-meditation .ti{background-image:url("https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-meditation{--tab-tint:linear-gradient(135deg,rgba(124,58,237,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab.tab-knowledge .ti{background-image:url("https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=200&q=70&auto=format&fit=crop")}
  .app .tabs.page-t .tab.tab-knowledge{--tab-tint:linear-gradient(135deg,rgba(180,83,9,.55),rgba(15,23,42,.45))}
  .app .tabs.page-t .tab:hover:not(.on) .ti{transform:scale(1.06);box-shadow:0 8px 22px rgba(15,23,42,.24)}
  .app .tabs.page-t .tab.on .ti{box-shadow:0 8px 24px rgba(15,23,42,.32),0 0 0 3px var(--ring,rgba(255,255,255,.7))}
  .app .tabs.page-t .tab.on .ti::after{opacity:.45}
  .app .tabs.page-t .tab.tab-tasks.on{--ring:rgba(99,102,241,.85)}
  .app .tabs.page-t .tab.tab-board.on{--ring:rgba(232,145,44,.85)}
  .app .tabs.page-t .tab.tab-cal.on{--ring:rgba(236,72,153,.85)}
  .app .tabs.page-t .tab.tab-news.on{--ring:rgba(13,148,136,.85)}
  .app .tabs.page-t .tab.tab-books.on{--ring:rgba(5,150,105,.85)}
  .app .tabs.page-t .tab.tab-meditation.on{--ring:rgba(139,92,246,.85)}
  .app .tabs.page-t .tab.tab-knowledge.on{--ring:rgba(180,83,9,.85)}
  /* Active tab tile pulses softly */
  .app .tabs.page-t .tab.on .ti{animation:tilePulse 2.4s ease-in-out infinite}
  @keyframes tilePulse{0%,100%{box-shadow:0 8px 24px rgba(15,23,42,.32),0 0 0 3px var(--ring,rgba(255,255,255,.7))}50%{box-shadow:0 12px 30px rgba(15,23,42,.36),0 0 0 6px var(--ring,rgba(255,255,255,.4))}}
  /* Hover shimmer across tile */
  .app .tabs.page-t .tab .ti::before{content:'';position:absolute;top:0;left:-60%;width:50%;height:100%;background:linear-gradient(120deg,transparent 0%,rgba(255,255,255,.45) 50%,transparent 100%);transform:skewX(-20deg);z-index:2;transition:left .6s ease;pointer-events:none}
  .app .tabs.page-t .tab:hover .ti::before{left:120%}
  /* Sidebar footer "now" panel — fills the bottom blank space */
  .app .tabs.page-t .side-now{margin-top:auto;background:linear-gradient(135deg,rgba(99,102,241,.08),rgba(232,145,44,.08));border:1px solid rgba(99,102,241,.18);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden}
  .app .tabs.page-t .side-now-lbl{font-size:10px;font-weight:800;color:#6366F1;letter-spacing:1.4px;text-transform:uppercase}
  .app .tabs.page-t .side-now-time{font-family:'Instrument Serif',Georgia,serif;font-size:30px;font-weight:400;color:#0F172A;line-height:1;letter-spacing:-.03em;margin-top:2px}
  .app .tabs.page-t .side-now-time .sec{color:#E8453C;animation:secBlink 1s steps(2) infinite;font-size:18px;margin-left:2px;display:inline-block;vertical-align:top;margin-top:6px}
  @keyframes secBlink{50%{opacity:.35}}
  .app .tabs.page-t .side-now-date{font-size:12px;color:#64748B;font-weight:600}
  .app .tabs.page-t .side-now-bar{height:6px;border-radius:99px;background:rgba(99,102,241,.14);overflow:hidden;margin-top:8px;position:relative}
  .app .tabs.page-t .side-now-fill{height:100%;background:linear-gradient(90deg,#6366F1,#E8912C);border-radius:99px;transition:width .4s ease;position:relative;overflow:hidden}
  .app .tabs.page-t .side-now-fill::after{content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:fillShine 2.6s ease-in-out infinite}
  @keyframes fillShine{0%{left:-30%}100%{left:130%}}
  .app .tabs.page-t .side-now-foot{font-size:10px;color:#94A3B8;font-weight:700;letter-spacing:.6px;display:flex;justify-content:space-between;margin-top:2px}
  .app .tabs.page-t .side-now-wave{position:absolute;bottom:0;left:0;right:0;height:30px;opacity:.15;pointer-events:none}
  /* Top strip — wide horizontal banner with the climb scene + live time at the very top */
  /* Climb scene — stick figures climbing stairs, fills the visible blank space */
  .app .tabs.page-t .climb-scene{position:relative;width:100%;height:170px;border-radius:14px;background:linear-gradient(180deg,rgba(99,102,241,.04) 0%,rgba(232,145,44,.06) 100%);border:1px dashed rgba(99,102,241,.22);overflow:hidden;flex-shrink:0;margin-top:auto}
  .app .tabs.page-t .side-now{margin-top:0!important}
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
  body[data-theme=aurora] .app .tabs.page-t .climb-scene{background:linear-gradient(180deg,rgba(167,139,250,.06) 0%,rgba(232,145,44,.05) 100%);border-color:rgba(167,139,250,.2)}
  body[data-theme=aurora] .climb-caption{color:#A78BFA}
  body[data-theme=aurora] .app .tabs.page-t .side-now{background:linear-gradient(135deg,rgba(167,139,250,.12),rgba(232,145,44,.08));border-color:rgba(167,139,250,.2)}
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
  body[data-theme=aurora] .app .tabs.page-t .side-now-time{color:#F5F5FA}
  body[data-theme=aurora] .app .tabs.page-t .side-now-date{color:#9999B5}
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
@media (max-width:600px){.tab-hero{height:72px;padding:10px 14px;border-radius:12px;margin-bottom:10px}.tab-hero-h{font-size:16px;margin:0;line-height:1.2}.tab-hero-s{font-size:11px;margin-top:2px;opacity:.85}.tab-hero-particles{display:none}}
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
body:not([data-theme=aurora]) .add-bar .txt small{color:var(--ink-3)}
/* Keep the green gradient + visible — the editorial overrides above were making it transparent white */
body:not([data-theme=aurora]) .add-bar .plus{background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;box-shadow:0 3px 10px rgba(61,174,92,.4)}
body:not([data-theme=aurora]) .fab{background:linear-gradient(135deg,#3DAE5C,#2D8A4E);color:#fff;box-shadow:0 10px 26px rgba(61,174,92,.45),0 4px 14px rgba(15,23,42,.18)}
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
/* MOBILE BOTTOM TAB BAR with photo tiles + visible labels */
/* ============================================== */
@media (max-width:1023px){
  .app{padding-bottom:calc(108px + env(safe-area-inset-bottom))}
  .tabs.page-t{position:fixed;bottom:0;left:0;right:0;top:auto;padding:8px 6px calc(8px + env(safe-area-inset-bottom));margin:0;border-radius:0;border:none;border-top:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.94);backdrop-filter:saturate(160%) blur(20px);-webkit-backdrop-filter:saturate(160%) blur(20px);z-index:60;flex-direction:row;gap:2px;justify-content:space-between;box-shadow:0 -4px 20px rgba(15,23,42,.06);overflow-x:auto;overflow-y:visible;scrollbar-width:none;max-height:none;align-items:stretch}
  .tabs.page-t::-webkit-scrollbar{display:none}
  body[data-theme=aurora] .tabs.page-t{background:rgba(14,14,28,.92);border-top-color:rgba(255,255,255,.08)}
  .tabs.page-t .tab{flex:1 1 0;flex-direction:column;padding:6px 4px 4px;min-width:64px;gap:3px;border-radius:12px;font-size:11px;font-weight:700;position:relative;transform:none;background:transparent;border:none;align-items:center;animation:tabFadeIn .35s cubic-bezier(.2,.8,.2,1) backwards}
  @keyframes tabFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .tabs.page-t .tab:nth-child(1){animation-delay:0s}
  .tabs.page-t .tab:nth-child(2){animation-delay:.04s}
  .tabs.page-t .tab:nth-child(3){animation-delay:.08s}
  .tabs.page-t .tab:nth-child(4){animation-delay:.12s}
  .tabs.page-t .tab:nth-child(5){animation-delay:.16s}
  .tabs.page-t .tab:nth-child(6){animation-delay:.2s}
  .tabs.page-t .tab .ti{width:38px;height:38px;border-radius:10px;background-size:cover;background-position:center;background-color:#0F172A;background-repeat:no-repeat;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.18);transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease;font-size:0;margin:0}
  .tabs.page-t .tab .ti::after{content:'';position:absolute;inset:0;background:var(--tab-tint,linear-gradient(135deg,rgba(99,102,241,.55),rgba(15,23,42,.35)));z-index:0;transition:opacity .2s ease}
  .tabs.page-t .tab .ti svg{width:20px!important;height:20px!important;position:relative;z-index:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));stroke-width:1.7!important}
  /* Per-tab background photos */
  .tabs.page-t .tab.tab-tasks .ti{background-image:url("https://images.unsplash.com/photo-1499951360447-b19be8fe80f5?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-tasks{--tab-tint:linear-gradient(135deg,rgba(79,70,229,.55),rgba(15,23,42,.45))}
  .tabs.page-t .tab.tab-board .ti{background-image:url("https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-board{--tab-tint:linear-gradient(135deg,rgba(217,119,6,.55),rgba(15,23,42,.45))}
  .tabs.page-t .tab.tab-cal .ti{background-image:url("https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-cal{--tab-tint:linear-gradient(135deg,rgba(219,39,119,.5),rgba(15,23,42,.45))}
  .tabs.page-t .tab.tab-news .ti{background-image:url("https://images.unsplash.com/photo-1495020689067-958852a7765e?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-news{--tab-tint:linear-gradient(135deg,rgba(13,148,136,.55),rgba(15,23,42,.45))}
  .tabs.page-t .tab.tab-books .ti{background-image:url("https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-books{--tab-tint:linear-gradient(135deg,rgba(5,150,105,.55),rgba(15,23,42,.45))}
  .tabs.page-t .tab.tab-meditation .ti{background-image:url("https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=200&q=70&auto=format&fit=crop")}
  .tabs.page-t .tab.tab-meditation{--tab-tint:linear-gradient(135deg,rgba(124,58,237,.55),rgba(15,23,42,.45))}
  /* Active state */
  .tabs.page-t .tab.on{background:transparent!important;color:#6366F1!important;transform:none!important;box-shadow:none!important}
  body[data-theme=aurora] .tabs.page-t .tab.on{color:#A78BFA!important;background:transparent!important}
  .tabs.page-t .tab.on .ti{transform:translateY(-2px) scale(1.1);box-shadow:0 6px 14px rgba(15,23,42,.25),0 0 0 2.5px var(--ring,rgba(99,102,241,.9))}
  .tabs.page-t .tab.on .ti::after{opacity:.4}
  .tabs.page-t .tab.tab-tasks.on{--ring:rgba(99,102,241,.9)}
  .tabs.page-t .tab.tab-board.on{--ring:rgba(232,145,44,.9)}
  .tabs.page-t .tab.tab-cal.on{--ring:rgba(236,72,153,.9)}
  .tabs.page-t .tab.tab-news.on{--ring:rgba(13,148,136,.9)}
  .tabs.page-t .tab.tab-books.on{--ring:rgba(5,150,105,.9)}
  .tabs.page-t .tab.tab-meditation.on{--ring:rgba(139,92,246,.9)}
  /* Top indicator pill on the active tab */
  .tabs.page-t .tab.on::before{content:'';position:absolute;top:-9px;left:32%;right:32%;height:3px;border-radius:0 0 4px 4px;background:linear-gradient(90deg,#6366F1,#EC4899);animation:tabIndicator .3s cubic-bezier(.2,.8,.2,1)}
  body[data-theme=aurora] .tabs.page-t .tab.on::before{background:linear-gradient(90deg,#A78BFA,#F472B6)}
  @keyframes tabIndicator{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  /* Visible label below each photo tile */
  .tabs.page-t .tab .tl{font-size:11px;line-height:1.1;letter-spacing:.05px;margin-top:4px;opacity:.95;font-weight:700;text-align:center;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  body[data-theme=aurora] .tabs.page-t .tab .tl{color:#E8E8F4}
  .tabs.page-t .tab.on .tl{color:#6366F1;font-weight:800}
  body[data-theme=aurora] .tabs.page-t .tab.on .tl{color:#A78BFA}
  .tabs.page-t .tab:hover:not(.on) .ti{transform:scale(1.04)}
  /* FAB sits above the bottom tab bar */
  .fab{bottom:calc(108px + env(safe-area-inset-bottom));right:18px;width:60px;height:60px;font-size:30px;z-index:100;display:flex!important;position:fixed!important}
  .player{bottom:calc(96px + env(safe-area-inset-bottom))}
}
@media (max-width:380px){
  .tabs.page-t .tab{min-width:56px;padding:5px 2px 3px}
  .tabs.page-t .tab .ti{width:34px;height:34px;border-radius:9px}
  .tabs.page-t .tab .ti svg{width:18px!important;height:18px!important}
  .tabs.page-t .tab .tl{font-size:10px}
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

.hdr-actions{display:flex;align-items:center;gap:8px}
.hdr-profile{display:inline-flex;align-items:center;gap:7px;padding:7px 12px 7px 9px;border-radius:99px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);color:#0F172A;font-size:13px;font-weight:600;cursor:pointer;transition:transform .15s ease,background .15s ease;font-family:inherit}
.hdr-profile:hover{background:rgba(99,102,241,.14);transform:translateY(-1px)}
.hdr-profile svg{color:#6366F1}
.hdr-profile-name{font-size:13px;letter-spacing:-.01em}
@media (max-width:600px){.hdr-profile-name{display:none}.hdr-profile{padding:7px 8px}}
body[data-theme=aurora] .hdr-profile{background:rgba(167,139,250,.14);border-color:rgba(167,139,250,.3);color:#F5F5FA}
body[data-theme=aurora] .hdr-profile svg{color:#A78BFA}
.hdr-help{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(232,145,44,.1));border:1px solid rgba(99,102,241,.25);color:#6366F1;font-weight:800;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;transition:transform .15s ease,background .15s ease}
.hdr-help:hover{background:linear-gradient(135deg,rgba(99,102,241,.2),rgba(232,145,44,.16));transform:translateY(-1px)}
body[data-theme=aurora] .hdr-help{background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(232,145,44,.12));border-color:rgba(167,139,250,.35);color:#A78BFA}
/* HELP modal — full step-by-step guide */
.help-mdl{max-width:560px;padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:90vh}
.help-hd{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;background:linear-gradient(135deg,#0F172A,#312E81);color:#fff;position:relative;flex-shrink:0}
.help-hd > div{flex:1;min-width:0}
.help-t{margin:0;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.01em}
.help-s{font-size:12.5px;color:rgba(255,255,255,.78);margin-top:3px}
.help-x{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.18);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:14px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;font-family:inherit}
.help-x:hover{background:rgba(255,255,255,.28)}
.help-body{flex:1;overflow-y:auto;padding:18px 20px 12px;background:#fff}
.help-sec{margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid #F1F5F9}
.help-sec:last-child{border-bottom:none;margin-bottom:0}
.help-sec-hd{display:flex;align-items:center;gap:11px;margin-bottom:10px}
.help-sec-num{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:14px;font-family:'Space Mono',monospace;box-shadow:0 3px 10px rgba(99,102,241,.3)}
.help-sec-t{margin:0;font-size:17px;font-weight:800;color:#0F172A;letter-spacing:-.01em}
.help-list{padding-left:22px;margin:0;display:flex;flex-direction:column;gap:8px}
.help-list li{font-size:14.5px;line-height:1.55;color:#1F2937}
.help-list li b{color:#0F172A}
.help-sublist{padding-left:18px;margin:6px 0 0;display:flex;flex-direction:column;gap:5px}
.help-sublist li{font-size:13.5px;color:#475569}
.help-callout{background:linear-gradient(135deg,#FFFBF1,#FEF3E0);border:1px solid #F3D9A0;border-radius:10px;padding:11px 13px;margin-bottom:12px;font-size:13.5px;line-height:1.55;color:#5D4400}
.help-callout b{color:#7C5A00}
.help-foot{padding:14px 20px;border-top:1px solid #E2E8F0;background:#FAFAF7;display:flex;justify-content:flex-end;flex-shrink:0}
.help-foot .mb{padding:11px 22px;font-size:14px}
@media (max-width:600px){.help-mdl{max-height:94vh;border-radius:16px 16px 0 0}.help-hd{padding:16px 16px 12px}.help-t{font-size:18px}.help-body{padding:14px 16px 10px}.help-sec{margin-bottom:18px;padding-bottom:14px}.help-sec-t{font-size:16px}.help-list li{font-size:14px}.help-foot{padding:12px 16px}}
body[data-theme=aurora] .help-mdl{background:#1A1A2E}
body[data-theme=aurora] .help-body,body[data-theme=aurora] .help-foot{background:rgba(255,255,255,.02)}
body[data-theme=aurora] .help-sec{border-bottom-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .help-sec-t,body[data-theme=aurora] .help-list li b{color:#F5F5FA}
body[data-theme=aurora] .help-list li{color:#C7C7D6}
body[data-theme=aurora] .help-sublist li{color:#9999B5}
body[data-theme=aurora] .help-callout{background:rgba(245,214,135,.08);border-color:rgba(245,214,135,.25);color:#F5D687}
body[data-theme=aurora] .help-callout b{color:#FCD34D}
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
.tc-added{font-size:10.5px;color:#94A3B8;font-weight:500;background:rgba(15,23,42,.04);padding:2px 7px;border-radius:6px;letter-spacing:.1px}
body[data-theme=aurora] .tc-added{color:#6B6B85;background:rgba(255,255,255,.04)}
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
.login{max-width:520px;margin:0 auto;padding:48px 32px 56px;text-align:center;min-height:100vh;display:flex;flex-direction:column;justify-content:center;gap:0}
@media (min-width:1024px){.login{max-width:560px;padding:64px 40px 72px}}
.hero-photo{position:relative;width:100%;aspect-ratio:5/3;border-radius:14px;overflow:hidden;margin-bottom:32px;background:var(--bg-sunken);box-shadow:var(--shadow-2)}
.hero-photo img{width:100%;height:100%;object-fit:cover;display:block;animation:photoFade .9s ease}
.hero-photo-overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 60%,rgba(0,0,0,.18) 100%);pointer-events:none}
@keyframes photoFade{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}
.login-logo{font-family:'Instrument Serif',Georgia,serif;font-size:56px;font-weight:400;margin-bottom:8px;letter-spacing:-1.8px;color:var(--ink);line-height:1}
.login-tagline{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:20px;color:var(--ink-3);margin-bottom:24px;letter-spacing:.01em}
.login-sub{font-size:16px;color:var(--ink-3);margin-bottom:32px;line-height:1.6;font-weight:450;max-width:420px;margin-left:auto;margin-right:auto}
@media (min-width:1024px){.login-logo{font-size:72px;letter-spacing:-2.2px}.login-tagline{font-size:22px;margin-bottom:32px}.login-sub{font-size:17px;margin-bottom:36px}}
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
.login-btn{width:100%;padding:16px;font-size:16px;border-radius:12px;font-weight:600;background:var(--ink);color:#FAFAF7;border:none;margin-top:8px;letter-spacing:-.005em;transition:background .15s ease,transform .1s ease}
@media (min-width:1024px){.login-btn{padding:18px;font-size:17px}}
.login-btn:hover{background:#000}
.login-btn:active{transform:scale(.99)}
.login-btn:disabled{opacity:.5;cursor:not-allowed}
.login-btn.sec{background:transparent;border:1px solid var(--line-2);color:var(--ink-2);margin-top:8px}
.login-btn.sec:hover{background:var(--bg-sunken);border-color:var(--ink-4)}
.login-hint{font-size:12px;color:#94A3B8;margin-top:16px;line-height:1.5}
.login-wa-note{margin-top:14px;padding:11px 13px;background:linear-gradient(135deg,rgba(37,211,102,.08),rgba(18,140,126,.05));border:1px solid rgba(37,211,102,.22);border-radius:10px;font-size:12px;color:#1A6035;text-align:left;display:flex;align-items:flex-start;gap:9px;line-height:1.45}
.login-wa-emoji{font-size:18px;line-height:1.1;flex-shrink:0}
body[data-theme=aurora] .login-wa-note{background:linear-gradient(135deg,rgba(37,211,102,.1),rgba(18,140,126,.06));border-color:rgba(37,211,102,.25);color:#A8E6BC}
/* Dedicated WhatsApp Setup modal — clean, focused, no profile clutter */
.was-mdl{max-width:460px;padding:0;overflow:hidden}
.ov-locked{cursor:default}/* overlay tap doesn't dismiss — explicit X only */
.was-progress{height:3px;background:rgba(0,0,0,.06);position:relative;overflow:hidden}
.was-progress-bar{height:100%;background:linear-gradient(90deg,#25D366,#128C7E);transition:width .35s cubic-bezier(.2,.8,.2,1)}
.was-body{padding:18px;background:#fff}
.was-card-t{font-weight:800;font-size:15.5px;color:#0F172A;margin:0 0 4px;letter-spacing:-.01em}
.was-card-d{font-size:12.5px;color:#475569;line-height:1.55;margin:0 0 14px}
.was-helper{margin:0 0 16px;padding:12px 14px;background:#FFF8E1;border:1px solid #F5D687;border-radius:10px}
.was-helper-t{font-weight:800;font-size:13px;color:#7C5A00;margin-bottom:4px}
.was-helper-d{font-size:12px;color:#5D4400;line-height:1.5;margin-bottom:10px}
.was-helper-acts{display:flex;gap:8px;flex-wrap:wrap}
.was-helper-acts .was-jb{flex:1;width:auto}
.was-helper-acts .was-skip{flex:0 0 auto;margin-top:0;padding:10px 12px;width:auto;background:#fff;border:1px solid #E2E8F0;border-radius:8px;color:#64748B}
.was-resend{display:block;width:100%;margin-top:14px;background:transparent;border:none;color:#128C7E;font-size:13px;font-weight:700;cursor:pointer;padding:10px;font-family:inherit;border-top:1px dashed #E2E8F0}
.was-resend:hover{background:#F8FAFC}
.was-hd{display:flex;align-items:center;gap:12px;padding:18px 18px 14px;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;position:relative}
.was-emoji{font-size:30px;line-height:1;flex-shrink:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2))}
.was-t{margin:0;font-size:18px;font-weight:800;color:#fff;letter-spacing:-.01em}
.was-s{font-size:12px;color:rgba(255,255,255,.85);font-weight:500;margin-top:2px}
.was-x{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.18);border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:14px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;font-family:inherit}
.was-x:hover{background:rgba(255,255,255,.28)}
.was-step{display:flex;gap:14px;padding:16px 18px;background:#fff;border-bottom:1px solid #F1F5F9}
.was-step:last-child{border-bottom:none}
.was-step-n{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:#25D366;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:14px;font-family:'Space Mono',monospace;box-shadow:0 3px 8px rgba(37,211,102,.3)}
.was-step-n.was-step-done{background:#94A3B8;box-shadow:none;font-size:16px}
.was-step-b{flex:1;min-width:0}
.was-step-t{font-weight:700;font-size:14.5px;color:#0F172A;margin-bottom:5px;letter-spacing:-.01em}
.was-step-d{font-size:13px;color:#475569;line-height:1.55;margin-bottom:12px}
.was-jb{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;border:none;border-radius:10px;padding:12px 16px;font-weight:700;font-size:13.5px;cursor:pointer;box-shadow:0 4px 14px rgba(37,211,102,.32);width:100%;justify-content:center;font-family:inherit;transition:transform .12s ease}
.was-jb:active{transform:scale(.98)}
.was-jb svg{width:16px;height:16px;fill:#fff}
.was-skip{display:block;width:100%;margin-top:10px;background:transparent;border:none;color:#64748B;font-size:12.5px;font-weight:600;cursor:pointer;padding:8px 0;font-family:inherit}
.was-skip:hover{color:#0F172A;text-decoration:underline}
.was-mini{margin:14px 18px 0;padding:9px 12px;background:#EDFCF2;border:1px solid #B7E8C4;border-radius:9px;font-size:12px;color:#1A6035;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.was-mini-reset{background:transparent;border:none;color:#6366F1;font-size:11.5px;font-weight:600;text-decoration:underline;cursor:pointer;padding:0;margin-left:auto;font-family:inherit}
.was-row{display:flex;gap:8px;margin-bottom:0;align-items:stretch}
.was-cc{flex:0 0 96px;width:96px;min-width:0;padding:13px 8px;border:1.5px solid #E2E8F0;border-radius:10px;background:#FAFAF7;font-size:13.5px;font-weight:600;font-family:inherit;color:#0F172A;cursor:pointer;-webkit-appearance:menulist;appearance:menulist;box-sizing:border-box;text-align:left}
.was-ph{flex:1 1 0;min-width:0;padding:13px 14px;border:1.5px solid #E2E8F0;border-radius:10px;font-size:16px;background:#fff;color:#0F172A;font-family:inherit;letter-spacing:.5px;-webkit-appearance:none;appearance:none;width:100%;box-sizing:border-box}
.was-ph:focus,.was-cc:focus{outline:none;border-color:#25D366;box-shadow:0 0 0 3px rgba(37,211,102,.18)}
.was-code{width:100%;padding:18px;text-align:center;letter-spacing:14px;font-size:28px;font-weight:700;font-family:'Space Mono',monospace;border:1.5px solid #E2E8F0;border-radius:12px;background:#FAFAF7;color:#0F172A;-webkit-appearance:none;appearance:none}
.was-code:focus{outline:none;border-color:#25D366;background:#fff;box-shadow:0 0 0 3px rgba(37,211,102,.18)}
.was-err{margin-top:10px;font-size:12.5px;color:#B91C1C;font-weight:600;background:#FEF2F2;border:1px solid #FCA5A5;padding:9px 11px;border-radius:8px;line-height:1.4}
.was-acts{display:flex;gap:9px;margin-top:14px}
.was-acts .mb{flex:1;margin-top:0;padding:12px;font-size:13.5px}
@media (max-width:520px){.was-step{padding:14px 14px}.was-hd{padding:16px 14px 12px}.was-step-d{font-size:12.5px}.was-ph{font-size:16px;padding:12px}.was-code{font-size:24px;letter-spacing:10px}}
body[data-theme=aurora] .was-mdl{background:#1A1A2E}
body[data-theme=aurora] .was-step{background:#1A1A2E;border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .was-step-t{color:#F5F5FA}
body[data-theme=aurora] .was-step-d{color:#9999B5}
body[data-theme=aurora] .was-cc,body[data-theme=aurora] .was-ph,body[data-theme=aurora] .was-code{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#F5F5FA}
body[data-theme=aurora] .was-mini{background:rgba(37,211,102,.12);border-color:rgba(37,211,102,.28);color:#A8E6BC}
body[data-theme=aurora] .was-skip{color:#9999B5}
@keyframes wn-pulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}
.whatsnew-pill:hover{background:rgba(31,77,63,.12)!important;border-color:rgba(31,77,63,.35)!important;transform:translateY(-1px);transition:all .25s}
.login-foot{margin-top:32px;padding-top:18px;border-top:1px solid rgba(15,23,42,.06);display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;color:#94A3B8;flex-wrap:wrap}
.login-foot a{color:#64748B;text-decoration:none;font-weight:600}
.login-foot a:hover{color:#0F172A;text-decoration:underline}
.login-foot span{opacity:.5}
.otp-inputs{display:flex;gap:8px;justify-content:center;margin:16px 0}
.otp-inputs input{width:48px;height:58px;text-align:center;font-size:24px;font-family:'Space Mono',monospace;font-weight:700;padding:0;border-radius:12px}
@media (min-width:1024px){.otp-inputs input{width:56px;height:66px;font-size:28px}}
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
.player{position:fixed;bottom:14px;left:10px;right:10px;background:linear-gradient(135deg,#0F172A,#1F1F3A);color:#F8FAFC;padding:8px 10px;border-radius:14px;box-shadow:0 10px 26px rgba(0,0,0,.34);display:none;z-index:80;max-width:560px;margin:0 auto}
@media (max-width:600px){.player{bottom:96px !important;left:12px !important;right:96px !important}}
.player.on{display:flex;align-items:center;gap:10px}
/* Reserve enough bottom space so the entire task list (including the LAST item + delete buttons)
   sits comfortably above the floating audio player. Generous padding > too tight. */
body.audio-on .app{padding-bottom:calc(110px + env(safe-area-inset-bottom,0px))}
body.audio-on .fab-global{bottom:calc(96px + env(safe-area-inset-bottom,0px))!important}
@media (max-width:600px){
  .player{padding:7px 10px;border-radius:12px;left:10px;right:10px;bottom:14px}
  body.audio-on .app{padding-bottom:calc(120px + env(safe-area-inset-bottom,0px))}
  body.audio-on .fab-global{bottom:calc(108px + env(safe-area-inset-bottom,0px))!important}
}
.player-info{flex:1;min-width:0}.player-title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player-author{font-size:11px;color:#94A3B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player audio{height:34px;max-width:200px;flex-shrink:0}.player-close{flex-shrink:0;padding:6px 11px;border-radius:8px;background:rgba(255,255,255,.18);font-size:13px;font-weight:700;color:#fff;border:1px solid rgba(255,255,255,.25);transition:background .15s ease;min-width:36px;min-height:36px}
@media (max-width:600px){.player audio{max-width:140px;height:32px}.player-title{font-size:12.5px}.player-author{font-size:10.5px}}
.player-close:hover{background:rgba(232,69,60,.85);border-color:rgba(232,69,60,.9)}
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
.fab{animation:fabPulse 2.4s ease-in-out infinite,fabBounce 1.6s ease-in-out infinite;transition:transform .15s}
@keyframes fabBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.fab:hover{transform:scale(1.08)}
@keyframes fabPulse{0%,100%{box-shadow:0 8px 22px rgba(61,174,92,.5),0 0 0 0 rgba(61,174,92,.55),0 4px 20px rgba(0,0,0,.25)}50%{box-shadow:0 12px 30px rgba(61,174,92,.65),0 0 0 14px rgba(61,174,92,0),0 4px 20px rgba(0,0,0,.25)}}
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
.add-bar-board{position:relative;border-left:5px solid var(--bk,transparent);padding-left:16px}
.add-bar-board::after{content:'';position:absolute;top:14px;right:14px;width:8px;height:8px;border-radius:50%;background:var(--bk,#fff);box-shadow:0 0 0 3px rgba(255,255,255,.18),0 0 12px var(--bk,#fff);animation:bkDotPulse 2s ease-in-out infinite}
@keyframes bkDotPulse{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}
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
/* Immersive Meditation Overlay — full-screen calm scene */
.med-scene{position:fixed;inset:0;background:linear-gradient(180deg,#0F172A 0%,#1E1B4B 25%,#5B21B6 55%,#7C2D12 80%,#F59E0B 100%);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;animation:medFadeIn .6s ease-out}
@keyframes medFadeIn{from{opacity:0}to{opacity:1}}
.med-scene::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 25% 35%,rgba(167,139,250,.18),transparent 55%),radial-gradient(ellipse at 75% 70%,rgba(232,145,44,.14),transparent 55%);animation:medAura 16s ease-in-out infinite alternate;pointer-events:none}
@keyframes medAura{from{opacity:.7;transform:scale(1)}to{opacity:1;transform:scale(1.06)}}
.med-stars{position:absolute;inset:0;pointer-events:none}
.med-stars span{position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;box-shadow:0 0 6px rgba(255,255,255,.7);animation:starTwinkle 3s ease-in-out infinite}
.med-stars span:nth-child(1){top:8%;left:12%;animation-delay:0s}
.med-stars span:nth-child(2){top:14%;left:30%;animation-delay:.4s;width:1.5px;height:1.5px}
.med-stars span:nth-child(3){top:6%;left:55%;animation-delay:.8s}
.med-stars span:nth-child(4){top:20%;left:78%;animation-delay:1.2s}
.med-stars span:nth-child(5){top:11%;left:88%;animation-delay:.3s;width:1.5px;height:1.5px}
.med-stars span:nth-child(6){top:24%;left:18%;animation-delay:1.6s}
.med-stars span:nth-child(7){top:32%;left:46%;animation-delay:.6s;width:2.5px;height:2.5px}
.med-stars span:nth-child(8){top:18%;left:64%;animation-delay:1s}
.med-stars span:nth-child(9){top:9%;left:42%;animation-delay:1.8s}
.med-stars span:nth-child(10){top:28%;left:8%;animation-delay:.2s;width:1px;height:1px}
.med-stars span:nth-child(11){top:35%;left:92%;animation-delay:1.4s}
.med-stars span:nth-child(12){top:5%;left:72%;animation-delay:2s;width:2.5px;height:2.5px}
@keyframes starTwinkle{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:1;transform:scale(1.3)}}
.med-waves{position:absolute;left:0;right:0;bottom:0;width:100%;height:36vh;pointer-events:none;z-index:1}
.med-wave{transform-origin:center bottom}
.med-wave-1{fill:rgba(167,139,250,.2);animation:waveSwell 11s ease-in-out infinite}
.med-wave-2{fill:rgba(99,102,241,.18);animation:waveSwell 14s ease-in-out infinite reverse;animation-delay:-2s}
.med-wave-3{fill:rgba(15,23,42,.45);animation:waveSwell 17s ease-in-out infinite;animation-delay:-4s}
@keyframes waveSwell{0%,100%{transform:translateX(-30px) scaleY(1)}50%{transform:translateX(30px) scaleY(1.04)}}
.med-info{position:relative;z-index:5;text-align:center;color:#fff;padding:0 24px 28px}
.med-info-mins{font-size:11px;font-weight:800;letter-spacing:3px;color:rgba(255,255,255,.7);margin-bottom:8px}
.med-info-title{font-family:'Instrument Serif',Georgia,serif;font-size:34px;font-weight:400;letter-spacing:-.01em;line-height:1.15;text-shadow:0 2px 16px rgba(0,0,0,.4)}
.med-breath-wrap{position:relative;z-index:5;width:280px;height:280px;display:flex;align-items:center;justify-content:center}
.med-breath-core,.med-breath-ring{position:absolute;border-radius:50%}
.med-breath-core{width:200px;height:200px;background:radial-gradient(circle,rgba(255,255,255,.32),rgba(255,255,255,.08) 65%,transparent);border:1.5px solid rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;animation:breathe 10s ease-in-out infinite;box-shadow:0 0 60px rgba(255,255,255,.18) inset,0 0 40px rgba(167,139,250,.3)}
.med-breath-ring-1{width:240px;height:240px;border:1px solid rgba(255,255,255,.25);animation:breatheRing 10s ease-in-out infinite;animation-delay:-.4s}
.med-breath-ring-2{width:300px;height:300px;border:1px solid rgba(255,255,255,.16);animation:breatheRing 10s ease-in-out infinite;animation-delay:-.8s}
.med-breath-ring-3{width:380px;height:380px;border:1px solid rgba(255,255,255,.08);animation:breatheRing 10s ease-in-out infinite;animation-delay:-1.2s}
@keyframes breathe{0%,100%{transform:scale(.85)}40%{transform:scale(1.18)}60%{transform:scale(1.18)}}
@keyframes breatheRing{0%,100%{transform:scale(.85);opacity:.4}40%{transform:scale(1.18);opacity:.85}60%{transform:scale(1.18);opacity:.85}}
.med-breath-text{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:22px;color:rgba(255,255,255,.92);letter-spacing:.04em;transition:opacity .25s ease;text-shadow:0 1px 8px rgba(0,0,0,.3)}
.med-tip{position:relative;z-index:5;color:rgba(255,255,255,.62);font-size:13px;margin-top:36px;font-style:italic;text-align:center;padding:0 24px}
.med-close{position:absolute;top:24px;right:24px;width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;font-size:22px;border:1px solid rgba(255,255,255,.22);cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px);transition:background .2s ease,transform .2s ease}
.med-close:hover{background:rgba(232,69,60,.5);transform:scale(1.05)}
.med-audio{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);max-width:360px;width:calc(100% - 48px);z-index:5;border-radius:16px;height:42px;outline:none;filter:invert(1) hue-rotate(180deg) opacity(.85)}
.med-loading{position:absolute;bottom:48px;color:rgba(255,255,255,.7);font-size:13px;font-style:italic;z-index:5}
@media (max-width:600px){.med-info-title{font-size:26px}.med-breath-wrap{width:240px;height:240px}.med-breath-core{width:160px;height:160px}.med-breath-ring-1{width:200px;height:200px}.med-breath-ring-2{width:250px;height:250px}.med-breath-ring-3{width:310px;height:310px}}

/* IPL tab — Wikipedia season card */
.ipl-wiki{display:flex;gap:14px;background:#fff;border:1px solid #E8E9EF;border-radius:14px;padding:14px;text-decoration:none;color:inherit;margin-bottom:18px;transition:transform .2s ease,box-shadow .2s ease;align-items:flex-start}
.ipl-wiki:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(15,23,42,.1)}
.ipl-wiki-thumb{width:120px;height:120px;border-radius:10px;object-fit:cover;flex-shrink:0;background:#F1F5F9}
.ipl-wiki-body{flex:1;min-width:0}
.ipl-wiki-kicker{font-size:10px;font-weight:800;color:#6366F1;letter-spacing:1.4px;margin-bottom:4px}
.ipl-wiki-h{font-family:'Instrument Serif',Georgia,serif;font-size:22px;font-weight:400;color:#0F172A;letter-spacing:-.01em;margin-bottom:6px;line-height:1.2}
.ipl-wiki-x{font-size:13.5px;line-height:1.55;color:#475569;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.ipl-wiki-cta{font-size:13px;font-weight:700;color:#6366F1;border-bottom:1.5px solid currentColor;padding-bottom:1px}
body[data-theme=aurora] .ipl-wiki{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
body[data-theme=aurora] .ipl-wiki-h{color:#F5F5FA}
body[data-theme=aurora] .ipl-wiki-x{color:#9999B5}
body[data-theme=aurora] .ipl-wiki-cta{color:#A78BFA}
@media (max-width:600px){.ipl-wiki{flex-direction:column;gap:10px}.ipl-wiki-thumb{width:100%;height:160px}}
/* IPL Spotlight card on the Sports news category */
.ipl-spotlight{background:linear-gradient(135deg,#0F172A 0%,#312E81 50%,#7E22CE 100%);color:#fff;border-radius:16px;padding:14px 16px 16px;margin-bottom:16px;box-shadow:0 8px 24px rgba(15,23,42,.18);position:relative;overflow:hidden}
.ipl-spotlight::before{content:'';position:absolute;inset:0;background-image:url("https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=1200&q=70&auto=format&fit=crop");background-size:cover;background-position:center;opacity:.14;mix-blend-mode:screen;pointer-events:none}
.ipl-spot-hd{display:flex;align-items:center;gap:10px;margin-bottom:12px;position:relative;z-index:1}
.ipl-spot-pulse{width:8px;height:8px;border-radius:50%;background:#E8453C;box-shadow:0 0 0 0 rgba(232,69,60,.7);animation:livePulse 1.5s ease-in-out infinite}
.ipl-spot-tag{font-size:10.5px;font-weight:800;color:#F472B6;letter-spacing:1.6px}
.ipl-spot-yr{font-size:10.5px;font-weight:600;color:rgba(255,255,255,.7);margin-left:auto;letter-spacing:.8px}
.ipl-spot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;position:relative;z-index:1}
.ipl-spot-stat{display:flex;flex-direction:column;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:11px;padding:9px 12px;text-decoration:none;color:inherit;transition:transform .2s ease,background .2s ease}
.ipl-spot-stat:hover{transform:translateY(-2px);background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.22)}
.ipl-spot-stat .iss-lbl{font-size:9.5px;font-weight:800;color:rgba(255,255,255,.6);letter-spacing:1.1px;text-transform:uppercase}
.ipl-spot-stat .iss-val{font-family:'Instrument Serif',Georgia,serif;font-size:18px;font-weight:400;color:#fff;letter-spacing:-.01em;margin:2px 0 1px;line-height:1.1}
.ipl-spot-stat .iss-sub{font-size:10.5px;color:rgba(255,255,255,.7);font-weight:500}
.ipl-spot-cta{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;position:relative;z-index:1}
.ipl-spot-cta a{display:inline-flex;align-items:center;padding:7px 13px;border-radius:9px;font-size:11.5px;font-weight:700;text-decoration:none;color:#fff;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);transition:background .15s ease,border-color .15s ease;letter-spacing:.2px}
.ipl-spot-cta a:hover{background:rgba(232,69,60,.65);border-color:rgba(232,69,60,.8)}
.ipl-spot-cta a:first-child{background:#E8453C;border-color:#E8453C}
.ipl-spot-cta a:first-child:hover{background:#DC2626;border-color:#DC2626}
@media (max-width:600px){.ipl-spot-grid{grid-template-columns:repeat(2,1fr);gap:8px}.ipl-spot-stat{padding:7px 10px}.ipl-spot-stat .iss-val{font-size:16px}}
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
.mag-pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;padding:4px 0}
.know-topics{margin-bottom:8px}
.know-topic{font-size:14px;padding:11px 18px}
.know-topic.on{background:linear-gradient(135deg,#B45309,#7C2D12);box-shadow:0 6px 18px rgba(180,83,9,.3)}
.know-subs{padding-bottom:14px;border-bottom:1px dashed rgba(99,102,241,.18);margin-bottom:18px}
.mag-pill-sub{font-size:12px;padding:7px 12px;font-weight:600}
.mag-pill-sub.on{background:linear-gradient(135deg,#6366F1,#8B5CF6);box-shadow:0 4px 12px rgba(99,102,241,.25)}
body[data-theme=aurora] .know-subs{border-bottom-color:rgba(167,139,250,.2)}
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
  .app .tabs.page-t .tab{padding:10px 14px;font-size:14px;font-weight:500;gap:10px;border-radius:8px}
  .app .tabs.page-t .tab .ti svg{width:18px;height:18px}
  .app .tabs.page-t{padding:14px 12px;gap:2px}
}
.section-hd{display:flex;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.section-hd h3{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;letter-spacing:-.02em}
.section-hd p{font-size:13px;color:var(--ink-3);margin-top:2px;font-weight:450}
.section-ic{width:36px;height:36px;border-radius:8px;background:var(--bg-sunken);color:var(--ink-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:none;border:1px solid var(--line)}
.section-ic svg{width:18px;height:18px}


/* ═══════════════ VOICE · Headspace-style calm tutor UI ═══════════════ */
.vc-lesson{position:relative;border-radius:24px;overflow:hidden;margin-bottom:18px;padding:32px 28px 30px;color:#fff;background:radial-gradient(900px 500px at 100% 0%, rgba(255,196,127,.42) 0%, transparent 55%),radial-gradient(700px 600px at 0% 100%, rgba(255,143,107,.30) 0%, transparent 55%),linear-gradient(135deg, #FF6B47 0%, #FF8A4F 35%, #FFB05E 100%);box-shadow:0 20px 50px -16px rgba(255,107,71,.45),0 1px 0 rgba(255,255,255,.18) inset;animation:intlFadeUp .65s cubic-bezier(.16,1,.3,1) both}
.vc-lesson::before{content:'';position:absolute;top:-30%;right:-15%;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.18) 0%,transparent 65%);animation:vc-breathe 7s ease-in-out infinite alternate;pointer-events:none}
@keyframes vc-breathe{0%{transform:scale(1) translate(0,0);opacity:.55}100%{transform:scale(1.18) translate(-12px,16px);opacity:.85}}
.vc-lesson::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 35%,rgba(255,255,255,.07) 50%,transparent 65%);transform:translateX(-100%);animation:intlShimmer 7s ease-in-out infinite;pointer-events:none}
.vc-lesson-eyebrow{font-family:'JetBrains Mono','Space Mono',monospace;font-weight:500;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.78);margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vc-lesson-eyebrow .day-num{padding:3px 10px;background:rgba(255,255,255,.16);border-radius:999px;font-weight:600;color:#fff;font-size:10px}
.vc-lesson h2{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:32px;line-height:1.05;letter-spacing:-.02em;color:#fff;margin:0 0 10px}
.vc-lesson .desc{font-size:14.5px;line-height:1.55;color:rgba(255,255,255,.82);max-width:560px;margin-bottom:18px}
.vc-lesson-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.vc-lesson-row .vc-go{padding:11px 22px;border-radius:12px;background:#fff;color:#0E0A1F;border:0;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;transition:transform .2s,box-shadow .25s}
.vc-lesson-row .vc-go:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(255,255,255,.15)}
.vc-lesson-row .vc-meta{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;color:rgba(255,255,255,.7);text-transform:uppercase}

/* Headspace-style chat thread + scenarios + composer */
.cc-scenarios{margin-bottom:18px !important}
.cc-scenarios-t{
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-size:11px !important;font-weight:500 !important;
  letter-spacing:.14em !important;color:#1F4D3F !important;
  text-transform:uppercase !important;margin-bottom:14px !important;
}
.cc-scenario-row{padding-bottom:8px !important;gap:10px !important}
.cc-sc{
  flex-shrink:0 !important;
  padding:14px 18px !important;
  border-radius:14px !important;
  border:1px solid #E8E6E0 !important;
  background:#fff !important;
  color:#1A1A1A !important;
  font-family:inherit !important;
  font-weight:500 !important;
  font-size:13.5px !important;
  letter-spacing:-.005em !important;
  cursor:pointer;
  transition:transform .35s cubic-bezier(.16,1,.3,1), border-color .25s, background .25s, box-shadow .3s !important;
  box-shadow:0 1px 2px rgba(0,0,0,.03), 0 2px 6px rgba(0,0,0,.04) !important;
  scroll-snap-align:start;
}
.cc-sc:hover{
  border-color:#FF8A4F !important;
  background:linear-gradient(135deg,#FFF8F2,#FFFFFF) !important;
  transform:translateY(-2px) !important;
  box-shadow:0 8px 20px -8px rgba(255,138,79,.3) !important;
}
.cc-sc-on{
  background:linear-gradient(135deg,#FF6B47,#FF8A4F) !important;
  border-color:#FF6B47 !important;color:#fff !important;
  box-shadow:0 8px 20px -8px rgba(255,107,71,.5) !important;
}
.cc-sc-on:hover{
  background:linear-gradient(135deg,#E54D2A,#F26935) !important;
  border-color:#E54D2A !important;color:#fff !important;
}
.cc-active-scenario{
  background:linear-gradient(135deg,#FFF1E8,#FFEBE0) !important;
  border:1px solid #FFD0B5 !important;
  color:#7A2F0E !important;
  border-radius:14px !important;padding:14px 18px !important;
  font-size:13.5px !important;
}
.cc-active-scenario b{color:#1A1A1A !important;font-weight:600 !important}
.cc-end{
  background:#fff !important;border:1px solid #FFD0B5 !important;
  color:#7A2F0E !important;font-family:'JetBrains Mono',monospace !important;
  font-weight:500 !important;font-size:11px !important;letter-spacing:.06em !important;
  text-transform:uppercase !important;padding:6px 12px !important;border-radius:999px !important;
}
.cc-end:hover{background:#FF6B47 !important;color:#fff !important;border-color:#FF6B47 !important}

/* Chat thread — bigger breathing room */
.cc-thread{
  padding:8px 0 14px !important;gap:14px !important;max-height:none !important;
}
.cc-bubble{
  max-width:82% !important;
  padding:14px 18px !important;
  border-radius:20px !important;
  font-size:14.5px !important;
  line-height:1.55 !important;
  letter-spacing:-.005em !important;
  font-family:'Inter',sans-serif !important;
}
.cc-coach .cc-bubble{
  background:#FAFAF7 !important;
  color:#1A1A1A !important;
  border:1px solid #ECEAE3 !important;
  border-bottom-left-radius:6px !important;
  box-shadow:0 1px 2px rgba(0,0,0,.02) !important;
}
.cc-me .cc-bubble{
  background:linear-gradient(135deg,#FF6B47,#FF8A4F) !important;
  color:#fff !important;
  border:0 !important;
  border-bottom-right-radius:6px !important;
  box-shadow:0 4px 14px -4px rgba(255,107,71,.4) !important;
}
.cc-msg{align-items:flex-end !important;gap:10px !important}
.cc-avatar{
  width:34px !important;height:34px !important;border-radius:50% !important;
  background:linear-gradient(135deg,#FF6B47,#FFB05E) !important;
  display:grid !important;place-items:center !important;
  font-size:14px !important;flex-shrink:0;
  box-shadow:0 4px 10px -2px rgba(255,107,71,.4) !important;
}
.cc-replay{
  background:rgba(255,107,71,.12) !important;
  color:#FF6B47 !important;
  border:0 !important;
  margin-left:8px !important;padding:3px 9px !important;border-radius:8px !important;
  font-size:13px !important;
}
.cc-replay:hover{background:#FF6B47 !important;color:#fff !important}
.cc-typing{padding:14px 18px !important}
.cc-typing span{
  background:#FF6B47 !important;width:7px !important;height:7px !important;
}

/* Composer — Headspace warmth */
.cc-composer{
  padding:12px !important;
  border:1px solid #ECEAE3 !important;
  border-radius:22px !important;
  background:#fff !important;
  box-shadow:0 4px 18px -6px rgba(0,0,0,.08) !important;
  margin-top:14px !important;
}
.cc-composer textarea{
  font-size:15.5px !important;
  line-height:1.5 !important;
  padding:10px 6px !important;
  font-family:'Inter',sans-serif !important;
}
.cc-composer textarea::placeholder{color:#9A9A9A !important;font-style:normal !important}
.cc-mic{
  width:44px !important;height:44px !important;
  background:#F4F3EE !important;
  color:#1A1A1A !important;
  font-size:18px !important;
  transition:background .25s, transform .35s cubic-bezier(.34,1.56,.64,1) !important;
}
.cc-mic:hover{background:#FFE1D1 !important;color:#FF6B47 !important;transform:scale(1.05)}
.cc-mic.cc-rec, .cc-rec{
  background:linear-gradient(135deg,#FF6B47,#FF8A4F) !important;
  color:#fff !important;
  animation:cc-rec-pulse 1.4s ease-in-out infinite !important;
}
@keyframes cc-rec-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,107,71,.6)}50%{box-shadow:0 0 0 12px rgba(255,107,71,0)}}
.cc-send{
  flex-shrink:0;width:44px !important;height:44px !important;
  border-radius:50% !important;border:0;cursor:pointer;
  background:linear-gradient(135deg,#FF6B47,#FF8A4F) !important;
  color:#fff !important;font-size:18px !important;font-family:inherit !important;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1), box-shadow .3s !important;
  box-shadow:0 4px 12px -2px rgba(255,107,71,.45) !important;
}
.cc-send:hover{transform:scale(1.06);box-shadow:0 6px 18px -2px rgba(255,107,71,.55) !important}
.cc-send:disabled{background:#E8E6E0 !important;color:#9A9A9A !important;box-shadow:none !important;cursor:not-allowed}

/* Quick-action chips */
.cc-quick{margin-top:14px !important;gap:8px !important;flex-wrap:wrap;display:flex}
.cc-quick-btn{
  padding:9px 16px !important;
  border-radius:999px !important;
  border:1px solid #E8E6E0 !important;
  background:#fff !important;
  color:#1A1A1A !important;
  font-family:inherit !important;
  font-weight:500 !important;
  font-size:13px !important;
  cursor:pointer;
  transition:all .25s !important;
}
.cc-quick-btn:hover{
  border-color:#FF6B47 !important;color:#FF6B47 !important;
  background:#FFF8F4 !important;
}
.cc-quick-reset{color:#9A9A9A !important;border-style:dashed !important}
.cc-quick-reset:hover{color:#1A1A1A !important;border-style:solid !important}

.cc-playing{
  margin-top:10px;padding:10px 14px;
  background:linear-gradient(135deg,#FFF1E8,#FFEBE0);
  border:1px solid #FFD0B5;border-radius:12px;
  font-size:13px;color:#7A2F0E;
  display:flex;align-items:center;gap:10px;
}
.cc-playing button{background:transparent;border:1px solid #FFD0B5;color:#FF6B47;font-family:inherit;font-weight:500;padding:4px 10px;border-radius:8px;font-size:12px;cursor:pointer}
.cc-playing button:hover{background:#FF6B47;color:#fff}

/* Math Sprint polish — premium typography, bigger problems, refined choices */
.ms-body{padding:24px 22px !important;gap:18px !important;background:#FAFAF7 !important}
.ms-stats{justify-content:space-between !important}
.ms-stat{
  background:#fff !important;border:1px solid #ECEAE3 !important;
  padding:10px 14px !important;border-radius:14px !important;
  box-shadow:0 1px 2px rgba(0,0,0,.03) !important;
}
.ms-stat b{
  font-family:'Inter',sans-serif !important;
  font-weight:600 !important;font-size:22px !important;
  letter-spacing:-.02em !important;color:#1A1A1A !important;
}
.ms-stat small{
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-weight:500 !important;font-size:10px !important;
  letter-spacing:.1em !important;color:#9A9A9A !important;
  text-transform:uppercase !important;
}
.ms-stat-streak b{color:#FF6B47 !important}
.ms-time-track{height:6px !important;background:#ECEAE3 !important;border-radius:999px !important}
.ms-problem-wrap{padding:32px 0 !important}
.ms-problem{
  font-family:'Inter',sans-serif !important;
  font-weight:600 !important;
  font-size:clamp(48px,9vw,84px) !important;
  letter-spacing:-.04em !important;
  color:#1A1A1A !important;
  gap:18px !important;
}
.ms-num{
  background:linear-gradient(180deg,#1A1A1A,#3D3D3D);
  -webkit-background-clip:text;background-clip:text;color:transparent !important;
}
.ms-op{color:#9A9A9A !important;font-weight:500 !important}
.ms-eq{color:#9A9A9A !important;font-weight:500 !important}
.ms-q{color:#FF6B47 !important;font-weight:700 !important}
.ms-choices{display:grid !important;grid-template-columns:repeat(2,1fr) !important;gap:10px !important;margin-top:6px}
.ms-choice{
  background:#fff !important;border:1.5px solid #ECEAE3 !important;
  border-radius:16px !important;padding:18px 14px !important;
  font-family:'Inter',sans-serif !important;
  font-weight:600 !important;font-size:30px !important;
  letter-spacing:-.02em !important;color:#1A1A1A !important;
  cursor:pointer;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1), border-color .2s, background .2s, box-shadow .25s !important;
  box-shadow:0 1px 2px rgba(0,0,0,.03), 0 2px 6px rgba(0,0,0,.04) !important;
}
.ms-choice:hover{
  transform:translateY(-3px) !important;
  border-color:#1A1A1A !important;
  background:#fff !important;
  box-shadow:0 8px 20px -8px rgba(0,0,0,.18) !important;
}
.ms-choice-ok{
  background:linear-gradient(135deg,#ECFDF5,#D1FAE5) !important;
  border-color:#10B981 !important;color:#065F46 !important;
  box-shadow:0 8px 20px -6px rgba(16,185,129,.4) !important;
  transform:translateY(-2px) !important;
}
.ms-choice-wrong{
  background:linear-gradient(135deg,#FEF2F2,#FEE2E2) !important;
  border-color:#EF4444 !important;color:#991B1B !important;
}
.ms-choice-fade{opacity:.35;transform:scale(.98)}
.ms-fb{
  font-family:'Inter',sans-serif !important;
  font-weight:500 !important;font-size:14.5px !important;
  text-align:center !important;padding:10px;border-radius:10px;
}
.ms-fb-ok{color:#065F46 !important;background:#ECFDF5}
.ms-fb-bad{color:#991B1B !important;background:#FEF2F2}

/* Memory Tap polish — premium round indicator + canvas frame */
.mt-shell{padding:24px 22px !important;background:#FAFAF7 !important}
.mt-hud{
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-size:11px !important;letter-spacing:.1em !important;
  color:#9A9A9A !important;text-transform:uppercase !important;
  padding:10px 14px !important;background:#fff !important;
  border:1px solid #ECEAE3 !important;border-radius:12px !important;
  margin-bottom:16px !important;
}
.mt-hud b{font-family:'Inter',sans-serif !important;font-weight:600 !important;color:#1A1A1A !important;font-size:14px !important;letter-spacing:-.01em !important}
.mt-canvas{border-radius:18px !important;box-shadow:0 14px 36px -16px rgba(0,0,0,.18) !important}
.mt-end{padding:30px 22px !important;background:#FAFAF7 !important}
.mt-end-stars{font-size:36px !important;letter-spacing:6px !important;margin-bottom:14px}
.mt-star{color:#E8E6E0 !important;transition:all .4s cubic-bezier(.34,1.56,.64,1)}
.mt-star-on{color:#F59E0B !important;text-shadow:0 0 18px rgba(245,158,11,.55) !important}
.mt-end-t{font-family:'Inter',sans-serif !important;font-weight:500 !important;font-size:18px !important;letter-spacing:-.01em !important;color:#3D3D3D !important;margin-bottom:6px}
.mt-end-t b{font-weight:700 !important;color:#1A1A1A !important;font-size:32px !important;display:block;letter-spacing:-.02em;margin-bottom:4px}
.mt-end-s{font-family:'JetBrains Mono',monospace !important;font-size:11.5px !important;color:#9A9A9A !important;letter-spacing:.06em !important;text-transform:uppercase}

/* Modal header polish */
.mg-mdl{border-radius:20px !important;overflow:hidden}
.mg-hd{padding:18px 22px 14px !important;border-bottom:1px solid #ECEAE3}
.mg-t{font-family:'Inter',sans-serif !important;font-weight:600 !important;font-size:18px !important;letter-spacing:-.015em !important;color:#1A1A1A !important}
.mg-s{font-size:13px !important;color:#6B6B6B !important;font-weight:450 !important;margin-top:3px}
.was-x{
  width:32px !important;height:32px !important;border-radius:50% !important;
  background:#fff !important;border:1px solid #ECEAE3 !important;
  color:#6B6B6B !important;cursor:pointer;
  transition:background .2s, color .2s, border-color .2s;
}
.was-x:hover{background:#FEF2F2 !important;color:#DC2626 !important;border-color:#FCA5A5 !important}

/* Reaction game polish — radial energy + pulsing rings, less flat */
.mg-react-stage{
  position:relative !important;
  border-radius:20px !important;
  height:320px !important;
  font-family:'Inter',sans-serif !important;
  font-weight:600 !important;
  font-size:28px !important;
  letter-spacing:-.02em !important;
  overflow:hidden !important;
  box-shadow:0 14px 36px -16px rgba(0,0,0,.3) !important;
}
.mg-react-stage::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.18) 0%, transparent 55%);pointer-events:none}
.mg-react-stage::after{content:'';position:absolute;width:200px;height:200px;border:2px solid rgba(255,255,255,.4);border-radius:50%;top:50%;left:50%;transform:translate(-50%,-50%);animation:mgr-ring 2.4s ease-in-out infinite;pointer-events:none}
@keyframes mgr-ring{0%{transform:translate(-50%,-50%) scale(.6);opacity:.7}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}
.mg-react-wait{background:radial-gradient(circle at 50% 30%, #F87171 0%, #DC2626 40%, #7F1D1D 100%) !important}
.mg-react-go{
  background:radial-gradient(circle at 50% 30%, #6EE7B7 0%, #10B981 40%, #047857 100%) !important;
  animation:mgReactPulse .5s ease infinite alternate !important;
}
.mg-react-go::after{animation-duration:.9s !important;border-color:rgba(255,255,255,.7) !important}
.mg-react-early{background:radial-gradient(circle at 50% 30%, #FCA5A5 0%, #DC2626 50%, #7F1D1D 100%) !important}
.mg-react-done{background:radial-gradient(circle at 50% 30%, #DBEAFE 0%, #93C5FD 50%, #1E3A8A 100%) !important}
.mg-react-time{
  font:600 clamp(64px,10vw,108px)/1 'Inter',sans-serif !important;
  letter-spacing:-.04em !important;color:#fff !important;
  background:linear-gradient(180deg,#fff,rgba(255,255,255,.6));
  -webkit-background-clip:text;background-clip:text;
  filter:drop-shadow(0 4px 20px rgba(255,255,255,.4));
}
.mg-react-time small{font-size:.4em;opacity:.65;margin-left:6px}
.mg-react-msg{position:relative;z-index:1;text-shadow:0 2px 6px rgba(0,0,0,.25)}

/* ═══════════════ Persistent book mini-player (Spotify-style) ═══════════════ */
.bk-mini{position:fixed;bottom:24px;right:24px;z-index:160;display:flex;align-items:center;gap:14px;background:#1A1A1A;color:#fff;border:1px solid #1A1A1A;border-radius:20px;padding:12px 16px 12px 12px;box-shadow:0 20px 50px -10px rgba(0,0,0,.4),0 6px 16px rgba(0,0,0,.12);max-width:420px;min-width:320px;animation:bk-up .4s cubic-bezier(.16,1,.3,1);cursor:pointer;transition:transform .25s,box-shadow .3s}
.bk-mini:hover{transform:translateY(-3px);box-shadow:0 28px 60px -10px rgba(0,0,0,.5)}
.bk-mini-info b{color:#fff !important}
.bk-mini-info small{color:rgba(255,255,255,.6) !important}
.bk-mini-btn{background:#fff !important;color:#1A1A1A !important}
.bk-mini-btn:hover{background:#FCD34D !important}
.bk-mini-x{background:rgba(255,255,255,.1) !important;color:rgba(255,255,255,.7) !important;border-color:rgba(255,255,255,.2) !important}
.bk-mini-x:hover{background:rgba(220,38,38,.4) !important;color:#fff !important;border-color:rgba(220,38,38,.6) !important}
@keyframes bkMiniPing{0%{box-shadow:0 0 0 0 rgba(255,255,255,.4)}80%,100%{box-shadow:0 0 0 14px rgba(255,255,255,0)}}
.bk-mini-pulse{animation:bkMiniPing 1.6s ease-out infinite}
.bk-mini-cover{width:42px;height:54px;border-radius:8px;background:var(--bm-grad,#1F4D3F);flex-shrink:0;box-shadow:0 4px 10px rgba(0,0,0,.15)}
.bk-mini-info{flex:1;min-width:0;line-height:1.3}
.bk-mini-info b{display:block;font-size:13px;font-weight:600;letter-spacing:-.005em;color:#1A1A1A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bk-mini-info small{display:block;font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;color:#6B6B6B;letter-spacing:.06em;text-transform:uppercase;margin-top:2px}
.bk-mini-btn{width:38px;height:38px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;background:#1A1A1A;color:#fff;font-size:14px;font-family:inherit;transition:background .2s,transform .2s;flex-shrink:0}
.bk-mini-btn:hover{background:#1F4D3F;transform:scale(1.05)}
.bk-mini-x{width:26px;height:26px;border-radius:50%;border:1px solid #ECEAE3;background:#fff;color:#6B6B6B;font-family:inherit;font-size:11px;cursor:pointer;display:grid;place-items:center;flex-shrink:0;transition:all .2s}
.bk-mini-x:hover{background:#FEF2F2;color:#DC2626;border-color:#FCA5A5}
/* When the audiobook player is also visible, stack the summary mini-player above it */
body:has(.player.on) .bk-mini{bottom:170px !important}
@media (max-width:600px){
  .bk-mini{
    left:auto !important;
    right:12px !important;
    bottom:96px !important; /* clears the global FAB+ button and any bottom nav */
    min-width:0 !important;
    max-width:calc(100vw - 24px) !important;
    padding:10px 14px 10px 10px !important;
    gap:10px !important;
  }
  body:has(.player.on) .bk-mini{bottom:170px !important}
  .bk-mini-cover{width:38px !important;height:48px !important}
  .bk-mini-info b{font-size:12px !important;max-width:120px}
  .bk-mini-info small{font-size:9.5px !important}
  .bk-mini-btn{width:34px !important;height:34px !important;font-size:13px !important}
  .bk-mini-x{width:24px !important;height:24px !important;font-size:10px !important}
}
@media (max-width:380px){
  .bk-mini-info{max-width:90px}
  .bk-mini-info b{max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
}

/* ═══════════════ COMMUNITY ARTICLES — Medium-style ═══════════════ */
.art-feed{display:flex;flex-direction:column;gap:18px;margin-top:8px}
.art-card{display:flex;flex-direction:column;background:#fff;border:1px solid #ECEAE3;border-radius:18px;overflow:hidden;cursor:pointer;transition:transform .35s cubic-bezier(.16,1,.3,1),box-shadow .3s,border-color .25s}
.art-card:hover{transform:translateY(-3px);box-shadow:0 18px 36px -16px rgba(0,0,0,.12);border-color:#CFCBC0}
.art-img{aspect-ratio:16/9;overflow:hidden;background:#F4F3EE}
.art-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .8s cubic-bezier(.16,1,.3,1)}
.art-card:hover .art-img img{transform:scale(1.04)}
.art-body{padding:22px 22px 18px}
.art-cat{display:inline-block;font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#1F4D3F;background:rgba(31,77,63,.08);padding:4px 10px;border-radius:999px;font-weight:600;margin-bottom:10px}
.art-title{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(22px,3.6vw,28px);line-height:1.15;letter-spacing:-.018em;color:#1A1A1A;margin:0 0 8px}
.art-preview{font-size:14.5px;line-height:1.55;color:#3D3D3D;margin:0 0 14px}
.art-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:#6B6B6B}
.art-author{display:inline-flex;align-items:center;gap:8px;font-weight:500;color:#1A1A1A}
.art-avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#FF6B47,#FFB05E);color:#fff;display:grid;place-items:center;font-weight:600;font-size:12px}
.art-dot{color:#CFCFCF}
.art-time,.art-readtime{font-family:'JetBrains Mono',monospace;font-size:11.5px}
.art-like{margin-left:auto;background:#fff;border:1px solid #ECEAE3;color:#1A1A1A;font-family:inherit;font-size:13px;padding:6px 12px;border-radius:999px;cursor:pointer;transition:all .2s;font-weight:500}
.art-like:hover{background:#FEF2F2;border-color:#FCA5A5;color:#DC2626}

/* Article editor */
.ae-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);overflow-y:auto;padding:18px;animation:bk-fade .3s cubic-bezier(.16,1,.3,1)}
.ae-box{width:min(700px,100%);background:#FAFAF7;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);margin:0 auto 80px;animation:bk-up .35s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;max-height:calc(100vh - 36px)}
.ae-top{display:grid;grid-template-columns:1fr auto;gap:14px;padding:18px 22px;border-bottom:1px solid #ECEAE3;background:#fff;align-items:center}
.ae-tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:#1F4D3F;font-weight:600}
.ae-h{font-family:'Inter',sans-serif;font-weight:600;font-size:18px;letter-spacing:-.015em;color:#1A1A1A;margin-top:2px}
.ae-body{padding:24px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;flex:1}
.ae-title{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:32px;line-height:1.1;letter-spacing:-.02em;color:#1A1A1A;border:0;border-bottom:2px solid #ECEAE3;padding:8px 4px;background:transparent;outline:none;width:100%}
.ae-title:focus{border-bottom-color:#1A1A1A}
.ae-title::placeholder{color:#CFCFCF}
.ae-image{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#6B6B6B;background:#fff;border:1px solid #ECEAE3;border-radius:10px;padding:10px 14px;width:100%;outline:none}
.ae-image:focus{border-color:#1A1A1A}
.ae-img-prev{aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#F4F3EE;border:1px solid #ECEAE3}
.ae-img-prev img{width:100%;height:100%;object-fit:cover;display:block}
.ae-cats{display:flex;gap:6px;flex-wrap:wrap}
.ae-cat{padding:7px 14px;border-radius:999px;border:1px solid #ECEAE3;background:#fff;color:#3D3D3D;font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:all .2s}
.ae-cat:hover{border-color:#1A1A1A}
.ae-cat.on{background:#1A1A1A;color:#fff;border-color:#1A1A1A}
.ae-text{font-family:'Inter',sans-serif;font-size:16px;line-height:1.7;color:#1A1A1A;border:1px solid #ECEAE3;background:#fff;border-radius:12px;padding:16px 18px;outline:none;resize:vertical;min-height:280px;width:100%}
.ae-text:focus{border-color:#1A1A1A}
.ae-text::placeholder{color:#9A9A9A}
.ae-meta{display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:11px;color:#9A9A9A;letter-spacing:.04em}
.ae-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid #ECEAE3;background:#fff}

/* Article reader */
.ar-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);overflow-y:auto;padding:18px;animation:bk-fade .3s cubic-bezier(.16,1,.3,1)}
.ar-box{position:relative;width:min(720px,100%);background:#FAFAF7;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);margin:0 auto 80px;animation:bk-up .35s cubic-bezier(.16,1,.3,1)}
.ar-x{position:absolute;top:18px;right:18px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.95);border:1px solid #ECEAE3;backdrop-filter:blur(8px);cursor:pointer;font-family:inherit;font-size:14px;color:#1A1A1A;display:grid;place-items:center;z-index:5;transition:all .2s}
.ar-x:hover{background:#FEF2F2;color:#DC2626;border-color:#FCA5A5}
.ar-hero{aspect-ratio:21/9;overflow:hidden;background:#F4F3EE}
.ar-hero img{width:100%;height:100%;object-fit:cover;display:block}
.ar-body{padding:34px 34px 28px}
@media (max-width:600px){.ar-body{padding:24px 22px 22px}}
.ar-cat{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:#1F4D3F;font-weight:600;margin-bottom:14px}
.ar-title{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(28px,4.4vw,42px);line-height:1.12;letter-spacing:-.022em;color:#1A1A1A;margin:0 0 14px}
.ar-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:#6B6B6B;padding-bottom:18px;border-bottom:1px solid #ECEAE3;margin-bottom:24px}
.ar-author{display:inline-flex;align-items:center;gap:9px;font-weight:500;color:#1A1A1A}
.ar-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#FF6B47,#FFB05E);color:#fff;display:grid;place-items:center;font-weight:600;font-size:14px}
.ar-content{font-family:'Inter',sans-serif;font-size:17px;line-height:1.7;color:#1A1A1A;letter-spacing:-.005em}
.ar-content p{margin-bottom:18px}
.ar-foot{margin-top:30px;padding-top:24px;border-top:1px solid #ECEAE3;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px}
.ar-like{background:#fff;border:1px solid #ECEAE3;color:#1A1A1A;font-family:inherit;font-size:14px;padding:10px 18px;border-radius:999px;cursor:pointer;font-weight:500;transition:all .2s}
.ar-like:hover{background:#FEF2F2;border-color:#FCA5A5;color:#DC2626;transform:translateY(-1px)}

/* ═══════════════ BLINKIST/HEADWAY-STYLE BOOK HERO ═══════════════ */
.bk-hero{position:relative;border-radius:22px;overflow:hidden;margin-bottom:18px;padding:32px 30px;color:#fff;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center;background:radial-gradient(900px 500px at 0% 0%, rgba(214,180,255,.4) 0%, transparent 60%),radial-gradient(700px 500px at 100% 100%, rgba(46,255,169,.25) 0%, transparent 60%),linear-gradient(135deg,#1B1245 0%,#2E0F4A 50%,#5B21B6 100%);box-shadow:0 22px 50px -16px rgba(91,33,182,.45);animation:intlFadeUp .65s cubic-bezier(.16,1,.3,1) both}
@media (max-width:560px){.bk-hero{grid-template-columns:1fr;text-align:center;padding:26px 22px}}
.bk-hero-tag{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;color:rgba(255,255,255,.78);text-transform:uppercase;font-weight:500}
.bk-hero h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:clamp(28px,4.6vw,42px);line-height:1.05;letter-spacing:-.022em;color:#fff;margin:8px 0 6px}
.bk-hero .bk-hero-author{font-size:13.5px;color:rgba(255,255,255,.78);font-weight:500}
.bk-hero .bk-hero-why{margin-top:14px;font-size:14.5px;line-height:1.55;color:rgba(255,255,255,.85);max-width:480px}
@media (max-width:560px){.bk-hero .bk-hero-why{margin-left:auto;margin-right:auto}}
.bk-hero-actions{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
@media (max-width:560px){.bk-hero-actions{justify-content:center}}
.bk-hero-go{padding:11px 22px;background:#fff;color:#1B1245;border:0;border-radius:12px;font-family:inherit;font-weight:600;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:transform .2s,box-shadow .25s}
.bk-hero-go:hover{transform:translateY(-1px);box-shadow:0 10px 22px -4px rgba(255,255,255,.18)}
.bk-hero-cover{width:140px;aspect-ratio:3/4;border-radius:12px;padding:22px 18px;display:flex;flex-direction:column;justify-content:space-between;color:#fff;box-shadow:0 18px 40px -14px rgba(0,0,0,.6)}
@media (max-width:560px){.bk-hero-cover{margin:0 auto}}
.bk-hero-cover h5{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:18px;line-height:1.05;letter-spacing:-.015em;color:#fff;margin:0}
.bk-hero-cover .auth{font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.1em;color:rgba(255,255,255,.78);text-transform:uppercase}

/* Category pills for books */
.bk-cats{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.bk-cat{padding:7px 14px;border-radius:999px;border:1px solid #ECEAE3;background:#fff;color:#3D3D3D;font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:all .2s}
.bk-cat:hover{border-color:#1A1A1A;color:#1A1A1A}
.bk-cat.on{background:#1A1A1A;color:#fff;border-color:#1A1A1A}

/* ═══════════════ DUOLINGO-STYLE LEARNING PATH ═══════════════ */
.vp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin:24px 0 14px;flex-wrap:wrap}
.vp-h{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:28px;letter-spacing:-.02em;color:#1A1A1A;margin:0;line-height:1.05}
.vp-sub{font-family:'JetBrains Mono','Space Mono',monospace;font-size:11px;letter-spacing:.06em;color:#6B6B6B;text-transform:uppercase;margin-top:4px}
.vp-stats{display:flex;gap:8px}
.vp-stat{padding:10px 14px;background:#fff;border:1px solid #ECEAE3;border-radius:14px;text-align:center;min-width:64px}
.vp-stat b{display:block;font-family:'Inter',sans-serif;font-weight:600;font-size:18px;letter-spacing:-.02em;color:#1A1A1A}
.vp-stat small{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.08em;color:#9A9A9A;text-transform:uppercase;margin-top:2px;display:block}
.vp-path{display:flex;flex-direction:column;gap:14px;margin-bottom:18px}
.vp-unit{position:relative;background:#fff;border:1px solid #ECEAE3;border-radius:18px;padding:18px;transition:border-color .25s,box-shadow .35s}
.vp-unit:hover{border-color:var(--vp-c,#FF6B47);box-shadow:0 14px 32px -16px rgba(0,0,0,.12)}
.vp-unit::before{content:'';position:absolute;top:0;left:0;width:5px;height:100%;background:var(--vp-c,#FF6B47);border-radius:18px 0 0 18px}
.vp-unit-done{background:linear-gradient(135deg,rgba(16,185,129,.04),#fff)}
.vp-unit-hd{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;margin-bottom:14px;padding-left:6px}
.vp-unit-ic{width:48px;height:48px;border-radius:14px;background:var(--vp-c,#FF6B47);display:grid;place-items:center;font-size:24px;box-shadow:0 8px 18px -6px var(--vp-c,#FF6B47);flex-shrink:0}
.vp-unit-tag{font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--vp-c,#FF6B47);font-weight:600;text-transform:uppercase}
.vp-unit-name{font-family:'Inter',sans-serif;font-weight:600;font-size:18px;letter-spacing:-.015em;color:#1A1A1A;margin-top:2px}
.vp-unit-desc{font-size:13px;color:#6B6B6B;line-height:1.45;margin-top:3px}
.vp-unit-prog{font-family:'Inter',sans-serif;font-weight:600;font-size:20px;color:var(--vp-c,#FF6B47);letter-spacing:-.02em}
.vp-unit-prog span{font-weight:400;color:#9A9A9A;font-size:14px}
.vp-lessons{display:flex;flex-direction:column;gap:6px;padding-left:6px}
.vp-lesson{display:grid;grid-template-columns:48px 1fr;gap:14px;align-items:center;padding:14px 16px;background:#FAFAF7;border:1px solid #ECEAE3;border-radius:14px;cursor:pointer;font-family:inherit;text-align:left;transition:transform .25s cubic-bezier(.16,1,.3,1),background .2s,border-color .2s}
.vp-lesson:hover{transform:translateX(4px);background:#fff;border-color:var(--vp-c,#FF6B47)}
.vp-lesson-locked{opacity:.55;cursor:not-allowed;background:#F4F3EE}
.vp-lesson-locked:hover{transform:none;border-color:#ECEAE3;background:#F4F3EE}
.vp-lesson-done{background:linear-gradient(135deg,rgba(16,185,129,.06),#fff);border-color:rgba(16,185,129,.3)}
.vp-l-num{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-family:'Inter',sans-serif;font-weight:600;font-size:14px;color:#fff;background:var(--vp-c,#FF6B47);box-shadow:0 4px 10px -3px var(--vp-c,#FF6B47);justify-self:center}
.vp-lesson-locked .vp-l-num{background:#CFCFCF;box-shadow:none;font-size:13px}
.vp-lesson-done .vp-l-num{background:#10B981;box-shadow:0 4px 10px -3px #10B981;font-size:16px;font-weight:700}
.vp-l-name{font-size:15px;font-weight:500;letter-spacing:-.005em;color:#1A1A1A}
.vp-l-stars{margin-top:4px;color:#E8E6E0;font-size:12px;letter-spacing:1.5px}
.vp-l-stars span.on{color:#F59E0B;text-shadow:0 0 6px rgba(245,158,11,.5)}
.vp-l-stars-empty{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#9A9A9A;letter-spacing:.05em;text-transform:uppercase}
.vp-lesson-locked .vp-l-name{color:#9A9A9A}

/* Lesson runner modal */
.vl-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:18px;animation:bk-fade .3s cubic-bezier(.16,1,.3,1)}
.vl-box{width:min(520px,100%);background:#FAFAF7;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);animation:bk-up .35s cubic-bezier(.16,1,.3,1)}
.vl-top{display:grid;grid-template-columns:1fr auto;gap:14px;padding:20px 22px 14px;border-bottom:1px solid #ECEAE3;background:#fff;align-items:center}
.vl-tag{font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--vl-c,#FF6B47);font-weight:600}
.vl-h{font-family:'Inter',sans-serif;font-weight:600;font-size:20px;letter-spacing:-.02em;color:#1A1A1A;margin-top:2px}
.vl-x{width:34px;height:34px;border-radius:50%;border:1px solid #ECEAE3;background:#fff;cursor:pointer;font-family:inherit;font-size:14px;color:#6B6B6B;display:grid;place-items:center;transition:all .2s}
.vl-x:hover{background:#FEF2F2;color:#DC2626;border-color:#FCA5A5}
.vl-progress{height:5px;background:#ECEAE3}
.vl-progress-fill{height:100%;background:var(--vl-c,#FF6B47);transition:width .5s cubic-bezier(.16,1,.3,1);box-shadow:0 0 8px var(--vl-c,#FF6B47)}
.vl-body{padding:30px 24px 22px;text-align:center;display:flex;flex-direction:column;gap:18px}
.vl-step{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;color:#9A9A9A;text-transform:uppercase}
.vl-phrase{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:clamp(22px,3.4vw,30px);line-height:1.3;color:#1A1A1A;padding:0 8px}
.vl-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.vl-btn{padding:13px 22px;border-radius:14px;border:0;cursor:pointer;font-family:inherit;font-weight:500;font-size:14px;display:inline-flex;align-items:center;gap:8px;transition:all .25s}
.vl-btn-ghost{background:#fff;color:#1A1A1A;border:1px solid #ECEAE3}
.vl-btn-ghost:hover{border-color:#1A1A1A}
.vl-btn-rec{background:linear-gradient(135deg,var(--vl-c,#FF6B47),color-mix(in oklab,var(--vl-c,#FF6B47) 70%,#000));color:#fff;box-shadow:0 8px 18px -6px var(--vl-c,#FF6B47);font-weight:600}
.vl-btn-rec:hover{transform:translateY(-1px);box-shadow:0 12px 24px -8px var(--vl-c,#FF6B47)}
.vl-btn-rec.recording{animation:cc-rec-pulse 1.4s ease-in-out infinite}
.vl-btn-primary{background:#1A1A1A;color:#fff;font-weight:600}
.vl-btn-primary:hover{background:#1F4D3F}
.vl-btn-primary:disabled{background:#CFCFCF;cursor:not-allowed}
.vl-result{padding:18px;border-radius:14px;font-family:'Inter',sans-serif}
.vl-r-good{background:linear-gradient(135deg,#ECFDF5,#D1FAE5);border:1px solid #6EE7B7;color:#065F46}
.vl-r-ok{background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FCD34D;color:#92400E}
.vl-r-miss{background:linear-gradient(135deg,#FEF2F2,#FEE2E2);border:1px solid #FCA5A5;color:#991B1B}
.vl-r-pct{font-family:'Inter',sans-serif;font-weight:700;font-size:36px;letter-spacing:-.03em;line-height:1}
.vl-r-meta{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-top:6px}
.vl-r-heard{font-size:13.5px;line-height:1.5;margin-top:10px;font-style:italic;opacity:.85}
.vl-foot{margin-top:6px}
.vl-foot .vl-btn-primary{width:100%;justify-content:center;font-size:15px;padding:15px}
.vl-end{padding:30px 24px;text-align:center}
.vl-end-stars{font-size:42px;letter-spacing:6px;margin-bottom:18px;color:#E8E6E0}
.vl-end-stars span.on{color:#F59E0B;text-shadow:0 0 18px rgba(245,158,11,.5)}
.vl-end-h{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:32px;letter-spacing:-.02em;color:#1A1A1A;margin-bottom:8px}
.vl-end-s{font-size:15px;color:#3D3D3D}
.vl-end-s b{font-weight:600;color:#1A1A1A;font-size:18px}
.vl-end-acts{display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap}

/* Skill grid + pronunciation drill — next-gen AI English trainer */
.vc-skills{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:18px}
@media (max-width:760px){.vc-skills{grid-template-columns:repeat(2,1fr)}}
@media (max-width:380px){.vc-skills{grid-template-columns:1fr}}
.vc-skill{position:relative;padding:18px 14px 14px;background:#fff;border:1px solid #ECEAE3;border-radius:16px;text-align:center;cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:6px;transition:transform .35s cubic-bezier(.16,1,.3,1),border-color .25s,box-shadow .3s}
.vc-skill:hover{transform:translateY(-3px);border-color:var(--vs-c,#FF6B47);box-shadow:0 14px 28px -12px var(--vs-shadow,rgba(255,107,71,.3))}
.vc-skill .vs-ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;font-size:20px;background:var(--vs-bg,linear-gradient(135deg,#FF8A4F,#FF6B47));box-shadow:0 6px 14px -4px var(--vs-shadow,rgba(255,107,71,.4));margin-bottom:6px;transition:transform .4s cubic-bezier(.34,1.56,.64,1)}
.vc-skill:hover .vs-ic{transform:rotate(-6deg) scale(1.06)}
.vc-skill .vs-name{font-size:12.5px;font-weight:600;letter-spacing:-.005em;color:#1A1A1A}
.vc-skill .vs-lvl{font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;color:#6B6B6B;letter-spacing:.06em;text-transform:uppercase}
.vc-skill[data-k=pronounce]{--vs-c:#0EA5E9;--vs-bg:linear-gradient(135deg,#7DD3FC,#0284C7);--vs-shadow:rgba(14,165,233,.4)}
.vc-skill[data-k=vocab]{--vs-c:#A855F7;--vs-bg:linear-gradient(135deg,#D8B4FE,#7E22CE);--vs-shadow:rgba(168,85,247,.4)}
.vc-skill[data-k=grammar]{--vs-c:#10B981;--vs-bg:linear-gradient(135deg,#6EE7B7,#059669);--vs-shadow:rgba(16,185,129,.4)}
.vc-skill[data-k=conv]{--vs-c:#FF6B47;--vs-bg:linear-gradient(135deg,#FF8A4F,#FF6B47);--vs-shadow:rgba(255,107,71,.4)}
.vc-skill[data-k=write]{--vs-c:#EC4899;--vs-bg:linear-gradient(135deg,#F9A8D4,#DB2777);--vs-shadow:rgba(236,72,153,.4)}
/* Pronunciation drill card */
.vc-pron{margin-bottom:18px;padding:24px;background:linear-gradient(135deg,#F0FBFF,#FFFFFF);border:1px solid #BAE6FD;border-radius:18px;display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center}
@media (max-width:560px){.vc-pron{grid-template-columns:1fr;text-align:center}}
.vc-pron-h{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#0284C7;font-weight:600}
.vc-pron-phrase{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:24px;line-height:1.2;color:#1A1A1A;margin:8px 0 4px}
.vc-pron-meta{font-size:13px;color:#6B6B6B;line-height:1.5}
.vc-pron-actions{display:flex;flex-direction:column;gap:8px}
@media (max-width:560px){.vc-pron-actions{flex-direction:row;justify-content:center}}
.vc-pron-btn{padding:11px 18px;border-radius:12px;border:0;cursor:pointer;font-family:inherit;font-weight:500;font-size:13.5px;display:inline-flex;align-items:center;gap:8px;justify-content:center;transition:transform .25s,background .2s}
.vc-pron-listen{background:#fff;color:#0284C7;border:1px solid #BAE6FD}
.vc-pron-listen:hover{background:#F0F9FF;transform:translateY(-1px)}
.vc-pron-rec{background:linear-gradient(135deg,#0EA5E9,#0284C7);color:#fff;box-shadow:0 6px 14px -4px rgba(14,165,233,.5)}
.vc-pron-rec:hover{transform:translateY(-1px);box-shadow:0 10px 20px -4px rgba(14,165,233,.6)}
.vc-pron-rec.recording{animation:cc-rec-pulse 1.4s ease-in-out infinite;background:linear-gradient(135deg,#EF4444,#DC2626)}
.vc-pron-result{margin-top:14px;padding:12px 14px;border-radius:10px;font-size:13.5px;line-height:1.5;font-family:'Inter',sans-serif}
.vc-pron-result.good{background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46}
.vc-pron-result.ok{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E}
.vc-pron-result.miss{background:#FEF2F2;border:1px solid #FECACA;color:#991B1B}
.vc-pron-result b{font-weight:600}

.vc-vocab-row{margin-bottom:18px}
.vc-vocab-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.vc-vocab-h h3{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:#1F4D3F;margin:0}
.vc-vocab-h .meta{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.06em;color:#6B6B6B}
.vc-vocab-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media (max-width:760px){.vc-vocab-grid{grid-template-columns:1fr}}
.vc-vocab-card{padding:18px 18px 16px;background:#fff;border:1px solid #E8E6E0;border-radius:14px;cursor:pointer;transition:transform .35s cubic-bezier(.16,1,.3,1),border-color .25s,box-shadow .3s;text-align:left;font-family:inherit;display:flex;flex-direction:column;gap:8px}
.vc-vocab-card:hover{transform:translateY(-3px);border-color:#1F4D3F;box-shadow:0 12px 28px -14px rgba(31,77,63,.35)}
.vc-vocab-card .word{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:24px;line-height:1;letter-spacing:-.015em;color:#1A1A1A}
.vc-vocab-card .pos{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6B6B6B}
.vc-vocab-card .def{font-size:13px;color:#3D3D3D;line-height:1.45}
.vc-vocab-card .ex{font-size:12.5px;color:#1F4D3F;font-style:italic;line-height:1.45;border-top:1px dashed #E8E6E0;padding-top:8px;margin-top:auto}

.vc-path{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.vc-path-pill{padding:7px 14px;border-radius:999px;font-size:12px;font-weight:500;letter-spacing:-.005em;border:1px solid #E8E6E0;background:#fff;color:#3D3D3D;cursor:pointer;transition:all .2s;font-family:inherit}
.vc-path-pill:hover{border-color:#1F4D3F;color:#1F4D3F}
.vc-path-pill.on{background:#1A1A1A;color:#fff;border-color:#1A1A1A}

/* MIND GYM extras: achievements row + week stats */
.mg-achievements{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px;margin-bottom:18px}
@media (max-width:600px){.mg-achievements{grid-template-columns:repeat(2,1fr)}}
.mg-ach{padding:14px 12px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.12);border-radius:14px;text-align:center;color:#fff;display:flex;flex-direction:column;align-items:center;gap:6px;transition:transform .35s cubic-bezier(.16,1,.3,1),border-color .25s;cursor:default}
.mg-ach:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.22)}
.mg-ach.locked{opacity:.5}
.mg-ach .medal{width:36px;height:36px;border-radius:999px;display:grid;place-items:center;font-size:18px;background:linear-gradient(135deg,#FCD34D,#F59E0B);color:#1A1A1A;box-shadow:0 0 16px rgba(252,211,77,.4)}
.mg-ach.locked .medal{background:rgba(255,255,255,.08);color:rgba(255,255,255,.4);box-shadow:none}
.mg-ach.streak .medal{background:linear-gradient(135deg,#FB923C,#DC2626);box-shadow:0 0 16px rgba(251,146,60,.4)}
.mg-ach.cool .medal{background:linear-gradient(135deg,#6EE7B7,#10B981);box-shadow:0 0 16px rgba(110,231,183,.4)}
.mg-ach.purple .medal{background:linear-gradient(135deg,#C4B5FD,#7C3AED);box-shadow:0 0 16px rgba(196,181,253,.4)}
.mg-ach .name{font-size:11px;font-weight:600;color:#fff;letter-spacing:-.005em}
.mg-ach .desc{font-size:10.5px;color:rgba(255,255,255,.7);line-height:1.3;font-family:'JetBrains Mono',monospace;letter-spacing:.02em}

/* ═══════════════ MIND GYM · Elevate-style card overhaul ═══════════════ */
.mg-grid-tab{grid-template-columns:repeat(2,1fr) !important;gap:14px !important}
@media (min-width:760px){.mg-grid-tab{grid-template-columns:repeat(2,1fr) !important}}
@media (min-width:1024px){.mg-grid-tab{grid-template-columns:repeat(4,1fr) !important}}
.mg-grid-tab .mg-card{
  background:#FFFFFF !important;
  border:1px solid #ECEAE3 !important;
  border-radius:18px !important;
  padding:22px 20px 20px !important;
  min-height:200px !important;
  position:relative;
  overflow:hidden;
  display:flex !important;
  flex-direction:column !important;
  gap:14px !important;
  transition:transform .4s cubic-bezier(.16,1,.3,1), box-shadow .35s, border-color .25s !important;
  box-shadow:0 1px 2px rgba(0,0,0,.02), 0 1px 3px rgba(0,0,0,.04) !important;
}
.mg-grid-tab .mg-card:hover{
  transform:translateY(-5px) !important;
  box-shadow:0 18px 36px -14px rgba(0,0,0,.16), 0 4px 10px rgba(0,0,0,.05) !important;
  border-color:#CFCBC0 !important;
}
.mg-grid-tab .mg-card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:5px;background:var(--mg-accent, #6366F1);transition:height .35s cubic-bezier(.16,1,.3,1);
}
.mg-grid-tab .mg-card:hover::before{ height:8px }

/* Replace inline emoji with proper gradient icon "tile" */
.mg-grid-tab .mg-card-hd{display:flex !important;align-items:flex-start !important;justify-content:space-between !important;gap:12px !important}
.mg-grid-tab .mg-card-emoji{
  width:54px !important;height:54px !important;
  border-radius:16px !important;
  display:grid !important;place-items:center !important;
  background:var(--mg-icon-bg, linear-gradient(135deg,#A5B4FC,#6366F1)) !important;
  font-size:26px !important;line-height:1 !important;
  box-shadow:0 8px 16px -6px var(--mg-icon-shadow, rgba(99,102,241,.4)) !important;
  flex-shrink:0 !important;
  transition:transform .4s cubic-bezier(.34,1.56,.64,1);
}
.mg-grid-tab .mg-card:hover .mg-card-emoji{ transform:rotate(-6deg) scale(1.06) }
.mg-grid-tab .mg-card-name{
  font-family:'Inter',sans-serif !important;
  font-weight:600 !important;
  font-size:16px !important;
  letter-spacing:-.015em !important;
  text-transform:none !important;
  color:#1A1A1A !important;
  line-height:1.2 !important;
  margin-top:2px;
}
.mg-grid-tab .mg-card-lvl{
  background:rgba(0,0,0,.04) !important;color:#3D3D3D !important;
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-weight:600 !important;font-size:10.5px !important;
  letter-spacing:.06em !important;
  padding:4px 10px !important;border-radius:999px !important;
}
.mg-grid-tab .mg-card-d{
  font-size:12.5px !important;color:#6B6B6B !important;
  line-height:1.45 !important;
  margin-top:-4px;
  font-weight:450 !important;
}
.mg-grid-tab .mg-bar{
  background:#F1EFE8 !important;border-radius:999px;overflow:hidden;
  height:4px !important;margin-top:auto;
}
.mg-grid-tab .mg-bar-fill{
  background:var(--mg-accent, #6366F1) !important;
  height:100% !important;border-radius:999px;
  transition:width .8s cubic-bezier(.16,1,.3,1);
}
.mg-grid-tab .mg-card-foot{
  display:flex !important;justify-content:space-between !important;align-items:center;
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-size:10.5px !important;letter-spacing:.06em !important;
  text-transform:uppercase !important;color:#9A9A9A !important;
  margin-top:4px !important;
}
.mg-grid-tab .mg-card-foot b{
  color:#1A1A1A !important;font-weight:600 !important;font-size:13px !important;
  font-family:'Inter',sans-serif !important;letter-spacing:-.01em !important;
  text-transform:none !important;
}

/* Per-game color tokens */
.mg-grid-tab .mg-math{    --mg-accent:#6366F1; --mg-icon-bg:linear-gradient(135deg,#818CF8,#4338CA); --mg-icon-shadow:rgba(99,102,241,.45) }
.mg-grid-tab .mg-memory{  --mg-accent:#EC4899; --mg-icon-bg:linear-gradient(135deg,#F9A8D4,#DB2777); --mg-icon-shadow:rgba(236,72,153,.45) }
.mg-grid-tab .mg-reaction{--mg-accent:#F59E0B; --mg-icon-bg:linear-gradient(135deg,#FCD34D,#D97706); --mg-icon-shadow:rgba(245,158,11,.45) }
.mg-grid-tab .mg-word{    --mg-accent:#10B981; --mg-icon-bg:linear-gradient(135deg,#6EE7B7,#059669); --mg-icon-shadow:rgba(16,185,129,.45) }
.mg-grid-tab .mg-math, .mg-grid-tab .mg-memory, .mg-grid-tab .mg-reaction, .mg-grid-tab .mg-word{
  background:#FFFFFF !important;border-color:#ECEAE3 !important;
}

/* Word Sprint — light-theme override for the main app modal (mg-mdl context) */
.mg-mdl .mw-body{padding:24px 22px 22px !important;background:#FAFAF7 !important}
.mg-mdl .mw-stats{color:#3D3D3D !important}
.mg-mdl .mw-stats b{color:#1A1A1A !important}
.mg-mdl .mw-let{
  background:linear-gradient(180deg,#FFFFFF,#F4F3EE) !important;
  border:1.5px solid #E8E6E0 !important;
  color:#1A1A1A !important;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 2px 6px rgba(0,0,0,.05) !important;
}
.mg-mdl .mw-let:hover{
  background:linear-gradient(180deg,#fff,#FAFAF7) !important;
  border-color:#1F4D3F !important;
  box-shadow:0 4px 12px rgba(31,77,63,.18) !important;
  transform:translateY(-2px) !important;
}
.mg-mdl .mw-let.used{opacity:.35 !important;background:#F4F3EE !important}
.mg-mdl .mw-cur{
  border:2px dashed #CFCFCF !important;
  background:#fff !important;
  color:#1A1A1A !important;
  box-shadow:0 1px 3px rgba(0,0,0,.05) inset !important;
}
.mg-mdl .mw-cur.flash-good{border-color:#10B981 !important;background:#EDFCF2 !important;color:#0E6D33 !important}
.mg-mdl .mw-cur.flash-bad{border-color:#F87171 !important;background:#FEF1F0 !important;color:#A02B23 !important}
.mg-mdl .mw-btn{
  background:#fff !important;border:1.5px solid #E8E6E0 !important;color:#1A1A1A !important;
}
.mg-mdl .mw-btn:hover{border-color:#1A1A1A !important;background:#FAFAF7 !important}
.mg-mdl .mw-btn-primary{background:#1A1A1A !important;color:#fff !important;border-color:#1A1A1A !important}
.mg-mdl .mw-btn-primary:hover{background:#1F4D3F !important;border-color:#1F4D3F !important}
.mg-mdl .mw-found{background:#fff !important;border:1px solid #E8E6E0 !important}
.mg-mdl .mw-found .empty{color:#9A9A9A !important}
.mg-mdl .mw-found span{background:#EDFCF2 !important;border:1px solid #B7E8C4 !important;color:#0E6D33 !important}

/* Word Sprint game UI */
.mw-body{padding:18px 22px 22px;display:flex;flex-direction:column;gap:14px;align-items:center}
.mw-stats{display:flex;gap:24px;font-family:'JetBrains Mono','Space Mono',monospace;font-size:11px;font-weight:500;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.06em}
.mw-stats span{display:flex;flex-direction:column;align-items:center}
.mw-stats b{font-family:'Inter','Space Mono',sans-serif;font-size:22px;color:#fff;display:block;letter-spacing:-.02em;margin-bottom:3px}
.mw-letters{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.mw-let{width:48px;height:58px;border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.06));border:1.5px solid rgba(255,255,255,.22);color:#fff;font:600 24px/1 'Inter',sans-serif;display:grid;place-items:center;cursor:pointer;user-select:none;transition:transform .15s cubic-bezier(.34,1.56,.64,1),background .2s,border-color .2s;font-family:inherit}
.mw-let:hover{background:linear-gradient(180deg,rgba(255,255,255,.28),rgba(255,255,255,.1));border-color:rgba(255,255,255,.4);transform:translateY(-2px)}
.mw-let.used{opacity:.3;pointer-events:none}
@media (max-width:480px){.mw-let{width:40px;height:50px;font-size:20px}}
.mw-cur{min-height:48px;padding:10px 22px;border:2px dashed rgba(255,255,255,.22);border-radius:12px;font:600 22px/1 'Inter',sans-serif;letter-spacing:.06em;color:#fff;min-width:240px;text-align:center;background:rgba(255,255,255,.03);display:flex;align-items:center;justify-content:center;transition:all .25s}
.mw-cur.flash-good{border-color:#10B981;background:rgba(16,185,129,.18);color:#6EE7B7;animation:mw-flash .4s cubic-bezier(.34,1.56,.64,1)}
.mw-cur.flash-bad{border-color:#F87171;background:rgba(248,113,113,.16);color:#FCA5A5}
@keyframes mw-flash{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
.mw-acts{display:flex;gap:8px;flex-wrap:wrap}
.mw-btn{padding:10px 18px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#fff;font:600 13px/1 'Inter',sans-serif;cursor:pointer;transition:all .2s;font-family:inherit}
.mw-btn:hover{border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.12)}
.mw-btn-primary{background:#fff;color:#0F172A;border-color:#fff}
.mw-btn-primary:hover{background:#FCD34D;border-color:#FCD34D}
.mw-found{width:100%;max-width:520px;min-height:54px;padding:10px 14px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.03);display:flex;flex-wrap:wrap;gap:5px;justify-content:center;align-content:flex-start}
.mw-found .empty{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.5);letter-spacing:.06em;text-transform:uppercase;margin:auto;padding:10px}
.mw-found span{padding:5px 11px;background:rgba(110,231,183,.18);border:1px solid rgba(110,231,183,.4);border-radius:999px;font:500 12px/1 'JetBrains Mono','Space Mono',monospace;color:#6EE7B7;letter-spacing:.04em;animation:mw-wordin .4s cubic-bezier(.34,1.56,.64,1)}
@keyframes mw-wordin{from{opacity:0;transform:scale(.7)}}

/* "Coming soon" preview card for next-gen game */
.mg-card-preview{position:relative;overflow:hidden}
.mg-card-preview::before{content:'COMING SOON';position:absolute;top:12px;right:12px;padding:3px 8px;background:rgba(252,211,77,.18);border:1px solid rgba(252,211,77,.4);border-radius:999px;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.08em;color:#FCD34D;z-index:2}
.mg-card-preview{cursor:not-allowed !important}
.mg-card-preview:hover{transform:none !important}

/* ═══════════════ BOOKS · 15-min summaries ═══════════════ */
.bk-mode-toggle{display:inline-flex;gap:4px;padding:4px;background:#F4F3EE;border:1px solid #E8E6E0;border-radius:999px;margin-bottom:18px}
.bk-mode-toggle button{padding:8px 16px;border-radius:999px;font-weight:500;font-size:13.5px;color:#6B6B6B;background:transparent;border:0;cursor:pointer;transition:all .2s;font-family:inherit}
.bk-mode-toggle button.on{background:#1A1A1A;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.bk-sum-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px;margin-bottom:24px}
.bk-sum-card{cursor:pointer;border:0;background:none;padding:0;font-family:inherit;text-align:left;display:flex;flex-direction:column;gap:10px;transition:transform .35s cubic-bezier(.16,1,.3,1)}
.bk-sum-card:hover{transform:translateY(-4px)}
.bk-sum-cover{position:relative;aspect-ratio:3/4;border-radius:14px;padding:18px 16px;display:flex;flex-direction:column;justify-content:space-between;color:#fff;border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 36px -12px rgba(0,0,0,.55);overflow:hidden;isolation:isolate}
.bk-sum-cover::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 35%,rgba(255,255,255,.14) 50%,transparent 65%);transform:translateX(-100%);transition:transform .8s cubic-bezier(.16,1,.3,1);pointer-events:none}
.bk-sum-card:hover .bk-sum-cover::after{transform:translateX(100%)}
.bk-sum-cover h5{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:20px;line-height:1.05;letter-spacing:-.015em;color:#fff;margin:0}
.bk-sum-cover .auth{font-family:'JetBrains Mono','Space Mono',monospace;font-size:10px;font-weight:500;letter-spacing:.1em;color:rgba(255,255,255,.78);text-transform:uppercase;margin-top:6px}
.bk-sum-mins{position:absolute;top:12px;right:12px;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.08em;color:#fff;text-transform:uppercase;border:1px solid rgba(255,255,255,.15)}
.bk-sum-meta{font-size:13px;font-weight:500;letter-spacing:-.005em;color:#1A1A1A;line-height:1.25}
.bk-sum-meta small{display:block;color:#6B6B6B;font-weight:400;font-size:11.5px;margin-top:3px}
/* Reader modal */
.bk-reader{position:fixed;inset:0;z-index:200;background:rgba(4,4,8,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);overflow-y:auto;padding:20px;animation:bk-fade .3s cubic-bezier(.16,1,.3,1)}
@keyframes bk-fade{from{opacity:0}}
.bk-reader-box{width:min(820px,100%);background:#FAFAF7;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);margin:0 auto 80px;animation:bk-up .4s cubic-bezier(.16,1,.3,1)}
@keyframes bk-up{from{opacity:0;transform:translateY(24px)}}
.bk-reader-top{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #E8E6E0;background:#fff;position:sticky;top:0;z-index:5}
.bk-reader-top .label{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6B6B6B}
.bk-x{width:32px;height:32px;border-radius:999px;border:1px solid #E8E6E0;background:#fff;cursor:pointer;display:grid;place-items:center;color:#1A1A1A;font-family:inherit;font-size:14px;transition:background .2s,border-color .2s}
.bk-x:hover{background:#F4F3EE;border-color:#CFCFCF}
.bk-reader-hero{display:grid;grid-template-columns:180px 1fr;gap:30px;padding:28px;align-items:start}
@media (max-width:600px){.bk-reader-hero{grid-template-columns:1fr;gap:18px;padding:22px}.bk-reader-hero > .cover{max-width:200px;margin:0 auto}}
.bk-reader-hero > .cover{aspect-ratio:3/4;border-radius:14px;padding:22px 18px;display:flex;flex-direction:column;justify-content:space-between;color:#fff;box-shadow:0 16px 40px -12px rgba(0,0,0,.5)}
.bk-reader-hero > .cover h2{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:26px;line-height:1;letter-spacing:-.015em;color:#fff;margin:0}
.bk-reader-hero > .cover .auth{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;letter-spacing:.1em;color:rgba(255,255,255,.78);text-transform:uppercase}
.bk-reader-hero .info h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:34px;line-height:1.02;letter-spacing:-.025em;color:#1A1A1A;margin:0}
.bk-reader-hero .info .by{margin-top:8px;color:#6B6B6B;font-size:14px}
.bk-reader-hero .info .by b{color:#1A1A1A;font-weight:500}
.bk-reader-hero .info .why{margin-top:16px;color:#1A1A1A;font-size:15px;line-height:1.55;max-width:440px}
.bk-reader-hero .info .stats{display:flex;gap:24px;margin-top:20px;flex-wrap:wrap}
.bk-reader-hero .info .stats > div{display:flex;flex-direction:column}
.bk-reader-hero .info .stats .num{font-family:'Inter',sans-serif;font-weight:600;font-size:20px;letter-spacing:-.02em;color:#1A1A1A}
.bk-reader-hero .info .stats .lbl{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B6B6B;margin-top:3px}
.bk-reader-hero .info .actions{display:flex;gap:8px;margin-top:22px;flex-wrap:wrap}
.bk-btn{padding:11px 18px;border-radius:10px;font-weight:500;font-size:14px;cursor:pointer;border:0;font-family:inherit;transition:background .2s,transform .2s,border-color .2s;display:inline-flex;align-items:center;gap:8px}
.bk-btn-primary{background:#1A1A1A;color:#fff}
.bk-btn-primary:hover{background:#1F4D3F;transform:translateY(-1px)}
.bk-btn-ghost{background:#fff;color:#1A1A1A;border:1px solid #E8E6E0}
.bk-btn-ghost:hover{border-color:#1A1A1A}
.bk-section{padding:0 28px 28px}
@media (max-width:600px){.bk-section{padding:0 22px 24px}}
.bk-section h3{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:#1F4D3F;margin:24px 0 14px}
.bk-insight{display:grid;grid-template-columns:auto 1fr;gap:18px;padding:18px 20px;background:#fff;border:1px solid #E8E6E0;border-radius:12px;margin-bottom:8px;transition:border-color .2s}
.bk-insight:hover{border-color:#CFCFCF}
.bk-insight .n{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:24px;color:#1F4D3F;width:32px;line-height:1;padding-top:2px}
.bk-insight h4{font-size:15px;font-weight:600;letter-spacing:-.005em;color:#1A1A1A;margin:0 0 4px}
.bk-insight p{font-size:13.5px;color:#3D3D3D;line-height:1.5;margin:0}
.bk-summary{font-size:15.5px;color:#1A1A1A;line-height:1.75;letter-spacing:-.005em;font-family:'Inter',sans-serif}
.bk-summary p{margin-top:14px}.bk-summary p:first-child{margin-top:0;font-style:italic;color:#3D3D3D}
.bk-tts{position:sticky;bottom:0;display:flex;align-items:center;gap:14px;padding:14px 20px;background:rgba(255,255,255,.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid #E8E6E0}
.bk-tts .play{width:42px;height:42px;border-radius:999px;background:#1A1A1A;color:#fff;border:0;cursor:pointer;display:grid;place-items:center;font-family:inherit;font-size:14px;transition:background .2s,transform .2s}
.bk-tts .play:hover{background:#1F4D3F;transform:scale(1.05)}
.bk-tts .info{flex:1;min-width:0}
.bk-tts .info b{display:block;font-size:13px;font-weight:500;color:#1A1A1A;letter-spacing:-.005em}
.bk-tts .info small{display:block;font-size:11px;color:#6B6B6B;margin-top:2px}
.bk-tts .speed{padding:6px 12px;background:#fff;border:1px solid #E8E6E0;border-radius:999px;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:500;cursor:pointer;color:#1A1A1A}
.bk-tts .speed:hover{border-color:#1A1A1A}

/* ═══════════════ INTERNATIONAL POLISH — visible tab upgrades ═══════════════ */
/* Smoother spring + refined motion tokens */
@keyframes intlFadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes intlShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes intlGlow{0%,100%{filter:drop-shadow(0 0 0 transparent)}50%{filter:drop-shadow(0 0 24px rgba(167,139,250,.45))}}

/* MIND GYM hero — richer aurora mesh, depth, subtle float */
.mg-hero{
  background:
    radial-gradient(1100px 600px at 0% 0%, rgba(167,139,250,.32) 0%, transparent 55%),
    radial-gradient(900px 500px at 100% 0%, rgba(252,211,77,.18) 0%, transparent 55%),
    radial-gradient(1200px 700px at 50% 130%, rgba(91,33,182,.5) 0%, transparent 55%),
    linear-gradient(135deg, #0B0F1A 0%, #1A1244 38%, #3B1675 100%) !important;
  border:1px solid rgba(255,255,255,.08);
  box-shadow:
    0 24px 60px -20px rgba(91,33,182,.55),
    0 1px 0 rgba(255,255,255,.06) inset,
    0 -1px 0 rgba(0,0,0,.3) inset !important;
  animation:intlFadeUp .7s cubic-bezier(.16,1,.3,1) both;
  position:relative;
}
.mg-hero::after{
  content:''; position:absolute; inset:0; pointer-events:none; border-radius:inherit;
  background:linear-gradient(105deg, transparent 35%, rgba(255,255,255,.08) 50%, transparent 65%);
  transform:translateX(-100%);
  animation:intlShimmer 6s ease-in-out infinite;
}
.mg-hero-t{
  font-family:'Instrument Serif', Georgia, serif !important;
  font-weight:400 !important;
  font-size:clamp(34px, 4.4vw, 46px) !important;
  letter-spacing:-.025em !important;
  line-height:1.02 !important;
}
.mg-hero-s{ font-size:14.5px !important; line-height:1.55 !important; max-width:560px }

/* Stat tiles — glassy, with a subtle inner glow */
.mg-stat{
  background:linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,.04)) !important;
  border:1px solid rgba(255,255,255,.18) !important;
  box-shadow:0 1px 0 rgba(255,255,255,.08) inset, 0 8px 24px -12px rgba(0,0,0,.4);
  transition:transform .35s cubic-bezier(.16,1,.3,1), background .25s, border-color .25s;
  padding:14px 14px !important;
  border-radius:14px !important;
}
.mg-stat:hover{
  transform:translateY(-2px);
  background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.06)) !important;
  border-color:rgba(255,255,255,.26) !important;
}
.mg-stat b{
  font-family:'Inter', sans-serif !important;
  font-weight:600 !important;
  font-size:26px !important;
  background:linear-gradient(180deg, #FCD34D, #F59E0B);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 0 14px rgba(252,211,77,.35));
}
.mg-stat-streak b{
  background:linear-gradient(180deg, #FB923C, #DC2626) !important;
  -webkit-background-clip:text !important; background-clip:text !important;
  filter:drop-shadow(0 0 14px rgba(251,146,60,.45)) !important;
}
.mg-stat small{ font-size:10px !important; letter-spacing:.12em !important; opacity:.7 }

/* Game cards — premium glass with mouse spotlight, lift, soft glow */
.mg-card{
  background:
    radial-gradient(circle at var(--sx, 50%) var(--sy, 50%), rgba(255,255,255,.14) 0%, transparent 50%),
    linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02)) !important;
  border:1px solid rgba(255,255,255,.12) !important;
  border-radius:16px !important;
  padding:18px 16px 16px !important;
  transition:transform .45s cubic-bezier(.34,1.56,.64,1), border-color .3s, box-shadow .35s !important;
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 8px 24px -16px rgba(0,0,0,.4);
  animation:intlFadeUp .6s cubic-bezier(.16,1,.3,1) both;
}
.mg-card:nth-of-type(2){ animation-delay:.06s }
.mg-card:nth-of-type(3){ animation-delay:.12s }
.mg-card:nth-of-type(4){ animation-delay:.18s }
.mg-card:hover{
  transform:translateY(-5px) !important;
  border-color:rgba(255,255,255,.24) !important;
  box-shadow:0 1px 0 rgba(255,255,255,.1) inset, 0 24px 48px -16px rgba(0,0,0,.6) !important;
}
.mg-card-name{ font-family:'Inter', sans-serif !important; font-weight:600 !important; letter-spacing:.04em !important; font-size:13.5px !important }
.mg-card-d{ font-size:12.5px !important; color:rgba(255,255,255,.72) !important; line-height:1.45 !important }
.mg-card-emoji{ font-size:24px !important; filter:drop-shadow(0 4px 12px rgba(0,0,0,.3)) }
.mg-card-lvl{
  background:linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.1)) !important;
  border:1px solid rgba(255,255,255,.2);
  font-weight:600 !important; font-size:10.5px !important; letter-spacing:.06em !important;
  padding:3px 9px !important;
}
.mg-card-foot{ font-size:11px !important; opacity:.85 }
.mg-card-foot b{ font-weight:600 !important; letter-spacing:.02em !important }

/* VOICE tab cc-hero — same premium treatment */
.cc-hero{
  background:
    radial-gradient(1100px 600px at 0% 0%, rgba(167,139,250,.34) 0%, transparent 55%),
    radial-gradient(800px 500px at 100% 100%, rgba(124,58,237,.55) 0%, transparent 55%),
    linear-gradient(135deg, #0B0F1A 0%, #1E1B4B 50%, #5B21B6 100%) !important;
  border:1px solid rgba(255,255,255,.08);
  box-shadow:0 24px 60px -20px rgba(124,58,237,.55), 0 1px 0 rgba(255,255,255,.06) inset !important;
  animation:intlFadeUp .7s cubic-bezier(.16,1,.3,1) both;
}
.cc-hero-t{
  font-family:'Instrument Serif', Georgia, serif !important;
  font-weight:400 !important;
  font-size:clamp(34px, 4.4vw, 46px) !important;
  letter-spacing:-.025em !important;
  line-height:1.02 !important;
}
.cc-hero-s{ font-size:14.5px !important; line-height:1.55 !important; max-width:580px }
.cc-hero-orb{ animation:ccOrb 8s ease-in-out infinite alternate, intlGlow 4s ease-in-out infinite }

/* Section spacing breath room */
.mg-hero-eyebrow, .cc-hero-eyebrow{
  font-family:'JetBrains Mono','Space Mono',monospace !important;
  font-weight:500 !important;
  font-size:11px !important;
  letter-spacing:.18em !important;
  opacity:.75;
}

/* Reduced motion respect */
@media (prefers-reduced-motion: reduce){
  .mg-hero,.cc-hero,.mg-card{animation:none !important}
  .mg-hero::after{display:none}
}
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
<script>/*__SERVER_INJECT__*/</script>
<script>
const MORALS=[{t:"The secret of getting ahead is getting started.",a:"Mark Twain"},{t:"It does not matter how slowly you go as long as you do not stop.",a:"Confucius"},{t:"Small daily improvements are the key to staggering long-term results.",a:"Robin Sharma"},{t:"Discipline is choosing between what you want now and what you want most.",a:"Abraham Lincoln"},{t:"Don't count the days. Make the days count.",a:"Muhammad Ali"},{t:"The best way to predict the future is to create it.",a:"Peter Drucker"},{t:"Focus on being productive instead of busy.",a:"Tim Ferriss"},{t:"You don't have to be great to start, but you have to start to be great.",a:"Zig Ziglar"},{t:"The journey of a thousand miles begins with a single step.",a:"Lao Tzu"},{t:"Either you run the day or the day runs you.",a:"Jim Rohn"},{t:"A year from now you may wish you had started today.",a:"Karen Lamb"},{t:"Success is the sum of small efforts repeated day in and day out.",a:"Robert Collier"},{t:"Done is better than perfect.",a:"Sheryl Sandberg"},{t:"The way to get started is to quit talking and begin doing.",a:"Walt Disney"},{t:"You cannot escape the responsibility of tomorrow by evading it today.",a:"Abraham Lincoln"},{t:"Motivation gets you going, but discipline keeps you growing.",a:"John C. Maxwell"},{t:"Do something today that your future self will thank you for.",a:"Sean Patrick Flanery"},{t:"The harder I work, the luckier I get.",a:"Samuel Goldwyn"},{t:"Don't watch the clock; do what it does. Keep going.",a:"Sam Levenson"},{t:"Great things never come from comfort zones.",a:"Neil Strauss"},{t:"Sometimes later becomes never. Do it now.",a:"Anonymous"},{t:"Wake up with determination. Go to bed with satisfaction.",a:"Anonymous"},{t:"A goal without a plan is just a wish.",a:"Antoine de Saint-Exupéry"},{t:"Little by little, day by day, what is meant for you will find its way.",a:"Anonymous"},{t:"Success doesn't just find you — you have to go out and get it.",a:"Anonymous"},{t:"Push yourself, because no one else is going to do it for you.",a:"Anonymous"},{t:"Dream big. Start small. Act now.",a:"Robin Sharma"},{t:"Hard work beats talent when talent doesn't work hard.",a:"Tim Notke"},{t:"The only impossible journey is the one you never begin.",a:"Tony Robbins"},{t:"Opportunities don't happen. You create them.",a:"Chris Grosser"}];
let S={tasks:[],view:'all',search:'',tab:'tasks',showAdd:false,editing:null,listening:false,toast:null,toastType:'ok',waOk:false,sending:{},user:null,
books:[],booksLoading:false,booksCat:'all',bookSearch:'',playing:null,moralIdx:Math.floor(Math.random()*MORALS.length),
knowledge:{loading:false,loaded:{},articles:{},events:[],topic:'history',sec:'today'},
game:{active:false,board:Array(9).fill(null),turn:'X',status:'idle',winLine:null,wins:Number(localStorage.getItem('tf_ttt_wins')||0),losses:Number(localStorage.getItem('tf_ttt_losses')||0),draws:Number(localStorage.getItem('tf_ttt_draws')||0)},
coin:{face:null,flipping:false,heads:Number(localStorage.getItem('tf_coin_h')||0),tails:Number(localStorage.getItem('tf_coin_t')||0)},
rps:{playerWins:Number(localStorage.getItem('tf_rps_w')||0),botWins:Number(localStorage.getItem('tf_rps_l')||0),draws:Number(localStorage.getItem('tf_rps_d')||0),lastPlayer:null,lastBot:null,lastResult:null},
guess:{target:null,attempts:0,history:[],message:'',ended:false},
dice:{values:[],history:[],rolling:false},
// Mind Gym — server-tracked progress + ephemeral per-play state
mg:{progress:{math:{level:1,xp:0,best:0},memory:{level:1,xp:0,best:0},reaction:{level:1,xp:0,best:0},word:{level:1,xp:0,best:0}},streak:{current:0,longest:0,total:0},loaded:false},
mgPlay:null,  // {game:'math|memory|reaction', ...gameSpecificState}
// Voice Trainer
voice:{loaded:false,curriculum:{days:[]},progress:{completed:0,totalPoints:0,pct:0,level:1,maxLevel:4,rows:[]}},
voicePlay:null,
// AI Coach (Phase 2)
coach:{status:null,history:[],input:'',sending:false,recording:false,recAudio:null,playing:false,scenario:null},
weather:{city:localStorage.getItem('tf_city')||'Bangalore',temp:null,aqi:null,country:'',loaded:false,loading:false,error:null},
cityTemps:{},remember:{person:null,loaded:false},lifeGoal:localStorage.getItem('tf_life_goal')||'',meditating:{active:false,title:'',mins:0,startedAt:0},
medCat:localStorage.getItem('tf_medcat')||'vipassana',
ticker:{items:[],idx:0,loaded:false},
waConnected:false,showWAOnboard:false,activeMeditation:null,
google:{configured:false,accounts:[],loaded:false},gcalEvents:[],gcalLoading:false,showGcalAdd:false,gcalForm:{title:'',date:'',time:'',duration:30,notes:'',email:''},
calMonth:new Date(),calSelectedDate:new Date().toISOString().slice(0,10),
steps:[],stepGoal:parseInt(localStorage.getItem('step_goal')||'10000',10),stepLive:{active:false,count:0},
theme:localStorage.getItem('theme')||'classic',
news:{},newsCat:'world',newsLoading:false,
bookStreak:{streak:0,total:0,today:false,days:[]},_bkSec:0,

loginStep:'phone',loginMethod:'email',loginPhone:'',loginCountryCode:localStorage.getItem('tf_cc')||'+91',loginEmail:'',loginName:'',loginOTP:['','','','','',''],loginLoading:false,loginError:'',loginErrorDetail:'',loginErrorCode:0,loginSentTo:'',emailOk:false,
form:{title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending'},
board:'combined'};  // Boards UI removed per user request — single unified task list. Data model retained.
try{localStorage.removeItem('tf_board')}catch(e){}  // clean up legacy key from previous boards UI
let rec=null,token=localStorage.getItem('tf_token');
if(token){S.user={phone:localStorage.getItem('tf_phone'),name:localStorage.getItem('tf_name'),token}}else{restoreLoginState();
  // Strongest fallback: server-side cookie (set on send-otp success) injected by the / route.
  // Survives iOS Safari tab kills + localStorage purges. Cookie expires after 10 min or on verify success.
  if(window.__PENDING_OTP_EMAIL){
    S.loginEmail=window.__PENDING_OTP_EMAIL;
    S.loginMethod='email';
    S.loginStep='otp';
    S.loginSentTo=window.__PENDING_OTP_EMAIL;
    try{if(location.hash!=='#otp')history.replaceState(null,'','#otp')}catch(e){}
  }
  // Belt 1 — bare hash: URL says mid-OTP and we have email/phone from localStorage
  if(location.hash==='#otp'&&(S.loginEmail||S.loginPhone)){S.loginStep='otp'}
  // Belt 2 — full hash with id: even with no localStorage and no cookie, the URL hash
  // alone restores the OTP step. Survives mobile tab discards, Safari ITP wipes,
  // private-window restarts. Format: #otp:user@example.com or #otp:+919876543210
  if(/^#otp:./.test(location.hash)){
    try{
      const id=decodeURIComponent(location.hash.slice(5));
      if(id){
        if(/@/.test(id)){S.loginEmail=id;S.loginMethod='email'}
        else{S.loginPhone=id;S.loginMethod='whatsapp'}
        S.loginStep='otp';
        S.loginSentTo=id;
      }
    }catch(e){}
  }
}

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
games:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="9" width="26" height="16" rx="6" fill="currentColor" opacity="0.18"/><circle cx="9" cy="17" r="2.4" fill="currentColor"/><circle cx="22.5" cy="14" r="1.6" fill="currentColor"/><circle cx="25.5" cy="17" r="1.6" fill="currentColor" opacity="0.65"/><circle cx="22.5" cy="20" r="1.6" fill="currentColor" opacity="0.65"/><circle cx="19.5" cy="17" r="1.6" fill="currentColor" opacity="0.65"/><line x1="6.5" y1="17" x2="11.5" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/><line x1="9" y1="14.5" x2="9" y2="19.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/></svg>',
mindgym:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 6 C 7 6 4 9 4 13 C 4 14.5 4.5 16 5.5 17.2 C 5 18.5 5 20 6 21.5 C 7 23 9 24 11 24 L 11 28 L 14 28 L 14 6 Z" fill="currentColor" opacity="0.85"/><path d="M21 6 C 25 6 28 9 28 13 C 28 14.5 27.5 16 26.5 17.2 C 27 18.5 27 20 26 21.5 C 25 23 23 24 21 24 L 21 28 L 18 28 L 18 6 Z" fill="currentColor" opacity="0.55"/><circle cx="9.5" cy="13" r="1.4" fill="#fff" opacity="0.9"/><circle cx="22.5" cy="13" r="1.4" fill="#fff" opacity="0.7"/></svg>',
voice:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="13" y="4" width="6" height="16" rx="3" fill="currentColor" opacity="0.85"/><path d="M8 14 C 8 18.5 11.5 22 16 22 C 20.5 22 24 18.5 24 14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none" opacity="0.55"/><line x1="16" y1="22" x2="16" y2="27" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity="0.55"/><line x1="12" y1="27" x2="20" y2="27" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity="0.55"/></svg>',
knowledge:'<svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 7 a2 2 0 0 1 2 -2 h18 a2 2 0 0 1 2 2 v18 a2 2 0 0 1 -2 2 h-18 a2 2 0 0 1 -2 -2 z" fill="currentColor" opacity="0.2"/><path d="M5 25 a2 2 0 0 0 2 2 h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M9 9 v14 M22 9 v14 M9 12 H 22 M9 18 H 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/><circle cx="13" cy="13" r="1" fill="currentColor"/><circle cx="13" cy="20" r="1" fill="currentColor"/></svg>'
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
  knowledge:{img:'1481627834876-b7833e8f5570',h:'The Knowledge desk',s:'History \\u2022 Geography \\u2022 Space \\u2022 Karma & Dharma'}
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
knowledge:'<svg '+s+'><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v2H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'};return m[n]||''}
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
function persistLoginState(){try{localStorage.setItem('tf_login_state',JSON.stringify({step:S.loginStep,method:S.loginMethod,phone:S.loginPhone,cc:S.loginCountryCode,email:S.loginEmail,name:S.loginName,sentTo:S.loginSentTo,otp:S.loginOTP,ts:Date.now()}));if(S.loginCountryCode)localStorage.setItem('tf_cc',S.loginCountryCode)}catch(e){}}
function restoreLoginState(){
  // Pre-fill from previous session's saved name/email/phone (kept across logout)
  try{
    const lastName=localStorage.getItem('tf_name')||'';
    const lastEmail=localStorage.getItem('tf_email')||'';
    const lastPhone=localStorage.getItem('tf_phone')||'';
    if(lastName)S.loginName=lastName;
    if(lastEmail){S.loginEmail=lastEmail;S.loginMethod='email'}
    else if(lastPhone){S.loginPhone=lastPhone;S.loginMethod='whatsapp'}
  }catch(e){}
  // Then layer the in-progress state (mid-OTP etc.) on top if it's still fresh
  // 60-min TTL — long enough that switching to Gmail to read the OTP and back doesn't lose state.
  try{const raw=localStorage.getItem('tf_login_state');if(!raw)return;const d=JSON.parse(raw);if(!d||!d.ts||Date.now()-d.ts>60*60*1000){localStorage.removeItem('tf_login_state');return}S.loginStep=d.step||'phone';S.loginMethod=d.method||S.loginMethod||'email';S.loginPhone=d.phone||S.loginPhone;S.loginCountryCode=d.cc||S.loginCountryCode||'+91';S.loginEmail=d.email||S.loginEmail;S.loginName=d.name||S.loginName;S.loginSentTo=d.sentTo||'';if(Array.isArray(d.otp)&&d.otp.length===6)S.loginOTP=d.otp.slice()}catch(e){}
}
function clearLoginState(){try{localStorage.removeItem('tf_login_state')}catch(e){}}
async function sendOTP(){S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){const em=(S.loginEmail||'').trim().toLowerCase();if(!/^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$/i.test(em)){S.loginError='Enter a valid email address';S.loginLoading=false;render();return}url='/api/send-otp-email';body={email:em}}else{const cc=(S.loginCountryCode||'+91').replace(/[^0-9+]/g,'');const local=(S.loginPhone||'').replace(/[^0-9]/g,'');if(!local){S.loginError='Enter your WhatsApp number';S.loginLoading=false;render();return}if(local.length<6){S.loginError='Phone number too short';S.loginLoading=false;render();return}const ph=cc+local;url='/api/send-otp';body={phone:ph}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({ok:false,error:'Network error \\u2014 check your connection'}));S.loginLoading=false;if(r.ok){S.loginStep='otp';S.loginOTP=['','','','','',''];S.loginError='';S.loginSentTo=r.phone||S.loginEmail||((S.loginCountryCode||'')+S.loginPhone);persistLoginState();try{const id=S.loginMethod==='email'?S.loginEmail:S.loginPhone;history.replaceState(null,'','#otp:'+encodeURIComponent(id||''))}catch(e){}render();setTimeout(()=>{const el=document.getElementById('otp0');if(el)el.focus()},100)}else{S.loginError=r.error||'Failed to send OTP';S.loginErrorDetail=r.detail||'';S.loginErrorCode=r.code||0;render()}}
async function verifyOTP(){const code=S.loginOTP.join('');if(code.length<6){S.loginError='Enter the 6-digit code';render();return}S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){url='/api/verify-otp-email';body={email:(S.loginEmail||'').trim().toLowerCase(),code,name:S.loginName}}else{let ph=S.loginPhone.replace(/[^0-9+]/g,'');if(!ph.startsWith('+'))ph='+'+ph;url='/api/verify-otp';body={phone:ph,code,name:S.loginName}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({error:'Network error'}));S.loginLoading=false;if(r.token){token=r.token;localStorage.setItem('tf_token',r.token);localStorage.setItem('tf_phone',r.phone);localStorage.setItem('tf_name',r.name||'');if(r.email)localStorage.setItem('tf_email',r.email);S.user=r;S.loginStep='phone';clearLoginState();try{history.replaceState(null,'','/')}catch(e){}load();chk();toast('\\u2705 Welcome!')}else{S.loginError=r.error||'Verification failed';render()}}
function otpInput(i,v){const d=v.slice(-1);S.loginOTP[i]=d;const el=document.getElementById('otp'+i);if(el)el.value=d;persistLoginState();if(d&&i<5){const nx=document.getElementById('otp'+(i+1));if(nx)nx.focus()}else if(d&&i===5){if(S.loginOTP.every(x=>x))verifyOTP()}}
function otpKey(i,e){if(e.key==='Backspace'&&!S.loginOTP[i]&&i>0){const prev=document.getElementById('otp'+(i-1));if(prev){prev.focus();S.loginOTP[i-1]='';prev.value='';persistLoginState()}}}
function logout(){
  // Preserve name/email/phone so the next login is one-tap
  const lastName=localStorage.getItem('tf_name')||'';
  const lastEmail=localStorage.getItem('tf_email')||'';
  const lastPhone=localStorage.getItem('tf_phone')||'';
  token=null;S.user=null;S.tasks=[];
  S.loginStep='phone';S.loginOTP=['','','','','',''];
  S.loginName=lastName;S.loginEmail=lastEmail;S.loginPhone=lastPhone;
  S.loginMethod=lastEmail?'email':(lastPhone?'whatsapp':'email');
  S.loginError='';S.loginErrorDetail='';S.loginErrorCode=0;S.loginSentTo='';
  localStorage.removeItem('tf_token');
  // Keep tf_name, tf_email, tf_phone in localStorage so we can pre-fill on relogin
  try{localStorage.removeItem('tf_login_state')}catch(e){}
  try{history.replaceState(null,'','/')}catch(e){}
  render();
}
async function load(){const a=document.getElementById('audioEl');if(a&&!a.paused)return;
  // Skip background re-render churn while the user is typing in a modal — kills focus on mobile.
  if(S.showWASetup||S.showAdd||S.showProfile){const ae=document.activeElement;if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'))return}
  const t=await api('/tasks');if(!t)return;
  // Local backup: every successful tasks fetch, snapshot to localStorage. If the server ever loses
  // the data (e.g. Railway redeploy without a persistent volume), the user can restore from this.
  try{
    if(t.length){localStorage.setItem('tf_tasks_backup',JSON.stringify({savedAt:Date.now(),user:S.user&&S.user.phone||'',tasks:t}))}
    else{
      // Server says zero tasks but we have a recent backup with tasks: offer to restore.
      const raw=localStorage.getItem('tf_tasks_backup');
      if(raw&&!S._restoreOffered){
        try{const d=JSON.parse(raw);if(d&&Array.isArray(d.tasks)&&d.tasks.length&&d.user===(S.user&&S.user.phone||'')){
          S._restoreOffered=true;
          S.restoreOffer={count:d.tasks.length,savedAt:d.savedAt};
        }}catch(e){}
      }
    }
  }catch(e){}
  const h=JSON.stringify(t);if(h===S._lastTasksHash)return;S._lastTasksHash=h;S.tasks=t;render();
}
async function restoreFromBackup(){
  const raw=localStorage.getItem('tf_tasks_backup');if(!raw)return toast('\\u26A0\\uFE0F No backup found','err');
  let d=null;try{d=JSON.parse(raw)}catch(e){return toast('\\u26A0\\uFE0F Backup corrupted','err')}
  if(!d||!Array.isArray(d.tasks)||!d.tasks.length)return toast('\\u26A0\\uFE0F Backup is empty','err');
  if(!confirm('Restore '+d.tasks.length+' task'+(d.tasks.length===1?'':'s')+' from your local backup? Tasks already on the server will be kept; backup tasks with new IDs will be added.'))return;
  const r=await api('/me/import',{method:'POST',body:JSON.stringify({tasks:d.tasks})});
  if(r&&r.ok){S.restoreOffer=null;toast('\\u2705 Restored '+r.inserted+' tasks ('+r.skipped+' already there)');load()}
  else toast('\\u26A0\\uFE0F Restore failed: '+((r&&r.error)||''),'err');
}
function dismissRestoreOffer(){S.restoreOffer=null;render()}
function downloadBackup(){window.open('/api/me/export','_blank')}
async function chk(){const h=await api('/health');if(h)S.waOk=h.twilio;render()}
async function addT(){if(!S.form.title.trim())return;const r=await api('/tasks',{method:'POST',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:'pending',due_date:S.form.dueDate,reminder_time:S.form.reminderTime,board:S.form.board})});if(r?.id){S.tasks.unshift(r);clM();toast('\\u2705 Task added!')}}
async function savE(){if(!S.form.title.trim()||!S.editing)return;const r=await api('/tasks/'+S.editing,{method:'PUT',body:JSON.stringify({title:S.form.title,notes:S.form.notes,priority:S.form.priority,status:S.form.status,due_date:S.form.dueDate,reminder_time:S.form.reminderTime,board:S.form.board})});if(r){const i=S.tasks.findIndex(t=>t.id===S.editing);if(i>-1)S.tasks[i]=r;clM();toast('\\u2705 Updated!')}}
async function del(id){await api('/tasks/'+id,{method:'DELETE'});S.tasks=S.tasks.filter(t=>t.id!==id);render()}
async function tog(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:t.status==='done'?'pending':'done'})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function cyc(id){const o=['pending','in-progress','done'],t=S.tasks.find(x=>x.id===id);if(!t)return;const r=await api('/tasks/'+id,{method:'PUT',body:JSON.stringify({status:o[(o.indexOf(t.status)+1)%3]})});if(r){const i=S.tasks.findIndex(x=>x.id===id);if(i>-1)S.tasks[i]=r;render()}}
async function sWA(id){S.sending[id]=1;render();const r=await api('/send-task/'+id,{method:'POST'});delete S.sending[id];toast(r?.ok?'\\u{1F4F1} Sent!':'\\u26A0\\uFE0F Failed',r?.ok?'ok':'err');render()}
async function sAll(){
  S.sending._a=1;render();
  const board=S.board==='combined'?null:S.board;
  const r=await api('/send-all',{method:'POST',body:JSON.stringify({board:board||''})});
  delete S.sending._a;
  if(r&&r.ok){const lbl=r.label||'Tasks';toast(r.empty?'\\u2728 No '+lbl.toLowerCase()+' to send':'\\u{1F4F1} '+lbl+' sent ('+r.sent+')!')}
  else toast('\\u26A0\\uFE0F '+((r&&r.error)||'Send failed'),'err');
  render();
}
function opA(){S.form={title:'',notes:'',priority:'medium',dueDate:'',reminderTime:'',status:'pending',board:S.board==='combined'?'home':S.board};S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
function opE(id){const t=S.tasks.find(x=>x.id===id);if(!t)return;S.form={title:t.title,notes:t.notes||'',priority:t.priority,dueDate:t.due_date||'',reminderTime:t.reminder_time||'',status:t.status,board:t.board||'home'};S.editing=id;S.showAdd=true;render()}
function setBoard(b){S.board=b;localStorage.setItem('tf_board',b);render()}
function clM(){S.showAdd=false;S.editing=null;if(rec)try{rec.stop()}catch(e){}S.listening=false;render()}
function stV(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){toast('\\u26A0\\uFE0F Voice not supported','err');return}rec=new SR();rec.continuous=false;rec.interimResults=true;rec.lang='en-US';rec.onresult=e=>{let t='';for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;if(e.results[0].isFinal){S.form.title=t;const l=t.toLowerCase();if(/urgent|important|asap/.test(l)){S.form.priority='high';S.form.title=S.form.title.replace(/urgent|important|asap/gi,'').trim()}if(/\\btoday\\b/.test(l))S.form.dueDate=new Date().toISOString().split('T')[0];else if(/\\btomorrow\\b/.test(l)){const d=new Date();d.setDate(d.getDate()+1);S.form.dueDate=d.toISOString().split('T')[0]}}else S.form.title=t;render()};rec.onend=()=>{S.listening=false;render()};rec.onerror=e=>{S.listening=false;toast('\\u26A0\\uFE0F '+e.error,'err');render()};rec.start();S.listening=true;render()}

// Knowledge magazine — four major topics, each with 4-5 sub-sections of curated Wikipedia article slugs
// Total: 130+ articles across History (40 + today), Geography (32), Space (28), Karma (24)
const KNOWLEDGE_TOPICS=[
  {k:'history',l:'History',e:'\\u{1F3DB}\\uFE0F',sections:[
    {k:'today',l:'On This Day',e:'\\u{1F4C5}'},
    {k:'ancient',l:'Ancient World',e:'\\u{1F3DB}\\uFE0F',titles:['Ancient_Egypt','Ancient_Rome','Ancient_Greece','Indus_Valley_Civilisation','Mesopotamia','Maya_civilization','Ancient_China','Persian_Empire']},
    {k:'science',l:'Science',e:'\\u{1F52C}',titles:['Isaac_Newton','Albert_Einstein','Marie_Curie','Charles_Darwin','Nikola_Tesla','Galileo_Galilei','Ada_Lovelace','Alan_Turing']},
    {k:'empires',l:'Empires & Wars',e:'\\u{2694}\\uFE0F',titles:['Roman_Empire','Mongol_Empire','British_Empire','Ottoman_Empire','Mughal_Empire','Byzantine_Empire','World_War_II','World_War_I']},
    {k:'art',l:'Art & Culture',e:'\\u{1F3A8}',titles:['Leonardo_da_Vinci','Renaissance','Michelangelo','William_Shakespeare','Wolfgang_Amadeus_Mozart','Vincent_van_Gogh','Pablo_Picasso','Frida_Kahlo']},
    {k:'innov',l:'Innovations',e:'\\u{1F4A1}',titles:['Printing_press','Industrial_Revolution','History_of_the_Internet','Telephone','Electricity','Steam_engine','Wright_brothers','Penicillin']}
  ]},
  {k:'geography',l:'Geography',e:'\\u{1F30D}',sections:[
    {k:'earth',l:'Earth',e:'\\u{1F30D}',titles:['Earth','Plate_tectonics','Continental_drift','Atmosphere_of_Earth','Pangaea','Volcano','Geosphere','Lithosphere']},
    {k:'oceans',l:'Oceans',e:'\\u{1F30A}',titles:['Pacific_Ocean','Atlantic_Ocean','Indian_Ocean','Arctic_Ocean','Mariana_Trench','Coral_reef','Great_Barrier_Reef','Ocean_current']},
    {k:'land',l:'Mountains & Land',e:'\\u{1F3D4}\\uFE0F',titles:['Mount_Everest','Sahara','Amazon_rainforest','Grand_Canyon','Antarctica','Himalayas','Andes','Yellowstone_National_Park']},
    {k:'climate',l:'Climate & Weather',e:'\\u{1F324}\\uFE0F',titles:['Climate_change','Monsoon','Tropical_cyclone','Desert','Permafrost','Aurora','Tornado','Glacier']}
  ]},
  {k:'space',l:'Space',e:'\\u{1F680}',sections:[
    {k:'solar',l:'Solar System',e:'\\u{2600}\\uFE0F',titles:['Sun','Mercury_(planet)','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto']},
    {k:'galaxies',l:'Galaxies',e:'\\u{1F30C}',titles:['Universe','Milky_Way','Andromeda_Galaxy','Galaxy','Big_Bang','Magellanic_Clouds','Cosmic_microwave_background','Dark_matter']},
    {k:'stars',l:'Stars & Black Holes',e:'\\u{2728}',titles:['Star','Black_hole','Supernova','Neutron_star','White_dwarf','Pulsar','Quasar']},
    {k:'missions',l:'Missions',e:'\\u{1F6F8}',titles:['Apollo_program','Voyager_program','International_Space_Station','Hubble_Space_Telescope','James_Webb_Space_Telescope','SpaceX','New_Horizons']}
  ]},
  {k:'karma',l:'Karma & Dharma',e:'\\u{1F549}\\uFE0F',sections:[
    {k:'epics',l:'Epics & Texts',e:'\\u{1F4DC}',titles:['Bhagavad_Gita','Mahabharata','Ramayana','Upanishads','Vedas','Tao_Te_Ching','Dhammapada']},
    {k:'concepts',l:'Core Concepts',e:'\\u{1FAB7}',titles:['Karma','Dharma','Moksha','Reincarnation','Yoga','Vedanta','Eightfold_Path','Four_Noble_Truths']},
    {k:'figures',l:'Sages & Teachers',e:'\\u{1F9D1}\\u200D\\u{1F33E}',titles:['Gautama_Buddha','Krishna','Confucius','Lao_Tzu','Adi_Shankara','Patanjali','Bodhidharma','Ramana_Maharshi']},
    {k:'paths',l:'Paths & Schools',e:'\\u{1F308}',titles:['Hinduism','Buddhism','Jainism','Sikhism','Zen','Theravada','Mahayana','Vipassana_movement']}
  ]}
];
function getKnowledgeTopic(k){return KNOWLEDGE_TOPICS.find(t=>t.k===k)||KNOWLEDGE_TOPICS[0]}
function getKnowledgeSec(topicK,secK){const t=getKnowledgeTopic(topicK);return t.sections.find(s=>s.k===secK)||t.sections[0]}
function switchTab(t){if(t==='steps'||t==='dash'||t==='history'||t==='geography'||t==='knowledge'||t==='ipl'||t==='games')t=t==='ipl'?'news':t==='games'?'mindgym':'tasks';S.tab=t;if(t==='news'){if(!S.newsCat)S.newsCat='world';if(!S.news[S.newsCat])loadNews(S.newsCat)}if(t==='books'&&!S.books.length)loadBooks('all');if(t==='meditation'&&!S.meditations)loadMeditations();if(t==='cal'){if(!S.google.loaded)loadGoogleStatus();else if(S.google.accounts.length&&!S.gcalEvents.length&&!S.gcalLoading)loadGcalEvents()}if(t==='mindgym'&&!S.mg.loaded)loadMindGym();if(t==='voice'){if(!S.coach.status)coachInit()}render();try{window.scrollTo({top:0,behavior:'smooth'})}catch(e){window.scrollTo(0,0)}}
async function loadKnowledge(topicK,secK){S.knowledge.topic=topicK;S.knowledge.sec=secK;S.knowledge.loading=true;render();const cacheKey=topicK+':'+secK;try{if(topicK==='history'&&secK==='today'){const r=await fetch('/api/history/today');const j=await r.json();S.knowledge.events=j.events||[]}else{const tObj=KNOWLEDGE_TOPICS.find(t=>t.k===topicK);const sObj=tObj&&tObj.sections.find(s=>s.k===secK);if(!sObj||!sObj.titles){S.knowledge.loaded[cacheKey]=true;S.knowledge.loading=false;render();return}const r=await fetch('/api/wiki/summaries?titles='+encodeURIComponent(sObj.titles.join(',')));const j=await r.json();S.knowledge.articles[cacheKey]=j.summaries||[]}}catch(e){}S.knowledge.loaded[cacheKey]=true;S.knowledge.loading=false;render()}
function switchKnowledgeTopic(k){S.knowledge.topic=k;const tObj=KNOWLEDGE_TOPICS.find(t=>t.k===k);const sk=(tObj&&tObj.sections[0]&&tObj.sections[0].k)||'today';loadKnowledge(k,sk)}
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
// WhatsApp UI disabled for closed-test phase (Twilio Sandbox can't deliver to arbitrary recipients).
function openWAOnboard(){return}
function closeWAOnboard(){S.showWAOnboard=false;render()}
function openWAJoin(){return}
function saveBroDoitContact(){const a=document.createElement('a');a.href='/brodoit.vcf';a.download='BroDoit.vcf';document.body.appendChild(a);a.click();setTimeout(()=>document.body.removeChild(a),1000);toast('\\u{1F4D2} Downloading BroDoit contact \\u2014 open it to save')}
function confirmWAJoined(){S.waConnected=true;localStorage.setItem('wa_connected','1');S.showWAOnboard=false;toast('\\u2705 WhatsApp connected');render()}
function disconnectWA(){S.waConnected=false;localStorage.removeItem('wa_connected');toast('\\u23F8 WhatsApp disconnected');render()}
// ─── Connect-WhatsApp flow (link a real WA number to this account) ───
// State persists to localStorage so iOS Safari suspending the tab while you fetch the OTP from
// WhatsApp doesn't drop you back to step 1 when you return.
function _waPersist(){try{if(S.waConn)localStorage.setItem('tf_wa_conn',JSON.stringify({...S.waConn,ts:Date.now()}));else localStorage.removeItem('tf_wa_conn')}catch(e){}}
function _waRestore(){try{const raw=localStorage.getItem('tf_wa_conn');if(!raw)return;const d=JSON.parse(raw);if(!d||!d.ts||Date.now()-d.ts>30*60*1000){localStorage.removeItem('tf_wa_conn');return}// strip transient flags
delete d.sending;delete d.verifying;S.waConn=d;S.showWASetup=true}catch(e){}}
async function waConnectSend(){
  const phEl=document.getElementById('waSetupPh');
  const ccEl=document.getElementById('waSetupCC');
  const localNum=((phEl&&phEl.value)||S.waConn?.phoneInput||'').replace(/[^0-9]/g,'');
  const cc=((ccEl&&ccEl.value)||S.waConn?.cc||'+91');
  const full=cc+localNum;
  if(full.length<8){S.waConn={...(S.waConn||{step:'phone'}),phoneInput:localNum,cc,err:'Enter your WhatsApp number'};_waPersist();render();return}
  S.waConn={...(S.waConn||{}),phone:full,cc,phoneInput:localNum,step:'phone',sending:true,err:''};_waPersist();render();
  const r=await api('/wa/connect',{method:'POST',body:JSON.stringify({phone:full})});
  if(r&&r.ok){
    localStorage.setItem('tf_wa_joined','1');
    S.waConn={phone:full,cc,phoneInput:localNum,step:'verify',codeInput:''};
    _waPersist();
    toast('\\u{1F4F2} Code sent to your WhatsApp');
    render();
    setTimeout(()=>{const e=document.getElementById('waSetupCode');if(e)e.focus()},120);
    return;
  }
  S.waConn={phone:full,cc,phoneInput:localNum,step:'phone',err:(r&&r.error)||'Failed to send',needsJoin:!!(r&&r.needsJoin)};
  if(r&&r.needsJoin)localStorage.removeItem('tf_wa_joined');
  _waPersist();render();
}
async function waConnectVerify(){
  const codeEl=document.getElementById('waSetupCode');
  const code=((codeEl&&codeEl.value)||S.waConn?.codeInput||'').trim();
  if(!code||code.length<6){S.waConn={...(S.waConn||{}),codeInput:code,err:'Enter the 6-digit code'};_waPersist();render();return}
  S.waConn={...(S.waConn||{}),codeInput:code,verifying:true,err:''};_waPersist();render();
  const r=await api('/wa/verify',{method:'POST',body:JSON.stringify({phone:S.waConn.phone,code})});
  if(r&&r.ok){
    S.profile={...(S.profile||{}),wa_phone:r.wa_phone};
    S.waConn=null;S.showWASetup=false;
    localStorage.removeItem('tf_wa_conn');
    localStorage.removeItem('tf_wa_banner_x');
    toast('\\u2705 WhatsApp connected!');
  }else{
    S.waConn={...(S.waConn||{}),codeInput:code,verifying:false,err:(r&&r.error)||'Verification failed'};
    _waPersist();
  }
  render();
}
async function waUnlink(){
  if(!confirm('Disconnect WhatsApp from this account?'))return;
  const r=await api('/wa/disconnect',{method:'POST'});
  if(r&&r.ok){S.profile={...(S.profile||{}),wa_phone:null};localStorage.removeItem('tf_wa_banner_x');toast('WhatsApp disconnected');render()}
}
function waConnectStart(){
  S.showProfile=false;S.showWASetup=true;
  // If we were mid-verify when the modal closed, resume there. Otherwise start fresh.
  if(!S.waConn||(S.waConn.step!=='verify'&&S.waConn.step!=='phone'))S.waConn={step:'phone',cc:'+91'};
  _waPersist();render();
  setTimeout(()=>{const e=document.getElementById(S.waConn.step==='verify'?'waSetupCode':'waSetupPh');if(e)e.focus()},120);
}
function waConnectCancel(){
  // Only allow cancel via explicit X / Cancel button. Keep state in localStorage so re-opening resumes.
  S.showWASetup=false;render();
}
function waConnectAbort(){S.waConn=null;S.showWASetup=false;localStorage.removeItem('tf_wa_conn');render()}
// Live-persist what the user types so iOS killing the tab while they switch to WhatsApp doesn't lose progress.
function waConnPhInput(v){if(!S.waConn)return;S.waConn={...S.waConn,phoneInput:v};_waPersist()}
function waConnCcInput(v){if(!S.waConn)return;S.waConn={...S.waConn,cc:v};_waPersist()}
function waConnCodeInput(v){if(!S.waConn)return;S.waConn={...S.waConn,codeInput:v};_waPersist();if((v||'').replace(/\D/g,'').length>=6)waConnectVerify()}
function waOpenJoin(){const code=window.__TWILIO_SANDBOX_CODE||'along-wool';window.open('https://wa.me/14155238886?text='+encodeURIComponent('join '+code),'_blank')}
// Three categories x two durations = six English-language meditation audios; durations VERIFIED to match the labels
const MED_SLOTS=[
{cat:'vipassana',mins:10,title:'Anāpāna + Mettā',desc:'Breath-awareness intro \\u2022 12 min',color:'#06B6D4',directId:'AnapanaEnglishMetta',directFile:'Anapana English+Metta.mp3'},
{cat:'vipassana',mins:20,title:'Anāpāna · 20-min Sit',desc:'Extended breath-awareness \\u2022 21 min',color:'#3B82F6',directId:'70_Minutes_Anapana_Part_1',directFile:'70-m-anapana-M0052.mp3'},
{cat:'music',mins:10,title:'Meditation Morning',desc:'Calming instrumental \\u2022 10 min',color:'#8B5CF6',directId:'SleepMeditationCalming',directFile:'10 min Meditation morning.mp3'},
{cat:'music',mins:30,title:'Ambient Soundbath',desc:'Slow, layered tones \\u2022 30 min',color:'#EC4899',directId:'AmbientSoundbathPodcast',directFile:'AmbientSoundbathPodcast-001.mp3'},
{cat:'guided',mins:15,title:'Body Scan',desc:'Body scan with Judith \\u2022 15 min',color:'#10B981',directId:'JR12-2015-10-03-RTR-CIW-body-scan-meditation-judith',directFile:'JR12-2015-10-03-RTR-CIW-body-scan-meditation-judith.mp3'},
{cat:'guided',mins:25,title:'Loving-Kindness',desc:'Guided practice with Ajahn Brahm \\u2022 25 min',color:'#F59E0B',directId:'BSWA-Meditation',directFile:'2018-11-02- Guided Meditation with AB.mp3'}
];
const MED_CATEGORIES=[
  {k:'vipassana',l:'Vipassana',e:'\\u{1F9D8}\\u200D\\u2642\\uFE0F'},
  {k:'music',l:'Music',e:'\\u{1F3B5}'},
  {k:'guided',l:'Guided',e:'\\u{1F50A}'}
];
async function loadMeditations(){if(S.medLoading)return;S.medLoading=true;S.meditations=S.meditations||{};MED_SLOTS.forEach(s=>{if(s.directId&&!S.meditations[s.directId])S.meditations[s.directId]={identifier:s.directId,title:s.title}});S.medLoading=false;render()}
function setMedCat(k){S.medCat=k;render()}
function playMedDirect(id,title,mins,file){playMeditation(id,title,mins,file)}
async function loadGoogleStatus(){const r=await api('/google/status');if(r){S.google={configured:!!r.configured,accounts:r.accounts||[],loaded:true};render();if(S.google.accounts.length&&S.tab==='cal')loadGcalEvents()}}
async function connectGoogle(){const r=await api('/google/auth-url');if(!r||!r.url){toast('\\u26A0\\uFE0F Google integration is not configured yet. Ask admin to set GOOGLE_CLIENT_ID/SECRET.','err');return}const w=window.open(r.url,'_blank','width=520,height=640');if(!w){location.href=r.url;return}window.addEventListener('message',function onMsg(e){if(e.data&&e.data.type==='google-connected'){window.removeEventListener('message',onMsg);toast('\\u2705 Connected '+e.data.email);loadGoogleStatus()}},{once:false});const poll=setInterval(()=>{if(w.closed){clearInterval(poll);loadGoogleStatus()}},900)}
async function disconnectGoogle(email){if(!confirm('Disconnect '+(email||'all Google accounts')+' from Brodoit Calendar?'))return;const r=await api('/google/disconnect',{method:'POST',body:JSON.stringify({email:email||''})});if(r&&r.ok){toast('\\u23F8 Disconnected');S.gcalEvents=[];loadGoogleStatus()}}
async function setDefaultGoogle(email){const r=await api('/google/set-default',{method:'POST',body:JSON.stringify({email})});if(r&&r.ok){toast('\\u2705 Default account set to '+email);loadGoogleStatus()}}
async function loadGcalEvents(){if(!S.google.accounts.length)return;S.gcalLoading=true;render();const def=S.google.accounts.find(a=>a.is_default)||S.google.accounts[0];const r=await api('/calendar/events?email='+encodeURIComponent(def.email));S.gcalLoading=false;if(r&&r.events){S.gcalEvents=r.events;render()}else{S.gcalEvents=[];render();if(r&&r.error)toast('\\u26A0\\uFE0F '+r.error,'err')}}
function openGcalAdd(){const def=S.google.accounts.find(a=>a.is_default)||S.google.accounts[0];S.gcalForm={title:'',date:S.calSelectedDate||new Date().toISOString().slice(0,10),time:'',duration:30,notes:'',email:def?def.email:''};S.showGcalAdd=true;render()}
function closeGcalAdd(){S.showGcalAdd=false;render()}
async function saveGcalEvent(){const f=S.gcalForm;if(!f.title.trim()){toast('\\u26A0\\uFE0F Title required','err');return}const r=await api('/calendar/events',{method:'POST',body:JSON.stringify({title:f.title.trim(),date:f.date,time:f.time||null,duration:f.duration||30,notes:f.notes,email:f.email})});if(r&&r.ok){toast('\\u2705 Event added to '+(f.email||'Google Calendar'));S.showGcalAdd=false;loadGcalEvents()}else if(r&&r.error){toast('\\u26A0\\uFE0F '+r.error,'err')}}
function playMedSlot(mins){const doc=(S.meditations||{})[mins];if(!doc){toast('\\u23F3 Loading audio...','err');return}const t=Array.isArray(doc.title)?doc.title[0]:doc.title;playMeditation(doc.identifier,t,mins)}
async function playMeditation(id,title,mins,preferFile){S.meditating={active:true,title:title||(mins+'-min meditation'),mins:mins||10,startedAt:Date.now()};S.playing={id,title:title||(mins+'-minute meditation'),author:'Guided meditation \\u2022 Internet Archive',loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=null;if(preferFile){mp3=j.files.find(f=>f.name===preferFile||(f.name||'').endsWith('/'+preferFile))}if(!mp3){const mp3s=j.files.filter(f=>/\\.mp3$/i.test(f.name)&&!/sample|preview|announce|intro\\.mp3|sting/i.test(f.name)).sort((a,b)=>(parseFloat(b.length||'0')||0)-(parseFloat(a.length||'0')||0));mp3=mp3s[0]}if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const directUrl='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');const dlUrl='https://archive.org/download/'+encodeURIComponent(id)+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title:title||mins+'-min meditation',author:'\\u{1F9D8} Guided meditation \\u2022 Archive.org',url:directUrl,altUrl:dlUrl,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(!a)return;a.setAttribute('playsinline','');a.preload='auto';a.addEventListener('error',function onErr(){a.removeEventListener('error',onErr);if(a.src!==dlUrl){a.src=dlUrl;a.load()}},{once:true});a.load();const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap play on the bar','err'))},250)}else{toast('\\u26A0\\uFE0F No mp3 \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing=null;render()}}
async function openProfile(){S.showProfile=true;render();const me=await api('/me');if(me&&!me.error)S.profile=me;render()}
function openHelp(){S.showHelp=true;render();setTimeout(()=>{const m=document.querySelector('.help-mdl');if(m)m.scrollTop=0},50)}
function closeHelp(){S.showHelp=false;render()}
function closeProfile(){S.showProfile=false;render()}
async function saveName(){const n=(document.getElementById('pfName')||{}).value;if(!n||!n.trim())return;const r=await api('/me',{method:'PUT',body:JSON.stringify({name:n.trim()})});if(r&&r.name){S.user.name=r.name;localStorage.setItem('tf_name',r.name);S.profile=Object.assign(S.profile||{},{name:r.name});toast('\\u2705 Name updated');render()}}
async function refreshSession(){
  if(!token)return;
  const r=await api('/me');
  if(r&&!r.error){S.user={phone:r.phone,name:r.name,token};S.profile=r;localStorage.setItem('tf_name',r.name||'');render();return}
  // Only force logout on a CLEAR auth failure (token rejected). Transient network errors,
  // 502s during redeploys, and undefined responses keep the cached login intact so a hard
  // refresh during a redeploy doesn't kick the user back to login.
  if(r&&r.error&&/invalid|expired|unauthor|401/i.test(String(r.error))){logout()}
}
function calPrev(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()-1);S.calMonth=d;render()}
function calNext(){const d=new Date(S.calMonth);d.setMonth(d.getMonth()+1);S.calMonth=d;render()}
function calSelect(d){S.calSelectedDate=d;render()}
function calAddForDate(){S.form={title:'',notes:'',priority:'medium',dueDate:S.calSelectedDate||'',reminderTime:'',status:'pending',board:S.board==='combined'?'home':S.board};S.editing=null;S.showAdd=true;render();setTimeout(()=>{const e=document.getElementById('ft');if(e)e.focus()},100)}
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
function flipCoin(){if(S.coin.flipping)return;S.coin.flipping=true;S.coin.face=null;render();setTimeout(()=>{const f=Math.random()<0.5?'heads':'tails';S.coin.face=f;S.coin.flipping=false;if(f==='heads'){S.coin.heads++;localStorage.setItem('tf_coin_h',S.coin.heads)}else{S.coin.tails++;localStorage.setItem('tf_coin_t',S.coin.tails)}render()},900)}

// ─── MIND GYM ─────────────────────────────────────────────────────────────
async function loadMindGym(){const r=await api('/games/progress');if(r&&r.progress){S.mg.progress=r.progress;S.mg.streak=r.streak||S.mg.streak;S.mg.loaded=true;render()}}
// ─── Web Audio sound effects (no library, no asset, ~free) ───
let _mgAudio=null;
function _mgSound(kind){
  try{
    if(!_mgAudio)_mgAudio=new(window.AudioContext||window.webkitAudioContext)();
    const ctx=_mgAudio,t=ctx.currentTime;
    const beep=(freq,start,dur,gain)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.value=freq;g.gain.setValueAtTime(gain||0.16,t+start);g.gain.exponentialRampToValueAtTime(0.001,t+start+dur);o.connect(g).connect(ctx.destination);o.start(t+start);o.stop(t+start+dur)};
    if(kind==='correct'){beep(523,0,0.16);beep(784,0.09,0.18)}
    else if(kind==='wrong'){const o=ctx.createOscillator(),g=ctx.createGain();o.type='sawtooth';o.frequency.value=200;o.frequency.linearRampToValueAtTime(110,t+0.22);g.gain.setValueAtTime(0.13,t);g.gain.exponentialRampToValueAtTime(0.001,t+0.22);o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+0.22)}
    else if(kind==='levelup'){[523,659,784,1047,1319].forEach((f,i)=>beep(f,i*0.08,0.22))}
    else if(kind==='tap'){beep(680,0,0.05,0.08)}
    else if(kind==='flash'){beep(440+Math.random()*440,0,0.12,0.1)}
    else if(kind==='go'){beep(900,0,0.08);beep(900,0.1,0.08)}
  }catch(e){}
}
// Daily workout ledger — which games the user completed *today*
function _mgTodayKey(g){return 'tf_mg_done_'+g+'_'+todayStr()}
function todayStr(){return new Date().toISOString().slice(0,10)}
function _mgMarkDone(g){
  try{localStorage.setItem(_mgTodayKey(g),'1')}catch(e){}
  // Headspace-style celebrations on game completion + ritual completion
  setTimeout(function(){
    const all=['math','memory','reaction','word'];
    const done=all.filter(k=>{try{return localStorage.getItem(_mgTodayKey(k))==='1'}catch(e){return false}});
    if(done.length===all.length){
      // Full daily ritual complete — biggest celebration
      _ttsSpeak('You completed the full daily ritual. The streak grows.',{rate:.92,pitch:1.0,volume:1.0});
      S._mgConfetti=Date.now();render();
    } else {
      const phrases={math:'Beautiful arithmetic. The mind sharpens with reps.',memory:'Memory is a muscle. You just trained it.',reaction:'Lightning reflexes. Lovely work.',word:'Words built up. That is craft, not luck.'};
      _ttsSpeak(phrases[g]||'Game complete. Daily streak alive.',{rate:.95,pitch:1.0,volume:1.0});
    }
  },350);
}
function _mgIsDoneToday(g){try{return localStorage.getItem(_mgTodayKey(g))==='1'}catch(e){return false}}
// ─── AI COACH (Phase 2) ──────────────────────────────────────────────
async function coachInit(){
  const s=await fetch('/api/coach/status').then(r=>r.json()).catch(()=>null);
  if(s)S.coach.status=s;
  // Greet on first open
  if(!S.coach.history.length){
    S.coach.history=[{role:'assistant',content:"Hi, I'm your Business English coach. We can practise vocabulary, refine how you phrase ideas, or rehearse a real scenario — your call. Type or tap the mic to speak. Where shall we start?"}];
  }
  render();
}
async function coachSend(text){
  const t=String(text||S.coach.input||'').trim();
  if(!t||S.coach.sending)return;
  S.coach.history=S.coach.history.concat([{role:'user',content:t}]);
  S.coach.input='';S.coach.sending=true;render();
  try{
    const sys=S.coach.scenario?_coachScenarioSystem(S.coach.scenario):undefined;
    const r=await api('/coach/chat',{method:'POST',body:JSON.stringify({messages:S.coach.history.map(m=>({role:m.role,content:m.content})),system:sys})});
    S.coach.sending=false;
    if(r&&r.reply){
      S.coach.history=S.coach.history.concat([{role:'assistant',content:r.reply}]);
      render();
      coachSpeak(r.reply);
    }else{
      toast('\\u26A0\\uFE0F '+((r&&r.error)||'Coach unavailable'),'err');
      render();
    }
  }catch(e){S.coach.sending=false;toast('\\u26A0\\uFE0F '+e.message,'err');render()}
}
function _coachScenarioSystem(sc){
  const role=sc.role||'colleague';
  return 'You are roleplaying as '+role+' in a Business English practice session. Stay strictly in character. The user is practising the scenario: "'+sc.title+'".\\n\\nRespond as the character would \\u2014 realistic, contextual, sometimes slightly challenging. Keep responses under 80 words. After 6-8 exchanges, naturally wrap up the scenario.\\n\\nIf the user says "STOP" or "feedback", break character and give a brief Business English coaching note about their performance: vocabulary, tone, pace, structure. Then offer to restart or try a new scenario.';
}
async function coachSpeak(text){
  if(!S.coach.status||!S.coach.status.tts){
    // Fallback to browser TTS
    voiceSpeak(text);return;
  }
  try{
    S.coach.playing=true;render();
    const r=await fetch('/api/coach/speak',{method:'POST',headers:{'Content-Type':'application/json','x-token':token},body:JSON.stringify({text})});
    if(!r.ok){S.coach.playing=false;render();voiceSpeak(text);return}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=new Audio(url);S._coachAudio=a;
    a.onended=()=>{S.coach.playing=false;URL.revokeObjectURL(url);render()};
    a.onerror=()=>{S.coach.playing=false;render()};
    a.play().catch(()=>{S.coach.playing=false;render()});
  }catch(e){S.coach.playing=false;render()}
}
function coachStopSpeak(){try{S._coachAudio&&S._coachAudio.pause();S._coachAudio=null}catch(e){}try{window.speechSynthesis&&window.speechSynthesis.cancel()}catch(e){}S.coach.playing=false;render()}
let _coachRec=null,_coachChunks=[];
async function coachStartRec(){
  if(_coachRec){coachStopRec();return}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('\\u26A0\\uFE0F Mic not available','err');return}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    // Live waveform — feed mic into an AnalyserNode so the UI can show real-time audio levels
    try{
      if(!_mgAudio)_mgAudio=new(window.AudioContext||window.webkitAudioContext)();
      const src=_mgAudio.createMediaStreamSource(stream);
      const an=_mgAudio.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=0.78;
      src.connect(an);
      S._coachAnalyser=an;S._coachStream=stream;
      _coachWaveformLoop();
    }catch(e){}
    const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':'';
    _coachRec=new MediaRecorder(stream,mime?{mimeType:mime}:{});
    _coachChunks=[];
    _coachRec.ondataavailable=e=>{if(e.data&&e.data.size)_coachChunks.push(e.data)};
    _coachRec.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(_coachChunks,{type:_coachRec.mimeType||'audio/webm'});
      _coachRec=null;_coachChunks=[];
      S.coach.recording=false;render();
      if(blob.size<300){toast('\\u26A0\\uFE0F Recording too short','err');return}
      // Send to Whisper
      S.coach.sending=true;render();
      try{
        const r=await fetch('/api/coach/transcribe',{method:'POST',headers:{'Content-Type':blob.type,'x-token':token},body:blob});
        const j=await r.json();
        S.coach.sending=false;
        if(j&&j.text){coachSend(j.text)}else{toast('\\u26A0\\uFE0F '+((j&&j.error)||'Transcribe failed'),'err');render()}
      }catch(e){S.coach.sending=false;toast('\\u26A0\\uFE0F '+e.message,'err');render()}
    };
    _coachRec.start();S.coach.recording=true;render();
    // Auto-stop after 30s safety cap
    setTimeout(()=>{if(_coachRec)coachStopRec()},30000);
  }catch(e){toast('\\u26A0\\uFE0F Mic blocked: '+(e.message||e),'err')}
}
function coachStopRec(){try{_coachRec&&_coachRec.state==='recording'&&_coachRec.stop()}catch(e){}try{S._coachStream&&S._coachStream.getTracks().forEach(t=>t.stop())}catch(e){}S._coachAnalyser=null;S._coachStream=null}
function _coachWaveformLoop(){
  if(!S._coachAnalyser){if(S._coachWaveRAF){cancelAnimationFrame(S._coachWaveRAF);S._coachWaveRAF=null}return}
  const canvas=document.getElementById('ccWave');
  if(!canvas){S._coachWaveRAF=requestAnimationFrame(_coachWaveformLoop);return}
  const ctx=canvas.getContext('2d');
  const dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  if(canvas.width!==canvas.clientWidth*dpr){canvas.width=canvas.clientWidth*dpr;canvas.height=canvas.clientHeight*dpr;ctx.scale(dpr,dpr)}
  const w=canvas.clientWidth,h=canvas.clientHeight;
  ctx.clearRect(0,0,w,h);
  const an=S._coachAnalyser;const buf=new Uint8Array(an.frequencyBinCount);an.getByteFrequencyData(buf);
  const bars=24,bw=w/bars;
  for(let i=0;i<bars;i++){
    const v=buf[Math.floor(i*buf.length/bars)]/255;
    const bh=Math.max(2,v*h*0.85);
    ctx.fillStyle='rgba(124,58,237,'+(0.3+v*0.7)+')';
    ctx.fillRect(i*bw+2,h/2-bh/2,bw-4,bh);
  }
  S._coachWaveRAF=requestAnimationFrame(_coachWaveformLoop);
}
function coachReset(){coachStopSpeak();coachStopRec();S.coach.history=[];S.coach.scenario=null;coachInit()}
function coachStartScenario(sc){coachStopSpeak();S.coach.scenario=sc;S.coach.history=[{role:'assistant',content:"Let's roleplay: **"+sc.title+"**. I'll play "+sc.role+". "+sc.opener}];render();coachSpeak("Let's roleplay. "+sc.opener);setTimeout(()=>{const el=document.getElementById('coachInput');if(el)el.focus()},120)}
function coachStartScenarioByIdx(i){const sc=COACH_SCENARIOS[i];if(sc)coachStartScenario(sc)}
function coachReplayLast(){if(!S.coach||!S.coach.history)return;const last=S.coach.history[S.coach.history.length-1];if(last&&last.role==='assistant')coachSpeak(last.content)}
const COACH_SCENARIOS=[
  {id:'pitch',title:'Pitch your idea to a skeptical investor',role:'a sharp, skeptical venture-capital investor',opener:"So — you've got 60 seconds. What are you building, and why should I care?"},
  {id:'salary',title:'Negotiate a salary increase with your manager',role:'your direct manager who has limited budget flexibility',opener:"Thanks for setting up this meeting. I understand you wanted to talk about compensation?"},
  {id:'reject',title:'Reject a vendor proposal politely',role:'a vendor who has just sent you a detailed proposal',opener:"Hi — wanted to follow up on the proposal we sent. Did you have a chance to review it?"},
  {id:'feedback',title:'Give difficult feedback to a direct report',role:'your direct report who recently missed an important deadline',opener:"Hey, you wanted to chat? Everything okay?"},
  {id:'qbr',title:'Present Q3 results to leadership',role:'a senior executive sitting in your QBR',opener:"Great, we're ready when you are. Walk us through Q3."},
  {id:'network',title:'Networking at an industry event',role:'a potential client you just met at a conference',opener:"Hey, nice to meet you. So what's your story — what do you do?"}
];
// ─── VOICE TRAINER ───
async function loadVoice(){
  const [c,p]=await Promise.all([fetch('/api/voice/curriculum').then(r=>r.json()).catch(()=>null),api('/voice/progress')]);
  if(c)S.voice.curriculum=c;
  if(p)S.voice.progress=p;
  S.voice.loaded=true;render();
}
async function voiceOpenLesson(day){
  const r=await fetch('/api/voice/lesson/'+day).then(r=>r.json()).catch(()=>null);
  if(!r||r.error)return toast('\\u26A0\\uFE0F Lesson not found','err');
  S.voicePlay={day:r.day,title:r.title,intro:r.intro,drills:r.drills||[],tip:r.tip,phase:r.phase,points:r.points,phase_num:r.phaseNum,idx:0,scores:[],playingTTS:false,recording:false,heard:'',done:false};
  render();
}
function voiceClose(){voiceStopAll();S.voicePlay=null;render()}
function voiceStopAll(){try{window.speechSynthesis&&window.speechSynthesis.cancel()}catch(e){}try{S._voiceRec&&S._voiceRec.stop()}catch(e){}}
function _pickMaleVoice(){
  try{const all=window.speechSynthesis.getVoices()||[];
    // Prefer en-* male-named voices
    const prefer=['Daniel','Google UK English Male','Microsoft David','Microsoft Mark','Microsoft Guy','Alex','Fred','Aaron','Arthur','Reed','Rocko'];
    for(const name of prefer){const v=all.find(x=>x.name&&x.name.indexOf(name)>=0&&(x.lang||'').toLowerCase().startsWith('en'));if(v)return v}
    // Any en-GB or en-US voice
    const en=all.find(x=>(x.lang||'').toLowerCase()==='en-gb')||all.find(x=>(x.lang||'').toLowerCase()==='en-us')||all.find(x=>(x.lang||'').toLowerCase().startsWith('en'));
    return en||all[0]||null;
  }catch(e){return null}
}
function voiceSpeak(text,onEnd){
  if(!('speechSynthesis' in window))return onEnd&&onEnd();
  voiceStopAll();
  if(S.voicePlay){S.voicePlay.playingTTS=true;render()}
  // Use chunked TTS so long passages don't get cut off mid-sentence (Chrome ~15s bug)
  _ttsSpeak(String(text||''),{rate:.94,pitch:.96,volume:1},function(){
    if(S.voicePlay)S.voicePlay.playingTTS=false;
    render();
    if(onEnd)onEnd();
  });
}
function voicePlayIntro(){const p=S.voicePlay;if(!p)return;voiceSpeak(p.intro)}
function voicePlayDrill(){const p=S.voicePlay;if(!p)return;voiceSpeak(p.drills[p.idx]||'')}
function voiceNextDrill(){const p=S.voicePlay;if(!p)return;if(p.idx<p.drills.length-1){p.idx++;p.heard='';render();voiceSpeak(p.drills[p.idx])}else{voiceFinish()}}
function voicePrevDrill(){const p=S.voicePlay;if(!p||p.idx<=0)return;p.idx--;p.heard='';render();voiceSpeak(p.drills[p.idx])}
function _similarity(a,b){a=String(a||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\\s+/g,' ').trim();b=String(b||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\\s+/g,' ').trim();if(!a||!b)return 0;const wa=a.split(' '),wb=b.split(' ');const set=new Set(wa);let hits=0;wb.forEach(w=>{if(set.has(w))hits++});return Math.min(100,Math.round((hits/Math.max(wa.length,wb.length))*100))}
function voiceRecord(){
  const p=S.voicePlay;if(!p)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('\\u26A0\\uFE0F Voice recognition not supported on this browser. Use Chrome or Safari.','err');return}
  const r=new SR();r.lang='en-US';r.continuous=false;r.interimResults=true;r.maxAlternatives=1;
  S._voiceRec=r;p.recording=true;p.heard='';render();
  r.onresult=e=>{let txt='';for(let i=0;i<e.results.length;i++)txt+=e.results[i][0].transcript;p.heard=txt;render()};
  r.onerror=e=>{p.recording=false;render();toast('\\u26A0\\uFE0F '+(e.error||'Recognition error'),'err')};
  r.onend=()=>{
    if(!S.voicePlay)return;
    p.recording=false;
    const expected=p.drills[p.idx]||'';
    const score=_similarity(expected,p.heard);
    p.scores[p.idx]=score;
    render();
  };
  try{r.start()}catch(e){p.recording=false;render();toast('\\u26A0\\uFE0F '+e.message,'err')}
}
async function voiceFinish(){
  const p=S.voicePlay;if(!p)return;
  // Average score across attempted drills, default 70 if none recorded (mark as completed without scoring)
  const valid=p.scores.filter(s=>typeof s==='number');
  const avg=valid.length?Math.round(valid.reduce((s,n)=>s+n,0)/valid.length):70;
  const r=await api('/voice/complete',{method:'POST',body:JSON.stringify({day:p.day,score:avg})});
  if(r&&r.ok){toast('\\u2705 Day '+p.day+' saved \\u2014 +'+r.points+' points');S.voice.progress.completed=r.completed;S.voice.progress.totalPoints=r.totalPoints;loadVoice()}
  voiceClose();
}
async function _mgSave(game,xpAdd,best){const r=await api('/games/progress',{method:'POST',body:JSON.stringify({game,xpAdd:xpAdd|0,best:best!=null?best|0:null})});if(r&&r.ok){S.mg.progress[game]={level:r.level,xp:r.xp,best:r.best,plays:r.plays};if(r.leveledUp)toast('\\u{1F31F} Level up! '+game+' \\u2192 L'+r.level);render()}}
function mgClose(){_mtCleanup();if(S._msTimer){clearInterval(S._msTimer);S._msTimer=null}if(S._mwTimer){clearInterval(S._mwTimer);S._mwTimer=null}try{document.removeEventListener('keydown',_mwOnKey)}catch(e){}S.mgPlay=null;render()}

// ── Word Sprint (anagram unscrambler, 90-sec timer, length-squared scoring) ──
const MG_PUZZLES=[
  {base:'MASTER',valid:['MASTER','STREAM','MATES','TEAMS','MEATS','STEAM','TEARS','MARES','SMART','TAMES','RATES','MAST','EARS','SEAT','RATE','TEAM','TEAR','ARMS','EAT','TEA','SAT','SEA','RAM','MAR','ATE','RAT','ART','MAT','TEAS','STAR','ARTS','RATS','TARS']},
  {base:'PLANET',valid:['PLANET','PLATE','PLEAT','PLANE','PETAL','LATEN','LATE','PLAN','LEAN','PALE','PEAL','LEAP','TALE','TEAL','NEAT','PANE','LANE','PAN','PEN','TEN','NAP','TAP','PAL','LET','EAT','ATE','TEA','PET','ANT','PAT','LAP','APE','APT','NET','NAPE','PEAT']},
  {base:'CRAVING',valid:['CRAVING','RACING','CARING','CARVING','GRAIN','CARGO','CRAG','GAIN','RAIN','RING','RAG','VAN','CAN','CAR','VAR','AIR','ARC','GIN','CIG','CRAVE']},
  {base:'FOCUSED',valid:['FOCUSED','FOCUS','CODES','DECOY','DOSE','CODE','FUSE','FUSED','DUE','SUE','CUE','FOE','SOD','OUD','USE','ODE','DOE','OUDS','FOES','CUES','SUED','DUES','USED']},
  {base:'STRENGTH',valid:['STRENGTH','STENT','TENT','TENTS','RENTS','TERN','GENT','GENTS','GETS','HENS','HENS','NETS','TEN','GET','SET','GEN','HEN','HER','EHRENH','THE','THEE','THESE','THERE','RENT','TREE','TREES','TREET']},
  {base:'CONQUER',valid:['CONQUER','CORE','ROC','ORE','REC','UN','OUR','RUE','OUNCE','ONCE','CONE','CORN','CORN','RUN','RUNE','RUNES','OURS','SOUR','CORE','CORES']}
];
function mgWordStart(){
  const lvl=(S.mg.progress.word&&S.mg.progress.word.level)||1;
  const puzzle=MG_PUZZLES[Math.floor(Math.random()*MG_PUZZLES.length)];
  const letters=puzzle.base.split('').sort(()=>Math.random()-.5);
  S.mgPlay={game:'word',level:lvl,_baseLevel:lvl,base:puzzle.base,letters,valid:puzzle.valid.map(w=>w.toUpperCase()),used:[],score:0,foundSet:new Set(),feedback:null,timeStart:Date.now(),timeMax:90,done:false};
  _mgSound('tap');render();
  if(S._mwTimer)clearInterval(S._mwTimer);
  S._mwTimer=setInterval(_mwTick,100);
  document.addEventListener('keydown',_mwOnKey);
}
function _mwTick(){
  const p=S.mgPlay;if(!p||p.game!=='word'||p.done){if(S._mwTimer){clearInterval(S._mwTimer);S._mwTimer=null}return}
  const elapsed=(Date.now()-p.timeStart)/1000;
  const left=Math.max(0,p.timeMax-elapsed);
  const bar=document.getElementById('mwBar');
  if(bar){bar.style.width=((left/p.timeMax)*100)+'%';bar.style.background=left<10?'linear-gradient(90deg,#DC2626,#F87171)':left<25?'linear-gradient(90deg,#F59E0B,#FCD34D)':'linear-gradient(90deg,#22D3EE,#34D399)'}
  const tn=document.getElementById('mwTime');if(tn)tn.textContent=Math.ceil(left);
  if(left<=0)_mwFinish();
}
function _mwFinish(){
  const p=S.mgPlay;if(!p||p.done)return;
  p.done=true;
  if(S._mwTimer){clearInterval(S._mwTimer);S._mwTimer=null}
  try{document.removeEventListener('keydown',_mwOnKey)}catch(e){}
  _mgSound('levelup');_mgMarkDone('word');
  if(p.foundSet.size>=8)S._mgConfetti=Date.now();
  render();
  _mgSave('word',Math.min(50,p.score),p.foundSet.size);
}
function mgWordTap(idx){
  const p=S.mgPlay;if(!p||p.game!=='word'||p.done)return;
  if(p.used.indexOf(idx)>=0)return;
  p.used.push(idx);_mgSound('tap');render();
}
function mgWordBack(){const p=S.mgPlay;if(!p||p.game!=='word'||p.done)return;p.used.pop();render()}
function mgWordClear(){const p=S.mgPlay;if(!p||p.game!=='word'||p.done)return;p.used=[];render()}
function mgWordSubmit(){
  const p=S.mgPlay;if(!p||p.game!=='word'||p.done)return;
  const word=p.used.map(i=>p.letters[i]).join('');
  const flash=(ok,msg)=>{p.feedback={ok,msg};render();setTimeout(()=>{const cur=S.mgPlay;if(cur&&cur.game==='word'){cur.feedback=null;render()}},650)};
  if(word.length<3){_mgSound('wrong');flash(false,'Min 3 letters');return}
  if(p.foundSet.has(word)){_mgSound('wrong');flash(false,'Already found');return}
  if(p.valid.indexOf(word)>=0){
    p.foundSet.add(word);
    const pts=word.length*word.length;p.score+=pts;
    _mgSound(word.length>=5?'levelup':'correct');
    p.used=[];flash(true,'+'+pts+' \\u2728');
  } else {
    _mgSound('wrong');flash(false,'Not in list');
  }
}
function _mwOnKey(e){
  if(!S.mgPlay||S.mgPlay.game!=='word'||S.mgPlay.done)return;
  if(e.key==='Enter'){e.preventDefault();mgWordSubmit();return}
  if(e.key==='Backspace'){e.preventDefault();mgWordBack();return}
  if(e.key==='Escape'){return}
  if(e.key&&e.key.length===1){const k=e.key.toUpperCase();if(/^[A-Z]$/.test(k)){const p=S.mgPlay;const idx=p.letters.findIndex((c,i)=>c===k&&p.used.indexOf(i)<0);if(idx>=0){e.preventDefault();mgWordTap(idx)}}}
}
function mgPercent(g){const p=S.mg.progress[g]||{level:1,xp:0};return Math.min(100,Math.round((p.xp/(5*100))*100))}

// ── Math Sprint ──
function _mgMathProblem(level){
  const r=(a,b)=>a+Math.floor(Math.random()*(b-a+1));
  let a,b,op,ans;
  if(level<=1){a=r(1,9);b=r(1,9);op=Math.random()<0.5?'+':'-';if(op==='-'&&b>a){[a,b]=[b,a]}ans=op==='+'?a+b:a-b}
  else if(level===2){a=r(10,50);b=r(1,30);op=['+','-','\\u00D7'][r(0,2)];if(op==='\\u00D7'){a=r(2,9);b=r(2,9);ans=a*b}else if(op==='-'&&b>a){[a,b]=[b,a];ans=a-b}else ans=op==='+'?a+b:a-b}
  else if(level===3){a=r(15,99);b=r(2,15);op=['+','-','\\u00D7'][r(0,2)];if(op==='\\u00D7'){a=r(3,15);b=r(2,12);ans=a*b}else if(op==='-'&&b>a){[a,b]=[b,a];ans=a-b}else ans=op==='+'?a+b:a-b}
  else if(level===4){const ops=['+','-','\\u00D7','\\u00F7'];op=ops[r(0,3)];if(op==='\\u00F7'){b=r(2,12);ans=r(2,12);a=b*ans}else if(op==='\\u00D7'){a=r(6,20);b=r(2,12);ans=a*b}else if(op==='-'){a=r(50,200);b=r(10,a-1);ans=a-b}else{a=r(50,500);b=r(20,400);ans=a+b}}
  else{const ops=['+','-','\\u00D7','\\u00F7'];op=ops[r(0,3)];if(op==='\\u00F7'){b=r(3,15);ans=r(3,15);a=b*ans}else if(op==='\\u00D7'){a=r(8,25);b=r(3,15);ans=a*b}else if(op==='-'){a=r(100,500);b=r(30,a-1);ans=a-b}else{a=r(100,800);b=r(50,500);ans=a+b}}
  // Build 4 unique answer choices
  const wrongs=new Set();while(wrongs.size<3){const off=r(-9,9)||1;const w=ans+off;if(w!==ans&&w>=0)wrongs.add(w)}
  const choices=[ans,...wrongs].sort(()=>Math.random()-.5);
  return {a,b,op,ans,choices}
}
// Math Sprint v2 — time pressure, combo multiplier, particles, smooth transitions, end-screen with stars
function _msTimePerProblem(lvl){return [10,8,7,6,5][Math.min(4,Math.max(0,lvl-1))]||10}
function mgMathStart(){
  const lvl=S.mg.progress.math.level;
  S.mgPlay={game:'math',level:lvl,_baseLevel:lvl,score:0,streak:0,best:0,wrongs:0,combo:1,problem:_mgMathProblem(lvl),feedback:null,feedbackChoice:null,startedAt:Date.now(),done:false,problemIdx:0,timeMax:_msTimePerProblem(lvl),timeStart:Date.now(),slideIn:Date.now(),particles:[],bonus:null};
  _mgSound('tap');render();
  if(S._msTimer)clearInterval(S._msTimer);
  S._msTimer=setInterval(_msTick,100);
}
function _msTick(){
  const p=S.mgPlay;if(!p||p.game!=='math'||p.done){if(S._msTimer){clearInterval(S._msTimer);S._msTimer=null}return}
  if(p.feedback)return;  // pause timer during feedback
  const elapsed=(Date.now()-p.timeStart)/1000;
  const left=Math.max(0,p.timeMax-elapsed);
  // Force-render timer bar by triggering a partial DOM update for the bar element
  const bar=document.getElementById('msBar');
  if(bar){bar.style.width=((left/p.timeMax)*100)+'%';bar.style.background=left<2?'linear-gradient(90deg,#DC2626,#F87171)':left<4?'linear-gradient(90deg,#F59E0B,#FCD34D)':'linear-gradient(90deg,#22D3EE,#34D399)'}
  if(left<=0&&!p.feedback){
    // Timeout = wrong
    p.feedback={ok:false,msg:'Time! Answer was '+p.problem.ans,timeout:true};
    p.feedbackChoice=null;p.streak=0;p.combo=1;p.wrongs++;
    _mgSound('wrong');
    render();
    setTimeout(()=>_msNextProblem(),900);
  }
}
function mgMathAnswer(choice){
  const p=S.mgPlay;if(!p||p.game!=='math'||p.done||p.feedback)return;
  const correct=choice===p.problem.ans;
  const elapsed=(Date.now()-p.timeStart)/1000;
  const fast=correct&&elapsed<2;  // sub-2s answer = bonus
  if(correct){
    p.score++;p.streak++;p.combo=Math.min(5,p.combo+1);
    if(p.streak>p.best)p.best=p.streak;
    p.feedback={ok:true,fast,msg:fast?'Lightning!':'Nice'};
    p.feedbackChoice=choice;
    _mgSound(fast?'levelup':'correct');
    // Particle burst at the choice tile
    setTimeout(()=>_msSpawnParticles(choice,fast?20:12),0);
    if(p.streak>=5&&p.level<5){p.level++;p.bonus={text:'Level Up! L'+p.level};setTimeout(()=>{if(S.mgPlay)S.mgPlay.bonus=null;render()},1500)}
  } else {
    p.streak=0;p.combo=1;p.wrongs++;
    p.feedback={ok:false,msg:'Answer: '+p.problem.ans};
    p.feedbackChoice=choice;
    _mgSound('wrong');
    if(p.wrongs>=2&&p.level>p._baseLevel){p.level--;p.wrongs=0}
  }
  render();
  setTimeout(()=>{const cur=S.mgPlay;if(!cur||cur.game!=='math'||cur.done)return;_msNextProblem()},correct?650:1100);
}
function _msNextProblem(){
  const p=S.mgPlay;if(!p||p.game!=='math')return;
  p.problemIdx++;
  if(p.problemIdx>=10){
    // Game complete
    p.done=true;
    if(S._msTimer){clearInterval(S._msTimer);S._msTimer=null}
    _mgSound('levelup');_mgMarkDone('math');
    if(p.score>=8)S._mgConfetti=Date.now();
    render();
    _mgSave('math',p.score*5,p.best);
    return;
  }
  p.problem=_mgMathProblem(p.level);
  p.feedback=null;p.feedbackChoice=null;
  p.timeMax=_msTimePerProblem(p.level);
  p.timeStart=Date.now();
  p.slideIn=Date.now();
  render();
}
function _msSpawnParticles(choice,n){
  // Find the tile DOM node and spawn floating particles around it
  const el=document.querySelector('[data-msc="'+choice+'"]');if(!el)return;
  const r=el.getBoundingClientRect();
  const cx=r.left+r.width/2,cy=r.top+r.height/2;
  const colors=['#FCD34D','#FB923C','#A855F7','#22D3EE','#34D399','#F472B6'];
  for(let i=0;i<n;i++){
    const d=document.createElement('div');
    d.className='ms-particle';
    const a=Math.random()*Math.PI*2,sp=80+Math.random()*120;
    d.style.cssText='left:'+cx+'px;top:'+cy+'px;background:'+colors[i%colors.length]+';--dx:'+(Math.cos(a)*sp)+'px;--dy:'+(Math.sin(a)*sp-40)+'px';
    document.body.appendChild(d);
    setTimeout(()=>d.remove(),900);
  }
}

// ── Memory Tap (canvas-based, Elevate-quality rebuild) ──
// Pentatonic notes per tile (16 notes for up to 25 tiles, repeats for >16)
const MT_NOTES=[261.63,293.66,329.63,392.00,440.00,523.25,587.33,659.25,783.99,880.00,1046.50,1174.66,1318.51,1567.98,1760.00,2093.00,2349.32,2637.02,2793.83,3135.96,3520.00,3951.07,4186.01,4699.63,5274.04];
// Per-tile color palette — each tile gets a hue across the spectrum so it feels rich
const MT_HUES=[210,260,300,340,20,40,60,90,140,170,195,225,255,285,315,345,15,45,75,105,135,165,195,225,255];
function mgMemoryStart(){
  const lvl=S.mg.progress.memory.level;
  // Grid scales with level: L1=3x3, L2=4x4, L3=4x4, L4=5x5, L5=5x5
  const cols=lvl<=1?3:lvl<=3?4:5;
  const grid=cols*cols;
  S.mgPlay={game:'memory',canvasGame:'mt',level:lvl,grid,cols,seq:[],userIdx:0,phase:'pre',round:1,best:0,combo:0,startedAt:Date.now(),done:false};
  _mgSound('tap');render();
  setTimeout(_mtInit,30);
}
function _mtInit(){
  const c=document.getElementById('mtCanvas');if(!c){return}
  S._mtActive=true;
  const dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));
  const cw=c.clientWidth||320,ch=c.clientHeight||320;
  c.width=cw*dpr;c.height=ch*dpr;
  const ctx=c.getContext('2d');ctx.scale(dpr,dpr);
  const p=S.mgPlay;
  const cols=p.cols,gap=10,pad=12;
  const tileSize=Math.floor((Math.min(cw,ch)-pad*2-gap*(cols-1))/cols);
  const gridW=tileSize*cols+gap*(cols-1);
  const offX=(cw-gridW)/2,offY=(ch-gridW)/2;
  // Build tile state
  const tiles=[];
  for(let i=0;i<p.grid;i++){
    const r=Math.floor(i/cols),col=i%cols;
    tiles.push({i,x:offX+col*(tileSize+gap),y:offY+r*(tileSize+gap),size:tileSize,hue:MT_HUES[i%MT_HUES.length],lit:0,press:0,particles:[]});
  }
  S._mt={ctx,c,cw,ch,tiles,gap,tileSize,offX,offY,cols,particles:[],hudFlash:0,bannerText:'Get ready\\u2026',bannerOpacity:1,bannerStartedAt:Date.now(),scoreDisplay:p.round-1,statusMsg:''};
  // Bind canvas tap
  c.onpointerdown=_mtPointer;
  // Start render loop
  if(!S._mtRAF)S._mtRAF=requestAnimationFrame(_mtTick);
  // Begin sequence
  setTimeout(()=>{const cur=S.mgPlay;if(!cur||cur.canvasGame!=='mt')return;_mtNextRound()},1400);
}
function _mtNextRound(){
  const p=S.mgPlay;if(!p||p.canvasGame!=='mt')return;
  const seqLen=p.round+(p.level-1);  // sequence grows each round
  p.seq=Array.from({length:seqLen},()=>Math.floor(Math.random()*p.grid));
  p.userIdx=0;p.phase='show';
  S._mt.bannerText='Round '+p.round;
  S._mt.bannerOpacity=1;S._mt.bannerStartedAt=Date.now();
  setTimeout(()=>_mtFlashSequence(0),900);
}
function _mtFlashSequence(i){
  const p=S.mgPlay;if(!p||p.canvasGame!=='mt'||p.phase!=='show')return;
  if(i>=p.seq.length){p.phase='input';S._mt.statusMsg="Your turn";return}
  const idx=p.seq[i];const t=S._mt.tiles[idx];if(!t)return;
  t.lit=1;_mtPlayNote(idx,0.32,0.5);
  setTimeout(()=>{const tt=S._mt&&S._mt.tiles[idx];if(tt)tt.lit=0;setTimeout(()=>_mtFlashSequence(i+1),220)},420);
}
function _mtPointer(ev){
  const p=S.mgPlay;if(!p||p.canvasGame!=='mt'||p.phase!=='input'||p.done)return;
  const c=S._mt.c;const rect=c.getBoundingClientRect();
  const x=ev.clientX-rect.left,y=ev.clientY-rect.top;
  for(const t of S._mt.tiles){
    if(x>=t.x&&x<=t.x+t.size&&y>=t.y&&y<=t.y+t.size){_mtTapTile(t.i,x,y);break}
  }
}
function _mtTapTile(idx,x,y){
  const p=S.mgPlay;if(!p)return;
  const t=S._mt.tiles[idx];if(!t)return;
  t.press=1;t.lit=0.85;
  setTimeout(()=>{t.press=0;t.lit=0},250);
  if(idx===p.seq[p.userIdx]){
    _mtPlayNote(idx,0.42,0.62);
    p.userIdx++;p.combo++;
    _mtBurst(x,y,t.hue,12);
    if(p.userIdx>=p.seq.length){
      // Round won
      if(p.round>p.best)p.best=p.round;
      p.round++;p.phase='passed';
      _mtRoundCelebrate();
      setTimeout(_mtNextRound,1200);
    }
  } else {
    // Wrong — game over
    p.done=true;p.phase='lost';
    _mtBurst(x,y,0,28);
    _mtPlayChord([196,164.81,130.81],0.45);
    S._mt.bannerText='Round '+p.best+(p.best?' \\u2014 well done':' \\u2014 try again');
    S._mt.bannerOpacity=1;S._mt.bannerStartedAt=Date.now();
    _mgMarkDone('memory');
    _mgSave('memory',p.best*5,p.best);
    setTimeout(_mtShowGameOver,800);
  }
}
function _mtRoundCelebrate(){
  const p=S.mgPlay;if(!p)return;
  S._mt.bannerText='\\u{1F389} '+p.combo+' in a row!';
  S._mt.bannerOpacity=1;S._mt.bannerStartedAt=Date.now();
  // Big confetti at center
  const cx=S._mt.cw/2,cy=S._mt.ch/2;
  for(let k=0;k<22;k++)_mtBurst(cx+(Math.random()-.5)*60,cy+(Math.random()-.5)*40,Math.random()*360,1);
  _mtPlayChord([523.25,659.25,784,1046.5],0.42);
}
function _mtBurst(x,y,hue,n){
  const ps=S._mt.particles;
  for(let i=0;i<n;i++){
    const a=Math.random()*Math.PI*2,sp=2+Math.random()*5;
    ps.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-2,life:1,hue,size:3+Math.random()*4});
  }
}
function _mtTick(now){
  if(!S._mtActive){S._mtRAF=null;return}
  const ctx=S._mt&&S._mt.ctx;if(!ctx){S._mtRAF=requestAnimationFrame(_mtTick);return}
  const cw=S._mt.cw,ch=S._mt.ch;
  // Background gradient
  const g=ctx.createLinearGradient(0,0,0,ch);g.addColorStop(0,'#1E1B4B');g.addColorStop(1,'#0F172A');
  ctx.fillStyle=g;ctx.fillRect(0,0,cw,ch);
  // Tiles
  for(const t of S._mt.tiles){
    const lit=t.lit,press=t.press;
    const scale=press?0.92:(1+lit*0.05);
    const cx=t.x+t.size/2,cy=t.y+t.size/2;
    ctx.save();ctx.translate(cx,cy);ctx.scale(scale,scale);ctx.translate(-cx,-cy);
    // Tile body
    const baseSat=lit>0.5?70:30;
    const baseLight=lit>0.5?60:24;
    ctx.fillStyle='hsl('+t.hue+','+baseSat+'%,'+baseLight+'%)';
    _mtRoundRect(ctx,t.x,t.y,t.size,t.size,16);ctx.fill();
    // Glow when lit
    if(lit>0){
      ctx.shadowColor='hsla('+t.hue+',80%,65%,'+(lit*0.85)+')';
      ctx.shadowBlur=24*lit;
      ctx.fillStyle='hsla('+t.hue+',85%,65%,'+(lit*0.4)+')';
      _mtRoundRect(ctx,t.x,t.y,t.size,t.size,16);ctx.fill();
      ctx.shadowBlur=0;
      // Highlight ring
      ctx.strokeStyle='hsla('+t.hue+',90%,80%,'+lit+')';ctx.lineWidth=3;
      _mtRoundRect(ctx,t.x+1.5,t.y+1.5,t.size-3,t.size-3,15);ctx.stroke();
    }
    // Inner highlight (top)
    const ig=ctx.createLinearGradient(0,t.y,0,t.y+t.size*0.4);
    ig.addColorStop(0,'rgba(255,255,255,'+(0.18+lit*0.25)+')');
    ig.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=ig;_mtRoundRect(ctx,t.x,t.y,t.size,t.size*0.4,16);ctx.fill();
    ctx.restore();
  }
  // Particles
  const ps=S._mt.particles;
  for(let i=ps.length-1;i>=0;i--){
    const pp=ps[i];
    pp.x+=pp.vx;pp.y+=pp.vy;pp.vy+=0.18;pp.life-=0.018;
    if(pp.life<=0){ps.splice(i,1);continue}
    ctx.fillStyle='hsla('+pp.hue+',90%,65%,'+pp.life+')';
    ctx.beginPath();ctx.arc(pp.x,pp.y,pp.size,0,Math.PI*2);ctx.fill();
  }
  // Banner text
  const elapsed=Date.now()-S._mt.bannerStartedAt;
  if(elapsed<2000){
    const op=elapsed<200?elapsed/200:elapsed>1500?Math.max(0,1-(elapsed-1500)/500):1;
    ctx.save();
    ctx.fillStyle='rgba(255,255,255,'+(op*0.95)+')';
    ctx.font='800 '+Math.floor(cw*0.075)+'px -apple-system, system-ui, sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.shadowColor='rgba(124,58,237,'+(op*0.6)+')';ctx.shadowBlur=18;
    ctx.fillText(S._mt.bannerText,cw/2,ch*0.12);
    ctx.restore();
  }
  // Status (your turn / watch)
  if(S.mgPlay&&S.mgPlay.phase==='input'){
    ctx.save();
    ctx.fillStyle='rgba(255,255,255,0.55)';
    ctx.font='600 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign='center';
    ctx.fillText('YOUR TURN \\u2014 '+(S.mgPlay.userIdx+1)+'/'+S.mgPlay.seq.length,cw/2,ch-18);
    ctx.restore();
  } else if(S.mgPlay&&S.mgPlay.phase==='show'){
    ctx.save();
    ctx.fillStyle='rgba(255,255,255,0.55)';
    ctx.font='600 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign='center';
    ctx.fillText('WATCH',cw/2,ch-18);
    ctx.restore();
  }
  S._mtRAF=requestAnimationFrame(_mtTick);
}
function _mtRoundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function _mtPlayNote(idx,gain,dur){
  try{
    if(!_mgAudio)_mgAudio=new(window.AudioContext||window.webkitAudioContext)();
    const ctx=_mgAudio,t=ctx.currentTime;
    const f=MT_NOTES[idx%MT_NOTES.length]||440;
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.value=f;
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(gain||0.3,t+0.01);
    g.gain.exponentialRampToValueAtTime(0.001,t+(dur||0.45));
    o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+(dur||0.45)+0.05);
  }catch(e){}
}
function _mtPlayChord(freqs,dur){freqs.forEach((f,i)=>{try{if(!_mgAudio)_mgAudio=new(window.AudioContext||window.webkitAudioContext)();const ctx=_mgAudio,t=ctx.currentTime;const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,t+i*0.06);g.gain.linearRampToValueAtTime(0.18,t+i*0.06+0.02);g.gain.exponentialRampToValueAtTime(0.001,t+i*0.06+(dur||0.4));o.connect(g).connect(ctx.destination);o.start(t+i*0.06);o.stop(t+i*0.06+(dur||0.4)+0.05)}catch(e){}})}
function _mtShowGameOver(){
  const p=S.mgPlay;if(!p)return;
  S._mtActive=false;  // stop the loop
  cancelAnimationFrame(S._mtRAF);S._mtRAF=null;
  render();  // re-renders into the modal end-screen
}
function _mtCleanup(){S._mtActive=false;if(S._mtRAF){cancelAnimationFrame(S._mtRAF);S._mtRAF=null}S._mt=null}

// ── Reaction ──
function mgReactionStart(){S.mgPlay={game:'reaction',level:S.mg.progress.reaction.level,phase:'wait',time:null,best:S.mg.progress.reaction.best||0,done:false};_mgSound('tap');render();const t=800+Math.floor(Math.random()*2200);S.mgPlay._timer=setTimeout(()=>{const p=S.mgPlay;if(!p||p.game!=='reaction')return;p.phase='go';p.startedAt=Date.now();_mgSound('go');render()},t)}
function mgReactionTap(){const p=S.mgPlay;if(!p||p.game!=='reaction')return;if(p.phase==='wait'){clearTimeout(p._timer);p.phase='early';_mgSound('wrong');render();return}if(p.phase==='go'){const ms=Date.now()-p.startedAt;p.time=ms;p.phase='done';p.done=true;_mgSound(ms<350?'levelup':'correct');_mgMarkDone('reaction');if(ms<500)S._mgConfetti=Date.now();render();
    const xp=ms<250?20:ms<350?15:ms<500?10:ms<700?6:3;_mgSave('reaction',xp,ms)}}
// Rock / Paper / Scissors vs random bot
function rpsPlay(p){
  const opts=['rock','paper','scissors'];
  const b=opts[Math.floor(Math.random()*3)];
  let r='draw';
  if(p!==b){r=((p==='rock'&&b==='scissors')||(p==='paper'&&b==='rock')||(p==='scissors'&&b==='paper'))?'win':'lose'}
  S.rps.lastPlayer=p;S.rps.lastBot=b;S.rps.lastResult=r;
  if(r==='win'){S.rps.playerWins++;localStorage.setItem('tf_rps_w',S.rps.playerWins)}
  else if(r==='lose'){S.rps.botWins++;localStorage.setItem('tf_rps_l',S.rps.botWins)}
  else{S.rps.draws++;localStorage.setItem('tf_rps_d',S.rps.draws)}
  render();
}
// Number Guess (1-100)
function guessStart(){S.guess={target:Math.floor(Math.random()*100)+1,attempts:0,history:[],message:'I'+'\\u2019'+'m thinking of a number from 1 to 100. Take a guess.',ended:false};render();setTimeout(()=>{const e=document.getElementById('guessInput');if(e)e.focus()},80)}
function guessSubmit(){
  if(S.guess.ended||S.guess.target==null){if(S.guess.target==null)return guessStart()}
  const el=document.getElementById('guessInput');const n=parseInt((el&&el.value)||'',10);
  if(!Number.isFinite(n)||n<1||n>100){S.guess.message='Enter a number between 1 and 100.';render();return}
  S.guess.attempts++;S.guess.history.unshift(n);if(el)el.value='';
  if(n===S.guess.target){S.guess.message='\\u{1F389} Got it in '+S.guess.attempts+' '+(S.guess.attempts===1?'try':'tries')+'!';S.guess.ended=true}
  else if(n<S.guess.target)S.guess.message='Higher \\u2191';
  else S.guess.message='Lower \\u2193';
  render();if(!S.guess.ended)setTimeout(()=>{const e=document.getElementById('guessInput');if(e)e.focus()},80);
}
// Dice — roll two d6
function rollDice(){
  if(S.dice.rolling)return;S.dice.rolling=true;render();
  setTimeout(()=>{const a=1+Math.floor(Math.random()*6),b=1+Math.floor(Math.random()*6);S.dice.values=[a,b];S.dice.history.unshift(a+b);if(S.dice.history.length>10)S.dice.history.length=10;S.dice.rolling=false;render()},650);
}
async function loadWeather(){if(S.weather.loading)return;S.weather.loading=true;S.weather.error=null;render();try{const r=await fetch('/api/weather?city='+encodeURIComponent(S.weather.city||'Bangalore'));const j=await r.json();if(j.error){S.weather.error=j.error}else{S.weather.city=j.city||S.weather.city;S.weather.country=j.country||'';S.weather.temp=j.temp;S.weather.aqi=j.aqi}}catch(e){S.weather.error=String(e)}S.weather.loaded=true;S.weather.loading=false;render()}
const INDIA_CITIES=['Delhi','Mumbai','Chennai','Bengaluru','Pune','Shimla','Indore','Jaipur'];
const WORLD_CITY_LIST=[
  {key:'New York',label:'New York',tz:'America/New_York'},
  {key:'London',label:'London',tz:'Europe/London'},
  {key:'Singapore',label:'Singapore',tz:'Asia/Singapore'},
  {key:'Shanghai',label:'Shanghai',tz:'Asia/Shanghai'},
  {key:'Tokyo',label:'Tokyo',tz:'Asia/Tokyo'},
  {key:'Sydney',label:'Sydney',tz:'Australia/Sydney'}
];
async function loadCityTemps(){const all=[...INDIA_CITIES,...WORLD_CITY_LIST.map(c=>c.key)];const results=await Promise.all(all.map(c=>fetch('/api/weather?city='+encodeURIComponent(c)).then(r=>r.json()).catch(()=>({}))));const m={};results.forEach((r,i)=>{if(r&&!r.error)m[all[i].toLowerCase()]={temp:r.temp,city:r.city||all[i]}});S.cityTemps=m;render()}
async function loadRemember(){try{const r=await fetch('/api/remember/today');const j=await r.json();S.remember={person:j.person||null,loaded:true};render()}catch(e){S.remember={person:null,loaded:true};render()}}
function editLifeGoal(){const v=prompt('Your goal in life \\u2014 your north star.\\nEdit any time.',S.lifeGoal||'');if(v===null)return;const t=v.trim().slice(0,400);S.lifeGoal=t;localStorage.setItem('tf_life_goal',t);render()}
async function loadTicker(){try{const r=await fetch('/api/news?cat=world',{cache:'no-store'});const j=await r.json();S.ticker={items:(j.items||[]).slice(0,12),idx:0,loaded:true};render();_startTicker()}catch(e){}}
let _tickerTimer=null;
function _startTicker(){if(_tickerTimer)clearInterval(_tickerTimer);if(!S.ticker.items.length)return;_tickerTimer=setInterval(()=>{if(!S.ticker.items.length)return;S.ticker.idx=(S.ticker.idx+3)%S.ticker.items.length;const stack=document.getElementById('newsTickerStack');if(stack)render()},9000)}
function setCity(){const c=prompt('Set your city',S.weather.city||'Bangalore');if(!c)return;const t=c.trim();if(!t)return;localStorage.setItem('tf_city',t);S.weather.city=t;S.weather.loaded=false;loadWeather()}
// Live-tick the sidebar, header clocks AND world clocks without re-rendering the whole tree
setInterval(()=>{const n=new Date();const hm=n.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});const sec=String(n.getSeconds()).padStart(2,'0');const t=document.getElementById('sideNowTime');const s=document.getElementById('sideNowSec');if(t&&s){if(t.firstChild&&t.firstChild.nodeValue!==hm)t.firstChild.nodeValue=hm;s.textContent=':'+sec}const ht=document.getElementById('hdrTimeHm');const hs=document.getElementById('hdrTimeSec');if(ht&&hs){if(ht.textContent!==hm)ht.textContent=hm;hs.textContent=':'+sec}const cities=document.querySelectorAll('[data-tz]');cities.forEach(el=>{try{const tz=el.getAttribute('data-tz');const t2=new Date().toLocaleTimeString('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false});if(el.textContent!==t2)el.textContent=t2}catch(e){}})},1000);

async function loadBooks(cat){S.booksCat=cat;S.booksLoading=true;S.booksError=null;render();try{const subjectMap={'self-help':'(subject:"self-help" OR subject:"self help" OR subject:"self improvement" OR subject:"non-fiction")'};const subj=subjectMap[cat]||('subject:'+cat);const q=cat==='all'?'collection:librivoxaudio AND mediatype:audio':'collection:librivoxaudio AND mediatype:audio AND '+subj;const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=30&output=json&sort[]=downloads+desc';const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),12000);const r=await fetch(url,{signal:ctrl.signal,cache:'no-store'});clearTimeout(t);if(!r.ok)throw new Error('archive.org returned '+r.status);const j=await r.json();S.books=(j.response&&j.response.docs)||[];if(!S.books.length)S.booksError='No audiobooks found in this category';}catch(e){S.books=[];S.booksError=e.name==='AbortError'?'Audiobook server timed out — try the 15-min summaries above instead':'Audiobook server (archive.org) is unreachable — check your connection or try the 15-min summaries above'}S.booksLoading=false;render()}
async function playBook(id){const b=S.books.find(x=>x.identifier===id);if(!b){toast('\\u26A0\\uFE0F Book not found','err');return}const title=Array.isArray(b.title)?b.title[0]:b.title;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');S.playing={id,title,author,loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F No files \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=j.files.find(f=>/_64kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/_32kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.mp3$/i.test(f.name)&&!/sample|test|spoken/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const directUrl='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');const dlUrl='https://archive.org/download/'+encodeURIComponent(id)+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title,author,url:directUrl,altUrl:dlUrl,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(!a)return;a.setAttribute('playsinline','');a.setAttribute('webkit-playsinline','');a.preload='auto';a.addEventListener('error',function onErr(){a.removeEventListener('error',onErr);if(a.src!==dlUrl){a.src=dlUrl;a.load()}},{once:true});a.load();a.addEventListener('play',startBookListenTimer);a.addEventListener('pause',()=>{/* keep timer; checks paused itself */});const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap the play button on the bar','err'))},250)}else{toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing={id,title,author,url:null,external:'https://archive.org/details/'+id,error:e.message};render()}}

// ═══ 15-MINUTE BOOK SUMMARIES ═══
const BOOK_SUMMARIES=[
  {id:'atomic',title:'Atomic Habits',author:'James Clear',tag:'productivity',mins:14,grad:'linear-gradient(135deg,#0a0a14 0%,#2a1845 50%,#6f5cff 100%)',
   why:'Tiny changes, remarkable results. The single most actionable book on behaviour change written this century.',
   insights:[['1% better, every day','Small improvements compound. A 1% gain repeated daily yields 37x growth in a year.'],['Identity, not goals','Don\\'t aim to run a marathon — become a runner. Habits stick when they reinforce who you believe you are.'],['The four laws','Make it obvious, attractive, easy, satisfying. Each is a lever you can pull on any habit.'],['Environment over willpower','Your environment is the silent hand. Shape it once and it works for you 24/7.'],['The plateau of latent potential','Results lag behind effort. Disappointment usually arrives just before the breakthrough.']],
   summary:'You don\\'t rise to your goals — you fall to your systems. James Clear argues that improvement is a function of consistent, tiny actions, not heroic sprints. A 1% gain held daily compounds; a 1% loss does the same in reverse. The first move is to stop chasing outcomes and start engineering processes. The second is to stop trying to be motivated and start changing your environment so the right move is the obvious one. The third is identity. Every action you take is a vote for the kind of person you wish to become. Habits stick when the new behaviour is consistent with that identity. The four laws of behaviour change — make it obvious, attractive, easy, and satisfying — give you concrete levers. Want to read more? Put the book on your pillow. Want to scroll less? Charge your phone in another room. Most failure isn\\'t about discipline. It\\'s about friction in the wrong direction. The plateau is the last lesson. Results lag behind effort because most of the work is invisible. The breakthrough almost always arrives just after the moment most people quit.'},
  {id:'deep',title:'Deep Work',author:'Cal Newport',tag:'focus',mins:13,grad:'linear-gradient(135deg,#001214 0%,#003640 50%,#2effa9 100%)',
   why:'The economic moat of the next decade is the ability to focus without distraction on a cognitively demanding task.',
   insights:[['Focus is the new IQ','Two skills will matter: learning hard things fast, and producing at an elite level. Both require deep work.'],['Shallow work is the enemy','Email, Slack, and meetings feel like work. They aren\\'t. They are the texture of looking productive.'],['Schedule every minute','Time-block your day in advance. The plan will fail, but the planning won\\'t.'],['Embrace boredom','If you can\\'t sit with five minutes of nothing, your concentration muscle has atrophied. Train it back.'],['Quit social media','Or at least audit it ruthlessly. The opportunity cost is your attention, the most precious resource you own.']],
   summary:'Cal Newport\\'s thesis is that the ability to focus without distraction on a cognitively demanding task is becoming both rare and valuable in our economy. He calls this skill deep work, and contrasts it with shallow work — the email, the chat, the half-listened meetings that feel like productivity but rarely move the needle. The first move is recognising the difference. The second is structuring your life so deep work has a place. Newport offers four philosophies: the monastic, the bimodal, the rhythmic, and the journalistic. Pick the one that fits your life, but pick one. The third move is to stop treating your attention as infinite. Schedule every minute of your day in advance — not to obey the schedule rigidly, but to force yourself to confront how you intend to spend your hours. Embrace boredom. If you cannot sit through five minutes without reaching for a feed, you have trained your brain to demand novelty. Train it back. And finally, quit, or radically constrain, the tools that have systematically rewired your attention against you.'},
  {id:'medi',title:'Meditations',author:'Marcus Aurelius',tag:'stoic',mins:15,grad:'linear-gradient(135deg,#1a0f08 0%,#3d2410 50%,#ffb547 100%)',
   why:'A roman emperor\\'s private journal. Two thousand years old and still the clearest manual for not losing your mind.',
   insights:[['You always have power','Over your mind, never outside events. Realise this and you find strength.'],['Memento mori','You could leave life right now. Let that determine what you do, say, and think.'],['The obstacle is the way','What stands in the way becomes the way. The impediment to action advances action.'],['Choose your thoughts','You become what you give your attention to. So be ruthless about what you let in.'],['Waste no time','Don\\'t worry about being remembered. Be useful, now, with the time you have.']],
   summary:'Marcus Aurelius did not write Meditations for you. He wrote it for himself, late at night, between battles, as a private exercise in keeping his head straight. That is what makes it timeless. The first lesson is that you always have power over your mind, but never over outside events. Stop trying to control the world. Start controlling your response to it. The second is memento mori — remember that you will die. Not as a morbid trick, but as the most clarifying lens available. You could leave life right now. Let that fact determine what you do, say, and think. The third is that the obstacle is the way. The thing that stands between you and your work is, often, the work itself. The fourth is attention. You become what you give your attention to. Choose your thoughts the way you would choose your meals. The fifth is to be useful, now, with the time you have. Don\\'t spend it waiting to be ready. Don\\'t spend it worrying about being remembered. Be useful. Today. That is the whole programme.'},
  {id:'dopa',title:'Dopamine Nation',author:'Anna Lembke',tag:'mind',mins:13,grad:'linear-gradient(135deg,#1a0810 0%,#3d0820 50%,#ff6a8b 100%)',
   why:'A psychiatrist on why a world of constant pleasure is making us miserable — and what to do about it.',
   insights:[['Pleasure and pain are linked','They are processed in the same part of the brain. They work like a seesaw.'],['Dopamine fasting works','Abstain from your drug — phones, sugar, porn — for thirty days. Reset the baseline.'],['Truth-telling heals','Naming the addiction out loud is half the cure. Shame loses oxygen in honesty.'],['Pain on purpose','Voluntary discomfort — cold showers, exercise, fasting — pushes the seesaw the other way.'],['Connection beats compulsion','We don\\'t reach for the drug because we love it. We reach because we are alone.']],
   summary:'Dr Anna Lembke runs an addiction clinic at Stanford. Her insight is unsettling: in a world of cheap, abundant pleasure, the human nervous system has been knocked off balance. Pleasure and pain, she argues, are processed in the same part of the brain and work like a seesaw. Press it down on the pleasure side and the brain compensates by tilting toward pain. The first generation of patients she saw were addicted to substances. The newest generation is addicted to phones, food, porn, work, gambling — the everyday compulsions of normal life. The cure begins with abstinence. A thirty-day dopamine fast resets the baseline. The second move is truth-telling. Name the addiction out loud, in detail, to someone you trust. Shame loses oxygen in honesty. The third is pain on purpose — voluntary discomfort that tilts the seesaw back. Cold showers, exercise, hard work, fasting. And the fourth, the deepest, is connection. We rarely reach for the drug because we love it. We reach because we are alone, and the drug is always available.'},
  {id:'sap',title:'Sapiens',author:'Yuval Noah Harari',tag:'mind',mins:15,grad:'linear-gradient(135deg,#0a0a06 0%,#2a2010 50%,#c8ff3d 100%)',
   why:'A brief history of humankind, told in three revolutions: cognitive, agricultural, and scientific.',
   insights:[['We rule because we gossip','Sapiens cooperate in large numbers because we share fictions — money, nations, gods.'],['Agriculture was a trap','It made us fewer calories, more hierarchy, and worse health. We chose abundance over freedom.'],['Money is universal trust','It works because everyone agrees it works. Strip away the agreement and there is nothing.'],['Empires homogenise','For better or worse, empires spread universal ideas faster than any tribe ever could.'],['Happiness has not risen','Despite progress, the average human is no happier than a hunter-gatherer. Maybe less.']],
   summary:'Harari\\'s argument is that the success of Homo sapiens cannot be explained by intelligence or strength. Many species are intelligent. Many are strong. Sapiens won the planet because we can cooperate in large numbers around shared fictions — money, nations, religions, corporations, human rights. None of these things exist in physical reality. They exist because we all agree they do. The first revolution was cognitive: somewhere around seventy thousand years ago, our brains acquired the capacity for fiction. The second was agricultural — and Harari calls it the worst deal in history. We worked harder, ate worse, and lived shorter lives than our hunter-gatherer ancestors. We chose abundance over freedom. The third was scientific. The willingness to admit ignorance and to test ideas against reality unleashed a flood of progress in just five hundred years. But the question Harari leaves you with is unsettling. With all our power, are we any happier than the hunter-gatherer who knew the name of every plant in her valley? The answer, on the available evidence, is no.'},
  {id:'fast',title:'Thinking, Fast and Slow',author:'Daniel Kahneman',tag:'mind',mins:14,grad:'linear-gradient(135deg,#06070d 0%,#1a1f3d 50%,#6f5cff 100%)',
   why:'A nobel laureate on the two systems that shape every choice you make — and how each one fails.',
   insights:[['System 1 is fast','It runs on intuition, pattern, and feeling. It is usually right. Until it is not.'],['System 2 is slow','Deliberate, logical, and lazy. It will let System 1 run the show unless you force it to wake up.'],['You are biased','Anchoring, framing, availability, loss aversion — every shortcut System 1 takes is also a trap.'],['The peak-end rule','You do not remember experiences. You remember the peak and the end. Plan accordingly.'],['Two selves','The experiencing self lives the moment. The remembering self tells the story. They disagree.']],
   summary:'Kahneman\\'s life work, distilled. The mind, he argues, runs two systems. System 1 is fast, automatic, and intuitive — the part of you that recognises a face, drives a familiar route, knows that two plus two is four. System 2 is slow, deliberate, and effortful. It does the long division, weighs the evidence, makes the considered choice. System 2 is also lazy. It will let System 1 run the show unless something forces it to wake up. Most of the errors humans make come from this division of labour. We are anchored by the first number we hear. We are swayed by the way a question is framed. We judge probability by how easily examples come to mind. We feel losses about twice as strongly as equivalent gains. And we have two selves. The experiencing self lives the present moment. The remembering self constructs the story. They disagree about almost everything. We make decisions based on the remembered story, not the lived experience — which is why we plan vacations we don\\'t enjoy and stay in jobs we hate. Knowing this won\\'t cure you. But it will help you catch yourself.'},
  {id:'frankl',title:'Man\\'s Search for Meaning',author:'Viktor Frankl',tag:'stoic',mins:12,grad:'linear-gradient(135deg,#0a0a0a 0%,#2a2a2a 50%,#d6b4ff 100%)',
   why:'A psychiatrist survives Auschwitz and writes the most influential book on meaning of the 20th century.',
   insights:[['Meaning is the engine','Those who survived the camps had something to live for. The rest perished.'],['You can\\'t control everything','Between stimulus and response there is a space. In that space lies your freedom.'],['Suffering with meaning','Pain becomes bearable the moment it has a reason. Without one, even comfort is unbearable.'],['Three sources of meaning','Work, love, and the courage you bring to unavoidable suffering.'],['Don\\'t aim at happiness','Happiness ensues. Pursued, it eludes. Chase meaning instead and the rest follows.']],
   summary:'Viktor Frankl spent three years in Nazi concentration camps. He emerged with a thesis that has shaped modern psychology: the deepest human drive is not pleasure, not power, but meaning. He observed that the prisoners who survived the camps were not the strongest or the smartest. They were the ones who had something — a person, a project, an unfinished work — to live for. The rest perished. Frankl distilled this into what he called logotherapy. The first principle is that between stimulus and response there is a space. In that space lies your freedom and your growth. The second is that suffering, if it has a meaning, becomes bearable. Pain without reason crushes us. Pain with a why we can withstand almost anything. The third is that meaning has three sources: work that matters, love for another person, and the courage we bring to unavoidable suffering. The fourth, perhaps the most counterintuitive, is that you cannot pursue happiness directly. It must ensue, as a side-effect of dedication to a cause greater than oneself. Chase happiness and it flees. Chase meaning and the rest follows.'},
  {id:'now',title:'The Power of Now',author:'Eckhart Tolle',tag:'mind',mins:12,grad:'linear-gradient(135deg,#06121a 0%,#0e2a3d 50%,#2effa9 100%)',
   why:'A spiritual teacher on the simplest, most overlooked truth: the present is the only moment that is real.',
   insights:[['You are not your mind','The voice in your head is not you. It is a tool you have mistaken for your self.'],['The present is all there is','The past is memory. The future is projection. Now is the only thing that exists.'],['The pain-body','Old emotional pain lives in the body and wakes up to feed on more pain. Watch it without feeding it.'],['Surrender, then act','Accept the moment as it is. Then, from that ground, do what needs doing.'],['Stillness is the answer','Beneath the noise of the mind there is a deeper intelligence. Get quiet enough to hear it.']],
   summary:'Tolle\\'s message is almost embarrassingly simple, which is why it is so often missed. The present moment is all you ever have. The past is memory; the future is projection. Both happen, when they happen at all, in the present. Yet most of us spend almost no time here. We are lost in the voice in our head — the running commentary, the rehearsed argument, the imagined future. We have mistaken that voice for who we are. The first move is to notice that you can hear the voice. If you can hear it, you are not it. The second is the pain-body — old emotional pain that lives on in you and seeks out more pain to feed itself. You don\\'t fight it. You watch it without feeding it, and it weakens. The third is surrender, which Tolle is careful to distinguish from passivity. Accept the moment as it is — then, from that ground, do what needs doing. Resistance is what creates suffering on top of pain. The fourth is stillness. Beneath the noise of the mind there is an intelligence that is older and quieter than thought. Get quiet enough, often enough, and you start to live from there.'},
  {id:'subtle',title:'The Subtle Art',author:'Mark Manson',tag:'mind',mins:13,grad:'linear-gradient(135deg,#1a0606 0%,#3a0c0c 50%,#ff5050 100%)',
   why:'Stop trying to feel good all the time. Pick the right struggles and the rest follows.',
   insights:[['Care less, but better','You only have so many f**ks to give. Spend them on a few things that actually matter.'],['The good life is built on good problems','You will always have problems. Choose problems you enjoy solving.'],['Pain is the price of meaning','Anything worth doing has discomfort baked in. Avoid the discomfort, you avoid the meaning.'],['Failure is the path','You only learn what works by finding what doesn\\'t. Get more failures, faster.'],['You are responsible, not at fault','You didn\\'t cause every bad thing. But you are responsible for what you do next.']],
   summary:'Mark Manson\\'s thesis is a counter-punch to a culture obsessed with positivity. The relentless message that you should always feel good, always be your best self, always be optimising — Manson argues — is itself the source of much of our anxiety. Real growth comes from caring less, but caring better. You have a finite supply of attention. Spend it on a small number of things that actually matter and let everything else go. The good life is not the absence of problems; it is having good problems. The kind you enjoy solving. Pain is not the enemy. It is the price of any meaningful life. Avoid the pain, you avoid the meaning. Failure is not a setback but the path itself — every successful person you admire has failed more times than you have tried. The deepest move is the distinction between fault and responsibility. You are not at fault for every bad thing that happened to you. But you are responsible for what you do about it. Once you accept that, you stop being a victim of circumstance and start being the protagonist of your story.'},
  {id:'flow',title:'Flow',author:'Mihaly Csikszentmihalyi',tag:'focus',mins:13,grad:'linear-gradient(135deg,#020a14 0%,#062041 50%,#22D3EE 100%)',
   why:'The state of total absorption in what you do — and how to engineer your life around it.',
   insights:[['Flow is the optimal experience','When skill matches challenge, attention narrows, ego dissolves, time disappears.'],['Set clear goals','You can\\'t enter flow without knowing what success looks like in this moment.'],['Get instant feedback','You need to see if your action is working. Otherwise the mind drifts.'],['Match challenge to skill','Too easy = bored. Too hard = anxious. The sweet spot is just beyond your edge.'],['Autotelic personality','People who can find flow anywhere have built the habit of meaning. You can train it.']],
   summary:'Csikszentmihalyi spent decades asking surgeons, chess players, rock climbers, and assembly-line workers what made them feel most alive. The answer was the same: a state he called flow — total immersion in a task where attention narrows, the ego falls away, and time bends. Flow is not luck. It has conditions. The challenge has to match your skill — too easy and you are bored, too hard and you are anxious. You need a clear goal so you know what to aim at. You need immediate feedback so you can adjust. And you need to be able to concentrate without interruption. The deepest insight of the book is that flow is teachable. People who routinely enter flow — what Csikszentmihalyi calls autotelic personalities — have built the habit of finding meaning in whatever they do. They can be in flow doing dishes if they choose to. Flow is not just productivity. It is the texture of a well-lived life.'},
  {id:'grit',title:'Grit',author:'Angela Duckworth',tag:'mind',mins:12,grad:'linear-gradient(135deg,#0c0805 0%,#3a1c0a 50%,#FB923C 100%)',
   why:'Talent is overrated. Sustained effort over years is what predicts success.',
   insights:[['Grit beats talent','In every field studied, sustained passion + perseverance beat raw talent.'],['Effort counts twice','Talent × effort = skill. Skill × effort = achievement. Effort shows up on both sides.'],['Find your "why"','You don\\'t persist for any goal — you persist for one that connects to a meaning you care about.'],['Deliberate practice','Drill the specific weak spot. Get coached. Repeat until it\\'s easy. Then find the next weak spot.'],['Hope is a skill','The grittiest don\\'t avoid setbacks. They have a built-in muscle for getting back up.']],
   summary:'Angela Duckworth set out to discover what predicts elite performance. She studied West Point cadets, spelling-bee champions, Olympic athletes, and Fortune 500 CEOs. The single best predictor of success was not IQ, not talent, not family income. It was grit — sustained passion and perseverance toward long-term goals. In her formula, talent multiplied by effort produces skill. Skill multiplied by effort produces achievement. Effort shows up twice. Grit is partly innate but mostly built. It grows when you find a why that genuinely matters to you, when you practice deliberately rather than just putting in hours, and when you treat setbacks as information rather than verdicts. The grittiest people Duckworth studied had a "high-level goal" — a guiding purpose — that gave coherence to all the smaller goals beneath it. They were also gritty because they were optimistic. They believed effort would pay off, and that belief itself made the effort pay off.'},
  {id:'mindset',title:'Mindset',author:'Carol Dweck',tag:'mind',mins:11,grad:'linear-gradient(135deg,#0c0a14 0%,#1f1245 50%,#A78BFA 100%)',
   why:'How you think about your abilities shapes how you grow them. Two mindsets, two very different lives.',
   insights:[['Two mindsets','Fixed: ability is given. Growth: ability is built. The framework you choose changes everything.'],['Fixed mindset hates effort','If talent is innate, needing to work hard means you don\\'t have it. So fixed-mindset people avoid challenge.'],['Growth mindset loves it','Effort is what makes you better. Failure is just data on the way to mastery.'],['Praise process, not person','Tell a child she is smart, she protects the label. Tell her she worked hard, she keeps working.'],['Mindset is changeable','You catch yourself in fixed thinking. You name it. You re-frame. The growth muscle gets stronger.']],
   summary:'Carol Dweck\\'s research distills decades of work on how children, and adults, respond to challenge. She found two underlying mindsets. People with a fixed mindset believe abilities are essentially set — you are smart or you aren\\'t, athletic or not, creative or not. People with a growth mindset believe abilities are built through practice. The difference looks small. The consequences are enormous. Fixed-mindset people avoid challenge because failure threatens the identity they\\'ve built around being talented. They give up sooner, plateau earlier, and feel deeply threatened by other people\\'s success. Growth-mindset people lean into challenge because effort is the path to becoming. They stick with hard things, see setbacks as feedback, and feel inspired by others\\' achievements rather than diminished. The deepest move in the book is that mindset is not a fixed trait — it can be learned. You catch yourself in fixed thinking ("I\\'m just not a math person"), you name it, you reframe it ("I\\'m not a math person yet"), and over time the growth voice becomes louder than the fixed one.'},
  {id:'4hour',title:'The 4-Hour Workweek',author:'Tim Ferriss',tag:'productivity',mins:12,grad:'linear-gradient(135deg,#0a0c14 0%,#0f2030 50%,#22D3EE 100%)',
   why:'Stop trading time for money. Design a life of mini-retirements instead of one big one at 65.',
   insights:[['Define your dreamline','Concrete dreams in dollars + dates beat vague "freedom" goals every time.'],['Eliminate before optimizing','Doing less of the wrong thing beats doing more of the right thing efficiently.'],['Pareto everywhere','80% of your output comes from 20% of your inputs. Find the 20%. Cut the rest.'],['Automate it','Once a process works, hand it to a system or a contractor. Free yourself for the next problem.'],['Mini-retirements','Don\\'t save freedom for 65. Take 1-month retirements throughout life — much more meaningful.']],
   summary:'Tim Ferriss popularised a way of life that treats traditional career math as broken. The deal you are sold — work hard for forty years, retire at sixty-five, then enjoy yourself — assumes you will still be young enough, healthy enough, and inspired enough to enjoy what you saved for. Most of the time, you won\\'t. Ferriss proposes the opposite. Define exactly what your ideal life looks like — in concrete numbers and dates. Most people\\'s dreams are dramatically cheaper than they think. Then engineer your work life backwards from that. The first move is elimination. Don\\'t optimise email — stop checking it. Don\\'t make meetings shorter — refuse them. Apply Pareto everywhere: most of your output comes from a small slice of your inputs. The second move is automation. Once a task works, build a system or hire someone to do it. Outsource your inbox, your calendar, your customer support. The third move is liberation — the geographic freedom that comes from working remotely and on results, not hours. Take mini-retirements throughout your life rather than waiting for one giant retirement that may never feel as good as you imagined.'},
  {id:'showup',title:'Show Your Work',author:'Austin Kleon',tag:'productivity',mins:11,grad:'linear-gradient(135deg,#0a0a0a 0%,#3a2c1a 50%,#FCD34D 100%)',
   why:'You don\\'t need to be a genius. You need to share your work as you make it.',
   insights:[['Share something every day','Write a post, post a sketch, ship a tiny prototype. Tiny over perfect, every time.'],['Document your process','Behind-the-scenes is more interesting than the final piece. Show the mess.'],['Talk about what you love','Enthusiasm is the strongest signal you can send. Be unironic about your obsessions.'],['Find the through-line','Over time, what you share will reveal what you actually care about. Trust that.'],['Don\\'t be a spammer','Sharing is generous when you give more than you take. Useful before promotional.']],
   summary:'Austin Kleon\\'s short, sharp book is a manifesto for the slightly-nervous creative who has not yet started sharing their work in public. His thesis is that you don\\'t need to be a genius. You need to be a node in a network. Share something small every day. Document the process, not just the polished output — the mess is more interesting than the masterpiece. Talk about what you love, unironically and specifically. Over time, the things you share reveal a through-line you couldn\\'t have planned. The world finds you through the work you put out, not the work you keep in a drawer. The book is full of tactical moves: keep an idea diary, learn to tell stories about your work in three sentences, give credit generously, ignore haters but listen to thoughtful critics. The deeper point is about generosity. The internet rewards people who give more than they take. Share useful things before you ever ask for anything. The audience accumulates quietly, and one day you wake up and realise the work has its own legs.'},
  {id:'sevenh',title:'The 7 Habits',author:'Stephen Covey',tag:'productivity',mins:14,grad:'linear-gradient(135deg,#0a0c14 0%,#102545 50%,#3B82F6 100%)',
   why:'Be proactive. Begin with the end in mind. Put first things first. The classic frame for an effective life.',
   insights:[['Be proactive','You are not your circumstances. You are how you respond to them. That is your superpower.'],['Begin with the end in mind','Write your own eulogy. Then live the life that earns it.'],['Put first things first','Important > urgent. Schedule the rocks first; the gravel and sand fit around them.'],['Think win-win','Every relationship works better when both sides leave better off. Anything else is brittle.'],['Sharpen the saw','You are the instrument. Maintain your body, mind, heart, and spirit, or you blunt over time.']],
   summary:'Covey\\'s seven habits have become so absorbed into business culture that they feel obvious — which is exactly why people miss the depth. Habit 1 is to be proactive: between what happens to you and how you respond, there is a space, and your power lives in that space. Habit 2 is to begin with the end in mind. Imagine your own funeral. What would you want said? Live the life that earns it. Habit 3 is to put first things first. Distinguish important from urgent. Schedule the big rocks (the things that matter) before the gravel of meetings, calls, and emails fills your week. Habits 4-6 govern how you work with others. Think win-win in every negotiation; the long-term relationship is more valuable than any single deal. Seek first to understand, then to be understood — most arguments dissolve the moment one side feels truly heard. Synergise — the right combination of complementary skills is more than the sum of its parts. Habit 7 is the most often skipped: sharpen the saw. You are the instrument all the others run on. Maintain your body, mind, heart, and spirit, or every other habit decays.'},
  {id:'whymatters',title:'Start with Why',author:'Simon Sinek',tag:'productivity',mins:11,grad:'linear-gradient(135deg,#0a0c0c 0%,#1f3030 50%,#10B981 100%)',
   why:'People don\\'t buy what you do. They buy why you do it.',
   insights:[['The Golden Circle','Most companies start with What. Great ones start with Why. The order changes everything.'],['Why earns trust','When you lead with belief, the right people follow. The wrong ones self-select out.'],['Why outlasts What','Products change. Your why doesn\\'t. Build your brand around the why and you survive every pivot.'],['Manipulation has a cost','Discounts, fear, peer pressure work short-term. They erode loyalty long-term.'],['Find your why','Look at the moments in your past when you felt fully alive. The pattern is your why.']],
   summary:'Simon Sinek\\'s thesis is structural. Every company can describe what they do. Most can describe how they do it. Very few know why. And the rare ones that do — Apple, the Wright brothers, Martin Luther King — communicate from the inside out. They start with the why. The Golden Circle is three concentric rings: why on the inside, how next, what on the outside. Most companies advertise from the outside in: here is the product, here are its features, please buy. Apple advertises from the inside out: we believe in challenging the status quo (why); we make beautifully designed, easy-to-use computers (how); want to buy one? (what). The first style is forgettable. The second creates devoted customers. The same is true for individuals and movements. People don\\'t follow leaders for what they say. They follow leaders for what they believe. Manipulation — discounts, fear, peer pressure, novelty — works in the short term but erodes loyalty over time. Inspiration earns the long game. Finding your why is not a marketing exercise. Look at the moments in your past when you felt fully alive, look at the through-line, and that is your why.'},
  {id:'rich',title:'Rich Dad Poor Dad',author:'Robert Kiyosaki',tag:'productivity',mins:12,grad:'linear-gradient(135deg,#0c0a06 0%,#3a2406 50%,#FCD34D 100%)',
   why:'Schools teach you to be a good employee. Almost no one teaches you to make money work for you.',
   insights:[['Assets vs liabilities','An asset puts money in your pocket. A liability takes it out. Most "wealth" is liability.'],['The rich don\\'t work for money','They work for assets that generate money while they sleep. Then they reinvest the cash flow.'],['Your house is not an asset','Until it produces rental income, it costs you. Be honest about that.'],['Pay yourself first','Save and invest before paying bills. You\\'ll find the money for the rest.'],['Mind your business','Your job is your income. Your business is your assets. Both matter. Build both.']],
   summary:'Kiyosaki uses the device of two fathers — his biological father, an educated employee who lived paycheck to paycheck, and the father of his best friend, a high-school dropout who became wealthy by buying assets. The book\\'s framework is brutally simple. An asset is something that puts money in your pocket. A liability is something that takes money out. Most middle-class wealth — the bigger house, the new car, the lifestyle upgrades — are liabilities dressed up as assets. The rich, in Kiyosaki\\'s telling, work for assets, not for money. They use the cash flow from those assets to acquire more assets, and gradually their portfolio of holdings produces enough income that they no longer need a job. The path requires financial literacy that schools don\\'t teach: how to read a balance sheet, what kinds of assets actually produce income, how to use leverage and tax law in your favour. Pay yourself first — save and invest before paying any bills — and you\\'ll discover, almost magically, that the money for everything else still appears. Mind your business: your job is your income, but your business is your asset column. Build both, but never confuse them.'},
  {id:'showups',title:'Show Up',author:'Daily ritual',tag:'productivity',mins:10,grad:'linear-gradient(135deg,#06121a 0%,#102045 50%,#A78BFA 100%)',
   why:'The simplest productivity rule that beats every system: show up, every day, for the smallest possible version.',
   insights:[['Two-minute rule','Make the bar so low you cannot fail. Two minutes of writing. One push-up. One page read.'],['Consistency beats intensity','Six days of two minutes beats one day of two hours. Always. Every time.'],['Track the chain','Mark today done. Don\\'t break the chain. The chain protects you from yourself on hard days.'],['Identity, not outcome','You are a writer, not someone trying to write a book. The identity carries you when motivation runs out.'],['Stop on a high','End your session while you still want to keep going. You\\'ll be eager to start tomorrow.']],
   summary:'This is the practical distillation of advice from a dozen books on habits, training, and creative work. The headline rule is showing up. Most people fail not because they aren\\'t talented or motivated — they fail because they show up irregularly. They go all-in for two weeks, miss three days, lose momentum, and quit. The fix is to make the bar absurdly low. Two minutes of writing. One push-up. One paragraph read. So low you cannot fail, even on your worst day. On most days you\\'ll do more — but on bad days, the two minutes is enough to keep the chain alive. Consistency beats intensity, always. Six days at low effort beats one day at peak effort, every time. Track the chain. Mark every day you showed up on a calendar. The visible streak becomes self-perpetuating. Adopt the identity, not the outcome. Don\\'t say "I\\'m trying to write a book" — say "I\\'m a writer". The identity carries you on the days motivation doesn\\'t. Finally: stop on a high. End the session while you still want to keep going. Tomorrow you\\'ll show up eager.'},
  {id:'soft',title:'Soft Skills',author:'Cal Newport (essay)',tag:'focus',mins:10,grad:'linear-gradient(135deg,#0a0a14 0%,#102140 50%,#3B82F6 100%)',
   why:'Following your passion is bad advice. Get good first — passion follows mastery.',
   insights:[['Passion is downstream of mastery','You don\\'t love things because they feel right. They feel right because you are good at them.'],['Career capital','Build rare and valuable skills. They become the currency you trade for autonomy and meaning.'],['Be so good they cannot ignore you','The Steve Martin advice. Skill speaks louder than self-promotion.'],['Mission needs traction','You can\\'t pick a mission from a blank page. Mission emerges from skill, not before it.'],['The craftsman mindset','Focus on what you produce, not how it makes you feel. Feeling follows production.']],
   summary:'Cal Newport\\'s long argument against the "follow your passion" gospel. Passion, he argues, is not how you find work you love. It is what happens after you become good at something. The reason most twenty-somethings hate their jobs is not that they picked the wrong career — it is that they are at the bottom of the skill ladder in every career, where the work is least autonomous and least meaningful. The fix is to stop asking "what should I do with my life" and start asking "what skills can I get rare-and-valuable at right now". Newport calls this career capital. The more rare and valuable your skills, the more leverage you have to negotiate for autonomy, mission, and money. The mantra he borrows from Steve Martin: be so good they cannot ignore you. Mission needs traction — you cannot pick a meaningful mission from a blank page. Mission emerges from accumulated expertise. Adopt the craftsman mindset: focus on what you produce, not how it makes you feel. Feeling follows production, not the other way around.'}
];
function openBookSummary(id){const b=BOOK_SUMMARIES.find(x=>x.id===id);if(!b)return;S.bookReader={open:true,book:b,playing:false,rate:1};render()}
function closeBookReader(){
  // If audio is currently playing, keep it going as a persistent mini-player at the bottom
  if(S.bookReader&&S.bookReader.playing&&S.bookReader.book){
    S.bkMini={book:S.bookReader.book,startedAt:S.bookReader.startedAt,rate:S.bookReader.rate,progress:S.bookReader.progress,usingEleven:S.bookReader.usingEleven};
    S.bookReader={open:false};
    render();
    return;
  }
  // Otherwise stop everything as before
  _premiumStop();
  if(window.speechSynthesis)try{speechSynthesis.cancel()}catch(e){}
  S.bookReader={open:false};render();
}
function bkMiniToggle(){
  if(!S.bkMini)return;
  // If audio is currently playing (window._narration active or speech synthesis), pause; else resume
  const isActive=!!(window._narration&&window._narration.audio&&!window._narration.audio.paused)||!!(window.speechSynthesis&&speechSynthesis.speaking&&!speechSynthesis.paused);
  if(isActive){
    if(window._narration&&window._narration.audio)try{window._narration.audio.pause()}catch(e){}
    if(window.speechSynthesis)try{speechSynthesis.pause()}catch(e){}
    S.bkMini.paused=true;
  } else {
    if(window._narration&&window._narration.audio)try{window._narration.audio.play()}catch(e){}
    if(window.speechSynthesis)try{speechSynthesis.resume()}catch(e){}
    S.bkMini.paused=false;
  }
  render();
}
function bkMiniClose(){_premiumStop();if(window.speechSynthesis)try{speechSynthesis.cancel()}catch(e){}S.bkMini=null;render()}
function bkMiniReopen(){if(!S.bkMini||!S.bkMini.book)return;S.bookReader={open:true,book:S.bkMini.book,playing:!S.bkMini.paused,rate:S.bkMini.rate,progress:S.bkMini.progress,startedAt:S.bkMini.startedAt,usingEleven:S.bkMini.usingEleven};S.bkMini=null;render()}
function _pickPremiumVoice(){
  if(!('speechSynthesis' in window))return null;
  const vs=speechSynthesis.getVoices();
  if(!vs||!vs.length)return null;
  // MALE voice priority — soft, warm, narrator-quality. User explicitly asked for a man's voice.
  const malePri=[
    /Microsoft\\s+(Brian|Andrew|Guy|Christopher|Eric|Davis|Jason)\\s+Online/i, // Microsoft Neural male
    /Daniel\\s+\\(Enhanced\\)/i, /Daniel\\s+\\(Premium\\)/i, /^Daniel$/i, // Apple Daniel (UK male, warm)
    /Alex\\s+\\(Enhanced\\)/i, /Alex\\s+\\(Premium\\)/i, /^Alex$/i,         // Apple Alex (US male, classic narrator)
    /Tom\\s+\\(Enhanced\\)/i, /^Tom$/i,
    /Aaron\\s+\\(Enhanced\\)/i, /^Aaron$/i,
    /Fred\\s+\\(Enhanced\\)/i, /^Fred$/i,
    /Oliver\\s+\\(Enhanced\\)/i, /^Oliver$/i,
    /Google\\s+UK\\s+English\\s+Male/i, // Chrome on desktop
    /Microsoft\\s+(David|Mark|George|James)\\s+/i, // Microsoft legacy male
  ];
  for(const re of malePri){const v=vs.find(x=>x.name&&re.test(x.name));if(v)return v}
  // Heuristic — anything with "male" in the name and English language
  const heur=vs.find(x=>x.lang&&x.lang.startsWith('en')&&/male/i.test(x.name||'')&&!/female/i.test(x.name||''));
  if(heur)return heur;
  // Last-resort fallback to any English voice
  return vs.find(x=>x.lang&&x.lang.startsWith('en'))||vs[0];
}
// Chunked TTS — splits long text into sentence groups so Chrome doesn't time out at ~15s
// Plus a keepalive pause/resume hack that fights the well-known Web Speech cutoff bug
function _ttsStop(){try{speechSynthesis.cancel()}catch(e){}if(window._ttsKeepalive){clearInterval(window._ttsKeepalive);window._ttsKeepalive=null}if(window._ttsQueue)window._ttsQueue.cancelled=true;window._ttsQueue=null}
// Premium narration — uses ElevenLabs (deep male studio voice) when configured server-side,
// gracefully falls back to chunked browser TTS otherwise. Now THE primary entry point for
// every TTS call across the app — _ttsSpeak is aliased to this below.
async function _premiumNarrate(text,opts,onAllDone,onProgress){
  _premiumStop();
  // Always re-fetch status on each call (cheap, ensures fresh state after env-var changes)
  try{const r=await fetch('/api/coach/status',{cache:'no-store'});const j=await r.json();if(!S.coach)S.coach={};S.coach.status=j}catch(e){console.warn('[narr] status check failed',e)}
  const useEleven=!!(S.coach&&S.coach.status&&S.coach.status.tts);
  console.log('[narr] tts available:',useEleven,'status:',S.coach&&S.coach.status);
  if(!useEleven){console.log('[narr] falling back to browser TTS — set ELEVENLABS_API_KEY');return _browserTtsSpeak(text,opts,onAllDone,onProgress)}
  // Chunk small for fast first-byte — first chunk ~300 chars (~3-5s to first audio)
  // After that, larger chunks (~1500 chars) for fewer round trips during playback
  const sentences=(text.match(/[^.!?\\u2026]+[.!?\\u2026]+["\\u2019\\u201d)]?\\s*/g))||[text];
  const chunks=[];let cur='';let firstChunkSize=300;
  for(const s of sentences){
    const limit=chunks.length===0?firstChunkSize:1500;
    if((cur+s).length>limit){if(cur)chunks.push(cur.trim());cur=s}
    else cur+=s;
  }
  if(cur.trim())chunks.push(cur.trim());
  if(!chunks.length)return false;
  const queue={chunks,idx:0,audio:null,cancelled:false};
  window._narration=queue;
  async function playNext(){
    if(queue.cancelled)return;
    if(queue.idx>=queue.chunks.length){if(typeof onAllDone==='function')onAllDone();return}
    if(typeof onProgress==='function')try{onProgress(queue.idx,queue.chunks.length,queue.chunks[queue.idx])}catch(e){}
    try{
      const r=await fetch('/api/coach/speak',{method:'POST',headers:{'Content-Type':'application/json','x-token':token},body:JSON.stringify({text:queue.chunks[queue.idx]})});
      console.log('[narr] /api/coach/speak chunk',queue.idx+1,'/',queue.chunks.length,'status:',r.status);
      if(queue.cancelled)return;
      if(!r.ok){
        let errBody='';try{errBody=await r.text();}catch(e){}
        console.warn('[narr] ElevenLabs request failed:',r.status,errBody);
        if(queue.idx===0&&typeof toast==='function')toast('\\u26A0\\uFE0F Studio voice failed: '+r.status+' — using browser fallback','err');
        const rem=queue.chunks.slice(queue.idx).join(' ');
        return _browserTtsSpeak(rem,opts,onAllDone,function(i,t,l){if(typeof onProgress==='function')try{onProgress(queue.idx+i,queue.chunks.length,l)}catch(e){}});
      }
      if(queue.idx===0&&typeof toast==='function')toast('\\u{1F3AC} Studio voice loaded','ok');
      const blob=await r.blob();
      console.log('[narr] chunk',queue.idx+1,'received blob size:',blob.size,'type:',blob.type);
      if(queue.cancelled)return;
      const url=URL.createObjectURL(blob);
      // Use a persistent in-DOM audio element — survives async transitions, browsers respect it more
      let a=document.getElementById('bk-narr-audio');
      if(!a){a=document.createElement('audio');a.id='bk-narr-audio';a.preload='auto';a.controls=false;document.body.appendChild(a)}
      a.src=url;
      a.volume=1.0;
      a.muted=false;
      queue.audio=a;
      a.playbackRate=Math.max(0.5,Math.min(2.0,(opts&&opts.rate)||1.0));
      a.onended=function(){console.log('[narr] chunk',queue.idx+1,'ended');URL.revokeObjectURL(url);queue.idx++;playNext()};
      a.onerror=function(){console.warn('[narr] chunk',queue.idx+1,'audio error',a.error);URL.revokeObjectURL(url);queue.idx++;playNext()};
      a.oncanplay=function(){console.log('[narr] chunk',queue.idx+1,'canplay (duration:',a.duration,')')};
      a.onplay=function(){console.log('[narr] chunk',queue.idx+1,'play started')};
      console.log('[narr] calling audio.play() for chunk',queue.idx+1);
      const p=a.play();
      if(p&&p.then){
        p.then(function(){console.log('[narr] chunk',queue.idx+1,'play() resolved')});
        p.catch(function(err){
          console.warn('[narr] chunk',queue.idx+1,'play() rejected:',err&&err.message);
          if(queue.idx===0&&typeof toast==='function')toast('\\u26A0\\uFE0F Browser blocked autoplay \\u2014 using browser TTS','err');
          URL.revokeObjectURL(url);
          if(queue.cancelled)return;
          const rem=queue.chunks.slice(queue.idx).join(' ');
          _browserTtsSpeak(rem,opts,onAllDone,function(i,t,l){if(typeof onProgress==='function')try{onProgress(queue.idx+i,queue.chunks.length,l)}catch(e){}});
        });
      }
    }catch(e){if(queue.cancelled)return;queue.idx++;playNext()}
  }
  playNext();
  return true;
}
function _premiumStop(){_ttsStop();if(window._narration){window._narration.cancelled=true;if(window._narration.audio){try{window._narration.audio.pause();window._narration.audio.src=''}catch(e){}}window._narration=null}}
// _ttsSpeak is the public entry point for every TTS call across the app.
// Routes through _premiumNarrate so callers automatically get ElevenLabs when configured,
// and the chunked browser-TTS fallback when not. Old code that called _ttsSpeak still works
// (Voice trainer drills, game celebrations, vocabulary cards, lesson runner, etc.) and now
// gets studio voice for free.
function _ttsSpeak(text,opts,onAllDone,onProgress){return _premiumNarrate(text,opts,onAllDone,onProgress)}
// Browser-only chunked TTS — used as fallback inside _premiumNarrate when ElevenLabs is unavailable.
// All public callers should use _ttsSpeak (the dispatcher alias defined below) so they get the
// premium voice automatically when configured.
function _browserTtsSpeak(text,opts,onAllDone,onProgress){
  if(!('speechSynthesis' in window))return false;
  _ttsStop();
  const sentences=(text.match(/[^.!?\\u2026]+[.!?\\u2026]+["\\u2019\\u201d)]?\\s*/g))||[text];
  const chunks=[];let cur='';
  for(const s of sentences){
    if((cur+s).length>180){if(cur)chunks.push(cur.trim());cur=s}
    else cur+=s;
  }
  if(cur.trim())chunks.push(cur.trim());
  if(!chunks.length)return false;
  const queue={chunks,idx:0,opts:opts||{},onAllDone,onProgress,cancelled:false};
  window._ttsQueue=queue;
  function speakNext(){
    if(queue.cancelled)return;
    if(queue.idx>=queue.chunks.length){
      if(window._ttsKeepalive){clearInterval(window._ttsKeepalive);window._ttsKeepalive=null}
      if(typeof onAllDone==='function')onAllDone();
      return;
    }
    if(typeof onProgress==='function')try{onProgress(queue.idx,queue.chunks.length,queue.chunks[queue.idx])}catch(e){}
    const u=new SpeechSynthesisUtterance(queue.chunks[queue.idx]);
    u.rate=queue.opts.rate||1;u.pitch=queue.opts.pitch||1.0;u.volume=queue.opts.volume||1.0;
    const v=_pickPremiumVoice();if(v){u.voice=v;u.lang=v.lang||'en-US'}
    u.onend=function(){queue.idx++;speakNext()};
    u.onerror=function(){queue.idx++;speakNext()};
    try{speechSynthesis.speak(u)}catch(e){queue.idx++;speakNext()}
  }
  if(window._ttsKeepalive)clearInterval(window._ttsKeepalive);
  window._ttsKeepalive=setInterval(function(){try{if(speechSynthesis.speaking&&!speechSynthesis.paused){speechSynthesis.pause();speechSynthesis.resume()}}catch(e){}},10000);
  speakNext();
  return true;
}
// Structured narration — assembles a full ~12-15 min audio experience from the book's parts:
// title, why-pitch, each numbered insight, then the long summary. Slow male narrator pace.
function _bookFullNarration(book){
  const parts=[];
  parts.push(book.title+', by '+book.author+'.');
  parts.push(book.why);
  parts.push('Five key insights to take with you.');
  book.insights.forEach((it,i)=>{
    parts.push('Insight '+(i+1)+'. '+it[0]+'.');
    parts.push(it[1]);
  });
  parts.push('Now, the full fifteen-minute summary.');
  parts.push(book.summary);
  parts.push('Beautiful. That is another summary completed. One more step on your daily streak.');
  // Strip HTML entities the data uses (e.g. \\u2014 em-dash) and normalise quotes so TTS reads cleanly
  return parts.join('  ').replace(/\\\\u2019/g,"'").replace(/\\\\u2014/g,', ').replace(/\\u2026/g,'...');
}
function bookReaderToggleTTS(){
  const r=S.bookReader;if(!r||!r.book)return;
  if(r.playing){_premiumStop();r.playing=false;render();return}
  const baseRate=r.rate||(S.coach&&S.coach.status&&S.coach.status.tts?1.0:0.78);
  const fullText=_bookFullNarration(r.book);
  r.startedAt=Date.now();r.progress={idx:0,total:0,line:'Loading studio voice...'};
  r.usingEleven=!!(S.coach&&S.coach.status&&S.coach.status.tts);
  const ok=_premiumNarrate(fullText,{rate:baseRate,pitch:0.95,volume:1.0},
    function(){
      const cur=S.bookReader;if(!cur||!cur.book)return;
      cur.playing=false;cur.completed=true;cur.progress=null;render();
      try{api('/book-streak',{method:'POST',body:JSON.stringify({seconds:r.book.mins*60})}).then(()=>loadBookStreak())}catch(e){}
      toast('\\u2728 Summary complete \\u2014 streak +1');
    },
    function(idx,total,line){
      const cur=S.bookReader;if(!cur||!cur.book)return;
      cur.progress={idx,total,line};
      const bar=document.getElementById('bkProgFill');
      const txt=document.getElementById('bkProgText');
      const pct=document.getElementById('bkProgPct');
      const t=document.getElementById('bkProgTime');
      if(bar)bar.style.transform='scaleX('+(idx/total)+')';
      if(txt)txt.textContent=String(line||'').slice(0,90)+(String(line||'').length>90?'...':'');
      if(pct)pct.textContent=Math.round((idx/total)*100)+'%';
      if(t){const elapsed=Math.floor((Date.now()-(cur.startedAt||Date.now()))/1000);t.textContent=Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0')}
    }
  );
  if(ok!==false){r.playing=true;render()}
}
function bookReaderSpeed(){const r=S.bookReader;if(!r)return;const cycle={0.78:0.95,0.95:1.1,1.1:1.25,1.25:1.5,1.5:0.78};const cur=r.rate||0.78;r.rate=cycle[cur]||0.78;if(r.playing){_ttsStop();r.playing=false;bookReaderToggleTTS()}render()}

// ═══ VOICE TUTOR — daily lessons + vocabulary ═══
const VOICE_LESSONS=[
  {day:'Sun',k:'review',e:'\\u{1F4DD}',title:'Reflection &amp; review',desc:'Look back at the week. What new word stuck? Which conversation felt easier than last week? Tell the coach in three sentences.',prompt:'Walk me through one moment this week where you used English well. What worked? What would you change?'},
  {day:'Mon',k:'vocab',e:'\\u{1F4DA}',title:'Vocabulary builder',desc:'Three new advanced words for the working week. Read the definitions, hear them spoken, then use each in your own sentence.',prompt:'Use the words "mitigate", "pivot", and "synergy" in three different professional sentences \\u2014 one for each.'},
  {day:'Tue',k:'phrases',e:'\\u{1F4AC}',title:'Confident phrases',desc:'Five power phrases for meetings. Replace weak hedging with crisp business English that lands.',prompt:'Teach me five professional phrases I can use to push back politely in a meeting. Give an example for each.'},
  {day:'Wed',k:'pronounce',e:'\\u{1F399}\\uFE0F',title:'Pronunciation drill',desc:'Say a tricky phrase, get instant feedback. Today: tongue twisters and the difference between "v" and "w".',prompt:'Help me practise saying "I really value the work we did" \\u2014 listen and tell me how my pronunciation lands.'},
  {day:'Thu',k:'idioms',e:'\\u{1F3AD}',title:'Idioms &amp; expressions',desc:'Idioms make you sound native. Three new ones today, with the story behind each and a real-world example.',prompt:'Teach me three idioms that English speakers actually use in business \\u2014 with the meaning and a short story for each.'},
  {day:'Fri',k:'negotiate',e:'\\u{1F91D}',title:'Negotiation language',desc:'How to make an ask, hold ground, and find common footing. The exact phrases that move a deal forward.',prompt:'Roleplay a salary negotiation with me. You are the manager, I am asking for a raise. Coach me as we go.'},
  {day:'Sat',k:'story',e:'\\u{1F4D6}',title:'Storytelling skills',desc:'A great story sells anything. Today: the three-beat structure that hooks, holds, and lands.',prompt:'Help me tell the story of how I joined my current company \\u2014 in 90 seconds, with a clear hook and ending.'},
];
const VOICE_VOCAB=[
  // Set 0 (week 1)
  {w:'Mitigate',pos:'verb',def:'To make something less severe or harmful.',ex:'We mitigated the risk by adding a second supplier.'},
  {w:'Pivot',pos:'verb',def:'To change strategy fundamentally while keeping the team and product.',ex:'After the user research, we pivoted from B2C to B2B.'},
  {w:'Synergy',pos:'noun',def:'The combined effect of two things being greater than their sum.',ex:'There is real synergy between the design and engineering teams.'},
  // Set 1 (week 2)
  {w:'Iterate',pos:'verb',def:'To improve something through repeated cycles of refinement.',ex:'We iterated on the prototype five times before shipping.'},
  {w:'Catalyze',pos:'verb',def:'To cause or accelerate a reaction or change.',ex:'Her speech catalyzed a wave of fresh investment.'},
  {w:'Resonate',pos:'verb',def:'To strike a chord with someone — to feel deeply right.',ex:'The new mission statement really resonated with the team.'},
  // Set 2 (week 3)
  {w:'Articulate',pos:'verb / adj',def:'To express clearly; or someone who speaks fluently and clearly.',ex:'She articulated the strategy in three sentences.'},
  {w:'Pragmatic',pos:'adj',def:'Practical, focused on what works rather than what is ideal.',ex:'He took a pragmatic approach to the budget cuts.'},
  {w:'Holistic',pos:'adj',def:'Considering the whole, not just isolated parts.',ex:'We need a holistic view of customer experience.'},
  // Set 3 (week 4)
  {w:'Empirical',pos:'adj',def:'Based on observation or data, not theory.',ex:'The decision was empirical \\u2014 the numbers told us so.'},
  {w:'Imperative',pos:'noun / adj',def:'Of vital importance; or an essential duty.',ex:'Speed is the imperative this quarter.'},
  {w:'Methodical',pos:'adj',def:'Done in a systematic, orderly way.',ex:'His methodical approach caught three bugs we missed.'},
  // Set 4 (week 5)
  {w:'Nuanced',pos:'adj',def:'Subtle, with fine distinctions worth noticing.',ex:'Her feedback was nuanced \\u2014 not just yes or no.'},
  {w:'Plausible',pos:'adj',def:'Believable, reasonable as a possibility.',ex:'It is plausible that we hit the target by Q3.'},
  {w:'Rigorous',pos:'adj',def:'Extremely thorough, careful, and precise.',ex:'The research was rigorous and well documented.'},
  // Set 5 (week 6)
  {w:'Decisive',pos:'adj',def:'Settling an issue quickly and effectively.',ex:'Her decisive call kept the project on track.'},
  {w:'Quintessential',pos:'adj',def:'Representing the most perfect example of a quality or class.',ex:'He is the quintessential founder \\u2014 fast, kind, relentless.'},
  {w:'Orchestrate',pos:'verb',def:'To arrange or direct elements to achieve a desired effect.',ex:'She orchestrated the launch across six time zones.'},
  // Set 6 (week 7)
  {w:'Strategic',pos:'adj',def:'Carefully aimed at a long-term goal.',ex:'A strategic hire shapes the next two years.'},
  {w:'Tactical',pos:'adj',def:'Aimed at a short-term, specific outcome.',ex:'That was a tactical move, not a strategy shift.'},
  {w:'Diligent',pos:'adj',def:'Showing careful, persistent effort.',ex:'She was diligent in following up after every meeting.'},
];
function _voiceLessonOfDay(){const d=new Date();return VOICE_LESSONS[d.getDay()]}
function _voiceVocabOfDay(){const d=new Date();const yStart=new Date(d.getFullYear(),0,0);const day=Math.floor((d-yStart)/86400000);const setIdx=day%7;const start=setIdx*3;return VOICE_VOCAB.slice(start,start+3)}
function voiceStartLesson(){const l=_voiceLessonOfDay();if(typeof coachSend==='function'){try{coachSend(l.prompt)}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err')}}}
function voiceSpeakWord(w){_ttsSpeak(w,{rate:.82,pitch:1.0,volume:1.0})}
function voiceCelebrateStreak(){if(!('speechSynthesis' in window))return;_ttsSpeak('Lovely work. Your daily streak is alive.',{rate:.92,pitch:1.0,volume:1.0})}

// Pronunciation drill — daily phrase rotation + record-and-score with Web Speech Recognition
const VOICE_PRON_PHRASES=[
  'I really value the work we did together.',
  'Could we circle back on that next week?',
  'Let me think about it and get back to you.',
  'I appreciate the thoughtful feedback.',
  'That is a great question — let me find out.',
  'I am happy to clarify if anything is unclear.',
  'We are aligned on the next steps.',
  'I would like to suggest a slightly different approach.',
  'Thank you for making the time today.',
  'I hear what you are saying and I see the trade-off.',
  'Let us focus on what is most important right now.',
  'I want to make sure I understood you correctly.',
  'Could you walk me through that one more time?',
  'I think we are very close to a solution.',
];
function _voicePronOfDay(){const d=new Date();const yStart=new Date(d.getFullYear(),0,0);const day=Math.floor((d-yStart)/86400000);return VOICE_PRON_PHRASES[day%VOICE_PRON_PHRASES.length]}
function voicePronListen(){const p=_voicePronOfDay();_ttsSpeak(p,{rate:.92,pitch:1.0,volume:1.0})}

// ═══ VOICE CURRICULUM — Duolingo-style learning path ═══
const VOICE_CURRICULUM=[
  {id:1,name:'Foundations',color:'#FF6B47',e:'\\u{1F331}',desc:'Build the basics. Greetings, introductions, simple talk.',lessons:[
    {id:1,name:'Hello & introductions',drills:['Hi, I am happy to meet you.','My name is Alex. What is your name?','Where are you from? I am from India.','It is a pleasure to meet you today.','How is your day going so far?']},
    {id:2,name:'Asking simple questions',drills:['Could you tell me what time it is?','How long have you been working here?','What do you do for a living?','Do you have a moment to chat?','Where can I find a good coffee shop?']},
    {id:3,name:'Numbers, days, time',drills:['I will see you on Monday at three.','We have twenty-four hours to finish this.','The meeting starts at half past nine.','I have been here for about six months.','My birthday is on the fifteenth of June.']},
  ]},
  {id:2,name:'Daily Conversation',color:'#F59E0B',e:'\\u{2615}',desc:'Real-life chat. Food, travel, weekends.',lessons:[
    {id:1,name:'Talking about your day',drills:['I had a productive morning at work.','I went for a long walk after lunch.','I spent the evening reading a good book.','It was a busy day but a good one.','I am planning to take it easy tomorrow.']},
    {id:2,name:'Food & ordering',drills:['I would like the chicken curry, please.','Could we have the bill when you are ready?','Is this dish very spicy?','Could I get water without ice, please?','That was absolutely delicious, thank you.']},
    {id:3,name:'Travel & directions',drills:['Excuse me, how do I get to the museum?','Is there a train station nearby?','Could you help me find the right platform?','How long does it take to get there?','Thank you so much for your help.']},
  ]},
  {id:3,name:'At Work',color:'#10B981',e:'\\u{1F4BC}',desc:'Office English. Meetings, email, team talk.',lessons:[
    {id:1,name:'Office vocabulary',drills:['Could you forward me that report?','I will block off some time on my calendar.','Let us circle back on this next week.','We need to align on the priorities.','I will keep you in the loop on this.']},
    {id:2,name:'Meeting language',drills:['I would like to start by saying thank you.','Let us go around the room and share updates.','That is a great question, let me think.','I want to push back on that idea, gently.','Let us park that and come back to it.']},
    {id:3,name:'Writing emails',drills:['I hope you are doing well today.','Just a quick follow-up on our chat yesterday.','Could you let me know your thoughts when you have a moment?','I really appreciate your help with this.','Looking forward to hearing from you soon.']},
  ]},
  {id:4,name:'Confident Communication',color:'#0EA5E9',e:'\\u{1F4AC}',desc:'Sound clear, sound certain. Replace hedging with crisp English.',lessons:[
    {id:1,name:'Active listening',drills:['I want to make sure I understood you correctly.','So what you are saying is, the timeline is the issue.','Let me reflect that back, just to be clear.','That is really helpful context, thank you.','Could you walk me through that one more time?']},
    {id:2,name:'Disagreeing politely',drills:['I see your point, but I see it slightly differently.','I want to push back on that, just a little.','Have we considered the other side of this?','I respectfully disagree, and here is why.','I think we are looking at this from different angles.']},
    {id:3,name:'Asking better questions',drills:['What is the goal we are really trying to hit?','Who decides if this is successful?','What does winning look like here?','What is the one thing we cannot get wrong?','If we had to cut something, what would go first?']},
  ]},
  {id:5,name:'Business English',color:'#A855F7',e:'\\u{1F4C8}',desc:'Pitching, negotiating, presenting. Big-stakes language.',lessons:[
    {id:1,name:'Pitching ideas',drills:['Here is the problem we are solving.','What if we approached it from a different angle?','The key insight is hidden in the data.','Imagine a world where this works perfectly.','I would love your honest reaction to this.']},
    {id:2,name:'Negotiation',drills:['I appreciate the offer, and I have a counter to discuss.','Could we meet somewhere in the middle?','What is the most flexible part of this for you?','I want this to work for both of us.','Let us focus on what each side really needs.']},
    {id:3,name:'Presentations',drills:['Today, I want to share three big ideas with you.','Let me start with a story that landed for me.','The number to remember from this slide is two.','I want to leave you with one question to sit with.','Thank you for your time, I am happy to take questions.']},
  ]},
  {id:6,name:'Pronunciation Mastery',color:'#EC4899',e:'\\u{1F399}\\uFE0F',desc:'Sharper sounds, clearer speech. Tongue twisters and stress patterns.',lessons:[
    {id:1,name:'Vowel sounds',drills:['The cat sat on the mat under the hat.','She sees the sea by the seashore today.','Tom walked along the long lawn at dawn.','I think the pink ink is in the sink.','The blue moon shone over the smooth lagoon.']},
    {id:2,name:'Tricky consonants',drills:['She sells seashells by the seashore.','Three thin thieves thought a thousand thoughts.','Red lorry, yellow lorry, red lorry, yellow lorry.','Peter Piper picked a peck of pickled peppers.','How can a clam cram in a clean cream can?']},
    {id:3,name:'Word stress',drills:['I will record the meeting for the record.','We need to present a present to the team.','The desert is no place to desert your friends.','I object to that object on principle.','The minute hand is moving in a minute way.']},
  ]},
  {id:7,name:'Idioms & Expressions',color:'#FCD34D',e:'\\u{1F3AD}',desc:'Native-level phrases. Sound like someone who lives in the language.',lessons:[
    {id:1,name:'Common idioms',drills:['It is a piece of cake, do not worry.','Let us not beat around the bush, time matters.','I am all ears, please tell me everything.','That decision really hit the nail on the head.','We need to bite the bullet and start tomorrow.']},
    {id:2,name:'Business idioms',drills:['That client is a real game changer for us.','We are going to have to think outside the box.','Let us cut to the chase and get to the offer.','The ball is in your court now, take your time.','We are on the same page about the next steps.']},
    {id:3,name:'Cultural references',drills:['It is a marathon, not a sprint, remember that.','We need to read the room before we push harder.','That is the elephant in the room nobody mentions.','At the end of the day, the work speaks for itself.','When push comes to shove, we do the right thing.']},
  ]},
  {id:8,name:'Mastery',color:'#1A1A1A',e:'\\u{1F3C6}',desc:'Native-level fluency. Tell stories. Lead conversations. Hold the room.',lessons:[
    {id:1,name:'Storytelling',drills:['Let me take you back to a Tuesday afternoon last spring.','At first it seemed like just another quiet meeting.','Then everything changed in a single sentence.','Looking back, that was the moment that made the project.','And that is why I always start with the customer.']},
    {id:2,name:'Holding the room',drills:['Let us pause here for one moment, this is important.','I want to make sure everyone is with me on this.','Take a breath, and look at the data on this slide.','I know this is a lot, so let us go slowly.','If you remember one thing today, remember this.']},
    {id:3,name:'Final test',drills:['I want to thank everyone who showed up for this.','We did not get here by accident, we got here by design.','The next chapter is going to ask more of all of us.','I trust this team more than any I have worked with.','Let us go and make something we are proud of.']},
  ]},
];

function voiceLessonOpen(unitId,lessonId){
  const unit=VOICE_CURRICULUM.find(u=>u.id===unitId);if(!unit)return;
  const lesson=unit.lessons.find(l=>l.id===lessonId);if(!lesson)return;
  // Check unlock — first lesson of unit 1 always unlocked; otherwise previous lesson must be completed
  const prog=(S.voiceCurriculum&&S.voiceCurriculum.progress)||{};
  const unlocked=_voiceIsLessonUnlocked(unitId,lessonId,prog);
  if(!unlocked){toast('\\u{1F512} Complete the previous lesson to unlock this one','err');return}
  S.voiceLesson={unit,lesson,idx:0,scores:[],heard:'',recording:false,phase:'intro',startedAt:Date.now()};
  render();
  setTimeout(()=>{
    _ttsSpeak('Lesson '+lesson.id+'. '+lesson.name+'. We have five phrases to practise. Listen, then speak. Take your time.',{rate:.92,pitch:1.0,volume:1.0});
  },300);
}
function _voiceIsLessonUnlocked(unitId,lessonId,prog){
  if(unitId===1&&lessonId===1)return true;
  // Must have completed (lessonId-1) of same unit, OR last lesson of (unitId-1) if lessonId===1
  if(lessonId>1)return !!prog[unitId+':'+(lessonId-1)];
  // First lesson of a unit > 1 — need last lesson of previous unit
  const prev=VOICE_CURRICULUM.find(u=>u.id===unitId-1);
  if(!prev)return false;
  return !!prog[prev.id+':'+prev.lessons[prev.lessons.length-1].id];
}
function voiceLessonClose(){_ttsStop();if(S._voiceLessonRec){try{S._voiceLessonRec.stop()}catch(e){}S._voiceLessonRec=null}S.voiceLesson=null;render()}
function voiceLessonListen(){const p=S.voiceLesson;if(!p||!p.lesson)return;const phrase=p.lesson.drills[p.idx];_ttsSpeak(phrase,{rate:.85,pitch:1.0,volume:1.0})}
function voiceLessonRecord(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('\\u26A0\\uFE0F Speech recognition not supported','err');return}
  const p=S.voiceLesson;if(!p||!p.lesson)return;
  if(S._voiceLessonRec){try{S._voiceLessonRec.stop()}catch(e){}S._voiceLessonRec=null;p.recording=false;render();return}
  const r=new SR();r.continuous=false;r.interimResults=false;r.lang='en-US';
  p.recording=true;p.heard='';render();
  r.onresult=function(e){
    let h='';for(let i=0;i<e.results.length;i++)h+=e.results[i][0].transcript;
    const target=p.lesson.drills[p.idx];
    const sc=_scorePronunciation(target,h);
    p.heard=h;p.lastScore=sc;p.scores[p.idx]=sc.pct;p.recording=false;
    if(sc.pct>=80)_ttsSpeak('Excellent.',{rate:.95,pitch:1.0});
    else if(sc.pct>=50)_ttsSpeak('Close. Try once more.',{rate:.95,pitch:1.0});
    else _ttsSpeak('Listen again, then speak it back.',{rate:.95,pitch:1.0});
    render();
  };
  r.onerror=function(){S._voiceLessonRec=null;p.recording=false;toast('\\u26A0\\uFE0F Mic error','err');render()};
  r.onend=function(){S._voiceLessonRec=null;if(p.recording){p.recording=false;render()}};
  try{r.start();S._voiceLessonRec=r}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S._voiceLessonRec=null;p.recording=false;render()}
}
function voiceLessonNext(){
  const p=S.voiceLesson;if(!p||!p.lesson)return;
  if(p.idx<p.lesson.drills.length-1){p.idx++;p.heard='';p.lastScore=null;render();setTimeout(voiceLessonListen,400);return}
  // Lesson complete
  const avg=p.scores.length?Math.round(p.scores.reduce((a,b)=>a+b,0)/p.scores.length):0;
  p.phase='done';p.finalScore=avg;render();
  // Save progress
  api('/voice/lesson-complete',{method:'POST',body:JSON.stringify({unit_id:p.unit.id,lesson_id:p.lesson.id,score:avg})}).then(r=>{
    if(r&&r.ok){
      if(!S.voiceCurriculum)S.voiceCurriculum={progress:{},totalXp:0};
      S.voiceCurriculum.progress[p.unit.id+':'+p.lesson.id]={score:avg,stars:r.stars,xp:r.xp};
      S.voiceCurriculum.totalXp=r.totalXp;
      const stars=r.stars;
      const phrase=stars===3?'Three stars. Beautiful work.':stars===2?'Two stars. Strong effort.':stars===1?'One star. Keep going.':'Try the lesson again to unlock the next.';
      _ttsSpeak('Lesson complete. '+phrase,{rate:.92,pitch:1.0});
      render();
    }
  }).catch(()=>{});
}
async function voiceCurriculumLoad(){
  const r=await api('/voice/lessons');
  if(r){S.voiceCurriculum={progress:r.progress||{},totalXp:r.totalXp||0,totalStars:r.totalStars||0,completed:r.completed||0};render()}
}

// ═══ COMMUNITY ARTICLES — Medium-style ═══
async function loadArticles(cat){
  S.articlesLoading=true;S.articlesCat=cat||'all';render();
  try{const r=await fetch('/api/articles?cat='+encodeURIComponent(S.articlesCat)+'&sort='+(S.articlesSort||'recent'));const j=await r.json();S.articles=j.items||[]}catch(e){S.articles=[]}
  S.articlesLoading=false;render();
}
function openArticleEditor(){
  S.articleEditor={open:true,id:null,title:'',body:'',image_url:'',category:'general',saving:false};
  render();
}
function closeArticleEditor(){S.articleEditor=null;render()}
async function saveArticle(){
  const e=S.articleEditor;if(!e)return;
  if(!e.title.trim()){toast('\\u26A0\\uFE0F Add a title','err');return}
  if(e.body.trim().length<50){toast('\\u26A0\\uFE0F Body needs at least 50 characters','err');return}
  e.saving=true;render();
  const r=await api('/articles',{method:'POST',body:JSON.stringify({title:e.title.trim(),body:e.body.trim(),image_url:e.image_url.trim(),category:e.category})});
  if(r&&r.ok){toast('\\u2728 Article published');S.articleEditor=null;loadArticles(S.articlesCat||'all')}
  else{e.saving=false;toast('\\u26A0\\uFE0F '+(r&&r.error||'Failed to publish'),'err');render()}
}
async function openArticleReader(id){
  S.articleReader={loading:true,id};render();
  try{const r=await fetch('/api/articles/'+encodeURIComponent(id));const j=await r.json();if(j.error){toast('\\u26A0\\uFE0F '+j.error,'err');S.articleReader=null;render();return}S.articleReader={article:j,loading:false}}
  catch(e){S.articleReader=null;toast('\\u26A0\\uFE0F Failed to load','err')}
  render();
}
function closeArticleReader(){S.articleReader=null;render()}
async function likeArticle(id){
  const r=await api('/articles/'+encodeURIComponent(id)+'/like',{method:'POST'});
  if(r&&r.ok){
    if(S.articles){const a=S.articles.find(x=>x.id===id);if(a)a.likes=r.likes}
    if(S.articleReader&&S.articleReader.article&&S.articleReader.article.id===id){S.articleReader.article.likes=r.likes;S.articleReader.liked=r.liked}
    render();
  }
}
function _normaliseForMatch(s){return String(s||'').toLowerCase().replace(/[^a-z0-9\\s]/g,'').replace(/\\s+/g,' ').trim()}
function _scorePronunciation(target,heard){
  const t=_normaliseForMatch(target).split(' ').filter(Boolean);
  const h=_normaliseForMatch(heard).split(' ').filter(Boolean);
  if(!t.length)return{pct:0,matched:0,total:0,missed:[]};
  const hSet=new Set(h);let matched=0;const missed=[];
  for(const w of t){if(hSet.has(w))matched++;else missed.push(w)}
  return{pct:Math.round((matched/t.length)*100),matched,total:t.length,missed,heard};
}
function voicePronRecord(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('\\u26A0\\uFE0F Speech recognition not supported on this device','err');return}
  if(S._pronRec){try{S._pronRec.stop()}catch(e){}S._pronRec=null;S.pron={...(S.pron||{}),recording:false};render();return}
  const r=new SR();r.continuous=false;r.interimResults=false;r.lang='en-US';
  S.pron={...(S.pron||{}),recording:true,heard:'',result:null};render();
  r.onresult=function(e){
    let h='';for(let i=0;i<e.results.length;i++)h+=e.results[i][0].transcript;
    const target=_voicePronOfDay();
    const score=_scorePronunciation(target,h);
    S.pron={recording:false,heard:h,result:score};
    if(score.pct>=80)_ttsSpeak('Beautiful pronunciation. You nailed it.',{rate:.92,pitch:1.0,volume:1.0});
    else if(score.pct>=50)_ttsSpeak('Good attempt. Try once more, slow and clear.',{rate:.92,pitch:1.0,volume:1.0});
    else _ttsSpeak('Listen to the phrase one more time, then say it back.',{rate:.92,pitch:1.0,volume:1.0});
    render();
  };
  r.onerror=function(){S._pronRec=null;S.pron={...(S.pron||{}),recording:false};toast('\\u26A0\\uFE0F Microphone error \\u2014 check permissions','err');render()};
  r.onend=function(){S._pronRec=null;if(S.pron&&S.pron.recording){S.pron.recording=false;render()}};
  try{r.start();S._pronRec=r}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S._pronRec=null;S.pron={...(S.pron||{}),recording:false};render()}
}
function closePlayer(){stopBookListenTimer();S.playing=null;S.meditating={active:false,title:'',mins:0,startedAt:0};render()}
function closeMeditation(){const a=document.getElementById('audioEl');if(a){try{a.pause()}catch(e){}}closePlayer()}
let _bkTimer=null;
function startBookListenTimer(){if(_bkTimer)return;S._bkSec=0;_bkTimer=setInterval(async()=>{const a=document.getElementById('audioEl');if(!a||a.paused||a.ended)return;S._bkSec+=5;if(S._bkSec===120&&S.user&&!S.bookStreak.today){const r=await api('/book-streak',{method:'POST',body:JSON.stringify({date:new Date().toISOString().slice(0,10),seconds:120})});if(r?.ok){S.bookStreak={streak:r.streak,total:r.total,today:true,days:S.bookStreak.days};toast('\\u{1F389} '+r.streak+'-day listening streak!');render()}}},5000)}
function stopBookListenTimer(){if(_bkTimer){clearInterval(_bkTimer);_bkTimer=null}}
async function loadBookStreak(){if(!S.user)return;const r=await api('/book-streak');if(r)S.bookStreak={streak:r.streak||0,total:r.total||0,today:!!r.today,days:r.days||[]}}

function render(){
// While the canvas-based Memory Tap is running, suspend full re-renders so the canvas state
// (game loop, animations) is preserved.
if(S._mtActive&&S.mgPlay&&S.mgPlay.canvasGame==='mt'&&document.getElementById('mtCanvas'))return;
// Preserve focus + cursor across re-renders so typing isn't interrupted
const _fs=(function(){try{const a=document.activeElement;if(!a||(a.tagName!=='INPUT'&&a.tagName!=='TEXTAREA'))return null;return{id:a.id,name:a.name,type:a.type,placeholder:a.placeholder,start:a.selectionStart,end:a.selectionEnd}}catch(e){return null}})();
const _restore=function(){if(!_fs)return;try{let el=null;if(_fs.id)el=document.getElementById(_fs.id);if(!el){const inputs=document.querySelectorAll('input,textarea');for(const i of inputs){if((_fs.placeholder&&i.placeholder===_fs.placeholder)||(_fs.name&&i.name===_fs.name)){el=i;break}}}if(el){try{el.focus({preventScroll:true})}catch(e){el.focus()}if(typeof _fs.start==='number'&&el.setSelectionRange){try{el.setSelectionRange(_fs.start,_fs.end)}catch(e){}}}}catch(e){}};
setTimeout(_restore,0);
if(!S.user){let h='<div class="login">';
if(S.loginStep==='phone'){
h+='<div class="hero-photo"><img src="https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1200&q=80" alt="Calm productive workspace" loading="eager"/><div class="hero-photo-overlay"></div></div>';
h+='<div class="login-logo">Brodoit</div>';
h+='<div class="login-tagline">Tasks. Books. Wisdom.</div>';
h+='<a class="whatsnew-pill" href="/pricing" style="display:inline-flex;align-items:center;gap:8px;padding:7px 14px;margin:0 0 18px;background:rgba(31,77,63,.08);border:1px solid rgba(31,77,63,.2);border-radius:999px;font-size:12px;font-weight:500;letter-spacing:.04em;color:#1F4D3F;text-decoration:none;font-family:\\'JetBrains Mono\\',monospace;text-transform:uppercase"><span style="width:6px;height:6px;border-radius:999px;background:#1F4D3F;box-shadow:0 0 8px #1F4D3F;animation:wn-pulse 2s ease-in-out infinite"></span>NEW · Pricing &amp; Pro tier <span style="opacity:.7">→</span></a>';
h+='<div class="login-sub">A calm, focused space for the work that matters.</div>';
// Login tabs removed for closed-test phase — email-only.
S.loginMethod='email';
h+='<input id="loginName" type="text" placeholder="Your name" value="'+esc(S.loginName)+'" oninput="S.loginName=this.value;persistLoginState()" style="font-size:15px;letter-spacing:0">';
if(S.loginMethod==='email'){
  h+='<input id="loginEmail" type="email" placeholder="you@example.com" value="'+esc(S.loginEmail)+'" oninput="S.loginEmail=this.value;persistLoginState()" autocomplete="email" style="font-size:15px;letter-spacing:0">';
  if(S.loginError)h+='<div style="color:#E8453C;font-size:13px;font-weight:600;margin:8px 0">'+S.loginError+'</div>';
  h+='<button class="login-btn" onclick="sendOTP()"'+(S.loginLoading?' disabled':'')+'>'+(S.loginLoading?'Sending code...':'\\u2709\\uFE0F Send code to email')+'</button>';
  h+='<div class="login-hint">We\\'ll email a 6-digit code. Check your inbox (and spam folder).</div>';
  h+='<div class="login-wa-note"><span class="login-wa-emoji">\\u{1F4F2}</span><span>After signing in, you can <b>connect WhatsApp</b> to add tasks and get reminders by chat. Find it in your profile.</span></div>';
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
h+='<button class="login-btn sec" onclick="S.loginStep=\\'phone\\';S.loginError=\\'\\';try{history.replaceState(null,\\'\\',\\'/\\')}catch(e){}render()">\\u2190 '+(S.loginMethod==='email'?'Change email':'Change number')+'</button>';
h+='<div class="login-hint">Didn\\'t get the code? Check your '+(S.loginMethod==='email'?'spam folder or tap "Change email"':'WhatsApp or tap "Change number"')+' to retry.</div>';
}
h+='<footer class="login-foot"><a href="/pricing">Pricing</a><span>\\u2022</span><a href="/about">About</a><span>\\u2022</span><a href="/changelog">What\\'s new</a><span>\\u2022</span><a href="/privacy" target="_blank" rel="noopener">Privacy</a><span>\\u2022</span><a href="/terms" target="_blank" rel="noopener">Terms</a><span>\\u2022</span><a href="mailto:hello@brodoit.com">Contact</a></footer>';
h+='</div>';
if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
document.getElementById('app').innerHTML=h;
if(S.loginMethod==='whatsapp'&&S.loginStep==='phone')updatePhonePreview();
return;
}

// Immersive meditation overlay — full-screen calm scene with breathing circle, ocean waves, drifting stars
if(S.meditating&&S.meditating.active){
  const med=S.meditating;
  let h='<div class="med-scene">';
  // Layered animated background
  h+='<div class="med-stars"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>';
  // SVG ocean waves at the bottom
  h+='<svg class="med-waves" viewBox="0 0 1440 240" preserveAspectRatio="none">'
    +'<path class="med-wave med-wave-1" d="M0 120 Q360 60 720 120 T1440 120 V240 H0 Z"/>'
    +'<path class="med-wave med-wave-2" d="M0 150 Q360 90 720 150 T1440 150 V240 H0 Z"/>'
    +'<path class="med-wave med-wave-3" d="M0 180 Q360 130 720 180 T1440 180 V240 H0 Z"/>'
  +'</svg>';
  // Top — title and close
  h+='<button class="med-close" onclick="closeMeditation()" aria-label="Close meditation">\\u2715</button>';
  h+='<div class="med-info"><div class="med-info-mins">'+med.mins+' MIN \\u2022 MEDITATION</div><div class="med-info-title">'+esc(med.title)+'</div></div>';
  // Breathing circle
  h+='<div class="med-breath-wrap"><div class="med-breath-ring med-breath-ring-3"></div><div class="med-breath-ring med-breath-ring-2"></div><div class="med-breath-ring med-breath-ring-1"></div><div class="med-breath-core"><span class="med-breath-text" id="medBreathText">Breathe in</span></div></div>';
  // Hidden audio player
  if(S.playing){
    if(S.playing.url)h+='<audio id="audioEl" controls preload="auto" src="'+esc(S.playing.url)+'" autoplay class="med-audio"></audio>';
    else if(S.playing.loading)h+='<div class="med-loading">Loading audio\\u2026</div>';
    else if(S.playing.error)h+='<div class="med-loading">Audio unavailable</div>';
  }
  h+='<div class="med-tip">Sit comfortably. Let the sound carry you.</div>';
  h+='</div>';
  if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
  document.getElementById('app').innerHTML=h;
  // Cycle the breath text
  if(!window._medBreathInterval){
    const phrases=['Breathe in','Hold','Breathe out','Hold'];let i=0;
    window._medBreathInterval=setInterval(()=>{const el=document.getElementById('medBreathText');if(!el){clearInterval(window._medBreathInterval);window._medBreathInterval=null;return}i=(i+1)%phrases.length;el.style.opacity='0';setTimeout(()=>{el.textContent=phrases[i];el.style.opacity='1'},200)},2500);
  }
  return;
}
// Filter by board first (Home / Office / Combined). Combined shows everything.
const ts=(S.board==='combined'?S.tasks:S.tasks.filter(t=>(t.board||'home')===S.board));
const f=ts.filter(t=>{if(S.search){const q=S.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||'').toLowerCase().includes(q))return false}if(S.view==='all')return true;if(S.view==='today')return isTd(t.due_date);if(S.view==='overdue')return isOD(t.due_date,t.status);return t.status===S.view});
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
const PROFILE_BTN='<button class="hdr-profile" onclick="openProfile()" title="'+esc(S.user.name||S.user.phone||'Profile')+'" aria-label="Profile"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg><span class="hdr-profile-name">'+esc((S.user.name||S.user.phone||'').split(' ')[0])+'</span></button>';

// Person-of-the-day card — precomputed so it can be injected next to the logo on desktop.
let remember='';
if(S.remember&&S.remember.person){
  const p=S.remember.person;
  // Wording that can't be misread as today's date.
  // Born:  "Born on this day in 1965"  /  Died: "Died on this day in 2017"
  const yr=p.year?String(p.year):'';
  const kicker=p.type==='born'?(yr?'Born on this day in '+yr:'Born on this day'):(yr?'Died on this day in '+yr:'Died on this day');
  remember='<a class="remember-card" href="'+esc(p.url||'#')+'" target="_blank" rel="noopener" title="Read on Wikipedia">'
    +(p.thumb?'<img class="remember-thumb" src="'+esc(p.thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">':'<span class="remember-thumb remember-thumb-empty">\\u{1F4DC}</span>')
    +'<div class="remember-body">'
      +'<div class="remember-kicker">'+esc(kicker)+'</div>'
      +'<div class="remember-name">'+esc(p.title)+'</div>'
      +(p.extract?'<div class="remember-extract">'+esc(p.extract)+'</div>':'')
    +'</div>'
    +'<svg class="remember-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>'
  +'</a>';
}
// Tasks tab is the "main page" — moral, news, person-of-day, world-clocks render only here.
const isMain=(S.tab==='tasks'||!S.tab);
const HELP_BTN='<button class="hdr-help" onclick="openHelp()" aria-label="Help" title="How to use Brodoit">?</button>';
let h=(isMain?PHONE_BANNER:'')+'<div class="hdr"><div class="hdr-l"><div class="logo">Bro<span class="k">Do</span>it</div><div class="hdr-tagline">tasks &middot; books &middot; wisdom &middot; calm</div><div class="hdr-sub">'+JUMPER+HDR_TIME+'</div></div>'+(isMain&&remember?'<div class="hdr-remember">'+remember+'</div>':'')+'<div class="hdr-actions">'+HELP_BTN+PROFILE_BTN+'<button class="theme-tg" onclick="toggleTheme()" title="Switch theme">'+(S.theme==='aurora'?ic('sun',18):ic('moon',18))+'</button></div></div>';

const m=MORALS[S.moralIdx];
let moralBlock='';
let bottomBlock='';
if(isMain){
  const mWrap='<div class="moral">'+MORAL_DOODLE+'<div class="moral-emoji">\\u{1F4A1}</div><div class="moral-body"><div class="moral-lbl">Moral of the Day</div><div class="moral-txt">"'+esc(m.t)+'"</div><div class="moral-by">\\u2014 '+esc(m.a)+'</div></div><button class="moral-ref" onclick="rotateMoral()" title="New quote">\\u21BB</button></div>';
  // 3 highlight headlines for the TOP of the tasks page — auto-rotating with fade animation
  const items=S.ticker.items||[];const baseIdx=S.ticker.idx||0;
  const top3=[0,1,2].map(o=>items[(baseIdx+o)%(items.length||1)]||{title:'Loading\\u2026',link:'#',source:''});
  let topNews='<div class="top-news" id="topNewsStack">';
  top3.forEach((ti,i)=>{topNews+='<a class="top-news-row" style="animation-delay:'+(i*0.5)+'s" href="'+esc(ti.link||'#')+'" target="_blank" rel="noopener" title="'+esc(ti.title||'')+'"><span class="top-news-pulse"></span><span class="top-news-src">'+esc((ti.source||'').toUpperCase())+'</span><span class="top-news-link">'+esc(ti.title||'')+'</span></a>'});
  topNews+='</div>';
  // Bottom: full 5-headline ticker + world clocks (person-of-day already in header on main page).
  const visible=[0,1,2,3,4].map(o=>items[(baseIdx+o)%(items.length||1)]||{title:'Loading\\u2026',link:'#',source:''});
  let ticker='<div class="news-ticker-stack" id="newsTickerStack">';
  visible.forEach((ti,i)=>{ticker+='<a class="news-ticker-row" style="animation-delay:'+(i*0.07)+'s" href="'+esc(ti.link||'#')+'" target="_blank" rel="noopener" title="'+esc(ti.title||'')+'"><span class="news-ticker-pulse"></span><span class="news-ticker-src">'+esc((ti.source||'').toUpperCase())+'</span><span class="news-ticker-link">'+esc(ti.title||'')+'</span></a>'});
  ticker+='</div>';
  const fmtTZ2=(tz)=>{try{return new Date().toLocaleTimeString('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false})}catch(e){return '--:--'}};
  const isDayAt=(tz)=>{try{const h=Number(new Date().toLocaleString('en-US',{timeZone:tz,hour:'2-digit',hour12:false}).split(',')[1]||new Date().toLocaleString('en-US',{timeZone:tz,hour:'2-digit',hour12:false}));return h>=6&&h<18}catch(e){return true}};
  const wc='<div class="world-clocks" id="worldClocks">'+WORLD_CITY_LIST.map((c,i)=>{const day=isDayAt(c.tz);const icon=day?'<svg class="wc-icon wc-sun" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill="#F59E0B"/><g stroke="#F59E0B" stroke-width="1.6" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="7" y2="17"/><line x1="17" y1="7" x2="19.1" y2="4.9"/></g></svg>':'<svg class="wc-icon wc-moon" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="#A78BFA"/><circle class="wc-star" cx="6" cy="6" r="0.8" fill="#A78BFA"/><circle class="wc-star" cx="20" cy="20" r="0.7" fill="#A78BFA"/></svg>';const ct=(S.cityTemps||{})[c.key.toLowerCase()];const tempStr=ct&&ct.temp!=null?ct.temp+'\\u00B0':'';return '<span class="wc-item '+(day?'wc-day':'wc-night')+'" style="animation-delay:'+(i*0.05)+'s"><span class="wc-icon-wrap">'+icon+'</span><b>'+esc(c.label)+'</b><span class="wc-time" data-tz="'+c.tz+'">'+fmtTZ2(c.tz)+'</span>'+(tempStr?'<span class="wc-temp">'+tempStr+'</span>':'')+'</span>'}).join('')+'</div>';
  moralBlock='<div class="moral-wrap">'+mWrap+topNews+'</div>';
  bottomBlock='<div class="bottom-strip">'+ticker+wc+'</div>';
}

// Tabs
{
  const now=new Date();
  const yStart=new Date(now.getFullYear(),0,0);
  const dayOfYear=Math.floor((now-yStart)/86400000);
  const yearPct=Math.round(dayOfYear/365*100);
  const dateStr=now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const tabsHtml=[{k:'tasks',l:'Tasks'},{k:'board',l:'Board'},{k:'cal',l:'Calendar'},{k:'books',l:'Books'},{k:'meditation',l:'Meditate'},{k:'mindgym',l:'Mind Gym'},{k:'voice',l:'Voice'},{k:'news',l:'News'}].map(x=>'<button class="tab tab-'+x.k+(S.tab===x.k?' on':'')+'" onclick="stopSpeak();switchTab(\\''+x.k+'\\')"><span class="ti">'+(ID[x.k]||ic(x.k,26))+'</span><span class="tl">'+x.l+'</span></button>').join('');
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
  const w=S.weather||{};
  const aqiLevel=w.aqi==null?'':w.aqi<=50?'good':w.aqi<=100?'mod':w.aqi<=150?'usg':w.aqi<=200?'bad':w.aqi<=300?'vbad':'haz';
  const aqiColor={good:'#10B981',mod:'#F59E0B',usg:'#F97316',bad:'#E8453C',vbad:'#9333EA',haz:'#7F1D1D'}[aqiLevel]||'#94A3B8';
  const fmtTZ=(tz)=>{try{return new Date().toLocaleTimeString('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false})}catch(e){return '--:--'}};
  const CITIES=[{l:'NYC',tz:'America/New_York'},{l:'LAX',tz:'America/Los_Angeles'},{l:'LDN',tz:'Europe/London'},{l:'SGP',tz:'Asia/Singapore'}];
  const sideNow='<div class="side-now" aria-hidden="true">'
    +'<div class="side-now-row">'
      +'<span class="side-now-time" id="sideNowTime">'+now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})+'<span class="sec" id="sideNowSec">:'+String(now.getSeconds()).padStart(2,'0')+'</span></span>'
      +'<span class="side-now-sep">\\u2022</span>'
      +'<span class="side-now-date">'+dateStr+'</span>'
      +'<span class="side-now-sep">\\u2022</span>'
      +'<span class="side-now-days"><b>'+daysLeft+'</b>d</span>'
    +'</div>'
    +'<div class="side-now-row side-now-row-w" onclick="setCity()" title="Click to change city" style="cursor:pointer">'
      +'<span class="weather-pin">\\u{1F4CD}</span>'
      +'<span class="weather-city">'+esc(w.city||'Bangalore')+'</span>'
      +(w.temp!=null?'<span class="side-now-sep">\\u2022</span><span class="weather-temp"><b>'+w.temp+'\\u00B0</b>C</span>':'')
      +(w.aqi!=null?'<span class="side-now-sep">\\u2022</span><span class="weather-aqi" style="--aqi-c:'+aqiColor+'">AQI <b>'+w.aqi+'</b></span>':'')
      +(w.loading?'<span class="weather-loading">\\u2026</span>':'')
    +'</div>'
    +'<div class="india-cities">'+INDIA_CITIES.map(c=>{const t=(S.cityTemps||{})[c.toLowerCase()];const tStr=t&&t.temp!=null?t.temp+'\\u00B0':'\\u2026';return '<span class="ic-item"><span class="ic-name">'+esc(c)+'</span><span class="ic-temp">'+tStr+'</span></span>'}).join('')+'</div>'
    +'<div class="side-now-bar"><div class="side-now-fill" style="width:'+yearPct+'%"></div><div class="side-now-walker" style="left:'+yearPct+'%">'
      +'<svg viewBox="0 0 14 18" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
        +'<circle cx="7" cy="3" r="2" fill="#6366F1"/>'
        +'<line x1="7" y1="5" x2="7" y2="11" stroke="#6366F1"/>'
        +'<g class="snw-arm-l"><line x1="7" y1="7" x2="3" y2="9" stroke="#6366F1"/></g>'
        +'<g class="snw-arm-r"><line x1="7" y1="7" x2="11" y2="6" stroke="#6366F1"/></g>'
        +'<g class="snw-leg-l"><line x1="7" y1="11" x2="4" y2="16" stroke="#6366F1"/></g>'
        +'<g class="snw-leg-r"><line x1="7" y1="11" x2="10" y2="16" stroke="#6366F1"/></g>'
      +'</svg>'
    +'</div></div>'
    +'<div class="side-now-foot"><span>'+yearPct+'%</span><span>Day '+dayOfYear+' / 365</span></div>'
    +'<svg class="side-now-wave" viewBox="0 0 100 30" preserveAspectRatio="none"><path d="M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15" stroke="#6366F1" stroke-width="1.6" fill="none"><animate attributeName="d" dur="4s" repeatCount="indefinite" values="M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15;M 0 15 Q 12.5 25 25 15 T 50 15 T 75 15 T 100 15;M 0 15 Q 12.5 5 25 15 T 50 15 T 75 15 T 100 15"/></path></svg>'
    +'</div>';
  h+='<aside class="side-col">';
  h+='<nav class="tabs page-t">'+tabsHtml+'</nav>';
  // Your Life Goal — editable, persists in localStorage, fills the bottom of the left chip
  const goalText=S.lifeGoal||'';
  const PENCIL='<svg class="lg-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const goalCard='<div class="life-goal'+(goalText?'':' life-goal-empty')+'" onclick="editLifeGoal()" title="Click to type your life goal">'
    +'<div class="lg-label-row">'
      +'<span class="lg-label"><span class="lg-star">\\u2605</span> Your Life Goal</span>'
      +'<span class="lg-edit-btn" aria-label="Edit">'+PENCIL+'<span class="lg-edit-text">'+(goalText?'Edit':'Type')+'</span></span>'
    +'</div>'
    +'<div class="lg-text'+(goalText?'':' lg-empty')+'">'+(goalText?esc(goalText):'Type your goal here \\u2014 your north star\\u2026')+'</div>'
    +(goalText?'':'<div class="lg-empty-hint">Tap anywhere to start typing</div>')
  +'</div>';
  // Topstrip (clock + weather + cities + life-goal) only on Tasks tab — keeps other tabs focused.
  // Inside the sidebar so on desktop it sits right below the tab nav.
  // On mobile it's hidden via CSS (tasks need to be above the fold; time/date is already in the header).
  if(isMain)h+='<section class="top-strip">'+sideNow+goalCard+'</section>';
  h+='</aside>';
}

h+='<main class="main-col">';
// Moral chip + 3-headline top news at the top of the main column (Tasks tab only).
h+=moralBlock;
// User-bar + section-div removed; Profile lives in the header top-right.
// Scenic tab hero — rendered at top of every tab EXCEPT Tasks (where it moves to the bottom of the list)
const _tabHeroHtml=(()=>{const hero=TAB_HERO[S.tab];if(!hero)return '';const url='https://images.unsplash.com/photo-'+hero.img+'?w=1400&q=80&auto=format&fit=crop';return '<div class="tab-hero" style="background-image:linear-gradient(135deg,rgba(15,23,42,.62) 0%,rgba(15,23,42,.32) 55%,rgba(15,23,42,.18) 100%),url(&quot;'+url+'&quot;)"><div class="tab-hero-particles"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><div class="tab-hero-body"><h2 class="tab-hero-h">'+hero.h+'</h2><p class="tab-hero-s">'+hero.s+'</p></div></div>'})();
if(S.tab!=='tasks')h+=_tabHeroHtml;

// TASKS TAB
if(S.tab==='dash')S.tab='tasks'; // Stats tab removed; redirect any stale state to Tasks
if(S.tab==='tasks'){
  // Restore-from-backup banner — surfaces only if the server returned 0 tasks but a local snapshot exists.
  if(S.restoreOffer&&S.restoreOffer.count){
    const when=S.restoreOffer.savedAt?new Date(S.restoreOffer.savedAt).toLocaleString():'';
    h+='<div class="restore-banner">'
      +'<span class="restore-emoji">\\u{1F4BE}</span>'
      +'<div class="restore-body"><div class="restore-t">Restore your tasks?</div><div class="restore-s">We have a local backup of <b>'+S.restoreOffer.count+'</b> task'+(S.restoreOffer.count===1?'':'s')+(when?' (saved '+esc(when)+')':'')+'. The server\\u2019s task list is empty.</div></div>'
      +'<button class="restore-go" onclick="restoreFromBackup()">Restore</button>'
      +'<button class="restore-x" onclick="dismissRestoreOffer()" aria-label="Dismiss">\\u2715</button>'
    +'</div>';
  }
  // Connect-WhatsApp banner — shows when WA isn't linked AND user hasn't dismissed it.
  if(S.profile&&!S.profile.wa_phone&&localStorage.getItem('tf_wa_banner_x')!=='1'){
    h+='<div class="wa-promo">'
      +'<span class="wa-promo-emoji">\\u{1F4F2}</span>'
      +'<div class="wa-promo-body"><div class="wa-promo-t">Connect WhatsApp</div><div class="wa-promo-s">Add tasks by chat &amp; get reminders on WhatsApp</div></div>'
      +'<button class="wa-promo-go" onclick="waConnectStart()">Connect \\u2192</button>'
      +'<button class="wa-promo-x" onclick="localStorage.setItem(\\'tf_wa_banner_x\\',\\'1\\');render()" aria-label="Dismiss">\\u2715</button>'
    +'</div>';
  }
  // Boards UI removed per user request — single unified task list, no Home/Office/Combined picker.
  // TASKS LEAD — primary action sits at the top
  h+='<button class="add-bar" onclick="opA()"><span class="plus">+</span><span class="txt"><b>Add a new task</b><small>Type, use voice, or send via WhatsApp</small></span></button>';
  // WhatsApp reminders prompt removed for closed-test phase
  h+='<div class="stats">'+[{l:'Total',v:s.total,c:'#0F172A'},{l:'To Do',v:s.pend,c:'#94A3B8'},{l:'Active',v:s.act,c:'#3B82F6'},{l:'Done',v:s.dn,c:'#3DAE5C'}].map(x=>'<div class="st"><b style="color:'+x.c+'">'+x.v+'</b><small>'+x.l+'</small></div>').join('')+'</div>';
  if(s.od>0)h+='<div class="al" style="background:#FEF1F0;border:1px solid #F5C6C2;color:#E8453C;cursor:pointer" onclick="S.view=\\'overdue\\';render()">\\u26A0\\uFE0F '+s.od+' overdue</div>';
  h+='<div class="srch"><input placeholder="Search tasks..." value="'+esc(S.search)+'" oninput="S.search=this.value;render()"></div>';
  h+='<div class="flt">'+[{k:'all',l:'All'},{k:'pending',l:'To Do'},{k:'in-progress',l:'Doing'},{k:'done',l:'Done'},{k:'today',l:'Today'}].map(x=>'<button class="fb'+(S.view===x.k?' on':'')+'" onclick="S.view=\\''+x.k+'\\';render()">'+x.l+'</button>').join('')+'</div>';
  if((s.pend+s.act)>0&&S.profile&&S.profile.wa_phone){
    h+='<button class="bwa" onclick="sAll()"'+(S.sending&&S.sending._a?' disabled':'')+'>'+WI+' '+(S.sending&&S.sending._a?'Sending\\u2026':'Send all tasks to WhatsApp')+'</button>';
  }
  h+='<div>';
  if(!f.length)h+='<div class="empty"><div style="font-size:36px;margin-bottom:8px">\\u2728</div><div style="font-size:15px;font-weight:600">No tasks yet</div><div style="font-size:13px;margin-top:4px">Tap + to add your first task</div></div>';
  else f.forEach(t=>{const p=P[t.priority]||P.medium,st=ST[t.status]||ST.pending,d=t.status==='done';
    const addedTxt=t.created_at?timeAgo((t.created_at||'').replace(' ','T')+'Z'):'';
    h+='<div class="tc'+(d?' dn':'')+'" style="border-left-color:'+p.c+'"><div class="tc-top"><button class="chk'+(d?' on':'')+'" onclick="tog(\\''+t.id+'\\')">'+(d?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>':'')+'</button><div style="flex:1;min-width:0"><div class="tc-t'+(d?' dn':'')+'">'+esc(t.title)+'</div>'+(t.notes?'<div class="tc-n">'+esc(t.notes)+'</div>':'')+'<div class="tc-m"><button class="badge" style="background:'+st.bg+';color:'+st.c+'" onclick="cyc(\\''+t.id+'\\')">'+st.l+'</button>'+(t.due_date?'<span style="font-size:12px;font-weight:500;color:'+(isOD(t.due_date,t.status)?'#E8453C':isTd(t.due_date)?'#E8912C':'#94A3B8')+'">\\u{1F4C5} '+fD(t.due_date)+(isOD(t.due_date,t.status)?' overdue':'')+'</span>':'')+(t.reminder_time&&!d?'<span style="font-size:11px;color:#3B82F6;font-weight:600">\\u{1F514} '+fT(t.reminder_time)+'</span>':'')+(t.source==='whatsapp'?'<span style="font-size:10px;font-weight:700;color:#128C7E;background:#EDFCF2;border:1px solid #B7E8C4;padding:2px 7px;border-radius:6px;letter-spacing:.3px">\\u{1F4F2} WA</span>':'')+(addedTxt?'<span class="tc-added" title="Added '+esc(t.created_at||'')+'">\\u2795 '+esc(addedTxt)+'</span>':'')+'</div></div></div>';
    h+='<div class="tc-acts"><button class="ib" onclick="opE(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'+(S.profile&&S.profile.wa_phone?'<button class="ib" title="Send to WhatsApp" onclick="sWA(\\''+t.id+'\\')">'+WI+'</button>':'')+'<button class="ib" style="color:#E8453C" onclick="del(\\''+t.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div></div>'});
  h+='</div>';
  // Mind Gym moved to its own dedicated tab.
}

// MIND GYM TAB — dedicated brain-training section, treated as its own product
else if(S.tab==='mindgym'){
  const mg=S.mg;const overall=Math.round((mgPercent('math')+mgPercent('memory')+mgPercent('reaction'))/3);
  const totalLevel=mg.progress.math.level+mg.progress.memory.level+mg.progress.reaction.level+((mg.progress.word&&mg.progress.word.level)||1);
  const totalXp=(mg.progress.math.xp||0)+(mg.progress.memory.xp||0)+(mg.progress.reaction.xp||0)+((mg.progress.word&&mg.progress.word.xp)||0);
  const streak=mg.streak||{current:0,longest:0,total:0};
  // Daily workout — 3-game plan, ticked as user completes each today
  const dGames=[{k:'math',n:'Math',e:'\\u{1F522}',fn:'mgMathStart()'},{k:'memory',n:'Memory',e:'\\u{1F9E9}',fn:'mgMemoryStart()'},{k:'reaction',n:'Reaction',e:'\\u26A1',fn:'mgReactionStart()'},{k:'word',n:'Word',e:'\\u{1F520}',fn:'mgWordStart()'}];
  const doneCount=dGames.filter(g=>_mgIsDoneToday(g.k)).length;const totalGames=dGames.length;
  const nextGame=dGames.find(g=>!_mgIsDoneToday(g.k));
  h+='<div class="mg-daily">'
    +'<div class="mg-daily-l"><div class="mg-daily-eyebrow">TODAY \\u2022 5-MINUTE WORKOUT</div>'
    +'<div class="mg-daily-t">'+(doneCount===totalGames?'\\u{1F389} Workout complete!':'Plan: '+dGames.map(g=>(_mgIsDoneToday(g.k)?'<s>':'')+g.e+' '+g.n+(_mgIsDoneToday(g.k)?'</s>':'')).join(' \\u2192 '))+'</div>'
    +'<div class="mg-daily-pills">';
  dGames.forEach(g=>{const done=_mgIsDoneToday(g.k);h+='<span class="mg-daily-pill'+(done?' mg-daily-done':'')+'">'+(done?'\\u2713 ':'')+g.e+' '+g.n+'</span>'});
  h+='</div></div>'
    +(nextGame?'<button class="mg-daily-btn" onclick="'+nextGame.fn+'">'+(doneCount===0?'Start \\u2192':'Continue \\u2192')+'</button>':'<div class="mg-daily-done-tag">\\u{1F525} +1 streak day</div>')
    +'</div>';
  // Hero header — stats overview
  h+='<section class="mg-hero">'
    +'<div class="mg-hero-grad"></div>'
    +'<div class="mg-hero-inner">'
      +'<div class="mg-hero-l"><div class="mg-hero-eyebrow">\\u{1F9E0} BRODOIT \\u00B7 MIND GYM</div>'
        +'<h1 class="mg-hero-t">Train your mind, daily.</h1>'
        +'<div class="mg-hero-s">Your brain learns the same way muscles do \\u2014 one rep at a time. Three games, server-tracked progress, every device.</div>'
      +'</div>'
      +'<div class="mg-hero-stats">'
        +'<div class="mg-stat"><b>'+overall+'%</b><small>Overall</small></div>'
        +'<div class="mg-stat"><b>L'+totalLevel+'</b><small>Total levels</small></div>'
        +'<div class="mg-stat mg-stat-streak"><b>\\u{1F525} '+streak.current+'</b><small>Day streak</small></div>'
        +'<div class="mg-stat"><b>'+totalXp+'</b><small>XP earned</small></div>'
      +'</div>'
    +'</div>'
  +'</section>';
  h+='<div class="mg-grid mg-grid-tab">';
  // Math Sprint
  {const p=mg.progress.math;const pct=mgPercent('math');h+='<button class="mg-card mg-math" onclick="mgMathStart()">'
    +'<div class="mg-card-hd"><span class="mg-card-emoji">\\u{1F522}</span><span class="mg-card-name">Math Sprint</span><span class="mg-card-lvl">L'+p.level+'</span></div>'
    +'<div class="mg-card-d">Mental arithmetic against the clock</div>'
    +'<div class="mg-bar"><div class="mg-bar-fill" style="width:'+pct+'%"></div></div>'
    +'<div class="mg-card-foot"><span>'+pct+'%</span><span>Best streak: <b>'+(p.best||0)+'</b></span></div>'
  +'</button>'}
  // Memory Tap
  {const p=mg.progress.memory;const pct=mgPercent('memory');h+='<button class="mg-card mg-memory" onclick="mgMemoryStart()">'
    +'<div class="mg-card-hd"><span class="mg-card-emoji">\\u{1F9E9}</span><span class="mg-card-name">Memory Tap</span><span class="mg-card-lvl">L'+p.level+'</span></div>'
    +'<div class="mg-card-d">Working-memory workout, Elevate-style</div>'
    +'<div class="mg-bar"><div class="mg-bar-fill" style="width:'+pct+'%"></div></div>'
    +'<div class="mg-card-foot"><span>'+pct+'%</span><span>Best round: <b>'+(p.best||0)+'</b></span></div>'
  +'</button>'}
  // Reaction
  {const p=mg.progress.reaction;const pct=mgPercent('reaction');const bestStr=p.best?p.best+'ms':'\\u2014';h+='<button class="mg-card mg-reaction" onclick="mgReactionStart()">'
    +'<div class="mg-card-hd"><span class="mg-card-emoji">\\u26A1</span><span class="mg-card-name">Reaction</span><span class="mg-card-lvl">L'+p.level+'</span></div>'
    +'<div class="mg-card-d">Train pure reflexes, ms by ms</div>'
    +'<div class="mg-bar"><div class="mg-bar-fill" style="width:'+pct+'%"></div></div>'
    +'<div class="mg-card-foot"><span>'+pct+'%</span><span>Best: <b>'+bestStr+'</b></span></div>'
  +'</button>'}
  // Word Sprint — anagram unscrambler (real game)
  {const p=mg.progress.word||{level:1,xp:0,best:0};const pct=Math.min(100,Math.round(((p.xp||0)/(5*100))*100));const bestStr=p.best?p.best+' words':'\\u2014';h+='<button class="mg-card mg-word" onclick="mgWordStart()" style="background:linear-gradient(135deg,#0a1414,#0a1d2a)">'
    +'<div class="mg-card-hd"><span class="mg-card-emoji">\\u{1F520}</span><span class="mg-card-name">Word Sprint</span><span class="mg-card-lvl">L'+p.level+'</span></div>'
    +'<div class="mg-card-d">Seven scrambled letters. Find every word in 90s.</div>'
    +'<div class="mg-bar"><div class="mg-bar-fill" style="width:'+pct+'%;background:linear-gradient(90deg,#22D3EE,#10B981)"></div></div>'
    +'<div class="mg-card-foot"><span>'+pct+'%</span><span>Best: <b>'+bestStr+'</b></span></div>'
  +'</button>'}
  h+='</div>';
  // Achievements row — 4 badges, some unlocked based on real progress
  {
    const totalLvl=mg.progress.math.level+mg.progress.memory.level+mg.progress.reaction.level;
    const ach=[
      {k:'first',cls:'',name:'First step',desc:'Played your first game',unlocked:totalLvl>3},
      {k:'week',cls:'streak',name:'Week warrior',desc:'7-day streak',unlocked:streak.current>=7},
      {k:'sharp',cls:'cool',name:'Sharp mind',desc:'L5 in any game',unlocked:Math.max(mg.progress.math.level,mg.progress.memory.level,mg.progress.reaction.level,(mg.progress.word&&mg.progress.word.level)||0)>=5},
      {k:'flow',cls:'purple',name:'In the flow',desc:'500 XP earned',unlocked:totalXp>=500}
    ];
    h+='<div class="mg-achievements">';
    ach.forEach(a=>{
      h+='<div class="mg-ach '+(a.unlocked?a.cls:'locked')+'">'
        +'<div class="medal">'+(a.unlocked?(a.k==='first'?'\\u2728':a.k==='week'?'\\u{1F525}':a.k==='sharp'?'\\u26A1':'\\u{1F4AB}'):'\\u{1F512}')+'</div>'
        +'<div class="name">'+a.name+'</div>'
        +'<div class="desc">'+a.desc+'</div>'
      +'</div>';
    });
    h+='</div>';
  }
  // Why train? — value-prop strip
  h+='<div class="mg-why">'
    +'<div class="mg-why-card"><span class="mg-why-emoji">\\u{1F4C8}</span><div><div class="mg-why-t">Trackable progress</div><div class="mg-why-d">Every play saves to your account. Your level travels with you across phone and laptop.</div></div></div>'
    +'<div class="mg-why-card"><span class="mg-why-emoji">\\u23F1\\uFE0F</span><div><div class="mg-why-t">Five minutes a day</div><div class="mg-why-d">Each game is a sub-90-second commitment. Stack them for a 5-minute morning warm-up.</div></div></div>'
    +'<div class="mg-why-card"><span class="mg-why-emoji">\\u{1F525}</span><div><div class="mg-why-t">Daily streaks</div><div class="mg-why-d">Build the habit. The streak counter rewards consistency over volume.</div></div></div>'
  +'</div>';
}

// VOICE TAB — AI Coach (Phase 2 — live Claude conversation + Whisper STT + ElevenLabs TTS)
else if(S.tab==='voice'){
  const c=S.coach||{};const st=c.status||{};
  // Daily lesson card (rotates by weekday) — renders at the very top
  {
    const lesson=_voiceLessonOfDay();
    const today=new Date();
    const weekDay=today.toLocaleDateString('en-US',{weekday:'long'});
    h+='<div class="vc-lesson">'
      +'<div class="vc-lesson-eyebrow">'+lesson.e+' Today\\u2019s lesson <span class="day-num">'+esc(weekDay)+'</span></div>'
      +'<h2>'+lesson.title+'</h2>'
      +'<div class="desc">'+lesson.desc+'</div>'
      +'<div class="vc-lesson-row">'
        +'<button class="vc-go" onclick="voiceStartLesson()">Start lesson \\u2192</button>'
        +'<span class="vc-meta">~ 4 min \\u00B7 AI tutor will guide you</span>'
      +'</div>'
    +'</div>';
  }
  // Vocabulary trio for today — 3 hand-picked advanced words
  {
    const vocab=_voiceVocabOfDay();
    h+='<div class="vc-vocab-row">'
      +'<div class="vc-vocab-h"><h3>\\u{1F4DA} Three words for today</h3><span class="meta">Tap any word to hear it</span></div>'
      +'<div class="vc-vocab-grid">';
    vocab.forEach(v=>{
      h+='<button class="vc-vocab-card" onclick="voiceSpeakWord(\\''+esc(v.w)+'\\')">'
        +'<div class="word">'+esc(v.w)+' \\u{1F50A}</div>'
        +'<div class="pos">'+esc(v.pos)+'</div>'
        +'<div class="def">'+esc(v.def)+'</div>'
        +'<div class="ex">"'+esc(v.ex)+'"</div>'
      +'</button>';
    });
    h+='</div></div>';
  }
  // ═══ Learning path — Duolingo-style level-by-level progression ═══
  {
    if(!S.voiceCurriculum){S.voiceCurriculum={progress:{},totalXp:0,totalStars:0,completed:0};setTimeout(voiceCurriculumLoad,200)}
    const cur=S.voiceCurriculum||{progress:{},totalXp:0,totalStars:0};
    const totalLessons=VOICE_CURRICULUM.reduce((s,u)=>s+u.lessons.length,0);
    h+='<div class="vp-head">'
      +'<div><h3 class="vp-h">Your learning path</h3><div class="vp-sub">'+VOICE_CURRICULUM.length+' units \\u00B7 '+totalLessons+' lessons \\u00B7 unlock as you go</div></div>'
      +'<div class="vp-stats">'
        +'<div class="vp-stat"><b>'+(cur.totalStars||0)+'</b><small>\\u2605 stars</small></div>'
        +'<div class="vp-stat"><b>'+(cur.totalXp||0)+'</b><small>XP</small></div>'
        +'<div class="vp-stat"><b>'+(cur.completed||0)+'<span style="font-weight:400;color:#9A9A9A">/'+totalLessons+'</span></b><small>lessons</small></div>'
      +'</div>'
    +'</div>';
    h+='<div class="vp-path">';
    VOICE_CURRICULUM.forEach((unit,uIdx)=>{
      const unitProgress=unit.lessons.filter(l=>cur.progress[unit.id+':'+l.id]).length;
      const unitDone=unitProgress===unit.lessons.length;
      h+='<div class="vp-unit'+(unitDone?' vp-unit-done':'')+'" style="--vp-c:'+unit.color+'">'
        +'<div class="vp-unit-hd">'
          +'<div class="vp-unit-ic">'+unit.e+'</div>'
          +'<div class="vp-unit-meta"><div class="vp-unit-tag">UNIT '+unit.id+'</div><div class="vp-unit-name">'+esc(unit.name)+'</div><div class="vp-unit-desc">'+esc(unit.desc)+'</div></div>'
          +'<div class="vp-unit-prog">'+unitProgress+'<span>/'+unit.lessons.length+'</span></div>'
        +'</div>'
        +'<div class="vp-lessons">';
      unit.lessons.forEach((lesson,lIdx)=>{
        const key=unit.id+':'+lesson.id;
        const done=!!cur.progress[key];
        const stars=done?(cur.progress[key].stars||0):0;
        const unlocked=_voiceIsLessonUnlocked(unit.id,lesson.id,cur.progress);
        const cls=done?'vp-lesson-done':unlocked?'vp-lesson-open':'vp-lesson-locked';
        h+='<button class="vp-lesson '+cls+'" onclick="voiceLessonOpen('+unit.id+','+lesson.id+')">'
          +'<div class="vp-l-num">'+(done?'\\u2713':unlocked?lesson.id:'\\u{1F512}')+'</div>'
          +'<div class="vp-l-meta"><div class="vp-l-name">'+esc(lesson.name)+'</div>'+(done?'<div class="vp-l-stars">'+[1,2,3].map(n=>'<span'+(n<=stars?' class="on"':'')+'>\\u2605</span>').join('')+'</div>':'<div class="vp-l-stars vp-l-stars-empty">5 phrases \\u00B7 ~3 min</div>')+'</div>'
        +'</button>';
      });
      h+='</div></div>';
    });
    h+='</div>';
  }
  // Skill grid — Duolingo-style 5 categories with brand colors
  {
    const lc=S.coach&&S.coach.scenario?S.coach.scenario.id:null;
    const skills=[
      {k:'pronounce',e:'\\u{1F399}\\uFE0F',n:'Pronounce',lvl:'L'+((S.mg.progress.word&&S.mg.progress.word.level)||1)},
      {k:'vocab',e:'\\u{1F4DA}',n:'Vocabulary',lvl:'21 words'},
      {k:'grammar',e:'\\u{1F9E9}',n:'Grammar',lvl:'Daily'},
      {k:'conv',e:'\\u{1F4AC}',n:'Conversation',lvl:(S.coach&&S.coach.history?S.coach.history.length:0)+' turns'},
      {k:'write',e:'\\u270D\\uFE0F',n:'Writing',lvl:'Beta'}
    ];
    h+='<div class="vc-skills">';
    skills.forEach(s=>{
      const click=s.k==='pronounce'?'document.getElementById(\\'vcPron\\')&&document.getElementById(\\'vcPron\\').scrollIntoView({behavior:\\'smooth\\',block:\\'center\\'})':s.k==='vocab'?'document.querySelector(\\'.vc-vocab-row\\')&&document.querySelector(\\'.vc-vocab-row\\').scrollIntoView({behavior:\\'smooth\\',block:\\'center\\'})':s.k==='conv'?'document.querySelector(\\'.cc-thread\\')&&document.querySelector(\\'.cc-thread\\').scrollIntoView({behavior:\\'smooth\\',block:\\'center\\'})':s.k==='grammar'?'coachSend(\\'Teach me one grammar rule that English learners get wrong most often, with three examples.\\')':'coachSend(\\'Help me write a polished email asking for a quick meeting next Tuesday.\\')';
      h+='<button class="vc-skill" data-k="'+s.k+'" onclick="'+click+'"><div class="vs-ic">'+s.e+'</div><div class="vs-name">'+s.n+'</div><div class="vs-lvl">'+s.lvl+'</div></button>';
    });
    h+='</div>';
  }
  // Pronunciation drill — daily phrase + record + score
  {
    const phrase=_voicePronOfDay();
    const pr=S.pron||{};
    h+='<div class="vc-pron" id="vcPron">'
      +'<div><div class="vc-pron-h">\\u{1F399}\\uFE0F Today\\u2019s pronunciation drill</div>'
      +'<div class="vc-pron-phrase">"'+esc(phrase)+'"</div>'
      +'<div class="vc-pron-meta">Tap <b>Listen</b> to hear it, then <b>Speak</b> to record. We score how close your version is.</div>'
      +(pr.result?'<div class="vc-pron-result '+(pr.result.pct>=80?'good':pr.result.pct>=50?'ok':'miss')+'"><b>'+pr.result.pct+'%</b> match \\u00B7 '+pr.result.matched+' of '+pr.result.total+' words. '+(pr.heard?'You said: <i>"'+esc(pr.heard)+'"</i>':'')+(pr.result.missed&&pr.result.missed.length?' \\u00B7 missed: '+pr.result.missed.slice(0,4).map(esc).join(', '):'')+'</div>':'')
      +'</div>'
      +'<div class="vc-pron-actions">'
        +'<button class="vc-pron-btn vc-pron-listen" onclick="voicePronListen()">\\u{1F50A} Listen</button>'
        +'<button class="vc-pron-btn vc-pron-rec'+(pr.recording?' recording':'')+'" onclick="voicePronRecord()">\\u{1F3A4} '+(pr.recording?'Listening\\u2026':'Speak')+'</button>'
      +'</div>'
    +'</div>';
  }
  // Hero
  h+='<section class="cc-hero">'
    +'<div class="cc-hero-orb"></div>'
    +'<div class="cc-hero-l"><div class="cc-hero-eyebrow">\\u{1F399}\\uFE0F BRODOIT \\u00B7 AI COACH</div>'
      +'<h1 class="cc-hero-t">Talk. Refine. Sound sharper.</h1>'
      +'<div class="cc-hero-s">A live Business English coach. Type or hit the mic \\u2014 your phone listens, the coach replies in a real human voice with vocabulary tips, polished rewrites, and follow-ups.</div>'
    +'</div>'
  +'</section>';
  // Tutor mode indicator — green when configured, an actionable setup card when not
  if(st.chat){
    h+='<div style="display:inline-flex;align-items:center;gap:8px;padding:7px 14px;background:rgba(31,77,63,.08);border:1px solid rgba(31,77,63,.22);border-radius:999px;font-family:\\'JetBrains Mono\\',\\'Space Mono\\',monospace;font-size:11px;font-weight:500;letter-spacing:.06em;color:#1F4D3F;text-transform:uppercase;margin-bottom:14px"><span style="width:6px;height:6px;border-radius:999px;background:#10B981;box-shadow:0 0 8px #10B981;animation:wn-pulse 2s ease-in-out infinite"></span>AI tutor \\u00B7 ready</div>';
  }
  // (AI-not-configured banner removed — local pronunciation drill + curriculum work
  // independently. The free-form chat at the bottom still needs ANTHROPIC_API_KEY for
  // intelligent replies; users discover that organically when they try it.)
  // Scenarios
  h+='<div class="cc-scenarios"><div class="cc-scenarios-t">\\u26A1 Pick a scenario \\u2014 or just chat below</div><div class="cc-scenario-row">';
  COACH_SCENARIOS.forEach((sc,i)=>{const on=c.scenario&&c.scenario.id===sc.id;h+='<button class="cc-sc'+(on?' cc-sc-on':'')+'" onclick="coachStartScenarioByIdx('+i+')">'+esc(sc.title)+'</button>'});
  h+='</div></div>';
  if(c.scenario)h+='<div class="cc-active-scenario">\\u{1F3AD} Roleplay: <b>'+esc(c.scenario.title)+'</b> <button class="cc-end" onclick="coachReset()">End \\u2715</button></div>';
  // Chat thread
  h+='<div class="cc-thread" id="ccThread">';
  (c.history||[]).forEach((m,i)=>{
    const role=m.role==='assistant'?'coach':'me';
    h+='<div class="cc-msg cc-'+role+'">'
      +(role==='coach'?'<div class="cc-avatar">\\u{1F399}\\uFE0F</div>':'')
      +'<div class="cc-bubble">'+esc(m.content).replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\n/g,'<br>')+(role==='coach'&&i===c.history.length-1?'<button class="cc-replay" onclick="coachReplayLast()" title="Replay">\\u{1F50A}</button>':'')+'</div>'
    +'</div>';
  });
  if(c.sending)h+='<div class="cc-msg cc-coach"><div class="cc-avatar">\\u{1F399}\\uFE0F</div><div class="cc-bubble cc-typing"><span></span><span></span><span></span></div></div>';
  h+='</div>';
  // Composer (with live waveform when recording)
  if(c.recording){
    h+='<div class="cc-composer cc-composer-rec">'
      +'<canvas id="ccWave" class="cc-wave"></canvas>'
      +'<button class="cc-mic cc-rec" onclick="coachStartRec()" aria-label="Stop">\\u23F9</button>'
    +'</div>';
  } else {
    h+='<div class="cc-composer">'
      +'<textarea id="coachInput" placeholder="Type your message\\u2026 or tap the mic" rows="1" oninput="S.coach.input=this.value;this.style.height=\\'auto\\';this.style.height=Math.min(120,this.scrollHeight)+\\'px\\'" onkeydown="if(event.key===\\'Enter\\'&&!event.shiftKey){event.preventDefault();coachSend()}">'+esc(c.input||'')+'</textarea>'
      +'<button class="cc-mic" onclick="coachStartRec()" aria-label="Record" title="Tap to record">\\u{1F3A4}</button>'
      +'<button class="cc-send" onclick="coachSend()" '+(c.sending||(!c.input||!c.input.trim())?'disabled':'')+' aria-label="Send">\\u2192</button>'
    +'</div>';
  }
  // Quick actions
  h+='<div class="cc-quick">'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'Teach me 3 advanced business words I can use today.\\')">3 advanced words</button>'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'Quiz me on idioms used in meetings.\\')">Idioms quiz</button>'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'How do I sound more confident in presentations?\\')">Confidence tips</button>'
    +(c.history.length>1?'<button class="cc-quick-btn cc-quick-reset" onclick="coachReset()">\\u21BB Restart</button>':'')
  +'</div>';
  if(c.playing)h+='<div class="cc-playing">\\u{1F50A} Coach is speaking\\u2026 <button onclick="coachStopSpeak()">stop</button></div>';
}

// BOARD TAB (Kanban: To Do / Doing / Done with drag-and-drop)
else if(S.tab==='board'){
  // Boards UI removed — unified task list across Tasks and Board tabs.
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
  if(!S.newsMode)S.newsMode='headlines';
  const cats=[{k:'world',l:'World',ic:'globe'},{k:'tech',l:'Tech & AI',ic:'tech'},{k:'sports',l:'Sports',ic:'sport'}];
  h+='<div class="news-hero"><div class="news-hero-l"><span class="news-hero-ic">'+ic('news',22)+'</span><div><h2>News &amp; Stories</h2><p>Fresh headlines \\u2022 Articles by the community</p></div></div>'+(S.newsMode==='community'?'<button class="news-refresh" onclick="openArticleEditor()" title="Write an article" style="background:#1A1A1A;color:#fff"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Write</button>':'<button class="news-refresh" onclick="loadNews(S.newsCat)" title="Refresh">'+ic('refresh',18)+'</button>')+'</div>';
  // Mode toggle: Headlines vs Community articles
  h+='<div class="bk-mode-toggle"><button class="'+(S.newsMode==='headlines'?'on':'')+'" onclick="S.newsMode=\\'headlines\\';render()">\\u{1F4F0} Headlines</button><button class="'+(S.newsMode==='community'?'on':'')+'" onclick="S.newsMode=\\'community\\';if(!S.articles)loadArticles(\\'all\\');render()">\\u270D\\uFE0F Community</button></div>';
  if(S.newsMode==='community'){
    if(!S.articles&&!S.articlesLoading){loadArticles('all')}
    const acats=['all','tech','business','life','wellness','culture','opinion'];
    h+='<div class="flt flt-icons" style="margin-bottom:14px">';
    acats.forEach(c=>{h+='<button class="fb'+((S.articlesCat||'all')===c?' on':'')+'" onclick="loadArticles(\\''+c+'\\')">'+(c.charAt(0).toUpperCase()+c.slice(1))+'</button>'});
    h+='</div>';
    if(S.articlesLoading&&!(S.articles||[]).length){h+='<div class="loading">\\u{1F4DD} Loading articles\\u2026</div>'}
    else if(!(S.articles||[]).length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DD}</div><div style="font-size:16px;margin-top:12px;font-weight:600">No articles in this category yet</div><div style="font-size:13px;margin-top:6px;color:var(--ink-3)">Be the first to write one</div><button class="mb mb-s" style="margin-top:16px;background:#1A1A1A" onclick="openArticleEditor()">\\u270D\\uFE0F Write the first article</button></div>'}
    else{
      h+='<div class="art-feed">';
      S.articles.forEach(a=>{
        const when=timeAgo(a.created_at?a.created_at.replace(' ','T')+'Z':null);
        const initial=(a.author_name||'A').charAt(0).toUpperCase();
        h+='<article class="art-card" onclick="openArticleReader(\\''+a.id+'\\')">';
        if(a.image_url)h+='<div class="art-img"><img src="'+esc(a.image_url)+'" loading="lazy" onerror="this.parentElement.style.display=\\'none\\'"></div>';
        h+='<div class="art-body"><div class="art-cat">'+esc(a.category||'general')+'</div><h3 class="art-title">'+esc(a.title)+'</h3><p class="art-preview">'+esc(a.preview||'')+'</p>'
          +'<div class="art-meta"><span class="art-author"><span class="art-avatar">'+initial+'</span>'+esc(a.author_name||'Anonymous')+'</span>'
          +'<span class="art-dot">\\u00B7</span><span class="art-time">'+esc(when||'')+'</span>'
          +'<span class="art-dot">\\u00B7</span><span class="art-readtime">'+a.read_min+' min read</span>'
          +'<button class="art-like" onclick="event.stopPropagation();likeArticle(\\''+a.id+'\\')">\\u2661 '+a.likes+'</button></div>'
          +'</div></article>';
      });
      h+='</div>';
    }
  } else {
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
  } // end newsMode==='headlines'
}

// BOOKS TAB
else if(S.tab==='books'){
  const bs=S.bookStreak||{streak:0,total:0,today:false};
  if(!S.booksMode)S.booksMode='summaries';
  h+='<div class="section-hd"><span class="section-ic">'+ic('books',22)+'</span><div><h3>Books</h3><p>15-minute summaries to read \\u2022 audiobooks to listen \\u2022 keep your streak alive</p></div></div>';
  h+='<div class="streak-card"><div class="streak-ico">'+ic('flame',24)+'</div><div class="streak-body"><div class="streak-n">'+bs.streak+'<span>day'+(bs.streak===1?'':'s')+'</span></div><div class="streak-lbl">Reading streak'+(bs.today?' \\u2022 done today \\u2705':'')+'</div></div><div class="streak-tot"><b>'+bs.total+'</b><small>total days</small></div></div>';
  // Mode toggle: summaries vs audiobooks
  h+='<div class="bk-mode-toggle"><button class="'+(S.booksMode==='summaries'?'on':'')+'" onclick="S.booksMode=\\'summaries\\';render()">\\u2728 15-min summaries</button><button class="'+(S.booksMode==='audiobooks'?'on':'')+'" onclick="S.booksMode=\\'audiobooks\\';render()">\\u{1F3A7} Audiobooks</button></div>';
  if(S.booksMode==='summaries'){
    // Featured book hero (Blinkist-style) — picks one based on day-of-year so it rotates daily
    {
      const d=new Date();const yStart=new Date(d.getFullYear(),0,0);const day=Math.floor((d-yStart)/86400000);
      const featured=BOOK_SUMMARIES[day%BOOK_SUMMARIES.length];
      h+='<div class="bk-hero">'
        +'<div>'
          +'<div class="bk-hero-tag">\\u2728 Featured today \\u00B7 '+featured.mins+' min</div>'
          +'<h2>'+esc(featured.title)+'</h2>'
          +'<div class="bk-hero-author">By '+esc(featured.author)+'</div>'
          +'<p class="bk-hero-why">'+esc(featured.why)+'</p>'
          +'<div class="bk-hero-actions">'
            +'<button class="bk-hero-go" onclick="openBookSummary(\\''+featured.id+'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg> Listen now</button>'
            +'<button class="bk-hero-go" style="background:rgba(255,255,255,.16);color:#fff" onclick="openBookSummary(\\''+featured.id+'\\')">Read summary</button>'
          +'</div>'
        +'</div>'
        +'<div class="bk-hero-cover" style="background:'+featured.grad+'">'
          +'<div class="auth">'+esc(featured.author)+'</div>'
          +'<h5>'+esc(featured.title)+'</h5>'
        +'</div>'
      +'</div>';
    }
    // Category filter pills
    {
      if(!S.bkCat)S.bkCat='all';
      const cats=[{k:'all',l:'All'},{k:'productivity',l:'Productivity'},{k:'focus',l:'Focus'},{k:'mind',l:'Mind'},{k:'stoic',l:'Stoic'}];
      h+='<div class="bk-cats">';
      cats.forEach(c=>{h+='<button class="bk-cat'+(S.bkCat===c.k?' on':'')+'" onclick="S.bkCat=\\''+c.k+'\\';render()">'+c.l+'</button>'});
      h+='</div>';
    }
    h+='<div class="bk-sum-grid">';
    const bkFiltered=S.bkCat&&S.bkCat!=='all'?BOOK_SUMMARIES.filter(b=>b.tag===S.bkCat):BOOK_SUMMARIES;
    bkFiltered.forEach(b=>{
      h+='<button class="bk-sum-card" onclick="openBookSummary(\\''+b.id+'\\')">';
      h+='<div class="bk-sum-cover" style="background:'+b.grad+'"><div class="bk-sum-mins">'+b.mins+' min</div><div></div><div><h5>'+esc(b.title)+'</h5><div class="auth">'+esc(b.author)+'</div></div></div>';
      h+='<div class="bk-sum-meta">'+esc(b.title)+'<small>'+esc(b.author)+'</small></div>';
      h+='</button>';
    });
    h+='</div>';
    h+='<div style="margin-top:18px;padding:18px 20px;border:1px dashed #E8E6E0;border-radius:14px;color:#6B6B6B;font-size:13px;line-height:1.55"><b style="color:#1A1A1A">Distilled, not dumbed down.</b> Each summary is a 12-15 minute read that captures the actual ideas \\u2014 not bullet trivia. Tap any cover, then tap <b style="color:#1F4D3F">Listen</b> to have it narrated aloud while you walk, drive, or wash dishes.</div>';
  } else {
    h+='<div class="srch"><input id="bsearch" placeholder="Search audiobooks..." value="'+esc(S.bookSearch)+'" oninput="filterBooks(this.value)"></div>';
    h+='<div class="flt">'+[{k:'all',l:'All'},{k:'fiction',l:'Fiction'},{k:'self-help',l:'Self Development'},{k:'mystery',l:'Mystery'},{k:'philosophy',l:'Philosophy'},{k:'adventure',l:'Adventure'},{k:'kids',l:'Kids'}].map(c=>'<button class="fb'+(S.booksCat===c.k?' on':'')+'" onclick="loadBooks(\\''+c.k+'\\')">'+c.l+'</button>').join('')+'</div>';
    if(S.booksLoading)h+='<div class="loading">Loading audiobooks...</div>';
    else if(S.booksError){
      h+='<div class="empty"><div style="font-size:44px">\\u{1F4F6}</div><div style="font-size:15px;font-weight:600;margin-top:10px">'+esc(S.booksError)+'</div><div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap"><button class="mb mb-s" onclick="loadBooks(\\''+esc(S.booksCat||'all')+'\\')">\\u21BB Retry</button><button class="mb mb-c" onclick="S.booksMode=\\'summaries\\';render()">\\u2728 Switch to summaries</button></div></div>';
    }
    else{
      const q=S.bookSearch.toLowerCase().trim();
      const fb=!q?S.books:S.books.filter(b=>{const t=(Array.isArray(b.title)?b.title[0]:b.title||'').toLowerCase();const a=(Array.isArray(b.creator)?b.creator[0]:b.creator||'').toLowerCase();return t.includes(q)||a.includes(q)});
      h+='<div id="books-grid">'+renderBookCards(fb)+'</div>';
    }
  }
}

// MEDITATION TAB — three categories with 2 audios each (10 + 20 min)
else if(S.tab==='meditation'){
  const cat=S.medCat||'vipassana';
  h+='<div class="section-hd"><span class="section-ic">'+ic('meditation',22)+'</span><div><h3>Meditation</h3><p>Vipassana \\u2022 Music \\u2022 Guided \\u2022 short sittings in English</p></div></div>';
  // Category pills
  h+='<div class="mag-pills" style="margin-bottom:14px">';
  MED_CATEGORIES.forEach(c=>{h+='<button class="mag-pill'+(cat===c.k?' on':'')+'" onclick="setMedCat(\\''+c.k+'\\')"><span class="mag-pill-e">'+c.e+'</span>'+esc(c.l)+'</button>'});
  h+='</div>';
  if(S.medLoading&&!S.meditations)h+='<div class="loading">Finding meditations...</div>';
  h+='<div class="med-grid">';
  MED_SLOTS.filter(s=>s.cat===cat).forEach(x=>{
    const doc=(S.meditations||{})[x.directId];
    const ready=!!doc;
    const safeTitle=esc(x.title).replace(/\\\\u/g,'\\\\\\\\u').replace(/'/g,"\\\\'");const safeFile=(x.directFile||'').replace(/'/g,"\\\\'");const onclick=ready?('playMedDirect(\\''+x.directId+'\\',\\''+safeTitle+'\\','+x.mins+',\\''+safeFile+'\\')'):'toast(\\'\\u23F3 Loading audio...\\',\\'err\\')';
    h+='<button class="med-card'+(ready?'':' loading')+'" onclick="'+onclick+'" style="--mc:'+x.color+'">';
    h+='<div class="med-card-mins"><b>'+x.mins+'</b><small>min</small></div>';
    h+='<div class="med-card-body"><div class="med-card-title">'+esc(x.title)+'</div><div class="med-card-desc">'+esc(x.desc)+'</div></div>';
    h+='<div class="med-card-play">'+(ready?'<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>':'<div class="med-load-dot"></div>')+'</div>';
    h+='</button>';
  });
  h+='</div>';
  h+='<div class="med-foot">\\u{1F50A} Use headphones, find a quiet spot, and let the guide lead you.</div>';
}

// KNOWLEDGE TAB removed at user request (kept stub so saved state doesn't break)
else if(S.tab==='__obsolete_knowledge__'){
  const kn=S.knowledge;
  const today=new Date();
  const topicK=kn.topic||'history';
  const secK=kn.sec||'today';
  const tObj=getKnowledgeTopic(topicK);
  const sObj=getKnowledgeSec(topicK,secK);
  h+='<div class="section-hd"><span class="section-ic" style="background:linear-gradient(135deg,#B45309,#7C2D12)">'+ic('knowledge',22)+'</span><div><h3>Knowledge \\u2022 a magazine for the curious</h3><p>History \\u2022 Geography \\u2022 Space \\u2022 Karma &amp; Dharma</p></div></div>';
  // Top-level topic pills
  h+='<div class="mag-pills know-topics">';
  KNOWLEDGE_TOPICS.forEach(t=>{h+='<button class="mag-pill know-topic'+(topicK===t.k?' on':'')+'" onclick="switchKnowledgeTopic(\\''+t.k+'\\')"><span class="mag-pill-e">'+t.e+'</span>'+esc(t.l)+'</button>'});
  h+='</div>';
  // Sub-section pills (changes with topic)
  h+='<div class="mag-pills know-subs">';
  tObj.sections.forEach(s=>{h+='<button class="mag-pill mag-pill-sub'+(secK===s.k?' on':'')+'" onclick="loadKnowledge(\\''+topicK+'\\',\\''+s.k+'\\')"><span class="mag-pill-e">'+s.e+'</span>'+esc(s.l)+'</button>'});
  h+='</div>';
  const cacheKey=topicK+':'+secK;
  if(kn.loading&&!kn.loaded[cacheKey]){h+='<div class="loading">\\u{1F4DA} Loading articles\\u2026</div>';}
  else if(topicK==='history'&&secK==='today'){
    const dayStr=today.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    h+='<div class="mag-section-ttl"><span>'+esc(dayStr)+' \\u2014 events on this day</span></div>';
    if(!kn.events.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DC}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No events loaded</div></div>';}
    else{
      h+='<div class="hist-feed">';
      kn.events.slice(0,20).forEach(ev=>{
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
    const arts=kn.articles[cacheKey]||[];
    h+='<div class="mag-section-ttl"><span>'+esc(tObj.l)+' \\u2022 '+esc(sObj.l)+'</span></div>';
    if(!arts.length){h+='<div class="empty"><div style="font-size:44px">\\u{1F4DA}</div><div style="font-size:15px;margin-top:10px;font-weight:600">No articles yet</div><div style="font-size:12px;margin-top:4px">Try refreshing</div></div>';}
    else{
      h+='<div class="mag-grid">';
      arts.forEach((a,i)=>{
        h+='<article class="mag-card" style="animation-delay:'+(i*0.05)+'s">';
        if(a.thumb)h+='<div class="mag-card-img"><img src="'+esc(a.thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add(\\'mag-card-img-empty\\');this.remove()"></div>';
        else h+='<div class="mag-card-img mag-card-img-empty">'+esc(tObj.e)+'</div>';
        h+='<div class="mag-card-body"><div class="mag-card-kicker">'+esc(tObj.l)+' \\u2022 '+esc(sObj.l)+'</div>';
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



h+='</main>';
// Global FAB+ — always rendered, fixed-position, bouncy animation. Adapts behavior per tab.
{
  const isTaskTab=S.tab==='tasks'||S.tab==='board';
  const isCalTab=S.tab==='cal';
  const action=isTaskTab?'opA()':(isCalTab?'calAddForDate()':"switchTab('tasks');setTimeout(opA,80)");
  const lbl=isTaskTab?'Add a new task':(isCalTab?'Add to calendar':'Add a task');
  h+='<button class="fab fab-global" onclick="'+action+'" aria-label="'+lbl+'" title="'+lbl+'">+</button>';
}

// Player bar (any tab)
if(S.playing){
  h+='<div class="player on"><div class="player-info"><div class="player-title">'+esc(S.playing.title)+'</div><div class="player-author">'+esc(S.playing.author)+(S.playing.external?' \\u2022 <a href="'+esc(S.playing.external)+'" target="_blank" style="color:#3DAE5C;text-decoration:none">Open \\u2197</a>':'')+'</div></div>';
  if(S.playing.url)h+='<audio id="audioEl" controls preload="auto" src="'+esc(S.playing.url)+'"></audio>';
  else if(S.playing.error)h+='<span style="font-size:11px;color:#E8453C">\\u26A0\\uFE0F '+esc(S.playing.error)+'</span>';
  else h+='<span style="font-size:11px;color:#94A3B8">Loading\\u2026</span>';
  h+='<button class="player-close" onclick="closePlayer()">\\u2715</button></div>';
}

if(S.toast)h+='<div class="toast toast-'+(S.toastType==='err'?'err':'ok')+'">'+S.toast+'</div>';
// Confetti — fires for 1.5s after S._mgConfetti is set
if(S._mgConfetti&&Date.now()-S._mgConfetti<1500){
  h+='<div class="mg-confetti"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
  setTimeout(()=>{S._mgConfetti=null;render()},1600);
}

// ═══ Persistent book mini-player (Spotify-style) — keeps audio playing when reader is closed ═══
if(S.bkMini&&S.bkMini.book){
  const m=S.bkMini.book;
  const isPaused=S.bkMini.paused;
  h+='<div class="bk-mini" onclick="bkMiniReopen()" style="--bm-grad:'+m.grad.replace(/"/g,'&quot;')+'">'
    +'<div class="bk-mini-cover" style="background:'+m.grad+'"></div>'
    +'<div class="bk-mini-info"><b>'+esc(m.title)+'</b><small>'+esc(m.author)+(S.bkMini.usingEleven?' \\u00B7 STUDIO':' \\u00B7 BROWSER')+'</small></div>'
    +'<button class="bk-mini-btn'+(isPaused?'':' bk-mini-pulse')+'" onclick="event.stopPropagation();bkMiniToggle()" aria-label="'+(isPaused?'Resume':'Pause')+'">'+(isPaused?'\\u25B6':'\\u23F8')+'</button>'
    +'<button class="bk-mini-x" onclick="event.stopPropagation();bkMiniClose()" aria-label="Stop">\\u2715</button>'
  +'</div>';
}

// ═══ ARTICLE EDITOR (Medium-style writing) ═══
if(S.articleEditor&&S.articleEditor.open){
  const e=S.articleEditor;
  h+='<div class="ae-overlay" onclick="if(event.target===this)closeArticleEditor()"><div class="ae-box">';
  h+='<header class="ae-top"><div><div class="ae-tag">WRITE A STORY</div><div class="ae-h">Share an idea with the community</div></div><button class="vl-x" onclick="closeArticleEditor()">\\u2715</button></header>';
  h+='<div class="ae-body">';
  h+='<input class="ae-title" placeholder="Title" maxlength="180" value="'+esc(e.title)+'" oninput="S.articleEditor.title=this.value">';
  h+='<input class="ae-image" placeholder="Image URL (optional, https://...)" value="'+esc(e.image_url)+'" oninput="S.articleEditor.image_url=this.value">';
  if(e.image_url&&/^https?:\\/\\//i.test(e.image_url))h+='<div class="ae-img-prev"><img src="'+esc(e.image_url)+'" onerror="this.parentElement.style.display=\\'none\\'"></div>';
  h+='<div class="ae-cats">';
  ['tech','business','life','wellness','culture','opinion','general'].forEach(c=>{
    h+='<button class="ae-cat'+(e.category===c?' on':'')+'" onclick="S.articleEditor.category=\\''+c+'\\';render()">'+(c.charAt(0).toUpperCase()+c.slice(1))+'</button>';
  });
  h+='</div>';
  h+='<textarea class="ae-text" placeholder="Tell your story... (min 50 characters)" rows="14" oninput="S.articleEditor.body=this.value">'+esc(e.body)+'</textarea>';
  const len=e.body.length;
  h+='<div class="ae-meta"><span>'+len+' characters \\u00B7 '+Math.max(1,Math.round(len/1200))+' min read</span><span>Markdown not supported \\u2014 plain text only</span></div>';
  h+='</div>';
  h+='<footer class="ae-foot"><button class="vl-btn vl-btn-ghost" onclick="closeArticleEditor()">Cancel</button><button class="vl-btn vl-btn-primary" onclick="saveArticle()" '+(e.saving||!e.title||e.body.length<50?'disabled':'')+'>'+(e.saving?'Publishing...':'Publish article')+'</button></footer>';
  h+='</div></div>';
}

// ═══ ARTICLE READER ═══
if(S.articleReader){
  if(S.articleReader.loading){
    h+='<div class="ar-overlay" onclick="if(event.target===this)closeArticleReader()"><div class="ar-box"><div style="padding:60px;text-align:center;color:#9A9A9A">Loading...</div></div></div>';
  } else if(S.articleReader.article){
    const a=S.articleReader.article;
    const when=timeAgo(a.created_at?a.created_at.replace(' ','T')+'Z':null);
    const initial=(a.author_name||'A').charAt(0).toUpperCase();
    const readMin=Math.max(1,Math.round((a.body||'').length/1200));
    h+='<div class="ar-overlay" onclick="if(event.target===this)closeArticleReader()"><div class="ar-box">';
    h+='<button class="ar-x" onclick="closeArticleReader()">\\u2715</button>';
    if(a.image_url)h+='<div class="ar-hero"><img src="'+esc(a.image_url)+'" onerror="this.parentElement.style.display=\\'none\\'"></div>';
    h+='<div class="ar-body">';
    h+='<div class="ar-cat">'+esc(a.category||'general').toUpperCase()+'</div>';
    h+='<h1 class="ar-title">'+esc(a.title)+'</h1>';
    h+='<div class="ar-meta"><span class="ar-author"><span class="ar-avatar">'+initial+'</span>'+esc(a.author_name||'Anonymous')+'</span><span>\\u00B7</span><span>'+esc(when||'')+'</span><span>\\u00B7</span><span>'+readMin+' min read</span></div>';
    h+='<div class="ar-content">';
    String(a.body||'').split(/\\n\\n+/).forEach(p=>{h+='<p>'+esc(p).replace(/\\n/g,'<br>')+'</p>'});
    h+='</div>';
    h+='<div class="ar-foot"><button class="ar-like" onclick="likeArticle(\\''+a.id+'\\')">\\u2661 '+a.likes+' likes</button><span style="color:#9A9A9A;font-size:13px">Thanks for reading</span></div>';
    h+='</div></div></div>';
  }
}

// ═══ VOICE LESSON RUNNER ═══
if(S.voiceLesson&&S.voiceLesson.lesson){
  const p=S.voiceLesson;const total=p.lesson.drills.length;const cur=p.idx+1;const drill=p.lesson.drills[p.idx]||'';
  h+='<div class="vl-overlay" onclick="if(event.target===this)voiceLessonClose()"><div class="vl-box" style="--vl-c:'+p.unit.color+'">';
  h+='<header class="vl-top"><div><div class="vl-tag">UNIT '+p.unit.id+' \\u00B7 '+esc(p.unit.name).toUpperCase()+'</div><div class="vl-h">'+esc(p.lesson.name)+'</div></div><button class="vl-x" onclick="voiceLessonClose()">\\u2715</button></header>';
  h+='<div class="vl-progress"><div class="vl-progress-fill" style="width:'+((p.scores.filter(s=>s!=null).length/total)*100)+'%"></div></div>';
  if(p.phase==='done'){
    const stars=p.finalScore>=85?3:p.finalScore>=65?2:p.finalScore>=40?1:0;
    h+='<div class="vl-end"><div class="vl-end-stars">'+[1,2,3].map(n=>'<span'+(n<=stars?' class="on"':'')+'>\\u2605</span>').join('')+'</div>';
    h+='<div class="vl-end-h">'+(stars===3?'Beautiful work':stars===2?'Strong effort':stars===1?'Good start':'Try again')+'</div>';
    h+='<div class="vl-end-s"><b>'+p.finalScore+'%</b> average across '+total+' phrases</div>';
    h+='<div class="vl-end-acts"><button class="vl-btn vl-btn-ghost" onclick="voiceLessonClose()">Done</button><button class="vl-btn vl-btn-primary" onclick="voiceLessonOpen('+p.unit.id+','+p.lesson.id+')">\\u21BB Try again</button></div></div>';
  } else {
    h+='<div class="vl-body">'
      +'<div class="vl-step">Phrase '+cur+' of '+total+'</div>'
      +'<div class="vl-phrase">"'+esc(drill)+'"</div>'
      +'<div class="vl-actions">'
        +'<button class="vl-btn vl-btn-ghost" onclick="voiceLessonListen()">\\u{1F50A} Listen</button>'
        +'<button class="vl-btn vl-btn-rec'+(p.recording?' recording':'')+'" onclick="voiceLessonRecord()">\\u{1F3A4} '+(p.recording?'Listening\\u2026':'Speak')+'</button>'
      +'</div>';
    if(p.lastScore){
      const sc=p.lastScore;
      h+='<div class="vl-result vl-r-'+(sc.pct>=80?'good':sc.pct>=50?'ok':'miss')+'">'
        +'<div class="vl-r-pct">'+sc.pct+'%</div>'
        +'<div class="vl-r-meta">'+sc.matched+' of '+sc.total+' words matched</div>'
        +(p.heard?'<div class="vl-r-heard">You said: <i>"'+esc(p.heard)+'"</i></div>':'')
      +'</div>';
    }
    h+='<div class="vl-foot"><button class="vl-btn vl-btn-primary" onclick="voiceLessonNext()" '+(p.lastScore?'':'disabled')+'>'+(p.idx<total-1?'Next phrase \\u2192':'Finish lesson \\u2192')+'</button></div>';
    h+='</div>';
  }
  h+='</div></div>';
}
if(S.bookReader&&S.bookReader.open&&S.bookReader.book){
  const b=S.bookReader.book;const r=S.bookReader;
  h+='<div class="bk-reader" onclick="if(event.target===this)closeBookReader()"><div class="bk-reader-box">';
  h+='<header class="bk-reader-top"><span class="label">'+b.mins+'-MIN SUMMARY \\u00B7 '+esc(b.tag)+'</span><div style="display:flex;gap:8px">'+(r.playing?'<button class="bk-x" onclick="closeBookReader()" title="Minimize \\u2014 audio keeps playing in mini-player" style="background:#1F4D3F;color:#fff;border-color:#1F4D3F">\\u2014 Minimize</button>':'')+'<button class="bk-x" onclick="_premiumStop();S.bookReader={open:false};render()" title="Close and stop audio">\\u2715</button></div></header>';
  h+='<div class="bk-reader-hero"><div class="cover" style="background:'+b.grad+'"><div class="auth">'+esc(b.author)+'</div><h2>'+esc(b.title)+'</h2></div>';
  h+='<div class="info"><h1>'+esc(b.title)+'</h1><div class="by">By <b>'+esc(b.author)+'</b></div><p class="why">'+esc(b.why)+'</p>';
  h+='<div class="stats"><div><span class="num">'+b.insights.length+'</span><span class="lbl">Key insights</span></div><div><span class="num">'+b.mins+'m</span><span class="lbl">Read time</span></div><div><span class="num">'+(b.summary.length<2000?'\\u26A1':'\\u{1F4DA}')+'</span><span class="lbl">'+(b.summary.length<2000?'Quick':'Deep')+'</span></div></div>';
  h+='<div class="actions"><button class="bk-btn bk-btn-primary" onclick="bookReaderToggleTTS()">'+(r.playing?'\\u23F8 Pause':'\\u25B6\\uFE0F Listen')+'</button><button class="bk-btn bk-btn-ghost" onclick="document.getElementById(\\'bk-summary-anchor\\').scrollIntoView({behavior:\\'smooth\\'})">Read summary</button></div></div></div>';
  h+='<div class="bk-section"><h3>Key insights</h3>';
  b.insights.forEach((it,i)=>{h+='<div class="bk-insight"><div class="n">'+String(i+1).padStart(2,'0')+'</div><div><h4>'+esc(it[0])+'</h4><p>'+esc(it[1])+'</p></div></div>'});
  h+='</div>';
  h+='<div class="bk-section" id="bk-summary-anchor"><h3>The 15-minute summary</h3><div class="bk-summary"><p>'+esc(b.summary).split('. ').reduce((acc,s,i,a)=>{if(i===0)acc.push(s);else if(i%4===0)acc.push('</p><p>'+s);else acc.push('. '+s);return acc},[]).join('')+(b.summary.endsWith('.')?'':'.')+'</p></div></div>';
  // Upgrade prompt — only when ElevenLabs is NOT configured and user clicks Listen
  if(!(S.coach&&S.coach.status&&S.coach.status.tts)){
    h+='<div class="bk-section" style="padding-bottom:14px"><div style="padding:18px 22px;background:linear-gradient(135deg,#FFF8F2,#FFFFFF);border:1px solid #FFD0B5;border-radius:14px;display:flex;gap:14px;align-items:flex-start"><span style="font-size:24px">\\u{1F3AC}</span><div style="flex:1;font-size:13.5px;line-height:1.55;color:#3D3D3D"><b style="color:#1A1A1A;font-weight:600">Want a real human-quality narrator?</b><br/>The current voice is your browser\\u2019s built-in TTS \\u2014 functional, but robotic. Add an <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener" style="color:#1F4D3F;font-weight:600">ElevenLabs API key</a> to <code style="font-family:\\'JetBrains Mono\\',monospace;font-size:11px;background:rgba(0,0,0,.05);padding:2px 6px;border-radius:4px">ELEVENLABS_API_KEY</code> in your Railway env, redeploy, and the reader switches to studio-quality Adam (deep, warm, deliberate). Free tier covers ~10 books/month.</div></div></div>';
  }
  // Podcast-style audio bar with real progress, current line, elapsed time
  const prog=r.progress||{idx:0,total:0,line:'Tap play to begin'};
  const pctNow=prog.total?Math.round((prog.idx/prog.total)*100):0;
  const elapsedNow=r.startedAt&&r.playing?Math.floor((Date.now()-r.startedAt)/1000):0;
  const isStudio=!!(S.coach&&S.coach.status&&S.coach.status.tts);
  h+='<div class="bk-tts">'
    +'<button class="play" onclick="bookReaderToggleTTS()">'+(r.playing?'\\u23F8':'\\u25B6')+'</button>'
    +'<div class="info" style="overflow:hidden">'
      +'<b>'+esc(b.title)+' \\u00B7 by '+esc(b.author)+(isStudio?' <span style="display:inline-block;margin-left:6px;padding:2px 7px;background:rgba(31,77,63,.12);color:#1F4D3F;border-radius:6px;font-size:9px;font-weight:600;letter-spacing:.06em;font-family:\\'JetBrains Mono\\',monospace;text-transform:uppercase;vertical-align:1px">\\u{1F3AC} STUDIO</span>':' <span style="display:inline-block;margin-left:6px;padding:2px 7px;background:rgba(180,83,9,.12);color:#92400E;border-radius:6px;font-size:9px;font-weight:600;letter-spacing:.06em;font-family:\\'JetBrains Mono\\',monospace;text-transform:uppercase;vertical-align:1px">browser voice</span>')+'</b>'
      +'<small id="bkProgText">'+(r.playing?esc(String(prog.line||'').slice(0,90)):(isStudio?'Adam \\u00B7 ElevenLabs studio voice \\u00B7 ~'+b.mins+' min':'Soft male narrator \\u00B7 '+(r.rate||0.78)+'x \\u00B7 ~'+b.mins+' min'))+'</small>'
      +'<div style="height:3px;background:#ECEAE3;border-radius:999px;margin-top:6px;overflow:hidden"><div id="bkProgFill" style="height:100%;background:linear-gradient(90deg,#FF6B47,#FF8A4F);transform:scaleX('+(pctNow/100)+');transform-origin:left;transition:transform .4s ease"></div></div>'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.04em;color:#9A9A9A"><span id="bkProgTime">'+Math.floor(elapsedNow/60)+':'+String(elapsedNow%60).padStart(2,'0')+'</span><span id="bkProgPct">'+pctNow+'%</span></div>'
    +'</div>'
    +'<button class="speed" onclick="bookReaderSpeed()" title="Click to change speed">'+(r.rate||0.78).toFixed(2).replace(/\\.?0+$/,'')+'x</button>'
  +'</div>';
  h+='</div></div>';
}
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

  // ─── WhatsApp section ───
  const waPhone=p.wa_phone||'';
  const conn=S.waConn||null;
  h+='<div class="wa-sec">';
  h+='<div class="wa-sec-hd"><span class="wa-sec-emoji">\\u{1F4F2}</span><div><div class="wa-sec-t">WhatsApp</div><div class="wa-sec-s">Add tasks and get reminders by chat</div></div></div>';
  if(waPhone){
    h+='<div class="wa-linked">\\u2705 Connected to <b>'+esc(waPhone)+'</b><button class="wa-link-x" onclick="waUnlink()">Disconnect</button></div>';
  } else {
    h+='<button class="mb mb-s wa-connect-btn" onclick="waConnectStart()">\\u{1F517} Set up WhatsApp \\u2192</button>';
  }
  h+='</div>';

  // Backup / Restore section
  h+='<div class="bkp-sec"><div class="bkp-sec-hd"><span class="bkp-sec-emoji">\\u{1F4BE}</span><div><div class="bkp-sec-t">Backup your tasks</div><div class="bkp-sec-s">Download a JSON file of all your tasks. Auto-saved to this device on every load.</div></div></div>'
    +'<button class="mb mb-s bkp-btn" onclick="downloadBackup()">\\u2B07 Download backup (JSON)</button>'
    +(localStorage.getItem('tf_tasks_backup')?'<button class="mb mb-c bkp-btn" style="margin-top:8px" onclick="restoreFromBackup()">\\u21BB Restore from this device\\u2019s backup</button>':'')
  +'</div>';

  h+='<div class="macts" style="margin-top:22px"><button class="mb mb-c" onclick="closeProfile()">Close</button><button class="mb mb-d" style="margin-top:0" onclick="logout()">Log out</button></div>';
  h+='</div></div>';
}

// ─── HELP modal — full step-by-step guide ───
if(S.showHelp){
  const sandboxCode=window.__TWILIO_SANDBOX_CODE||'along-wool';
  h+='<div class="ov" onclick="closeHelp()"><div class="mdl help-mdl" onclick="event.stopPropagation()">';
  h+='<div class="help-hd"><div><h2 class="help-t">How to use Brodoit</h2><div class="help-s">Everything you need, step by step</div></div><button class="help-x" onclick="closeHelp()" aria-label="Close">\\u2715</button></div>';
  h+='<div class="help-body">';

  // Section 1 — Adding tasks
  h+='<section class="help-sec"><div class="help-sec-hd"><span class="help-sec-num">1</span><h3 class="help-sec-t">Add a task</h3></div>'
    +'<ol class="help-list">'
      +'<li>Open the <b>Tasks</b> tab (the first tab in the bar at the top).</li>'
      +'<li>Tap the big <b>+ Add a new task</b> bar near the top of the page.</li>'
      +'<li>Type the task title. Optionally add notes, priority, a due date and a reminder time.</li>'
      +'<li>Use the <b>\\u{1F3A4} Speak to add</b> button to dictate the task instead of typing. Phrases like <i>"Buy groceries tomorrow urgent"</i> auto-set the date and priority.</li>'
      +'<li>Tap <b>Add Task</b> to save. The task appears at the top of the list.</li>'
    +'</ol></section>';

  // Section 2 — Manage on Board
  h+='<section class="help-sec"><div class="help-sec-hd"><span class="help-sec-num">2</span><h3 class="help-sec-t">Move tasks on the Board</h3></div>'
    +'<ol class="help-list">'
      +'<li>Tap the <b>Board</b> tab in the top bar.</li>'
      +'<li>You\\'ll see three columns: <b>To Do \\u2022 Doing \\u2022 Done</b>.</li>'
      +'<li><b>On desktop</b>: drag a task card from one column to another to change its status.</li>'
      +'<li><b>On mobile</b>: tap the small status badge on any task and it cycles To Do \\u2192 Doing \\u2192 Done.</li>'
      +'<li>Tap the round circle on the left of a task to mark it complete instantly. Tap again to undo.</li>'
    +'</ol></section>';

  // Section 3 — WhatsApp setup (with Twilio disclosure)
  h+='<section class="help-sec"><div class="help-sec-hd"><span class="help-sec-num">3</span><h3 class="help-sec-t">Connect WhatsApp</h3></div>'
    +'<div class="help-callout"><b>How this works:</b> Brodoit doesn\\'t talk to WhatsApp directly. We use <b>Twilio</b>, a third-party messaging gateway. Your messages flow <b>your WhatsApp \\u2192 Twilio \\u2192 Brodoit\\u2019s server</b> and back. You opt in once per phone, then it just works.</div>'
    +'<ol class="help-list">'
      +'<li>Tap your <b>profile</b> button (top-right of the header).</li>'
      +'<li>Scroll down in the Profile and tap <b>\\u{1F517} Set up WhatsApp \\u2192</b>.</li>'
      +'<li><b>One-time setup</b>: open WhatsApp and send the message <b>join '+esc(sandboxCode)+'</b> to <b>+1 415 523 8886</b>. The pre-filled <b>Open WhatsApp</b> button does this for you.</li>'
      +'<li>Wait for a confirmation reply from Twilio (usually within a few seconds).</li>'
      +'<li>Back in Brodoit, pick your country code and type your WhatsApp number, then tap <b>Send code via WhatsApp</b>.</li>'
      +'<li>Open WhatsApp, find the 6-digit code, copy it, paste it into Brodoit, and tap <b>Verify &amp; connect</b>.</li>'
      +'<li>Done. Now you can:'
        +'<ul class="help-sublist">'
          +'<li>WhatsApp any message to <b>+1 415 523 8886</b> and it becomes a task.</li>'
          +'<li>Send a single task to your WhatsApp by tapping the <b>\\u{1F4F2}</b> icon next to it.</li>'
          +'<li>Send all your open tasks at once with <b>Send all tasks to WhatsApp</b>.</li>'
          +'<li>Receive automatic reminders on WhatsApp at the scheduled time.</li>'
        +'</ul>'
      +'</li>'
      +'<li>WhatsApp commands (reply to any Brodoit message): <b>list</b>, <b>done <i>title</i></b>, <b>doing <i>title</i></b>, <b>delete <i>title</i></b>, <b>help</b>.</li>'
    +'</ol></section>';

  // Section 4 — Other features
  h+='<section class="help-sec"><div class="help-sec-hd"><span class="help-sec-num">4</span><h3 class="help-sec-t">More inside the app</h3></div>'
    +'<ul class="help-list">'
      +'<li><b>Calendar</b> tab: connect your Google account to see and add events without leaving Brodoit.</li>'
      +'<li><b>Books</b> tab: free public-domain audiobooks from the Internet Archive. Tap any book to play; a 2-minute listen counts toward your daily streak.</li>'
      +'<li><b>Meditate</b> tab: short guided meditations \\u2014 Vipassana breath-awareness and metta sessions, 10 or 20 minutes each.</li>'
      +'<li><b>News</b> tab: latest headlines across Tech, Sports and World, refreshed every 15 minutes.</li>'
      +'<li><b>Daily moral of the day</b>: a fresh quote on your Tasks landing every visit. Tap the \\u21BB button to rotate.</li>'
      +'<li><b>Voice dictation</b> works inside the New Task modal \\u2014 it parses dates and priorities automatically.</li>'
    +'</ul></section>';

  // Section 5 — Privacy & data
  h+='<section class="help-sec"><div class="help-sec-hd"><span class="help-sec-num">5</span><h3 class="help-sec-t">Privacy &amp; your data</h3></div>'
    +'<ul class="help-list">'
      +'<li>Login is <b>email-only OTP</b> \\u2014 no password to remember, no data shared with third parties.</li>'
      +'<li>Your tasks are stored on Brodoit\\u2019s server and tied only to your email.</li>'
      +'<li>WhatsApp messages pass through Twilio (the gateway). Brodoit never reads your WhatsApp chats outside our own number.</li>'
      +'<li>Read the full <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/terms" target="_blank" rel="noopener">Terms</a>.</li>'
    +'</ul></section>';

  h+='</div>';
  h+='<div class="help-foot"><button class="mb mb-s" onclick="closeHelp()">Got it</button></div>';
  h+='</div></div>';
}

// ─── Dedicated WhatsApp Setup modal ───
// State persisted to localStorage so iOS Safari suspending the tab while user fetches the OTP
// from WhatsApp doesn't drop them back to step 1. Overlay tap does NOT close (explicit X only).
// ─── MIND GYM gameplay modal ───
if(S.mgPlay){
  const p=S.mgPlay;
  h+='<div class="ov ov-locked"><div class="mdl mg-mdl">';
  h+='<div class="mg-hd"><div><h2 class="mg-t">'+(p.game==='math'?'\\u{1F522} Math Sprint':p.game==='memory'?'\\u{1F9E9} Memory Tap':p.game==='word'?'\\u{1F520} Word Sprint':'\\u26A1 Reaction')+' \\u2022 L'+p.level+'</h2><div class="mg-s">'+(p.game==='math'?'Solve 10 to win XP':p.game==='memory'?'Repeat the pattern \\u2014 it grows each round':p.game==='word'?'90 seconds. Find every word you can.':'Tap when the screen turns green')+'</div></div><button class="was-x" onclick="mgClose()">\\u2715</button></div>';

  if(p.game==='math'){
    if(p.done){
      const stars=p.score>=10?3:p.score>=8?2:p.score>=4?1:0;
      const starsHTML=[1,2,3].map(n=>'<span class="mt-star'+(n<=stars?' mt-star-on':'')+'">\\u2605</span>').join('');
      h+='<div class="mg-body mt-end">'
        +'<div class="mt-end-stars">'+starsHTML+'</div>'
        +'<div class="mt-end-t"><b>'+p.score+'</b> / 10 correct</div>'
        +'<div class="mt-end-s">Best streak: '+p.best+' \\u2022 +'+(p.score*5)+' XP saved</div>'
        +'<div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgMathStart()">\\u21BB Play again</button></div>'
      +'</div>';
    } else {
      const q=p.problem;
      const elapsed=(Date.now()-p.timeStart)/1000;
      const timePct=Math.max(0,Math.min(100,((p.timeMax-elapsed)/p.timeMax)*100));
      h+='<div class="ms-body">'
        // Stats bar
        +'<div class="ms-stats"><div class="ms-stat"><b>'+p.score+'</b><small>/10</small></div>'
          +'<div class="ms-stat ms-stat-streak'+(p.streak>=3?' ms-streak-hot':'')+'"><b>'+p.streak+'</b><small>streak</small></div>'
          +(p.combo>1?'<div class="ms-combo">x'+p.combo+'</div>':'')
        +'</div>'
        // Time pressure bar
        +'<div class="ms-time-track"><div class="ms-time-fill" id="msBar" style="width:'+timePct+'%"></div></div>'
        // Problem (slide-in animated via key)
        +'<div class="ms-problem-wrap"><div class="ms-problem" key="'+p.problemIdx+'"><span class="ms-num">'+q.a+'</span><span class="ms-op">'+q.op+'</span><span class="ms-num">'+q.b+'</span><span class="ms-eq">=</span><span class="ms-q">?</span></div></div>'
        // Choices
        +'<div class="ms-choices">';
      q.choices.forEach((c,idx)=>{
        let cls='ms-choice';
        if(p.feedback){
          if(c===q.ans)cls+=' ms-choice-ok';
          else if(c===p.feedbackChoice)cls+=' ms-choice-wrong';
          else cls+=' ms-choice-fade';
        }
        h+='<button class="'+cls+'" data-msc="'+c+'" onclick="mgMathAnswer('+c+')"'+(p.feedback?' disabled':'')+'>'+c+(p.feedback&&p.feedback.fast&&c===q.ans?'<span class="ms-bolt">\\u26A1</span>':'')+'</button>';
      });
      h+='</div>'
        +(p.feedback?'<div class="ms-fb '+(p.feedback.ok?'ms-fb-ok':'ms-fb-bad')+'">'+(p.feedback.ok?(p.feedback.fast?'\\u26A1 Lightning fast!':'\\u2705 '+p.feedback.msg):p.feedback.msg)+'</div>':'')
        +(p.bonus?'<div class="ms-bonus">\\u{1F389} '+esc(p.bonus.text)+'</div>':'')
      +'</div>';
    }
  } else if(p.game==='memory'){
    if(p.done){
      // Stars based on best round reached
      const stars=p.best>=8?3:p.best>=4?2:p.best>=1?1:0;
      const starsHTML=[1,2,3].map(n=>'<span class="mt-star'+(n<=stars?' mt-star-on':'')+'">\\u2605</span>').join('');
      h+='<div class="mg-body mt-end">'
        +'<div class="mt-end-stars">'+starsHTML+'</div>'
        +'<div class="mt-end-t">Reached <b>round '+p.best+'</b></div>'
        +'<div class="mt-end-s">+'+(p.best*5)+' XP saved \\u2022 Best run today</div>'
        +'<div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgMemoryStart()">\\u21BB Play again</button></div>'
      +'</div>';
    } else {
      // Canvas shell — _mtInit() will mount the engine after the DOM lands.
      h+='<div class="mt-shell">'
        +'<div class="mt-hud"><span class="mt-hud-l">ROUND <b>'+p.round+'</b></span><span class="mt-hud-r">BEST <b>'+p.best+'</b></span></div>'
        +'<canvas id="mtCanvas" class="mt-canvas"></canvas>'
      +'</div>';
    }
  } else if(p.game==='word'){
    if(p.done){
      const stars=p.foundSet.size>=10?3:p.foundSet.size>=6?2:p.foundSet.size>=3?1:0;
      const starsHTML=[1,2,3].map(n=>'<span class="mt-star'+(n<=stars?' mt-star-on':'')+'">\\u2605</span>').join('');
      h+='<div class="mg-body mt-end">'
        +'<div class="mt-end-stars">'+starsHTML+'</div>'
        +'<div class="mt-end-t">Found <b>'+p.foundSet.size+'</b> words \\u2022 <b>'+p.score+'</b> pts</div>'
        +'<div class="mt-end-s">Base word: <b>'+p.base+'</b> \\u2022 +'+Math.min(50,p.score)+' XP saved</div>'
        +(p.foundSet.size>0?'<div class="mw-found" style="margin-top:14px">'+[...p.foundSet].map(w=>'<span>'+w+'</span>').join('')+'</div>':'')
        +'<div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgWordStart()">\\u21BB Play again</button></div>'
      +'</div>';
    } else {
      const elapsed=(Date.now()-p.timeStart)/1000;
      const timePct=Math.max(0,Math.min(100,((p.timeMax-elapsed)/p.timeMax)*100));
      const cur=p.used.map(i=>p.letters[i]).join('');
      h+='<div class="mw-body">'
        +'<div class="mw-stats"><span><b>'+p.foundSet.size+'</b>words</span><span><b>'+p.score+'</b>points</span><span><b id="mwTime">'+Math.ceil(Math.max(0,p.timeMax-elapsed))+'</b>sec</span></div>'
        +'<div class="ms-time-track"><div class="ms-time-fill" id="mwBar" style="width:'+timePct+'%"></div></div>'
        +'<div class="mw-letters">';
      p.letters.forEach((c,i)=>{
        const used=p.used.indexOf(i)>=0;
        h+='<button class="mw-let'+(used?' used':'')+'" onclick="mgWordTap('+i+')">'+c+'</button>';
      });
      h+='</div>'
        +'<div class="mw-cur'+(p.feedback?(p.feedback.ok?' flash-good':' flash-bad'):'')+'">'+(p.feedback?p.feedback.msg:(cur||'Tap or type letters'))+'</div>'
        +'<div class="mw-acts"><button class="mw-btn" onclick="mgWordClear()">Clear</button><button class="mw-btn" onclick="mgWordBack()">\\u232B Back</button><button class="mw-btn mw-btn-primary" onclick="mgWordSubmit()">Submit \\u21B5</button></div>'
        +'<div class="mw-found">'
        +(p.foundSet.size===0?'<span class="empty">Found words appear here \\u2022 use keyboard or tap tiles</span>':[...p.foundSet].map(w=>'<span>'+w+'</span>').join(''))
      +'</div></div>';
    }
  } else if(p.game==='reaction'){
    h+='<div class="mg-body">';
    if(p.phase==='wait')h+='<div class="mg-react-stage mg-react-wait" onclick="mgReactionTap()"><div class="mg-react-msg">Wait for green\\u2026</div></div>';
    else if(p.phase==='go')h+='<div class="mg-react-stage mg-react-go" onclick="mgReactionTap()"><div class="mg-react-msg">TAP NOW!</div></div>';
    else if(p.phase==='early')h+='<div class="mg-react-stage mg-react-early"><div class="mg-react-msg">Too early!</div><div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgReactionStart()">\\u21BB Try again</button></div></div>';
    else if(p.phase==='done')h+='<div class="mg-react-stage mg-react-done"><div class="mg-react-time">'+p.time+'<small>ms</small></div><div class="mg-react-msg">'+(p.time<250?'Lightning! \\u26A1':p.time<350?'Excellent':p.time<500?'Good':p.time<700?'OK':'Try to focus')+'</div><div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgReactionStart()">\\u21BB Play again</button></div></div>';
    h+='</div>';
  }
  h+='</div></div>';
}

// ─── VOICE TRAINER lesson player ───
if(S.voicePlay){
  const p=S.voicePlay;const total=p.drills.length;const cur=p.idx+1;const drill=p.drills[p.idx]||'';const lastScore=typeof p.scores[p.idx]==='number'?p.scores[p.idx]:null;
  h+='<div class="ov ov-locked"><div class="mdl vc-mdl">';
  h+='<div class="vc-mdl-hd"><div><div class="vc-mdl-eyebrow">DAY '+p.day+' \\u2022 '+esc(p.phase)+' \\u2022 PHASE '+p.phase_num+'</div><h2 class="vc-mdl-t">'+esc(p.title)+'</h2></div><button class="was-x" onclick="voiceClose()">\\u2715</button></div>';
  h+='<div class="vc-mdl-progress"><div class="vc-mdl-progress-bar" style="width:'+Math.round((cur/total)*100)+'%"></div></div>';
  h+='<div class="vc-mdl-body">';
  // Coach intro
  h+='<div class="vc-coach"><div class="vc-coach-row"><span class="vc-coach-emoji">\\u{1F399}\\uFE0F</span><div class="vc-coach-name">AI Coach <small>'+(p.playingTTS?'speaking\\u2026':'tap to listen')+'</small></div><button class="vc-coach-btn" onclick="voicePlayIntro()">'+(p.playingTTS?'\\u23F8':'\\u25B6')+' Intro</button></div><div class="vc-coach-text">'+esc(p.intro)+'</div></div>';
  // Drill card
  h+='<div class="vc-drill-card"><div class="vc-drill-meta">Drill '+cur+' of '+total+'</div><div class="vc-drill-text">"'+esc(drill)+'"</div>';
  if(p.tip)h+='<div class="vc-drill-tip">\\u{1F4A1} '+esc(p.tip)+'</div>';
  h+='<div class="vc-drill-row"><button class="vc-drill-btn vc-drill-listen" onclick="voicePlayDrill()">\\u{1F50A} Listen</button><button class="vc-drill-btn vc-drill-rec'+(p.recording?' vc-rec-on':'')+'" onclick="voiceRecord()"'+(p.recording?' disabled':'')+'>\\u{1F3A4} '+(p.recording?'Listening\\u2026':'Tap & speak')+'</button></div>';
  if(p.heard)h+='<div class="vc-heard">You said: <i>"'+esc(p.heard)+'"</i></div>';
  if(lastScore!=null)h+='<div class="vc-score vc-score-'+(lastScore>=70?'good':lastScore>=40?'ok':'bad')+'">Match: <b>'+lastScore+'%</b> '+(lastScore>=70?'\\u{1F525}':lastScore>=40?'\\u{1F44D}':'try again')+'</div>';
  h+='</div>';
  // Nav
  h+='<div class="vc-mdl-nav"><button class="mb mb-c" onclick="voicePrevDrill()"'+(p.idx<=0?' disabled':'')+'>\\u2190 Prev</button>'+(p.idx>=total-1?'<button class="mb mb-s" onclick="voiceFinish()">\\u2713 Finish &amp; save</button>':'<button class="mb mb-s" onclick="voiceNextDrill()">Next \\u2192</button>')+'</div>';
  h+='</div></div></div>';
}

if(S.showWASetup){
  const conn=S.waConn||{step:'phone',cc:'+91'};
  const joined=localStorage.getItem('tf_wa_joined')==='1';
  const sandboxCode=window.__TWILIO_SANDBOX_CODE||'along-wool';
  const ccVal=conn.cc||'+91';
  const ccOpts=[['+91','\\u{1F1EE}\\u{1F1F3}'],['+1','\\u{1F1FA}\\u{1F1F8}'],['+44','\\u{1F1EC}\\u{1F1E7}'],['+61','\\u{1F1E6}\\u{1F1FA}'],['+971','\\u{1F1E6}\\u{1F1EA}'],['+65','\\u{1F1F8}\\u{1F1EC}']];
  const ccHTML=ccOpts.map(o=>'<option value="'+o[0]+'"'+(ccVal===o[0]?' selected':'')+'>'+o[1]+' '+o[0]+'</option>').join('');
  h+='<div class="ov ov-locked"><div class="mdl was-mdl">';
  h+='<div class="was-hd"><span class="was-emoji">\\u{1F4F2}</span><div><h2 class="was-t">Set up WhatsApp</h2><div class="was-s">'+(conn.step==='verify'?'Step 2 of 2 \\u2022 Enter the code':'Step 1 of 2 \\u2022 Enter your number')+'</div></div><button class="was-x" onclick="waConnectAbort()" aria-label="Close">\\u2715</button></div>';
  // progress indicator
  h+='<div class="was-progress"><div class="was-progress-bar" style="width:'+(conn.step==='verify'?'100%':'50%')+'"></div></div>';

  if(conn.step==='verify'){
    h+='<div class="was-body">'
      +'<div class="was-card-t">Enter the 6-digit code</div>'
      +'<div class="was-card-d">We sent it on WhatsApp to <b>'+esc(conn.phone||'')+'</b>. Switch to WhatsApp, copy the code, paste below \\u2014 your progress is saved if you switch apps.</div>'
      +'<input id="waSetupCode" class="was-code" type="tel" inputmode="numeric" maxlength="6" placeholder="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022" autocomplete="one-time-code" value="'+esc(conn.codeInput||'')+'" oninput="waConnCodeInput(this.value)">'
      +(conn.err?'<div class="was-err">'+esc(conn.err)+'</div>':'')
      +'<div class="was-acts"><button class="mb mb-c" onclick="S.waConn={step:\\'phone\\',cc:\\''+ccVal+'\\',phoneInput:\\''+esc(conn.phoneInput||'')+'\\'};_waPersist();render()">\\u2190 Wrong number?</button><button class="mb mb-s" onclick="waConnectVerify()"'+(conn.verifying?' disabled':'')+'>'+(conn.verifying?'Verifying\\u2026':'Verify &amp; connect')+'</button></div>'
      +'<button class="was-resend" onclick="waConnectSend()">\\u{1F501} Resend code</button>'
    +'</div>';
  } else {
    h+='<div class="was-body">';
    if(!joined){
      h+='<div class="was-helper"><div class="was-helper-t">\\u26A1 How this works \\u2014 first time only</div>'
        +'<div class="was-helper-d">Brodoit talks to WhatsApp through <b>Twilio</b>, a third-party messaging gateway. Your tasks flow: <b>your WhatsApp \\u2192 Twilio \\u2192 Brodoit</b> and back. Before Twilio will deliver our messages to you, you have to <b>opt in</b> by sending one short message:<br><br>1. Open WhatsApp<br>2. Send <b>join '+esc(sandboxCode)+'</b> to <b>+1 415 523 8886</b><br>3. Wait for the confirmation reply<br><br>That\\'s it \\u2014 you only do this <b>once per phone</b>. Tap the button below and the message is pre-filled for you.</div>'
        +'<div class="was-helper-acts"><button class="was-jb" onclick="waOpenJoin()">'+WI+' Open WhatsApp \\u2014 send join code</button><button class="was-skip" onclick="localStorage.setItem(\\'tf_wa_joined\\',\\'1\\');render()">Already did this \\u2192</button></div>'
      +'</div>';
    }else{
      h+='<div class="was-mini">\\u2705 Twilio bridge set up on this device <button class="was-mini-reset" onclick="localStorage.removeItem(\\'tf_wa_joined\\');render()">Redo</button></div>';
    }
    h+='<div class="was-card-t">Your WhatsApp number</div>'
      +'<div class="was-card-d">We\\'ll send a 6-digit code to confirm.</div>'
      +'<div class="was-row"><select id="waSetupCC" class="was-cc" onchange="waConnCcInput(this.value)">'+ccHTML+'</select>'
      +'<input id="waSetupPh" class="was-ph" type="tel" inputmode="tel" placeholder="98765 43210" autocomplete="tel-national" value="'+esc(conn.phoneInput||'')+'" oninput="waConnPhInput(this.value)"></div>'
      +(conn.err?'<div class="was-err">'+esc(conn.err)+(conn.needsJoin?' \\u2014 finish the one-time setup above first':'')+'</div>':'')
      +'<div class="was-acts"><button class="mb mb-c" onclick="waConnectAbort()">Cancel</button><button class="mb mb-s" onclick="waConnectSend()"'+(conn.sending?' disabled':'')+'>'+(conn.sending?'Sending\\u2026':'Send code via WhatsApp')+'</button></div>'
    +'</div>';
  }
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
// Board picker in form removed — single unified task list. Server defaults new tasks to 'home'.
if(isE)h+='<label class="lbl">Status</label><select onchange="S.form.status=this.value"><option value="pending"'+(S.form.status==='pending'?' selected':'')+'>To Do</option><option value="in-progress"'+(S.form.status==='in-progress'?' selected':'')+'>Doing</option><option value="done"'+(S.form.status==='done'?' selected':'')+'>Done</option></select>';
h+='<div class="macts"><button class="mb mb-c" onclick="clM()">Cancel</button><button class="mb mb-s" onclick="'+(isE?'savE()':'addT()')+'">'+(isE?'Update':'Add Task')+'</button></div>';
if(isE)h+='<button class="mb mb-d" onclick="del(\\''+S.editing+'\\');clM()">Delete</button>';
h+='</div></div>';}

h+=bottomBlock;
document.getElementById('app').innerHTML=h;
// Toggle a body class so the page reserves bottom space when the audio player is visible.
try{document.body.classList.toggle('audio-on',!!(S.playing&&(S.playing.url||S.playing.loading)))}catch(e){}
}
fetch('/api/config').then(r=>r.json()).then(c=>{window.__TWILIO_SANDBOX_CODE=c.sandboxCode||'';render()}).catch(()=>{});
applyTheme();
if(S.user){_waRestore();refreshSession();load();loadBookStreak();loadGoogleStatus();loadWeather();loadTicker();loadCityTemps();loadRemember();loadMindGym();coachInit();chk();setInterval(load,10000);setInterval(loadWeather,15*60*1000);setInterval(loadTicker,15*60*1000);setInterval(loadCityTemps,15*60*1000);setInterval(loadRemember,6*60*60*1000)}else render();
// When the user returns from Gmail/another app, re-restore the in-progress login if the displayed step
// doesn't match what the URL hash + localStorage say. Covers iOS Safari evicting the tab while she reads
// the OTP email. The URL hash (#otp) is the most durable signal — survives even a full tab kill + reload.
function _recoverLoginIfNeeded(){
  if(S.user||token)return;
  const hashSaysOtp=location.hash==='#otp';
  let saved=null;try{saved=JSON.parse(localStorage.getItem('tf_login_state')||'null')}catch(e){}
  const savedSaysOtp=!!(saved&&saved.step==='otp'&&saved.ts&&Date.now()-saved.ts<60*60*1000);
  const wantOtp=hashSaysOtp||savedSaysOtp;
  // Force OTP step if either signal says so AND we know who the user is.
  if(wantOtp){
    if(S.loginStep==='otp')return; // already showing it
    try{restoreLoginState()}catch(e){}
    // Prefill email/phone from any of the durable sources
    if(!S.loginEmail&&saved&&saved.email)S.loginEmail=saved.email;
    if(!S.loginEmail){try{S.loginEmail=localStorage.getItem('tf_email')||S.loginEmail||''}catch(e){}}
    if(!S.loginPhone&&saved&&saved.phone)S.loginPhone=saved.phone;
    if(S.loginEmail||S.loginPhone){
      S.loginStep='otp';
      // Re-stamp the hash in case the platform dropped it
      try{if(location.hash!=='#otp')history.replaceState(null,'','#otp')}catch(e){}
      render();
    }
    return;
  }
  if(!saved)return;
  if(S.loginStep===(saved?saved.step:'phone'))return;
  try{restoreLoginState()}catch(e){}
  render();
}
window.addEventListener('pageshow',function(e){_recoverLoginIfNeeded()});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')_recoverLoginIfNeeded()});
// Polling fallback — covers iOS Safari edge cases where neither pageshow nor visibilitychange fires reliably.
// Cheap (one localStorage read every 2s) and only acts if state actually drifts.
setInterval(_recoverLoginIfNeeded,2000);
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
  background_color:"#FAFAF7",
  theme_color:"#1A1816",
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

// Digital Asset Links for TWA (Google Play Store verification).
// ALWAYS includes both Play app-signing key (Google re-signs installs from Play with this)
// AND the upload key (used for local bubblewrap installs). Env var is additive, not a replacement.
app.get('/.well-known/assetlinks.json',(_,res)=>{
  const required=[
    'F2:F5:17:C9:ED:59:76:BE:E8:BB:49:18:A6:5F:D9:69:6A:FF:9C:61:F8:7F:C9:54:F8:33:A6:A2:3B:3C:45:F4',
    'EA:7E:0D:CB:02:DE:1B:07:45:EF:1B:2C:6B:3B:2F:22:4B:74:1C:19:0C:F2:4D:44:2B:AF:17:E5:E1:C7:C6:B3'
  ];
  const extra=(process.env.ANDROID_SHA256_FINGERPRINT||'').split(',').map(s=>s.trim()).filter(Boolean);
  const fps=[...new Set([...required,...extra])];
  res.json([{
    relation:["delegate_permission/common.handle_all_urls"],
    target:{
      namespace:"android_app",
      package_name:process.env.ANDROID_PACKAGE_NAME||"com.brodoit.twa",
      sha256_cert_fingerprints:fps
    }
  }]);
});

// Brand-aligned shared chrome for legal pages — matches the editorial palette of the main app
const LEGAL_CHROME=`<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#1A1816"><meta name="robots" content="index,follow"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;background:#FAFAF7;color:#1A1A1A;line-height:1.7;font-feature-settings:'cv11','ss01','ss03';letter-spacing:-.011em;font-weight:450;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;min-height:100vh}body::before{content:'';position:fixed;inset:-100px;pointer-events:none;z-index:0;background:radial-gradient(680px 480px at 8% 12%,rgba(31,77,63,.08),transparent 65%),radial-gradient(560px 440px at 92% 18%,rgba(180,83,9,.06),transparent 65%),radial-gradient(620px 460px at 50% 108%,rgba(31,77,63,.05),transparent 65%);filter:blur(20px)}.wrap{max-width:760px;margin:0 auto;padding:64px 24px 80px;position:relative;z-index:1}.crumb{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#6B6B6B;text-decoration:none;padding:6px 12px;border:1px solid #E8E6E0;border-radius:999px;background:#fff;transition:all .2s}.crumb:hover{color:#1F4D3F;border-color:#1F4D3F;transform:translateX(-2px)}.kicker{margin-top:32px;font-family:'JetBrains Mono','Space Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#1F4D3F}h1{font-family:'Instrument Serif','Playfair Display',Georgia,serif;font-weight:400;font-size:clamp(40px,6vw,64px);line-height:1.05;letter-spacing:-.025em;color:#1A1A1A;margin-top:8px}.lede{margin-top:18px;font-size:18px;line-height:1.55;color:#3D3D3D;max-width:580px}.updated{display:inline-block;margin-top:24px;padding:6px 12px;background:#E6EFEA;color:#0E2E25;border-radius:999px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}.hr{height:1px;background:#E8E6E0;margin:48px 0;border:0}h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:28px;line-height:1.15;letter-spacing:-.02em;margin-top:40px;color:#1A1A1A;display:flex;align-items:baseline;gap:14px}h2::before{content:attr(data-n);font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:500;color:#1F4D3F;letter-spacing:.05em;flex-shrink:0;width:32px;padding-top:8px;font-style:normal}p,li{font-size:16px;color:#3D3D3D;margin-top:14px}ul{margin-top:14px;padding-left:24px}li{padding-left:6px}strong,b{color:#1A1A1A;font-weight:600}a{color:#1F4D3F;text-decoration:underline;text-decoration-color:rgba(31,77,63,.3);text-underline-offset:3px;transition:text-decoration-color .2s}a:hover{text-decoration-color:#1F4D3F}.note{margin-top:20px;padding:18px 22px;background:#FFFFFF;border:1px solid #E8E6E0;border-radius:14px;color:#3D3D3D;font-size:15px;line-height:1.6}.foot{margin-top:64px;padding-top:32px;border-top:1px solid #E8E6E0;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;font-size:13px;color:#6B6B6B}.foot .links{display:flex;gap:18px}.foot a{color:#3D3D3D;text-decoration:none}.foot a:hover{color:#1F4D3F}@media (max-width:600px){h1{font-size:38px}h2{font-size:22px}h2::before{width:28px;font-size:11px}p,li{font-size:15px}}</style>`;
const LEGAL_FOOT=`<footer class="foot"><span>© 2026 Brodoit · Made with discipline.</span><div class="links"><a href="/">App</a><a href="/pricing">Pricing</a><a href="/about">About</a><a href="/changelog">Changelog</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:hello@brodoit.com">Contact</a></div></footer>`;
// Marketing chrome — extends LEGAL_CHROME with pricing-tier and feature-grid styles
const MARKETING_CHROME=LEGAL_CHROME+`<style>.hero-tag{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(31,77,63,.08);color:#1F4D3F;border:1px solid rgba(31,77,63,.18);border-radius:999px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;margin-bottom:24px}.hero-tag .pulse{width:6px;height:6px;border-radius:999px;background:#1F4D3F;box-shadow:0 0 8px #1F4D3F;animation:pulse 2.4s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}h1.huge{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(56px,9vw,104px);line-height:.95;letter-spacing:-.035em;margin-bottom:0}h1.huge em{font-style:italic;color:#1F4D3F}.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:60px}@media (max-width:840px){.tiers{grid-template-columns:1fr;gap:14px}}.tier{position:relative;padding:36px 30px;background:#fff;border:1px solid #E8E6E0;border-radius:20px;display:flex;flex-direction:column;gap:18px;transition:transform .35s cubic-bezier(.16,1,.3,1),border-color .25s,box-shadow .35s}.tier:hover{transform:translateY(-4px);border-color:#CFCFCF;box-shadow:0 14px 40px -16px rgba(26,26,26,.16)}.tier.featured{border-color:#1F4D3F;background:linear-gradient(180deg,#fff,#F4FBF6);box-shadow:0 16px 48px -18px rgba(31,77,63,.32)}.tier .ribbon{position:absolute;top:-12px;right:24px;background:#1F4D3F;color:#fff;padding:5px 12px;border-radius:999px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase}.tier .name{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B6B6B;font-weight:500}.tier h3{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:32px;line-height:1;color:#1A1A1A;margin-top:-4px}.price{display:flex;align-items:flex-start;gap:4px;margin-top:-2px}.price .dollar{font-size:22px;color:#6B6B6B;margin-top:8px;font-weight:400}.price .num{font-family:'Inter',sans-serif;font-size:60px;font-weight:600;letter-spacing:-.04em;color:#1A1A1A;line-height:.95}.price .suffix{font-size:13px;color:#6B6B6B;margin-top:auto;margin-bottom:9px;font-family:'JetBrains Mono',monospace;letter-spacing:.05em}.tier .blurb{font-size:14px;line-height:1.55;color:#3D3D3D;min-height:42px}.tier ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}.tier li{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.45;color:#1A1A1A}.tier li svg{flex-shrink:0;margin-top:3px;color:#1F4D3F}.tier li.muted{color:#9A9A9A}.tier li.muted svg{color:#CFCFCF}.tier .cta{margin-top:auto;padding:14px 22px;text-align:center;border-radius:12px;font-weight:600;font-size:14.5px;border:1.5px solid #E8E6E0;color:#1A1A1A;text-decoration:none;transition:all .25s;cursor:pointer;background:#fff}.tier .cta:hover{border-color:#1A1A1A;background:#FAFAF7;transform:translateY(-1px)}.tier.featured .cta{background:#1F4D3F;color:#fff;border-color:#1F4D3F}.tier.featured .cta:hover{background:#0E2E25}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:48px}@media (max-width:760px){.feature-grid{grid-template-columns:1fr}}.feat{padding:24px;background:#fff;border:1px solid #E8E6E0;border-radius:16px;transition:border-color .25s,transform .35s cubic-bezier(.16,1,.3,1)}.feat:hover{border-color:#CFCFCF;transform:translateY(-2px)}.feat .ic{width:42px;height:42px;border-radius:12px;background:rgba(31,77,63,.08);color:#1F4D3F;display:grid;place-items:center;margin-bottom:14px}.feat h4{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:22px;color:#1A1A1A;margin-bottom:6px}.feat p{font-size:14px;line-height:1.5;color:#3D3D3D;margin:0}.faq{display:flex;flex-direction:column;gap:10px;margin-top:36px}.faq details{background:#fff;border:1px solid #E8E6E0;border-radius:14px;padding:18px 22px;cursor:pointer;transition:border-color .25s}.faq details:hover{border-color:#CFCFCF}.faq details[open]{border-color:#1F4D3F;background:#F4FBF6}.faq summary{font-weight:500;font-size:15.5px;letter-spacing:-.005em;list-style:none;display:flex;justify-content:space-between;align-items:center;color:#1A1A1A}.faq summary::after{content:'+';font-size:22px;color:#1F4D3F;font-weight:300;transition:transform .25s;font-family:'JetBrains Mono',monospace}.faq details[open] summary::after{transform:rotate(45deg)}.faq p{margin-top:14px;font-size:14.5px;color:#3D3D3D;line-height:1.6}.cta-row{display:flex;flex-wrap:wrap;gap:12px;margin-top:36px;align-items:center}.btn-primary{display:inline-flex;align-items:center;gap:8px;padding:14px 26px;background:#1A1A1A;color:#fff;text-decoration:none;border-radius:12px;font-weight:500;font-size:15px;transition:background .25s,transform .2s;border:0;cursor:pointer;font-family:inherit}.btn-primary:hover{background:#1F4D3F;transform:translateY(-1px)}.btn-ghost{display:inline-flex;align-items:center;gap:8px;padding:14px 26px;background:#fff;color:#1A1A1A;text-decoration:none;border-radius:12px;font-weight:500;font-size:15px;border:1px solid #E8E6E0;transition:border-color .25s}.btn-ghost:hover{border-color:#1A1A1A}.proof{margin-top:48px;padding:28px;background:#fff;border:1px solid #E8E6E0;border-radius:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px;text-align:center}@media (max-width:560px){.proof{grid-template-columns:1fr;gap:14px}}.proof .num{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:36px;color:#1F4D3F;line-height:1}.proof .lbl{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6B6B6B;margin-top:6px}.changelog{display:flex;flex-direction:column;gap:24px;margin-top:32px}.cl-item{padding:24px;background:#fff;border:1px solid #E8E6E0;border-radius:14px;display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:flex-start}@media (max-width:600px){.cl-item{grid-template-columns:1fr}}.cl-date{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:#1F4D3F;background:rgba(31,77,63,.08);padding:6px 12px;border-radius:999px;width:fit-content;height:fit-content;white-space:nowrap}.cl-body h3{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-style:italic;font-size:22px;color:#1A1A1A;margin-bottom:8px}.cl-body p{font-size:14.5px;color:#3D3D3D;line-height:1.55;margin-top:6px}.cl-body ul{margin-top:12px;padding-left:22px;font-size:14.5px;color:#3D3D3D}.cl-body li{margin-top:5px;line-height:1.5}.about-quote{font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:clamp(22px,3vw,30px);line-height:1.35;color:#1A1A1A;padding:32px 0;border-top:1px solid #E8E6E0;border-bottom:1px solid #E8E6E0;margin:48px 0}</style>`;

// Privacy Policy (required by Play Store)
app.get('/privacy',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>${LEGAL_CHROME}<title>Privacy Policy — Brodoit</title><meta name="description" content="What Brodoit collects, why, and your rights. Plain-English privacy policy."></head><body><div class="wrap"><a class="crumb" href="/">← Back to Brodoit</a><div class="kicker">Legal · Privacy</div><h1>Privacy, plainly.</h1><p class="lede">We built Brodoit to be a calm, private place. This page explains exactly what we collect, why, and what we will never do. No dark patterns, no fine print.</p><span class="updated">Last updated · April 2026</span><hr class="hr"><h2 data-n="01">What we collect</h2><ul><li><strong>Email address</strong> or <strong>phone number</strong> — used only to authenticate you via a one-time verification code.</li><li><strong>Your name</strong> — displayed in your profile screen.</li><li><strong>Your tasks, notes, due dates, reminders</strong> — stored so we can show them back to you and send reminders on the times you set.</li><li><strong>Session token</strong> — a random string stored in your browser so you stay logged in.</li></ul><div class="note">We do <strong>not</strong> collect: your location, your contacts, advertising IDs, device IDs, photos, payment info, or any data we don't explicitly list above.</div><h2 data-n="02">How we use it</h2><ul><li>Deliver one-time codes by email or WhatsApp.</li><li>Show your tasks, books, and other content you've created.</li><li>Send reminders at the times you set.</li></ul><h2 data-n="03">Who we share with</h2><p>We share data only with the following service providers, strictly to operate the service:</p><ul><li><strong>Resend</strong> — to deliver verification emails (<a href="https://resend.com/privacy">privacy policy</a>).</li><li><strong>Twilio</strong> — to deliver WhatsApp messages (<a href="https://www.twilio.com/legal/privacy">privacy policy</a>).</li><li><strong>Railway</strong> — our hosting provider (<a href="https://railway.app/legal/privacy">privacy policy</a>).</li><li><strong>Internet Archive (LibriVox)</strong> — we fetch public-domain audiobook metadata. No personal data is sent.</li></ul><div class="note">We never sell your data. We never show ads. We never track you across other apps or sites.</div><h2 data-n="04">Data retention</h2><p>Your tasks and account persist until you delete them or ask us to delete your account. Verification codes expire after 5 minutes and are wiped after use.</p><h2 data-n="05">Your rights</h2><p>Email <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> any time to export your data, correct it, or permanently delete your account. We respond within seven days.</p><h2 data-n="06">Children</h2><p>Brodoit is not directed at children under 13. We do not knowingly collect data from children under 13. If you believe we have, please contact us and we will delete it immediately.</p><h2 data-n="07">Changes</h2><p>If we make material changes, we'll update the date at the top of this page and notify you by email if we have your address.</p><h2 data-n="08">Contact</h2><p>Questions about anything on this page? <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> — a real human reads every message.</p>${LEGAL_FOOT}</div></body></html>`);
});

// Terms of Service
app.get('/terms',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>${LEGAL_CHROME}<title>Terms of Service — Brodoit</title><meta name="description" content="The simple terms for using Brodoit. Plain English, no surprises."></head><body><div class="wrap"><a class="crumb" href="/">← Back to Brodoit</a><div class="kicker">Legal · Terms</div><h1>The simple rules.</h1><p class="lede">We've kept these terms short and human. Use Brodoit kindly, and we'll keep building it for you.</p><span class="updated">Last updated · April 2026</span><hr class="hr"><h2 data-n="01">The service</h2><p>Brodoit is a personal productivity app: it lets you manage tasks with optional WhatsApp and email reminders, listen to free public-domain audiobooks, sharpen your mind with brain games, and see a daily wisdom quote.</p><h2 data-n="02">Your account</h2><p>You register with your email address or phone number. Keep your one-time verification codes private — anyone with the code can sign in. You are responsible for activity on your account.</p><h2 data-n="03">Acceptable use</h2><p>Please don't abuse the service: no spam, no impersonation, no automated scraping, no attempts to disrupt other users or the service itself. We may suspend or remove accounts that do.</p><h2 data-n="04">Content</h2><p>You own your tasks, notes, and other content you create. We store them so we can show them back to you. Audiobook content belongs to the respective public-domain authors and is served from the Internet Archive's LibriVox collection.</p><h2 data-n="05">No warranty</h2><p>The service is provided "as is". We try hard to keep it running, but can't promise zero downtime or guarantee that every reminder is delivered (WhatsApp and email providers can fail). If something matters, please don't rely solely on Brodoit.</p><h2 data-n="06">Limitation of liability</h2><p>Brodoit is a personal tool. We're not liable for missed deadlines, lost data, or any consequential damages from using — or not using — the service.</p><h2 data-n="07">Changes</h2><p>We may update these terms. If we do, we'll update the date at the top. Continued use after a change means you accept the new terms.</p><h2 data-n="08">Contact</h2><p>Need anything? <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> — a real human reads every message.</p>${LEGAL_FOOT}</div></body></html>`);
});
app.get('/sw.js',(_,res)=>{res.set('Content-Type','application/javascript');res.send('self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){self.clients.claim()});self.addEventListener("fetch",function(e){});')});

// ═══ MARKETING / PUBLIC PAGES ═══

// Real robots.txt — without this, Express's catch-all returned the SPA HTML to crawlers
app.get('/robots.txt',(_,res)=>{
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://brodoit.com/sitemap.xml\n`);
});

// Real sitemap.xml — same problem, was returning HTML before
app.get('/sitemap.xml',(_,res)=>{
  const today=new Date().toISOString().slice(0,10);
  const urls=[
    {loc:'https://brodoit.com/',pri:'1.0',freq:'daily'},
    {loc:'https://brodoit.com/pricing',pri:'0.9',freq:'weekly'},
    {loc:'https://brodoit.com/about',pri:'0.8',freq:'monthly'},
    {loc:'https://brodoit.com/changelog',pri:'0.7',freq:'weekly'},
    {loc:'https://brodoit.com/privacy',pri:'0.5',freq:'yearly'},
    {loc:'https://brodoit.com/terms',pri:'0.5',freq:'yearly'},
  ];
  const xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+urls.map(u=>'  <url><loc>'+u.loc+'</loc><lastmod>'+today+'</lastmod><changefreq>'+u.freq+'</changefreq><priority>'+u.pri+'</priority></url>').join('\n')+'\n</urlset>';
  res.type('application/xml').send(xml);
});

// Pricing page — three tiers, comparison, FAQ, waitlist CTAs
app.get('/pricing',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>${MARKETING_CHROME}<title>Pricing — Brodoit</title><meta name="description" content="Brodoit pricing. Free forever for the basics. Pro for serious depth. Lifetime for the believers."><meta property="og:title" content="Pricing — Brodoit"><meta property="og:description" content="Free forever. Pro for $7/month. Lifetime for $149 once."><meta property="og:image" content="https://brodoit.com/icon-512.png"></head><body><div class="wrap"><a class="crumb" href="/">← Back to Brodoit</a><div style="margin-top:32px"><span class="hero-tag"><span class="pulse"></span>Simple pricing</span></div><h1 class="huge">Free forever.<br/><em>Pro when you're ready.</em></h1><p class="lede" style="margin-top:24px">No tricks, no auto-renewing surprises, no "starts at" bait. Three tiers, picked once. Free is fully usable for life — Pro just unlocks the depth.</p><div class="tiers"><div class="tier"><div><div class="name">Starter</div><h3>Free, forever</h3></div><div class="price"><span class="dollar">$</span><span class="num">0</span><span class="suffix">/ month</span></div><p class="blurb">Everything you need to actually run your day. No credit card, no trial timer.</p><ul><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited tasks &amp; reminders</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>WhatsApp + email reminders</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Free public-domain audiobooks</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Daily wisdom, weather, news</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Mind Gym &amp; Voice (lite)</li><li class="muted"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>Advanced analytics</li><li class="muted"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>Priority reminders</li></ul><a href="/" class="cta">Open the app</a></div><div class="tier featured"><span class="ribbon">Most loved</span><div><div class="name">Pro</div><h3>The full ritual</h3></div><div class="price"><span class="dollar">$</span><span class="num">7</span><span class="suffix">/ month</span></div><p class="blurb">Everything in Starter, plus the depth: insights, full Mind Gym, full Voice Coach, calendar sync, and priority delivery.</p><ul><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Everything in Starter</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><b>Mind Gym</b> · all 5 games unlocked</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><b>Voice Coach</b> · 90-day course in full</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Insights dashboard</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Priority WhatsApp delivery</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Google Calendar sync</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Custom themes &amp; export</li></ul><a href="mailto:hello@brodoit.com?subject=Pro%20waitlist" class="cta">Join the Pro waitlist</a></div><div class="tier"><div><div class="name">Lifetime</div><h3>Pay once, done</h3></div><div class="price"><span class="dollar">$</span><span class="num">149</span><span class="suffix">once</span></div><p class="blurb">Pro features locked in forever. No subscriptions, no upsells. Saves $169 over two years.</p><ul><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Everything in Pro</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Forever — zero renewals</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Founder badge in profile</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Beta access · all new features</li><li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Direct line to the founder</li></ul><a href="mailto:hello@brodoit.com?subject=Lifetime%20waitlist" class="cta">Reserve a lifetime seat</a></div></div><div class="proof"><div><div class="num">15+</div><div class="lbl">features in Free</div></div><div><div class="num">14-day</div><div class="lbl">money-back · Pro</div></div><div><div class="num">0</div><div class="lbl">ads · ever</div></div></div><h2 data-n="">Frequently asked</h2><div class="faq"><details><summary>Can I really use Free forever?</summary><p>Yes. Free isn't a trial — it's a permanent tier with no row count caps, no time limits. We'd rather have you using Brodoit free for ten years than nagging you to upgrade for ten months.</p></details><details><summary>What if I don't like Pro?</summary><p>Email us within 14 days of your first charge and we'll refund every cent — no forms, no exit interviews, no hard feelings.</p></details><details><summary>How does WhatsApp delivery work?</summary><p>Reminders go through Twilio. On Pro, your messages take a higher-priority lane that's typically delivered within seconds even when Twilio's free queue is backed up.</p></details><details><summary>Is my data safe?</summary><p>Stored in a SQLite database on Railway, never sold, never shared with advertisers. Read the <a href="/privacy">full privacy policy</a> — it's short and in plain English.</p></details><details><summary>What about a team plan?</summary><p>It's coming. Email <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> with how big your team is — early team customers get a permanent discount.</p></details></div><div class="cta-row"><a href="/" class="btn-primary">Start free now →</a><a href="/about" class="btn-ghost">Read the story</a></div>${LEGAL_FOOT}</div></body></html>`);
});

// About page — the brand story
app.get('/about',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>${MARKETING_CHROME}<title>About — Brodoit</title><meta name="description" content="Why Brodoit exists. The story behind the calmest productivity app on the internet."><meta property="og:title" content="About — Brodoit"><meta property="og:description" content="Why Brodoit exists, who it's for, and what it will never become."></head><body><div class="wrap"><a class="crumb" href="/">← Back to Brodoit</a><div style="margin-top:32px"><span class="hero-tag"><span class="pulse"></span>Our story</span></div><h1 class="huge">Made for the<br/><em>quietly serious.</em></h1><p class="lede" style="margin-top:24px">Brodoit is a productivity app that doesn't beg for your attention. No streak shaming. No 47 notifications a day. No "you're about to lose your spot" emails. Just a calm place to write down what matters and a gentle nudge when it's time.</p><div class="about-quote">"Most productivity apps are designed to be opened. Brodoit is designed to be closed — so you can go and do the actual work."</div><h2 data-n="01">Why we built it</h2><p>Every productivity app on the planet seemed to optimise for one metric: time-on-app. We wanted the opposite. A tool that puts the task into the world (your WhatsApp, your inbox, your calendar) and then gets out of the way.</p><p>So we built Brodoit. One screen, fast. Reminders that find you wherever you already are. Audiobooks for the commute. A tiny mind-gym for when the phone tries to suck you back in. A daily quote to remember why you started.</p><h2 data-n="02">What it will <em>never</em> be</h2><ul><li><strong>Ad-supported.</strong> Your attention is not for sale. Pricing pays the bills, period.</li><li><strong>Sold or acqui-hired.</strong> No "we've been acquired by [bigco]" email. The app stays independent.</li><li><strong>A social network.</strong> No followers, no leaderboards, no streak-public-shaming. Productivity is a private practice.</li><li><strong>Bloated.</strong> If a feature doesn't earn its weight in calm, it leaves.</li></ul><h2 data-n="03">Who it's for</h2><p>People with a real life and a long list. Founders running on three hours of sleep. Students with fifteen tabs open. Parents who finally have ten minutes to themselves. Anyone who's tired of being shouted at by their tools.</p><div class="proof" style="margin-top:48px"><div><div class="num">∞</div><div class="lbl">tasks · free</div></div><div><div class="num">3</div><div class="lbl">tabs at most</div></div><div><div class="num">0</div><div class="lbl">notifications you didn't ask for</div></div></div><h2 data-n="04">Made by</h2><p>One person, in their kitchen, between cups of coffee. If you've got feedback, ideas, or just want to say hi: <a href="mailto:hello@brodoit.com">hello@brodoit.com</a>. A real human reads every email.</p><div class="cta-row"><a href="/" class="btn-primary">Open the app →</a><a href="/pricing" class="btn-ghost">See pricing</a></div>${LEGAL_FOOT}</div></body></html>`);
});

// Changelog page — public record of recent improvements (signals active development)
app.get('/changelog',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>${MARKETING_CHROME}<title>Changelog — Brodoit</title><meta name="description" content="What's new in Brodoit. Recent shipping log."><meta property="og:title" content="Changelog — Brodoit"><meta property="og:description" content="What's new in Brodoit. Recent shipping log."></head><body><div class="wrap"><a class="crumb" href="/">← Back to Brodoit</a><div style="margin-top:32px"><span class="hero-tag"><span class="pulse"></span>Always shipping</span></div><h1 class="huge">What's <em>new.</em></h1><p class="lede" style="margin-top:24px">A live record of every meaningful change. We ship most weeks. If you spot a bug or want a feature, email <a href="mailto:hello@brodoit.com">hello@brodoit.com</a>.</p><div class="changelog"><div class="cl-item"><div class="cl-date">Apr 28, 2026</div><div class="cl-body"><h3>Internationalization push</h3><p>Brought the site up to global publishing standards.</p><ul><li>Added structured data (JSON-LD) so Google can render rich-result cards</li><li>Open Graph + Twitter Card tags — links shared in WhatsApp, iMessage, Slack, X now show proper preview cards</li><li>Re-enabled pinch-zoom (was blocked — accessibility fix)</li><li>Apple touch icon + iOS standalone meta for clean home-screen install</li><li>Aligned manifest theme/background with the editorial palette</li><li>Rebuilt /privacy and /terms with the brand typography</li><li>Added /pricing, /about, /changelog public pages</li><li>Real /robots.txt and /sitemap.xml (were being eaten by the SPA catch-all)</li></ul></div></div><div class="cl-item"><div class="cl-date">Late April</div><div class="cl-body"><h3>Math Sprint v2</h3><p>The arithmetic game got the works: time pressure, bigger tap targets, combo multipliers, particle effects on correct answers, and an end-of-round star screen.</p></div></div><div class="cl-item"><div class="cl-date">Early April</div><div class="cl-body"><h3>Memory Tap, rebuilt on canvas</h3><p>Switched from DOM-rendered tiles to a real game loop on canvas. Smoother animations, lower latency, and a Voice Coach with a live waveform to give you immediate feedback on your speech rhythm.</p></div></div><div class="cl-item"><div class="cl-date">Late March</div><div class="cl-body"><h3>Editorial UI overhaul</h3><p>The whole app got a quieter, more grown-up look: a neutral warm palette, real photography in the headers, refined typography (Inter + Instrument Serif + JetBrains Mono), and gentler shadows.</p></div></div><div class="cl-item"><div class="cl-date">March</div><div class="cl-body"><h3>Premium UI polish</h3><p>'Bro, Do It!' hero illustration, animated gradient icons, and login screen with footer links. Privacy and Terms pages went live for the Play Store submission.</p></div></div></div><div class="cta-row"><a href="/" class="btn-primary">Try the app →</a><a href="/pricing" class="btn-ghost">See pricing</a></div>${LEGAL_FOOT}</div></body></html>`);
});
function _readCookie(req,name){const c=req.headers.cookie||'';const m=c.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));return m?decodeURIComponent(m[1]):''}
app.get('/',(req,res)=>{
  const pendingEmail=_readCookie(req,'pending_otp_email');
  const inject=pendingEmail?'window.__PENDING_OTP_EMAIL='+JSON.stringify(pendingEmail.slice(0,254))+';':'';
  const html=HTML.replace('/*__SERVER_INJECT__*/',inject);
  // Vary: Cookie tells any CDN (Railway uses Fastly) that responses differ per cookie — never serve a
  // user-A cookie response to user-B. Combined with no-store, this blocks all caching of /.
  res.set('Cache-Control','no-cache, no-store, must-revalidate').set('Pragma','no-cache').set('Expires','0').set('Vary','Cookie').type('html').send(html);
});
app.get('*',(_,res)=>res.type('html').send(HTML));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('🚀 Brodoit running on port '+PORT));
