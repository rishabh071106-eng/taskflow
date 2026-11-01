# Records Bro's book notes with the studio narration voice (GitHub Actions, CPU; see .github/workflows/book-voice.yml and
# voice/voice.json):
#   python record.py ref <voice_dir> <out.wav>                          Bro's voice sample (Kokoro) the English model follows
#   python record.py en|hi <todo.json> <shard> <shards> <out_dir> <voice_dir> [ref.wav]
# English: Chatterbox (MIT) speaking in the timbre of Bro's own voice sample, with calm narration settings.
# Hindi: Kokoro-82M (Apache-2.0), Bro's Hindi blend.
# Unlike the server's live engine (which cuts a sentence into ~60-character pieces so a call never waits), each note is read
# a sentence group at a time (<= 260 characters), so the intonation runs through whole sentences. Every English take is
# checked (its length for its text, and a Whisper transcript against the text) and read again with a new seed when it is
# off. Takes are joined with natural pauses (0.32 s, 0.9 s between paragraphs), loudness-normalised (-18 LUFS) and encoded
# to 64 kbps mono mp3. Writes <out_dir>/<id>-<hash>.mp3 and <out_dir>/items.jsonl.
import hashlib, json, os, re, subprocess, sys, time, unicodedata
import numpy as np
import soundfile as sf
import torch

torch.set_num_threads(os.cpu_count() or 4)

def kokoro_say(lang_code, spec, speed):
    from kokoro import KPipeline
    pipe = KPipeline(lang_code=lang_code)
    v = None
    for part in spec.split('+'):
        n, w = (part.split(':') + ['1'])[:2]
        t = pipe.load_single_voice(n) * float(w)
        v = t if v is None else v + t
    def say(text):
        a = [r.audio.numpy() for r in pipe(text, voice=v, speed=speed) if r.audio is not None]
        return np.concatenate(a) if a else np.zeros(1, dtype=np.float32)
    return say, 24000

if sys.argv[1] == 'ref':
    voice_dir, out_wav = sys.argv[2], sys.argv[3]
    R = json.load(open(os.path.join(voice_dir, 'voice.json')))['ref']
    say, sr = kokoro_say('a', R['voice'], R.get('speed', 1.0))
    a = say(R['text']); sf.write(out_wav, a / (float(np.max(np.abs(a))) or 1) * 0.89, sr)
    print('reference clip', out_wav, round(len(a) / sr, 1), 's'); sys.exit(0)

lang, todo_file, shard, shards, out, voice_dir = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
ref = sys.argv[7] if len(sys.argv) > 7 else None
os.makedirs(out, exist_ok=True)
todo = [n for n in json.load(open(todo_file, encoding='utf-8')) if n['lang'] == lang]
todo = [n for i, n in enumerate(todo) if i % shards == shard]
print(lang, 'shard', shard, 'of', shards, ':', len(todo), 'notes', flush=True)
if not todo: sys.exit(0)
CFG = json.load(open(os.path.join(voice_dir, 'voice.json')))[lang]

def chunks(p, limit=260):
    sents = [s for s in re.split(r'(?<=[.!?।])\s+', p.strip()) if s]
    outl, cur = [], ''
    for s in sents:
        if cur and len(cur) + 1 + len(s) > limit: outl.append(cur); cur = s
        else: cur = (cur + ' ' + s).strip()
    if cur: outl.append(cur)
    return outl

def norm(t):
    t = unicodedata.normalize('NFC', t.lower())
    return re.sub(r'\s+', ' ', re.sub(r"[^\w\s]", ' ', t)).strip()

def cer(ref_t, hyp):
    a, b = ref_t.replace(' ', ''), hyp.replace(' ', '')
    if not a: return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1): cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1] / len(a)

