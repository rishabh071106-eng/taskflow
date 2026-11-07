// v36: the pictures in every lesson: the story's own main character (each lesson's hero, app/ideas/<id>.json) drawn in
// the place the story happens, one picture per story card (meet, the five ideas' stories, how it turned out).
// The people are Notionists by Zoish (CC0 1.0, via DiceBear, MIT): free for any use, no credit needed. The places and
// props are drawn here, in the same black line style, in the lesson's colours. Nothing is copied from any book or app.
//   npm i --no-save @dicebear/core@9.4.3 @dicebear/notionists@9.4.2      (once; only this script needs them)
//   node scripts/lessons/illustrate.js [ids…]      → app/lessons/img/<id>/<0-6>.svg (+ app/lessons/img/index.json)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createAvatar } = require('@dicebear/core');
const notionists = require('@dicebear/notionists'); // the style module itself (create, meta, schema)

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'app', 'lessons', 'img');
const W = 600, H = 450, INK = '#1d1b19';

// the covers' palettes (scripts/covers/make.py, same order): bg, accent, light, mid, deep
const PALETTES = [
  ['#1F2A44', '#E9B44C', '#F6EFE3', '#3B4E78', '#141C2F'], ['#B5452F', '#F6D9A8', '#FCF1E5', '#842E1E', '#5E1C10'],
  ['#24392E', '#D9B66C', '#ECEFE2', '#4F6F57', '#15231B'], ['#4B2C4F', '#F0A38C', '#F7EAE2', '#7D5281', '#2E1A31'],
  ['#1E5F63', '#F2C57C', '#EAF2ED', '#33868C', '#103A3D'], ['#2B2A29', '#F07A5A', '#F5F0E7', '#4D4946', '#191818'],
  ['#2F5D8C', '#F6D86B', '#EDF3F9', '#5385B8', '#1D3C5C'], ['#86552A', '#F5DCA8', '#FCF2E3', '#B07A41', '#573617'],
  ['#3D3A6B', '#F2B5D4', '#EEECF8', '#625F9B', '#25234A'], ['#6B2E3E', '#F5C46B', '#F9EBEE', '#984559', '#451D28'],
  ['#3F5E4A', '#F0E3B5', '#F0F4EA', '#628670', '#283D30'], ['#0F4C5C', '#EE7A3B', '#F4EEE3', '#21728A', '#08313C'],
  ['#5A3E36', '#9FD3C7', '#F7EEE9', '#80604F', '#3A2722'], ['#262F3D', '#7FD1AE', '#EBF0F5', '#3E4D63', '#171D27'],
];
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v * (1 - t) + hex(b)[i] * t).toString(16).padStart(2, '0')).join('');

// hair: by the hero's pronouns (and white hair past 55); sets picked by eye from the 64 Notionists hairstyles
const HAIR_F = ['variant02', 'variant04', 'variant08', 'variant10', 'variant23', 'variant28', 'variant36', 'variant37', 'variant39', 'variant41', 'variant43', 'variant45', 'variant46', 'variant47', 'variant48', 'variant57', 'variant58'];
const HAIR_M = ['variant01', 'variant03', 'variant05', 'variant06', 'variant07', 'variant09', 'variant12', 'variant13', 'variant15', 'variant16', 'variant17', 'variant18', 'variant19', 'variant21', 'variant22', 'variant24', 'variant25', 'variant27', 'variant30', 'variant31', 'variant33', 'variant34', 'variant35', 'variant38', 'variant40', 'variant49', 'variant53', 'variant54', 'variant55', 'variant56'];
const HAIR_OLD_F = ['variant48', 'variant57', 'variant02'], HAIR_OLD_M = ['variant42', 'variant60', 'variant13'];
const BODIES = ['variant01', 'variant02', 'variant03', 'variant05', 'variant06', 'variant08', 'variant10', 'variant12', 'variant13', 'variant15', 'variant17', 'variant19', 'variant21', 'variant23', 'variant25'];
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const pick = (arr, seed) => arr[hash(seed) % arr.length];

