# Городской банк (все звёзды), ночь — варианты «Ступени и колонны» + «Свет из-под карниза» (17.10.2026):
# тёплый свет стекает по стенам из-под карниза, из-под межэтажного пояса и козырька портика; по кромкам
# ступеней и цоколя — тёплые световые линии, колонны портика подсвечены снизу. Пятна от фонаря у входа нет.
# 18.10.2026: буквы BANK — канальные: горят только лицевые грани, борта и верх тёмные, без ореола (общим ореолом
# буквы сливались); звёзды на крыше — как у Великого Арканума: ярко-жёлтые с рельефом граней и слабым ореолом,
# ножка под звездой не светится.
# Окна — по обычной разметке ov, фонтаны 2★/3★ — своими emit там же, отсюда только подсветка: {"t": "mod", "mod": "bank"}.
# Геометрия у всех звёзд одна, поэтому карниз, буквы, пояс и ступени берутся с базового спрайта.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, blur

REF = 'COM_bank.png'
WARM = np.array([255, 200, 140.])
_ref = {}


def _sat(rgb):
    mx = rgb.max(-1); return (mx - rgb.min(-1)) / np.maximum(mx, 1)


def _stars(rgb, a, w):
    """Звёзды на крыше — всё, чем кадр отличается от базового спрайта выше пояса (вместе со светлыми гранями)."""
    import gen
    b = np.asarray(gen.sprite(REF, w)).astype(float)
    m = (np.abs(rgb - b[..., :3]).max(-1) > 20) & (a > 200)
    m[int(0.42 * a.shape[0]):] = False
    lab, k = nd.label(nd.binary_opening(m, np.ones((2, 2))))
    return nd.binary_fill_holes(np.isin(lab, np.nonzero(nd.sum(m, lab, range(1, k + 1)) >= 150)[0] + 1)) & (a > 200)


def _stem(st, Y, X):
    """Ножка-конус под каждой звездой: звёзды одного размера (65×86 в родном кадре), ножка — слева внизу рамки."""
    lab, _ = nd.label(st); m = np.zeros_like(st)
    for i, sl in enumerate(nd.find_objects(lab)):
        y0, x0 = sl[0].start, sl[1].start
        m |= (lab == i + 1) & (Y >= y0 + 62) & (X <= x0 + 38)
    return m


def _anatomy(w):
    if w in _ref: return _ref[w]
    import gen
    rgb, a, L, Y, X = parts(np.asarray(gen.sprite(REF, w)).astype(float))
    solid = a > 200
    # бежевый декор: карниз (самый большой кусок), буквы, рамы окон
    tan = (_sat(rgb) > 0.18) & solid & (rgb[..., 0] > rgb[..., 2] + 20)
    lab, k = nd.label(tan)
    corn = lab == 1 + int(np.argmax(nd.sum(tan, lab, range(1, k + 1))))
    let = tan & ~corn & (X > 225) & (X < 350) & (Y > 270) & (Y < 380) & ~((X > 300) & (Y < 297))
    ll, kk = nd.label(nd.binary_closing(let, np.ones((3, 3))))
    let &= np.isin(ll, np.nonzero(nd.sum(let, ll, range(1, kk + 1)) >= 120)[0] + 1)
    filled = nd.binary_fill_holes(corn); roof = filled & ~corn
    # нижняя кромка карниза над фасадом (без внутренней — над крышей)
    below = np.zeros_like(corn); below[:-2] = corn[2:]
    cl = corn & ~below & ~nd.binary_dilation(roof, iterations=3)
    # нижние кромки выступов: перепад яркости вниз, длинные куски. По порядку меток: 0, 2 — межэтажный
    # пояс, 1 — подоконник над портиком, 3 — козырёк портика, 4, 5 — цоколь и ступени
    d = np.zeros_like(L); d[:-2] = L[:-2] - L[2:]
    m = (d > 25) & nd.binary_erosion(solid, iterations=4) & ~nd.binary_dilation(tan, iterations=2)
    lb, kb = nd.label(nd.binary_dilation(m, np.ones((1, 3))), structure=np.ones((3, 3)))
    comps = [(lb == i + 1) & m for i, sl in enumerate(nd.find_objects(lb)) if sl[1].stop - sl[1].start >= 40]
    pick = lambda ids: np.any([comps[i] for i in ids], axis=0)
    cols = (((X >= 237) & (X <= 251) & (Y >= 340) & (Y <= 436)) | ((X >= 317) & (X <= 334) & (Y >= 372) & (Y <= 475))) & (L > 140) & solid
    _ref[w] = dict(tan=tan, corn=corn, let=let, filled=filled, cl=cl, ledge=pick([0, 2]), canopy=pick([3]), steps=pick([4, 5]), cols=cols)
    return _ref[w]


