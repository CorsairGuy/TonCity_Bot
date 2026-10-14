'use strict';
// Пересчёт и валидация уровней TP/SL для Башни Сатоши — 1:1 с математикой клиента игры.
// Появилось после обновления игры 31.07.2026, когда у игры завёлся СВОЙ (серверный) TP/SL.
//
// Реверс: chunks/satoshi_tower-*.js, компонент OrderTicket.
//   POST /satoshi-tower/positions {side,leverage,margin,take_profit_price,stop_loss_price}
// Игра принимает АБСОЛЮТНУЮ ЦЕНУ, а не процент ROI, и проверяет её по границам из
// GET /satoshi-tower/config: min_trigger_distance, max_take_profit_multiple, stop_loss_liq_buffer,
// trigger_price_decimals, fee_rate, min_fee.
//
// Живёт отдельным модулем, потому что нужен из ДВУХ мест: web/routes/satoshi.js (открытие по
// кнопке) и modules/satoshiPendingOrders.js (срабатывание условного ордера) — формула должна быть
// ровно одна, иначе уровни в этих двух путях разъедутся.

// комиссия игры: max(min_fee, round(fee_rate * margin * leverage))
function gameFee(cfg, margin, leverage) {
  const feeRate = cfg?.fee_rate ?? 0.001;
  const minFee = cfg?.min_fee ?? 1;
  return Math.max(minFee, Math.round(feeRate * Number(margin) * Number(leverage)));
}

// «ROI % от маржи» → цена (функция zt в OrderTicket):
//   R = (pct/100*margin + fee) / notional;  price = entry * (long ? 1+R : 1-R)
//
// ЕДИНИЦЫ: pct приходит В ПРОЦЕНТАХ (50 = +50% ROI), как их хранит и шлёт фронт
// (SatoshiTower.tsx: tp_pnl_pct/sl_pnl_pct, там же margin*(pct/100)). Знак ЗАДАЁТ ВЫЗЫВАЮЩИЙ:
// sl_pnl_pct хранится ПОЛОЖИТЕЛЬНЫМ (величина убытка), поэтому для стоп-лосса сюда передают
// отрицательное значение — см. buildOpenTriggers. Отдельные грабли: без /100 и без минуса для SL
// уровни улетали за границы игры и подрезались клампом к максимуму (то есть молча не туда).
function pnlPctToPrice(cfg, { side, entry, margin, leverage, pct }) {
  const notional = Number(margin) * Number(leverage);
  if (!(entry > 0) || !(notional > 0) || pct == null) return null;
  const R = ((Number(pct) / 100) * Number(margin) + gameFee(cfg, margin, leverage)) / notional;
  const dec = cfg?.trigger_price_decimals ?? 3, f = 10 ** dec;
  return Math.round(Number(entry) * (side === 'long' ? 1 + R : 1 - R) * f) / f;
}

// Границы, которые игра проверяет у себя (те же вычисления st/ct/tt/ot в OrderTicket):
//   LONG : TP ∈ [entry*(1+d), entry*maxMult],  SL ∈ [liq + entry*buf, entry*(1-d)]
//   SHORT: TP ∈ [entry/maxMult, entry*(1-d)],  SL ∈ [entry*(1+d), liq - entry*buf]
// Выходить за них смысла нет — игра просто отклонит открытие, поэтому подрезаем на своей стороне.
function clampTrigger(cfg, { side, entry, liq, price, kind }) {
  if (price == null || !(entry > 0)) return null;
  const d = cfg?.min_trigger_distance ?? 0.001;
  const mult = cfg?.max_take_profit_multiple ?? 10;
  const buf = cfg?.stop_loss_liq_buffer ?? 0.001;
  const dec = cfg?.trigger_price_decimals ?? 3, f = 10 ** dec;
  const long = side === 'long';
  let lo, hi;
  if (kind === 'tp') {
    if (long) { lo = entry * (1 + d); hi = entry * mult; }
    else { lo = entry / mult; hi = entry * (1 - d); }
  } else {
    if (long) { lo = liq > 0 ? liq + entry * buf : 0; hi = entry * (1 - d); }
    else { lo = entry * (1 + d); hi = liq > 0 ? liq - entry * buf : Infinity; }
  }
  if (!(hi > lo)) return null;   // границы схлопнулись (например, слишком большое плечо)
  const v = Math.min(hi, Math.max(lo, Number(price)));
  return Math.round(v * f) / f;
}

// Грубая оценка цены ликвидации до открытия позиции — нужна только чтобы не выставить SL за неё.
// Точную liquidation_price игра вернёт уже в самой позиции.
function approxLiquidation(side, entry, leverage) {
  const lev = Number(leverage);
  if (!(entry > 0) || !(lev > 0)) return 0;
  return side === 'long' ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
}

// Готовые {take_profit_price,stop_loss_price} для тела POST /satoshi-tower/positions.
// Принимает и абсолютные цены, и проценты ROI (что задал пользователь) — наружу отдаёт только цены.
function buildOpenTriggers(cfg, { side, entry, margin, leverage, tp_price, sl_price, tp_pnl_pct, sl_pnl_pct }) {
  const out = {};
  if (!(entry > 0)) return out;
  const liq = approxLiquidation(side, entry, leverage);
  const mk = (price, pct, kind) => {
    // знак ROI: тейк — прибыль (+), стоп — убыток (−). sl_pnl_pct хранится положительным.
    const signed = pct == null ? null : (kind === 'tp' ? Math.abs(Number(pct)) : -Math.abs(Number(pct)));
    const raw = price != null ? Number(price)
      : (signed != null ? pnlPctToPrice(cfg, { side, entry, margin, leverage, pct: signed }) : null);
    return clampTrigger(cfg, { side, entry, liq, price: raw, kind });
  };
  const tp = mk(tp_price, tp_pnl_pct, 'tp');
  const sl = mk(sl_price, sl_pnl_pct, 'sl');
  if (tp != null) out.take_profit_price = tp;
  if (sl != null) out.stop_loss_price = sl;
  return out;
}

// Можно ли выставить бот-side уровень поверх игрового. Игровой TP/SL после открытия НЕ меняется
// (эндпоинта нет), поэтому бот способен только УЖЕСТОЧИТЬ — закрыть раньше игрового триггера.
//   LONG : строже = TP НИЖЕ игрового, SL ВЫШЕ игрового
//   SHORT: строже = TP ВЫШЕ игрового, SL НИЖЕ игрового
function isTightening(side, kind, gamePrice, botPrice) {
  if (gamePrice == null || botPrice == null) return true;  // игрового уровня нет — ограничения нет
  const long = side === 'long';
  return kind === 'tp'
    ? (long ? botPrice <= gamePrice : botPrice >= gamePrice)
    : (long ? botPrice >= gamePrice : botPrice <= gamePrice);
}

module.exports = { gameFee, pnlPctToPrice, clampTrigger, approxLiquidation, buildOpenTriggers, isTightening };
