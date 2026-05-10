#!/usr/bin/env python3
"""score_jd.py — score a job description against Rishabh's profile.

Usage:
    python3 score_jd.py < jd.txt
    python3 score_jd.py path/to/jd.txt
    pbpaste | python3 score_jd.py        # macOS, paste from clipboard

Output: a fit score, why-it-fits pitch (paste into Naukri), top 3 resume
bullets, gaps, and a one-line tracker row you can append to applications.csv.

No external dependencies. Pure stdlib.
"""
from __future__ import annotations
import re
import sys
from collections import OrderedDict


# ---------- Profile pillars ----------
# Each pillar has a weight (importance) and a list of (regex, score) signals.
# Multiple matches in the same pillar saturate.
PILLARS = OrderedDict([
    ("Product Management", {
        "weight": 0.22,
        "signals": [
            r"\bproduct\s+management\b",
            r"\bproduct\s+manager\b",
            r"\bhead\s+of\s+product\b",
            r"\bdirector[\s,\-]+product\b",
            r"\bvp[\s,\-]+product\b",
            r"\bprincipal\s+product\b",
            r"\bgroup\s+product\s+manager\b",
            r"\bproduct\s+strategy\b",
            r"\bproduct\s+roadmap\b",
            r"\bproduct\s+lifecycle\b",
        ],
    }),
    ("Leadership / Seniority", {
        "weight": 0.16,
        "signals": [
            r"\bdirector\b", r"\bvp\b", r"\bvice\s+president\b",
            r"\bhead\s+of\b", r"\bavp\b",
            r"\bmanage[s]?\s+team", r"\bleading\s+a\s+team",
            r"\bp\s*&\s*l\b", r"\bstrategic\s+leadership\b",
            r"\bsenior\s+manager\b", r"\bcross[\s\-]functional\b",
        ],
    }),
    ("FinTech / Banking", {
        "weight": 0.16,
        "signals": [
            r"\bfintech\b", r"\bbanking\b", r"\bbank\b",
            r"\bfinancial\s+services\b", r"\bcommercial\s+bank",
            r"\bcorporate\s+bank", r"\binvestment\s+bank",
            r"\bcib\b", r"\bcb\b",
        ],
    }),
    ("Lending / Loans", {
        "weight": 0.12,
        "signals": [
            r"\blending\b", r"\bloan", r"\bsyndicat",
            r"\bcredit\b", r"\bunderwrit", r"\bloan\s+iq\b",
            r"\bacbs\b", r"\bbooking\s+platform\b",
        ],
    }),
    ("Payments", {
        "weight": 0.08,
        "signals": [
            r"\bpayments?\b", r"\bwallet", r"\bremittance",
            r"\breal[\s\-]time\s+payments?\b", r"\bcorridor",
            r"\btreasury\b", r"\bfx\b", r"\bliquidity\b",
            r"\bnpci\b", r"\bupi\b",
        ],
    }),
    ("AI / Agents", {
        "weight": 0.16,
        "signals": [
            r"\bai\b", r"\bartificial\s+intelligence\b",
            r"\bmachine\s+learning\b", r"\bml\b",
            r"\bllm\b", r"\bgen\s*ai\b", r"\bgenerative\b",
            r"\bagent(ic)?\b", r"\bcopilot\b",
            r"\bautomation\b", r"\bdocument\s+extraction\b",
        ],
    }),
    ("Platform / APIs / Cloud", {
        "weight": 0.06,
        "signals": [
            r"\bapis?\b", r"\bkafka\b", r"\baws\b", r"\bcloud\b",
            r"\bplatform\b", r"\bintegrations?\b",
            r"\bmicroservices?\b",
        ],
    }),
    ("Data / Analytics", {
        "weight": 0.04,
        "signals": [
            r"\btableau\b", r"\bsql\b", r"\bdata\s+strategy\b",
            r"\bdata\s+analytics\b", r"\bdashboards?\b",
            r"\bin[\s\-]app\s+analytics\b",
        ],
    }),
])

# ---------- Negative signals (penalties) ----------
PENALTIES = [
    (r"\bjp\s*morgan\b|\bjpmc\b|\bj\.?p\.?\s*morgan\b", -100,
     "Excluded employer (JP Morgan)"),
    (r"\brelocat(e|ion)\s+to\s+(us|usa|united\s+states|uk|europe|singapore|dubai|uae)",
     -25, "Requires relocation outside India"),
    (r"\b(0|1|2|3|4|5)[\s\-]+(\d+\s+)?years?\s+(of\s+)?experience\b",
     -15, "Asks for too-junior experience range"),
    (r"\bjunior\s+product\s+manager\b|\bassociate\s+product\s+manager\b",
     -25, "Sub-Senior Manager seniority"),
    (r"\bcustomer\s+support\b|\bsales\s+executive\b|\boperations?\s+associate\b",
     -25, "Not a Product Management role"),
]