def _down(line, h, mask):
    """Свет, стекающий по стене вниз от линии на h px."""
    f = np.zeros(line.shape)
    for k in range(h):
        s = np.zeros(line.shape); s[k:] = line[:line.shape[0] - k]
        f = np.maximum(f, s * (1 - k / h) ** 1.8)
    return f * mask


def emit(im, name):
    rgb, a, L, Y, X = parts(im)
    r = _anatomy(a.shape[1])
    st = _stars(rgb, a, a.shape[1])
    hide = nd.binary_dilation(st, iterations=2)  # звёзды заслоняют подсветку карниза
    wall = (a > 200) & ~r['tan'] & ~r['filled']
    e = np.zeros(rgb.shape)
    # свет из-под карниза и полоска у его нижней кромки
    cl = r['cl'] & ~hide
    e += _down(cl, 45, wall)[..., None] * WARM * 0.7
    n = np.zeros(rgb.shape); n[cl] = np.array([255, 210, 150.]) * 0.6; e += halo(n, ((0.6, 2),))
    # из-под пояса и козырька портика
    e += _down(r['ledge'] | r['canopy'], 30, wall)[..., None] * WARM * 0.55
    # световые линии по кромкам ступеней и цоколя
    n = np.zeros(rgb.shape); n[r['steps']] = np.array([255, 200, 130.]) * 0.85
    e += halo(n, ((0.7, 2), (0.3, 5)))
    # колонны: свет снизу, к капители слабее
    yb = np.where(X < 290, 436, 475)
    c = r['cols']; cv = np.zeros(rgb.shape)
    cv[c] = np.array([255, 205, 140.]) * (0.2 + 0.45 * np.clip((L[c] - 140) / 90, 0, 1))[:, None] * np.clip(1 - (yb - Y) / 110, 0.15, 1)[c][:, None]
    e += halo(cv, ((0.35, 3), (0.15, 9)))
    # буквы: лицевые грани (тёмные в дневном спрайте) горят тёплым белым, борта и верх почти не светятся
    m = r['let']; ln = np.zeros(rgb.shape)
    front = m & (L < 165); side = m & (L >= 165) & (L < 190); top = m & (L >= 190)
    ln[front] = np.array([255, 215, 140.]) * (0.85 + 0.15 * np.clip((L[front] - 120) / 45, 0, 1))[:, None]
    ln[side] = np.array([255, 180, 90.]) * 0.07; ln[top] = np.array([255, 190, 110.]) * 0.1
    e[m] = 0; e += ln + blur(ln, 1.2) * 0.35
    # звёзды как у Арканума: цвет 255,210,60, рельеф граней (shade 1.5, lo 0.4), ореол 0.4
    sv = np.zeros(rgb.shape)
    if st.any():
        lo, hi = np.percentile(L[st], 3), np.percentile(L[st], 97)
        sv[st] = np.array([255, 210, 60.]) * (0.4 + 0.6 * np.clip((L[st] - lo) / max(hi - lo, 1), 0, 1) ** 1.5)[:, None]
    sv[_stem(st, Y, X)] = 0  # ножка звезды не светится (решение владельца)
    e[st] = 0; e += sv + blur(sv, 6) * 0.4
    return e
