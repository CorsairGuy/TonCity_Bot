# Инкубатор (все звёзды), ночь — вариант «Лунный фонарь» (17.10.2026): стеклянный конус внутри
# ажурной оболочки горит ровным холодным белым светом, к шпилю чуть мягче, сетка окон (этажи и стойки)
# во всех проёмах остаётся тёмной, края проёмов оболочки подсвечены изнутри, на площадке — свет от основания.
# Геометрия у всех звёзд одна, а цвета разные (у 3★ красная оболочка темнее стекла), поэтому проёмы,
# оболочка и площадка берутся с синей 1★, а линии сетки — по локальному контрасту своего кадра.
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
    # сетка окон: линии этажей и стойки — всё, что заметно светлее или темнее стекла вокруг; ночью
    # горят стёкла между ними, а сама сетка остаётся тёмной — так она видна во всех проёмах одинаково
    lm = nd.median_filter(np.where(reg, L, np.nan_to_num(L)), size=7)
    lines = reg & (np.abs(L - lm) > 7)
    pane = reg & ~lines
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
    k = 0.72 - 0.2 * th
    paint(pane, gc, k)
    rim = shell & (d_open < 4)
    paint(rim, (150, 200, 255), 0.45 * np.clip(1 - d_open / 4, 0, 1) * (0.5 + 0.5 * np.clip(L / 200, 0, 1.3)))
    # свет от основания на площадке: эллипс по кругу конуса
    d = ((X - CX) / 250) ** 2 + ((Y - 640) / 125) ** 2
    paint(plate, (160, 200, 255), 0.35 * np.clip(1 - d, 0, 1) ** 1.6)
    bulb(e, X, Y, 383, 17, 4.5, (200, 240, 255))
    e = halo(e, [(0.4, 2), (0.22, 8)])
    e[lines] *= 0.2   # ореол не замывает сетку
    return np.zeros((Hh, Ww, 4), np.uint8), e
