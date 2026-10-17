# Сборка ночных слоёв карты города: карта окон и слой внешней подсветки всех размеченных зданий
# (ov/*.json) плюс фонари на дорожных тайлах. Результат — src/web/sprites/night/:
#   night-win.png   — окна: R — яркость стекла днём, G — группа квартиры (g*32+16), B — тон света
#                     (t*80+40), A=255 на пикселях окон;
#   night-emit.png  — внешняя подсветка (RGB на чёрном, складывается режимом 'lighter');
#   night.json      — {w, frames:{id:{x,y,w,h,ox,oy,sh}}, lamps:{asset:[[fx,fy],…]}}: где в атласах лежит
#                     вырезка здания и где она стоит внутри кадра шириной w (высота кадра sh).
# Запуск: python3 scripts/night/export.py   (нужны numpy, scipy, pillow); --lamps — пересчитать только фонари
import json, os, re, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen

OUT = gen.SPRITES + '/night'
AW = 2048


def lamps(n):
    """Фонари дорожного тайла: [fx, fy] — доли кадра.

    Тротуар (светлые тёплые пиксели) переводится в координаты клетки (u — вдоль x сетки, v — вдоль y),
    фонарь ставится у бордюра: на полосе вдоль дороги — один на клетку, по разные стороны дороги
    вразбежку (на четверти и на трёх четвертях клетки, рядом — если там дерево), на углу квартала — у угла
    бордюра, на повороте — на середине дуги. Островок посреди дороги (кольцо) без фонаря."""
    from scipy import ndimage as nd
    im = np.asarray(gen.sprite(n)).astype(int)
    h, w = im.shape[:2]
    r, g, b, a = im[..., 0], im[..., 1], im[..., 2], im[..., 3]
    walk = (a > 200) & (r > 200) & (g > 190) & (b > 150) & (r - b > 12)
    asph = (a > 200) & (abs(r - g) < 12) & (abs(g - b) < 14) & (r > 60) & (r < 150)
    tree = (a > 200) & ~walk & ~asph & (((g > r + 10) & (g > b)) | ((r > g) & (g > b) & (r < 190) & (r - b > 40)))
    hd = w * 434 / 753; oy = h - hd  # ромб клетки — нижние hd пикселей кадра (выше — кроны деревьев)
    yy, xx = np.mgrid[0:h, 0:w]
    fx = (xx + .5) / w; fy = (yy + .5 - oy) / hd
    U = fy + fx - .5; V = fy - fx + .5
    au, av = U[asph].mean(), V[asph].mean()
    near = nd.binary_dilation(asph, iterations=10)
    I = .07  # отступ от бордюра вглубь тротуара

    def clear(u, v):  # столб не упирается в дерево
        x = int((.5 + (u - v) / 2) * w); y = int(oy + (u + v) / 2 * hd)
        return not tree[max(0, y - int(.6 * hd)):y + 3, max(0, x - 4):x + 5].any()

    def along(f, t0):
        for t in (t0, .5, 1 - t0, .15, .85):
            if clear(*f(t)): return f(t)
        return None

    lab, k = nd.label(walk)
    out = []
    for i in range(1, k + 1):
        m = lab == i
        if m.sum() < w * h * 0.01: continue
        u, v = U[m], V[m]
        u0, u1, v0, v1 = np.percentile(u, 2), np.percentile(u, 98), np.percentile(v, 2), np.percentile(v, 98)
        if min(u0, v0) > .1 and max(u1, v1) < .9: continue
        cu, cv = u.mean(), v.mean()
        if u1 - u0 > .7 and v1 - v0 < .45:
            vv = v1 - I if cv < av else v0 + I
            p = along(lambda t: (t, vv), .25 if cv < av else .75)
            if p: out.append(p)
        elif v1 - v0 > .7 and u1 - u0 < .45:
            uu = u1 - I if cu < au else u0 + I
            p = along(lambda t: (uu, t), .25 if cu < au else .75)
            if p: out.append(p)
        elif u1 - u0 < .45 and v1 - v0 < .45:
            out.append((u1 - I if cu < au else u0 + I, v1 - I if cv < av else v0 + I))
        else:
            c = m & near
            pu, pv = U[c], V[c]
            ang = np.angle(np.exp(1j * (np.arctan2(pv - av, pu - au) - np.arctan2(cv - av, cu - au))))
            j = np.argsort(ang)[len(ang) // 2]
            d = np.hypot(pu[j] - au, pv[j] - av)
            out.append((pu[j] + (pu[j] - au) / d * I, pv[j] + (pv[j] - av) / d * I))
    return [[round(.5 + (u - v) / 2, 4), round((oy + (u + v) / 2 * hd) / h, 4)] for u, v in out]


def road_lamps(smap):
    roads = json.load(open(gen.REPO + '/src/web/client/src/data/road-map.json'))
    road_assets = sorted({v['asset'] for v in roads.values() if not v.get('big')})
    return {a: l for a in road_assets if a in smap and re.match(r'^(road|t_turn|turn|cross|roundabout)', a) for l in [lamps(a)] if l}


def main():
    if '--lamps' in sys.argv:  # только фонари: слои зданий в night.json остаются как есть
        j = json.load(open(OUT + '/night.json'))
        j['lamps'] = road_lamps(gen.sprite_map())
        json.dump(j, open(OUT + '/night.json', 'w'), separators=(',', ':'))
        print(f'дорожных тайлов с фонарями {len(j["lamps"])}')
        return
    os.makedirs(OUT, exist_ok=True)
    smap = gen.sprite_map()
    ov = gen.load_ov()
    items = {}
    for n in sorted(ov):
        if n not in smap: continue
        b = gen.build(n, ov)
        wm = b['win'] > 0
        em = b['em'][..., :3]
        on = wm | (em.max(-1) > 4)
        if not on.any(): continue
        ys, xs = np.nonzero(on)
        y0, y1, x0, x1 = max(0, ys.min() - 1), ys.max() + 2, max(0, xs.min() - 1), xs.max() + 2
        L = b['im'][..., :3] @ [0.299, 0.587, 0.114]
        win = np.zeros(wm.shape + (4,), np.uint8)
        win[..., 0] = np.where(wm, b.get('wr', L), 0)
        win[..., 1] = np.where(wm, b['grp'].astype(int) * 32 + 16, 0)
        win[..., 2] = np.where(wm, b['tone'].astype(int) * 80 + 40, 0)
        win[..., 3] = np.where(wm, 255, 0)
        items[n] = dict(win=win[y0:y1, x0:x1], em=em[y0:y1, x0:x1], ox=int(x0), oy=int(y0), sh=int(wm.shape[0]), nw=int(b['nw']))
    # раскладка по полкам, высокие первыми
    x = y = sh = 0
    for n in sorted(items, key=lambda n: -items[n]['win'].shape[0]):
        h, w = items[n]['win'].shape[:2]
        if x + w > AW: x = 0; y += sh; sh = 0
        items[n]['x'], items[n]['y'] = x, y
        x += w; sh = max(sh, h)
    AH = y + sh
    win = np.zeros((AH, AW, 4), np.uint8); emi = np.zeros((AH, AW, 3), np.uint8)
    frames = {}
    for n, it in items.items():
        h, w = it['win'].shape[:2]
        win[it['y']:it['y'] + h, it['x']:it['x'] + w] = it['win']
        emi[it['y']:it['y'] + h, it['x']:it['x'] + w] = it['em']
        frames[n] = {'x': it['x'], 'y': it['y'], 'w': w, 'h': h, 'ox': it['ox'], 'oy': it['oy'], 'sh': it['sh']}
    lmp = road_lamps(smap)
    Image.fromarray(win).save(OUT + '/night-win.png', optimize=True)
    # подсветка без потерь: webp с потерями даёт «грязь» вокруг ярких точек на чёрном
    Image.fromarray(emi).save(OUT + '/night-emit.png', optimize=True)
    json.dump({'w': gen.W, 'frames': frames, 'lamps': lmp}, open(OUT + '/night.json', 'w'), separators=(',', ':'))
    print(f'зданий {len(frames)}, окон {sum(it["nw"] for it in items.values())}, атлас {AW}×{AH}, '
          f'дорожных тайлов с фонарями {len(lmp)}')


if __name__ == '__main__':
    main()
