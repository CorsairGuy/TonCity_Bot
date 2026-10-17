# Столичная Башня (город), ночь — вариант «Прожекторы и золото» (17.10.2026): белые плиты
# подсвечены снизу тёплым светом, по нижним кромкам плит золотой неон, окна-ленты между плитами,
# стеклянный атриум у основания горит янтарным, бассейн, фонари по кольцу площади.
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
    water = solid & (b > r + 40) & (Y > 480) & (X < 260)
    lawn = solid & (g > r + 8) & (g > b + 15) & ~((Y < 455) & (X > 270) & (X < 505))
    trees = solid & (g > r + 5) & (X < 290)
    # атриум: тёмные стёкла-ячейки между белыми рёбрами вокруг основания
    zone = solid & (ell(388, 522, 182, 72) < 1) & (Y > 440) & ~water & ~lawn
    dl, dn = nd.label(solid & (L < 70))
    atrium = np.zeros_like(solid)
    for i in range(1, dn + 1):
        m = dl == i; ys = Y[m]
        if 480 < ys.mean() < 580 and m.sum() > 15 and zone[m].mean() > 0.6: atrium |= m
    lobby = solid & (L < 60) & (Y > 565) & (Y < 620) & (X > 330) & (X < 450)  # проезд под башней: ночью тёмный
    atrium &= ~lobby
    # длинные тонкие полосы у основания — остекление низа башни, а не ячейки атриума
    al, an = nd.label(atrium)
    for i in range(1, an + 1):
        ys, xs = np.nonzero(al == i)
        if len(ys) < 30 or (xs.max() - xs.min() > 60 and ys.max() - ys.min() < 12): atrium[al == i] = False
    # верх атриума по колонкам: всё выше — башня
    ya = np.zeros(Ww)
    for x in range(Ww):
        ys = np.nonzero(atrium[:, x])[0]
        ya[x] = ys.min() - 1 if len(ys) else (455 if 245 < x < 535 else 0)
    ya = nd.maximum_filter1d(ya, 7)
    body = solid & (Y < ya[None, :]) & (X > 245) & (X < 535) & ~atrium & ~lawn & ~trees
    # окна — тонкие тёмные ленты между плитами (толстые тёмные пятна — тени у силуэта)
    near = nd.binary_dilation(a < 100, iterations=6)
    dk = body & (L < 75) & ~near
    thick = nd.binary_opening(dk, np.ones((10, 1)))
    gap = dk & ~thick
    # нижние ленты над атриумом горят всегда и целиком, вместе с бирюзовыми стёклами и до самого края
    teal = (b > r + 30) & (L < 120)
    bd = solid & (Y > 505) & (Y < 552) & (X > 272) & (X < 505) & ((L < 120) | teal)
    base_band = bd & ~nd.binary_opening(bd, np.ones((5, 1)))   # тонкие линии, ячейки атриума толще
    gap &= ~base_band
    # ленты вытянуты вдоль плит: короткие и вертикальные куски (тени, стойки перил) — не окна
    gl0, gn0 = nd.label(gap)
    for i, sl in enumerate(nd.find_objects(gl0)):
        hh = sl[0].stop - sl[0].start; ww = sl[1].stop - sl[1].start
        if ww < 2.5 * hh or ww < 8: gap[sl][gl0[sl] == i + 1] = False
    dn2 = lambda m, k: np.roll(m, -k, 0)
    lower = body & (Y < 470) & (L > 105) & (dn2(L < 75, 2) | dn2(L < 75, 1)) & ~gap & ~nd.binary_dilation(a < 100, iterations=2)

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
    um = body & ~gap & ~base_band
    w = np.exp(-np.clip((540 - Y) / 480, 0, 1) * 2.6)
    e[um] = np.array([255, 175, 80.])[None] * (0.42 * w[um] * (0.3 + 0.9 * L[um] / 230))[:, None]
    # золотой неон по нижним кромкам плит
    sh = np.clip(0.55 + 0.6 * L / 220, 0, 1.2) * 0.9
    e[lower] = np.maximum(e[lower], np.array([255, 196, 90.])[None] * sh[lower][:, None])
    t = np.clip((Y - 480) / 90, 0, 1)
    e[atrium] = np.array([255, 180, 90.])[None] * (1.0 - 0.45 * t[atrium])[:, None]
    # нижние ленты окон: ровный тёплый свет по всей длине, к краям чуть мягче
    e[base_band] = np.array([255, 205, 130.])[None] * (0.95 - 0.25 * (np.abs(X[base_band] - 388) / 125) ** 2)[:, None]
    e[water] = np.array([60, 190, 255.])[None] * (0.5 * (0.5 + 0.8 * L[water] / 255))[:, None]
    # фонари по внешнему кольцу площади, через равный угол
    for ang in np.linspace(0, 2 * np.pi, 28, endpoint=False):
        x = 380 + 236 * np.cos(ang); y = 606 + 142 * np.sin(ang)
        if y < 575: continue
        xi, yi = int(x), int(y)
        if 0 <= yi < Hh and 0 <= xi < Ww and solid[yi, xi] and not water[yi, xi]: bulb(e, X, Y, x, y, 2.6, (255, 210, 150))
    bulb(e, X, Y, 375, 30, 3.5)
    return win, halo(e, [(0.3, 2), (0.15, 7)])
