# Штаб-квартира гильдии (столица): вместо сложного верха (большие стёкла и решётки над звездой)
# центральная грань продолжается обычной сеткой этажей до самой крыши (решение 17.10.2026).
# Правит атлас столицы в src/web/sprites на месте. После scripts/download-sprites.js запустить снова:
#   python3 scripts/night/patch_hq_sprite.py && python3 scripts/night/export.py
import json, math, os
import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPRITES = REPO + '/src/web/sprites'
NAME = 'CAP_guild_headquarters.png'
CX = 376                       # ось центральной грани
P0, PER = 373, 40.3            # линия этажа и шаг (как P_C в custom/guild_hq.py)
Y0, Y_END = 180, 505           # верх грани под крышей; сложный верх кончается над этой высотой


def main():
    e = json.load(open(SPRITES + '/sprite-map.json'))[NAME]; f = e['frame']
    path = SPRITES + '/' + e['atlas']
    atlas = Image.open(path).convert('RGBA')
    a = np.asarray(atlas.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))).astype(np.uint8)
    W = a.shape[1]

    def run(y):
        # центральная грань в строке: от оси до серых рёбер слева и справа
        r, g, b, al = a[y].astype(int).T
        gray = (np.abs(r - b) < 25) & (r > 50) & (al > 200)
        l = CX
        while l > 0 and not gray[l - 1]: l -= 1
        rr = CX
        while rr < W - 1 and not gray[rr + 1]: rr += 1
        return l, rr

    # образец — этаж под звездой, где грань чистая
    src0 = P0 + PER * (math.floor((790 - P0) / PER) + 1)
    y1 = int(round(P0 + PER * math.ceil((Y_END - P0) / PER)))
    b = a.copy()
    if run(300)[1] - run(300)[0] < 150:
        raise SystemExit('грань не найдена: спрайт изменился, проверьте координаты')
    for y in range(Y0, y1):
        fr = ((y - P0) / PER) % 1; ys = int(round(src0 + fr * PER))
        l, r = run(y); ls, rs = run(ys)
        idx = np.clip(np.round(np.linspace(0, 1, r - l + 1) * (rs - ls)).astype(int), 0, rs - ls)
        b[y, l:r + 1] = a[ys, ls:rs + 1][idx]
    atlas.paste(Image.fromarray(b), (f['x'], f['y']))
    atlas.save(path, optimize=True)
    print('штаб-квартира: верх перерисован, строки', Y0, '…', y1)


if __name__ == '__main__':
    main()
