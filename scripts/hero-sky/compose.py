import numpy as np
from PIL import Image, ImageFilter
W, H = 2880, 2200          # 1440 x 1100 css at 2x
S = 2                      # css -> px
m0 = np.load('/tmp/gpbg/mask.npy'); lum0 = np.load('/tmp/gpbg/lum.npy')
m0 = m0[380:]; lum0 = lum0[380:]
hz0, tipx0, tipy0 = m0.shape[0], 1187, 28
HZ = 520 * S               # horizon in output px
scale = (HZ - 305 * S) / (hz0 - tipy0)
TX = int(0.20 * W)        # CN Tower x

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
cy = yy / S
def ramp(stops, t):
    t = np.asarray(t); out = np.zeros(t.shape + (3,), np.float32)
    ys = [s[0] for s in stops]; cs = np.array([s[1] for s in stops], np.float32)
    for k in range(3): out[..., k] = np.interp(t, ys, cs[:, k])
    return out
sky = ramp([(0, (76, 142, 214)), (110, (92, 162, 222)), (300, (116, 182, 232)), (430, (148, 202, 240)), (500, (190, 222, 244)), (580, (222, 238, 249)), (760, (242, 247, 251)), (1100, (250, 252, 253))], cy)
# corners a touch lighter, like Cluely's
sky += (np.exp(-(((xx / W - 1.0) / 0.35) ** 2 + ((cy - 60) / 260) ** 2)) * 22)[..., None] * np.array([1, 0.8, 0.4])
sky += (np.exp(-(((xx / W - 0.0) / 0.25) ** 2 + ((cy - 120) / 260) ** 2)) * 16)[..., None] * np.array([1, 0.8, 0.4])
# sun: low on the right, bright disc and warm bloom along the horizon
SX, SY = 0.79 * W, 446 * S
r = np.hypot(xx - SX, (yy - SY)) / S
sky = sky + (np.exp(-(r / 95) ** 2) * 60 + np.exp(-(r / 260) ** 2) * 22)[..., None] * np.array([1, 0.93, 0.8])
band = 0.6 * np.exp(-((cy - 512) / 24) ** 2) * np.exp(-((xx - SX) / (0.5 * W)) ** 2)
sky = sky + (band * 40)[..., None] * np.array([1, 0.9, 0.7])
disc = np.clip((54 - r) / 2.5, 0, 1)
sky = sky * (1 - disc[..., None]) + disc[..., None] * np.array([255, 255, 253])
# soft wispy cloud streaks
rng = np.random.default_rng(7)
cl = np.zeros((H, W), np.float32)
for cx_, cy_, w_, h_, a_ in [(0.04, 40, 0.20, 70, 0.30), (0.97, 20, 0.22, 80, 0.32), (0.08, 330, 0.18, 30, 0.16), (0.58, 405, 0.30, 22, 0.14)]:
    cl += a_ * np.exp(-(((xx / W - cx_) / w_) ** 2 + ((cy - cy_) / h_) ** 2))
sky = sky + (np.clip(cl, 0, 0.6) * 255)[..., None] * 0.6 * (1 - sky / 300)

