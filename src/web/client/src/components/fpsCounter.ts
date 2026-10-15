// Счётчик кадров в углу карты в духе старого оверлея NVIDIA: квадратные «рубленые» цифры ярко-
// зелёного цвета с тёмной обводкой. Цифры рисуются прямоугольниками по сетке 4×7 модулей (как
// сегменты, но с глухими прямыми углами), без шрифта — так они одинаковые на любом устройстве и
// попадают точно в пиксели экрана.
//
// Считает кадры самой карты, а не «тики» браузера: requestAnimationFrame идёт 60 раз в секунду и
// тогда, когда карта не успевает перерисоваться, поэтому прежний счётчик показывал 60 при заметных
// рывках. Теперь каждая перерисовка карты отмечается (frame), и длительность кадра — это время от
// предыдущего кадра (или от запроса перерисовки, если карта до этого стояла) до текущего. Зависание
// на 100 мс внутри окна замера честно роняет число. Пока карта неподвижна, кадров нет и число не
// меняется — показано последнее значение.

const COLOR = '#76b900';
const OUTLINE = 'rgba(0,0,0,0.85)';
const U = 3;          // модуль цифры, css-px: цифра 12×21
const GAP = 1;        // промежуток между цифрами, в модулях
const MARGIN = 8;     // отступ от левого верхнего угла canvas, css-px

// a — верх, b — правый верх, c — правый низ, d — низ, e — левый низ, f — левый верх, g — середина
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 0, 4, 1], b: [3, 0, 1, 4], c: [3, 3, 1, 4], d: [0, 6, 4, 1],
  e: [0, 3, 1, 4], f: [0, 0, 1, 4], g: [0, 3, 4, 1],
};
const DIGITS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];

function draw(canvas: HTMLCanvasElement, value: number) {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const u = Math.max(1, Math.round(U * dpr)), o = Math.max(1, Math.round(dpr)); // модуль и обводка — целые device-px
  const text = String(Math.max(0, Math.min(999, Math.round(value))));
  const w = text.length * 4 * u + (text.length - 1) * GAP * u + 2 * o, h = 7 * u + 2 * o;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    canvas.style.width = `${w / dpr}px`; canvas.style.height = `${h / dpr}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const rects: [number, number, number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const x0 = o + i * (4 + GAP) * u;
    for (const s of DIGITS[+text[i]]) {
      const [x, y, rw, rh] = SEG[s];
      rects.push([x0 + x * u, o + y * u, rw * u, rh * u]);
    }
  }
  ctx.fillStyle = OUTLINE;
  for (const [x, y, rw, rh] of rects) ctx.fillRect(x - o, y - o, rw + 2 * o, rh + 2 * o);
  ctx.fillStyle = COLOR;
  for (const [x, y, rw, rh] of rects) ctx.fillRect(x, y, rw, rh);
}

const WINDOW_MS = 500;   // окно усреднения
const MIN_FRAMES = 3;    // меньше кадров в окне — копим дальше, одиночный кадр ничего не говорит

export interface FpsCounter {
  request(): void;  // запрошена перерисовка карты (отсюда считается кадр, если карта стояла)
  frame(): void;    // карта перерисована
  stop(): void;
}

// запускает счётчик на переданном canvas; onSample получает каждое новое значение (раз в ~0,5 с
// активности карты)
export function startFpsCounter(canvas: HTMLCanvasElement, onSample?: (fps: number) => void): FpsCounter {
  canvas.style.position = 'absolute';
  canvas.style.left = `${MARGIN}px`;
  canvas.style.top = `${MARGIN}px`;
  canvas.style.pointerEvents = 'none';
  let reqAt = -1, last = -Infinity, frames = 0, sum = 0, winStart = performance.now(), shown = -1;
  // период обновления экрана: быстрее него карта показаться не может, даже если перерисовка
  // запрошена за миллисекунду до кадра. Оценка — самый короткий интервал между кадрами подряд
  let vsync = 1000 / 60;
  draw(canvas, 0);
  const frame = () => {
    const now = performance.now();
    let dt: number;
    if (reqAt >= 0 && reqAt > last) dt = now - reqAt;    // карта стояла — кадр от запроса
    else if (reqAt >= 0) {                                // карта двигалась — кадр от прошлого кадра
      dt = now - last;
      if (dt >= 4 && dt < vsync) vsync = dt;
    } else dt = Math.min(now - last, vsync);              // перерисовка по таймеру без запроса
    dt = Math.max(dt, vsync);
    reqAt = -1; last = now;
    frames++; sum += dt;
    if (frames >= MIN_FRAMES && now - winStart >= WINDOW_MS) {
      const fps = Math.round(frames * 1000 / sum);
      if (fps !== shown) { shown = fps; draw(canvas, fps); }
      onSample?.(fps);
      frames = 0; sum = 0; winStart = now;
    }
  };
  const request = () => { if (reqAt < 0) reqAt = performance.now(); };
  // время в фоновой вкладке — не кадр
  const onVis = () => { reqAt = -1; last = -Infinity; frames = 0; sum = 0; winStart = performance.now(); };
  document.addEventListener('visibilitychange', onVis);
  return { frame, request, stop: () => document.removeEventListener('visibilitychange', onVis) };
}
