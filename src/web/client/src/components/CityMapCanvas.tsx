import { useEffect, useRef, useCallback } from 'react';
import type { MapBuilding } from '../api';

interface Props {
  buildings: MapBuilding[];
  type: 'city' | 'capital';
}

// Точные пропорции из игры
const TW = 90;
const TH = Math.round(TW * 434 / 753); // 52

const MAP_CAT_COLORS: Record<string, { fill: string; stroke: string }> = {
  COM: { fill: 'rgba(0,152,234,.35)',   stroke: 'rgba(0,152,234,.85)' },
  RES: { fill: 'rgba(137,87,229,.35)',  stroke: 'rgba(137,87,229,.85)' },
  SER: { fill: 'rgba(46,160,67,.35)',   stroke: 'rgba(46,160,67,.85)' },
  SPE: { fill: 'rgba(198,144,38,.35)',  stroke: 'rgba(198,144,38,.85)' },
  CAP: { fill: 'rgba(38,198,218,.35)',  stroke: 'rgba(38,198,218,.85)' },
  DEC: { fill: 'rgba(84,93,104,.25)',   stroke: 'rgba(120,130,140,.6)' },
  BEN: { fill: 'rgba(46,160,67,.35)',   stroke: 'rgba(46,160,67,.85)' },
};

function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
function buildingLabel(id: string): string {
  return id.replace(/\.png$/i, '').replace(/^[A-Z]+_(?:[A-Z]+_)?/, '').replace(/_/g, ' ');
}

