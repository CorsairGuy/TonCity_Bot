'use strict';
// Постоянные WebSocket-соединения на аккаунт.
//
// С обновления 06.07.2026 сервер игры пропускает REST-запросы к /api/* ТОЛЬКО при наличии
// активного авторизованного WS этого клиента. Без WS любой валидно-подписанный запрос → 403
// {"code":"forbidden","message":"Direct API access is not allowed"}. С живым WS → 200.
//
// URL: wss://game.toncity.io/ws. Хендшейк (web/Bearer): {type:'jwt_auth', data:<access_token>,
// req_token/req_ts/req_nonce} — подпись над методом 'WS' и путём '/ws' (reqSign.signRaw).
// Ответ сервера: {"type":"auth_result","success":true}. Далее heartbeat ping раз в 25с,
// pong-таймаут 10с → реконнект; backoff 1с→×2→30с.
//
// Состояние глобальное на процесс (бот и веб-сервер в одном процессе): один WS на account.id.
// Основной клиент — пакет `ws`; если он не установлен в окружении (напр. контейнер без npm install),
// падаем на встроенный zero-dep клиент, чтобы бот не крашился (см. miniWs.js).
let WebSocket;
try { WebSocket = require('ws'); }
catch (_) { WebSocket = require('./miniWs'); require('./logger').warn('[ws] пакет `ws` не найден — используется встроенный miniWs (поставьте ws для production)'); }
const cfg = require('../config');
const logger = require('./logger');
const reqSign = require('./reqSign');

const WS_URL = (cfg.baseUrl || 'https://game.toncity.io/api').replace(/^http/, 'ws').replace(/\/api\/?$/, '') + '/ws';
const PING_INTERVAL = 25000;   // мс: период heartbeat-ping
const PONG_TIMEOUT = 10000;    // мс: ждём любой ответ после ping, иначе реконнект
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;
const AUTH_TIMEOUT = 15000;    // мс: ждём auth_result после открытия
const READY_WAIT = 12000;      // мс: сколько ensureReady ждёт готовности

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sessions = new Map(); // accountId -> session

function _get(accountId) {
  let s = sessions.get(accountId);
  if (!s) {
    s = {
      accountId, ws: null, authed: false, connecting: false, closedByUs: false,
      getToken: null, refreshFn: null, backoff: BACKOFF_MIN, pingTimer: null, pongTimer: null,
      reconnectTimer: null, waiters: [], name: String(accountId), authFailCount: 0,
    };
    sessions.set(accountId, s);
  }
  return s;
}

// Истёк ли access-token (JWT). Буфер 60с — как Mue() в клиенте игры.
function _tokenExpired(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString());
    return typeof p.exp === 'number' ? (p.exp * 1000 < Date.now() + 60000) : false;
  } catch (_) { return false; }
}

function _clearTimers(s) {
  if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
  if (s.pongTimer) { clearTimeout(s.pongTimer); s.pongTimer = null; }
}

function _resolveWaiters(s, val) {
  const ws = s.waiters; s.waiters = [];
  for (const w of ws) { clearTimeout(w.timer); w.resolve(val); }
}

