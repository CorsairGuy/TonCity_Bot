'use strict';
const {Sequelize,DataTypes}=require('sequelize');
const cfg=require('../config'),logger=require('../utils/logger');
// ВСЕ суточные циклы бота живут по UTC (sleepUntilUtcMidnight/isDifferentDay, ключи дня вида
// toISOString().slice(0,10)) — значит и БД обязана быть в UTC, иначе сравнения по DATETIME
// (окно суток гильдейского депозита, выборки «за сегодня») уедут на смещение зоны сервера.
// timezone задаём ДВАЖДЫ намеренно: dialectOptions.timezone — драйверу mariadb (как он
// преобразует Date ↔ строку), верхнеуровневый timezone — самому Sequelize (он же выставляет
// session time_zone соединения). У меня БД в UTC и разницы не видно, но на чужой машине с
// MariaDB в локальной зоне без этого «выполнено сегодня» считалось бы по зоне сервера.
const seq=new Sequelize(cfg.db.name,cfg.db.user,cfg.db.password,{
  host:cfg.db.host,port:cfg.db.port,dialect:'mariadb',logging:false,timezone:'+00:00',
  dialectOptions:{timezone:'+00:00',connectTimeout:30000},pool:{max:20,min:2,acquire:30000,idle:10000},
});
const I=DataTypes.INTEGER,S=DataTypes.STRING,T=DataTypes.TEXT,LT=DataTypes.TEXT('long');
const Account=seq.define('Account',{id:{type:I,primaryKey:true,autoIncrement:true},name:S(255),
  profit:S(50),population:S(50),happiness:S(20),
  profit_final:S(50),population_final:S(50),happiness_final:S(20),
  balance:S(50),crystals:S(50),staked_coins:S(50),staked_crystals:S(50),access_token:T,refresh_token:T,init_token:T,
  special_buildings:T},{tableName:'accs',timestamps:false});
const Inventory=seq.define('Inventory',{id:{type:I,primaryKey:true,autoIncrement:true},account:S(255),name:S(255),type:{type:S(40),defaultValue:null},marketable:{type:I,defaultValue:0},locked:{type:I,defaultValue:0},sell_price:{type:DataTypes.DOUBLE,defaultValue:null},sell_currency:{type:S(20),defaultValue:null},booster_active_limit:{type:I,defaultValue:null},booster_currently_active:{type:I,defaultValue:null},
  // время окончания ПОСЛЕДНЕГО активного инстанса этого типа — записывается сами при активации
  // (см. modules/boosterAutomation.js/web/routes/cityStrategy.js), из end_time ответа игры на
  // POST /boosters/activate. Позволяет странице "Ускорители" показывать оставшееся время и
  // определять, какой тип сейчас активен, БЕЗ единого живого запроса — только по своим же записям.
  booster_active_until:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'inventory',timestamps:false});
const WordleLog=seq.define('WordleLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  played_at:{type:DataTypes.DATEONLY,defaultValue:DataTypes.NOW},
  won:{type:DataTypes.BOOLEAN,defaultValue:false},
  attempts:{type:I,defaultValue:0},
  words:T,
},{tableName:'wordle_log',timestamps:false});
const MinigameLog=seq.define('MinigameLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  game:S(20),
  played_at:{type:DataTypes.DATEONLY,defaultValue:DataTypes.NOW},
  won:{type:DataTypes.BOOLEAN,defaultValue:false},
  reward:{type:I,defaultValue:null},
  score:{type:I,defaultValue:null},
},{tableName:'minigame_log',timestamps:false});
const QuizAnswer=seq.define('QuizAnswer',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  question_id:{type:I},
  answer_id:{type:I},
  status:S(10),
  question_text:S(255),
},{tableName:'quiz_answers',timestamps:false});
const FortuneLog=seq.define('FortuneLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  spun_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
  reward:T,
},{tableName:'fortune_log',timestamps:false});
const DailyLog=seq.define('DailyLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  logged_at:{type:DataTypes.DATEONLY,defaultValue:DataTypes.NOW},
  day:{type:I,defaultValue:null},
  reward:T,
},{tableName:'daily_log',timestamps:false});
// 13.10.2026: весь 28-дневный график наград (GET /daily-login/ отдаёт rewards:[{streak_day,
// reward_type,calculated_reward,item_id?}] на ВСЕ 28 дней разом, calculated_reward считается под
// ТЕКУЩИЕ показатели аккаунта — см. modules/tasks.js). Этот ответ бот и так получает каждый день
// (суточный цикл делает GET перед решением, нужен ли POST) — просто перестаём его выбрасывать,
// отдельный живой запрос странице не нужен.
const DailyRewardSnapshot=seq.define('DailyRewardSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  streak:{type:I,defaultValue:null},
  last_login:S(40), // ISO-таймстамп целиком (не только дата) — VARCHAR(20) обрезал, видели в логе 1406/22001
  rewards:T, // JSON: [{streak_day,reward_type,calculated_reward,item_id}]
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'daily_reward_snapshot',timestamps:false});
const ShopSnapshot=seq.define('ShopSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  type:S(50),
  data:DataTypes.TEXT('long'),  // TEXT (64 КБ) переполнялся на больших витринах
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'shop_snapshot',timestamps:false});
const D=DataTypes.DOUBLE;
const TownhallAirdrop=seq.define('TownhallAirdrop',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  city:{type:D,defaultValue:null},
  activity:{type:D,defaultValue:null},
  friends:{type:D,defaultValue:null},
  transactions:{type:D,defaultValue:null},
  achievements:{type:D,defaultValue:null},
  percentile:{type:D,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'townhall_airdrop',timestamps:false});
const TownhallDiversity=seq.define('TownhallDiversity',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  score:{type:D,defaultValue:null},
  variety_score:{type:D,defaultValue:null},
  profit_score:{type:D,defaultValue:null},
  unique_types:{type:I,defaultValue:null},
  total_buildings:{type:I,defaultValue:null},
  // бонус к доходу города от разнообразия застройки (строка "Разнообразие +N%" на экране "Обзор
  // доходов" в игре) — тот же ответ /progress/diversity, что и остальные поля здесь, просто раньше
  // не сохраняли. Сырое число (0.1 = +10%), см. web/cityStats.js computeCityStats mods.
  income_bonus:{type:D,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'townhall_diversity',timestamps:false});
const JourneyLevel=seq.define('JourneyLevel',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  level:I,
  claimed:{type:DataTypes.BOOLEAN,defaultValue:false},
  condition_met:{type:DataTypes.BOOLEAN,defaultValue:false},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'journey_log',timestamps:false});
// Пороги уровней Пути мэра/Дороги верности — СТАТИЧНЫЕ (одинаковые у всех аккаунтов, подтверждено
// сверкой живых ответов разных аккаунтов), но нигде в конфигах игры не лежат — харвестятся
// инкрементально из живых ответов /mjourney/ и /loyalty-road/ (тот же приём, что PolicyDefCatalog
// для политик), а не хардкодятся — на случай, если игра когда-нибудь добавит уровни.
const JourneyLevelDef=seq.define('JourneyLevelDef',{
  level:{type:I,primaryKey:true},
  required_profit:{type:DataTypes.DOUBLE,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'journey_level_defs',timestamps:false});
const LoyaltyLevelDef=seq.define('LoyaltyLevelDef',{
  level:{type:I,primaryKey:true},
  required_days:{type:I,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'loyalty_level_defs',timestamps:false});
const AchievementSnapshot=seq.define('AchievementSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  achievement_id:S(100),
  progress:{type:D,defaultValue:null},
  tiers:T,
  secret:{type:DataTypes.BOOLEAN,defaultValue:false},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'achievement_log',timestamps:false});
const PromoLog=seq.define('PromoLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  code:S(255),
  success:{type:DataTypes.BOOLEAN,defaultValue:false},
  reward:T,
  used_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'promo_log',timestamps:false});
