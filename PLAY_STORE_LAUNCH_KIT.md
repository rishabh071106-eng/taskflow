# Brodoit · Play Store Launch Kit

Last updated: October 20, 2026 (v19). The May 10 playbook follows below.

## v19: the new app on the existing Play listing

The app in this repo (TWA + background steps) now builds as **`com.brodoit.android`** for Google Play (v40, November
2026: a fresh listing; the first one, `com.brodoit.twa`, kept a package name Play never lets change and tester
communities refuse on sight, so it stays empty). The same build is also **`com.brodoit.app`**
at **https://brodoit.com/android**, a one-tap install for testers that needs no Play account.

**The server does the rest:**
- Every build is signed by the server's upload key.
- With a service account, each build goes to Play's **internal** and **closed (alpha)** tracks by itself.
- Status: `https://brodoit.com/api/android/status` → `play.state`.

### One time, in Play Console (about 15 minutes)

1. **Upload key reset.**
   - Download https://brodoit.com/download/upload_certificate.pem.
   - In Play Console, go to Brodoit → Test and release → App integrity → App signing → "Request upload key reset".
   - Reason: "I lost my upload key". Upload that .pem file. Google replies within about 2 days.
   - After the reset, `play.state` stops saying `waiting-key-reset` and the build uploads by itself.
2. **Service account** (the uploader). The Google Cloud side is set up (28 Oct 2026):
   - **Project:** `brodoit-play-261028`, with the Google Play Android Developer API turned on.
   - **Service account:** `play-uploader@brodoit-play-261028.iam.gserviceaccount.com`. Its key was made by the **Brodoit server itself**.
   - Google holds only the public certificate (https://brodoit.com/download/play-api-cert.pem, SHA-256 `35:F3:03:73…`). The private key never leaves the server.
   - The email is in `config/play.json`.

   In Play Console → Users and permissions → Invite new users, paste that email and add the app Brodoit with
   **Release apps to testing tracks** and **Manage testing tracks**, then send the invite.
   (Or make your own service account key and choose its .json file in You → Admin → Google Play; a pasted key wins.)
3. **App content.** In Policy → App content, update these two forms for step counting:
   - **Data safety:** "Fitness info" (step counts) is collected, linked to the account, used for app functionality, not shared, encrypted in transit, and deletable on request. The device ID is "Device or other IDs" (app functionality).
   - **Health apps:** fitness / activity tracking.
4. **Production.** After 12 testers have been opted in for 14 days on the closed track, use Publishing overview → "Apply for production". Then promote the newest closed-test release.

Per the latest Play Console state, only two gates remain before
production: **12 active testers** and the **14-day continuous test**
window. Everything else (declarations, content rating, listing,
TWA assetlinks) is already done.

This kit is the operational playbook to clear those two gates.

---

## 1 · Pre-flight — ZERO config needed

The system now bootstraps automatically. **You don't need to set any
Railway env vars.** As long as you're signed in to brodoit.com with
the email of the *first account ever created* on the database, the
admin dashboards will recognize you and let you in.

The Play Console opt-in URL is hardcoded as fallback (using your app
ID `4972957219436856411`), so the email auto-send to new signups
already works.

Bookmark these three URLs:

```
https://brodoit.com/beta                  ← share this
https://brodoit.com/admin/beta-signups    ← signup queue
https://brodoit.com/admin/testers         ← activity tracker
```

If you visit either admin URL while signed in to brodoit.com (same
browser), the page injects your login token automatically and shows
the dashboard. If you're not signed in, you'll get a "Sign in first"
card with a button to brodoit.com.

### Optional: stricter auth via env vars

If you want shareable admin URLs (or want to deploy a fresh DB later),
set on Railway → Service → Variables:

```
ADMIN_TOKEN = <a long random value only you know (never commit it)>
```

Then access via `https://brodoit.com/admin/testers?token=<your ADMIN_TOKEN>`.

### The flow is fully automated:

1. You share `brodoit.com/beta` (or `brodoit.com/beta?src=whatsapp` to track channel)
2. Friend enters their Play email → server emails them the install link instantly
3. Their email shows up in `/admin/beta-signups`
4. You paste it into Play Console → Closed testing → Testers
5. After 14 days of activity, `/admin/testers` shows them as eligible

---

## 2 · Tester recruitment

### Target list (paste into a Google Sheet, NOT this file)

Aim for **25 names**. You only need 12 to opt-in but half won't follow
through. Priority:

1. Family members on Android (highest follow-through)
2. 5–10 close friends on Android
3. Coworkers / classmates on Android
4. LinkedIn / X DMs (broader, lower conversion)
5. Reddit r/androidapps if still short

### Sheet columns

```
Name | Play email | Sent invite | Joined | Day-1 install | Day-14 cleared | Notes
```

### Invite messages (copy/paste)

#### WhatsApp / iMessage — short, casual

> Hey — I built a productivity app called Brodoit and need 12
> friends testing it for 2 weeks before Google lets me launch.
> Takes 30 seconds.
>
> Tap → brodoit.com/beta?src=whatsapp
>
> Drop your Play Store email there, install the app on Android,
> done. Means a lot 🙏

#### Email — formal

> Subject: 30 seconds — help me ship Brodoit to Play Store
>
> Hi {name},
>
> I'm shipping a productivity app called Brodoit (tasks, audiobooks,
> guided affirmations, mind-gym games). Google requires 12 testers
> using it for 14 days before they'll let me promote it to public
> release.
>
> Could you join the closed test? Two things from you:
>
> 1. Reply with the email you use on Google Play
> 2. Once I add you, I'll send the install link — just open it on
>    Android and install. Use the app whenever you'd normally check
>    tasks.
>
> That's the entire ask. 14 days, then I can launch.
>
> Thanks,
> Rishabh