function _startHeartbeat(s) {
  _clearTimers(s);
  s.pingTimer = setInterval(() => {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    try { s.ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    if (s.pongTimer) clearTimeout(s.pongTimer);
    s.pongTimer = setTimeout(() => {
      logger.warn(`[ws:${s.name}] heartbeat timeout — реконнект`);
      try { s.ws && s.ws.terminate(); } catch (_) {}
    }, PONG_TIMEOUT);
  }, PING_INTERVAL);
}

// Токен может быть отозван сервером и при этом ещё не истёк по собственному exp в JWT — тогда
// auth_result явно возвращает fail, а _connect() (см. ниже) не пытается рефрешить, потому что
// _tokenExpired() говорит "всё ок". Без этой эскалации такой аккаунт долбит реконнект раз в 30с
// (потолок BACKOFF_MAX) БЕСКОНЕЧНО — что и видно в логах для мёртвых токенов. После нескольких
// подряд явных отказов авторизации увеличиваем потолок бэкоффа до HARD_FAIL_BACKOFF_MAX.
const HARD_FAIL_THRESHOLD = 3;
const HARD_FAIL_BACKOFF_MAX = 10 * 60 * 1000; // 10 минут — вместо реконнекта раз в 30с навечно

function _scheduleReconnect(s) {
  if (s.closedByUs) return;
  if (s.reconnectTimer) return;
  const cap = s.authFailCount >= HARD_FAIL_THRESHOLD ? HARD_FAIL_BACKOFF_MAX : BACKOFF_MAX;
  const base = Math.min(s.backoff, cap);
  s.backoff = Math.min(s.backoff * 2, cap);
  // РАЗБРОС по времени обязателен. Шлюз игры роняет ВСЕ соединения разом (в логе десятки строк
  // «закрыт (1006)» в одну секунду), и без джиттера все аккаунты переподключаются синхронно —
  // экспоненциальный backoff тут не спасает, потому что растёт у всех одинаково. Итог: пачка
  // одновременных рукопожатий, которые шлюз не тянет, и лог заполняется «Opening handshake has
  // timed out» (19.08 — 612 таких строк за час). Размазываем ±50%.
  const delay = Math.round(base * (0.5 + Math.random()));
  s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; _connect(s); }, delay);
}

// Не больше CONNECT_SLOTS рукопожатий одновременно на весь процесс. Само рукопожатие занимает
// доли секунды, поэтому очередь рассасывается быстро, но шлюз перестаёт получать шестьдесят
// одновременных подключений после массового обрыва или рестарта бота.
const CONNECT_SLOTS = 4;
let _connecting = 0;
const _connectQueue = [];
function _acquireSlot() {
  if (_connecting < CONNECT_SLOTS) { _connecting++; return Promise.resolve(); }
  return new Promise(resolve => _connectQueue.push(resolve));
}
function _releaseSlot() {
  const next = _connectQueue.shift();
  if (next) next(); else _connecting = Math.max(0, _connecting - 1);
}

