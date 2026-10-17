# Ботанический сад (все звёзды), ночь: окон-квартир нет, сквозь стеклянный купол видно освещённую
# оранжерею — тёплый свет на растениях, дорожках и бассейне, рёбра каркаса остаются тёмными.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb, blur

# свет внутри: 'warm' — ровный тёплый везде, 'grow' — растения под фитолампами, полы тёплые
LIGHT = 'warm'

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
    # насыщеннее: интерьер в спрайте пастельный, под тёплым светом краски гуще
    sat = np.clip(Li[..., None] + (inner - Li[..., None]) * 1.7, 0, 255)
    # бассейн внизу купола; голубое выше — стеклянные перила галереи, их светим как всё остальное
    water = (inner[..., 2] > inner[..., 0] + 25) & (inner[..., 2] > inner[..., 1] + 5) & (Y > 0.47 * Hh)
    lightc = np.where(water[..., None], np.array([0.55, 0.9, 1.0]), np.array([1.0, 0.8, 0.5]))
    if LIGHT == 'warm':
        # ровный тёплый свет по всей оранжерее
        D = sat * lightc * 1.05
    else:
        # растения под белым светом фитоламп, дорожки и полы — тёплым
        plant = (inner[..., 1] > inner[..., 0] + 6) & (inner[..., 1] > inner[..., 2] + 6) & ~water
        plant = nd.binary_opening(plant, np.ones((2, 2)))
        lc = np.where(plant[..., None], np.array([0.85, 1.0, 0.75]), lightc)
        D = sat * lc * 1.05
    # ночью под стеклом уже лежит тонированный спрайт: добавляем ровно то, чего до нужного цвета не хватает
    base = rgb * np.array([62, 78, 140.]) / 255
    c = np.clip(D - base, 0, 255)
    e[glass] = c[glass] * gk[glass][:, None]
    # небольшой фонарь у двери
    bulb(e, X, Y, 0.31 * Ww, 0.69 * Hh, 0.006 * Ww, (255, 215, 150))
    win = np.zeros(a.shape + (4,), np.uint8)
    return win, halo(e, [(0.18, 2), (0.08, 8)])
