'use strict';
// Запуск фоновых циклов для аккаунта, добавленного УЖЕ на работающем боте.
//
// Зачем: index.js читает список аккаунтов ОДИН раз при старте и там же создаёт для каждого циклы
// (прокачка города, столица, квесты, автоускорители). Аккаунт, добавленный через веб-панель позже,
// не получал ни одного цикла до перезапуска процесса — то есть «улучшения не запускались».
// На моей установке это незаметно (аккаунты давно в базе и бот стартует уже с ними), а на ЛЮБОЙ
// новой установке это ровно первый сценарий: бот поднимается с пустой базой, аккаунт добавляют
// после — и он молчит. Подтверждено чужим логом 19.08.2026:
//   13:30:42 [session] проверка 0 аккаунтов... / No accounts in DB.
//   13:30:52 Web UI: account Great Buffalo added      ← и ни одной строки [progress] дальше
//
// Реестр нужен, чтобы веб-роут не тянул require('../index') (это точка входа со своими побочными
// эффектами): index.js кладёт сюда свой стартер, роут добавления аккаунта его дёргает.
//
// 13.10.2026: та же дырка была у ОБЩИХ циклов (runDailyLoop/wordle/loyalty/profit/capital-collect/
// staking в index.js) — они держали закрытый массив `clients`, построенный ОДИН раз при старте, и
// аккаунт, добавленный позже, был для них невидим навечно (ежедневный вход/фортуна и т.д. molчa не
// выполнялись). Симметрично — удалённый аккаунт из этого массива не убирался: циклы продолжали
// дёргать игру от его имени, хотя страницы (читающие БД напрямую) его уже не показывали. Реестр
// `clients` ниже — единый живой список {api,account} для ВСЕХ общих циклов: index.js кладёт туда
// запись при старте и при добавлении аккаунта, удаление вычищает её сразу же. `stopped` — для
// ДОЛГОЖИВУЩИХ per-account циклов (прокачка города/столицы/квесты/ускорители), которые не ждут
// следующего обхода общего списка, а крутятся вечно сами — им нужен явный флаг "хватит".
const logger = require('./logger');

let starter = null;                    // (account) => Promise<void>, ставит index.js
const started = new Set();             // id аккаунтов, для которых циклы уже подняты
const stopped = new Set();             // id удалённых аккаунтов — долгоживущие циклы проверяют на каждом шаге
const clients = new Map();             // id -> {api,account} — живой список для общих циклов index.js

// index.js регистрирует функцию запуска и сразу отмечает аккаунты, поднятые при старте
function register(fn, accountIds = []) {
  starter = fn;
  for (const id of accountIds) started.add(Number(id));
}

// Поднять циклы для аккаунта. Повторный вызов для того же id ничего не делает — циклы вечные,
// второй комплект означал бы двойные запросы к игре от одного аккаунта.
function startFor(account) {
  if (!starter || !account?.id) return false;
  const id = Number(account.id);
  if (started.has(id)) return false;
  started.add(id);
  stopped.delete(id);                  // аккаунт мог быть удалён и добавлен заново — снимаем флаг
  logger.info(`[${account.name}] запускаю фоновые циклы (аккаунт добавлен на работающем боте)`);
  Promise.resolve(starter(account)).catch(e => {
    started.delete(id);              // не смогли — пусть следующая попытка сможет
    logger.error(`[${account.name}] не удалось запустить циклы: ${e.message}`);
  });
  return true;
}

// аккаунт удалили — забываем, чтобы повторное добавление снова подняло циклы, останавливаем
// долгоживущие per-account циклы и убираем из живого списка общих циклов
function forget(accountId) {
  const id = Number(accountId);
  started.delete(id);
  stopped.add(id);
  clients.delete(id);
}

// долгоживущие while(true)-циклы (cityUpgradeLoop и т.п.) зовут это на каждой итерации
function isStopped(accountId) { return stopped.has(Number(accountId)); }

// общие циклы index.js (daily/wordle/loyalty/profit/capital-collect/staking) — живой список вместо
// закрытого массива, построенного один раз при старте
function setClient(id, client) { clients.set(Number(id), client); }
function listClients() { return [...clients.values()]; }

module.exports = { register, startFor, forget, isStopped, setClient, listClients };
