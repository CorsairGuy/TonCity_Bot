# CLAUDE.md — заметки для Claude о проекте TON City Bot

Этот файл читает Claude перед работой с репозиторием. Здесь то, что нельзя быстро понять из кода: устройство, договорённости, подводные камни. Описание для людей — в [README.md](README.md), история изменений — в [CHANGELOG.md](CHANGELOG.md).

## 0. Коротко о главном

- Многоаккаунтный бот для **game.toncity.io** + веб-панель управления. Отвечать пользователю **по-русски**.
- **Бэкенд**: Node.js 22, CommonJS, `'use strict'`, компактный стиль без пробелов вокруг `=`, русские комментарии и логи. Express, Sequelize + MariaDB 10.11, axios, winston, `ws`.
- **Фронтенд**: React 18 + **Primer React v36** (`@primer/react`, `@primer/css`, styled-components 5) + Vite 6 + TypeScript, react-router-dom 6, lightweight-charts, overlayscrollbars, PWA (`vite-plugin-pwa`). Исходники в `src/web/client/`, сборка в `src/web/dist/` (в git не хранится).
- **Интерфейс — только компоненты Primer React.** После правок фронта: `cd src/web/client && npm run build` (это `tsc && vite build`, ошибки типов ломают сборку).
- Игровой API: `https://game.toncity.io/api`, Bearer-токен на аккаунт, **обязательны подпись запросов и живой WebSocket** (см. §2).
- Бот и веб-сервер — **один процесс** (`src/index.js`), общие состояние, `apiLock` и WS-соединения.
- **Журнал изменений:** после каждой законченной работы дописывай запись в `CHANGELOG.md` (формат — в начале того файла). Одна дата — один заголовок `## ГГГГ-ММ-ДД`: если раздел с сегодняшней датой уже есть, дописывай в него, а перед этим перечитай его и оставь только актуальное (отменённое и переделанное за день убирай или переписывай).

### Секреты
Никогда не коммитить и не переносить в файлы: `.env`, `config/settings.json` (токен Telegram-бота, chat id, хэш пароля и секрет сессии панели), `config/bot-state.json`, `db_data/`, логи, токены аккаунтов, `TONCITYQUESTS_BOT_HASH`. Всё это уже в `.gitignore`/`.dockerignore`. Секреты берутся только из `.env` или `settings.json`. Старый `BOT_HASH` от toncityquests.ru остался в истории `main` (коммит `349bc8a`), его нужно перевыпустить.

## 1. Запуск и окружение

```bash
npm run dev                            # node --watch: перезапуск при правках подключённых модулей (иконки, dist, config/ и .env не следит)
npm start                              # node --max-old-space-size=3072 src/index.js
cd src/web/client && npm run build     # фронт → src/web/dist/ (сервер отдаёт статику отсюда)
cd src/web/client && npm run dev       # vite dev-сервер, проксирует /api, /sprites, /items на :3000
node --check src/web/server.js         # быстрая проверка синтаксиса
docker compose up -d                   # db (MariaDB) + bot (образ из GHCR) + updater
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build db bot   # разработка: ./src с хоста + node --watch
```

- **Docker и обновления (с 14.10.2026):** `docker-compose.yml` поднимает `db`, `bot` и `updater`. `bot` — **готовый образ** `ghcr.io/corsairguy/toncity_bot:${BOT_TAG:-latest}`, его собирает `.github/workflows/docker.yml` на каждый push в ветку (кроме `claude/**`) и на тег `v*` (код, `node_modules` и собранный фронт внутри, коммит в `APP_COMMIT`, ветка/версия в `APP_REF`). Теги: имя ветки (`main`=`latest`), релиз `vX.Y`→`X.Y` (+`stable`, если не пре-релиз), `sha-<коммит>`, `updater` (обновлятель, только из `main`). С хоста в `bot` подключены только `./config` и `./logs`; иконки предметов, которые бот докачивает в `src/items`, живут внутри контейнера и после обновления докачиваются заново. Справочники из `config/` лежат копией в образе (`/app/config-defaults`) и при старте докладываются в `config/` только если файла там нет — **изменённый в git справочник на сервер сам не приедет**, его нужно скопировать вручную. Бот запускается через `exec node` под `init: true` (tini пробрасывает SIGTERM → `gracefulShutdown`).
  - **Канал обновлений (с 14.10.2026, вместо Watchtower):** Настройки → Обновления (`components/UpdatesCard.tsx`). Канал = тег образа `BOT_TAG` в `.env`: ветка, `stable` или закреплённая версия (`X.Y`/`sha-…`). Переключает сервис `updater` (`updater/updater.sh`, образ `:updater`): бот пишет заявку `config/updater/request.json` (`utils/selfUpdate.js`, `POST /api/update {tag?,force?}`), обновлятель делает `docker compose pull bot` → `BOT_TAG` в `.env` → `up -d --no-deps bot` с файлами и папкой из меток `com.docker.compose.*` бота (папка проекта смонтирована в `/project`, по хостовому пути — симлинк), итог в `status.json`, жив ли — `heartbeat.json`. Оборванный запрос панели = бот перезапускается; панель ждёт смены `startedAt`. Автообновление решает бот (`utils/autoUpdate.js`, раз в 10 мин, `settings.update.auto`, только плавающие каналы, только при собранном образе и без операций `opRegistry`). История запущенных версий для отката — `config/updater/history.json`. В режиме разработки (`docker-compose.dev.yml`) переключение отказывает.
  - Проверка версии — `utils/versionCheck.js` + `GET /api/version` (публичный GitHub API без токена, кэш 30 мин, ручная проверка `?force=1` идёт на GitHub всегда, кроме повтора в пределах 10 с — тогда ответ с `cached:true`: ветки, релизы с описанием, голова канала, статус сборки образа в Actions) и плашка `components/VersionBadge.tsx` внизу меню.
  - **Portainer** — `docker-compose.portainer.yml` + раздел «Portainer» в `README.md` (14.10.2026): абсолютные пути от `DATA_DIR`, переменные из Portainer вместо `env_file`, `updater` при заданных `PORTAINER_URL`/`PORTAINER_TOKEN` меняет `BOT_TAG` стека и передеплоит его через API Portainer (`PUT /stacks/{id}` или `/git/redeploy`, `pullImage:true`), а не зовёт `docker compose`.
  - **Режим разработки** — `docker-compose.dev.yml`: локальная сборка, `./src`/`.git` с хоста, `node --watch`, фронт собирать на хосте. nodemon из проекта убран (14.10.2026).
  - В контейнере `WEB_BIND=0.0.0.0`, порт `${WEB_PORT}:${WEB_PORT}`. Имена контейнеров — `${STACK_NAME}_db`/`_bot`/`_updater` (несколько копий на хосте — разные `STACK_NAME`/порты).
