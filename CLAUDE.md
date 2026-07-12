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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Push notifications |
| `WHATSAPP_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification (default: `brodoit_verify_2024`) |
| `WHATSAPP_NUMBER` | Business number with +country code |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth |

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

## Don't

- Don't add `require('twilio')` — removed, using native fetch to Graph API
- Don't commit `.env` — it's gitignored
- Don't use `git push --force` — Railway tracks main branch
- Don't assume HMR — server must restart for any change to take effect
