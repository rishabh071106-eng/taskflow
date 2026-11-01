# Brodoit — CLAUDE.md

## Architecture

Single-file monolith: `server.js` (~15,400 lines). Express server serving API + full SPA HTML in one `const HTML = \`...\`` template literal. SQLite database via better-sqlite3. Deployed on Railway via git push.

## Deployment

```bash
# Test locally
node server.js  # starts on port 3000

# Deploy (auto-deploys on Railway)
git add server.js
git commit -m "description"
git push origin main      # GitHub (brodoit.git)
git push railway main     # Railway (taskflow.git) — triggers deploy
```

Both pushes are needed. Railway auto-builds on push to `railway` remote.

**v24: deploys that cannot silently stop.** Railway's GitHub link stopped reacting on 20 Oct 2026 (no deployment for two days of merges).
- `.github/workflows/deploy.yml` runs on every push to taskflow main. It waits 2 minutes for Railway's own deployment of the commit (a GitHub deployment record); with none, it uploads the commit with `railway up --ci --service taskflow` (`@railway/cli@5.63.1`; repo variable `RAILWAY_SERVICE` overrides).
  - It needs the `RAILWAY_TOKEN` secret: a Railway project token for production. Without it, it only warns.
  - It writes `BUILD_COMMIT` (an upload carries no git data) and records a GitHub deployment `railway-ci`.
