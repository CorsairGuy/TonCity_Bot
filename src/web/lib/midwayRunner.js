'use strict';
// Карнавальная аллея: играем партии ПРОТИВ БОТА, пока не выберем дневной кошелёк билетов.
// Против живых игроков не играем принципиально — это чужое время, а награда та же.
//
// Балаганы по дням (identifier приходит в /anniversary-midway/, заранее игра его не раскрывает):
//   день 1 — connect_four «Четыре в ряд»  (солвер utils/connectFour.js)
//   день 2 — battleship   «Морской бой»   (солвер utils/battleship.js)
//   день 3 — pentago      «Пентаго»       (солвер utils/pentago.js)
//   день 4 — quoridor     «Коридор»       (солвер utils/quoridor.js)
//   день 5 — dots_and_boxes «Точки и коробки» (солвер utils/dotsAndBoxes.js)
// ВАЖНО: вчерашний балаган остаётся is_open=true (сверено живьём 20.08.2026), поэтому «сегодняшним»
// считаем не первый открытый, а тот, где ещё остались неоплаченные победы.
//
// Эндпоинты «Четыре в ряд» (бандл + живая партия 19.08.2026):
//   POST /anniversary-midway/connect-four/games            {vs_bot} → {game,connect_four,tickets_balance}
//   GET  /anniversary-midway/connect-four/games/{code}
//   POST /anniversary-midway/connect-four/games/{code}/move {column}
//
// Эндпоинты «Морской бой» (бандл + живая партия 20.08.2026):
//   POST /anniversary-midway/battleship/games              {vs_bot,fleet_kind}
//   POST /anniversary-midway/battleship/games/{code}/fleet  {ships:[{row,col,length,horizontal}]}
//   POST /anniversary-midway/battleship/games/{code}/fire   {cell:<row*10+col>}
//   состояние: grids.firing/incoming/fleet ('.' неизвестно, 'x' попал, 'o' мимо, '~' игра сама
//   пометила пусто вокруг потопленного), your_fleet_ready/other_fleet_ready, grids.fleet_afloat.
//
// Грабли, найденные живыми партиями (каждая ломала игру молча):
//   1. игра адресуется полем `code`, а не `id` — по id прилетает 404 «Эта игра больше не существует»;
//   2. ход/выстрел нередко отвечает таймаутом, НО ПРИ ЭТОМ ПРОХОДИТ — слепой повтор сделает второй
//      ход, поэтому после ошибки состояние перечитывается и решение принимается по доске;
//   3. `turn_deadline` приходит null, хотя лимит ходу заявлен — на него полагаться нельзя;
//   4. незавершённая партия морского боя в active_game НЕ приходит (там только «четыре в ряд») —
//      её код помним у себя и доигрываем после сбоя вместо новой партии.
//
// Прогресс живёт в процессе бота (реестр ниже), а не во вкладке: партия идёт минуту-полторы, а
// «сыграть всем» — десятки минут. Страница только спрашивает статус, поэтому спиннеры кнопок
// переживают перезагрузку страницы.
const logger = require('../../utils/logger');
const { sleep } = require('../../utils/helpers');
const { bestMove } = require('../../utils/connectFour');
const battleship = require('../../utils/battleship');
const pentago = require('../../utils/pentago');
const quoridor = require('../../utils/quoridor');
const dotsAndBoxes = require('../../utils/dotsAndBoxes');

