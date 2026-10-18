# Великий Арканум (все звёзды), ночь — переделка 18.10.2026: прежний вариант (горят почти все стёкла
# витражей, неоновый контур по всем кромкам, корона залита) слепил. Теперь башня тёмная, светится немногое.
# Геометрия у всех звёзд одна, поэтому стёкла, колонны, купола и корона размечаются по базовому спрайту;
# на звёздных версиях из этого вычитаются сами звёзды (их подсветка — прежняя, в ov через "lights").
# Витражи режутся на этажи по линиям изометрии (наклон ±0.577): горит этаж-полоса, а не стекло в два этажа.
import numpy as np
from scipy import ndimage as nd
from .common import H, parts, halo, bulb, win_layer, NG, shaded

REF = 'COM_grand_arcanum.png'
SK = 0.577            # наклон линий этажей в изометрии
FL = 20               # высота этажа в витраже, px родного кадра
XC = 356              # ребро башни: левее — левая грань, правее — правая
COLS = ((180, 236), (334, 384), (518, 572))   # угловые стеклянные колонны (x)

# Варианты. lit — доля окон-кандидатов (вечером горят почти все кандидаты, к ночи гаснут);
# tone — доли тёплого/белого/холодного света; остальное — сила подсветок (0 — нет).
VARIANTS = {
    'quiet': dict(lit=0.3, tone=(0.55, 0.35, 0.10), pod=0.35, dome=0.2, crown=0, cols=0, bands=0, slits=0.4),
    'crown': dict(lit=0.28, tone=(0.6, 0.3, 0.1), pod=0.3, dome=0.55, crown=0.75, cols=0, bands=0, slits=0.7),
    'azure': dict(lit=0.24, tone=(0.25, 0.40, 0.35), pod=0.3, dome=0.7, crown=0, cols=0.55, bands=0, slits=0.7, cool=True),
    'bands': dict(lit=0.28, tone=(0.55, 0.35, 0.10), pod=0.3, dome=0.3, crown=0, cols=0, bands=0.7, slits=0.4),
    'deco': dict(lit=0.26, tone=(0.6, 0.3, 0.1), pod=0.3, dome=0.5, crown=0.6, cols=0, bands=0.5, slits=0.6),
}
VARIANT = 'crown'      # по умолчанию «Корона»; остальные — варианты на выбор (18.10.2026)
_ref = {}


def _glass(rgb, a):
    g = (rgb[..., 2] > rgb[..., 0] + 10) | (np.abs(rgb - [14, 30, 40]).max(-1) <= 22)
    g = nd.binary_closing(g & (a > 200), np.ones((3, 3))) & (a > 200)
    return nd.binary_fill_holes(g)


def _anatomy(w):
    if w in _ref: return _ref[w]
    import gen
    im = np.asarray(gen.sprite(REF, w)).astype(float)
    rgb, a, L, Y, X = parts(im)
    solid = a > 200
    g = _glass(rgb, a)
    lab, k = nd.label(g)
    objs = nd.find_objects(lab)
    incol = np.zeros(a.shape, bool)
    for x0, x1 in COLS: incol |= (X >= x0) & (X < x1) & (Y > 255) & (Y < 1260)
    kinds = {}
    dome = np.zeros_like(g); col = np.zeros_like(g); slit = np.zeros_like(g)
    for i, sl in enumerate(objs):
        m = lab == i + 1
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        cx = (x0 + x1) / 2
        if y0 < 330 and y1 - y0 < 50 and x1 - x0 > 45: dome |= m; continue        # стеклянные купола
        if y1 < 300 and 270 < cx < 480: slit |= m; continue                       # окна короны
        if incol[m].mean() > 0.7 and (x1 - x0) >= 12: col |= m; continue          # угловые колонны
    win = g & ~dome & ~col & ~slit
    pod = win & (Y > 1280)
    # корона: медь над стеклом башни, без купола и плоской крыши
    from PIL import Image, ImageDraw
    pi = Image.new('L', (a.shape[1], a.shape[0]), 0)
    ImageDraw.Draw(pi).polygon([(226, 205), (262, 85), (490, 85), (526, 195), (500, 232), (400, 277), (365, 292),
                                (320, 287), (226, 215)], fill=255)
    crown = solid & ~g & (np.asarray(pi) > 0)
    top = crown & (L > 150) & (Y < 140)   # плоская светлая крыша короны
    crown &= ~nd.binary_dilation(top, iterations=2)
    # пояса: нижние кромки главных карнизов — длинные перепады яркости вниз, охватывающие колонны
    d = np.zeros_like(L); d[:-2] = L[:-2] - L[2:]
    m = (d > 20) & nd.binary_erosion(solid, iterations=3) & ~g & (Y > 300) & (Y < 1290)
    lb, kb = nd.label(nd.binary_dilation(m, np.ones((1, 3))), structure=np.ones((3, 3)))
    bands = np.zeros_like(m)
    for i, sl in enumerate(nd.find_objects(lb)):
        mm = (lb[sl] == i + 1) & m[sl]
        xs = np.nonzero(mm.any(0))[0] + sl[1].start
        # главный карниз заходит на колонну (на её кольцо), мелкие кромки витражей — нет
        if xs.max() - xs.min() >= 40 and any((xs.min() <= x1) and (xs.max() >= x0) for x0, x1 in COLS):
            bands[sl] |= mm
    _ref[w] = dict(L=L, win=win, pod=pod, dome=dome, col=col, slit=slit, crown=crown, bands=bands, Y=Y, X=X)
    return _ref[w]


