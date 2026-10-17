# Павильон удачи, ночь: окон нет. Тёплые гирлянды (каждая лампочка со своим ореолом), полосатый шатёр
# светится изнутри (белые полосы ярче, красные — красноватые, стены ярче крыши), золотая корона и
# тёплый свет из входа на крыльцо. Пятен света на земле нет.
import numpy as np
from scipy import ndimage as nd
from PIL import Image, ImageDraw
from .common import parts, halo, shaded

WARM = (255, 196, 105)


def poly(shape, pts):
    img = Image.new('L', (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon(pts, fill=255)
    return np.asarray(img) > 0


def build(im):
    rgb, a, L, Y, X = parts(im)
    sh = a.shape; r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    sol = a > 200
    # лампочки гирлянд: светло-жёлтые; тонкие жёлтые кромки крыши отбрасываются по размеру
    bl = sol & (r > 200) & (g > 200) & (r - b > 35) & (b < 225)
    lab, k = nd.label(bl)
    B = np.isin(lab, np.nonzero(nd.sum(bl, lab, range(1, k + 1)) >= 12)[0] + 1)
    core = B * np.clip((L - 150) / 105, 0.35, 1)  # объём лампочки
    bulbs = halo(core[..., None] * np.array(WARM, float) * 0.85, [(0.9, 1.5), (0.5, 4), (0.22, 10)])
    gold = sol & (r > 150) & (r - b > 45) & (g > 110) & (np.abs(r - g) < 70) & ~bl & (Y < 130)
    neutral = (rgb.max(-1) - rgb.min(-1) <= 3) & (np.abs(L - 204) < 8)
    pad = nd.binary_propagation(neutral & (Y > sh[0] - 40), mask=neutral) | ~sol
    tent = sol & ~pad & ~B & ~gold & (Y > 40)
    white = tent & (rgb.min(-1) > 150) & (rgb.max(-1) - rgb.min(-1) < 40)
    red = tent & ~white
    drum = tent & (Y > 300 - ((X - 420) / 330) ** 2 * 120)  # стены ниже кромки крыши
    roof = tent & ~drum
    inner = (shaded(white & drum, (255, 185, 110), L, lo=0.55, k=0.48) + shaded(red & drum, (255, 110, 60), L, lo=0.5, k=0.32)
             + shaded(white & roof, (255, 185, 110), L, lo=0.55, k=0.2) + shaded(red & roof, (255, 110, 60), L, lo=0.5, k=0.16))
    crown = shaded(gold, (255, 200, 90), L, lo=0.3, p=1.3, k=0.9)
    porch = poly(sh, [(195, 285), (250, 300), (270, 330), (270, 400), (240, 400), (205, 345), (185, 360), (180, 330)]) & sol & ~pad
    fall = np.clip(1 - np.hypot(X - 262, Y - 330) / 80, 0, 1) ** 1.2
    door = np.where(porch[..., None], np.array([255, 185, 110.]) * (0.35 + 0.65 * L / 255)[..., None] * fall[..., None] * 1.1, 0)
    em = halo(inner * 0.75, [(0.25, 3)]) + halo(crown * 0.8, [(0.5, 3), (0.25, 8)]) + halo(door * 0.8, [(0.4, 4)]) + bulbs
    return np.zeros(sh + (4,), np.uint8), em