const CONCURRENCY = 4;                 // партия — это десятки запросов подряд; игру мы уже роняли параллелизмом
const SEARCH_DEPTH = 8;                // «четыре в ряд»: хватает с запасом, бот игры слабый
const MOVE_GAP_MS = 700;               // пауза между своими ходами
const POLL_GAP_MS = 1500;              // ожидание хода соперника
const MAX_MOVES = 60;                  // 42 клетки + запас на перечитывания
const MAX_SHOTS = 140;                 // 100 клеток поля + запас на перечитывания
const MAX_PLIES = 60;                  // 36 клеток пентаго + запас на перечитывания
const MAX_TURNS = 220;                 // «коридор»: игра сама режет партию на 500 ходов обоих
const MAX_LINES = 90;                  // «точки и коробки»: 60 линий + запас на перечитывания
// Балаганы, которые бот умеет. Флот armada [5,4,3,3,2] против flotilla: у армады меньше клеток
// искать (17 против 21), и солвер закрывает её в среднем за 39 выстрелов против 57 — играем её.
const SOLVERS = { connect_four: 'Четыре в ряд', battleship: 'Морской бой', pentago: 'Пентаго', quoridor: 'Коридор',
  dots_and_boxes: 'Точки и коробки' };
const FLEET_KIND = 'armada';
// Потолок на партию: «четыре в ряд» — это ~20 ходов, морской бой — до ~40 своих выстрелов плюс
// столько же ожиданий соперника, то есть заметно дольше.
const GAME_TIMEOUT_MS = { connect_four: 5 * 60_000, battleship: 10 * 60_000, pentago: 8 * 60_000, quoridor: 12 * 60_000,
  dots_and_boxes: 10 * 60_000 };
const ACCOUNT_BUDGET_MS = 25 * 60_000; // потолок на аккаунт целиком

const registry = new Map();            // accountId -> состояние для страницы
const queue = [];
let workers = 0;

const list = () => [...registry.entries()].map(([account_id, e]) => ({ account_id, ...e }));
const get = accountId => registry.get(Number(accountId));

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: не уложилось в ${Math.round(ms / 60000)} мин`)), ms); }),
  ]);
}

// Сессия игры (WS + подпись запросов) периодически отваливается сама по себе — это не поражение и
// не повод бросать аккаунт: поднимаем клиент заново и продолжаем с того же места. Сюда же 403
// «Invalid request signature»: подпись живёт вместе с WS и отваливается так же (поймано 20.08.2026).
const isSessionHiccup = e => /WS не авторизован|нет seed для подписи|Invalid request signature|signature required|ECONNRESET/i
  .test(String(e?.message || ''));

// Какой балаган играем: среди открытых берём тот, где ещё есть оплачиваемые победы. Вчерашний
// остаётся открытым с уже выбранным кошельком — если брать просто первый открытый, бот со второго
// дня события считал бы, что делать нечего.
function pickStall(midway) {
  const open = (midway?.stalls || []).filter(s => s.is_open && SOLVERS[s.identifier]);
  const withRoom = open.find(s => {
    const c = midway?.[s.identifier] || {};
    return Number(c.paid_wins_cap || 0) > Number(c.paid_wins || 0);
  });
  return withRoom || open[open.length - 1] || null;
}

// ── одна партия «Четыре в ряд» против бота ──────────────────────────────────
async function playConnectFour(api, name, existing) {
  let game = existing;
  if (!game || game.status === 'finished') {
    const created = await api.post('/anniversary-midway/connect-four/games', { vs_bot: true });
    game = created?.game || created;
  }
  if (!game?.code) throw new Error('игра не создана (нет code в ответе)');
  const url = `/anniversary-midway/connect-four/games/${game.code}`;

  let last = null;
  for (let i = 0; i < MAX_MOVES && game.status !== 'finished'; i++) {
    if (!game.your_turn) {
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    const move = bestMove(game.board, game.seat, SEARCH_DEPTH);
    if (!move) break;                                        // доска заполнена
    try {
      const r = await api.post(`${url}/move`, { column: move.col });
      game = r?.game || game;
      if (r?.connect_four) last = r.connect_four;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;                        // сессию чинит вызывающий
      // ход мог пройти — судим по фактической доске, а не по ответу
      logger.warn(`[${name}] [midway] ход ${move.col}: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    await sleep(MOVE_GAP_MS);
  }
  const won = game.status === 'finished' && game.winner === game.seat;
  return { won, tickets: Number(game.reward_tickets || 0), state: last, game };
}

