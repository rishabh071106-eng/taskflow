// v37: the Hindi lessons (owner, 7 Nov: "complete the package by recording hindi version of these lessons and complete
// all books"). Every lesson's words (app/bookfull.js lesson(): the cards' text, the hero) are written once in natural
// spoken Hindi and kept in app/lessons-hi/<id>.json, the same shape as the English source; app/bookfull.js lessonHi()
// builds the Hindi lesson from it (its narration with Hindi joins: "पहला विचार।", "रुकिए और सोचिए।" …) and
// modules/bookeleven.js records it ("lesson-hi-<id>"). A Hindi file carries the hash of the English it was written from
// (`src`): when the English lesson changes, the Hindi one is stale and is neither shown nor recorded until rewritten.
//   node scripts/lessons/hi.js extract <dir> [ids…]   → <dir>/<id>.json: the English to write in Hindi (same shape)
//   node scripts/lessons/hi.js check [ids…]           → the problems in app/lessons-hi (exit 1 if any)
//   node scripts/lessons/hi.js stamp [ids…]           → set `src` in each Hindi file that passes; index.json lists them all
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const HI = path.join(ROOT, 'app', 'lessons-hi');
const { lesson } = require(path.join(ROOT, 'app', 'bookfull.js'));

function books() {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(s);
  return vm.runInNewContext('(' + m[1].replace(/\\\\/g, '\\') + ')', {}, { timeout: 5000 });
}
const ideasOf = id => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'ideas', id + '.json'), 'utf8')); } catch (e) { return null; } };

// the English words of a lesson, card by card, in the shape the Hindi file keeps
function extract(l) {
  const cards = l.cards.map(c => {
    switch (c.kind) {
      case 'cover': return { k: 'cover', why: c.why };
      case 'meet': return { k: 'meet', text: c.text };
      case 'idea': return { k: 'idea', n: c.n, title: c.title, body: c.body };
      case 'story': return { k: 'story', n: c.n, h: c.h, story: c.story };
      case 'lesson': return { k: 'lesson', n: c.n, think: c.think ? { q: c.think.q, o: c.think.o.slice(), a: c.think.a, why: c.think.why } : null, take: c.take || '', tryIt: c.tryIt || '' };
      case 'ending': return { k: 'ending', h: c.h, story: c.story, take: c.take || '', bro: c.bro || '' };
      case 'end': return { k: 'end', recap: (c.recap || []).slice(), week: (c.week || []).map(w => ({ day: w.day, tryIt: w.tryIt })) };
      default: return { k: c.kind };
    }
  });
  const meetCard = l.cards.find(c => c.kind === 'meet');
  const meet = meetCard ? meetCard.say.slice(0, meetCard.say.length - String(meetCard.text || '').length).trim() : '';
  return { id: l.base, title: l.title, author: l.author, hero: { name: l.hero.name, who: l.hero.who, meet }, cards };
}
const srcHash = src => crypto.createHash('sha256').update(JSON.stringify({ hero: src.hero, cards: src.cards })).digest('hex').slice(0, 16);

const deva = t => (String(t || '').match(/[ऀ-ॿ]/g) || []).length;
const letters = t => (String(t || '').match(/[A-Za-zऀ-ॿ]/g) || []).length;
const ratio = t => { const n = letters(t); return n ? deva(t) / n : 0; };

