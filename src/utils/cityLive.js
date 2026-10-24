'use strict';
// Живые обновления карты города — БЕЗ поллинга: подписчики (SSE-соединения) просто вешаются на уже
// существующие точки записи CitySnapshot (фоновый цикл прокачки modules/progress.js, ручные
// действия web/routes/cityStrategy.js) и получают свежий список построек мгновенно, без единого
// дополнительного запроса к БД/игре сверх того, что и так уже происходило.
const subscribers = new Map(); // account -> Set<Response>

function subscribe(account, res) {
  if (!subscribers.has(account)) subscribers.set(account, new Set());
  subscribers.get(account).add(res);
}

function unsubscribe(account, res) {
  subscribers.get(account)?.delete(res);
}

function broadcast(account, buildings) {
  // общая карта всех городов слушает общий поток событий панели, а не по соединению на город
  try { require('../web/lib/panelEvents').emit('city', { account, buildings }); } catch (_) {}
  const set = subscribers.get(account);
  if (!set || !set.size) return;
  const data = `data: ${JSON.stringify({ buildings })}\n\n`;
  for (const res of set) { try { res.write(data); } catch (_) {} }
}

module.exports = { subscribe, unsubscribe, broadcast };
