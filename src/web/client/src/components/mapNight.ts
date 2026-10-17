// Смена суток на карте города: заранее размеченные ночные слои зданий и тонирование спрайтов по
// времени суток. Разметка делается офлайн (scripts/night, README там же): для каждого здания — где
// настоящие окна, какие окна образуют квартиру (свет включается и гаснет квартирами, 8 групп) и что
// светится снаружи (вывески, прожекторы, фонари у входа). Результат лежит в /sprites/night/.
//
// Сутки разбиты на STEPS ступеней. На каждую ступень все спрайты карты один раз перекрашиваются
// (тонирование по яркости: тени и свет красятся по-разному, как на настоящем закате) — понемногу, по
// GRADE_SLICE_MS за подход, а карта до готовности рисуется прежним набором. Окна рисуются поверх
// спрайта готовой картинкой «горящих квартир» здания, она собирается один раз на набор групп.
// Днём ничего из этого не работает: карта рисуется дневными спрайтами, как раньше.

import { getPreparedSprite, onSpritesReady, type PreparedSprite } from './mapSprites';

export type DayNightMode = 'auto' | 'day' | 'night';

export interface Phase {
  step: number;
  // S — множитель тёмных тонов, Hc — светлых, haze — дымка (screen), mist — дымка у горизонта (верх
  // карты), sun — сторона солнца (-1 запад/слева, +1 восток/справа), sunA — её сила, lamps — фонари и
  // подсветка, dark — ночная основа (стёкла без света темнеют, окна горят)
  S: number[]; Hc: number[]; haze: number[]; mist: number; sun: number; sunA: number; lamps: number; dark: number;
  T: Float32Array; // таблица тонирования: 256 яркостей × 3 канала
  isDay: boolean;
  ground: string;  // цвет фона карты под этот час
}

export const STEPS = 48; // ступень — полчаса
const NG = 8;
const GRADE_SLICE_MS = 4;
const LIT_CACHE_LIMIT = 400;
const TONES = [[255, 205, 130], [255, 236, 196], [206, 226, 255]]; // тёплый, белый, холодный офисный

type KF = Omit<Phase, 'step' | 'T' | 'isDay' | 'ground'>;
// ночь — дневные цвета зданий, только темнее: без синего оттенка, иначе белое и бежевое уходят в синий
const N: KF = { S: [50, 50, 56], Hc: [105, 104, 112], haze: [0, 0, 0, 0], mist: 0, sun: 0, sunA: 0, lamps: 1, dark: 1 };
const D: KF = { S: [255, 255, 255], Hc: [255, 255, 255], haze: [0, 0, 0, 0], mist: 0, sun: 0, sunA: 0, lamps: 0, dark: 0 };
const KEYS: [number, KF][] = [
  [0.0, N], [4.6, N],
  [5.5, { S: [72, 74, 90], Hc: [150, 144, 170], haze: [120, 120, 150, 0.04], mist: 0.25, sun: 1, sunA: 0.25, lamps: 0.85, dark: 0.85 }],
  // рассвет: холодные голубые тени, персиковый свет с востока, дымка вдали
  [6.4, { S: [150, 172, 218], Hc: [276, 226, 206], haze: [255, 220, 216, 0.05], mist: 0.55, sun: 1, sunA: 0.5, lamps: 0.15, dark: 0.25 }],
  [7.4, { S: [228, 234, 248], Hc: [266, 252, 238], haze: [255, 238, 228, 0.03], mist: 0.22, sun: 1, sunA: 0.2, lamps: 0, dark: 0 }],
  [8.6, D], [17.3, D],
  // золотой час: тёплый свет, тени чуть сиреневые
  [18.5, { S: [205, 178, 190], Hc: [282, 236, 172], haze: [0, 0, 0, 0], mist: 0, sun: -1, sunA: 0.4, lamps: 0, dark: 0 }],
  // закат: освещённое оранжевое, тени фиолетовые
  [19.3, { S: [124, 100, 170], Hc: [282, 196, 140], haze: [255, 150, 120, 0.03], mist: 0.18, sun: -1, sunA: 0.6, lamps: 0.2, dark: 0.12 }],
  // сумерки
  [20.3, { S: [64, 64, 80], Hc: [160, 140, 158], haze: [0, 0, 0, 0], mist: 0, sun: -1, sunA: 0.2, lamps: 0.75, dark: 0.7 }],
  [21.3, N], [24.0, N],
];

