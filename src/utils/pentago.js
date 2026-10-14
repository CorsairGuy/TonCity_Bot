'use strict';
// Солвер «Пентаго» — балаган 3-го дня Карнавальной аллеи (/anniversary-midway/pentago/...).
//
// Правила сняты ИЗ БАНДЛА игры дословно (chunks/anniversary_midway-*), а не по википедии:
//   поле 6×6 (индекс клетки = row*6 + col), четыре квадранта 3×3, победа — 5 в ряд;
//   ход = поставить свой шарик в пустую клетку И повернуть один квадрант на 90°;
//   запрос: POST .../move {cell, quadrant, clockwise}; поворот ОБЯЗАТЕЛЕН — на quadrant=-1
//   (константа Ut из бандла) сервер отвечает 400 «Выберите один из четырёх блоков для поворота»;
//   шарик игрока: место 2 → '2', иначе '1'; пустая клетка — '.'.
//
// Порядок применения сверен живыми ходами 21.08.2026: сервер СНАЧАЛА ставит шарик, ПОТОМ поворачивает
// квадрант (поставили в клетку 1 и повернули квадрант 0 по часовой — шарики уехали в 8 и 2, ровно как
// предсказывает эта модель). Первая сверка сбила с толку: ответный ход бота крутил тот же квадрант
// обратно, и казалось, что поворот вообще не применяется.
//
// Формула квадранта и поворота — тоже из бандла:
//   quadrantOf(cell) = floor(row/3)*2 + floor(col/3)
//   при повороте T[r][g] = a[cw ? 2-g : g][cw ? r : 2-r] внутри квадранта.

const SIZE = 6, BLOCK = 3, CELLS = SIZE * SIZE, QUADRANTS = 4, RUN = 5;
const NO_TWIST = -1;        // есть в бандле (Ut), но сервер такой ход не принимает — см. moves()

const cellOf = (row, col) => row * SIZE + col;
const rowOf = i => Math.floor(i / SIZE);
const colOf = i => i % SIZE;
const emptyBoard = () => '.'.repeat(CELLS);
const marbleOf = seat => (Number(seat) === 2 ? '2' : '1');
const quadrantOf = cell => Math.floor(rowOf(cell) / BLOCK) * 2 + Math.floor(colOf(cell) / BLOCK);

// все линии из пяти клеток (по горизонтали, вертикали и обеим диагоналям) — как строит игра
const LINES = (() => {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + dr * (RUN - 1), ec = c + dc * (RUN - 1);
      if (er < 0 || er >= SIZE || ec < 0 || ec >= SIZE) continue;
      const line = [];
      for (let k = 0; k < RUN; k++) line.push(cellOf(r + dr * k, c + dc * k));
      out.push(line);
    }
  }
  return out;
})();

function place(board, cell, marble) {
  if (cell < 0 || cell >= CELLS || board.length !== CELLS) return board;
  return board.slice(0, cell) + marble + board.slice(cell + 1);
}

function rotate(board, quadrant, clockwise) {
  if (board.length !== CELLS || quadrant < 0 || quadrant >= QUADRANTS) return board;
  const baseRow = Math.floor(quadrant / 2) * BLOCK, baseCol = (quadrant % 2) * BLOCK;
  const out = board.split('');
  for (let r = 0; r < BLOCK; r++) for (let c = 0; c < BLOCK; c++) {
    const sr = clockwise ? BLOCK - 1 - c : c;
    const sc = clockwise ? r : BLOCK - 1 - r;
    out[cellOf(baseRow + r, baseCol + c)] = board[cellOf(baseRow + sr, baseCol + sc)];
  }
  return out.join('');
}

const applyMove = (board, cell, marble, quadrant, clockwise) =>
  (quadrant === NO_TWIST ? place(board, cell, marble) : rotate(place(board, cell, marble), quadrant, clockwise));

// Кто собрал пять в ряд. Поворот может достроить линию ОБОИМ — возвращаем 'both', такие ходы
// солвер считает не выигрышем, а ничьей и не выбирает их, когда есть чистая победа.
function winnerOf(board) {
  let me = false, other = false;
  for (const line of LINES) {
    const first = board[line[0]];
    if (first === '.') continue;
    let all = true;
    for (let k = 1; k < RUN; k++) if (board[line[k]] !== first) { all = false; break; }
    if (!all) continue;
    if (first === '1') me = true; else other = true;
  }
  if (me && other) return 'both';
  if (me) return '1';
  if (other) return '2';
  return null;
}

// Оценка позиции: считаем «окна» из пяти клеток. Окно, где есть шарики обоих, мертво для обоих.
const WEIGHT = [0, 1, 8, 60, 500, 100000];
function evaluate(board, me, opp) {
  let score = 0;
  for (const line of LINES) {
    let mine = 0, theirs = 0;
    for (const c of line) {
      const v = board[c];
      if (v === me) mine++; else if (v === opp) theirs++;
    }
    if (mine && theirs) continue;
    if (mine) score += WEIGHT[mine];
    else if (theirs) score -= WEIGHT[theirs] * 1.1;   // защищаться чуть важнее, чем строить
  }
  // центры квадрантов не двигаются при повороте — они ценнее прочих клеток
  for (const c of [7, 10, 25, 28]) {
    if (board[c] === me) score += 6; else if (board[c] === opp) score -= 6;
  }
  return score;
}

