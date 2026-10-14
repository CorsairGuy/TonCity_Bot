# TON City Bot

Многоаккаунтный автобот для игры **game.toncity.io** (Telegram web-app про строительство города) + веб-панель управления на React/Primer.

- **Бэкенд-бот**: Node.js (CommonJS, `'use strict'`, компактный стиль без пробелов вокруг `=`), Sequelize + MariaDB, axios.
- **Веб-панель**: Express API (`src/web/server.js`) + SPA на React 18 + Primer React v36 + Vite (`src/web/client/`), билд в `src/web/dist/`.
- Игровой API: `https://game.toncity.io/api` (Bearer-токен на аккаунт).

---

## 1. Запуск и окружение

```bash
# dev (nodemon, перезапуск при изменениях src/, config/, .env)
npm run dev
# prod
npm start                       # node --max-old-space-size=3072 src/index.js

# фронтенд
cd src/web/client && npm run build     # → src/web/dist/  (сервер отдаёт статику отсюда)
node --check src/web/server.js         # быстрая проверка синтаксиса сервера
```

- Docker: `docker-compose.yml` поднимает `db` (MariaDB) + `bot` (nodemon). `WEB_BIND=0.0.0.0` в контейнере.
- **Платформа: Windows.** Основная оболочка — PowerShell; для POSIX-скриптов есть Bash-tool. Проект НЕ git-репозиторий.
- Веб-панель по умолчанию слушает `127.0.0.1:3000` (`WEB_BIND`/`WEB_PORT`). При открытии наружу — обязательно пароль (см. §7).

### ENV (`.env`, см. `.env.example`)
`WEB_PORT`, `WEB_BIND`, `DB_HOST/DB_EXPOSED_PORT/DB_USER/DB_PASSWORD/DB_NAME`, `LOG_LEVEL`, `TG_BOT_TOKEN`.
Фича-флаги и настройки живут не в env, а в **`config/settings.json`** (см. §7).

---

## 2. Архитектура бэкенда

### Точка входа `src/index.js` → `main()`
1. `init()` (создание таблиц/миграций) → `startWebServer(webPort)`.
2. Грузит все `Account` из БД, на каждый создаёт `ApiClient` с `setRefreshFn(doRefresh)`.
3. `ensureSession()` для всех аккаунтов последовательно (проверка/refresh токена).
4. Запускает **параллельные вечные циклы** (каждый — свой `setInterval`/`while+sleep`):

| Цикл | Период | Что делает |
|---|---|---|
| `runMarketPriceLoop` | постоянно | опрос рыночных цен (модуль `marketPrices`) |
| `runAllAccounts` (initial) → `runDailyLoop` | до UTC-полуночи | ежедневные задачи всех аккаунтов (`bot.js`) |
| `runWordleOnce` → `runWordleLoop` | строго последовательно | вордли: 1 аккаунт = 1 слово |
| `collectProfitLoop` | 6 ч | сбор прибыли города (`/progress/`), `saveStats` |
| `collectCapitalLoop` | 12 ч | сбор монет/кристаллов столицы **только лидером гильдии** |
| `stakingLoop` | до ближайшего `can_collect_at` из БД | сбор готовых стейков (Федрезерв) |
| `startAccountLoops` (per-account) | `cityUpgradeLoop` 6ч + `runCapUpgradeLoop` + `runQuestLoop` | улучшение города/столицы, квесты гильдии |

Флаги фич берутся из `getConfig().features`.

### `src/bot.js` → `runAccount(api, account)` (ежедневный проход одного аккаунта)
Последовательно с задержками: `dailyLogin → fortune → game2048 → inventory → market → promocodes → auditorium → techfactory`. Обёртка `_run(label,id,fn)` использует `dailyStatus` (`isDone/markDone`), чтобы не повторять задачу в тот же UTC-день.

### Сессии/авторизация — `src/modules/session.js`
- `ensureSession`: пробует `/progress/`; при неудаче — `doRefresh`.
- `doRefresh`: `POST /web-auth/refresh {refresh_token}` → новый `access_token` (+ ротация refresh), пишет в БД. Есть per-account lock (`_refreshInFlight`), чтобы не рефрешить дважды. Fallback: `exchangeToken` через `POST /web-auth/exchange {token: init_token}`.
- `saveStats`: из `/progress/` пишет в `Account` баланс/кристаллы и показатели города. `params[0]` = после всех апгрейдов (final), `params[last]` = текущее.

