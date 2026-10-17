# Генератор ночных ресурсов зданий (вариант В): для каждого спрайта — карта окон (окно, квартира,
# группа) и слой внешней подсветки. Ручные поправки по зданиям — ov/*.json (см. README.md в этой папке).
import json, sys, os, glob, colorsys, hashlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as nd

S = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(S + '/../..')
SPRITES = REPO + '/src/web/sprites'
NG = 8
W = 384  # ширина, в которой размечены здания (все доли и пиксельные пороги поправок — под неё)

_smap = None
_cache = {}


def sprite_map():
    global _smap
    if _smap is None:
        _smap = json.load(open(SPRITES + '/sprite-map.json'))
    return _smap


def sprite(n, w=W):
    """Кадр здания из атласа игры (src/web/sprites), уменьшенный до ширины w."""
    k = (n, w)
    if k not in _cache:
        e = sprite_map()[n]; f = e['frame']
        im = Image.open(SPRITES + '/' + e['atlas']).convert('RGBA').crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
        _cache[k] = im.resize((w, round(f['h'] * w / f['w'])), Image.LANCZOS)
    return _cache[k]


def load_ov():
    ov = {}
    for f in sorted(glob.glob(S + '/ov/*.json')):
        for k, v in json.load(open(f)).items():
            ov[k] = v
    return ov