async function _connect(s) {
  if (s.connecting || (s.ws && (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING))) return;
  s.connecting = true;
  s.authed = false;
  // Как в клиенте игры (s()→ix()): перед коннектом рефрешим токен, если он истёк —
  // иначе при реконнекте на протухшем токене WS зациклится. refreshFn обновит и токен, и seed.
  let token = s.getToken && s.getToken();
  // форсируем рефреш уже после ПЕРВОГО явного отказа авторизации WS (не ждём HARD_FAIL_THRESHOLD).
  // Причина: auth_result:fail почти всегда = протух session_seed (сервер вышиб WS и инвалидировал
  // seed — напр. этим аккаунтом параллельно зашёл живой человек в Telegram). Реконнект со СТАРЫМ
  // seed снова падает — нужен свежий seed, а он приходит ТОЛЬКО с refresh. Раньше ждали 3 отказа
  // (~10с), всё это время REST к аккаунту падал на гейте (Direct API/Invalid signature). Теперь
  // восстановление ~3с. От refresh-шторма защищает отметка «мёртв» (_refreshDead) в session.js.
  const forceRefresh = s.authFailCount >= 1;
  if (s.refreshFn && (!token || _tokenExpired(token) || forceRefresh)) {
    try { await s.refreshFn(); } catch (_) {}
    token = s.getToken && s.getToken();
  }
  // Нет токена/seed даже после попытки рефреша → аккаунт нерабочий (напр. протух refresh_token).
  // Не долбим WS вхолостую: засыпаем до следующего успешного рефреша (notifyRefreshed разбудит).
  // Логируем один раз, чтобы не спамить.
  if (!token) { s.connecting = false; if (!s.dormantLogged) { logger.warn(`[ws:${s.name}] нет токена для WS — WS отложен до рефреша`); s.dormantLogged = true; } _resolveWaiters(s, false); return; }
  const hs = reqSign.signRaw(s.accountId, 'WS', '/ws');
  if (!hs) { s.connecting = false; if (!s.dormantLogged) { logger.warn(`[ws:${s.name}] нет seed (рефреш не удался?) — WS отложен до рефреша`); s.dormantLogged = true; } _resolveWaiters(s, false); return; }
  s.dormantLogged = false;

  await _acquireSlot();
  // слот держим до конца рукопожатия (auth_result / close / ошибка создания)
  let slotReleased = false;
  // Страховка: если сокет не откроется и не закроется (шлюз молчит совсем), слот всё равно
  // вернётся в пул — иначе одна зависшая попытка навсегда съела бы одно из четырёх мест.
  let slotGuard = null;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    if (slotGuard) { clearTimeout(slotGuard); slotGuard = null; }
    _releaseSlot();
  };
  slotGuard = setTimeout(releaseSlot, 25000);
  if (slotGuard.unref) slotGuard.unref();

  let ws;
  try {
    ws = new WebSocket(WS_URL, {
      headers: { origin: 'https://game.toncity.io', 'user-agent': UA, cookie: 'i18n_redirected=ru' },
      handshakeTimeout: 15000,
    });
  } catch (e) {
    s.connecting = false;
    releaseSlot();
    logger.warn(`[ws:${s.name}] не удалось создать WS: ${e.message}`);
    _scheduleReconnect(s);
    return;
  }
  s.ws = ws;

  // Таймер ждёт auth_result и отсчитывается ОТ ОТКРЫТИЯ СОКЕТА, а не от его создания. Раньше он
  // стартовал сразу, и если шлюз тормозил с рукопожатием (а он тормозит: handshakeTimeout 15с),
  // таймер срабатывал по ещё НЕ открытому сокету и звал terminate() — отсюда в логе
  // «WebSocket was closed before the connection was established», а следом «WS не готов».
  // Незавершённое рукопожатие и так закроет сам ws по handshakeTimeout.
  let authTimer = null;

  ws.on('open', () => {
    authTimer = setTimeout(() => {
      if (!s.authed) { logger.warn(`[ws:${s.name}] auth timeout`); try { ws.terminate(); } catch (_) {} }
    }, AUTH_TIMEOUT);
    try { ws.send(JSON.stringify({ type: 'jwt_auth', data: token, req_token: hs.token, req_ts: hs.ts, req_nonce: hs.nonce })); }
    catch (e) { logger.warn(`[ws:${s.name}] send handshake: ${e.message}`); }
  });

  ws.on('message', (data) => {
    // любое сообщение = признак живого соединения → сбрасываем pong-таймер
    if (s.pongTimer) { clearTimeout(s.pongTimer); s.pongTimer = null; }
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg && msg.type === 'auth_result') {
      if (authTimer) clearTimeout(authTimer);
      if (msg.success) {
        s.connecting = false;
        releaseSlot();
        s.authed = true;
        s.backoff = BACKOFF_MIN;
        s.authFailCount = 0;
        logger.info(`[ws:${s.name}] авторизован`);
        _startHeartbeat(s);
        _resolveWaiters(s, true);
        // Башня Сатоши (вариант А): если этот аккаунт назначен "дежурным" для курса GRAM —
        // подписываемся на push-цену игры на уже открытом соединении (доп. коннектов не нужно)
        if (s.gramSubscribe) {
          try { ws.send(JSON.stringify({ type: 'gram_subscribe' })); } catch (_) {}
        }
      } else {
        s.authFailCount = (s.authFailCount || 0) + 1;
        if (s.authFailCount === HARD_FAIL_THRESHOLD) {
          logger.warn(`[ws:${s.name}] ${HARD_FAIL_THRESHOLD} явных отказов подряд — реконнект замедлен до раза в ${HARD_FAIL_BACKOFF_MAX / 60000} мин, форсируем рефреш токена`);
        }
        logger.warn(`[ws:${s.name}] auth_result: fail ${JSON.stringify(msg).slice(0, 120)}`);
        try { ws.terminate(); } catch (_) {}
      }
    } else if (msg && msg.type === 'gram_price' && s.onGramPrice) {
      try { s.onGramPrice({ price: msg.price, change_percent: msg.change_percent, timestamp: msg.timestamp }); }
      catch (e) { logger.warn(`[ws:${s.name}] onGramPrice: ${e.message}`); }
    }
  });

  ws.on('error', (e) => {
    // «closed before the connection was established» — это НЕ сбой игры, а наш собственный
    // terminate() по недооткрытому сокету (реконнект/остановка). Держим на debug, чтобы не путать
    // с настоящими ошибками; всё остальное по-прежнему в warn.
    const msg = String(e && e.message || '');
    if (/closed before the connection was established/i.test(msg)) {
      if (logger.debug) logger.debug(`[ws:${s.name}] ${msg}`);
      return;
    }
    logger.warn(`[ws:${s.name}] error: ${msg}`);
  });

  ws.on('close', (code) => {
    if (authTimer) clearTimeout(authTimer);
    releaseSlot();
    _clearTimers(s);
    const wasAuthed = s.authed;
    s.authed = false;
    s.connecting = false;
    s.ws = null;
    if (wasAuthed) logger.warn(`[ws:${s.name}] закрыт (${code}) — переподключение`);
    _resolveWaiters(s, false);
    _scheduleReconnect(s);
  });
}

