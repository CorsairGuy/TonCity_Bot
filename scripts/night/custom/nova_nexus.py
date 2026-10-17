# Нова Нексус (все звёзды), ночь: в ядре между дисками стеклянные кольца этажей — горят сплошными
# кольцами, этаж целиком; на сетке между лентами — россыпь тёплых огоньков. Модель у всех звёзд одна
# (меняются только материалы), поэтому кольца и сетка находятся по базовому зданию и 2★, где стекло
# отличается от дисков по цвету надёжнее всего.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, win_layer, disk, padmask, H

GEO = ['RES_nova_nexus.png', 'RES_nova_nexus_2_star.png']
_geo = {}


def _rings(n, w):
    import gen
    im = np.asarray(gen.sprite(n, w)).astype(float)
    rgb, a, L, Y, X = parts(im); r, b = rgb[..., 0], rgb[..., 2]
    sol = a > 200; pad = padmask(rgb, a, Y)
    gl = sol & (b > r + 6) & (X > 290) & (X < 480) & (Y > 110) & (Y < 1480) & ~pad
    gl = nd.binary_closing(gl, np.ones((1, 13))) & sol  # блик на стекле — вертикальная полоска внутри кольца
    lab, k = nd.label(gl); m = np.zeros(a.shape, bool)
    for i, sl in enumerate(nd.find_objects(lab)):
        reg = lab[sl] == i + 1; w_ = sl[1].stop - sl[1].start; h_ = sl[0].stop - sl[0].start
        if reg.sum() >= 20 and w_ >= 10 and h_ <= w_ * 0.9: m[sl] |= reg
    big = nd.binary_opening(sol, disk(6)) & ~pad
    return m, big, pad


def geo(w):
    if w not in _geo:
        r0, _, _ = _rings(GEO[0], w); r2, big, pad = _rings(GEO[1], w)
        rings = r0 | r2
        X = np.arange(rings.shape[1])[None, :]
        # ядро — полоса вокруг колец, на сетку не залезает
        ys, xs = np.nonzero(rings)
        rows = np.unique(ys)
        lo = np.polyfit(rows, [xs[ys == y].min() for y in rows], 2); hi = np.polyfit(rows, [xs[ys == y].max() for y in rows], 2)
        Y = np.arange(rings.shape[0])[:, None]
        spine = (X >= np.polyval(lo, Y) - 18) & (X <= np.polyval(hi, Y) + 18) & (Y >= rows.min() - 25) & (Y <= rows.max() + 45)
        _geo[w] = (rings, big, pad, spine)
    return _geo[w]


def build(im):
    rgb, a, L, Y, X = parts(im)
    rings, big, pad, spine = geo(a.shape[1])
    sol = a > 200
    # этаж — кольцо целиком (части за лентами склеиваются по горизонтали)
    lab, k = nd.label(nd.binary_dilation(rings, np.ones((3, 25))))
    fl = np.where(rings, lab, 0)
    g = np.array([0] + [int(H('nn', i) * 1e6) % 8 for i in range(1, k + 1)])
    t = np.array([0] + [0 if H('nnt', i) < 0.8 else (1 if H('nnt', i) < 0.92 else 2) for i in range(1, k + 1)])
    win = win_layer(a.shape, [(rings, g[fl], t[fl], 200)])
    # огоньки на сетке: каждая третья клетка 11×11 по сетке, горит чуть больше половины
    lat = sol & ~nd.binary_dilation(big, iterations=3) & ~pad & ~spine & (Y > 60)  # без кромок лент
    ys, xs = np.nonzero(lat)
    keep = (xs // 11 + ys // 11) % 3 == 0
    c = np.zeros(a.shape, bool); c[ys[keep], xs[keep]] = True
    lab, k = nd.label(c)
    em = np.zeros(a.shape + (3,))
    for i, (cy, cx) in enumerate(nd.center_of_mass(c, lab, range(1, k + 1))):
        if H('fd', i) < 0.55: bulb(em, X, Y, cx, cy, 1.6, (255, 200, 120))
    return win, halo(em, [(0.8, 1.5), (0.35, 4)])
