// Счётчик кадров в углу карты в духе старого оверлея NVIDIA: квадратные «рубленые» цифры ярко-
// зелёного цвета с тёмной обводкой. Цифры рисуются прямоугольниками по сетке 4×7 модулей (как
// сегменты, но с глухими прямыми углами), без шрифта — так они одинаковые на любом устройстве и
// попадают точно в пиксели экрана.
//
// Считает реальные перерисовки карты (requestAnimationFrame идёт и тогда, когда карта не
// перерисовывается, поэтому считаются кадры самой карты — frame()). Как в RivaTuner Statistics Server
// (частота усредняется за период и раз в период выводится), но период 250 мс (решение
// 23.10.2026): число меняется 4 раза в секунду. Частота — кадров в окне, делённое
// на время от кадра перед окном до последнего, поэтому число не скачет на ±1 от того, попал ли крайний
// кадр в окно, а зависание главного потока честно его роняет. Когда карта трогается с места, окно
// начинается заново и число показывается сразу, не дожидаясь конца периода. Сам счётчик кадров не заказывает: неподвижная
// карта перерисовывается раз в секунду своим тиком (liveTimer в CityActionsCanvas), и счётчик
// показывает 1.

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

const WINDOW_MS = 250;   // окно усреднения и период обновления числа (RefreshPeriod у RTSS): 4 раза в секунду

export interface FpsCounter {
  frame(): void;    // карта перерисована
  stop(): void;
}

// запускает счётчик на переданном canvas; onSample получает значение на каждом кадре карты
export function startFpsCounter(canvas: HTMLCanvasElement, onSample?: (fps: number) => void): FpsCounter {
  canvas.style.position = 'absolute';
  canvas.style.left = `${MARGIN}px`;
  canvas.style.top = `${MARGIN}px`;
  canvas.style.pointerEvents = 'none';
  const times: number[] = [];   // метки кадров карты за окно и одного кадра перед ним
  let shown = -1, drawnAt = -Infinity;
  draw(canvas, 0);
  // время в фоновой вкладке — не кадры: браузер не рисует, а таймеры там приторможены
  const onVis = () => { times.length = 0; };
  document.addEventListener('visibilitychange', onVis);
  return {
    frame: () => {
      const now = performance.now();
      // карта резко ускорилась (стояла и поехала): кадр пришёл вчетверо быстрее среднего по окну —
      // старые редкие кадры окна выбрасываются, иначе число ползло бы от 1 до 144. Порог 4×, чтобы
      // обычные рывки (кадр через один) окно не сбрасывали. Замедление так не сбрасывается: провал и
      // остановка честно видны по окну
      const n = times.length;
      const restart = n >= 2 && (now - times[n - 1]) * 4 < (times[n - 1] - times[0]) / (n - 1);
      if (restart) times.splice(0, n - 1);
      times.push(now);
      while (times.length > 2 && times[1] <= now - WINDOW_MS) times.shift();
      const span = now - times[0];
      const fps = times.length > 1 && span > 0 ? Math.round((times.length - 1) * 1000 / span) : 0;
      // число — раз в окно; после рестарта окна — сразу, на втором кадре движения уже верное
      if (restart || now - drawnAt >= WINDOW_MS) {
        drawnAt = now;
        if (fps !== shown) { shown = fps; draw(canvas, fps); }
      }
      onSample?.(fps);
    },
    stop: () => document.removeEventListener('visibilitychange', onVis),
  };
}
