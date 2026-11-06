# Throwaway-branch only: listen to a published book recording the way a person would and say what is wrong with it.
#   python listen.py <mp3> <notes.json> <id>
# Whisper (medium.en, word timestamps) against the text the recording reads: every place the words differ, with the
# time in the recording; long silences; pace per chapter; loudness jumps (ffmpeg ebur128, short-term).
import json, re, subprocess, sys, difflib, statistics
from faster_whisper import WhisperModel

mp3, notes_file, nid = sys.argv[1], sys.argv[2], sys.argv[3]
text = next(n['text'] for n in json.load(open(notes_file, encoding='utf-8')) if n['id'] == nid)
tok = lambda s: re.findall(r"[a-z0-9']+", s.lower().replace('’', "'"))
ref = tok(text)
m = WhisperModel('medium.en', device='cpu', compute_type='int8')
segs, _ = m.transcribe(mp3, language='en', beam_size=5, word_timestamps=True, condition_on_previous_text=False)
hw = []
for s in segs:
    for w in s.words:
        for t in tok(w.word): hw.append((t, w.start, w.end, w.probability))
hyp = [w[0] for w in hw]
sm = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
bad = 0; out = []
for op, i1, i2, j1, j2 in sm.get_opcodes():
    if op == 'equal': continue
    bad += max(i2 - i1, j2 - j1)
    at = hw[min(j1, len(hw) - 1)][1] if hw else 0
    out.append('%5.0fs %-7s text: %-40s | heard: %s   (…%s)' % (at, op, ' '.join(ref[i1:i2])[:40], ' '.join(hyp[j1:j2])[:60], ' '.join(ref[max(0, i1 - 4):i1])))
print('== %s: %d words in the text, %d heard, %d differ (%.1f%%)' % (nid, len(ref), len(hyp), bad, 100.0 * bad / max(1, len(ref))))
for l in out: print(l)
gaps = [(hw[k][1] - hw[k - 1][2], hw[k - 1][2]) for k in range(1, len(hw))]
long = [g for g in gaps if g[0] > 1.6]
print('-- silences over 1.6 s:', len(long), ' '.join('%.1fs@%.0f' % g for g in long[:30]))
# pace per chapter: words per minute between the words "chapter"
ch = [k for k, w in enumerate(hw) if w[0] == 'chapter'] + [len(hw)]
for a, b in zip(ch, ch[1:]):
    if b - a > 20: print('-- pace from %.0fs: %.0f words/min' % (hw[a][1], 60.0 * (b - a) / max(1, hw[b - 1][2] - hw[a][1])))
lo = [w for w in hw if w[3] < 0.5]
print('-- words Whisper was unsure of (garbled sound):', len(lo), ' '.join('%s@%.0f' % (w[0], w[1]) for w in lo[:40]))
r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', mp3, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'], capture_output=True, text=True)
st = [(float(a), float(b)) for a, b in re.findall(r't:\s*([\d.]+)\s+TARGET.*?S:\s*(-?[\d.]+)', r.stderr)]
st = [x for x in st if x[1] > -40][::30]
if st:
    v = [x[1] for x in st]; med = statistics.median(v)
    print('-- short-term loudness: median %.1f LUFS, spread %.1f LU; 3 s windows over 5 LU from it: %s' % (med, statistics.pstdev(v), ' '.join('%.0fs(%+.0f)' % (t, l - med) for t, l in st if abs(l - med) > 5)[:600]))