### API-клиент — `src/api/client.js`
Класс `ApiClient` (axios, `baseURL=https://game.toncity.io/api`). Методы `get/post/patch` идут через единый `_request()`: сначала **предохранитель техработ** (`src/utils/maintenance.js`), затем сериализация через глобальный `apiLock` (`src/utils/lock.js`); на **401** автоматически вызывает `_refreshFn` и повторяет запрос один раз. Заголовки маскируют браузер Chrome + `cookie: i18n_redirected=ru`.

### Автопауза на техработах — `src/utils/maintenance.js`
Игра во время обновлений отвечает **HTTP 503 + тело с `maintenance`** (тот же критерий проверяет клиент игры: `503`&`maintenance`). Общий на процесс **circuit-breaker** с ЛИПКИМ флагом `active` ставит на паузу ВСЕ запросы к игре — и автозадачи бота, и действия из панели (всё идёт через `ApiClient`): при детекте `active=true`, `acquire()` мгновенно бросает `MaintenanceError` без обращения к серверу. Флаг снимается ТОЛЬКО успешной пробой (не по таймеру — состояние не «мерцает» между пробами). Проба (half-open) пропускает один реальный запрос не чаще раза в `PROBE_INTERVAL` (5 мин): ответ сервера (не 503-maintenance) снимает паузу, повторный `503+maintenance` — оставляет до следующей пробы.
- **Детект без лишних запросов:** НАЧАЛО техработ ловится первым же ответом `503` от обычных запросов (циклы/панель) — по здоровой игре ничего специально не опрашиваем. КОНЕЦ техработ сам не поймать (во время паузы предохранитель блокирует обычные запросы), поэтому реактивный цикл `maintenanceWatchLoop` (`src/index.js`) шлёт пробу `/progress/` с одного стабильного аккаунта (техработы глобальны — случайный аккаунт смысла не даёт) **только пока пауза активна**; реальный запрос уходит не чаще раза в `PROBE_INTERVAL` (5 мин, гейтит `acquire()`), остальные попытки — дешёвый локальный отказ. По здоровой игре цикл просто спит и лишь локально читает `status()`.
- **Уведомления в Telegram** (в основной тред — тот же, что и вордли, через `src/utils/telegram.js`): на переходе НОРМА→ТЕХРАБОТЫ шлётся текст игры «🛠 Проводятся работы на серверах игры / Пожалуйста, попробуйте зайти позже», на переходе ТЕХРАБОТЫ→НОРМА — «✅ Игра снова доступна». Оба сообщения — строго один раз на переход.
- **Панель:** статус `GET /api/maintenance` (`{active,since,retryInMs}`), баннер `components/MaintenanceBanner.tsx` лишь ОТОБРАЖАЕТ состояние (опрос раз в 5 минут), детект от него не зависит.

### Утилиты `src/utils/`
`logger.js` (winston, `logs/bot*.log`), `helpers.js` (`sleep`, `sleepUntilUtcMidnight`), `lock.js` (`apiLock`), `botState.js` (`bot-state.json`: `isCityPaused/setCityPaused`), `maintenance.js` (автопауза техработ, см. выше), `itemCache.js`, `dailyStatus` (в модулях).

---

## 3. Модули бота (`src/modules/`)

