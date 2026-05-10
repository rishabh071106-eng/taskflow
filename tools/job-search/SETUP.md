# Naukri assistant — setup & usage

## Install (one time, on your Mac)

```
cd tools/job-search
python3 -m venv .venv
source .venv/bin/activate
pip install playwright
python -m playwright install chromium
```

## Configure

Open `profile.json` and edit:

- `files.resume_pdf` — absolute path to the resume PDF you want uploaded.
  Recommended: the hybrid PDF this repo produces.
- `files.applications_csv` — where the tracker is appended.
- `files.playwright_user_data_dir` — browser profile dir; first run logs you
  in to Naukri, subsequent runs reuse the session (no password stored).
- `current.expected_ctc_lpa`, `notice_period_days`, etc. — make sure these
  match what you'd say verbally.
- `search_queries` — pick the role titles you want to scan.
- `filters.min_match_score` — default 75. Lower if you want to see borderline.

## First run (dry-run, score only)

```
source .venv/bin/activate
python3 naukri_assistant.py
```

This will:

1. Open a real Chromium window pointed at naukri.com.
2. Wait for you to log in *in the browser*. **Type your password yourself.**
3. After you press <Enter> in the terminal, run each search query, open
   each result, score the JD, and print to terminal.  Nothing is filled,
   nothing is submitted.

Use this to verify the SEL selectors at the top of `naukri_assistant.py`
still match Naukri's current DOM.  If `result_card` finds 0 entries, open
DevTools, find the right class on a job card, paste it into `SEL`.

## Live run

```
python3 naukri_assistant.py --apply
```

For every job that scores ≥ 75 and isn't excluded:

1. Script clicks the Apply button.
2. Script tries to fill notice period / current CTC / expected CTC etc on
   any visible chatbot-style screening fields.
3. Script prints `READY → click Submit yourself` and waits for you in the
   terminal.
4. **You** review the form in the browser, fix anything the script missed,
   and click Submit.
5. Press <Enter> in the terminal — logged as `applied`. Or type `skip` —
   logged as `skipped_by_user`.

Caps are enforced from the CSV: max 10 applies per day, max 2 per company
per week.  When either is hit the script exits.

## When selectors break

Naukri rolls out UI changes from time to time.  Two failure modes:

- **0 result cards found.** Open a search results page in Chrome, right
  click a job card → Inspect.  Find the outer `<article>` or `<div>` that
  wraps one card. Update `SEL["result_card"]` to that selector.

- **No Apply button found.** Open a job page → Inspect → find the
  Apply button.  Update `SEL["apply_button"]`.

Selectors live in one block at the top of `naukri_assistant.py`.  No
other code needs to change.

## What this script will NOT do

- It will not solve CAPTCHAs.  If one appears, you solve it in the browser.
- It will not spoof browser fingerprint or rotate proxies.  Default
  Chromium identity, your home IP.
- It will not click Submit.  Ever.
- It will not cover up the fact that the activity is automated — Naukri
  may still flag patterns even with the rate limits.  Use your judgement.

If you want zero account risk, stay with `score_jd.py` + `answers.md` and
do the apply clicks yourself — that flow is also ~60 seconds per job and
purely manual.