- **Машина пользователя: Windows**, основная оболочка PowerShell. Рабочая папка `Z:\DOCKER\toncity_bot` (до 13.10.2026 — `X:\toncity_bot`) — это **сетевой диск, смонтированная папка `/DOCKER/toncity_bot` на боевом сервере** (Debian, Docker). До перехода сервера на образ из GHCR правка `src/` там = правка прода (~60 аккаунтов, применяется `docker compose restart bot`); после перехода код прода живёт только в образе, правки на Z: на работающего бота не влияют — всё через git → `main` → сборка → «Обновить». `config/` и логи `logs/bot*.log` по-прежнему там, боевые. С 14.10.2026 проект в git: https://github.com/CorsairGuy/TonCity_Bot.
- **Время в логах — UTC** (в контейнере нет TZ), пользователь называет местное время GMT+5.
- Изменения `docker-compose.yml` применяются только `docker compose down && docker compose up -d` (не `restart`). Новые npm-зависимости бэкенда приезжают с новым образом (`node_modules` внутри образа); в режиме разработки — `--build`.
- Панель по умолчанию слушает `127.0.0.1:3000` (`WEB_BIND`/`WEB_PORT`). Наружу — только с паролем (§7).

### ENV (`.env`, см. `.env.example`)
`WEB_PORT`, `WEB_BIND`, `DB_HOST/DB_EXPOSED_PORT/DB_USER/DB_PASSWORD/DB_NAME`, `STACK_NAME`, `TONCITYQUESTS_BOT_HASH` (пусто — отправка гильд-квестов на toncityquests.ru выключена), `LOG_LEVEL`.
Фича-флаги и прочие настройки живут не в env, а в **`config/settings.json`** (дефолты — `DEFAULTS` в `src/config.js`, редактируются на странице «Настройки»).

### Скрипты `scripts/`
- `check-accounts.js` — проверка живости аккаунтов через refresh с сохранением ротированных токенов. Запускать **только при остановленном боте** (`docker compose stop bot`), иначе гонка рефрешей сожжёт токены.
- `schema-dump.js` — снимок схемы БД (сравнить боевую базу с базой «с нуля»).
- `probe-new-endpoints.js` — дамп сырых ответов новых систем игры (только GET, можно при работающем боте).
- `download-sprites.js` — выкачка спрайтов карты.

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

**С обновления игры 06.07.2026 без двух вещей запросы не проходят:**
- **Подпись запросов** (`src/utils/reqSign.js` + `reqChallenge.wasm`): на каждый `/api/*` заголовки `X-Req-Token/X-Req-Ts/X-Req-Nonce`, считаются WASM-модулем из клиента игры по `session_seed` (приходит в ответе `/web-auth/exchange` и `/web-auth/refresh`, хранится per-account). Пока seed нет, подпись не ставится, поэтому первый exchange/refresh идёт без неё.
- **Живой WebSocket на аккаунт** (`src/utils/wsSession.js`, `wss://game.toncity.io/ws`): без авторизованного WS сервер отвечает 403 `Direct API access is not allowed`. Хендшейк `{type:'jwt_auth',data:<access_token>,req_token,req_ts,req_nonce}`, ping раз в 25 с, реконнект с backoff. Если пакета `ws` нет — запасной `miniWs.js`.