export function CityMapCanvas({ buildings, type }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // mutable state (not React state — no re-renders needed)
  const state = useRef({
    spriteMap: {} as Record<string, { pngUrl: string; frame: { x: number; y: number; w: number; h: number } }>,
    imgCache: {} as Record<string, HTMLImageElement>,
    roadMap: {} as Record<string, { asset: string; big?: boolean }>,
    bmap: {} as Record<string, MapBuilding>,
    x0: 0, y0: 0, cols: 0, rows: 0,
    coords: new Set<string>(),
    ox: 0, oy: 0, scale: 1,
    needsCenter: true,
    rafId: null as number | null,
    dragging: false, dx: 0, dy: 0,
  });

  const requestRedraw = useCallback(() => {
    const s = state.current;
    if (s.rafId) return;
    s.rafId = requestAnimationFrame(() => { s.rafId = null; redraw(); });
  }, []);

  function isoToScreen(col: number, row: number) {
    const { rows } = state.current;
    return { x: (col - row + (rows - 1)) * TW / 2, y: (col + row) * TH / 2 };
  }

  function computeBounds(blds: MapBuilding[], coordsList: { x: number; y: number }[]) {
    let xMin = 999, xMax = -999, yMin = 999, yMax = -999;
    const src = [...blds, ...coordsList];
    for (const b of src) {
      const x = +b.x, y = +b.y;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    if (!src.length) { xMin = 0; xMax = 10; yMin = 0; yMax = 10; }
    const pad = 3;
    const s = state.current;
    s.x0 = xMin - pad; s.y0 = yMin - pad;
    s.cols = xMax + pad - s.x0 + 1; s.rows = yMax + pad - s.y0 + 1;
  }

  function rebuildBmap() {
    const s = state.current;
    s.bmap = {};
    for (const b of buildings) s.bmap[`${b.x}_${b.y}`] = b;
  }

  function centerOnBuildings() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const s = state.current;
    const totalW = (s.cols + s.rows - 2) * TW / 2;
    const totalH = (s.cols + s.rows - 2) * TH / 2;
    s.scale = Math.max(0.3, Math.min(2, Math.min(W / totalW, H / totalH) * 0.88));
    s.ox = W / 2 - totalW / 2 * s.scale;
    s.oy = H / 2 - totalH / 2 * s.scale;
  }

  function clampPan() {
    const wrap = wrapRef.current; if (!wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const s = state.current;
    const mapW = (s.cols + s.rows - 1) * TW / 2 * s.scale;
    const mapH = (s.cols + s.rows - 1) * TH / 2 * s.scale;
    const m = 120;
    s.ox = Math.min(s.ox, W - m); s.ox = Math.max(s.ox, m - mapW);
    s.oy = Math.min(s.oy, H - m); s.oy = Math.max(s.oy, m - mapH);
  }

  function getImg(url: string): HTMLImageElement | null {
    const s = state.current;
    const cached = s.imgCache[url];
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => requestRedraw();
    img.onerror = () => { (img as any)._error = true; };
    img.src = url;
    s.imgCache[url] = img;
    return null;
  }

  function drawTile(ctx: CanvasRenderingContext2D, sx: number, sy: number, fill: string, stroke: string, label?: string | null, level?: number | null) {
    const hw = TW / 2, hh = TH / 2;
    ctx.beginPath();
    ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
    ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    if (label) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
      ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
      ctx.closePath(); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = `bold ${Math.max(7, Math.round(TW * 0.115))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(level ? `${label} L${level}` : label, sx + hw, sy + hh, TW - 6);
      ctx.restore();
    }
  }

  function redraw() {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; state.current.needsCenter = true; }
    const s = state.current;
    if (s.needsCenter && W > 0 && H > 0) { centerOnBuildings(); s.needsCenter = false; }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!s.cols || !s.rows) return;
    ctx.save();
    ctx.translate(s.ox, s.oy);
    ctx.scale(s.scale, s.scale);

    // первый проход — тайлы и спрайты
    for (let d = 0; d <= (s.cols - 1) + (s.rows - 1); d++) {
      for (let col = 0; col <= d; col++) {
        const row = d - col;
        if (col >= s.cols || row >= s.rows) continue;
        const gx = s.x0 + col, gy = s.y0 + row;
        const { x: sx, y: sy } = isoToScreen(col, row);
        const b = s.bmap[`${gx}_${gy}`];
        const valid = s.coords.size === 0 || s.coords.has(`${gx}_${gy}`);
        if (b) {
          const cat = buildingCat(b.id);
          const cc = MAP_CAT_COLORS[cat] || { fill: 'rgba(100,100,100,.3)', stroke: 'rgba(150,150,150,.6)' };
          const sp = s.spriteMap[b.id];
          const img = sp ? getImg(sp.pngUrl) : null;
          if (img) {
            const f = sp!.frame;
            const RS = 1.025, dh0 = f.h * TW / 753;
            const dw = TW * RS, dh = dh0 * RS;
            ctx.drawImage(img, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh, dw, dh);
          } else {
            drawTile(ctx, sx, sy, cc.fill, cc.stroke, buildingLabel(b.id), b.level);
          }
        } else if (valid) {
          const empSp = s.spriteMap['empty.png'];
          const empImg = empSp ? getImg(empSp.pngUrl) : null;
          if (empImg) {
            const f = empSp!.frame;
            const RS = 1.025, dh0 = f.h * TW / 753;
            const dw = TW * RS, dh = dh0 * RS;
            ctx.drawImage(empImg, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh + (dh - dh0) / 2, dw, dh);
          } else {
            drawTile(ctx, sx, sy, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.18)');
          }
        } else {
          const env = s.roadMap[`${gx}_${gy}`] || null;
          const envSp = env ? s.spriteMap[env.asset] : null;
          const envImg = envSp ? getImg(envSp.pngUrl) : null;
          if (envImg && env) {
            const f = envSp!.frame;
            if (env.big) {
              const dw = Math.round(TW * 2), dh = Math.round(f.h * TW / 753 * 2);
              ctx.drawImage(envImg, f.x, f.y, f.w, f.h, Math.round(sx), Math.round(sy + 3 * TH / 2 - dh), dw, dh);
            } else {
              const RS = 1.05, dh0 = f.h * TW / 753;
              const dw = TW * RS, dh = dh0 * RS;
              ctx.drawImage(envImg, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh + (dh - dh0) / 2, dw, dh);
            }
          }
        }
      }
    }

    // второй проход — бейджи уровней (только для улучшаемых зданий)
    const fsz = Math.max(8, Math.round(TW * 0.13));
    ctx.font = `bold ${fsz}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const b of buildings) {
      if (!b.level) continue;
      // город: SPE_* не улучшаемы; столица: is_upgradable из конфига
      const renovatable = type === 'capital'
        ? (b as any).is_upgradable === true
        : !b.id.startsWith('SPE_');
      if (!renovatable) continue;
      const col = b.x - s.x0, row = b.y - s.y0;
      if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
      const { x: sx, y: sy } = isoToScreen(col, row);
      const lvl = String(b.level);
      const bx = sx + TW / 2, by = sy + TH / 2;
      const m = ctx.measureText(lvl);
      const tw = m.width, bw = Math.max(tw + 8, fsz + 6), bh = fsz + 5, r = bh / 2;
      const textCenterY = by + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
      ctx.fillStyle = 'rgba(15,15,20,0.82)';
      ctx.beginPath();
      if ((ctx as any).roundRect) (ctx as any).roundRect(bx - bw / 2, by - bh / 2, bw, bh, r);
      else ctx.ellipse(bx, by, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.fillText(lvl, bx, textCenterY);
    }
    ctx.restore();
  }

  // загрузка спрайтов и инициализация
  useEffect(() => {
    if (!buildings.length) return;
    const s = state.current;
    rebuildBmap();
    computeBounds(buildings, []);
    s.needsCenter = true;

    const rmUrl = type === 'capital' ? '/sprites/capital-road-map.json' : '/sprites/road-map.json';
    const loads: Promise<unknown>[] = [];
    if (Object.keys(s.spriteMap).length === 0) {
      loads.push(fetch('/sprites/sprite-map.json').then(r => r.json()).then(sm => {
        for (const [id, info] of Object.entries(sm as Record<string, { atlas: string; frame: any }>)) {
          s.spriteMap[id] = { pngUrl: '/sprites/' + info.atlas, frame: info.frame };
        }
      }));
    }
    loads.push(fetch(rmUrl).then(r => r.json()).then(rm => { s.roadMap = rm; }));

    // fetch coords if needed
    fetch(`/api/coords?type=${type === 'capital' ? 'capital' : ''}`)
      .then(r => r.json())
      .then(d => { s.coords = new Set((d.coords || []).map((c: any) => `${c.x}_${c.y}`)); })
      .catch(() => {});

    Promise.all(loads).then(() => {
      // preload atlas PNGs
      const needed = new Set(['empty.png']);
      for (const v of Object.values(s.roadMap)) needed.add(v.asset);
      for (const b of buildings) if (s.spriteMap[b.id]) needed.add(b.id);
      const urls = new Set<string>();
      for (const id of needed) { const sp = s.spriteMap[id]; if (sp) urls.add(sp.pngUrl); }
      const preloads = [...urls].map(url => new Promise<void>(res => {
        const cached = s.imgCache[url];
        if (cached && cached.complete && cached.naturalWidth > 0) return res();
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { requestRedraw(); res(); };
        img.onerror = () => res();
        img.src = url; s.imgCache[url] = img;
      }));
      Promise.all(preloads).then(() => requestRedraw());
    });

    // wait for wrap to have dimensions
    let attempts = 0;
    const waitCenter = () => {
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0) { requestRedraw(); }
      else if (attempts++ < 30) setTimeout(waitCenter, 16);
    };
    waitCenter();
  }, [buildings, type]);

  // resize observer
  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const ro = new ResizeObserver(() => { state.current.needsCenter = true; requestRedraw(); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // pan/zoom events
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const s = state.current;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newScale = Math.max(0.3, Math.min(2, s.scale * factor));
      s.ox = mx + (s.ox - mx) * (newScale / s.scale);
      s.oy = my + (s.oy - my) * (newScale / s.scale);
      s.scale = newScale;
      clampPan();
      requestRedraw();
    };

    const onMouseDown = (e: MouseEvent) => {
      s.dragging = true;
      s.dx = e.clientX - s.ox; s.dy = e.clientY - s.oy;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!s.dragging) return;
      s.ox = e.clientX - s.dx; s.oy = e.clientY - s.dy;
      clampPan(); requestRedraw();
    };
    const onMouseUp = () => { s.dragging = false; };
    const onCtxMenu = (e: Event) => e.preventDefault();

    // touch support
    let lastDist = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) { s.dragging = true; s.dx = e.touches[0].clientX - s.ox; s.dy = e.touches[0].clientY - s.oy; }
      else if (e.touches.length === 2) { s.dragging = false; lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1 && s.dragging) { s.ox = e.touches[0].clientX - s.dx; s.oy = e.touches[0].clientY - s.dy; clampPan(); requestRedraw(); }
      else if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const rect = wrap.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const factor = dist / lastDist;
        const ns = Math.max(0.3, Math.min(2, s.scale * factor));
        s.ox = cx + (s.ox - cx) * (ns / s.scale); s.oy = cy + (s.oy - cy) * (ns / s.scale);
        s.scale = ns; lastDist = dist; clampPan(); requestRedraw();
      }
    };
    const onTouchEnd = () => { s.dragging = false; };

    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    wrap.addEventListener('contextmenu', onCtxMenu);
    wrap.addEventListener('touchstart', onTouchStart, { passive: true });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false });
    wrap.addEventListener('touchend', onTouchEnd);

    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      wrap.removeEventListener('contextmenu', onCtxMenu);
      wrap.removeEventListener('touchstart', onTouchStart);
      wrap.removeEventListener('touchmove', onTouchMove);
      wrap.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: 'grab', background: '#d8d8d8', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}
