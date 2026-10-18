# Башня Сатоши, ночь (18.10.2026, вариант 6.5 «Бычий рынок»): стекло разбито по этажам на панели-окна,
# комната — 1–3 соседние панели, горит ~40% комнат, тёплый и белый свет; белые пилястры светятся
# зелёным (сильнее к низу), зелёный неон по кромкам уступов, логотип и огни антенн зелёные. Корона
# на крыше не подсвечивается.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, shaded, padmask, H
from .neonkit import neon, bulbs, poly, comps

GR = (70, 255, 130)
ANT = [(390, 4), (308, 78), (462, 66)]
PW = 11                                          # ширина панели стекла, px
FRAC, WARM, WHITE, SEED, BR = 0.42, 0.55, 0.6, 'pz', 60


def masks(im):
    rgb, a, L, Y, X = parts(im); sh = a.shape
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    sol = a > 200; sat = rgb.max(-1) - rgb.min(-1)
    white = sol & (sat < 22) & (L > 168) & ~padmask(rgb, a, Y)
    logo = sol & (r - g > 45) & (r > 140)
    blue = sol & (b > r + 18)
    crown = blue & poly(sh, [(100, 128), (240, 85), (475, 222), (470, 262), (400, 290), (300, 250), (105, 170)]) & (Y < 300)
    vert = nd.binary_opening(white, np.ones((40, 3)))          # пилястры
    thick = nd.distance_transform_edt(white) > 6
    thick = nd.binary_propagation(thick, mask=white) & nd.binary_dilation(thick, iterations=8)  # плиты уступов
    return dict(rgb=rgb, a=a, L=L, Y=Y, X=X, sh=sh, sol=sol, logo=logo, crown=crown, glass=blue & ~crown, vert=vert, thick=thick)


def panels(d):
    """Панели стекла: по каждой грани (наклон ±0.577) этажи по минимумам яркости, стойки через PW px."""
    L, Y, X, sh = d['L'], d['Y'], d['X'], d['sh']
    glass = d['glass'] & ~d['crown'] & (Y > 95)
    right = X >= 386
    F = Y - np.where(right, -0.577, 0.577) * X
    lab = np.zeros(sh, int); nid = 1
    for fi, face in enumerate([~right, right]):
        m = glass & face; f = F[m]; lo = int(f.min()); hi = int(f.max()) + 1
        idx = (f - lo).astype(int)
        prof = np.bincount(idx, weights=L[m], minlength=hi - lo + 1) / np.maximum(np.bincount(idx, minlength=hi - lo + 1), 1)
        sm = nd.uniform_filter1d(prof, 3)
        mins = np.array([i for i in range(2, len(sm) - 2) if sm[i] == sm[i - 2:i + 3].min() and sm[i] < np.median(sm) - 6])
        fb = np.searchsorted(mins, F - lo)
        near = np.zeros(sh, bool)
        for v in mins: near |= np.abs(F - lo - v) < 2.0
        col = ((X + fi * 5) // PW).astype(int); mull = ((X + fi * 5) % PW) < 2
        key = np.where(m & ~near & ~mull, fb * 1000 + col, -1)
        _, inv = np.unique(key, return_inverse=True); inv = inv.reshape(sh)
        k_ = np.where(key >= 0, inv + nid, 0); lab = np.where(k_ > 0, k_, lab); nid = k_.max() + 1
    sz = np.bincount(lab.ravel()); lab[sz[lab] < 12] = 0
    return lab, F, right


def build(im):
    d = masks(im); L, Y, X, sh = d['L'], d['Y'], d['X'], d['sh']
    PL, F, right = panels(d)
    ids = np.unique(PL)[1:]
    cx = nd.mean(X, PL, ids); cf = nd.mean(F, PL, ids); rt = nd.mean(right.astype(float), PL, ids)
    n = PL.max() + 1
    on = np.zeros(n, bool); g = np.zeros(n, int); t = np.zeros(n, int)
    for i, x_, f_, r_ in zip(ids, cx, cf, rt):
        w_ = 2 + int(H('rw', int(f_ // 6)) * 2)        # комната: 2–3 панели на одном этаже
        room = (int(r_), int(f_ // 6), int(x_ // (PW * w_)))
        on[i] = H(SEED, room) < FRAC; g[i] = int(H(SEED + 'g', room) * 1e6) % 7
        h = H(SEED + 't', i); t[i] = 0 if h < WARM else (1 if h < WARM + (1 - WARM) * WHITE else 2)
    win = np.zeros(sh + (4,), np.uint8); m = PL > 0
    G = np.where(on[PL], g[PL], 7)
    win[m, 0] = np.clip(BR * (0.75 + 0.5 * L[m] / 255), 0, 255); win[m, 1] = G[m] * 32 + 16
    win[m, 2] = t[PL][m] * 80 + 40; win[m, 3] = 255
    # пилястры зелёным, ярче к низу
    f = np.clip((Y - 80) / 1000, 0, 1) ** 0.8
    e = halo(shaded(d['vert'] & ~d['thick'], GR, L, lo=0.5, k=0.75) * f[..., None], [(0.5, 2), (0.25, 7)])
    # логотип
    lm = nd.binary_dilation(d['logo'], iterations=1)
    e += halo(shaded(lm, GR, L, lo=0.7, k=0.5), [(0.8, 2), (0.45, 6), (0.2, 14)])
    e += bulbs(sh, X, Y, ANT, GR, 3.2)
    # неон по нижним кромкам уступов
    th = d['thick']; lower = th & ~np.roll(th, -3, 0) & ~np.roll(th, -1, 0) & (Y > 100)
    lab, k = comps(lower); s2 = nd.sum(lower, lab, range(1, k + 1)); lower = np.isin(lab, np.nonzero(s2 >= 30)[0] + 1)
    e += neon(lower, GR, 1.1)
    return win, e