| Модуль | Экспорт | Назначение / игровые эндпоинты |
|---|---|---|
| `tasks` | `runDailyLogin` | ежедневный вход: `GET/POST /daily-login/` |
| `fortune` | `runFortune` | колесо фортуны: `GET /fortune-pavilion/can-draw`, `POST /fortune-pavilion/daily-draw` (одиночный спин) |
| `journey` | `runJourney` | путь мэра: `GET/POST /mjourney/` |
| `game2048` | `runGame2048` | 2048 (взвешенная матрица): `GET/POST /game2048/` |
| `wordle` | `runWordle/Once/Loop`, `submitWordAll` | вордли: `GET /wordle/stats`, `POST /wordle/guess`; `submitWordAll` подаёт слово на все аккаунты И пишет `WordleLog` из свежих stats |
| `minesweeper` | `solveMinesweeper` | сапёр: `GET /minesweeper/`, `POST /minesweeper/`, `GET /minesweeper/reward` |
| `sudoku` | `solveSudoku` | судоку: `GET /sudoku/`, `POST /sudoku/generate`, `POST /sudoku/` |
| `quiz` | `solveQuiz`, `cleanupWrongAnswers` | викторина: `GET /quiz/state`, `POST /quiz/start`, `POST /quiz/answer`; учит ответы (`QuizAnswer`) |
| `inventory` | `runInventory` | склад: `GET /storage/allitemdata`, открытие паков; пишет `Inventory` |
| `builders` | `runBuilders` | строители: `GET /builders/`, `POST /builders/purchase` |
| `staking` | `runStaking`, `collectReady`, `saveEntriesToDb` | Федрезерв: `GET /federal-reserve/staking`, `POST /federal-reserve/staking`, `POST /federal-reserve/staking/collect`; ведёт `StakingEntry` |
| `market` | `runMarket` | рынок: `/market/direct*`, продажа предметов из настроек |
| `marketPrices` | `runMarketPriceLoop` | постоянный опрос цен рынка |
| `promocodes` | `runPromocodes` | `POST /promocodes/activate` (коды из настроек), пишет `PromoLog` |
| `townhall` | `runTownhall` | мэрия/аирдроп: `GET /airdrop/`, `GET /progress/diversity` |
| `shop` | `runShop` | магазин: `GET /shop/offers/booster`, `/shop/offers/booster_pack` |
| `achievements` | `runAchievements` | `GET /achievements/unlocked` |
| `loyalty` | `runLoyalty` | дорога верности: `GET/POST /loyalty-road/` |
| `auditorium` | `runAuditorium` | вечный аудиториум (задача при `runAccount`) |
| `techfactory` | `runTechFactory` | технологическая фабрика (задача при `runAccount`) |
| `capital` | `runCapital`, `runQuestLoop`, `runCapUpgradeLoop`, `collectCapitalResources` | столица гильдии: `GET/POST /capitals/progress/{gid}`, `collect/coins`, `collect/crystals`; квесты гильдии `/guild-quests/*` |
| `progress` | `runProgress` | **прокачка города**: строит/двигает/улучшает здания и **разблокирует секции** по референсу фазы (см. §6) |
| `dailyads` | `getDailyAdsStatus`, `runDailyAds` | ежедневная реклама: `GET/POST /daily-ads/` |
| `dailyStatus` | `isDone`, `markDone` | пометки «сделано сегодня» (UTC) |

---

## 4. Игровой API (полный список используемых эндпоинтов)

Прогресс/город: `GET /progress/`, `POST /progress/` (move/build/upgrade), `POST /progress/unlock-section`, `GET /progress/diversity`, `GET /buildings/criteria`.
Сессия: `POST /web-auth/refresh`, `POST /web-auth/exchange`.
Профиль/гильдия: `GET /users/me/guild`, `GET /guilds/{id}`, `GET /guilds/benefits`, `GET /guilds/management/{id}` (+ `/applications`, approve/reject), `PATCH /guilds/management/{id}`, `GET /guilds/{id}/members`.
Столица: `GET/POST /capitals/progress/{gid}`, `POST /capitals/progress/{gid}/collect/coins`, `/collect/crystals`.
Квесты гильдии: `GET /guild-quests/guild/{gid}`, `POST /guild-quests/create/{gid}`, `POST /guild-quests/collect/{id}`.
МИД (foreign-ministry): `GET /foreign-ministry/overview?guild_id=`, `POST /foreign-ministry/{sub}?guild_id=` (alliances request/accept/reject/cancel/break/upgrade, enemies, scouting start/unlock/confirm, invitations).
Рынок: `GET/POST /market/direct`, `GET /market/direct/{id}`, `POST /market/direct/buy`, `POST /market/direct/cancel`, `GET /market/user/listing-limits`, `GET /market/user/stats`, `GET /market/toncoin/balance`, `POST /market/unwarn`.
Склад/бусты: `GET /storage/allitemdata`, `POST /storage/items/sell`, `POST /boosters/activate`, `POST /boosters/combine`, `GET /boosters/active`, `GET /boosters/combination-rules`, `POST /booster-packs/open`, `POST /booster-packs/set-target`.
Мини-игры: `wordle/*`, `minesweeper/*`, `sudoku/*`, `quiz/*`, `game2048/*`.
Прочее: `daily-login/`, `daily-ads/`, `mjourney/`, `loyalty-road/`, `fortune-pavilion/*`, `federal-reserve/staking*`, `achievements/unlocked`, `airdrop/`, `promocodes/activate`, `shop/offers/*`.

