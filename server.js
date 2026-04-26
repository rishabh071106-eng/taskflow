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
const ELEVENLABS_VOICE=process.env.ELEVENLABS_VOICE||'29vD33N1CtxCmqQRPOHJ';  // Adam (deep male)
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
      body:JSON.stringify({text,model_id:'eleven_turbo_v2_5',voice_settings:{stability:0.5,similarity_boost:0.78,style:0.15,use_speaker_boost:true}})
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
  ['math','memory','reaction'].forEach(g=>{if(!map[g])map[g]={game:g,level:1,xp:0,best:0,plays:0,updated_at:null}});
  const streak=_streakFor(req.user.phone,'mindgym');
  res.json({progress:map,maxLevel:MAX_LEVEL,xpPerLevel:100,streak});
});
app.post('/api/games/progress',auth,(req,res)=>{
  const game=String((req.body&&req.body.game)||'').toLowerCase();
  if(!['math','memory','reaction'].includes(game))return res.status(400).json({error:'Unknown game'});
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

// ═══ WEATHER + AQI (Open-Meteo, free, no key needed) — 15-min server cache ═══
const weatherCache={};
app.get('/api/weather',async(req,res)=>{
  const city=String(req.query.city||'Bangalore').slice(0,80).trim();
  const key=city.toLowerCase();
  const c=weatherCache[key];
  if(c&&Date.now()-c.ts<15*60*1000)return res.json({...c.data,cached:true});
  try{
    const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),6000);
    const geoR=await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name='+encodeURIComponent(city),{signal:ctrl.signal,headers:{'User-Agent':'Brodoit/1.0'}});
    clearTimeout(tm);
    const geoJ=await geoR.json();
    const place=(geoJ.results||[])[0];
    if(!place)return res.json({error:'city_not_found',city});
    const lat=place.latitude,lon=place.longitude,cityName=place.name,country=place.country_code||'';
    const [wxR,aqR]=await Promise.all([
      fetch('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current_weather=true').then(r=>r.json()).catch(()=>({})),
      fetch('https://air-quality-api.open-meteo.com/v1/air-quality?latitude='+lat+'&longitude='+lon+'&current=us_aqi').then(r=>r.json()).catch(()=>({}))
    ]);
    const cw=wxR&&wxR.current_weather;
    const temp=cw&&typeof cw.temperature==='number'?Math.round(cw.temperature):null;
    const code=cw?cw.weathercode:null;
    const aqRaw=aqR&&aqR.current&&aqR.current.us_aqi;
    const aqi=typeof aqRaw==='number'?Math.round(aqRaw):null;
    const data={city:cityName,country,lat,lon,temp,aqi,weatherCode:code};
    weatherCache[key]={ts:Date.now(),data};
    res.json(data);
  }catch(e){res.json({error:String(e),city})}
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
@media (max-width:480px){
  .tabs.page-t{padding:6px;gap:6px}
  .tabs.page-t .tab{padding:13px 10px;font-size:14px;gap:7px;min-height:50px}
  .tabs.page-t .tab .ti{font-size:20px;width:28px;height:28px}
  .tabs.page-t .tab .ti svg{width:21px!important;height:21px!important}
  .tabs.page-t .tab .tl{font-size:12.5px}
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
mg:{progress:{math:{level:1,xp:0,best:0},memory:{level:1,xp:0,best:0},reaction:{level:1,xp:0,best:0}},streak:{current:0,longest:0,total:0},loaded:false},
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
  // Belt: URL hash says mid-OTP, force loginStep='otp' regardless of localStorage state.
  if(location.hash==='#otp'&&(S.loginEmail||S.loginPhone)){S.loginStep='otp'}
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
async function sendOTP(){S.loginLoading=true;S.loginError='';render();let url,body;if(S.loginMethod==='email'){const em=(S.loginEmail||'').trim().toLowerCase();if(!/^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$/i.test(em)){S.loginError='Enter a valid email address';S.loginLoading=false;render();return}url='/api/send-otp-email';body={email:em}}else{const cc=(S.loginCountryCode||'+91').replace(/[^0-9+]/g,'');const local=(S.loginPhone||'').replace(/[^0-9]/g,'');if(!local){S.loginError='Enter your WhatsApp number';S.loginLoading=false;render();return}if(local.length<6){S.loginError='Phone number too short';S.loginLoading=false;render();return}const ph=cc+local;url='/api/send-otp';body={phone:ph}}const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({ok:false,error:'Network error \\u2014 check your connection'}));S.loginLoading=false;if(r.ok){S.loginStep='otp';S.loginOTP=['','','','','',''];S.loginError='';S.loginSentTo=r.phone||S.loginEmail||((S.loginCountryCode||'')+S.loginPhone);persistLoginState();try{history.replaceState(null,'','#otp')}catch(e){}render();setTimeout(()=>{const el=document.getElementById('otp0');if(el)el.focus()},100)}else{S.loginError=r.error||'Failed to send OTP';S.loginErrorDetail=r.detail||'';S.loginErrorCode=r.code||0;render()}}
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
async function refreshSession(){if(!token)return;const r=await api('/me');if(r&&!r.error){S.user={phone:r.phone,name:r.name,token};S.profile=r;localStorage.setItem('tf_name',r.name||'');render()}else if(r&&r.error){logout()}}
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
function _mgMarkDone(g){try{localStorage.setItem(_mgTodayKey(g),'1')}catch(e){}}
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
function coachStopRec(){try{_coachRec&&_coachRec.state==='recording'&&_coachRec.stop()}catch(e){}}
function coachReset(){coachStopSpeak();coachStopRec();S.coach.history=[];S.coach.scenario=null;coachInit()}
function coachStartScenario(sc){coachStopSpeak();S.coach.scenario=sc;S.coach.history=[{role:'assistant',content:"Let's roleplay: **"+sc.title+"**. I'll play "+sc.role+". "+sc.opener}];render();coachSpeak("Let's roleplay. "+sc.opener);setTimeout(()=>{const el=document.getElementById('coachInput');if(el)el.focus()},120)}
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
  const u=new SpeechSynthesisUtterance(String(text||''));
  const v=_pickMaleVoice();if(v){u.voice=v;u.lang=v.lang||'en-US'}else u.lang='en-US';
  u.rate=.94;u.pitch=.92;u.volume=1;
  u.onend=()=>{if(S.voicePlay)S.voicePlay.playingTTS=false;render();onEnd&&onEnd()};
  u.onerror=()=>{if(S.voicePlay)S.voicePlay.playingTTS=false;render()};
  if(S.voicePlay){S.voicePlay.playingTTS=true;render()}
  try{window.speechSynthesis.speak(u)}catch(e){}
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
function mgClose(){S.mgPlay=null;render()}
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
function mgMathStart(){const lvl=S.mg.progress.math.level;S.mgPlay={game:'math',level:lvl,_baseLevel:lvl,score:0,streak:0,best:0,wrongs:0,problem:_mgMathProblem(lvl),feedback:null,startedAt:Date.now(),done:false};_mgSound('tap');render()}
function mgMathAnswer(choice){
  const p=S.mgPlay;if(!p||p.game!=='math'||p.done)return;
  if(choice===p.problem.ans){
    p.score++;p.streak++;if(p.streak>p.best)p.best=p.streak;p.feedback={ok:true,msg:'Correct!'};
    _mgSound('correct');
    // Adaptive: 5+ streak = bump difficulty by 1 (capped at 5). 2 wrongs in a row = drop 1 (min base level)
    if(p.streak===5&&p.level<5)p.level++;
  } else {
    p.streak=0;p.wrongs++;p.feedback={ok:false,msg:'Answer was '+p.problem.ans};
    _mgSound('wrong');
    if(p.wrongs>=2&&p.level>p._baseLevel){p.level--;p.wrongs=0}
  }
  render();
  setTimeout(()=>{
    const cur=S.mgPlay;if(!cur||cur.game!=='math')return;
    if(cur.score>=10){cur.done=true;_mgSound('levelup');_mgMarkDone('math');S._mgConfetti=Date.now();render();_mgSave('math',cur.score*5,cur.best)}
    else{cur.problem=_mgMathProblem(cur.level);cur.feedback=null;render()}
  },650);
}

// ── Memory Tap ──
function mgMemoryStart(){const lvl=S.mg.progress.memory.level;const grid=lvl<=1?9:lvl===2?12:lvl===3?16:lvl===4?20:25;S.mgPlay={game:'memory',level:lvl,grid,seq:[],userIdx:0,phase:'show',round:1,best:0,done:false};_mgMemoryNext();render();}
function _mgMemoryNext(){const p=S.mgPlay;if(!p||p.game!=='memory')return;const seqLen=p.round+(p.level-1);p.seq=Array.from({length:seqLen},()=>Math.floor(Math.random()*p.grid));p.userIdx=0;p.phase='show';p.flashIdx=-1;render();_mgMemoryFlash(0)}
function _mgMemoryFlash(i){const p=S.mgPlay;if(!p||p.game!=='memory'||p.phase!=='show')return;if(i>=p.seq.length){p.phase='input';p.flashIdx=-1;render();return}p.flashIdx=p.seq[i];_mgSound('flash');render();setTimeout(()=>{p.flashIdx=-1;render();setTimeout(()=>_mgMemoryFlash(i+1),200)},520)}
function mgMemoryTap(idx){const p=S.mgPlay;if(!p||p.game!=='memory'||p.phase!=='input')return;if(idx===p.seq[p.userIdx]){_mgSound('tap');p.userIdx++;if(p.userIdx>=p.seq.length){if(p.round>p.best)p.best=p.round;p.round++;p.phase='passed';_mgSound('correct');render();setTimeout(_mgMemoryNext,650)}}
  else{p.done=true;p.phase='lost';_mgSound('wrong');_mgMarkDone('memory');render();_mgSave('memory',p.best*5,p.best)}
}

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

async function loadBooks(cat){S.booksCat=cat;S.booksLoading=true;render();try{const subjectMap={'self-help':'(subject:"self-help" OR subject:"self help" OR subject:"self improvement" OR subject:"non-fiction")'};const subj=subjectMap[cat]||('subject:'+cat);const q=cat==='all'?'collection:librivoxaudio AND mediatype:audio':'collection:librivoxaudio AND mediatype:audio AND '+subj;const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(q)+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&rows=30&output=json&sort[]=downloads+desc';const r=await fetch(url);const j=await r.json();S.books=j.response.docs;}catch(e){S.books=[];toast('\\u26A0\\uFE0F Failed to load books','err')}S.booksLoading=false;render()}
async function playBook(id){const b=S.books.find(x=>x.identifier===id);if(!b){toast('\\u26A0\\uFE0F Book not found','err');return}const title=Array.isArray(b.title)?b.title[0]:b.title;const author=Array.isArray(b.creator)?b.creator[0]:(b.creator||'Unknown');S.playing={id,title,author,loading:true};render();try{const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id));if(!r.ok)throw new Error('metadata '+r.status);const j=await r.json();if(!j.files||!j.files.length){toast('\\u26A0\\uFE0F No files \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render();return}let mp3=j.files.find(f=>/_64kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/_32kb\\.mp3$/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.mp3$/i.test(f.name)&&!/sample|test|spoken/i.test(f.name));if(!mp3)mp3=j.files.find(f=>/\\.(mp3|m4a|ogg)$/i.test(f.name));if(mp3){const server=j.server||'archive.org';const dir=j.dir||('/'+id);const directUrl='https://'+server+dir+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');const dlUrl='https://archive.org/download/'+encodeURIComponent(id)+'/'+mp3.name.split('/').map(encodeURIComponent).join('/');S.playing={id,title,author,url:directUrl,altUrl:dlUrl,external:'https://archive.org/details/'+id};render();setTimeout(()=>{const a=document.getElementById('audioEl');if(!a)return;a.setAttribute('playsinline','');a.setAttribute('webkit-playsinline','');a.preload='auto';a.addEventListener('error',function onErr(){a.removeEventListener('error',onErr);if(a.src!==dlUrl){a.src=dlUrl;a.load()}},{once:true});a.load();a.addEventListener('play',startBookListenTimer);a.addEventListener('pause',()=>{/* keep timer; checks paused itself */});const p=a.play();if(p&&p.catch)p.catch(()=>toast('\\u25B6\\uFE0F Tap the play button on the bar','err'))},250)}else{toast('\\u26A0\\uFE0F No audio \\u2014 opening archive.org','err');window.open('https://archive.org/details/'+id,'_blank');S.playing=null;render()}}catch(e){toast('\\u26A0\\uFE0F '+e.message,'err');S.playing={id,title,author,url:null,external:'https://archive.org/details/'+id,error:e.message};render()}}
function closePlayer(){stopBookListenTimer();S.playing=null;S.meditating={active:false,title:'',mins:0,startedAt:0};render()}
function closeMeditation(){const a=document.getElementById('audioEl');if(a){try{a.pause()}catch(e){}}closePlayer()}
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
h+='<footer class="login-foot"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a><span>\\u2022</span><a href="/terms" target="_blank" rel="noopener">Terms of Service</a><span>\\u2022</span><a href="mailto:hello@brodoit.com">Contact</a></footer>';
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
  const totalLevel=mg.progress.math.level+mg.progress.memory.level+mg.progress.reaction.level;
  const totalXp=(mg.progress.math.xp||0)+(mg.progress.memory.xp||0)+(mg.progress.reaction.xp||0);
  const streak=mg.streak||{current:0,longest:0,total:0};
  // Daily workout — 3-game plan, ticked as user completes each today
  const dGames=[{k:'math',n:'Math',e:'\\u{1F522}',fn:'mgMathStart()'},{k:'memory',n:'Memory',e:'\\u{1F9E9}',fn:'mgMemoryStart()'},{k:'reaction',n:'Reaction',e:'\\u26A1',fn:'mgReactionStart()'}];
  const doneCount=dGames.filter(g=>_mgIsDoneToday(g.k)).length;
  const nextGame=dGames.find(g=>!_mgIsDoneToday(g.k));
  h+='<div class="mg-daily">'
    +'<div class="mg-daily-l"><div class="mg-daily-eyebrow">TODAY \\u2022 5-MINUTE WORKOUT</div>'
    +'<div class="mg-daily-t">'+(doneCount===3?'\\u{1F389} Workout complete!':'Plan: '+dGames.map(g=>(_mgIsDoneToday(g.k)?'<s>':'')+g.e+' '+g.n+(_mgIsDoneToday(g.k)?'</s>':'')).join(' \\u2192 '))+'</div>'
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
  h+='</div>';
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
  // Hero
  h+='<section class="cc-hero">'
    +'<div class="cc-hero-orb"></div>'
    +'<div class="cc-hero-l"><div class="cc-hero-eyebrow">\\u{1F399}\\uFE0F BRODOIT \\u00B7 AI COACH</div>'
      +'<h1 class="cc-hero-t">Talk. Refine. Sound sharper.</h1>'
      +'<div class="cc-hero-s">A live Business English coach. Type or hit the mic \\u2014 your phone listens, the coach replies in a real human voice with vocabulary tips, polished rewrites, and follow-ups.</div>'
    +'</div>'
  +'</section>';
  // Capability badges
  h+='<div class="cc-caps">'
    +'<span class="cc-cap'+(st.chat?' cc-cap-on':'')+'">\\u{1F4AC} '+(st.chat?'Live AI':'AI offline')+'</span>'
    +'<span class="cc-cap'+(st.transcribe?' cc-cap-on':'')+'">\\u{1F3A4} '+(st.transcribe?'Voice in':'Type only')+'</span>'
    +'<span class="cc-cap'+(st.tts?' cc-cap-on':'')+'">\\u{1F50A} '+(st.tts?'Human voice':'Browser voice')+'</span>'
  +'</div>';
  // Scenarios
  h+='<div class="cc-scenarios"><div class="cc-scenarios-t">\\u26A1 Pick a scenario \\u2014 or just chat below</div><div class="cc-scenario-row">';
  COACH_SCENARIOS.forEach(sc=>{const on=c.scenario&&c.scenario.id===sc.id;h+='<button class="cc-sc'+(on?' cc-sc-on':'')+'" onclick="coachStartScenario('+esc(JSON.stringify(sc).replace(/'/g,"\\\\'"))+')">'+esc(sc.title)+'</button>'});
  h+='</div></div>';
  if(c.scenario)h+='<div class="cc-active-scenario">\\u{1F3AD} Roleplay: <b>'+esc(c.scenario.title)+'</b> <button class="cc-end" onclick="coachReset()">End \\u2715</button></div>';
  // Chat thread
  h+='<div class="cc-thread" id="ccThread">';
  (c.history||[]).forEach((m,i)=>{
    const role=m.role==='assistant'?'coach':'me';
    h+='<div class="cc-msg cc-'+role+'">'
      +(role==='coach'?'<div class="cc-avatar">\\u{1F399}\\uFE0F</div>':'')
      +'<div class="cc-bubble">'+_renderCoachText(m.content)+(role==='coach'&&i===c.history.length-1?'<button class="cc-replay" onclick="coachSpeak('+esc(JSON.stringify(m.content).replace(/'/g,"\\\\'"))+')" title="Replay">\\u{1F50A}</button>':'')+'</div>'
    +'</div>';
  });
  if(c.sending)h+='<div class="cc-msg cc-coach"><div class="cc-avatar">\\u{1F399}\\uFE0F</div><div class="cc-bubble cc-typing"><span></span><span></span><span></span></div></div>';
  h+='</div>';
  // Composer
  h+='<div class="cc-composer">'
    +'<textarea id="coachInput" placeholder="Type your message\\u2026 or tap the mic" rows="1" oninput="S.coach.input=this.value;this.style.height=\\'auto\\';this.style.height=Math.min(120,this.scrollHeight)+\\'px\\'" onkeydown="if(event.key===\\'Enter\\'&&!event.shiftKey){event.preventDefault();coachSend()}">'+esc(c.input||'')+'</textarea>'
    +'<button class="cc-mic'+(c.recording?' cc-rec':'')+'" onclick="coachStartRec()" aria-label="Record" title="Tap to record">'+(c.recording?'\\u23F9':'\\u{1F3A4}')+'</button>'
    +'<button class="cc-send" onclick="coachSend()" '+(c.sending||(!c.input||!c.input.trim())?'disabled':'')+' aria-label="Send">\\u2192</button>'
  +'</div>';
  // Quick actions
  h+='<div class="cc-quick">'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'Teach me 3 advanced business words I can use today.\\')">3 advanced words</button>'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'Quiz me on idioms used in meetings.\\')">Idioms quiz</button>'
    +'<button class="cc-quick-btn" onclick="coachSend(\\'How do I sound more confident in presentations?\\')">Confidence tips</button>'
    +(c.history.length>1?'<button class="cc-quick-btn cc-quick-reset" onclick="coachReset()">\\u21BB Restart</button>':'')
  +'</div>';
  if(c.playing)h+='<div class="cc-playing">\\u{1F50A} Coach is speaking\\u2026 <button onclick="coachStopSpeak()">stop</button></div>';
}
// Helper: simple markdown-ish rendering for coach replies (paragraphs, bold)
function _renderCoachText(t){return esc(t).replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\n/g,'<br>')}

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
  const cats=[{k:'world',l:'World',ic:'globe'},{k:'tech',l:'Tech & AI',ic:'tech'},{k:'sports',l:'Sports',ic:'sport'}];
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
  h+='<div class="mg-hd"><div><h2 class="mg-t">'+(p.game==='math'?'\\u{1F522} Math Sprint':p.game==='memory'?'\\u{1F9E9} Memory Tap':'\\u26A1 Reaction')+' \\u2022 L'+p.level+'</h2><div class="mg-s">'+(p.game==='math'?'Solve 10 to win XP':p.game==='memory'?'Repeat the pattern \\u2014 it grows each round':'Tap when the screen turns green')+'</div></div><button class="was-x" onclick="mgClose()">\\u2715</button></div>';

  if(p.game==='math'){
    if(p.done){
      h+='<div class="mg-body mg-end"><div class="mg-end-emoji">\\u{1F389}</div><div class="mg-end-t">'+p.score+' / 10 correct</div><div class="mg-end-s">Best streak: <b>'+p.best+'</b> \\u2022 +'+(p.score*5)+' XP</div><div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgMathStart()">\\u21BB Play again</button></div></div>';
    }else{
      const q=p.problem;
      h+='<div class="mg-body">'
        +'<div class="mg-progress"><div class="mg-progress-bar" style="width:'+(p.score*10)+'%"></div></div>'
        +'<div class="mg-math-q">'+q.a+' '+q.op+' '+q.b+' = ?</div>'
        +'<div class="mg-math-choices">';
      q.choices.forEach(c=>{const cls=p.feedback?(c===q.ans?' mg-choice-ok':' mg-choice-wrong'):'';h+='<button class="mg-choice'+cls+'" onclick="mgMathAnswer('+c+')"'+(p.feedback?' disabled':'')+'>'+c+'</button>'});
      h+='</div>'
        +(p.feedback?'<div class="mg-feedback '+(p.feedback.ok?'mg-fb-ok':'mg-fb-bad')+'">'+esc(p.feedback.msg)+'</div>':'')
        +'<div class="mg-meta">Score <b>'+p.score+'</b>/10 \\u2022 Streak <b>'+p.streak+'</b></div>'
      +'</div>';
    }
  } else if(p.game==='memory'){
    if(p.done){
      h+='<div class="mg-body mg-end"><div class="mg-end-emoji">'+(p.phase==='lost'?'\\u{1F4A5}':'\\u{1F389}')+'</div><div class="mg-end-t">Reached round '+p.best+'</div><div class="mg-end-s">+'+(p.best*5)+' XP saved</div><div class="was-acts"><button class="mb mb-c" onclick="mgClose()">Done</button><button class="mb mb-s" onclick="mgMemoryStart()">\\u21BB Play again</button></div></div>';
    }else{
      const cols=p.grid<=9?3:p.grid<=12?4:p.grid<=16?4:5;
      h+='<div class="mg-body">'
        +'<div class="mg-mem-status">'+(p.phase==='show'?'Watch \\u2026':p.phase==='input'?'Your turn ('+(p.userIdx+1)+'/'+p.seq.length+')':p.phase==='passed'?'\\u2705 Got it! Next round\\u2026':'')+'</div>'
        +'<div class="mg-mem-grid" style="grid-template-columns:repeat('+cols+',1fr)">';
      for(let i=0;i<p.grid;i++){const lit=p.flashIdx===i;h+='<button class="mg-mem-tile'+(lit?' mg-mem-lit':'')+'" onclick="mgMemoryTap('+i+')"'+(p.phase!=='input'?' disabled':'')+'></button>'}
      h+='</div>'
        +'<div class="mg-meta">Round <b>'+p.round+'</b> \\u2022 Best <b>'+p.best+'</b></div>'
      +'</div>';
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
if(S.user){_waRestore();refreshSession();load();loadBookStreak();loadGoogleStatus();loadWeather();loadTicker();loadCityTemps();loadRemember();loadMindGym();chk();setInterval(load,10000);setInterval(loadWeather,15*60*1000);setInterval(loadTicker,15*60*1000);setInterval(loadCityTemps,15*60*1000);setInterval(loadRemember,6*60*60*1000)}else render();
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

// Privacy Policy (required by Play Store)
app.get('/privacy',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Privacy Policy — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#0F172A;background:#F8FAFC;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#312E81}a{color:#3DAE5C}</style></head><body><h1>Privacy Policy</h1><p><em>Last updated: April 2026</em></p><p><strong>Brodoit</strong> ("we", "our", "the app") values your privacy. This page explains what data we collect, why, and your rights.</p><h2>1. What we collect</h2><ul><li><strong>Email address</strong> or <strong>phone number</strong> — used only to authenticate you via one-time verification codes.</li><li><strong>Your name</strong> — displayed in the app's profile screen.</li><li><strong>Your tasks, notes, due dates, reminders</strong> — stored so we can show them back to you and send reminders.</li><li><strong>Session token</strong> — a random string stored in your browser so you stay logged in.</li></ul><p>We do <strong>not</strong> collect: location, contacts, advertising IDs, device IDs, photos, payment info, or any data we don't explicitly list here.</p><h2>2. How we use it</h2><ul><li>Deliver one-time codes by email or WhatsApp (via Resend and Twilio respectively).</li><li>Show your tasks and books library.</li><li>Send WhatsApp reminders at the times you set.</li></ul><h2>3. Who we share with</h2><p>We share data only with the following service providers, strictly to operate the service:</p><ul><li><strong>Resend</strong> — to deliver verification emails (<a href="https://resend.com/privacy">privacy policy</a>).</li><li><strong>Twilio</strong> — to deliver WhatsApp messages (<a href="https://www.twilio.com/legal/privacy">privacy policy</a>).</li><li><strong>Railway</strong> — our hosting provider (<a href="https://railway.app/legal/privacy">privacy policy</a>).</li><li><strong>Internet Archive (LibriVox)</strong> — we fetch public audiobook metadata; no personal data is sent.</li></ul><p>We never sell data, never show ads, never track you across other apps or sites.</p><h2>4. Data retention</h2><p>Your tasks and account persist until you delete them or ask us to delete your account. Verification codes expire after 5 minutes and are deleted after use.</p><h2>5. Your rights</h2><p>Email us at <a href="mailto:hello@brodoit.com">hello@brodoit.com</a> to: export your data, correct your data, or permanently delete your account.</p><h2>6. Children</h2><p>Brodoit is not directed at children under 13. We do not knowingly collect data from children under 13.</p><h2>7. Changes</h2><p>If we make material changes, we'll update the date at the top and notify you via email if we have your address.</p><h2>8. Contact</h2><p>Questions? <a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#94A3B8"><a href="/">← Back to Brodoit</a></p></body></html>`);
});

// Terms of Service
app.get('/terms',(_,res)=>{
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Terms — Brodoit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#0F172A;background:#F8FAFC;line-height:1.7}h1{font-family:monospace;font-size:28px}h2{margin-top:28px;font-size:18px}p,li{font-size:15px;color:#312E81}a{color:#3DAE5C}</style></head><body><h1>Terms of Service</h1><p><em>Last updated: April 2026</em></p><h2>1. The service</h2><p>Brodoit is a personal productivity app that lets you track tasks, listen to free public-domain audiobooks, and view daily motivational quotes.</p><h2>2. Your account</h2><p>You register with an email address or phone number. Keep your verification codes private. You're responsible for activity on your account.</p><h2>3. Acceptable use</h2><p>Don't abuse the service: no spam, no impersonation, no automated scraping, no attempts to disrupt the service. We may suspend accounts that do.</p><h2>4. Content</h2><p>You own your tasks and notes. We store them to show back to you. Audiobook content belongs to its respective public-domain authors and is served from the Internet Archive's LibriVox collection.</p><h2>5. No warranty</h2><p>The service is provided "as is". We try hard to keep it running but can't promise zero downtime or that reminders will always be delivered (WhatsApp/email providers can fail).</p><h2>6. Limitation of liability</h2><p>Brodoit is a personal tool. We're not liable for missed deadlines, lost data, or any consequential damages from using (or not using) the service.</p><h2>7. Changes</h2><p>We may update these terms. Continued use after a change means you accept the new terms.</p><h2>8. Contact</h2><p><a href="mailto:hello@brodoit.com">hello@brodoit.com</a></p><p style="margin-top:40px;font-size:12px;color:#94A3B8"><a href="/">← Back to Brodoit</a></p></body></html>`);
});
app.get('/sw.js',(_,res)=>{res.set('Content-Type','application/javascript');res.send('self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){self.clients.claim()});self.addEventListener("fetch",function(e){});')});
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
