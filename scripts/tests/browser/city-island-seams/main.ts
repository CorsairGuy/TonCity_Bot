import { islandClipRect, d1IslandRects, mainIslandRects, D1_ISLAND_SPRITES, MAIN_ISLAND_SPRITES } from '/client/cityIsland';
import { requestSprite, getPreparedSprite, pickMip } from '/client/components/mapSprites';
const api = window as any;
const canvas = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
api.synthetic = () => {
  let beforeErrors = 0, afterErrors = 0, maxAfterError = 0, cases = 0; const details: any[] = [];
  // pickMip гарантирует сжатие выбранного уровня не более 2:1.
  for (const scale of [.51, .87, 1.31, 1.97]) for (const dpr of [1, 2, 3]) for (const alpha of [255, 128, 40]) for (const night of [false, true]) {
    const r = scale * dpr, width = Math.ceil(200 * r) + 50, height = Math.ceil(80 * r) + 50;
    const image = canvas(240, 120), source = image.getContext('2d')!;
    for (let px = 0; px < 240; px++) { const v = px < 100 ? 0 : 100; source.fillStyle = night ? `rgba(${20+v},25,50,${alpha / 255})` : `rgba(${70+v},110,90,${alpha / 255})`; source.fillRect(px, 0, 1, 120); }
    const crop = (start: number, w: number) => { const c = canvas(w,80); c.getContext('2d')!.drawImage(image,start,0,w,80,0,0,w,80); return c; };
    const left=crop(0,100),right=crop(100,100),expandedLeft=crop(0,116),expandedRight=crop(84,116);
    const draw = (mode: 'reference' | 'before' | 'after') => {
      const c = canvas(width, height), x = c.getContext('2d')!; x.fillStyle = '#d8d8d8'; x.fillRect(0, 0, width, height); x.setTransform(r, 0, 0, r, 20.37, 20.23);
      if (mode === 'reference') x.drawImage(image, 0, 0, 200, 80, 0, 0, 200, 80);
      else for (const start of [0, 100]) {
        x.save();
        if (mode === 'after') { const p = islandClipRect({ x0: start, y0: 0, x1: start + 100, y1: 80 }, x.getTransform()); x.beginPath(); x.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0); x.clip(); x.drawImage(start===0?expandedLeft:expandedRight, start===0?0:84, 0); }
        else x.drawImage(start===0?left:right, start, 0);
        x.restore();
      }
      return x.getImageData(0, 0, width, height).data;
    };
    const ref = draw('reference'), before = draw('before'), after = draw('after'), seam = Math.round(100 * r + 20.37);
    for (let y = 23; y < Math.floor(80 * r + 20.23) - 2; y++) for (let x = seam - 2; x <= seam + 2; x++) for (let k = 0; k < 4; k++) {
      const i = (y * width + x) * 4 + k, error = Math.abs(after[i] - ref[i]); maxAfterError = Math.max(maxAfterError, error);
      if (Math.abs(before[i] - ref[i]) > 1) beforeErrors++; if (error > 1) { afterErrors++; if(details.length<30)details.push({scale,dpr,alpha,night,x,y,k,ref:ref[i],before:before[i],after:after[i],error}); }
    }
    cases++;
  }
  return { cases, beforeErrors, afterErrors, maxAfterError, details };
};
api.renderIsland = async (district: 'main' | 'd1', scale: number, dpr: number) => {
  const parts = (district === 'main' ? mainIslandRects : d1IslandRects)(0, 0, 90, 52), map = district === 'main' ? MAIN_ISLAND_SPRITES : D1_ISLAND_SPRITES;
  for (const p of parts) requestSprite(p.id, map[p.id], Math.ceil((p.x1 - p.x0) * 2 * dpr));
  const deadline = performance.now() + 45000;
  while (parts.some(p => !getPreparedSprite(p.id, Math.ceil((p.x1 - p.x0) * 2 * dpr)))) { if (performance.now() > deadline) throw Error('Sprite preparation timeout'); await new Promise(r => setTimeout(r, 20)); }
  const x0 = Math.min(...parts.map(p => p.core.x0)), y0 = Math.min(...parts.map(p => p.core.y0)), x1 = Math.max(...parts.map(p => p.core.x1)), y1 = Math.max(...parts.map(p => p.core.y1));
  const r = scale * dpr, c = canvas(1200, 900), x = c.getContext('2d')!;
  x.fillStyle = '#d8d8d8'; x.fillRect(0, 0, c.width, c.height);
  x.setTransform(r, 0, 0, r, c.width / 2 - (x0 + (x1 - x0) * .5) * r + .37, c.height / 2 - (y0 + (y1 - y0) * .65) * r + .23);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'low';
  for (const p of parts) { const w = p.x1 - p.x0, clip = islandClipRect(p.core, x.getTransform()); x.save(); x.beginPath(); x.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0); x.clip(); x.drawImage(pickMip(getPreparedSprite(p.id, Math.ceil(w * 2 * dpr))!, w * r), p.x0, p.y0, w, p.y1 - p.y0); x.restore(); }
  return c.toDataURL();
};
api.ready = true;