const CitySnapshot=seq.define('CitySnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  buildings:T,
  // JSON-массив id секций (см. config/city_sections.json), которые игра уже отдаёт готовыми прямо в
  // /progress/ (prog.progress.unlocked_sections, сверено реверсом бандла и живым запросом 22.07.2026)
  // — никакого отдельного live-запроса не нужно, просто сохраняем рядом с buildings на каждом fetch.
  unlocked_sections:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_snapshot',timestamps:false});
// Действия по городу (страница "Города" → кнопка "Действия") — заменяет автоматику по эталонному
// плану. Сохраняются ТОЛЬКО цели улучшений (семья здания → целевой уровень) — постоянный,
// длящийся процесс, который читает modules/progress.js в своём уже существующем цикле ожидания
// строителей. Строительство/перемещение/снос — разовые живые действия, нигде не сохраняются
// (см. web/routes/cityStrategy.js).
const CityStrategy=seq.define('CityStrategy',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  targets:T, // JSON: [{family_id,target_level}]
  queue:T, // JSON: [{x,y}] — ручная приоритетная очередь улучшений, порядок массива = порядок очереди
  reconstruct_plan:T, // JSON: [{x,y}] — запланированные реконструкции, срабатывают сами, когда здание
  // достигнет required_lvl и не будет занято стройкой (см. modules/progress.js runPendingReconstructions)
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_strategy',timestamps:false});
// ── Планы города ПОСТРОЧНО (строка = клетка) ───────────────────────────────────────────────
// Пришли на смену трём JSON-блобам в city_strategy (targets/queue/reconstruct_plan). Блобы
// оставлены нетронутыми как резервная копия и путь отката, но источник правды с 19.08 — эти
// таблицы. Почему так: блоб переписывался целиком на каждое действие, поэтому одно сохранение
// могло затереть соседний план (а при отсутствии UNIQUE на city_strategy.account — затирало
// гарантированно, см. историю ensureUpsertKeys). Теперь добавление/удаление клетки — точечные
// INSERT/DELETE по своей строке, а UNIQUE(account,x,y) не даёт задвоиться на уровне БД.
const CityUpgradeTarget=seq.define('CityUpgradeTarget',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255), x:I, y:I,
  target_level:I,                 // до какого уровня качать здание на этой клетке
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_upgrade_target',timestamps:false});
const CityUpgradeQueue=seq.define('CityUpgradeQueue',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255), x:I, y:I,
  pos:{type:I,defaultValue:0},    // порядок в ручной очереди (раньше — порядок элементов массива)
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_upgrade_queue',timestamps:false});
const CityReconstructPlan=seq.define('CityReconstructPlan',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255), x:I, y:I,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_reconstruct_plan',timestamps:false});
// Доступ к Центральному рынку по аккаунтам. Игра может ограничить рынок за «подозрительную

// активность» (мультиаккаунт, перегон валюты между своими) — и тогда ЛЮБОЙ ответ /market/offers

// приходит с is_frozen/is_warned, а сама витрина в игре подменяется баннером. Держим это у себя,

// чтобы не предлагать такие аккаунты в покупке/ставках/автоскупке и не слать заведомо мёртвые

// запросы. Флаги пишутся ПОПУТНО, из ответов, которые мы и так запрашиваем.

const MarketAccess=seq.define('MarketAccess',{

  id:{type:I,primaryKey:true,autoIncrement:true},

  account:S(255),

  frozen:{type:I,defaultValue:0},   // рынок заморожен — действия недоступны совсем

  warned:{type:I,defaultValue:0},   // предупреждение: игра держит баннер, пока его не принять

  checked_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},

},{tableName:'market_access',timestamps:false});

// Отметки одноразовых операций над данными (не над схемой — схему чинит ensureUpsertKeys).
// Нужна, чтобы перенос блобов в таблицы выше выполнился ровно один раз: без отметки пустой план
// после переноса выглядел бы как «ещё не переносили» и старый блоб воскрешал бы удалённые цели.
const SchemaMark=seq.define('SchemaMark',{
  name:{type:S(100),primaryKey:true},
  done_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'schema_marks',timestamps:false});
// Общий (глобальный) план улучшений по семействам зданий — не привязан к аккаунту/городу, действует
// на любой город, где есть здание этого семейства, если у самого города нет личной цели для этой
// клетки (см. modules/progress.js resolveEffectiveTargets)
const GlobalUpgradePlan=seq.define('GlobalUpgradePlan',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  family_id:S(255),
  target_level:I,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'global_upgrade_plan',timestamps:false});
// Автоактивация ускорителей (страница "Карта города" → вкладка "Ускорители") — booster_name = id
// типа ускорителя (тот же id, что ключ в config/items.json и Inventory.name), "всегда держать
// активным": фоновый цикл (modules/boosterAutomation.js) сам активирует новый, как только
// освобождается слот (currently_active<active_limit) и есть запас в инвентаре.
const BoosterAutomation=seq.define('BoosterAutomation',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  booster_name:S(50),
  enabled:{type:I,defaultValue:0},
  queue_pos:{type:I,defaultValue:null},   // легаси первой версии очереди, см. BoosterQueue ниже
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'booster_automation',timestamps:false});
// ОЧЕРЕДЬ активации ускорителей (вкладка «Ускорители»). Одна строка = ОДИН экземпляр к активации,
// поэтому один и тот же тип может встречаться несколько раз («мифик, мифик, лега»). Позиция
// РАСХОДУЕТСЯ: после успешной активации строка удаляется и очередь сдвигается — этим она
// отличается от BoosterAutomation.enabled («всегда держать активным»), который живёт постоянно.
const BoosterQueue=seq.define('BoosterQueue',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  booster_name:S(50),
  pos:{type:I,defaultValue:0},
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'booster_queue',timestamps:false});
// Лог действий по городу (страница "Карта города" → вкладка "Лог") — намеренно НЕ завязан жёстко
// на "город": типизированные колонки под самые частые нужды отображения (сортировка по времени,
// фильтр по типу/зданию), detail — JSON под всё остальное, чтобы новый нюанс действия не требовал
// ALTER TABLE. account проиндексирован с created_at — тот же запрос без WHERE account в будущем
// станет общим логом всех аккаунтов разом, без переделок схемы.
const CityActionLog=seq.define('CityActionLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  type:S(30), // upgrade|build|move|demolish|reconstruct|renovate|booster_activate
  x:{type:I,defaultValue:null},
  y:{type:I,defaultValue:null},
  from_x:{type:I,defaultValue:null},
  from_y:{type:I,defaultValue:null},
  building_id:{type:S(255),defaultValue:null},
  level_from:{type:I,defaultValue:null},
  level_to:{type:I,defaultValue:null},
  duration_ms:{type:DataTypes.BIGINT,defaultValue:null},
  detail:{type:T,defaultValue:null},
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'city_action_log',timestamps:false});
// Столицы: та же архитектура, что и у CityStrategy/GlobalUpgradePlan/CityActionLog выше, только
// ключ guild_id вместо account — столица общая на гильдию (см. CapitalSnapshot), а не личная.
const CapitalStrategy=seq.define('CapitalStrategy',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  targets:T, // JSON: [{x,y,target_level}]
  queue:T, // JSON: [{x,y}] — ручная приоритетная очередь, как у CityStrategy.queue
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'capital_strategy',timestamps:false});
const GlobalCapitalUpgradePlan=seq.define('GlobalCapitalUpgradePlan',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  family_id:S(255), // по факту точный id здания столицы, как и у GlobalUpgradePlan
  target_level:I,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'global_capital_upgrade_plan',timestamps:false});
const CapitalActionLog=seq.define('CapitalActionLog',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  type:S(30), // upgrade|build|move|demolish
  x:{type:I,defaultValue:null},
  y:{type:I,defaultValue:null},
  from_x:{type:I,defaultValue:null},
  from_y:{type:I,defaultValue:null},
  building_id:{type:S(255),defaultValue:null},
  level_from:{type:I,defaultValue:null},
  level_to:{type:I,defaultValue:null},
  duration_ms:{type:DataTypes.BIGINT,defaultValue:null},
  detail:{type:T,defaultValue:null},
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'capital_action_log',timestamps:false});
const GuildSnapshot=seq.define('GuildSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  guild_id:S(100),
  guild_title:S(255),
  role:S(50),
  benefits:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'guild_snapshot',timestamps:false});
const GuildQuestSnapshot=seq.define('GuildQuestSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  account:S(255),
  quests:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'guild_quests',timestamps:false});