if CFG['engine'] == 'chatterbox':
    from chatterbox.tts import ChatterboxTTS
    m = ChatterboxTTS.from_pretrained(device='cpu')
    if ref: m.prepare_conditionals(ref, exaggeration=CFG.get('exaggeration', 0.5))
    SR = m.sr
    say = lambda t: m.generate(t, exaggeration=CFG.get('exaggeration', 0.5), cfg_weight=CFG.get('cfg', 0.5), temperature=CFG.get('temperature', 0.8)).squeeze(0).numpy()
    CHECK = True
else:
    say, SR = kokoro_say(CFG.get('lang_code', 'h'), CFG['voice'], CFG.get('speed', 1.0))
    CHECK = False  # Kokoro reads what it is given (no sampling), so there is nothing to retake

asr = None
def heard(wav):
    global asr
    if asr is None:
        from faster_whisper import WhisperModel
        asr = WhisperModel('small', device='cpu', compute_type='int8')
    import librosa
    y = librosa.resample(wav.astype(np.float32), orig_sr=SR, target_sr=16000) if SR != 16000 else wav.astype(np.float32)
    segs, _ = asr.transcribe(y, language=lang, beam_size=1)
    return ' '.join(s.text for s in segs)

def trim(a):
    import librosa
    _, (s, e) = librosa.effects.trim(a, top_db=38)
    pad = int(SR * 0.03)
    return a[max(0, s - pad):min(len(a), e + pad)]

# a natural read lands near 14 characters a second (English); outside 9-22 a take dropped or repeated words
CPS = {'en': (9.0, 22.0), 'hi': (6.0, 22.0)}
def take(text, seed0):
    best = None
    for k in range(3 if CHECK else 1):
        torch.manual_seed(seed0 + k * 7919); np.random.seed((seed0 + k) % 2**32)
        a = trim(np.asarray(say(text), dtype=np.float32).reshape(-1))
        cps = len(text) / max(0.1, len(a) / SR); lo, hi = CPS[lang]
        c = cer(norm(text), norm(heard(a))) if CHECK else 0.0
        score = c + (0 if lo <= cps <= hi else 0.5)
        if best is None or score < best[0]: best = (score, a, c)
        if lo <= cps <= hi and c <= 0.10: break
        print('  retake', k + 1, '(%.1f chars/s, %.0f%% heard wrong)' % (cps, c * 100), text[:70], flush=True)
    return best[1], best[2]

for n in todo:
    t0 = time.time(); parts = []; worst = 0.0
    paras = [p.strip() for p in re.split(r'\n\s*\n', n['text']) if p.strip()]
    seed = int(hashlib.sha1(n['id'].encode()).hexdigest()[:8], 16)
    for pi, p in enumerate(paras):
        cs = chunks(re.sub(r'\s+', ' ', p))
        for ci, c in enumerate(cs):
            a, ce = take(c, seed + pi * 101 + ci)
            worst = max(worst, ce)
            parts.append(a); parts.append(np.zeros(int(SR * (0.9 if ci == len(cs) - 1 else 0.32)), dtype=np.float32))
    if worst > 0.25:
        # a sentence group still read wrong after every retake: this note keeps Bro's voice until the next run
        print('SKIPPED', n['id'], '(a sentence group was %.0f%% wrong after every retake)' % (worst * 100), flush=True); continue
    a = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype=np.float32)
    a = a / (float(np.max(np.abs(a))) or 1.0) * 0.9
    wav = os.path.join(out, n['id'] + '.wav'); sf.write(wav, a, SR)
    name = '%s-%s.mp3' % (n['id'], n['hash']); mp3 = os.path.join(out, name)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', mp3], check=True)
    os.remove(wav)
    b = open(mp3, 'rb').read()
    it = {'id': n['id'], 'file': name, 'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'secs': round(len(a) / SR, 1), 'text': n['hash'], 'worst_cer': round(worst, 3)}
    with open(os.path.join(out, 'items.jsonl'), 'a') as f: f.write(json.dumps(it) + '\n')
    print('NOTE', n['id'], '%.0f s of audio in %.0f s' % (it['secs'], time.time() - t0), '· worst sentence group %.0f%% heard wrong' % (worst * 100), flush=True)
