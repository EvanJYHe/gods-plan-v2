import sys, os
import cv2
from PIL import Image, ImageFilter
import numpy as np
src, waterline_target = sys.argv[1], float(sys.argv[2])
WL = 568 / 1024           # waterline fraction in the ChatGPT original
bgr = cv2.fastNlMeansDenoisingColored(cv2.imread(src), None, 3, 3, 5, 15)   # strip the AI grain (bytes, no detail)
im = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
W = 2880
big = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
big = big.filter(ImageFilter.UnsharpMask(radius=1.4, percent=35, threshold=2))
# mist: the lake dissolves into white soon below the waterline, like Cluely's lower hero (orig px 585 -> 740)
k = W / 1536
arr = np.asarray(big).astype(np.float32)
y = np.arange(arr.shape[0], dtype=np.float32) / k
t = np.clip((y - 585) / (740 - 585), 0, 1); t = t * t * (3 - 2 * t)
arr = arr * (1 - t[:, None, None]) + np.array([250, 252, 255], np.float32) * t[:, None, None]
big = Image.fromarray(np.round(arr).astype(np.uint8))
H = round(WL * big.height / waterline_target)
a = np.asarray(big)
canvas = np.empty((H, W, 3), np.uint8)
canvas[:big.height] = a
canvas[big.height:] = np.round(a[-8:].reshape(-1, 3).mean(0)).astype(np.uint8)   # extend the white mist
out = Image.fromarray(canvas)
dst = '/Users/evanhe/repos/projects/gods-plan/public/media/'
for q in (84, 82, 80, 78):
    out.save(dst + 'hero-sky.jpg', quality=q, optimize=True, progressive=True)
    sz = os.path.getsize(dst + 'hero-sky.jpg')
    if sz < 400_000: break
half = out.resize((W // 2, round(H / 2)), Image.LANCZOS)
half.save(dst + 'hero-sky-1x.jpg', quality=85, optimize=True, progressive=True)
print('size', out.size, 'pad', H - big.height, 'q', q, 'bytes', sz, '1x', half.size, os.path.getsize(dst + 'hero-sky-1x.jpg'))
