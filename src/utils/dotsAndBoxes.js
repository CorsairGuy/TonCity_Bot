'use strict';
// «Точки и коробки» (dots_and_boxes) — пятый балаган Карнавальной аллеи.
//
// Разметка снята с бандла игры (chunk anniversary_midway, 23.08.2026), не додумана:
//   поле N×N коробок (в игре N=5, коробок 25), точек (N+1)², линий 2*N*(N+1) = 60;
//   горизонтальные линии первыми: id = row*N + col, row 0..N, col 0..N-1  → 0..29;
//   вертикальные следом:          id = N*(N+1) + row*(N+1) + col          → 30..59;
//   стороны коробки (r,c): [гор(r,c), гор(r+1,c), верт(r,c), верт(r,c+1)];
//   `lines` — строка из 60 символов ('.', '1', '2'), `boxes` — из 25.
// Ход: POST .../move {line}. Замкнул коробку — забрал её И ХОДИШЬ СНОВА.
//
// Игру решает не жадность, а ЦЕПОЧКИ. Когда безопасных ходов не остаётся, недостающие линии
// образуют цепочки (пути коробок) и петли (циклы). Дальше всё считается точно: кто вынужден
// вскрыть цепочку, тот её дарит; получатель может забрать её целиком и вскрывать следующую сам,
// а может отдать две последние коробки («двойной крест») и оставить ход сопернику.
//
// Живьём 23.08.2026: жадный вариант проиграл боту игры 2:13, вариант со случайными доигровками дал
// 2 победы из 5. Точный расчёт цепочек — то, ради чего этот файл выглядит сложно.

const DEFAULT_N = 5;
const GROUND = -1;

function geometry(n) {
  const dots = n + 1;
  const hCount = dots * n;
  const total = hCount + n * dots;
  const boxes = n * n;
  const sides = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      sides.push([r * n + c, (r + 1) * n + c, hCount + r * dots + c, hCount + r * dots + c + 1]);
    }
  }
  const near = [];
  for (let line = 0; line < total; line++) {
    const list = [];
    if (line < hCount) {
      const row = Math.floor(line / n), col = line % n;
      if (row > 0) list.push((row - 1) * n + col);
      if (row < n) list.push(row * n + col);
    } else {
      const idx = line - hCount, row = Math.floor(idx / dots), col = idx % dots;
      if (col > 0) list.push(row * n + col - 1);
      if (col < n) list.push(row * n + col);
    }
    near.push(list);
  }
  return { n, dots, hCount, total, boxes, sides, near };
}

const CACHE = new Map();
const geo = n => { if (!CACHE.has(n)) CACHE.set(n, geometry(n)); return CACHE.get(n); };
const sizeFromLines = lines => {
  for (let n = 2; n <= 12; n++) if (geo(n).total === lines.length) return n;
  return DEFAULT_N;
};

const drawnSides = (g, lines, box) => g.sides[box].reduce((k, l) => k + (lines[l] !== '.' ? 1 : 0), 0);

function draw(g, lines, line, mark) {
  const next = `${lines.slice(0, line)}${mark}${lines.slice(line + 1)}`;
  const claimed = g.near[line].filter(box => drawnSides(g, next, box) === 4);
  return { lines: next, claimed };
}

const freeLines = (g, lines) => {
  const out = [];
  for (let i = 0; i < g.total; i++) if (lines[i] === '.') out.push(i);
  return out;
};

const capturing = (g, lines, free) => free.filter(l => g.near[l].some(b => drawnSides(g, lines, b) === 3));
const safe = (g, lines, free) => free.filter(l => !g.near[l].some(b => drawnSides(g, lines, b) === 2));

// ── позиция в быстром виде: счётчики сторон + свободные линии ────────────────
function fastState(g, lines) {
  const counts = new Int8Array(g.boxes);
  const free = [];
  for (let l = 0; l < g.total; l++) {
    if (lines[l] === '.') free.push(l);
    else for (const b of g.near[l]) counts[b]++;
  }
  return { counts, free };
}

// Позиция «разобрана» (в теории её зовут loony), если у каждой недостроенной коробки уже не меньше
// двух сторон: только тогда недостающие линии складываются в цепочки и петли и работает точный
// расчёт. Одного отсутствия безопасных ходов НЕ хватает — в поле может остаться коробка с одной
// стороной, и разбор на цепочки даст чушь (на этом первая версия проиграла 23 партии из 30).
const isDecomposed = (g, counts) => {
  for (let b = 0; b < g.boxes; b++) if (counts[b] < 2 && counts[b] !== 4) return false;
  return true;
};

