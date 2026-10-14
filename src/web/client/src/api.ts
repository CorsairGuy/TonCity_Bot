async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  if (r.status === 401) window.dispatchEvent(new CustomEvent('tc-unauthorized'));
  return r.json() as Promise<T>;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

export const api = {
  // maintenance (автопауза запросов к игре во время техработ)
  maintenance: () => req<{ ok: boolean; active: boolean; since: number | null; retryInMs: number }>('/api/maintenance'),

  // проверка новой версии бота на GitHub (только чтение)
  build: () => req<{ ok: boolean; commit: string | null; startedAt: number; busy: boolean }>('/api/build'),
  version: (force = false) => req<VersionInfo>('/api/version' + (force ? '?force=1' : '')),
  // обновление или смена канала через обновлятель (tag не задан — свежий образ текущего канала);
  // если образ новый, бот перезапустится раньше ответа
  update: (force = false, tag?: string) =>
    req<{ ok: boolean; updated?: number; busy?: string[]; error?: string }>('/api/update', post({ force, tag })),

  // auth
  authStatus: () => req<{ ok: boolean; required: boolean; authed: boolean }>('/api/auth/status'),
  login: (password: string) => req<{ ok: boolean; error?: string }>('/api/login', post({ password })),
  logout: () => req<{ ok: boolean }>('/api/logout', post({})),
  setPassword: (password: string) => req<{ ok: boolean; error?: string }>('/api/password', post({ password })),

  // accounts
  accounts: () => req<{ ok: boolean; accounts: Account[] }>('/api/accounts'),
  // точечное обновление одного аккаунта — не тянуть весь флот ради баланса одного (см. SatoshiTower)
  accountById: (id: number) => req<{ ok: boolean; account: Account; error?: string }>(`/api/accounts/${id}`),
  addAccount: (url: string) =>
    req<{ ok: boolean; name?: string; created?: boolean; error?: string }>('/api/accounts/add', post({ url })),
  deleteAccount: (id: number) =>
    req<{ ok: boolean; error?: string }>(`/api/accounts/${id}`, { method: 'DELETE' }),
  // точный детектор задвоенных аккаунтов — по JWT-subject из access_token, не эвристика
  accountDuplicates: () =>
    req<{ ok: boolean; groups: { id: number; name: string }[][]; error?: string }>('/api/accounts/duplicates'),

  // inventory — server returns {byAccount, accIdByName, accValues}
  inventory: () => req<{ ok: boolean; byAccount: Record<string, InventoryItem[]>; accIdByName: Record<string, number>; accValues: Record<string, { coins: number; crystals: number }> }>('/api/inventory'),

  // fortune
  fortuneLog: (date: string) =>
    req<{ ok: boolean; rows: FortuneRow[] }>(`/api/fortune-log?date=${date}`),
  fortuneCanDrawAll: () =>
    req<{ ok: boolean; results: FortuneCanDrawResult[] }>('/api/fortune/can-draw-all'),
  fortuneStatusStored: () =>
    req<{ ok: boolean; results: FortuneCanDrawResult[] }>('/api/fortune/status'),
  fortuneSpinAll: () =>
    req<{ ok: boolean; results: { name: string; ok: boolean; spins?: number; crystals_spent?: number; reward?: unknown; error?: string }[] }>('/api/fortune/spin-all', post()),
  fortuneSpin: (accountId: number) =>
    req<{ ok: boolean; spins?: number; crystals_spent?: number; results?: unknown[]; can_draw?: FortuneCanDrawResult; crystals_remaining?: number; error?: string }>('/api/fortune/spin', post({ account_id: accountId })),

  // daily
  dailyRewards: () => req<{ ok: boolean; accounts: DailyRewardAccount[] }>('/api/daily'),
  // живой статус прямо из игры (снимок в БД мог остаться со вчерашнего дня)
  dailyAdsLiveStatus: () =>
    req<{ ok: boolean; rows: DailyAdsRow[]; error?: string }>('/api/daily-ads/live-status'),
  dailyAdsStatus: () => req<{ ok: boolean; rows: DailyAdsRow[] }>('/api/daily-ads/status'),
  dailyAdsWatch: (accountId: number) =>
    req<{ ok: boolean; claimed: number; reward: number; current: number; limit: number; limit_reached: boolean; error?: string }>('/api/daily-ads/watch', post({ account_id: accountId })),
  dailyAdsWatchAll: () =>
    req<{ ok: boolean; results: { id: number; name: string; ok: boolean; claimed?: number; error?: string }[] }>('/api/daily-ads/watch-all', post()),
  // кто сейчас смотрит рекламу и на каком счётчике — для восстановления прогресса после перезагрузки
  dailyAdsLive: () =>
    req<{ ok: boolean; rows: { account_id: number; current: number; limit: number }[] }>('/api/daily-ads/live'),

  // logs
  logs: (lines: number) => req<{ ok: boolean; logs: string[] }>(`/api/logs?lines=${lines}`),

  // config / settings
  config: () => req<{ ok: boolean; settings: AppConfig }>('/api/config'),
  saveConfig: (settings: Partial<AppConfig>) =>
    req<{ ok: boolean; error?: string }>('/api/config', post(settings)),
  restart: () => req<{ ok: boolean }>('/api/restart', post()),

  // wordle
  wordleLog: (date: string) =>
    req<{ ok: boolean; date: string; rows: WordleRow[] }>(`/api/wordle-status?date=${date}`),
  wordleGuessAll: (word: string) =>
    req<{ ok: boolean; word?: string; error?: string; results?: { name: string; ok: boolean; won?: boolean; skipped?: string; error?: string; attempts?: number }[] }>(
      '/api/wordle/guess-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word }) }),

  // journey
  journey: () => req<{ ok: boolean; accounts: JourneyAccount[] }>('/api/journey'),

  // achievements
  achievements: () =>
    req<{ ok: boolean; achievements: AchievementEntry[] }>('/api/achievements'),

  // promo
  promoHistory: () => req<{ ok: boolean; accounts: PromoAccount[] }>('/api/promo-log'),
  promoActivate: (accountId: number, code: string) =>
    req<{ ok: boolean; success?: boolean; reward?: unknown; error?: string }>('/api/promo/activate', post({ account_id: accountId, code })),
  promoActivateAll: (code: string) =>
    req<{ ok: boolean; results: { name: string; ok: boolean; success?: boolean; reward?: unknown; error?: string }[] }>('/api/promo/activate-all', post({ code })),

  // builders — server: {id, name, count, price_coins, price_stars}
  builders: () => req<{ ok: boolean; rows: BuilderRow[] }>('/api/builders'),
  buyBuilder: (accountId: number, type: string) =>
    req<{ ok: boolean; error?: string }>('/api/builders/buy', post({ account_id: accountId, type })),
  refreshBuildersAll: () =>
    req<{ ok: boolean; rows: BuilderLiveRow[] }>('/api/builders/refresh-all', post({})),

  // loyalty — server: {account_id, account, data: {levels, streak}}. Заклейм — только ботом
  // (modules/loyalty.js), ручной кнопки нет — награду и так надёжно забирает автоматика.
  loyalty: () => req<{ ok: boolean; rows: LoyaltyRow[] }>('/api/loyalty-road'),

  // tech-factory / timeless-auditorium — спецздания гильдии, персональные действия за свой Почёт
  techFactoryAccounts: () => req<{ ok: boolean; accounts: BuildingAccount[] }>('/api/tech-factory/accounts'),
  techFactoryOverview: (accountId: number) =>
    req<{ ok: boolean; error?: string } & Partial<TechFactoryOverview>>(`/api/tech-factory/${accountId}/overview`),
  techFactoryContribute: (accountId: number, category: number, amount: number, source: 'personal' | 'guild' = 'personal') =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/contribute`, post({ category, amount, source })),
  techFactoryStart: (accountId: number, machineId: string, level: number) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/start`, post({ machine_id: machineId, level })),
  techFactoryUpgrade: (accountId: number, machineId: string, level: number) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/upgrade`, post({ machine_id: machineId, level })),
  techFactoryClaim: (accountId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/claim`, post({})),
  techFactoryQueueAdd: (accountId: number, machineId: string, level: number) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/queue`, post({ machine_id: machineId, level })),
  techFactoryQueueRemove: (accountId: number, queueId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/queue/${queueId}`, { method: 'DELETE' }),
  techFactoryQueueReorder: (accountId: number, ids: number[]) =>
    req<{ ok: boolean; error?: string }>(`/api/tech-factory/${accountId}/queue/reorder`, post({ ids })),
  auditoriumAccounts: () => req<{ ok: boolean; accounts: BuildingAccount[] }>('/api/timeless-auditorium/accounts'),
  auditoriumStatus: (accountId: number) =>
    req<{ ok: boolean; error?: string } & Partial<AuditoriumStatus>>(`/api/timeless-auditorium/${accountId}/status`),
  // обмен Почёта на предмет — POST /timeless-auditorium/buy {sku} (эндпоинта /enter у игры нет)
  auditoriumBuy: (accountId: number, sku: string) =>
    req<{ ok: boolean; error?: string; data?: { balance: number; limits: AuditoriumSkuLimits | null; purchasable: boolean } }>(
      `/api/timeless-auditorium/${accountId}/buy`, post({ sku })),

  // guilds — server: {account, guild_id, guild_title, role, benefits, updated_at}
  guilds: () => req<{ ok: boolean; rows: GuildMembership[] }>('/api/guilds'),
  guildQuests: () => req<{ ok: boolean; guilds: GuildQuestGroup[] }>('/api/guild-quests'),
  // живой перезапрос квестов по ВСЕМ аккаунтам (кнопка "Обновить"), в отличие от guildQuests(),
  // которая только читает снимок из БД
  guildQuestsRefresh: () =>
    req<{ ok: boolean; results: { name: string; ok: boolean; count?: number; error?: string }[]; error?: string }>('/api/guild-quests/refresh', post({})),
  // quest — состояние квеста ПОСЛЕ ресинка, приходит и при ok, и при ошибке (страница обновляет
  // по нему строку, иначе на ошибке она залипает со старым is_collected). already:true — награда
  // уже была забрана (см. комментарий в web/routes/dashboards.js).
  guildQuestCollect: (accountId: number, questId: number) =>
    req<{ ok: boolean; error?: string; already?: boolean; quest?: GuildQuest }>(`/api/guild-quests/${accountId}/collect`, post({ quest_id: questId })),
  // ручная активация ускорителя под квест booster_activate (заменила автоматику, см.
  // modules/questAutomation.js) — соблюдает правило игры "пока активен другой тип — нельзя",
  // при блокировке вернёт ok:false с понятной причиной вместо тихой неудачи
  // quest — СВЕЖИЙ снимок квеста после действия (прогресс игра учитывает не мгновенно, сервер ждёт
  // его и только потом отвечает); collected — сработал ли автозаклейм, если оба условия выполнились
  guildQuestActivateBooster: (accountId: number, questId: number) =>
    req<{ ok: boolean; name?: string; quest?: GuildQuest | null; collected?: boolean; error?: string }>(`/api/guild-quests/${accountId}/activate-booster`, post({ quest_id: questId })),
  // ручное комбинирование ускорителей под квест booster_combine — конвертирует ровно один
  // "рецепт" (минимум, нужный для выполнения квеста), правила конверсии — см. modules/boosterAutomation.js
  // покупка бустов гильдии под квест guild_boost — тратит АЛМАЗЫ (POST /guilds/boosts/invoice).
  // Одно нажатие закрывает одно условие целиком: сначала личное, потом общее.
  guildQuestGuildBoost: (accountId: number, questId: number) =>
    req<{ ok: boolean; spent?: number; scope?: 'personal' | 'guild'; quest?: GuildQuest | null; collected?: boolean; error?: string }>(`/api/guild-quests/${accountId}/guild-boost`, post({ quest_id: questId })),
  guildQuestCombineBooster: (accountId: number, questId: number) =>
    req<{ ok: boolean; toName?: string; quest?: GuildQuest | null; collected?: boolean; error?: string }>(`/api/guild-quests/${accountId}/combine-booster`, post({ quest_id: questId })),
  // Уровни гильдейских квестов — новая система обновления 06.07.2026
  questTiers: () => req<{ ok: boolean; guilds: QuestTierGuild[] }>('/api/quest-tiers'),
  questTiersRefresh: (guildId: string) =>
    req<{ ok: boolean; data?: QuestTierData; error?: string }>(`/api/quest-tiers/${encodeURIComponent(guildId)}/refresh`, post({})),
  questTiersRefreshAll: () =>
    req<{ ok: boolean; results?: { guild_id: string; ok: boolean; error?: string }[]; succeeded?: number; total?: number; error?: string }>(
      '/api/quest-tiers/refresh-all', post({})),
  // взнос с ВЫБРАННЫХ пользователем аккаунтов гильдии (Почёт похоже привязан к участнику,
  // не к гильдии целиком — eligible_members в ответе). Тело запроса не подтверждено реверсом —
  // если сервер ответит 400 с другим форматом, текст ошибки покажет фронт, тогда поправим.
  questTiersContributeAll: (guildId: string, tierId: number, amount: number, accounts: string[]) =>
    req<{ ok: boolean; results?: { account: string; ok: boolean; error?: string }[]; succeeded?: number; total?: number; data?: QuestTierData; error?: string }>(
      `/api/quest-tiers/${encodeURIComponent(guildId)}/contribute-all`, post({ tier_id: tierId, amount, accounts })),
  specialBuildings: () => req<{ ok: boolean; rows: SpecialBuildingRow[] }>('/api/special-buildings'),
  specialBuildingsRefresh: () => req<{ ok: boolean; results: { guild: string; ok: boolean; error?: string }[] }>('/api/special-buildings/refresh', post({})),

  // управление гильдией: заявки
  guildApplications: (guildId: string) =>
    req<{ ok: boolean; applications: GuildApplication[]; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/applications`),
  guildAppApprove: (guildId: string, appId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/applications/${appId}/approve`, post({})),
  guildAppReject: (guildId: string, appId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/applications/${appId}/reject`, post({})),
  // управление гильдией: участники
  guildMembers: (guildId: string) =>
    req<{ ok: boolean; members: GuildMember[]; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/members`),
  guildMemberAction: (guildId: string, userId: number, action: 'promote' | 'demote' | 'kick' | 'promote-to-leader') =>
    req<{ ok: boolean; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/members/${action}`, post({ user_id: userId })),
  // управление гильдией: настройки
  guildSettings: (guildId: string) =>
    req<{ ok: boolean; settings: GuildSettings; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/settings`),
  guildSaveSettings: (guildId: string, payload: GuildSettingsPayload) =>
    req<{ ok: boolean; error?: string }>(`/api/guild/${encodeURIComponent(guildId)}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),

  // capitals — server: {rows: [{guild_id, guild_title, buildings, coins, economic_strength, updated_at}]}
  capitals: () => req<{ ok: boolean; rows: CapitalRow[] }>('/api/capital-snapshots'),

  // city — server: {rows: [{account, buildings, updated_at}]}
  city: () => req<{ ok: boolean; rows: CityRow[] }>('/api/city-snapshots'),

  // Действия по городу (страница "Города" → "Действия") — заменяет автоматику по эталонному плану
  buildingsList: (type: 'city' | 'capital' = 'city') =>
    req<{ ok: boolean; buildings: BuildingDef[] }>(`/api/buildingslist?type=${type}`),
  cityStrategy: (account: string) =>
    req<{ ok: boolean; targets: CityStrategyTarget[]; queue: CityStrategyQueueItem[]; reconstructPlan: CityStrategyQueueItem[]; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}`),
  saveCityStrategy: (account: string, targets: CityStrategyTarget[]) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}`, post({ targets })),
  // ручная приоритетная очередь улучшений — разбирается строителями ПЕРЕД личным/общим планом
  saveCityQueue: (account: string, queue: CityStrategyQueueItem[]) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/queue`, post({ queue })),
  // запланированные реконструкции — сработают сами, когда здание достигнет required_lvl и не будет
  // занято стройкой (см. modules/progress.js runPendingReconstructions)
  saveReconstructPlan: (account: string, plan: CityStrategyQueueItem[]) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/reconstruct-plan`, post({ plan })),
  // общий (глобальный) план улучшений по семействам зданий — не привязан к аккаунту
  globalUpgradePlan: () =>
    req<{ ok: boolean; plan: GlobalUpgradeRule[]; error?: string }>('/api/global-upgrade-plan'),
  saveGlobalUpgradePlan: (plan: GlobalUpgradeRule[]) =>
    req<{ ok: boolean; error?: string }>('/api/global-upgrade-plan', post({ plan })),
  // живое обновление карты с игры (не из кэша БД) — кнопка "Обновить" на странице карты города
  cityRefresh: (account: string) =>
    req<{ ok: boolean; buildings: MapBuilding[]; unlockedSections: string[]; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/refresh`, post({})),
  // статический каталог секций карты (закрытые территории) — общий для всех городов, не меняется
  sections: () => req<{ ok: boolean; sections: MapSection[] }>('/api/sections'),
  // запас компонентов/мастерпланов (вкладки "Реконструкция"/"Реновация") — из БД (Inventory), без живого запроса
  cityResources: (account: string) =>
    req<{ ok: boolean; components: number; masterplans: number; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/resources`),
  // гильдийская скидка на постройку зданий (building_purchases_discount из /guilds/benefits) —
  // отдельная от скидки политик, см. cityStrategy.js
  cityGuildBenefits: (account: string) =>
    req<{ ok: boolean; building_purchases_discount: number; upgrades_discount: number; income_boost: number; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/guild-benefits`),
  // бонус "Разнообразие" — читается ИЗ БД (TownhallDiversity, тот же снимок modules/townhall.js
  // опрашивает на своём цикле для страницы "Ратуша"), без единого живого запроса. income_bonus —
  // сырое число (0.1 = +10%)
  cityDiversity: (account: string) =>
    req<{ ok: boolean; income_bonus: number; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/diversity`),
  // живой критерий доступности построек (GET /buildings/criteria в самой игре) — форма ответа не
  // задокументирована на клиенте, поэтому типизируем как unknown и разбираем защитным кодом
  cityBuildCriteria: (account: string) =>
    req<{ ok: boolean; criteria: unknown; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/build-criteria`),
  // ускорители — читаются только из БД, единственный живой запрос всего раздела — сама активация
  cityBoosters: (account: string) =>
    req<{ ok: boolean; boosters: CityBoosterRow[]; queue?: { name: string; label: string }[]; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/boosters`),
  // очередь активации: шлём ВЕСЬ порядок разом (что не в массиве — выбывает из очереди)
  saveBoosterQueue: (account: string, order: string[]) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/boosters/queue`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }),
  saveBoosterAuto: (account: string, name: string, enabled: boolean) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/boosters/${encodeURIComponent(name)}/auto`, post({ enabled })),
  activateBooster: (account: string, name: string) =>
    req<{ ok: boolean; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/boosters/${encodeURIComponent(name)}/activate`, post({})),
  // единственный живой запрос к игре во всей вкладке — разовая сверка по кнопке "Проверить"
  checkBoosters: (account: string) =>
    req<{ ok: boolean; error?: string; added?: number }>(`/api/city-strategy/${encodeURIComponent(account)}/boosters/check`, post({})),
  // лог действий по городу
  cityActionLog: (account: string, limit = 200) =>
    req<{ ok: boolean; rows: CityActionLogRow[]; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/action-log?limit=${limit}`),
  // прогноз действий бота на ближайшие ~3 суток — единственный живой запрос: реальные end/level/
  // coins/builders, дальше чистая симуляция на бэке (см. modules/progress.js simulateFutureActions)
  cityForecast: (account: string) =>
    req<{ ok: boolean; events: ForecastEvent[]; boosterTimeline?: ForecastBoosterWindow[] | null; mods?: ForecastMods; actualVsPredicted?: ForecastDiag; error?: string }>(`/api/city-strategy/${encodeURIComponent(account)}/forecast`),
  cityActionBuild: (account: string, family_id: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/build`, post({ family_id, x, y })),
  cityActionMove: (account: string, from: { x: number; y: number }, to: { x: number; y: number }) =>
    req<{ ok: boolean; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/move`, post({ from, to })),
  cityActionDemolish: (account: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/demolish`, post({ x, y })),
  cityActionReconstruct: (account: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/reconstruct`, post({ x, y })),
  cityActionRenovate: (account: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/renovate`, post({ x, y })),
  // разблокировка закрытой секции карты — единственное действие с ОТДЕЛЬНЫМ игровым эндпоинтом
  // (/progress/unlock-section, не общий /progress/ массив), см. web/routes/cityStrategy.js
  cityActionUnlockSection: (account: string, section_id: string) =>
    req<{ ok: boolean; unlockedSections?: string[]; error?: string }>(`/api/city-actions/${encodeURIComponent(account)}/unlock-section`, post({ section_id })),

  // Действия по столице (страница "Карта города" → тип столица) — та же архитектура, что и у
  // города, минус Реконструкция/Реновация/Ускорители, плюс Снос; guildTitle вместо account, см.
  // web/routes/capitalStrategy.js
  capitalStrategy: (guildTitle: string) =>
    req<{ ok: boolean; targets: CapitalStrategyTarget[]; queue: CapitalStrategyQueueItem[]; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}`),
  saveCapitalStrategy: (guildTitle: string, targets: CapitalStrategyTarget[]) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}`, post({ targets })),
  saveCapitalQueue: (guildTitle: string, queue: CapitalStrategyQueueItem[]) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}/queue`, post({ queue })),
  capitalRefresh: (guildTitle: string) =>
    req<{ ok: boolean; buildings: MapBuilding[]; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}/refresh`, post({})),
  capitalActionLog: (guildTitle: string, limit = 200) =>
    req<{ ok: boolean; rows: CapitalActionLogRow[]; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}/action-log?limit=${limit}`),
  capitalForecast: (guildTitle: string) =>
    req<{ ok: boolean; events: ForecastEvent[]; error?: string }>(`/api/capital-strategy/${encodeURIComponent(guildTitle)}/forecast`),
  globalCapitalUpgradePlan: () =>
    req<{ ok: boolean; plan: GlobalUpgradeRule[]; error?: string }>('/api/global-capital-upgrade-plan'),
  saveGlobalCapitalUpgradePlan: (plan: GlobalUpgradeRule[]) =>
    req<{ ok: boolean; error?: string }>('/api/global-capital-upgrade-plan', post({ plan })),
  capitalActionBuild: (guildTitle: string, family_id: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-actions/${encodeURIComponent(guildTitle)}/build`, post({ family_id, x, y })),
  capitalActionMove: (guildTitle: string, from: { x: number; y: number }, to: { x: number; y: number }) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-actions/${encodeURIComponent(guildTitle)}/move`, post({ from, to })),
  capitalActionDemolish: (guildTitle: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-actions/${encodeURIComponent(guildTitle)}/demolish`, post({ x, y })),
  // ускорить текущую стройку здания за алмазы (только столица, см. capitalStrategy.js) — цену
  // определяет сама игра по факту (зависит от оставшегося времени на момент запроса)
  capitalActionSkipUpgrade: (guildTitle: string, x: number, y: number) =>
    req<{ ok: boolean; error?: string }>(`/api/capital-actions/${encodeURIComponent(guildTitle)}/skip-upgrade`, post({ x, y })),

  // shop — single endpoint
  shop: () => req<{ ok: boolean; accounts: ShopAccountRaw[] }>('/api/shop'),

  // townhall — single endpoint with airdrop + diversity
  townhall: () => req<{ ok: boolean; accounts: TownhallAccount[] }>('/api/townhall'),

  // городской розыгрыш (civic_draw из /progress/diversity) — обновляется тем же api.refresh('townhall')
  civicDraw: () => req<{ ok: boolean; accounts: CivicDrawAccount[]; error?: string }>('/api/civic-draw'),
  civicDrawClaimAll: () =>
    req<{ ok: boolean; results?: { account: string; ok: boolean; result?: unknown; error?: string }[]; succeeded?: number; total?: number; error?: string }>(
      '/api/civic-draw/claim-all', post({})),

  // staking
  staking: (includeCollected = false) =>
    req<{ ok: boolean; entries: StakingEntryRow[]; accounts: StakingAccountInfo[] }>(
      `/api/staking${includeCollected ? '?collected=1' : ''}`
    ),
  stakingStake: (accountId: number, currency: 'coins' | 'crystals', amount: number, duration: number) =>
    req<{ ok: boolean; error?: string }>('/api/staking/stake', post({ account_id: accountId, currency, amount, duration })),
  stakingCancel: (entryId: number) =>
    req<{ ok: boolean; error?: string; result?: { amount?: number } }>('/api/staking/cancel', post({ entry_id: entryId })),

  // МИД live
  midOverview: (guildId: string) =>
    req<MidLiveData & { updated_at?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/overview`),
  midRefresh: (guildId: string) =>
    req<MidLiveData & { updated_at?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/refresh`, post()),
  midSearch: (guildId: string, q: string, type: 'alliances' | 'enemies', page = 1) =>
    req<{ ok: boolean; guilds: MidSearchGuild[]; total: number | null }>(`/api/mid-live/${encodeURIComponent(guildId)}/search?q=${encodeURIComponent(q)}&type=${type}&page=${page}`),
  midAllianceSend: (guildId: string, targetGuildId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/send`, post({ target_guild_id: targetGuildId })),
  midAllianceAccept: (guildId: string, requestId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/accept`, post({ request_id: requestId })),
  midAllianceReject: (guildId: string, requestId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/reject`, post({ request_id: requestId })),
  midAllianceCancel: (guildId: string, requestId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/cancel`, post({ request_id: requestId })),
  midAllianceBreak: (guildId: string, allyGuildId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/break`, post({ ally_guild_id: allyGuildId })),
  midAllianceUpgrade: (guildId: string, allyGuildId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/alliance/upgrade`, post({ ally_guild_id: allyGuildId })),
  midEnemyAdd: (guildId: string, enemyGuildId: number, tariffLevel: string) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/enemy/add`, post({ enemy_guild_id: enemyGuildId, tariff_level: tariffLevel })),
  midEnemyRemove: (guildId: string, enemyGuildId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/enemy/remove`, post({ enemy_guild_id: enemyGuildId })),
  midEnemyUpdateTariff: (guildId: string, enemyGuildId: number, tariffLevel: string) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/enemy/update-tariff`, post({ enemy_guild_id: enemyGuildId, tariff_level: tariffLevel })),
  midCampaignsStart: (guildId: string, targetGuildId: number, durationHours: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/campaigns/start`, post({ target_guild_id: targetGuildId, duration_hours: durationHours })),
  midCampaignsDeploy: (guildId: string, campaignId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/campaigns/deploy`, post({ campaign_id: campaignId })),
  midCampaignsCallToArms: (guildId: string, campaignId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/campaigns/call-to-arms`, post({ campaign_id: campaignId })),
  midInvitationsBuy: (guildId: string, packageIndex: number) =>
    req<{ ok: boolean; error?: string }>(`/api/mid-live/${encodeURIComponent(guildId)}/invitations/buy`, post({ package_index: packageIndex })),

  // каталог предметов игры (id → тип/имя/редкость), см. src/utils/itemCatalog.js
  items: (ids?: number[]) =>
    req<{ ok: boolean; items: { item_id: number; type: string | null; name: string | null; rarity: string | null; title?: string | null; tag?: string | null }[] }>(
      `/api/items${ids?.length ? `?ids=${ids.join(',')}` : ''}`),

  // generic refresh
  refresh: (module: string) =>
    req<{ ok: boolean; results?: unknown[] }>(`/api/refresh/${module}`, post()),

  // статус фоновых "Обновить"-операций — переживают перезагрузку страницы (см. useResumableRefresh)
  opStatus: (keys: string[]) =>
    req<{ ok: boolean; running: Record<string, boolean> }>(`/api/op-status?keys=${keys.map(encodeURIComponent).join(',')}`),

  // shop live
  shopBoosters: (ids?: number[]) =>
    req<ShopLiveResponse>(`/api/shop-live/boosters${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  shopPacks: (ids?: number[]) =>
    req<ShopLiveResponse>(`/api/shop-live/packs${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  shopPolicies: (ids?: number[]) =>
    req<ShopLiveResponse>(`/api/shop-live/policies${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  // syncPolicies=true — только магазин политик: покупка может дать карту политики (её нет в обычном
  // складе). Сервер после покупки сам обновляет инвентарь в БД, чтобы страницы предметов/политик
  // показали покупку без ручного "Обновить".
  shopBuy: (accountId: number, offerId: number, amount: number, offerType: ShopOfferType, syncPolicies?: boolean) =>
    req<ShopBuyResponse>('/api/shop-live/buy', post({ account_id: accountId, offer_id: offerId, amount, offer_type: offerType, sync_policies: syncPolicies })),
  shopBuyAll: (accountIds: number[], offerId: number, offerType: ShopOfferType, syncPolicies?: boolean) =>
    req<ShopBuyAllResponse>('/api/shop-live/buy-all', post({ account_ids: accountIds, offer_id: offerId, offer_type: offerType, sync_policies: syncPolicies })),
  // магазин билетов: те же три витрины, но только офферы с offer_type='tickets'
  shopTickets: (ids?: number[]) =>
    req<ShopLiveResponse>(`/api/shop-live/tickets${ids?.length ? `?ids=${ids.join(',')}` : ''}`),

  // ── Годовщина: событие «Летний карнавал» (10-23.08.2026) ────────────────────
  // ids — добрать только перечисленные аккаунты (повтор сбойных без опроса всех остальных)
  anniversaryEvent: (ids?: number[]) =>
    req<AnniversaryEventResponse>(`/api/anniversary/event${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  // board/road/ladder в ответе — свежие данные ИМЕННО ЭТОГО аккаунта, перечитанные сразу после
  // сбора: страница подставляет их в свою строку (виден прогресс следующей ступени) и не гоняет
  // полный живой проход по всем аккаунтам
  anniversaryEventClaim: (accountId: number, tierId: number) =>
    req<{ ok: boolean; reward?: number | null; board?: Omit<AnniversaryBoard, 'id' | 'name'> | null; error?: string }>('/api/anniversary/event/claim', post({ account_id: accountId, tier_id: tierId })),
  anniversaryEventClaimAll: () =>
    req<{ ok: boolean; results: AnniversaryClaimResult[]; error?: string }>('/api/anniversary/event/claim-all', post({})),
  anniversaryMilestones: (ids?: number[]) =>
    req<AnniversaryRoadResponse>(`/api/anniversary/milestones${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  // выполнение заданий события: реклама и мини-игры. Работа фоновая — ручка только ставит в
  // очередь, прогресс приходит из anniversaryTasksStatus (страница опрашивает его раз в 5с)
  anniversaryTasksRun: (accountId: number, opts?: { ad?: boolean; minigames?: boolean; guild?: boolean; login?: boolean }) =>
    req<{ ok: boolean; started?: boolean; error?: string }>('/api/anniversary/tasks/run', post({ account_id: accountId, ...opts })),
  anniversaryTasksRunAll: (opts?: { ad?: boolean; minigames?: boolean; guild?: boolean; account_ids?: number[] }) =>
    req<{ ok: boolean; started?: number; error?: string }>('/api/anniversary/tasks/run-all', post({ ...opts })),
  // Хранилище призов: состояние поля и вращение (тратит билеты — только по кнопке у аккаунта)
  anniversaryVault: (ids?: number[]) =>
    req<AnniversaryVaultResponse>(`/api/anniversary/vault${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  anniversaryVaultSpin: (accountId: number) =>
    req<AnniversaryVaultSpinResponse>('/api/anniversary/vault/spin', post({ account_id: accountId })),
  // одно вращение на каждый переданный аккаунт; сервер сам перепроверяет, хватает ли билетов
  anniversaryVaultSpinAll: (accountIds: number[]) =>
    req<{ ok: boolean; results: AnniversaryVaultSpinAllRow[]; error?: string }>(
      '/api/anniversary/vault/spin-all', post({ account_ids: accountIds })),
  // Карнавальная аллея (19-24.08): балаганы по дням, «Четыре в ряд» на билеты.
  // Игра идёт в фоне на сервере — прогресс кнопок берётся из midwayStatus, поэтому
  // спиннеры переживают перезагрузку страницы.
  midway: (ids?: number[]) =>
    req<MidwayResponse>(`/api/midway${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  midwayPlay: (accountId: number) =>
    req<{ ok: boolean; started?: boolean; error?: string }>('/api/midway/play', post({ account_id: accountId })),
  midwayPlayAll: (accountIds?: number[]) =>
    req<{ ok: boolean; started?: number; error?: string }>('/api/midway/play-all', post({ account_ids: accountIds })),
  midwayStatus: () =>
    req<{ ok: boolean; rows: MidwayRun[] }>('/api/midway/status'),
  anniversaryTasksStatus: () =>
    req<{ ok: boolean; rows: CarnivalTaskRun[] }>('/api/anniversary/tasks/status'),
  anniversaryMilestoneClaim: (accountId: number, stage: number) =>
    req<{ ok: boolean; road?: AnniversaryRoad | null; error?: string }>('/api/anniversary/milestones/claim', post({ account_id: accountId, stage })),
  anniversaryMilestoneClaimAll: () =>
    req<{ ok: boolean; results: AnniversaryClaimResult[]; error?: string }>('/api/anniversary/milestones/claim-all', post({})),
  anniversaryOffers: (ids?: number[]) =>
    req<AnniversaryOffersResponse>(`/api/anniversary/offers${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  anniversaryOfferBuy: (accountId: number, paymentMethod: 'coins' | 'crystals') =>
    req<{ ok: boolean; balance?: ShopBalance | null; error?: string }>('/api/anniversary/offers/buy', post({ account_id: accountId, payment_method: paymentMethod })),
  anniversaryLadderClaim: (accountId: number, rung: number) =>
    req<{ ok: boolean; tickets?: number | null; offer?: AnniversaryOffer | null; ladder?: AnniversaryLadder | null; error?: string }>('/api/anniversary/offers/ladder/claim', post({ account_id: accountId, rung })),
  anniversaryLadderClaimAll: () =>
    req<{ ok: boolean; results: AnniversaryClaimResult[]; error?: string }>('/api/anniversary/offers/ladder/claim-all', post({})),

  // Оплот Мудрости: Сапёр и Судоку (авто-решение + награда)
  minesweeperSolve: (accountId: number) =>
    req<MinigameSolveResult>('/api/minesweeper/solve', post({ account_id: accountId })),
  minesweeperSolveAll: () =>
    req<{ ok: boolean; results: MinigameAllResult[] }>('/api/minesweeper/solve-all', post({})),
  sudokuSolve: (accountId: number, difficulty?: string) =>
    req<MinigameSolveResult>('/api/sudoku/solve', post({ account_id: accountId, difficulty })),
  sudokuSolveAll: (difficulty?: string) =>
    req<{ ok: boolean; results: MinigameAllResult[] }>('/api/sudoku/solve-all', post({ difficulty })),
  // Центральный рынок
  marketStats: () => req<{ ok: boolean; rows: MarketStatsRow[] }>('/api/market-stats'),
  marketStatsRefresh: () =>
    req<{ ok: boolean; results: { name: string; ok: boolean; error?: string }[] }>('/api/market-stats/refresh', post({})),
  marketDeals: (type: 'listings' | 'purchases' | 'sales') =>
    req<{ ok: boolean; rows: MarketDealRow[] }>(`/api/market-deals?type=${type}`),
  marketDealsRefresh: (type: 'listings' | 'purchases' | 'sales') =>
    req<{ ok: boolean; results: { name: string; ok: boolean; count?: number; error?: string }[] }>('/api/market-deals/refresh', post({ type })),
  marketOffers: (params: { categories?: string; rarities?: string; currencies?: string; market_types?: string; sort?: string; page?: number; page_size?: number }) =>
    req<{ ok: boolean; offers: MarketOffer[]; pagination: { page: number; page_size: number; total: number } }>(`/api/market/offers?${new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])
    ).toString()}`),
  // ВАЖНО: только через хелпер post() — он ставит Content-Type: application/json. Раньше эти два
  // вызова собирали RequestInit вручную и заголовок теряли, из-за чего express.json() не парсил
  // тело, req.body приходил пустым и сервер отвечал «account_id, auction_id, amount обязательны»
  // при полностью заполненной форме (ставка на аукционе вообще не работала).
  marketAuctionBid: (body: { account_id: number; auction_id: number; amount: number; anonymous?: boolean }) =>
    req<{ ok: boolean; result?: unknown; error?: string }>('/api/market/auction/bid', post(body)),
  marketNegotiationOffer: (body: { account_id: number; listing_id: number; amount: number; currency: string; anonymous?: boolean }) =>
    req<{ ok: boolean; result?: unknown; error?: string }>('/api/market/negotiation/offer', post(body)),
  marketTonBalances: () =>
    req<{ ok: boolean; balances: { id: number; name: string; ton: number | null }[] }>('/api/market/ton-balances'),
  marketBuy: (offerId: number, accountIds: number[]) =>
    req<{ ok: boolean; results: { id: number; name: string; ok: boolean; error?: string }[] }>('/api/market/buy', post({ offer_id: offerId, account_ids: accountIds })),
  marketAutoBuy: (p: { categories?: string; rarities?: string; currency: string; max_price: number; max_budget?: number; account_ids: number[] }) =>
    req<{ ok: boolean; available: number; planned: number; spent: number; results: { offer_id: number; account_id: number; name: string; price: number; ok: boolean; error?: string }[] }>('/api/market/auto-buy', post(p)),
  // правила автопокупки (CRUD)
  marketAutobuyList: () => req<{ ok: boolean; rules: MarketAutobuyRule[] }>('/api/market/autobuy'),
  marketAutobuyCreate: (rule: Partial<MarketAutobuyRule>) => req<{ ok: boolean; id: number }>('/api/market/autobuy', post(rule)),
  marketAutobuyUpdate: (id: number, patch: Partial<MarketAutobuyRule> & { reset_spent?: boolean }) =>
    req<{ ok: boolean }>(`/api/market/autobuy/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  marketAutobuyDelete: (id: number) => req<{ ok: boolean }>(`/api/market/autobuy/${id}`, { method: 'DELETE' }),
  marketSnipe: (p: { offer_id: number; account_id: number; item_id?: number; currency?: string; price?: number; available_at: string }) =>
    req<{ ok: boolean; id?: number; error?: string }>('/api/market/snipe', post(p)),
  marketSnipeList: () => req<{ ok: boolean; snipes: MarketSnipeRow[] }>('/api/market/snipe'),
  marketSnipeDelete: (id: number) => req<{ ok: boolean }>(`/api/market/snipe/${id}`, { method: 'DELETE' }),
  marketSellable: (accountId: number, mode?: 'items' | 'special') =>
    req<{ ok: boolean; items: MarketSellableItem[] }>(`/api/market/sellable?account_id=${accountId}${mode ? `&mode=${mode}` : ''}`),
  // mode='items' (по умолчанию) — обычные предметы, БЕЗ живого /policies/, как на странице "Предметы".
  // mode='special' — ТОЛЬКО политики+осколки, всегда живой запрос к /policies/ (карты политик не
  // хранятся в обычном сторедже — см. web/routes/market.js). Разделено 31.07.2026 по просьбе
  // пользователя — раньше один и тот же путь пытался покрыть и то, и другое разом.
  marketSellableAll: (accountIds?: number[], mode?: 'items' | 'special') =>
    req<{ ok: boolean; items: MarketSellableItem[] }>(`/api/market/sellable-all?${[
      accountIds && accountIds.length ? `account_ids=${accountIds.join(',')}` : '',
      mode ? `mode=${mode}` : '',
    ].filter(Boolean).join('&')}`),
  marketItemAccounts: (itemId: number, rarity?: string, defId?: number | string) =>
    req<{ ok: boolean; accounts: { id: number; name: string; owned: number }[] }>(`/api/market/item-accounts?item_id=${itemId}${rarity ? `&rarity=${rarity}` : ''}${defId != null ? `&def_id=${defId}` : ''}`),
  marketList: (p: { account_id: number; market_id: number; price: number; currency: string; anonymous?: boolean; listing_days?: number }) =>
    req<{ ok: boolean; result?: unknown; error?: string }>('/api/market/list', post(p)),
  marketListSpread: (p: { market_id: number; item_id: number; item_rarity?: string; def_id?: number | string; market_type?: 'direct' | 'auction' | 'negotiation'; price?: number; currency: string; anonymous?: boolean; quantity: number; account_ids?: number[]; listing_days?: number }) =>
    req<{ ok: boolean; listed?: number; requested?: number; error?: string; results?: { name: string; listed: number; skip?: string; error?: string }[] }>('/api/market/list-spread', post(p)),
  marketCancelListing: (account: string, offer_id: number) =>
    req<{ ok: boolean; error?: string }>('/api/market/listing/cancel', post({ account, offer_id })),
  marketCancelAllListings: (account?: string) =>
    req<{ ok: boolean; count?: number; error?: string; results?: { account: string; listing_id: number; ok: boolean; error?: string }[] }>(
      '/api/market/listings/cancel-all', post(account && account !== 'all' ? { account } : {})),

  minigameStatus: (game: 'minesweeper' | 'sudoku' | 'quiz' | '2048') =>
    req<{ ok: boolean; rows: MinigameStatusRow[] }>(`/api/minigame-status?game=${game}`),
  quizSolve: (accountId: number) =>
    req<{ ok: boolean; started?: boolean; error?: string }>('/api/quiz/solve', post({ account_id: accountId })),
  quizSolveAll: () =>
    req<{ ok: boolean; started?: boolean }>('/api/quiz/solve-all', post({})),
  // кто сейчас решает и на каком вопросе — для восстановления прогресса после перезагрузки страницы
  quizLive: () =>
    req<{ ok: boolean; rows: { account_id: number; current: number; total: number }[] }>('/api/quiz/live'),

  // 2048 (Оплот Мудрости) — живая игра в модалке, не решается вслепую на сервере целиком
  game2048State: (accountId: number) =>
    req<{ ok: boolean; board: number[][]; score: number; max_tile: number; game_status: Game2048Status; error?: string }>(`/api/game2048/${accountId}`),
  game2048Move: (accountId: number, direction: Game2048Direction) =>
    req<{ ok: boolean; board: number[][]; score: number; max_tile: number; game_status: Game2048Status; reward?: number; error?: string }>(`/api/game2048/${accountId}/move`, post({ direction })),
  // кто сейчас доигрывается в фоне (см. web/lib/game2048Progress.js) — переживает перезагрузку
  // страницы/закрытие вкладки, не завязано на конкретное SSE-соединение
  game2048Live: () =>
    req<{ ok: boolean; rows: { account_id: number; board: number[][]; score: number; max_tile: number; game_status: Game2048Status }[] }>('/api/game2048/live'),
  game2048Stop: (accountId: number) =>
    req<{ ok: boolean }>(`/api/game2048/${accountId}/stop`, post({})),

  // storage live
  storageLive: (accountId: number) =>
    req<StorageLiveResponse>(`/api/storage-live/${accountId}`),
  storageSell: (accountId: number, itemId: number, amount: number) =>
    req<StorageActionResponse>(`/api/storage-live/${accountId}/sell`, post({ item_id: itemId, amount })),
  storageActivate: (accountId: number, itemId: number) =>
    req<StorageActionResponse>(`/api/storage-live/${accountId}/activate`, post({ item_id: itemId })),
  storageCombine: (accountId: number, fromItemId: number, amount: number) =>
    req<StorageActionResponse>(`/api/storage-live/${accountId}/combine`, post({ from_item_id: fromItemId, amount })),
  storageOpenPack: (accountId: number, itemId: number) =>
    req<StorageActionResponse>(`/api/storage-live/${accountId}/open-pack`, post({ item_id: itemId })),
  storageSetTarget: (accountId: number, packId: number, targetItemId: number) =>
    req<StorageActionResponse>(`/api/storage-live/${accountId}/set-target`, post({ pack_id: packId, target_item_id: targetItemId })),
  // синхронизировать инвентарь аккаунта в БД с игры (после расхода предметов)
  storageSync: (accountId: number) =>
    req<{ ok: boolean; error?: string }>(`/api/storage-live/${accountId}/sync`, post({})),

  // policies (Кабинет мэра / Библиотека политик) — читается из БД, как и /api/inventory
  policies: () =>
    req<{ ok: boolean; byAccount: Record<string, PoliciesAccountData>; accIdByName: Record<string, number>; error?: string }>('/api/policies'),
  policyAction: (accountId: number, action: PolicyActionName, payload: Record<string, unknown> = {}) =>
    req<PolicyActionResponse>(`/api/policies/${accountId}/action`, post({ action, ...payload })),

  // "Библиотека политик" (Мэрия) — накопленный каталог описаний со всех аккаунтов бота
  policyDefs: () =>
    req<{ ok: boolean; defs: PolicyDefEntry[]; totalsByRarity: Record<string, number>; error?: string }>('/api/policy-defs'),

  // Башня Сатоши — курс/свечи ДВУХ живых источников (source: 'exchange' | 'game'), позиции — из БД
  satoshiPrice: (source: SatoshiFeedSource = 'exchange') =>
    req<{ ok: boolean; price: number; change_percent: number; source: string; timestamp: number; error?: string }>(`/api/satoshi/price?source=${source}`),
  satoshiCandles: (timeframe: SatoshiTimeframe, limit = 300, source: SatoshiFeedSource = 'exchange') =>
    req<{ ok: boolean; candles: SatoshiCandle[]; error?: string }>(`/api/satoshi/candles?timeframe=${timeframe}&limit=${limit}&source=${source}`),
  satoshiConfig: () =>
    req<{ ok: boolean; config: SatoshiConfig; error?: string }>('/api/satoshi/config'),
  // разделено на три независимых пути (см. web/routes/satoshi.js): открытые позиции живые и
  // маленькие, закрытые — серверная пагинация (тянем только нужную страницу), прибыль — готовый
  // агрегат из БД, без самих строк
  satoshiOpenPositions: () =>
    req<{ ok: boolean; open: SatoshiOpenPosition[]; error?: string }>('/api/satoshi/open'),
  satoshiHistory: (page: number, pageSize: number) =>
    req<{ ok: boolean; history: SatoshiHistoryPosition[]; total: number; error?: string }>(`/api/satoshi/history?page=${page}&pageSize=${pageSize}`),
  satoshiProfitSummary: () =>
    req<{ ok: boolean; daily: number; weekly: number; error?: string }>('/api/satoshi/profit-summary'),
  // Какие АБСОЛЮТНЫЕ цены уйдут в игру как take_profit_price/stop_loss_price. Игра принимает
  // только цену, а вводить можно в ROI%/«% движения» — считает сервер тем же кодом, что и само
  // открытие (utils/satoshiTriggers), чтобы показанное совпадало с отправленным.
  satoshiTriggerPreview: (p: { side: 'long' | 'short'; leverage: number; margin: number; price?: number } & SatoshiTpSl) =>
    req<{ ok: boolean; entry: number | null; take_profit_price: number | null; stop_loss_price: number | null; error?: string }>('/api/satoshi/trigger-preview', post(p)),
  satoshiOpen: (accountId: number, side: 'long' | 'short', leverage: number, margin: number, tpSl?: SatoshiTpSl) =>
    req<{ ok: boolean; result?: unknown; error?: string }>(`/api/satoshi/${accountId}/open`, post({ side, leverage, margin, ...tpSl })),
  satoshiClose: (accountId: number, positionId: number) =>
    req<{ ok: boolean; result?: unknown; error?: string }>(`/api/satoshi/${accountId}/close`, post({ position_id: positionId })),
  satoshiUpdateTpSl: (positionId: number, tpSl: SatoshiTpSl) =>
    req<{ ok: boolean; error?: string }>(`/api/satoshi/positions/${positionId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tpSl) }),

  // условные ордера ("открыть по цене") — следят за биржевым курсом, открывают в игре при срабатывании
  satoshiPending: () =>
    req<{ ok: boolean; orders: SatoshiPendingOrder[]; error?: string }>('/api/satoshi/pending'),
  satoshiCreatePending: (accountId: number, side: 'long' | 'short', leverage: number, margin: number, triggerPrice: number, tpSl?: SatoshiTpSl) =>
    req<{ ok: boolean; id?: number; error?: string }>(`/api/satoshi/${accountId}/pending`, post({ side, leverage, margin, trigger_price: triggerPrice, ...tpSl })),
  satoshiCancelPending: (id: number) =>
    req<{ ok: boolean; error?: string }>(`/api/satoshi/pending/${id}`, { method: 'DELETE' }),
  satoshiRefreshBalances: () =>
    req<{ ok: boolean; updated?: number; total?: number; error?: string }>('/api/satoshi/refresh-balances', post({})),
  satoshiLeverageLimits: (fresh = false) =>
    req<{ ok: boolean; limits: Record<number, number>; default: number; error?: string }>(`/api/satoshi/leverage-limits${fresh ? '?fresh=1' : ''}`),
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StakingAccountInfo {
  id: number;
  name: string;
  coins: number;
  crystals: number;
  coin_slots: number;
  crystal_slots: number;
}

export interface StakingEntryRow {
  id: number;
  entry_id: number;
  account: string;
  currency: 'coins' | 'crystals';
  amount_staked: number;
  amount_to_collect: number;
  created_at: string;
  can_collect_at: string;
  collected: boolean;
  collected_at: string | null;
}

export interface Account {
  id: number;
  name: string;
  hasToken: boolean;
  hasInit: boolean;
  // реальный статус сессии (WS), не просто "есть токен в БД" — токен не удаляется сам при протухании
  sessionStatus: 'active' | 'dead' | 'connecting' | 'unknown';
  buildings?: string[]; // особые здания на карте: 'market' | 'fortune' | 'wisdom' | 'reserve'
  balance: number;
  crystals: number;
  profit: number;
  profit_final: number;
  population: number;
  population_final: number;
  happiness: number;
  happiness_final: number;
  staked_coins: number;
  staked_crystals: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  marketable: number;
  locked: number;
  qty: number;
  sell_price?: number | null;
  sell_currency?: string | null;
  booster_active_limit?: number | null;
  booster_currently_active?: number | null;
}

export interface FortuneCanDrawResult {
  id: number;
  name: string;
  ok: boolean;
  can_draw: boolean;
  cost: number;
  spins_made: number;
  crystals: number;
  error?: string;
}

export interface FortuneRow {
  id: number;
  account: string;
  spun_at: string;
  reward: null | {
    reward_type?: string;
    type?: string;
    amount?: number;
    item_id?: number;
    reward_id?: number;
    reward?: { reward_type?: string; type?: string; amount?: number; actual_coins?: number; item_id?: number };
  };
}

// 13.10.2026: карточки на весь 28-дневный цикл (GET /api/daily) — чисто из БД, см.
// web/routes/dashboards.js. source: 'actual' — наша запись о реальной выдаче (DailyLog),
// 'estimated' — прошедший день без нашей записи (забрали руками в игре, calculated_reward —
// лучшая оценка), 'upcoming' — ещё не наступил, calculated_reward и есть то, что реально придёт.
export interface DailyRewardDay {
  day: number; // 1-28
  reward_type: string;
  amount: number;
  item_id: number | null;
  source: 'actual' | 'estimated' | 'upcoming';
  is_today: boolean;
}
export interface DailyRewardAccount {
  name: string;
  streak: number | null;
  last_login: string | null;
  updated_at: string | null;
  days: DailyRewardDay[];
}

export interface DailyAdsRow {
  id: number;
  name: string;
  ok: boolean;
  current: number;
  limit: number;
  reward: number;
  limit_reached: boolean;
  // снимок в БД сделан ДО последней UTC-полуночи, т.е. относится к прошлому дню: показывать его
  // как «Готово» нельзя — счётчик рекламы за новый день уже другой (см. /api/daily-ads/status)
  stale?: boolean;
  error?: string;
}

export interface AppConfig {
  logLevel: string;
  ui?: { navOpenGroups?: string[] };
  update?: { auto?: boolean };
  telegram?: {
    botToken?: string;
    maintenanceChatId?: string; maintenanceThreadId?: string;
    wordleChatId?: string; wordleThreadId?: string;
    marketChatId?: string; marketThreadId?: string;
  };
  [key: string]: unknown;
}

export interface WordleRow {
  account: string;
  won: boolean;
  attempts: number;
  words: string[];
}

export interface JourneyAccount {
  name: string;
  levels: { level: number; claimed: boolean; condition_met: boolean; updated_at?: string }[];
}

export interface AchievementEntry {
  id: string | number;
  accounts: { name: string; progress?: number; tiers?: unknown[]; secret?: boolean; updated_at?: string }[];
}

export interface PromoAccount {
  id: number | null;
  name: string;
  entries: { code: string; success: boolean; reward: unknown; used_at: string }[];
}

export interface BuilderRow {
  id: number;
  name: string;
  count: number | null;
  price_coins: number | null;
  price_stars: number | null;
  max_builders: number | null;
  cnt_coins: number | null;
  max_coins: number | null;
  cnt_stars: number | null;
  max_stars: number | null;
  updated_at?: string;
}

export interface BuilderLiveRow extends BuilderRow {
  balance: number | null;
  crystals: number | null;
  error?: string;
}

export interface LoyaltyReward {
  type?: string;             // 'crystals' | item
  quantity: number;
  booster?: string | null;
  booster_pack?: string | null;
  item_id?: number | null;
}
export interface LoyaltyLevel {
  level: number;
  claimed: boolean;
  // required_days — РЕАЛЬНЫЙ порог уровня (3/7/14/30/60/90/180/360, сверено живьём) — НЕ равен
  // l.level! Раньше фронт ошибочно принимал l.level за требуемое число дней (см. Loyalty.tsx).
  condition?: { condition_met?: boolean; current_days?: number; required_days?: number } | null;
  condition_met?: boolean;   // запасной плоский вариант
  rewards?: LoyaltyReward[];
}
export interface LoyaltyRow {
  account_id: number;
  account: string;
  data: {
    streak: number;
    levels: LoyaltyLevel[];
  };
  updated_at: string | null;
}

export interface BuildingAccount {
  id: number;
  name: string;
}

// Технологическая фабрика — структура реверснута из chunks/tech_factory-*.js. Копите Почёт в
// pool категории → категория открывается → выбираете рецепт → start тратит fee_crystals +
// inputs со склада, запускает таймер (duration_seconds) → по готовности claim забирает output.
// Один активный крафт на аккаунт (job).
export interface TechFactoryItemStack {
  item_id: number;
  quantity: number;
}
// как и GuildQuest.name/description — игра отдаёт локализованный объект, не голую строку
// (см. React error #31 "object with keys {en, ru}" — раньше тип был string, что не совпадало
// с реальным ответом /tech-factory/overview)
export type LocText = { en?: string; ru?: string } | string;
// 13.10.2026: форма подтверждена реверсом живого бандла (chunks/tech_factory-*.js) — раньше была
// угадана неверно (category.code/pool/recipes[] плоским списком). Настоящая: category.machines[],
// у каждого станка — tiers[] (I-VI), в тире и рецепт, и лимит, и цена разблокировки следующего.
export interface TechFactoryTier {
  level: number; // 1-6, в игре подписано римскими I-VI
  unlocked: boolean;
  duration_seconds: number;
  fee_crystals: number;
  inputs: TechFactoryItemStack[];
  output: TechFactoryItemStack;
  used: number;
  limit_count: number;
  limit_window: 'day' | 'week' | string;
  upgrade_crystals?: number; // цена разблокировки ЭТОГО тира (присутствует, пока tier не unlocked)
}
export interface TechFactoryMachine {
  id: string;
  name: LocText;
  description?: LocText;
  icon_key?: string;
  level: number;
  max_level: number;
  tiers: TechFactoryTier[];
}
export interface TechFactoryCategory {
  id: number;
  code: string;
  name?: LocText;
  description?: LocText;
  icon_key?: string;
  unlocked: boolean;
  // живым ответом подтверждено 13.10.2026 (лог бота, аккаунт ещё ничего не разблокировал): пока
  // категория закрыта — копим Почёт в pool, machines==[] и появляются только после разблокировки
  pool: { kind: string; target: number; progress: number; fundable: boolean } | null;
  machines: TechFactoryMachine[];
  machine_total?: number;
}
export interface TechFactoryJob {
  machine_id: string;
  level: number;
  started_at: string;
  finishes_at: string;
  ready: boolean;
  output: TechFactoryItemStack;
}
export interface TechFactoryQueueItem {
  id: number;
  machine_id: string;
  level: number;
}
// 13.10.2026: имена верхнего уровня подтверждены ЖИВЫМ ответом игры (сохранился в логе бота до
// чистки temp-дампа) — отличаются от того, что подсказывал только статический бандл (is_member/
// can_upgrade были неверной догадкой; реальные поля — in_guild/can_spend_guild_crystals и т.д.)
export interface TechFactoryOverview {
  renown_balance: number | null;
  categories: TechFactoryCategory[];
  job: TechFactoryJob | null;
  in_guild: boolean;
  has_factory: boolean;
  membership_eligible: boolean;
  eligible_members: number;
  economy_unlocked: boolean;
  guild_renown_balance: number | null;
  can_spend_guild_renown: boolean;
  guild_crystal_balance: number | null;
  can_spend_guild_crystals: boolean;
  queue: TechFactoryQueueItem[];
  updated_at: string | null;
}

// Вечный аудиториум — структура реверснута из chunks/timeless_auditorium-*.js. Три условия входа
// (Почёт за всё время в гильдии / дней подряд в гильдии / население города), все три met → unlocked.
export interface AuditoriumGate {
  current: number;
  required: number;
  met: boolean;
}
// Витрина (GET /timeless-auditorium/catalog, 14.10.2026, chunks/timeless_auditorium-*.js).
// tiers — уровни престижа (foyer/gallery/vault) по Почёту за всё время; товар доступен, когда
// tier_met, хватает баланса и не исчерпан лимит (purchasable — вердикт сервера).
export interface AuditoriumSkuLimits {
  used: number;
  limit: number;
  remaining: number;
  limit_days: number;
  resets_at: string | null;
}
export interface AuditoriumSku {
  code: string;
  item_id: number;
  quantity: number;
  renown: number;
  rarity: string;
  min_lifetime_renown: number;
  tier_met: boolean;
  purchasable: boolean;
  limits: AuditoriumSkuLimits | null;
}
export interface AuditoriumTier { tier: string; threshold: number; reached: boolean }
export interface AuditoriumCatalog {
  balance: number;
  lifetime_earned: number;
  tiers: AuditoriumTier[];
  sections: { key: string; skus: AuditoriumSku[] }[];
}
export interface AuditoriumStatus {
  renown: AuditoriumGate | null;
  loyalty: AuditoriumGate | null;
  population: AuditoriumGate | null;
  unlocked: boolean;
  in_guild: boolean | null;
  has_auditorium: boolean | null;
  catalog: AuditoriumCatalog | null;
  updated_at: string | null;
}

// структура ответа /guild-quests/tiers/{id} подтверждена живым запросом (DevTools, 09.07.2026)
export interface QuestTierPool {
  target: number;
  progress: number;
  fundable: boolean;
}
export interface QuestTier {
  id: number;
  rarity: string;
  unlocked: boolean;
  pool: QuestTierPool;
}
export interface QuestTierData {
  renown_balance: number;
  eligible_members: number;
  tiers: QuestTier[];
}
export interface QuestTierGuild {
  guild_id: string;
  guild_title: string;
  data: QuestTierData | null;
  updated_at: string | null;
}

export interface GuildMembership {
  account: string;
  account_id: number | null;
  guild_id: string;
  guild_title: string;
  role: string;
  benefits: unknown;
  updated_at: string;
}

export interface GuildApplication {
  id: number;
  first_name: string;
  last_name: string | null;
  population: number;
  profit: number;
  timestamp: string;
  small_url?: string | null;
}

export interface GuildSettings {
  guild_type: string;
  auto_kick: string;
  application_criteria_population: number;
  application_criteria_profit: number;
  membership_fee_type: string | null;
  membership_fee_amount: number | null;
  membership_fee_duration: string | null;
  membership_fee_currency: string | null;
  member_capacity?: number;
  headquarters_level?: number;
  guild_color?: string;
  is_verified?: boolean;
}

// точное тело PATCH /guilds/management/{id} (как шлёт сам UI игры)
export interface GuildSettingsPayload {
  guild_type: string;
  auto_kick: string;                              // 'none' | '7' | '14' | '30' | '90'
  application_criteria_population: number | null; // null когда критерии выключены
  application_criteria_profit: number | null;
  membership_fee_type: string | null;            // null | 'hourly' | 'fixed'
  membership_fee_amount: number | null;
  membership_fee_duration: string | null;        // 'daily' | 'weekly' | 'monthly'
  membership_fee_currency: string | null;        // 'coins' | 'crystals'
}

export interface GuildMember {
  id: number;
  first_name: string;
  last_name: string | null;
  role: string;
  online_status: string;
  profit: number;
  population: number;
  rank_profit?: number;
  rank_population?: number;
  small_url?: string | null;
}

export interface MidOverview {
  alliance_count: number;
  enemy_count: number;
  scouting_slots: number;
  invitations_count: number;
  pending_requests_count: number;
  has_foreign_ministry: boolean;
}

export interface MidAlliance {
  id: number;
  ally_guild_id: number;
  ally_guild_title: string;
  ally_guild_photo: string | null;
  our_level: number;
  their_level: number;
  effective_level: number;
  next_level_cost?: number;
  created_at: string;
}

export interface MidAllianceRequest {
  id: number;
  guild_id?: number;
  guild_title?: string;
  guild_photo?: string | null;
  guild_members_count?: number;
  guild_alliance_count?: number;
  created_at: string;
}

export interface MidEnemy {
  id: number;
  enemy_guild_id: number;
  enemy_guild_title: string;
  enemy_guild_photo: string | null;
  enemy_members_count: number;
  tariff_level: string;
  created_at: string;
}

// Кампании Гильдий (guild-campaigns) — заменили scouting в обновлении 06.07.2026.
// Структура реверснута из бандла игры (chunks/foreign_ministry-*.js + CampaignCard-*.js):
// объявляете кампанию против гильдии (start), участники обеих сторон "деплоятся" (deploy),
// лидер под атакой может кликнуть "в ружьё" (call-to-arms) — зовёт союзников на подкрепление
// (эндпоинты volunteer/volunteer-withdraw/volunteer-decide для САМИХ союзников — в боте пока
// не нужны, у нас нет отдельного экрана "чужая гильдия просит подкрепление"). По истечении
// duration_hours бой решается автоматически, проигравший теряет часть казны победителю.
export interface MidCampaignSide {
  guild_id: number;
  guild_title: string;
  guild_photo: string | null;
  power?: number;
  baseline_power?: number;
  deployed_count?: number;
  reinforcement_count?: number;
}
export interface MidCampaign {
  id: number;
  attacker: MidCampaignSide;
  defender: MidCampaignSide;
  my_side: 'attacker' | 'defender';
  started_at: string;
  ends_at: string;
  win_chance?: number;
  declared_enemy?: boolean;
  can_call_to_arms?: boolean;
  can_deploy?: boolean;
  my_deployed?: boolean;
  renown_estimate?: number;
}
export interface MidCampaignRecent {
  id: number;
  attacker: MidCampaignSide;
  defender: MidCampaignSide;
  my_side: 'attacker' | 'defender';
  attacker_won?: boolean;
  coins_taken?: number;
  crystals_taken?: number;
  duration_hours: number;
}
export interface MidCampaignConfig {
  durations: number[];
  steal_base_short?: number;
  steal_base_long?: number;
  max_per_side?: number;
  enemy_spoils_bonus?: number;
  mobilized_income_bane?: number;
}
export interface MidCampaignsData {
  active: MidCampaign[];
  recent: MidCampaignRecent[];
  config: MidCampaignConfig;
}

export interface MidSearchGuild {
  id: number;
  title: string;
  photo: string | null;
  members_count: number;
  has_foreign_ministry?: boolean;
  alliance_count?: number;
  is_enemy?: boolean;
}

export interface MidLiveData {
  ok: boolean;
  overview: MidOverview;
  alliances: { alliances: MidAlliance[]; max_alliances: number };
  requests: { incoming: MidAllianceRequest[]; outgoing: MidAllianceRequest[] };
  enemies: { enemies: MidEnemy[]; max_enemies: number };
  campaigns: MidCampaignsData | null;
  error?: string;
}

export interface CapitalRow {
  guild_id: string;
  guild_title: string;
  buildings: MapBuilding[];
  coins?: number;
  crystals?: number;
  profit_coins?: number;
  profit_crystals?: number;
  profit_coins_final?: number;
  profit_crystals_final?: number;
  economic_strength?: number;
  updated_at: string;
}

export interface CityRow {
  account: string;
  buildings: MapBuilding[];
  // null — снимок ещё не знает про секции (не путать с пустым списком «ничего не открыто»)
  unlockedSections: string[] | null; // id секций (см. MapSection) — игра отдаёт прямо в /progress/, см. progress.js
  updated_at: string;
}

// Секция карты города (закрытая территория) — статический каталог config/city_sections.json,
// один и тот же для всех аккаунтов, отдаётся через /api/sections. coordinates — клетки, входящие
// в секцию (для отрисовки затемнения/замка на карте), adjacentSections — какие секции должны быть
// уже открыты, чтобы эту можно было открыть (сверяет сама игра, бот не проверяет).
export interface MapSection {
  id: string;
  coordinates: { x: number; y: number }[];
  adjacentSections: string[];
  unlockCost: { coins?: number; crystals?: number };
  defaultUnlocked: boolean;
}

export interface MapBuilding {
  x: number;
  y: number;
  id: string;
  level: number;
  end?: string | null; // ISO-время окончания текущей стройки/улучшения — из живых данных игры
  start?: string | null; // ISO-время НАЧАЛА — тоже отдаёт сама игра (см. bundle: deserialize()
  // s.constructionBegin=n.start), не зависит от того, кто запустил улучшение (бот или сам игрок в
  // игре) — duration=end-start точно, без формул и без знания о бустах ускорения вообще
}

// Действия по городу — см. web/routes/cityStrategy.js. Цель привязана к КОНКРЕТНОЙ клетке (x,y),
// не к семье здания — иначе одна цель подсвечивала бы сразу все экземпляры семьи на карте.
export interface CityStrategyTarget {
  x: number;
  y: number;
  target_level: number;
}
// ручная приоритетная очередь улучшений (вкладка "Улучшение") — конкретная клетка, без уровня:
// бот просто улучшает её на 1 уровень и вычёркивает запись из очереди
export interface CityStrategyQueueItem {
  x: number;
  y: number;
}
// общий (глобальный) план по семействам зданий — не привязан к аккаунту/клетке
export interface GlobalUpgradeRule {
  family_id: string;
  target_level: number;
}
// ускоритель из инвентаря (вкладка "Ускорители") — available/active_limit из БД, остальное живое
// (правило игры: пока активен любой ускоритель, активировать можно только тот же тип)
export interface CityBoosterRow {
  name: string; // = id типа ускорителя (ключ в config/items.json)
  label: string; // человекочитаемое имя
  available: number; // сколько штук в наличии (marketable)
  active_limit: number;
  currently_active: number;
  ends_at: number | null; // мс — когда закончится ПОСЛЕДНИЙ активный инстанс этого типа
  blocked_by_other: boolean; // активен другой тип — этот нельзя активировать, пока тот не кончится
  auto: boolean; // включена ли автоактивация
}
// запись лога действий по городу (вкладка "Лог")
export interface CityActionLogRow {
  id: number;
  account: string;
  type: string; // upgrade|build|move|demolish|reconstruct|renovate|booster_activate
  x: number | null;
  y: number | null;
  from_x: number | null;
  from_y: number | null;
  building_id: string | null;
  level_from: number | null;
  level_to: number | null;
  duration_ms: number | null;
  detail: string | null;
  created_at: string;
}
// Действия по столице — та же форма, что городская версия, но без реконструкции/реновации/
// ускорителей (не подтверждены реверсом для столицы), guild_id вместо account.
export interface CapitalStrategyTarget {
  x: number;
  y: number;
  target_level: number;
}
export interface CapitalStrategyQueueItem {
  x: number;
  y: number;
}
export interface CapitalActionLogRow {
  id: number;
  guild_id: string;
  type: string; // upgrade|build|move|demolish
  x: number | null;
  y: number | null;
  from_x: number | null;
  from_y: number | null;
  building_id: string | null;
  level_from: number | null;
  level_to: number | null;
  duration_ms: number | null;
  detail: string | null;
  created_at: string;
}
// прогнозируемое действие бота (вкладка "Прогноз") — start/end в мс (timestamp)
export interface ForecastEvent {
  x: number;
  y: number;
  building_id: string;
  level_from: number;
  level_to: number;
  start: number;
  end: number;
  duration_ms: number;
  // под каким окном ускорителя посчитана строка (см. modules/progress.js loadBoosterTimeline) —
  // нужно, чтобы расхождение с игрой было видно сразу, а не выяснялось по косвенным признакам
  boost_multiplier?: number | null;
  boost_name?: string | null;
}
export interface ForecastBoosterWindow { fromMs: number; toMs: number; multiplier: number; name?: string | null }
export interface ForecastMods { reducedUpgradeTimes: number; constructionTimeMultiplier: number }
export interface ForecastDiag { samples: number; median: number | null; spread: [number, number] | null }
export interface BuildingDef {
  id: string;
  category: string;
  service_category: string | null;
  is_purchasable: boolean;
  base_price: number | null;
  base_price_factor: number | null; // множитель цены за каждый уже построенный экземпляр семьи, см. buildPriceAt
  star_lvl: number | null; // null/undefined — не звёздный вариант
  is_reconstructible: boolean;
  is_renovatable: boolean;
  required_lvl: number | null; // минимальный уровень для реконструкции/реновации
  components_required: number | null; // компонентов нужно на реконструкцию
  masterplans_num: number | null; // мастерпланов нужно на реновацию
  masterplans_to_get: number | null; // мастерпланов ВЫДАЁТСЯ за реконструкцию
  next_id: string | null; // id следующего звёздного тира (реновация)
  construction_increment: number | null; // секунды — база формулы времени улучшения, см. upgradeDuration
  base_profit: number | null; // для сортировки коммерческих зданий по прибыли
  base_population: number | null; // для сортировки жилых зданий по населению
  service_coverage: number | null; // для сортировки служебных зданий по покрытию
  limit: number | null; // максимум экземпляров семьи в городе (напр. спецздания — по 1 шт.)
  urban_vitality_population: number | null; // минимальное население города для этого здания (порог "жизнеспособности")
  name: string; // JSON-строка {en,ru} — парсить на клиенте
}

export interface ShopAccountRaw {
  name: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface TownhallAccount {
  name: string;
  airdrop?: {
    city: number;
    activity: number;
    friends: number;
    transactions: number;
    achievements: number;
    percentile?: number;
    updated_at?: string;
  };
  diversity?: {
    score: number;
    variety_score: number;
    profit_score: number;
    unique_types: number;
    total_buildings: number;
    income_bonus?: number | null;
    updated_at?: string;
  };
}

export interface CivicDrawOdds {
  rarity: string;
  chance: number;
  count: number;
}

export interface CivicDrawAccount {
  account_id: number;
  account: string;
  draws_per_day: number | null;
  draws_ready: number | null;
  draw_progress: number | null;
  claimable: boolean;
  odds: CivicDrawOdds[];
  ready_at: string | null; // линейный прогноз (см. modules/townhall.js), null если ставка неизвестна
  updated_at: string | null;
}

export interface GuildQuest {
  id: number;
  task_id: number;
  type: string;
  name: { en?: string; ru?: string };
  description: { en?: string; ru?: string };
  rarity: string;
  reward_item_id: number;
  reward_amount: number;
  renown_reward: number | null;
  personal_threshold: number;
  personal_progress: number;
  guild_threshold: number;
  guild_progress: number;
  is_collected: boolean;
  created_at: string;
  expires_at: string;
  duration_days: number;
  description_variables: Record<string, string | number> | null;
  // только для booster_activate/booster_combine — считается на сервере из Inventory (БД, не игра),
  // чтобы заранее показать «есть M / нужно N» и гасить кнопку, не тратя мёртвый запрос к игре.
  // null = не удалось определить (редкость не распозналась / нет правил комбинирования в кэше).
  booster_rarity?: string;
  booster_owned?: number | null;
  booster_needed?: number | null;
  // Слоты ускорителей (только booster_activate). У типа их может быть несколько (напр. 4 у
  // эпических) и освобождаются они ПО ОДНОМУ — booster_blocked_until это время БЛИЖАЙШЕГО
  // освобождающегося слота, а не последнего. null = слот свободен, можно активировать сейчас.
  booster_blocked_until?: string | null;
  booster_slots_used?: number | null;
  booster_slots_limit?: number | null;
  // только guild_boost: сколько АЛМАЗОВ нужно на закрытие личного/общего условия (кратно 10 —
  // игра принимает только такие суммы) и текущий баланс аккаунта из БД. null в стоимости = не
  // удалось понять единицу измерения из текста квеста, покупку не предлагаем.
  boost_cost_personal?: number | null;
  boost_cost_guild?: number | null;
  account_crystals?: number | null;
}
export interface GuildQuestGroup {
  guild_id: string;
  guild_title: string;
  // своя строка на (guild_id,account) — у каждого своего аккаунта в гильдии своё personal_progress
  // (см. web/routes/dashboards.js), поэтому одна гильдия может встретиться несколько раз в списке
  account?: string;
  account_id?: number | null;
  quests: GuildQuest[];
  updated_at?: string;
  error?: string;
}

export interface SpecialBuildingRow {
  guild_id: string;
  guild_title: string;
  auditorium_level: number | null;
  factory_level: number | null;
  ministry_level: number | null;
  updated_at?: string;
}

export type ServiceCat = 'hospital' | 'police-station' | 'fire-station' | 'park';
export interface CityStats {
  count: number;
  population: number;
  profit: number;       // "голая" база — без happiness/политик/гильдии (обратная совместимость)
  profitFinal: number;  // как в игре: raw·happiness·глобальные_политики·(1+гильдия)·(1+разнообразие) — полностью, см. reference_game_formulas.md
  coverageByCat: Record<ServiceCat, number>;  // абсолютное покрытие по виду
  serviceRatios: Record<ServiceCat, number>;  // доля покрытия населения (1 = полностью)
  happiness: number;
  buildCost: number;
  upgradeCost: number;
  totalCost: number;
}

export interface StorageItemFull {
  id: number;
  type: 'booster' | 'booster_pack' | 'component' | 'masterplan' | 'snowflake' | string;
  quantity: number;
  sell_price: number;
  sell_currency: 'coins' | 'crystals';
  soulbound: number;
  booster: {
    rarity: string;
    multiplier: number;
    duration: number;
    active_limit: number;
    currently_active: number;
  } | null;
  booster_pack: { type: string } | null;
}

export interface BoosterPackReward {
  reward_id: number;
  reward_type: 'item' | 'crystals';
  probability: number;
  rarity: { booster_rarity: string; valid: boolean } | null;
  crystals_amount: number | null;
}

// Гарантия набора: выбираешь цель, игра считает серию открытий этого набора, и на
// attempts_required-м паке цель падает гарантированно (счётчик после этого сбрасывается).
// Поля сверены с живым ответом /storage/allitemdata → booster_packs[] (19.08).
export interface PackGuaranteedDrop {
  target_item_id: number;
  attempts_required: number;      // сколько паков нужно открыть до гарантированного выпадения
}

export interface PackTargetProgress {
  target_item_id: number;
  current_streak: number;         // сколько уже открыто в серии
  active: boolean;                // цель выбрана прямо сейчас (активна одна)
}

export interface BoosterPackMeta {
  id: number;
  type: string;
  guaranteed_drops: PackGuaranteedDrop[];
  rewards: BoosterPackReward[];
  user_progress: PackTargetProgress[];
}

export interface CombinationRule {
  from_rarity: string;
  to_rarity: string;
  required_amount: number;
}

export interface StorageLiveResponse {
  ok: boolean;
  items: StorageItemFull[];
  booster_packs: BoosterPackMeta[];
  combination_rules: CombinationRule[];
  active_boosters: unknown[];
  error?: string;
}

export interface StorageActionResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── Policies (Политики) ─────────────────────────────────────────────────────────

export interface PolicyEffect {
  stat: string;
  scope_kind: string;
  targets: string[];
  mode: 'mult' | 'add' | 'set';
  value: number;
  kind?: 'boon' | 'bane';
  next_value: number | null;
}

export interface PolicyDefinition {
  name?: { en?: string; ru?: string };
  description?: { en?: string; ru?: string };
  icon_key?: string;
  theme?: string;
  badge?: string;
  badge_n?: number;
}

export interface PolicyInstance {
  id: number;
  def_id: string;
  rarity: string;
  level: number;
  serial_number: number | null;
  definition: PolicyDefinition | null;
  max_level?: number | null;
  effects?: PolicyEffect[];
  enacted_slot: number | null;
  tenure_points?: number;
  next_level_tenure?: number | null;
  next_level_shards?: number | null;
  promotion?: { shard_cost: number; target_rarity: string; tenure_carry: number } | null;
  // считается на сервере (web/routes/policies.js policyProgress) — правила берутся из ответа игры,
  // наличие осколков из Inventory; на фронте только показываем и гасим кнопки
  progress?: PolicyProgress;
}

export interface PolicyProgress {
  shard_item_id: number | null;
  have_shards: number;
  tenure_now: number;
  tenure_needed: number | null;
  level_shards_needed: number | null;
  can_level_up: boolean;
  level_blockers: string[];
  promote_shards_needed: number | null;
  promote_target_rarity: string | null;
  can_promote: boolean;
  promote_blockers: string[];
}

export interface PolicyLibrarySection {
  rarity: string;
  total: number;
  discovered: number;
  entries: PolicyInstance[];
  locked: number[];
}

export interface PolicyLibrary {
  discovered: number;
  total: number;
  sections: PolicyLibrarySection[];
}

export interface PolicyCabinetSlot {
  slot: number;
  unlocked: boolean;
  instance: PolicyInstance | null;
}

export interface PolicyCabinet {
  slots: PolicyCabinetSlot[];
  civic_draw?: unknown;
}

// осколки политик / нераскрытые тайные политики — обычные предметы инвентаря (Inventory),
// но помечены типом и поэтому живут на странице "Политики", а не "Предметы"
export interface PolicyShardItem {
  id: string;
  type: 'policy_shard' | 'mystery_policy' | string;
  marketable: number;
  locked: number;
  qty: number;
}

export interface PolicyEconomy {
  unlocked: boolean;
  min_population: number;
  craft_costs: Record<string, number>; // редкость -> сколько осколков нужно на одну тайную политику
}

export interface PoliciesAccountData {
  list: PolicyInstance[];
  library: PolicyLibrary;
  cabinet: PolicyCabinet;
  economy: PolicyEconomy | null;
  shards: PolicyShardItem[];
  updated_at: string | null;
  population: number | null;
  policies_unlocked: boolean;
  // считает сервер по кабинету: слот свободен, если разблокирован по населению и пуст
  free_slots?: number;
  total_slots?: number;
}

export type PolicyActionName =
  | 'enact' | 'unequip' | 'levelup' | 'promote' | 'dissolve'
  | 'mystery-craft' | 'mystery-open' | 'civic-draw-claim';

export interface PolicyActionResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PolicyDefEntry {
  def_id: string;
  rarity: string;
  name: { en?: string; ru?: string } | null;
  description: { en?: string; ru?: string } | null;
  icon_key: string | null;
  theme: string | null;
  badge: string | null;
  badge_n: number | null;
  max_level: number | null;
  effects: PolicyEffect[];
  seen_account: string | null;
  updated_at: string | null;
}

// ── Башня Сатоши (Satoshi Tower) ────────────────────────────────────────────────

export type SatoshiTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface SatoshiCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SatoshiConfig {
  max_leverage: number;
  min_margin: number;
  min_fee: number;
  fee_rate: number;
  max_open_positions: number;
}

export type SatoshiFeedSource = 'exchange' | 'game';

// TP/SL — фича бота (игра не поддерживает нативно): задаётся при открытии, редактируется потом.
// Можно указать целевую ЦЕНУ и/или целевой ПРОЦЕНТ профита/убытка — сработает то, что наступит раньше.
export interface SatoshiTpSl {
  tp_price?: number | null;
  sl_price?: number | null;
  tp_pnl_pct?: number | null;
  sl_pnl_pct?: number | null;
}

export interface SatoshiOpenPosition extends SatoshiTpSl {
  id: number;
  account: string;
  account_id: number | null;
  side: 'long' | 'short';
  leverage: number;
  margin: number;
  notional: number;
  entry_price: number;
  liquidation_price: number;
  opened_at: string;
}

export interface SatoshiHistoryPosition extends SatoshiOpenPosition {
  close_price: number | null;
  realized_pnl: number | null;
  fee: number | null;
  payout: number | null;
  status: 'closed' | 'liquidated' | string;
  closed_at: string | null;
}

export interface SatoshiPendingOrder extends SatoshiTpSl {
  id: number;
  account: string;
  account_id: number | null;
  side: 'long' | 'short';
  leverage: number;
  margin: number;
  trigger_price: number;
  ref_price: number | null;
  status: 'pending' | 'triggered' | 'cancelled' | 'failed' | string;
  error: string | null;
  created_at: string;
}

// ── Shop Live ──────────────────────────────────────────────────────────────────

// 'tickets' — валюта события «Летний карнавал» (10-23.08.2026), покупка через /shop/buy/tickets
export type ShopOfferType = 'coins' | 'crystals' | 'ads' | 'tickets';

export interface ShopOffer {
  offer_id: number;
  offer_type: ShopOfferType;
  price: number;
  limit: number;
  current: number;
  limit_type: 'daily' | 'weekly';
  league_required: string | null;
  league_met: boolean;
}

export interface ShopNormalizedItem {
  item_id: number;
  rarity?: string;
  multiplier?: number;
  duration_ns?: number;
  active_limit?: number;
  pack_type?: string;
  category?: string; // из какой витрины пришёл предмет (только магазин билетов, где их три сразу)
  // сырые поля предмета из ответа игры — есть не всегда, но для новых предметов событийной витрины
  // это единственный способ узнать название/картинку до обновления каталога предметов
  game_name?: string | null;
  game_type?: string | null;
  game_rarity?: string | null;
  offers: ShopOffer[];
}

export interface ShopAccountData {
  id: number;
  name: string;
  items: ShopNormalizedItem[];
  // какие валюты игра реально предлагает в витринах этого аккаунта (только магазин билетов) —
  // нужно, чтобы объяснить пустую страницу вместо молчания
  offer_types?: string[];
  error?: string;
  permanent?: boolean;
}

export interface ShopLiveResponse {
  ok: boolean;
  accounts: ShopAccountData[];
  error?: string;
}

// balance — фактический баланс аккаунта ПОСЛЕ покупки (сервер перечитывает его из игры и
// обновляет запись в БД, см. web/routes/economy.js). Страницы магазина обновляют по нему свою
// карту балансов: иначе кнопка «Купить» осталась бы включённой по старому числу и следующая
// покупка упиралась бы в 400 «Недостаточно монет».
export interface ShopBalance { balance: number | null; crystals: number | null }

export interface ShopBuyResponse {
  ok: boolean;
  result?: unknown;
  balance?: ShopBalance | null;
  error?: string;
}

export interface ShopBuyAllResponse {
  ok: boolean;
  results: { id: number; name: string; ok: boolean; result?: unknown; balance?: ShopBalance | null; error?: string }[];
  error?: string;
}

// ── Годовщина / «Летний карнавал» ──────────────────────────────────────────────
// Формы 1:1 с ответами игры (сверено по бандлу, см. шапку web/routes/anniversary.js).

export interface AnniversaryTier {
  id: number;
  required: number | null;   // null у заданий без числового порога (сделал — забрал)
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: number;            // билеты
}

export interface AnniversaryTask {
  identifier: string;
  name: { en?: string; ru?: string };
  task_type: string;         // 'regular' | ... — у не-regular ступени без порога
  paid_only?: boolean;       // задание за реальные деньги — «Финал дня» засчитается и без него
  tiers: AnniversaryTier[];
}

export interface AnniversaryBoard {
  id: number;
  name: string;
  event: { is_active: boolean; current_day: number | null; total_days: number | null; day_end: string | null } | null;
  tasks: { regular: AnniversaryTask[]; exclusive: AnniversaryTask[]; meta: AnniversaryTask[] };
  tickets_balance: number;
  tickets_earned: number;
  // есть ли у аккаунта «Оплот Мудрости» — без него мини-игры недоступны в принципе
  has_wisdom?: boolean;
  // состоит ли аккаунт в гильдии — без неё нельзя внести в казну
  has_guild?: boolean;
  // что аккаунт уже сделал сегодня по нашим записям (DailyLog / лог действий): по этому признаку
  // страница показывает «Забрать» вместо «Выполнить» у заданий без числового порога
  actions_done?: { daily_login?: boolean; guild_contribute?: boolean };
  error?: string;
  // игра отказала этому аккаунту насовсем (нет здания, не хватает населения) — повторять запрос
  // бессмысленно, см. isPermanent в web/lib/accountSweep.js
  permanent?: boolean;
}

export interface AnniversaryEventResponse { ok: boolean; accounts: AnniversaryBoard[]; error?: string }

export interface AnniversaryStage {
  stage: number;
  global_coins: number;      // порог «мира»
  personal_goal: number;     // порог «вы»
  state: 'claimed' | 'claimable' | 'locked' | string;
  ticket_reward: number;
  item_rewards: { item_id: number; amount: number }[];
  policy?: { def_id: number; rarity: string; name: Record<string, string> | string; icon_key?: string } | null;
}

export interface AnniversaryRoad {
  active: boolean;
  event_ends_at: string | null;
  ticket_item_id: number | null;
  claimed_stages: number;
  global_total: number;      // сколько потратил весь мир
  global_goal: number;
  coins_spent: number;       // сколько потратил этот аккаунт
  stages: AnniversaryStage[];
}

export interface AnniversaryRoadResponse {
  ok: boolean;
  accounts: { id: number; name: string; road?: AnniversaryRoad; error?: string; permanent?: boolean }[];
  error?: string;
}

export interface AnniversaryOfferPrice {
  kind: 'coins' | 'crystals' | 'money' | string;
  coins?: number;
  crystals?: number;
  stars?: number;
  nanotons?: number | string;
}

export interface AnniversaryOffer {
  active: boolean;
  day: number | null;
  total_days: number | null;
  ends_at: string | null;
  purchased: boolean;
  value_multiplier: number;
  rewards: { item_id: number; amount: number }[];
  price: AnniversaryOfferPrice | null;
}

export interface AnniversaryLadder {
  offers_accepted: number;
  rungs: { rung: number; offers_required: number; ticket_reward: number; state: 'claimed' | 'claimable' | 'locked' | string }[];
}

export interface AnniversaryOffersResponse {
  ok: boolean;
  accounts: { id: number; name: string; offer?: AnniversaryOffer | null; ladder?: AnniversaryLadder | null; error?: string; permanent?: boolean }[];
  error?: string;
}

// строка фонового выполнения заданий карнавала (реклама + мини-игры), см. web/lib/carnivalRunner.js
// ── Карнавальная аллея (anniversary-midway, 19-24.08.2026) ──────────────────────────────────
// Пять балаганов, по одному в день; у дня свой кошелёк билетов (purse), победа даёт win_tickets,
// оплачиваемых побед в день — paid_wins_cap. День 1 — «Четыре в ряд», балаганы 2-5 игра заранее
// не раскрывает (identifier пустой до открытия).
export interface MidwayStall {
  day: number;
  identifier: string;             // '' пока день не открыт
  opens_at: string | null;
  is_open: boolean;
  purse: number;                  // сколько билетов можно взять за этот день
  tickets_earned: number;
}

export interface MidwayConnectFour {
  paid_wins: number;
  paid_wins_cap: number;          // сколько побед в день оплачивается
  win_tickets: number;            // билетов за победу
  tickets_earned: number;
  total_wins: number;
  move_seconds: number;
}

// Счётчики СЕГОДНЯШНЕГО балагана, каким бы он ни был: страница не обязана знать конкретную игру
// (дни 3-5 игра заранее не раскрывает). supported=false — балаган открылся, но бот его не умеет.
export interface MidwayActive {
  identifier: string;
  title: string;                  // «Четыре в ряд», «Морской бой» или '' для незнакомого
  supported: boolean;
  paid_wins: number;
  paid_wins_cap: number;
  win_tickets: number;
  tickets_earned: number;
}

export interface MidwayState {
  is_open: boolean;
  opens_at: string | null;
  ends_at: string | null;
  tickets_balance: number;
  stalls: MidwayStall[];
  today_identifier: string;
  active: MidwayActive;
  connect_four: MidwayConnectFour;
  active_game: { code: string; status: string; vs_bot: boolean; moves: number } | null;
}

export interface MidwayResponse {
  ok: boolean;
  accounts: { id: number; name: string; midway?: MidwayState; error?: string; permanent?: boolean }[];
  error?: string;
}

// Состояние фоновой игры — живёт в процессе бота, а не во вкладке
export interface MidwayRun {
  account_id: number;
  name: string;
  game?: string;                  // какой балаган играется прямо сейчас
  step: string;                   // «Морской бой: партия 2 из 3», «готово», «кошелёк дня уже выбран»
  wins: number;
  needed: number | null;
  tickets: number;
  losses: number;
  running: boolean;
  error: string | null;
}

export interface CarnivalTaskRun {
  account_id: number;
  name: string;
  // какие виды заданий выполняются в этом запуске: login | ad | guild | minigames.
  // Живёт на сервере, поэтому спиннер на кнопке переживает перезагрузку страницы.
  kinds: string[];
  step: string;            // «играю: Судоку», «смотрю рекламу», «готово»
  wins: number;
  needed: number | null;   // сколько побед требует задание
  ads: number;
  adsNeeded: number | null;
  running: boolean;
  error: string | null;
}

// «Хранилище призов» (открылось 15.08): поле из 11 ячеек, каждая выигрывается один раз,
// цена следующего вращения растёт. Формы сверены с бандлом (chunks/anniversary_vault-*).
export interface AnniversaryVaultPrize {
  index: number;
  grand: boolean;                 // главный приз
  rewards: { item_id: number; amount: number }[];
  won: boolean;
  odds_bp: number;                // шанс в базисных пунктах (10000 = 100%)
  won_at: string | null;
}

export interface AnniversaryVault {
  is_open: boolean;
  opens_at: string | null;
  ends_at: string | null;
  spins_done: number;
  total_spins: number;
  next_cost: number | null;       // цена следующего вращения в билетах
  tickets_balance: number;
  tickets_spent: number;
  prizes: AnniversaryVaultPrize[];
}

export interface AnniversaryVaultResponse {
  ok: boolean;
  accounts: { id: number; name: string; vault?: AnniversaryVault; error?: string; permanent?: boolean }[];
  error?: string;
}

export interface AnniversaryVaultSpinResponse {
  ok: boolean;
  result?: { prize_index: number; grand: boolean; rewards: { item_id: number; amount: number }[]; tickets_paid: number };
  vault?: AnniversaryVault | null;
  error?: string;
}

// результат «крутить всем»: по строке на аккаунт — что выпало либо почему пропустили
export interface AnniversaryVaultSpinAllRow {
  id: number;
  name: string;
  spun?: boolean;
  grand?: boolean;
  tickets_paid?: number | null;
  rewards?: { item_id: number; amount: number }[];
  vault?: AnniversaryVault;
  skipped?: string;
  error?: string;
}

export interface AnniversaryClaimResult {
  id: number;
  name: string;
  claimed?: number;
  tickets?: number;
  error?: string;
}

export interface MinigameSolveResult {
  ok: boolean;
  won?: boolean;
  skipped?: boolean;
  reward?: number | null;
  error?: string;
}

export interface MinigameAllResult {
  id: number;
  name: string;
  ok: boolean;
  won?: boolean;
  skipped?: boolean;
  reward?: number | null;
  error?: string;
}

export interface MarketStatsRow {
  account: string;
  total_purchases: number | null;
  total_sales: number | null;
  total_crystals_earned: number | null;
  total_crystals_spent: number | null;
  total_ton_earned: number | null;
  total_ton_spent: number | null;
  updated_at?: string;
}

export interface MarketDealRow {
  id: number;
  account: string;
  listing_id?: number | null;
  record_id?: number | null;
  market_id: number | null;
  item_id: number | null;
  item_category: string | null;
  item_rarity: string | null;
  currency: string | null;
  price: number | null;
  fee?: number | null;
  qty: number | null;
  status?: string | null;
  counterparty?: string | null;
  created_at?: string | null;
  available_at?: string | null;
  ends_at?: string | null;
  sold_at?: string | null;
}

export interface MarketOffer {
  id: number;
  market_id: number;
  item_id: number;
  item_category: string;
  item_rarity: string;
  listing_currency: string;
  listing_price: number;
  display_price: number;
  commission_percent?: number;
  can_buy?: boolean;
  purchase_limit?: number;
  purchase_limit_type?: string;
  user_purchases?: number;
  seller_name?: string;
  available_at?: string;
  ends_at?: string;
  status?: string;
  sold_at?: string | null;
  your_offer?: boolean;
  mine_account?: string | null;  // имя моего аккаунта-владельца лота, '' если мой но имя неизвестно, null — не мой
  market_type?: 'direct' | 'auction' | 'negotiation';
  current_bid?: number | null;   // только аукцион
  min_next_bid?: number | null;  // только аукцион
  policy?: MarketPolicyInfo | null; // полное определение политики (для лотов категории policy)
}

export interface MarketPolicyEffect {
  kind?: string;       // boon | bane
  mode?: string;       // mult | add
  stat?: string;       // population | total_coverage | ...
  scope_kind?: string; // global | ...
  value?: number;
  next_value?: number;
  fixed?: boolean;
}
export interface MarketPolicyInfo {
  def_id: string;
  name?: { en?: string; ru?: string } | null;
  theme?: string | null;
  icon_key?: string | null;
  level?: number | null;
  max_level?: number | null;
  effects?: MarketPolicyEffect[];
}

export interface MarketAutobuyRule {
  id: number;
  item_id: number | null;
  categories: string;
  rarities: string;
  currency: string;
  max_price: number;
  max_budget: number | null;
  spent: number;
  account_ids: number[];
  include_escrow: boolean;
  enabled: boolean;
}

export interface MarketSellableItem {
  market_id: number;
  item_id: number;
  currency: string;
  floor_price: number;
  ceiling_price: number;
  item_category: string;
  item_rarity: string;
  current_listings: number;
  listings_limit: number | null;
  owned: number;
  free_slots?: number;   // суммарно свободных слотов (режим «случайные аккаунты»)
  accounts?: number;     // у скольких аккаунтов есть предмет (режим «случайные аккаунты»)
  def_id?: number | string;  // только карты политик — конкретная политика внутри бакета редкости
  policy_name?: string;      // только карты политик — название этой конкретной политики
  market_type?: 'direct' | 'auction' | 'negotiation';  // один и тот же market_id может встречаться на нескольких типах рынка — строка на каждую комбинацию
}

export interface MarketSnipeRow {
  id: number;
  offer_id: number;
  account_id: number;
  item_id: number | null;
  currency: string | null;
  price: number | null;
  available_at: string | null;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
}

export interface MinigameStatusRow {
  account: string;
  game: string;
  won: boolean;
  reward: number | null;
  score?: number | null;
}

export type Game2048Direction = 'up' | 'down' | 'left' | 'right';
export type Game2048Status = 'ongoing' | 'won' | 'lost';

export interface UpdateChannel {
  // branch — свежая сборка ветки; stable — последний релиз; release — закреплённый релиз; commit — закреплённая сборка
  kind: 'branch' | 'stable' | 'release' | 'commit';
  name: string;
  tag: string;
  sha?: string;
}
export interface UpdateRelease {
  version: string; tagName: string; tag: string; name: string; date: string;
  prerelease: boolean; url: string; notes: string; isNew: boolean;
}
export interface VersionInfo {
  ok: boolean;
  error?: string | null;
  repo: string;
  repoUrl: string;
  local: { sha: string; branch: string | null; ref: string | null; source: 'git' | 'env' } | null;
  channel: UpdateChannel;
  branch: string | null;
  branches: { name: string; tag: string; sha?: string }[];
  releases: UpdateRelease[];
  stable: { version: string; date: string } | null;
  currentRelease?: string | null;
  newerReleases?: number;
  // голова плавающего канала (ветка или последний релиз)
  remote: { sha: string; ref: string; message: string; date: string | null; url: string } | null;
  release: { tag: string; name: string | null; date: string | null; url: string } | null;
  // current — актуальна; behind — в канале есть новее; pinned — закреплённая версия; ahead/diverged —
  // локально свои коммиты; unknown_local — локального коммита нет на GitHub; unknown — не определена
  status: 'current' | 'behind' | 'pinned' | 'ahead' | 'diverged' | 'unknown_local' | 'unknown';
  behindBy: number | null;
  compareUrl: string | null;
  // сборка Docker-образа головы канала в GitHub Actions
  build: { status: string; conclusion: string | null; url: string } | null;
  canUpdate?: boolean;
  // время старта процесса бота — по нему панель понимает, что бот перезапустился
  startedAt?: number;
  auto?: boolean;
  updater?: { alive: boolean; busy?: boolean; heartbeatAt: string | null; version: number | null; mode?: string | null;
    last: { id: string; state: string; tag: string; message: string; at: string } | null };
  history?: { commit: string; ref: string | null; tag: string; at: string }[];
  checkedAt: number;
  // ответ из кэша сервера (ручная проверка повторена раньше чем через 10 с)
  cached?: boolean;
}