// «Всегда ночь» — вечер, когда горит почти весь город
const NIGHT_HOUR = 21.5, DAY_HOUR = 13;

export function hourFor(mode: DayNightMode, now = new Date()): number {
  if (mode === 'night') return NIGHT_HOUR;
  if (mode === 'day') return DAY_HOUR;
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

export const stepOf = (h: number) => Math.round(h / 24 * STEPS) % STEPS;

const phases = new Map<number, Phase>();
export function phaseAt(step: number): Phase {
  let p = phases.get(step);
  if (p) return p;
  const h = step * 24 / STEPS;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= h) i++;
  const [ha, A] = KEYS[i], [hb, B] = KEYS[i + 1];
  const t0 = Math.min(1, Math.max(0, (h - ha) / (hb - ha))), t = t0 * t0 * (3 - 2 * t0);
  const mix = (a: number, b: number) => a + (b - a) * t;
  const arr = (a: number[], b: number[]) => a.map((v, j) => mix(v, b[j]));
  const o = {
    S: arr(A.S, B.S), Hc: arr(A.Hc, B.Hc), haze: arr(A.haze, B.haze), mist: mix(A.mist, B.mist),
    sun: mix(A.sun, B.sun), sunA: mix(A.sunA, B.sunA), lamps: mix(A.lamps, B.lamps), dark: mix(A.dark, B.dark),
  };
  const T = new Float32Array(256 * 3);
  for (let l = 0; l < 256; l++) {
    const u = Math.min(1, Math.max(0, (l / 255 - 0.08) / 0.84)), k = u * u * (3 - 2 * u);
    for (let c = 0; c < 3; c++) T[l * 3 + c] = (o.S[c] + (o.Hc[c] - o.S[c]) * k) / 255;
  }
  const isDay = o.S.every(v => v > 254.5) && o.Hc.every(v => v > 254.5) && o.haze[3] < 0.005;
  p = { step, ...o, T, isDay, ground: '' };
  const g = new Uint8ClampedArray([216, 216, 216, 255]); // фон карты днём — MAP_BG
  gradePixels(g, p);
  p.ground = `rgb(${g[0]},${g[1]},${g[2]})`;
  phases.set(step, p);
  return p;
}

function gradePixels(d: Uint8ClampedArray, ph: Phase) {
  const T = ph.T, hz = ph.haze, ha = hz[3];
  const h0 = 1 - ha * hz[0] / 255, h1 = 1 - ha * hz[1] / 255, h2 = 1 - ha * hz[2] / 255;
  for (let p = 0; p < d.length; p += 4) {
    if (!d[p + 3]) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2], l = ((r * 77 + g * 150 + b * 29) >> 8) * 3;
    let o0 = r * T[l], o1 = g * T[l + 1], o2 = b * T[l + 2];
    if (ha > 0.005) {
      o0 = 255 - (255 - Math.min(255, o0)) * h0; o1 = 255 - (255 - Math.min(255, o1)) * h1; o2 = 255 - (255 - Math.min(255, o2)) * h2;
    }
    d[p] = o0; d[p + 1] = o1; d[p + 2] = o2;
  }
}

// ── расписание света: квартира загорается вечером, гаснет в свой час ночью, часть встаёт рано ──
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function groupOn(key: string, g: number, h: number): boolean {
  const s = (hash(key + ':s') - 0.5) * 1.2, r = hash(`${key}:${g}`);
  const onE = 17.4 + g * 0.32 + s, offN = 21.6 + g * 0.55 + r * 0.8 + s; // 21:36 … ~02:30
  const t = h < 12 ? h + 24 : h;
  if (t >= onE && t < offN) return true;
  // ранние подъёмы: половина групп, 5:10 … 7:20, гаснут с рассветом
  if (r < 0.55) { const onM = 5.2 + r * 3.6, offM = 7.4 + hash(`${key}:${g}:m`); if (h >= onM && h < offM) return true; }
  // кто-то не спит: короткое включение посреди ночи
  const w = hash(`${key}:${g}:w`);
  if (w < 0.22) { const at = 1 + w * 14; if (h >= at && h < at + 0.3) return true; }
  return false;
}
// маска горящих групп квартир здания на клетке key в час h
export function litMask(key: string, h: number): number {
  let m = 0;
  for (let g = 0; g < NG; g++) if (groupOn(key, g, h)) m |= 1 << g;
  return m;
}

