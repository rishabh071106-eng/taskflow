#!/usr/bin/env python3
"""naukri_assistant.py — Playwright-driven application *helper* for Naukri.

DESIGN
------
* Visible Chromium window with a persistent profile dir.  You log into
  Naukri yourself the first time; the session is reused on subsequent runs.
* For each search query in profile.json, the script lists results, opens
  each posting, extracts the JD, and runs it through score_jd.score_jd().
* If the score >= profile.filters.min_match_score and the job passes the
  exclusion filters and the daily / per-company caps, the script:
    1. Clicks the Apply button.
    2. Tries to fill any obvious form fields (notice period, expected
       CTC, current CTC, location, total experience).
    3. Pauses and prints "READY → click Submit yourself" to the terminal.
    4. Waits for you to either press <Enter> in the terminal (logged as
       applied) or type "skip" + <Enter> (logged as skipped).
* Everything is appended to applications.csv.

WHAT THIS SCRIPT DOES NOT DO
----------------------------
* No CAPTCHA bypass.  If Naukri shows one, solve it in the browser.
* No fingerprint or user-agent spoofing.  Default Chromium fingerprint.
* No proxy rotation.  Your normal IP.
* No auto-submit.  You always click Submit yourself.

These limits are deliberate.  They are also the reason you can run this
without burning your Naukri account.

REQUIREMENTS
------------
    pip install playwright
    python -m playwright install chromium

USAGE
-----
    python3 naukri_assistant.py                   # dry-run (score only, no fill)
    python3 naukri_assistant.py --apply           # fill forms; you Submit
    python3 naukri_assistant.py --profile p.json  # custom profile path

SELECTORS
---------
Naukri's DOM changes.  When the script stops finding things, open the
browser DevTools, inspect the elements you care about, and update the
SEL constants block below.  Nothing else needs to change.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Optional

# Local import: scorer ships in the same folder.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from score_jd import score_jd  # noqa: E402

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print("ERROR: playwright is not installed.\n"
          "  pip install playwright\n"
          "  python -m playwright install chromium", file=sys.stderr)
    sys.exit(1)


# ---------- Selectors block (UPDATE WHEN NAUKRI DOM CHANGES) -----------
SEL = {
    # Search results page — one card per posting.
    "result_card": "article.jobTuple, div.srp-jobtuple-wrapper, "
                    "div[class*='jobTuple']",
    "result_title_link": "a.title, a.jobTitle, a[class*='jobTitleLink']",
    "result_company": "a.subTitle, a.companyName, span[class*='company']",
    "result_location": "li.location, span[class*='location']",
    "result_salary": "li.salary, span[class*='salary']",

    # Job detail page.
    "jd_body": "section.styles_job-desc-container__txpYf, "
               "div.dang-inner-html, div[class*='job-desc']",
    "jd_title": "h1, h2.styles_jd-header-title__rZwM1",
    "jd_company": "div[class*='comp-info'] a, a[class*='companyName']",

    # Apply controls.
    "apply_button": "button#apply-button, button:has-text('Apply'), "
                    "a:has-text('Easy Apply')",
    "already_applied_marker": "text=/applied/i",

    # Common chatbot / screening prompt fields (Naukri uses a chat-like UI).
    "screening_input": "input[type='text']:visible, "
                        "textarea:visible",
    "screening_send": "button:has-text('Send'), button[type='submit']",
}
# -----------------------------------------------------------------------


def load_profile(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def naukri_search_url(query: str, location: str = "") -> str:
    q = re.sub(r"\s+", "-", query.strip().lower())
    base = f"https://www.naukri.com/{q}-jobs"
    if location:
        loc = re.sub(r"\s+", "-", location.strip().lower())
        base += f"-in-{loc}"
    return base


def daily_count(csv_path: Path) -> int:
    if not csv_path.exists():
        return 0
    today = dt.date.today().isoformat()
    n = 0
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("status") == "applied" and row.get("date", "").startswith(today):
                n += 1
    return n


def company_count_this_week(csv_path: Path, company: str) -> int:
    if not csv_path.exists():
        return 0
    company_lc = company.strip().lower()
    cutoff = dt.date.today() - dt.timedelta(days=7)
    n = 0
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("company", "").strip().lower() != company_lc:
                continue
            if row.get("status") != "applied":
                continue
            try:
                d = dt.date.fromisoformat(row["date"][:10])
            except Exception:
                continue
            if d >= cutoff:
                n += 1
    return n


def append_row(csv_path: Path, row: dict) -> None:
    new_file = not csv_path.exists()
    fields = ["date", "company", "role", "location", "salary_lpa",
              "match_score", "source", "url", "status", "notes"]
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if new_file:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in fields})


def is_excluded(company: str, title: str, profile: dict) -> Optional[str]:
    excl = profile.get("exclusions", {})
    company_lc = company.lower()
    for emp in excl.get("employers", []):
        if emp.lower() in company_lc:
            return f"Excluded employer: {emp}"
    title_lc = title.lower()
    for kw in excl.get("title_keywords_to_skip", []):
        if kw.lower() in title_lc:
            return f"Excluded title keyword: {kw}"
    return None


def random_delay(profile: dict) -> None:
    rl = profile.get("rate_limits", {})
    lo = rl.get("delay_between_jobs_seconds_min", 6)
    hi = rl.get("delay_between_jobs_seconds_max", 14)
    time.sleep(random.uniform(lo, hi))


def fill_screening(page, profile: dict) -> None:
    """Best-effort fill on common screening prompts.

    Prints what it tries and leaves anything it can't handle for the human.
    """
    cur = profile["current"]
    answers_priority = [
        # (regex match against the prompt text, answer)
        (r"notice\s*period", str(cur["notice_period_days"]) + " days"),
        (r"current\s*(ctc|salary|compensation)",
         f"{cur['current_ctc_lpa']} LPA"),
        (r"expected\s*(ctc|salary|compensation)",
         f"{cur['expected_ctc_lpa']} LPA"),
        (r"total\s*(years\s*of\s*)?experience",
         str(cur["total_experience_years"])),
        (r"current\s*location|where\s*are\s*you\s*based", cur["city"]),
        (r"willing\s*to\s*relocate", "Yes, within India"),
        (r"current\s*company|present\s*employer", cur["company"]),
        (r"current\s*designation|current\s*role", cur["designation"]),
    ]
    # Scan the page text for prompt-like blocks; if any match a known
    # question, fill the visible input + send button.
    page_text = page.content().lower()
    for pat, ans in answers_priority:
        if re.search(pat, page_text):
            try:
                inp = page.locator(SEL["screening_input"]).first
                if inp.is_visible(timeout=1500):
                    inp.fill(ans)
                    page.locator(SEL["screening_send"]).first.click(
                        timeout=2000)
                    print(f"   filled: {pat} → {ans}")
                    page.wait_for_timeout(1500)
            except Exception:
                pass


def process_job(page, url: str, profile: dict, do_apply: bool,
                csv_path: Path) -> dict:
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    title = (page.locator(SEL["jd_title"]).first.text_content() or "").strip()
    company = ""
    try:
        company = (page.locator(SEL["jd_company"]).first
                       .text_content() or "").strip()
    except Exception:
        pass
    location = ""
    salary = ""
    jd_body = ""
    try:
        jd_body = (page.locator(SEL["jd_body"]).first
                       .text_content() or "").strip()
    except Exception:
        pass

    excl = is_excluded(company, title, profile)
    if excl:
        return {"action": "skipped", "reason": excl, "title": title,
                "company": company, "score": 0}

    if not jd_body:
        return {"action": "skipped", "reason": "Empty JD body",
                "title": title, "company": company, "score": 0}

    result = score_jd(jd_body)
    score = result["score"]
    threshold = profile["filters"].get("min_match_score", 75)

    print(f"\n  [{score}/100] {company} — {title}")
    if score < threshold:
        return {"action": "skipped", "reason": f"Score {score} < {threshold}",
                "title": title, "company": company, "score": score}

    # Caps.
    if daily_count(csv_path) >= profile["rate_limits"][
            "max_applications_per_day"]:
        return {"action": "stopped", "reason": "Daily cap reached",
                "title": title, "company": company, "score": score}
    if company_count_this_week(csv_path, company) >= profile["rate_limits"][
            "max_applications_per_company_per_week"]:
        return {"action": "skipped", "reason": "Company cap reached this week",
                "title": title, "company": company, "score": score}

    if not do_apply:
        return {"action": "scored_only", "reason": "Dry-run",
                "title": title, "company": company, "score": score}

    # Click Apply.
    try:
        page.locator(SEL["apply_button"]).first.click(timeout=4000)
        page.wait_for_timeout(2500)
    except Exception as e:
        return {"action": "skipped", "reason": f"No Apply button: {e}",
                "title": title, "company": company, "score": score}

    # Best-effort fill on screening fields.
    fill_screening(page, profile)

    # HUMAN-IN-THE-LOOP: stop here, let the user verify and click Submit.
    print("   ► READY. Verify form fields, attach resume if not pre-attached,")
    print("     then CLICK SUBMIT YOURSELF in the browser.")
    answer = input("     Press <Enter> after submitting (or type 'skip'): "
                   ).strip().lower()
    status = "applied" if answer != "skip" else "skipped_by_user"

    return {"action": status, "reason": "User-confirmed",
            "title": title, "company": company, "score": score,
            "url": url, "location": location, "salary": salary}


def list_search_results(page, profile: dict, query: str) -> list[str]:
    pref_locs = profile.get("preferences", {}).get("preferred_locations", [])
    location = pref_locs[0] if pref_locs else ""
    url = naukri_search_url(query, location)
    print(f"\n→ search: {url}")
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    cards = page.locator(SEL["result_card"])
    count = cards.count()
    print(f"  found {count} result cards on first page")
    urls = []
    for i in range(count):
        try:
            href = cards.nth(i).locator(SEL["result_title_link"]).first \
                        .get_attribute("href")
            if href:
                if href.startswith("/"):
                    href = "https://www.naukri.com" + href
                urls.append(href)
        except Exception:
            continue
    return urls


def print_summary(scanned: list[dict], applied: list[dict],
                  shortlisted: list[dict], skipped: list[dict]) -> None:
    print("\n" + "=" * 60)
    print("  RUN SUMMARY")
    print("=" * 60)
    print(f"  Jobs scanned     : {len(scanned)}")
    print(f"  Jobs shortlisted : {len(shortlisted)}  (score >= threshold)")
    print(f"  Jobs applied     : {len(applied)}")
    if shortlisted:
        top = sorted(shortlisted, key=lambda x: x.get("score", 0),
                     reverse=True)[:5]
        print("\n  Top 5 strongest matches this run:")
        for i, j in enumerate(top, 1):
            print(f"    {i}. [{j.get('score', 0):>3}] "
                  f"{j.get('company', '?')} — {j.get('title', '?')}")
    if skipped:
        print("\n  Skip reasons:")
        reasons = {}
        for s in skipped:
            r = s.get("reason", "unspecified")
            reasons[r] = reasons.get(r, 0) + 1
        for reason, n in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"    {n:>3} × {reason}")
    print("=" * 60 + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=str(HERE / "profile.json"))
    ap.add_argument("--apply", action="store_true",
                    help="Actually click Apply and fill forms (you still "
                         "submit). Default is dry-run / score-only.")
    args = ap.parse_args()

    profile = load_profile(args.profile)
    csv_path = Path(profile["files"].get("applications_csv", "applications.csv"))
    if not csv_path.is_absolute():
        csv_path = HERE / csv_path
    user_dir = Path(profile["files"].get(
        "playwright_user_data_dir", "./.naukri-browser-profile"))
    if not user_dir.is_absolute():
        user_dir = HERE / user_dir
    user_dir.mkdir(parents=True, exist_ok=True)

    # Per-run aggregates for the end-of-run summary.
    scanned: list[dict] = []
    applied: list[dict] = []
    shortlisted: list[dict] = []
    skipped: list[dict] = []

    # Pre-flight cap check.
    if daily_count(csv_path) >= profile["rate_limits"][
            "max_applications_per_day"]:
        print(f"[{dt.datetime.now().isoformat(timespec='seconds')}] "
              "Daily cap already hit. Exiting.")
        return

    print(f"[{dt.datetime.now().isoformat(timespec='seconds')}] "
          f"Launching Chromium with persistent profile at: {user_dir}")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(user_dir),
            headless=False,
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.new_page()
        page.goto("https://www.naukri.com")
        print("\nLog in to Naukri in the browser window if you aren't already.")
        input("Press <Enter> here once your dashboard is visible: ")

        try:
            for query in profile["search_queries"]:
                urls = list_search_results(page, profile, query)
                for u in urls:
                    if daily_count(csv_path) >= profile["rate_limits"][
                            "max_applications_per_day"]:
                        print("Daily cap reached. Stopping.")
                        raise StopIteration
                    outcome = process_job(page, u, profile, args.apply,
                                          csv_path)
                    scanned.append(outcome)
                    if outcome["action"] == "applied":
                        applied.append(outcome)
                        shortlisted.append(outcome)
                    elif outcome["action"] in ("scored_only",):
                        shortlisted.append(outcome)
                    elif outcome["action"] == "stopped":
                        print("STOPPED:", outcome["reason"])
                        raise StopIteration
                    else:
                        skipped.append(outcome)

                    if outcome["action"] in ("applied", "skipped_by_user"):
                        append_row(csv_path, {
                            "date": dt.datetime.now().isoformat(
                                timespec="seconds"),
                            "company": outcome.get("company", ""),
                            "role": outcome.get("title", ""),
                            "location": outcome.get("location", ""),
                            "salary_lpa": outcome.get("salary", ""),
                            "match_score": outcome.get("score", 0),
                            "source": "naukri",
                            "url": outcome.get("url", u),
                            "status": outcome["action"],
                            "notes": outcome.get("reason", ""),
                        })
                    print(f"  → {outcome['action']}: {outcome['reason']}")
                    random_delay(profile)
        except StopIteration:
            pass

        print_summary(scanned, applied, shortlisted, skipped)
        # When run by launchd there is no human at the keyboard; do not
        # block on input(). Skip the prompt if not a TTY.
        if sys.stdin.isatty():
            input("Press <Enter> to close the browser: ")
        ctx.close()


if __name__ == "__main__":
    main()