CLUELY = [  # rows y, columns x; screen RGB
    [(112, 156, 216), (74, 136, 211), (81, 148, 217), (90, 161, 219), (138, 189, 232)],
    [(117, 170, 222), (87, 157, 219), (95, 167, 223), (109, 177, 228), (147, 198, 234)],
    [(134, 188, 231), (106, 176, 228), (119, 185, 229), (139, 198, 233), (175, 215, 238)],
    [(167, 210, 238), (135, 196, 231), (155, 205, 231), (185, 222, 231), (211, 234, 241)],
    [(206, 231, 243), (215, 236, 243), (224, 241, 244), (233, 245, 244), (241, 248, 244)],
]
OURS = [
    [(115, 174, 227), (95, 154, 216), (86, 146, 211), (104, 164, 221), (124, 183, 231)],
    [(114, 178, 227), (102, 167, 221), (99, 164, 218), (112, 176, 227), (117, 182, 229)],
    [(117, 182, 229), (110, 175, 225), (108, 174, 224), (122, 187, 235), (121, 186, 231)],
    [(134, 197, 236), (124, 188, 232), (120, 185, 229), (143, 209, 250), (129, 194, 237)],
    [(141, 201, 236), (142, 202, 237), (144, 204, 239), (146, 206, 241), (147, 208, 243)],
]
# match Cluely's sky as Chrome shows it: ratio of Cluely's screen colour to ours, measured at 1440px on a 5 x 5 grid
# (x 40/360/720/1080/1400, y 20/120/220/320/420 css), interpolated over the sky. Deeper royal blue up top, deepest
# left of centre, near-white towards the horizon so the skyline stands out.
GX = np.array([40, 360, 720, 1080, 1400], np.float32) / 1440 * W
GY = np.array([20, 120, 220, 320, 420], np.float32) * S
cl_t = np.array(CLUELY, np.float32); ours_t = np.array(OURS, np.float32)
ratio = cl_t / ours_t
from scipy.ndimage import map_coordinates
gx = np.interp(xx[0], GX, np.arange(5)); gy = np.interp(yy[:, 0], GY, np.arange(5))
GXX, GYY = np.meshgrid(gx, gy)
for k in range(3):
    sky[..., k] *= map_coordinates(ratio[..., k], [GYY, GXX], order=1, mode='nearest')

def place(mask, lum, x_anchor, x_out, sc, hz_out):
    h, w = mask.shape
    nw, nh = int(w * sc), int(h * sc)
    mi = Image.fromarray((mask * 255).astype(np.uint8)).resize((nw, nh), Image.LANCZOS)
    li = Image.fromarray((lum * 255).astype(np.uint8)).resize((nw, nh), Image.LANCZOS)
    M = np.zeros((H, W), np.float32); L = np.zeros((H, W), np.float32)
    ox = int(x_out - x_anchor * sc); oy = hz_out - nh
    a = np.asarray(mi, np.float32) / 255; b = np.asarray(li, np.float32) / 255
    x0, x1 = max(0, ox), min(W, ox + nw)
    M[oy:hz_out, x0:x1] = a[:, x0 - ox:x1 - ox]; L[oy:hz_out, x0:x1] = b[:, x0 - ox:x1 - ox]
    return M, L

img = sky.copy()
# far layer: the eastern half of the skyline, mirrored, small and pale, so the horizon right of the city isn't bare
far = m0[:, 1320:2069][:, ::-1].copy(); farl = lum0[:, 1320:2069][:, ::-1]
Mf, _ = place(far, farl, 0, int(0.58 * W), scale * 0.5, HZ)
Mf = Mf * np.clip((xx - 0.58 * W) / (0.08 * W), 0, 1)
Mf = np.asarray(Image.fromarray((Mf * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5)), np.float32) / 255
farc = ramp([(450, (128, 180, 234)), (520, (200, 224, 242))], cy)
fa = 0.8 * (1 - np.clip(np.exp(-(r / 150) ** 2) * 1.3, 0, 1))
img = img * (1 - fa[..., None] * Mf[..., None]) + farc * (fa * Mf)[..., None]
# main layer: the real skyline
M, L = place(m0, lum0, tipx0, TX, scale, HZ)
M = M * np.clip((0.655 * W - xx) / (0.10 * W), 0, 1) ** 0.7
M = np.asarray(Image.fromarray((M * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
Ls = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.0)), np.float32) / 255
base = ramp([(260, (44, 100, 214)), (420, (54, 114, 220)), (490, (100, 158, 230)), (520, (196, 220, 240))], cy)
sel = M > 0.5
mu = Ls[sel].mean()
shade = 1 + 0.32 * (Ls - mu)
col = np.clip(base * shade[..., None], 0, 255)
# sunlit right edges (sun is to the right): lighten pixels whose right neighbour is sky
edge = np.clip(M - np.roll(M, -6, axis=1), 0, 1)
edge = np.asarray(Image.fromarray((edge * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)), np.float32) / 255
col = col + (edge * 95)[..., None] * np.array([1, 0.95, 0.85])
haze = np.clip(np.exp(-(r / 260) ** 2) * 0.85, 0, 0.85)[..., None]
col = col * (1 - haze) + sky * haze
img = img * (1 - M[..., None]) + col * M[..., None]
# nearer blocks of the city, Cluely-style: each ridge rises in front of the last and dissolves into white mist at
# its base, so the city carries on down beside the film and fades out instead of stopping at a horizon line
mist = ramp([(440, (222, 237, 249)), (760, (243, 248, 252)), (1000, (255, 255, 255))], cy)
def mistband(top, base, p=1.6):
    return np.clip((cy - top) / (base - top), 0, 1) ** p
