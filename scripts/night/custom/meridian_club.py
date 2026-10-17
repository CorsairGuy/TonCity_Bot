# Клуб «Меридиан» (вилла с бассейном), ночь. Окна — параллелограммы по рамкам с переплётами,
# свет только в стёклах между переплётами; подсветка зависит от варианта VARIANT.
import os
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, edge, halo, bulb, blur, win_layer, NG

VARIANT = os.environ.get('MERIDIAN_VARIANT', 'A')
SL = 0.577                                   # наклон изометрии
# окна: черновая рамка (x0,y0,x1,y1) в пикселях кадра 753×467 и знак наклона грани
BOX = [(474, 232, 490, 260, -1), (474, 263, 499, 297, -1), (469, 305, 500, 357, -1), (515, 209, 530, 235, -1),
       (515, 250, 530, 276, -1), (517, 286, 542, 327, -1), (416, 341, 450, 388, -1),
       (463, 166, 493, 200, 1), (100, 219, 135, 272, 1), (138, 241, 174, 294, 1), (297, 333, 332, 386, 1),
       (335, 355, 368, 404, 1),
       (293, 66, 327, 110, 1), (373, 115, 417, 172, 1), (208, 93, 242, 142, 1)]
# открытые двери под аркадой: x0, x1 и линии верха/низа проёма (u = y - SL*x)
DOORS = [(245, 257, 93.5, 122), (263, 280, 93, 121), (314, 325, 93, 117)]
PILLARS = [(17.5, 212), (377.5, 5), (735, 212), (375, 420)]   # колонны по углам ограды (верх капители)
GATE = [(175, 300), (216.7, 325)]                              # столбы ворот
LAMP = (436, 183)                                              # ночник у кровати
BILLIARD = (370, 160)
FENCE_DY = 15                                                 # верх ограды ниже капителей


def glow(e, X, Y, x, y, c, rad=3.2, far=14, k=0.5):
    """Фонарь: яркое ядро и мягкий ореол вокруг."""
    d = np.hypot(X - x, Y - y)
    f = np.clip(1 - d / rad, 0, 1) ** 0.8 + k * np.clip(1 - d / far, 0, 1) ** 2.2
    e += f[..., None] * np.array(c, float)