const GuildSpecialBuilding=seq.define('GuildSpecialBuilding',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  auditorium_level:{type:I,defaultValue:null},
  factory_level:{type:I,defaultValue:null},
  ministry_level:{type:I,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'guild_special_buildings',timestamps:false});
const FortuneStatus=seq.define('FortuneStatus',{
  account_id:{type:I,primaryKey:true},
  account:S(255),
  can_draw:{type:I,defaultValue:0},
  cost:{type:I,defaultValue:0},
  spins_made:{type:I,defaultValue:0},
  crystals:{type:D,defaultValue:0},
  status_date:S(20),
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'fortune_status',timestamps:false});
const CapitalSnapshot=seq.define('CapitalSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  buildings:T,
  coins:{type:D,defaultValue:null},
  crystals:{type:D,defaultValue:null},
  profit_coins:{type:D,defaultValue:null},
  profit_crystals:{type:D,defaultValue:null},
  profit_coins_final:{type:D,defaultValue:null},
  profit_crystals_final:{type:D,defaultValue:null},
  economic_strength:{type:D,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'capital_snapshot',timestamps:false});
const BuilderSnapshot=seq.define('BuilderSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  count:{type:I,defaultValue:null},
  price_coins:{type:D,defaultValue:null},
  price_stars:{type:D,defaultValue:null},
  max_builders:{type:I,defaultValue:null},
  cnt_coins:{type:I,defaultValue:null},
  max_coins:{type:I,defaultValue:null},
  cnt_stars:{type:I,defaultValue:null},
  max_stars:{type:I,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'builder_snapshot',timestamps:false});
const LoyaltySnapshot=seq.define('LoyaltySnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  streak:{type:I,defaultValue:0},
  levels:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'loyalty_snapshot',timestamps:false});
const GuildMembersSnapshot=seq.define('GuildMembersSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  members:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'guild_members_snapshot',timestamps:false});
const MidSnapshot=seq.define('MidSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  data:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'mid_snapshot',timestamps:false});
const QuestTierSnapshot=seq.define('QuestTierSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  guild_id:S(100),
  guild_title:S(255),
  data:T,
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'quest_tier_snapshot',timestamps:false});
const DailyAdsSnapshot=seq.define('DailyAdsSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  current:{type:I,defaultValue:0},
  limit:{type:I,defaultValue:10},
  // BIGINT, а не INT: на событии награда за рекламу удвоена и у прокачанных городов вылезла за
  // 2^31 — игра прислала число, MariaDB ответила ER_WARN_DATA_OUT_OF_RANGE (лог 13.08), и снимок
  // рекламы переставал сохраняться вообще
  reward:{type:DataTypes.BIGINT,defaultValue:0},
  limit_reached:{type:DataTypes.BOOLEAN,defaultValue:false},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'daily_ads_snapshot',timestamps:false});
const StakingEntry=seq.define('StakingEntry',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  entry_id:{type:I,unique:true},
  account:S(255),
  currency:S(20),
  amount_staked:{type:D,defaultValue:null},
  amount_to_collect:{type:D,defaultValue:null},
  created_at:{type:DataTypes.DATE,defaultValue:null},
  can_collect_at:{type:DataTypes.DATE,defaultValue:null},
  collected:{type:DataTypes.BOOLEAN,defaultValue:false},
  collected_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'staking_entries',timestamps:false});
const MarketStatsSnapshot=seq.define('MarketStatsSnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  total_purchases:{type:I,defaultValue:null},
  total_sales:{type:I,defaultValue:null},
  total_crystals_earned:{type:D,defaultValue:null},
  total_crystals_spent:{type:D,defaultValue:null},
  total_ton_earned:{type:D,defaultValue:null},
  total_ton_spent:{type:D,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'market_stats_snapshot',timestamps:false});
const MarketListing=seq.define('MarketListing',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  listing_id:{type:I,defaultValue:null},
  market_id:{type:I,defaultValue:null},
  item_id:{type:I,defaultValue:null},
  item_category:S(40),
  item_rarity:S(20),
  currency:S(20),
  price:{type:D,defaultValue:null},
  qty:{type:I,defaultValue:null},
  status:S(20),
  created_at:{type:DataTypes.DATE,defaultValue:null},
  available_at:{type:DataTypes.DATE,defaultValue:null},
  ends_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'market_listings',timestamps:false});
const MarketPurchase=seq.define('MarketPurchase',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  record_id:{type:I,defaultValue:null},
  market_id:{type:I,defaultValue:null},
  item_id:{type:I,defaultValue:null},
  item_category:S(40),
  item_rarity:S(20),
  currency:S(20),
  price:{type:D,defaultValue:null},
  fee:{type:D,defaultValue:null},
  qty:{type:I,defaultValue:null},
  counterparty:S(255),
  sold_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'market_purchases',timestamps:false});
const MarketSale=seq.define('MarketSale',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  record_id:{type:I,defaultValue:null},
  market_id:{type:I,defaultValue:null},
  item_id:{type:I,defaultValue:null},
  item_category:S(40),
  item_rarity:S(20),
  currency:S(20),
  price:{type:D,defaultValue:null},
  fee:{type:D,defaultValue:null},
  qty:{type:I,defaultValue:null},
  counterparty:S(255),
  sold_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'market_sales',timestamps:false});
const MarketAutobuy=seq.define('MarketAutobuy',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  item_id:{type:I,defaultValue:null},
  categories:S(40),
  rarities:S(20),
  currency:S(20),
  max_price:{type:D,defaultValue:null},
  max_budget:{type:D,defaultValue:null},
  spent:{type:D,defaultValue:0},
  account_ids:T,
  include_escrow:{type:DataTypes.BOOLEAN,defaultValue:true},
  enabled:{type:DataTypes.BOOLEAN,defaultValue:false},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'market_autobuy',timestamps:false});
const CivicDrawStatus=seq.define('CivicDrawStatus',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  draws_per_day:{type:DataTypes.DOUBLE,defaultValue:null}, // было INTEGER — дробную ставку (0.97/день и т.п.) округляло при записи
  draws_ready:{type:I,defaultValue:null},
  draw_progress:{type:DataTypes.DOUBLE,defaultValue:null},
  claimable:{type:DataTypes.BOOLEAN,defaultValue:false},
  odds:T, // JSON: [{rarity,chance,count}] — шансы наград розыгрыша
  // линейный прогноз "когда будет готов следующий розыгрыш", посчитанный на сервере при каждом
  // синке (см. modules/townhall.js) и НИКОГДА не сдвигаемый назад между синками (max со старым
  // значением) — защита от того, что сырой прогресс иногда чуть колеблется между снимками
  ready_at:{type:DataTypes.DATE,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'civic_draw_status',timestamps:false});
// 13.10.2026: форма подтверждена реверсом живого бандла игры (chunks/tech_factory-*.js, useGuildAchievements-*.js) —
// раньше categories/job хранили УГАДАННУЮ форму ({code,pool,recipes:[{id,...}]}), настоящая другая:
//   categories: [{id,unlocked, machines:[{id,name,icon_key,level,max_level,
//                 tiers:[{level(1-6),unlocked,duration_seconds,fee_crystals,
//                         inputs:[{item_id,quantity}],output:{item_id,quantity},
//                         used,limit_count,limit_window:'day'|'week',upgrade_crystals}]}]}]
//   job: {machine_id,level,started_at,finishes_at,ready,output:{item_id,quantity}}|null — per-account,
//        НЕ общий на гильдию (станок гильдейский, но очередь/задание у каждого участника своё)
const TechFactoryStatus=seq.define('TechFactoryStatus',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  renown_balance:{type:DataTypes.DOUBLE,defaultValue:null},
  categories:T,
  job:T,
  is_member:{type:DataTypes.BOOLEAN,defaultValue:null},
  membership_eligible:{type:DataTypes.BOOLEAN,defaultValue:null},
  economy_unlocked:{type:DataTypes.BOOLEAN,defaultValue:null},
  guild_crystal_balance:{type:DataTypes.DOUBLE,defaultValue:null},
  can_upgrade:{type:DataTypes.BOOLEAN,defaultValue:null},
  guild_renown_balance:{type:DataTypes.DOUBLE,defaultValue:null},
  can_spend_guild_renown:{type:DataTypes.BOOLEAN,defaultValue:null},
  eligible_members:{type:I,defaultValue:null},
  // 13.10.2026: раньше наличие здания определялось ЧУЖОЙ таблицей (guild_special_buildings,
  // которую заполняет ТОЛЬКО лидер/офицер гильдии через /capitals/progress/ — обычному участнику
  // эта ручка недоступна). Рядовые члены гильдии, где у бота нет лидера/офицера, никогда не
  // попадали на страницу фабрики, хотя здание у их гильдии реально построено — эндпоинт
  // /tech-factory/overview САМ отдаёт has_factory всем, независимо от роли. См. [[reference_tech_factory_api]].
  has_factory:{type:DataTypes.BOOLEAN,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'tech_factory_status',timestamps:false});
