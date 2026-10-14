import { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Button, Dialog, Text, Spinner, Flash } from '@primer/react';
import { api, type Game2048Direction, type Game2048Status } from '../api';

// Механика 2048 подтверждена реверсом бандла игры (chunks/game2048-*.js):
//   GET  /game2048/          -> {board:number[4][4], score, max_tile, game_status}
//   POST /game2048/ {direction:'up'|'down'|'left'|'right'} -> тот же формат + reward при завершении
// Анимация плиток — ДОСЛОВНЫЙ порт функций xe()/ye() (оптимистичное локальное предсказание хода) и
// Se() (сверка предсказания с реальным ответом сервера) из бандла. Ключевой момент, который я упустил
// в первой версии: при слиянии двух тайлов ПРОИГРАВШИЙ не выбрасывается сразу — он тоже едет на
// клетку выжившего (mergedInto=id выжившего) и висит там ОДИН кадр анимации, накладываясь на
// выжившего, и только при следующей сверке (Se) реально убирается из списка. Если выбросить его
// сразу (как было раньше) — он просто исчезает на месте посреди хода, а не "долетает" до соседа,
// из-за чего казалось, что тайлы перелетают друг через друга.
const TILE_COLORS: Record<number, { bg: string; text: string }> = {
  2: { bg: '#eee4da', text: '#776e65' }, 4: { bg: '#ede0c8', text: '#776e65' },
  8: { bg: '#f2b179', text: '#f9f6f2' }, 16: { bg: '#f59563', text: '#f9f6f2' },
  32: { bg: '#f67c5f', text: '#f9f6f2' }, 64: { bg: '#f65e3b', text: '#f9f6f2' },
  128: { bg: '#edcf72', text: '#f9f6f2' }, 256: { bg: '#edcc61', text: '#f9f6f2' },
  512: { bg: '#edc850', text: '#f9f6f2' }, 1024: { bg: '#edc53f', text: '#f9f6f2' },
  2048: { bg: '#edc22e', text: '#f9f6f2' },
};
function tileColor(v: number) { return TILE_COLORS[v] ?? { bg: '#3c3a32', text: '#f9f6f2' }; }

interface TileState {
  id: number; value: number; row: number; col: number;
  isNew?: boolean;
  mergedInto?: number | -1; // -1 — временная пометка "этот тайл только что ПРИНЯЛ слияние" (для pop), как в бандле
  justMerged?: boolean; // не из бандла — чисто для CSS pop-класса на React-стороне (см. коммент ниже)
}

function boardToTiles(board: number[][], nextId: { current: number }): TileState[] {
  const tiles: TileState[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (board[r][c] > 0) tiles.push({ id: nextId.current++, value: board[r][c], row: r, col: c });
  }
  return tiles;
}
function tilesToBoard(tiles: TileState[]): number[][] {
  const b = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (const t of tiles) if (!t.mergedInto) b[t.row][t.col] = t.value;
  return b;
}

// числовая механика (для canMove) — 1:1 порт extractLine/mergeLine/canMove из modules/game2048.js
function extractLine(board: number[][], dir: Game2048Direction, i: number): number[] {
  if (dir === 'left') return [...board[i]];
  if (dir === 'right') return [...board[i]].reverse();
  if (dir === 'up') return [board[0][i], board[1][i], board[2][i], board[3][i]];
  return [board[3][i], board[2][i], board[1][i], board[0][i]];
}
function mergeLine(line: number[]): number[] {
  const t = line.filter(v => v !== 0);
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i + 1] !== undefined && t[i] === t[i + 1]) { out.push(t[i] * 2); i++; }
    else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return out;
}
function canMove(board: number[][], dir: Game2048Direction): boolean {
  for (let i = 0; i < 4; i++) {
    const line = extractLine(board, dir, i);
    const merged = mergeLine(line);
    for (let k = 0; k < 4; k++) if (line[k] !== merged[k]) return true;
  }
  return false;
}