**Refresh-токен ротируется** при каждом `/web-auth/refresh`: новый токен нужно сразу сохранить в БД, иначе аккаунт «сгорит». Два одновременных рефреша одного аккаунта (бот + скрипт) сжигают токен.

### Автопауза на техработах — `src/utils/maintenance.js`
Игра во время обновлений отвечает **HTTP 503 + тело с `maintenance`** (тот же критерий проверяет клиент игры: `503`&`maintenance`). Общий на процесс **circuit-breaker** с ЛИПКИМ флагом `active` ставит на паузу ВСЕ запросы к игре — и автозадачи бота, и действия из панели (всё идёт через `ApiClient`): при детекте `active=true`, `acquire()` мгновенно бросает `MaintenanceError` без обращения к серверу. Флаг снимается ТОЛЬКО успешной пробой (не по таймеру — состояние не «мерцает» между пробами). Проба (half-open) пропускает один реальный запрос не чаще раза в `PROBE_INTERVAL` (5 мин): ответ сервера (не 503-maintenance) снимает паузу, повторный `503+maintenance` — оставляет до следующей пробы.
- **Детект без лишних запросов:** НАЧАЛО техработ ловится первым же ответом `503` от обычных запросов (циклы/панель) — по здоровой игре ничего специально не опрашиваем. КОНЕЦ техработ сам не поймать (во время паузы предохранитель блокирует обычные запросы), поэтому реактивный цикл `maintenanceWatchLoop` (`src/index.js`) шлёт пробу `/progress/` с одного стабильного аккаунта (техработы глобальны — случайный аккаунт смысла не даёт) **только пока пауза активна**; реальный запрос уходит не чаще раза в `PROBE_INTERVAL` (5 мин, гейтит `acquire()`), остальные попытки — дешёвый локальный отказ. По здоровой игре цикл просто спит и лишь локально читает `status()`.
- **Уведомления в Telegram** (в основной тред — тот же, что и вордли, через `src/utils/telegram.js`): на переходе НОРМА→ТЕХРАБОТЫ шлётся текст игры «🛠 Проводятся работы на серверах игры / Пожалуйста, попробуйте зайти позже», на переходе ТЕХРАБОТЫ→НОРМА — «✅ Игра снова доступна». Оба сообщения — строго один раз на переход.
- **Панель:** статус `GET /api/maintenance` (`{active,since,retryInMs}`), баннер `components/MaintenanceBanner.tsx` лишь ОТОБРАЖАЕТ состояние (опрос раз в 5 минут), детект от него не зависит.

### Утилиты `src/utils/`
`logger.js` (winston, `logs/bot*.log`), `helpers.js` (`sleep`, `sleepUntilUtcMidnight`), `lock.js` (`apiLock`), `botState.js` (`bot-state.json`: `isCityPaused/setCityPaused`), `maintenance.js` (автопауза техработ, см. выше), `itemCache.js`, `dailyStatus` (в модулях), `reqSign.js`/`wsSession.js` (подпись и WS, см. выше), `telegram.js` (`sendToMainThread`), `itemCatalog.js` (каталог предметов из `/storage/allitemdata` → `config/items-live.json`, недостающие иконки → `src/items/<тег>.png` по тегу как в `ITEMS_BY_ID`, `tagOf`), `itemLocale.js` (русские названия предметов и справочник id→{name,type} прямо из бандла игры → `config/items-locale.json`, раз в сутки; `/api/items` отдаёт готовые `title` и `tag`), `accountLoops.js` (живой реестр `clients` для общих циклов и запуск циклов для аккаунта, добавленного на работающем боте; удаление аккаунта вычищает его из реестра), `satoshi*.js`/`gramPrice.js`/`candleAggregator.js` (Башня Сатоши), решатели мини-игр карнавала (`connectFour`, `battleship`, `dotsAndBoxes`, `pentago`, `quoridor`).

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
| `staking` | `runStaking`, `collectReady`, `saveEntriesToDb` | Федрезерв: `GET /federal-reserve/staking`, `POST /federal-reserve/staking`, `POST /federal-reserve/staking/collect`, отмена монетного вклада `cancelEntry` (`POST /federal-reserve/staking/cancel {entry_id}`, сверено с chunks/staking); ведёт `StakingEntry` |
| `market` | `runMarket` | рынок: `/market/direct*`, продажа предметов из настроек |
| `marketPrices` | `runMarketPriceLoop` | постоянный опрос цен рынка |
| `promocodes` | `runPromocodes` | `POST /promocodes/activate` (коды из настроек), пишет `PromoLog` |
| `townhall` | `runTownhall` | мэрия/аирдроп: `GET /airdrop/`, `GET /progress/diversity` |
| `shop` | `runShop` | магазин: `GET /shop/offers/booster`, `/shop/offers/booster_pack` |
| `achievements` | `runAchievements` | `GET /achievements/unlocked` |
| `loyalty` | `runLoyalty` | дорога верности: `GET/POST /loyalty-road/` |
| `capital` | `runCapital`, `runQuestLoop`, `runCapUpgradeLoop`, `collectCapitalResources` | столица гильдии: `GET/POST /capitals/progress/{gid}`, `collect/coins`, `collect/crystals`; квесты гильдии `/guild-quests/*` |
| `progress` | `runProgress` | **прокачка города**: строит/двигает/улучшает здания и **разблокирует секции** по референсу фазы (см. §6) |
| `dailyads` | `getDailyAdsStatus`, `runDailyAds` | ежедневная реклама: `GET/POST /daily-ads/` |
| `dailyStatus` | `isDone`, `markDone` | пометки «сделано сегодня» (UTC) |
| `capitalProgress` | `runCapitalProgress` | прокачка столицы по стратегии (§6) |
| `policies` | `runPolicies` | политики города: `/policies/*` (библиотека, кабинет мэра, стаж/осколки/редкость) |
| `satoshi`, `satoshiAutoClose`, `satoshiPendingOrders` | | Башня Сатоши: трейдинг GRAM, бот-side TP/SL и лимитки; стартуют из `web/server.js`, не из `index.js` |
| `guildBuildings` | `runAuditorium`, `runTechFactory`, `runTechFactoryLoop` | Вечный аудиториум (`/timeless-auditorium/status`, `/catalog`, `POST /buy {sku}` — обмен Почёта на предметы) и Технофабрика `/tech-factory/*`; очередь крафта per-account (`TechFactoryQueue`) |
| `questAutomation` | | автовыполнение гильдейских квестов только под живой квест нужного типа (`config.questAutomation`) |
| `civicDrawAuto` | `runCivicDrawLoop` | автосбор городского розыгрыша по прогнозу готовности с живой проверкой `claimable` (`features.civicDraw`); claim — `POST /policies/civic-draw/claim` |
| `boosterAutomation` | `runBoosterAutomationLoop` | автоактивация ускорителей города, свой `noLock`-клиент |