// очередь автозапуска переработок (своя у каждого аккаунта, pos — порядок обработки)
const TechFactoryQueue=seq.define('TechFactoryQueue',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  machine_id:S(100),
  level:{type:I},
  pos:{type:I},
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'tech_factory_queue',timestamps:false});
const AuditoriumStatus=seq.define('AuditoriumStatus',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  renown:T,     // JSON: {current,required,met}
  loyalty:T,    // JSON: {current,required,met}
  population:T, // JSON: {current,required,met}
  unlocked:{type:DataTypes.BOOLEAN,defaultValue:false},
  // 14.10.2026: реверс chunks/timeless_auditorium-*.js — /status отдаёт ещё in_guild/has_auditorium
  // (доступен ЛЮБОМУ члену гильдии, в отличие от guild_special_buildings), а открытым аккаунтам
  // /catalog отдаёт витрину обмена Почёта: {balance,lifetime_earned,tiers[],sections[{key,skus[]}]}
  in_guild:{type:DataTypes.BOOLEAN,allowNull:true},
  has_auditorium:{type:DataTypes.BOOLEAN,allowNull:true},
  catalog:LT,  // JSON ответа /timeless-auditorium/catalog (null — вход закрыт)
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'auditorium_status',timestamps:false});
const PolicySnapshot=seq.define('PolicySnapshot',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  // LONGTEXT, а не TEXT: предел TEXT — 65 535 БАЙТ, а не символов, и кириллица в utf8mb4 занимает
  // по два. Библиотека политик растёт с каждым обновлением игры: 19.08.2026 она уже 62 КБ (95% от
  // предела) — у второй установки запись падала с «Data too long for column 'library'», и снимок
  // политик просто не сохранялся. list идёт следом (29 КБ). Меняем сразу все JSON-колонки таблицы.
  list:LT,     // JSON: инстансы политик игрока (/policies/)
  library:LT,  // JSON: {discovered,total,sections} (/policies/library)
  cabinet:LT,  // JSON: {slots,civic_draw} (/policies/cabinet)
  economy:LT, // JSON: {unlocked,min_population,craft_costs:{rarity:cost}} — тоже из /policies/,
              // раньше отбрасывалось модулем (брали только .instances) — из-за этого кнопка
              // "Создать тайную политику" не знала, сколько осколков реально нужно
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'policy_snapshot',timestamps:false});
// Башня Сатоши: открытые позиции (id — реальный position_id из игры, поэтому PK не автоинкремент)
const SatoshiPosition=seq.define('SatoshiPosition',{
  id:{type:I,primaryKey:true},
  account:S(255),
  side:S(10),
  leverage:{type:D,defaultValue:null},
  margin:{type:D,defaultValue:null},
  notional:{type:D,defaultValue:null},
  entry_price:{type:D,defaultValue:null},
  liquidation_price:{type:D,defaultValue:null},
  opened_at:{type:DataTypes.DATE,defaultValue:null},
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
  // Бот-side авто-закрытие. С обновления игры 31.07.2026 у игры ПОЯВИЛСЯ свой TP/SL (см. ниже
  // game_tp_price/game_sl_price) — он основной, серверный и срабатывает даже когда бот выключен.
  // Эти поля остаются как ДОЖИМ: игровой TP/SL нельзя изменить после открытия позиции (эндпоинта
  // на правку у игры нет), поэтому бот может только ужесточить уровень — закрыть РАНЬШЕ игрового.
  tp_price:{type:D,defaultValue:null},
  sl_price:{type:D,defaultValue:null},
  tp_pnl_pct:{type:D,defaultValue:null},
  sl_pnl_pct:{type:D,defaultValue:null},
  // игровой (серверный) TP/SL — приходит в самой позиции из /satoshi-tower/positions, задаётся
  // ТОЛЬКО при открытии в POST /satoshi-tower/positions {take_profit_price,stop_loss_price}
  game_tp_price:{type:D,defaultValue:null},
  game_sl_price:{type:D,defaultValue:null},
},{tableName:'satoshi_position',timestamps:false});
// Башня Сатоши: условные ордера ("открыть по достижении цены") — бот-фича, следит за биржевым
// курсом (utils/satoshiPendingOrders.js) и открывает реальную позицию в игре при срабатывании
const SatoshiPendingOrder=seq.define('SatoshiPendingOrder',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  account:S(255),
  side:S(10),
  leverage:{type:D,defaultValue:null},
  margin:{type:D,defaultValue:null},
  trigger_price:{type:D,defaultValue:null},
  ref_price:{type:D,defaultValue:null}, // цена биржи на момент создания — определяет направление пересечения
  tp_price:{type:D,defaultValue:null},
  sl_price:{type:D,defaultValue:null},
  tp_pnl_pct:{type:D,defaultValue:null},
  sl_pnl_pct:{type:D,defaultValue:null},
  status:{type:S(20),defaultValue:'pending'}, // pending|triggered|cancelled|failed
  error:T,
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
  triggered_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'satoshi_pending_order',timestamps:false});
// Башня Сатоши: закрытые/ликвидированные позиции — копим бессрочно (по id, не дублируем)
const SatoshiPositionHistory=seq.define('SatoshiPositionHistory',{
  id:{type:I,primaryKey:true},
  account:S(255),
  side:S(10),
  leverage:{type:D,defaultValue:null},
  margin:{type:D,defaultValue:null},
  notional:{type:D,defaultValue:null},
  entry_price:{type:D,defaultValue:null},
  close_price:{type:D,defaultValue:null},
  liquidation_price:{type:D,defaultValue:null},
  realized_pnl:{type:D,defaultValue:null},
  fee:{type:D,defaultValue:null},
  payout:{type:D,defaultValue:null},
  status:S(20),
  opened_at:{type:DataTypes.DATE,defaultValue:null},
  closed_at:{type:DataTypes.DATE,defaultValue:null},
},{tableName:'satoshi_position_history',timestamps:false});
// Каталог ОПИСАНИЙ политик, собранный по мере обнаружения аккаунтами (полного списка всех ~300
// политик клиент игры не хранит локально — сервер отдаёт данные только для уже открытых игроком;
// поэтому копим общий каталог в БД из данных всех аккаунтов бота, он растёт со временем)
// Ключ СОСТАВНОЙ (def_id + rarity): одна и та же политика существует в РАЗНЫХ редкостях с ОДНИМ
// def_id (редкость в def_id не закодирована, ср. ind_frugal_engineering__city_income). Пока PK был
// только def_id, строка была одна и rarity затиралась последней записью — из-за этого на странице
// офферов у эпического лота открывалась карточка обычной политики, а в библиотеке политика
// показывалась только в одной группе редкости (исправлено 31.07.2026).
const PolicyDefCatalog=seq.define('PolicyDefCatalog',{
  def_id:{type:S(100),primaryKey:true},
  rarity:{type:S(20),primaryKey:true,defaultValue:'unknown'},
  name:T,        // JSON {en,ru}
  description:T, // JSON {en,ru}
  icon_key:S(100),
  theme:S(50),
  badge:S(50),
  badge_n:{type:I,defaultValue:null},
  max_level:{type:I,defaultValue:null},
  effects:T,     // JSON: эффекты представительного инстанса (stat/scope_kind/targets/mode/value)
  seen_account:S(255), // первый аккаунт, где встретилась (для справки)
  updated_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'policy_def_catalog',timestamps:false});
