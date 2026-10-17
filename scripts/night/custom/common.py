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
    """items: [(маска, группа, тон, яркость стекла 0..255 — число или массив)] → RGBA окон."""
    w = np.zeros(shape + (4,), np.uint8)
    for m, g, t, r in items:
        w[m, 0] = np.clip(r[m] if np.ndim(r) else r, 0, 255)
        w[m, 1] = g * 32 + 16; w[m, 2] = t * 80 + 40; w[m, 3] = 255
    return w