function heroLook(id, ideas) {
  const all = ideas.chapters.map(c => (c.story && c.story.b) || '').join(' ').toLowerCase();
  const she = (all.match(/\b(she|her|hers|herself)\b/g) || []).length, he = (all.match(/\b(he|him|his|himself)\b/g) || []).length;
  const female = she > he;
  const age = Number((/(\d{2})-year-old/.exec(ideas.hero.who || '') || [])[1]) || (/retired|grandmother|grandfather/i.test(ideas.hero.who || '') ? 62 : 30);
  const old = age >= 55; const seed = id + ':' + ideas.hero.name;
  return {
    female, old,
    hair: pick(old ? (female ? HAIR_OLD_F : HAIR_OLD_M) : (female ? HAIR_F : HAIR_M), seed + 'h'),
    body: pick(BODIES, seed + 'b'),
    beard: !female && hash(seed + 'beard') % 100 < (old ? 45 : 22),
    glasses: hash(seed + 'g') % 100 < (old ? 45 : 14), lens: pick(['variant11', 'variant08', 'variant03'], seed + 'lens'), // clear lenses only
    brows: 'variant0' + (1 + hash(seed + 'br') % 9), lips: 'variant' + String(1 + hash(seed + 'l') % 30).padStart(2, '0'),
    nose: 'variant' + String(1 + hash(seed + 'n') % 20).padStart(2, '0'), eyes: 'variant0' + (1 + hash(seed + 'e') % 5),
  };
}
// the hero, as an <svg> placed at x, y (size s), with a gesture
function hero(look, gesture, x, y, s) {
  const o = { seed: 'brodoit', hair: [look.hair], body: [look.body], brows: [look.brows], lips: [look.lips], nose: [look.nose], eyes: [look.eyes], bodyIconProbability: 0,
    beardProbability: look.beard ? 100 : 0, glasses: [look.lens], glassesProbability: look.glasses ? 100 : 0, gestureProbability: gesture ? 100 : 0 };
  if (gesture) o.gesture = [gesture];
  const svg = createAvatar(notionists, o).toString().replace(/<metadata[\s\S]*?<\/metadata>/, '');
  return svg.replace(/^<svg /, `<svg x="${x}" y="${y}" width="${s}" height="${s}" `);
}