const MarketSnipe=seq.define('MarketSnipe',{
  id:{type:I,primaryKey:true,autoIncrement:true},
  offer_id:{type:I},
  // account_id — строка в accs, а она НЕ вечная: если аккаунт удалить и добавить заново (напр.
  // после протухшего refresh-токена), у него будет НОВЫЙ id, и отложенная покупка уткнётся в
  // «Аккаунт не найден или нет токена». Поэтому рядом храним имя — по нему снайп находит аккаунт
  // заново и чинит ссылку (живой случай 21.08.2026: вечный ускоритель не выкупился именно так).
  account_id:{type:I},
  account:S(255),
  item_id:{type:I,defaultValue:null},
  currency:S(20),
  price:{type:D,defaultValue:null},
  available_at:{type:DataTypes.DATE,defaultValue:null},
  status:{type:S(20),defaultValue:'pending'},
  error:T,
  created_at:{type:DataTypes.DATE,defaultValue:DataTypes.NOW},
},{tableName:'market_snipe',timestamps:false});
async function init(){
  await seq.authenticate();
  logger.info('Database connected');
  // Громкая проверка вместо тихого сползания дат: если соединение почему-то не в UTC (чужая БД,
  // другой драйвер, переопределённые настройки), суточные окна поедут на смещение зоны, а внешне
  // это выглядит как «задание засчиталось не в тот день». Лучше увидеть строку в логе.
  try{
    const[tz]=await seq.query('SELECT @@session.time_zone tz, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) skew',
      {type:Sequelize.QueryTypes.SELECT});
    const skew=Number(tz?.skew||0);
    if(skew!==0)logger.warn(`[db] ВНИМАНИЕ: время БД смещено на ${skew} с относительно UTC (session time_zone=${tz?.tz}). Суточные циклы бота работают по UTC — выборки «за сегодня» будут неверными.`);
    else logger.info(`[db] время БД в UTC (session time_zone=${tz?.tz})`);
  }catch(e){logger.warn(`[db] не удалось проверить часовой пояс БД: ${e.message}`);}
  // создаёт ТОЛЬКО отсутствующие таблицы по текущим определениям моделей (не трогает уже
  // существующие) — без этого на чистой БД (напр. первый запуск в Docker у другого человека)
  // часть таблиц (MinigameLog/QuizAnswer/DailyLog/CitySnapshot/... — не имеющие ни строчки в
  // init.sql, ни в миграциях ниже) никогда не создавалась бы и падала с ER_NO_SUCH_TABLE.
  await seq.sync();
  const migrations=[
    `ALTER TABLE capital_snapshot ADD COLUMN crystals REAL`,
    `ALTER TABLE capital_snapshot ADD COLUMN profit_coins REAL`,
    `ALTER TABLE capital_snapshot ADD COLUMN profit_crystals REAL`,
    `ALTER TABLE capital_snapshot ADD COLUMN profit_coins_final REAL`,
    `ALTER TABLE capital_snapshot ADD COLUMN profit_crystals_final REAL`,
    `CREATE TABLE IF NOT EXISTS staking_entries (id INT AUTO_INCREMENT PRIMARY KEY, entry_id INT NOT NULL UNIQUE, account VARCHAR(255), currency VARCHAR(20), amount_staked DOUBLE DEFAULT NULL, amount_to_collect DOUBLE DEFAULT NULL, created_at DATETIME DEFAULT NULL, can_collect_at DATETIME DEFAULT NULL, collected TINYINT(1) DEFAULT 0, collected_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS quest_tier_snapshot (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(100) UNIQUE, guild_title VARCHAR(255), data TEXT, updated_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS market_listings (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), listing_id INT, market_id INT, item_id INT, item_category VARCHAR(40), item_rarity VARCHAR(20), currency VARCHAR(20), price DOUBLE DEFAULT NULL, qty INT, status VARCHAR(20), created_at DATETIME DEFAULT NULL, available_at DATETIME DEFAULT NULL, ends_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    `CREATE TABLE IF NOT EXISTS market_purchases (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), record_id INT, market_id INT, item_id INT, item_category VARCHAR(40), item_rarity VARCHAR(20), currency VARCHAR(20), price DOUBLE DEFAULT NULL, fee DOUBLE DEFAULT NULL, qty INT, counterparty VARCHAR(255), sold_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    `CREATE TABLE IF NOT EXISTS market_sales (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), record_id INT, market_id INT, item_id INT, item_category VARCHAR(40), item_rarity VARCHAR(20), currency VARCHAR(20), price DOUBLE DEFAULT NULL, fee DOUBLE DEFAULT NULL, qty INT, counterparty VARCHAR(255), sold_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    `CREATE TABLE IF NOT EXISTS market_autobuy (id INT AUTO_INCREMENT PRIMARY KEY, item_id INT, categories VARCHAR(40), rarities VARCHAR(20), currency VARCHAR(20), max_price DOUBLE DEFAULT NULL, max_budget DOUBLE DEFAULT NULL, spent DOUBLE DEFAULT 0, account_ids TEXT, include_escrow TINYINT(1) DEFAULT 1, enabled TINYINT(1) DEFAULT 0, updated_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS market_snipe (id INT AUTO_INCREMENT PRIMARY KEY, offer_id INT, account_id INT, item_id INT, currency VARCHAR(20), price DOUBLE DEFAULT NULL, available_at DATETIME DEFAULT NULL, status VARCHAR(20) DEFAULT 'pending', error TEXT, created_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_offer_acc (offer_id, account_id))`,
    `CREATE TABLE IF NOT EXISTS guild_quests (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(100) UNIQUE, guild_title VARCHAR(255), account VARCHAR(255), quests TEXT, updated_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS guild_special_buildings (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(100) UNIQUE, guild_title VARCHAR(255), auditorium_level INT DEFAULT NULL, factory_level INT DEFAULT NULL, ministry_level INT DEFAULT NULL, updated_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS fortune_status (account_id INT PRIMARY KEY, account VARCHAR(255), can_draw TINYINT(1) DEFAULT 0, cost INT DEFAULT 0, spins_made INT DEFAULT 0, crystals DOUBLE DEFAULT 0, status_date VARCHAR(20), updated_at DATETIME DEFAULT NULL)`,
    `ALTER TABLE guild_special_buildings ADD COLUMN ministry_level INT DEFAULT NULL`,
    // награда за рекламу перестала помещаться в INT (удвоение на событии) — см. модель выше
    `ALTER TABLE daily_ads_snapshot MODIFY COLUMN reward BIGINT DEFAULT 0`,
    // особые здания аккаунта на карте (CSV: market,fortune,wisdom,reserve) — заполняется из /progress/
    `ALTER TABLE accs ADD COLUMN special_buildings TEXT`,
    // тип предмета из живого API (booster/booster_pack/policy_shard/mystery_policy/...) — чтобы отличать
    // осколки/тайные политики (страница "Политики") от обычных предметов (страница "Предметы")
    `ALTER TABLE inventory ADD COLUMN type VARCHAR(40)`,
    // время окончания активного ускорителя (страница "Ускорители") — записывается сами при
    // активации, из end_time ответа игры, без отдельного живого запроса на чтение.
    `ALTER TABLE inventory ADD COLUMN booster_active_until DATETIME DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS policy_snapshot (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), list TEXT, library TEXT, cabinet TEXT, updated_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    `ALTER TABLE policy_snapshot ADD COLUMN economy TEXT`,
    // бонус к доходу города от разнообразия застройки (тот же /progress/diversity, что и остальные
    // поля townhall_diversity) — для расчёта показателей города на карте (cityStats.js)
    `ALTER TABLE townhall_diversity ADD COLUMN income_bonus DOUBLE DEFAULT NULL`,
    // Городской розыгрыш (civic_draw из /progress/diversity) — своя таблица, не трогаем townhall_diversity
    `CREATE TABLE IF NOT EXISTS civic_draw_status (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), draws_per_day INT DEFAULT NULL, draws_ready INT DEFAULT NULL, draw_progress DOUBLE DEFAULT NULL, claimable TINYINT(1) DEFAULT 0, odds TEXT, updated_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    // БАГ: таблица создавалась с обычным INDEX (не UNIQUE), а townhall.js писал через
    // upsert({conflictFields:['account']}) — этот механизм работает только при реальном уникальном
    // ограничении в БД, без него это была просто INSERT на каждый цикл синка → бесконечно растущие
    // дубли строк на аккаунт (видно на странице "Городской розыгрыш" — по 6+ одинаковых строк).
    // Чистим дубли (оставляем самую свежую по id на каждый account), затем добавляем настоящий UNIQUE.
    `DELETE t1 FROM civic_draw_status t1 INNER JOIN civic_draw_status t2 ON t1.account=t2.account AND t1.id<t2.id`,
    `ALTER TABLE civic_draw_status ADD UNIQUE KEY uniq_civic_draw_account (account)`,
    // draws_per_day хранился как INT — реальная ставка дробная (0.97/день и т.п.), округлялась при
    // каждой записи. И новая колонка под прогноз готовности (см. CivicDrawStatus.ready_at выше).
    `ALTER TABLE civic_draw_status MODIFY draws_per_day DOUBLE DEFAULT NULL`,
    `ALTER TABLE civic_draw_status ADD COLUMN ready_at DATETIME DEFAULT NULL`,
    // общий каталог описаний политик (растёт по мере открытия разными аккаунтами)
    `CREATE TABLE IF NOT EXISTS policy_def_catalog (def_id VARCHAR(100) PRIMARY KEY, rarity VARCHAR(20), name TEXT, description TEXT, icon_key VARCHAR(100), theme VARCHAR(50), badge VARCHAR(50), badge_n INT DEFAULT NULL, max_level INT DEFAULT NULL, effects TEXT, seen_account VARCHAR(255), updated_at DATETIME DEFAULT NULL)`,
    // PK был только def_id — но одна политика бывает в НЕСКОЛЬКИХ редкостях с тем же def_id, и
    // строка перезаписывалась (эпическая показывалась как обычная). Переводим на составной ключ.
    // rarity не может быть NULL в PK — сначала чистим пустые (их насыпал старый харвест библиотеки,
    // где редкость лежит на уровне секции и терялась).
    `UPDATE policy_def_catalog SET rarity='unknown' WHERE rarity IS NULL OR rarity=''`,
    `ALTER TABLE policy_def_catalog MODIFY rarity VARCHAR(20) NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE policy_def_catalog DROP PRIMARY KEY, ADD PRIMARY KEY (def_id, rarity)`,
    // Башня Сатоши: открытые и закрытые позиции (id — реальный position_id из игры)
    `CREATE TABLE IF NOT EXISTS satoshi_position (id INT PRIMARY KEY, account VARCHAR(255), side VARCHAR(10), leverage DOUBLE, margin DOUBLE, notional DOUBLE, entry_price DOUBLE, liquidation_price DOUBLE, opened_at DATETIME DEFAULT NULL, updated_at DATETIME DEFAULT NULL, tp_price DOUBLE DEFAULT NULL, sl_price DOUBLE DEFAULT NULL, tp_pnl_pct DOUBLE DEFAULT NULL, sl_pnl_pct DOUBLE DEFAULT NULL, INDEX idx_account (account))`,
    `ALTER TABLE satoshi_position ADD COLUMN tp_price DOUBLE DEFAULT NULL`,
    `ALTER TABLE satoshi_position ADD COLUMN sl_price DOUBLE DEFAULT NULL`,
    `ALTER TABLE satoshi_position ADD COLUMN tp_pnl_pct DOUBLE DEFAULT NULL`,
    `ALTER TABLE satoshi_position ADD COLUMN sl_pnl_pct DOUBLE DEFAULT NULL`,
    // игровой TP/SL (обновление игры 31.07.2026)
    `ALTER TABLE satoshi_position ADD COLUMN game_tp_price DOUBLE DEFAULT NULL`,
    `ALTER TABLE satoshi_position ADD COLUMN game_sl_price DOUBLE DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS satoshi_position_history (id INT PRIMARY KEY, account VARCHAR(255), side VARCHAR(10), leverage DOUBLE, margin DOUBLE, notional DOUBLE, entry_price DOUBLE, close_price DOUBLE, liquidation_price DOUBLE, realized_pnl DOUBLE, fee DOUBLE, payout DOUBLE, status VARCHAR(20), opened_at DATETIME DEFAULT NULL, closed_at DATETIME DEFAULT NULL, INDEX idx_account (account))`,
    // условные ордера ("открыть по цене") — следим за биржевым курсом, открываем в игре при срабатывании
    `CREATE TABLE IF NOT EXISTS satoshi_pending_order (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), side VARCHAR(10), leverage DOUBLE, margin DOUBLE, trigger_price DOUBLE, ref_price DOUBLE, tp_price DOUBLE DEFAULT NULL, sl_price DOUBLE DEFAULT NULL, tp_pnl_pct DOUBLE DEFAULT NULL, sl_pnl_pct DOUBLE DEFAULT NULL, status VARCHAR(20) DEFAULT 'pending', error TEXT, created_at DATETIME DEFAULT NULL, triggered_at DATETIME DEFAULT NULL, INDEX idx_status (status))`,
    // Технофабрика/Вечный аудиториум — снимки из БД (страница читает отсюда, live-запрос к игре
    // только по кнопке "Обновить", как и везде в проекте — раньше страницы дёргали игру напрямую
    // при каждом открытии, из-за чего ломались)
    `CREATE TABLE IF NOT EXISTS tech_factory_status (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), renown_balance DOUBLE DEFAULT NULL, categories TEXT, job TEXT, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_tech_factory_account (account))`,
    `CREATE TABLE IF NOT EXISTS auditorium_status (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), renown TEXT, loyalty TEXT, population TEXT, unlocked TINYINT(1) DEFAULT 0, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_auditorium_account (account))`,
    // 13.10.2026: реверс реального бандла дал больше полей, чем угаданная форма раньше (is_member/
    // economy_unlocked и т.п. нужны странице, чтобы объяснять, почему кнопка недоступна)
    `ALTER TABLE tech_factory_status ADD COLUMN is_member TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN membership_eligible TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN economy_unlocked TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN guild_crystal_balance DOUBLE DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN can_upgrade TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN guild_renown_balance DOUBLE DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN can_spend_guild_renown TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE tech_factory_status ADD COLUMN eligible_members INT DEFAULT NULL`,
    // 13.10.2026: has_factory теперь из САМОГО /tech-factory/overview (доступен ЛЮБОМУ члену
    // гильдии), а не из guild_special_buildings (видна только лидеру/офицеру) — см. модель выше
    `ALTER TABLE tech_factory_status ADD COLUMN has_factory TINYINT(1) DEFAULT NULL`,
    // 14.10.2026: витрина Вечного аудиториума (обмен Почёта на предметы) + флаги из /status
    `ALTER TABLE auditorium_status ADD COLUMN in_guild TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE auditorium_status ADD COLUMN has_auditorium TINYINT(1) DEFAULT NULL`,
    `ALTER TABLE auditorium_status ADD COLUMN catalog LONGTEXT`,
    `CREATE TABLE IF NOT EXISTS daily_reward_snapshot (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), streak INT DEFAULT NULL, last_login VARCHAR(40), rewards TEXT, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_daily_reward_account (account))`,
    // 13.10.2026: last_login — полный ISO-таймстамп от игры, VARCHAR(20) обрезал (1406/22001 в
    // логе, снимок не сохранялся вообще ни разу)
    `ALTER TABLE daily_reward_snapshot MODIFY COLUMN last_login VARCHAR(40)`,
    // очередь автозапуска переработок — своя у каждого аккаунта (см. modules/guildBuildings.js
    // runTechFactoryLoop): pos задаёт порядок, станок свободен → берём запись с наименьшим pos
    `CREATE TABLE IF NOT EXISTS tech_factory_queue (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), machine_id VARCHAR(100), level INT, pos INT, created_at DATETIME DEFAULT NULL, INDEX idx_account_pos (account, pos))`,
    // minigame_log (Судоку/Сапёр/Викторина) исторически никогда не имел уникального ключа —
    // upsert({conflictFields:['account','game','played_at']}) тихо деградировал в обычный INSERT,
    // копились дубли строк за один день, и /api/minigame-status без ORDER BY отдавал их в
    // непредсказуемом порядке — со стороны выглядело как "статус сыграно то есть, то нет". Сначала
    // убираем накопленные дубли (оставляя запись с наибольшим id — самую свежую), потом добавляем
    // сам уникальный ключ, чтобы дубли больше не копились.
    `DELETE m1 FROM minigame_log m1 INNER JOIN minigame_log m2 ON m1.account=m2.account AND m1.game=m2.game AND m1.played_at=m2.played_at AND m1.id<m2.id`,
    `ALTER TABLE minigame_log ADD UNIQUE KEY uniq_minigame (account, game, played_at)`,
    // "Out of range value for column 'reward'" в логе — таблица создавалась не через миграции этого
    // проекта, реальная колонка оказалась уже INT/SMALLINT, награда Викторины в неё не влезала, upsert
    // падал с ошибкой и статус "сыграно" вообще не сохранялся в БД (именно это видел пользователь).
    `ALTER TABLE minigame_log MODIFY reward BIGINT DEFAULT NULL`,
    `ALTER TABLE minigame_log MODIFY score BIGINT DEFAULT NULL`,
    // Действия по городу (страница "Города" → "Действия") — только цели улучшений на аккаунт.
    // UNIQUE сразу в CREATE TABLE (не отдельным ALTER "на будущее") — на этом уже не раз обжигались
    // в этом проекте: conflictFields в upsert без настоящего уникального ограничения в БД тихо
    // деградирует в обычный INSERT и копит дубли строк на аккаунт.
    `CREATE TABLE IF NOT EXISTS city_strategy (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), targets TEXT, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_city_strategy_account (account))`,
    // Ручная приоритетная очередь улучшений (страница "Карта города" → вкладка "Улучшение") —
    // разбирается строителями ПЕРЕД личным планом (targets) и общим планом по семействам.
    `ALTER TABLE city_strategy ADD COLUMN queue TEXT`,
    // Запланированные реконструкции (вкладка "Реконструкция" → "Запланировать") — срабатывают сами,
    // когда здание достигнет required_lvl и не будет занято стройкой.
    `ALTER TABLE city_strategy ADD COLUMN reconstruct_plan TEXT`,
    // Общий план улучшений по семействам зданий (страница "Общий план улучшений") — не привязан к
    // аккаунту, действует на все города, где нет личной цели для конкретной клетки этого семейства.
    `CREATE TABLE IF NOT EXISTS global_upgrade_plan (id INT AUTO_INCREMENT PRIMARY KEY, family_id VARCHAR(255), target_level INT, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_global_family (family_id))`,
    // Автоактивация ускорителей (вкладка "Ускорители") — "всегда держать активным".
    `CREATE TABLE IF NOT EXISTS booster_automation (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), booster_name VARCHAR(50), enabled TINYINT(1) DEFAULT 0, updated_at DATETIME DEFAULT NULL, UNIQUE KEY uniq_booster_automation (account, booster_name))`,
    `ALTER TABLE booster_automation ADD COLUMN queue_pos INT DEFAULT NULL`,
    // Очередь активации: строка = ОДИН экземпляр, повторы одного типа разрешены (потому и нет
    // UNIQUE по (account,booster_name), в отличие от booster_automation). Позиция расходуется.
    `CREATE TABLE IF NOT EXISTS booster_queue (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), booster_name VARCHAR(50), pos INT DEFAULT 0, created_at DATETIME DEFAULT NULL, INDEX idx_account_pos (account, pos))`,
    // Лог действий по городу (вкладка "Лог") — типизированные колонки под частые нужды отображения,
    // detail — JSON под остальное; идёт с прицелом на будущий общий лог всех аккаунтов (тот же
    // запрос без WHERE account).
    `CREATE TABLE IF NOT EXISTS city_action_log (id INT AUTO_INCREMENT PRIMARY KEY, account VARCHAR(255), type VARCHAR(30), x INT DEFAULT NULL, y INT DEFAULT NULL, from_x INT DEFAULT NULL, from_y INT DEFAULT NULL, building_id VARCHAR(255) DEFAULT NULL, level_from INT DEFAULT NULL, level_to INT DEFAULT NULL, duration_ms BIGINT DEFAULT NULL, detail TEXT, created_at DATETIME DEFAULT NULL, INDEX idx_account_created (account, created_at))`,
    // guild_quests раньше был UNIQUE только по guild_id — одна строка на гильдию, последний
    // записавший аккаунт затирал personal_progress всех остальных. Личное условие квеста —
    // per-аккаунт (у каждого своё), общее — одно на гильдию (значение одинаковое у всех, просто
    // дублируется в каждой строке). Нужен отдельный слот на (guild_id,account), иначе при
    // нескольких СВОИХ аккаунтах в одной гильдии (см. автовыполнение квестов) они бы затирали
    // личный прогресс друг друга и заклейм для не-лидеров был бы невозможен.
    `ALTER TABLE guild_quests DROP INDEX guild_id`,
    `ALTER TABLE guild_quests ADD UNIQUE KEY uniq_guild_account (guild_id, account)`,
    // Путь мэра/Дорога верности — локальный расчёт вместо ежедневного живого опроса (см.
    // modules/journey.js, modules/loyalty.js): каталог статичных порогов уровней. Путь мэра
    // сравнивается напрямую с уже известным Account.profit (текущая прибыль/час — условие
    // /mjourney/ это НЕ накопительный счётчик, а именно текущая прибыль, сверено живьём), поэтому
    // отдельный снимок/экстраполяция по времени не нужны.
    `CREATE TABLE IF NOT EXISTS journey_level_defs (level INT PRIMARY KEY, required_profit DOUBLE DEFAULT NULL, updated_at DATETIME DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS loyalty_level_defs (level INT PRIMARY KEY, required_days INT DEFAULT NULL, updated_at DATETIME DEFAULT NULL)`,
    `ALTER TABLE city_snapshot ADD COLUMN unlocked_sections TEXT`,
    // очередь улучшений сначала ошибочно получила UNIQUE(account,x,y) — он запрещал ставить одну
    // и ту же клетку в очередь несколько раз подряд (серия апгрейдов 1→2→3): сохранялась только
    // первая позиция. Снимаем; правильный ключ (account,pos) досоздаёт ensureUpsertKeys ниже.
    'ALTER TABLE city_upgrade_queue DROP INDEX uq_city_upgrade_queue',

    // Лечим уже записанное «[]» в списке разблокированных секций. Пустой список — НЕ валидное

    // состояние (стартовая секция открыта всегда), он попадал туда из старого кода, который

    // отсутствие поля в ответе игры превращал в пустой массив. Карта на таком значении рисует

    // замки на ВСЁМ городе, и никакие обновления это не чинили, пока строка не перезапишется

    // валидным списком. NULL означает «не знаю» — замки не рисуются, а первый нормальный ответ

    // игры проставит реальные секции (см. modules/progress.js unlockedSectionsOf).

    `UPDATE city_snapshot SET unlocked_sections=NULL WHERE unlocked_sections='[]'`,
    'ALTER TABLE market_snipe ADD COLUMN account VARCHAR(255)',
    // Библиотека политик переросла TEXT (65 535 байт): на 19.08.2026 — 62 КБ, и это ещё до
    // следующего обновления игры. Запись падала целиком, снимок политик не сохранялся.
    'ALTER TABLE policy_snapshot MODIFY list LONGTEXT',
    'ALTER TABLE policy_snapshot MODIFY library LONGTEXT',
    'ALTER TABLE policy_snapshot MODIFY cabinet LONGTEXT',
    'ALTER TABLE policy_snapshot MODIFY economy LONGTEXT',
  ];
  for(const sql of migrations){
    try{await seq.query(sql);}catch(_){}
  }
  await ensureUpsertKeys();
  // одноразовый перенос JSON-блобов city_strategy в построчные таблицы — строго ПОСЛЕ
  // ensureUpsertKeys: тот сначала склеивает дубли строк, иначе переносили бы половинчатую строку
  try{await require('./cityPlans').migrateFromBlobs();}
  catch(e){logger.warn(`[db] перенос планов города: ${e.message}`);}
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIQUE-ключи под upsert. Sequelize'овский upsert({...},{conflictFields:[...]}) на MariaDB
// компилируется в INSERT ... ON DUPLICATE KEY UPDATE и работает ТОЛЬКО если по этим колонкам есть
// настоящий UNIQUE-индекс. Без него каждый «upsert» просто ВСТАВЛЯЕТ новую строку, а чтение
// (findOne) отдаёт первую попавшуюся — обычно самую старую. Снаружи это выглядит так: жмёшь
// «Обновить», на миг видишь свежую карту города (её транслирует cityLive), а потом страница
// перечитывает из БД и показывает древний снимок (жалоба 14.08 от чужой установки).
//
// На нашей инсталляции ключи когда-то доставили руками, поэтому проблема не воспроизводилась —
// а на чистой БД (seq.sync() по моделям, где unique не объявлен) их не было вовсе. Теперь код
// доводит схему сам: находит дубликаты, оставляет САМУЮ СВЕЖУЮ строку (max id) и вешает UNIQUE.
// Список — все таблицы, в которые где-либо пишут через conflictFields (см. grep по проекту).
const UPSERT_KEYS=[
  ['city_snapshot',['account']],
  ['capital_snapshot',['guild_id']],
  ['builder_snapshot',['account']],
  ['loyalty_snapshot',['account']],
  ['daily_ads_snapshot',['account']],
  ['market_stats_snapshot',['account']],
  ['policy_snapshot',['account']],
  ['townhall_airdrop',['account']],
  ['townhall_diversity',['account']],
  ['civic_draw_status',['account']],
  ['tech_factory_status',['account']],
  ['auditorium_status',['account']],
  ['city_strategy',['account']],
  ['capital_strategy',['guild_id']],
  ['guild_members_snapshot',['guild_id']],
  ['mid_snapshot',['guild_id']],
  ['quest_tier_snapshot',['guild_id']],
  ['guild_special_buildings',['guild_id']],
  ['guild_snapshot',['account','guild_id']],
  ['guild_quests',['guild_id','account']],
  ['shop_snapshot',['account','type']],
  ['booster_automation',['account','booster_name']],
  ['achievement_log',['account','achievement_id']],
  ['daily_log',['account','logged_at']],
  ['daily_reward_snapshot',['account']],
  ['wordle_log',['account','played_at']],
  ['minigame_log',['account','game','played_at']],
  ['promo_log',['account','code']],
  ['quiz_answers',['question_id','answer_id']],
  ['staking_entries',['entry_id']],
  ['fortune_status',['account_id']],
  ['global_upgrade_plan',['family_id']],
  ['global_capital_upgrade_plan',['family_id']],
  // были только в боевой БД (доставлены руками) — теперь создаются и на чистой установке
  ['accs',['name']],
  ['journey_log',['account','level']],
  ['market_snipe',['offer_id','account_id']],
  // планы города построчно: клетка уникальна в пределах аккаунта
  ['city_upgrade_target',['account','x','y']],
  // очередь — по МЕСТУ в очереди, а не по клетке: одна клетка может стоять несколько раз подряд
  ['city_upgrade_queue',['account','pos']],
  ['city_reconstruct_plan',['account','x','y']],

  ['market_access',['account']],
];

// Дубликаты НЕ ПРОСТО удаляем, а СКЛЕИВАЕМ. Причина: без UNIQUE-ключа каждый upsert вставлял
// новую строку, причём в ней заполнены ТОЛЬКО те колонки, которые пришли с этим сохранением.
// Живой пример из city_strategy: сохранили цели → строка №1 (targets заполнен, reconstruct_plan
// пуст); запланировали реконструкцию → строка №2 (наоборот). Оставить «самую свежую» значило бы
// потерять цели, оставить самую старую — потерять реконструкции; пользователь именно это и видел
// как «здания пропадают то из плана, то из реконструкций». Поэтому в самую свежую строку
// переносим непустые значения из более старых (свежее приоритетнее), а остальные удаляем.
async function mergeDuplicates(table,keyCols){
  // describeTable, а не сырой SHOW COLUMNS: mariadb-драйвер ломает разбор такого ответа
  const desc=await seq.getQueryInterface().describeTable(table);
  const names=Object.keys(desc).filter(f=>f!=='id');
  const rows=await seq.query(`SELECT * FROM \`${table}\` ORDER BY id DESC`,{type:Sequelize.QueryTypes.SELECT});
  const groups=new Map();
  for(const r of rows){
    const key=JSON.stringify(keyCols.map(c=>r[c]));   // без склейки строкой: значения бывают с пробелами
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(r);
  }
  let mergedGroups=0;
  for(const list of groups.values()){
    if(list.length<2)continue;
    const keep=list[0];                       // самая свежая (ORDER BY id DESC)
    const patch={};
    for(const name of names){
      if(keep[name]!==null&&keep[name]!==undefined)continue;
      const donor=list.find(r=>r[name]!==null&&r[name]!==undefined);
      if(donor)patch[name]=donor[name];
    }
    if(Object.keys(patch).length){
      const set=Object.keys(patch).map(k=>`\`${k}\`=?`).join(',');
      await seq.query(`UPDATE \`${table}\` SET ${set} WHERE id=?`,{type:Sequelize.QueryTypes.UPDATE,replacements:[...Object.values(patch),keep.id]});
    }
    const drop=list.slice(1).map(r=>r.id);
    await seq.query(`DELETE FROM \`${table}\` WHERE id IN (${drop.map(()=>'?').join(',')})`,{type:Sequelize.QueryTypes.DELETE,replacements:drop});
    mergedGroups++;
  }
  return mergedGroups;
}

