'use strict';
// Живые обновления карты столицы — та же схема, что и utils/cityLive.js для городов, только ключ
// guild_id вместо account (столица общая на гильдию, см. CapitalSnapshot).
const subscribers = new Map(); // guildId -> Set<Response>

function subscribe(guildId, res) {
  if (!subscribers.has(guildId)) subscribers.set(guildId, new Set());
  subscribers.get(guildId).add(res);
}

function unsubscribe(guildId, res) {
  subscribers.get(guildId)?.delete(res);
}

function broadcast(guildId, buildings) {
  const set = subscribers.get(guildId);
  if (!set || !set.size) return;
  const data = `data: ${JSON.stringify({ buildings })}\n\n`;
  for (const res of set) { try { res.write(data); } catch (_) {} }
}

module.exports = { subscribe, unsubscribe, broadcast };