// ── props, drawn in the people's line style ──
const L = (d, fill) => `<path d="${d}" fill="${fill || 'none'}" stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
const R = (x, y, w, h, fill, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx || 6}" fill="${fill || '#fff'}" stroke="${INK}" stroke-width="5"/>`;
const C = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill || '#fff'}" stroke="${INK}" stroke-width="5"/>`;
const P = {
  window(x, y, w, h, view, p) {
    let s = R(x, y, w, h, view === 'night' ? p.deep : mix(p.light, '#ffffff', 0.4));
    if (view === 'city') for (let i = 0; i < 5; i++) { const bw = w / 6, bh = 30 + (hash(x + ':' + i) % 70); s += `<rect x="${x + 8 + i * bw * 1.15}" y="${y + h - bh - 4}" width="${bw}" height="${bh}" fill="${p.mid}" opacity=".55"/>`; }
    if (view === 'sky') s += `<circle cx="${x + w * 0.72}" cy="${y + h * 0.34}" r="${h * 0.14}" fill="${p.accent}"/>` + `<path d="M${x + 14} ${y + h * 0.5} q20 -16 40 0 q16 -12 34 0" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`;
    if (view === 'night') { s += `<circle cx="${x + w * 0.7}" cy="${y + h * 0.32}" r="${h * 0.13}" fill="${p.accent}"/><circle cx="${x + w * 0.7 + 10}" cy="${y + h * 0.32 - 8}" r="${h * 0.12}" fill="${p.deep}"/>`; for (let i = 0; i < 6; i++) s += `<circle cx="${x + 12 + (hash('s' + i + x) % (w - 24))}" cy="${y + 12 + (hash('t' + i + x) % (h * 0.6))}" r="3" fill="#fff"/>`; }
    s += L(`M${x + w / 2} ${y} V${y + h} M${x} ${y + h / 2} H${x + w}`);
    return s;
  },
  desk: (x, y, w, p) => R(x, y, w, 18, p.mid, 4) + L(`M${x + 16} ${y + 18} V${H + 10} M${x + w - 16} ${y + 18} V${H + 10}`),
  laptop: (x, y, p) => R(x, y - 70, 110, 70, '#fff', 8) + `<rect x="${x + 12}" y="${y - 58}" width="86" height="46" fill="${p.accent}" opacity=".6"/>` + R(x - 14, y - 4, 138, 10, '#fff', 4),
  mug: (x, y, p) => R(x, y - 46, 38, 46, p.accent, 6) + L(`M${x + 38} ${y - 36} q18 4 0 22`) + L(`M${x + 10} ${y - 60} q-8 -10 0 -20 M${x + 26} ${y - 60} q-8 -10 0 -20`),
  plant: (x, y, p) => R(x, y - 50, 54, 50, p.accent, 8) + L(`M${x + 27} ${y - 50} q-30 -40 -20 -80 M${x + 27} ${y - 50} q30 -46 22 -90 M${x + 27} ${y - 50} V${y - 120}`) + `<ellipse cx="${x + 6}" cy="${y - 118}" rx="16" ry="26" fill="${p.mid}" stroke="${INK}" stroke-width="5" transform="rotate(-25 ${x + 6} ${y - 118})"/><ellipse cx="${x + 50}" cy="${y - 128}" rx="16" ry="28" fill="${p.mid}" stroke="${INK}" stroke-width="5" transform="rotate(22 ${x + 50} ${y - 128})"/>`,
  books: (x, y, p) => R(x, y - 22, 96, 22, p.accent, 3) + R(x + 8, y - 44, 84, 22, '#fff', 3) + R(x - 4, y - 66, 90, 22, p.mid, 3),
  shelf(x, y, w, p) { let s = R(x, y, w, 210, mix(p.light, '#ffffff', 0.3), 4) + L(`M${x} ${y + 70} H${x + w} M${x} ${y + 140} H${x + w}`); for (let r = 0; r < 3; r++) for (let i = 0; i < 4; i++) { const bh = 40 + (hash(r + ':' + i + x) % 22); s += `<rect x="${x + 12 + i * 26}" y="${y + 70 * (r + 1) - bh - 2}" width="20" height="${bh}" fill="${[p.accent, p.mid, '#fff', p.deep][(r + i) % 4]}" stroke="${INK}" stroke-width="4"/>`; } return s; },
  lamp: (x, y, p) => L(`M${x} ${y} V${y - 120} l40 -30`) + `<path d="M${x + 20} ${y - 170} l50 0 l-14 40 l-50 0 z" fill="${p.accent}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` + R(x - 24, y - 6, 50, 10, '#fff', 4),
  clock: (x, y, p) => C(x, y, 40, '#fff') + L(`M${x} ${y} V${y - 26} M${x} ${y} L${x + 18} ${y + 8}`) + `<circle cx="${x}" cy="${y}" r="4" fill="${INK}"/>` + `<circle cx="${x}" cy="${y}" r="46" fill="none" stroke="${p.accent}" stroke-width="6"/>`,
  phone: (x, y, p) => R(x, y, 120, 210, '#fff', 22) + `<rect x="${x + 14}" y="${y + 30}" width="92" height="150" rx="8" fill="${p.accent}" opacity=".35"/>` + R(x + 22, y + 44, 76, 26, '#fff', 12) + R(x + 22, y + 82, 60, 26, '#fff', 12) + R(x + 22, y + 120, 76, 26, '#fff', 12) + C(x + 104, y + 20, 14, p.mid),
  pole: (x, p) => L(`M${x} 0 V${H}`) + L(`M${x - 30} 70 H${x + 30}`) + `<rect x="${x - 12}" y="78" width="24" height="44" rx="10" fill="${p.accent}" stroke="${INK}" stroke-width="5"/>`,
  sun: (x, y, r, p) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${p.accent}"/>` + [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const a = i * Math.PI / 4; return L(`M${x + Math.cos(a) * (r + 12)} ${y + Math.sin(a) * (r + 12)} L${x + Math.cos(a) * (r + 30)} ${y + Math.sin(a) * (r + 30)}`); }).join(''),
  hills: (p) => `<path d="M-10 ${H - 110} q120 -70 250 -10 q130 60 370 -30 V${H + 10} H-10 z" fill="${p.mid}" opacity=".55"/>` + `<path d="M-10 ${H - 60} q160 -50 320 0 q140 40 300 -10 V${H + 10} H-10 z" fill="${mix(p.mid, '#ffffff', 0.35)}"/>`,
  tree: (x, y, p) => L(`M${x} ${y} V${y - 90}`) + C(x, y - 130, 52, p.mid) + C(x - 34, y - 104, 34, p.mid) + C(x + 34, y - 104, 34, p.mid),
  awning(p) { let s = ''; for (let i = 0; i < 8; i++) s += `<path d="M${i * 80 - 10} 0 h80 v70 q-40 26 -80 0 z" fill="${i % 2 ? '#fff' : p.accent}" stroke="${INK}" stroke-width="5"/>`; return s; },
  counter: (p) => R(-10, H - 120, W + 20, 140, p.mid, 0) + L(`M-10 ${H - 92} H${W + 10}`),
  crates: (x, y, p) => R(x, y - 60, 90, 60, '#fff', 4) + C(x + 24, y - 72, 16, p.accent) + C(x + 52, y - 76, 16, p.accent) + C(x + 76, y - 70, 14, p.accent),
  stumps: (x, y, p) => L(`M${x} ${y} V${y - 120} M${x + 20} ${y} V${y - 120} M${x + 40} ${y} V${y - 120} M${x - 4} ${y - 124} H${x + 44}`) + C(x + 90, y - 24, 16, p.accent),
  ball: (x, y, p) => C(x, y, 34, '#fff') + L(`M${x - 34} ${y} q34 -22 68 0 M${x} ${y - 34} q-20 34 0 68`) + `<circle cx="${x}" cy="${y}" r="10" fill="${p.accent}"/>`,
  board(x, y, p, chart) { let s = R(x, y, 190, 140, '#fff', 8); if (chart) { s += L(`M${x + 20} ${y + 120} L${x + 70} ${y + 80} L${x + 110} ${y + 96} L${x + 170} ${y + 30}`); s += `<circle cx="${x + 170}" cy="${y + 30}" r="9" fill="${p.accent}" stroke="${INK}" stroke-width="4"/>`; } else s += L(`M${x + 24} ${y + 40} H${x + 160} M${x + 24} ${y + 72} H${x + 140} M${x + 24} ${y + 104} H${x + 110}`); return s; },
  coins: (x, y, p) => [0, 1, 2, 3].map(i => `<ellipse cx="${x}" cy="${y - i * 16}" rx="40" ry="13" fill="${i % 2 ? '#fff' : p.accent}" stroke="${INK}" stroke-width="5"/>`).join(''),
  cross: (x, y, p) => `<path d="M${x - 16} ${y - 48} h32 v32 h32 v32 h-32 v32 h-32 v-32 h-32 v-32 h32 z" fill="${p.accent}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`,
  curtain: (x, p) => `<path d="M${x} 0 h120 q-20 90 10 200 q-60 0 -130 10 z" fill="${p.mid}" opacity=".6" stroke="${INK}" stroke-width="5"/>`,
  stove: (x, y, p) => R(x, y - 30, 150, 30, '#fff', 4) + `<path d="M${x + 30} ${y - 30} h90 v-26 h-90 z" fill="${p.mid}" stroke="${INK}" stroke-width="5"/>` + L(`M${x + 120} ${y - 46} h40`) + L(`M${x + 54} ${y - 70} q-8 -12 0 -24 M${x + 80} ${y - 70} q-8 -12 0 -24`),
  jars(x, y, p) { let s = L(`M${x} ${y} H${x + 190}`); for (let i = 0; i < 4; i++) s += R(x + 8 + i * 46, y - 54, 36, 54, [p.accent, '#fff', p.mid, '#fff'][i], 8); return s; },
  bed: (x, y, p) => R(x, y - 60, 230, 60, p.mid, 10) + R(x + 12, y - 92, 80, 36, '#fff', 14) + L(`M${x} ${y - 60} V${y - 130}`),
  bubble: (x, y, p, txt) => `<path d="M${x} ${y} h130 a16 16 0 0 1 16 16 v50 a16 16 0 0 1 -16 16 h-84 l-22 22 v-22 h-24 a16 16 0 0 1 -16 -16 v-50 a16 16 0 0 1 16 -16 z" fill="#fff" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` + (txt ? `<text x="${x + 65}" y="${y + 52}" text-anchor="middle" font-size="38" font-weight="800" fill="${p.deep}" font-family="Plus Jakarta Sans, sans-serif">${txt}</text>` : L(`M${x + 20} ${y + 30} H${x + 116} M${x + 20} ${y + 52} H${x + 90}`)),
};