def H(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


def rects_mask(shape, rects):
    h, w = shape
    m = np.zeros(shape, bool)
    for x0, y0, x1, y1 in rects:
        m[int(round(y0 * h)):int(round(y1 * h)), int(round(x0 * w)):int(round(x1 * w))] = True
    return m


def poly_mask(shape, polys):
    h, w = shape
    img = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(img)
    for p in polys:
        d.polygon([(x * w, y * h) for x, y in p], fill=255)
    return np.asarray(img) > 0


def windows(n, o, rgb, a):
    """Маска окон и номера окон (0 — не окно)."""
    Hh, Ww = a.shape
    if o.get('none'):
        return np.zeros(a.shape, np.int32), 0
    L = rgb @ [0.299, 0.587, 0.114]
    mx = rgb.max(-1); mn = rgb.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    solid = a > 220
    if 'colors' in o:
        # окна заданы цветами стекла: [r,g,b,допуск]
        m = np.zeros(a.shape, bool)
        for r, g, b, t in o['colors']:
            m |= (np.abs(rgb - [r, g, b]).max(-1) <= t)
        m &= solid
        if o.get('alsoAuto'):
            pass
    else:
        r_ = o.get('r', 7)
        loc = nd.uniform_filter(L, size=2 * r_ + 1)
        dark = L < loc - o.get('dk', 10)
        glass = (rgb[..., 2] > rgb[..., 0] + 14) & (sat > 0.14) & (mx < 240) & (mx > 35)
        m = (dark if o.get('noglass') else (dark | glass)) & solid
    if 'inc' in o or 'incp' in o:
        inc = np.zeros(a.shape, bool)
        if 'inc' in o: inc |= rects_mask(a.shape, o['inc'])
        if 'incp' in o: inc |= poly_mask(a.shape, o['incp'])
        m &= inc
    if 'ex' in o: m &= ~rects_mask(a.shape, o['ex'])
    if 'exp' in o: m &= ~poly_mask(a.shape, o['exp'])
    if o.get('close'): m = nd.binary_closing(m, np.ones((3, 3))) & solid  # залатать крапинки в стёклах
    if o.get('open'): m = nd.binary_opening(m, np.ones((2, 2)))
    lab, _ = nd.label(m, structure=np.ones((3, 3)) if o.get('conn8', True) else None)
    out = np.zeros(a.shape, np.int32)
    k = 0
    amin, amax, rep = o.get('amin', 5), o.get('amax', 500), o.get('rep', 4 if 'colors' not in o else 1)
    cand = []
    for i, sl in enumerate(nd.find_objects(lab)):
        reg = lab[sl] == i + 1
        area = int(reg.sum())
        if area < amin: continue
        h = sl[0].stop - sl[0].start; w = sl[1].stop - sl[1].start
        fill = area / (h * w)
        big = area > amax
        if big:
            if not o.get('split') or fill < o.get('bigfill', 0.5): continue
        elif fill < o.get('fill', 0.35) or h > Hh * 0.35 or w > Ww * 0.3:
            continue
        cand.append((i + 1, sl, reg, area, rgb[sl][reg].mean(0), big))
    keep = []
    for c in cand:
        if c[5] or rep <= 1:
            keep.append(c); continue
        sim = sum(1 for d in cand if not d[5] and np.abs(d[4] - c[4]).sum() < 45 and 0.4 < d[3] / c[3] < 2.5)
        if sim >= rep: keep.append(c)
    for idx, sl, reg, area, col, big in keep:
        if big:
            # стеклянная стена: режем по светлым переплётам, где они есть, иначе — сеткой
            cw, ch = o['split']
            ys, xs = np.nonzero(reg)
            cells = {}
            for y, x in zip(ys, xs):
                key = (x // cw, (y + int(o.get('skew', 0) * x)) // ch)
                cells.setdefault(key, []).append((y + sl[0].start, x + sl[1].start))
            for pts in cells.values():
                if len(pts) < 4: continue
                k += 1
                for y, x in pts: out[y, x] = k
        else:
            k += 1
            out[sl][reg] = k
    return out, k


def units(win, o):
    """Квартиры: соседние окна одного этажа объединяются, свет включают и гасят квартирами."""
    if win.max() == 0: return win, 0
    d = o.get('unit', 3)
    m = nd.binary_dilation(win > 0, np.ones((1 + 2 * (d // 3), 1 + 2 * d)))
    lab, n = nd.label(m)
    u = np.where(win > 0, lab, 0)
    return u, n


def emissive(n, o, rgb, a):
    """Слой внешней подсветки (RGBA, складывается поверх ночного спрайта)."""
    h, w = a.shape
    acc = np.zeros((h, w, 3))
    sil = (a > 0)
    for e in o.get('lights', []):
        t = e['t']
        col = np.array(e.get('c', [255, 196, 120]), float)
        g = e.get('g', 1.0)
        if t == 'emit':
            # светящиеся вывески, неон, витрины: пиксели прямоугольника (по цвету, если задан)
            rgb_, a_ = rgb, a
            if e.get('src'):
                # взять область с другого спрайта того же размера (одинаковая звезда у разных звёздностей)
                si = np.asarray(sprite(e['src'])).astype(float)
                rgb, a = si[..., :3], si[..., 3]
            m = rects_mask(a.shape, [e['r']]) & (a > 120)
            if e.get('ex'): m &= ~rects_mask(a.shape, e['ex'])
            if 'rgb' in e:
                r_, g_, b_, tol = e['rgb']
                m &= np.abs(rgb - [r_, g_, b_]).max(-1) <= tol
            if e.get('minsat'):
                mx = rgb.max(-1); mn = rgb.min(-1)
                m &= (mx - mn) / np.maximum(mx, 1) >= e['minsat']
            if e.get('minarea'):
                # отбросить мелкие куски (подоконники, лепнина) — светятся только длинные карнизы
                lab, k = nd.label(m)
                if k:
                    sz = nd.sum(m, lab, range(1, k + 1))
                    m &= np.isin(lab, np.nonzero(sz >= e['minarea'])[0] + 1)
            m0 = m.copy()
            if e.get('edge'):
                # неоновый контур: только кромка найденных областей шириной edge px
                m &= ~nd.binary_erosion(m, iterations=e['edge'])
            if e.get('lower'):
                # только нижние кромки (внешний край крыши над фасадом), без стыков со стенами выше
                full = m0 if e.get('edge') else m
                below = np.zeros_like(full); below[:-e['lower']] = full[e['lower']:]
                m &= ~below
            if e.get('shade'):
                # цвет c с рельефом исходника: грани остаются различимы, не заливаются плоским пятном
                # яркость растягивается на весь диапазон области, так что и бледная звезда получает объём
                L = rgb @ [0.299, 0.587, 0.114]
                lo, hi = (np.percentile(L[m], 3), np.percentile(L[m], 97)) if m.any() else (0, 255)
                t = np.clip((L - lo) / max(hi - lo, 1), 0, 1) ** e['shade']
                c = np.clip(col * (e.get('lo', 0.35) + (1 - e.get('lo', 0.35)) * t)[..., None] * e.get('k', 1.0), 0, 255)
            elif e.get('own', True):
                c = np.clip(rgb * e.get('k', 1.25) + e.get('add', 30), 0, 255)
            else:
                c = np.broadcast_to(col, rgb.shape)
            layer = np.where(m[..., None], c, 0) * g
            if e.get('fade'):
                # свет снизу: к верху прямоугольника яркость спадает (степень fade)
                y0, y1 = e['r'][1] * h, e['r'][3] * h
                layer = layer * (np.clip((np.arange(h) - y0) / max(y1 - y0, 1), 0, 1) ** e['fade'])[:, None, None]
            blur = np.asarray(Image.fromarray(layer.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(e.get('blur', 3)))).astype(float)
            acc += layer + blur * e.get('halo', 0.8)
            rgb, a = rgb_, a_
        elif t == 'spot':
            # пятно света на земле / стене: эллипс, сплюснутый под изометрию
            cx, cy, r = e['x'] * w, e['y'] * h, e.get('rad', 0.08) * w
            yy, xx = np.mgrid[0:h, 0:w]
            d = np.sqrt(((xx - cx) / r) ** 2 + ((yy - cy) / (r * e.get('sq', 0.58))) ** 2)
            f = np.clip(1 - d, 0, 1) ** 1.6
            acc += f[..., None] * col * g
        elif t == 'up':
            # подсветка фасада снизу вверх вдоль отрезка основания, только по силуэту здания
            x1, y1, x2, y2 = e['p']
            hh = e.get('h', 0.25) * h
            yy, xx = np.mgrid[0:h, 0:w].astype(float)
            X1, Y1, X2, Y2 = x1 * w, y1 * h, x2 * w, y2 * h
            tpar = np.clip(((xx - X1) * (X2 - X1)) / max((X2 - X1) ** 2, 1e-6), 0, 1)
            by = Y1 + (Y2 - Y1) * tpar
            inside = (xx >= min(X1, X2) - 2) & (xx <= max(X1, X2) + 2)
            dy = by - yy
            f = np.where(inside & (dy >= -2), np.clip(1 - dy / hh, 0, 1) ** 1.5, 0)
            # поперёк отрезка: ярче в середине каждого прожектора
            nsp = e.get('n', 0)
            if nsp:
                ph = (tpar * nsp) % 1
                f *= 0.45 + 0.55 * np.cos((ph - 0.5) * np.pi) ** 2
            acc += (f * sil)[..., None] * col * g * 0.8
        elif t == 'mod':
            # подсветка, нарисованная кодом (custom/<mod>.py, emit(кадр в родном размере, имя) → RGB с ореолом)
            import importlib
            f = sprite_map()[n]['frame']
            full = np.asarray(sprite(n, f['w'])).astype(float)
            ef = importlib.import_module('custom.' + e['mod']).emit(full, n)
            acc += np.asarray(Image.fromarray(ef.clip(0, 255).astype(np.uint8)).resize((w, h), Image.BOX)).astype(float) * g
        elif t == 'bulb':
            cx, cy, r = e['x'] * w, e['y'] * h, e.get('rad', 0.018) * w
            yy, xx = np.mgrid[0:h, 0:w]
            d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
            f = np.clip(1 - d, 0, 1) ** 1.2 + 0.5 * np.clip(1 - d / 3, 0, 1) ** 2
            acc += f[..., None] * col * g
    out = np.zeros((h, w, 4))
    out[..., :3] = acc.clip(0, 255)
    out[..., 3] = 255
    return out.astype(np.uint8)


def build(n, ov):
    o = ov.get(n, {})
    if 'same' in o:  # звёздные версии: те же правила, что у базового здания, плюс свои
        base = dict(ov.get(o['same'], {}))
        base.update({k: v for k, v in o.items() if k != 'same'})
        o = base
    if 'custom' in o:
        return build_custom(n, o)
    im = np.asarray(sprite(n)).astype(float)
    rgb, a = im[..., :3], im[..., 3]
    win, nw = windows(n, o, rgb, a)
    un, nu = units(win, o)
    # группа квартиры (0..7) — порядок, в котором гаснет свет ночью; цвет — тёплый/белый/холодный
    grp = np.zeros(win.shape, np.uint8); tone = np.zeros(win.shape, np.uint8)
    for u in range(1, nu + 1):
        hsh = H(f'{n}:{u}')
        sel = un == u
        grp[sel] = hsh % NG
        r = (hsh >> 8) % 100
        tone[sel] = 0 if r < o.get('warm', 70) else (1 if r < 88 else 2)
    em = emissive(n, o, rgb, a)
    return dict(o=o, im=im, win=win, nw=nw, un=un, nu=nu, grp=grp, tone=tone, em=em)


def build_custom(n, o):
    """Здание с ручной отрисовкой (custom/<модуль>.py): окна и подсветка считаются в родном размере
    кадра и уменьшаются до ширины W. Группы и тоны окон задаёт модуль (зеркальный рисунок)."""
    import importlib
    mod = importlib.import_module('custom.' + o['custom'])
    f = sprite_map()[n]['frame']
    full = np.asarray(sprite(n, f['w'])).astype(float)
    wf, ef = mod.build(full)
    small = sprite(n); w, h = small.size
    # окна: доля покрытия ≥ 35%, группа/тон/яркость — ближайший горящий пиксель исходника
    cov = np.asarray(Image.fromarray(wf[..., 3]).resize((w, h), Image.BOX)).astype(float)
    m = cov >= 90
    rgbx = np.stack([nd.grey_dilation(wf[..., c], size=(3, 3)) for c in range(3)], -1).astype(np.uint8)
    rgbx = np.asarray(Image.fromarray(rgbx).resize((w, h), Image.NEAREST)).astype(int)
    lab, nw = nd.label(m)
    grp = np.where(m, (rgbx[..., 1] >> 5).clip(0, NG - 1), 0).astype(np.uint8)
    tone = np.where(m, (rgbx[..., 2] // 80).clip(0, 2), 0).astype(np.uint8)
    em3 = np.asarray(Image.fromarray(ef.clip(0, 255).astype(np.uint8)).resize((w, h), Image.BOX)).astype(float)
    em = np.zeros((h, w, 4)); em[..., :3] = em3; em[..., 3] = 255
    im = np.asarray(small).astype(float)
    return dict(o=o, im=im, win=lab, nw=nw, un=lab, nu=nw, grp=grp, tone=tone, em=em.astype(np.uint8),
                wr=np.where(m, rgbx[..., 0], 0))


TONES = [np.array([255, 205, 130]), np.array([255, 236, 196]), np.array([206, 226, 255])]


def night_preview(b, lit_frac=0.7, tint=(62, 78, 140)):
    im = b['im'].copy(); rgb = im[..., :3]; a = im[..., 3]
    winm = b['win'] > 0
    L = rgb @ [0.299, 0.587, 0.114]
    base = rgb * np.array(tint) / 255
    base[winm] *= 0.55  # стекло без света ночью темнее
    on = winm & (b['grp'] < int(round(lit_frac * NG)))
    k = (0.75 + 0.5 * L / 255)[..., None]
    lit = np.zeros_like(rgb)
    for t in range(3):
        sel = on & (b['tone'] == t)
        lit[sel] = (TONES[t] * k[sel]).clip(0, 255)
    out = np.where(on[..., None], lit, base)
    out = (out + b['em'][..., :3] * (a[..., None] > 0) * 0.9 + b['em'][..., :3] * (a[..., None] == 0) * 0.9).clip(0, 255)
    alpha = np.maximum(a, (b['em'][..., :3].max(-1) > 8) * 255 * 0)
    return Image.fromarray(np.dstack([out, alpha]).astype(np.uint8))


def id_view(b):
    im = b['im'].copy(); im[..., :3] *= 0.4
    rng = np.random.default_rng(3)
    cols = (np.array([colorsys.hsv_to_rgb(rng.random(), 0.9, 1) for _ in range(b['nu'] + 1)]) * 255)
    m = b['un'] > 0
    im[m, :3] = cols[b['un'][m]]
    return Image.fromarray(im.clip(0, 255).astype(np.uint8))


def preview(names, out):
    ov = load_ov()
    rows = []
    for n in names:
        b = build(n, ov)
        day = sprite(n)
        ims = [day, id_view(b), night_preview(b)]
        hh = day.height + 18
        row = Image.new('RGB', (W * 3, hh), (205, 205, 205))
        row.paste(Image.new('RGB', (W, hh), (40, 44, 60)), (W * 2, 0))
        row.paste(Image.new('RGB', (W, hh), (70, 70, 70)), (W, 0))
        for k, im in enumerate(ims):
            row.paste(im, (k * W, 18), im)
        d = ImageDraw.Draw(row)
        d.text((4, 3), f'{n}  windows={b["nw"]} units={b["nu"]}', fill=(0, 0, 0))
        # сетка в долях спрайта на дневной картинке — для координат поправок
        for i in range(1, 10):
            x = int(W * i / 10); y = 18 + int(day.height * i / 10)
            d.line([(x, 18), (x, hh)], fill=(150, 150, 150) if i != 5 else (120, 120, 200))
            d.line([(0, y), (W, y)], fill=(150, 150, 150) if i != 5 else (120, 120, 200))
            d.text((x + 1, 19), f'.{i}', fill=(90, 90, 90)); d.text((1, y + 1), f'.{i}', fill=(90, 90, 90))
        rows.append(row)
    Hs = sum(r.height for r in rows)
    sheet = Image.new('RGB', (W * 3, Hs), (205, 205, 205))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out)


if __name__ == '__main__':
    # python3 gen.py preview out.png NAME [NAME...]
    if sys.argv[1] == 'preview':
        preview(sys.argv[3:], sys.argv[2])
    elif sys.argv[1] == 'pick':
        # python3 gen.py pick NAME x y [x y ...] — цвет пикселей (доли спрайта), среднее 3×3
        im = np.asarray(sprite(sys.argv[2])).astype(int)
        h, w = im.shape[:2]
        c = sys.argv[3:]
        for i in range(0, len(c), 2):
            x, y = int(float(c[i]) * w), int(float(c[i + 1]) * h)
            p = im[max(0, y - 1):y + 2, max(0, x - 1):x + 2].reshape(-1, 4)
            print(c[i], c[i + 1], 'rgba', p.mean(0).round().astype(int).tolist(), 'разброс', (p.max(0) - p.min(0)).tolist())
    elif sys.argv[1] == 'zoom':
        # python3 gen.py zoom NAME out.png x0 y0 x1 y1 — кусок спрайта ×3 с сеткой 0.02
        im = sprite(sys.argv[2]); w, h = im.size
        x0, y0, x1, y1 = [float(v) for v in sys.argv[4:8]]
        cr = im.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
        Z = 3; big = Image.new('RGBA', (cr.width * Z, cr.height * Z), (205, 205, 205, 255))
        big.paste(cr.resize((cr.width * Z, cr.height * Z), Image.NEAREST), (0, 0), cr.resize((cr.width * Z, cr.height * Z), Image.NEAREST))
        d = ImageDraw.Draw(big)
        import math
        for i in range(math.ceil(x0 / .02), int(x1 / .02) + 1):
            X = (i * .02 * w - int(x0 * w)) * Z; d.line([(X, 0), (X, big.height)], fill=(255, 0, 0, 90) if i % 5 else (255, 0, 0, 200)); d.text((X + 2, 2), f'{i*.02:.2f}', fill=(200, 0, 0))
        for i in range(math.ceil(y0 / .02), int(y1 / .02) + 1):
            Y = (i * .02 * h - int(y0 * h)) * Z; d.line([(0, Y), (big.width, Y)], fill=(0, 0, 255, 90) if i % 5 else (0, 0, 255, 200)); d.text((2, Y + 2), f'{i*.02:.2f}', fill=(0, 0, 200))
        big.save(sys.argv[3])