---

## 4. Игровой API (полный список используемых эндпоинтов)

Прогресс/город: `GET /progress/`, `POST /progress/` (move/build/upgrade), `POST /progress/unlock-section`, `GET /progress/diversity`, `GET /buildings/criteria`.
Сессия: `POST /web-auth/refresh`, `POST /web-auth/exchange`.
Профиль/гильдия: `GET /users/me/guild`, `GET /guilds/{id}`, `GET /guilds/benefits`, `GET /guilds/management/{id}` (+ `/applications`, approve/reject), `PATCH /guilds/management/{id}`, `GET /guilds/{id}/members`.
Столица: `GET/POST /capitals/progress/{gid}`, `POST /capitals/progress/{gid}/collect/coins`, `/collect/crystals`.
Квесты гильдии: `GET /guild-quests/guild/{gid}`, `POST /guild-quests/create/{gid}`, `POST /guild-quests/collect/{id}`.
МИД (foreign-ministry): `GET /foreign-ministry/overview?guild_id=`, `POST /foreign-ministry/{sub}?guild_id=` (alliances request/accept/reject/cancel/break/upgrade, enemies, invitations; `scouting` удалён игрой 06.07, заменён Кампаниями гильдий `/guild-campaigns/*`).
Рынок: `GET/POST /market/direct` (создание лота: `{market_id,price,currency,anonymous_sale,listing_days}`, `listing_days` из `[1,3,7]` обязателен; фильтр `categories` — единственное число: `policy/shard/booster/pack/consumable/component/masterplan`), `GET /market/direct/{id}`, `POST /market/direct/buy`, `POST /market/direct/cancel`, `GET /market/user/listing-rules` (бывший `listing-limits`, отдаёт `{rules:[...]}`), `GET /market/user/stats`, `GET /market/toncoin/balance`, `POST /market/unwarn`.
Склад/бусты: `GET /storage/allitemdata`, `POST /storage/items/sell`, `POST /boosters/activate`, `POST /boosters/combine`, `GET /boosters/active`, `GET /boosters/combination-rules`, `POST /booster-packs/open`, `POST /booster-packs/set-target`.
Рейтинги: `GET /leaderboard/global` (топ-500 по населению/доходу), `GET /leaderboard/` (топ-100 каждой лиги мэров), `GET /guilds/leaderboard` (лиги гильдий).
Мини-игры: `wordle/*`, `minesweeper/*`, `sudoku/*`, `quiz/*`, `game2048/*`.
Прочее: `daily-login/`, `daily-ads/`, `mjourney/`, `loyalty-road/`, `fortune-pavilion/*`, `federal-reserve/staking*`, `achievements/unlocked`, `airdrop/`, `promocodes/activate`, `shop/offers/*`.

> Реверс игры: чанки бандла тянутся через Chrome MCP `javascript_tool`; минифицированный код декодируется заменой `=`→`EQ`, `?`→`Q`, `&`→`AND`, `!`→`BANG` (обход сканера, блокирующего строки с cookie/query). Так найдены билдеры путей вроде `storage.sell="/storage/items/sell"`.