// where a story happens, from its words
const PLACES = [
  ['sport', /\b(cricket|football|kabaddi|badminton|match|nets|stadium|coach|marathon|running|run|gym|workout|swim|tournament|race)\b/g],
  ['commute', /\b(bus|metro|train|auto|commute|traffic|scooter|rickshaw|platform|station|ride)\b/g],
  ['kitchen', /\b(cook|cooking|kitchen|chai|tea|dal|roti|recipe|breakfast|lunch|dinner|meal|cake|cakes|bakery|food|canteen|tiffin|idli|dosa)\b/g],
  ['shop', /\b(shop|store|customer|customers|sell|selling|kirana|market|stall|boutique|order|orders|counter|business)\b/g],
  ['clinic', /\b(hospital|clinic|doctor|nurse|nurses|patient|patients|ward|therapist|therapy)\b/g],
  ['money', /\b(salary|money|rupees|invest|investing|sip|emi|loan|bank|savings|budget|fund|stock|stocks|market)\b/g],
  ['night', /\b(night|sleep|bed|midnight|insomnia|awake|dark|alarm|snooze)\b/g],
  ['study', /\b(exam|exams|study|studying|class|college|school|syllabus|notes|library|semester|student|students|teacher|lesson|chapter|homework|tuition)\b/g],
  ['office', /\b(office|meeting|boss|manager|team|client|clients|email|emails|laptop|presentation|project|startup|deadline|colleague|colleagues|desk)\b/g],
  ['phone', /\b(phone|instagram|reels|scroll|scrolling|whatsapp|notification|notifications|app|apps|screen)\b/g],
  ['outdoors', /\b(park|walk|walks|garden|village|farm|beach|trek|hill|hills|terrace|river|field|fields|lake)\b/g],
];
function placeOf(text) {
  const t = String(text).toLowerCase(); let best = 'home', n = 0;
  for (const [k, re] of PLACES) { const c = (t.match(re) || []).length; if (c > n) { n = c; best = k; } }
  return best;
}
// what the hero's hands do: a wave to meet them, a phone only where the story is about one, a pointing or open hand
// while the ideas unfold, both arms up when it works out
function gestureOf(text, k, place) {
  if (k === 0) return 'waveLongArm';
  if (k === 6) return 'waveOkLongArms';
  if (place === 'phone') return 'handPhone';
  return ['pointLongArm', 'hand', 'okLongArm', 'point', 'wavePointLongArms'][k - 1];
}

