'use strict';
// Разовая диагностика: дампит СЫРЫЕ ответы игры для трёх систем, добавленных обновлением
// 06.07.2026, чтобы можно было построить под них страницы (структуру ответа не удалось
// вытащить статическим реверсом бандла — код мини-аппов лениво подгружается в игре).
//
// Безопасно запускать ПРИ РАБОТАЮЩЕМ боте — только GET-запросы, токены не трогает,
// использует ту же сессионную машинерию (ensureSession/WS/подпись), что и сам бот.
//
// Запуск (с хоста, БД снаружи):   DBHOST=<host> DBPORT=<port> node scripts/probe-new-endpoints.js
// Запуск внутри контейнера/сети:  node scripts/probe-new-endpoints.js
const cfg = require('../src/config');
process.env.DB_HOST = process.env.DBHOST || process.env.DB_HOST || cfg.db.host;
process.env.DB_PORT = process.env.DBPORT || process.env.DB_PORT || cfg.db.port;

const { Account, GuildSpecialBuilding, GuildSnapshot } = require('../src/db/index');
const ApiClient = require('../src/api/client');
const { ensureSession } = require('../src/modules/session');

const sep = title => console.log(`\n${'='.repeat(8)} ${title} ${'='.repeat(8)}`);
const dump = (label, v) => console.log(`  ${label}: ${JSON.stringify(v)}`);

async function tryCall(api, label, fn) {
  try {
    const r = await fn();
    dump(`OK ${label}`, r);
    return r;
  } catch (e) {
    dump(`FAIL ${label}`, { status: e.status, message: e.message });
    return null;
  }
}

(async () => {
  // 1. Гильдия, у которой ТОЧНО есть хотя бы одно из новых зданий (иначе получим "нет здания")
  const withBuilding = await GuildSpecialBuilding.findOne({
    where: {}, order: [['updated_at', 'DESC']],
  });
  let guildId = withBuilding?.guild_id || null;
  console.log(`Гильдия для теста: ${guildId || '(не найдена в guild_special_buildings — беру первую попавшуюся с лидером)'}`);

  let leaderRow = guildId
    ? await GuildSnapshot.findOne({ where: { guild_id: guildId, role: 'Leader' } })
    : await GuildSnapshot.findOne({ where: { role: 'Leader' } });
  if (!leaderRow) { console.error('Не нашёл ни одного аккаунта-лидера гильдии в БД — нечем тестировать.'); process.exit(1); }
  guildId = guildId || leaderRow.guild_id;

  const acc = await Account.findOne({ where: { name: leaderRow.account } });
  if (!acc?.access_token) { console.error(`Аккаунт-лидер "${leaderRow.account}" без токена.`); process.exit(1); }

  console.log(`Аккаунт: ${acc.name} (id ${acc.id}), guild_id: ${guildId}`);
  const api = new ApiClient(acc.access_token);
  api.setAccountId(acc.id);
  const { doRefresh } = require('../src/modules/session');
  api.setRefreshFn(() => doRefresh(api, acc));
  const sess = await ensureSession(api, acc);
  if (!sess) { console.error('Не удалось поднять сессию для тестового аккаунта.'); process.exit(1); }

  sep('tech-factory');
  await tryCall(api, 'GET /tech-factory/overview', () => api.get('/tech-factory/overview'));
  await tryCall(api, 'GET /tech-factory/overview?guild_id=', () => api.get(`/tech-factory/overview?guild_id=${guildId}`));

  sep('timeless-auditorium');
  await tryCall(api, 'GET /timeless-auditorium/status', () => api.get('/timeless-auditorium/status'));
  await tryCall(api, 'GET /timeless-auditorium/status?guild_id=', () => api.get(`/timeless-auditorium/status?guild_id=${guildId}`));

  sep('guild-campaigns');
  await tryCall(api, 'GET /guild-campaigns/overview?guild_id=', () => api.get(`/guild-campaigns/overview?guild_id=${guildId}`));

  // ── сапёр: нужен аккаунт со зданием "Оплот Мудрости" (иначе 403 нет здания) — ищем отдельно,
  // тестовый аккаунт-лидер гильдии выше для этого не обязательно подходит.
  sep('minesweeper (структура поля)');
  const wisdomAcc = await Account.findOne({ where: { special_buildings: { [require('sequelize').Op.like]: '%wisdom%' } } });
  if (!wisdomAcc?.access_token) {
    console.log('  Не нашёл аккаунт со зданием "Оплот Мудрости" — пропускаю.');
  } else {
    console.log(`  Аккаунт: ${wisdomAcc.name} (id ${wisdomAcc.id})`);
    const api2 = new ApiClient(wisdomAcc.access_token);
    api2.setAccountId(wisdomAcc.id);
    api2.setRefreshFn(() => doRefresh(api2, wisdomAcc));
    const sess2 = await ensureSession(api2, wisdomAcc);
    if (!sess2) {
      console.log('  Не удалось поднять сессию для этого аккаунта.');
    } else {
      let st = await tryCall(api2, 'GET /minesweeper/ (до)', () => api2.get('/minesweeper/'));
      if (st && !st.field?.squares && st.game_status !== 'won' && st.game_status !== 'lost') {
        // безопасный первый клик — по логике текущего бота мины генерируются ПОСЛЕ первого клика
        st = await tryCall(api2, 'POST /minesweeper/ {x:0,y:0} (первый клик)', () => api2.post('/minesweeper/', { x: 0, y: 0, is_flag: false }));
      }
      await tryCall(api2, 'GET /minesweeper/ (после)', () => api2.get('/minesweeper/'));
    }
  }

  console.log('\nГотово. Пришлите этот вывод целиком — по нему построю страницы/солверы под точную структуру ответа.');
  process.exit(0);
})().catch(e => { console.error('Фатальная ошибка:', e); process.exit(1); });
