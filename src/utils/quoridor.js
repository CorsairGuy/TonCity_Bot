'use strict';
// «Коридор» (quoridor) — четвёртый балаган Карнавальной аллеи.
//
// Правила и все формулы сняты с бандла игры (chunk anniversary_midway, 22.08.2026), а не додуманы:
//   доска 9×9, клетка = row*9+col (0..80), своя цель — ряд 0 для host(seat 1) и ряд 8 для guest(seat 2);
//   стены живут в отдельной сетке 8×8, слот = row*8+col (0..63), строка `walls` из 64 символов,
//   где '.' — пусто, 'h' — горизонтальная, 'v' — вертикальная;
//   стена в слоте (r,c) перекрывает ДВА прохода: горизонтальная — между рядами r и r+1 в столбцах c и c+1,
//   вертикальная — между столбцами c и c+1 в рядах r и r+1.
//
// Ход отправляется как POST .../move {kind:'step'|'wall', cell, slot, horizontal}; поля, которые не
// нужны текущему виду хода, игра всё равно ждёт (в бандле они шлются нулями), поэтому шлём все.
//
// Список своих легальных шагов игра присылает сама (game.legal) — прыжки через фишку соперника и
// диагонали считать самим не нужно. Для оценки ответов соперника хватает расстояний по BFS.

const SIZE = 9;                        // Ce
const CELLS = SIZE * SIZE;             // ya
const WGRID = SIZE - 1;                // Re
const SLOTS = WGRID * WGRID;           // Gt
const HOST = 1, GUEST = 2;

const cellRow = c => Math.floor(c / SIZE);
const cellCol = c => c % SIZE;
const cellAt = (r, c) => r * SIZE + c;
const slotRow = s => Math.floor(s / WGRID);
const slotCol = s => s % WGRID;
const goalRow = seat => (seat === GUEST ? SIZE - 1 : 0);

const wallAt = (walls, r, c) =>
  (r < 0 || r >= WGRID || c < 0 || c >= WGRID) ? '.' : (walls[r * WGRID + c] ?? '.');

// Перекрыт ли проход между двумя СОСЕДНИМИ клетками (r1,c1)-(r2,c2).
function blocked(walls, r1, c1, r2, c2) {
  if (c1 === c2) {                                    // ход по вертикали — мешает горизонтальная стена
    const r = Math.min(r1, r2);
    return wallAt(walls, r, c1) === 'h' || wallAt(walls, r, c1 - 1) === 'h';
  }
  if (r1 === r2) {                                    // ход по горизонтали — мешает вертикальная
    const c = Math.min(c1, c2);
    return wallAt(walls, r1, c) === 'v' || wallAt(walls, r1 - 1, c) === 'v';
  }
  return false;
}

const STEPS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// Расстояние КАЖДОЙ клетки до целевого ряда (волна от всего ряда сразу), -1 — пути нет.
function distField(walls, row) {
  const dist = new Array(CELLS).fill(-1);
  const q = [];
  for (let c = 0; c < SIZE; c++) { const cell = cellAt(row, c); dist[cell] = 0; q.push(cell); }
  for (let i = 0; i < q.length; i++) {
    const cell = q[i], r = cellRow(cell), c = cellCol(cell);
    for (const [dr, dc] of STEPS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (blocked(walls, r, c, nr, nc)) continue;
      const next = cellAt(nr, nc);
      if (dist[next] >= 0) continue;
      dist[next] = dist[cell] + 1;
      q.push(next);
    }
  }
  return dist;
}

const cellOf = (pos, seat) => (seat === GUEST ? pos.guest_cell : pos.host_cell);
const wallsLeft = (pos, seat) => Number(seat === GUEST ? pos.guest_walls : pos.host_walls) || 0;

// Свободен ли слот: сам пуст и рядом нет стены той же ориентации (иначе они наложились бы).
function slotFree(walls, slot, horizontal) {
  if (slot < 0 || slot >= SLOTS || walls[slot] !== '.') return false;
  const r = slotRow(slot), c = slotCol(slot);
  return horizontal
    ? wallAt(walls, r, c - 1) !== 'h' && wallAt(walls, r, c + 1) !== 'h'
    : wallAt(walls, r - 1, c) !== 'v' && wallAt(walls, r + 1, c) !== 'v';
}

const withWall = (walls, slot, horizontal) =>
  `${walls.slice(0, slot)}${horizontal ? 'h' : 'v'}${walls.slice(slot + 1)}`;

// Три опорные точки стены в координатах узлов сетки.
const anchors = (slot, horizontal) => {
  const r = slotRow(slot), c = slotCol(slot);
  return horizontal ? [[r + 1, c], [r + 1, c + 1], [r + 1, c + 2]]
                    : [[r, c + 1], [r + 1, c + 1], [r + 2, c + 1]];
};