def windows(rgb, a, L, sat, Y, X):
    loc = nd.uniform_filter(L, 5)
    out = []
    for k, (x0, y0, x1, y1, sg) in enumerate(BOX):
        s = sg * SL; sub = (slice(y0, y1), slice(x0, x1))
        thr = min(np.median(L[sub]) - 30, 125)
        ys, xs = np.nonzero((L[sub] < thr) & (sat[sub] < 0.25) & (a[sub] > 200))
        ys = ys + y0; xs = xs + x0; u = ys - s * xs
        u0, u1 = np.percentile(u, 1), np.percentile(u, 99)
        xa, xb = np.percentile(xs, 1), np.percentile(xs, 99)
        q = (X >= xa) & (X <= xb + .5) & (Y - s * X >= u0) & (Y - s * X <= u1 + .5)
        q &= (X >= x0 - 1) & (X < x1 + 1) & (Y >= y0 - 1) & (Y < y1 + 1)
        pane = q & ~((L < loc - 16) | (L < thr)) & (sat < 0.3)
        out.append(nd.binary_opening(pane, np.ones((2, 2))))
    return out


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); mn = rgb.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    solid = a > 200
    V = VARIANT
    # --- окна
    items = []
    for k, m in enumerate(windows(rgb, a, L, sat, Y, X)):
        if V == 'B': t = [0, 1, 2][int(H('mc', 't', k) * 3)]
        elif V == 'C': t = 0 if H('mc', 't', k) < 0.8 else 1
        else: t = 0 if H('mc', 't', k) < 0.7 else 1
        br = np.clip(150 + 0.6 * (L - 120), 150, 255)     # отражение на стекле даёт рисунок
        items.append((m, int(H('mc', 'g', k) * NG), t, br))
    # проёмы открытых дверей светятся целиком, к полу ярче; рельеф створки сохраняется
    for k, (x0, x1, u0, u1) in enumerate(DOORS):
        u = Y - SL * X
        m = solid & (X >= x0) & (X <= x1) & (u >= u0) & (u <= u1) & (L > 95)
        tt = np.clip((u - u0) / (u1 - u0), 0, 1)
        items.append((m, int(H('mc', 'd', k) * NG), 0, np.clip((120 + 0.5 * (L - 100)) * (0.8 + 0.35 * tt), 120, 255)))
    win = win_layer(a.shape, items)

    e = np.zeros_like(rgb)
    def paint(m, c, k=1.0):
        e[m] = np.maximum(e[m], np.array(c, float)[None] * (k[m][:, None] if np.ndim(k) else k))
    # --- бассейн: вода светится бирюзой со своей рябью
    pool = solid & (b > r + 6) & (sat > 0.05) & (X > 440) & (X < 620) & (Y > 120) & (Y < 205) & ~((Y > 183) & (X < 532))
    pool = nd.binary_fill_holes(nd.binary_closing(pool, np.ones((3, 3)))) & solid & (b >= r)
    lo, hi = np.percentile(L[pool], 3), np.percentile(L[pool], 97)
    t = np.clip((L - lo) / max(hi - lo, 1), 0, 1)
    pc = {'A': (70, 200, 230), 'B': (40, 230, 255), 'C': (60, 215, 255)}[V]
    pk = {'A': 0.75, 'B': 0.85, 'C': 1.0}[V]
    paint(pool, pc, pk * (0.35 + 0.65 * t ** 1.4))
    if V == 'B':
        paint(edge(pool, 2), (170, 250, 255), 1.0)
    if V == 'C':
        # подводные прожекторы вдоль дальней стенки, через равные промежутки
        pf = nd.binary_fill_holes(pool)
        cols = np.nonzero(pf.any(0))[0]
        for xx in np.linspace(cols.min() + 14, cols.max() - 14, 5):
            ys = np.nonzero(pf[:, int(xx)])[0]
            if len(ys): 
                yy = ys.min() + 3
                d = np.hypot(X - xx, (Y - yy) * 1.7)
                e += (np.clip(1 - d / 12, 0, 1) ** 1.5 * pf)[..., None] * np.array([150, 240, 255.]) * 0.6
    # --- пальмы: подсветка снизу, к верхушке слабее
    palm = solid & (g > r + 8) & (g > b + 8) & (sat > 0.12) & ~((X > 335) & (X < 370) & (Y > 210) & (Y < 260))
    lab, n = nd.label(nd.binary_closing(palm, np.ones((3, 3))) & palm)
    sz = nd.sum(palm, lab, range(1, n + 1))
    pcol = {'A': (215, 235, 120), 'B': (175, 100, 255), 'C': (130, 235, 175)}[V]
    for i in np.nonzero(sz >= 120)[0] + 1:
        m = lab == i
        ys = Y[m]; tt = (ys - ys.min()) / max(1, ys.max() - ys.min())
        rel = np.clip((L[m] - 70) / 140, 0, 1)
        e[m] = np.maximum(e[m], np.array(pcol, float)[None] * ((0.08 + 0.55 * tt ** 1.7) * (0.35 + 0.75 * rel))[:, None])
    # --- фонари на колоннах ограды и у ворот
    lc = {'A': (255, 200, 120), 'B': (255, 110, 210), 'C': (255, 214, 150)}[V]
    for x, y in PILLARS + GATE:
        if V == 'B' and (x, y) in PILLARS: continue
        glow(e, X, Y, x, y, lc)
    # --- гирлянда по верху ограды (курорт): лампочки через равный шаг, только там, где ограда видна
    if V == 'C':
        fence = solid & (L < 125) & (sat < 0.12)
        P = dict(zip('LTRB', PILLARS))
        for s_, e_ in ['LB', 'BR', 'LT', 'TR']:
            (x1, y1), (x2, y2) = P[s_], P[e_]
            n_ = int(abs(x2 - x1) // 13)
            for j in range(1, n_):
                x = x1 + (x2 - x1) * j / n_; y = y1 + (y2 - y1) * j / n_ + FENCE_DY
                yi, xi = int(round(y)), int(round(x))
                if fence[yi:yi + 4, xi].any():
                    glow(e, X, Y, x, y + 1, (255, 215, 140), 1.6, 5, 0.35)
    # --- комнаты без крыши: ночник у кровати и лампа над бильярдом
    if V in 'AC':
        bulb(e, X, Y, LAMP[0], LAMP[1], 2.2, (255, 200, 120))
        felt = solid & (g > r + 10) & (np.hypot(X - BILLIARD[0], (Y - BILLIARD[1]) * 1.6) < 22) & ~palm
        paint(felt, (180, 230, 150), np.clip(L / 200, 0, 1) * 0.55)
    # --- неон по передней кромке плиты над аркадой
    if V == 'B':
        slab = solid & (L > 205) & (sat < 0.06) & (X > 206) & (X < 376) & (Y > 115) & (Y < 240)
        lab2, n2 = nd.label(slab); big = np.argmax(nd.sum(slab, lab2, range(1, n2 + 1))) + 1
        slab = lab2 == big
        neon = np.zeros_like(slab)
        for xx in range(207, 376):
            ys = np.nonzero(slab[:, xx])[0]
            if len(ys): neon[ys.max() - 1:ys.max() + 1, xx] = True
        paint(neon, (255, 70, 200), 1.0)
    rings = {'A': [(0.35, 2), (0.15, 6)], 'B': [(0.45, 2), (0.22, 7)], 'C': [(0.35, 2), (0.18, 7)]}[V]
    return win, halo(e, rings)