---

## 5. Веб-панель

### Сервер `src/web/server.js` (`startWebServer(port)`) + группы роутов `src/web/routes/*.js`
- `server.js` (тонкий, ~90 строк): поднимает Express, статику (`/items`,`/sprites`,SPA из `dist/`), **auth-гейт** (`/api/*` кроме `auth/status`,`login`,`logout`) + эндпоинты `login/logout/password`, собирает `ctx` и регистрирует группы роутов, `GET *` SPA-fallback, `app.listen`, старт фоновых воркеров рынка.
- Общие хелперы — `src/web/lib/api.js`: `apiForAcc(acc,{noLock})` и `makeApiForAccount(accountId,{noLock})` → `ApiClient` для аккаунта (на 401 сам рефрешит токен); `midErr(e)` → ошибка МИД строкой. Передаются в группы через `ctx={apiForAcc,makeApiForAccount,midErr}`.
- Каждая группа — `module.exports=function(app,ctx){…}` в `src/web/routes/`:
  - `core.js` — items/config/accounts/inventory/logs, версия и обновление;
  - `plans.js` — sections/coords/buildingslist/bot-state, city-/capital-snapshots;
  - `minigames.js` — wordle (status/guess-all), minesweeper/sudoku/quiz (+SSE `solve-stream`), minigame-status;
  - `fortune.js` — павильон удачи (log/status/can-draw-all/spin/spin-all);
  - `dashboards.js` — shop/townhall/journey/achievements/promo, guilds/guild-quests/special-buildings, builders;
  - `market.js` — **центральный рынок** (stats/deals/offers/ton-balances/auto-buy/buy/autobuy CRUD+воркер/snipe/sellable/list/list-spread/cancel); ставит `app.__startAutobuyWorker`/`app.__startSnipeScheduler`;
  - `guilds.js` — **mid-live** (МИД live: alliance/enemy/scouting/invitations), управление гильдией (applications/members/settings);
  - `economy.js` — loyalty-road, `storage-live/:accountId/*` (склад: sell/activate/combine/open-pack/set-target/sync), `shop-live`, staking, daily-ads (+SSE `watch-stream`);
  - `refresh.js` — `refresh/:module` (ручной прогон модуля).
  - `policies.js` — политики (библиотека, кабинет мэра); `civicDraw.js` — городской розыгрыш (Мэрия); `satoshi.js` — Башня Сатоши (трейдинг GRAM/USDT, курс с реальных бирж); `questTiers.js` — уровни гильдейских квестов; `guildBuildings.js` — Технофабрика/Вечный аудиториум; `cityStrategy.js`/`capitalStrategy.js` — цели улучшений и разовые build/move/demolish; `anniversary.js`/`midway.js` — событие годовщины (август 2026); `leaderboard.js` — рейтинги игры («Величайшие мэры» и лиги, кэш 10 мин).
- `restart` остаётся в `server.js`. Полный порядок регистрации групп — `src/web/server.js`.
- Правило при переносе роута в группу: относительные `require` глубже на уровень — `'../…'`→`'../../…'`, `'./cityStats'`→`'../cityStats'`.

### Фронтенд `src/web/client/` (React + Primer, роутинг в `App.tsx`)
Меню (сайдбар, группы): Аккаунты, Инвентарь, **Федеральный Резерв**(Стейкинг), **Павильон удачи**(Фортуна), **Оплот Мудрости**(Вордли/Сапёр/Судоку/Викторина), **Профиль**(Путь Мэра/Достижения/Промокоды), Строители, МИД, Гильдии, **Сфера миссий**(Дорога верности/Квесты), Столицы, Города, **Рейтинг**(Величайшие мэры/Лиги), Аудиториум, Фабрика, **Задания**(Ежедневный вход/реклама), **Мэрия**(Распределение/Политика/Разнообразие), **Магазин**(Ускорители/Наборы), **Центральный рынок**(Лоты/Листинги/Статистика/Покупки/Продажи), Настройки, Логи. Хидер убран; `--header-h:0`.

Ключевые страницы: `Accounts`, `Inventory`+`StorageModal` (склад live: продажа/актив/комбо/открытие паков с показом выпавшего), `Reserve` (стейкинг), `Fortune`, мини-игры, `City`/`CityMap` (`CityMapCity`/`CityMapCapital` + `CityActionsCanvas`), `GlobalUpgradePlan`/`GlobalCapitalUpgradePlan`, `Capitals`, `Mid`, `Guilds`, `MarketStats/MarketLots/MarketDeals`, `DailyAds`, `Loyalty`, `Quests`, `Settings`, `Logs`.

