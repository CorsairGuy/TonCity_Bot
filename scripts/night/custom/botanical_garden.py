# Ботанический сад (все звёзды), ночь: окон-квартир нет, сквозь стеклянный купол видно освещённую
# оранжерею — тёплый свет на растениях, дорожках и бассейне, рёбра каркаса остаются тёмными.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, blur

GAIN = 1.5    # сила света внутри
REFL = 0.06   # отражение неба в стекле (к верху купола больше)

# оранжерея в долях кадра: купол, стеклянные стены спереди, справа и сзади (лишнее отсекут рёбра и корпус)
ZONE = [(0.22, 0.12), (0.30, 0.05), (0.73, 0.38), (0.73, 0.63), (0.60, 0.71), (0.44, 0.71), (0.29, 0.61),
        (0.21, 0.45)]
DOME = [(0.300, 0.090), (0.372, 0.124), (0.695, 0.410), (0.640, 0.522), (0.515, 0.626), (0.405, 0.640),
        (0.292, 0.560), (0.238, 0.426), (0.238, 0.320), (0.275, 0.176)]
STARS = ['SER_botanical_garden.png', 'SER_botanical_garden_1_star.png', 'SER_botanical_garden_2_star.png',
         'SER_botanical_garden_3_star.png']


def poly(shape, pts):
    from PIL import Image, ImageDraw
    h, w = shape
    img = Image.new('L', (w, h), 0)
    ImageDraw.Draw(img).polygon([(x * w, y * h) for x, y in pts], fill=255)
    return np.asarray(img) > 0


def build(im):
    rgb, a, L, Y, X = parts(im)
    Hh, Ww = a.shape
    solid = a > 200
    # все звёзды — одна и та же картинка в разных цветах каркаса: что совпадает у всех четырёх — это
    # интерьер за стеклом, что расходится — покрашенный каркас и корпус
    import gen
    S = np.stack([np.asarray(gen.sprite(n, Ww)).astype(float)[..., :3] for n in STARS])
    sd = S.std(0).mean(-1)
    inner = S.mean(0)          # средний по звёздам цвет — интерьер без тона стекла
    hi = sd >= 14
    # каркас: отклонение цвета по звёздам целиком повторяет цвет верхней балки (k≈1) — рёбра, обод, стойки;
    # рёбра купола крашены иначе, чем балка, но сильнее всего прочего (большой остаток res). Крашеные полы
    # и стекло окрашены слабее (k≈0.4..0.7, res≈0.3) — так рёбра находятся и над полом, и над бассейном
    d = (S - inner[None]).transpose(1, 2, 0, 3).reshape(Hh, Ww, 12)
    fr = d[int(0.19 * Hh):int(0.21 * Hh), int(0.45 * Ww):int(0.47 * Ww)].reshape(-1, 12).mean(0)
    fn = np.linalg.norm(fr); fu = fr / fn
    pr = d @ fu
    k = pr / fn
    res = np.linalg.norm(d - pr[..., None] * fu, axis=-1) / fn
    frame = solid & ((k > 0.9) | (res > 0.45))
    frame = nd.binary_closing(frame, iterations=1)
    dome = poly(a.shape, DOME)
    # под куполом стекло и крашеные полы, в стенах — только то, что у всех звёзд одинаково
    glass = poly(a.shape, ZONE) & solid & ~frame & (~hi | dome)
    lab, n = nd.label(glass)
    sz = nd.sum(glass, lab, range(1, n + 1))
    glass &= np.isin(lab, 1 + np.nonzero(sz >= 25)[0])
    Li = inner @ [0.299, 0.587, 0.114]
    gk = np.clip(blur(glass[..., None].astype(float), 0.8)[..., 0] * 1.4 - 0.2, 0, 1) * glass
    e = np.zeros_like(rgb)
    # цвет за стеклом: интерьер с лёгким тоном стекла своей звезды
    col = inner * 0.65 + rgb * 0.35
    Lc = col @ [0.299, 0.587, 0.114]
    sat = np.clip(Lc[..., None] + (col - Lc[..., None]) * 1.2, 0, 255)
    water = (inner[..., 2] > inner[..., 0] + 25) & (inner[..., 2] > inner[..., 1] + 5) & (Y > 0.47 * Hh)
    # только сам бассейн: тонкие голубоватые колонны рядом с ним светятся тёплым, как всё вокруг
    water = nd.binary_opening(water, np.ones((7, 7)))
    water = nd.binary_dilation(water, iterations=2) & (inner[..., 2] > inner[..., 0] + 25)
    lightc = np.where(water[..., None], np.array([0.6, 0.85, 1.0]), np.array([1.0, 0.76, 0.46]))
    D = sat * lightc * GAIN
    # стекло: часть ночного неба отражается, к верху купола сильнее — свет изнутри видно сквозь стекло, а не вместо него
    base = rgb * np.array([62, 78, 140.]) / 255
    refl = np.clip(REFL + 0.25 * (0.45 - Y / Hh) / 0.35, REFL * 0.7, REFL + 0.25)
    c = np.clip(D * (1 - refl[..., None]) - base * (1 - refl[..., None]) * 0.8, 0, 255)
    e[glass] = c[glass] * gk[glass][:, None]
    win = np.zeros(a.shape + (4,), np.uint8)
    # ореол слабый, и на каркас не ложится: балки непрозрачные, ночью они в цвет здания
    e = halo(e, [(0.06, 6)])
    e[frame & poly(a.shape, ZONE)] = 0
    # небольшой фонарь у двери
    bulb(e, X, Y, 0.31 * Ww, 0.69 * Hh, 0.006 * Ww, (255, 215, 150))
    return win, e
