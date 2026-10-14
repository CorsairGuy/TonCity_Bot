'use strict';
// Снимок схемы БД: таблицы → колонки и уникальные индексы. Нужен, чтобы сравнивать «боевую» базу
// (в неё многое доставляли руками) с базой, которую код создаёт с нуля — и убирать расхождения.
//
// Запуск:  node scripts/schema-dump.js > /tmp/schema.json
//          DB_NAME=other_db node scripts/schema-dump.js > /tmp/schema-fresh.json
const cfg = require('../src/config');
const { Sequelize } = require('sequelize');

const seq = new Sequelize(cfg.db.name, cfg.db.user, cfg.db.password, {
  host: process.env.DBHOST || cfg.db.host,
  port: Number(process.env.DBPORT || cfg.db.port),
  dialect: 'mariadb',
  logging: false,
});

(async () => {
  const cols = await seq.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY t, c`, { type: Sequelize.QueryTypes.SELECT });
  const idx = await seq.query(
    `SELECT TABLE_NAME t, INDEX_NAME i, COLUMN_NAME c, SEQ_IN_INDEX s, NON_UNIQUE nu
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY t, i, s`, { type: Sequelize.QueryTypes.SELECT });

  const out = {};
  for (const r of cols) {
    out[r.t] = out[r.t] || { columns: {}, unique: [] };
    out[r.t].columns[r.c] = r.ty;
  }
  const byIndex = new Map();
  for (const r of idx) {
    if (Number(r.nu) !== 0) continue;                 // интересуют только уникальные
    const key = `${r.t}|${r.i}`;
    if (!byIndex.has(key)) byIndex.set(key, { t: r.t, cols: [] });
    byIndex.get(key).cols.push(r.c);
  }
  for (const { t, cols: c } of byIndex.values()) {
    out[t] = out[t] || { columns: {}, unique: [] };
    out[t].unique.push(c.join(','));
  }
  for (const t of Object.keys(out)) out[t].unique.sort();

  console.log(JSON.stringify(out, null, 1));
  await seq.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
