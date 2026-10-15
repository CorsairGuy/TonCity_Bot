import { memo, useEffect, useRef } from 'react';

// Спрайт здания из атласа игры для списков сайдбара карты — тот же /sprites/sprite-map.json, что
// рисует CityActionsCanvas. Атлас и карта грузятся один раз на модуль, кадр рисуется в маленький
// canvas, вписанный по нижнему краю (изометрические здания стоят на земле).
type SpriteInfo = { atlas: string; frame: { x: number; y: number; w: number; h: number } };
let spriteMap: Record<string, SpriteInfo> | null = null;
let spriteMapP: Promise<void> | null = null;
const atlases: Record<string, HTMLImageElement> = {};
function loadSpriteMap() {
  if (!spriteMapP) spriteMapP = fetch('/sprites/sprite-map.json').then(r => r.json()).then(j => { spriteMap = j; }).catch(() => { spriteMapP = null; });
  return spriteMapP;
}

export const BuildingSprite = memo(function BuildingSprite({ id, size = 32, dim }: { id: string; size?: number; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    loadSpriteMap().then(() => {
      const info = spriteMap?.[id]; if (!info || dead) return;
      const url = '/sprites/' + info.atlas;
      const draw = (im: HTMLImageElement) => {
        const c = ref.current; if (!c || dead) return;
        const d = Math.min(2, window.devicePixelRatio || 1);
        c.width = size * d; c.height = size * d;
        const x = c.getContext('2d'); if (!x) return;
        const f = info.frame; const k = Math.min(size / f.w, size / f.h) * d;
        x.clearRect(0, 0, c.width, c.height);
        x.drawImage(im, f.x, f.y, f.w, f.h, (c.width - f.w * k) / 2, c.height - f.h * k, f.w * k, f.h * k);
      };
      const im = atlases[url];
      if (im && im.complete) draw(im);
      else {
        const n = im ?? new Image();
        atlases[url] = n;
        n.addEventListener('load', () => draw(n), { once: true });
        if (!im) n.src = url;
      }
    });
    return () => { dead = true; };
  }, [id, size]);
  return <canvas ref={ref} aria-hidden="true" style={{ width: size, height: size, display: 'block', flexShrink: 0, opacity: dim ? 0.6 : 1 }} />;
});