// Стена способна замуровать проход, только если обоими концами упирается в борт или в другую стену.
// Дешёвая отсечка перед честной проверкой путей — ровно как в игре.
function touchesTwo(walls, slot, horizontal) {
  const nodes = new Set();
  for (let s = 0; s < SLOTS; s++) {
    if (walls[s] === '.') continue;
    for (const [r, c] of anchors(s, walls[s] === 'h')) nodes.add(`${r},${c}`);
  }
  let hits = 0;
  for (const [r, c] of anchors(slot, horizontal)) {
    if (r === 0 || r === SIZE || c === 0 || c === SIZE || nodes.has(`${r},${c}`)) hits++;
  }
  return hits >= 2;
}

// 'spent' — стены кончились, 'occupied' — слот занят/наложение, 'seals' — кому-то отрезан путь, 'ok'.
function wallStatus(pos, seat, slot, horizontal) {
  if (wallsLeft(pos, seat) <= 0) return 'spent';
  if (!slotFree(pos.walls, slot, horizontal)) return 'occupied';
  if (!touchesTwo(pos.walls, slot, horizontal)) return 'ok';
  const walls = withWall(pos.walls, slot, horizontal);
  const hostOk = distField(walls, goalRow(HOST))[pos.host_cell] >= 0;
  const guestOk = distField(walls, goalRow(GUEST))[pos.guest_cell] >= 0;
  return hostOk && guestOk ? 'ok' : 'seals';
}

function legalWalls(pos, seat) {
  const out = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    for (const horizontal of [true, false]) {
      if (wallStatus(pos, seat, slot, horizontal) === 'ok') out.push({ slot, horizontal });
    }
  }
  return out;
}

// Свои шаги на случай, если игра почему-то не прислала legal: соседние клетки, прыжок через фишку
// соперника, а если за ней стена или борт — обход по диагонали.
function legalSteps(pos, seat) {
  const me = cellOf(pos, seat), foe = cellOf(pos, seat === GUEST ? HOST : GUEST);
  const r = cellRow(me), c = cellCol(me);
  const out = new Set();
  for (const [dr, dc] of STEPS) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
    if (blocked(pos.walls, r, c, nr, nc)) continue;
    const target = cellAt(nr, nc);
    if (target !== foe) { out.add(target); continue; }
    const jr = nr + dr, jc = nc + dc;
    if (jr >= 0 && jr < SIZE && jc >= 0 && jc < SIZE && !blocked(pos.walls, nr, nc, jr, jc)) {
      out.add(cellAt(jr, jc));
      continue;
    }
    for (const [sr, sc] of (dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]])) {
      const ar = nr + sr, ac = nc + sc;
      if (ar < 0 || ar >= SIZE || ac < 0 || ac >= SIZE) continue;
      if (blocked(pos.walls, nr, nc, ar, ac)) continue;
      out.add(cellAt(ar, ac));
    }
  }
  return [...out];
}

const distOf = (walls, seat, cell) => distField(walls, goalRow(seat))[cell];

const other = seat => (seat === GUEST ? HOST : GUEST);
const moved = (pos, seat, cell) => (seat === GUEST ? { ...pos, guest_cell: cell } : { ...pos, host_cell: cell });
const spent = (pos, seat, slot, horizontal) => ({
  ...pos,
  walls: withWall(pos.walls, slot, horizontal),
  host_walls: pos.host_walls - (seat === HOST ? 1 : 0),
  guest_walls: pos.guest_walls - (seat === GUEST ? 1 : 0),
});

// Один кратчайший путь фишки до её ряда: спускаемся по полю расстояний.
function pathCells(walls, from, seat) {
  const field = distField(walls, goalRow(seat));
  if (field[from] < 0) return [];
  const path = [from];
  let cell = from;
  while (field[cell] > 0) {
    const r = cellRow(cell), c = cellCol(cell);
    let next = -1;
    for (const [dr, dc] of STEPS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (blocked(walls, r, c, nr, nc)) continue;
      const cand = cellAt(nr, nc);
      if (field[cand] === field[cell] - 1) { next = cand; break; }
    }
    if (next < 0) break;
    path.push(next);
    cell = next;
  }
  return path;
}

// Стены-кандидаты: только те, что реально режут кратчайший путь соперника. Перебирать все 128
// легальных стен на каждом узле поиска бессмысленно — почти все они не меняют ни одного расстояния.
function wallCandidates(pos, seat) {
  if (wallsLeft(pos, seat) <= 0) return [];
  const foe = other(seat);
  const path = pathCells(pos.walls, cellOf(pos, foe), foe);
  const seen = new Set();
  const out = [];
  const add = (slot, horizontal) => {
    const key = `${slot}${horizontal ? 'h' : 'v'}`;
    if (slot < 0 || slot >= SLOTS || seen.has(key)) return;
    seen.add(key);
    if (wallStatus(pos, seat, slot, horizontal) === 'ok') out.push({ slot, horizontal });
  };
  for (let i = 0; i + 1 < path.length; i++) {
    const r1 = cellRow(path[i]), c1 = cellCol(path[i]);
    const r2 = cellRow(path[i + 1]), c2 = cellCol(path[i + 1]);
    if (c1 === c2) {                                  // шаг по вертикали режет горизонтальная стена
      const r = Math.min(r1, r2);
      add(r * WGRID + c1, true);
      if (c1 > 0) add(r * WGRID + (c1 - 1), true);
    } else {                                          // шаг по горизонтали — вертикальная
      const c = Math.min(c1, c2);
      add(r1 * WGRID + c, false);
      if (r1 > 0) add((r1 - 1) * WGRID + c, false);
    }
  }
  return out;
}