// ── ночные слои зданий ──
type Mip = ImageBitmap | HTMLCanvasElement;
interface NightBld {
  ox: number; oy: number; w: number; h: number; sh: number; // вырезка в кадре шириной meta.w (высота кадра sh)
  idx: Uint32Array; grp: Uint8Array; col: Uint8ClampedArray; // пиксели окон: позиция, группа, цвет света
  shade: Mip;            // стёкла без света ночью темнее: множитель для режима multiply
  emit: Mip | null;      // внешняя подсветка, режим 'lighter'
}
interface Meta { w: number; lamps: Record<string, [number, number][]>; b: Map<string, NightBld> }
let meta: Meta | null = null;
let metaState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let metaPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

export function onNightChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const nextTick = () => new Promise<void>(r => setTimeout(r, 0));
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}
async function freeze(c: HTMLCanvasElement): Promise<Mip> {
  if (typeof createImageBitmap !== 'function') return c;
  try { const b = await createImageBitmap(c); c.width = 0; c.height = 0; return b; } catch { return c; }
}

export function ensureNight(): Promise<void> {
  if (metaPromise) return metaPromise;
  metaState = 'loading';
  metaPromise = (async () => {
    try {
      const [j, win, emi] = await Promise.all([
        fetch('/sprites/night/night.json').then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }),
        loadImage('/sprites/night/night-win.png'), loadImage('/sprites/night/night-emit.png'),
      ]);
      const b = new Map<string, NightBld>();
      const wc = mk(1, 1), ec = mk(1, 1);
      for (const [id, f] of Object.entries(j.frames as Record<string, { x: number; y: number; w: number; h: number; ox: number; oy: number; sh: number }>)) {
        wc.width = f.w; wc.height = f.h; ec.width = f.w; ec.height = f.h;
        const wx = wc.getContext('2d', { willReadFrequently: true })!, ex = ec.getContext('2d', { willReadFrequently: true })!;
        wx.drawImage(win, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
        ex.drawImage(emi, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
        const wd = wx.getImageData(0, 0, f.w, f.h).data;
        let n = 0;
        for (let p = 3; p < wd.length; p += 4) if (wd[p] >= 128) n++;
        const idx = new Uint32Array(n), grp = new Uint8Array(n), col = new Uint8ClampedArray(n * 3);
        const shade = new ImageData(f.w, f.h);
        for (let p = 0, i = 0; p < wd.length; p += 4) {
          if (wd[p + 3] < 128) continue;
          const tone = TONES[Math.min(2, Math.floor(wd[p + 2] / 80))], k = 0.75 + 0.5 * wd[p] / 255;
          idx[i] = p; grp[i] = Math.min(NG - 1, wd[p + 1] >> 5);
          col[i * 3] = tone[0] * k; col[i * 3 + 1] = tone[1] * k; col[i * 3 + 2] = tone[2] * k;
          shade.data[p] = 128; shade.data[p + 1] = 133; shade.data[p + 2] = 153; shade.data[p + 3] = 255;
          i++;
        }
        const sc = mk(f.w, f.h); sc.getContext('2d')!.putImageData(shade, 0, 0);
        const ed = ex.getImageData(0, 0, f.w, f.h).data;
        let any = false;
        for (let p = 0; p < ed.length; p += 4) if (ed[p] + ed[p + 1] + ed[p + 2] > 12) { any = true; break; }
        let emit: HTMLCanvasElement | null = null;
        if (any) { emit = mk(f.w, f.h); emit.getContext('2d')!.drawImage(ec, 0, 0); }
        b.set(id, { ox: f.ox, oy: f.oy, w: f.w, h: f.h, sh: f.sh, idx, grp, col, shade: await freeze(sc), emit: emit ? await freeze(emit) : null });
        await nextTick();
      }
      wc.width = wc.height = ec.width = ec.height = 0;
      meta = { w: j.w, lamps: j.lamps || {}, b };
      metaState = 'ready';
    } catch {
      metaState = 'failed'; // без ночных слоёв карта всё равно тонируется по времени суток
    }
    notify();
    void pump();
  })();
  return metaPromise;
}

export function nightReady(): boolean { return metaState === 'ready' || metaState === 'failed'; }
export function lampsOf(asset: string): [number, number][] { return meta?.lamps[asset] || []; }
export function hasWindows(id: string): boolean { const b = meta?.b.get(id); return !!b && b.idx.length > 0; }

