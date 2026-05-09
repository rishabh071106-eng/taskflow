"""Rishabh Sharma — designed resume targeting Thunes Head of Product (Core & Growth).

Layout: A4 single-column with a horizontal Career Roadmap, accented section
headers, two-column Education/Certifications/Tools footer. Generated with
reportlab so the source-of-truth is text and the file rebuilds deterministically.
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Flowable, KeepTogether,
)

OUTPUT = "/home/user/taskflow/resume/Rishabh_Sharma_Resume_2026_Thunes_HoP.pdf"

# Palette — deep navy with a warm gold accent for milestones.
NAVY = HexColor("#0B2545")
INK = HexColor("#13315C")
SLATE = HexColor("#3F4A5A")
RULE = HexColor("#8DA9C4")
SOFT = HexColor("#EEF4F7")
GOLD = HexColor("#B5894E")
BODY = HexColor("#1A1A1A")

PAGE_W = 210 * mm
MARGIN = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

styles = {
    "name": ParagraphStyle("name", fontName="Helvetica-Bold", fontSize=24,
                            leading=27, textColor=NAVY, spaceAfter=2),
    "headline": ParagraphStyle("headline", fontName="Helvetica", fontSize=11.5,
                                leading=14, textColor=INK, spaceAfter=4),
    "contact": ParagraphStyle("contact", fontName="Helvetica", fontSize=9,
                                leading=12, textColor=SLATE, spaceAfter=4),
    "section": ParagraphStyle("section", fontName="Helvetica-Bold", fontSize=10.5,
                                leading=13, textColor=white, spaceBefore=2,
                                spaceAfter=4),
    "role": ParagraphStyle("role", fontName="Helvetica-Bold", fontSize=10.8,
                            leading=13, textColor=NAVY, spaceAfter=1),
    "meta": ParagraphStyle("meta", fontName="Helvetica-Oblique", fontSize=9,
                            leading=12, textColor=SLATE, spaceAfter=3),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.5,
                            leading=13, textColor=BODY, alignment=TA_JUSTIFY,
                            spaceAfter=2),
    "bullet": ParagraphStyle("bullet", fontName="Helvetica", fontSize=9.4,
                              leading=12.5, textColor=BODY, leftIndent=11,
                              bulletIndent=2, spaceAfter=2, alignment=TA_LEFT),
    "side_h": ParagraphStyle("side_h", fontName="Helvetica-Bold", fontSize=10,
                              leading=13, textColor=NAVY, spaceBefore=2,
                              spaceAfter=3),
    "side_b": ParagraphStyle("side_b", fontName="Helvetica", fontSize=9,
                              leading=12, textColor=BODY, spaceAfter=2),
    "chip": ParagraphStyle("chip", fontName="Helvetica", fontSize=8.7,
                            leading=11, textColor=INK, alignment=TA_CENTER),
    "milestone_year": ParagraphStyle("my", fontName="Helvetica-Bold", fontSize=9,
                                       leading=11, textColor=NAVY,
                                       alignment=TA_CENTER),
    "milestone_label": ParagraphStyle("ml", fontName="Helvetica", fontSize=8.2,
                                        leading=10, textColor=SLATE,
                                        alignment=TA_CENTER),
}


# ---------- Custom flowables ----------

def _decode(text):
    return (text.replace("&amp;", "&")
                .replace("&middot;", "·")
                .replace("&nbsp;", " "))


class SectionHeader(Flowable):
    """Coloured bar with white section title."""

    def __init__(self, text, width=CONTENT_W, height=15, color=NAVY,
                 accent=GOLD):
        super().__init__()
        self.text = _decode(text)
        self.width = width
        self.height = height
        self.color = color
        self.accent = accent

    def wrap(self, *_):
        return self.width, self.height + 4

    def draw(self):
        c = self.canv
        c.setFillColor(self.color)
        c.rect(0, 0, self.width, self.height, stroke=0, fill=1)
        c.setFillColor(self.accent)
        c.rect(0, 0, 4, self.height, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(12, (self.height - 8) / 2 + 1, self.text.upper())


class CareerRoadmap(Flowable):
    """Horizontal milestone timeline with diamond markers."""

    def __init__(self, milestones, width=CONTENT_W, height=58):
        super().__init__()
        self.milestones = milestones
        self.width = width
        self.height = height

    def wrap(self, *_):
        return self.width, self.height

    def _diamond(self, x, y, r, fill):
        c = self.canv
        c.setFillColor(fill)
        c.setStrokeColor(fill)
        p = c.beginPath()
        p.moveTo(x, y + r)
        p.lineTo(x + r, y)
        p.lineTo(x, y - r)
        p.lineTo(x - r, y)
        p.close()
        c.drawPath(p, stroke=0, fill=1)

    def draw(self):
        c = self.canv
        n = len(self.milestones)
        pad = 10
        line_y = self.height - 22
        x_start = pad
        x_end = self.width - pad
        c.setStrokeColor(RULE)
        c.setLineWidth(1.1)
        c.line(x_start, line_y, x_end, line_y)

        step = (x_end - x_start) / max(n - 1, 1)
        from reportlab.platypus import Paragraph as P
        for i, (year, label) in enumerate(self.milestones):
            x = x_start + i * step
            self._diamond(x, line_y, 4.2, GOLD)
            # Year above
            yp = P(year, styles["milestone_year"])
            yw, yh = yp.wrap(60, 14)
            yp.drawOn(c, x - yw / 2, line_y + 7)
            # Label below
            lp = P(label, styles["milestone_label"])
            lw, lh = lp.wrap(min(step + 18, 110), 30)
            lp.drawOn(c, x - lw / 2, line_y - lh - 7)


# ---------- Building blocks ----------

def hr(color=RULE, width=CONTENT_W, weight=0.6):
    t = Table([[""]], colWidths=[width], rowHeights=[0.6])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), weight, color)]))
    return t


def section(title):
    return [SectionHeader(title), Spacer(1, 4)]


def bullet(text):
    return Paragraph(f"• {text}", styles["bullet"])


# ---------- Sections ----------

def header():
    name = Paragraph("RISHABH SHARMA", styles["name"])
    headline = Paragraph(
        "Vice President — Product Management  &nbsp;·&nbsp;  Fintech Platforms · AI Agents · Payments",
        styles["headline"],
    )
    contact = Paragraph(
        "Bengaluru, India  ·  +91 70877 50777  ·  rishabh071106@gmail.com  ·  "
        '<link href="https://www.linkedin.com/in/rishabh-sharmaiimk/" color="#13315C">'
        "linkedin.com/in/rishabh-sharmaiimk</link>"
        "  ·  Open to Singapore relocation",
        styles["contact"],
    )
    return [name, headline, contact, hr(weight=0.8), Spacer(1, 6)]


def profile():
    text = (
        "Product leader with <b>15+ years</b> across global fintech, payments and banking platforms — "
        "<b>8+ years in product management</b> and <b>5+ years leading distributed product squads</b>. "
        "Currently <b>Vice President — Product Management at J.P. Morgan</b>, owning the global digital "
        "lending platform for CIB and CB clients with deep work in <b>syndicated lending, agency operations, "
        "real-time treasury and FX, platform APIs and partner onboarding</b>. Active builder of "
        "<b>agentic AI workflows</b> — from production loan-booking copilots to side-project agent stacks "
        "orchestrating LLMs, tool-use and voice models. Translates ambiguous market signals into scalable "
        "roadmaps, partners closely with engineering, compliance and GTM, and delivers measurable P&amp;L "
        "impact in matrixed, multi-region environments."
    )
    return [Paragraph(text, styles["body"]), Spacer(1, 6)]


def roadmap():
    milestones = [
        ("2011", "Joined Wipro · Standard Bank core banking"),
        ("2016", "Agile transformation across 14 markets"),
        ("2019", "AML &amp; compliance overhaul, 26 partner platforms"),
        ("2020", "Joined JPM as VP — Product Management"),
        ("2022", "Launched global Loan Booking Platform v1"),
        ("2024", "Scaled adoption 40 → 85%; AI doc extraction live"),
        ("2026", "Agentic loan ecosystem · TaskFlow agent stack"),
    ]
    return section("Career Roadmap") + [CareerRoadmap(milestones), Spacer(1, 4)]


def competencies():
    rows = [
        ["Product Strategy &amp; Roadmap", "GTM &amp; ICP Enablement", "P&amp;L &amp; Business Cases"],
        ["Pay CORE Platform &amp; APIs", "Treasury, Liquidity &amp; FX", "Real-Time Payments &amp; Wallets"],
        ["Onboarding &amp; KYC Platforms", "Cross-Functional Leadership", "Matrix &amp; Multi-Region Ops"],
        ["Agentic AI &amp; LLM Orchestration", "Syndicated Lending &amp; Agency", "Data, Metrics &amp; Experimentation"],
    ]
    chip_rows = [[Paragraph(c, styles["chip"]) for c in r] for r in rows]
    col_w = CONTENT_W / 3
    t = Table(chip_rows, colWidths=[col_w, col_w, col_w])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, white),
    ]))
    return section("Core Competencies") + [t, Spacer(1, 6)]


def experience():
    items = section("Professional Experience")

    items.append(Paragraph("Vice President — Product Management", styles["role"]))
    items.append(Paragraph(
        "J.P. Morgan Chase &amp; Co.  ·  Bengaluru, India  ·  Jun 2020 – Present",
        styles["meta"]))
    for b in [
        "Own the <b>global product strategy and roadmap</b> for the digital loan booking &amp; servicing "
        "platform serving Commercial &amp; Investment Banking clients across <b>30+ countries</b>; defined "
        "the target-state architecture and led the shift from legacy COBOL/manual workflows to an "
        "<b>AI-native, agentic ecosystem</b>.",
        "Deep <b>syndicated lending</b> exposure: shaped agency-bank workflows on <b>Loan IQ</b> and "
        "<b>ACBS</b> covering deal setup, lender allocations, drawdowns, rollovers, interest &amp; fee "
        "accruals, secondary trades and notices — directly transferable to multi-counterparty payment "
        "rails and treasury orchestration.",
        "Architected <b>API and Kafka integrations</b> with Loan IQ, ACBS and <b>12+ upstream "
        "underwriting and pre-booking systems</b> on AWS — the same orchestration pattern Thunes runs "
        "across its Pay CORE platform and partner network.",
        "Lead a cross-functional squad of <b>25+ engineers, product owners and data specialists</b> "
        "across India, US and EMEA; coach 4 PMs, run quarterly OKRs, sprint reviews and steering committees.",
        "Partnered with <b>Treasury, Liquidity and Risk</b> to model collateral, exposure and FX hedging "
        "flows; delivered controls that improved limit utilisation accuracy and shortened reconciliation cycles.",
        "Built the <b>partner onboarding platform</b> with country-specific KYC, AML and regulatory "
        "workflows; secured approvals across multiple jurisdictions and reduced onboarding lead time by <b>~40%</b>.",
        "Drove <b>Go-To-Market</b> for two new client segments — defined ICP, pricing tiers, sales "
        "enablement and rollout playbook with Marketing, Legal and Compliance; adoption rose from "
        "<b>40% to 85% in 12 months</b>.",
        "Delivered <b>~30% FTE optimisation</b> via AI/ML document extraction, intelligent routing and "
        "exception handling — established the platform as a strategic differentiator in the bank's "
        "global lending transformation.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 5))

    wipro = [
        Paragraph("Senior Consultant — Product &amp; Platform Modernisation", styles["role"]),
        Paragraph(
            "Wipro Technologies (client: Standard Bank Group)  ·  Johannesburg, South Africa  ·  Oct 2011 – Jun 2020",
            styles["meta"]),
    ]
    for b in [
        "Led the <b>core banking and payments modernisation</b> programme for one of Africa's largest banks — "
        "designed the SAP-based target architecture and migrated <b>26 partner platforms</b> (mobile money, "
        "card schemes, agency banking, remittance corridors) into a unified ecosystem.",
        "Drove a high-impact <b>AML &amp; compliance</b> initiative across <b>14 African markets</b>, "
        "hardening the bank's risk framework and cutting false-positive alerts by <b>~35%</b>.",
        "Managed a global delivery team of <b>38 developers, BAs and data specialists</b>; introduced Agile "
        "ceremonies and migrated the programme from Waterfall, lifting release cadence from quarterly to fortnightly.",
        "Partnered with enterprise architects on <b>API &amp; integration strategy</b> for self-service "
        "channels, branch operations and <b>mobile money rails (M-Pesa, MTN, Airtel)</b> — the corridor "
        "DNA Thunes' Direct Global Network is built on.",
        "<b>6 years of international experience</b> across Sub-Saharan Africa with deep exposure to "
        "emerging-market payment behaviour and regulatory diversity.",
    ]:
        wipro.append(bullet(b))
    items.append(KeepTogether(wipro))
    items.append(Spacer(1, 5))
    return items


def ai_agents():
    items = section("AI Agents &amp; Workflow Automation")
    items.append(Paragraph(
        "Hands-on practitioner shipping agentic systems — production at JPM and personal builds — "
        "across LLM orchestration, tool-use, retrieval and voice.",
        styles["body"],
    ))
    items.append(Spacer(1, 2))
    for b in [
        "<b>Agentic Loan Booking (JPM):</b> multi-agent workflow where extraction, validation, KYC and "
        "covenant-check agents collaborate over a shared context bus; replaced ~30% of manual ops "
        "touchpoints and cut average booking turnaround from days to hours.",
        "<b>AI Document Intelligence:</b> orchestrated LLM + OCR pipelines with structured-output "
        "guards and human-in-the-loop review gates across CIB and CB lending — measurable accuracy lift "
        "on covenant and term-sheet parsing.",
        "<b>TaskFlow (personal build, 2026):</b> a daily-routine app powered by an agent stack that "
        "plans the user's day, generates <b>chapter-wise book briefs</b>, <b>ElevenLabs voice "
        "affirmations</b> and <b>guided meditations</b>, and serves them through a streaming audio "
        "layer with a cache-warmup agent — calendar, wisdom and Mind Gym modules feed off the same orchestrator.",
        "<b>Tooling fluency:</b> Claude / Anthropic API, OpenAI, ElevenLabs voice, RAG with vector "
        "stores, agent frameworks (tool-use, function calling, MCP-style servers), prompt &amp; eval "
        "harnesses, and product instrumentation for agent quality, latency and unit economics.",
        "<b>Product POV on agents:</b> evaluate agentic features on <i>task success, intervention rate, "
        "$/successful task and trust signals</i> — not just demos; advocate for guardrails, observability "
        "and graceful fallbacks before scale-out.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 5))
    return items


def outcomes():
    items = section("Selected Outcomes &amp; Recognition")
    for b in [
        "Scaled JPM Loan Booking Platform adoption from <b>40% → 85% in 12 months</b> via React UI, "
        "embedded Tableau analytics and structured change management.",
        "Cut onboarding lead time by <b>~40%</b> through a workflow-driven KYC platform with "
        "country-specific rule packs.",
        "Delivered <b>~30% FTE optimisation</b> using AI/ML document extraction across global lending operations.",
        "Reduced AML false positives by <b>~35%</b> across <b>14 African markets</b> at Standard Bank.",
        "JPM <b>MVP Award (Q3'22)</b>, <b>Team of the Quarter (Q3'24)</b>; winner — Wipro White Paper "
        "Contest on the Future of Software Testing.",
    ]:
        items.append(bullet(b))
    items.append(Spacer(1, 5))
    return items


def footer():
    edu = [
        Paragraph("Education", styles["side_h"]),
        Paragraph("<b>M.Tech, Artificial Intelligence</b><br/>IIT Bhilai · Ongoing", styles["side_b"]),
        Paragraph("<b>Executive MBA</b><br/>IIM Kozhikode", styles["side_b"]),
        Paragraph("<b>B.Tech, Electronics &amp; Communication</b><br/>"
                  "Jaypee University of Information Technology", styles["side_b"]),
    ]
    certs = [
        Paragraph("Certifications", styles["side_h"]),
        Paragraph("Certified Scrum Product Owner (CSPO) · 2024", styles["side_b"]),
        Paragraph("Professional Certificate in Product Management — SP Jain Dubai · 2024", styles["side_b"]),
        Paragraph("Certified Strategy Professional · 2023", styles["side_b"]),
        Paragraph("Certified Scrum Master, Scrum Alliance · 2020", styles["side_b"]),
        Paragraph("AWS Certified Cloud Practitioner · 2019", styles["side_b"]),
        Paragraph("SAFe Practitioner · 2018", styles["side_b"]),
    ]
    tools = [
        Paragraph("Tools &amp; Tech", styles["side_h"]),
        Paragraph("AWS, Kafka, REST APIs, SQL, Tableau, SAS", styles["side_b"]),
        Paragraph("Claude / OpenAI APIs, ElevenLabs, RAG, MCP", styles["side_b"]),
        Paragraph("Jira Align, Confluence, Figma, InVision", styles["side_b"]),
        Paragraph("Loan IQ, ACBS, SAP CRM/BS", styles["side_b"]),
    ]

    col = CONTENT_W / 3
    table = Table([[edu, certs, tools]], colWidths=[col, col, col])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    return section("Education, Certifications &amp; Tooling") + [table]


# ---------- Page chrome ----------

def page_chrome(canvas, doc):
    canvas.saveState()
    # Left accent stripe
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, 6 * mm, A4[1], stroke=0, fill=1)
    # Page number
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE)
    canvas.drawRightString(A4[0] - MARGIN, 8 * mm,
                           f"Rishabh Sharma  ·  Page {doc.page}")
    canvas.restoreState()


def build():
    doc = SimpleDocTemplate(
        OUTPUT, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="Rishabh Sharma — Resume (Head of Product, Thunes)",
        author="Rishabh Sharma",
    )
    story = []
    story += header()
    story += profile()
    story += roadmap()
    story += competencies()
    story += experience()
    story += ai_agents()
    story += outcomes()
    story += footer()
    doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    build()