const WIN = 100000;

// Оценка позиции глазами `seat`: разница «сколько шагов осталось сопернику минус сколько мне».
// Стены — мелкая добавка: запас стен полезен, но темп важнее.
function evaluate(pos, seat) {
  const foe = other(seat);
  const dm = distOf(pos.walls, seat, cellOf(pos, seat));
  const df = distOf(pos.walls, foe, cellOf(pos, foe));
  if (dm < 0) return -WIN;
  if (df < 0) return WIN;
  return (df - dm) * 10 + (wallsLeft(pos, seat) - wallsLeft(pos, foe));
}

// Ходы узла: шаги (по возрастанию расстояния до цели) + стены, режущие путь соперника.
function moveList(pos, seat) {
  const field = distField(pos.walls, goalRow(seat));
  const steps = legalSteps(pos, seat)
    .filter(cell => field[cell] >= 0)
    .sort((a, b) => field[a] - field[b])
    .map(cell => ({ kind: 'step', cell }));
  return [...steps, ...wallCandidates(pos, seat).map(w => ({ kind: 'wall', ...w }))];
}

function negamax(pos, seat, depth, alpha, beta) {
  const moves = moveList(pos, seat);
  if (!moves.length) return -WIN;
  if (depth === 0) return evaluate(pos, seat);
  let best = -WIN * 2;
  for (const mv of moves) {
    let score;
    if (mv.kind === 'step') {
      if (cellRow(mv.cell) === goalRow(seat)) score = WIN + depth;   // дошли — партия наша
      else score = -negamax(moved(pos, seat, mv.cell), other(seat), depth - 1, -beta, -alpha);
    } else {
      score = -negamax(spent(pos, seat, mv.slot, mv.horizontal), other(seat), depth - 1, -beta, -alpha);
    }
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Выбор хода: перебор на несколько полуходов вперёд. Жадная гонка «беги по кратчайшему пути»
// проигрывает боту игры вчистую (живая партия 22.08.2026: он заваливал стенами и уводил мою фишку
// с 8 шагов до цели на 22), поэтому считаем ответы соперника, а не только своё расстояние.
function bestMove(game, opts = {}) {
  const pos = {
    walls: String(game.walls || '.'.repeat(SLOTS)),
    host_cell: Number(game.host_cell), guest_cell: Number(game.guest_cell),
    host_walls: Number(game.host_walls) || 0, guest_walls: Number(game.guest_walls) || 0,
  };
  const seat = Number(game.seat) === GUEST ? GUEST : HOST;
  const depth = Number.isFinite(opts.depth) ? opts.depth : 3;

  // Свои шаги игра присылает сама — они авторитетнее наших расчётов (прыжки, диагонали).
  const given = Array.isArray(game.legal) ? game.legal.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < CELLS) : [];
  const field = distField(pos.walls, goalRow(seat));
  const steps = (given.length ? given : legalSteps(pos, seat)).filter(cell => field[cell] >= 0);
  if (!steps.length) return null;

  for (const cell of steps) if (cellRow(cell) === goalRow(seat)) return { kind: 'step', cell };

  const moves = [
    ...steps.sort((a, b) => field[a] - field[b]).map(cell => ({ kind: 'step', cell })),
    ...wallCandidates(pos, seat).map(w => ({ kind: 'wall', ...w })),
  ];
  let best = moves[0], bestScore = -WIN * 2;
  for (const mv of moves) {
    const next = mv.kind === 'step' ? moved(pos, seat, mv.cell) : spent(pos, seat, mv.slot, mv.horizontal);
    const score = -negamax(next, other(seat), depth - 1, -WIN * 2, WIN * 2);
    if (score > bestScore) { bestScore = score; best = mv; }
  }
  return best.kind === 'wall'
    ? { kind: 'wall', slot: best.slot, horizontal: best.horizontal }
    : { kind: 'step', cell: best.cell };
}

module.exports = {
  SIZE, CELLS, WGRID, SLOTS, HOST, GUEST,
  cellAt, cellRow, cellCol, goalRow, blocked, distField, legalSteps, legalWalls, wallStatus,
  withWall, pathCells, wallCandidates, evaluate, bestMove,
};
