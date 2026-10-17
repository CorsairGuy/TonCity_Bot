# Ботанический сад (все звёзды), ночь: окон-квартир нет, сквозь стеклянный купол видно освещённую
# оранжерею — тёплый свет на растениях, дорожках и бассейне, рёбра каркаса остаются тёмными.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, blur

GAIN = 1.0    # сила света внутри
RIM = 0.50    # блик на рёбрах каркаса
REFL = 0.15   # отражение неба в стекле (к верху купола больше)

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
    # крашеные полы внутри купола — пятна, рёбра — тонкие линии
    floor = nd.binary_opening(hi, np.ones((9, 9))) & poly(a.shape, DOME)
    glass = poly(a.shape, ZONE) & solid & (~hi | floor)
    glass &= ~nd.binary_dilation(hi & ~floor, iterations=1)
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
    lightc = np.where(water[..., None], np.array([0.6, 0.85, 1.0]), np.array([1.0, 0.76, 0.46]))
    D = sat * lightc * GAIN
    # стекло: часть ночного неба отражается, к верху купола сильнее — свет изнутри видно сквозь стекло, а не вместо него
    base = rgb * np.array([62, 78, 140.]) / 255
    refl = np.clip(REFL + 0.25 * (0.45 - Y / Hh) / 0.35, REFL * 0.7, REFL + 0.25)
    c = np.clip(D * (1 - refl[..., None]) - base * (1 - refl[..., None]) * 0.8, 0, 255)
    e[glass] = c[glass] * gk[glass][:, None]
    # рёбра каркаса в своём цвете, подсвечены тёплым изнутри — купол читается как конструкция, как днём
    bars = poly(a.shape, DOME) & solid & hi & ~floor & ~glass
    bars = nd.binary_dilation(bars, iterations=1) & poly(a.shape, DOME) & solid & ~glass
    e[bars] = np.clip(rgb[bars] * np.array([1.0, 0.85, 0.7]) * RIM - base[bars] * 0.5, 0, 255)
    # небольшой фонарь у двери
    bulb(e, X, Y, 0.31 * Ww, 0.69 * Hh, 0.006 * Ww, (255, 215, 150))
    win = np.zeros(a.shape + (4,), np.uint8)
    # ореол только наружу и слабый: внутри купола он размывал бы рёбра
    return win, halo(e, [(0.06, 6)])
