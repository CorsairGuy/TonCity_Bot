# Сборка ночных слоёв карты города: карта окон и слой внешней подсветки всех размеченных зданий
# (ov/*.json) плюс фонари на дорожных тайлах. Результат — src/web/sprites/night/:
#   night-win.png   — окна: R — яркость стекла днём, G — группа квартиры (g*32+16), B — тон света
#                     (t*80+40), A=255 на пикселях окон;
#   night-emit.png  — внешняя подсветка (RGB на чёрном, складывается режимом 'lighter');
#   night.json      — {w, frames:{id:{x,y,w,h,ox,oy,sh}}, lamps:{asset:[[fx,fy],…]}}: где в атласах лежит
#                     вырезка здания и где она стоит внутри кадра шириной w (высота кадра sh).
# Запуск: python3 scripts/night/export.py   (нужны numpy, scipy, pillow)
import json, os, re, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen

OUT = gen.SPRITES + '/night'
AW = 2048


def lamps(n):
    """Фонари дорожного тайла: центры кусков тротуара (светлые тёплые пиксели), длинные куски — по два."""
    im = np.asarray(gen.sprite(n)).astype(int)
    h, w = im.shape[:2]
    r, g, b, a = im[..., 0], im[..., 1], im[..., 2], im[..., 3]
    m = (a > 200) & (r > 200) & (g > 190) & (b > 150) & (r - b > 12)
    from scipy import ndimage as nd
    lab, k = nd.label(m)
    out = []
    for i, sl in enumerate(nd.find_objects(lab)):
        ys, xs = np.nonzero(lab[sl] == i + 1)
        if len(xs) < w * h * 0.01: continue
        xs = xs + sl[1].start; ys = ys + sl[0].start
        cx, cy = xs.mean(), ys.mean()
        minx, maxx, miny, maxy = xs.min(), xs.max(), ys.min(), ys.max()
        if maxx - minx > w * 0.55:
            dxs = (maxx - minx) / 4
            slope = (maxy - miny) / (maxx - minx) * (1 if (cy < h / 2) == (cx < w / 2) else -1)
            out += [[(cx - dxs) / w, (cy - dxs * slope) / h], [(cx + dxs) / w, (cy + dxs * slope) / h]]
        else:
            out.append([cx / w, cy / h])
    return [[round(x, 4), round(y, 4)] for x, y in out]


def main():
    os.makedirs(OUT, exist_ok=True)
    smap = gen.sprite_map()
    ov = gen.load_ov()
    roads = json.load(open(gen.REPO + '/src/web/client/src/data/road-map.json'))
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
    road_assets = sorted({v['asset'] for v in roads.values() if not v.get('big')})
    lmp = {a: l for a in road_assets if a in smap and re.match(r'^(road|t_turn|turn|cross|roundabout)', a) for l in [lamps(a)] if l}
    Image.fromarray(win).save(OUT + '/night-win.png', optimize=True)
    # подсветка без потерь: webp с потерями даёт «грязь» вокруг ярких точек на чёрном
    Image.fromarray(emi).save(OUT + '/night-emit.png', optimize=True)
    json.dump({'w': gen.W, 'frames': frames, 'lamps': lmp}, open(OUT + '/night.json', 'w'), separators=(',', ':'))
    print(f'зданий {len(frames)}, окон {sum(it["nw"] for it in items.values())}, атлас {AW}×{AH}, '
          f'дорожных тайлов с фонарями {len(lmp)}')


if __name__ == '__main__':
    main()
