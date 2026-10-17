# Инкубатор (все звёзды), ночь — вариант «Лунный фонарь» (17.10.2026): стеклянный конус внутри
# ажурной оболочки горит ровным холодным белым светом, к шпилю чуть мягче, линии перекрытий —
# белые, края проёмов оболочки подсвечены изнутри, на площадке — свет от основания, на макушке огонёк.
# Геометрия у всех звёзд одна, а цвета разные (у 3★ красная оболочка темнее стекла), поэтому проёмы,
# оболочка и площадка берутся с синей 1★, а линии и стёкла — по яркости своего кадра.
import numpy as np
from scipy import ndimage as nd
from .common import parts, halo, bulb

REF = 'COM_startup_hub_1_star.png'
CX, YB, YT = 378.0, 700.0, 8.0


def _ref_masks(w, h):
    import gen
    im = np.asarray(gen.sprite(REF, w)).astype(float)
    rgb, a, L, Y, X = parts(im)
    mx = rgb.max(-1); sat = (mx - rgb.min(-1)) / np.maximum(mx, 1)
    solid = a > 200
    gray = solid & (sat < 0.12) & (L > 140) & (L < 215)
    glass = solid & (L < 95) & (sat < 0.4)
    shell = solid & ~glass & ~gray & (sat > 0.18)
    reg = nd.binary_fill_holes(nd.binary_closing(glass, np.ones((7, 7))) & solid) & ~shell
    rest = solid & ~shell & ~reg
    lab, n = nd.label(rest)
    plate = lab == 1 + int(np.argmax(nd.sum(rest, lab, range(1, n + 1))))
    reg |= rest & ~plate & (sat < 0.2) & (L > 120)   # обрезки линий у краёв проёмов
    out = np.zeros((h, w, 3), bool)
    m = min(h, im.shape[0])
    for i, k in enumerate((shell, reg, plate)): out[:m, :, i] = k[:m]
    return out[..., 0], out[..., 1], out[..., 2]


def build(im):
    rgb, a, L, Y, X = parts(im)
    Hh, Ww = a.shape
    solid = a > 200
    shell, reg, plate = _ref_masks(Ww, Hh)
    shell &= solid; reg &= solid; plate &= solid
    # линии этажей — светлые на тёмном стекле, стекло — без чёрных стоек
    lines = reg & (L > 110)
    gl = L[reg & ~lines]
    pane = reg & ~lines & (L > 0.65 * np.median(gl))
    hole = nd.binary_fill_holes(solid) & ~solid
    d_open = nd.distance_transform_edt(~(reg | hole))
    th = np.clip((YB - Y) / (YB - YT), 0, 1)   # 0 у основания, 1 на макушке

    e = np.zeros_like(rgb)

    def paint(m, c, w):
        c = np.broadcast_to(np.asarray(c, float), rgb.shape)
        e[m] = np.maximum(e[m], c[m] * w[m][:, None])

    st = np.array([[170, 215, 255], [215, 235, 255], [240, 248, 255.]])
    pos = th * 2; i = np.clip(np.floor(pos).astype(int), 0, 1); f = (pos - i)[..., None]
    gc = st[i] * (1 - f) + st[i + 1] * f
    k = (0.72 - 0.2 * th) * (0.85 + 0.3 * np.clip((L - 40) / 25, 0, 1))
    paint(pane, gc, k)
    # линии светлее стёкол; у 2★/3★ они золотистые — оттенок своего цвета остаётся
    lc = 0.65 * 255 + 0.35 * rgb * 255 / np.maximum(rgb.max(-1, keepdims=True), 1)
    paint(lines, lc, np.ones_like(L))
    rim = shell & (d_open < 4)
    paint(rim, (150, 200, 255), 0.45 * np.clip(1 - d_open / 4, 0, 1) * (0.5 + 0.5 * np.clip(L / 200, 0, 1.3)))
    # свет от основания на площадке: эллипс по кругу конуса
    d = ((X - CX) / 250) ** 2 + ((Y - 640) / 125) ** 2
    paint(plate, (160, 200, 255), 0.35 * np.clip(1 - d, 0, 1) ** 1.6)
    bulb(e, X, Y, 383, 17, 4.5, (200, 240, 255))
    return np.zeros((Hh, Ww, 4), np.uint8), halo(e, [(0.4, 2), (0.22, 8)])
