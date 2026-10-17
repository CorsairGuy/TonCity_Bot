# Столичная Башня (город), ночь — вариант «Прожекторы и золото» (17.10.2026): белые плиты
# подсвечены снизу тёплым светом, по нижним кромкам плит золотой неон, окна-ленты между плитами,
# стеклянный атриум у основания горит янтарным, бассейн, вход, фонари по кольцу площади.
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, halo, bulb, win_layer, NG


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); mn = rgb.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    solid = a > 200
    Hh, Ww = a.shape
    ell = lambda cx, cy, rx, ry: ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2
    tower = solid & (Y < 455) & (X > 270) & (X < 505)
    water = solid & (b > r + 40) & (Y > 480) & (X < 260)
    lawn = solid & (g > r + 8) & (g > b + 15) & ~tower
    trees = solid & (g > r + 5) & (X < 290)
    # атриум: тёмные стёкла-ячейки между белыми рёбрами вокруг основания
    zone = solid & (ell(388, 522, 182, 72) < 1) & (Y > 440) & ~water & ~lawn
    dl, dn = nd.label(solid & (L < 70))
    atrium = np.zeros_like(solid)
    for i in range(1, dn + 1):
        m = dl == i; ys = Y[m]
        if 480 < ys.mean() < 580 and m.sum() > 15 and zone[m].mean() > 0.6: atrium |= m
    lobby = solid & (L < 60) & (Y > 565) & (Y < 620) & (X > 330) & (X < 450)
    atrium &= ~lobby
    # длинные тонкие полосы — остекление низа башни, а не ячейки атриума
    al, an = nd.label(atrium); base_glass = np.zeros_like(atrium)
    for i in range(1, an + 1):
        ys, xs = np.nonzero(al == i)
        if len(ys) < 30: atrium[al == i] = False
        elif xs.max() - xs.min() > 60 and ys.max() - ys.min() < 12: atrium[al == i] = False; base_glass |= al == i
    near = nd.binary_dilation(a < 100, iterations=6)
    gap = (tower & (L < 75) & ~atrium & (Y < 470) & ~near) | base_glass
    dn2 = lambda m, k: np.roll(m, -k, 0)
    lower = tower & (L > 105) & (dn2(L < 75, 2) | dn2(L < 75, 1)) & ~gap & (Y < 470) & ~nd.binary_dilation(a < 100, iterations=2)

    # окна: ленты между плитами, квартиры — куски ленты по 13 px
    gl, _ = nd.label(nd.binary_dilation(gap, iterations=1))
    gi = gl * 1000 + np.floor(X / 13).astype(int)
    items = []
    for v in np.unique(gi[gap]):
        if H('w', v) > 0.85: continue
        sel = gap & (gi == v)
        items.append((sel, int(H('g', v) * NG), 0 if H('t', v) < 0.6 else 1, 150))
    win = win_layer(a.shape, items)

    e = np.zeros_like(rgb)
    # подсветка снизу: всё, что выше верхней кромки атриума в своей колонке
    ya = np.zeros(Ww)
    for x in range(Ww):
        ys = np.nonzero(atrium[:, x])[0]
        ya[x] = ys.min() - 1 if len(ys) else (455 if 262 < x < 512 else 0)
    ya = nd.maximum_filter1d(ya, 7)
    um = solid & (Y < ya[None, :]) & (X > 262) & (X < 512) & ~gap & ~atrium & ~lawn & ~trees
    w = np.exp(-np.clip((540 - Y) / 480, 0, 1) * 2.6)
    e[um] = np.array([255, 175, 80.])[None] * (0.42 * w[um] * (0.3 + 0.9 * L[um] / 230))[:, None]
    # золотой неон по нижним кромкам плит
    sh = np.clip(0.55 + 0.6 * L / 220, 0, 1.2) * 0.9
    e[lower] = np.maximum(e[lower], np.array([255, 196, 90.])[None] * sh[lower][:, None])
    t = np.clip((Y - 480) / 90, 0, 1)
    e[atrium] = np.array([255, 180, 90.])[None] * (1.0 - 0.45 * t[atrium])[:, None]
    e[lobby] = np.array([255, 210, 150.])[None] * (0.6 + 0.4 * np.clip((Y[lobby] - 565) / 40, 0, 1))[:, None]
    e[water] = np.array([60, 190, 255.])[None] * (0.5 * (0.5 + 0.8 * L[water] / 255))[:, None]
    # фонари по внешнему кольцу площади, через равный угол
    for ang in np.linspace(0, 2 * np.pi, 28, endpoint=False):
        x = 380 + 236 * np.cos(ang); y = 606 + 142 * np.sin(ang)
        if y < 575: continue
        xi, yi = int(x), int(y)
        if 0 <= yi < Hh and 0 <= xi < Ww and solid[yi, xi] and not water[yi, xi]: bulb(e, X, Y, x, y, 2.6, (255, 210, 150))
    bulb(e, X, Y, 375, 30, 3.5)
    return win, halo(e, [(0.3, 2), (0.15, 7)])
