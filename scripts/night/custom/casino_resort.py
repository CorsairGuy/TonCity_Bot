# Казино, ночь (18.10.2026, вариант 4 «Сетка по изгибу»): вогнутая стеклянная стена разбита на окна по
# этажам и стойкам стекла; этажи повторяют радиус изгиба — нижнюю кромку стекла у входа и дугу под короной.
# Горит ~25% окон (комната — две соседние клетки), к краям изгиба свет тусклее. Дуги перекрытий и стойки
# стекла светятся золотом, красный огонёк на шпиле. Окна правой грани (сетка за бронзовыми рёбрами) —
# прежние ключи разметки этого здания в ov/g1.json.
import numpy as np
from scipy import ndimage as nd
from PIL import Image
from .common import parts, halo, padmask, H
from .neonkit import bulbs, poly, comps

N = 'COM_casino_resort.png'
GOLD = (255, 190, 80)
FRAC, WARM, WHITE, SEED, ROOM, CURVE = 0.25, 0.75, 0.7, 'c4', 2, 0.6
FUV, FA, FP = 400.0, 0.0023, 29.5                # этаж: V = Y − FA·(U − FUV)², шаг FP px


def keywin(sh, keep):
    """Окна правой грани по ключам разметки (без 'custom'), растянутые до родного размера."""
    import gen
    o = {k: v for k, v in gen.load_ov()[N].items() if k not in ('custom', 'lights')}
    b = gen.build(N, {N: o})
    wm = b['win'] > 0; L = b['im'][..., :3] @ [0.299, 0.587, 0.114]
    w = np.zeros(wm.shape + (4,), np.uint8)
    w[..., 0] = np.where(wm, L, 0); w[..., 1] = np.where(wm, b['grp'].astype(int) * 32 + 16, 0)
    w[..., 2] = np.where(wm, b['tone'].astype(int) * 80 + 40, 0); w[..., 3] = np.where(wm, 255, 0)
    w = np.asarray(Image.fromarray(w).resize((sh[1], sh[0]), Image.NEAREST)).copy()
    w[~keep] = 0
    return w


def build(im):
    rgb, a, L, Y, X = parts(im); sh = a.shape
    r, b_ = rgb[..., 0], rgb[..., 2]
    sol = a > 200; pad = padmask(rgb, a, Y)
    bronze = sol & (r - b_ > 35) & (r > 110) & ~pad
    rf = poly(sh, [(553, 272), (616, 248), (618, 1292), (357, 1442)])   # правая грань за рёбрами
    panel = sol & poly(sh, [(318, 12), (392, 40), (332, 292), (262, 262)]) & ~bronze & (L < 110)
    ring = sol & poly(sh, [(305, 320), (560, 300), (560, 480), (300, 470)]) & (L < 45) & ~panel
    curtain = sol & ~bronze & ~rf & ~panel & ~ring & (L < 120) & (Y > 100) & ~pad & (X > 60)
    cur = nd.binary_opening(curtain & (Y > 100), np.ones((2, 2)))
    med = nd.median_filter(np.where(cur, L, np.nan_to_num(L)), size=9)
    mull = cur & (L > med + 8)                   # стойки стекла
    arc = cur & (L < med - 5)                    # тёмные линии перекрытий
    # наклон стоек (ось башни)
    labm, _ = comps(nd.binary_dilation(mull, np.ones((3, 1))))
    sl = []
    for i, o in enumerate(nd.find_objects(labm)):
        if o[0].stop - o[0].start < 300: continue
        yy, xx = np.nonzero(labm[o] == i + 1); sl.append(np.polyfit(yy + o[0].start, xx + o[1].start, 1)[0])
    AX = float(np.median(sl))
    U = X - AX * Y                               # поперёк стекла (вдоль стоек U постоянна)
    V = Y - FA * (U - FUV) ** 2                  # этажи — копии нижней кромки стекла
    mm = arc & (Y > 200) & (Y < 1250)
    FPH = float(np.angle(np.exp(2j * np.pi * V[mm] / FP).mean()) / (2 * np.pi) * FP)
    VF = (V - FPH) / FP; FI = np.floor(VF).astype(int)
    floorline = cur & (np.abs((VF + 0.5) % 1 - 0.5) * FP < 1.3)
    u0 = U[cur].min()
    hist = nd.uniform_filter1d(np.bincount(np.clip(U[mull] - u0, 0, None).astype(int)).astype(float), 3)
    MU = np.array([i for i in range(2, len(hist) - 2) if hist[i] == hist[i - 2:i + 3].max() and hist[i] > hist.max() * 0.15]) + u0
    COL = np.digitize(U, MU)
    UN = np.clip((U - MU.min()) / (MU.max() - MU.min()), 0, 1)   # 0..1 поперёк стекла
    pane = cur & ~nd.binary_dilation(mull, np.ones((1, 2))) & ~floorline
    CELL = np.where(pane, FI * 1000 + COL, -1)
    # окна-клетки
    ids = np.unique(CELL[CELL >= 0])
    on = {}; gg = {}; tt = {}
    for c in ids:
        f, col = c // 1000, c % 1000
        room = (f, (col + int(H(SEED, 'o', f) * ROOM)) // ROOM)
        on[c] = H(SEED, room) < FRAC; gg[c] = int(H(SEED, 'g', room) * 1e6) % 7
        h = H(SEED, 't', room); tt[c] = 0 if h < WARM else (1 if h < WARM + (1 - WARM) * WHITE else 2)
    win = keywin(sh, nd.binary_dilation(rf, iterations=8))
    m = CELL >= 0; cm = CELL[m]
    o_ = np.vectorize(on.get)(cm); g_ = np.vectorize(gg.get)(cm); t_ = np.vectorize(tt.get)(cm)
    br = 255 * (1 - CURVE * (np.abs(UN[m] - 0.45) * 2) ** 1.5)   # к краям изгиба стекло уходит от зрителя
    win[m, 0] = np.clip(br, 0, 255); win[m, 1] = np.where(o_, g_, 7) * 32 + 16; win[m, 2] = t_ * 80 + 40; win[m, 3] = 255
    # золотая сетка: дуги перекрытий и стойки
    fe = 1 - 0.65 * (np.abs(UN - 0.45) * 2) ** 1.5
    e = halo(np.where(floorline[..., None], np.array(GOLD, float) * 0.75 * fe[..., None], 0), [(0.5, 2), (0.22, 6)])
    fm = fe * np.clip((Y - 150) / 1100, 0.35, 1)
    e += halo(np.where((mull & cur)[..., None], np.array(GOLD, float) * 0.45 * fm[..., None], 0), [(0.5, 2), (0.2, 6)])
    e += bulbs(sh, X, Y, [(455, 52)], (255, 60, 50), 3.2)
    return win, e
