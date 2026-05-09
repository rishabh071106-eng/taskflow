"""Generate Rishabh Sharma's resume tailored for Thunes Head of Product - Core & Growth."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
)

OUTPUT = "/home/user/taskflow/resume/Rishabh_Sharma_Resume_2026_Thunes_HoP.pdf"

NAVY = HexColor("#0B2545")
ACCENT = HexColor("#13315C")
RULE = HexColor("#8DA9C4")
MUTED = HexColor("#3F4A5A")
LIGHT_BG = HexColor("#EEF4F7")

styles = {
    "name": ParagraphStyle(
        "name", fontName="Helvetica-Bold", fontSize=22, leading=26,
        textColor=NAVY, spaceAfter=2,
    ),
    "headline": ParagraphStyle(
        "headline", fontName="Helvetica", fontSize=11.5, leading=14,
        textColor=ACCENT, spaceAfter=4,
    ),
    "contact": ParagraphStyle(
        "contact", fontName="Helvetica", fontSize=9, leading=12,
        textColor=MUTED, spaceAfter=8,
    ),
    "section": ParagraphStyle(
        "section", fontName="Helvetica-Bold", fontSize=11, leading=14,
        textColor=NAVY, spaceBefore=8, spaceAfter=4,
    ),
    "role": ParagraphStyle(
        "role", fontName="Helvetica-Bold", fontSize=10.5, leading=13,
        textColor=NAVY, spaceAfter=1,
    ),
    "meta": ParagraphStyle(
        "meta", fontName="Helvetica-Oblique", fontSize=9, leading=12,
        textColor=MUTED, spaceAfter=3,
    ),
    "body": ParagraphStyle(
        "body", fontName="Helvetica", fontSize=9.5, leading=13,
        textColor=HexColor("#1A1A1A"), alignment=TA_JUSTIFY, spaceAfter=2,
    ),
    "bullet": ParagraphStyle(
        "bullet", fontName="Helvetica", fontSize=9.5, leading=13,
        textColor=HexColor("#1A1A1A"), leftIndent=12, bulletIndent=2,
        spaceAfter=2, alignment=TA_LEFT,
    ),
    "side_h": ParagraphStyle(
        "side_h", fontName="Helvetica-Bold", fontSize=10, leading=13,
        textColor=NAVY, spaceBefore=4, spaceAfter=3,
    ),
    "side_b": ParagraphStyle(
        "side_b", fontName="Helvetica", fontSize=9, leading=12,
        textColor=HexColor("#1A1A1A"), spaceAfter=2,
    ),
    "side_chip": ParagraphStyle(
        "side_chip", fontName="Helvetica", fontSize=8.6, leading=11,
        textColor=ACCENT, spaceAfter=1,
    ),
}


def hr():
    t = Table([[""]], colWidths=[170 * mm], rowHeights=[0.6])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.7, RULE)]))
    return t


def section(title):
    return [Paragraph(title.upper(), styles["section"]), hr(), Spacer(1, 3)]


def bullet(text):
    return Paragraph(f"• {text}", styles["bullet"])


def header():
    name = Paragraph("RISHABH SHARMA", styles["name"])
    headline = Paragraph(
        "Vice President — Product Management  ·  Fintech Platforms · AI Agents · Payments",
        styles["headline"],
    )
    contact = Paragraph(
        "Bengaluru, India  ·  +91 70877 50777  ·  rishabh071106@gmail.com  ·  "
        '<link href="https://www.linkedin.com/in/rishabh-sharmaiimk/">linkedin.com/in/rishabh-sharmaiimk</link>'
        "  ·  Open to Singapore relocation",
        styles["contact"],
    )
    return [name, headline, contact, hr(), Spacer(1, 6)]


def profile():
    text = (
        "Product leader with <b>15+ years</b> across global fintech, payments and banking platforms, "
        "of which <b>8+ years</b> are in product management and <b>5+ years</b> leading high-performing, "
        "geographically distributed product squads. Currently <b>Vice President — Product Management at "
        "J.P. Morgan</b>, owning the global digital lending platform across CIB and CB clients. "
        "Hands-on operator with deep experience in <b>real-time payment rails, treasury, liquidity &amp; FX, "
        "platform APIs, partner onboarding and ICP-led use-case enablement</b>, and an active builder of "
        "<b>agentic AI workflows</b> — from production loan-booking copilots to side-project agent stacks "
        "orchestrating LLMs, tool-use, and voice models. Known for translating ambiguous market signals into "
        "scalable roadmaps, partnering closely with engineering, compliance and GTM, and delivering measurable "
        "P&amp;L impact in matrixed, multi-region environments."
    )
    return [Paragraph(text, styles["body"]), Spacer(1, 4)]


def experience():
    items = []
    items += section("Professional Experience")

    # JPM
    items.append(Paragraph("Vice President — Product Management", styles["role"]))
    items.append(Paragraph("J.P. Morgan Chase &amp; Co.  ·  Bengaluru, India  ·  Jun 2020 – Present", styles["meta"]))
    for b in [
        "Own the <b>global product strategy and roadmap</b> for the digital loan booking &amp; servicing platform "
        "serving Commercial &amp; Investment Banking clients across <b>30+ countries</b>; defined the target-state "
        "architecture and led the shift from legacy COBOL/manual workflows to an <b>AI-native, agentic ecosystem</b>.",
        "Lead a cross-functional squad of <b>25+ engineers, product owners and data specialists</b> across India, "
        "US and EMEA in an onshore–offshore model; coach 4 product managers, run quarterly OKRs, sprint reviews and "
        "stakeholder steering committees.",
        "Architected <b>API and Kafka-based integrations</b> with Loan IQ, ACBS and 12+ upstream underwriting "
        "and pre-booking systems on AWS — the platform pattern is directly analogous to <b>Pay CORE platform &amp; "
        "API orchestration</b> across counterparties.",
        "Partnered with <b>Treasury, Liquidity and Risk</b> teams to model collateral, exposure and FX hedging "
        "flows; delivered controls that improved limit utilisation accuracy and shortened reconciliation cycles.",
        "Built the <b>partner onboarding platform</b> with country-specific KYC, AML and regulatory workflows; "
        "secured approvals across multiple jurisdictions and reduced onboarding lead time by <b>~40%</b>.",
        "Drove <b>Go-To-Market</b> for two new client segments — defined ICP, pricing tiers, sales enablement "
        "collateral and rollout playbook with Marketing, Legal and Compliance; adoption climbed from "
        "<b>40% to 85% in 12 months</b>.",
        "Delivered <b>~30% FTE optimisation</b> and accelerated time-to-market by introducing AI/ML-based "
        "document extraction, intelligent routing and exception handling — established the platform as a "
        "strategic differentiator in the bank's global lending transformation.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 4))

    # Wipro
    items.append(Paragraph("Senior Consultant — Product &amp; Platform Modernisation", styles["role"]))
    items.append(Paragraph("Wipro Technologies (client: Standard Bank Group)  ·  Johannesburg, South Africa  ·  Oct 2011 – Jun 2020", styles["meta"]))
    for b in [
        "Led the <b>core banking and payments modernisation</b> programme for one of Africa's largest banks — "
        "designed the SAP-based target architecture and migrated <b>26 partner platforms</b> (mobile money, "
        "card schemes, agency banking, remittance corridors) into a unified ecosystem.",
        "Drove a high-impact <b>AML &amp; compliance</b> initiative across <b>14 African markets</b>, hardening "
        "the bank's risk framework and cutting false-positive alerts by <b>~35%</b>.",
        "Managed a global delivery team of <b>38</b> developers, BAs and data specialists; introduced Agile "
        "ceremonies and migrated the programme from Waterfall, lifting release cadence from quarterly to "
        "fortnightly.",
        "Partnered with enterprise architects on <b>API &amp; integration strategy</b> for self-service channels, "
        "branch operations and mobile wallets — directly relevant to Thunes' Direct Global Network ambitions.",
        "<b>6 years of international experience</b> across Sub-Saharan Africa with deep exposure to mobile money "
        "rails (M-Pesa, MTN, Airtel) and emerging-market payment behaviours.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 4))

    return items


def core_competencies_table():
    rows = [
        ["Product Strategy &amp; Roadmap", "GTM &amp; ICP Enablement", "P&amp;L &amp; Business Cases"],
        ["Pay CORE Platform &amp; APIs", "Treasury, Liquidity &amp; FX", "Real-Time Payments &amp; Wallets"],
        ["Onboarding &amp; KYC Platforms", "Cross-Functional Leadership", "Matrix &amp; Multi-Region Ops"],
        ["Agentic AI &amp; LLM Orchestration", "Regulatory &amp; Compliance", "Data, Metrics &amp; Experimentation"],
    ]
    para_rows = [[Paragraph(c, styles["side_chip"]) for c in r] for r in rows]
    t = Table(para_rows, colWidths=[56 * mm, 56 * mm, 56 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_BG),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, HexColor("#FFFFFF")),
    ]))
    return t


def core_competencies():
    return section("Core Competencies") + [core_competencies_table(), Spacer(1, 4)]


def ai_agents():
    items = section("AI Agents &amp; Workflow Automation")
    items.append(Paragraph(
        "Hands-on practitioner shipping agentic systems — production at JPM and "
        "personal builds — across LLM orchestration, tool-use, retrieval, and voice.",
        styles["body"],
    ))
    items.append(Spacer(1, 2))
    for b in [
        "<b>Agentic Loan Booking (JPM):</b> designed a multi-agent workflow where "
        "extraction, validation, KYC and covenant-check agents collaborate over a shared "
        "context bus; replaced ~30% of manual ops touchpoints and cut average booking "
        "turnaround from days to hours.",
        "<b>AI Document Intelligence:</b> orchestrated LLM + OCR pipelines with "
        "structured-output guards and human-in-the-loop review gates; rolled out across "
        "CIB and CB lending with measurable accuracy lift on covenant and term-sheet parsing.",
        "<b>TaskFlow (personal build, 2026):</b> a daily-routine app powered by an "
        "agent stack that plans the user's day, generates <b>chapter-wise book briefs</b>, "
        "<b>ElevenLabs voice affirmations</b> and <b>guided meditations</b>, and serves "
        "them through a streaming audio layer with a cache-warmup agent — calendar, "
        "wisdom and Mind Gym modules feed off the same orchestrator.",
        "<b>Tooling fluency:</b> Claude / Anthropic API, OpenAI, ElevenLabs voice, "
        "RAG with vector stores, agent frameworks (tool-use, function calling, MCP-style "
        "servers), prompt &amp; eval harnesses, and product instrumentation for agent "
        "quality, latency and unit economics.",
        "<b>Product POV on agents:</b> evaluate agentic features on <i>task success, "
        "intervention rate, $/successful task and trust signals</i> — not just demos; "
        "advocate for guardrails, observability and graceful fallbacks before scale-out.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 4))
    return items


def selected_outcomes():
    items = section("Selected Outcomes")
    for b in [
        "Scaled JPM Loan Booking Platform adoption from <b>40% → 85% in 12 months</b> via React UI, "
        "embedded Tableau analytics and structured change management.",
        "Cut onboarding lead time by <b>~40%</b> through a workflow-driven KYC platform with country-specific rule packs.",
        "Delivered <b>~30% FTE optimisation</b> using AI/ML document extraction across global lending operations.",
        "Reduced AML false positives by <b>~35%</b> across <b>14 African markets</b> at Standard Bank.",
        "Honoured at JPM with <b>MVP Award (Q3'22)</b> and <b>Team of the Quarter (Q3'24)</b>; won Wipro's White Paper Contest on the Future of Software Testing.",
    ]:
        items.append(bullet(b))
    return items


def two_col_footer():
    edu = [
        Paragraph("Education", styles["side_h"]),
        Paragraph("<b>M.Tech, Artificial Intelligence</b><br/>IIT Bhilai  ·  Ongoing", styles["side_b"]),
        Paragraph("<b>Executive MBA</b><br/>IIM Kozhikode", styles["side_b"]),
        Paragraph("<b>B.Tech, Electronics &amp; Communication</b><br/>Jaypee University of Information Technology", styles["side_b"]),
    ]
    certs = [
        Paragraph("Certifications", styles["side_h"]),
        Paragraph("Certified Scrum Product Owner (CSPO) — 2024", styles["side_b"]),
        Paragraph("Professional Certificate in Product Management — SP Jain Dubai, 2024", styles["side_b"]),
        Paragraph("Certified Strategy Professional — 2023", styles["side_b"]),
        Paragraph("Certified Scrum Master, Scrum Alliance — 2020", styles["side_b"]),
        Paragraph("AWS Certified Cloud Practitioner — 2019", styles["side_b"]),
        Paragraph("SAFe Practitioner — 2018", styles["side_b"]),
    ]
    tools = [
        Paragraph("Tools &amp; Tech", styles["side_h"]),
        Paragraph("AWS, Kafka, REST APIs, SQL, Tableau, SAS", styles["side_b"]),
        Paragraph("Claude / OpenAI APIs, ElevenLabs, RAG, MCP", styles["side_b"]),
        Paragraph("Jira Align, Confluence, Figma, InVision", styles["side_b"]),
        Paragraph("Loan IQ, ACBS, SAP CRM/BS", styles["side_b"]),
    ]

    table = Table(
        [[edu, certs, tools]],
        colWidths=[58 * mm, 58 * mm, 54 * mm],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    return [Spacer(1, 4)] + section("Education, Certifications &amp; Tooling") + [table]


def build():
    doc = SimpleDocTemplate(
        OUTPUT, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="Rishabh Sharma — Resume (Head of Product, Thunes)",
        author="Rishabh Sharma",
    )
    story = []
    story += header()
    story += profile()
    story += core_competencies()
    story += experience()
    story += ai_agents()
    story += selected_outcomes()
    story += two_col_footer()
    doc.build(story)
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    build()
