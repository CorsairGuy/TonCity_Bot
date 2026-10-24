import { useEffect, useRef } from 'react';
import { Box } from '@primer/react';
import type { MapBuilding, MapSection } from '../api';
import cityCoordsData from '../data/city-coords.json';
import cityRoadMapData from '../data/road-map.json';
import { getPreparedSprite, pickMip, requestSprite, onSpritesReady, type SpriteInfo } from './mapSprites';
import { constructionSpriteId } from './CityActionsCanvas';

// Общая карта всех городов (страница «Города», pages/CityWorld.tsx). Города стоят сеткой на одной
// изометрической плоскости. Каждый город один раз рисуется в свою картинку (те же спрайты, дороги
// и пустые клетки, что у карты города, только мелко), кадр карты — это просто эти картинки со сдвигом
// и масштабом, поэтому пан и зум по шестидесяти городам не тормозят. Уровни и бейджи здесь не рисуются:
// их видно, когда город приближен (порог З1 — город шире половины экрана, тогда страница открывает
// его карту, CityMapCity).

const COORDS = cityCoordsData as { x: number; y: number }[];
const ROAD_MAP = cityRoadMapData as Record<string, { asset: string; big?: boolean }>;
const VALID = new Set(COORDS.map(c => `${c.x}_${c.y}`));
const SPAN = 22;            // клеток города по каждой оси, вместе с дорогами и лесом (0..21)
const STEP = 25;            // шаг сетки городов в клетках: 3 клетки зазора между соседями
const B = 32;               // ширина клетки в картинке города, device-px
const BH = B * 434 / 753;   // её высота (пропорции клетки игры)
const OVER = 3 * B;         // запас сверху под высокие здания
const IMG_W = SPAN * B + B;
const IMG_H = (SPAN - 1) * BH + 2 * BH + OVER;
const OFF_X = (SPAN - 1) * B / 2;
const TH_K = 434 / 753;
const WORLD_BG = '#c9ced3';
const GROUND = '#d8d8d8';
// город шире этой доли экрана — открывается его карта; при выходе из города он встаёт на треть
export const ENTER_SHARE = 0.5;
export const LEAVE_SHARE = 1 / 3;

type SpriteMap = Record<string, SpriteInfo>;
let spriteMapCache: SpriteMap | null = null;
let spriteMapP: Promise<SpriteMap> | null = null;
function loadSpriteMap(): Promise<SpriteMap> {
  if (spriteMapCache) return Promise.resolve(spriteMapCache);
  return spriteMapP ??= fetch('/sprites/sprite-map.json').then(r => r.json()).then(sm => {
    const map: SpriteMap = {};
    for (const [id, info] of Object.entries(sm as Record<string, { atlas: string; frame: SpriteInfo['frame'] }>)) map[id] = { pngUrl: '/sprites/' + info.atlas, frame: info.frame };
    return (spriteMapCache = map);
  }).catch(() => ({}));
}

export interface WorldCity { account: string; buildings: MapBuilding[]; unlockedSections: string[] | null }
export interface WorldCell { account: string; x: number; y: number; fill: string; stroke?: string }

interface Props {
  cities: WorldCity[];                    // в порядке показа: слева направо, сверху вниз
  sections: MapSection[];
  tint?: Map<string, string>;             // заливка города целиком (цвет вкладки)
  cells?: WorldCell[];                    // заливка отдельных клеток
  dim?: Set<string> | null;               // города вне этого набора приглушены
  focus?: { account: string; share: number } | null; // поставить город в центр шириной share экрана
  onEnter: (account: string) => void;     // город приблизили до порога З1 или кликнули по нему
  onHover?: (account: string | null) => void;
  // вкладки действий: клик выбирает клетку в любом городе, а не открывает город
  onCell?: (account: string, x: number, y: number) => void;
}

interface CityImg { el: HTMLCanvasElement; complete: boolean; sig: string }

function gridCols(n: number): number { return Math.max(1, Math.ceil(Math.sqrt(n))); }