#### LinkedIn / X DM — one-liner

> Quick favor — shipping a productivity app to Play Store, stuck on
> Google's 12-tester requirement. If you're on Android, take 30 sec:
> brodoit.com/beta?src=linkedin — drop your Play email, you'll get
> the install link. 14-day test, then it goes public. Thanks!

---

## 3 · Add testers in Play Console

1. Play Console → Brodoit → **Testing → Closed testing → "alpha"** track
2. Click **Testers** tab
3. Click **Create email list** if you haven't already
4. Paste tester emails (one per line)
5. Save
6. Copy the **opt-in URL** (Tab labeled "How testers join your test")
7. Send it back to each tester

Tester instructions to paste with the link:

> Tap this on your Android phone:
> {opt-in-URL}
>
> Tap "Become a tester" → "Download it on Google Play" → install.
> That's it.

---

## 4 · 14-day timeline

| Day  | What happens                                          | What you do                                         |
|------|-------------------------------------------------------|-----------------------------------------------------|
| 0    | Send 25 invites                                       | Set up sheet + dashboard                            |
| 1–3  | Replies trickle in                                    | Add Play emails to console, send opt-in URL         |
| 4    | Most testers should be installed                      | Check `/admin/testers` — should see ≥10 signups     |
| 5    | First nudge                                           | "Just confirming the app is still installed"        |
| 9    | Mid-test nudge                                        | Same wording, different angle                       |
| 13   | Pre-eligibility check                                 | Confirm 12+ users show "✅ 14-day" on dashboard     |
| 14   | Eligible for production                               | Submit production release in Play Console          |
| 15–22| Google review                                         | Usually 2–3 days, can be up to 7                    |

---

## 5 · Nudge messages (copy/paste)

### Day 5

> Just checking — Brodoit still installed on your phone? Google's
> 14-day count tracks daily app presence so I want to make sure
> you're still in. No pressure, just a heads-up.

### Day 9

> Halfway through the 14-day test! Anything on Brodoit you'd want
> changed? Now's the time — I can ship updates to testers in hours.

