// Подготовка спрайтов карты под реальный экран.
//
// Игра отдаёт здания кадрами шириной 753px в атласах до 2259×2262 — распакованный атлас занимает
// до 20 МБ памяти, а на карте здание никогда не бывает шире TW*1.05*MAX_SCALE css-px (~190 px,
// ×devicePixelRatio на ретине). Прозрачных полей у кадров почти нет (игра их уже обрезала, проверено
// по всем кадрам: 0,3%), поэтому «кроп» здесь — по разрешению: каждый нужный кадр один раз
// вырезается из атласа в свой canvas и уменьшается ровно до максимального экранного размера
// (1 пиксель спрайта = 1 пиксель экрана на максимальном зуме — глазом не отличить от оригинала).
// Уменьшение — цепочкой половинок (каждый шаг 2:1 с билинейной фильтрацией = усреднение 2×2),
// иначе одно большое сжатие 753→190 даёт «лесенку» и мерцание мелких деталей. Дальше от того же
// уровня строятся mip-уровни (каждый вдвое меньше): на отдалённом зуме рисуется ближайший по
// размеру уровень, а не большая картинка с пропуском пикселей. Атлас после нарезки отпускается.

export interface SpriteFrame { x: number; y: number; w: number; h: number }
export interface SpriteInfo { pngUrl: string; frame: SpriteFrame }
// уровни хранятся как ImageBitmap: неизменяемая картинка один раз уходит в видеопамять. Сотни
// отдельных canvas-источников браузер держать на GPU не умеет — часть уходит в программный режим, и
// каждое рисование такого canvas в кусок карты превращается в копирование из видеопамяти и обратно
type Mip = ImageBitmap | HTMLCanvasElement;
export interface PreparedSprite { mips: Mip[] } // mips[0] — самый крупный уровень

const prepared = new Map<string, PreparedSprite>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let running = false;
const jobs: { key: string; info: SpriteInfo; targetW: number }[] = [];

const keyOf = (id: string, targetW: number) => `${id}@${targetW}`;

export function getPreparedSprite(id: string, targetW: number): PreparedSprite | undefined {
  return prepared.get(keyOf(id, targetW));
}

// уровень, который при отрисовке шириной needW (device-px) ещё не меньше нужного — меньший
// уровень пришлось бы растягивать (мыло), больший — сжимать с пропуском пикселей (рябь)
export function pickMip(sp: PreparedSprite, needW: number): Mip {
  const m = sp.mips;
  for (let i = m.length - 1; i > 0; i--) if (m[i].width >= needW) return m[i];
  return m[0];
}

export function onSpritesReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function half(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = Math.max(1, Math.round(src.width / 2)), h = Math.max(1, Math.round(src.height / 2));
  const c = makeCanvas(w, h), ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  return c;
}

function cut(img: HTMLImageElement, f: SpriteFrame, targetW: number): HTMLCanvasElement[] {
  // 1:1 копия кадра в отдельный canvas — дальше сэмплинг не цепляет соседние кадры атласа
  let cur = makeCanvas(f.w, f.h);
  cur.getContext('2d')!.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  const tw = Math.min(targetW, f.w);
  while (cur.width / 2 >= tw) cur = half(cur);
  if (cur.width !== tw) {
    const th = Math.max(1, Math.round(f.h * tw / f.w));
    const c = makeCanvas(tw, th), ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, tw, th);
    cur = c;
  }
  const mips = [cur];
  while (mips[mips.length - 1].width >= 32) mips.push(half(mips[mips.length - 1]));
  return mips;
}

async function freeze(canvases: HTMLCanvasElement[]): Promise<Mip[]> {
  if (typeof createImageBitmap !== 'function') return canvases;
  try {
    const out = await Promise.all(canvases.map(c => createImageBitmap(c)));
    for (const c of canvases) { c.width = 0; c.height = 0; }
    return out;
  } catch {
    return canvases;
  }
}

// Атласы качаются все сразу, параллельно, как только карта заказала из них первый кадр: нарезка идёт
// по одному атласу, и раньше каждый следующий файл начинал качаться только после нарезки прежнего.
// Держим сжатый файл (Blob), а не картинку: распакованный атлас — до 20 МБ памяти, сжатый — сотни КБ.
// Сжатый файл остаётся на сессию: новые кадры того же атласа не требуют повторного fetch.
const atlases = new Map<string, Promise<Blob | null>>();
const atlasesDone = new Set<string>(); // файл атласа уже пришёл (или не пришёл совсем) — для шкалы загрузки

function fetchAtlas(url: string): Promise<Blob | null> {
  let p = atlases.get(url);
  if (!p) {
    p = fetch(url).then(r => (r.ok ? r.blob() : null)).catch(() => null).finally(() => { atlasesDone.add(url); });
    atlases.set(url, p);
  }
  return p;
}

export function atlasFetched(url: string): boolean {
  return atlasesDone.has(url);
}

// кадр готов или его подготовка уже закончилась неудачей (битый атлас) — ждать его больше нечего
export function spriteSettled(id: string, targetW: number): boolean {
  const key = keyOf(id, targetW);
  return prepared.has(key) || !queued.has(key);
}

async function loadAtlas(url: string): Promise<HTMLImageElement | null> {
  const blob = await fetchAtlas(url);
  if (!blob) return loadImage(url); // не скачался — последняя попытка обычной загрузкой картинки
  const obj = URL.createObjectURL(blob);
  try { return await loadImage(obj); } finally { URL.revokeObjectURL(obj); }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(res => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

const nextTick = () => new Promise<void>(r => setTimeout(r, 0));

async function pump() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      // одним заходом — все задания одного атласа: атлас грузится (из кэша браузера) один раз и
      // сразу отпускается после нарезки
      const url = jobs[0].info.pngUrl;
      const batch = jobs.filter(j => j.info.pngUrl === url);
      for (const j of batch) jobs.splice(jobs.indexOf(j), 1);
      const img = await loadAtlas(url);
      for (const j of batch) {
        if (img) {
          try { prepared.set(j.key, { mips: await freeze(cut(img, j.info.frame, j.targetW)) }); } catch { /* битый кадр — останется заглушка */ }
        }
        queued.delete(j.key);
        await nextTick(); // не держим главный поток дольше одного кадра
      }
      for (const fn of listeners) fn();
    }
  } finally {
    running = false;
  }
}

export function requestSprite(id: string, info: SpriteInfo, targetW: number) {
  const key = keyOf(id, targetW);
  if (prepared.has(key) || queued.has(key)) return;
  queued.add(key);
  jobs.push({ key, info, targetW });
  void fetchAtlas(info.pngUrl);
  void pump();
}
