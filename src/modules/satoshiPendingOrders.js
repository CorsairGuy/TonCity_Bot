'use strict';
// Условные ордера ("открыть позицию по достижении цены") — тоже фича бота: игра не поддерживает
// отложенные/лимитные ордера, только мгновенное открытие {side,leverage,margin}. Следим за
// РЕАЛЬНЫМ биржевым курсом (как и TP/SL, см. satoshiAutoClose.js), направление срабатывания —
// пересечение trigger_price от исходной цены на момент создания ордера (ref_price). При
// срабатывании берём свежую цену ИГРЫ перед самим открытием (для лога) и шлём настоящий
// POST /satoshi-tower/positions.
const logger = require('../utils/logger');
const gramExchangeFeed = require('../utils/gramExchangeFeed');

const CHECK_INTERVAL_MS = 3000;
let lastCheck = 0;
let checking = false;
const inFlight = new Set();

function isCrossed(order, price) {
  if (order.ref_price == null) return true; // нет опорной цены — считаем что уже готово
  if (order.ref_price <= order.trigger_price) return price >= order.trigger_price; // ждём роста до цели
  return price <= order.trigger_price; // ждём падения до цели
}

async function checkOnce(price) {
  if (checking || !price) return;
  checking = true;
  try {
    const { SatoshiPendingOrder, Account, SatoshiPosition } = require('../db/index');
    const rows = await SatoshiPendingOrder.findAll({ where: { status: 'pending' } });
    for (const order of rows) {
      if (inFlight.has(order.id)) continue;
      if (!isCrossed(order, price)) continue;
      inFlight.add(order.id);
      (async () => {
        try {
          const acc = await Account.findOne({ where: { name: order.account }, attributes: ['id', 'name'] });
          if (!acc) { await order.update({ status: 'failed', error: 'Аккаунт не найден' }); return; }
          const { makeApiForAccount } = require('../web/lib/api');
          const api = await makeApiForAccount(acc.id, { noLock: true });
          const gamePrice = await api.get('/satoshi-tower/price').catch(() => null);

          const before = new Set((await SatoshiPosition.findAll({ where: { account: acc.name }, attributes: ['id'] })).map(r => r.id));
          // Игровой (серверный) TP/SL — обновление игры 31.07.2026: задать его можно ТОЛЬКО здесь,
          // в самом запросе открытия. Точка отсчёта — живая цена игры (не биржи: уровни проверяет
          // и исполняет сервер игры по своей цене). Та же математика, что у кнопки открытия в вебе.
          const { buildOpenTriggers } = require('../utils/satoshiTriggers');
          const cfg = await api.get('/satoshi-tower/config').catch(() => null);
          const entry = Number(gamePrice?.price) || null;
          const openBody = {
            side: order.side, leverage: order.leverage, margin: order.margin,
            ...buildOpenTriggers(cfg, {
              side: order.side, entry, margin: order.margin, leverage: order.leverage,
              tp_price: order.tp_price, sl_price: order.sl_price,
              tp_pnl_pct: order.tp_pnl_pct, sl_pnl_pct: order.sl_pnl_pct,
            }),
          };
          const openResult = await api.post('/satoshi-tower/positions', openBody);
          const satoshiMod = require('./satoshi');
          await satoshiMod.applyBalance(acc.id, openResult?.new_balance);
          await satoshiMod.runSatoshi(api, acc.name).catch(() => {});

          if (order.tp_price != null || order.sl_price != null || order.tp_pnl_pct != null || order.sl_pnl_pct != null) {
            const after = await SatoshiPosition.findAll({ where: { account: acc.name } });
            const created = after.find(r => !before.has(r.id));
            if (created) {
              await created.update({
                tp_price: order.tp_price, sl_price: order.sl_price,
                tp_pnl_pct: order.tp_pnl_pct, sl_pnl_pct: order.sl_pnl_pct,
              });
            }
          }
          await order.update({ status: 'triggered', triggered_at: new Date() });
          logger.info(`[satoshi-pending] [${acc.name}] ордер #${order.id} сработал (биржа=${price}, игра=${gamePrice?.price ?? '?'}) → открыт ${order.side}`);
        } catch (e) {
          logger.warn(`[satoshi-pending] ордер #${order.id} не удалось исполнить: ${e.message}`);
          await order.update({ status: 'failed', error: e.message }).catch(() => {});
        } finally { inFlight.delete(order.id); }
      })();
    }
  } catch (e) { logger.warn(`[satoshi-pending] проверка: ${e.message}`); }
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
  logger.info('[satoshi-pending] мониторинг условных ордеров запущен (по живому биржевому курсу)');
}

module.exports = { start };
