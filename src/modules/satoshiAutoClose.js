'use strict';
// Авто-закрытие позиций по TP/SL — фича бота, игра такого не поддерживает нативно (payload
// открытия позиции — только {side,leverage,margin}, см. reverse в routes/satoshi.js). Решение о
// срабатывании принимаем по РЕАЛЬНОМУ биржевому курсу (gramExchangeFeed, WS Binance/OKX/KuCoin) —
// именно его хочет видеть пользователь как триггер, а не внутриигровую синтетику. Но непосредственно
// перед самим запросом на закрытие дополнительно берём свежую цену ИГРЫ (GET /satoshi-tower/price) —
// чисто для контроля/лога, сам close выполняется по актуальному состоянию на сервере игры.
const logger = require('../utils/logger');
const gramExchangeFeed = require('../utils/gramExchangeFeed');

const CHECK_INTERVAL_MS = 3000; // троттлинг: не чаще раза в 3с, даже если тики идут чаще
let lastCheck = 0;
let checking = false;
const inFlight = new Set(); // id позиций, для которых close уже отправлен — не дублируем

// При массовом срабатывании TP/SL (резкое движение курса тронуло сразу много позиций) закрытия
// летели ПАРАЛЛЕЛЬНО и в обход общего apiLock (noLock) → игра отвечала 429 "Too Many Requests".
// Сериализуем close-запросы через общую цепочку с паузой между ними.
const CLOSE_GAP_MS = 400;
let _closeChain = Promise.resolve();
function throttledClose(fn) {
  const run = _closeChain.then(async () => {
    const r = await fn();
    await new Promise(res => setTimeout(res, CLOSE_GAP_MS));
    return r;
  });
  _closeChain = run.then(() => {}, () => {}); // ошибка одного close не рвёт цепочку
  return run;
}

function calcPnlPct(pos, price) {
  if (!price || !pos.entry_price || !pos.margin) return 0;
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = dir * ((price - pos.entry_price) / pos.entry_price) * pos.notional;
  return pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
}

function isTriggered(pos, price) {
  const pnlPct = calcPnlPct(pos, price);
  const long = pos.side === 'long';
  if (pos.tp_price != null && (long ? price >= pos.tp_price : price <= pos.tp_price)) return 'tp_price';
  if (pos.sl_price != null && (long ? price <= pos.sl_price : price >= pos.sl_price)) return 'sl_price';
  if (pos.tp_pnl_pct != null && pnlPct >= pos.tp_pnl_pct) return 'tp_pnl_pct';
  if (pos.sl_pnl_pct != null && pnlPct <= -Math.abs(pos.sl_pnl_pct)) return 'sl_pnl_pct';
  return null;
}

// Найденный вживую баг (21.07.2026): у SQL-запроса ниже нет таймаута НА ВЫПОЛНЕНИЕ (только
// connectTimeout/pool.acquire в db/index.js — они про установку соединения, а не про уже
// отправленный запрос). БД на отдельном сервере (сеть), и если запрос уходит на "подвисшее"
// соединение (напр. сразу после шторма рестартов) — await никогда не резолвится и не падает,
// finally ниже не выполняется, checking=true остаётся НАВСЕГДА → монитор TP/SL молча и без единой
// ошибки в логе перестаёт срабатывать до следующего рестарта процесса. Обнаружено по факту: цена
// на бирже реально пересекала TP (+20.9% ROI по шортам, +16.8% по лонгам, подтверждено live-историей
// Binance), позиции не закрылись, в логе — ни одной записи ни об ошибке, ни о проверке. Фикс —
// жёсткий таймаут на сам запрос, чтобы checking не мог зависнуть навсегда.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkOnce(price) {
  if (checking || !price) return;
  checking = true;
  try {
    const { SatoshiPosition, Account } = require('../db/index');
    const { Op } = require('sequelize');
    const rows = await withTimeout(SatoshiPosition.findAll({
      where: {
        [Op.or]: [
          { tp_price: { [Op.not]: null } }, { sl_price: { [Op.not]: null } },
          { tp_pnl_pct: { [Op.not]: null } }, { sl_pnl_pct: { [Op.not]: null } },
        ],
      },
    }), 8000, 'satoshi-autoclose findAll');
    for (const row of rows) {
      if (inFlight.has(row.id)) continue;
      const reason = isTriggered(row, price);
      if (!reason) continue;
      inFlight.add(row.id);
      (async () => {
        let api = null, acc = null;
        try {
          acc = await Account.findOne({ where: { name: row.account }, attributes: ['id', 'name'] });
          if (!acc) return;
          const { makeApiForAccount } = require('../web/lib/api');
          api = await makeApiForAccount(acc.id, { noLock: true });
          // свежая цена ИГРЫ прямо перед действием — для лога/контроля (сам close сервер игры
          // исполняет по своей актуальной цене, этот запрос ничего не меняет в позиции)
          const gamePrice = await api.get('/satoshi-tower/price').catch(() => null);
          const result = await throttledClose(() => api.post('/satoshi-tower/positions/close', { position_id: row.id }));
          logger.info(`[satoshi-autoclose] [${acc.name}] позиция #${row.id} закрыта по ${reason} (биржа=${price}, игра=${gamePrice?.price ?? '?'})`);
          await require('./satoshi').applyBalance(acc.id, result?.new_balance);
        } catch (e) {
          logger.warn(`[satoshi-autoclose] закрытие #${row.id} не удалось: ${e.message}`);
        } finally {
          // ре-синк в ЛЮБОМ случае: и после успеха, и после ошибки — если позиция уже закрыта/
          // ликвидирована (400/404), синк уберёт её из БД, иначе будем долбить закрытие каждый тик
          if (api && acc) { try { await require('./satoshi').runSatoshi(api, acc.name); } catch (_) {} }
          inFlight.delete(row.id);
        }
      })();
    }
  } catch (e) { logger.warn(`[satoshi-autoclose] проверка: ${e.message}`); }
  finally { checking = false; }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  gramExchangeFeed.onTick(tick => {
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;
    lastCheck = now;
    checkOnce(tick.price);
  });
  logger.info('[satoshi-autoclose] мониторинг TP/SL запущен (по живому биржевому курсу)');
}

module.exports = { start };
