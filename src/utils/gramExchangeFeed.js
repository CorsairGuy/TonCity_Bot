'use strict';
// Живой курс GRAM/USDT с реальной биржи — WebSocket-стрим Binance (combined stream: тикер +
// kline по всем таймфреймам разом). Если Binance WS недоступен (гео-блок/сеть) — автоматически
// переключаемся на REST-поллинг (gramPrice.js: Binance→OKX→KuCoin) раз в 5с, пока WS не оживёт.
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = null; }
const EventEmitter = require('events');
const logger = require('./logger');
const gramPriceRest = require('./gramPrice');

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const SYMBOL = 'gramusdt';
const BACKOFF_MAX = 30000;

const emitter = new EventEmitter();
let candles = new Map();
let latest = { price: 0, change_percent: 0, timestamp: 0, source: null };
let ws = null;
let backoff = 1000;
let restTimer = null;
let startPromise = null; // промис, а не булев флаг — иначе параллельные вызовы обгоняют seedHistory()

function streamUrl() {
  const streams = [`${SYMBOL}@ticker`, ...TIMEFRAMES.map(tf => `${SYMBOL}@kline_${tf}`)];
  return `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
}

async function seedHistory() {
  for (const tf of TIMEFRAMES) {
    try { candles.set(tf, await gramPriceRest.getCandles(tf, 300)); }
    catch (e) { logger.warn(`[gram-exchange-feed] seed ${tf}: ${e.message}`); candles.set(tf, []); }
  }
}

function applyKline(tf, k) {
  const arr = candles.get(tf) || [];
  const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
  const last = arr[arr.length - 1];
  if (last && last.time === bar.time) arr[arr.length - 1] = bar;
  else { arr.push(bar); if (arr.length > 1000) arr.shift(); }
  candles.set(tf, arr);
  emitter.emit('candle', { timeframe: tf, candle: bar });
}

function startRestFallback() {
  if (restTimer) return;
  logger.warn('[gram-exchange-feed] WS недоступен — временно переключаюсь на REST-поллинг (Binance→OKX→KuCoin)');
  restTimer = setInterval(async () => {
    try { const p = await gramPriceRest.getPrice(); latest = { ...p }; emitter.emit('tick', latest); }
    catch (e) { logger.warn(`[gram-exchange-feed] REST fallback: ${e.message}`); }
  }, 5000);
}
function stopRestFallback() {
  if (restTimer) { clearInterval(restTimer); restTimer = null; }
}

function connect() {
  if (!WebSocket) { startRestFallback(); return; }
  if (ws) return;
  try { ws = new WebSocket(streamUrl()); }
  catch (e) { logger.warn(`[gram-exchange-feed] create WS: ${e.message}`); ws = null; scheduleReconnect(); return; }

  ws.on('open', () => { logger.info('[gram-exchange-feed] Binance WS подключен'); backoff = 1000; stopRestFallback(); });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const d = msg && msg.data; if (!d) return;
    if (d.e === '24hrTicker') {
      latest = { price: +d.c, change_percent: +d.P, timestamp: Date.now(), source: 'binance' };
      emitter.emit('tick', latest);
    } else if (d.e === 'kline') {
      applyKline(d.k.i, d.k);
    }
  });
  ws.on('error', e => logger.warn(`[gram-exchange-feed] WS error: ${e.message}`));
  ws.on('close', () => { logger.warn('[gram-exchange-feed] Binance WS закрыт — реконнект'); ws = null; scheduleReconnect(); });
}

function scheduleReconnect() {
  startRestFallback();
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
}

function ensureStarted() {
  if (!startPromise) startPromise = seedHistory().then(() => connect());
  return startPromise;
}

function getPrice() { return latest; }
async function getCandles(timeframe, limit = 300) {
  await ensureStarted();
  return (candles.get(timeframe) || []).slice(-limit);
}
function onTick(cb) { emitter.on('tick', cb); return () => emitter.off('tick', cb); }
function onCandle(cb) { emitter.on('candle', cb); return () => emitter.off('candle', cb); }

module.exports = { ensureStarted, getPrice, getCandles, onTick, onCandle };
