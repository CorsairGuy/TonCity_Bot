'use strict';
const logger = require('./logger');

// Имя аккаунта — ИЗМЕНЯЕМЫЙ ключ, по которому во множестве таблиц-снимков хранятся строки
// (позиции/история Башни Сатоши, инвентарь, снапшоты гильдий, лоты рынка, стейкинги, розыгрыши…):
// поле `account` там = account.name (строка), а НЕ стабильный account.id. Поэтому при любом
// переименовании (плейсхолдер account_XXXXXXXX → настоящее имя, ручное переименование, объединение
// дубля) все такие строки «осиротевают»: в UI они висят под старым именем и не привязываются ни к
// одному текущему аккаунту (account_id = null). Открытые позиции могут самоизлечиться при следующем
// синке, но закрытая история и прочие снимки — уже никогда. Единственный надёжный способ — при
// переименовании перенести все ссылки со старого имени на новое во ВСЕХ таблицах, ключуемых по имени.
//
// Автоопределение: берём каждую модель sequelize, у которой есть атрибут `account`, и переносим
// account:oldName → account:newName. Модель Account (ключ `name`, не `account`) сюда не попадает.
// Каждая таблица — в своём try/catch: если у неё UNIQUE(account) и строка newName уже существует
// (крайне редко — только при слиянии дублей), пропускаем её, не роняя перенос остальных.
async function renameAccountRefs(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  let seq;
  try { seq = require('../db/index').seq; } catch (_) { return; }
  if (!seq || !seq.models) return;
  let moved = 0;
  for (const model of Object.values(seq.models)) {
    const attrs = model.rawAttributes || {};
    if (!attrs.account) continue;
    try {
      const [n] = await model.update({ account: newName }, { where: { account: oldName } });
      moved += n || 0;
    } catch (e) {
      logger.warn(`[rename] ${model.name} "${oldName}"→"${newName}": ${e.message}`);
    }
  }
  if (moved) logger.info(`[rename] перенесено строк ${moved} со "${oldName}" на "${newName}"`);
}

module.exports = { renameAccountRefs };
