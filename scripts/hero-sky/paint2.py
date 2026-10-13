import numpy as np
from PIL import Image, ImageFilter
full = np.asarray(Image.open('/tmp/gp_still_full.png').convert('RGB')).astype(np.float32)
sky = np.asarray(Image.open('/tmp/gp_still_sky.png').convert('RGB')).astype(np.float32)
H0, W0, _ = full.shape
d = np.abs(full - sky).sum(axis=2)
m = (d > 20)
rows = m.mean(axis=1)
hz = next(y for y in range(300, H0) if rows[y] > 0.97)
print('hz', hz, rows[hz-5:hz+3])
m = m[:hz].astype(np.float32)
from PIL import ImageFilter as F
mi = Image.fromarray((m*255).astype(np.uint8)).filter(F.MinFilter(3)).filter(F.MaxFilter(3))
m = (np.asarray(mi) > 127).astype(np.float32)
keep = np.zeros_like(m)
for x in range(W0):
    c = m[:, x]; y = hz - 1; gap = 0; topy = hz
    while y > 0:
        if c[y] > 0: gap = 0; topy = y
        else:
            gap += 1
            if gap > 3: break
        y -= 1
    keep[topy:, x] = 1
m = keep
top = np.argmax(m > 0, axis=0)
print('tip', top.min(), 'tower x', np.where(top == top.min())[0])
np.save('/tmp/gpbg/mask.npy', m); np.save('/tmp/gpbg/lum.npy', full[:hz].mean(axis=2) / 255)
Image.fromarray((m * 255).astype(np.uint8)).resize((1200, hz // 2)).save('/tmp/gpbg/mask.png')
