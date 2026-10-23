// Счётчик кадров в углу карты в духе старого оверлея NVIDIA: квадратные «рубленые» цифры ярко-
// зелёного цвета с тёмной обводкой. Цифры рисуются прямоугольниками по сетке 4×7 модулей (как
// сегменты, но с глухими прямыми углами), без шрифта — так они одинаковые на любом устройстве и
// попадают точно в пиксели экрана.
//
// Показывает реальное число перерисовок карты за последнюю секунду (requestAnimationFrame идёт и
// тогда, когда карта не перерисовывается, поэтому считаются кадры самой карты — frame()). Неподвижная
// карта не стоит пустой: раз в секунду она перерисовывается сама (heartbeat), и счётчик честно
// показывает 1. Зависание главного потока тоже видно: за такую секунду кадров меньше.

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

// запускает счётчик на переданном canvas; heartbeat — перерисовать карту (зовётся раз в секунду, если
// за полсекунды карта ни разу не перерисовалась); onSample получает каждое новое значение (раз в секунду)
export function startFpsCounter(canvas: HTMLCanvasElement, heartbeat: () => void, onSample?: (fps: number) => void): FpsCounter {
  canvas.style.position = 'absolute';
  canvas.style.left = `${MARGIN}px`;
  canvas.style.top = `${MARGIN}px`;
  canvas.style.pointerEvents = 'none';
  let frames = 0, shown = -1;
  draw(canvas, 0);
  // секунда делится на две половины: в середине секунды неподвижной карте заказывается кадр (он
  // точно попадёт в эту же секунду), в конце — итог секунды на экран
  let half = 0;
  const timer = setInterval(() => {
    half ^= 1;
    if (half) { if (frames === 0) heartbeat(); return; }
    if (frames !== shown) { shown = frames; draw(canvas, frames); }
    onSample?.(frames);
    frames = 0;
  }, SECOND_MS / 2);
  // время в фоновой вкладке — не кадры: браузер не рисует, а таймеры там приторможены
  const onVis = () => { frames = 0; half = 0; };
  document.addEventListener('visibilitychange', onVis);
  return {
    frame: () => { frames++; },
    stop: () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); },
  };
}
