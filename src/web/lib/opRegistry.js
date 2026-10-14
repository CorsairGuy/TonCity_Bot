'use strict';
// Общий (на процесс) реестр сейчас выполняющихся ручных "Обновить"-операций — по образцу
// adsProgress.js/quizProgress.js, но без SSE-подписчиков: нужен только мьютекс с присоединением
// (повторный вызов НЕ запускает операцию заново, а ждёт результата уже идущей) + видимость статуса
// через /api/op-status, чтобы кнопка "Обновить" могла восстановить своё состояние после
// перезагрузки страницы (запрос браузера прерывается, но обработчик на сервере продолжает
// выполняться — Node не отменяет его из-за разрыва соединения).
const running = new Map(); // key -> Promise

function run(key, fn) {
  const existing = running.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); }
    finally { running.delete(key); }
  })();
  running.set(key, p);
  return p;
}

function statusOf(keys) {
  const out = {};
  for (const k of keys) out[k] = running.has(k);
  return out;
}

module.exports = { run, statusOf };
