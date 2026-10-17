# Оплот мудрости, ночь: стеклянные полосы между пилястрами горят сплошными окнами (каждая полоса яруса —
# своё окно), свет офисный — больше белого и холодного; циферблаты светятся изнутри, стрелки остаются
# тёмными; на игле шпиля красный заградительный огонь.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, win_layer, shaded, H

FACES = [(285, 713, 50, 62), (470, 713, 50, 62)]  # циферблаты: центр и полуоси в кадре 753×1495


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    sol = a > 200; mx = rgb.max(-1); mn = rgb.min(-1)
    glass = nd.binary_opening(sol & (b > r + 35) & (g > r + 25) & (Y > 820), np.ones((3, 2)))
    lab, k = nd.label(glass)
    gr = np.array([0] + [int(H('wsc', i) * 1e6) % 8 for i in range(1, k + 1)])
    tn = np.array([0] + [0 if H('wsct', i) < 0.3 else (1 if H('wsct', i) < 0.72 else 2) for i in range(1, k + 1)])
    win = win_layer(a.shape, [(lab > 0, gr[lab], tn[lab], 170)])
    disc = np.zeros(a.shape, bool); hands = np.zeros(a.shape, bool); face = np.zeros(a.shape, bool)
    for cx, cy, rx, ry in FACES:
        e = ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1
        disc |= e; face |= e & sol & (mx - mn < 22) & (L > 110); hands |= e & sol & (L <= 110)
    face = nd.binary_fill_holes(face | hands) & disc & ~hands
    em = halo(shaded(face, (235, 245, 255), L, lo=0.75, k=0.95), [(0.5, 3), (0.3, 10), (0.15, 24)])
    # верхний ярус (арки над часами, малые купола, кровля вокруг купола) в мягком тёплом свете прожекторов
    # снизу, стеклянный купол светится изнутри неярко и холодно
    top = sol & (Y > 330) & (Y < 1010) & ~disc & ~(b > r + 15) & ~nd.binary_dilation(glass, iterations=1)
    f = (1 - 0.55 * np.clip((900 - Y) / 570, 0, 1)) * np.clip((1010 - Y) / 110, 0, 1)
    em += shaded(top, (255, 222, 175), L, lo=0.4, k=0.36) * f[..., None]
    dome = sol & (b > r + 15) & (Y > 360) & (Y < 560) & (mx - mn > 18)
    em += halo(shaded(dome, (200, 225, 255), L, lo=0.45, k=0.35), [(0.3, 4)])
    nd_ = np.zeros(a.shape + (3,)); bulb(nd_, X, Y, 376, 6, 4.5, (255, 60, 50))
    return win, em + halo(nd_, [(0.8, 3), (0.4, 9)])