// Все ходы: пустая клетка × поворот одного из четырёх квадрантов в любую сторону.
// Поворот ОБЯЗАТЕЛЕН: на quadrant=-1 сервер отвечает 400 «Выберите один из четырёх блоков для
// поворота» (проверено живым запросом 21.08.2026), поэтому константа NO_TWIST из бандла в игре
// недоступна и в переборе не участвует.
function* moves(board) {
  for (let cell = 0; cell < CELLS; cell++) {
    if (board[cell] !== '.') continue;
    for (let q = 0; q < QUADRANTS; q++) {
      yield { cell, quadrant: q, clockwise: true };
      yield { cell, quadrant: q, clockwise: false };
    }
  }
}

// Сколько ветвей смотрим вглубь. Полный перебор трёх полуходов нереален: на пустой доске это
// 324 × 324 × 324 позиций. Поэтому селективно: своих ходов берём TOP_OURS лучших по быстрой оценке,
// ответов соперника — TOP_THEIRS. Против бота игры этого достаточно, а времени уходит ~1-2 с при
// лимите хода в 120 с.
const TOP_OURS = 16, TOP_THEIRS = 8;

// Оценка одного нашего хода без заглядывания вперёд — для отбора кандидатов.
function shallowScore(board, mv, me, opp, winTag, loseTag) {
  const after = applyMove(board, mv.cell, me, mv.quadrant, mv.clockwise);
  const w = winnerOf(after);
  if (w === winTag) return { after, score: Infinity };
  if (w === loseTag) return { after, score: -Infinity };      // свой поворот достроил линию сопернику
  if (w === 'both') return { after, score: 0 };
  return { after, score: evaluate(after, me, opp) };
}

// Лучший ход за seat: три полухода (наш → ответ соперника → наш) селективным перебором.
// Глубины 2 не хватало: пентаго выигрывается «вилками», которые видно только на третьем полуходе —
// на живых партиях 21.08.2026 бот игры обыгрывал двухходовую версию.
function bestMove(board, seat) {
  if (typeof board !== 'string' || board.length !== CELLS) return null;
  const me = marbleOf(seat), opp = me === '1' ? '2' : '1';
  const winTag = me, loseTag = opp;

  // 1) отбираем кандидатов
  const cands = [];
  for (const mv of moves(board)) {
    const { after, score } = shallowScore(board, mv, me, opp, winTag, loseTag);
    if (score === Infinity) return { ...mv, score };           // выигрываем прямо сейчас
    if (score === -Infinity) continue;
    cands.push({ mv, after, score });
  }
  if (!cands.length) {
    for (const mv of moves(board)) return { ...mv, score: -Infinity };
    return null;
  }
  cands.sort((a, b) => b.score - a.score);

  let best = null, bestScore = -Infinity;
  for (const cand of cands.slice(0, TOP_OURS)) {
    // 2) ответы соперника: сразу отбрасываем ход, если соперник побеждает; иначе берём его лучшие
    const replies = [];
    let refuted = false;
    for (const reply of moves(cand.after)) {
      const next = applyMove(cand.after, reply.cell, opp, reply.quadrant, reply.clockwise);
      const rw = winnerOf(next);
      if (rw === loseTag) { refuted = true; break; }           // соперник выигрывает ответом
      if (rw === winTag) continue;                             // его ход достраивает линию нам — ему невыгодно
      replies.push({ next, score: evaluate(next, opp, me) });   // оценка ЕГО глазами
    }
    if (refuted) continue;
    if (!replies.length) { // ему нечем ходить или всё ведёт к нашей победе
      if (cand.score > bestScore) { bestScore = cand.score; best = { ...cand.mv, score: cand.score }; }
      continue;
    }
    replies.sort((a, b) => b.score - a.score);

    // 3) на каждый его ответ считаем НАШ лучший ход; берём худший для нас вариант
    let worst = Infinity;
    for (const reply of replies.slice(0, TOP_THEIRS)) {
      let ourBest = -Infinity;
      for (const mv2 of moves(reply.next)) {
        const after2 = applyMove(reply.next, mv2.cell, me, mv2.quadrant, mv2.clockwise);
        const w2 = winnerOf(after2);
        const s2 = w2 === winTag ? 1e6 : w2 === loseTag ? -1e6 : w2 === 'both' ? 0 : evaluate(after2, me, opp);
        if (s2 > ourBest) ourBest = s2;
        if (ourBest >= 1e6) break;
      }
      if (ourBest < worst) worst = ourBest;
      if (worst <= -1e6) break;
    }
    if (worst > bestScore) { bestScore = worst; best = { ...cand.mv, score: worst }; }
  }
  // всё опровергается — играем лучший по мелкой оценке, вдруг соперник ошибётся
  if (!best) { const c = cands[0]; best = { ...c.mv, score: c.score }; }
  return best;
}

function render(board) {
  const rows = [];
  for (let r = 0; r < SIZE; r++) rows.push(board.slice(r * SIZE, r * SIZE + SIZE).split('').join(' '));
  return rows.join('\n');
}

module.exports = {
  bestMove, applyMove, place, rotate, winnerOf, evaluate, marbleOf, quadrantOf, render,
  emptyBoard, LINES, SIZE, BLOCK, CELLS, QUADRANTS, RUN, NO_TWIST,
};
