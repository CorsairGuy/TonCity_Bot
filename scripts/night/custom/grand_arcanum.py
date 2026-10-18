# Великий Арканум (все звёзды), ночь — переделка 18.10.2026: прежний вариант (горят почти все стёкла
# витражей, неоновый контур по всем кромкам, корона залита) слепил. Первый набор вариантов отклонён, этот — второй.
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

# Варианты (второй заход 18.10.2026). lit — доля окон-кандидатов (вечером горят почти все кандидаты, к ночи
# гаснут), pod — то же для цоколя; tone — доли тёплого/белого/холодного света. Остальное — подсветки, 0 — нет:
#   wash  — прожекторы на каждом главном карнизе освещают медь яруса над ним (свет к верху яруса спадает),
#           washc/washc2 — цвет внизу/вверху башни (между ними — плавный переход по высоте);
#   crown — корона залита светом снизу; dome — стеклянные купола-шары; cols — стеклянные угловые колонны
#           светятся изнутри; slits — окна короны; rim — кромка крыши короны; glow — витражи светятся целиком
#           ровным светом изнутри (вместо отдельных окон); *c — цвет.
GOLD = (255, 190, 105); CYAN = (70, 215, 255); AMBER = (255, 170, 80); VIOLET = (175, 95, 255)
VARIANTS = {
    'empire': dict(lit=0.22, pod=0.3, tone=(0.6, 0.3, 0.1), wash=0.6, washc=GOLD, washc2=GOLD, crown=0.8,
                   crownc=GOLD, dome=0.6, domec=GOLD, slits=0.8, slitc=AMBER),
    'neon': dict(lit=0.22, pod=0.3, tone=(0.55, 0.35, 0.1), cols=0.95, colc=CYAN, dome=1.0, domec=CYAN,
                 slits=1.0, slitc=CYAN, rim=0.9, rimc=CYAN),
    'lantern': dict(lit=0, pod=0.35, tone=(0.6, 0.3, 0.1), glow=0.6, glowc=AMBER, crown=0.45, crownc=GOLD,
                    dome=0.5, domec=GOLD, slits=0.7, slitc=AMBER),
    'amethyst': dict(lit=0.22, pod=0.3, tone=(0.5, 0.35, 0.15), wash=0.6, washc=VIOLET, washc2=(255, 120, 200),
                     crown=0.85, crownc=GOLD, dome=0.7, domec=GOLD, slits=0.8, slitc=AMBER),
    'beacon': dict(lit=0.2, pod=0.3, tone=(0.6, 0.3, 0.1), crown=1.0, crownc=GOLD, rim=1.0, rimc=(255, 220, 150),
                   dome=1.0, domec=GOLD, slits=1.0, slitc=AMBER, cols=0.35, colc=AMBER),
}
VARIANT = 'empire'      # по умолчанию «Эмпайр»; остальные — варианты на выбор
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
    sky = Y - np.where(X < XC, SK, -SK) * (X - XC)
    # медь башни (опоры, импосты, карнизы) — от короны до крыши цоколя, без стекла
    copper = solid & ~g & (Y > 200) & (sky < 1285) & ~nd.binary_dilation(crown | top, iterations=1)
    dn = np.zeros_like(top); dn[:-4] = top[4:]
    rim = top & ~dn                                       # нижние (передние) кромки крыши короны
    _ref[w] = dict(L=L, win=win, pod=pod, dome=dome, col=col, slit=slit, crown=crown, Y=Y, X=X,
                   sky=sky, copper=copper, rim=rim, top=top)
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
    g = lambda k, d=0: V.get(k, d)
    c = lambda k: np.array(V[k], float)
    if g('wash'):
        # прожекторы у нижней кромки каждого яруса (высоты — «sky», по линиям этажей): карниз над ними залит
        # светом сильнее всего, выше по ярусу свет спадает до четверти; рельеф меди сохраняется
        sky = r['sky']; f = np.zeros(a.shape)
        S = (250, 490, 755, 1025, 1115, 1255, 1290)
        for s0, s1 in zip(S[:-1], S[1:]):
            t = np.clip((s1 - sky) / (s1 - s0), 0, 1)
            f = np.where((sky > s0) & (sky <= s1), 0.25 + 0.75 * (1 - t) ** 1.5, f)
        hgt = np.clip((1280 - sky) / 1000, 0, 1)[..., None]
        col = c('washc') * (1 - hgt) + c('washc2') * hgt
        m = r['copper'] & ~star
        e += halo(shaded(m, (1, 1, 1), Lr, lo=0.35, p=1.0, k=g('wash')) * col * f[..., None], ((0.2, 3), (0.1, 10)))
    if g('glow'):
        # витражи светятся целиком изнутри: видна фактура стекла, импосты тёмные
        m = r['win'] & ~r['pod'] & ~star
        e += halo(shaded(m, c('glowc'), Lr, lo=0.45, p=0.8, k=g('glow')), ((0.2, 3), (0.1, 9)))
    if g('crown'):
        m = r['crown']
        f = 0.35 + 0.65 * np.clip((Y - 70) / 220, 0, 1) ** 1.2
        e += halo(shaded(m, c('crownc'), Lr, lo=0.3, k=g('crown')) * f[..., None], ((0.3, 4), (0.12, 12)))
    if g('rim'):
        n = np.zeros(rgb.shape); n[r['rim']] = c('rimc') * g('rim')
        e += halo(n, ((0.6, 2), (0.25, 7)))
    if g('dome'):
        # купола — светящиеся шары: стекло светится изнутри, блики видны, вокруг мягкий ореол
        e += halo(shaded(r['dome'] & ~star, c('domec'), Lr, lo=0.45, p=0.7, k=g('dome')), ((0.45, 4), (0.25, 14)))
    if g('slits'):
        e += halo(shaded(r['slit'], c('slitc'), Lr, lo=0.5, k=g('slits')), ((0.35, 3), (0.15, 9)))
    if g('cols'):
        # колонны — световые трубки: ярче к низу каждого стеклянного отрезка, видны кольца
        m = r['col'] & ~star
        lab, k = nd.label(m)
        w = np.zeros(a.shape)
        for i, sl in enumerate(nd.find_objects(lab)):
            mm = lab[sl] == i + 1
            yy = Y[sl]; y0, y1 = sl[0].start, sl[0].stop
            w[sl][mm] = (0.55 + 0.45 * ((yy - y0) / max(y1 - y0, 1)) ** 1.5)[mm]
        e += halo(shaded(m, c('colc'), Lr, lo=0.45, k=g('cols')) * w[..., None], ((0.35, 3), (0.2, 11)))
    bulb(e, X, Y, 376, 50, 4.5)   # авиаогонь
    return win, e