// Гарантировать активный авторизованный WS для аккаунта.
//   getToken  — функция, возвращающая текущий access_token.
//   refreshFn — (опц.) async-функция рефреша токена; вызывается перед коннектом, если токен истёк.
// Возвращает Promise<boolean> (true если авторизован в пределах READY_WAIT).
function ensureReady(accountId, getToken, refreshFn) {
  if (accountId == null) return Promise.resolve(false);
  const s = _get(accountId);
  if (getToken) s.getToken = getToken;
  if (refreshFn) s.refreshFn = refreshFn;
  s.closedByUs = false;
  if (s.authed && s.ws && s.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  // запускаем подключение, если ещё нет — НО не в обход уже запланированного backoff-реконнекта:
  // раньше это условие не проверяло s.reconnectTimer, поэтому КАЖДЫЙ запрос от ЛЮБОГО модуля
  // (инвентарь, вордли, рынок, квесты...) для аккаунта с закрытым WS форсировал немедленный
  // _connect() в обход экспоненциального backoff и эскалации HARD_FAIL_BACKOFF_MAX — на мёртвых
  // аккаунтах WS долбился реконнектом каждые ~30с ПОСТОЯННО вместо замедления до раза в 10 минут
  // (десятки одновременных модулей = десятки форсированных reconnect-попыток в минуту).
  if (!s.connecting && !s.reconnectTimer && (!s.ws || s.ws.readyState > WebSocket.OPEN)) _connect(s);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.waiters = s.waiters.filter(w => w.resolve !== resolve);
      resolve(s.authed && s.ws && s.ws.readyState === WebSocket.OPEN);
    }, READY_WAIT);
    s.waiters.push({ resolve, timer });
  });
}

function isReady(accountId) {
  const s = sessions.get(accountId);
  return !!(s && s.authed && s.ws && s.ws.readyState === WebSocket.OPEN);
}

