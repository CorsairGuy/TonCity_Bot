# Офисная башня (все звёзды), ночь — вариант «Неон по контуру» (17.10.2026): бирюзовые неоновые трубки
# по кромке крыши (обе плиты, без надстройки с лестницей и проёма в правой плите) и по трём вертикальным
# углам, стеклянная шахта лестницы светится холодным белым (этажи чуть разные), лобби у входов тёплые,
# звёзды на фасаде мягко подсвечены, у 2★ вокруг вертолётной площадки кольцо зелёных огней.
# Окна (двери на балконах) — по обычной разметке ov, отсюда только подсветка: {"t": "mod", "mod": "office_tower"}.
# Геометрия у всех звёзд одна, контур крыши берётся с базового спрайта (у 2★ на крыше солнечные панели).
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd
from .common import parts, halo, edge

REF = 'COM_office_tower.png'
NEON = np.array([60, 230, 255.])


def _poly(shape, pts):
    img = Image.new('L', (shape[1], shape[0]), 0); ImageDraw.Draw(img).polygon(pts, fill=255)
    return np.asarray(img) > 0


def _lines(shape, pls, w=2):
    """Непрерывные линии с антиалиасингом (рисуются в 4× и уменьшаются)."""
    S = 4; img = Image.new('L', (shape[1] * S, shape[0] * S), 0); d = ImageDraw.Draw(img)
    for pl in pls: d.line([(x * S, y * S) for x, y in pl], fill=255, width=w * S)
    return np.asarray(img.resize((shape[1], shape[0]), Image.BOX)) / 255 > 0.35


def _roof(w):
    import gen
    rgb, a, L, Y, X = parts(np.asarray(gen.sprite(REF, w)).astype(float))
    solid = a > 200
    rt = (L > 188) & solid & (Y < 275)
    lab, k = nd.label(rt)
    roof = np.isin(lab, np.nonzero(nd.sum(rt, lab, range(1, k + 1)) > 3000)[0] + 1)
    roof = nd.binary_fill_holes(nd.binary_closing(roof, np.ones((5, 5)), iterations=2) & solid)
    # кромка крыши без надстройки с лестницей, вертолётной площадки и проёма в правой плите
    excl = ((X > 393) & (X < 490)) | ((X >= 490) & (X < 600) & (Y > 125) & (Y < 212)) \
        | ((X >= 490) & (X < 558) & (Y <= 125)) | ((X >= 490) & (X < 525) & (Y < 218))
    return edge(roof, 2) & ~excl


def _stars(rgb, a, L):
    mx = rgb.max(-1); sat = (mx - rgb.min(-1)) / np.maximum(mx, 1)
    m = (sat > 0.42) & (rgb[..., 0] > rgb[..., 2] + 60) & (rgb[..., 1] > rgb[..., 2] + 30) & (rgb[..., 0] > rgb[..., 1] + 25) & (a > 200)
    m[int(0.6 * a.shape[0]):] = False  # ниже — скамейки и клумбы
    lab, k = nd.label(nd.binary_closing(m, np.ones((3, 3))))
    st = np.isin(lab, np.nonzero(nd.sum(np.ones_like(m), lab, range(1, k + 1)) >= 150)[0] + 1)
    st = nd.binary_fill_holes(st) & (a > 200)
    e = np.zeros(rgb.shape)
    if st.any():
        lo, hi = np.percentile(L[st], 5), np.percentile(L[st], 95)
        e[st] = np.array([255, 185, 80.]) * (0.3 + 0.6 * np.clip((L[st, None] - lo) / max(hi - lo, 1), 0, 1))
    return halo(e, ((0.35, 3), (0.15, 9)))


def _helipad(rgb, X, Y, cx=507, cy=97, rx=42, ry=24, n=14):
    e = np.zeros(rgb.shape)
    for i in range(n):
        t = 2 * np.pi * i / n
        d = np.hypot(X - (cx + np.cos(t) * (rx + 2)), Y - (cy + np.sin(t) * (ry + 1.5))) / 1.8
        e += (np.clip(1 - d, 0, 1) + 0.35 * np.clip(1 - d / 3, 0, 1) ** 2)[..., None] * np.array([120, 255, 140.])
    yel = (((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 < 1.05) & (rgb[..., 0] > 170) & (rgb[..., 2] < 160)
    e[yel] += rgb[yel] * np.array([1.0, 0.95, 0.6]) * 0.55  # разметка H в свете прожекторов
    return e


def emit(im, name):
    rgb, a, L, Y, X = parts(im)
    sh = a.shape
    e = np.zeros(rgb.shape)
    # неон: кромка крыши и вертикальные углы (левый — до крыши входа)
    tube = _roof(sh[1]) | _lines(sh, [[(172, 168), (172, 318)], [(547.5, 254), (547.5, 550)], [(678, 178), (678, 477)]])
    n = np.zeros(rgb.shape); n[tube] = NEON * 0.9
    e += halo(n, ((1.1, 2), (0.6, 6), (0.25, 14)))
    # шахта лестницы: стекло и ступени изнутри, этажи по ~58 px с разной яркостью
    s = (X >= 424) & (X <= 467) & (Y >= 200) & (Y < 497 + (X - 426) * 0.58) & (a > 200)
    var = np.array([0.95, 0.75, 1.0, 0.85, 0.6, 0.95, 0.8, 1.0, 0.9, 0.7])[np.clip(((Y - 205) // 58).astype(int), 0, 9)]
    glass = s & (L < 125); stair = s & (L >= 125)
    sl = np.zeros(rgb.shape)
    sl[glass] = np.array([200, 225, 255.]) * (0.25 + 0.45 * np.clip(L[glass] / 120, 0, 1))[:, None] * var[glass][:, None]
    sl[stair] = np.array([235, 240, 255.]) * (0.3 + 0.6 * np.clip((L[stair] - 125) / 110, 0, 1) ** 1.5)[:, None] * var[stair][:, None]
    e += halo(sl * 0.8, ((0.25, 3), (0.12, 9)))
    # лобби за стеклом входов и пятна света на земле у дверей
    lob = (_poly(sh, [(190, 345), (224, 362), (224, 492), (190, 476)]) | _poly(sh, [(604, 394), (647, 372), (647, 508), (604, 531)])) & (L > 70)
    c = np.array([255, 200, 130.]) * 0.7
    lb = np.zeros(rgb.shape); lb[lob] = c * (0.2 + 0.6 * np.clip((L[lob] - 70) / 110, 0, 1))[:, None]
    for cx, cy in ((212, 500), (625, 540)):
        d = np.sqrt(((X - cx) / 45) ** 2 + ((Y - cy) / (45 * 0.55)) ** 2)
        lb += (np.clip(1 - d, 0, 1) ** 1.6)[..., None] * c * 0.5
    e += halo(lb, ((0.3, 3), (0.15, 10)))
    e += _stars(rgb, a, L)
    if '2_star' in name: e += _helipad(rgb, X, Y)
    return e