async function ensureUpsertKeys(){
  for(const[table,cols]of UPSERT_KEYS){
    try{
      // ВЕЗДЕ явный type: сырой query() через mariadb-драйвер падает с «Cannot delete property
      // meta of [object Array]» — на этом ensureUpsertKeys молча не создавал НИ ОДНОГО ключа
      // (поймано прогоном на чистой БД 18.08, до него ошибка пряталась в warn-логе).
      const[exists]=await seq.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
        {type:Sequelize.QueryTypes.SELECT,replacements:[table]});
      if(!Number(exists?.n))continue;                      // таблицы ещё нет — создастся моделью
      // уже есть UNIQUE ровно по этим колонкам?
      const idx=await seq.query(
        `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
        {type:Sequelize.QueryTypes.SELECT,replacements:[table]});
      const byName=new Map();
      for(const r of idx)byName.set(r.INDEX_NAME,(byName.get(r.INDEX_NAME)||[]).concat(r.COLUMN_NAME));
      const want=cols.join(',').toLowerCase();
      let ok=false;
      for(const list of byName.values())if(list.join(',').toLowerCase()===want)ok=true;
      if(ok)continue;
      const colList=cols.map(c=>`\`${c}\``).join(',');
      const merged=await mergeDuplicates(table,cols);
      await seq.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`uq_${table}\` (${colList})`,{type:Sequelize.QueryTypes.RAW});
      logger.info(`[db] добавлен UNIQUE ${table}(${cols.join(',')})${merged?`, склеено дублей: ${merged}`:''}`);
    }catch(e){
      // не фатально: без ключа модуль продолжит работать как раньше, но пишем в лог, чтобы было видно
      logger.warn(`[db] не удалось привести к UNIQUE ${table}(${cols.join(',')}): ${e.message}`);
    }
  }
}
module.exports={seq,Account,Inventory,FortuneLog,WordleLog,MinigameLog,QuizAnswer,JourneyLevel,DailyLog,DailyRewardSnapshot,TownhallAirdrop,TownhallDiversity,ShopSnapshot,AchievementSnapshot,PromoLog,CitySnapshot,GuildSnapshot,GuildQuestSnapshot,GuildSpecialBuilding,FortuneStatus,CapitalSnapshot,BuilderSnapshot,LoyaltySnapshot,GuildMembersSnapshot,MidSnapshot,DailyAdsSnapshot,StakingEntry,MarketStatsSnapshot,MarketListing,MarketPurchase,MarketSale,MarketAutobuy,MarketSnipe,PolicySnapshot,CivicDrawStatus,PolicyDefCatalog,SatoshiPosition,SatoshiPositionHistory,SatoshiPendingOrder,QuestTierSnapshot,TechFactoryStatus,TechFactoryQueue,AuditoriumStatus,MarketAccess,CityStrategy,CityUpgradeTarget,CityUpgradeQueue,CityReconstructPlan,SchemaMark,GlobalUpgradePlan,BoosterAutomation,BoosterQueue,CityActionLog,
CapitalStrategy,GlobalCapitalUpgradePlan,CapitalActionLog,JourneyLevelDef,LoyaltyLevelDef,init};