### Day 13

> One day left on the closed-test count. If Brodoit is still on your
> phone we're good. Will share the public link when it's live —
> appreciate the help getting here.

---

## 6 · Listing copy (already on Play Store, kept here for reference)

### Short description (80 chars max)

> Tasks, audiobooks & daily wisdom — calm productivity in one app.

### Full description

> **Brodoit** is the calm-productivity app for people who want to
> get things done without the dopamine treadmill of every other
> task tool.
>
> ✓ **Tasks** with priority, due dates, voice notes, smart reminders.
> ✓ **Listen** to free public-domain audiobooks (LibriVox library)
>   and 15-minute book briefs while you walk, drive, or wash dishes.
> ✓ **Wisdom** — guided affirmations and short meditations narrated
>   by professional voices. 5, 10, or 15 minutes. No subscription,
>   no upsell.
> ✓ **Train** — six micro-games for focus, memory, and mental math.
>   Each round is sub-90 seconds. Beat your best.
> ✓ **Calendar** — Google Calendar sync, drag-drop events, day view.
>
> Email-only login. No ads. No tracking. Your data stays on the
> server you signed in to.

### Keywords (informally — Play Store doesn't have a keywords field)

> productivity tasks reminders audiobooks meditation affirmations
> mindfulness brain games focus habit tracker

---

## 7 · What CAN block production (besides the 14-day clock)

If review comes back negative, the most common reasons:

1. **Privacy policy URL doesn't load** — verify https://brodoit.com/privacy
   returns 200. ✅ Already checked.
2. **Data safety mismatch** — what the app actually sends ≠ what was
   declared. Quick audit: app sends email, name, phone (optional),
   tasks, voice notes. All declared. ✅
3. **TWA assetlinks.json missing** — verify https://brodoit.com/.well-known/assetlinks.json
   returns the package fingerprint. ✅
4. **Crash on first launch** — uncommon on TWA. If it happens, check
   Railway logs.

---

## 8 · After production goes live

1. Send the public Play Store link to everyone who tested
2. Move the closed test track to "Open testing" (no email allowlist)
   so anyone can install future betas before promotion
3. Set up Play Console → User feedback → Reviews so you see ratings
4. Add a "Rate us on Play Store" prompt in the app after week 2
   of usage (don't nag earlier)

---

## 9 · Emergency: rejected by Google

If review fails:

1. Read the rejection reason carefully — they're specific
2. Fix the issue
3. Submit a new release (not a re-review of the same build)
4. Most rejections are resolved in 24h

Don't appeal unless you're certain the rejection is wrong — appeals
can take 2 weeks and reset goodwill.

---

## What's already shipped in code (this commit)

- `last_seen` column on users table, updated on every authenticated
  request (throttled to once per 60s per user)
- `GET /admin/testers` HTML dashboard, gated by `ADMIN_TOKEN` env var
  or `ADMIN_EMAIL` (logged-in admin can view)
- Beta-tester acknowledgment pill shown to every signed-in user once
  (dismissable, remembered in localStorage)

That's everything operational. The remaining work is people-work,
not code-work.

## v40 · Store listing assets (November 2026, the fresh `com.brodoit.android` listing)

In `store/play/`, made from the running app (signed in as the review account) and the v39 icon:

| File | Use in Play Console |
|---|---|
| `Brodoit-icon-512.png` | App icon, 512×512, square corners, no transparency |
| `Brodoit-feature-graphic-1024x500.png` | Feature graphic |
| `Brodoit-screenshot-1-lessons-1080x1920.png` … `4-learn` | Phone screenshots (Lessons, Bro, Steps, Learn), 9:16 |

Short description: *8-minute story lessons from great books, in English and Hindi. News in photos, streak, tasks, steps.*
Category Education · contact hello@brodoit.com · privacy https://brodoit.com/privacy · deletion https://brodoit.com/delete-account.
