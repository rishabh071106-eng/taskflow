# Brodoit's own book covers (v34): no publisher cover art anywhere in the app. Every cover is drawn here, in code: a
# palette, an abstract motif chosen for the book's idea (blocks that compound for Atomic Habits, rings for Deep Work, a
# sunrise for The Miracle Morning …), the title in DM Serif Display and the author in Plus Jakarta Sans (both SIL Open
# Font License 1.1, in ./fonts with their licences; the fonts are only used to draw these pictures).
#   python scripts/covers/make.py <books.json> <out_dir> [ids…]
# books.json: [{ id, title, author, tag }] (node scripts/covers/books.js prints it from BOOK_SUMMARIES). Writes
# <out_dir>/<id>.svg; scripts/covers/render.js turns them into app/covers/<id>.webp (see scripts/covers/README.md).
import hashlib, json, math, os, random, sys
from xml.sax.saxutils import escape
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 600, 800

class Font:
    def __init__(self, f):
        t = TTFont(os.path.join(HERE, 'fonts', f)); self.cmap = t.getBestCmap(); self.hmtx = t['hmtx']; self.upm = t['head'].unitsPerEm
    def width(self, s, size, ls=0.0):
        w = sum(self.hmtx[self.cmap.get(ord(ch)) or self.cmap[ord('?')]][0] for ch in s)
        return w * size / self.upm + ls * max(0, len(s) - 1)
SERIF = Font('dm-serif-display-latin-400-normal.ttf'); SANS = Font('plus-jakarta-sans-latin-700-normal.ttf')

# bg, a = accent, b = light (title), c = mid, d = deep
PALETTES = [
    ('#1F2A44', '#E9B44C', '#F6EFE3', '#3B4E78', '#141C2F'),  # ink and gold
    ('#B5452F', '#F6D9A8', '#FCF1E5', '#842E1E', '#5E1C10'),  # terracotta
    ('#24392E', '#D9B66C', '#ECEFE2', '#4F6F57', '#15231B'),  # forest
    ('#4B2C4F', '#F0A38C', '#F7EAE2', '#7D5281', '#2E1A31'),  # plum
    ('#1E5F63', '#F2C57C', '#EAF2ED', '#33868C', '#103A3D'),  # teal
    ('#2B2A29', '#F07A5A', '#F5F0E7', '#4D4946', '#191818'),  # charcoal and coral
    ('#2F5D8C', '#F6D86B', '#EDF3F9', '#5385B8', '#1D3C5C'),  # sky
    ('#86552A', '#F5DCA8', '#FCF2E3', '#B07A41', '#573617'),  # ochre
    ('#3D3A6B', '#F2B5D4', '#EEECF8', '#625F9B', '#25234A'),  # indigo
    ('#6B2E3E', '#F5C46B', '#F9EBEE', '#984559', '#451D28'),  # wine
    ('#3F5E4A', '#F0E3B5', '#F0F4EA', '#628670', '#283D30'),  # sage
    ('#0F4C5C', '#EE7A3B', '#F4EEE3', '#21728A', '#08313C'),  # petrol
    ('#5A3E36', '#9FD3C7', '#F7EEE9', '#80604F', '#3A2722'),  # cocoa
    ('#262F3D', '#7FD1AE', '#EBF0F5', '#3E4D63', '#171D27'),  # night
]

# ── motifs: each draws in the zone below the title (top `t`, to the bottom of the cover) ──
def blocks(r, p, t, few=False):
    bg, a, b, c, d = p; s, g = 54, 16; cols = 7; rows = max(3, int((H - t - 40) / (s + g)))
    x0 = (W - (cols * s + (cols - 1) * g)) / 2; y0 = H - 30 - rows * (s + g) + g; out = []
    lit = r.randint(4, 7) if few else None
    for i in range(rows):
        for j in range(cols):
            x, y = x0 + j * (s + g), y0 + i * (s + g)
            if few:
                on = r.random() < 0.18
                out.append(f'<rect x="{x:.0f}" y="{y:.0f}" width="{s}" height="{s}" rx="10" fill="{a if on else "none"}" stroke="{c}" stroke-width="{0 if on else 3}" opacity="{1 if on else .7}"/>')
            else:
                k = (rows - 1 - i) + j  # grows from the bottom left, like habits compounding
                lvl = k / (rows + cols - 2)
                if lvl < 0.42: fill, op = a, 1
                elif lvl < 0.62: fill, op = b, .9
                else: fill, op = c, .6
                sz = s * (0.5 + 0.5 * min(1, (1.05 - lvl) * 1.3))
                out.append(f'<rect x="{x + (s - sz) / 2:.1f}" y="{y + (s - sz) / 2:.1f}" width="{sz:.1f}" height="{sz:.1f}" rx="{sz * .18:.1f}" fill="{fill}" opacity="{op}"/>')
    return ''.join(out)

