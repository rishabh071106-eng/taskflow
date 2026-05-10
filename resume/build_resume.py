"""Resume generator — Rishabh Sharma — 2026.

Produces two interactive, clickable PDFs:
- Thunes: Head of Product — Core & Growth (Singapore)
- Wells Fargo: MarTech Senior Product Manager — Executive Director (Bengaluru)

Both share visual system (navy/gold palette, career-roadmap timeline, chip
grid, accent-bar section headers) and interactive features (mailto/tel/LinkedIn
links, in-document section navigation, PDF outline bookmarks).
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Flowable,
    KeepTogether, PageBreak,
)

# ---------- Palette ----------
NAVY = HexColor("#0B2545")
INK = HexColor("#13315C")
SLATE = HexColor("#3F4A5A")
RULE = HexColor("#8DA9C4")
SOFT = HexColor("#EEF4F7")
GOLD = HexColor("#B5894E")
BODY = HexColor("#1A1A1A")
LINK = HexColor("#0B5394")

# Wells Fargo accent (red) for that variant only.
WF_RED = HexColor("#B31B1B")

PAGE_W = 210 * mm
MARGIN = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

LINKEDIN = "https://www.linkedin.com/in/rishabh-sharmaiimk/"
EMAIL = "rishabh071106@gmail.com"
PHONE_DISPLAY = "+91 70877 50777"
PHONE_TEL = "tel:+917087750777"


def _styles(accent=GOLD):
    return {
        "name": ParagraphStyle("name", fontName="Helvetica-Bold", fontSize=24,
                                leading=27, textColor=NAVY, spaceAfter=2),
        "headline": ParagraphStyle("headline", fontName="Helvetica", fontSize=11.5,
                                    leading=14, textColor=INK, spaceAfter=4),
        "contact": ParagraphStyle("contact", fontName="Helvetica", fontSize=9,
                                    leading=12, textColor=SLATE, spaceAfter=4),
        "nav": ParagraphStyle("nav", fontName="Helvetica-Bold", fontSize=8.5,
                                leading=11, textColor=accent, spaceAfter=2,
                                alignment=TA_CENTER),
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
        "milestone_year": ParagraphStyle("my", fontName="Helvetica-Bold",
                                           fontSize=9, leading=11, textColor=NAVY,
                                           alignment=TA_CENTER),
        "milestone_label": ParagraphStyle("ml", fontName="Helvetica", fontSize=8.2,
                                            leading=10, textColor=SLATE,
                                            alignment=TA_CENTER),
    }


def _decode(text):
    return (text.replace("&amp;", "&").replace("&middot;", "·")
                .replace("&nbsp;", " "))


# ---------- Custom flowables ----------

class SectionHeader(Flowable):
    """Coloured bar with white section title.

    When an anchor name is supplied, also registers a named destination
    (so nav-strip links jump here) AND a side-panel outline entry so PDF
    readers show this section in their bookmarks tree.
    """

    def __init__(self, text, anchor=None, accent=GOLD, color=NAVY,
                 width=CONTENT_W, height=15):
        super().__init__()
        self.text = _decode(text)
        self.anchor = anchor
        self.accent = accent
        self.color = color
        self.width = width
        self.height = height

    def wrap(self, *_):
        return self.width, self.height + 4

    def draw(self):
        c = self.canv
        if self.anchor:
            # bookmarkHorizontal registers a named destination at this y; the
            # nav strip's <link href="#anchor"> jumps here. addOutlineEntry
            # adds a clickable entry to the reader's side bookmark panel.
            c.bookmarkHorizontal(self.anchor, 0, self.height + 4)
            c.addOutlineEntry(self.text, self.anchor, level=0)
        c.setFillColor(self.color)
        c.rect(0, 0, self.width, self.height, stroke=0, fill=1)
        c.setFillColor(self.accent)
        c.rect(0, 0, 4, self.height, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(12, (self.height - 8) / 2 + 1, self.text.upper())


class CareerRoadmap(Flowable):
    """Horizontal milestone timeline with diamond markers.

    Labels are hard-constrained to (step - gap) so they never collide with
    neighbouring labels.
    """

    def __init__(self, milestones, width=CONTENT_W, height=72, accent=GOLD,
                 gap=10):
        super().__init__()
        self.milestones = milestones
        self.width = width
        self.height = height
        self.accent = accent
        self.gap = gap

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
        pad = 14
        line_y = self.height - 28
        x_start = pad
        x_end = self.width - pad
        c.setStrokeColor(RULE)
        c.setLineWidth(1.0)
        c.line(x_start, line_y, x_end, line_y)
        step = (x_end - x_start) / max(n - 1, 1)
        max_label_w = step - self.gap
        S = _styles()
        for i, (year, label) in enumerate(self.milestones):
            x = x_start + i * step
            self._diamond(x, line_y, 4.5, self.accent)
            # Year above the line.
            yp = Paragraph(year, S["milestone_year"])
            yw, yh = yp.wrap(60, 14)
            yp.drawOn(c, x - yw / 2, line_y + 8)
            # Label below — hard-constrained so it never overflows the slot.
            lp = Paragraph(label, S["milestone_label"])
            lw, lh = lp.wrap(max_label_w, 36)
            lp.drawOn(c, x - lw / 2, line_y - lh - 9)


class CompanyBadge(Flowable):
    """Small monogram badge — used inline next to role lines."""

    def __init__(self, text, color=NAVY, fg=white, width=22, height=14):
        super().__init__()
        self.text = text
        self.color = color
        self.fg = fg
        self.width = width
        self.height = height

    def wrap(self, *_):
        return self.width + 6, self.height + 2

    def draw(self):
        c = self.canv
        c.setFillColor(self.color)
        c.roundRect(0, 0, self.width, self.height, 2, stroke=0, fill=1)
        c.setFillColor(self.fg)
        c.setFont("Helvetica-Bold", 7.6)
        c.drawCentredString(self.width / 2, (self.height - 7) / 2 + 1, self.text)


# ---------- Helpers ----------

def hr(width=CONTENT_W):
    t = Table([[""]], colWidths=[width], rowHeights=[0.6])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.8, RULE)]))
    return t


def section(title, anchor=None, accent=GOLD):
    return [SectionHeader(title, anchor=anchor, accent=accent), Spacer(1, 4)]


def bullet(text, S):
    return Paragraph(f"• {text}", S["bullet"])


def role_with_badge(badge_text, badge_color, role_text, S):
    """Render company badge + role title on a single line."""
    badge = CompanyBadge(badge_text, color=badge_color)
    para = Paragraph(role_text, S["role"])
    t = Table([[badge, para]], colWidths=[28, CONTENT_W - 28])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return t


def header(headline_html, accent, location_line, S):
    name = Paragraph("RISHABH SHARMA", S["name"])
    headline = Paragraph(headline_html, S["headline"])
    contact_html = (
        f'{location_line}  ·  '
        f'<link href="{PHONE_TEL}" color="#0B5394">{PHONE_DISPLAY}</link>  ·  '
        f'<link href="mailto:{EMAIL}" color="#0B5394">{EMAIL}</link>  ·  '
        f'<link href="{LINKEDIN}" color="#0B5394">linkedin.com/in/rishabh-sharmaiimk</link>'
    )
    contact = Paragraph(contact_html, S["contact"])
    nav_html = (
        '<link href="#profile">PROFILE</link>'
        '  ·  <link href="#roadmap">ROADMAP</link>'
        '  ·  <link href="#competencies">COMPETENCIES</link>'
        '  ·  <link href="#experience">EXPERIENCE</link>'
        '  ·  <link href="#agents">AI AGENTS</link>'
        '  ·  <link href="#outcomes">OUTCOMES</link>'
        '  ·  <link href="#education">EDUCATION</link>'
    )
    nav = Paragraph(nav_html, S["nav"])
    return [name, headline, contact, hr(), Spacer(1, 4), nav, Spacer(1, 6)]


def chip_grid(rows, S):
    chip_rows = [[Paragraph(c, S["chip"]) for c in r] for r in rows]
    col_w = CONTENT_W / 3
    t = Table(chip_rows, colWidths=[col_w] * 3)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, white),
    ]))
    return t


def footer_block(S):
    edu = [
        Paragraph("Education", S["side_h"]),
        Paragraph("<b>M.Tech, Artificial Intelligence</b><br/>IIT Bhilai · Ongoing", S["side_b"]),
        Paragraph("<b>Executive MBA</b><br/>IIM Kozhikode", S["side_b"]),
        Paragraph("<b>B.Tech, Electronics &amp; Communication</b><br/>"
                  "Jaypee University of Information Technology", S["side_b"]),
    ]
    certs = [
        Paragraph("Certifications", S["side_h"]),
        Paragraph("Certified Scrum Product Owner (CSPO) · 2024", S["side_b"]),
        Paragraph("Professional Certificate in Product Management — SP Jain Dubai · 2024", S["side_b"]),
        Paragraph("Certified Strategy Professional · 2023", S["side_b"]),
        Paragraph("Certified Scrum Master, Scrum Alliance · 2020", S["side_b"]),
        Paragraph("AWS Certified Cloud Practitioner · 2019", S["side_b"]),
        Paragraph("SAFe Practitioner · 2018", S["side_b"]),
    ]
    tools = [
        Paragraph("Tools &amp; Tech", S["side_h"]),
        Paragraph("AWS, Kafka, REST APIs, SQL, Tableau, SAS", S["side_b"]),
        Paragraph("Claude / OpenAI APIs, ElevenLabs, RAG, MCP", S["side_b"]),
        Paragraph("Jira Align, Confluence, Figma, InVision", S["side_b"]),
        Paragraph("Loan IQ, ACBS, SAP CRM/BS", S["side_b"]),
    ]
    col = CONTENT_W / 3
    table = Table([[edu, certs, tools]], colWidths=[col] * 3)
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def page_chrome(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, 6 * mm, A4[1], stroke=0, fill=1)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE)
    canvas.drawRightString(A4[0] - MARGIN, 8 * mm,
                           f"Rishabh Sharma  ·  Page {doc.page}")
    canvas.restoreState()


# Anchor paragraph (zero-height) used to mark in-flow targets the nav links into.
def anchor(name):
    return Paragraph(f'<a name="{name}"/>', ParagraphStyle(
        "anchor", fontSize=1, leading=1, textColor=white))


# ---------- Shared content ----------

def jpm_bullets():
    return [
        "Own the <b>global product strategy and roadmap</b> for the digital loan booking &amp; servicing "
        "platform serving Commercial &amp; Investment Banking clients across <b>30+ countries</b>; defined "
        "the target-state architecture and led the shift from legacy COBOL/manual workflows to an "
        "<b>AI-native, agentic ecosystem</b>.",
        "Deep <b>syndicated lending</b> exposure: shaped agency-bank workflows on <b>Loan IQ</b> and "
        "<b>ACBS</b> covering deal setup, lender allocations, drawdowns, rollovers, interest &amp; fee "
        "accruals, secondary trades and notices.",
        "Architected <b>API and Kafka integrations</b> with Loan IQ, ACBS and <b>12+ upstream "
        "underwriting and pre-booking systems</b> on AWS.",
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
        "exception handling.",
    ]


def wipro_bullets():
    return [
        "Led the <b>core banking and payments modernisation</b> programme for one of Africa's largest banks — "
        "designed the SAP-based target architecture and migrated <b>26 partner platforms</b> (mobile money, "
        "card schemes, agency banking, remittance corridors) into a unified ecosystem.",
        "Drove a high-impact <b>AML &amp; compliance</b> initiative across <b>14 African markets</b>, "
        "hardening the bank's risk framework and cutting false-positive alerts by <b>~35%</b>.",
        "Managed a global delivery team of <b>38 developers, BAs and data specialists</b>; introduced Agile "
        "ceremonies and migrated the programme from Waterfall, lifting release cadence from quarterly to fortnightly.",
        "Partnered with enterprise architects on <b>API &amp; integration strategy</b> for self-service "
        "channels, branch operations and <b>mobile money rails (M-Pesa, MTN, Airtel)</b>.",
        "<b>6 years of international experience</b> across Sub-Saharan Africa with deep exposure to "
        "emerging-market consumer behaviour and regulatory diversity.",
    ]


def ai_agents_bullets():
    return [
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
    ]


# ---------- Variant builders ----------

def build_thunes():
    output = "/home/user/taskflow/resume/Rishabh_Sharma_Resume_2026_Thunes_HoP.pdf"
    accent = GOLD
    S = _styles(accent=accent)
    doc = SimpleDocTemplate(
        output, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="Rishabh Sharma — Resume (Head of Product, Thunes)",
        author="Rishabh Sharma",
    )
    headline = ("Vice President — Product Management  &nbsp;·&nbsp;  "
                "Fintech Platforms · AI Agents · Payments")
    location = "Bengaluru, India  ·  Open to Singapore relocation"

    profile = (
        "Product leader with <b>15+ years</b> across global fintech, payments and banking platforms — "
        "<b>8+ years in product management</b> and <b>5+ years leading distributed product squads</b>. "
        "Currently <b>Vice President — Product Management at J.P. Morgan</b>, owning the global digital "
        "lending platform for CIB and CB clients with deep work in <b>syndicated lending, agency "
        "operations, real-time treasury and FX, platform APIs and partner onboarding</b>. Active builder "
        "of <b>agentic AI workflows</b> — from production loan-booking copilots to side-project agent "
        "stacks orchestrating LLMs, tool-use and voice models. Translates ambiguous market signals into "
        "scalable roadmaps, partners closely with engineering, compliance and GTM, and delivers measurable "
        "P&amp;L impact in matrixed, multi-region environments."
    )

    milestones = [
        ("2011", "Wipro · Standard Bank"),
        ("2016", "Agile across 14 markets"),
        ("2020", "Joined JPM · VP Product"),
        ("2022", "Loan Booking v1 launched"),
        ("2024", "Adoption 40% → 85%"),
        ("2026", "Agentic stack · TaskFlow"),
    ]
    competencies = [
        ["Product Strategy &amp; Roadmap", "GTM &amp; ICP Enablement", "P&amp;L &amp; Business Cases"],
        ["Pay CORE Platform &amp; APIs", "Treasury, Liquidity &amp; FX", "Real-Time Payments &amp; Wallets"],
        ["Onboarding &amp; KYC Platforms", "Cross-Functional Leadership", "Matrix &amp; Multi-Region Ops"],
        ["Agentic AI &amp; LLM Orchestration", "Syndicated Lending &amp; Agency", "Data, Metrics &amp; Experimentation"],
    ]
    outcomes = [
        "Scaled JPM Loan Booking Platform adoption from <b>40% → 85% in 12 months</b> via React UI, "
        "embedded Tableau analytics and structured change management.",
        "Cut onboarding lead time by <b>~40%</b> through a workflow-driven KYC platform with "
        "country-specific rule packs.",
        "Delivered <b>~30% FTE optimisation</b> using AI/ML document extraction across global lending operations.",
        "Reduced AML false positives by <b>~35%</b> across <b>14 African markets</b> at Standard Bank.",
        "JPM <b>MVP Award (Q3'22)</b>, <b>Team of the Quarter (Q3'24)</b>; winner — Wipro White Paper "
        "Contest on the Future of Software Testing.",
    ]

    story = []
    story += header(headline, accent, location, S)
    story.append(anchor("profile"))
    story.append(Paragraph(profile, S["body"]))
    story.append(Spacer(1, 6))

    story += section("Career Roadmap", anchor="roadmap", accent=accent)
    story.append(CareerRoadmap(milestones, accent=accent))
    story.append(Spacer(1, 4))

    story += section("Core Competencies", anchor="competencies", accent=accent)
    story.append(chip_grid(competencies, S))
    story.append(Spacer(1, 6))

    story += section("AI Agents &amp; Workflow Automation", anchor="agents", accent=accent)
    story.append(Paragraph(
        "Hands-on practitioner shipping agentic systems — production at JPM and personal builds — "
        "across LLM orchestration, tool-use, retrieval and voice.",
        S["body"]))
    story.append(Spacer(1, 2))
    for b in ai_agents_bullets():
        story.append(bullet(b, S))

    story.append(PageBreak())
    story += section("Professional Experience", anchor="experience", accent=accent)
    story.append(role_with_badge("JPM", NAVY,
        "Vice President — Product Management", S))
    story.append(Paragraph(
        "J.P. Morgan Chase &amp; Co.  ·  Bengaluru, India  ·  Jun 2020 – Present",
        S["meta"]))
    for b in jpm_bullets():
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    wipro = [
        role_with_badge("WIP", HexColor("#341A6E"),
            "Senior Consultant — Product &amp; Platform Modernisation", S),
        Paragraph(
            "Wipro Technologies (client: Standard Bank Group)  ·  "
            "Johannesburg, South Africa  ·  Oct 2011 – Jun 2020",
            S["meta"]),
    ]
    for b in wipro_bullets():
        wipro.append(bullet(b, S))
    story.append(KeepTogether(wipro))
    story.append(Spacer(1, 5))

    story += section("Selected Outcomes &amp; Recognition", anchor="outcomes", accent=accent)
    for b in outcomes:
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    edu_block = (section("Education, Certifications &amp; Tooling",
                         anchor="education", accent=accent)
                 + [footer_block(S)])
    story.append(KeepTogether(edu_block))

    doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(f"Wrote {output}")


def build_wellsfargo():
    output = "/home/user/taskflow/resume/Rishabh_Sharma_Resume_2026_WellsFargo_MarTech.pdf"
    accent = WF_RED
    S = _styles(accent=accent)
    doc = SimpleDocTemplate(
        output, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="Rishabh Sharma — Resume (MarTech Sr. PM ED, Wells Fargo)",
        author="Rishabh Sharma",
    )
    headline = ("Vice President — Product Management  &nbsp;·&nbsp;  "
                "MarTech &amp; Marketing Platforms · Consumer Banking · AI Agents")
    location = "Bengaluru, India"

    profile = (
        "Senior product leader with <b>15+ years</b> in global fintech and consumer-facing banking — "
        "<b>8+ years in digital product management</b> and <b>5+ years leading and developing "
        "high-performing product teams</b>. Currently <b>Vice President — Product Management at "
        "J.P. Morgan</b>, where I run the platform-product playbook end-to-end: defining strategy, "
        "breaking it into quarterly and sprint-level OKRs, partnering across LOBs, and shipping with "
        "agile/scrum squads. Combines deep <b>MarTech-adjacent</b> product experience — <b>customer "
        "journey instrumentation, in-app analytics, Tableau adoption dashboards, segmentation and "
        "campaign-style rollouts</b> — with hands-on building of <b>agentic AI workflows</b> and "
        "<b>no-code/low-code configuration platforms</b>. Known for translating ambiguous business needs "
        "into a clear capabilities roadmap and delivering tangible customer and P&amp;L outcomes."
    )

    milestones = [
        ("2011", "Wipro · Standard Bank"),
        ("2016", "Agile across 14 markets"),
        ("2020", "Joined JPM · VP Product"),
        ("2022", "Platform v1 + analytics"),
        ("2024", "Adoption 40% → 85%"),
        ("2026", "MarTech-style agent stack"),
    ]
    competencies = [
        ["MarTech &amp; Marketing Platforms", "Customer Journey &amp; Segmentation", "Adoption Analytics &amp; OKRs"],
        ["Digital Product Management", "Agile · Scrum · Kanban Leadership", "Stakeholder &amp; LOB Influence"],
        ["No-Code / Low-Code Config", "Consumer Banking &amp; Lending", "Talent Development &amp; Hiring"],
        ["Agentic AI &amp; LLM Orchestration", "Data, Tableau &amp; Experimentation", "Capabilities Roadmap &amp; GTM"],
    ]

    # JPM bullets reframed for MarTech / Marketing-platform relevance.
    jpm_wf_bullets = [
        "Own the <b>capabilities roadmap</b> for J.P. Morgan's global lending platform — break strategy "
        "into <b>quarterly OKRs and sprint-level priorities</b> and re-prioritise continuously with LOB partners.",
        "Lead and develop a team of <b>25+ product owners, engineers and data specialists</b> across "
        "India, US and EMEA; coach 4 PMs, run hiring, performance and talent-development for a "
        "<b>high-performing product organisation</b>.",
        "Manage <b>scrum and kanban squads</b> delivering platform features and user stories; introduced "
        "no-code/low-code configuration patterns so business teams can self-serve common changes — "
        "directly relevant to <b>MarTech platform configuration and SharePoint-style operations</b>.",
        "Built embedded <b>Tableau adoption dashboards</b>, <b>in-app analytics</b> and <b>customer "
        "journey instrumentation</b> — defined and evolved the product success metrics and OKRs the "
        "platform is measured on.",
        "Drove <b>segmentation and campaign-style rollouts</b> for two new client segments — defined "
        "ICP, value props, enablement collateral and rollout playbook with Marketing, Legal and "
        "Compliance; adoption rose from <b>40% to 85% in 12 months</b>.",
        "Partnered across <b>technology, risk, legal, marketing and compliance</b> LOBs in a matrixed "
        "global setting; influenced senior stakeholders and provided credible, effective challenge.",
        "Delivered <b>~30% operational efficiency</b> via AI/ML document extraction, intelligent "
        "routing and exception handling — established the platform as a strategic differentiator.",
    ]

    outcomes = [
        "Scaled JPM Loan Booking Platform adoption from <b>40% → 85% in 12 months</b> via React UI, "
        "embedded Tableau analytics, in-app onboarding and structured change management.",
        "Reduced AML false positives by <b>~35%</b> across <b>14 African markets</b> at Standard Bank.",
        "JPM <b>MVP Award (Q3'22)</b>, <b>Team of the Quarter (Q3'24)</b>; winner — Wipro White Paper "
        "Contest on the Future of Software Testing.",
    ]

    story = []
    story += header(headline, accent, location, S)
    story.append(anchor("profile"))
    story.append(Paragraph(profile, S["body"]))
    story.append(Spacer(1, 6))

    story += section("Career Roadmap", anchor="roadmap", accent=accent)
    story.append(CareerRoadmap(milestones, accent=accent))
    story.append(Spacer(1, 4))

    story += section("Core Competencies", anchor="competencies", accent=accent)
    story.append(chip_grid(competencies, S))
    story.append(Spacer(1, 6))

    story += section("AI Agents &amp; Workflow Automation", anchor="agents", accent=accent)
    story.append(Paragraph(
        "Active builder of agentic AI systems — production at JPM and personal builds — "
        "with a clear product POV on metrics, guardrails and unit economics.",
        S["body"]))
    story.append(Spacer(1, 2))
    for b in ai_agents_bullets():
        story.append(bullet(b, S))

    story.append(PageBreak())
    story += section("Professional Experience", anchor="experience", accent=accent)
    story.append(role_with_badge("JPM", NAVY,
        "Vice President — Product Management", S))
    story.append(Paragraph(
        "J.P. Morgan Chase &amp; Co.  ·  Bengaluru, India  ·  Jun 2020 – Present",
        S["meta"]))
    for b in jpm_wf_bullets:
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    wipro = [
        role_with_badge("WIP", HexColor("#341A6E"),
            "Senior Consultant — Product &amp; Platform Modernisation", S),
        Paragraph(
            "Wipro Technologies (client: Standard Bank Group)  ·  "
            "Johannesburg, South Africa  ·  Oct 2011 – Jun 2020",
            S["meta"]),
    ]
    for b in wipro_bullets():
        wipro.append(bullet(b, S))
    story.append(KeepTogether(wipro))
    story.append(Spacer(1, 5))

    story += section("Selected Outcomes &amp; Recognition", anchor="outcomes", accent=accent)
    for b in outcomes:
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    edu_block = (section("Education, Certifications &amp; Tooling",
                         anchor="education", accent=accent)
                 + [footer_block(S)])
    story.append(KeepTogether(edu_block))

    doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(f"Wrote {output}")


def build_hybrid():
    """Generalised, AI-agents-first resume.

    No employer names — uses generic descriptors so the resume can be shared
    broadly. Combines the platform/syndicated-lending depth and the
    MarTech/OKR/team-leadership framing into one document with the AI Agents
    section elevated above Professional Experience.
    """
    output = "/home/user/taskflow/resume/Rishabh_Sharma_Resume_2026_AI_Agents_Hybrid.pdf"
    accent = GOLD
    S = _styles(accent=accent)
    doc = SimpleDocTemplate(
        output, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="Rishabh Sharma — Resume (Product Leader · AI Agents)",
        author="Rishabh Sharma",
    )
    headline = ("Vice President — Product Management  &nbsp;·&nbsp;  "
                "AI Agents · Fintech Platforms · Payments")
    location = "Bengaluru, India"

    profile = (
        "Product leader with <b>15+ years</b> across global fintech, payments and banking platforms — "
        "<b>8+ years in product management</b> and <b>5+ years leading distributed product squads</b>. "
        "Active builder of <b>agentic AI workflows</b> — production loan-booking copilots and "
        "side-project agent stacks orchestrating LLMs, tool-use, retrieval and voice models. Combines "
        "deep <b>platform-product DNA</b> (syndicated lending on industry servicing platforms, real-time "
        "treasury and FX, partner onboarding, customer-journey instrumentation, adoption analytics) with "
        "hands-on <b>agent design</b> — multi-agent decomposition, structured-output guards, "
        "human-in-the-loop gates and product instrumentation for <b>agent quality, latency and unit "
        "economics</b>. Translates ambiguous business needs into a clear capabilities roadmap and ships "
        "in a matrixed, multi-region, OKR-driven way."
    )

    milestones = [
        ("2011", "Joined consultancy · Pan-African bank"),
        ("2016", "Agile rollout across 14 markets"),
        ("2020", "Joined investment bank · VP Product"),
        ("2022", "Global lending platform v1 launched"),
        ("2024", "AI doc extraction · adoption 40→85%"),
        ("2026", "Agentic platform · TaskFlow agent stack"),
    ]

    competencies = [
        # AI / agents pillar lives in the top row.
        ["Agentic AI &amp; LLM Orchestration", "Multi-Agent Workflow Design", "Prompt, RAG &amp; Eval Harnesses"],
        ["Product Strategy &amp; Roadmap", "OKR-Driven Capabilities Planning", "GTM &amp; Customer Journeys"],
        ["APIs, Kafka &amp; Integrations", "Onboarding/KYC · Treasury/FX", "Syndicated Lending &amp; Agency"],
        ["Cross-Functional Leadership", "Talent Development &amp; Hiring", "Data, Analytics &amp; Experimentation"],
    ]

    # Generic current-role bullets — no employer name.
    current_role_bullets = [
        "Own the <b>global product strategy and roadmap</b> for a digital loan booking &amp; servicing "
        "platform serving CIB and CB clients across <b>30+ countries</b>; led the shift from legacy "
        "COBOL/manual workflows to an <b>AI-native, agentic ecosystem</b>.",
        "Lead a cross-functional squad of <b>25+ engineers, product owners and data specialists</b> "
        "across India, US and EMEA; coach 4 PMs, run quarterly OKRs, hiring and talent development "
        "for a <b>high-performing product organisation</b>.",
        "Deep <b>syndicated lending</b> exposure: shaped agency-bank workflows on industry servicing "
        "platforms covering deal setup, lender allocations, drawdowns, rollovers, interest &amp; fee "
        "accruals, secondary trades and notices.",
        "Architected <b>API and Kafka integrations</b> with <b>12+ upstream underwriting and "
        "pre-booking systems</b> on AWS, and partnered with Treasury, Liquidity &amp; Risk to model "
        "collateral, exposure and FX hedging flows.",
        "Built embedded <b>Tableau adoption dashboards</b>, <b>in-app analytics</b> and "
        "<b>customer-journey instrumentation</b>; defined and continuously evolved the product "
        "success metrics and OKRs the platform is measured on.",
        "Built the <b>partner onboarding platform</b> with country-specific KYC, AML and regulatory "
        "workflows; secured approvals across multiple jurisdictions and reduced onboarding lead time "
        "by <b>~40%</b>.",
        "Drove <b>segmentation and campaign-style GTM</b> for two new client segments — defined ICP, "
        "value props, enablement and rollout playbook with Marketing, Legal and Compliance; adoption "
        "rose from <b>40% to 85% in 12 months</b>.",
    ]

    prior_role_bullets = [
        "Led the <b>core banking and payments modernisation</b> programme for a top Pan-African bank — "
        "designed the SAP-based target architecture and migrated <b>26 partner platforms</b> (mobile "
        "money, card schemes, agency banking, remittance corridors) into a unified ecosystem.",
        "Drove a high-impact <b>AML &amp; compliance</b> initiative across <b>14 African markets</b>, "
        "hardening the bank's risk framework and cutting false-positive alerts by <b>~35%</b>.",
        "Managed a global delivery team of <b>38 developers, BAs and data specialists</b>; introduced "
        "Agile ceremonies and migrated the programme from Waterfall, lifting release cadence from "
        "quarterly to fortnightly.",
        "Partnered with enterprise architects on <b>API &amp; integration strategy</b> for self-service "
        "channels, branch operations and <b>mobile money rails (M-Pesa, MTN, Airtel)</b>.",
        "<b>6 years of international experience</b> across Sub-Saharan Africa with deep exposure to "
        "emerging-market consumer behaviour and regulatory diversity.",
    ]

    # AI Agents section — expanded for the hybrid; no employer names.
    agents_intro = (
        "Hands-on operator shipping agentic systems — both production at work and personal builds — "
        "across LLM orchestration, tool-use, retrieval, evaluation and voice. Treats every agent as a "
        "<b>product surface</b> with metrics, guardrails and unit economics, not a demo."
    )
    agents_bullets = [
        "<b>Agentic Loan Booking (production):</b> multi-agent workflow where extraction, validation, "
        "KYC and covenant-check agents collaborate over a shared context bus with structured-output "
        "guards and human-in-the-loop gates; replaced ~30% of manual ops touchpoints and cut average "
        "booking turnaround from days to hours.",
        "<b>AI Document Intelligence:</b> orchestrated LLM + OCR pipelines across CIB and CB lending "
        "with measurable accuracy lift on covenant and term-sheet parsing; designed the eval harness, "
        "exception-routing flow and graceful fallback to human review.",
        "<b>TaskFlow (personal build, 2026):</b> daily-routine app powered by an agent stack that "
        "plans the user's day, generates <b>chapter-wise book briefs</b>, <b>ElevenLabs voice "
        "affirmations</b> and <b>guided meditations</b>, served through a streaming audio layer with "
        "a cache-warmup agent — calendar, wisdom and Mind Gym modules feed off the same orchestrator.",
        "<b>Tooling fluency:</b> Claude / Anthropic API, OpenAI, ElevenLabs voice, RAG with vector "
        "stores, agent frameworks (tool-use, function calling, MCP-style servers), prompt &amp; eval "
        "harnesses, structured outputs.",
        "<b>Product POV on agents:</b> evaluate agentic features on <i>task success, intervention "
        "rate, $/successful task and trust signals</i> — not demos; insist on guardrails, "
        "observability and graceful fallbacks before scale-out.",
    ]

    outcomes = [
        "Delivered <b>~30% efficiency gain</b> using AI/ML document extraction across global "
        "lending operations.",
        "Reduced AML false positives by <b>~35%</b> across <b>14 African markets</b>.",
        "<b>MVP Award (Q3'22)</b> and <b>Team of the Quarter (Q3'24)</b> at current employer; "
        "winner — industry White Paper Contest on the Future of Software Testing.",
    ]

    story = []
    story += header(headline, accent, location, S)

    story.append(anchor("profile"))
    story.append(Paragraph(profile, S["body"]))
    story.append(Spacer(1, 6))

    story += section("Career Roadmap", anchor="roadmap", accent=accent)
    story.append(CareerRoadmap(milestones, accent=accent))
    story.append(Spacer(1, 4))

    story += section("Core Competencies", anchor="competencies", accent=accent)
    story.append(chip_grid(competencies, S))
    story.append(Spacer(1, 6))

    # Agents section elevated above Professional Experience to signal focus.
    story += section("AI Agents &amp; Agentic Workflows", anchor="agents", accent=accent)
    story.append(Paragraph(agents_intro, S["body"]))
    story.append(Spacer(1, 2))
    for b in agents_bullets:
        story.append(bullet(b, S))

    # Force Professional Experience onto a fresh page so the role title and
    # company line are never orphaned at the bottom of page 1.
    story.append(PageBreak())

    story += section("Professional Experience", anchor="experience", accent=accent)

    # Current role — generic descriptor instead of employer name.
    story.append(role_with_badge("VP", NAVY,
        "Vice President — Product Management", S))
    story.append(Paragraph(
        "Tier-1 Global Investment &amp; Commercial Bank  ·  Bengaluru, India  ·  Jun 2020 – Present",
        S["meta"]))
    for b in current_role_bullets:
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    # Prior role — generic descriptor instead of employer name.
    prior = [
        role_with_badge("SC", HexColor("#341A6E"),
            "Senior Consultant — Product &amp; Platform Modernisation", S),
        Paragraph(
            "Global IT Services Consultancy (Pan-African Banking client)  ·  "
            "Johannesburg, South Africa  ·  Oct 2011 – Jun 2020",
            S["meta"]),
    ]
    for b in prior_role_bullets:
        prior.append(bullet(b, S))
    story.append(KeepTogether(prior))
    story.append(Spacer(1, 5))

    story += section("Selected Outcomes &amp; Recognition", anchor="outcomes", accent=accent)
    for b in outcomes:
        story.append(bullet(b, S))
    story.append(Spacer(1, 5))

    edu_block = (section("Education, Certifications &amp; Tooling",
                         anchor="education", accent=accent)
                 + [footer_block(S)])
    story.append(KeepTogether(edu_block))

    doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(f"Wrote {output}")


if __name__ == "__main__":
    build_thunes()
    build_wellsfargo()
    build_hybrid()
