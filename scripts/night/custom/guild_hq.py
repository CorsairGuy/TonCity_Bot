# Штаб-квартира гильдии (столица), ночь — вариант «Офисные огни» (17.10.2026): окна этажей между
# линиями перекрытий горят тёплым/белым/холодным светом зеркально относительно оси, рёбра — золотой
# неон, звезда светится своим рельефом. Сложный верх (большие стёкла и решётки) перерисован в спрайте
# обычной сеткой этажей (scripts/night/patch_hq_sprite.py), окна идут до самой крыши, крыша тёмная.
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, edge, halo, win_layer, NG

CX = 376.0
SL = 0.58                                   # наклон линий этажей на боковых гранях
P_L, P_R, P_C = (756, 38.47), (751.5, 38.47), (373, 40.3)  # первая линия и шаг этажа: лево, право, центр
P = 15                                      # ширина окна-панели, px


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    solid = a > 200
    glass = solid & (b > r + 25) & (b >= g)
    star = (a > 100) & (r > b + 40) & (r >= g)
    gray = solid & ~glass & ~star
    plate = gray & (L > 170)
    frame = gray & ~plate
    lab, _ = nd.label(glass)
    # три грани: самые большие куски стекла, по положению центра
    sz = nd.sum(glass, lab, range(1, lab.max() + 1))
    big = np.argsort(-sz)[:3] + 1
    cx = {i: X[lab == i].mean() for i in big}
    FL, FC, FR = [lab == i for i in sorted(big, key=lambda i: cx[i])]
    FACE = FL | FC | FR
    line = glass & (g > 80)
    uL = Y - SL * (X - CX); uR = Y + SL * (X - CX)
    K = np.where(FL, np.floor((uL - P_L[0]) / P_L[1]), np.where(FR, np.floor((uR - P_R[0]) / P_R[1]), np.floor((Y - P_C[0]) / P_C[1])))
    FF = np.where(FL, ((uL - P_L[0]) / P_L[1]) % 1, np.where(FR, ((uR - P_R[0]) / P_R[1]) % 1, ((Y - P_C[0]) / P_C[1]) % 1))
    DX = np.abs(X - CX)

    # окна-панели: между линиями этажей, колонки от оси (зеркально), обрезки у рёбер не светятся
    j = np.floor(DX / P); fx = (DX / P) % 1
    pm = FACE & ~line & (FF > 0.16) & (FF < 0.96) & (fx * P > 1) & (fx * P < P - 1) & ~star
    face = np.where(FL, 0, np.where(FR, 1, 2))
    key = np.where(pm, (K.astype(np.int64) + 100) * 1000 + j.astype(np.int64) * 4 + face, -1)
    u, inv = np.unique(key, return_inverse=True); inv = inv.reshape(key.shape)
    plab = np.where(pm, inv, 0)
    area = np.bincount(plab.ravel(), minlength=len(u))
    full = np.percentile(area[1:], 80)
    items = []
    for i in range(1, len(u)):
        if area[i] < full * 0.55: continue
        k = int(u[i]) // 1000 - 100; jj = (int(u[i]) % 1000) // 4
        sel = plab == i
        t = int(H('o', 't', k // 2) * 3)
        if H('o', 'x', k, jj) < 0.15: t = int(H('o', 'y', k, jj) * 3)
        # потолочный свет: у верхней кромки окна ярче
        br = 255 * np.exp(-np.maximum(FF - 0.18, 0) / 0.22) * 0.75
        items.append((sel, int(H('o', 'g', k, jj) * NG), t, br))
    win = win_layer(a.shape, items)

    e = np.zeros_like(rgb)
    def paint(m, c, k):
        e[m] = np.maximum(e[m], np.array(c)[None] * (k[m][:, None] if np.ndim(k) else k))
    GOLD = (255, 196, 90)
    ef = edge(frame, 2) & ~plate
    paint(ef, GOLD, np.clip((0.65 + 0.5 * L / 255) * 0.9, 0, 1.4))
    # звезда: рельеф исходника, золото не выгорает в белое
    rel = (L - L[star].min()) / max(1, L[star].max() - L[star].min())
    kk = (0.38 + 0.72 * rel[star]) ** 1.1
    col = np.array([255, 190, 80.])[None] * kk[:, None]
    col[:, 1] += 28 * rel[star] ** 3; col[:, 2] += 40 * rel[star] ** 4
    e[star] = np.clip(col, 0, 255)
    return win, halo(e, [(0.3, 2), (0.12, 6)])
