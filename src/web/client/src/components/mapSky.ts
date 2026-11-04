// Небо за картой (утверждённый макет sky-middle-2, 04.11.2026): бирюзовое небо, облака в три слоя
// глубины под островами, свет слева сверху. Всё тяжёлое запечено заранее генератором
// scripts/sky/gen.py в src/web/sprites/sky/: бесшовная плитка облаков (свет, тени облаков друг на
// друга, дымка глубины), маски «что видно на каждом слое» и размытые силуэты островов.
// Здесь только сборка: плитка рисуется в мировых координатах (облака едут вместе с картой), тень
// каждого острова кладётся на каждый слой со своим сдвигом и размытием и видна только там, где этот
// слой виден сверху. Рисуется один раз на кусок карты, при движении куски не перерисовываются.
import type { Phase } from './mapNight';

type SkyLayer = { dx: number; dy: number; color: number[]; alpha: number };
type SkyCfg = {
  tile: string; tileWorld: number; masks: string[]; maskWorld: number; layers: SkyLayer[];
  shadows: Record<'main' | 'd1', { file: string; pad: number }[]>; avg: number[];
};
// мировой прямоугольник всей картинки острова — от него строится его тень
export type SkyIsland = { x0: number; y0: number; x1: number; y1: number; kind: 'main' | 'd1' };

const BASE = '/sprites/sky/';
let cfg: SkyCfg | null = null;
let tile: HTMLImageElement | null = null;
let masks: HTMLImageElement[] = [];
let shadows: Record<string, HTMLImageElement[]> = {};
let ready = false, loading: Promise<void> | null = null;
let avg = [135, 181, 198];
let off: HTMLCanvasElement | null = null;

function img(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = rej; i.src = BASE + src; });
}

// грузит набор один раз на страницу; onReady — когда можно перерисовать карту с облаками
export function loadSky(onReady: () => void) {
  if (ready) { onReady(); return; }
  if (!loading) loading = (async () => {
    const c = await (await fetch(BASE + 'sky.json')).json() as SkyCfg;
    const [t, m, sm, sd] = await Promise.all([
      img(c.tile), Promise.all(c.masks.map(img)),
      Promise.all(c.shadows.main.map(s => img(s.file))), Promise.all(c.shadows.d1.map(s => img(s.file))),
    ]);
    cfg = c; tile = t; masks = m; shadows = { main: sm, d1: sd }; avg = c.avg; ready = true;
  })();
  loading.then(onReady, e => { loading = null; console.warn('Небо карты не загрузилось', e); });
}

// ночью небо темнеет тем же цветом, что и спрайты (основа ступени суток), но мягче
function nightTint(ph: Phase | null): number[] | null {
  if (!ph || ph.isDay) return null;
  return ph.S.map(v => Math.round(255 - (255 - Math.min(255, v)) * 0.75));
}

// средний цвет неба — фон до загрузки, пелена фокуса и затенение городов
export function skyAvg(ph: Phase | null): string {
  const t = nightTint(ph);
  const c = t ? avg.map((v, i) => Math.round(v * t[i] / 255)) : avg;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function pattern(ctx: CanvasRenderingContext2D, im: HTMLImageElement, world: number): CanvasPattern | null {
  const p = ctx.createPattern(im, 'repeat');
  if (!p) return null;
  const k = world / im.naturalWidth;
  p.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
  return p;
}

// ctx уже в мировых координатах куска; [wx0..wx1]×[wy0..wy1] — мировой прямоугольник куска
export function paintSky(ctx: CanvasRenderingContext2D, wx0: number, wy0: number, wx1: number, wy1: number, islands: SkyIsland[], ph: Phase | null) {
  const w = wx1 - wx0, h = wy1 - wy0;
  if (!ready || !cfg || !tile) { ctx.fillStyle = skyAvg(ph); ctx.fillRect(wx0, wy0, w, h); return; }
  const tp = pattern(ctx, tile, cfg.tileWorld);
  ctx.fillStyle = tp ?? skyAvg(null); ctx.fillRect(wx0, wy0, w, h);
  if (islands.length) {
    const m = ctx.getTransform(), cw = ctx.canvas.width, ch = ctx.canvas.height;
    cfg.layers.forEach((L, i) => {
      const hits: [HTMLImageElement, number, number, number, number][] = [];
      for (const isl of islands) {
        const sh = cfg!.shadows[isl.kind]?.[i], im = shadows[isl.kind]?.[i];
        if (!sh || !im) continue;
        const x0 = isl.x0 + L.dx - sh.pad, y0 = isl.y0 + L.dy - sh.pad, x1 = isl.x1 + L.dx + sh.pad, y1 = isl.y1 + L.dy + sh.pad;
        if (x1 < wx0 || x0 > wx1 || y1 < wy0 || y0 > wy1) continue;
        hits.push([im, x0, y0, x1 - x0, y1 - y0]);
      }
      if (!hits.length) return;
      if (!off) off = document.createElement('canvas');
      if (off.width !== cw || off.height !== ch) { off.width = cw; off.height = ch; }
      const o = off.getContext('2d')!;
      o.setTransform(1, 0, 0, 1, 0, 0); o.globalCompositeOperation = 'source-over'; o.clearRect(0, 0, cw, ch);
      o.setTransform(m);
      for (const [im, x, y, ww, hh] of hits) o.drawImage(im, x, y, ww, hh);
      // цвет тени слоя, затем — только там, где этот слой виден сверху
      o.globalCompositeOperation = 'source-in';
      o.fillStyle = `rgba(${L.color[0]},${L.color[1]},${L.color[2]},${L.alpha})`; o.fillRect(wx0, wy0, w, h);
      const mp = pattern(o, masks[i], cfg!.maskWorld);
      if (mp) { o.globalCompositeOperation = 'destination-in'; o.fillStyle = mp; o.fillRect(wx0, wy0, w, h); }
      o.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.restore();
    });
  }
  const t = nightTint(ph);
  if (t) {
    ctx.save(); ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${t[0]},${t[1]},${t[2]})`; ctx.fillRect(wx0, wy0, w, h);
    ctx.restore();
  }
}