// what is wrong with a Hindi file, against its English source (an empty list: it is good)
function check(src, hi) {
  const bad = []; const say = (where, msg) => bad.push(where + ': ' + msg);
  if (!hi || typeof hi !== 'object') return ['not a JSON object'];
  if (hi.id !== src.id) say('id', 'must be "' + src.id + '"');
  const str = (where, en, t, min) => {
    if (typeof t !== 'string' || !t.trim()) return say(where, 'missing');
    if (/[0-9]/.test(t)) say(where, 'has digits: write numbers, times and amounts in Hindi words');
    if (ratio(t) < (min == null ? 0.6 : min)) say(where, 'must be Hindi in Devanagari (' + Math.round(ratio(t) * 100) + '% Devanagari)');
    const r = t.length / Math.max(1, String(en || '').length);
    if (en && en.length > 40 && (r < 0.55 || r > 2.1)) say(where, 'length ' + t.length + ' vs English ' + en.length + ': translate all of it, add nothing');
    if (/[*#_[\]{}<>]/.test(t)) say(where, 'no markup characters');
  };
  const h = hi.hero || {};
  str('hero.name', src.hero.name, h.name, 0.95); str('hero.who', src.hero.who, h.who); str('hero.meet', src.hero.meet, h.meet);
  if (h.name && h.meet && !h.meet.includes(h.name)) say('hero.meet', 'must name the hero (' + h.name + ')');
  if (!Array.isArray(hi.cards) || hi.cards.length !== src.cards.length) { say('cards', 'must be ' + src.cards.length + ' cards'); return bad; }
  let named = 0;
  src.cards.forEach((e, i) => {
    const c = hi.cards[i] || {}, w = 'cards[' + i + '] (' + e.k + (e.n ? ' ' + e.n : '') + ')';
    if (c.k !== e.k) return say(w, 'k must be "' + e.k + '"');
    if (e.n != null && c.n !== e.n) say(w, 'n must be ' + e.n);
    for (const f of ['why', 'text', 'body', 'h', 'story', 'take', 'tryIt', 'bro']) if (e[f] != null && e[f] !== '') str(w + '.' + f, e[f], c[f]);
    if (e.title != null) str(w + '.title', e.title, c.title, 0.4);
    if (e.k === 'lesson') {
      if (!!e.think !== !!c.think) say(w, 'think must be ' + (e.think ? 'there' : 'null'));
      else if (e.think) {
        str(w + '.think.q', e.think.q, c.think.q); str(w + '.think.why', e.think.why, c.think.why);
        if (!Array.isArray(c.think.o) || c.think.o.length !== e.think.o.length) say(w, 'think.o must have ' + e.think.o.length + ' choices');
        else e.think.o.forEach((o, k) => str(w + '.think.o[' + k + ']', o, c.think.o[k]));
        if (c.think.a !== e.think.a) say(w, 'think.a must stay ' + e.think.a + ' (the same best choice)');
      }
    }
    if (e.k === 'end') {
      if (!Array.isArray(c.recap) || c.recap.length !== e.recap.length) say(w, 'recap must have ' + e.recap.length + ' items'); else e.recap.forEach((x, k) => str(w + '.recap[' + k + ']', x, c.recap[k], 0.4));
      if (!Array.isArray(c.week) || c.week.length !== e.week.length) say(w, 'week must have ' + e.week.length + ' days'); else e.week.forEach((x, k) => { str(w + '.week[' + k + '].day', x.day, (c.week[k] || {}).day, 0.95); str(w + '.week[' + k + '].tryIt', x.tryIt, (c.week[k] || {}).tryIt); });
    }
    if ((e.k === 'story' || e.k === 'ending' || e.k === 'meet') && h.name && String(c.story || c.text || '').includes(h.name)) named++;
  });
  if (h.name && named < 4) say('hero.name', '"' + h.name + '" should be the hero\'s name in the stories too (found in ' + named + ' of 7)');
  return bad;
}

function sources(ids) {
  const want = new Set(ids || []); const out = [];
  for (const b of books()) {
    if (want.size && !want.has(b.id)) continue;
    const j = ideasOf(b.id); if (!j) continue;
    const l = lesson(b, j); if (l) out.push(extract(l));
  }
  return out;
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'extract') {
    const dir = args.shift(); fs.mkdirSync(dir, { recursive: true });
    for (const s of sources(args)) fs.writeFileSync(path.join(dir, s.id + '.json'), JSON.stringify(s, null, 1));
    console.log('wrote', fs.readdirSync(dir).length, 'sources to', dir);
  } else if (cmd === 'check' || cmd === 'stamp') {
    let n = 0, good = 0; const index = { ids: [], heroes: {} };
    for (const s of sources(args)) {
      const f = path.join(HI, s.id + '.json'); if (!fs.existsSync(f)) continue; n++;
      let hi; try { hi = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(s.id + ': not JSON (' + e.message + ')'); continue; }
      const bad = check(s, hi);
      if (cmd === 'check' && hi.src && hi.src !== srcHash(s)) bad.push('src: written from an older English lesson (stale)');
      if (bad.length) { console.log(s.id + ':\n  ' + bad.slice(0, 25).join('\n  ')); continue; }
      good++;
      if (cmd === 'stamp') { hi.src = srcHash(s); fs.writeFileSync(f, JSON.stringify(hi)); }
      index.ids.push(s.id); index.heroes[s.id] = hi.hero.name;
    }
    // the index lists every Hindi lesson that is good and written from today's English (all of them, not just these ids)
    if (cmd === 'stamp') {
      const all = { ids: [], heroes: {} };
      for (const t of sources()) { const f = path.join(HI, t.id + '.json'); if (!fs.existsSync(f)) continue; let hi; try { hi = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; } if (hi.src === srcHash(t) && !check(t, hi).length) { all.ids.push(t.id); all.heroes[t.id] = hi.hero.name; } }
      fs.writeFileSync(path.join(HI, 'index.json'), JSON.stringify(all));
      console.log('index:', all.ids.length, 'Hindi lessons');
    }
    console.log(good + ' of ' + n + ' Hindi lessons are good');
    process.exit(good === n ? 0 : 1);
  } else { console.log('usage: hi.js extract <dir> [ids…] | check [ids…] | stamp [ids…]'); process.exit(2); }
}
module.exports = { extract, check, srcHash, sources, ratio };