- The server reads its commit from `RAILWAY_GIT_COMMIT_SHA`, else `BUILD_COMMIT` (`_BUILD_SHA`: `/api/health`'s `commit`, the service worker version).
- `live-check.yml` waits up to 6 minutes for either deploy to start, then for `/api/health` to report the commit. Every run warns how many commits brodoit.com is behind main.
- **Diagnosis (22 Oct)**, from a read-only Actions run that read the GitHub deployments and check suites:
  - The link was not broken. Railway's GitHub app (`railway-app`) still opened its check suite on every push to main.
  - Railway simply created no deployment after `1f489ec` (20 Oct 22:06; 12 deployments that day, each 3 s after its push).
  - So the hold was inside the Railway account or service: plan or credits, paused deploys, or a source or CI setting. The owner moved the account to Pro on 22 Oct.
  - If merges stop deploying again, look in Railway → *taskflow*: the Deployments tab (banner, skipped or waiting) and Settings → Source (repo `taskflow`, branch `main`, wait for CI).

## Critical Escaping Rules

The HTML is inside a JS template literal (`const HTML = \`...\``). Inside it:
- Use `✅` (unicode escapes) for emoji, not raw emoji
- Escape backticks: `\`` 
- For `onclick` handlers with string args: `onclick="fn(\\'value\\')"` (double-backslash + quote)
- `${...}` interpolation works — be careful not to accidentally create one
- `\n` becomes a newline in the template — use `\\n` for literal `\n` in strings inside the HTML

Server-side code (outside the template literal) uses normal JS — raw emoji and single-backslash escapes work fine.

## Key Sections (line ranges shift as code changes — use grep)

| Section | Grep landmark |
|---------|--------------|
| DB schema | `CREATE TABLE IF NOT EXISTS` |
| Auth/OTP | `// ═══ OTP AUTH` |
| AI Chat (Bro) | `// ═══ BRO / BRI` |
| Tasks API | `// ═══ TASKS API` |
| Mind Games | `// ═══ MIND GYM` |
| WhatsApp webhook | `// ═══ WHATSAPP CLOUD API WEBHOOK` |
| News feed | `// ═══ NEWS` |
| Frontend HTML start | `const HTML=` |
| CSS start | `<style>` (inside HTML) |
| JS start | `<script>` (inside HTML) |
| Service Worker | `app.get('/sw.js'` |
| Night sky / stars | `night-sky` |
| Tab bar render | `function renderTabs` or `tabBar` |
| Marketing pages | `// ═══ MARKETING` |
| v9 modules (voice, news channel, /lang, Hindi books) | `// ═══ v9:` — code lives in `modules/voice.js`, `modules/bulletin.js`, `app/*.js`, `lang/` |
| Settings + Admin panel (keys live in `app_settings`, env is fallback) | `modules/settings.js`, `modules/admin.js`, `app/admin.js`; identity `isAdminUser` |
| Steps (StepSetGo-style) | `modules/steps.js` (server), `app/steps.js` (tab), tab key `steps`; `dayKey(tz)` for IST days |
| Design system v10 | `app/theme.css` (tokens), `app/icons.js` (`ico()`), `app/mascot.svg`, `app/haptics.js`, fonts in `app/fonts/` |
| Talking Bro home screen | `broVoiceRoot` (render) + `app/voice.js` (client) |
| News Channel | `newsRoot` (render) + `app/news.js` |
| Learn tree | `var _LT=[` |
| Book player v2 | `function bkpPlay` / `_bkBuild`; Hindi via `bkHiBook` |

## Themes

- **Aurora (dark)**: default. `data-theme="aurora"` on body. Dark background, gradient accents.
- **Night Sky**: `body.night-sky` class, adds nebula + star elements.
- **Classic (light)**: no theme attribute, white background.

CSS variables are defined at the top of the `<style>` block under `[data-theme="aurora"]`.

## Database

SQLite at `DB_PATH` env var, or `/data/taskflow.db` (Railway volume), or `./taskflow.db` (local).

Key tables: `users`, `tasks`, `otps`, `mind_gym_progress`, `steps`, `push_subs`, `meetings`, `meeting_voices`, `highlights`, `schedule_blocks`, `community_articles`, `bro_memory`

## Environment Variables (Railway)

| Var | Purpose |
|-----|---------|
| `DB_PATH` | SQLite path (Railway: `/data/taskflow.db`) |
| `RESEND_API_KEY` | Email OTP delivery |
| `GROQ_API_KEY` | AI chat (Bro) — free tier |
| `GEMINI_API_KEY` | AI chat primary — free tier |
| `VAPID_PRIVATE_KEY` | Push notifications (optional since v21: without it the server makes its own key in `DATA_DIR/secrets/vapid.json`; the key once committed to the repo is refused). `VAPID_SUBJECT` defaults to `https://brodoit.com` |
| `WHATSAPP_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification (default: `brodoit_verify_2024`) |
| `WHATSAPP_NUMBER` | Business number with +country code |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth |
| `OPENAI_API_KEY` | Talking Bro real-time voice (WebRTC); normally pasted in You → Admin instead; env is the fallback |
| `ELEVENLABS_API_KEY` | Studio voices: bulletins (EN/HI), Hindi book briefs, language lessons; normally pasted in You → Admin |
| `ADMIN_TOKEN` | `POST /api/bulletins/refresh?token=` to re-write today's bulletin |

## Common Tasks

### Change UI text/styling
1. Find the section with `grep -n 'keyword' server.js`
2. Edit server.js
3. Bump CACHE_VER: find `var CACHE_VER="vNN"` in the SW section, increment
4. Also update SW registration: `register('/sw.js?v=NN'`
5. `node -c server.js` to verify syntax
6. Commit + push both remotes

### Add a new API endpoint
Insert near related endpoints. Pattern:
```js
app.post('/api/thing',auth,async(req,res)=>{
  // auth middleware sets req.user = {phone, name, ...}
  res.json({ok:true});
});
```

### Frontend state
Global `S` object holds all app state. `render()` (via requestAnimationFrame) re-renders the whole page. `_render()` renders synchronously.

### Render functions
Frontend is vanilla JS. The `_render()` function returns the full HTML for the current tab. Each tab's content is in a section like:
```js
if(S.tab==='tasks') html += '...';
```

## Auth Pattern

Opaque token auth, NOT JWT. Token stored in `users.token` column. Auth middleware:
```js
function auth(req,res,next){
  const t=req.headers['x-token']||...;
  const user=db.prepare('SELECT * FROM users WHERE token=?').get(t);
  if(!user) return res.status(401)...;
  req.user=user; next();
}
```

## Git Remotes

- `origin` → `github.com/rishabh071106-eng/brodoit.git` (source of truth)
- `railway` → `github.com/rishabh071106-eng/taskflow.git` (deploy trigger)

## Pre-commit Checklist

1. `node -c server.js` — catch syntax errors
2. Bump `CACHE_VER` if frontend changed
3. Push to BOTH `origin` and `railway`

## WhatsApp Integration

Uses Meta WhatsApp Cloud API (not Twilio). Auto-creates accounts for new WhatsApp users. Merges accounts when users later sign up on web. Commands: list, done, doing, delete, help + natural language task adding.

## Content and copyright (v27)
Everything the app shows or plays must be ours, free-licensed with credit, or a link. Rules the code now enforces:
- **Books = Bro's book notes**, not summaries: `BOOK_SUMMARIES` (server.js SPA) holds 104 entries with `notes:1`, `why` (hook), `insights` = 5 × [idea, our own explanation and example, "try it today"], `take` (Bro's honest take), `summary` = the audio script ("Bro's notes on…", "Idea one. <title>. …", "Bro's take. …"). Written fresh from the ideas, never chapter by chapter, no quotes, no author anecdotes. The reader says so and links to Open Library ("Find the book"); an idea's "try it today" becomes a task (`bkTry`). Every note is recorded ahead of time in Bro's voice (`note-<id>`, Bro's library); `book-<id>` recordings of the old briefs are deleted at boot. Hindi notes: `modules/booknotes-hi.js` writes `MEDIA_DIR/books-hi/<id>.json` with `notes: 2` (Gemini, else Bro Core's background lane); older Hindi files are deleted, and `/api/book-hi` serves only `notes: 2`.
- **End-to-end tests live in the repo**: `bash test/e2e/run.sh` (after `npm ci`; Playwright's Chromium) boots the real server on a test database (`test/e2e/make-db.mjs`, two signed-in users) with outside fetches stubbed (`stub-fetch.cjs`) and runs `smoke` (every tab, English and Hindi, at 390×844), `bookvoice` (v31 narration) and `books` (v33 books in 7 chapters, the notes fallback, the public-domain originals). `scripts/book-ideas/validate.mjs app/ideas` checks the story chapters. Keep new suites here, not in a scratch folder (a container restart once wiped them).
- **v33 Books: books only, read in Bro's voice** (owner, 1 Nov: "I want books to be books only with voice"). The Books tab is Books · Audiobooks again (no Ideas feed, no quiz player, no saved cards; a phone that had Ideas open lands on Books). **Each book is the book in 7 chapters**, composed by `app/bookfull.js` (one file for the page, the server and the recorder, so the recorded text, the text the server checks and the text shown are always the same) from Bro's note (BOOK_SUMMARIES: 7 paragraphs, why this book, ideas one to five, Bro's take) and `app/ideas/<id>.json`: chapter 1 why this book + "Meet <hero>" + the first story; 2-6 Bro's explanation of the idea, its story, "In short: <takeaway>", "Try this today: …"; 7 the last story, its takeaway and Bro's take. Each chapter is one paragraph opening "Chapter one. <title>." (the player's sections). It is recorded whole in Bro's studio voice as `book-<id>` (~9 min, ~8,300 characters): `scripts/book-voice/notes.js` lists the 104 after the notes and briefs; `plan.js` gives no runner more than 27,000 characters (`BOOK_VOICE_RUNNER_CHARS`) and leaves the rest for the next run (`more=true`), which the publish job starts itself (`gh workflow run`, `actions: write`) while each run uploads something; `record.py` never starts a note it may not finish (`BOOK_VOICE_BUDGET_MIN`, 320). The server builds the same text (`_bookText('book-<id>')`), plays `book-<id>` only from the studio recording (404 otherwise, never queued for the live engine) and lists what it has at `/api/book-voice/ready` (`{ items: { id: secs } }`). The page (`app/ideas.js`, `BookIdeas.play`) plays `book-<id>` when it is ready, else Bro's recorded notes (the same 7 parts, so "from chapter 3" works for both) and says the book is being recorded. Book page: cover, Listen, the 7 chapters (tap = listen from there), read along (Bro's text, the story, the takeaway, "Try it today" with Add to my tasks, Bro's take); public-domain books add "The original, chapter by chapter". Hindi versions of the notes (`hi-<id>`) keep the old notes page. Bro's notes (`<id>`) stay recorded as the fallback.
- **v32 Books: every book as a story in 7 chapters, Ideas, and the public-domain books whole** (v33 removed Ideas, the chapter player with "What would you do?" and saved cards; the chapter stories live on inside the books) (owner, 1 Nov: keep the old precise book stories; if copyright stops that, an idea-card system with chapters and situations). The old chapter-by-chapter briefs of the 101 books still under copyright stay out: a chapter-by-chapter abridgement is an "adaptation" only the owner may make (Indian Copyright Act s.2(a)). **The 5 public-domain books** (Meditations, Discourses, Letters from a Stoic, Tao Te Ching, The Richest Man in Babylon) are back whole in `app/briefs/<id>.json` (quotes only from public-domain translations: George Long, James Legge), shown on the book page ("Chapter by chapter", `BookIdeas.briefHtml`) and played as `brief-<id>` (`_bookText`; recorded by the studio narration, never queued for Bro's live engine). **Every book** has `app/ideas/<id>.json` (written for Brodoit: one invented Indian main character through 7 chapters; never the book's own stories, anecdotes, examples or words): chapter 1 the problem (`why`), 2-6 the note's 5 ideas in order, 7 how it turned out (`take`); each chapter = the idea, the situation (80-150 words), "What would you do?" (3 options, the right one and why), the takeaway (+ the note's "Try it today"). `app/ideas.js` (`window.BookIdeas`) draws the chapter list on the book page, the chapter player (a full-screen overlay outside the shell) and **Ideas**, the Books tab's first section: one chapter's situation + takeaway per screen, swiped up, mixed across books in a daily order, unseen first; a bookmark saves one (the Saved button beside the sections). Progress, seen and saved stay on the phone (`ideas.prog.v1`, `ideas.seen.v1`, `ideas.saved.v1`). The Books tab skips the 10-second passive redraw. `scripts/book-ideas/index.js` rebuilds `app/ideas/index.json`. The 18 untraced motivational videos stay removed.
- **v31 Book voice: the book notes are read by a studio narration, not Bro's live engine** (owner, 1 Nov: "audio books is so bad now… I need that level for all books", without copyright risk). Cause: the live engine cuts recordings into ~60-character pieces (44 in Hindi, `LOW_CHUNK_CHARS`) so a call never waits, which broke the intonation of every sentence. `.github/workflows/book-voice.yml` reads each note a sentence group (≤ 260 characters) at a time on GitHub's free runners: English by **Chatterbox** (Resemble AI, MIT) in the timbre of a sample of Bro's own Kokoro voice (exaggeration 0.4, cfg 0.3: ~160 wpm), Hindi by **Kokoro-82M** (Apache-2.0, Bro's Hindi blend); every English take is checked against a Whisper transcript and read again when off, and a note still wrong is skipped (Bro's voice stays). Published as the release `book-voice-v1` (`manifest.json`: per note its file, sha256, bytes and the hash of the text it reads); `modules/bookvoice.js` copies the takes to `MEDIA_DIR/book-voice/` (boot + every 30 min, sha256-checked, 1 GB of disk kept free) and `/api/book-audio/:id` plays one only while the note's text is still the one it reads (`textHash`), else Bro's recording, else 404 `{live:true}`. Notes with a studio take are not recorded again in Bro's voice. Nightly runs read only new or edited notes and new Hindi notes (`/api/book-hi` on the live site); a change to `scripts/book-voice/voice/voice.json` re-reads all. Never edge-tts or a cloned real person's voice; /credits names the voices. Benchmark: `claude/voice-bench` (UTMOS ties ~4.5 for whole-sentence reads; Chatterbox Hindi mispronounced, so Hindi stays Kokoro).
- **News photos only from Wikimedia Commons** with a free licence (PD/CC0/CC BY/CC BY-SA; never NC/ND/non-free), found from the writer's `image_query` (`modules/newsphoto.js`), credited on the card, the Sources sheet, the share picture and `/n/` pages (`image_credit`). Never a publisher's or agency's photo (feed image, og:image); old ones are removed at boot. No free photo → the colour card.
- **News text in our own words**: the writer's brief says so, and `checkStory` sends back any 8-word run copied from a source (`COPY_RUN`). No writer → nothing is published (the extractive fallback is gone). The old feed (`curateNewsCategory`) no longer fetches article pages, relabels sources "Brodoit" or pads stories with filler. `/api/news/read` (stored article copies) is off unless `NEWS_READER=1`.
- **Official sources** (RBI, UN News, WHO, NASA feeds in `modules/newsfeeds.js`; any `.gov.in`, `.gov`, `.int`… link) are marked "Official source".
- **v28 News: a photo on every story.** `photoInto` (modules/newsdesk.js): the story's own subject on Wikimedia Commons, then Openverse (`findOpenverse`: CC0, public domain mark, CC BY, CC BY-SA only), else the section's pool (`POOL_Q`: free photos of each section's usual subjects, found once into `MEDIA_DIR/news-pool/pool.json`, credit marked `pool: true`). Every credit says where the photo is from (`source`). The same finder serves Thought of the day and readers' pieces (`global._newsPhotos`). **v28.1 matching:** the writer's `image_query` needs two thirds of its words in the photo's title or tags; a subject made from the headline (`queryFromHeadline`: proper nouns, no acronyms, no general words such as India or world) needs all of them (`find(q, { all: true })`). The hourly pass moves an older photo (no `fit` mark in its credit) that fails `fitsHeadline` / `fitsQuery` to its section's pool photo, only when a pool photo is there to give. **v28.2:** a headline subject needs two words or more (`headlineSubject`; one word alone → the section's photo), and each credit says how its photo was found (`via: writer|headline`); photos with `via` are never re-checked.
- **v30 News: news only, clean** (owner, 1 Nov): one feed mixes every section (`mix()`: the desk's order, but never two stories in a row from one section while another is left); no section bar, no Readers / Saved / Thought / Send views, and **no buttons** on the reading screen (no Save, Share, language switch, "Read the full story", "New stories" pill or nav buttons): the app's language decides News's language. No "written by" line anywhere; each story names its reports in plain text under the headline (`.nz-srcl`), and swiping a card left opens their links ("This story is a summary of these reports"). The photo credit stays (the free licences ask for it). `fit()` never cuts a story: type and photo step down, "Why it matters" steps aside last (the photo takes back its room), and only on the smallest phones does the text scroll in its card. Links shared before v30 to a thought or a reader's piece (`?s=th_…` / `rd_…`) open it as one card in the feed. The thought and readers modules still run on the server; the app no longer shows them as sections.
- **v29 News reader** (`app/news.js`, `app/news.css`): one story per screen, swiped UP for the next (the deck scrolls on y with mandatory snapping). Each card is the snap target and never moves; its inner layer `.nz-in` holds the story and, where `animation-timeline: view()` is supported, steps back and dims as the next card slides over it (Chrome snaps to transformed boxes, so never transform `.nz-card` itself). Photo edge to edge; Save (bookmark, `news.saved.v1`, the **Saved** chip in the bar) and Share on it; the foot strip names the reports (tap it, or swipe the card left). `fit()` never scrolls inside a card: type steps down, the photo gives way to 30%, "Why it matters" folds to one line, then the text ends on a whole line (at least five; on the smallest screens "Why it matters" steps aside) with "Read the full story" (a sheet with the whole story). News opens at once on the last visit's unseen stories (`news.deck.v1.<lang>`, 36 h) while the new ones load; a "New stories" pill appears when an edition comes in while you read.
- **v28.2 News desk pacing**: when Bro Core's background lane writes (gpt-oss-20b, 8,000 tokens a minute shared), stories go out ~45 s apart (`NEWS_PACE_SHARED_MS`), and a rate limit there waits 65 s (`NEWS_RATE_WAIT_MS`) and tries Bro Core once more before the next writer (the emergency ElevenLabs writer). `state.last.by` counts each writer's stories, `rate_waits` the waits.
- **v28 News sections and views**: AI is its own section (`NEWS_FEEDS.ai`: the labs' own feeds, "Primary source", and the tech press's AI desks); each edition gives every section a turn. The app opens on the first story (no front page); the bar under it holds the sections, Readers, Thought of the day and Send. **Thought of the day** (`modules/newsthought.js`): an original thought + the story behind it, EN + HI, never a quote (checked), seven Brodoit seeds when no writer. **Readers** (`modules/newsreaders.js`): signed-in readers send news tips, thoughts or stories; the AI editor publishes or declines each (with a reason) — never published unreviewed; contact details refused; 3 a day; two reports hide a piece; first names only; news tips say "Not checked by Brodoit".
- **Untraced media is not served**: the 18 motivational video clips (`MV_VIDEOS=1` to bring back once each is traced, files were removed from the repo) and the 37 script-less music/sleep/story files (`UNTRACED_AUDIO=1`). Don't add media without recording its source and licence.

## Don't

- Don't add `require('twilio')` — removed, using native fetch to Graph API
- Don't commit `.env` — it's gitignored
- Don't use `git push --force` — Railway tracks main branch
- Don't assume HMR — server must restart for any change to take effect


## Android (v9.4, v19 Google Play)
- `android/` — Kotlin TWA + background steps (`LauncherActivity`, `EnableStepsActivity`, `StepsEngine` → `RecordingProvider`/`SensorProvider`, `SyncJobService`, `Scheduler`, `Api`). Two flavors of one build (`.github/workflows/android.yml`): `direct` = `com.brodoit.app` (the APK at brodoit.com/android, a TWA), `play` = `com.brodoit.twa` (the bundle for the existing Play listing). targetSdk 36, versionCode = 1000 + run number. CI checks packages/versions/target SDK, installs both on API 35/36 emulators (`.github/scripts/android-smoke.sh`, `android-smoke-play.sh`), releases from `main` only, then checks the APK brodoit.com serves.
- Play build = WebView, not TWA (Oct 2026: a TWA's use counts as Chrome's, Testers Community refuses TWAs, and the earlier production application was rejected). `src/play/AndroidManifest.xml` removes `LauncherActivity`/`DelegationService` and launches `WebAppActivity` (same first-run steps detour and pairing URL; mic on request, file picker, back, other sites + Google sign-in in a Chrome tab, offline screen, edge-to-edge). `assets/bridge.js` runs before the page (document-start script, origin brodoit.com only) and fills in `navigator.share`, the clipboard, `SpeechRecognition` (Android recognizer) and `window.open` (Chrome tab) over `BrodoitNative` (web message listener); it sets `bd_twa`/`bd_twa_pkg` and `window.BrodoitApp`. No web push in the WebView yet (`notify.js` says so in the app). `R.bool.use_webview` picks the activity `EnableStepsActivity` returns to.
- `modules/android.js` — fetches the newest GitHub release (every 10 min), signs with the on-volume upload key, serves `/download/brodoit.apk`, `/android`, `/api/android/status` (with `play`), `/download/upload_certificate.pem` (Play Console's upload key reset); `global._androidCert()` feeds `/.well-known/assetlinks.json`.
- `modules/play.js` — uploads each signed Play bundle to Play's `internal` + `alpha` tracks (Play Developer API, service account from Admin → Google Play = `PLAY_SERVICE_ACCOUNT_JSON`; `PLAY_TRACKS`). States: no-account, no-access, waiting-key-reset, needs-declaration (Play Console wants an App content answer such as Health apps; Google sends 403 for it), uploaded, error.
- Steps client: `isTWA()` accepts `android-app://com.brodoit.*` and `?twa=1`; "Turn on" opens `intent://enable#Intent;scheme=brodoit;package=<twaPkg()>;end` (the app that opened the page).

- `modules/admin.js` `autoRecord()` — self-starting recording chain (bulletin → hindi-books → lang-audio), triggered by key save, boot (+90 s) and a daily 03:30 IST sweep; `GET /api/admin/status` → `auto`, `POST /api/admin/auto` runs it now. `ADMIN_AUTO_RECORD=0` disables.

## Voice (v9.5)
- `modules/elevenvoice.js` — `pickVoice(key, lang, getSetting)` (Admin setting → env → account voices by name → Adam), `speak()` with `eleven_turbo_v2_5` + language_code (multilingual_v2 rejects language_code). Used by bulletin, lang-audio, hindi-books and Bro's TTS.
- `modules/voice.js` — engines in order: ElevenLabs Conversational AI (`ensureAgent`, `/v1/convai/agents/create`, signed URL; `ELEVEN_AGENT_ID`/`_HASH` in settings; `global._voiceStatus()` for Admin) → OpenAI Realtime → classic (`/api/voice/turn`: OpenAI chat → Groq → Gemini with tools; `/api/voice/tts`; `/api/voice/transcribe`).
- `app/voice.js` — `V.connectEleven` loads `@elevenlabs/client` from esm.sh/jsDelivr, client tools → `/api/voice/tool`; full-screen overlay; `V.speak` prefers `/api/voice/tts`.
- AI keys in `server.js` are `geminiKey()` / `groqKey()` (Admin → env); `global._getSetting` is set once settings load.

## News Desk + mini-app chrome (v9.5)
- `modules/newsdesk.js` — (v22: three editions a day, see "v22 News" below; the rest of this line is the v9.5 design) batch every 30 min (+boot): all feeds → cluster duplicates (token Jaccard ≥ .28) → writer OpenAI → Gemini → Groq (JSON: headline, 55-65-word summary, why, Hindi trio, category; only facts from sources) or extractive fallback → `news_stories`. `GET /api/news/desk`, `POST /api/news/desk/run` (admin). `NEWS_DESK=0` disables.
- `app/news.js` — default view `top`: Brodoit Desk cards (`N.deckHtml`, `N.card`, `N.sizeDeck`), Listen via `N.say` (studio TTS), Explain via `N.explainObj`, Read via `N.readItem`.
- `lang/assets/topbar.{js,css}` — shared mini-app bar: one back control (parent ‹ or "← Brodoit"), home button on the right when there is a parent; cold-open back guard (referrer-based) so Android back lands in the app.
- Android first open asks the system Physical-activity permission directly (one tap); declining opens the app.

## Money-safe voice, Gemini models, sealed keys (v9.6)
- `modules/studio.js` — the only place text becomes speech (bulletin, News "Listen" via `/api/voice/tts` with `kind:'news'`, Bro classic replies, `scripts/lang-audio.js`, `scripts/hindi-books.js`). Order: ElevenLabs → Gemini TTS (`modules/geminivoice.js`, PCM → mp3 via ffmpeg) → OpenAI `gpt-4o-mini-tts`; null → device voice. `plan()` picks one provider per lesson/book. Monthly usage in `MEDIA_DIR/voice-usage.json`, shown in Admin ("Voice this month"). `/api/voice/tts` caches by text in `MEDIA_DIR/tts-cache` (a story is paid for once).
- ElevenLabs credit guard (`elevenvoice.js` `budget()`): reads `/v1/user/subscription`; purposes `live` (Bro) may use all that is left, `daily` stops with 30% of the plan left, `bulk` only uses the first 40%; never runs into overage. A quota error marks ElevenLabs out for 6 h and the next provider takes over; the voice session skips the agent while out.
- `modules/gemini.js` — every Gemini text call (server `_callGemini`, jobs, News Desk on the lite tier, Hindi translation). Google retires ids (`gemini-2.0-flash` is gone) → chain `GEMINI_MODEL` → `gemini-2.5-flash` → `gemini-flash-latest`. HTTP 402 = project out of prepaid credit → `err.code='credits'`; Admin checks Gemini with a real one-token call (listing models succeeds even with no credit).
- `modules/settings.js` `KEYS` must list every name read through `getSetting` (missing names silently fall back to env and throw on save — that is how pasted Gemini keys and `ELEVEN_AGENT_ID` were lost before v9.6).
- Sealed keys (`modules/sealed.js`): repos are public, so keys handed over in chat are encrypted to the server's own RSA key (private half in `dirname(DB_PATH)/secrets`, never served). Get the public key with the "Server public key" workflow (or `GET /api/seal/pubkey`), run `NAME=value node scripts/seal.js pub.json NAME`, commit `config/sealed-settings.json`; the next boot applies new items once (Admin edits are never overwritten).

## Card UI + live steps (v12)
- Look: the Books section everywhere. `app/cards.css` + `app/cards.js` (`window.Cards`): `Cards.cover()` (image-led cover card; photo by `key`, art fallback by `icon` + `tone-*`), `Cards.row()` (list card with 56-px photo thumb), `Cards.mini()` (small stat/action card), `Cards.sec()`; layout `.cv-grid`, `.cv-rail`, `.page-h`; one button system `.btn` (+ `accent/soft/light/glass/line`, `sm/wide`), `.btn-ic`, filled `.pill`s. Legacy `.b-btn`/`.b-chip` are restyled to match.
- Photos: `app/img/cards/<key>.jpg` (960×640) fetched by CI from Wikimedia Commons, free licences only (`scripts/fetch-images.js`, `config/image-manifest.json`, workflow "Card photos" on a `claude/*` push). Delete a jpg + push the manifest to refetch. Attribution at `/credits` (`modules/credits.js`).
- Screens: Home `app/voice.js` + `app/home.css`; Learn landing `app/learn.js` (`LearnUI.landing()`, hooked in server.js, legacy fallback); You `app/you.js` (`YouUI.html()` replaces `_youDash()`); Tasks `app/tasks.css`; Books `app/books.css`; Steps `app/steps.js/css`; News `app/news.js/css` (section-matched fallback photos).
- Live steps (`app/steps.js`): on Android the motion sensor counts whenever Brodoit is visible (no tap, no permission; iPhone shows "Count live"); the ring and the Home card tick up; display = max(server, base + live steps) with a per-account per-day floor (`bd_live_floor`) so a background Android-app sync never double counts and the number never snaps back. Deltas post as `source:'device'` (trust 1) at most once a minute.

## Learn = two schools, News = recorded cards, ElevenLabs brain (v13)
- **Learn tab** (`app/learn.js`, `app/learn.css`): only Python (`/code/`) and Languages (`/lang/`). Exam prep (`/prep`), jobs, the ML lab and the old inline AI/Product/fake-Python sections are retired; `/prep/*` → `/?tab=learn`, `/learning/*` → `/code/`, `/lang/phrases*` → `/lang/`. Japanese and the phrasebooks were removed; the language school is es/fr/de/hi (taught in English) + en (taught in Hindi).
- **Python: Zero to Hero** (`/code`): 60 days in `code/days/dNN.json` (format: `code/COURSE.md`, syllabus: `code/SYLLABUS.md`). Real CPython runs in the browser: Pyodide pinned in package.json, served by `modules/pyhost.js` at `/code/py/<ver>/` (brotli/gzip precompressed into `MEDIA_DIR/.cache`), executed in `code/assets/pyworker.js` with `code/assets/harness.py` (output capture, stdin, step tracer for "Watch it run", exercise tests). **Always run `node scripts/code-check.mjs`** after editing a day: it runs every snippet in the same harness, checks expected output, predict answers and that exercise solutions pass and starters fail, and rebuilds `code/days/index.json`. Bump `HARNESS` in `code/assets/runner.js` when harness.py changes.
- **Player UI**: `code/day.html` + `assets/player.js` (slides, editor.js, trace.js, visuals.js — 12 animated visual kinds), mission map `code/index.html` + `assets/map.js`, Bro dock `assets/coach.js`. Progress lives in `localStorage bd.py.v1` and syncs to `/api/learn/progress`.
- **modules/learn.js**: progress tables (`learn_units`, `learn_stats`, `learn_events`), `POST /api/learn/coach` (Bro with the learner's profile, slide, code and error), and narration recorded once: every `say` line and every target-language phrase is a catalog entry (`sid = sha1(voice + "\n" + text)[0:20]`, same on client); `GET /api/learn/say/<sid>.mp3` serves `MEDIA_DIR/learn-voice` or records it on first play; `scripts/learn-audio.js` (Admin job `learn-audio`) pre-records everything. Language pages' `speak()` (lang/assets/lang.js) plays these clips before the device voice.
- **Languages UI**: `lang/course.html` + `lang/assets/stages.css` (photo hero, Listen episodes, practice stages with a gate); lessons add combo/XP/burst and sync completions to `/api/learn/progress`.
- **v20 Smartest-first brain**:
  - **Clouds** (`modules/brocore/brain.js`): the clouds are Groq, Google and OpenAI. Model ids are prefixed `gemini/` and `oai/`; Google uses its OpenAI-compatible endpoint.
    - On live turns, Google's newest stable Flash (read from its `/models`, falling back to `gemini-2.5-flash`) comes right after gpt-oss-120b. An OpenAI model comes next if `OPENAI_API_KEY` is set. The rescue lane also ends with Flash.
    - A refused key skips that cloud for 10 minutes, and the other clouds go on. A server with only a Gemini key still works.
    - `BROCORE_CLOUDS` (e.g. `groq,gemini`) switches clouds off. `health().clouds` and `/api/bro/ok` `clouds` list the models in use.
  - **Difficulty** (`modules/brocore/route.js`): `difficulty(text)` → `{ hard, filler }` uses instant rules: maths, code, planning, comparisons, why/explain, several questions, or over 200 characters.
    - `req.hard` → reasoning `medium` on a call and `high` in typed chat.
    - On a call, a hard puzzle (not feelings) first gets "Ooh, good one! Let me think."
  - **Calls** (`converse` in `modules/voice.js`): the cloud answers first. If the cloud can't say a word, Bro's own brain answers at once. That covers every model failing, and also no first words within `BRO_CLOUD_BUDGET_MS` (default 7 s, +5 s for hard) while the own brain is free. Then the rescue, then the apology. The `own:only` self-test is unchanged.
  - **Typed chat:** `POST /api/voice/turn` with `stream: true` answers over SSE:
    - `{t:'delta'}`, `{t:'action'}`, then `{t:'done'}` or `{t:'error'}`
    - `app/voice.js` `V.send` shows the words as they come and speaks sentence by sentence when the voice is on
    - the own brain is the backup, then the old brains
  - **App actions in chat and calls:** `BRO_TOOLS` + `EXTRA_TOOLS` run via `runTool`, so Bro can add/finish tasks, set reminders, add events, read the schedule, steps and news, and open lessons and screens.
    - They sit behind the GATED/INTENT guard. The page gets `{t:'action'}` for toasts.
    - A non-tab `open` waits for the call to end.
    - `BRO_APP_TOOLS=off` turns them off.
  - **Status:** `/api/bro/ok` `live` adds `cloud`, `own`, `ownBackup`, `ownSlow`, `ownSkip`, `cloudSlow`, `firstMs` (p50 for the cloud's first words on calls), `chatFirstMs` and `chatOwn`.
- **v20 Voice notes**:
  - **The recorder:** `app/voicenote.js` (`window.BroNote.open({ lang, onSave, onAppend })`) is a full-screen recorder. It has a 96 px record button, a live waveform, a timer capped at 10 minutes, pause/resume and discard (tap twice). Notes shows a big "Record a voice note" card, and the editor's Voice button opens the recorder with "Add to this note" (`noteVoice()` in server.js).
  - **Transcription:** the recording is cut into ~2-minute pieces (each a complete file), and each piece is sent to `POST /api/voice/transcribe` with the recorder's real type while the next one records.
  - **Review:** the text is editable and can be translated via `POST /api/notes/translate { text, to }` (`modules/notes.js`, Bro Core's brain). "Show original" brings back your own words. Then "Save as note" or "Add to this note".
  - **Nothing is lost:** the words so far are kept in localStorage `bro_note_draft` until saved. Closing mid-way finishes the transcription and saves the note by itself, and a left-behind draft comes back the next time the recorder opens.
  - **The old endpoint:** `/api/transcribe` (always 401 before) now forwards to `/api/voice/transcribe`.
- **v20 Languages**:
  - **Openings:** every Listen lesson (`lang/audio/<code>.json`, `short: true`) opens with one line ("Lesson N. Let's go!…", in Hindi for the English course), then the last instruction before the first speak-back. The welcome, the opening dialogue and its recap were cut.
  - **Playback:** `lang/audio.html` plays line by line in Bro's voice (v21: see "One Bro voice" below for fetching and prefetch). The stitched lesson mp3 is no longer used.
  - **Clip catalog:** `modules/learn.js` covers every Listen line too: guide `n`/`q` lines under the learner's language key (en, or hi for the English course), `t` lines under the course key. The fill-in sentence uses `options[answer]`.
  - **Recording:** replaced in v21 (see "One Bro voice" below). Nothing paid is used unless the emergency switch is on, and Admin no longer auto-runs the paid `learn-audio` / `lang-audio` jobs.
  - **Speak-back** (`hearPhrase` + `matchPhrase` in lang.js):
    - **Hearing:** the phone recogniser (SpeechRecognition) is used when it works. Otherwise MediaRecorder with voice-activity detection records the answer and sends it to `POST /api/voice/transcribe?lang=<course>&expect=<phrase>`. Every Bro Core language is accepted, and `hear.js` never drops the expected phrase as a phantom.
    - **Match:** accents, punctuation and number words are folded first; a close sentence must also have its words.
    - **Flow:** a wrong try shows "You said …" and Bro says the line again. Silence shows "I didn't hear you". After three wrong tries or two silences, Bro waits for a mic tap. Nothing advances by itself.
    - **Ways out:** "Hear it again" and "Stop for now" (the place is kept in localStorage `lang.pos.<code>/<id>`). Skip is gone.
    - **Practice:** the Practice `speak` card passes only when it's right. "Can't speak now" pauses the lesson.
- **v21 One Bro voice** (the owner heard a different speaker in Languages than on calls):
  - **One timbre** (`modules/brocore/voice.js`): the energetic and bright styles are one voice in every language. es/fr/de/it/pt speak with Bro's English blend (`am_fenrir:0.6+am_puck:0.4`) and their own espeak phonemes at pace 1.0. hi/ja/zh mix in a quarter of the native voice (`am_fenrir:0.45+am_puck:0.3+hm_psi:0.25`, hi ×1.04). `oneVoice()` ignores per-language `BRO_VOICE_SPECS`, and the nightly A/B skips it. `deep` keeps the old per-language voices (rollback). The GPU clone (`gpu.js`) speaks only in the deep style.
  - **Voice key:** `voiceKey()` (style + sha of every language's spec and pace; `B.voiceKey()`) names the folders recordings live in, so a new voice re-records everything and an old recording is never played.
  - **Wait, don't refuse:** `admit(lane, {wait, signal})` lanes are `course` (`MID_MAX` 2, for a line a learner waits for) and `low` (`LOW_MAX` 3). A request over the limit waits FIFO up to `wait` ms (`WAIT_MAX` 32 waiting in all), else `VOICE_BUSY`. Live speech still goes first. `speak()` takes `priority: 'live'|'course'|'low'`, `wait` and `noCache` (skip the mp3 cache). `/api/voice/tts` waits 15 s (503 + Retry-After after that). German goes through Bro Core too.
  - **Course clips** (`modules/learn.js`): `learn-voice/bro-<voiceKey>/<sid>.mp3`, served `no-cache` + ETag.
    - A missing line is recorded on request: `?p=now` (the line playing) in the course lane with a 25 s wait, otherwise low with a 60 s wait.
    - While the voice is loading the route waits up to 20 s, then answers `503 Retry-After`.
    - The crawler (`crawl()`, every 10 min) records the whole catalog, warm lines first. It pauses during live calls (`global._liveCalls()`, at most 3 min at a time) and stops under 1.5 GB free.
    - `sweep()` deletes folders of other voices untouched for 14 days.
    - `scripts/learn-audio.js` (ElevenLabs) is retired (`--studio` to force).
  - **Client** (`lang/assets/lang.js`, `CLIP_V='v21'`):
    - `fetchClip` retries 503/429 by `Retry-After` for up to 45 s, and a "Bro is getting ready…" pill shows after 1.2 s.
    - The current line is asked for first (`p=now`). At most 2 lines are fetched ahead, only once the line plays (`speak(..., {onStart})`).
    - A 404 (text outside the catalog) is read live via `/api/voice/tts`. The phone's voice is used only offline or when the server keeps failing, with a toast.
    - Clips play at the speed buttons' rate.
  - **Bro's library** (`modules/brolibrary.js`): the 4 breathing cues and the 9 affirmation/meditation scripts are recorded once in Bro's voice (`MEDIA_DIR/bro-voice/<voiceKey>/<key>.mp3`). They are spoken part by part with real silences (2.2 s between paragraphs, 1 s at "…"), low priority, stepping aside for calls. `/api/audio/:id` and `/api/breathe-audio/:id` serve them first (`sendAudio`: Range, ETag, no-cache), and the bundled file until then. Client URLs carry `?v=21`. `/api/learn/voice-status` reports `voice`, `crawler` and `library`.
- **v21 Bro hears quiet voices** (a soft voice wasn't heard well):
  - **Server** (`modules/brocore/hear.js`): loudness is measured per 20 ms frame (`frameStats`: speech level, 10th-percentile floor, SNR, peak).
    - Recorder clips (webm/ogg/mp4) are decoded with ffmpeg first (`decodeToPcm`, a temp file). A clip ffmpeg can't read goes to Whisper as it came.
    - Silence: p95 < −58 dBFS, or fewer than 3 frames 6 dB above the floor while p95 < −45 dBFS. Silence never reaches Whisper.
    - Quiet speech is raised to about −20 dBFS before Whisper (`normalize`: at most +30 dB, never past −1 dBFS).
    - A phantom-list word ("okay", "Thank you.") is dropped only when Whisper doubts it (`no_speech_prob > 0.4`) or it is faint (speech < −50 dBFS and SNR < 10 dB).
    - `hear()` returns `level`.
  - **Calls** (`app/voice.js` VAD):
    - Start thresholds: floor + 9 dB (energy), + 4 dB (Silero). A phrase continues above + 5 / + 4 dB.
    - The floor is the 20th percentile of the last 3 s of frames Silero calls non-speech (`vadFloor`), so a soft voice can't drag it up.
    - Silero hearing speech that stays under the start level for ~640 ms shows "Speak a little closer" (`closerCheck`, at most every 30 s).
  - **`app/micgain.js`** (`MicGain.wrap(stream, {ac})` → `{ stream, level(), gainDb(), close() }`):
    - Chain: high-pass 80 Hz → gain → limiter → a −1 dBFS ceiling.
    - The gain targets −24 dBFS speech (0–24 dB; up 1.5 dB / 100 ms, down 6 dB) and is remembered in localStorage `bd.micGainDb`.
    - Used by the Languages recorder (lang.js `recordUtterance`) and voice notes (the waveform still reads the raw mic).
  - **Languages speak-back:**
    - The floor is the 20th percentile of what was heard, frozen once speech starts. Speech is > max(0.0025, floor × 2).
    - A quieter voice heard for 300 ms is sent anyway and the server decides.
    - The phone's recogniser returning "no-speech" falls back to the recorder (`via: 'rescue'`). After two rescues, localStorage `lang.hear = 'rec'` skips the recogniser.
- **v21 One app + speed** (games and lessons felt like another site):
  - **The layer** (`app/frame.js`, loaded first in the SPA head): `BroFrame.open(url)` shows `/lang`, `/mind` or `/code` pages in a full-screen same-origin iframe (`allow="microphone; autoplay; fullscreen; screen-wake-lock"`).
    - It adds one history entry (`?frame=<page>`, so reloads, deep links and notifications reopen it). Every `<a>` to a mini-app opens there, and so do `BroFrame.go(url)` (Bro's open actions, the Python row) and `?frame=`.
    - The phone's back asks the page's `bdFrameBack()` first, then closes the layer.
    - Messages: `bd-close {url}` closes and routes in the app (`route()`: tab + Learn hub); `brodoit-xp {xp}` shows "+N XP".
    - If the SPA ever loads inside the layer it closes it (safety net). `localStorage bd.frame = 'off'` turns it off.
  - **Inside** (`app/inframe.js`, first script in every mini-app page): `bdFramed` and `bdGo(url, {replace})`. Inside the layer, mini-app pages replace each other and app URLs post `bd-close`. Links are caught in the capture phase.
    - `bdFrameBack()` follows `.bd-back` / `.ui-back` when it leads to another mini-app page. `window.bdBackHandler` overrides it (the Mind engine pauses a round).
    - `topbar.js` skips its back guard inside the layer. `@view-transition` is in `app/ui.css`.
  - **The page:** `window._DQ` holds `{q, a}` only (~40 KB). Today's story comes from `GET /api/quotes/:n` (`_dqStory()`, prefetched after 4 s).
    - `/` is built once and compressed once (brotli/gzip). It is sent `private, no-cache` with an ETag per encoding (304s).
    - The `pending_otp_email` cookie still gets an uncached page.
  - **Assets** (`modules/compress.js` `staticText`): brotli/gzip for js/css/html/json/svg under `/app /lang /mind /code`, in a 48 MB in-memory LRU keyed by size + mtime. `no-cache` + an ETag per encoding. `..` paths are refused.
  - **Service worker:** `CACHE_VER = v183-<commit>`, so a deploy drops old caches.
    - Install precaches `/`. Navigations are network-first with the cached copy offline (`/` and mini-app pages).
    - `/app /lang /mind /code` and icons are served stale-while-revalidate.
    - Never `/api/`, Range requests or no-store responses.
- **v21 Exciting Languages** (learning felt flat; DESIGN.md "Celebration" allows this in lessons and games only):
  - **Store** (`lang/assets/lang.js`): `addXP(n, {course})` adds to the total, the day (`daily`) and the course (`courseXp`). It fires `lang-xp` `{xp, total, today, goal, goalReached, streak, streakUp, course}`.
    - `stats(course)` gives the streak, today vs the 50 XP goal, and the course XP. `completeLesson(key, xp)` returns the store plus `.ev`.
    - A store from before v21 (no `courseXp`) counts 50 per finished lesson, once.
  - **Shared rewards** (`lang/assets/fun.js`): `mountStats` (flame, goal ring, XP; updates on `lang-xp`), `xpPop`, `combo`, `sfx`/`buzz` (window.Sfx and haptic), `muteButton`, `mascotStage`, `celebrate`.
    - `cheer(kind)` plays Bro's recorded line from `lang/data/cheers.json` (en/hi: yes, five, ten, done, goal, streak). The cheers are warm catalog lines in Bro's voice.
    - Reduced motion: still pops, no confetti, no bobbing.
  - **Listen** (`lang/audio.html`): a speak-back right first time earns +2 (+1 after a retry). Every 5 in a row adds +5, the combo sound and "Five in a row!" (ten: "On fire"). A wrong try resets the combo.
    - Bro on the stage speaks, listens and celebrates. Finishing adds +20.
    - The end screen shows what was really earned, said-right-first-time N/M, the streak and minutes, badges (Streak +1, goal), Next, and "Talk to Bro in X".
  - **Practice** (`lang/lesson.html`): +2/+1 per answer, +5 per 5 in a row. Finishing adds +20, +10 more when perfect. End badges: Streak +1, goal, Unit complete, Perfect.
  - **Course page** (`lang/course.html`): every unit is a zig-zag path of nodes (done / current "Start" / open / locked). It has a big Continue to the next undone item, the stats strip and "Talk to Bro in X".
  - **Talk to Bro in X** = `/?tab=bro&persona=language&course=<code>`. Inside the layer, `bd-close` routes it to Bro with that persona and course.
    - `modules/voice.js` `courseLine(text, code)` speaks the persona's es/fr/de sentences with that language's pronunciation; English coaching stays English.
  - **Sync:** POST `/api/learn/progress` carries the course's real XP and `daily` (the last 14 days). The server keeps `learn_daily(user_phone, day, xp)` (max, within −40/+2 days).
    - GET `?course=lang` returns every course plus 60 days of `daily`. `pullProgress()` (course page, Languages hub; at most once a minute) merges it, so a new phone gets its lessons, XP and streak back.
    - The Learn → Languages hub shows the streak, today's XP and each course's XP.
- **v21 News without Bro, seen memory, share links** (Bro was on every card; scrolled stories came back; shared links got lost):
  - No "Ask Bro" in News: the orb, the empty-state mascots and `BroVoice.askAbout` are gone.
  - **Seen:** a card on screen for 1.5 s, or swiped past, is seen.
    - The phone keeps `localStorage news.seen.v1`: ids for 30 days, plus each story's words for 14 days. A signed-in reader's server keeps `news_seen` (`POST /api/news/seen`, batched, flushed when hidden).
    - `/api/news/desk` leaves out seen ids and any story whose headline + opening is ≥ 0.45 alike a seen one, so a rewrite with a new id is caught too. It pages past them and answers `caughtUp`.
  - The deck no longer goes round again. It ends on a "You're all caught up · Next edition at …" card (v22) with "Check again". Back on News after 20 minutes away, it reloads what is new.
  - **Links:** `?tab=news&s=<id>` (and `NewsChannel.open(id)`, also from `BroFrame.route`) opens that story even when seen, fetching it with `GET /api/news/story/:id` if needed.
  - **Share** opens a sheet:
    - Share picture: the story as a JPEG whose footer prints `brodoit.com/n/<id>` and a QR code (`app/vendor/qrcode.js`, MIT, loaded on first share). Text and link go along.
    - Share link (`navigator.share({url})`) and Copy link.
  - `POST /api/news/share {id}` snapshots the story into `news_shared` (90 days, outside the feed; its photo is kept) and returns `<PUBLIC_URL>/n/<id>`.
  - **`/n/<id>`:** the story's own page with og/twitter tags, the readable story, sources, Hindi under "हिंदी में पढ़ें", and "Open in Brodoit".
    - A signed-in visitor (tf_token cookie) gets a 302 to `/?tab=news&s=<id>`.
    - `/n/<id>/card.png` (resvg) is the preview picture when the story has no photo.
- **v21 Phone notifications** (nothing subscribed phones; reminders ran on server time):
  - **Keys** (`modules/pushkeys.js`): `VAPID_PRIVATE_KEY` (its public half derived), else `DATA_DIR/secrets/vapid.json`, made once. The once-committed private key is refused.
    - Every subscription records its key (`push_subs.vapid`). One made with another key is skipped until the app re-subscribes.
    - A 401/403/404/410 from the push service deletes the subscription. Every push goes through `_push.send` (`pushTo`).
  - **App** (`app/notify.js`):
    - `Notify.enable({ask})` / `Notify.subscribe()` subscribe with the server's current key (replacing one made with an older key). Already allowed → it re-subscribes 4 s after start.
    - Onboarding's bell subscribes.
    - You → Notifications (`Notify.open()`): on/off, morning and evening summary times, "Send a test".
  - **Summaries** (`modules/digest.js`, a 60 s tick on each user's own `users.tz`, India when unknown; once a day per kind, `push_sent`; within 15 min of the time). Each is built from the data at send time:
    - Morning (08:00): today's tasks with times, plan blocks, the step goal, yesterday's steps and streak, the top story → `/?tab=tasks`.
    - Evening (20:30): steps against the goal, the streak, open tasks and tomorrow's → `/?tab=steps`.
    - While the evening summary is on, the steps module's own evening nudge stays quiet (`global._digestOwnsEvening`).
    - Routes: `GET/POST /api/notify/prefs`, `POST /api/notify/test`, `GET /api/notify/status` (counts only).
  - **Reminders** fire at the task's local date and time (up to 10 min late after a restart), once. The water reminders run 8:00–21:00 local. Bro's tools use the user's local date for "today". The steps push opens `/?tab=steps`.
  - **Service worker:** a push carries `tag`, `renotify`, `requireInteraction` (reminders only), `/app/badge-96.png` (white Bro bubble) and a same-site `url`.
    - A tap focuses the open app and posts `bd-route` (`frame.js` → `BroFrame.go`: a tab, a lesson in the layer, a story), or opens the url.
  - **Android:** `POST_NOTIFICATIONS` plus android-browser-helper's `NotificationPermissionRequestActivity`, and a white small icon (`@drawable/ic_notification` as the DelegationService `SMALL_ICON`). CI checks the permission; the emulator test grants it.
- **v22 News** (owner: the same news came back, Hindi stories in English mode, cut-off summaries, refresh 3 times a day, no Bro, a UI people don't miss):
  - **Editions** (`modules/newsdesk.js`): 07:00, 13:00 and 19:00 India time (`NEWS_EDITIONS`, "HH:MM,…" IST). `editionOf(now)` → `{id: YYYY-MM-DD-HHMM, label, label_hi, at, next_at}`.
    - A 60 s `tick` makes the current edition once (`news_editions`). One with nothing new is tried again 20 min later, at most 3 times. There is no 30-minute batch any more.
    - Up to `NEWS_PER_EDITION` (20) stories, `NEWS_PACE_MS` (4 s) apart. `news_stories.edition` records which edition wrote each one.
  - **Writers**, best first: Gemini Flash (its own provider), then Bro Core's background lane (purpose `news`: scout, qwen3-32b, 8b-instant). Never gpt-oss: its allowance is live talk's. OpenAI/Groq/ElevenLabs are used only in the emergency mode.
    - The prompt is a senior wire editor's. It asks for an 80-110-word summary, a "why it matters" line (12-25 words) and the Hindi trio. It lists the last two days' headlines ("RECENT"), and the writer answers `duplicate_of` for a repeat.
    - The writer reads the articles themselves, not only the feed's line or two: `enrich(c)` reads up to 2 per story through `modules/newsreader.js` `readArticle` (public addresses only; 15 s; Hindi-only text dropped). Their text counts as the sources for the number check. It is off when `deps.readArticle` is absent (tests) or `NEWS_READ_ARTICLES=0`.
    - The extractive fallback runs only when no writer exists. Raw feed items never reach the deck.
  - **Every story is checked** (`checkStory(story, sourceText)` → `{en, hi}` problems):
    - The English fields must have no Devanagari. The headline is 4-16 words with no "…"; the summary is 70-135 words (the boot cleanup removes anything under 70) and ends on a full sentence; "why" is 6-40 words.
    - Every number (other than 0-12) must appear in the sources.
    - The Hindi fields must be ≥ 60% Devanagari, and `summary_hi` must be 55-170 words with a proper ending.
    - Problems → one repair round (the draft plus the problems), then the next writer. Good English with bad Hindi is published English-only.
    - Nothing is cut: stored up to 1400/1800 chars.
  - **No repeats** (live on 22 Oct: the Musk Tesla-SpaceX merger 6 times, others 2-3 times):
    - `sameStory(sigOf(a), sigOf(b))` = one event:
      - headline + opening ≥ 0.45 alike with 2+ telling words shared; or
      - headlines sharing 4+ words, 3+ of them not `GENERIC` ("elon musk tesla spacex", not "police arrest three"), making up 60% of the shorter headline.
    - A cluster whose link or any item matches a story of the last 3 days is skipped before asking a writer.
    - The writer sees up to 30 recent headlines that share a telling word with its story (`relatedHeads`) and answers `duplicate_of`.
    - At boot, a repeat from the last 4 days is deleted (the best-sourced story stays). The deck never shows one event twice on a page (`once()`), plus v21's seen memory.
    - A cluster that is all Devanagari (a Hindi feed) is skipped.
  - **Boot cleanup:**
    - Deletes stories with Devanagari in the English headline or summary, or a summary ending "…".
    - Clears a Devanagari `why`, and Hindi fields that aren't Hindi.
  - **Desk API:**
    - `?lang=hi` serves only stories with Hindi. The first page is the newest edition first, then score.
    - `older` pages never fill from raw feeds.
    - Every answer carries `edition` (`editionInfo()`). `GET /api/news/edition` → `{id, label, at, next_at, count, ready}`.
  - **App** (`app/news.js`, `news.css`):
    - The deck opens on the edition's **front page** (`{kind:'cover'}` at index 0): "Morning edition" + date, "The stories that matter now", section chips (`NewsChannel.setCat`, reloads), the lead story big with its photo (when it has one), then the next headlines numbered (tap → that story), and a pinned footer with "Next edition at 1 pm" and Start reading.
    - Each card: section + time on the photo, headline, story, a **Why it matters** box, and "Sources: The Hindu, NDTV +1", which opens the original reports (`NewsChannel.sources(i)`).
    - A slim progress bar sits on top. English mode never shows Devanagari; Hindi reloads with `lang=hi` and shows only Hindi stories, with Hindi times ("दोपहर 1 बजे").
    - A dot on the News tab (`body.nz-fresh`) marks an edition this phone hasn't opened (`news.edition.seen`, checked 3 s after start and on return). The caught-up card names the next edition.
  - Tests: `scratchpad/v21/p6-news.mjs` (checks, editions, fake writer: repair, duplicates, English-only, cleanup, desk; Chromium: front page, why, sources, progress, Hindi, dot). Live check: the "News quality" step counts Hindi-in-English and cut-off stories.
- **v23 Bro the agent, the calendar, one voice** (owner: asked to write a plan, Bro "kept saying Listening"; events must be recorded as asked and synced with the calendar; the voice must be the same everywhere):
  - **Never silence** (`modules/voice.js`). A reasoning model can spend its whole allowance thinking and answer with no words. A call then said "Ooh, good one! Let me think." and went back to "Listening…".
    - Actions with no words after them (`T.done`, `T.textRound` ≤ `T.toolRound`): Bro says what he did, with `doneLine(done, lang, dayWordFor(user))`. Example: "Done. I've put 2 things in your calendar for tomorrow: Revise maths at 9 am, …". Hindi: "हो गया। … सुबह 9 बजे …".
    - No words at all: one more try (`EMPTY_RULE`, effort low, no new tools). Then `EMPTY` goes to the own brain, the rescue, the apology.
    - Typed chat (`streamTurn` and the plain path) gets the same done line, never an error after the work.
    - Calls get `maxTokens` 1400/1800, typed chat 1600/2400.
  - **`write_down {title, text}`** (EXTRA_TOOLS): a plan, list, timetable or draft.
    - The page shows it as a card in the thread (`.bv-doc`: times bold, bullets, Copy, Share). It saves it in Notes (`tf_notes`, the new "From Bro" category `bro`). During a call it stays on the call screen (`.bvf-doc`).
    - Bro sums it up in a sentence or two; the history carries the card's text, so "put that in my calendar" works.
  - **The rules** (`APP_RULE`) cover writing and the calendar: event / block / task / reminder, use exactly what they asked. `datesFor(user)` gives today, now and the next 7 days as YYYY-MM-DD in their time zone (unknown → Asia/Kolkata).
    - The intent guard (`INTENT.remind`) also accepts add / put / book / plan / appointment / exam / class / interview / birthday, and जोड़ / डाल / कैलेंडर.
  - **Calendar** (`server.js` `_broExecTool`):
    - `create_calendar_event` always saves in Brodoit: at a time → a `schedule_blocks` row (colour `#2F6FDE`, default 60 min); all day → a task on its date (`source 'bro-event'`). It also goes to Google Calendar when connected. Before, without Google the event was lost.
    - `_hhmm` takes "9:30 pm", "21.30", "7:05 a.m." and similar; `_isDayStr` and `_addMins` (capped 23:59) check dates and ends.
    - A same title, date and start is not booked twice (`already`).
    - `set_reminder` uses the user's date, no longer UTC.
    - `_gcalCreateTimed(…, opts)`: Google's `colorId` must be "1"-"11". The hex colour made Google refuse every block, so nothing ever synced. Bro's events go as themselves (blocks stay "🔒 label"); an unknown time zone is India's; all-day ends the next day.
    - `GET /api/schedule?from=&to=` returns a range. The Calendar tab loads the month (`calBlocksLoad`, `window.calBlocksRefresh` after Bro acts) and shows the selected day's plan (`.cal-plan-row`, times, a "Google" chip). It puts a dot on days with a plan and hides a Google event that is one of ours.
  - **One voice** (the sweep found the other voices):
    - **Book summaries** (`/api/book-audio/:id`): Bro's recording (`MEDIA_DIR/bro-voice/<voiceKey>/book-<id>.mp3`), else 404 `{live:true}`. The player then reads it live in Bro's voice, the next chunk fetched ahead with `BroSay.warm`, and the summary is queued for the library (`_wantBook`, `books-wanted.json`).
      - Texts come from the page's `BOOK_SUMMARIES` (read once from the built HTML in a `vm`) and `books-hi/<id>.json`. The old edge-tts and ElevenLabs narrators only play with `BOOKS_OLD_AUDIO=1`.
    - The AI-lesson "Listen" uses `BroSay.speak`; it was the phone's voice only.
    - `BroSay` asks a busy voice (503) again twice, after its Retry-After (1-4 s), before the phone's voice.
    - A call whose voice is still loading waits once, up to 10 s, before captions-with-the-phone's-voice.
  - Tests: `scratchpad/v21/p7-agent.mjs` (call pipeline with `scratchpad/v23/stub-agent.js`; the real server in Chromium with `scratchpad/v23/stub-gcal.cjs`, a fake Google Calendar).
- **v24 one app, one language, one look** (owner: "I still see inconsistency": voice, Hindi/English mixing, look and layout, Bro and the calendar):
  - **One language for the whole app.** Before, `S.lang` was never set, so every `S.lang==='hi'` screen stayed English while Bro chat (`bro.lang`) and News (`news.lang`) each kept their own switch.
    - `S.lang` comes from `_initLang()`: `bd_lang`, else `bro.lang`, else `news.lang`. All three keys are then kept equal, and `<html lang>` follows.
    - `window.setAppLang(l, from)` is the one switch. The You tab's Language row calls it, and Bro chat's (`V.setLang(l, fromApp)`) and News' (`N.setLang(l, fromApp)`) switches call it too. It updates the others and re-renders.
    - `_T('English', 'हिंदी')` is the helper for SPA strings. The mini-apps read `bd_lang` themselves (`/lang/` list; `/mind/` via `HI`/`tr` in `mind/assets/util.js`).
    - Content keeps its own language. A course is in the language it teaches in (the Spanish course is taught in English; `/code/` is English). Book texts, News stories and the user's own words are left as they are.
    - Books open their Hindi version in Hindi mode when one exists (`_bkWantHi`; choosing English sticks per book).
  - **Hindi chrome** on every tab and the screens one tap deeper:
    - tab bar; Tasks/Notes; Today/Upcoming/Done; Notes list, categories (`NOTE_CATS[].hl`) and editor;
    - Calendar month, weekdays, Google card, day plan, schedule sheet and Google event sheet;
    - Books switches and categories, reader and player; add/edit task; profile; the Learn → Languages list; the Mind games.
  - **Look:**
    - Every switch, chip, calendar day and icon button is at least 44 px: `#app` rules at the end of the SPA CSS, `.ui-seg`, `.nz-cv-chips`, `.bk-seg` in `app/cards.css`, `.bkp-ib`, `.note-tool-btn`, `.cal-nav`.
    - No emoji in titles or buttons (the add-task, schedule and reader buttons). The book text uses the app's one font, not Georgia.
    - The book player says "Bro's voice" (both ways of playing are Bro since v23).
  - Tests: `scratchpad/v21/p8-consistency.mjs` is the audit and the regression (`MODE=report` prints everything found).
    - It uses the real server, a 390 px phone, and English then Hindi.
    - It covers every tab, the deeper screens (`DEEP`) and the mini-apps.
    - Rules: the app, Bro and News share one language; no Devanagari in English; no English words in Hindi (outside names and content); one type family; no sideways scroll; 44 px targets; no emoji in chrome; every sound is Bro's voice.
    - Screenshots go to `scratchpad/v21/p8shots`.
- **News** (`app/news.js`): cards only (desk stories), section chips, "Listen" plays recorded headline clips back to back. `modules/newsvoice.js` records after every desk batch through ElevenLabs only (`NEWS_VOICE_PROVIDER=any` opens the chain): headlines for every story in the feed + `NEWS_VOICE_FULL` (default 10) full read-outs a day per language; files in `MEDIA_DIR/news-voice`, served by `/api/news/voice/<id>-<lang>-<h|s>.mp3`. Nothing is rendered on tap. The long spoken bulletin is opt-in (`BULLETIN_AUDIO=1`). News is a bottom tab; You moved to the header avatar.
- **ElevenLabs brain** (`modules/elevenbrain.js`): a private text-only ElevenLabs agent used as the LLM when Gemini has no key, is out of credit (402 → skipped for an hour via `global._geminiDownUntil`) or fails — `_callGemini` falls back to it, so Bro chat, Explain, the coach and the news desk keep working on ElevenLabs credits. Bro chat no longer runs a second "verify" pass.
- **ElevenLabs budget** (modules/elevenvoice.js `RESERVE`): bulk (static recordings) may use the first 70% of the month, daily (news, first plays) stops at 15% left, live Bro uses the rest. Admin auto-record order: learn-audio → lang-audio → hindi-books.
