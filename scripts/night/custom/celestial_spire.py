# Небесный Пик, ночь — вариант «Лунная тишина» (17.10.2026): окон горит немного, свет холодный белый и
# тёплый вперемешку; стекло лобби и небесного сада светится изнутри спокойным холодным светом (штриховка
# стекла видна); по переднему краю крыши тонкое бледное кольцо от края до края; авиаогонь в центре крыши,
# у входа слабый отсвет на площадке.
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, halo, bulb, win_layer, NG

LIT = 0.45                                   # доля окон, которые вообще могут гореть
TONE = (0.25, 0.40, 0.35)                    # тёплый, белый, холодный
APT = (17, 19)                               # квартира — клетка фасада, px


def build(im):
    rgb, a, L, Y, X = parts(im)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    solid = a > 200
    Hh, Ww = a.shape
    plate = solid & (np.abs(rgb - 204).max(-1) <= 6) & (Y > 0.82 * Hh)    # площадка под башней
    rl, _ = nd.label(solid & (np.abs(rgb - 164).max(-1) <= 8) & (Y < 200))
    roof = nd.binary_fill_holes(rl == rl[40, Ww // 2 - 12])              # плоская крыша
    # стеклянные пояса (лобби и небесный сад): светлые бирюзовые рамы и стекло внутри них
    fr = solid & (L > 165) & (g > r + 15) & (b > r + 15)
    fl, fn = nd.label(fr, np.ones((3, 3)))
    sz = nd.sum(fr, fl, range(1, fn + 1))
    frames = np.isin(fl, 1 + np.nonzero(sz >= 50)[0])
    pane = nd.binary_fill_holes(frames | ~solid) & solid & ~frames
    fac = solid & ~plate & ~roof & ~pane & ~frames
    # окна — бирюзовые стёкла фасада; высокие узкие полосы у правого края — блик, не окна
    teal = fac & (g > r + 25) & (b > r + 25)
    wl, wn = nd.label(teal)
    items = []
    for i, sl in enumerate(nd.find_objects(wl)):
        m = wl[sl] == i + 1
        if m.sum() < 6 or sl[0].stop - sl[0].start >= 26: continue
        ys, xs = np.nonzero(m)
        k = (int((xs.mean() + sl[1].start) // APT[0]), int((ys.mean() + sl[0].start) // APT[1]))
        if H('l', k) > LIT: continue
        t = H('l', 't', k) * sum(TONE)
        tone = 0 if t < TONE[0] else 1 if t < TONE[0] + TONE[1] else 2
        sel = np.zeros_like(solid); sel[sl] = m
        items.append((sel, int(H('l', 'g', k) * NG), tone, L))
    win = win_layer(a.shape, items)

    e = np.zeros_like(rgb)

    def paint(mask, c, w):
        e[mask] = np.maximum(e[mask], np.array(c, float)[None] * np.broadcast_to(w, a.shape)[mask][:, None])

    # стекло поясов: свет изнутри, штриховка стекла видна
    tex = 0.3 + 0.7 * np.clip((L - 30) / 90, 0, 1.2)
    lobby = pane & (Y > Hh / 2); sky = pane & (Y <= Hh / 2)
    paint(lobby, (230, 235, 255), 0.55 * tex)
    paint(sky, (200, 215, 255), 0.35 * tex)
    # кольцо по переднему краю крыши: нижняя кромка крыши в каждой колонке, гладкая кривая от края до края
    xs = np.array([x for x in range(Ww) if roof[:, x].any()], float)
    ys = np.array([np.nonzero(roof[:, int(x)])[0].max() for x in xs], float)
    xr = np.arange(xs.min(), xs.max() + 1); yr = np.polyval(np.polyfit(xs, ys, 6), xr)
    ring = np.zeros(a.shape)
    for x, yv in zip(xr.astype(int), yr):
        seg = np.arange(max(0, int(yv) - 6), min(Hh, int(yv) + 7))
        ring[seg, x] = np.maximum(ring[seg, x], np.clip(1 - (np.abs(seg - yv) - 1.0), 0, 1))
    e[:] = np.maximum(e, np.array([200, 215, 255.])[None, None] * (0.55 * ring)[..., None])
    # отсвет лобби на площадке
    d = ((X - 0.44 * Ww) / 300) ** 2 + ((Y - 0.937 * Hh) / 150) ** 2
    paint(plate, (190, 205, 255), 0.2 * np.clip(1 - d, 0, 1) ** 1.6)
    bulb(e, X, Y, Ww // 2 - 12, 40, 4.5)
    return win, halo(e, [(0.3, 2), (0.15, 7)])