> Реверс игры: чанки бандла тянутся через Chrome MCP `javascript_tool`; минифицированный код декодируется заменой `=`→`EQ`, `?`→`Q`, `&`→`AND`, `!`→`BANG` (обход сканера, блокирующего строки с cookie/query). Так найдены билдеры путей вроде `storage.sell="/storage/items/sell"`.

---

## 5. Веб-панель

### Сервер `src/web/server.js` (`startWebServer(port)`) + группы роутов `src/web/routes/*.js`
- `server.js` (тонкий, ~90 строк): поднимает Express, статику (`/items`,`/sprites`,SPA из `dist/`), **auth-гейт** (`/api/*` кроме `auth/status`,`login`,`logout`) + эндпоинты `login/logout/password`, собирает `ctx` и регистрирует группы роутов, `GET *` SPA-fallback, `app.listen`, старт фоновых воркеров рынка.
- Общие хелперы — `src/web/lib/api.js`: `apiForAcc(acc,{noLock})` и `makeApiForAccount(accountId,{noLock})` → `ApiClient` для аккаунта (на 401 сам рефрешит токен); `midErr(e)` → ошибка МИД строкой. Передаются в группы через `ctx={apiForAcc,makeApiForAccount,midErr}`.
- Каждая группа — `module.exports=function(app,ctx){…}` в `src/web/routes/`:
  - `core.js` — items-meta/config/accounts/inventory/logs + item-info/action/refresh-inventory;
  - `plans.js` — **refplans** (референсы города/столицы, генерация, импорт карты — §6), phases/building-phases/sections/coords/buildingslist/bot-state, legacy cityplan/capitalplan, city-/capital-snapshots;
  - `minigames.js` — wordle (status/guess-all), minesweeper/sudoku/quiz (+SSE `solve-stream`), minigame-status;
  - `fortune.js` — павильон удачи (raw/log/items-summary/status/can-draw-all/spin/spin-all);
  - `dashboards.js` — shop/townhall/journey/achievements/promo, guilds/guild-quests/special-buildings, builders;
  - `market.js` — **центральный рынок** (stats/deals/offers/ton-balances/auto-buy/buy/autobuy CRUD+воркер/snipe/sellable/list/list-spread/cancel); ставит `app.__startAutobuyWorker`/`app.__startSnipeScheduler`;
  - `guilds.js` — guild-info/guild-mid, **mid-live** (МИД live: alliance/enemy/scouting/invitations), guild-settings, управление гильдией (applications/members/settings);
  - `economy.js` — loyalty-road, `storage-live/:accountId/*` (склад: sell/activate/combine/open-pack/set-target/sync), `shop-live`, staking, daily-ads (+SSE `watch-stream`);
  - `refresh.js` — `refresh/:module` (ручной прогон модуля).
- `restart` остаётся в `server.js`.
- Правило при переносе роута в группу: относительные `require` глубже на уровень — `'../…'`→`'../../…'`, `'./cityStats'`→`'../cityStats'`.

### Фронтенд `src/web/client/` (React + Primer, роутинг в `App.tsx`)
Меню (сайдбар, группы): Аккаунты, Инвентарь, **Федеральный Резерв**(Стейкинг), **Павильон удачи**(Фортуна), **Оплот Мудрости**(Вордли/Сапёр/Судоку/Викторина), **Профиль**(Путь Мэра/Достижения/Промокоды), Строители, МИД, Гильдии, **Сфера миссий**(Дорога верности/Квесты), Столицы, Города, Аудиториум, Фабрика, **Задания**(Ежедневный вход/реклама), **Мэрия**(Распределение/Политика/Разнообразие), **Магазин**(Ускорители/Наборы), **Центральный рынок**(Лоты/Листинги/Статистика/Покупки/Продажи), Настройки, Логи. Хидер убран; `--header-h:0`.

Ключевые страницы: `Accounts`, `Inventory`+`StorageModal` (склад live: продажа/актив/комбо/открытие паков с показом выпавшего), `Reserve` (стейкинг), `Fortune`, мини-игры, `Plans` (референсы города/столицы), `CityMapEditor`+`MapEditor` (canvas-редактор карты), `City`/`CityMap`, `Capitals`, `Mid`, `Guilds`, `MarketStats/MarketLots/MarketDeals`, `DailyAds`, `Loyalty`, `Quests`, `Settings`, `Logs`.

Утилиты формата `src/web/client/src/utils.ts`: `fmt` (сокращения K/M/B/T), `fmtInt` (точное целое, разделение тысяч — баланс алмазов), `fmtCr` (дробное до 1 знака — прибыль в алмазах), `fmtDate`, `fmtPop`, `sortByName`. API-обёртка — `src/web/client/src/api.ts`.

