'use strict';
// Кто из аккаунтов реально может торговать на Центральном рынке.
//
// Игра ограничивает рынок за «подозрительную активность» (в баннере прямым текстом: координация
// нескольких аккаунтов, искусственные сделки для перегона валюты между своими). Признак приходит
// в ЛЮБОМ ответе `/market/offers`: `is_frozen` — доступ закрыт совсем, `is_warned` — предупреждение,
// игра держит баннер, пока его не примут (POST /market/unwarn). Поля сверены с бандлом
// (chunks/central_market-*: `g.is_frozen!==void 0&&(S.value=g.is_frozen)`) и с живыми ответами.
//
// Отсюда правило: аккаунт с frozen/warned не показываем в выборе для покупки/ставки/оффера/
// автоскупки и не берём как источник витрины — запрос всё равно вернёт баннер вместо лотов.
//
// Флаги пишем ПОПУТНО, из ответов, которые и так запрашиваем: отдельный опрос нужен только для
// кнопки «Проверить рынок» (refresh ниже).
const logger = require('../../utils/logger');

const REFRESH_CONCURRENCY = 4;

// Запомнить состояние из ответа /market/offers. resp без флагов (старый эндпоинт, ошибка) — игнор.
async function record(accountName, resp) {
  if (!accountName || !resp || (resp.is_frozen === undefined && resp.is_warned === undefined)) return null;
  const { MarketAccess } = require('../../db/index');
  const row = {
    account: accountName,
    frozen: resp.is_frozen ? 1 : 0,
    warned: resp.is_warned ? 1 : 0,
    checked_at: new Date(),
  };
  try {
    await MarketAccess.upsert(row, { conflictFields: ['account'] });
    if (row.frozen || row.warned) logger.info(`[${accountName}] [market] доступ ограничен: ${row.frozen ? 'заморожен' : 'предупреждение'}`);
  } catch (e) { logger.warn(`[${accountName}] [market] не удалось сохранить статус рынка: ${e.message}`); }
  return row;
}

// Все известные статусы: account -> {frozen,warned,checked_at}
async function map() {
  const { MarketAccess } = require('../../db/index');
  const rows = await MarketAccess.findAll({ raw: true }).catch(() => []);
  return new Map(rows.map(r => [r.account, { frozen: !!r.frozen, warned: !!r.warned, checked_at: r.checked_at }]));
}

// Может ли аккаунт торговать: нужно здание Центрального рынка И отсутствие ограничения.
// Пока про аккаунт ничего не знаем (ни разу не проверяли) — считаем рабочим, чтобы не прятать
// аккаунты на чистой установке; первая же выборка витрины проставит настоящий статус.
function usable(acc, statuses) {
  if (!String(acc?.special_buildings || '').split(',').includes('market')) return false;
  const st = statuses.get(acc.name);
  return !st || (!st.frozen && !st.warned);
}

// Опросить аккаунты и обновить статусы. Лёгкий запрос (одна страница витрины) — он же и есть
// носитель флагов. Пул небольшой: рынок и так отвечает медленно, а параллелизмом мы игру уже роняли.
async function refresh(makeApiForAccount, onlyIds = null) {
  const { Account } = require('../../db/index');
  const all = await Account.findAll({ order: [['id', 'ASC']] });
  const list = all.filter(a =>
    a.access_token && a.access_token !== 'placeholder' &&
    String(a.special_buildings || '').split(',').includes('market') &&
    (!onlyIds || onlyIds.includes(a.id)));
  const out = [];
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const acc = queue.shift();
      try {
        const api = await makeApiForAccount(acc.id, { noLock: true });
        const d = await api.get('/market/offers?page=1&page_size=1&sort=ends_at');
        const st = await record(acc.name, d);
        out.push({ id: acc.id, name: acc.name, frozen: !!st?.frozen, warned: !!st?.warned });
      } catch (e) {
        // сетевая ошибка/протухшая сессия — это НЕ ограничение рынка, статус не трогаем
        out.push({ id: acc.id, name: acc.name, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
  const frozen = out.filter(x => x.frozen).length, warned = out.filter(x => x.warned).length;
  logger.info(`[market] проверка доступа: ${out.length} аккаунтов, заморожено ${frozen}, с предупреждением ${warned}, ошибок ${out.filter(x => x.error).length}`);
  return out;
}

module.exports = { record, map, usable, refresh };
