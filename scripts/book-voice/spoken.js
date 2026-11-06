// v34: the words a narrator says for a book note's text, so the studio voice never guesses at "5:30" (it read it as
// "five thousand thirty"), "9.15", "2 a.m.", "SIP", "UPI" or "Dr.". The text the app shows and the server checks stays
// as written; only what the voice is given (and what each take is checked against) goes through spoken().
//   spoken(text, { letters: 'dots' | 'names' }) → text
//   letters: how an initialism is written: 'dots' ("S. I. P.": what the studio voice is given), 'names' ("ess eye pee":
//   what a take is checked against, so a voice that said "sip" no longer passes as "SIP").
//   node scripts/book-voice/spoken.js [dots|names] < text      prints spoken(stdin)
//   node scripts/book-voice/spoken.js --lines [dots|names|check] one JSON string per line in, one per line out (the
//                                                               recorder keeps a "check" one running to check its takes)
'use strict';
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const u100 = n => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
const u1000 = n => { const h = Math.floor(n / 100), r = n % 100; return h ? ONES[h] + ' hundred' + (r ? ' and ' + u100(r) : '') : u100(r); };
function words(n) {
  n = Math.floor(Number(n)); if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return u1000(n);
  const out = [];
  for (const [v, name] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) if (n >= v) { out.push(words(Math.floor(n / v)) + ' ' + name); n %= v; }
  if (n) out.push((n < 100 ? 'and ' : '') + u1000(n));
  return out.join(' ');
}
// 1987 → nineteen eighty-seven, 1900 → nineteen hundred, 2005 → two thousand and five, 2024 → twenty twenty-four
function year(n) {
  const hi = Math.floor(n / 100), lo = n % 100;
  if (n >= 2000 && n < 2010) return 'two thousand' + (lo ? ' and ' + ONES[lo] : '');
  return u100(hi) + ' ' + (lo === 0 ? 'hundred' : lo < 10 ? 'oh ' + ONES[lo] : u100(lo));
}
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const ordinal = n => words(n).replace(/([a-z]+)$/, w => ORD[w] || (w.endsWith('y') ? w.slice(0, -1) + 'ieth' : w + 'th'));
const plural = w => w.replace(/([a-z]+)$/, x => x.endsWith('y') ? x.slice(0, -1) + 'ies' : x + 's');
function clock(h, m, ampm) {
  h = Number(h); m = Number(m);
  const mw = m === 0 ? (ampm ? '' : " o'clock") : m < 10 ? ' oh ' + ONES[m] : ' ' + u100(m);
  return words(h) + mw + (ampm ? ' ' + ampm : '');
}

// capitals said as words stay words; every other run of 2-6 capitals is spelled out (the voice read "SIP" as "sip",
// "UPI" as "oopy", "IT" as "it")
const AS_WORD = { NEET: 'Neet', BATNA: 'Batna', ONE: 'One', NASA: 'Nasa', ISRO: 'Isro', UNESCO: 'Unesco', COVID: 'Covid', AIIMS: 'Aims', SEBI: 'Sebi', NABARD: 'Nabard', SAARC: 'Sark' };
const MIXED = { BSc: 'BSC', BCom: 'B Com', MSc: 'MSC', PhD: 'PHD', BTech: 'B Tech', MTech: 'M Tech' };
const LETTER = { A: 'ay', B: 'bee', C: 'see', D: 'dee', E: 'ee', F: 'eff', G: 'jee', H: 'aitch', I: 'eye', J: 'jay', K: 'kay',
  L: 'el', M: 'em', N: 'en', O: 'oh', P: 'pee', Q: 'cue', R: 'ar', S: 'ess', T: 'tee', U: 'you', V: 'vee', W: 'double you',
  X: 'ex', Y: 'why', Z: 'zed' };
const spell = (caps, mode) => mode === 'names' ? caps.split('').map(l => LETTER[l] || l).join(' ') : caps.split('').join('. ') + '.';
// ₹3.50 → 3 rupees 50 paise (the numbers are written out below)
const money = (n, unit, sub) => { const [a, b] = n.split('.'); return a + ' ' + unit + (b && /^\d\d$/.test(b) && +b ? ' ' + +b + ' ' + sub : ''); };
const NOT_AFTER_NUMBER = '(?!\\.\\d|\\s?(?:%|percent|per\\b|lakh|crore|kg|km|kilo|litre|rupee|dollar|million|billion|thousand))';

