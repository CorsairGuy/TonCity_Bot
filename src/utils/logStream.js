'use strict';
// Живой хвост логов (SSE) — без поллинга и без чтения диска: транслирует строку в момент самой
// записи лога (см. logger.js BroadcastTransport), процесс-level реестр подписчиков.
const subscribers = new Set();

function subscribe(res) { subscribers.add(res); }
function unsubscribe(res) { subscribers.delete(res); }

function broadcast(line) {
  const data = `data: ${JSON.stringify({ line })}\n\n`;
  for (const res of subscribers) { try { res.write(data); } catch (_) {} }
}

module.exports = { subscribe, unsubscribe, broadcast };
