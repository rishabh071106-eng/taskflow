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


# ---------- Shared content (only facts from the original resume) ----------

def jpm_bullets():
    """Current-role bullets, lifted from the original resume verbatim
    (with light tightening). No fabricated counts or systems."""
    return [
        "Spearheading the <b>strategic vision and roadmap</b> for a <b>global digital loan booking "
        "platform</b>, defining the target-state architecture and driving the shift from legacy "
        "processes to an <b>AI-enabled, agentic ecosystem</b> serving <b>CIB and CB clients worldwide</b>.",
        "Formulating and delivering an <b>enterprise-scale architecture on AWS</b>, integrating with "
        "<b>Loan IQ, ACBS and upstream underwriting / pre-underwriting systems</b> through "
        "<b>APIs and Kafka</b>, facilitating seamless loan booking and downstream system synchronisation.",
        "Collaborating with global <b>risk, compliance and regulatory bodies</b> to achieve "
        "<b>country-specific approvals</b> and alignment, while advancing <b>multi-LOB expansion</b> "
        "in adherence to international banking standards.",
        "Defining and maintaining a <b>dynamic product roadmap</b>, capturing insights from "
        "stakeholders, users and data analytics, and transforming them into scalable features while "
        "<b>prioritising delivery based on business value</b>.",
        "Leading and coordinating a <b>cross-functional global workforce of 25+ engineers, product "
        "owners and data experts</b>, ensuring agile execution, sprint delivery and dependency "
        "resolution across diverse business lines and geographies.",
        "Delivering <b>measurable FTE optimisation</b> and accelerating time-to-market by applying "
        "<b>AI/ML-based document extraction and automation</b>, establishing the platform as a "
        "<b>strategic differentiator</b> in the bank's global lending transformation.",
    ]


def wipro_bullets():
    """Prior-role bullets, lifted from the original resume."""
    return [
        "Executed the end-to-end <b>digital overhaul of core banking</b> by assessing current-state "
        "processes, designing the target architecture in <b>SAP</b>, and transitioning from legacy "
        "<b>COBOL-based systems</b>.",
        "Spearheaded comprehensive <b>core modernisation and large-scale data migration</b>, "
        "streamlining and integrating <b>26 partner platforms</b> into a unified ecosystem.",
        "Directed a high-impact <b>AML compliance initiative</b>, enhancing regulatory alignment "
        "and fortifying the bank's <b>risk management framework</b>.",
        "Supervised a <b>38-member global team</b> of developers, business analysts and data "
        "specialists, overseeing system integration, migration and delivery across <b>self-service "
        "channels and branch operations</b>.",
        "Partnered with enterprise architects and senior technology leaders to devise cost-efficient "
        "solutions, enable workforce upskilling and accelerate product delivery through "
        "<b>Agile Transformation practices</b>.",
    ]


def ai_agents_bullets():
    """AI Agents section — framed around the production multi-agent
    loan-booking architecture, plus the AI assistant from Standard Bank
    and the personal TaskFlow build."""
    return [
        "<b>Multi-Agent Architecture for Loan Booking (production):</b> Defined the target-state "
        "architecture as a network of specialist agents — extraction, validation, regulatory checks "
        "and downstream synchronisation — integrated with <b>Loan IQ, ACBS and upstream "
        "underwriting / pre-underwriting systems</b> via <b>APIs and Kafka on AWS</b>, replacing "
        "legacy manual workflows with an <b>AI-enabled, agentic ecosystem</b> for CIB and CB clients "
        "worldwide.",
        "<b>AI/ML Document Extraction &amp; Automation:</b> Applied AI/ML-based document extraction "
        "and automation across the global lending platform — delivering <b>measurable FTE "
        "optimisation</b> and accelerating time-to-market, establishing the platform as a strategic "
        "differentiator in the bank's global lending transformation.",
        "<b>AI Assistant for Delivery Speed (Standard Bank):</b> Developed an AI assistant during "
        "the core banking modernisation programme to enhance delivery speed; recognised for "
        "<b>innovation and thought leadership</b>.",
        "<b>TaskFlow (personal build, 2026):</b> Daily-routine app powered by an agent stack that "
        "plans the user's day, generates <b>chapter-wise book briefs</b>, <b>ElevenLabs voice "
        "affirmations</b> and <b>guided meditations</b>, served through a streaming audio layer with "
        "a cache-warmup agent.",
        "<b>Tooling fluency:</b> Claude / Anthropic API, OpenAI, ElevenLabs voice, RAG with vector "
        "stores, agent frameworks (tool-use, function calling, MCP-style servers), prompt &amp; eval "
        "harnesses; <b>Loan IQ, ACBS, AWS, Kafka, React, Tableau</b>.",
    ]


