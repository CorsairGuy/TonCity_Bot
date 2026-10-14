'use strict';
// Солвер «Морского боя» — балаган 2-го дня Карнавальной аллеи (/anniversary-midway/battleship/...).
//
// Формат игры сверен с бандлом (chunks/anniversary_midway-*) и живой партией 20.08.2026:
//   поле 10×10, индекс клетки = row*10 + col;
//   корабль в запросе — {row, col, length, horizontal};
//   выстрел — POST .../fire {cell:<индекс>};
//   сетки в ответе (grids): fleet — свой флот, incoming — по нам, firing — наши выстрелы;
//   символы: '.' неизвестно/пусто, 'x' попадание, 'o' промах, '~' «доказано пусто»
//   (игра сама помечает клетки вокруг потопленного корабля).
//
// Два флота: armada [5,4,3,3,2] и flotilla [4,3,3,2,2,2,1,1,1,1] — приходят в состоянии аллеи.

const W = 10, H = 10, SIZE = W * H;
const cellOf = (row, col) => row * W + col;
const rowOf = c => Math.floor(c / W);
const colOf = c => c % W;

// клетки корабля или null, если он не влезает в поле
function shipCells(ship) {
  const { row, col, length, horizontal } = ship;
  if (length < 1 || row < 0 || col < 0) return null;
  if (horizontal ? col + length > W : row + length > H) return null;
  if (horizontal ? row >= H : col >= W) return null;
  const out = [];
  for (let i = 0; i < length; i++) out.push(horizontal ? cellOf(row, col + i) : cellOf(row + i, col));
  return out;
}

// соседи клетки, по умолчанию включая диагонали: корабли не должны соприкасаться даже углами
function neighbors(cell, withDiagonals = true) {
  const r = rowOf(cell), c = colOf(cell);
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  if (withDiagonals) deltas.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  const out = [];
  for (const [dr, dc] of deltas) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < H && cc >= 0 && cc < W) out.push(cellOf(rr, cc));
  }
  return out;
}

// можно ли поставить корабль рядом с уже расставленными (без наложений и касаний)
function fits(ship, placed) {
  const cells = shipCells(ship);
  if (!cells) return false;
  const busy = new Set();
  for (const p of placed) {
    const pc = shipCells(p) || [];
    for (const c of pc) { busy.add(c); for (const n of neighbors(c)) busy.add(n); }
  }
  return cells.every(c => !busy.has(c));
}

// Случайная валидная расстановка. Позиция флота на исход почти не влияет (бот стреляет вслепую),
// поэтому не мудрим — важно лишь, чтобы игра приняла расстановку с первого раза.
function randomFleet(lengths) {
  const order = [...lengths].sort((a, b) => b - a);          // крупные ставим первыми — им теснее
  for (let attempt = 0; attempt < 200; attempt++) {
    const placed = [];
    let failed = false;
    for (const length of order) {
      let done = false;
      for (let i = 0; i < 400 && !done; i++) {
        const ship = {
          row: Math.floor(Math.random() * H),
          col: Math.floor(Math.random() * W),
          length,
          horizontal: Math.random() < 0.5,
        };
        if (fits(ship, placed)) { placed.push(ship); done = true; }
      }
      if (!done) { failed = true; break; }
    }
    if (!failed) return placed;
  }
  return [];
}

// ── выбор выстрела ───────────────────────────────────────────────────────────
// Две фазы, как в классическом решении:
//   1) добивание: есть попадания, не входящие в потопленные корабли — бьём вдоль линии;
//   2) поиск: карта вероятностей — для каждого оставшегося корабля перебираем все его возможные
//      положения и копим счётчик по клеткам; бьём в максимум. Это заметно лучше «шахматки»:
//      частота автоматически учитывает и длины оставшихся кораблей, и уже известные промахи.
const isBlocked = ch => ch === 'o' || ch === '~';           // промах и «доказано пусто»
const isHit = ch => ch === 'x';
const isUnknown = ch => ch === '.';

