'use strict';
// Реестр особых зданий аккаунтов (in-memory, общий на процесс: бот + веб).
//
// Сервер игры отвечает 403 «У вас нет здания, необходимого для этого действия», если у аккаунта
// нет здания фичи. Чтобы вообще НЕ слать такие запросы, ApiClient перед запросом спрашивает реестр:
// нужно ли для этого пути здание и есть ли оно у аккаунта. Наличие берётся из /progress/
// (progress.data.buildings[]) и кладётся сюда через setForAccount (см. session.js _saveStats,
// web/lib/api.js apiForAcc).
//
// Семантика known(): пока про аккаунт ничего не знаем (сессия ещё не проверена) — НЕ гейтим,
// чтобы не заблокировать легитимный запрос; если знаем и здания нет — гейтим (запрос не уходит).

const _map = new Map(); // accountId -> Set<'market'|'fortune'|'wisdom'|'reserve'|'satoshi'>

// Префикс пути игрового API → требуемое здание. Пути даём с ведущим '/', как их передают модули.
const RULES = [
  { re: /^\/market\//i,             key: 'market'  },
  { re: /^\/fortune-pavilion\//i,   key: 'fortune' },
  { re: /^\/federal-reserve\//i,    key: 'reserve' },
  { re: /^\/wordle\//i,             key: 'wisdom'  },
  { re: /^\/minesweeper\//i,        key: 'wisdom'  },
  { re: /^\/sudoku\//i,             key: 'wisdom'  },
  { re: /^\/quiz\//i,               key: 'wisdom'  },
  { re: /^\/game2048\//i,           key: 'wisdom'  },
  { re: /^\/satoshi-tower\//i,      key: 'satoshi' },
];

// Какое здание требует путь запроса ('market'|'fortune'|'wisdom'|'reserve') или null.
function needFor(path) {
  const p = String(path || '').split('?')[0];
  for (const r of RULES) if (r.re.test(p)) return r.key;
  return null;
}

// Записать набор зданий аккаунта из CSV ('market,fortune,...'). Пустая строка = «зданий нет» (тоже знание).
function setForAccount(accountId, csv) {
  if (accountId == null) return;
  _map.set(Number(accountId), new Set(String(csv || '').split(',').map(s => s.trim()).filter(Boolean)));
}

// Знаем ли мы состав зданий этого аккаунта (была ли синхронизация из /progress/).
function known(accountId) {
  return _map.has(Number(accountId));
}

// Есть ли у аккаунта здание key.
function has(accountId, key) {
  const s = _map.get(Number(accountId));
  return s ? s.has(key) : false;
}

// Нужно ли блокировать запрос: путь требует здание, про аккаунт мы знаем, и здания нет.
function shouldBlock(accountId, path) {
  if (accountId == null) return null;
  const need = needFor(path);
  if (!need) return null;
  if (!known(accountId)) return null; // ещё не знаем состав — не гейтим
  return has(accountId, need) ? null : need;
}

module.exports = { needFor, setForAccount, known, has, shouldBlock };