function scene(place, p, seed) {
  const side = hash(seed) % 2; // props left or right of the hero
  const lx = side ? 380 : 24, rx = side ? 24 : 380;
  switch (place) {
    case 'office': return P.window(lx, 40, 190, 170, 'city', p) + P.desk(rx - 10, 330, 220, p) + P.laptop(rx + 40, 330, p) + P.mug(rx + 168, 330, p);
    case 'study': return P.shelf(lx + 20, 60, 130, p) + P.desk(rx - 10, 330, 220, p) + P.books(rx + 20, 330, p) + P.lamp(rx + 170, 330, p);
    case 'kitchen': return P.jars(lx, 120, p) + P.stove(rx + 10, 340, p) + R(-10, 340, W + 20, 130, mix(p.mid, '#ffffff', 0.25), 0) + P.mug(lx + 60, 330, p);
    case 'commute': return P.window(30, 50, 170, 150, 'city', p) + P.window(400, 50, 170, 150, 'city', p) + P.pole(side ? 510 : 90, p);
    case 'shop': return P.awning(p) + P.counter(p) + P.crates(lx + 20, H - 120, p) + P.crates(rx + 60, H - 120, p);
    case 'clinic': return P.curtain(side ? W - 130 : 10, p) + P.cross(lx + 90, 120, p) + P.board(rx, 90, p, false);
    case 'money': return P.board(lx, 60, p, true) + P.coins(rx + 100, 400, p) + P.coins(rx + 40, 420, p);
    case 'night': return P.window(lx + 20, 50, 160, 150, 'night', p) + P.bed(rx - 10, H - 20, p) + P.lamp(side ? 40 : W - 70, H - 30, p);
    case 'sport': return P.sun(lx + 80, 90, 34, p) + `<path d="M-10 ${H - 70} H${W + 10}" stroke="#fff" stroke-width="8"/>` + P.stumps(rx + 40, H - 70, p);
    case 'phone': return P.phone(lx + 40, 60, p) + P.bubble(rx + 20, 60, p, '!') + P.bubble(rx + 40, 170, p, '');
    case 'outdoors': return P.hills(p) + P.sun(lx + 100, 96, 36, p) + P.tree(rx + 90, H - 60, p);
    default: return P.window(lx + 10, 50, 170, 150, 'sky', p) + P.plant(rx + 60, H - 30, p) + P.clock(side ? 80 : W - 80, 70, p);
  }
}