// место вырезки ночного слоя здания на карте, если само здание нарисовано прямоугольником dx,dy,dw,dh
function placeOf(b: NightBld, dx: number, dy: number, dw: number, dh: number) {
  const kx = dw / meta!.w, ky = dh / b.sh;
  return { x: dx + b.ox * kx, y: dy + b.oy * ky, w: b.w * kx, h: b.h * ky };
}

function halfChain(c: HTMLCanvasElement, minW = 16): HTMLCanvasElement[] {
  const out = [c];
  for (let cur = c; cur.width / 2 >= minW;) {
    const n = mk(Math.max(1, Math.round(cur.width / 2)), Math.max(1, Math.round(cur.height / 2))), x = n.getContext('2d')!;
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, n.width, n.height);
    out.push(n); cur = n;
  }
  return out;
}
function freezeAll(sp: PreparedSprite) {
  sp.mips.forEach((m, i) => { if (m instanceof HTMLCanvasElement) void freeze(m).then(b => { sp.mips[i] = b; }); });
}
function closeAll(sp: PreparedSprite) {
  for (const m of sp.mips) { if (m instanceof HTMLCanvasElement) { m.width = 0; m.height = 0; } else m.close?.(); }
}
function pickLevel(sp: PreparedSprite, needW: number): Mip {
  const m = sp.mips;
  for (let i = m.length - 1; i > 0; i--) if (m[i].width >= needW) return m[i];
  return m[0];
}

// горящие окна здания (маска групп mask) в масштабе tw — ширина кадра на максимальном зуме
const litCache = new Map<string, PreparedSprite>();
function litLayer(id: string, b: NightBld, mask: number, tw: number): PreparedSprite {
  const key = `${id}|${mask}|${tw}`;
  let sp = litCache.get(key);
  if (sp) { litCache.delete(key); litCache.set(key, sp); return sp; }
  const src = new ImageData(b.w, b.h), d = src.data;
  for (let i = 0; i < b.idx.length; i++) {
    if (!(mask & (1 << b.grp[i]))) continue;
    const p = b.idx[i];
    d[p] = b.col[i * 3]; d[p + 1] = b.col[i * 3 + 1]; d[p + 2] = b.col[i * 3 + 2]; d[p + 3] = 255;
  }
  const c1 = mk(b.w, b.h); c1.getContext('2d')!.putImageData(src, 0, 0);
  const k = tw / meta!.w, W = Math.max(1, Math.round(b.w * k)), H = Math.max(1, Math.round(b.h * k));
  // мягкий ореол вокруг окон: уменьшить вчетверо и растянуть обратно (размытие без ctx.filter)
  const sm = mk(Math.max(1, Math.round(b.w / 4)), Math.max(1, Math.round(b.h / 4))), sx = sm.getContext('2d')!;
  sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high';
  sx.drawImage(c1, 0, 0, sm.width, sm.height);
  const c2 = mk(W, H), x2 = c2.getContext('2d')!;
  x2.imageSmoothingEnabled = true; x2.imageSmoothingQuality = 'high';
  x2.globalAlpha = 0.75; x2.drawImage(sm, 0, 0, W, H);
  x2.globalAlpha = 1; x2.drawImage(c1, 0, 0, W, H);
  c1.width = c1.height = sm.width = sm.height = 0;
  sp = { mips: halfChain(c2) };
  freezeAll(sp);
  litCache.set(key, sp);
  while (litCache.size > LIT_CACHE_LIMIT) {
    const [k0, old] = litCache.entries().next().value as [string, PreparedSprite];
    litCache.delete(k0); closeAll(old);
  }
  return sp;
}

const emitCache = new Map<string, PreparedSprite>();
function emitLayer(id: string, b: NightBld, tw: number): PreparedSprite | null {
  if (!b.emit) return null;
  const key = `${id}|${tw}`;
  let sp = emitCache.get(key);
  if (!sp) {
    const k = tw / meta!.w, c = mk(Math.max(1, Math.round(b.w * k)), Math.max(1, Math.round(b.h * k))), x = c.getContext('2d')!;
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(b.emit, 0, 0, c.width, c.height);
    sp = { mips: halfChain(c) };
    freezeAll(sp);
    emitCache.set(key, sp);
  }
  return sp;
}

