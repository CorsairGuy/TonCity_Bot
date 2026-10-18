# Городской банк (все звёзды), ночь — варианты «Ступени и колонны» + «Свет из-под карниза» (17.10.2026):
# тёплый свет стекает по стенам из-под карниза, из-под межэтажного пояса и козырька портика; по кромкам
# ступеней и цоколя — тёплые световые линии, колонны портика подсвечены снизу; звёзды заслоняют подсветку карниза.
# 18.10.2026: у букв BANK горит лицевая грань, боковины тёмные, стена за буквами без света — надпись читается;
# звёзды — насыщенное жёлтое золото, как у Великого Арканума. Пятна от фонаря у входа нет (решение владельца).
# Окна — по обычной разметке ov, фонтаны 2★/3★ — своими emit там же, отсюда только подсветка: {"t": "mod", "mod": "bank"}.
# Геометрия у всех звёзд одна, поэтому карниз, буквы, пояс и ступени берутся с базового спрайта.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo

REF = 'COM_bank.png'
WARM = np.array([255, 200, 140.])
FACE = np.array([255, 232, 160.])   # лицевые грани букв — светлое золото
SIDE = np.array([140, 80, 28.])     # боковины букв — тёмная медь: на ней читается контур каждой буквы
RINGS = ((0.15, 1.5),)              # ореол букв: узкий, чтобы буквы не слились в одно пятно
STAR_LO = 0.65     # яркость тёмных граней звезды относительно светлых
_ref = {}


def _sat(rgb):
    mx = rgb.max(-1); return (mx - rgb.min(-1)) / np.maximum(mx, 1)


def _gold(rgb, a, Y, ymax):
    sat = _sat(rgb)
    m = (sat > 0.42) & (rgb[..., 0] > rgb[..., 1] + 25) & (rgb[..., 1] > rgb[..., 2] + 30) & (a > 200)
    m[int(ymax * a.shape[0]):] = False
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
    # стена за буквами остаётся тёмной: светлые буквы читаются на тёмном
    back = nd.binary_dilation(let, iterations=10)
    _ref[w] = dict(rgb=rgb, back=back, tan=tan, corn=corn, let=let, filled=filled, cl=cl, ledge=pick([0, 2]), canopy=pick([3]), steps=pick([4, 5]), cols=cols)
    return _ref[w]


def _down(line, h, mask):
    """Свет, стекающий по стене вниз от линии на h px."""
    f = np.zeros(line.shape)
    for k in range(h):
        s = np.zeros(line.shape); s[k:] = line[:line.shape[0] - k]
        f = np.maximum(f, s * (1 - k / h) ** 1.8)
    return f * mask


def _relief(m, L, c, lo=0.35):
    e = np.zeros(L.shape + (3,))
    if m.any():
        a, b = np.percentile(L[m], 5), np.percentile(L[m], 95)
        e[m] = c * (lo + (1 - lo) * np.clip((L[m, None] - a) / max(b - a, 1), 0, 1))
    return e


def emit(im, name):
    rgb, a, L, Y, X = parts(im)
    r = _anatomy(a.shape[1])
    # звёзды — всё, чем верх звёздного спрайта отличается от базового (у базового звёзд нет)
    st = (np.abs(rgb - r['rgb']).max(-1) > 12) & (a > 200) & (Y < 0.4 * a.shape[0])
    st = nd.binary_opening(st, np.ones((3, 3)))
    hide = nd.binary_dilation(st, iterations=2)  # звёзды заслоняют подсветку карниза
    wall = (a > 200) & ~r['tan'] & ~r['filled'] & ~r['back']
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
    # буквы: горит только лицевая грань (во дне она темнее светлых боковин), боковины — тёмная медь;
    # ореол узкий, чтобы буквы не сливались в одно пятно
    let = r['let']; face = let & (L < 150)
    e[let] = 0
    side = np.zeros(rgb.shape); side[let & ~face] = SIDE
    e += halo(_relief(face, L, FACE, 0.8) + side, RINGS)
    # звёзды — как у Великого Арканума: насыщенное жёлтое золото с объёмом граней, мягкий ореол
    e[st] = 0
    e += halo(_relief(st, L, np.array([255, 210, 60.]), STAR_LO), ((0.4, 6),))
    return e
