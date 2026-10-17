# Столичная Башня (город), ночь — вариант «Прожекторы и золото» (17.10.2026): белые плиты
# подсвечены снизу тёплым светом, по нижним кромкам плит золотой неон, окна-ленты между плитами,
# стеклянный атриум у основания горит янтарным, бассейн, вход, фонари по кольцу площади.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, win_layer


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
    # проезд под башней — тёмный кусок под центром атриума целиком (не прямоугольник)
    lobby = dl == dl[585, 388] if dl[585, 388] else np.zeros_like(solid)
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
    # окна — тонкие тёмные ленты между плитами (толстые тёмные пятна — тени у силуэта); у силуэта
    # отступ в 1 px, иначе концы лент оставались тёмными
    near = nd.binary_dilation(a < 100, iterations=1)
    # тонкая линия — темнее и того, что над ней, и того, что под ней (серые линии на светлых плитах),
    # плюс бирюзовые стёкла в щелях
    up = np.minimum(np.roll(L, 2, 0), np.roll(L, 3, 0)); dn = np.minimum(np.roll(L, -2, 0), np.roll(L, -3, 0))
    thin = (L < up - 22) & (L < dn - 22) & (L < 150)
    teal_g = (b > r + 25) & (L < 130)
    dk = body & ((((L < 85) | teal_g) & ~near) | (thin & ~nd.binary_dilation(a < 100, iterations=4)))
    thick = nd.binary_opening(dk, np.ones((10, 1)))
    gap = dk & ~thick
    # нижние ленты над атриумом горят всегда и целиком, вместе с бирюзовыми стёклами и до самого края
    teal = (b > r + 30) & (L < 120)
    # только сами тёмные линии (без серых полутонов вокруг), иначе свет ложится прямоугольниками
    bd = solid & (Y > 498) & (Y < 556) & (X > 272) & (X < 505) & ((L < 60) | (teal & (L < 120)))
    base_band = bd & ~nd.binary_opening(bd, np.ones((5, 1)))   # тонкие линии, ячейки атриума толще
    # мягкая маска по самой линии: сила света — насколько пиксель тёмный (сглаженные края линии),
    # так свет повторяет изгиб линии, а не ложится ступеньками и прямоугольниками
    bb_zone = nd.binary_dilation(base_band, iterations=1) & solid & ~atrium
    bb_k = np.where(bb_zone, np.clip((150 - L) / 90, 0, 1), 0)
    gap &= ~base_band & (Y < 498)   # ниже — только постоянные ленты
    # ленты вытянуты вдоль плит: короткие и вертикальные куски (тени, стойки перил) — не окна.
    # Пунктирные линии (их режут стойки перил) склеиваем по горизонтали, чтобы проверять ленту целиком
    edge4 = nd.binary_dilation(a < 100, iterations=4)
    gl0, gn0 = nd.label(nd.binary_dilation(gap, np.ones((1, 7))))
    for i, sl in enumerate(nd.find_objects(gl0)):
        hh = sl[0].stop - sl[0].start; ww = sl[1].stop - sl[1].start
        m = gl0[sl] == i + 1
        # лента — тонкая (в среднем до 4 px на колонку) и длинная, наклонные ленты тоже проходят
        mg = gap[sl] & m
        # куски, лежащие в основном у силуэта, — тени и перила на торцах, а не ленты
        if ww < 12 or ww < 1.5 * hh or mg.sum() > 4 * ww or edge4[sl][mg].mean() > 0.5: gap[sl][m] = False
    dn2 = lambda m, k: np.roll(m, -k, 0)
    lower = body & (Y < 470) & (L > 105) & (dn2(L < 75, 2) | dn2(L < 75, 1)) & ~gap & ~nd.binary_dilation(a < 100, iterations=2)

    # окна: ленты между плитами горят всегда и целиком, как нижние (решение 17.10.2026: без пропусков)
    win = win_layer(a.shape, [])
    g_zone = nd.binary_dilation(gap, iterations=1) & solid & ~atrium & ~bb_zone
    g_k = np.where(gap, 1.0, np.where(g_zone, np.clip((150 - L) / 90, 0, 1), 0))

    e = np.zeros_like(rgb)
    # подсветка снизу: всё, что выше верхней кромки атриума в своей колонке
    um = body & ~gap
    w = np.exp(-np.clip((540 - Y) / 480, 0, 1) * 2.6)
    e[um] = np.array([255, 175, 80.])[None] * (0.42 * w[um] * (0.3 + 0.9 * L[um] / 230))[:, None]
    # золотой неон по нижним кромкам плит
    sh = np.clip(0.55 + 0.6 * L / 220, 0, 1.2) * 0.9
    e[lower] = np.maximum(e[lower], np.array([255, 196, 90.])[None] * sh[lower][:, None])
    t = np.clip((Y - 480) / 90, 0, 1)
    e[atrium] = np.array([255, 180, 90.])[None] * (1.0 - 0.45 * t[atrium])[:, None]
    # нижние ленты окон: ровный тёплый свет по всей длине, к краям чуть мягче
    bk = bb_k * (0.95 - 0.25 * (np.abs(X - 388) / 125) ** 2)
    e[bb_zone] = np.maximum(e[bb_zone] * (1 - bb_k[bb_zone, None]), np.array([255, 205, 130.])[None] * bk[bb_zone][:, None])
    e[g_zone] = np.maximum(e[g_zone] * (1 - g_k[g_zone, None]), np.array([255, 205, 130.])[None] * (0.9 * g_k[g_zone])[:, None])
    e[lobby] = np.array([255, 210, 150.])[None] * (0.6 + 0.4 * np.clip((Y[lobby] - 565) / 40, 0, 1))[:, None]
    e[water] = np.array([60, 190, 255.])[None] * (0.5 * (0.5 + 0.8 * L[water] / 255))[:, None]
    # фонари по внешнему кольцу площади, через равный угол
    for ang in np.linspace(0, 2 * np.pi, 28, endpoint=False):
        x = 380 + 236 * np.cos(ang); y = 606 + 142 * np.sin(ang)
        if y < 575: continue
        xi, yi = int(x), int(y)
        if 0 <= yi < Hh and 0 <= xi < Ww and solid[yi, xi] and not water[yi, xi]: bulb(e, X, Y, x, y, 2.6, (255, 210, 150))
    bulb(e, X, Y, 375, 30, 3.5)
    return win, halo(e, [(0.3, 2), (0.15, 7)])