// окна и подсветка здания id поверх его спрайта (dx,dy,dw,dh — мировые координаты, r — device-px на
// мировой px куска). mask — горящие группы квартир
export function drawBuildingLights(ctx: CanvasRenderingContext2D, ph: Phase, id: string, mask: number, tw: number, r: number, dx: number, dy: number, dw: number, dh: number) {
  const b = meta?.b.get(id);
  if (!b) return;
  const at = placeOf(b, dx, dy, dw, dh);
  const W = Math.min(1, ph.dark * 1.4);
  if (mask && W > 0.01 && b.idx.length) {
    ctx.globalAlpha = W;
    ctx.drawImage(pickLevel(litLayer(id, b, mask, tw), at.w * r), at.x, at.y, at.w, at.h);
    ctx.globalAlpha = 1;
  }
  if (ph.lamps > 0.01) {
    const e = emitLayer(id, b, tw);
    if (e) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = ph.lamps;
      ctx.drawImage(pickLevel(e, at.w * r), at.x, at.y, at.w, at.h);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
  }
}

// ── перекрашенные спрайты: набор на ступень суток ──
interface GSet { ph: Phase; map: Map<string, PreparedSprite> }
let shown: GSet | null = null;   // этим набором карта рисуется сейчас
let next: GSet | null = null;    // этот готовится, карта переключится на него целиком
const want = new Map<string, { id: string; tw: number }>();
const missing = new Set<string>(); // дневной спрайт ещё не подготовлен — перекрасим, когда будет
let queue: string[] = [];
let pumping = false;
const keyOf = (id: string, tw: number) => `${id}@${tw}`;

function dropSet(g: GSet | null) { if (g) for (const sp of g.map.values()) closeAll(sp); }

export function setPhase(ph: Phase) {
  const cur = next ?? shown;
  if (cur && cur.ph.step === ph.step) return;
  if (ph.isDay) {
    dropSet(next); dropSet(shown);
    next = null; shown = { ph, map: new Map() }; queue = []; missing.clear();
    notify();
    return;
  }
  // первая ночная ступень — набор наполняется на глазах (карта ждёт его, см. nightBusy); смена
  // ступени — новый набор готовится целиком в фоне, пока карта рисуется прежним
  if (!shown || shown.ph.isDay) { dropSet(shown); shown = { ph, map: new Map() }; }
  else { dropSet(next); next = { ph, map: new Map() }; }
  queue = [...want.keys()]; missing.clear();
  void pump();
}

export function shownPhase(): Phase | null { return shown && !shown.ph.isDay ? shown.ph : null; }
export function nightBusy(): boolean { return metaState === 'loading' || queue.length > 0 || pumping; }

// карта собирается рисовать спрайт id шириной tw — заранее перекрасить его под текущую ступень
export function wantGraded(id: string, tw: number) {
  const k = keyOf(id, tw);
  if (want.has(k)) return;
  want.set(k, { id, tw });
  const t = next ?? shown;
  if (t && !t.ph.isDay) { queue.push(k); void pump(); }
}

export function gradedSprite(id: string, tw: number): PreparedSprite | undefined {
  return shown?.map.get(keyOf(id, tw));
}

function grade(src: Mip, id: string, ph: Phase): PreparedSprite {
  const w = src.width, h = src.height, c = mk(w, h), x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0);
  const b = meta?.b.get(id);
  if (b && b.idx.length && ph.dark > 0.3) {
    const at = placeOf(b, 0, 0, w, h);
    x.globalCompositeOperation = 'multiply';
    x.drawImage(b.shade, at.x, at.y, at.w, at.h);
    x.globalCompositeOperation = 'source-over';
  }
  const im = x.getImageData(0, 0, w, h);
  gradePixels(im.data, ph);
  x.putImageData(im, 0, 0);
  return { mips: halfChain(c, 32) };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // стёкла затемняются по разметке окон — сначала дожидаемся ночных слоёв
    if (metaState === 'loading') await metaPromise;
    while (queue.length) {
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < GRADE_SLICE_MS) {
        const k = queue.shift()!, t = next ?? shown;
        if (!t || t.ph.isDay) { queue = []; break; }
        if (t.map.has(k)) continue;
        const w = want.get(k)!, day = getPreparedSprite(w.id, w.tw);
        if (!day) { missing.add(k); continue; }
        const sp = grade(day.mips[0], w.id, t.ph);
        freezeAll(sp);
        t.map.set(k, sp);
      }
      await nextTick();
    }
    if (next) { dropSet(shown); shown = next; next = null; }
  } finally {
    pumping = false;
  }
  notify();
}

onSpritesReady(() => {
  if (!missing.size) return;
  queue.push(...missing); missing.clear();
  void pump();
});