# ---------- Curated resume bullets ----------
# (bullet_text, list of pillar names this bullet best evidences)
RESUME_BULLETS = [
    ("Spearheading the strategic vision and roadmap for a global digital "
     "loan booking platform, driving the shift from legacy processes to an "
     "AI-enabled, agentic ecosystem serving CIB and CB clients worldwide.",
     ["Product Management", "Lending / Loans", "FinTech / Banking",
      "AI / Agents", "Leadership / Seniority"]),

    ("Defined a multi-agent architecture for loan booking — extraction, "
     "validation, regulatory checks and downstream synchronisation agents — "
     "integrated with Loan IQ, ACBS and upstream systems via APIs and "
     "Kafka on AWS.",
     ["AI / Agents", "Lending / Loans", "Platform / APIs / Cloud"]),

    ("Delivered measurable FTE optimisation and accelerated time-to-market "
     "by applying AI/ML-based document extraction and automation, "
     "establishing the platform as a strategic differentiator in the "
     "bank's global lending transformation.",
     ["AI / Agents", "Lending / Loans", "Product Management"]),

    ("Lead a cross-functional global workforce of 25+ engineers, product "
     "owners and data experts, ensuring agile execution, sprint delivery "
     "and dependency resolution across diverse business lines and geographies.",
     ["Leadership / Seniority", "Product Management"]),

    ("Loan Booking Platform adoption: 40% → 85% in 12 months via React UI, "
     "Tableau dashboards, in-app analytics and structured change management.",
     ["Product Management", "Data / Analytics"]),

    ("Led Agile transformation at Standard Bank (2016) — driving migration "
     "from Waterfall to Agile by establishing sprints, ceremonies and "
     "cross-functional global delivery practices across 14 markets.",
     ["Leadership / Seniority", "FinTech / Banking"]),

    ("Spearheaded core banking modernisation, migrating 26 partner platforms "
     "into a unified ecosystem; designed SAP target architecture and "
     "transitioned from legacy COBOL systems.",
     ["FinTech / Banking", "Platform / APIs / Cloud", "Payments"]),

    ("Directed a high-impact AML compliance initiative, fortifying the "
     "bank's risk management framework and regulatory alignment.",
     ["FinTech / Banking", "Lending / Loans"]),

    ("15+ years across fintech and enterprise — 6 years international "
     "(Johannesburg) + 8 years India — with strong cross-functional "
     "leadership across geographies and onshore-offshore models.",
     ["Leadership / Seniority", "FinTech / Banking"]),

    ("M.Tech in Artificial Intelligence (IIT Bhilai, ongoing); Executive "
     "MBA (IIM Kozhikode); CSPO, CSM, AWS Cloud Practitioner, SAFe.",
     ["AI / Agents", "Product Management"]),
]


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def score_pillar(text: str, signals: list[str]) -> tuple[float, list[str]]:
    """Return (0..1 saturation score, list of matched signal patterns)."""
    matched = []
    for pat in signals:
        if re.search(pat, text, flags=re.IGNORECASE):
            matched.append(pat)
    if not matched:
        return 0.0, []
    # Saturation: 1 hit = 0.55, 2 hits = 0.78, 3+ = 1.0
    n = len(matched)
    sat = min(1.0, 0.55 + 0.23 * (n - 1))
    return sat, matched


def score_jd(jd_raw: str) -> dict:
    text = normalise(jd_raw)
    pillar_scores = OrderedDict()
    matches = OrderedDict()
    weighted = 0.0
    for name, info in PILLARS.items():
        sat, hits = score_pillar(text, info["signals"])
        pillar_scores[name] = sat
        matches[name] = hits
        weighted += sat * info["weight"]

    raw_score = weighted * 100  # 0..100 baseline (sum of weights = 1.0)

    penalty_total = 0
    triggered_penalties = []
    for pat, delta, label in PENALTIES:
        if re.search(pat, text, flags=re.IGNORECASE):
            penalty_total += delta
            triggered_penalties.append(label)

    final_score = max(0, min(100, round(raw_score + penalty_total)))

    return {
        "score": final_score,
        "raw_score": round(raw_score, 1),
        "pillars": pillar_scores,
        "matches": matches,
        "penalties": triggered_penalties,
    }


def top_bullets(pillar_scores: dict, k: int = 3) -> list[str]:
    """Pick k resume bullets that best evidence the strongest pillars."""
    ranked = []
    for bullet, evidences in RESUME_BULLETS:
        # Bullet score = sum of pillar saturation for evidenced pillars.
        b = sum(pillar_scores.get(p, 0) for p in evidences)
        ranked.append((b, bullet))
    ranked.sort(key=lambda x: x[0], reverse=True)
    return [b for s, b in ranked[:k] if s > 0]