// Реальный статус сессии аккаунта для веб-панели (страница "Аккаунты") — раньше там всегда
// показывалось "Активен" по одному лишь факту наличия токена в БД, даже для протухших/мёртвых
// аккаунтов, т.к. токен из БД не удаляется сам по себе при протухании.
//   'active'    — WS живой и авторизован прямо сейчас
//   'dead'      — HARD_FAIL_THRESHOLD подряд явных отказов авторизации — токен почти наверняка мёртв
//   'connecting'— сессия известна процессу, но WS ещё не авторизован (реконнект/первый коннект)
//   'unknown'   — аккаунт ещё ни разу не трогался в этом запуске бота (нет данных)
function getStatus(accountId) {
  const s = sessions.get(accountId);
  if (!s) return { state: 'unknown' };
  if (s.authed && s.ws && s.ws.readyState === WebSocket.OPEN) return { state: 'active' };
  if ((s.authFailCount || 0) >= HARD_FAIL_THRESHOLD) return { state: 'dead', authFailCount: s.authFailCount };
  return { state: 'connecting' };
}

// Токен/seed обновились (refresh) → переподключаем WS с новыми данными.
function notifyRefreshed(accountId, getToken) {
  const s = sessions.get(accountId);
  if (!s) return;
  if (getToken) s.getToken = getToken;
  s.backoff = BACKOFF_MIN;
  s.dormantLogged = false;
  s.closedByUs = false;
  if (s.ws) {
    try { s.ws.terminate(); } catch (_) {} // close-обработчик сам переподключит с новыми данными
  } else if (!s.connecting) {
    _connect(s); // был «уснувший» (без seed) → будим с новым токеном/seed
  }
}

// Помечает WS этого аккаунта как "дежурный" по курсу GRAM (Башня Сатоши, вариант А) — при
// (пере)авторизации сам пошлёт gram_subscribe, дальнейшие push-тики gram_price идут в cb.
// Ничего не открывает заново — переиспользует уже обязательный для этого аккаунта WS-коннект.
function subscribeGramFeed(accountId, cb) {
  const s = _get(accountId);
  s.gramSubscribe = true;
  s.onGramPrice = cb;
  if (s.authed && s.ws && s.ws.readyState === WebSocket.OPEN) {
    try { s.ws.send(JSON.stringify({ type: 'gram_subscribe' })); } catch (_) {}
  }
}

function setName(accountId, name) { const s = _get(accountId); s.name = name || String(accountId); }

// Сервер ответил "Invalid request signature" по REST, хотя локально WS считается authed —
// значит СЕРВЕР больше не признаёт эту WS-сессию авторизованной (напр. реальный владелец
// аккаунта зашёл в игру параллельно и вытеснил сессию бота своей — сервер держит только одну
// активную сессию на аккаунт; наш WS при этом НЕ закрывается, никакого close-события не будет).
// Раньше бот в этом случае продолжал молча верить в "живую" WS минутами — ошибка каскадом
// сыпалась на все модули этого аккаунта до случайного следующего heartbeat/реконнекта. Форсируем
// реальный реконнект сразу же, как только обнаружили расхождение между нашим и серверным состоянием.
function forceReconnect(accountId) {
  const s = sessions.get(accountId);
  if (!s) return;
  // реконнект уже идёт или запланирован — не дёргаем повторно (иначе пачка 403 от разных модулей
  // одного аккаунта устроит шторм terminate()/reconnect); а также чтобы не оборвать текущий коннект
  if (s.connecting || s.reconnectTimer) return;
  if (s.ws) { try { s.ws.terminate(); } catch (_) {} } // close-обработчик сам вызовет _scheduleReconnect
  else { _connect(s); }
}

function close(accountId) {
  const s = sessions.get(accountId);
  if (!s) return;
  s.closedByUs = true;
  _clearTimers(s);
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  try { if (s.ws) s.ws.close(); } catch (_) {}
  s.ws = null; s.authed = false;
}

function closeAll() { for (const id of [...sessions.keys()]) close(id); }

module.exports = { ensureReady, isReady, getStatus, notifyRefreshed, forceReconnect, setName, close, closeAll, WS_URL, subscribeGramFeed };
