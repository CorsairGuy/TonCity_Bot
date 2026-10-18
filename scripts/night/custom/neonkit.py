# Помощники для неона, ламп и пятен света у зданий, нарисованных кодом (18.10.2026: полиция, пожарные,
# медцентр, Башня Сатоши, казино). Все координаты — в родном размере кадра атласа (ширина 753).
import numpy as np
from scipy import ndimage as nd
from PIL import Image, ImageDraw
from .common import halo, bulb, shaded, edge, lines, padmask, parts, H

NEON_RINGS = ((0.9, 2), (0.45, 5), (0.2, 12))


def neon(m, c, k=1.0, rings=NEON_RINGS):
    """Неоновая линия по маске m цвета c с ореолом."""
    return halo(m.astype(float)[..., None] * np.array(c, float) * k, list(rings))


def bulbs(sh, X, Y, pts, c, rad=3.5, k=1.0):
    e = np.zeros(sh + (3,))
    for x, y in pts: bulb(e, X, Y, x, y, rad, c)
    return halo(e * k, [(0.8, 3), (0.4, 9), (0.15, 20)])


def spotg(X, Y, cx, cy, r, c, g=0.5, sq=0.55):
    """Пятно света, сплюснутое под изометрию."""
    d = np.sqrt(((X - cx) / r) ** 2 + ((Y - cy) / (r * sq)) ** 2)
    return (np.clip(1 - d, 0, 1) ** 1.6)[..., None] * np.array(c, float) * g


def poly(sh, pts):
    img = Image.new('L', (sh[1], sh[0]), 0); ImageDraw.Draw(img).polygon([tuple(p) for p in pts], fill=255)
    return np.asarray(img) > 0


def ell_pts(cx, cy, rx, ry, n, a0=0):
    return [(int(cx + rx * np.cos(a0 + 2 * np.pi * i / n)), int(cy + ry * np.sin(a0 + 2 * np.pi * i / n))) for i in range(n)]


def comps(m):
    return nd.label(m, structure=np.ones((3, 3)))


def clean(m, mn=25):
    """Убрать куски меньше mn пикселей."""
    lab, k = comps(m)
    if not k: return m
    sz = nd.sum(m, lab, range(1, k + 1))
    return np.isin(lab, np.nonzero(sz >= mn)[0] + 1)


def region(rgb, a, x, y, tol=14):
    """Связная область цвета точки (x, y)."""
    c = rgb[y, x]; m = (np.abs(rgb - c).max(-1) <= tol) & (a > 200)
    lab, _ = nd.label(m)
    return lab == lab[y, x]


def hull(m):
    from scipy.spatial import ConvexHull
    ys, xs = np.nonzero(m); pts = np.stack([xs, ys], 1); h = ConvexHull(pts)
    return poly(m.shape, [tuple(pts[i]) for i in h.vertices])


def nowin(sh):
    return np.zeros(sh + (4,), np.uint8)