img = img * (1 - mistband(440, 560)[..., None] * 0.8) + mist * (mistband(440, 560)[..., None] * 0.8)
soft = (np.exp(-((cy - 521) / 14) ** 2) * 0.55)[..., None]
img = img * (1 - soft) + mist * soft
# the near rows reuse the skyline without the CN Tower, mirrored, so no tower repeats
cut = lambda a: np.concatenate([a[:, 32:1150], a[:, 1230:2070]], axis=1)
tile = np.concatenate([cut(m0), cut(m0)[:, ::-1]], axis=1)
tilel = np.concatenate([cut(lum0), cut(lum0)[:, ::-1]], axis=1)
for sc, base_css, shift, top_c, edge_a, fade_top in [
    (scale * 1.35, 640, 0.31, (92, 150, 228), 70, 520),
    (scale * 1.9, 760, 0.62, (122, 172, 236), 60, 600),
    (scale * 2.3, 890, 0.12, (150, 192, 240), 50, 690),
]:
    Mn, Ln = place(tile, tilel, int(shift * tile.shape[1]), int(0.5 * W), sc, base_css * S)
    Mn = np.asarray(Image.fromarray((Mn * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.4)), np.float32) / 255
    Lns = np.asarray(Image.fromarray((Ln * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5)), np.float32) / 255
    sel = Mn > 0.5
    shade = 1 + 0.22 * (Lns - (Lns[sel].mean() if sel.any() else 0.5))
    coln = np.clip(np.array(top_c, np.float32) * shade[..., None], 0, 255)
    e = np.clip(Mn - np.roll(Mn, -8, axis=1), 0, 1)
    e = np.asarray(Image.fromarray((e * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5)), np.float32) / 255
    coln = coln + (e * edge_a)[..., None] * np.array([1, 0.96, 0.88])
    coln = coln * (1 - haze) + np.array([238, 246, 252]) * haze
    f = mistband(fade_top, base_css)[..., None]
    coln = coln * (1 - f) + mist * f
    img = img * (1 - Mn[..., None]) + coln * Mn[..., None]
    img = img * (1 - mistband(base_css - 60, base_css + 20)[..., None] * 0.85) + mist * mistband(base_css - 60, base_css + 20)[..., None] * 0.85
# Chrome shows this untagged JPEG warmer and paler than its values; pull red down in the blues to land on Cluely's sky
rr = np.clip(img[..., 0], 0, 255)
img[..., 0] = rr * 0.76 + 0.24 * rr * (rr / 255) ** 3
img += rng.normal(0, 1.2, img.shape)
out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
import sys
if '--write' in sys.argv:
    out.save('/Users/evanhe/repos/projects/gods-plan/public/media/hero-sky.jpg', quality=84, optimize=True, progressive=True)
    out.resize((W // 2, H // 2), Image.LANCZOS).save('/Users/evanhe/repos/projects/gods-plan/public/media/hero-sky-1x.jpg', quality=82, optimize=True, progressive=True)
out.resize((1440, 1100)).save('/tmp/gpbg/preview2.jpg')
