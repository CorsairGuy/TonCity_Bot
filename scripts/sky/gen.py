#!/usr/bin/env python3
# Генератор неба за картой (утверждённый макет sky-middle-2, 04.11.2026).
# Пишет в src/web/sprites/sky/: бесшовную плитку облаков (свет, тени облаков друг на друга, дымка
# глубины уже запечены), маски «что видно на каждом слое» для теней островов и размытые силуэты
# островов для этих теней. Все размеры — в мировых px карты (клетка TW=90).
# Запуск: python3 -I scripts/sky/gen.py  (нужны numpy и Pillow)
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'src/web/sprites/sky')
SPR = os.path.join(ROOT, 'src/web/sprites')
os.makedirs(OUT, exist_ok=True)

K = 434 / 753            # сплющивание изометрии: облака лежат в плоскости карты
N = 2048                 # плитка, текселей -> 32768 мировых px, повтор почти незаметен
TEX = 16                 # мировых px на тексель плитки -> плитка 16384 мировых px
MASK_N = 1024            # маски, текселей (тени островов всё равно размыты)
MW = 7.05                # мировых px на px макета (макет рисовался при TW=12.77)
LIGHT = np.array([0.5, 0.72])  # сдвиг тени на единицу глубины: свет слева сверху
# слои от ближнего к дальнему: глубина (px макета), порог, покрытие, seed, размер облака (px макета)
LAYERS = [(180, .56, 1.0, 71, 400), (520, .58, .95, 72, 300), (950, .57, .9, 73, 210)]
ZMAX = LAYERS[-1][0] + 500
SOFT, DOF = .18, 1.2
LIT, SHADE, SHCOL = (255, 255, 255), (196, 218, 228), (60, 104, 128)
BASE = (112, 176, 200)   # небо под облаками (середина градиента макета)
RECV, BASE_SH, HAZE, ISL_SH, CL_SH = .45, .4, .55, .9, .6
ISL_RECV, ISL_BASE = .75, .55  # тень острова плотнее облачной: остров непрозрачный

def tx(px):  # px макета -> тексели плитки
    return px * MW / TEX

