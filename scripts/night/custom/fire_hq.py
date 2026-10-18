# Штаб-квартира пожарных и её звёздные версии, ночь (18.10.2026, вариант 4): оранжевый неон по кромкам крыши депо (с углом справа),
# карнизам и шапке каланчи; буквы Fire Station горят белым; тёплый свет пробивается сквозь щели гаражных
# ворот, без пятна на асфальте. Огонька на шпиле, света в окне каланчи и линии у земли нет. Окна здания —
# прежние ключи разметки, этот модуль — {"t":"mod","mod":"fire_hq"}.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, edge, shaded, lines
from .neonkit import neon, poly, comps, clean, region

OR = (255, 120, 40); WH = (235, 240, 255); SLIT = (255, 215, 160)
CX, CY, RX, RY = 543, 360, 56, 30                # вертолётная площадка на крыше депо


def emit(im, name):
    # контуры ищутся на базовом спрайте, у звёздных версий свет остаётся только там, где кадр совпадает с базой
    # (машины и звёзды перед стеной его закрывают)
    import gen
    base = 'SER_fire_headquarters.png'
    b = np.asarray(gen.sprite(base, gen.sprite_map()[base]['frame']['w'])).astype(float)
    vis = (np.abs(im[..., :3] - b[..., :3]).max(-1) < 30) & (im[..., 3] > 200) if name != base else im[..., 3] > 200
    rgb, a, L, Y, X = parts(b); sh = a.shape
    r, g = rgb[..., 0], rgb[..., 1]
    sat = rgb.max(-1) - rgb.min(-1)
    sol = a > 200
    peach = sol & (r > 190) & (g > 140) & (rgb[..., 2] > 110) & (r - rgb[..., 2] > 40) & (r - rgb[..., 2] < 110)
    tower = peach & (X < 292) & (Y < 300); body = peach & ~tower
    gar = nd.binary_dilation(region(rgb, a, 300, 370, 22), iterations=1) | nd.binary_dilation(region(rgb, a, 450, 460, 22), iterations=1)
    gar &= sol & (sat < 30)
    # красные части: крыша депо, шапка каланчи, карниз
    red = sol & (r - g > 50) & (r > 110) & (Y < 560)
    lab, k = comps(red); sz = nd.sum(red, lab, range(1, k + 1)); order = np.argsort(-sz)
    C = lambda j: lab == order[j] + 1
    depot = nd.binary_fill_holes(C(0)); towtop = nd.binary_fill_holes(C(1)); cornice = nd.binary_fill_holes(C(3))
    signp = poly(sh, [(146, 205), (245, 248), (245, 282), (146, 240)])
    depot_ns = depot & ~nd.binary_dilation(signp & sol, iterations=3)
    lower = lambda m: m & np.roll(~m, -3, 0)
    upper = lambda m: m & np.roll(~sol, 3, 0)
    truck = poly(sh, [(300, 430), (480, 430), (480, 590), (300, 590)])
    wallok = tower | body | ~sol | gar
    ne = clean(((lower(depot_ns) & np.roll(wallok, -3, 0)) | upper(depot_ns)) & ~truck & (Y > 140)
               & ~(((X - 543) / 75) ** 2 + ((Y - 360) / 42) ** 2 < 1))
    # вертолёт на площадке: через него линия не идёт
    heli = sol & (((X - CX) / (RX + 14)) ** 2 + ((Y - CY) / (RY + 10)) ** 2 < 1.3) & ((L < 95) | ((sat < 30) & (L < 200) & (L > 95))) & ~(r - g > 50)
    heli |= sol & (L < 110) & (sat < 25) & poly(sh, [(440, 250), (660, 250), (660, 345), (440, 345)])
    HD = nd.binary_dilation(heli, iterations=3)
    # задняя кромка крыши депо — двумя прямыми (её перебивает лопасть)
    up = clean(upper(depot_ns)) & (X > 300) & (X < 660)
    yy, xx = np.nonzero(up); pf = np.polyfit(xx, yy, 1)
    segs = []
    for a_, b_ in [(296, 372), (380, 662)]:
        s_ = (xx >= a_) & (xx <= b_); q = np.polyfit(xx[s_], yy[s_], 1)
        segs.append([(a_, np.polyval(q, a_)), (b_, np.polyval(q, b_))])
    back = (lines(sh, segs, 2.2) > 0.4) & sol & ~HD
    back &= ~nd.binary_dilation(sol & (L < 120) & (sat < 25) & (Y < np.polyval(pf, X) - 1), iterations=1)
    ne = (ne & ~(upper(depot_ns) & (X > 300))) | back
    tw = clean(lower(towtop) | upper(towtop) | lower(cornice))
    cap = edge(towtop, 2) & sol                  # шапка каланчи полным контуром
    tip = edge(depot_ns, 2) & (X > 644) & sol    # правый угол депо: линии сходятся на кончике карниза
    e = neon((ne | tw | cap | tip) & vis, OR, 1.1)
    # буквы Fire Station: красное внутри таблички без рамки
    plate = nd.binary_erosion(poly(sh, [(159, 216), (227, 252), (227, 269), (158, 233)]), iterations=3) & sol
    let = plate & (r - g > 60) & vis
    e += halo(np.where(let[..., None], np.array(WH, float) * 1.3, 0), [(0.25, 1.0), (0.08, 3)])
    # щели гаражных ворот
    slit = gar & (L < np.percentile(L[gar], 35))
    gl = shaded(slit, SLIT, L, lo=0.7, k=0.45) + shaded(gar & ~slit, SLIT, L, lo=0.5, k=0.125)
    gl += np.where((gar & np.roll(~gar, -3, 0))[..., None], np.array(SLIT, float) * 0.9, 0)
    e += halo(gl * vis[..., None], [(0.4, 2), (0.2, 5)])
    return e