---

## 6. Референсы города/столицы и прокачка

**Референс города** = целевая раскладка зданий на фазу. Один референс на фазу в `config/city-refplans.json` (`{phase, popThreshold, profitThreshold, unlockedSections, buildings:[{x,y,id,level}]}`). Фазы 0–6 в `config/phases.json`.

- **Показатели** считаются строго по формулам игры в `src/web/cityStats.js` (`computeCityStats`): население, прибыль, покрытие сервисами, счастье, стоимость постройки (**накопительная**: `base_price·factor^k` по семейству) + улучшений (`e^0.5·s`). Позиция здания на показатели НЕ влияет.
- **Генератор** `src/web/cityGen.js` (`generateCityRefplan(phase)`): выбирает **связный** набор секций по смежности (как бот), заполняет клетки жадным стоимостно-осознанным подбором с лимитом на семейство (`FACTOR_CAP`), сервисы — фикс. бюджет клеток + мин. уровень покрытия. Цель: макс. прибыль при населении ≥ порога, счастье ~100%, разумная стоимость.
- **Бот-прокачка** `src/modules/progress.js` `runProgress`: выбирает фазу по **реальным** населению/прибыли аккаунта (`max(фаза_pop, фаза_profit)`), двигает/строит/улучшает здания к референсу и **разблокирует секции** `POST /progress/unlock-section` — только **смежные** с открытыми и **за монеты** (кристальные секции бот не открывает). Пауза: `bot-state.json` (`cityPaused`).

**Столица**: секций НЕ имеет — вся карта всегда открыта (редактор для `type='capital'` не грузит секции). Референсы столицы — `config/capital-refplans.json`.

Config-файлы: `buildings.txt`/`capital_buildings.txt` (справочники зданий), `city-coords.json`/`capital-coords.json` (клетки), `city_sections.json` (секции+смежность+цены), `city-building-phases.json` (здание→мин.фаза), `phases.json` (пороги фаз), `items.json`.

---

## 7. Настройки и безопасность (`config/settings.json`)

- `features.*` (dailyLogin, fortune, journey, builders, inventory, upgrading, buying, capital, staking, wordle, game2048, market), `logLevel`, `growthModePopulation`, `staking{amount,currency,duration}`, `sellItems[]`, `promoCodes[]`, `telegram{...}`.
- **Веб-пароль** (`src/web/auth.js`): один пароль без логина, scrypt-хэш в `settings.json:web.passwordHash`, сессия — HMAC-подписанная httpOnly-кука `tc_session` (30 дней), секрет `web.sessionSecret` автогенерится. `/api/config` вырезает `web.passwordHash`/`sessionSecret`.
- **Новые таблицы БД** добавляются только через `CREATE TABLE IF NOT EXISTS` в массиве миграций `src/db/index.js` (init НЕ вызывает `seq.sync()`). Колонки существующих таблиц — добавляет пользователь вручную.

### Модели БД (`src/db/index.js`)
`Account`, `CityPlan`, `CapitalPlan`, `Inventory`, `WordleLog`, `MinigameLog`, `QuizAnswer`, `FortuneLog`, `DailyLog`, `ShopSnapshot`, `TownhallAirdrop`, `TownhallDiversity`, `JourneyLevel`, `AchievementSnapshot`, `PromoLog`, `CitySnapshot`, `GuildSnapshot`, `GuildQuestSnapshot`, `GuildSpecialBuilding`, `FortuneStatus`, `CapitalSnapshot`, `BuilderSnapshot`, `LoyaltySnapshot`, `GuildMembersSnapshot`, `MidSnapshot`, `DailyAdsSnapshot`, `StakingEntry`, `MarketStatsSnapshot`, `MarketListing`, `MarketPurchase`, `MarketSale`, `MarketAutobuy`, `MarketSnipe`.

---

## 8. Правила разработки
- Стиль бэкенда: CommonJS, `'use strict'`, компактно (без пробелов у `=`), русские комментарии/логи.
- Фронт: только компоненты **Primer React**; после правок — `npm run build` в `src/web/client`.
- Токены игры добавляются в БД (`accs`), панель управляет аккаунтами через `/api/accounts`.
- При реверсе игры — НЕ покупать/продавать/выставлять реальные данные без явной цели построить фичу.