const isCapture = (g, counts, line) => g.near[line].some(b => counts[b] === 3);
const isSafe = (g, counts, line) => !g.near[line].some(b => counts[b] === 2);

// ── разбор позиции на цепочки и петли ────────────────────────────────────────
// Узлы — недостроенные коробки, рёбра — ещё не проведённые линии; линия с одной коробкой ведёт
// «на землю» (край поля). Пока есть безопасные ходы, у коробок бывает степень 3-4 и разбор
// бессмыслен — он применяется ровно тогда, когда безопасных ходов не осталось: тогда каждая
// компонента это путь (цепочка) или цикл (петля).
function decompose(g, counts, free) {
  const inc = Array.from({ length: g.boxes }, () => []);
  for (const line of free) {
    const bs = g.near[line];
    if (bs.length === 1) inc[bs[0]].push({ line, other: GROUND });
    else { inc[bs[0]].push({ line, other: bs[1] }); inc[bs[1]].push({ line, other: bs[0] }); }
  }
  const seen = new Uint8Array(g.boxes);
  const comps = [];
  for (let start = 0; start < g.boxes; start++) {
    if (seen[start] || counts[start] === 4) continue;
    const boxes = [], lines = new Set();
    const stack = [start];
    seen[start] = 1;
    let groundEnds = 0;
    while (stack.length) {
      const b = stack.pop();
      boxes.push(b);
      for (const { line, other } of inc[b]) {
        lines.add(line);
        if (other === GROUND) { groundEnds++; continue; }
        if (!seen[other]) { seen[other] = 1; stack.push(other); }
      }
    }
    // петля — цикл: рёбер столько же, сколько коробок, и ни одного выхода на землю
    const loop = groundEnds === 0 && lines.size === boxes.length;
    comps.push({ boxes, lines: [...lines], size: boxes.length, groundEnds, loop });
  }
  return comps;
}

// Открытая компонента — та, где уже есть коробка с тремя сторонами: её забирают прямо сейчас.
const isOpen = (comp, counts) => comp.boxes.some(b => counts[b] === 3);

// ── точная ценность позиции, разобранной на компоненты ───────────────────────
// Компонента описывается тройкой: сколько в ней коробок, «хвост» (2 у цепочки, 4 у петли) и
// вскрыта ли она уже (в ней есть коробка с тремя сторонами — её можно есть прямо сейчас).
//
// value(S) — разница коробок для того, чей ход:
//   есть вскрытая компонента → он либо съедает её целиком и ходит дальше сам,
//                              либо отдаёт хвост k и передаёт ход соперником;
//   вскрытых нет → он обязан вскрыть какую-то, и дальше считает уже соперник.
// Короткие цепочки (1-2 коробки) вскрывают «жёстким подарком» — разрезают посередине, и отказаться
// сопернику нечем.
//
// ВАЖНО: вскрытых компонент может быть НЕСКОЛЬКО одновременно — например, когда соперник разрезал
// длинную цепочку посередине. Первая версия считала лишнюю вскрытую компоненту закрытой и врала на
// целые цепочки (живая партия давала −11 там, где расчёт обещал +17).
const valueCache = new Map();
const compTag = c => (c.open ? 'o' : 'c') + (c.tail === 4 ? 'L' : 'C') + c.size;

function valuePosition(comps) {
  if (!comps.length) return 0;
  const key = comps.map(compTag).sort().join(',');
  const hit = valueCache.get(key);
  if (hit !== undefined) return hit;

  let result;
  const openList = comps.map((c, i) => (c.open ? i : -1)).filter(i => i >= 0);
  if (openList.length) {
    // Вскрытых компонент может быть несколько — выбирать нужно И какую есть, И есть ли целиком.
    let best = -Infinity;
    const tried = new Set();
    for (const i of openList) {
      const tag = compTag(comps[i]);
      if (tried.has(tag)) continue;
      tried.add(tag);
      const X = comps[i];
      const restValue = valuePosition(comps.filter((_, j) => j !== i));
      const takeAll = X.size + restValue;                     // съесть всё и вскрывать самому
      const decline = X.size >= X.tail
        ? (X.size - X.tail) - (X.tail + restValue)            // отдать хвост, ход у соперника
        : -Infinity;
      best = Math.max(best, takeAll, decline);
    }
    result = best;
  } else {
    let best = -Infinity;
    const tried = new Set();
    for (let i = 0; i < comps.length; i++) {
      const tag = compTag(comps[i]);
      if (tried.has(tag)) continue;
      tried.add(tag);
      best = Math.max(best, -valueAfterOpening(comps, i));
    }
    result = best;
  }
  valueCache.set(key, result);
  return result;
}