def build_pitch(score: int, pillars: dict, jd_raw: str) -> str:
    """Generate a ~150-word 'why I'm a fit' pitch ranked by pillar strength."""
    strong = [p for p, s in pillars.items() if s >= 0.7]

    # Seed phrases keyed by pillar — composed into a coherent paragraph.
    parts = []
    parts.append(
        "I'm Rishabh Sharma, Vice President — Product Management at "
        "J.P. Morgan, with 15+ years across fintech and enterprise "
        "domains and 6 years of international experience in Johannesburg.")

    if "Lending / Loans" in strong or "FinTech / Banking" in strong:
        parts.append(
            "I currently spearhead the strategic vision and roadmap for a "
            "global digital loan booking platform, driving the shift from "
            "legacy processes to an AI-enabled, agentic ecosystem serving "
            "CIB and CB clients worldwide.")
    elif "Product Management" in strong:
        parts.append(
            "I currently spearhead the strategic vision and roadmap for a "
            "global digital banking platform, taking it from strategy to "
            "scaled adoption across multiple business lines and geographies.")

    if "AI / Agents" in strong:
        parts.append(
            "On the AI side I've defined a multi-agent architecture for "
            "loan booking — specialist extraction, validation, regulatory "
            "and downstream-sync agents — and applied AI/ML document "
            "extraction to deliver measurable FTE optimisation.")

    if "Platform / APIs / Cloud" in strong:
        parts.append(
            "Architected enterprise-scale integrations on AWS with Loan IQ, "
            "ACBS and upstream underwriting systems via APIs and Kafka.")

    parts.append(
        "I lead a cross-functional global team of 25+ across India, US "
        "and EMEA, scaled platform adoption from 40% to 85% in 12 months, "
        "and hold an Executive MBA from IIM Kozhikode and an ongoing "
        "M.Tech in AI from IIT Bhilai.")

    parts.append(
        "Would love to discuss how this maps to the role — happy to share "
        "specifics on metrics, architecture and team scope.")

    pitch = " ".join(parts)
    # Trim to roughly 150 words while keeping last sentence intact.
    words = pitch.split()
    if len(words) > 170:
        pitch = " ".join(words[:160]) + "…"
    return pitch


def render(result: dict, jd_raw: str) -> str:
    s = result["score"]
    out = []
    out.append("=" * 60)
    out.append(f"  MATCH SCORE: {s} / 100")
    if s >= 75:
        out.append(f"  → APPLY (score ≥ 75 threshold)")
    else:
        out.append(f"  → SKIP or tailor heavily (below 75 threshold)")
    out.append("=" * 60)

    out.append("\nPillar breakdown:")
    for name, sat in result["pillars"].items():
        bar = "█" * int(round(sat * 12)) + "·" * (12 - int(round(sat * 12)))
        out.append(f"  {name:<26} [{bar}]  {sat:.2f}")

    if result["penalties"]:
        out.append("\nPenalties applied:")
        for p in result["penalties"]:
            out.append(f"  ⚠  {p}")

    out.append("\n" + "-" * 60)
    out.append("WHY I'M A FIT  (paste into Naukri's free-text box)")
    out.append("-" * 60)
    out.append(build_pitch(s, result["pillars"], jd_raw))

    out.append("\n" + "-" * 60)
    out.append("TOP RESUME BULLETS TO HIGHLIGHT")
    out.append("-" * 60)
    for i, b in enumerate(top_bullets(result["pillars"]), 1):
        out.append(f"{i}. {b}")

    if s < 75:
        out.append("\n" + "-" * 60)
        out.append("GAPS TO ADDRESS BEFORE APPLYING")
        out.append("-" * 60)
        weak = [name for name, sat in result["pillars"].items() if sat < 0.4]
        for w in weak[:5]:
            out.append(f"  •  {w} — JD signals weak; consider stretching with "
                       "an adjacent example from your work.")

    out.append("\n" + "-" * 60)
    out.append("TRACKER ROW (append to applications.csv)")
    out.append("-" * 60)
    out.append("date,company,role,location,salary,match_score,url,status,notes")
    out.append(f"<DATE>,<COMPANY>,<ROLE>,<LOCATION>,<SALARY>,{s},<URL>,"
               f"{'applied' if s >= 75 else 'skipped'},")
    out.append("")
    return "\n".join(out)


def main():
    if len(sys.argv) > 1 and sys.argv[1] not in ("-", "--"):
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            jd = f.read()
    else:
        jd = sys.stdin.read()
    if not jd.strip():
        print("ERROR: no JD provided. Pipe one in or pass a file path.",
              file=sys.stderr)
        sys.exit(1)
    result = score_jd(jd)
    print(render(result, jd))


if __name__ == "__main__":
    main()
