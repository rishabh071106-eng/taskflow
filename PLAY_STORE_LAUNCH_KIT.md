# Brodoit · Play Store Launch Kit

Last updated: May 10, 2026

Per the latest Play Console state, only two gates remain before
production: **12 active testers** and the **14-day continuous test**
window. Everything else (declarations, content rating, listing,
TWA assetlinks) is already done.

This kit is the operational playbook to clear those two gates.

---

## 1 · Pre-flight (5 min, do once)

Set three env vars on Railway → Service → Variables, then redeploy:

| Variable           | Value                                                 | Why                                              |
|--------------------|-------------------------------------------------------|--------------------------------------------------|
| `ADMIN_TOKEN`      | `_R6HkqWzgooYoSaLhL4hvUl1` (or generate a new one)    | Gates the admin dashboards                       |
| `ADMIN_EMAIL`      | the email you log in to Brodoit with                  | Lets you view dashboards while signed in         |
| `BETA_OPT_IN_URL`  | the Play Console opt-in URL for your closed test      | Auto-emailed to anyone who signs up via /beta    |

The `BETA_OPT_IN_URL` looks like `https://play.google.com/apps/internaltest/4972957219436856411` — copy it from Play Console → Closed testing → "How testers join your test".

Bookmark these three URLs:

```
https://brodoit.com/beta                                          ← share this
https://brodoit.com/admin/testers?token=_R6HkqWzgooYoSaLhL4hvUl1   ← activity
https://brodoit.com/admin/beta-signups?token=_R6HkqWzgooYoSaLhL4hvUl1  ← signup queue
```

The flow is now automated:
1. You share `brodoit.com/beta` (or `brodoit.com/beta?src=whatsapp` to track)
2. Friend enters their Play email → server emails them the install link
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
