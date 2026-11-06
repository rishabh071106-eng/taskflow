# The covers' PNGs (scripts/covers/render.js) as the WebP files the app serves: app/covers/<id>.webp (~25 KB each).
#   python scripts/covers/webp.py <png dir> <out dir>
import os, sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True); n = 0
for f in sorted(os.listdir(src)):
    if not f.endswith('.png'): continue
    Image.open(os.path.join(src, f)).convert('RGB').save(os.path.join(out, f[:-4] + '.webp'), 'WEBP', quality=86, method=6); n += 1
print('webp', n)