// дословный порт xe()/ye() из бандла — тайловая симуляция хода с сохранением id (для CSS-анимации)
function slideTiles(tiles: TileState[], dir: Game2048Direction): TileState[] {
  const e: TileState[] = tiles.filter(a => !a.mergedInto).map(a => ({ ...a, isNew: false, justMerged: false }));
  const s = dir === 'left' || dir === 'right'; // движение по строке (горизонтально)
  const l = dir === 'right' || dir === 'down'; // движение к бОльшим индексам
  for (let a = 0; a < 4; a++) {
    const n = e.filter(d => s ? d.row === a : d.col === a);
    n.sort((d, S) => {
      const k = s ? d.col : d.row, V = s ? S.col : S.row;
      return l ? V - k : k - V;
    });
    let c = l ? 3 : 0;
    let p: TileState | null = null;
    for (const d of n) {
      if (p && p.value === d.value && !p.mergedInto) {
        d.mergedInto = p.id;
        if (s) d.col = p.col; else d.row = p.row; // едет НА клетку выжившего — вместе доезжают, не пропадает на месте
        p.value *= 2; p.mergedInto = -1; p.justMerged = true;
      } else {
        if (s) d.col = c; else d.row = c;
        p = d;
        c += l ? -1 : 1;
      }
    }
  }
  for (const a of e) if (a.mergedInto === -1) a.mergedInto = undefined;
  return e;
}

// дословный порт Se() из бандла — сверка предсказания с реальной доской сервера: слившиеся
// "призраки" отбрасываются, ровно одна новая клетка (там, где сервер добавил случайную плитку)
// достраивается; если расхождение необъяснимо новой плиткой — пересобираем с нуля без анимации
function reconcileTiles(predicted: TileState[], serverBoard: number[][], nextId: { current: number }): TileState[] {
  const live = predicted.filter(t => !t.mergedInto).map(t => ({ ...t, isNew: false, justMerged: false }));
  const predBoard = tilesToBoard(live);
  let mismatch = false;
  const result = [...live];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (predBoard[r][c] !== serverBoard[r][c]) {
      if (predBoard[r][c] === 0 && serverBoard[r][c] > 0) result.push({ id: nextId.current++, value: serverBoard[r][c], row: r, col: c, isNew: true, justMerged: false });
      else mismatch = true;
    }
  }
  return mismatch ? boardToTiles(serverBoard, nextId) : result;
}

const SLIDE_MS = 150; // должно совпадать с CSS-переходом .g2048-tile (см. global.css) — тайминг из бандла

interface BoardMsg { type: 'snapshot' | 'move' | 'done'; board?: number[][]; score?: number; max_tile?: number; game_status?: Game2048Status; direction?: Game2048Direction; reward?: number; error?: string }

interface Props {
  accountId: number;
  accountName: string;
  // solving — единственный источник правды "автоиграет ли сейчас этот аккаунт", общий с таблицей
  // (см. Game2048.tsx: solvingIds) — старт/стоп из модалки идут через те же startTableSolve/
  // stopTableSolve, что и кнопки в таблице, поэтому оба места ВСЕГДА показывают один и тот же
  // статус, а не рассинхронизированные локальные состояния.
  solving: boolean;
  onStartSolve: () => void;
  onStopSolve: () => void;
  // подписка на ЕДИНСТВЕННОЕ SSE-соединение автоигры этого аккаунта, которое держит таблица (см.
  // Game2048.tsx subscribeBoard) — модалка больше не открывает своё, ВТОРОЕ соединение к тому же
  // потоку: раньше два параллельных EventSource на один accountId (одно у таблицы для статуса
  // "Играет…", другое у модалки для доски) при нескольких одновременно играющих аккаунтах легко
  // упирались в лимит браузера на число соединений к одному origin (6 для HTTP/1.1) — новое
  // соединение модалки просто зависало в очереди, и доска выглядела "застывшей".
  onSubscribeBoard: (cb: (m: BoardMsg) => void) => () => void;
  onClose: () => void;
  onResult: (r: { won: boolean; reward?: number; score?: number }) => void;
}