function picture(look, p, k, text, seed) {
  const place = placeOf(text);
  const bg = mix(p.accent, '#ffffff', 0.62), blob = mix(p.accent, '#ffffff', 0.25);
  const hs = 380, hx = (W - hs) / 2 + (hash(seed + 'x') % 2 ? -20 : 20), hy = H - hs + 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="${bg}"/>` +
    `<circle cx="${W / 2}" cy="${H / 2 + 40}" r="${170}" fill="${blob}" opacity=".7"/>` +
    scene(place, p, seed) + hero(look, gestureOf(text, k, place), hx, hy, hs) + '</svg>';
}

function books() {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(s);
  return vm.runInNewContext('(' + m[1].replace(/\\\\/g, '\\') + ')', {}, { timeout: 5000 });
}

if (require.main === module) {
  const only = new Set(process.argv.slice(2)); const index = {};
  books().forEach((b, n) => {
    let ideas; try { ideas = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'ideas', b.id + '.json'), 'utf8')); } catch (e) { return; }
    const pal = PALETTES[n % PALETTES.length]; const p = { bg: pal[0], accent: pal[1], light: pal[2], mid: pal[3], deep: pal[4] };
    const look = heroLook(b.id, ideas); index[b.id] = { hero: ideas.hero.name, pal, places: [] }; // the player paints each lesson in its cover's colours
    const dir = path.join(OUT, b.id);
    ideas.chapters.forEach((c, k) => {
      const text = ((c.story && c.story.h) || '') + ' ' + ((c.story && c.story.b) || '');
      index[b.id].places.push(placeOf(text));
      if (only.size && !only.has(b.id)) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, k + '.svg'), picture(look, p, k, text, b.id + ':' + k));
    });
  });
  if (!only.size) fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log('pictures for', only.size || Object.keys(index).length, 'lessons');
}
module.exports = { placeOf, heroLook };
