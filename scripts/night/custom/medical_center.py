# Медицинский центр, ночь (18.10.2026, вариант 2): красный неон по кромкам крыш (как на рисунке
# пользователя), по заднему парапету верхней крыши от вертолёта до угла — одна ровная линия; буквы HOSPITAL
# горят белым без ореола. Навес входа без полосок, пятна света под ним и мигалки у скорой нет. Окна и
# красный крест на стене — прежние ключи разметки, этот модуль — {"t":"mod","mod":"medical_center"}.
import numpy as np
from scipy import ndimage as nd
from .common import parts, lines
from .neonkit import neon, poly, comps, clean, hull

RD = (255, 45, 45); WH = (235, 242, 255)


def emit(im, name):
    rgb, a, L, Y, X = parts(im); sh = a.shape
    r, g = rgb[..., 0], rgb[..., 1]
    sat = rgb.max(-1) - rgb.min(-1)
    sol = a > 200
    red = sol & (r - g > 60) & (r > 170)
    lab, k = comps(red); sz = nd.sum(red, lab, range(1, k + 1))
    big = np.isin(lab, np.nonzero(sz >= 1500)[0] + 1)
    hpad = sol & (((X - 342) / 56) ** 2 + ((Y - 117) / 31) ** 2 < 1)
    heli = sol & poly(sh, [(245, 0), (300, 0), (425, 38), (425, 95), (335, 98), (245, 45)]) & ((L < 120) | (r - g < 60))
    heli = nd.binary_dilation(heli, iterations=2)
    HP = poly(sh, [(250, 0), (300, 0), (420, 35), (420, 60), (300, 60), (250, 40)])  # корпус вертолёта над парапетом
    # парапеты крыш (большой корпус режется на две части по x=236): внешняя нижняя кромка и задний край
    parts_ = []
    lb, kb = comps(big)
    for i in range(1, kb + 1):
        m = lb == i
        parts_ += [m & (X < 236), m & (X >= 236)] if m.sum() > 12000 else [m]
    LO = np.zeros(sh, bool); IB = np.zeros(sh, bool)
    for m in parts_:
        if not m.any(): continue
        hm = hull(m)
        LO |= m & ~np.roll(hm, -3, 0)
        IB |= m & np.roll(hm & ~m, -3, 0) & np.roll(~red, -3, 0)
    LO = clean(LO & ~heli & ~HP, 30); IB = clean(IB & ~heli & ~HP & ~hpad, 30)
    # задний парапет верхней крыши от вертолёта до угла: внутренний край (стык с белой крышей), одна прямая
    blade = sol & (sat < 25) & (L < 200) & poly(sh, [(300, 0), (450, 0), (450, 75), (300, 75)])
    redm = red | (r - g > 60)
    inb = sol & (sat < 30) & (L > 195) & np.roll(redm, 2, 0) & (X > 362) & (X < 456) \
        & (np.abs(Y - (0.551 * X - 145.6)) < 5) & ~nd.binary_dilation(blade, iterations=2)
    yy, xx = np.nonzero(clean(inb, 8)); pf = np.polyfit(xx, yy, 1); x0, x1 = xx.min(), xx.max()
    back = (lines(sh, [[(x0, np.polyval(pf, x0)), (x1, np.polyval(pf, x1))]], 2.6) > 0.4) & ~nd.binary_dilation(blade, iterations=2)
    near = (np.abs(Y - np.polyval(pf, X)) < 7) & (X > 355) & (X < 462)
    canopy = poly(sh, [(195, 290), (340, 290), (340, 425), (195, 425)])  # навес входа — без неона
    ne = ((nd.binary_dilation(LO | IB, iterations=1) & ~near) | back) & ~canopy
    e = neon(ne, RD, 1.2)
    # буквы HOSPITAL: красное внутри белого щита вывески, без рамки
    signp = poly(sh, [(191, 316), (279, 353), (279, 388), (191, 349)])
    bg = sol & signp & (L > 170) & (sat < 40)
    lb, _ = comps(bg); bg = lb == np.bincount(lb[lb > 0]).argmax()
    let = nd.binary_erosion(hull(bg), iterations=1) & (r - g > 90) & sol
    e += np.where(let[..., None], np.array(WH, float) * 1.15, 0)
    return e
