'use strict';
// Солвер «Четыре в ряд» для балагана Карнавальной аллеи (/anniversary-midway/connect-four/...).
//
// Формат доски у игры (сверено живой партией 19.08.2026): строка из 42 символов, индекс = row*7+col,
// НИЖНИЙ ряд — последний (row 5), '.' — пусто, '1' — фишки хозяина (seat 1), '2' — гостя (seat 2).
//
// Перебор с альфа-бетой. Бот игры слабый: партия на глубине 8 велась с растущим перевесом от начала
// до конца, ни одной опасной позиции он не создал. Глубина вынесена в параметр — если игра усилит
// соперника, поднять её дешевле, чем переписывать оценку.

const W = 7, H = 6;
const idx = (r, c) => r * W + c;
// порядок перебора от центра к краям — так альфа-бета отсекает больше веток
const ORDER = [3, 2, 4, 1, 5, 0, 6];

// нижняя свободная строка колонки; -1 — колонка заполнена
function landingRow(board, col) {
  for (let r = H - 1; r >= 0; r--) if (board[idx(r, col)] === '.') return r;
  return -1;
}
function place(board, col, disc) {
  const r = landingRow(board, col);
  if (r < 0) return null;
  return board.slice(0, idx(r, col)) + disc + board.slice(idx(r, col) + 1);
}
function winner(board) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const p = board[idx(r, c)];
    if (p === '.') continue;
    for (const [dr, dc] of dirs) {
      const r3 = r + 3 * dr, c3 = c + 3 * dc;
      if (r3 < 0 || r3 >= H || c3 < 0 || c3 >= W) continue;
      if (board[idx(r + dr, c + dc)] === p && board[idx(r + 2 * dr, c + 2 * dc)] === p && board[idx(r3, c3)] === p) return p;
    }
  }
  return null;
}
const isFull = board => !board.includes('.');

// оценка позиции по «окнам» из четырёх клеток + бонус за центр
function evaluate(board, me, opp) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  let score = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    for (const [dr, dc] of dirs) {
      const r3 = r + 3 * dr, c3 = c + 3 * dc;
      if (r3 < 0 || r3 >= H || c3 < 0 || c3 >= W) continue;
      let mine = 0, theirs = 0;
      for (let k = 0; k < 4; k++) {
        const v = board[idx(r + k * dr, c + k * dc)];
        if (v === me) mine++; else if (v === opp) theirs++;
      }
      if (mine && theirs) continue;                 // смешанное окно уже мертво для обоих
      if (mine === 3) score += 50; else if (mine === 2) score += 8; else if (mine === 1) score += 1;
      if (theirs === 3) score -= 60; else if (theirs === 2) score -= 10; else if (theirs === 1) score -= 1;
    }
  }
  for (let r = 0; r < H; r++) {
    const v = board[idx(r, 3)];
    if (v === me) score += 6; else if (v === opp) score -= 6;
  }
  return score;
}

function search(board, depth, alpha, beta, myTurn, me, opp) {
  const w = winner(board);
  if (w === me) return 10000 + depth;               // выигрыш тем ценнее, чем он ближе
  if (w === opp) return -10000 - depth;
  if (isFull(board) || depth === 0) return evaluate(board, me, opp);
  let best = myTurn ? -Infinity : Infinity;
  for (const c of ORDER) {
    const next = place(board, c, myTurn ? me : opp);
    if (!next) continue;
    const v = search(next, depth - 1, alpha, beta, !myTurn, me, opp);
    if (myTurn) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (alpha >= beta) break;
  }
  return best;
}

// seat — наше место (1 хозяин, 2 гость). Возвращает {col, score} или null, если ходить некуда.
function bestMove(board, seat, depth = 8) {
  const me = String(seat) === '2' ? '2' : '1', opp = me === '1' ? '2' : '1';
  let bestCol = null, bestScore = -Infinity;
  for (const c of ORDER) {
    const next = place(board, c, me);
    if (!next) continue;
    const v = search(next, depth - 1, -Infinity, Infinity, false, me, opp);
    if (v > bestScore) { bestScore = v; bestCol = c; }
  }
  return bestCol === null ? null : { col: bestCol, score: bestScore };
}

// доска в текст — для логов и отладки
function render(board) {
  const rows = [];
  for (let r = 0; r < H; r++) {
    rows.push([...board.slice(r * W, r * W + W)].map(v => (v === '1' ? '●' : v === '2' ? '○' : '·')).join(' '));
  }
  return rows.join('\n');
}

module.exports = { bestMove, winner, landingRow, place, render, W, H };