// Ценность ДЛЯ СОПЕРНИКА после того, как мы вскрыли компоненту i.
function valueAfterOpening(comps, i) {
  const X = comps[i];
  const rest = comps.filter((_, j) => j !== i);
  if (X.tail === 2 && X.size <= 2) return X.size + valuePosition(rest);   // жёсткий подарок
  return valuePosition([...rest, { ...X, open: true }]);
}

// Компоненты доски в виде, понятном value: размер, хвост, вскрыта ли.
const asComps = (g, counts, free) => decompose(g, counts, free).map(c => ({
  size: c.size,
  tail: c.loop || c.groundEnds === 0 ? 4 : 2,     // вскрытая петля тоже отдаётся четвёркой
  open: c.boxes.some(b => counts[b] === 3),
  ref: c,
}));

// Совместимость со старым именем: ценность набора закрытых компонент.
const valueClosed = comps => valuePosition(comps.map(c => ({
  size: c.size, tail: c.loop ? 4 : 2, open: false,
})));

// ── ход в разобранной позиции ────────────────────────────────────────────────
// Здесь живёт «двойной крест»: иногда правильно НЕ забирать хвост, чтобы вскрывал соперник.
function closedPhaseLine(g, counts, free) {
  const comps = asComps(g, counts, free);
  const capture = () => free.find(l => isCapture(g, counts, l));
  const openList = comps.filter(c => c.open);

  if (openList.length) {
    // выбираем, какую вскрытую компоненту трогать и съедать ли её целиком
    let pick = null;
    for (const X of openList) {
      const rest = valuePosition(comps.filter(c => c !== X));
      const takeAll = X.size + rest;
      const decline = X.size >= X.tail ? (X.size - X.tail) - (X.tail + rest) : -Infinity;
      const score = Math.max(takeAll, decline);
      if (!pick || score > pick.score) pick = { X, score, take: takeAll >= decline };
    }
    const inComp = l => pick.X.ref.lines.includes(l);
    if (pick.take) return free.find(l => inComp(l) && isCapture(g, counts, l)) ?? capture();
    // отдаём хвост, но сперва доедаем всё, кроме последних X.tail коробок
    if (pick.X.size > pick.X.tail) return free.find(l => inComp(l) && isCapture(g, counts, l)) ?? capture();
    const cut = pick.X.ref.lines.find(l => !isCapture(g, counts, l));
    return cut === undefined ? capture() : cut;
  }

  let bestLine = free[0], best = -Infinity;
  for (let i = 0; i < comps.length; i++) {
    const v = -valueAfterOpening(comps, i);
    if (v > best) {
      best = v;
      const comp = comps[i].ref;
      // цепочку из двух коробок режем ПОСЕРЕДИНЕ (отказаться сопернику нечем), длинную вскрываем
      // с края линией на землю, петлю — любой её линией
      bestLine = (comps[i].tail === 2 && comps[i].size === 2)
        ? (comp.lines.find(l => g.near[l].length === 2) ?? comp.lines[0])
        : (comp.lines.find(l => g.near[l].length === 1) ?? comp.lines[0]);
    }
  }
  return bestLine;
}

// ── оценка хода доигровкой безопасной фазы ───────────────────────────────────
// Доигрываем только «безопасную» часть (случайные безопасные ходы, замыкания забираем), а как
// только безопасные ходы кончились — считаем цепочки точно. Доигровка коротка и не врёт о концовке.
function playoutValue(g, counts0, free0, turn, me) {
  const counts = Int8Array.from(counts0);
  const free = free0.slice();
  let seat = turn, diff = 0;
  for (let guard = 0; guard < 200; guard++) {
    if (!free.length) break;
    let idx = -1;
    for (let i = 0; i < free.length; i++) if (isCapture(g, counts, free[i])) { idx = i; break; }
    if (idx < 0) {
      if (isDecomposed(g, counts)) break;                          // дальше — точный расчёт
      const safeIdx = [];
      for (let i = 0; i < free.length; i++) if (isSafe(g, counts, free[i])) safeIdx.push(i);
      idx = safeIdx.length ? safeIdx[(Math.random() * safeIdx.length) | 0]
                           : (Math.random() * free.length) | 0;    // вскрываем наугад
    }
    const line = free[idx];
    free[idx] = free[free.length - 1];
    free.pop();
    let got = 0;
    for (const b of g.near[line]) if (++counts[b] === 4) got++;
    if (got) diff += (seat === me ? got : -got);
    else seat = seat === 1 ? 2 : 1;
  }
  if (!free.length) return diff;
  const v = valuePosition(asComps(g, counts, free));               // глазами того, чей ход
  return diff + (seat === me ? v : -v);
}

