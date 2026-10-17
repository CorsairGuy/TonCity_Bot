# Общие помощники для зданий с ручной ночной отрисовкой (ov: "custom": "<модуль>").
# Модуль здания получает кадр в родном размере атласа и возвращает:
#   win  — RGBA uint8: A=255 на окнах, R — яркость стекла (0..255), G — группа квартиры (g*32+16),
#          B — тон света (t*80+40): как в night-win.png;
#   emit — RGB float: внешняя подсветка вместе с ореолом (складывается 'lighter').
import hashlib
import numpy as np
from scipy import ndimage as nd

NG = 8


def H(*k):
    return int(hashlib.md5(repr(k).encode()).hexdigest()[:8], 16) / 2 ** 32


def parts(im):
    rgb = im[..., :3]; a = im[..., 3]
    L = rgb @ [0.299, 0.587, 0.114]
    Hh, Ww = a.shape
    Y, X = np.mgrid[0:Hh, 0:Ww].astype(float)
    return rgb, a, L, Y, X


def blur(x, s):
    return np.stack([nd.gaussian_filter(x[..., i], s) for i in range(x.shape[-1])], -1)


def edge(m, n=2):
    return m & ~nd.binary_erosion(m, iterations=n)


def halo(e, rings):
    """Свет вместе с мягким ореолом: [(сила, сигма), …]."""
    out = e.copy()
    for k, s in rings: out += blur(e, s) * k
    return out


def bulb(e, X, Y, x, y, rad=4, c=(255, 60, 50)):
    m = np.hypot(X - x, Y - y) < rad
    e[m] = np.maximum(e[m], c)


def win_layer(shape, items):
    """items: [(маска, группа, тон, яркость стекла 0..255)] → RGBA окон; группа, тон и яркость — число
    или массив размера кадра."""
    w = np.zeros(shape + (4,), np.uint8)
    pick = lambda v, m: v[m] if np.ndim(v) else v
    for m, g, t, r in items:
        w[m, 0] = np.clip(pick(r, m), 0, 255)
        w[m, 1] = pick(g, m) * 32 + 16; w[m, 2] = pick(t, m) * 80 + 40; w[m, 3] = 255
    return w


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def shaded(m, c, L, lo=0.35, p=1.0, k=1.0):
    """Цвет c с рельефом исходника: яркость L растянута по области m, грани не сливаются в пятно."""
    if not m.any(): return np.zeros(m.shape + (3,))
    a, b = np.percentile(L[m], 3), np.percentile(L[m], 97)
    t = np.clip((L - a) / max(b - a, 1), 0, 1) ** p
    return np.where(m[..., None], np.array(c, float) * (lo + (1 - lo) * t)[..., None] * k, 0)


def lines(shape, pls, w=2.0, S=4):
    """Сплошные линии (полилинии) со сглаживанием: доля покрытия 0..1."""
    from PIL import Image, ImageDraw
    img = Image.new('L', (shape[1] * S, shape[0] * S), 0)
    d = ImageDraw.Draw(img)
    for pl in pls: d.line([(x * S, y * S) for x, y in pl], fill=255, width=max(1, int(w * S)), joint='curve')
    return np.asarray(img.resize((shape[1], shape[0]), Image.BOX)).astype(float) / 255


def padmask(rgb, a, Y):
    """Серая площадка клетки (204,204,204) в ромбе внизу кадра: на ней свет не рисуется."""
    h, w = a.shape
    X = np.arange(w)[None, :]
    dia = np.abs(X - w / 2) / (w / 2) + np.abs(Y - (h - w * 217 / 753)) / (w * 217 / 753) <= 1.01
    neutral = (rgb.max(-1) - rgb.min(-1) <= 2) & (np.abs(rgb.mean(-1) - 204) <= 3) & (a > 200) & dia
    return nd.binary_opening(neutral, np.ones((3, 3))) | (dia & (a <= 200))
