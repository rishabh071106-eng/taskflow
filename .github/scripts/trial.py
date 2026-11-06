# Throwaway-branch only: how does the studio voice (Chatterbox, Bro's reference clip) read times, numbers and short
# forms written different ways, and which settings read real sentence groups most accurately? Whisper is the ear.
#   python trial.py forms <forms.json> <ref.wav>        each line: what Whisper heard, and how long it took to say
#   python trial.py groups <groups.json> <ref.wav> <exaggeration> <cfg> <temperature>
import json, re, sys, time, numpy as np, torch
from chatterbox.tts import ChatterboxTTS
from faster_whisper import WhisperModel
torch.set_num_threads(4)
mode, f, ref = sys.argv[1], sys.argv[2], sys.argv[3]
ex, cfg, temp = (float(x) for x in (sys.argv[4:7] if mode == 'groups' else ('0.4', '0.3', '0.8')))
m = ChatterboxTTS.from_pretrained(device='cpu'); m.prepare_conditionals(ref, exaggeration=ex)
asr = WhisperModel('medium.en', device='cpu', compute_type='int8')
import librosa
def heard(a):
    y = librosa.resample(a, orig_sr=m.sr, target_sr=16000)
    segs, _ = asr.transcribe(y, language='en', beam_size=5, word_timestamps=True, condition_on_previous_text=False)
    ws = [w for s in segs for w in s.words]
    return ''.join(w.word for w in ws).strip(), ws
def norm(t): return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9' ]", ' ', t.lower())).strip()
def cer(a, b):
    a, b = a.replace(' ', ''), b.replace(' ', '')
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1): cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1] / max(1, len(a))
import os
items = json.load(open(f))[int(os.environ.get('START', 0)):int(os.environ.get('END', 999))]
tot = []; secs = 0; chars = 0
for k, it in enumerate(items):
    text = it[1] if isinstance(it, list) else it
    for seed in ((11, 23) if mode == 'forms' else (5,)):
        torch.manual_seed(seed + k)
        t0 = time.time()
        a = m.generate(text, exaggeration=ex, cfg_weight=cfg, temperature=temp).squeeze(0).numpy().astype(np.float32)
        h, ws = heard(a)
        d = len(a) / m.sr
        if mode == 'forms':
            print('%-6s seed %d  %.1fs  SAID: %s\n                      HEARD: %s\n                      words: %s' % (it[0], seed, d, text, h, ' '.join('%s[%.2f]' % (w.word.strip(), w.end - w.start) for w in ws)), flush=True)
        else:
            c = cer(norm(text), norm(h)); tot.append(c); secs += d; chars += len(text)
            print('%.0f%% wrong  %.1f chars/s  (%.0fs to make)  %s\n      HEARD: %s' % (c * 100, len(text) / d, time.time() - t0, text[:90], h[:200]), flush=True)
if mode == 'groups':
    print('== settings exaggeration %s cfg %s temperature %s: mean %.1f%% wrong, worst %.0f%%, groups over 5%%: %d of %d, pace %.1f chars/s' % (ex, cfg, temp, 100 * sum(tot) / len(tot), 100 * max(tot), sum(c > 0.05 for c in tot), len(tot), chars / secs))