// ── точный расчёт «безопасной» фазы ──────────────────────────────────────────
// Пока идут безопасные ходы, коробки не достаются никому — но именно здесь решается, КТО первым
// будет вынужден вскрыть цепочку. Проведённая линия безопасность только отнимает (счётчики сторон
// растут), поэтому все достижимые позиции — это подмножества исходного набора безопасных линий:
// при 14 линиях это 16 тысяч состояний, то есть фазу можно досчитать точно, а не угадывать.
// Терминал считаем по цепочкам, а если позиция ещё не разобралась — доигровками.
function solveSafePhase(g, counts0, free0, safeList, rollouts) {
  const memo = new Map();
  const applied = new Int8Array(counts0.length);

  const valueOf = (mask, counts, free) => {
    const avail = [];
    for (let i = 0; i < safeList.length; i++) {
      if (mask & (1 << i)) continue;
      if (isSafe(g, counts, safeList[i])) avail.push(i);
    }
    if (!avail.length) {                                     // безопасные кончились — считаем итог
      if (isDecomposed(g, counts)) return { score: valuePosition(asComps(g, counts, free)), move: null };
      let total = 0;
      for (let i = 0; i < rollouts; i++) total += playoutValue(g, counts, free, 1, 1);
      return { score: total / rollouts, move: null };
    }
    let best = -Infinity, bestMove = safeList[avail[0]];
    for (const i of avail) {
      const line = safeList[i];
      const c2 = Int8Array.from(counts);
      for (const b of g.near[line]) c2[b]++;
      const v = -solve(mask | (1 << i), c2, free.filter(l => l !== line)).score;
      if (v > best) { best = v; bestMove = line; }
    }
    return { score: best, move: bestMove };
  };

  const solve = (mask, counts, free) => {
    const hit = memo.get(mask);
    if (hit) return hit;
    const res = valueOf(mask, counts, free);
    memo.set(mask, res);
    return res;
  };

  void applied;
  return solve(0, counts0, free0);
}

// ── выбор хода ───────────────────────────────────────────────────────────────
function bestMove(game, opts = {}) {
  const lines = String(game?.lines || '');
  if (!lines) return null;
  const g = geo(sizeFromLines(lines));
  const { counts, free } = fastState(g, lines);
  if (!free.length) return null;

  const safeMoves = free.filter(l => isSafe(g, counts, l));
  if (isDecomposed(g, counts)) return { line: closedPhaseLine(g, counts, free) };

  // Безопасные ходы ещё есть: чем кончится дележ цепочек, на один ход вперёд не видно, поэтому
  // кандидатов сравниваем доигровками с точной оценкой концовки.
  const seat = Number(game?.seat) === 2 ? 2 : 1;
  const foe = seat === 1 ? 2 : 1;
  const sims = Number.isFinite(opts.sims) ? opts.sims : 400;
  const caps = free.filter(l => isCapture(g, counts, l));
  const candidates = caps.length ? [...caps, ...safeMoves] : (safeMoves.length ? safeMoves : free);
  if (candidates.length === 1) return { line: candidates[0] };

  // Если безопасных ходов осталось немного, всю фазу можно досчитать точно — это надёжнее любых
  // доигровок, потому что чётность цепочек решается именно последними безопасными ходами.
  const SAFE_EXACT = Number.isFinite(opts.safeExact) ? opts.safeExact : 14;
  if (!caps.length && safeMoves.length && safeMoves.length <= SAFE_EXACT) {
    const res = solveSafePhase(g, counts, free, safeMoves, 12);
    if (res.move !== null && res.move !== undefined) return { line: res.move };
  }

  const per = Math.max(15, Math.round(sims / candidates.length));
  let best = candidates[0], bestScore = -Infinity;
  for (const line of candidates) {
    const c2 = Int8Array.from(counts);
    const rest = free.filter(l => l !== line);
    let got = 0;
    for (const b of g.near[line]) if (++c2[b] === 4) got++;
    const nextTurn = got ? seat : foe;
    let total = 0;
    for (let i = 0; i < per; i++) total += playoutValue(g, c2, rest, nextTurn, seat);
    const score = got + total / per;
    if (score > bestScore) { bestScore = score; best = line; }
  }
  return { line: best };
}

module.exports = {
  geometry: geo, draw, freeLines, capturing, safe, drawnSides,
  fastState, decompose, valueClosed, valuePosition, asComps, closedPhaseLine, isDecomposed, bestMove,
};