def truthful_outcomes(generic=False):
    """Outcomes section, mapped 1:1 to the original Achievements section.

    `generic=True` strips employer names for the hybrid resume.
    """
    if generic:
        return [
            "<b>Loan Booking Platform adoption: 40% → 85% in 12 months</b> via React-based "
            "interface, Tableau dashboards, in-app analytics and structured change management.",
            "<b>Led Agile transformation in 2016</b>, driving migration from Waterfall to Agile by "
            "establishing sprints, ceremonies and cross-functional global delivery practices.",
            "<b>MVP Award (Q3 2022)</b> and <b>Team of the Quarter Award (Q3 2024)</b> at current "
            "employer, for exceptional contributions to Commercial Banking initiatives.",
            "Winner — industry <b>White Paper Contest on the Future of Software Testing</b>; "
            "developed an <b>AI assistant</b> to enhance delivery speed during a core banking "
            "modernisation programme.",
        ]
    return [
        "<b>JP Morgan Loan Booking Platform adoption: 40% → 85% in 12 months</b> via React-based "
        "interface, Tableau dashboards, in-app analytics and structured change management.",
        "<b>Led Agile transformation at Standard Bank (2016)</b>, driving migration from Waterfall "
        "to Agile by establishing sprints, ceremonies and cross-functional global delivery practices.",
        "<b>JP Morgan MVP Award (Q3 2022)</b> and <b>Team of the Quarter Award (Q3 2024)</b> for "
        "exceptional contributions to Commercial Banking initiatives.",
        "Winner — <b>Wipro White Paper Contest on the Future of Software Testing</b>; developed "
        "an <b>AI assistant at Standard Bank</b> to enhance delivery speed.",
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
                "AI Agents · Fintech Platforms · Payments")
    location = "Bengaluru, India  ·  Open to Singapore relocation"

    profile = (
        "Product leader with <b>15+ years</b> of expertise across <b>fintech and enterprise</b> "
        "domains, driving <b>innovation, scalability and AI/ML-powered solutions</b> aligned with "
        "business objectives. Currently <b>Vice President — Product Management at J.P. Morgan</b>, "
        "spearheading the strategic vision and roadmap for a <b>global digital loan booking "
        "platform</b> and driving the shift from legacy processes to an <b>AI-enabled, agentic "
        "ecosystem</b> serving CIB and CB clients worldwide. <b>6 years of international experience "
        "in Johannesburg</b> and <b>8 years in India</b>, with strong cross-functional leadership, "
        "<b>regulatory compliance &amp; governance</b> in banking and financial services, and "
        "end-to-end product lifecycle management including <b>P&amp;L ownership, cost estimation "
        "and risk management</b>."
    )

    milestones = [
        ("2011", "Joined Wipro · Standard Bank"),
        ("2016", "Agile transformation at Standard Bank"),
        ("2020", "VP — Product Management at J.P. Morgan"),
        ("2022", "Loan Booking Platform · MVP Award"),
        ("2024", "40% → 85% adoption · AI doc extraction"),
        ("2026", "Agentic ecosystem · TaskFlow"),
    ]
    # Competencies use the user's original resume language, with one explicit
    # emphasis on multi-agent architecture.
    competencies = [
        ["Agentic AI &amp; Multi-Agent Architecture", "AI-Driven Product Development", "Predictive Data Modeling"],
        ["Product Strategy &amp; Scalable Roadmap", "System Integration &amp; API/Kafka", "Digital Transformation"],
        ["Agile &amp; Lean Product Management", "Innovation Management", "Data Visualization &amp; Analytics"],
        ["Cross-Functional Leadership", "Stakeholder Management", "Customer Journey Mapping"],
    ]
    outcomes = truthful_outcomes()

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

    story += section("AI Agents &amp; Multi-Agent Architecture", anchor="agents", accent=accent)
    story.append(Paragraph(
        "Spearheading the shift from legacy loan booking to an <b>AI-enabled, agentic "
        "ecosystem</b> serving CIB and CB clients worldwide. Builds production multi-agent "
        "systems, an AI assistant for delivery acceleration, and a personal agent stack.",
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
                "Digital Product · AI Agents · Consumer Banking")
    location = "Bengaluru, India"

    profile = (
        "Product leader with <b>15+ years</b> across <b>fintech and enterprise</b> domains, driving "
        "<b>innovation, scalability and AI/ML-powered solutions</b> aligned with business "
        "objectives. Currently <b>Vice President — Product Management at J.P. Morgan</b>, "
        "spearheading the strategic vision and roadmap for a <b>global digital loan booking "
        "platform</b> and the shift from legacy processes to an <b>AI-enabled, agentic ecosystem</b>. "
        "Strong expertise in <b>cloud platforms, data strategy, AI/ML integration and advanced "
        "analytics</b>, leveraging insights to shape product vision and strengthen customer "
        "engagement; proven competency in <b>customer journey mapping</b>, <b>data visualization "
        "&amp; business analytics</b> (Tableau, in-app analytics) and <b>cross-functional "
        "leadership</b> across geographies."
    )

    milestones = [
        ("2011", "Joined Wipro · Standard Bank"),
        ("2016", "Agile transformation at Standard Bank"),
        ("2020", "VP — Product Management at J.P. Morgan"),
        ("2022", "Loan Booking Platform · MVP Award"),
        ("2024", "40% → 85% adoption · in-app analytics"),
        ("2026", "Agentic ecosystem · TaskFlow"),
    ]
    # Slight analytics / customer-journey lean while staying within the
    # original resume's competency vocabulary.
    competencies = [
        ["AI-Driven Product Development", "Agentic AI &amp; Multi-Agent Architecture", "Predictive Data Modeling"],
        ["Customer Journey Mapping", "Data Visualization &amp; Analytics", "Innovation Management"],
        ["Product Strategy &amp; Scalable Roadmap", "Agile &amp; Lean Product Management", "Digital Transformation"],
        ["Cross-Functional Leadership", "Stakeholder Management", "Team Leadership &amp; Management"],
    ]

    outcomes = truthful_outcomes()

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

    story += section("AI Agents &amp; Multi-Agent Architecture", anchor="agents", accent=accent)
    story.append(Paragraph(
        "Spearheading the shift from legacy loan booking to an <b>AI-enabled, agentic "
        "ecosystem</b> serving CIB and CB clients worldwide. Builds production multi-agent "
        "systems, an AI assistant for delivery acceleration, and a personal agent stack.",
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

    # Profile uses original-resume language only.
    profile = (
        "Product leader with <b>15+ years</b> of expertise across <b>fintech and enterprise</b> "
        "domains, driving <b>innovation, scalability and AI/ML-powered solutions</b> aligned with "
        "business objectives. Currently <b>Vice President — Product Management</b> at a tier-1 "
        "global investment &amp; commercial bank, spearheading the strategic vision and roadmap "
        "for a <b>global digital loan booking platform</b> and driving the shift from legacy "
        "processes to an <b>AI-enabled, agentic ecosystem</b> serving CIB and CB clients worldwide. "
        "<b>6 years of international experience in Johannesburg</b> and <b>8 years in India</b>, "
        "with a track record of cross-functional leadership, end-to-end product lifecycle "
        "management and program governance — including <b>P&amp;L ownership, cost estimation, "
        "risk management</b> and global product roadmap execution in an onshore–offshore model."
    )

    milestones = [
        ("2011", "Joined consultancy · Pan-African bank"),
        ("2016", "Led Agile transformation at the bank"),
        ("2020", "VP — Product Management role"),
        ("2022", "Loan Booking Platform · MVP Award"),
        ("2024", "40% → 85% adoption · AI doc extraction"),
        ("2026", "Agentic ecosystem · TaskFlow"),
    ]

    # Competencies grid — uses the original resume's competency wording,
    # plus one explicit emphasis on multi-agent architecture.
    competencies = [
        ["Agentic AI &amp; Multi-Agent Architecture", "AI-Driven Product Development", "Predictive Data Modeling"],
        ["Product Strategy &amp; Scalable Roadmap", "Agile &amp; Lean Product Management", "Innovation Management"],
        ["System Integration &amp; API/Kafka", "Data Visualization &amp; Analytics", "Digital Transformation"],
        ["Cross-Functional Leadership", "Stakeholder Management", "Customer Journey Mapping"],
    ]

    agents_intro = (
        "Spearheading the shift from legacy loan booking to an <b>AI-enabled, agentic ecosystem</b> "
        "serving CIB and CB clients worldwide. Builds production multi-agent systems, an AI "
        "assistant for delivery acceleration, and a personal agent stack."
    )

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
    story += section("AI Agents &amp; Multi-Agent Architecture", anchor="agents", accent=accent)
    story.append(Paragraph(agents_intro, S["body"]))
    story.append(Spacer(1, 2))
    for b in ai_agents_bullets():
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
    for b in jpm_bullets():
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
    for b in wipro_bullets():
        prior.append(bullet(b, S))
    story.append(KeepTogether(prior))
    story.append(Spacer(1, 5))

    story += section("Selected Outcomes &amp; Recognition", anchor="outcomes", accent=accent)
    for b in truthful_outcomes(generic=True):
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
