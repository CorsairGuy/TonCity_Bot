# Центральный маркет, ночь: чёрная стеклянная башня-цилиндр — этажи идут дугами по цилиндру, панели между
# стойками (стойки чаще к краям, как на круглом фасаде), свет включается офисами по две панели.
# Наверху голограмма-экран со своими розовыми кольцами и семь колец вокруг верха башни: передние дуги
# колец проходят снаружи, поверх лент, и горят целиком, задние — только там, где их видно.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, win_layer, disk, padmask, lines, H

CX = 378                                  # ось башни
RY_ = [560, 800, 1000, 1250, 1500, 1660]  # радиус башни по высоте (кадр 753×1800)
RX_ = [150, 125, 118, 130, 148, 152]
NC, FH = 26, 16                           # панелей на полкруга, высота этажа
RING = (376, 227, 128, 52.5, 380, 7)      # кольца: ось x, полуоси, шаг по высоте, верхнее, сколько (подобраны по спрайту)


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    sol = a > 200; pad = padmask(rgb, a, Y); mx = rgb.max(-1); mn = rgb.min(-1)
    RX = np.interp(Y, RY_, RX_)
    glass = sol & ~pad & (L < 70) & (Y > 575) & (Y < 1655) & (np.abs(X - CX) < RX + 8)
    t = np.clip((X - CX) / RX, -0.999, 0.999)
    cf = (np.arcsin(t) + np.pi / 2) / (np.pi / NC); col = np.floor(cf).astype(int)
    fy = Y - 0.3 * RX * np.sqrt(1 - t * t); fl = np.floor((fy - 560) / FH).astype(int)
    mull = (cf % 1 < 0.1) | (cf % 1 > 0.93) | (((fy - 560) % FH) < 3.2)
    cells = glass & ~mull & (np.abs(t) < 0.97)
    key = fl * 1000 + col // 2
    u, inv = np.unique(key[cells], return_inverse=True)
    hs = np.array([H('cm', int(q)) for q in u]); h2 = np.array([H('cmt', int(q)) for q in u])
    gq = np.where(hs < 0.55, (hs / 0.55 * 7).astype(int), 7)  # горит чуть больше половины офисов
    tq = np.where(h2 < 0.45, 0, np.where(h2 < 0.78, 1, 2))
    G = np.zeros(a.shape, int); T = np.zeros(a.shape, int)
    G[cells] = gq[inv.ravel()]; T[cells] = tq[inv.ravel()]
    win = win_layer(a.shape, [(cells, G, T, 120)])
    # голограмма: экран светится своими цветами, розовые кольца вокруг него — розовым неоном
    pale = sol & ~pad & (L > 110) & (b >= r) & (mx - mn > 8)
    thin = pale & ~nd.binary_opening(pale, disk(4))
    holo = sol & (((X - 356) / 93) ** 2 + ((Y - 147) / 75) ** 2 <= 1)
    pink = thin & (Y < 330) & ~holo
    em = halo(np.where(holo[..., None], np.clip(rgb * 1.1 + 20, 0, 255) * 0.8, 0), [(0.4, 4), (0.2, 14)])
    em += halo(pink[..., None] * np.array([255, 150, 235.]) * 0.8, [(0.6, 2), (0.3, 7)])
    # кольца вокруг верха: эллипсы, передняя половина — сплошной линией
    cx, rx, ry, dy, c0, n = RING
    vis = nd.binary_dilation(sol & (L > 150) & (g >= r) & (b >= r) & (np.abs(g - b) < 35), iterations=2)
    th = np.linspace(0, np.pi, 240)
    front = [[(cx + rx * np.cos(q), c0 + k * dy + ry * np.sin(q)) for q in th] for k in range(n)]
    back = [[(cx + rx * np.cos(q), c0 + k * dy - ry * np.sin(q)) for q in th] for k in range(n)]
    rm = np.maximum(lines(a.shape, front, 4.2), lines(a.shape, back, 4.2) * vis)
    em += halo(rm[..., None] * np.array([165, 238, 255.]) * 0.85, [(0.75, 2), (0.35, 6), (0.15, 16)])
    return win, em
