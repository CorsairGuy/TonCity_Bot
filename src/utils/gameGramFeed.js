'use strict';
// Курс GRAM ИЗ ИГРЫ (вариант А) — не дёргаем игру поллингом отдельно: один "дежурный" аккаунт
// (у него и так обязателен постоянный WS для anti-bot гейта подписи запросов, см. wsSession.js)
// один раз шлёт gram_subscribe и дальше пассивно получает push-тики gram_price. Историю свечей
// сидируем через REST /satoshi-tower/candles один раз на таймфрейм, дальше сами наращиваем
// бары по тикам (candleAggregator) — так же, как это делает клиент игры на своей стороне.
const EventEmitter = require('events');
const logger = require('./logger');
const wsSession = require('./wsSession');
const candleAgg = require('./candleAggregator');

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const emitter = new EventEmitter();

let state = { price: 0, change_percent: 0, timestamp: 0 };
let candles = new Map(); // timeframe -> array
let designatedAccountId = null;
let startPromise = null; // промис, а не булев флаг — иначе параллельные вызовы обгоняют pickDesignatedAccount()
let lastTickAt = 0;      // когда последний раз пришёл gram_price (для watchdog)
let watchdogTimer = null;
const TICK_STALE_MS = 90 * 1000; // нет тиков дольше этого → дежурный аккаунт «умер», переизбираем

function onTick(tick) {
  lastTickAt = Date.now();
  state = { price: tick.price, change_percent: tick.change_percent, timestamp: tick.timestamp || Date.now() };
  const tsSec = Math.floor(state.timestamp / 1000);
  for (const tf of TIMEFRAMES) {
    if (!candles.has(tf)) continue; // ещё не сидировали историю для этого таймфрейма — пропускаем
    const arr = candles.get(tf);
    candleAgg.applyTick(arr, tf, state.price, tsSec);
    emitter.emit('candle', { timeframe: tf, candle: arr[arr.length - 1] });
  }
  emitter.emit('tick', state);
}

// Курс/позиции доступны ТОЛЬКО аккаунтам с Башней Сатоши на карте (special_buildings — как
// у Центрального рынка/Павильона удачи, см. modules/session.js SPECIAL_BUILDINGS). Перебирать
// аккаунты без здания бессмысленно — сервер игры ответит 403 «нет здания».
async function pickDesignatedAccount(excludeId = null) {
  const { Account } = require('../db/index');
  const { Op } = require('sequelize');
  const { apiForAcc } = require('../web/lib/api');
  const { ensureSession } = require('../modules/session');
  const accs = await Account.findAll({
    where: { access_token: { [Op.not]: null }, special_buildings: { [Op.like]: '%satoshi%' } },
    order: [['id', 'ASC']],
  });
  if (!accs.length) { logger.warn('[satoshi-game-feed] ни у одного аккаунта нет Башни Сатоши на карте'); return false; }
  // при переизбрании (watchdog) «умерший» дежурный пробуем ПОСЛЕДНИМ — вдруг другие живее
  const ordered = excludeId != null
    ? [...accs.filter(a => a.id !== excludeId), ...accs.filter(a => a.id === excludeId)]
    : accs;
  for (const acc of ordered) {
    try {
      const api = apiForAcc(acc);
      // ВАЖНО: без прогрева сессии (seed для подписи + подъём WS) первый же запрос свежего
      // процесса улетит неподписанным → 403 "Request signature required" (см. modules/session.js)
      const session = await ensureSession(api, acc);
      if (!session) throw new Error('не удалось прогреть сессию');
      await api.get('/satoshi-tower/config');
      designatedAccountId = acc.id;
      lastTickAt = Date.now(); // дать время на первый тик, чтобы watchdog не сработал сразу
      wsSession.subscribeGramFeed(acc.id, onTick);
      logger.info(`[satoshi-game-feed] дежурный аккаунт для курса GRAM: ${acc.name}`);
      startWatchdog();
      return true;
    } catch (e) { logger.warn(`[satoshi-game-feed] ${acc.name} не подошёл: ${e.message}`); }
  }
  return false;
}

// Watchdog: если дежурный аккаунт «умер» (протух токен/WS не поднимается) — пуш-тики gram_price
// прекращаются и курс из игры на странице «висит». Раньше это чинилось только рестартом бота.
// Теперь: нет тиков дольше TICK_STALE_MS → переизбираем дежурного (исключая мёртвого), курс
// самовосстанавливается. Проверяем раз в 30с; unref, чтобы не держать процесс живым.
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (!designatedAccountId) return;
    if (Date.now() - lastTickAt < TICK_STALE_MS) return; // тики идут — всё ок
    const dead = designatedAccountId;
    logger.warn(`[satoshi-game-feed] нет тиков курса >${TICK_STALE_MS / 1000}с — переизбираю дежурного (был id ${dead})`);
    designatedAccountId = null;
    try { await pickDesignatedAccount(dead); } catch (e) { logger.warn(`[satoshi-game-feed] переизбрание: ${e.message}`); }
  }, 30 * 1000);
  if (watchdogTimer.unref) watchdogTimer.unref();
}

// Параллельные вызовы (несколько вкладок/эндпоинтов разом на старте процесса) ждут ОДИН и тот
// же промис, а не гонятся мимо друг друга — иначе часть вызовов видит "started" раньше, чем
// designatedAccountId реально назначен, и молча уходит с пустой историей.
function ensureStarted() {
  if (!startPromise) {
    startPromise = pickDesignatedAccount().then(ok => {
      if (!ok) {
        logger.warn('[satoshi-game-feed] не удалось назначить дежурный аккаунт, повтор через 5 мин');
        startPromise = null;
        setTimeout(ensureStarted, 5 * 60 * 1000);
      }
    });
  }
  return startPromise;
}

async function seedTimeframe(timeframe, limit) {
  // ВАЖНО: не помечаем таймфрейм "сидированным" при пустом результате — иначе при первом вызове
  // (ещё нет дежурного аккаунта/сеть моргнула) история так и останется пустой навсегда, и график
  // будет получать только новые бары по тикам ("висит" одна текущая свеча). Разрешаем повтор.
  if ((candles.get(timeframe) || []).length > 0) return;
  if (!designatedAccountId) return;
  try {
    const { makeApiForAccount } = require('../web/lib/api');
    const api = await makeApiForAccount(designatedAccountId);
    const data = await api.get('/satoshi-tower/candles', { timeframe, limit });
    if (data?.candles?.length) candles.set(timeframe, data.candles.slice(-limit));
  } catch (e) { logger.warn(`[satoshi-game-feed] seed ${timeframe}: ${e.message}`); }
}

async function getCandles(timeframe, limit = 300) {
  await ensureStarted();
  await seedTimeframe(timeframe, limit);
  return (candles.get(timeframe) || []).slice(-limit);
}

function getPrice() { return state; }
function onPriceTick(cb) { emitter.on('tick', cb); return () => emitter.off('tick', cb); }
function onCandle(cb) { emitter.on('candle', cb); return () => emitter.off('candle', cb); }

module.exports = { ensureStarted, getCandles, getPrice, onPriceTick, onCandle };