def rings(r, p, t):
    bg, a, b, c, d = p; cx = W / 2 + r.randint(-130, 130); cy = (t + H) / 2 + r.randint(10, 90); out = []
    step = r.choice([30, 38, 46]); order = r.choice([[c, b, a, d], [b, c, d, a], [d, a, b, c]])
    for k, rad in enumerate(range(250, 20, -step)):
        col = order[k % 4] if k < 5 else a
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{rad}" fill="{col}" opacity="{.95 if col != b else .9}"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="14" fill="{b}"/>')
    return ''.join(out)

def arch(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; base = H - 40; w = 300; top = t + 40; out = []
    out.append(f'<circle cx="{cx}" cy="{top + 150}" r="{r.randint(74, 96)}" fill="{a}"/>')
    out.append(f'<path d="M{cx - w / 2} {base} V{top + w / 2} A{w / 2} {w / 2} 0 0 1 {cx + w / 2} {top + w / 2} V{base}" fill="none" stroke="{b}" stroke-width="14"/>')
    for x in (cx - w / 2 - 70, cx - w / 2 - 34, cx + w / 2 + 34, cx + w / 2 + 70):
        out.append(f'<rect x="{x - 12}" y="{top + w / 2 + 30}" width="24" height="{base - top - w / 2 - 30}" fill="{c}"/>')
    out.append(f'<rect x="{cx - w / 2 - 92}" y="{top + w / 2 + 18}" width="76" height="14" fill="{c}"/><rect x="{cx + w / 2 + 16}" y="{top + w / 2 + 18}" width="76" height="14" fill="{c}"/>')
    out.append(f'<rect x="40" y="{base}" width="{W - 80}" height="14" fill="{b}" opacity=".9"/>')
    return ''.join(out)

def scales(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; top = t + 50; ang = r.choice([-9, -6, 6, 9]); L = 170; out = []
    out.append(f'<rect x="{cx - 7}" y="{top}" width="14" height="{H - 70 - top}" fill="{b}"/><rect x="{cx - 90}" y="{H - 70}" width="180" height="16" rx="8" fill="{b}"/>')
    dx, dy = L * math.cos(math.radians(ang)), L * math.sin(math.radians(ang))
    out.append(f'<line x1="{cx - dx}" y1="{top + 20 - dy}" x2="{cx + dx}" y2="{top + 20 + dy}" stroke="{b}" stroke-width="12" stroke-linecap="round"/>')
    for sgn in (-1, 1):
        px, py = cx + sgn * dx, top + 20 + sgn * dy; pan = py + 120
        out.append(f'<line x1="{px}" y1="{py}" x2="{px - 60}" y2="{pan}" stroke="{b}" stroke-width="4" opacity=".7"/><line x1="{px}" y1="{py}" x2="{px + 60}" y2="{pan}" stroke="{b}" stroke-width="4" opacity=".7"/>')
        out.append(f'<path d="M{px - 74} {pan} A74 36 0 0 0 {px + 74} {pan} Z" fill="{a if sgn == (1 if ang > 0 else -1) else c}"/>')
    out.append(f'<circle cx="{cx}" cy="{top + 20}" r="16" fill="{a}"/>')
    return ''.join(out)

def globe(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; cy = (t + H) / 2 + 30; R = 190; out = [f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="{c}"/>']
    for k in (0.3, 0.62, 0.9): out.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{R * k}" ry="{R}" fill="none" stroke="{b}" stroke-width="4" opacity=".7"/>')
    for k in (-0.6, -0.2, 0.2, 0.6):
        y = cy + R * k; hw = R * math.sqrt(1 - k * k)
        out.append(f'<line x1="{cx - hw}" y1="{y}" x2="{cx + hw}" y2="{y}" stroke="{b}" stroke-width="4" opacity=".7"/>')
    out.append(f'<circle cx="{cx + r.randint(-90, 90)}" cy="{cy + r.randint(-100, 60)}" r="26" fill="{a}"/>')
    return ''.join(out)

def split(r, p, t):
    bg, a, b, c, d = p; cy = (t + H) / 2 + 30; R = r.choice([150, 170]); o = r.choice([70, 80, 95]); out = []
    g = '' if r.random() < .6 else f' transform="rotate(90 {W / 2} {cy})"'
    hh = math.sqrt(R * R - o * o)
    out.append(f'<g{g}><circle cx="{W / 2 - o}" cy="{cy}" r="{R}" fill="{a}"/><circle cx="{W / 2 + o}" cy="{cy}" r="{R}" fill="{c}" opacity=".85"/>')
    out.append(f'<path d="M{W / 2} {cy - hh} A{R} {R} 0 0 1 {W / 2} {cy + hh} A{R} {R} 0 0 1 {W / 2} {cy - hh} Z" fill="{b}"/></g>')
    return ''.join(out)

def beam(r, p, t):
    bg, a, b, c, d = p; out = [f'<rect x="0" y="{t}" width="{W}" height="{H - t}" fill="{d}"/>']
    out.append(f'<path d="M{W - 90} {t} L{W - 40} {t} L{W / 2 + 120} {H} L{60} {H} Z" fill="{a}" opacity=".9"/>')
    out.append(f'<circle cx="{W - 66}" cy="{t + 4}" r="40" fill="{b}"/>')
    out.append(f'<rect x="{W / 2 - 40}" y="{H - 170}" width="80" height="130" rx="40" fill="{d}"/><circle cx="{W / 2}" cy="{H - 205}" r="34" fill="{d}"/>')
    return ''.join(out)

def sea(r, p, t):
    bg, a, b, c, d = p; hz = (t + H) / 2 + 20; out = [f'<rect x="0" y="{hz}" width="{W}" height="{H - hz}" fill="{c}"/>']
    R = r.randint(80, 110); out.append(f'<circle cx="{W / 2}" cy="{hz}" r="{R}" fill="{a}"/><rect x="0" y="{hz}" width="{W}" height="{H - hz}" fill="{c}"/>')
    for k in range(6):
        y = hz + 24 + k * 30; w = R * 1.8 * (1 - k * 0.13)
        out.append(f'<rect x="{W / 2 - w / 2}" y="{y}" width="{w}" height="10" rx="5" fill="{a}" opacity="{.85 - k * .1}"/>')
    return ''.join(out)

def dotsone(r, p, t, dark=False):
    bg, a, b, c, d = p; cols, g = r.choice([(6, 84), (7, 72), (8, 64)]); rows = max(3, int((H - t - 60) / g)); x0 = (W - (cols - 1) * g) / 2; y0 = H - 50 - (rows - 1) * g; out = []
    pick = (r.randrange(rows), r.randrange(cols))
    for i in range(rows):
        for j in range(cols):
            x, y = x0 + j * g, y0 + i * g
            if (i, j) == pick: out.append(f'<circle cx="{x}" cy="{y}" r="36" fill="{d if dark else a}" stroke="{b if dark else "none"}" stroke-width="{4 if dark else 0}"/>')
            else: out.append(f'<circle cx="{x}" cy="{y}" r="10" fill="{b}" opacity=".75"/>')
    return ''.join(out)

def waves(r, p, t):
    bg, a, b, c, d = p; cols = [c, a, b, d, c]; out = []
    for k in range(5):
        y = t + 90 + k * ((H - t - 60) / 5); amp = r.randint(16, 30); ph = r.random() * 6
        pts = ' '.join(f'L{x} {y + amp * math.sin(x / 70 + ph + k):.1f}' for x in range(0, W + 20, 20))
        out.append(f'<path d="M0 {H} L0 {y + amp * math.sin(ph + k):.1f} {pts} L{W} {H} Z" fill="{cols[k]}" opacity="{.95 if cols[k] != b else .9}"/>')
    return ''.join(out)

def stairs(r, p, t):
    bg, a, b, c, d = p; n = r.choice([4, 5, 6, 7]); sw = (W - 80) / n; sh = (H - t - 120) / n; out = []
    pts = f'M40 {H}'
    for k in range(n):
        x = 40 + k * sw; y = H - (k + 1) * sh
        pts += f' L{x} {y} L{x + sw} {y}'
    out.append(f'<path d="{pts} L{W - 40} {H} Z" fill="{c}"/>')
    for k in range(n): out.append(f'<rect x="{40 + k * sw}" y="{H - (k + 1) * sh}" width="{sw}" height="8" fill="{b}" opacity=".85"/>')
    fx = 40 + (n - 1) * sw + sw / 2; fy = H - n * sh
    out.append(f'<line x1="{fx}" y1="{fy}" x2="{fx}" y2="{fy - 110}" stroke="{b}" stroke-width="6"/><path d="M{fx} {fy - 110} L{fx + 70} {fy - 88} L{fx} {fy - 66} Z" fill="{a}"/>')
    return ''.join(out)

def plant(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; base = H - 60; top = t + 70; out = []
    out.append(f'<path d="M{cx} {base} C{cx - 30} {base - 120} {cx + 40} {top + 160} {cx} {top}" fill="none" stroke="{b}" stroke-width="10" stroke-linecap="round"/>')
    for k in range(5):
        y = base - 70 - k * ((base - top - 80) / 5); side = -1 if k % 2 else 1; sz = 70 - k * 6
        out.append(f'<ellipse cx="{cx + side * (sz * .9)}" cy="{y}" rx="{sz}" ry="{sz * .42}" transform="rotate({side * -28} {cx + side * (sz * .9)} {y})" fill="{a if k % 2 else c}"/>')
    out.append(f'<circle cx="{cx}" cy="{top}" r="22" fill="{a}"/><rect x="60" y="{base}" width="{W - 120}" height="12" rx="6" fill="{b}" opacity=".85"/>')
    return ''.join(out)

def hourglass(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; top = t + 30; bot = H - 40; mid = (top + bot) / 2; hw = 150; out = []
    out.append(f'<path d="M{cx - hw} {top} L{cx + hw} {top} L{cx + 10} {mid} L{cx + hw} {bot} L{cx - hw} {bot} L{cx - 10} {mid} Z" fill="{c}"/>')
    lvl = r.uniform(0.35, 0.6)
    out.append(f'<path d="M{cx - hw * (1 - lvl) - 8} {top + (mid - top) * lvl} L{cx + hw * (1 - lvl) + 8} {top + (mid - top) * lvl} L{cx + 10} {mid} L{cx - 10} {mid} Z" fill="{a}"/>')
    out.append(f'<path d="M{cx - hw} {bot} L{cx + hw} {bot} L{cx} {bot - (bot - mid) * (1 - lvl) * .9} Z" fill="{a}"/><rect x="{cx - 3}" y="{mid}" width="6" height="{(bot - mid) * .55}" fill="{a}"/>')
    out.append(f'<rect x="{cx - hw - 30}" y="{top - 16}" width="{2 * hw + 60}" height="16" rx="8" fill="{b}"/><rect x="{cx - hw - 30}" y="{bot}" width="{2 * hw + 60}" height="16" rx="8" fill="{b}"/>')
    return ''.join(out)

def spark(r, p, t):
    bg, a, b, c, d = p; cx = W / 2 + r.randint(-110, 110); cy = (t + H) / 2 + r.randint(0, 70); out = []
    n = r.choice([12, 16, 20, 24]); L1, L2 = r.choice([(210, 140), (190, 110), (230, 170)])
    if r.random() < .5: out.append(f'<circle cx="{cx}" cy="{cy}" r="{L1 + 10}" fill="{c}" opacity=".5"/>')
    for k in range(n):
        ang = k * 2 * math.pi / n + r.random() * .05; L = L1 if k % 2 == 0 else L2
        out.append(f'<line x1="{cx + 60 * math.cos(ang):.1f}" y1="{cy + 60 * math.sin(ang):.1f}" x2="{cx + L * math.cos(ang):.1f}" y2="{cy + L * math.sin(ang):.1f}" stroke="{a if k % 2 == 0 else b}" stroke-width="{12 if k % 2 == 0 else 7}" stroke-linecap="round"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="42" fill="{b}"/>')
    return ''.join(out)

def compass(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; cy = (t + H) / 2 + 30; R = 180; rot = r.choice([-20, 15, 30, -35]); out = []
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="{c}"/><circle cx="{cx}" cy="{cy}" r="{R - 26}" fill="none" stroke="{b}" stroke-width="3" opacity=".6"/>')
    for k in range(12):
        ang = k * math.pi / 6; L = 22 if k % 3 == 0 else 12
        out.append(f'<line x1="{cx + (R - 8) * math.cos(ang):.1f}" y1="{cy + (R - 8) * math.sin(ang):.1f}" x2="{cx + (R - 8 - L) * math.cos(ang):.1f}" y2="{cy + (R - 8 - L) * math.sin(ang):.1f}" stroke="{b}" stroke-width="5"/>')
    out.append(f'<g transform="rotate({rot} {cx} {cy})"><path d="M{cx} {cy - R + 40} L{cx + 26} {cy} L{cx - 26} {cy} Z" fill="{a}"/><path d="M{cx} {cy + R - 40} L{cx + 26} {cy} L{cx - 26} {cy} Z" fill="{b}"/></g><circle cx="{cx}" cy="{cy}" r="12" fill="{d}"/>')
    return ''.join(out)

def coins(r, p, t):
    bg, a, b, c, d = p; out = [f'<circle cx="{W - 120}" cy="{t + 120}" r="90" fill="{a}" opacity=".9"/><circle cx="{W - 120}" cy="{t + 120}" r="62" fill="none" stroke="{d}" stroke-width="6" opacity=".35"/>']
    base = H - 50; ns = r.choice([[3, 5, 8, 12], [2, 4, 7, 11], [4, 6, 9, 13]])
    if r.random() < .5: out = [o.replace(f'cx="{W - 120}"', 'cx="120"') for o in out]; xs = [W - 110 - k * 120 for k in range(4)]
    else: xs = [110 + k * 120 for k in range(4)]
    for k, n in enumerate(ns):
        x = xs[k]
        for j in range(n):
            y = base - j * 22
            out.append(f'<ellipse cx="{x}" cy="{y + 10}" rx="48" ry="16" fill="{c}"/><ellipse cx="{x}" cy="{y}" rx="48" ry="16" fill="{a if j % 2 == 0 else b}"/>')
    return ''.join(out)

def checklist(r, p, t, lines_only=False):
    bg, a, b, c, d = p; out = []; n = 4; y0 = t + 50; g = (H - 60 - y0) / n
    for k in range(n):
        y = y0 + k * g; done = k < n - 1 - (0 if lines_only else r.randint(0, 1))
        if not lines_only:
            out.append(f'<rect x="60" y="{y}" width="64" height="64" rx="14" fill="{a if done else "none"}" stroke="{b}" stroke-width="{0 if done else 5}"/>')
            if done: out.append(f'<path d="M76 {y + 34} L88 {y + 46} L110 {y + 20}" fill="none" stroke="{d}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>')
        x0 = 60 if lines_only else 150; w = (W - 60 - x0) * (0.6 + 0.4 * r.random())
        out.append(f'<rect x="{x0}" y="{y + 18}" width="{w:.0f}" height="26" rx="13" fill="{b if done or lines_only else c}" opacity="{.85 if done else .7}"/>')
    if lines_only: out.append(f'<path d="M{W - 170} {H - 60} L{W - 70} {t + 70}" stroke="{a}" stroke-width="16" stroke-linecap="round"/>')
    return ''.join(out)

def sunrise(r, p, t):
    bg, a, b, c, d = p; hz = H - 170; out = []
    R = r.randint(110, 140); cx = W / 2 + r.randint(-60, 60)
    for k in range(10):
        ang = math.pi + (k + 0.5) * math.pi / 10
        out.append(f'<line x1="{cx + (R + 24) * math.cos(ang):.1f}" y1="{hz + (R + 24) * math.sin(ang):.1f}" x2="{cx + (R + 70) * math.cos(ang):.1f}" y2="{hz + (R + 70) * math.sin(ang):.1f}" stroke="{a}" stroke-width="8" stroke-linecap="round"/>')
    out.append(f'<circle cx="{cx}" cy="{hz}" r="{R}" fill="{a}"/>')
    out.append(f'<path d="M0 {hz + 10} C150 {hz - 30} 300 {hz + 40} {W} {hz - 10} L{W} {H} L0 {H} Z" fill="{c}"/>')
    out.append(f'<path d="M0 {hz + 80} C200 {hz + 40} 380 {hz + 110} {W} {hz + 60} L{W} {H} L0 {H} Z" fill="{d}"/>')
    return ''.join(out)

def peak(r, p, t):
    bg, a, b, c, d = p; base = H; px = r.randint(250, 400); py = t + r.randint(90, 140); sx = 120 if px > 320 else W - 120
    out = [f'<circle cx="{sx}" cy="{t + 90}" r="54" fill="{a}"/>']
    bx = r.randint(120, 200) if px > 320 else r.randint(400, 480)
    out.append(f'<path d="M{bx - 220} {base} L{bx} {t + 190} L{bx + 200} {base} Z" fill="{c}"/>')
    out.append(f'<path d="M110 {base} L{px} {py} L{W + 60} {base} Z" fill="{d}"/>')
    out.append(f'<path d="M{px} {py} L{px - 52} {py + 70} L{px - 18} {py + 56} L{px + 6} {py + 78} L{px + 50} {py + 64} Z" fill="{b}"/>')
    out.append(f'<line x1="{px}" y1="{py}" x2="{px}" y2="{py - 80}" stroke="{b}" stroke-width="6"/><path d="M{px} {py - 80} L{px + 56} {py - 64} L{px} {py - 48} Z" fill="{a}"/>')
    return ''.join(out)

def loop(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; cy = (t + H) / 2 + 30; R = 160; out = []
    cols = [a, b, c]
    for k in range(3):
        a0 = k * 2 * math.pi / 3 - math.pi / 2 + 0.18; a1 = a0 + 2 * math.pi / 3 - 0.36
        x0, y0 = cx + R * math.cos(a0), cy + R * math.sin(a0); x1, y1 = cx + R * math.cos(a1), cy + R * math.sin(a1)
        out.append(f'<path d="M{x0:.1f} {y0:.1f} A{R} {R} 0 0 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{cols[k]}" stroke-width="30" stroke-linecap="round"/>')
        tx, ty = -math.sin(a1), math.cos(a1)
        out.append(f'<path d="M{x1 + 34 * tx:.1f} {y1 + 34 * ty:.1f} L{x1 - 30 * math.cos(a1) - 8 * tx:.1f} {y1 - 30 * math.sin(a1) - 8 * ty:.1f} L{x1 + 30 * math.cos(a1) - 8 * tx:.1f} {y1 + 30 * math.sin(a1) - 8 * ty:.1f} Z" fill="{cols[k]}"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="40" fill="{a}"/>')
    return ''.join(out)

def curve(r, p, t, jag=False, bars=False):
    bg, a, b, c, d = p; x0, y0, x1, y1 = 60, H - 60, W - 60, t + 60; out = [f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}" stroke="{b}" stroke-width="5" opacity=".7"/><line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}" stroke="{b}" stroke-width="5" opacity=".7"/>']
    if bars:
        for k in range(6):
            h = (y0 - y1 - 40) * (0.25 + 0.13 * k) * (0.9 + 0.2 * r.random())
            out.append(f'<rect x="{x0 + 30 + k * 76}" y="{y0 - h}" width="50" height="{h}" rx="6" fill="{c if k < 5 else a}"/>')
    pts = []
    for k in range(41):
        u = k / 40; x = x0 + 20 + u * (x1 - x0 - 30)
        v = (math.exp(3.2 * u) - 1) / (math.exp(3.2) - 1) if not jag else u * 0.8 + 0.12 * math.sin(u * 23 + r.random())
        if jag: v += (r.random() - .5) * 0.12
        pts.append(f'{x:.1f},{y0 - 20 - max(0, v) * (y0 - y1 - 40):.1f}')
    out.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{a if not bars else b}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>')
    lx, ly = pts[-1].split(','); out.append(f'<circle cx="{lx}" cy="{ly}" r="20" fill="{b if not bars else a}"/>')
    return ''.join(out)

def shield(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; top = t + 30; w = 300; h = H - 60 - top; out = []
    out.append(f'<path d="M{cx} {top} L{cx + w / 2} {top + 50} V{top + h * .45} C{cx + w / 2} {top + h * .78} {cx + 40} {top + h * .92} {cx} {top + h} C{cx - 40} {top + h * .92} {cx - w / 2} {top + h * .78} {cx - w / 2} {top + h * .45} V{top + 50} Z" fill="{c}"/>')
    out.append(f'<path d="M{cx} {top + 36} L{cx + w / 2 - 34} {top + 76} V{top + h * .45} C{cx + w / 2 - 34} {top + h * .72} {cx + 30} {top + h * .85} {cx} {top + h - 34} Z" fill="{a}"/>')
    out.append(f'<path d="M{cx - 70} {top + h * .48} L{cx} {top + h * .36} L{cx + 70} {top + h * .48}" fill="none" stroke="{b}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>')
    return ''.join(out)

def spiral(r, p, t):
    bg, a, b, c, d = p; cx = W / 2 + r.randint(-40, 40); cy = (t + H) / 2 + 30; pts = []
    for k in range(400):
        th = k / 400 * 5.2 * math.pi; rad = 8 + th * 13
        pts.append(f'{cx + rad * math.cos(th):.1f},{cy + rad * math.sin(th):.1f}')
    return f'<circle cx="{cx}" cy="{cy}" r="215" fill="{c}" opacity=".55"/><polyline points="{" ".join(pts)}" fill="none" stroke="{a}" stroke-width="14" stroke-linecap="round"/><circle cx="{cx}" cy="{cy}" r="14" fill="{b}"/>'

def bubbles(r, p, t):
    bg, a, b, c, d = p; out = []
    def bub(x, y, w, h, col, tail_left, lines_col):
        tx = x + 50 if tail_left else x + w - 50
        o = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="34" fill="{col}"/><path d="M{tx - 22} {y + h - 2} L{tx + (-30 if tail_left else 30)} {y + h + 46} L{tx + 26} {y + h - 2} Z" fill="{col}"/>'
        for k in range(2): o += f'<rect x="{x + 36}" y="{y + 38 + k * 40}" width="{(w - 72) * (1 if k == 0 else .6):.0f}" height="16" rx="8" fill="{lines_col}" opacity=".55"/>'
        return o
    y = t + 40; v = r.randrange(3) if t < 400 else r.randrange(2)
    if v == 0: out += [bub(50, y, 360, 150, b, True, d), bub(190, y + 210, 360, 150, a, False, d)]
    elif v == 1: out += [bub(190, y, 360, 150, a, False, d), bub(50, y + 210, 360, 150, b, True, d)]
    else: out += [bub(50, y, 300, 124, c, True, b), bub(250, y + 150, 300, 124, a, False, d), bub(70, y + 300, 260, 110, b, True, d)]
    return ''.join(out)

def path(r, p, t):
    bg, a, b, c, d = p; out = []
    dpath = f'M{W / 2 - 60} {H + 20} C{W - 20} {H - 120} {40} {t + 200} {W / 2 + 80} {t + 70}'
    out.append(f'<path d="{dpath}" fill="none" stroke="{c}" stroke-width="64" stroke-linecap="round"/><path d="{dpath}" fill="none" stroke="{b}" stroke-width="6" stroke-dasharray="22 20" stroke-linecap="round"/>')
    fx, fy = W / 2 + 80, t + 70
    out.append(f'<circle cx="{fx}" cy="{fy}" r="36" fill="{a}"/><circle cx="{fx}" cy="{fy}" r="14" fill="{d}"/>')
    return ''.join(out)

def pulse(r, p, t):
    bg, a, b, c, d = p; y = (t + H) / 2 + 40; out = [f'<circle cx="{W / 2}" cy="{y}" r="190" fill="{c}" opacity=".7"/>']
    pts = f'0,{y} 150,{y} 190,{y - 40} 230,{y + 30} 270,{y - 150} 320,{y + 120} 360,{y - 20} 390,{y} {W},{y}'
    out.append(f'<polyline points="{pts}" fill="none" stroke="{a}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>')
    return ''.join(out)

def moon(r, p, t):
    bg, a, b, c, d = p; cx = W / 2 + 40; cy = (t + H) / 2 + 10; R = 160; out = []
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="{a}"/><circle cx="{cx + 70}" cy="{cy - 40}" r="{R - 10}" fill="{bg}"/>')
    for k in range(40):
        x = r.randint(40, W - 40); y = r.randint(t + 10, H - 120); s = r.choice([3, 4, 5, 7])
        if (x - cx) ** 2 + (y - cy) ** 2 < (R + 30) ** 2: continue
        out.append(f'<circle cx="{x}" cy="{y}" r="{s}" fill="{b}" opacity=".85"/>')
    out.append(f'<path d="M0 {H - 70} C200 {H - 110} 420 {H - 40} {W} {H - 90} L{W} {H} L0 {H} Z" fill="{d}"/>')
    return ''.join(out)

def dominoes(r, p, t):
    bg, a, b, c, d = p; out = []; base = H - 50; n = 6
    for k in range(n):
        x = 60 + k * 84; ang = min(70, k * 15) if k > 0 else 0; col = a if k == n - 1 else (b if k % 2 == 0 else c)
        out.append(f'<rect x="{x}" y="{base - 230}" width="40" height="230" rx="8" fill="{col}" transform="rotate({ang} {x + 40} {base})"/>')
    out.append(f'<rect x="30" y="{base}" width="{W - 60}" height="12" rx="6" fill="{b}" opacity=".8"/>')
    return ''.join(out)

def orbit(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; cy = (t + H) / 2 + 30; out = []
    for k, (rx, ry, rot) in enumerate([(230, 90, -20), (200, 70, 35), (150, 150, 0)]):
        out.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rot} {cx} {cy})" fill="none" stroke="{b if k != 2 else c}" stroke-width="5" opacity=".75"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="56" fill="{a}"/>')
    for k in range(5):
        ang = r.random() * 2 * math.pi; rr = r.choice([150, 200, 230])
        out.append(f'<circle cx="{cx + rr * .95 * math.cos(ang):.0f}" cy="{cy + rr * .45 * math.sin(ang):.0f}" r="{r.choice([12, 16, 20])}" fill="{b if k % 2 else a}"/>')
    return ''.join(out)

def lotus(r, p, t):
    bg, a, b, c, d = p; cx = W / 2; base = H - 150; out = [f'<rect x="0" y="{base + 20}" width="{W}" height="{H - base}" fill="{c}"/>']
    for k, (ang, L, col) in enumerate([(-62, 150, c), (62, 150, c), (-34, 190, a), (34, 190, a), (0, 220, b)]):
        out.append(f'<ellipse cx="{cx}" cy="{base - L / 2}" rx="{L * .26}" ry="{L / 2}" transform="rotate({ang} {cx} {base})" fill="{col}"/>')
    for k in range(4): out.append(f'<rect x="{cx - 160 + k * 20}" y="{base + 60 + k * 32}" width="{320 - k * 40}" height="9" rx="4.5" fill="{b}" opacity="{.5 - k * .1}"/>')
    return ''.join(out)

def mosaic(r, p, t):
    bg, a, b, c, d = p; out = []; s = 60; y0 = t + 30
    for i in range(int((H - y0) / s) + 1):
        for j in range(10):
            if r.random() < .35: continue
            col = r.choice([a, b, c, d, a]); x = j * s; y = y0 + i * s; sh = r.randrange(3)
            if sh == 0: out.append(f'<rect x="{x}" y="{y}" width="{s}" height="{s}" fill="{col}"/>')
            elif sh == 1: out.append(f'<path d="M{x} {y + s} A{s} {s} 0 0 1 {x + s} {y} L{x + s} {y + s} Z" fill="{col}"/>')
            else: out.append(f'<circle cx="{x + s / 2}" cy="{y + s / 2}" r="{s / 2}" fill="{col}"/>')
    return ''.join(out)

MOTIFS = dict(mosaic=mosaic, blocks=blocks, few=lambda r, p, t: blocks(r, p, t, few=True), rings=rings, arch=arch, scales=scales, globe=globe,
              split=split, beam=beam, sea=sea, dotsone=dotsone, darkone=lambda r, p, t: dotsone(r, p, t, dark=True), waves=waves,
              stairs=stairs, plant=plant, hourglass=hourglass, spark=spark, compass=compass, coins=coins, checklist=checklist,
              lines=lambda r, p, t: checklist(r, p, t, lines_only=True), sunrise=sunrise, peak=peak, loop=loop, curve=curve,
              walk=lambda r, p, t: curve(r, p, t, jag=True), bars=lambda r, p, t: curve(r, p, t, bars=True), shield=shield,
              spiral=spiral, bubbles=bubbles, path=path, pulse=pulse, moon=moon, dominoes=dominoes, orbit=orbit, lotus=lotus)

# the idea each cover stands for
BOOK_MOTIF = dict(
    atomic='blocks', deep='rings', medi='arch', dopa='scales', sap='globe', fast='split', frankl='beam', now='sea', subtle='few',
    flow='waves', grit='stairs', mindset='plant', **{'4hour': 'hourglass'}, showup='spark', sevenh='compass', whymatters='rings',
    rich='coins', gtd='checklist', onething='dotsone', maketime='sunrise', eatfrog='peak', powerhabit='loop', tinyhabits='plant',
    hyperfocus='rings', compound='curve', miracle='sunrise', slightedge='curve', checklist='checklist', essential='dotsone',
    indistract='shield', stolenfocus='spiral', digitalmin='few', shallows='waves', dailystoic='arch', obstacle='peak', ego='split',
    stillness='sea', discipline='stairs', discourses='arch', lettersstoic='lines', goodlife='arch', drive='compass', influence='bubbles',
    presuasion='beam', nudge='path', behave='split', bodyscore='pulse', whysleep='moon', outliers='dotsone', blink='spark',
    tipping='dominoes', strangers='bubbles', blackswan='darkone', antifragile='spark', skin='scales', range='peak', peak='stairs',
    warart='shield', psymoney='coins', babylon='coins', iwtyt='coins', moneylife='hourglass', millionaire='bars', intelligent='scales',
    randwalk='walk', boglehead='bars', goodgreat='stairs', leanstartup='loop', zeroone='spark', hardthing='peak', mwm='rings',
    radical='bubbles', multipliers='orbit', hom='bars', effexec='checklist', shoedog='path', jobs='dotsone', crucial='bubbles',
    neversplit='scales', yes='split', mtstick='spark', switch='path', winfriends='bubbles', thinkgrow='plant', bluezones='sunrise',
    outlive='pulse', obesity='plant', lifespan='hourglass', breath='waves', spark='spark', canthurt='peak', bigmagic='spark',
    steal='mosaic', onwriting='lines', artistway='spiral', makestick='loop', ultra='stairs', mindnum='dotsone', artlearn='rings',
    untethered='orbit', tenhappier='sea', miramind='lotus', tao='waves', fivedys='sunrise')
TAG_MOTIF = dict(productivity='blocks', focus='rings', mind='spiral', stoic='arch', money='coins', leadership='stairs',
                 communication='bubbles', health='pulse', creativity='spark')

def wrap(text, font, size, width):
    words = text.split(); lines = []; cur = ''
    for w in words:
        nxt = (cur + ' ' + w).strip()
        if font.width(nxt, size) <= width or not cur: cur = nxt
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def cover(book, k):
    p = PALETTES[k % len(PALETTES)]; bg, a, b, c, d = p
    r = random.Random(int(hashlib.sha1(book['id'].encode()).hexdigest()[:8], 16))
    title = book['title']; author = book['author'].upper()
    # the largest title size that fits in 3 lines (4 for the longest titles), at most 500 wide
    for size in range(78, 40, -2):
        lines = wrap(title, SERIF, size, 500)
        if len(lines) <= 3 or (size <= 50 and len(lines) <= 4): break
    lh = size * 1.04; y = 150 + size * 0.78
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', f'<rect width="{W}" height="{H}" fill="{bg}"/>']
    zone = int(150 + len(lines) * lh + 90)
    out.append(MOTIFS[BOOK_MOTIF.get(book['id']) or TAG_MOTIF.get(book.get('tag'), 'rings')](r, p, zone))
    # a soft fade behind the words, so the motif never runs under them
    out.append(f'<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{bg}" stop-opacity="1"/><stop offset="1" stop-color="{bg}" stop-opacity="0"/></linearGradient></defs>')
    out.append(f'<rect x="0" y="0" width="{W}" height="{zone - 60}" fill="{bg}"/><rect x="0" y="{zone - 60}" width="{W}" height="50" fill="url(#f)"/>')
    out.append(f'<rect x="48" y="78" width="44" height="6" rx="3" fill="{a}"/>')
    out.append(f'<text x="104" y="87" font-family="Plus Jakarta Sans" font-weight="800" font-size="17" letter-spacing="4.5" fill="{b}" opacity=".8">BRODOIT</text>')
    for i, l in enumerate(lines):
        out.append(f'<text x="46" y="{y + i * lh:.1f}" font-family="DM Serif Display" font-size="{size}" fill="{b}">{escape(l)}</text>')
    asz = 24
    while SANS.width(author, asz, 2.5) > 508 and asz > 15: asz -= 1
    out.append(f'<text x="48" y="{y + (len(lines) - 1) * lh + 54:.1f}" font-family="Plus Jakarta Sans" font-weight="700" font-size="{asz}" letter-spacing="2.5" fill="{a}">{escape(author)}</text>')
    out.append('</svg>')
    return '\n'.join(out)

if __name__ == '__main__':
    books = json.load(open(sys.argv[1], encoding='utf-8')); out = sys.argv[2]; only = set(sys.argv[3:])
    os.makedirs(out, exist_ok=True)
    for k, bk in enumerate(books):
        if only and bk['id'] not in only: continue
        open(os.path.join(out, bk['id'] + '.svg'), 'w', encoding='utf-8').write(cover(bk, k))
    print('covers:', len(only) or len(books))
