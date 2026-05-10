# Job-search toolkit

Three small files designed to compress per-application time from ~10 minutes
to ~60 seconds without violating any platform's Terms of Service.

```
score_jd.py        # paste a JD, get fit score + tailored pitch + bullets
answers.md         # copy-paste pack for screening Q&A
applications.csv   # tracker (date, company, role, score, status, notes)
```

## Recommended flow on Naukri (or LinkedIn / Instahyre / Cutshort)

1. **Browse normally** — keep your saved searches and email job alerts on
   Naukri.  Open job postings in tabs.
2. **Score the JD** — copy the JD body to clipboard, then in Terminal:
   ```
   pbpaste | python3 score_jd.py        # macOS
   xclip -o | python3 score_jd.py       # Linux
   python3 score_jd.py path/to/jd.txt   # or save to a file
   ```
   You get a 0–100 match score, a pillar breakdown
   (PM / Leadership / FinTech / Lending / Payments / AI / Platform / Data),
   any disqualifiers (JPM employer, relocation outside India, sub-Senior
   Manager), a tailored 150-word "why I'm a fit" pitch you can paste
   straight into Naukri's free-text box, and the 3 best resume bullets
   to highlight.
3. **Apply if score ≥ 75.**  Open `answers.md` in a tab, copy the
   relevant blocks into Naukri's screening questions.
4. **Log it** — append the printed CSV row to `applications.csv`. Open
   the CSV in Numbers/Excel/Google Sheets to see your week.

## Why no auto-apply bot

Naukri's ToS prohibits automated logins and bulk applications.  Bot
behaviour gets accounts flagged and CVs blacklisted — exactly the
opposite of what you want while you're still at JPM.  This toolkit
gives you the same speed (~10 quality apps in 10 minutes) without the
account risk and without spamming recruiters with templated content.

## Customising

- **Tune the scorer.**  Edit the `PILLARS` weights or `RESUME_BULLETS`
  list in `score_jd.py` to bias toward different types of role.
- **Tune the pitch.**  Edit `build_pitch()` to change the default 150-word
  text or add new conditional blocks.
- **Track more fields.**  The CSV header is just a suggestion — add columns
  for recruiter name, follow-up date, etc.

## Optional: Claude-powered scoring

The default scorer is keyword + weighted-pillar.  To upgrade, set
`ANTHROPIC_API_KEY` in your shell and replace `score_jd()`'s body with
a Claude API call that takes the JD + a JSON description of the profile
and returns the structured fields. Same interface; better fit detection
on rare phrasings.