// связная группа попаданий, к которой принадлежит cell (по горизонтали/вертикали)
function hitGroup(grid, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    for (const n of neighbors(c, false)) {
      if (!seen.has(n) && isHit(grid[n])) { seen.add(n); stack.push(n); }
    }
  }
  return [...seen];
}

// кандидаты на добивание группы попаданий
function finishCandidates(grid, group) {
  const out = [];
  if (group.length === 1) {
    for (const n of neighbors(group[0], false)) if (isUnknown(grid[n])) out.push(n);
    return out;
  }
  const rows = new Set(group.map(rowOf)), cols = new Set(group.map(colOf));
  const horizontal = rows.size === 1;
  const sorted = [...group].sort((a, b) => a - b);
  const first = sorted[0], last = sorted[sorted.length - 1];
  if (horizontal) {
    const r = rowOf(first);
    if (colOf(first) > 0) out.push(cellOf(r, colOf(first) - 1));
    if (colOf(last) < W - 1) out.push(cellOf(r, colOf(last) + 1));
  } else if (cols.size === 1) {
    const c = colOf(first);
    if (rowOf(first) > 0) out.push(cellOf(rowOf(first) - 1, c));
    if (rowOf(last) < H - 1) out.push(cellOf(rowOf(last) + 1, c));
  }
  return out.filter(c => isUnknown(grid[c]));
}

// карта вероятностей: сколько размещений оставшихся кораблей накрывает каждую клетку
function densityMap(grid, remainingLengths) {
  const score = new Array(SIZE).fill(0);
  for (const length of new Set(remainingLengths)) {
    const weight = remainingLengths.filter(l => l === length).length;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      for (const horizontal of [true, false]) {
        const cells = shipCells({ row: r, col: c, length, horizontal });
        if (!cells) continue;
        // размещение возможно, только если ни одна клетка не помечена промахом/пусто
        if (cells.some(x => isBlocked(grid[x]))) continue;
        // клетки с попаданиями тоже допустимы (корабль мог быть подбит), но такие ситуации
        // разруливает фаза добивания — здесь просто не даём им лишнего веса
        for (const x of cells) if (isUnknown(grid[x])) score[x] += weight;
      }
    }
  }
  return score;
}

// Следующий выстрел. grid — строка `grids.firing`, remainingLengths — длины ещё не потопленных
// кораблей (если неизвестны, передайте полный список флота: это лишь веса, не корректность).
function nextShot(grid, remainingLengths = [5, 4, 3, 3, 2]) {
  if (typeof grid !== 'string' || grid.length !== SIZE) return null;
  // 1) добиваем начатое
  const openHits = [];
  for (let c = 0; c < SIZE; c++) if (isHit(grid[c])) openHits.push(c);
  const handled = new Set();
  for (const h of openHits) {
    if (handled.has(h)) continue;
    const group = hitGroup(grid, h);
    for (const g of group) handled.add(g);
    const cand = finishCandidates(grid, group);
    if (cand.length) return cand[0];
  }
  // 2) ищем по карте вероятностей
  const score = densityMap(grid, remainingLengths);
  let best = -1, bestScore = -1;
  for (let c = 0; c < SIZE; c++) {
    if (!isUnknown(grid[c])) continue;
    if (score[c] > bestScore) { bestScore = score[c]; best = c; }
  }
  if (best >= 0 && bestScore > 0) return best;
  // 3) на всякий случай — первая неизвестная клетка
  for (let c = 0; c < SIZE; c++) if (isUnknown(grid[c])) return c;
  return null;
}

// поле в текст — для логов
function render(grid) {
  const rows = [];
  for (let r = 0; r < H; r++) rows.push(grid.slice(r * W, r * W + W).split('').join(' '));
  return rows.join('\n');
}

module.exports = { randomFleet, nextShot, shipCells, fits, neighbors, render, cellOf, rowOf, colOf, W, H, SIZE };
