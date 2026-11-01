# Scores every recorded voice the same way:
#   MOS   - UTMOS22 (strong), a predictor of the 1-5 naturalness score listeners give (English-trained)
#   CER   - character error rate of a Whisper transcript against the text (did it say every word, clearly?)
#   F0    - median pitch (Hz): a deep male narrator sits near 90-130
#   WPM   - words per minute
#   RTF   - seconds of compute per second of audio on a 4-vCPU runner
#   python score.py <dir with */meta.jsonl and wavs>
import glob, json, os, re, sys, unicodedata
import numpy as np
import librosa, torch

root = sys.argv[1]
rows = []
for mf in glob.glob(os.path.join(root, '**', 'meta.jsonl'), recursive=True):
    d = os.path.dirname(mf)
    for line in open(mf, encoding='utf-8'):
        m = json.loads(line); m['wav'] = os.path.join(d, m['name'] + '.wav'); rows.append(m)
print('voices:', len(rows), flush=True)

mos = torch.hub.load('tarepan/SpeechMOS:v1.2.0', 'utmos22_strong', trust_repo=True)
from faster_whisper import WhisperModel
asr = {'en': WhisperModel('small', device='cpu', compute_type='int8'), 'hi': WhisperModel('medium', device='cpu', compute_type='int8')}

def norm(t, lang):
    t = unicodedata.normalize('NFC', t.lower())
    t = re.sub(r"[^\w\s]", ' ', t) if lang == 'en' else re.sub(r'[।,.!?;:"\'()\-–—…]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def cer(ref, hyp):
    a, b = ref.replace(' ', ''), hyp.replace(' ', '')
    if not a: return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1] / len(a)

out = []
for m in rows:
    try:
        y, sr = librosa.load(m['wav'], sr=16000, mono=True)
        # MOS on 10 s windows, averaged (the predictor is trained on short clips)
        win = 16000 * 10; scores = []
        for s in range(0, max(1, len(y) - 16000 * 3), win):
            seg = y[s:s + win]
            if len(seg) < 16000 * 3: break
            with torch.no_grad(): scores.append(float(mos(torch.from_numpy(seg).unsqueeze(0), 16000)))
        segs, _ = asr[m['lang']].transcribe(m['wav'], language=m['lang'], beam_size=5)
        hyp = ' '.join(s.text for s in segs)
        c = cer(norm(m['text'], m['lang']), norm(hyp, m['lang']))
        f0, vf, _ = librosa.pyin(y, fmin=60, fmax=400, sr=16000, frame_length=1024)
        f0m = float(np.nanmedian(f0[vf])) if np.any(vf) else 0.0
        semis = float(np.nanstd(12 * np.log2(f0[vf] / f0m))) if np.any(vf) and f0m else 0.0
        words = len(m['text'].split())
        r = dict(name=m['name'], lang=m['lang'], voice=m['voice'], mos=round(float(np.mean(scores)), 2) if scores else 0, cer=round(c * 100, 1),
                 f0=round(f0m), semis=round(semis, 1), wpm=round(words / (m['secs_audio'] / 60)), rtf=round(m['secs_compute'] / m['secs_audio'], 2), secs=m['secs_audio'])
        out.append(r)
        print('SCORE', json.dumps(r, ensure_ascii=False), flush=True)
        if r['cer'] > 8: print('  heard:', hyp[:400], flush=True)
    except Exception as e:
        print('SCORE-FAIL', m['name'], repr(e)[:300], flush=True)

print('\n==== RESULTS (higher MOS better; lower CER better) ====')
for lang in ('en', 'hi'):
    for r in sorted([r for r in out if r['lang'] == lang], key=lambda r: -r['mos']):
        print('RESULT %-3s %-18s MOS %.2f  CER %5.1f%%  F0 %3d Hz  pitch±%.1f st  %3d wpm  RTF %.2f  (%s)' % (lang, r['name'], r['mos'], r['cer'], r['f0'], r['semis'], r['wpm'], r['rtf'], r['voice']))
