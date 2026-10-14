'use strict';
// Проверка живости аккаунтов БЕЗ сжигания токенов.
//
// ЗАЧЕМ: сервер игры при каждом /web-auth/refresh РОТИРУЕТ refresh_token (старый становится
// невалидным). Поэтому «проверить» аккаунт = сделать refresh, и если не сохранить новый токен
// обратно в БД — аккаунт сгорит. Этот скрипт делает refresh и СРАЗУ сохраняет ротированный
// access_token + refresh_token в БД, поэтому живые аккаунты не страдают, а мёртвые (401)
// выводятся списком на перелогин.
//
// ВАЖНО: запускать при ОСТАНОВЛЕННОМ боте (иначе бот и скрипт могут одновременно рефрешить
// один токен → гонка → сжигание). Останови контейнер бота: `docker compose stop bot`.
//
// Запуск (с хоста, БД снаружи):   DBHOST=<ip-сервера-БД> DBPORT=3377 node scripts/check-accounts.js
// Запуск внутри контейнера/сети:  node scripts/check-accounts.js   (возьмёт DB_HOST/DB_PORT из env)
const cfg = require('../src/config');
const axios = require('axios');
const { Sequelize, QueryTypes } = require('sequelize');

const DBH = process.env.DBHOST || process.env.DB_HOST || cfg.db.host;
const DBP = Number(process.env.DBPORT || process.env.DB_PORT || cfg.db.port || 3377);
const DELAY_MS = Number(process.env.DELAY_MS || 400); // пауза между аккаунтами, чтобы не долбить сервер
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const seq = new Sequelize(cfg.db.name, cfg.db.user, cfg.db.password, {
    host: DBH, port: DBP, dialect: 'mariadb', logging: false,
    dialectOptions: { connectTimeout: 20000, host: DBH, port: DBP },
  });
  try { await seq.authenticate(); } catch (e) { console.error(`Не удалось подключиться к БД ${DBH}:${DBP} — ${e.message}`); process.exit(1); }

  const accs = await seq.query(
    "SELECT id, name, refresh_token, init_token FROM accs ORDER BY id ASC",
    { type: QueryTypes.SELECT });

  const alive = [], dead = [], noToken = [], unknown = [];
  console.log(`Проверяю ${accs.length} аккаунтов (БД ${DBH}:${DBP}). Ротированные токены сохраняются в БД.\n`);

  for (const a of accs) {
    const tag = `#${a.id} ${a.name}`;
    if (!a.refresh_token) { noToken.push(a); console.log(`  ○ ${tag}: нет refresh_token`); continue; }
    try {
      const r = await axios.post(`${cfg.baseUrl}/web-auth/refresh`, { refresh_token: a.refresh_token },
        { timeout: 20000, headers: { 'content-type': 'application/json', accept: 'application/json' } });
      const b = r.data;
      if (b && b.access_token) {
        // СОХРАНЯЕМ ротированный токен (иначе сожжём при этой же проверке)
        const newRefresh = b.refresh_token || a.refresh_token;
        await seq.query('UPDATE accs SET access_token=?, refresh_token=? WHERE id=?',
          { replacements: [b.access_token, newRefresh, a.id], type: QueryTypes.UPDATE });
        alive.push(a);
        console.log(`  ✔ ${tag}: жив (токен обновлён)`);
      } else {
        unknown.push(a);
        console.log(`  ? ${tag}: странный ответ ${JSON.stringify(b).slice(0, 80)}`);
      }
    } catch (e) {
      const st = e?.response?.status;
      if (st === 401 || st === 403) {
        dead.push(a);
        console.log(`  x ${tag}: МЁРТВ (${st} ${JSON.stringify(e?.response?.data).slice(0, 60)}) — нужен перелогин`);
      } else {
        unknown.push(a); // сеть/таймаут — не трогаем, статус неизвестен
        console.log(`  ? ${tag}: ошибка сети/сервера (${st || e.code || e.message}) — статус неизвестен`);
      }
    }
    await sleep(DELAY_MS);
  }

  await seq.close();

  console.log('\n================= ИТОГ =================');
  console.log(`Живых:            ${alive.length}`);
  console.log(`Мёртвых (401/403):${dead.length}`);
  console.log(`Без токена:       ${noToken.length}`);
  console.log(`Неизвестно (сеть):${unknown.length}`);
  if (dead.length) {
    console.log('\n--- НУЖЕН ПЕРЕЛОГИН (мёртвые refresh_token) ---');
    for (const a of dead) console.log(`  #${a.id}\t${a.name}\t${a.init_token ? '(есть init_token — возможен exchange)' : '(нет init_token — только ручной перелогин)'}`);
  }
  if (unknown.length) {
    console.log('\n--- ПЕРЕПРОВЕРИТЬ (сетевые ошибки) ---');
    for (const a of unknown) console.log(`  #${a.id}\t${a.name}`);
  }
  console.log('\nГотово. Живым аккаунтам токены сохранены — можно запускать бота.');
})();