def _units(r, V):
    """Окна: витражи — по этажам, решётки — клетками, подиум — по окну. → [(маска, группа, тон, яркость)]."""
    win, L, Y, X = r['win'], r['L'], r['Y'], r['X']
    cum = np.cumsum(V['tone'])
    sky = Y - np.where(X < XC, SK, -SK) * (X - XC)          # «высота» вдоль этажа
    lab, k = nd.label(win)
    items = []

    def add(sel, key):
        if H('ga', VARIANT, key) > (V['pod'] if key[0] == 'p' else V['lit']): return
        t = int(np.searchsorted(cum, H('ga', 't', key) * cum[-1]))
        items.append((sel, int(H('ga', 'g', key) * NG), min(t, 2), np.clip(L * 0.6, 0, 255)))

    for i, sl in enumerate(nd.find_objects(lab)):
        m = np.zeros_like(win); m[sl] = lab[sl] == i + 1
        n = m.sum(); h = sl[0].stop - sl[0].start
        if n < 12: continue
        if r['pod'][m].any():
            add(m, ('p', i)); continue
        if n > 500 and h > 38:
            # витраж: полосы-этажи по линиям изометрии, между ними тёмная плита перекрытия
            f = sky[m]; f0 = f.min()
            fl = np.floor((sky - f0) / FL)
            gap = ((sky - f0) % FL) < 2.2
            for j in range(int((f.max() - f0) // FL) + 1):
                s = m & (fl == j) & ~gap
                if s.sum() >= 20: add(s, ('b', i, j))
            continue
        # мелкие стёкла решёток: квартира — клетка 26×20 px
        cx, cy = X[m].mean(), Y[m].mean()
        add(m, ('l', int(cx // 26), int(cy // 20)))
    return items


def _star(rgb, a):
    s = (rgb[..., 0] > 180) & (rgb[..., 1] > 150) & (rgb[..., 2] < 120) & (a > 120)
    return nd.binary_dilation(s, iterations=3)


def build(im):
    rgb, a, L, Y, X = parts(im)
    r = _anatomy(a.shape[1])
    V = VARIANTS[VARIANT]
    star = _star(rgb, a)
    win = win_layer(a.shape, [(m & ~star, g, t, b) for m, g, t, b in _units(r, V) if (m & ~star).sum() >= 12])
    e = np.zeros(rgb.shape)
    Lr = r['L']
    warm = np.array([255, 190, 110.]); gold = np.array([255, 205, 120.])
    teal = np.array([120, 215, 255.])
    if V['dome']:
        # купола: стекло светится изнутри, блики и рисунок стекла видны
        c = teal if V.get('cool') else gold
        e += halo(shaded(r['dome'] & ~star, c, Lr, lo=0.25, p=0.8, k=V['dome']), ((0.35, 3), (0.2, 9)))
    if V['slits']:
        c = teal if V.get('cool') else warm
        e += halo(shaded(r['slit'], c, Lr, lo=0.4, k=V['slits']), ((0.3, 2), (0.15, 6)))
    if V['cols']:
        # колонны: холодный свет изнутри, ярче к низу каждого стеклянного отрезка — видны кольца
        m = r['col'] & ~star
        lab, k = nd.label(m)
        w = np.zeros(a.shape)
        for i, sl in enumerate(nd.find_objects(lab)):
            mm = lab[sl] == i + 1
            yy = Y[sl]; y0, y1 = sl[0].start, sl[0].stop
            w[sl][mm] = (0.45 + 0.55 * ((yy - y0) / max(y1 - y0, 1)) ** 1.5)[mm]
        e += halo(shaded(m, teal, Lr, lo=0.35, k=V['cols']) * w[..., None], ((0.3, 3), (0.15, 10)))
    if V['crown']:
        # корона: прожекторы у основания, свет к верху спадает; грани меди различимы
        m = r['crown']
        f = np.clip((Y - 70) / 220, 0, 1) ** 1.4
        e += halo(shaded(m, warm, Lr, lo=0.3, p=1.0, k=V['crown']) * f[..., None], ((0.25, 4),))
    if V['bands']:
        n = np.zeros(rgb.shape); n[r['bands'] & ~star] = np.array([255, 195, 120.]) * V['bands']
        e += halo(n, ((0.45, 2), (0.15, 6)))
    bulb(e, X, Y, 376, 50, 4.5)   # авиаогонь
    return win, e
