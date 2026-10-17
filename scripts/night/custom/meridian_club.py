# Клуб «Меридиан» (вилла с бассейном), ночь — вариант «Курорт с гирляндой» (17.10.2026): окна —
# параллелограммы по рамам, свет только в стёклах между переплётами; проёмы дверей под аркадой;
# неяркий бирюзовый бассейн с ровным дном и светлой кромкой по бортику; пальмы без подсветки, окна за ними
# не светятся; фонари на угловых колоннах и столбах ворот; гирлянда по верху ограды со всех сторон,
# где ограда видна.
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, edge, halo, bulb, blur, win_layer, NG

SL = 0.577                                   # наклон изометрии
# окна только под крышей (стёкла срезанных комнат без потолка не светятся):
# черновая рамка (x0,y0,x1,y1) в пикселях кадра 753×467 и знак наклона грани
BOX = [(474, 232, 490, 260, -1), (474, 263, 499, 297, -1), (469, 305, 500, 357, -1), (515, 209, 530, 235, -1),
       (515, 250, 530, 276, -1), (517, 286, 542, 327, -1), (416, 341, 450, 388, -1),
       (100, 219, 135, 272, 1), (138, 241, 174, 294, 1), (297, 333, 332, 386, 1),
       (335, 355, 368, 404, 1)]
# открытые двери под аркадой: x0, x1 и линии верха/низа проёма (u = y - SL*x)
DOORS = [(245, 257, 93.5, 122), (263, 280, 93, 121), (314, 325, 93, 117)]
PILLARS = [(17.5, 212), (377.5, 5), (735, 212), (375, 420)]   # колонны по углам ограды (верх капители)
GATE = [(175, 300), (216.7, 325)]                              # столбы ворот
LAMP = (436, 183)                                              # ночник у кровати
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
    # листва пальм непрозрачна: окна за ней не светятся
    # (в атласе пальмы полупрозрачные: между листьями просвечивает окно — считаем листвой всю крону)
    green = solid & (g >= r + 4) & (g > b + 6) & (sat > 0.06) & ~((X > 335) & (X < 370) & (Y > 210) & (Y < 260))
    leaf = (nd.uniform_filter(green.astype(float), 7) > 0.3) | nd.binary_closing(green, np.ones((5, 5)))
    leaf = nd.binary_dilation(leaf) & solid
    # --- окна
    items = []
    for k, m in enumerate(windows(rgb, a, L, sat, Y, X)):
        t = 0 if H('mc', 't', k) < 0.8 else 1
        br = np.clip(150 + 0.6 * (L - 120), 150, 255)     # отражение на стекле даёт рисунок
        items.append((m & ~leaf, int(H('mc', 'g', k) * NG), t, br))
    # проёмы открытых дверей светятся целиком, к полу ярче; рельеф створки сохраняется
    for k, (x0, x1, u0, u1) in enumerate(DOORS):
        u = Y - SL * X
        m = solid & (X >= x0) & (X <= x1) & (u >= u0) & (u <= u1) & (L > 95) & ~leaf
        tt = np.clip((u - u0) / (u1 - u0), 0, 1)
        items.append((m, int(H('mc', 'd', k) * NG), 0, np.clip((120 + 0.5 * (L - 100)) * (0.8 + 0.35 * tt), 120, 255)))
    win = win_layer(a.shape, items)

    e = np.zeros_like(rgb)
    def paint(m, c, k=1.0):
        e[m] = np.maximum(e[m], np.array(c, float)[None] * (k[m][:, None] if np.ndim(k) else k))
    # --- бассейн
    # вода — самый большой кусок голубого у бассейна (мозаика ванной и перила отсекаются стеной)
    pool = solid & (b > r + 6) & (sat > 0.05) & (X > 440) & (X < 620) & (Y > 120) & (Y < 210)
    lab, n = nd.label(nd.binary_opening(pool, np.ones((2, 2))))
    pool = nd.binary_fill_holes(lab == np.argmax(nd.sum(pool, lab, range(1, n + 1))) + 1)
    # дно: размытый рельеф исходника — перепад глубины остаётся, зерно плитки уходит
    Lp = nd.gaussian_filter(np.where(pool, L, 0), 3) / np.maximum(nd.gaussian_filter(pool.astype(float), 3), 1e-3)
    lo, hi = np.percentile(Lp[pool], 3), np.percentile(Lp[pool], 97)
    t = np.clip((Lp - lo) / max(hi - lo, 1), 0, 1)
    paint(pool, (40, 230, 255), 0.18 * (0.45 + 0.55 * t))
    # светлая кромка только вдоль бортика, не по стене дома, которая закрывает угол бассейна
    coping = solid & (L > 185) & (sat < 0.1)
    paint(edge(pool, 2) & nd.binary_dilation(coping, iterations=3), (150, 235, 255), 0.22)
    # --- фонари на колоннах ограды и у ворот
    for x, y in PILLARS + GATE:
        glow(e, X, Y, x, y, (255, 214, 150))
    # --- гирлянда по верху ограды со всех сторон: лампочки через равный шаг, только там, где
    # ограда видна (под точкой — серое полотно забора, а не дом или пальма)
    body = solid & (L > 80) & (L < 150) & (sat < 0.05)
    P = dict(zip('LTRB', PILLARS))
    for s_, e_ in ['LB', 'BR', 'LT', 'TR']:
        (x1, y1), (x2, y2) = P[s_], P[e_]
        n_ = int(abs(x2 - x1) // 13)
        for j in range(1, n_):
            x = x1 + (x2 - x1) * j / n_; y = y1 + (y2 - y1) * j / n_
            xi = int(round(x))
            col = np.nonzero(body[int(y) + 8:int(y) + 26, xi])[0]
            if len(col):
                glow(e, X, Y, x, int(y) + 8 + col[0] - 1, (255, 215, 140), 1.6, 5, 0.35)
    # --- ночник у кровати
    bulb(e, X, Y, LAMP[0], LAMP[1], 2.2, (255, 200, 120))
    return win, halo(e, [(0.35, 2), (0.18, 7)])