// картинка города: земля, пустые клетки, дороги, лес и здания по диагоналям (порядок художника)
function renderCity(c: WorldCity, sm: SpriteMap, locked: Set<string>, into?: HTMLCanvasElement): CityImg {
  const el = into ?? document.createElement('canvas');
  el.width = Math.ceil(IMG_W); el.height = Math.ceil(IMG_H);
  const x = el.getContext('2d')!;
  x.clearRect(0, 0, el.width, el.height);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  const iso = (cx: number, cy: number) => ({ sx: (cx - cy) * B / 2 + OFF_X, sy: (cx + cy) * BH / 2 + OVER });
  const t = iso(0, 0), r = iso(SPAN - 1, 0), b = iso(SPAN - 1, SPAN - 1), l = iso(0, SPAN - 1);
  x.beginPath(); x.moveTo(t.sx + B / 2, t.sy); x.lineTo(r.sx + B, r.sy + BH / 2); x.lineTo(b.sx + B / 2, b.sy + BH); x.lineTo(l.sx, l.sy + BH / 2); x.closePath();
  x.fillStyle = GROUND; x.fill();
  const now = Date.now();
  const bmap = new Map(c.buildings.map(v => [`${v.x}_${v.y}`, v]));
  let complete = true;
  const draw = (id: string, dw: number, dx: number, dy: number, dh: number) => {
    const info = sm[id];
    if (!info) return;
    const tw = Math.ceil(dw);
    const sp = getPreparedSprite(id, tw);
    if (!sp) { requestSprite(id, info, tw); complete = false; return; }
    x.drawImage(pickMip(sp, dw), dx, dy, dw, dh);
  };
  for (let d = 0; d <= 2 * (SPAN - 1); d++) {
    for (let cx = 0; cx <= d; cx++) {
      const cy = d - cx;
      if (cx >= SPAN || cy >= SPAN) continue;
      const key = `${cx}_${cy}`;
      const { sx, sy } = iso(cx, cy);
      const bld = bmap.get(key);
      if (locked.has(key)) {
        x.beginPath(); x.moveTo(sx + B / 2, sy); x.lineTo(sx + B, sy + BH / 2); x.lineTo(sx + B / 2, sy + BH); x.lineTo(sx, sy + BH / 2); x.closePath();
        x.fillStyle = 'rgba(8,8,12,.45)'; x.fill();
      } else if (bld) {
        const building = !!bld.end && new Date(bld.end).getTime() > now;
        const id = building ? constructionSpriteId(bld.id, 'city') : bld.id;
        const f = sm[id]?.frame;
        if (!f) continue;
        const dw = B * 1.025, dh = f.h * B / 753 * 1.025;
        draw(id, dw, sx - (dw - B) / 2, sy + BH - dh, dh);
      } else if (VALID.has(key)) {
        const f = sm['empty.png']?.frame;
        if (!f) continue;
        const dw = B * 1.025, dh0 = f.h * B / 753, dh = dh0 * 1.025;
        draw('empty.png', dw, sx - (dw - B) / 2, sy + BH - dh + (dh - dh0) / 2, dh);
      } else {
        const env = ROAD_MAP[key];
        const f = env && sm[env.asset]?.frame;
        if (!env || !f) continue;
        if (env.big) {
          const dw = B * 2, dh = f.h * B / 753 * 2;
          draw(env.asset, dw, sx, sy + 1.5 * BH - dh, dh);
        } else {
          const dh0 = f.h * B / 753, dw = B * 1.05, dh = dh0 * 1.05;
          draw(env.asset, dw, sx - (dw - B) / 2, sy + BH - dh + (dh - dh0) / 2, dh);
        }
      }
    }
  }
  return { el, complete, sig: '' };
}

const citySig = (c: WorldCity) => `${c.unlockedSections?.join(',') ?? '-'}|${c.buildings.map(b => `${b.x},${b.y},${b.id},${b.end ? new Date(b.end).getTime() > Date.now() ? 1 : 0 : 0}`).join(';')}`;

