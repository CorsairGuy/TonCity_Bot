'use strict';
const axios = require('axios');

// GRAM/USDT торгуется на реальных биржах (проверено) — берём курс оттуда, а не из игры
// (внутриигровая цена в /satoshi-tower/price — синтетическая для механики Башни Сатоши).
// Binance основной источник, OKX/KuCoin — резерв на случай гео-блока/лимитов.

const TIMEFRAME_MS = {
  '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000,
};

const BINANCE_INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const KUCOIN_TYPE = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1hour', '4h': '4hour', '1d': '1day' };

let priceCache = { ts: 0, data: null };
let candleCache = new Map(); // key `${timeframe}:${limit}` -> {ts,data}
const PRICE_TTL = 5000, CANDLE_TTL = 30000;

async function fetchBinancePrice() {
  const r = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: 'GRAMUSDT' }, timeout: 8000 });
  return { price: parseFloat(r.data.lastPrice), change_percent: parseFloat(r.data.priceChangePercent), source: 'binance' };
}
async function fetchOkxPrice() {
  const r = await axios.get('https://www.okx.com/api/v5/market/ticker', { params: { instId: 'GRAM-USDT' }, timeout: 8000 });
  const d = r.data.data[0];
  const last = parseFloat(d.last), open = parseFloat(d.open24h);
  return { price: last, change_percent: open ? ((last - open) / open) * 100 : 0, source: 'okx' };
}
async function fetchKucoinPrice() {
  const [tick, stats] = await Promise.all([
    axios.get('https://api.kucoin.com/api/v1/market/orderbook/level1', { params: { symbol: 'GRAM-USDT' }, timeout: 8000 }),
    axios.get('https://api.kucoin.com/api/v1/market/stats', { params: { symbol: 'GRAM-USDT' }, timeout: 8000 }),
  ]);
  return { price: parseFloat(tick.data.data.price), change_percent: parseFloat(stats.data.data.changeRate) * 100, source: 'kucoin' };
}

async function getPrice() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.ts < PRICE_TTL) return priceCache.data;
  let data;
  for (const fn of [fetchBinancePrice, fetchOkxPrice, fetchKucoinPrice]) {
    try { data = await fn(); break; } catch (_) { /* пробуем следующую биржу */ }
  }
  if (!data) throw new Error('Не удалось получить курс GRAM ни с одной биржи');
  data.timestamp = now;
  priceCache = { ts: now, data };
  return data;
}

async function fetchBinanceCandles(timeframe, limit) {
  const r = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol: 'GRAMUSDT', interval: BINANCE_INTERVAL[timeframe], limit }, timeout: 8000,
  });
  return r.data.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}
async function fetchOkxCandles(timeframe, limit) {
  const r = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId: 'GRAM-USDT', bar: OKX_BAR[timeframe], limit }, timeout: 8000,
  });
  return r.data.data.map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
}
async function fetchKucoinCandles(timeframe, limit) {
  const r = await axios.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol: 'GRAM-USDT', type: KUCOIN_TYPE[timeframe] }, timeout: 8000,
  });
  // KuCoin: [time, open, close, high, low, volume, turnover] — порядок open/close отличается от остальных
  return r.data.data.slice(0, limit).map(k => ({ time: +k[0], open: +k[1], high: +k[3], low: +k[4], close: +k[2], volume: +k[5] })).reverse();
}

async function getCandles(timeframe, limit = 300) {
  if (!TIMEFRAME_MS[timeframe]) throw new Error('Неизвестный таймфрейм: ' + timeframe);
  const key = `${timeframe}:${limit}`;
  const now = Date.now();
  const cached = candleCache.get(key);
  if (cached && now - cached.ts < CANDLE_TTL) return cached.data;
  let data;
  for (const fn of [fetchBinanceCandles, fetchOkxCandles, fetchKucoinCandles]) {
    try { data = await fn(timeframe, limit); if (data?.length) break; } catch (_) { /* пробуем следующую биржу */ }
  }
  if (!data) throw new Error('Не удалось получить свечи GRAM ни с одной биржи');
  candleCache.set(key, { ts: now, data });
  return data;
}

module.exports = { getPrice, getCandles };