export function Game2048Modal({ accountId, accountName, solving, onStartSolve, onStopSolve, onSubscribeBoard, onClose, onResult }: Props) {
  const [tiles, setTiles] = useState<TileState[]>([]);
  const [score, setScore] = useState(0);
  const [maxTile, setMaxTile] = useState(0);
  const [status, setStatus] = useState<Game2048Status>('ongoing');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nextIdRef = useRef(1);
  const tilesRef = useRef<TileState[]>([]);
  tilesRef.current = tiles;
  const statusRef = useRef<Game2048Status>('ongoing');
  statusRef.current = status;
  const solvingRef = useRef(solving);
  solvingRef.current = solving;
  const busyRef = useRef(false); // блокирует ход, ПОКА летит запрос — снимается сразу по ответу сервера (без искусственной задержки)
  // onResult приходит от родителя как инлайн-функция — новая ссылка на КАЖДЫЙ его рендер, поэтому
  // не держим её напрямую в зависимостях эффектов/колбэков (перезапускались бы на каждый чужой
  // рендер) — читаем через ref, всегда актуальный на момент вызова.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onSubscribeBoardRef = useRef(onSubscribeBoard);
  onSubscribeBoardRef.current = onSubscribeBoard;

  // подписаться/отписаться на общий поток вслед за solving (статус из таблицы) — рисует доску,
  // пока идёт автоигра; когда она останавливается (из ЛЮБОГО места — из этой же модалки, из
  // таблицы или сама доигралась), подгружает актуальное состояние для возобновления ручной игры.
  // 'done' здесь НЕ дёргает onResult — завершение партии уже обрабатывает собственная (постоянная)
  // подписка таблицы (см. startTableSolve в Game2048.tsx); если бы модалка тоже вызывала onResult,
  // флэш-уведомление и результат прилетали бы ДВАЖДЫ, пока модалка открыта.
  useEffect(() => {
    let cancelled = false;
    if (solving) {
      setLoading(false);
      const unsubscribe = onSubscribeBoardRef.current(data => {
        if (data.type === 'snapshot' && data.board) {
          setTiles(boardToTiles(data.board, nextIdRef));
          setScore(data.score ?? 0); setMaxTile(data.max_tile ?? 0); setStatus(data.game_status ?? 'ongoing');
        } else if (data.type === 'move' && data.board && data.direction) {
          const predicted = slideTiles(tilesRef.current, data.direction);
          setTiles(predicted);
          setTimeout(() => {
            setTiles(reconcileTiles(predicted, data.board!, nextIdRef));
            setScore(data.score ?? 0); setMaxTile(data.max_tile ?? 0); setStatus(data.game_status ?? 'ongoing');
          }, SLIDE_MS);
        } else if (data.type === 'done' && data.error) setError(data.error);
      });
      return () => { cancelled = true; unsubscribe(); };
    }
    api.game2048State(accountId).then(d => {
      if (cancelled) return;
      if (d.ok) { setTiles(boardToTiles(d.board, nextIdRef)); setScore(d.score); setMaxTile(d.max_tile); setStatus(d.game_status); }
      else setError(d.error ?? 'Ошибка загрузки');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, solving]);

  const move = useCallback(async (dir: Game2048Direction) => {
    if (busyRef.current || solvingRef.current || statusRef.current !== 'ongoing' || !tilesRef.current.length) return;
    if (!canMove(tilesToBoard(tilesRef.current), dir)) return; // как в игре — нет хода в эту сторону, запрос не шлём
    busyRef.current = true;
    const predicted = slideTiles(tilesRef.current, dir);
    setTiles(predicted); // мгновенно показываем скольжение — ещё до ответа сервера
    try {
      const r = await api.game2048Move(accountId, dir);
      busyRef.current = false; // разблокировать СРАЗУ по ответу сервера — не ждать доп. время анимации,
      // иначе быстрый ввод ощущается как будто запросы идут через рейтлимитер
      if (r.ok) {
        setTimeout(() => {
          setTiles(reconcileTiles(predicted, r.board, nextIdRef));
          setScore(r.score); setMaxTile(r.max_tile); setStatus(r.game_status);
          if (r.game_status !== 'ongoing') onResultRef.current({ won: r.game_status === 'won', reward: r.reward, score: r.score });
        }, SLIDE_MS);
      } else setError(r.error ?? 'Ошибка хода');
    } catch (e) { busyRef.current = false; setError(String(e)); }
  }, [accountId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, Game2048Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      const dir = map[e.key];
      if (dir) { e.preventDefault(); move(dir); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  // свайп (тач) и перетаскивание мышью — тот же порог 30px и логика выбора направления, что в игре
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (x: number, y: number) => { startRef.current = { x, y }; };
  const onPointerUp = (x: number, y: number) => {
    const start = startRef.current; startRef.current = null;
    if (!start) return;
    const dx = x - start.x, dy = y - start.y, T = 30;
    if (Math.abs(dx) < T && Math.abs(dy) < T) return;
    const dir: Game2048Direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    move(dir);
  };

  // старт/стоп идут через общее состояние таблицы (см. Props.solving) — сама подписка на поток
  // подключится/отключится реактивно, эффектом выше, как только solving поменяется
  const runSolve = () => {
    if (solvingRef.current || statusRef.current !== 'ongoing') return;
    onStartSolve();
  };
  const stopSolve = () => { onStopSolve(); };

  // поле — фиксированный размер (как было до "растягивания на всю модалку" — там же выяснилась
  // причина пропавшей рамки сверху/слева: aspect-ratio+% в этом контексте считался нестабильно).
  // Вместо растягивания поля под модалку — наоборот, модалка сжата точно под поле + 8px с каждой
  // стороны (BOARD + 2*PAD_MODAL), это и даёт ровно 8px отступа без изменения самого поля.
  const BOARD = 320, PAD = 8, GAP = 8, PAD_MODAL = 8;
  const CELL = (BOARD - PAD * 2 - GAP * 3) / 4;
  const posOf = (i: number) => PAD + i * (CELL + GAP);

  return (
    <Dialog isOpen onDismiss={onClose} sx={{ width: BOARD + PAD_MODAL * 2, maxWidth: '95vw' }}>
      <Dialog.Header>2048 — {accountName}</Dialog.Header>
      <Box sx={{ p: `${PAD_MODAL}px`, display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
        {error && <Flash variant="danger" sx={{ width: '100%' }}>{error}</Flash>}
        {loading ? <Spinner /> : (
          <>
            <Box sx={{ display: 'flex', gap: 4, fontSize: 1 }}>
              <Text>Счёт: <b>{score}</b></Text>
              <Text>Макс: <b>{maxTile}</b></Text>
            </Box>
            <div
              onMouseDown={e => onPointerDown(e.clientX, e.clientY)}
              onMouseUp={e => onPointerUp(e.clientX, e.clientY)}
              onTouchStart={e => { const t = e.touches[0]; onPointerDown(t.clientX, t.clientY); }}
              onTouchEnd={e => { const t = e.changedTouches[0]; onPointerUp(t.clientX, t.clientY); }}
              style={{
                position: 'relative', width: BOARD, height: BOARD, flexShrink: 0,
                background: '#bbada0', borderRadius: 8, padding: PAD, boxSizing: 'border-box',
                userSelect: 'none', touchAction: 'none', cursor: status === 'ongoing' ? 'grab' : 'default',
              }}
            >
              {/* статичная фоновая сетка 4×4 — фиксированный размер, никогда не пересчитывается по контенту */}
              {Array.from({ length: 16 }).map((_, k) => (
                <div key={k} style={{
                  position: 'absolute', width: CELL, height: CELL,
                  left: posOf(k % 4), top: posOf(Math.floor(k / 4)),
                  background: 'rgba(238,228,218,.35)', borderRadius: 4,
                }} />
              ))}
              {/* слившиеся тайлы (mergedInto) рисуются НИЖЕ (без z-index — раньше в DOM) выживших, чтобы
                  выживший визуально "накрывал" их в момент наложения на одной клетке */}
              {[...tiles].sort((a, b) => (a.mergedInto ? 0 : 1) - (b.mergedInto ? 0 : 1)).map(t => {
                const { bg, text } = tileColor(t.value);
                return (
                  <div
                    key={t.id}
                    className={'g2048-tile' + (t.isNew ? ' g2048-tile-new' : '') + (t.justMerged ? ' g2048-tile-pop' : '')}
                    style={{
                      position: 'absolute', width: CELL, height: CELL,
                      left: posOf(t.col), top: posOf(t.row),
                      background: bg, color: text, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 4, fontWeight: 'bold', fontSize: t.value >= 1000 ? 22 : t.value >= 100 ? 26 : 32,
                    }}
                  >
                    {t.value}
                  </div>
                );
              })}
            </div>
            {status !== 'ongoing' && (
              <Text sx={{ fontWeight: 'bold', color: status === 'won' ? 'success.fg' : 'danger.fg' }}>
                {status === 'won' ? 'Победа!' : 'Игра окончена'}
              </Text>
            )}
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Стрелки на клавиатуре или свайп</Text>
            {solving
              ? <Button variant="danger" block onClick={stopSolve}>Стоп</Button>
              : <Button variant="primary" block disabled={status !== 'ongoing'} onClick={runSolve}>Решить</Button>}
          </>
        )}
      </Box>
    </Dialog>
  );
}
