'use strict';
// Подпись запросов к игре (заголовки X-Req-Token / X-Req-Ts / X-Req-Nonce).
//
// С обновления 06.07.2026 клиент игры для веб-сессий (Bearer-токен — как у бота)
// на КАЖДЫЙ /api/* запрос добавляет подпись, вычисляемую WASM-модулем из
// (session_seed, timestamp, nonce, HTTP-метод, путь). session_seed приходит в
// ответе /web-auth/exchange и /web-auth/refresh (поле session_seed, 32-байт hex).
//
// Здесь воспроизведён glue-код чанка wasm_challenge-*.js: экспорт _a обёрнут в sign().
// WASM самодостаточен (нулевые импорты), инстанцируется синхронно один раз.
// Сверено байт-в-байт с настоящим кодом клиента (тот же токен на одинаковых входах).
//
// Модель: seed хранится per-account (Map по account.id). Пока seed нет —
// подпись не добавляется (ровно как в клиенте: lM возвращает null без seed),
// поэтому первый exchange/refresh проходит без подписи (иначе была бы курица-яйцо).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const WASM_PATH = path.join(__dirname, 'reqChallenge.wasm');
const enc = new TextEncoder();

let _wasm = null;      // { L } — обёртка экспорта _a
let _wasmTried = false;

// Инстанцируем WASM и строим обёртку L(seed,tsHi,tsLo,nonce,method,path)->Uint8Array.
function _initWasm() {
  if (_wasm || _wasmTried) return _wasm;
  _wasmTried = true;
  try {
    const bytes = fs.readFileSync(WASM_PATH);
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const n = inst.exports;
    let u8 = null, dv = null, len = 0;
    const mem8 = () => {
      if (u8 === null || u8.byteLength === 0) u8 = new Uint8Array(n.memory.buffer);
      return u8;
    };
    const view = () => {
      if (dv === null || dv.buffer !== n.memory.buffer) dv = new DataView(n.memory.buffer);
      return dv;
    };
    const put = (arr) => {
      const ptr = n.__wbindgen_export(arr.length * 1, 1) >>> 0;
      mem8().set(arr, ptr);
      len = arr.length;
      return ptr;
    };
    const L = (seed, tsHi, tsLo, nonce, method, p) => {
      const b = n.__wbindgen_add_to_stack_pointer(-16);
      try {
        const m = put(seed), A = len;
        const W = put(nonce), R = len;
        const h = put(method), M = len;
        const U = put(p), x = len;
        n._a(b, m, A, tsHi, tsLo, W, R, h, M, U, x);
        const rptr = view().getInt32(b + 0, true) >>> 0;
        const rlen = view().getInt32(b + 4, true);
        const out = mem8().subarray(rptr, rptr + rlen).slice();
        n.__wbindgen_export2(rptr, rlen * 1, 1);
        return out;
      } finally {
        n.__wbindgen_add_to_stack_pointer(16);
      }
    };
    _wasm = { L };
    logger.info('[reqSign] WASM challenge загружен');
  } catch (e) {
    logger.error(`[reqSign] не удалось загрузить WASM (${WASM_PATH}): ${e.message} — запросы пойдут без подписи`);
    _wasm = null;
  }
  return _wasm;
}

// ── seed per account ────────────────────────────────────────────────────────
const _seeds = new Map();  // accountId -> Uint8Array(32)

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2) return null;
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) {
    const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    a[i] = v;
  }
  return a;
}
function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Сохранить/обновить seed аккаунта из ответа exchange/refresh.
// seedHex может быть undefined — тогда ничего не меняем (сервер прислал не всегда).
function setSeed(accountId, seedHex) {
  if (accountId == null || !seedHex) return;
  const bytes = hexToBytes(seedHex);
  if (!bytes || bytes.length !== 32) {
    logger.warn(`[reqSign] некорректный session_seed для acc ${accountId} (len=${seedHex.length})`);
    return;
  }
  _seeds.set(accountId, bytes);
}
function hasSeed(accountId) {
  return _seeds.has(accountId);
}
function clearSeed(accountId) {
  _seeds.delete(accountId);
}

// Построить подписываемый путь ровно как клиент: "/api"+path, без query.
function canonPath(reqPath) {
  let p = String(reqPath || '');
  if (!p.startsWith('/api')) p = '/api' + (p.startsWith('/') ? '' : '/') + p;
  const q = p.indexOf('?');
  return q === -1 ? p : p.slice(0, q);
}

// Вернуть заголовки подписи для запроса аккаунта или null (нет seed / нет WASM).
// method — HTTP-метод, reqPath — путь запроса относительно baseUrl (напр. '/progress/').
function headersFor(accountId, method, reqPath) {
  const seed = _seeds.get(accountId);
  if (!seed) return null;
  const w = _initWasm();
  if (!w) return null;
  try {
    const nonce = crypto.randomUUID();
    const r = Date.now();
    const tsHi = Math.floor(r / 4294967296);
    const tsLo = r >>> 0;
    const sig = w.L(seed, tsHi, tsLo, enc.encode(nonce), enc.encode(String(method || 'GET').toUpperCase()), enc.encode(canonPath(reqPath)));
    return {
      'X-Req-Token': bytesToHex(sig),
      'X-Req-Ts': r.toString(),
      'X-Req-Nonce': nonce,
    };
  } catch (e) {
    logger.warn(`[reqSign] ошибка подписи acc ${accountId}: ${e.message}`);
    return null;
  }
}

// Сырая подпись для произвольного метода/пути (нужно для WS-хендшейка: method='WS', path='/ws').
// Возвращает {token, ts, nonce} или null (нет seed/WASM). Путь передаётся КАК ЕСТЬ (не канонизируется).
function signRaw(accountId, method, rawPath) {
  const seed = _seeds.get(accountId);
  if (!seed) return null;
  const w = _initWasm();
  if (!w) return null;
  try {
    const nonce = crypto.randomUUID();
    const r = Date.now();
    const sig = w.L(seed, Math.floor(r / 4294967296), r >>> 0, enc.encode(nonce), enc.encode(String(method || 'GET').toUpperCase()), enc.encode(String(rawPath || '')));
    return { token: bytesToHex(sig), ts: r.toString(), nonce };
  } catch (e) {
    logger.warn(`[reqSign] ошибка signRaw acc ${accountId}: ${e.message}`);
    return null;
  }
}

module.exports = { setSeed, hasSeed, clearSeed, headersFor, signRaw, canonPath, _initWasm };