function spoken(text, opt) {
  const mode = (opt && opt.letters) || 'dots';
  const AMW = mode === 'names' ? 'ay em' : 'A. M.', PMW = mode === 'names' ? 'pee em' : 'P. M.';
  let t = String(text == null ? '' : text);
  t = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, ' ');
  // abbreviations
  t = t.replace(/\bDr\.(?=\s)/g, 'Doctor').replace(/\bMr\.(?=\s)/g, 'Mister').replace(/\bMrs\.(?=\s)/g, 'Missus').replace(/\bMs\.(?=\s)/g, 'Miz')
    .replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,').replace(/\betc\./gi, 'et cetera.')
    .replace(/\bvs\.?(?=\s)/gi, 'versus').replace(/\bapprox\.(?=\s)/gi, 'about').replace(/\s&\s/g, ' and ')
    .replace(/\bNo\.\s?(?=\d)/g, 'number ');
  // money and percentages: ₹500, Rs 500, Rs. 1,200, $20, 20%
  t = t.replace(/(?:₹|\bRs\.?|\bINR)\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g, (_, n) => money(n, 'rupees', 'paise'))
    .replace(/\$\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g, (_, n) => money(n, 'dollars', 'cents'))
    .replace(/(\d)\s?%/g, '$1 percent');
  // 5-10 → five to ten (two plain numbers; before dashes become pauses)
  t = t.replace(/\b(\d{1,4})\s?[-–]\s?(\d{1,4})\b(?![-\d])/g, '$1 to $2');
  // clock times: 5:30, 6:00, 7:45 a.m.; 9.15 and 10.30 (the Indian way); 2 a.m.; the 5 AM Club. A sentence that ends
  // in "a.m." keeps its full stop.
  const AP = '(\\s?(?:[aApP]\\.\\s?[mM]\\.?|[aApP][mM])(?![A-Za-z]))';
  const say = s => s ? (/^\s?[aA]/.test(s) ? AMW : PMW) : '';
  const keep = (s, rest) => s && /\.$/.test(s) && /^(\s+["A-Z]|\s*$)/.test(rest) ? '.' : '';
  t = t.replace(new RegExp('\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b' + AP + '?', 'g'), (m, h, mi, s, off, str) => clock(h, mi, say(s)) + keep(s, str.slice(off + m.length)));
  t = t.replace(new RegExp('\\b(1[0-2]|0?[1-9])\\.([0-5]\\d)\\b' + NOT_AFTER_NUMBER + AP + '?', 'g'), (m, h, mi, s, off, str) => clock(h, mi, say(s)) + keep(s, str.slice(off + m.length)));
  t = t.replace(new RegExp('\\b(1[0-2]|0?[1-9])' + AP, 'g'), (m, h, s, off, str) => words(+h) + ' ' + say(s) + keep(s, str.slice(off + m.length)));
  // a dash between words is a pause
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\s+--\s+/g, ', ');
  // 24/7, 8/10, 1/2
  t = t.replace(/\b24\/7\b/g, 'twenty-four seven')
    .replace(/\b1\/2\b/g, 'one half').replace(/\b1\/3\b/g, 'one third').replace(/\b1\/4\b/g, 'one quarter').replace(/\b3\/4\b/g, 'three quarters')
    .replace(/\b(\d+)\/(\d+)\b/g, (_, a, b) => words(+a) + ' out of ' + words(+b));
  // 10x, 1st and 21st, the 1920s, 10,000 and 1,00,000, 2.5, 1987, and every other number
  t = t.replace(/\b(\d+)x\b/g, (_, n) => words(+n) + ' times')
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, (_, n) => ordinal(+n))
    .replace(/\b(1[1-9]\d0|20\d0)s\b/g, (_, n) => plural(year(+n)))
    .replace(/\b\d{1,3}(?:,\d{2,3})+\b/g, n => words(+n.replace(/,/g, '')))
    .replace(/\b(\d+)\.(\d+)\b/g, (_, a, b) => words(+a) + ' point ' + b.split('').map(d => ONES[+d]).join(' '))
    .replace(/\b(1[1-9]\d\d|20\d\d)\b/g, (_, n) => year(+n))
    .replace(/\b\d+\b/g, n => words(+n));
  t = t.replace(/\b(\w+) km\b/g, '$1 kilometres').replace(/\b(\w+) kgs?\b/g, '$1 kilos').replace(/\bhrs\b/g, 'hours').replace(/\bmins\b/g, 'minutes');
  // initialisms however they are written (SIP, S.I.P., S. I. P., EMIs, OKRs, BSc), each spelled the same way
  t = t.replace(/\b[A-Z]\.(?:\s?[A-Z]\.)+(?=\s|$|[,;:!?'"])/g, (m, off, str) => m.replace(/[.\s]/g, '') + (/^(\s+["A-Z]|\s*$)/.test(str.slice(off + m.length)) ? '.' : ''));
  t = t.replace(/\b(BSc|BCom|MSc|PhD|BTech|MTech)\b/g, m => MIXED[m]);
  t = t.replace(/\b([A-Z]{2,6})(s?)\b/g, (m, caps, s) => {
    if (AS_WORD[caps]) return AS_WORD[caps] + s;
    if (caps === 'AM' || caps === 'PM') return caps[0] === 'A' ? AMW : PMW;
    return spell(caps, mode) + (s ? (mode === 'names' ? 's' : "'s") : '');
  });
  // "a S. I. P." → "an S. I. P.", "a 8-year-old" → "an eight-year-old"
  t = t.replace(/\b([Aa]) (?=(?:[AEFHILMNORSX]\.|eight\b|eight-|eleven|eighteen|eighty|(?:ay|ee|eff|aitch|eye|el|em|en|oh|ar|ess|ex)\b))/g, '$1n ');
  return t.replace(/[ \t]+/g, ' ').replace(/ ([,.!?;:])/g, '$1').replace(/,(\s*,)+/g, ',').replace(/\.(\s*\.)+(?!\.)/g, '.');
}

// what a take is checked against (record.py): letters spelled out, and every number as digits, so the way Whisper
// happens to write a number never counts as a misreading ("seven ten" = "710" = "7:10", "five thirty" = "5.30",
// "nineteen eighty-seven" = "1987"; the check ignores spaces)
const NUMW = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { hundred: 100, thousand: 1e3, lakh: 1e5, million: 1e6, crore: 1e7, billion: 1e9 };
function toDigits(t) {
  const toks = String(t).split(/(\s+|-)/); const out = []; let total = 0, cur = null, last = '', gap = '';
  const flush = () => { if (cur !== null || total) out.push(String(total + (cur || 0))); out.push(gap); gap = ''; total = 0; cur = null; last = ''; };
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i]; if (/^(\s+|-)$/.test(raw)) { if (cur === null && !total) out.push(raw); else gap = raw; continue; }
    // "a hundred", "a thousand"
    if (/^a$/i.test(raw) && cur === null && !total) { let j = i + 1; while (j < toks.length && /^(\s+|-)$/.test(toks[j])) j++; if (j < toks.length && SCALE[toks[j].toLowerCase()]) { cur = 1; last = 'unit'; continue; } }
    const m = /^([A-Za-z']+)([^A-Za-z']*)$/.exec(raw); const w = m ? m[1].toLowerCase() : '', tail = m ? m[2] : raw;
    const nextNum = () => { for (let j = i + 1; j < toks.length; j++) { if (/^(\s+|-)$/.test(toks[j])) continue; return NUMW[(toks[j].match(/^[A-Za-z]+/) || [''])[0].toLowerCase()] != null; } return false; };
    if (m && NUMW[w] != null && !(w === 'oh' && cur === null && !total)) {
      const v = NUMW[w], open = cur !== null || total;
      const joins = open && (last === 'hundred' || last === 'scale' || last === 'and' || (last === 'tens' && v < 10));
      if (!joins) { if (open) out.push(String(total + (cur || 0)), gap || ' '); gap = ''; total = 0; cur = v; } else { cur = (cur || 0) + v; gap = ''; }
      last = v >= 20 && v % 10 === 0 ? 'tens' : 'unit';
    } else if (m && SCALE[w] && (cur !== null || total)) {
      gap = '';
      if (w === 'hundred') { cur = (cur || 1) * 100; last = 'hundred'; } else { total += (cur || 1) * SCALE[w]; cur = 0; last = 'scale'; }
    } else if (w === 'and' && (last === 'hundred' || last === 'scale') && nextNum()) { last = 'and'; gap = ''; continue; }
    else { flush(); out.push(raw); continue; }
    if (tail) { flush(); out.push(tail); }
  }
  flush();
  return out.join('').replace(/[ \t]+/g, ' ');
}
// British and American spellings are the same word to the ear (Whisper writes "kilometers", "realize", "color")
const sameSpelling = t => t.replace(/\bpractis/gi, 'practic').replace(/\b(\w{3,})our(s?)\b/gi, '$1or$2').replace(/\b(\w{2,})is(e|ed|es|ing|ation|ations)\b/gi, '$1iz$2')
  .replace(/\b(\w{2,})tre(s?)\b/gi, '$1ter$2').replace(/\b(\w{2,}[aeiou])ll(ed|ing|er|ers)\b/gi, '$1l$2')
  .replace(/\binstalment/gi, 'installment').replace(/\bprogramme/gi, 'program').replace(/\bjeweller/gi, 'jeweler');
const check = t => sameSpelling(toDigits(spoken(t, { letters: 'names' })));

module.exports = { spoken, check, toDigits, words, year, ordinal, clock };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--lines') {
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', l => { let s = ''; try { s = JSON.parse(l); } catch (e) { s = l; } process.stdout.write(JSON.stringify(a[1] === 'check' ? check(s) : spoken(s, { letters: a[1] || 'names' })) + '\n'); });
  } else {
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { s += d; }).on('end', () => process.stdout.write(spoken(s, { letters: a[0] || 'dots' })));
  }
}