// ── одна партия «Морской бой» против бота ───────────────────────────────────
// Порядок: создать игру → расставить флот → стрелять до конца. Клетка адресуется одним индексом
// row*10+col; свои выстрелы читаем из grids.firing, живые корабли — из grids.fleet_afloat (по ним
// солвер считает карту вероятностей).
async function playBattleship(api, name, existing, fleetLengths) {
  let game = existing;
  if (!game || game.status === 'finished') {
    const created = await api.post('/anniversary-midway/battleship/games', { vs_bot: true, fleet_kind: FLEET_KIND });
    game = created?.game || created;
  }
  if (!game?.code) throw new Error('игра не создана (нет code в ответе)');
  const url = `/anniversary-midway/battleship/games/${game.code}`;
  const reread = async () => { game = (await api.get(url)).game; };

  let last = null;
  if (!game.your_fleet_ready) {
    const ships = battleship.randomFleet(fleetLengths);
    if (!ships.length) throw new Error('не удалось расставить флот');
    try {
      const r = await api.post(`${url}/fleet`, { ships });
      game = r?.game || game;
      if (r?.battleship) last = r.battleship;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;
      // ответ мог не дойти, а расстановка пройти — судим по состоянию, а не по ошибке
      logger.warn(`[${name}] [midway] расстановка флота: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      await reread();
      if (!game.your_fleet_ready) throw e;
    }
  }

  for (let i = 0; i < MAX_SHOTS && game.status !== 'finished'; i++) {
    if (!game.your_turn) { await sleep(POLL_GAP_MS); await reread(); continue; }
    const afloat = Array.isArray(game.grids?.fleet_afloat) && game.grids.fleet_afloat.length
      ? game.grids.fleet_afloat : fleetLengths;
    const cell = battleship.nextShot(game.grids?.firing, afloat);
    if (cell == null) break;
    try {
      const r = await api.post(`${url}/fire`, { cell });
      game = r?.game || game;
      if (r?.battleship) last = r.battleship;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;
      logger.warn(`[${name}] [midway] выстрел ${cell}: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      await reread();
      continue;
    }
    await sleep(MOVE_GAP_MS);
  }
  const won = game.status === 'finished' && game.winner === game.seat;
  return { won, tickets: Number(game.reward_tickets || 0), state: last, game };
}

// ── одна партия «Пентаго» против бота ───────────────────────────────────────
// Ход = поставить шарик в пустую клетку И повернуть один квадрант 3×3 на 90°:
// POST .../move {cell, quadrant, clockwise}, где quadrant=-1 означает «без поворота».
// Доска — строка из 36 символов ('.', '1', '2'), индекс клетки = row*6+col.
async function playPentago(api, name, existing) {
  let game = existing;
  if (!game || game.status === 'finished') {
    const created = await api.post('/anniversary-midway/pentago/games', { vs_bot: true });
    game = created?.game || created;
  }
  if (!game?.code) throw new Error('игра не создана (нет code в ответе)');
  const url = `/anniversary-midway/pentago/games/${game.code}`;

  let last = null;
  for (let i = 0; i < MAX_PLIES && game.status !== 'finished'; i++) {
    if (!game.your_turn) {
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    const mv = pentago.bestMove(game.board, game.seat);
    if (!mv) break;                                          // ставить некуда
    try {
      const r = await api.post(`${url}/move`, { cell: mv.cell, quadrant: mv.quadrant, clockwise: mv.clockwise });
      game = r?.game || game;
      if (r?.pentago) last = r.pentago;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;
      logger.warn(`[${name}] [midway] ход ${mv.cell}/${mv.quadrant}: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    await sleep(MOVE_GAP_MS);
  }
  const won = game.status === 'finished' && game.winner === game.seat;
  return { won, tickets: Number(game.reward_tickets || 0), state: last, game };
}

// ── одна партия «Коридор» против бота ───────────────────────────────────────
// Ход бывает двух видов, но отправляется одним запросом с ПОЛНЫМ набором полей (игра ждёт все
// четыре, лишние в бандле шлются нулями):
//   POST .../move {kind:'step', cell, slot:0, horizontal:false}  — шаг фишкой
//   POST .../move {kind:'wall', cell:0, slot, horizontal}        — поставить стену
// Список своих легальных шагов игра присылает сама в game.legal — прыжки через чужую фишку и обход
// по диагонали считать не нужно, а вот стены проверяем сами (солвер повторяет правила игры).
async function playQuoridor(api, name, existing) {
  let game = existing;
  if (!game || game.status === 'finished') {
    const created = await api.post('/anniversary-midway/quoridor/games', { vs_bot: true });
    game = created?.game || created;
  }
  if (!game?.code) throw new Error('игра не создана (нет code в ответе)');
  const url = `/anniversary-midway/quoridor/games/${game.code}`;

  let last = null;
  for (let i = 0; i < MAX_TURNS && game.status !== 'finished'; i++) {
    if (!game.your_turn) {
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    const mv = quoridor.bestMove(game);
    if (!mv) break;                                          // ходить нечем — такого быть не должно
    const body = mv.kind === 'wall'
      ? { kind: 'wall', cell: 0, slot: mv.slot, horizontal: mv.horizontal }
      : { kind: 'step', cell: mv.cell, slot: 0, horizontal: false };
    try {
      const r = await api.post(`${url}/move`, body);
      game = r?.game || game;
      if (r?.quoridor) last = r.quoridor;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;
      // ход мог ПРОЙТИ, просто ответа не дождались — не повторяем вслепую, а перечитываем партию
      logger.warn(`[${name}] [midway] ход ${JSON.stringify(body)}: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    await sleep(MOVE_GAP_MS);
  }
  const won = game.status === 'finished' && game.winner === game.seat;
  return { won, tickets: Number(game.reward_tickets || 0), state: last, game };
}

// ── одна партия «Точки и коробки» против бота ───────────────────────────────
// Ход: POST .../move {line}. Замкнул коробку — ходишь снова (игра сама держит your_turn), поэтому
// цикл ничем не отличается от остальных балаганов.
async function playDotsAndBoxes(api, name, existing) {
  let game = existing;
  if (!game || game.status === 'finished') {
    const created = await api.post('/anniversary-midway/dots-and-boxes/games', { vs_bot: true });
    game = created?.game || created;
  }
  if (!game?.code) throw new Error('игра не создана (нет code в ответе)');
  const url = `/anniversary-midway/dots-and-boxes/games/${game.code}`;

  let last = null;
  for (let i = 0; i < MAX_LINES && game.status !== 'finished'; i++) {
    if (!game.your_turn) {
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    const mv = dotsAndBoxes.bestMove(game);
    if (!mv) break;                                          // свободных линий не осталось
    try {
      const r = await api.post(`${url}/move`, { line: mv.line });
      game = r?.game || game;
      if (r?.dots_and_boxes) last = r.dots_and_boxes;
    } catch (e) {
      if (isSessionHiccup(e)) throw e;
      // ход мог пройти, а ответа не дождались — не повторяем вслепую, перечитываем партию
      logger.warn(`[${name}] [midway] линия ${mv.line}: ${e.message} — перечитываю партию`);
      await sleep(POLL_GAP_MS);
      game = (await api.get(url)).game;
      continue;
    }
    await sleep(MOVE_GAP_MS);
  }
  const won = game.status === 'finished' && game.winner === game.seat;
  return { won, tickets: Number(game.reward_tickets || 0), state: last, game };
}

// ── проход по одному аккаунту: доигрываем кошелёк дня ────────────────────────
async function runAccount(accountId, name, makeApiForAccount) {
  const st = registry.get(accountId);
  const startedAt = Date.now();
  let api = await makeApiForAccount(accountId, { noLock: true });

  // Первый же запрос может уткнуться в отвалившуюся подпись/WS — поднимаем клиент заново и пробуем
  // ещё раз, иначе аккаунт вылетает из прохода ещё до первой партии.
  let midway;
  try { midway = await api.get('/anniversary-midway/'); }
  catch (e) {
    if (!isSessionHiccup(e)) throw e;
    logger.warn(`[${name}] [midway] сессия не готова (${e.message}) — поднимаю заново`);
    await sleep(5000);
    api = await makeApiForAccount(accountId, { noLock: true });
    midway = await api.get('/anniversary-midway/');
  }
  if (!midway?.is_open) { st.step = 'аллея закрыта'; return; }

  const openNow = (midway.stalls || []).filter(s => s.is_open);
  if (!openNow.length) { st.step = 'сегодня балаган закрыт'; return; }
  const stall = pickStall(midway);
  if (!stall) {
    // балаганы 3–5 игра заранее не раскрывает; откроется незнакомый — честно скажем, что не умеем
    const today = openNow[openNow.length - 1];
    st.step = 'готово';
    st.error = `балаган «${today?.identifier || 'без имени'}» бот пока не умеет`;
    return;
  }
  st.game = SOLVERS[stall.identifier];

  const counters = midway[stall.identifier] || {};
  st.wins = Number(counters.paid_wins || 0);
  st.needed = Number(counters.paid_wins_cap || 0);
  st.tickets = Number(counters.tickets_earned || 0);
  if (st.needed && st.wins >= st.needed) { st.step = 'кошелёк дня уже выбран'; return; }

  let active = midway.active_game && midway.active_game.status !== 'finished' ? midway.active_game : null;
  if (active && !active.vs_bot) {
    // недоигранная партия с живым игроком — не бросаем и не играем за него, просто не мешаем
    st.step = 'готово';
    st.error = 'есть незавершённая партия с живым игроком — доиграйте её в игре';
    return;
  }

  // Незавершённую партию игра отдаёт в СВОЁМ поле на каждую игру (active_game — «четыре в ряд»,
  // active_battleship_game, active_pentago_game; последние два появились вместе со своими днями).
  // Плюс страховка своим же запомненным кодом: она нужна, когда сессия отвалилась ровно между
  // ходами и игра ещё не успела показать партию активной.
  const URLS = {
    connect_four: '/anniversary-midway/connect-four/games',
    battleship: '/anniversary-midway/battleship/games',
    pentago: '/anniversary-midway/pentago/games',
    quoridor: '/anniversary-midway/quoridor/games',
    dots_and_boxes: '/anniversary-midway/dots-and-boxes/games',
  };
  const ACTIVE_FIELDS = {
    connect_four: 'active_game',
    battleship: 'active_battleship_game',
    pentago: 'active_pentago_game',
    quoridor: 'active_quoridor_game',
    dots_and_boxes: 'active_dots_and_boxes_game',
  };
  const resumeOwnGame = async (state) => {
    const fromState = state?.[ACTIVE_FIELDS[stall.identifier]];
    if (fromState && fromState.status !== 'finished' && fromState.vs_bot !== false) return fromState;
    if (!st.lastGameCode) return null;
    try {
      const g = (await api.get(`${URLS[stall.identifier]}/${st.lastGameCode}`)).game;
      return g && g.status !== 'finished' ? g : null;
    } catch (_) { return null; }
  };
  if (!active) active = await resumeOwnGame(midway);

  const fleetLengths = (midway.battleship?.fleets || []).find(f => f.kind === FLEET_KIND)?.lengths || [5, 4, 3, 3, 2];
  const playOnce = existing => {
    if (stall.identifier === 'battleship') return playBattleship(api, name, existing, fleetLengths);
    if (stall.identifier === 'pentago') return playPentago(api, name, existing);
    if (stall.identifier === 'quoridor') return playQuoridor(api, name, existing);
    if (stall.identifier === 'dots_and_boxes') return playDotsAndBoxes(api, name, existing);
    return playConnectFour(api, name, existing);
  };
  const timeout = GAME_TIMEOUT_MS[stall.identifier] || 5 * 60_000;

  while (st.wins < st.needed) {
    if (Date.now() - startedAt > ACCOUNT_BUDGET_MS) { st.error = 'не уложились в отведённое время'; break; }
    st.step = `${SOLVERS[stall.identifier]}: партия ${st.wins + 1} из ${st.needed}`;
    // Сессия может отвалиться несколько раз подряд (подпись восстанавливается не с первой попытки),
    // поэтому пробуем до трёх раз с нарастающей паузой. Это безопасно: прогресс побед считает
    // сервер игры, повтор не может «переплатить» — он лишь доигрывает ту же партию.
    let r = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !r; attempt++) {
      try {
        r = await withTimeout(playOnce(active), timeout, 'партия');
      } catch (e) {
        lastErr = e;
        if (!isSessionHiccup(e) || attempt === 3) throw e;
        logger.warn(`[${name}] [midway] сессия отвалилась (${e.message}) — попытка ${attempt + 1} из 3`);
        await sleep(5000 * attempt);
        api = await makeApiForAccount(accountId, { noLock: true });
        active = await resumeOwnGame(null);
      }
    }
    if (!r) throw lastErr || new Error('партия не доиграна');
    if (r.game?.code) st.lastGameCode = r.game.code;
    active = null;
    if (r.state) {
      st.wins = Number(r.state.paid_wins || st.wins);
      st.tickets = Number(r.state.tickets_earned || st.tickets);
    } else if (r.won) st.wins++;
    logger.info(`[${name}] [midway] ${SOLVERS[stall.identifier]}: партия ${r.won ? 'выиграна' : 'проиграна'}${r.tickets ? `, +${r.tickets} билетов` : ''} (побед ${st.wins}/${st.needed})`);
    // Счётчик именно ПОДРЯД идущих поражений: победа его обнуляет. Иначе чередование «выиграл —
    // проиграл» останавливало проход на середине кошелька (поймано на пентаго 21.08.2026).
    if (r.won) st.losses = 0;
    else {
      st.losses = (st.losses || 0) + 1;
      if (st.losses >= 3) { st.error = 'три поражения подряд — остановился'; break; }
    }
    await sleep(1000);
  }
  st.step = 'готово';
}

// ── очередь ──────────────────────────────────────────────────────────────────
function enqueue(accountId, name, makeApiForAccount) {
  accountId = Number(accountId);
  const existing = registry.get(accountId);
  if (existing && existing.running) return existing;     // уже играем за этот аккаунт
  const entry = {
    name, game: null, step: 'в очереди', wins: 0, needed: null, tickets: 0, losses: 0,
    running: true, error: null, startedAt: Date.now(), finishedAt: null,
    lastGameCode: existing?.lastGameCode || null,        // чтобы доиграть брошенную партию
  };
  registry.set(accountId, entry);
  queue.push({ accountId, name, makeApiForAccount });
  pump();
  return entry;
}

function pump() {
  while (workers < CONCURRENCY && queue.length) {
    const job = queue.shift();
    workers++;
    (async () => {
      const st = registry.get(job.accountId);
      try {
        st.step = 'начинаю';
        await runAccount(job.accountId, job.name, job.makeApiForAccount);
      } catch (e) {
        st.error = e.message;
        logger.warn(`[${job.name}] [midway] ${e.message}`);
      } finally {
        st.running = false;
        st.finishedAt = Date.now();
        workers--;
        pump();
      }
    })();
  }
}

// строки старше получаса убираем, чтобы список статуса не рос вечно
function prune() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, e] of registry) if (!e.running && e.finishedAt && e.finishedAt < cutoff) registry.delete(id);
}

module.exports = { enqueue, list, get, prune };