def blur(a, r):
    if r < .4: return a
    # бесшовно: размываем плитку, окружённую копиями самой себя
    p = int(r * 3) + 1
    big = np.pad(a, p, mode='wrap')
    im = Image.fromarray(np.clip(big * 255, 0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(r))
    return np.asarray(im, dtype=float)[p:-p, p:-p] / 255

def shift(a, dx, dy):
    return np.roll(np.roll(a, int(round(dy)), 0), int(round(dx)), 1)

def vnoise(rng, cell):
    # периодический value noise: сетка кратна плитке, клетка сплющена по изометрии
    gx = max(2, round(N / cell)); gy = max(2, round(N / (cell * K)))
    g = rng.random((gy, gx)).astype('float32')
    t = np.tile(g, (3, 3))
    im = Image.fromarray(t, mode='F').resize((3 * N, 3 * N), Image.BICUBIC)
    return np.asarray(im, dtype=float)[N:2 * N, N:2 * N]

def fbm(seed, cell, oct):
    rng = np.random.default_rng(seed); acc = 0; amp = 1; tot = 0
    for _ in range(oct):
        acc = acc + vnoise(rng, cell) * amp; tot += amp; amp *= .5; cell /= 2
    return acc / tot

def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

dens = []
for z, th, cov, seed, sc in LAYERS:
    n = fbm(seed, tx(sc), 3) * .85 + fbm(seed + 500, tx(sc / 3), 3) * .15
    d = smooth(n, th, th + SOFT) * cov
    dens.append(blur(d, tx(DOF * (1 + z * .005))))

def occl(zr):  # тень облаков, лежащих выше глубины zr
    S = np.zeros((N, N))
    for (z, *_), d in zip(LAYERS, dens):
        if z >= zr: continue
        dz = zr - z
        S = 1 - (1 - S) * (1 - blur(shift(d, *(LIGHT * tx(dz))), tx(2 + dz * .025)) * CL_SH)
    return S

col = np.zeros((N, N, 3)) + np.array(BASE)
col = col * (1 - BASE_SH * occl(ZMAX)[..., None])
for (z, *_), d in reversed(list(zip(LAYERS, dens))):
    db = blur(d, tx(5))
    lit = np.clip(.55 + (db - shift(db, *(-LIGHT * tx(16)))) * 2.8, 0, 1)
    c = np.array(SHADE) * (1 - lit[..., None]) + np.array(LIT) * lit[..., None]
    S = occl(z)
    c = c * (1 - RECV * S[..., None]) + np.array(SHCOL) * RECV * S[..., None]
    h = z / ZMAX * HAZE
    c = c * (1 - h) + col * h
    col = col * (1 - d[..., None]) + c * d[..., None]
Image.fromarray(np.clip(col, 0, 255).astype('uint8')).save(os.path.join(OUT, 'tile.webp'), quality=88, method=6)

# маски видимости для теней островов: ближний слой виден весь, дальний — сквозь просветы ближних
masks, above = [], np.ones((N, N))
for (z, *_), d in zip(LAYERS, dens):
    masks.append(d * above * (1 - z / ZMAX * HAZE)); above = above * (1 - d)
masks.append(above)  # само небо
for i, m in enumerate(masks):
    a = Image.fromarray(np.clip(m * 255, 0, 255).astype('uint8')).resize((MASK_N, MASK_N), Image.BILINEAR)
    rgba = Image.new('RGBA', a.size, (0, 0, 0, 0)); rgba.putalpha(a)
    rgba.save(os.path.join(OUT, f'mask-{i}.webp'), quality=80, method=6)

# тени островов: силуэт картинки острова, размытый под каждую глубину
DEPTHS = [z for z, *_ in LAYERS] + [ZMAX]
SH_TEX = 8               # мировых px на пиксель тени
def island(name, atlas_dir, world_w, world_h):
    meta = json.load(open(os.path.join(atlas_dir, 'island.json')))
    img = Image.open(os.path.join(atlas_dir, meta['tiles'][0]['image'])).convert('RGBA')
    a = img.getchannel('A')
    w, h = max(1, round(world_w / SH_TEX)), max(1, round(world_h / SH_TEX))
    a = a.resize((w, h), Image.BOX)
    out = []
    for i, z in enumerate(DEPTHS):
        r = (2 + z * .028) * MW / SH_TEX
        pad = int(r * 3) + 2
        big = Image.new('L', (w + 2 * pad, h + 2 * pad), 0); big.paste(a, (pad, pad))
        big = big.filter(ImageFilter.GaussianBlur(r))
        rgba = Image.new('RGBA', big.size, (0, 0, 0, 0)); rgba.putalpha(big)
        fn = f'shadow-{name}-{i}.png'; rgba.save(os.path.join(OUT, fn), optimize=True)
        out.append({'file': fn, 'pad': pad * SH_TEX})
    return out

# размеры картинок островов в мировых px — как в cityIsland.ts (TW=90, TH=52)
TW, TH = 90, round(90 * 434 / 753)
main_meta = json.load(open(os.path.join(ROOT, 'src/web/client/src/data/main-island.json')))['meta']['sourceSize']
d1_meta = json.load(open(os.path.join(ROOT, 'src/web/client/src/data/d1-island.json')))['meta']['sourceSize']
main_w, main_h = main_meta['w'] * .851 * TW / (753 * .5), main_meta['h'] * .851 * TH / (434 * .5)
d1_w, d1_h = d1_meta['w'] * TW / 753, d1_meta['h'] * TH / 434
shadows = {'main': island('main', os.path.join(SPR, 'main-island'), main_w, main_h),
           'd1': island('d1', os.path.join(SPR, 'd1-island'), d1_w, d1_h)}

avg = col.reshape(-1, 3).mean(0)
cfg = {
    'tile': 'tile.webp', 'tileWorld': N * TEX,
    'masks': [f'mask-{i}.webp' for i in range(len(masks))], 'maskWorld': N * TEX,
    # тень острова на слое i: сдвиг (мировые px), цвет и сила; последний — само небо
    'layers': [{'dx': round(LIGHT[0] * z * MW), 'dy': round(LIGHT[1] * z * MW),
                'color': list(SHCOL) if i < len(LAYERS) else [0, 0, 0],
                'alpha': round((ISL_RECV if i < len(LAYERS) else ISL_BASE) * ISL_SH, 3)} for i, z in enumerate(DEPTHS)],
    'shadows': shadows,
    'avg': [round(v) for v in avg],
}
json.dump(cfg, open(os.path.join(OUT, 'sky.json'), 'w'), indent=1)
print('ok', OUT, cfg['avg'])
