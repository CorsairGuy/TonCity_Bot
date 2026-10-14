'use strict';
// Сборка отдельных тиков цены в OHLC-свечи по таймфрейму — используется для фида цены ИГРЫ
// (WS отдаёт только сырые тики gram_price, свечей по WS игра не шлёт). Для биржевого фида это
// не нужно — Binance kline-стрим уже присылает готовые OHLC-бары.

const TIMEFRAME_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

function bucketStart(tsSec, timeframe) {
  const sz = TIMEFRAME_SEC[timeframe] || 60;
  return Math.floor(tsSec / sz) * sz;
}

// мутирует массив свечей на месте: обновляет текущий (последний) бар или открывает новый
function applyTick(candles, timeframe, price, tsSec) {
  const bucket = bucketStart(tsSec, timeframe);
  const last = candles[candles.length - 1];
  if (last && last.time === bucket) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  } else {
    candles.push({ time: bucket, open: last ? last.close : price, high: price, low: price, close: price, volume: 0 });
    if (candles.length > 1000) candles.shift();
  }
  return candles;
}

module.exports = { TIMEFRAME_SEC, bucketStart, applyTick };