export function WorldMapCanvas({ cities, sections, tint, cells, dim, focus, onEnter, onHover, onCell }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const st = useRef({
    tw: 0, ox: 0, oy: 0, placed: false,
    imgs: new Map<string, CityImg>(),
    sm: null as SpriteMap | null,
    hover: null as string | null,
    hoverCell: null as { i: number; x: number; y: number } | null,
    raf: 0, anim: 0,
  });
  const props = useRef({ cities, sections, tint, cells, dim, onEnter, onHover, onCell });
  props.current = { cities, sections, tint, cells, dim, onEnter, onHover, onCell };

  const cols = gridCols(cities.length);
  // обработчики и кадр живут дольше одного рендера — сетку берут отсюда, а не из замыкания
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const posOf = (i: number) => ({ c: (i % colsRef.current) * STEP, r: Math.floor(i / colsRef.current) * STEP });

  const redraw = () => {
    const s = st.current;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => { s.raf = 0; paint(); });
  };

  function size() { const w = wrapRef.current; return { W: w?.clientWidth ?? 1, H: w?.clientHeight ?? 1 }; }
  function iso(c: number, r: number) { const s = st.current, th = s.tw * TH_K; return { x: (c - r) * s.tw / 2 + s.ox, y: (c + r) * th / 2 + s.oy }; }
  // центр города в мировых координатах клетки
  function centerOf(i: number) { const p = posOf(i); return { c: p.c + SPAN / 2 - 0.5, r: p.r + SPAN / 2 - 0.5 }; }
  // поставить точку (c,r) мира в центр экрана при ширине клетки tw
  function lookAt(c: number, r: number, tw: number) {
    const s = st.current, { W, H } = size(), th = tw * TH_K;
    s.tw = tw;
    s.ox = W / 2 - (c - r) * tw / 2 - tw / 2;
    s.oy = H / 2 - (c + r) * th / 2 - th / 2;
  }
  function minTw() {
    const { W, H } = size(), n = props.current.cities.length, cols = colsRef.current, rows = Math.max(1, Math.ceil(n / cols));
    const wc = (cols - 1) * STEP + SPAN, wr = (rows - 1) * STEP + SPAN;
    const tw = Math.min(W / ((wc + wr) / 2), H / ((wc + wr) / 2 * TH_K + 3)) * 0.92;
    return Math.max(2, tw);
  }
  const enterTw = () => size().W * ENTER_SHARE / SPAN;
  function fitAll() {
    const n = props.current.cities.length, cols = colsRef.current, rows = Math.max(1, Math.ceil(n / cols));
    const wc = (cols - 1) * STEP + SPAN, wr = (rows - 1) * STEP + SPAN;
    lookAt(wc / 2 - 0.5, wr / 2 - 0.5, minTw());
  }
  // клетка мира под точкой экрана
  function pick(mx: number, my: number) {
    const s = st.current, th = s.tw * TH_K;
    const u = (mx - s.ox - s.tw / 2) / (s.tw / 2), v = (my - s.oy - th / 2) / (th / 2);
    return { c: (u + v) / 2, r: (v - u) / 2 };
  }
  function cityAt(mx: number, my: number): number {
    const { c, r } = pick(mx, my);
    const n = props.current.cities.length;
    for (let i = 0; i < n; i++) {
      const p = posOf(i);
      if (c >= p.c - 1 && c < p.c + SPAN + 1 && r >= p.r - 1 && r < p.r + SPAN + 1) return i;
    }
    return -1;
  }
  // клетка города под точкой экрана (координаты внутри города)
  function cellAt(mx: number, my: number): { i: number; x: number; y: number } | null {
    const i = cityAt(mx, my);
    if (i < 0) return null;
    const { c, r } = pick(mx, my), p = posOf(i);
    const x = Math.round(c) - p.c, y = Math.round(r) - p.r;
    return x >= 0 && y >= 0 && x < SPAN && y < SPAN ? { i, x, y } : null;
  }
  // город, который сейчас ближе всех к центру экрана
  function centralCity(): number {
    const { W, H } = size(), { c, r } = pick(W / 2, H / 2);
    let best = -1, bd = Infinity;
    props.current.cities.forEach((_, i) => { const ce = centerOf(i), d = Math.hypot(ce.c - c, ce.r - r); if (d < bd) { bd = d; best = i; } });
    return bd < SPAN ? best : -1;
  }

  function paint() {
    const cv = canvasRef.current, s = st.current;
    if (!cv) return;
    const { W, H } = size(), dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const x = cv.getContext('2d')!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = WORLD_BG; x.fillRect(0, 0, W, H);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    const { cities: list, tint: tn, cells: cl, dim: dm } = props.current;
    const k = s.tw / B, th = s.tw * TH_K;
    const idx = new Map(list.map((c, i) => [c.account, i]));
    const diamond = (i: number) => {
      const p = posOf(i), t = iso(p.c, p.r), r = iso(p.c + SPAN - 1, p.r), b = iso(p.c + SPAN - 1, p.r + SPAN - 1), l = iso(p.c, p.r + SPAN - 1);
      x.beginPath(); x.moveTo(t.x + s.tw / 2, t.y); x.lineTo(r.x + s.tw, r.y + th / 2); x.lineTo(b.x + s.tw / 2, b.y + th); x.lineTo(l.x, l.y + th / 2); x.closePath();
    };
    list.forEach((c, i) => {
      const img = s.imgs.get(c.account);
      const p = posOf(i), o = iso(p.c, p.r);
      const dx = o.x - OFF_X * k, dy = o.y - OVER * k, dw = IMG_W * k, dh = IMG_H * k;
      if (dx > W || dy > H || dx + dw < 0 || dy + dh < 0) return;
      // Н1: под курсором город, остальные бледнеют; на вкладках с выбором — города вне выбора приглушены
      const faded = (s.hover != null && s.hover !== c.account) || (dm != null && !dm.has(c.account));
      x.globalAlpha = faded ? 0.4 : 1;
      if (img) x.drawImage(img.el, dx, dy, dw, dh);
      else { diamond(i); x.fillStyle = GROUND; x.fill(); }
      const t = tn?.get(c.account);
      if (t) { diamond(i); x.fillStyle = t; x.fill(); }
      x.globalAlpha = 1;
    });
    if (cl?.length) for (const cell of cl) {
      const i = idx.get(cell.account);
      if (i == null) continue;
      const p = posOf(i), o = iso(p.c + cell.x, p.r + cell.y);
      x.beginPath(); x.moveTo(o.x + s.tw / 2, o.y); x.lineTo(o.x + s.tw, o.y + th / 2); x.lineTo(o.x + s.tw / 2, o.y + th); x.lineTo(o.x, o.y + th / 2); x.closePath();
      x.fillStyle = cell.fill; x.fill();
      if (cell.stroke && s.tw >= 6) { x.lineWidth = 1; x.strokeStyle = cell.stroke; x.stroke(); }
    }
    // клетка под курсором на вкладках действий
    if (s.hoverCell && props.current.onCell) {
      const p = posOf(s.hoverCell.i), o = iso(p.c + s.hoverCell.x, p.r + s.hoverCell.y);
      x.beginPath(); x.moveTo(o.x + s.tw / 2, o.y); x.lineTo(o.x + s.tw, o.y + th / 2); x.lineTo(o.x + s.tw / 2, o.y + th); x.lineTo(o.x, o.y + th / 2); x.closePath();
      x.fillStyle = 'rgba(255,255,255,.35)'; x.fill();
      x.lineWidth = 2; x.strokeStyle = '#0969da'; x.stroke();
    }
  }

  // картинки городов: перерисовываем только изменившиеся и те, где ещё не все спрайты были готовы
  function rebuild(force = false) {
    const s = st.current;
    if (!s.sm) return;
    const { cities: list, sections: secs } = props.current;
    const alive = new Set(list.map(c => c.account));
    for (const k of [...s.imgs.keys()]) if (!alive.has(k)) s.imgs.delete(k);
    for (const c of list) {
      const sig = citySig(c), old = s.imgs.get(c.account);
      if (old && old.complete && old.sig === sig && !force) continue;
      const locked = new Set<string>();
      if (c.unlockedSections) { const u = new Set(c.unlockedSections); for (const sec of secs) if (!u.has(sec.id)) for (const p of sec.coordinates) locked.add(`${p.x}_${p.y}`); }
      const img = renderCity(c, s.sm, locked, old?.el);
      img.sig = sig;
      s.imgs.set(c.account, img);
    }
    redraw();
  }

  useEffect(() => {
    let alive = true;
    loadSpriteMap().then(sm => { if (!alive) return; st.current.sm = sm; rebuild(); });
    let t = 0;
    const off = onSpritesReady(() => { if (!t) t = window.setTimeout(() => { t = 0; rebuild(); }, 150); });
    return () => { alive = false; off(); if (t) clearTimeout(t); };
  }, []);
  useEffect(() => { rebuild(); }, [cities, sections]);
  useEffect(() => { redraw(); }, [tint, cells, dim]);

  // первая расстановка и возврат из города: город встаёт в центр на треть экрана
  useEffect(() => {
    const s = st.current;
    if (!cities.length) return;
    const i = focus ? cities.findIndex(c => c.account === focus.account) : -1;
    if (i >= 0) { const ce = centerOf(i); lookAt(ce.c, ce.r, Math.max(minTw(), size().W * focus!.share / SPAN)); s.placed = true; }
    else if (!s.placed) { fitAll(); s.placed = true; }
    redraw();
  }, [focus, cities.length > 0, cols]);

  // пан, зум колесом и щипком, клик по городу
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const s = st.current;
    const setHover = (h: string | null) => { if (h !== s.hover) { s.hover = h; props.current.onHover?.(h); redraw(); } };
    const zoomAt = (mx: number, my: number, tw: number) => {
      const nt = Math.max(minTw(), Math.min(enterTw() * 1.001, tw));
      s.ox = mx + (s.ox - mx) * (nt / s.tw);
      s.oy = my + (s.oy - my) * (nt / s.tw);
      s.tw = nt;
      redraw();
      // З1: приблизили до порога — открывается город у центра экрана
      if (nt >= enterTw()) { const i = centralCity(); if (i >= 0) props.current.onEnter(props.current.cities[i].account); }
    };
    // плавный наезд на город по клику, в конце — его карта
    const flyTo = (i: number) => {
      cancelAnimationFrame(s.anim);
      const { W, H } = size(), from = pick(W / 2, H / 2), ft = s.tw, to = centerOf(i), tt = enterTw(), t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - p, 3);
        lookAt(from.c + (to.c - from.c) * e, from.r + (to.r - from.r) * e, ft * Math.pow(tt / ft, e));
        paint();
        if (p < 1) s.anim = requestAnimationFrame(step);
        else props.current.onEnter(props.current.cities[i].account);
      };
      s.anim = requestAnimationFrame(step);
    };
    const local = (e: { clientX: number; clientY: number }) => { const r = wrap.getBoundingClientRect(); return { mx: e.clientX - r.left, my: e.clientY - r.top }; };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { mx, my } = local(e);
      zoomAt(mx, my, s.tw * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    };
    let down: { x: number; y: number; ox: number; oy: number } | null = null, moved = false;
    const onDown = (e: MouseEvent) => { if (e.button !== 0 && e.button !== 2) return; down = { x: e.clientX, y: e.clientY, ox: s.ox, oy: s.oy }; moved = false; };
    const onMove = (e: MouseEvent) => {
      if (down) {
        if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) moved = true;
        if (moved) { s.ox = down.ox + e.clientX - down.x; s.oy = down.oy + e.clientY - down.y; redraw(); }
        return;
      }
      const { mx, my } = local(e);
      const i = cityAt(mx, my);
      setHover(i >= 0 ? props.current.cities[i].account : null);
      if (props.current.onCell) {
        const c = cellAt(mx, my), h = s.hoverCell;
        if (c?.i !== h?.i || c?.x !== h?.x || c?.y !== h?.y) { s.hoverCell = c; redraw(); }
      }
    };
    const onUp = (e: MouseEvent) => {
      if (!down) return;
      const wasMove = moved; down = null;
      if (wasMove || e.button !== 0) return;
      tap(local(e));
    };
    // клик: на вкладках действий — клетка, иначе наезд на город
    const tap = ({ mx, my }: { mx: number; my: number }) => {
      const cb = props.current.onCell;
      if (cb) { const c = cellAt(mx, my); if (c) cb(props.current.cities[c.i].account, c.x, c.y); return; }
      const i = cityAt(mx, my);
      if (i >= 0) flyTo(i);
    };
    const onLeave = () => { if (!down) { setHover(null); if (s.hoverCell) { s.hoverCell = null; redraw(); } } };
    const onCtx = (e: MouseEvent) => e.preventDefault();

    // сенсор: один палец — пан и тап по городу, два — зум
    let t1: { x: number; y: number; ox: number; oy: number } | null = null, tMoved = false, pinch: number | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTStart = (e: TouchEvent) => {
      if (e.touches.length === 2) { pinch = dist(e.touches); t1 = null; return; }
      if (e.touches.length === 1) { t1 = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: s.ox, oy: s.oy }; tMoved = false; }
    };
    const onTMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinch != null) {
        const d = dist(e.touches), r = wrap.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        zoomAt(mx, my, s.tw * d / pinch); pinch = d;
        return;
      }
      if (t1 && e.touches.length === 1) {
        const t = e.touches[0];
        if (Math.abs(t.clientX - t1.x) + Math.abs(t.clientY - t1.y) > 6) tMoved = true;
        if (tMoved) { s.ox = t1.ox + t.clientX - t1.x; s.oy = t1.oy + t.clientY - t1.y; redraw(); }
      }
    };
    const onTEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) { pinch = null; return; }
      if (t1 && !tMoved && e.changedTouches.length) tap(local(e.changedTouches[0]));
      t1 = null; pinch = null;
    };
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrap);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    wrap.addEventListener('mouseleave', onLeave);
    wrap.addEventListener('contextmenu', onCtx);
    wrap.addEventListener('touchstart', onTStart, { passive: true });
    wrap.addEventListener('touchmove', onTMove, { passive: false });
    wrap.addEventListener('touchend', onTEnd);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(s.anim); cancelAnimationFrame(s.raf); s.raf = 0;
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      wrap.removeEventListener('mouseleave', onLeave);
      wrap.removeEventListener('contextmenu', onCtx);
      wrap.removeEventListener('touchstart', onTStart);
      wrap.removeEventListener('touchmove', onTMove);
      wrap.removeEventListener('touchend', onTEnd);
    };
  }, [cols]);

  return (
    <Box ref={wrapRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'hidden', touchAction: 'none', cursor: onCell ? 'pointer' : 'grab', bg: WORLD_BG }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
    </Box>
  );
}
