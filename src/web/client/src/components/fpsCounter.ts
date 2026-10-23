// Счётчик кадров в углу карты в духе старого оверлея NVIDIA: квадратные «рубленые» цифры ярко-
// зелёного цвета с тёмной обводкой. Цифры рисуются прямоугольниками по сетке 4×7 модулей (как
// сегменты, но с глухими прямыми углами), без шрифта — так они одинаковые на любом устройстве и
// попадают точно в пиксели экрана.
//
// Показывает реальное число перерисовок карты за последнюю секунду (requestAnimationFrame идёт и
// тогда, когда карта не перерисовывается, поэтому считаются кадры самой карты — frame()). Окно
// скользящее, и число перерисовывается на каждом кадре карты: 144 кадра — 144 обновления счётчика.
// Неподвижная карта не стоит пустой: через секунду без кадров она перерисовывается сама (heartbeat),
// и счётчик честно показывает 1. Зависание главного потока тоже видно: за такую секунду кадров меньше.

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

const SECOND_MS = 1000;

export interface FpsCounter {
  frame(): void;    // карта перерисована
  stop(): void;
}

// запускает счётчик на переданном canvas; heartbeat — перерисовать карту (зовётся, если карта секунду
// не перерисовывалась); onSample получает значение на каждом кадре
export function startFpsCounter(canvas: HTMLCanvasElement, heartbeat: () => void, onSample?: (fps: number) => void): FpsCounter {
  canvas.style.position = 'absolute';
  canvas.style.left = `${MARGIN}px`;
  canvas.style.top = `${MARGIN}px`;
  canvas.style.pointerEvents = 'none';
  const times: number[] = [];   // метки кадров карты за последнюю секунду
  let shown = -1, idle: ReturnType<typeof setTimeout> | null = null;
  draw(canvas, 0);
  // кадр по таймеру приходит чуть позже секунды (плюс ожидание requestAnimationFrame), поэтому
  // прошлый кадр уже выпал из окна и стоящая карта показывает ровно 1. Таймер взводится заново и
  // сам: перерисовка может выйти раньше кадра (карта ещё без размера или данных)
  const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { arm(); heartbeat(); }, SECOND_MS); };
  arm();
  // время в фоновой вкладке — не кадры: браузер не рисует, а таймеры там приторможены
  const onVis = () => { times.length = 0; arm(); };
  document.addEventListener('visibilitychange', onVis);
  return {
    frame: () => {
      const now = performance.now();
      times.push(now);
      while (times[0] <= now - SECOND_MS) times.shift();
      if (times.length !== shown) { shown = times.length; draw(canvas, shown); }
      onSample?.(shown);
      arm();
    },
    stop: () => { if (idle) clearTimeout(idle); document.removeEventListener('visibilitychange', onVis); },
  };
}