Название предмета по id на любой странице — `itemName(id, catalog)`/`knownItemName` из `hooks/useItemCatalog.ts` (локализация игры → `ITEMS_BY_ID` → слаг → «Предмет #id»), страница вызывает `useItemCatalog()`, чтобы перерисоваться после загрузки каталога.

**Смена суток на карте города** (17.10.2026): `components/mapNight.ts` + ночной проход в `CityActionsCanvas.tsx` (проп `dayNight`, режим из `config.ui.mapDayNight`). Окна и подсветка — готовые слои `src/web/sprites/night/` из `scripts/night/export.py` по ручной разметке `scripts/night/ov/*.json`. Слои хранятся в репозитории и сами не пересобираются: правка разметки и пересборка — только когда пользователь назовёт, какие здания переделать (решение 17.10.2026). Днём ночной код не работает вовсе. Столица тонируется тем же переключателем, из её зданий размечена только штаб-квартира; её верх перерисован прямо в атласе столицы (`scripts/night/patch_hq_sprite.py`), после `download-sprites.js` правку надо наложить заново. Сложные здания (Столичная Башня, штаб-квартира, инкубатор, Ботанический сад, Клуб «Меридиан», Небесный Пик, Павильон удачи, Нова Нексус, Оплот мудрости, Центральный маркет, Великий Арканум, Башня Сатоши, казино) отрисованы кодом: `"custom"` в разметке → `scripts/night/custom/*.py`. У Офисной башни, Городского банка, штаб-квартир полиции и пожарных и медцентра окна по ключам, а подсветка кодом: `{"t":"mod"}` в `lights` → `emit()` в `scripts/night/custom/office_tower.py`/`bank.py`/`police_hq.py`/`fire_hq.py`/`medical_center.py`.

Утилиты формата `src/web/client/src/utils.ts`: `fmt` (сокращения K/M/B/T), `fmtInt` (точное целое, разделение тысяч — баланс алмазов), `fmtCr` (дробное до 1 знака — прибыль в алмазах), `fmtDate`, `sortByName`. API-обёртка — `src/web/client/src/api.ts`.

---

## 6. Прокачка города и столицы

**С 20.07.2026 прокачкой управляют стратегии пользователя.** Старая автоматика «строить по эталонному плану фазы» убрана из цикла бота (позиция здания в формулах ни на что не влияет), а 14.10.2026 удалена совсем: референсы `config/*-refplans.json`, `phases.json`, `city-building-phases.json`, генератор `src/web/cityGen.js` и эндпоинты `/api/refplans*`, `/api/cityplan`, `/api/capitalplan`.

**Источники целей** (одинаково для города и столицы, по приоритету):
1. **Ручная очередь** — клетки «улучшить следующими». Забирает столько свободных строителей, сколько может занять сейчас, остальные идут по планам. Одна клетка может стоять в очереди несколько раз подряд (серия уровней). Выполненная запись вычёркивается.
2. **Личный план** — целевой уровень для конкретной клетки.
3. **Общий план** (`GlobalUpgradePlan`/`GlobalCapitalUpgradePlan`) — целевой уровень по точному `id` здания для всех городов/столиц. Звёздные тиры («Городской банк» и «Городской банк ★2») — разные правила.

**Хранение.** Планы города построчно (с 19.08): `city_upgrade_target`, `city_upgrade_queue` (ключ `account,pos`, не по клетке), `city_reconstruct_plan`. Единственная точка доступа — `src/db/cityPlans.js`, сохранение явным diff, **без `upsert`**. Старые JSON-блобы `city_strategy.*` перенесены по отметке `city_plans_rows_v1` в `schema_marks`, больше не пишутся. Столица — `CapitalStrategy(guild_id, targets, queue)`.

**Циклы.**
- Город — `modules/progress.js runProgress` из `cityUpgradeLoop` (6 ч или по будильнику). Ограничен **строителями** (ответ игры + гильд-бонус `additional_builder` + политика кабинета `concurrent_builders`). Бюджет прохода — **80% монет**. Короткие апгрейды первыми, при равном времени — ниже уровень, при полной ничьей — по клетке (y,x); пачка запускается подряд с `sleep(500)` между POST, `refreshState()` один раз после пачки. **Стратегия перечитывается в начале каждого прохода** (цикл живёт часами внутри `waitOrWake`). Все внутренние ожидания — `waitOrWake`, не `sleep`. Сбой `/progress/` бросает `err.transient`, повтор через минуту.
- Столица — `modules/capitalProgress.js` из `capital.js runCapUpgradeLoop`, только лидер гильдии. Строителей нет, только бюджет 80% монет. Формулы цены/длительности свои (`capitalHelpers.js`), бонусов гильдии/политик/ускорителей на время нет.
- Будильник — `utils/cityWake.js` (`wake`/`waitOrWake`): ключ — имя аккаунта или `capital:${guildId}`. Сохранение целей в панели будит цикл сразу.
- Реконструкция по плану (только город) — `runPendingReconstructions`, не занимает строителя, ждёт `required_lvl` и конца стройки.

**Разовые действия** с карты: город — `web/routes/cityStrategy.js` (`build/move/demolish(destroy)/reconstruct/renovate`, `POST /progress/` **голым массивом** `[{type,...}]`); столица — `web/routes/capitalStrategy.js` (`build/move/demolish/skip-upgrade`, `POST /capitals/progress/{gid}` **объектом** `{actions:[...]}`). Столица в URL — по `guild_title`, действия от аккаунта-лидера. При `move` цели и очередь переезжают вместе со зданием. Реконструкция тратит «Компонент» (id 13), реновация — «Мастерплан» (id 12).

**Карта и прогноз.** SSE без поллинга (`utils/cityLive.js`/`capitalLive.js`, `/api/city-strategy/:account/live-stream`) — рассылка при каждой записи снимка. Прогноз — чистая симуляция без лишних запросов на тех же функциях выбора целей (`pickStrategyTargets`), что и цикл. Игра увеличивает `level` **сразу при старте** стройки (`realLevel = level-1`, пока `end` в будущем). Лог действий — `CityActionLog`/`CapitalActionLog`, реальная длительность берётся из свежего `/progress/`.

**Показатели** считаются по формулам игры в `src/web/cityStats.js`. Каталог зданий — `utils/buildingCatalog.js`, путь **`/buildings/` со слэшем** (без слэша 500), кэш `config/buildings-live.json`, обновляется кнопкой «Обновить», на событиях скидки приходят прямо в `base_price`.

Разблокировка секций (только город, `POST /progress/unlock-section`): только смежные и за монеты, кристальные бот не открывает. **У столицы секций нет.**

Config-файлы: `buildings.txt`/`capital_buildings.txt`, `city-coords.json`/`capital-coords.json`, `city_sections.json`, `items.json`, `wordle-words.txt`. Координаты для канваса карты продублированы в `src/web/client/src/data/` (импортируются в бандл), там же дорожные карты `road-map.json`/`capital-road-map.json`.

---

## 7. Настройки и безопасность (`config/settings.json`)

- `features.*` (dailyLogin, fortune, journey, builders, inventory, upgrading, buying, capital, staking, wordle, game2048, market), `logLevel`, `growthModePopulation`, `staking{amount,currency,duration}`, `sellItems[]`, `promoCodes[]`, `telegram{...}`.
- **Веб-пароль** (`src/web/auth.js`): один пароль без логина, scrypt-хэш в `settings.json:web.passwordHash`, сессия — HMAC-подписанная httpOnly-кука `tc_session` (30 дней), секрет `web.sessionSecret` автогенерится. `/api/config` вырезает `web.passwordHash`/`sessionSecret`.
- **Новые таблицы БД** добавляются только через `CREATE TABLE IF NOT EXISTS` в массиве миграций `src/db/index.js` (init НЕ вызывает `seq.sync()`). Новые колонки — `ALTER TABLE` в тех же миграциях. UNIQUE-ключи для `upsert` — `UPSERT_KEYS`/`ensureUpsertKeys()`, дубли склеивает `mergeDuplicates`. Любую правку схемы проверять `init()` на пустой базе + `scripts/schema-dump.js`: боевая база не эталон, в неё многое добавляли руками.

### Модели БД (`src/db/index.js`)
`Account`, `Inventory`, `WordleLog`, `MinigameLog`, `QuizAnswer`, `FortuneLog`, `DailyLog`, `ShopSnapshot`, `TownhallAirdrop`, `TownhallDiversity`, `JourneyLevel`, `AchievementSnapshot`, `PromoLog`, `CitySnapshot`, `GuildSnapshot`, `GuildQuestSnapshot`, `GuildSpecialBuilding`, `FortuneStatus`, `CapitalSnapshot`, `BuilderSnapshot`, `LoyaltySnapshot`, `GuildMembersSnapshot`, `MidSnapshot`, `DailyAdsSnapshot`, `StakingEntry`, `MarketStatsSnapshot`, `MarketListing`, `MarketPurchase`, `MarketSale`, `MarketAutobuy`, `MarketSnipe`.

---

## 8. Правила разработки
- Стиль бэкенда: CommonJS, `'use strict'`, компактно (без пробелов у `=`), русские комментарии/логи.
- Фронт: только компоненты **Primer React**; после правок — `npm run build` в `src/web/client`.
- Токены игры добавляются в БД (`accs`), панель управляет аккаунтами через `/api/accounts`.
- При реверсе игры — НЕ покупать/продавать/выставлять реальные данные без явной цели построить фичу.
- Запросы к игре — только через `ApiClient` (подпись, WS, предохранитель техработ, `apiLock`, авто-refresh). Из веб-роутов — через `ctx.apiForAcc`/`ctx.makeApiForAccount`.
- Новые общие циклы берут аккаунты из живого реестра `src/utils/accountLoops.js`, а не из массива, собранного при старте.
- Новые таблицы БД — только миграцией `CREATE TABLE IF NOT EXISTS` в `src/db/index.js` (§7).
- Активация ускорителей, покупки и траты кристаллов — намеренное решение игрока: автоматика делает это только под явную настройку или квест.
- Живые данные игры не кэшировать в PWA (в `vite.config.ts` `/api/*` — `NetworkOnly`).
- Тестов в проекте нет. Минимальная проверка: `node --check` изменённых файлов бэкенда и `npm run build` фронта.
- В конце работы — запись в `CHANGELOG.md`, в раздел текущей даты (один на дату, только актуальное, см. §0).
- Кнопки в последнем столбце таблицы (`DataTable`) — прижаты вправо средствами Primer: у колонки `align: 'end'`, ячейка — `<Box sx={{display:'flex',justifyContent:'flex-end'}}>` (образец — `pages/City.tsx`, «Карта»).
- Модалки — только новый `Dialog` из `@primer/react/experimental` (legacy `Dialog` из `@primer/react` больше нигде не используется). Мобильный bottom-sheet включается явно: `position={{narrow:'bottom',regular:'center'}}`.

## 9. Уроки и подводные камни

Собрано из прежней памяти Claude (июль–октябрь 2026). Подробности по датам — в `CHANGELOG.md`.

**Токены и сессии**
- Никогда не запускать вторую сессию к игре против боевой базы (тестовый скрипт, второй экземпляр бота): игра ротирует `refresh_token` и тут же убивает старый, `session_seed` новый на каждый refresh и живёт только в памяти процесса. Два процесса = вылет аккаунтов. Защита: `main()` ждёт успешного bind порта до прогрева сессий (порт-singleton), graceful shutdown.
- В JWT `access_token` только `{exp,iat,tg_uid}`, имени нет. Дедуп аккаунтов — по `tg_uid`. Имя — из `GET /users/me/` (нужна подписанная сессия).
- Ответ 403 «нет здания» (`err.noBuilding`) — нормальная ситуация: `utils/buildingReg.js` гейтит запросы по особым зданиям аккаунта (рынок, фортуна, Оплот Мудрости, Федрезерв), модули тихо пропускают.

**Запросы к игре**
- Повторяются **только GET и только когда игра вообще не ответила** (таймаут, обрыв): до 10 попыток, потолок 90 с, пауза вне `apiLock`. Изменяющие запросы не повторяются никогда: молчание не значит, что действие не выполнено. Для доменных ретраев вокруг мутаций — `withRetry(...,{skipOnNoAnswer:true})`, `sweepAccounts(...,{mutating:true})`.
- Игра отвечает одним и тем же 400 «Предоставлены неверные входные данные» / «Невозможно обработать данные запроса» на любую проблему, в том числе «уже забрано». Вердикт выносить по состоянию после ресинка, а не по коду ответа.
- Долгие или потенциально зависающие циклы (автоускорители, TP/SL Сатоши) работают на своём `noLock`-клиенте: общий `apiLock` один на процесс, `concurrency:1`, зависший запрос в нём останавливает весь бот.
- Всё, что может зависнуть, — с таймаутом: SQL без таймаута однажды навсегда остановил TP/SL; `opRegistry` держит ключ до `finally`, поэтому ручные «Обновить» обёрнуты в `withTimeout` (90 с на аккаунт, 20 мин на проход).
- `setTimeout` переполняется после ~24,8 суток (32 бита) и срабатывает сразу. `sleep()` в `utils/helpers.js` режет длинные паузы на куски; при расчёте задержки «до даты» помнить об этом.

**Реверс API игры**
- Путь эндпоинта и тело запроса надёжно берутся из JS-бандла игры (`entry-*.js` + `chunks/*.js`, отдаются без авторизации). Имена полей ответа и значения enum из бандла бывают неверны (легко спутать с i18n-таблицами): **живой ответ или точный текст ошибки важнее статики**. Для проверки — временный `logger.warn(JSON.stringify(...))` на реальном проходе.
- Игра обновляется без предупреждения, хэш бандла меняется. Перед реверсом брать свежий `https://game.toncity.io/`. Если сменится WASM подписи — перевендорить `src/utils/reqChallenge.wasm`.

**Данные и панель**
- После покупок и действий баланс перечитывать из `/progress/` (`saveStats`/`refreshBalance`), а не вычитать локально: монеты параллельно капают с города.
- Каждый `EventSource` на странице закрывать в cleanup `useEffect`: браузер держит максимум 6 соединений на origin, утёкшие SSE «вешают» всю панель.
- Не класть в `src/` файлы, которые бот создаёт сам, кроме иконок предметов в `src/items/<тег>.png` (их докачивает `itemCatalog.fetchIcons`; `node --watch` на новые файлы не реагирует). Прочий кэш из игры — в `config/`.
- Иконки монет/кристаллов — `<img>` с data-URI SVG, не инлайновый JSX-`<svg>` (сильно тормозило таблицы). Страницы в `App.tsx` грузятся через `lazy()`.
- Графики `lightweight-charts` ставят свои z-index 49/50 — у контейнера графика `isolation:isolate`, иначе он перекрывает модалки Primer (у портала z-index 1).
- Настройки интерфейса, которые должны переживать простой PWA на iOS (localStorage чистится), хранить на сервере в `config.ui` (пример — `navOpenGroups`).
