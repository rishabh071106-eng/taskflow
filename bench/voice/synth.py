# Book-voice bench: one engine per call, the same passage for every voice.
#   python synth.py <engine> <out_dir> [ref_dir]
# engines: kokoro (today's Bro voice + reference clips), chatterbox, chatterbox-turbo, chatterbox-hi, parler
# Writes <out_dir>/<name>.wav and one JSON line per voice to <out_dir>/meta.jsonl:
#   {name, engine, voice, lang, text, secs_audio, secs_compute}
import json, os, re, sys, time
import numpy as np
import soundfile as sf

engine, out = sys.argv[1], sys.argv[2]
ref_dir = sys.argv[3] if len(sys.argv) > 3 else ''
os.makedirs(out, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
S = json.load(open(os.path.join(here, 'sample.json')))
EN = S['en']
HI = []
try:
    HI = json.load(open(os.path.join(ref_dir or out, 'hi.json')))['hi']
except Exception:
    pass

def chunks(p, limit=280):
    # sentences, joined while they fit under `limit` characters
    sents = re.split(r'(?<=[.!?।])\s+', p.strip())
    outl, cur = [], ''
    for s in sents:
        if cur and len(cur) + 1 + len(s) > limit:
            outl.append(cur); cur = s
        else:
            cur = (cur + ' ' + s).strip()
    if cur: outl.append(cur)
    return outl

def join(parts, sr, gap_s=0.25, para_s=0.7):
    # parts: list of (np.array, is_last_in_paragraph)
    bits = []
    for a, last in parts:
        bits.append(np.asarray(a, dtype=np.float32).reshape(-1))
        bits.append(np.zeros(int(sr * (para_s if last else gap_s)), dtype=np.float32))
    return np.concatenate(bits) if bits else np.zeros(1, dtype=np.float32)

def record(name, voice, lang, paras, sr, say):
    t0 = time.time(); parts = []
    for p in paras:
        cs = chunks(p)
        for i, c in enumerate(cs):
            parts.append((say(c), i == len(cs) - 1))
    secs = time.time() - t0
    a = join(parts, sr)
    peak = float(np.max(np.abs(a))) or 1.0
    a = a / peak * 0.89
    sf.write(os.path.join(out, name + '.wav'), a, sr)
    m = {'name': name, 'engine': engine, 'voice': voice, 'lang': lang, 'text': '\n\n'.join(paras), 'secs_audio': round(len(a) / sr, 2), 'secs_compute': round(secs, 2)}
    with open(os.path.join(out, 'meta.jsonl'), 'a') as f: f.write(json.dumps(m, ensure_ascii=False) + '\n')
    print('SYNTH', name, 'audio', m['secs_audio'], 's compute', m['secs_compute'], 's RTF', round(secs / max(0.1, m['secs_audio']), 2), flush=True)

REF_EN = ('Good evening. Today we look at one simple idea that can change a whole year. '
          'Small steps, taken every single day, add up to something you can be proud of.')

if engine == 'kokoro':
    import torch
    from kokoro import KPipeline
    en = KPipeline(lang_code='a')
    def blend(pipe, spec):
        t = None
        for part in spec.split('+'):
            n, w = (part.split(':') + ['1'])[:2]
            v = pipe.load_single_voice(n) * float(w)
            t = v if t is None else t + v
        return t
    def say_with(pipe, voice, speed):
        def f(text):
            a = [r.audio.numpy() if hasattr(r, 'audio') else r[2].numpy() for r in pipe(text, voice=voice, speed=speed)]
            return np.concatenate(a)
        return f
    bro = blend(en, 'am_fenrir:0.6+am_puck:0.4')
    # today's book notes: Bro's English blend at 1.08 x 0.97
    record('kokoro-bro-en', 'am_fenrir:0.6+am_puck:0.4 @1.05', 'en', EN, 24000, say_with(en, bro, 1.05))
    record('kokoro-michael-en', 'am_michael', 'en', EN, 24000, say_with(en, 'am_michael', 1.0))
    # reference clips for the cloning models (synthetic voices, Apache-2.0: no real person's voice is copied)
    for nm, v, sp in [('ref-bro', bro, 1.0), ('ref-michael', 'am_michael', 1.0), ('ref-fenrir', 'am_fenrir', 1.0)]:
        a = say_with(en, v, sp)(REF_EN); sf.write(os.path.join(out, nm + '.wav'), a / (np.max(np.abs(a)) or 1) * 0.89, 24000)
    if HI:
        hi = KPipeline(lang_code='h')
        hb = blend(hi, 'am_fenrir:0.45+am_puck:0.3+hm_psi:0.25')
        record('kokoro-bro-hi', 'Bro blend + hm_psi @1.01', 'hi', HI, 24000, say_with(hi, hb, 1.01))
        record('kokoro-omega-hi', 'hm_omega', 'hi', HI, 24000, say_with(hi, 'hm_omega', 1.0))

elif engine in ('chatterbox', 'chatterbox-turbo', 'chatterbox-hi'):
    import torch
    torch.set_num_threads(os.cpu_count() or 4)
    refs = {n: os.path.join(ref_dir, n + '.wav') for n in ('ref-bro', 'ref-michael', 'ref-fenrir')}
    if engine == 'chatterbox':
        from chatterbox.tts import ChatterboxTTS
        m = ChatterboxTTS.from_pretrained(device='cpu')
        def say(ref, ex=0.5, cfg=0.5):
            return lambda t: m.generate(t, audio_prompt_path=ref, exaggeration=ex, cfg_weight=cfg).squeeze(0).numpy()
        record('cb-default-en', 'built-in voice', 'en', EN, m.sr, say(None))
        record('cb-bro-en', 'ref-bro (Kokoro Bro blend)', 'en', EN, m.sr, say(refs['ref-bro']))
        record('cb-michael-en', 'ref-michael', 'en', EN, m.sr, say(refs['ref-michael']))
        record('cb-bro-narr-en', 'ref-bro, exaggeration 0.4 cfg 0.3', 'en', EN, m.sr, say(refs['ref-bro'], 0.4, 0.3))
    elif engine == 'chatterbox-turbo':
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        m = ChatterboxTurboTTS.from_pretrained(device='cpu')
        def say(ref):
            return lambda t: m.generate(t, audio_prompt_path=ref).squeeze(0).numpy()
        record('cbt-bro-en', 'turbo, ref-bro', 'en', EN, m.sr, say(refs['ref-bro']))
        record('cbt-michael-en', 'turbo, ref-michael', 'en', EN, m.sr, say(refs['ref-michael']))
    else:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        m = ChatterboxMultilingualTTS.from_pretrained(device='cpu')
        def say(ref, lang):
            return lambda t: m.generate(t, language_id=lang, audio_prompt_path=ref).squeeze(0).numpy()
        if HI:
            record('cbm-default-hi', 'multilingual built-in voice', 'hi', HI, m.sr, say(None, 'hi'))
            record('cbm-bro-hi', 'multilingual, ref-bro', 'hi', HI, m.sr, say(refs['ref-bro'], 'hi'))
        record('cbm-bro-en', 'multilingual, ref-bro', 'en', EN[:2], m.sr, say(refs['ref-bro'], 'en'))

elif engine == 'parler':
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer
    name = 'ai4bharat/indic-parler-tts'
    model = ParlerTTSForConditionalGeneration.from_pretrained(name)
    tok = AutoTokenizer.from_pretrained(name)
    dtok = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    sr = model.config.sampling_rate
    def say(speaker):
        desc = speaker + ' speaks in a warm, confident and friendly voice at a moderate pace, with natural expression. The recording is very clear, close-sounding, with no background noise.'
        d = dtok(desc, return_tensors='pt')
        def f(t):
            p = tok(t, return_tensors='pt')
            with torch.no_grad():
                g = model.generate(input_ids=d.input_ids, attention_mask=d.attention_mask, prompt_input_ids=p.input_ids, prompt_attention_mask=p.attention_mask)
            return g.cpu().numpy().squeeze()
        return f
    record('parler-thoma-en', 'Indic Parler, Thoma', 'en', EN[:2], sr, say('Thoma'))
    if HI:
        record('parler-rohit-hi', 'Indic Parler, Rohit', 'hi', HI, sr, say('Rohit'))
else:
    sys.exit('unknown engine ' + engine)
