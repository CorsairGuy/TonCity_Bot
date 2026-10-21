import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Spinner, Text, TextInput } from '@primer/react';
import { CheckIcon, ChevronLeftIcon, SyncIcon, XIcon } from '@primer/octicons-react';
import { api, type CityRow, type CapitalRow, type BuildingDef, type CityStrategyTarget, type CityStrategyQueueItem, type MapBuilding, type PolicyCabinet, type CityBoosterRow, type CityActionLogRow, type ForecastEvent, type GlobalUpgradeRule, type CityStats, type ServiceCat, type MapSection } from '../api';
import { CityActionsCanvas, type CityActionMode } from '../components/CityActionsCanvas';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { useMapDayNight } from '../hooks/useMapDayNight';
import { DayNightMenu } from '../components/DayNightMenu';
import { fmt } from '../utils';
import { CoinValue } from '../components/Icons';
import { upgradeStep, computeCityStats, type CityStatsMods } from '../cityStats';
import { MapPalette, MapBrushLevel, PanelShell, StatsPanel, PlanPanel, PlanSaveButton, FooterButton, QueuePanel, PendingList, MovePanel, DemolishPanel, ReconstructPanel, RenovatePanel, BoostersPanel, LogPanel, ForecastPanel, Empty, fmtTimeLeft, type PanelMode, type ReconGroup } from './cityMapPanels';

// ключ карты эффектов политики: та же схема, что cw(stat,scopeKind,target) в бандле игры —
// scope_kind==="global" (или без target) — суффикса нет, иначе "scopeKind:target"
function policyKey(stat: string, scopeKind: string, target: string): string {
  const suffix = scopeKind === 'global' || !target ? '' : `${scopeKind}:${target}`;
  return `${stat}|${suffix}`;
}
interface PolicyMaps { mult: Map<string, number>; add: Map<string, number> }
// сводит ВСЕ эффекты кабинета в две карты (mult/add), суммируя по ключу — сверено с бандлом (Gc()
// вычисляет ТАК ЖЕ: mult-эффекты с одним stat+scope+target складываются АДДИТИВНО перед 1+сумма)
function buildPolicyMaps(cabinet: PolicyCabinet | undefined): PolicyMaps {
  const mult = new Map<string, number>(), add = new Map<string, number>();
  for (const slot of cabinet?.slots ?? []) {
    for (const e of slot.instance?.effects ?? []) {
      const targets = e.targets && e.targets.length > 0 ? e.targets : [''];
      for (const t of targets) {
        const key = policyKey(e.stat, e.scope_kind, t);
        if (e.mode === 'mult') mult.set(key, (mult.get(key) ?? 0) + e.value);
        else if (e.mode === 'add') add.set(key, (add.get(key) ?? 0) + e.value);
      }
    }
  }
  return { mult, add };
}
function policyMultScoped(maps: PolicyMaps, stat: string, scopeKind = 'global', target = ''): number {
  return Math.max(0, 1 + (maps.mult.get(policyKey(stat, scopeKind, target)) ?? 0));
}
function policyAddScoped(maps: PolicyMaps, stat: string, scopeKind = 'global', target = ''): number {
  return maps.add.get(policyKey(stat, scopeKind, target)) ?? 0;
}
// собирает полный набор живых модификаторов для computeCityStats из кабинета политик + гильдийского
// income_boost + бонуса "Разнообразие" (GET /progress/diversity) — buildCostMultiplier/
// upgradeCostMultiplier уже посчитаны отдельно (политика·гильдия, см. useEffect ниже), переиспользуем
// как есть, вместо повторного вычисления
function buildCityStatsMods(cabinet: PolicyCabinet | undefined, incomeBoost: number, diversityIncomeBoost: number, buildCostMultiplier: number, upgradeCostMultiplier: number): CityStatsMods {
  const maps = buildPolicyMaps(cabinet);
  return {
    incomeBoost,
    diversityIncomeBoost,
    globalIncomeMult: policyMultScoped(maps, 'global_income'),
    categoryIncomeMult: cat => policyMultScoped(maps, 'category_income', 'building_category', cat),
    buildingTypeIncomeMult: id => policyMultScoped(maps, 'building_type_income', 'building_type', id),
    populationMult: policyMultScoped(maps, 'population'),
    serviceCoverageMult: cat => policyMultScoped(maps, 'service_category_coverage', 'service_category', cat) * policyMultScoped(maps, 'total_coverage'),
    urbanVitalityMult: Math.max(0.01, policyMultScoped(maps, 'urban_vitality_requirement')),
    happinessFloorDelta: Math.min(0.75, policyAddScoped(maps, 'happiness_floor') / 100),
    happinessCeilingDelta: policyAddScoped(maps, 'happiness_ceiling') / 100,
    buildCostMult: buildCostMultiplier,
    upgradeCostMult: upgradeCostMultiplier,
  };
}

// Редактор "Действий" по городу — прямо в странице карты (раньше была отдельная модалка
// CityActionsModal с выпадающими списками). Строительство/Перемещение/Снос/Реконструкция/Реновация
// копятся в ОДНУ общую очередь, которая переживает переключение вкладок режима — клик только
// добавляет действие в очередь, реальные запросы к игре шлёт единая кнопка "Выполнить очередь" с
// рейтлимитом (1 запрос/сек). Карта при этом рисует ОПТИМИСТИЧНОЕ превью очереди (перемещённое
// здание сразу видно на новом месте, старая клетка свободна для следующего действия, снесённое —
// исчезает), поэтому вся эта работа получается на дисплее ещё до реального выполнения. Улучшение
// (цели прокачки) — отдельный, уже существующий персистентный механизм (CityStrategy.targets),
// в общую очередь не входит, сохраняется своей кнопкой "Сохранить".

function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
function buildingName(b: BuildingDef): string {
  try { const n = JSON.parse(b.name) as { en?: string; ru?: string } | null; return n?.ru || n?.en || b.id; } catch { return b.id; }
}
// та же семья, что и familyId() в web/cityStats.js — звёздные варианты одного здания считаются
// одной семьёй ("_2_star.png" и т.п. -> ".png")
const familyId = (id: string) => id.replace(/_\d+_star\.png$/i, '.png');

// живой критерий доступности постройки (GET /buildings/criteria в самой игре) — форма ответа
// подтверждена по логу бота (logger.info в cityStrategy.js): {criteria: [{criteria_id, criteria_met,
// id, type: 'population'|'profit'|'invitations', population: {population, population_required}|null,
// profit: {profit, profit_required}|null, invitations_required, task}, ...]} — один или несколько
// объектов на здание (id), criteria_met — итоговый флаг "выполнено ли конкретно это условие".
interface BuildCriterion {
  criteria_id: number;
  criteria_met: boolean;
  id: string;
  type: string;
  population: { population: number; population_required: number } | null;
  profit: { profit: number; profit_required: number } | null;
  invitations_required: number | null;
}
function criteriaListFor(criteria: unknown, buildingId: string): BuildCriterion[] {
  const arr = (criteria as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(arr)) return [];
  return arr.filter((c): c is BuildCriterion => !!c && typeof c === 'object' && (c as any).id === buildingId);
}
function isCriteriaUnmet(criteria: unknown, buildingId: string): boolean {
  return criteriaListFor(criteria, buildingId).some(c => c.criteria_met === false);
}
// человекочитаемая причина недоступности — берём первое невыполненное условие
function criteriaReason(criteria: unknown, buildingId: string): string {
  const unmet = criteriaListFor(criteria, buildingId).find(c => c.criteria_met === false);
  if (!unmet) return 'Недоступно';
  if (unmet.type === 'population' && unmet.population) return `Нужно ${fmt(Math.ceil(unmet.population.population_required))} нас.`;
  if (unmet.type === 'profit' && unmet.profit) return `Нужна прибыль ${fmt(Math.ceil(unmet.profit.profit_required))}`;
  if (unmet.type === 'invitations' && unmet.invitations_required != null) return `Нужно приглашений: ${unmet.invitations_required}`;
  return 'Недоступно';
}
// цена постройки k-го здания семейства (0-индекс): Math.round(base_price · base_price_factor^k) ·
// buildCostMultiplier — сверено с бандлом игры (get actualBasePrice()). buildCostMultiplier — скидка
// от надетых политик (см. computeBuildCostMultiplier ниже), без нёе цена не совпадает со скидочной
// ценой в самой игре (только с "зачёркнутой" базовой, да и то не всегда — там ещё count может отличаться)
function buildPriceAt(info: BuildingDef, k: number, buildCostMultiplier = 1): number {
  return Math.round(Math.round((info.base_price || 0) * Math.pow(info.base_price_factor ?? 1, k)) * buildCostMultiplier);
}
// множитель цены от надетых политик (build_cost — постройка, upgrade_cost — улучшение) — сверено с
// бандлом (policyMultiplier: суммируем ВСЕ mult-эффекты с этим stat'ом аддитивно, затем 1+сумма,
// не ниже 0 — не перемножаем по одной, иначе две политики по -10% дали бы 0.81 вместо верных 0.8)
function computePolicyMultiplier(cabinet: PolicyCabinet | undefined, stat: string): number {
  let sum = 0;
  for (const slot of cabinet?.slots ?? []) {
    for (const e of slot.instance?.effects ?? []) {
      if (e.stat === stat && e.mode === 'mult') sum += e.value;
    }
  }
  return Math.max(0, 1 + sum);
}

const MODE_TITLE: Record<Exclude<CityActionMode, 'view' | 'skip'>, string> = {
  queue: 'Улучшение', upgrade: 'План', build: 'Строительство', move: 'Перемещение',
  demolish: 'Снос', reconstruct: 'Реконструкция', renovate: 'Реновация',
  boosters: 'Ускорители', log: 'Лог', forecast: 'Прогноз',
};

type PendingAction =
  | { id: number; kind: 'build'; family_id: string; x: number; y: number }
  | { id: number; kind: 'move'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { id: number; kind: 'demolish'; x: number; y: number }
  | { id: number; kind: 'reconstruct'; x: number; y: number }
  | { id: number; kind: 'renovate'; x: number; y: number };

// применяет всю очередь поверх реального состояния карты — оптимистичное превью для canvas и для
// расчёта валидных клеток (после queued-перемещения старая клетка свободна, новая занята, и т.д.)
function applyQueue(owned: MapBuilding[], queue: PendingAction[], catalog: BuildingDef[]): MapBuilding[] {
  let list = owned.map(b => ({ ...b }));
  for (const a of queue) {
    if (a.kind === 'build') {
      list.push({ x: a.x, y: a.y, id: a.family_id, level: 1 });
    } else if (a.kind === 'move') {
      const idx = list.findIndex(b => b.x === a.from.x && b.y === a.from.y);
      if (idx >= 0) list[idx] = { ...list[idx], x: a.to.x, y: a.to.y };
    } else if (a.kind === 'demolish') {
      list = list.filter(b => !(b.x === a.x && b.y === a.y));
    } else if (a.kind === 'reconstruct') {
      // сбрасывает здание на 1 уровень (подтверждено бандлом — "resetting the building to level 1")
      const idx = list.findIndex(b => b.x === a.x && b.y === a.y);
      if (idx >= 0) list[idx] = { ...list[idx], level: 1 };
    } else if (a.kind === 'renovate') {
      // эволюционирует в next_id (итоговый уровень бандлом не подтверждён — не гадаем, оставляем как есть)
      const idx = list.findIndex(b => b.x === a.x && b.y === a.y);
      const info = idx >= 0 ? catalog.find(c => c.id === list[idx].id) : null;
      if (idx >= 0 && info?.next_id) list[idx] = { ...list[idx], id: info.next_id };
    }
  }
  return list;
}

function actionLabel(a: PendingAction, labelFor: (id: string) => string, findInfoAt: (x: number, y: number) => BuildingDef | undefined): string {
  if (a.kind === 'build') return `Строительство: ${labelFor(a.family_id)} (${a.x},${a.y})`;
  if (a.kind === 'move') return `Перемещение: (${a.from.x},${a.from.y}) → (${a.to.x},${a.to.y})`;
  if (a.kind === 'demolish') return `Снос: (${a.x},${a.y})`;
  if (a.kind === 'reconstruct') {
    const info = findInfoAt(a.x, a.y);
    const cost = info?.components_required != null ? ` (−${info.components_required} компонентов` : '';
    const reward = info?.masterplans_to_get != null ? `${cost ? ', ' : ' ('}+${info.masterplans_to_get} мастерпланов` : '';
    const suffix = cost || reward ? `${cost}${reward})` : '';
    return `Реконструкция: (${a.x},${a.y})${suffix}`;
  }
  const info = findInfoAt(a.x, a.y);
  const cost = info?.masterplans_num != null ? ` (−${info.masterplans_num} мастерпланов)` : '';
  return `Реновация: (${a.x},${a.y})${cost}`;
}

// строка лога действий (вкладка "Лог") — building_id для booster_activate это id ТИПА ускорителя
// (не здание), поэтому его не прогоняем через labelFor, а через boosterLabelFor (config/items.json)
function logLabel(r: CityActionLogRow, labelFor: (id: string) => string, boosterLabelFor: (id: string) => string): string {
  const name = r.building_id ? labelFor(r.building_id) : '—';
  const dur = r.duration_ms ? ` за ${fmtTimeLeft(r.duration_ms)}` : '';
  switch (r.type) {
    case 'upgrade': return `Улучшение: ${name} (${r.x},${r.y}) ${r.level_from}→${r.level_to}${dur}`;
    case 'build': return `Строительство: ${name} (${r.x},${r.y})`;
    case 'move': return `Перемещение: (${r.from_x},${r.from_y}) → (${r.x},${r.y})`;
    case 'demolish': return `Снос: ${name} (${r.x},${r.y}), был ур. ${r.level_from}`;
    case 'reconstruct': return `Реконструкция: ${name} (${r.x},${r.y}), был ур. ${r.level_from}`;
    case 'renovate': return `Реновация: ${name} (${r.x},${r.y}), был ур. ${r.level_from}`;
    case 'booster_activate': return `${r.building_id ? boosterLabelFor(r.building_id) : 'Ускоритель'} активирован`;
    case 'booster_combine': {
      let detail: { toItemId?: string; requiredAmount?: number } = {};
      try { detail = r.detail ? JSON.parse(r.detail) : {}; } catch { /* старый/битый снимок */ }
      const fromName = r.building_id ? boosterLabelFor(r.building_id) : 'Ускоритель';
      const toName = detail.toItemId ? boosterLabelFor(detail.toItemId) : '?';
      return `Комбинирование: ${detail.requiredAmount ?? '?'}× ${fromName} → 1× ${toName}`;
    }
    case 'unlock_section': {
      let detail: { section_id?: string } = {};
      try { detail = r.detail ? JSON.parse(r.detail) : {}; } catch { /* старый/битый снимок — покажем без id */ }
      return `Разблокирована секция карты: ${detail.section_id ?? '—'}`;
    }
    default: return r.type;
  }
}

export function CityMapCity() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { flash, showFlash } = useFlash();

  const account = searchParams.get('account') ?? '';
  const mapType = 'city' as const;
  const [dayNight, setDayNight] = useMapDayNight();

  const [rows, setRows] = useState<CityRow[] | CapitalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildingsCatalog, setBuildingsCatalog] = useState<BuildingDef[]>([]);
  const [targets, setTargets] = useState<CityStrategyTarget[]>([]);
  const [manualQueue, setManualQueue] = useState<CityStrategyQueueItem[]>([]);
  const [reconstructPlan, setReconstructPlan] = useState<CityStrategyQueueItem[]>([]);
  const [planHover, setPlanHover] = useState<string[] | null>(null); // "x_y" клеток под курсором в «Плане»
  const planFocus = useMemo(() => planHover ? new Set(planHover) : null, [planHover]);
  // клетки плана ("x,y"), помеченные к удалению — уходят из целей только при «Сохранить»
  const [planRemoved, setPlanRemoved] = useState<Set<string>>(() => new Set());
  const markPlanRemoved = useCallback((keys: string[], on: boolean) => setPlanRemoved(prev => {
    const n = new Set(prev); for (const k of keys) { if (on) n.add(k); else n.delete(k); } return n;
  }), []);
  // запас компонентов/мастерпланов (вкладки "Реконструкция"/"Реновация") — из БД, подгружаем при
  // смене аккаунта, обновляем после каждой реконструкции/реновации (они тратят/дают эти предметы)
  const [components, setComponents] = useState(0);
  const [masterplans, setMasterplans] = useState(0);
  const loadResources = useCallback(() => {
    if (!account) return;
    api.cityResources(account).then(d => { if (d.ok) { setComponents(d.components); setMasterplans(d.masterplans); } });
  }, [account]);
  useEffect(() => { loadResources(); }, [loadResources]);
  // общий план по семействам — нужен только для показателей "после всех запланированных" (вкладка
  // "Просмотр"), не привязан к аккаунту, поэтому подгружаем один раз при заходе на страницу
  const [globalPlan, setGlobalPlan] = useState<GlobalUpgradeRule[]>([]);
  useEffect(() => { api.globalUpgradePlan().then(d => { if (d.ok) setGlobalPlan(d.plan); }); }, []);
  // закрытые секции карты — статический каталог (config/city_sections.json), общий для всех
  // городов, не привязан к аккаунту, поэтому грузим один раз при заходе на страницу
  const [sections, setSections] = useState<MapSection[]>([]);
  useEffect(() => { api.sections().then(d => { if (d.ok) setSections(d.sections); }); }, []);

  // живые обновления построек с сервера (SSE, без поллинга) — бот пишет свежий снимок при каждом
  // запуске/завершении стройки (см. modules/progress.js), сервер сразу транслирует его сюда;
  // обратный отсчёт на canvas и так пересчитывается локально раз в секунду (CityActionsCanvas.tsx),
  // здесь только обновляем исходные данные, откуда он берётся.
  useEffect(() => {
    if (!account) return;
    const es = new EventSource(`/api/city-strategy/${encodeURIComponent(account)}/live-stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as { buildings: MapBuilding[] };
      setRows(prev => (prev as CityRow[]).map(r =>
        r.account === account ? { ...r, buildings: data.buildings } : r
      ));
    };
    return () => es.close();
  }, [account]);

  // ── Ускорители/Лог/Прогноз — каждая вкладка подгружает своё при активации, не на общей загрузке
  // страницы (ускорители/лог — из БД, прогноз — единственный живой запрос всего раздела) ──────────
  const [boosters, setBoosters] = useState<CityBoosterRow[]>([]);
  // очередь активации: порядок = приоритет, цикл идёт по ней сверху вниз
  const [boosterQueue, setBoosterQueue] = useState<{ name: string; label: string }[]>([]);
  const [boostersLoading, setBoostersLoading] = useState(false);
  const [boosterActivating, setBoosterActivating] = useState<Set<string>>(new Set());
  const [boostersChecking, setBoostersChecking] = useResumableRefresh(`boostersCheck:${account}`, () => loadBoosters());
  const [actionLog, setActionLog] = useState<CityActionLogRow[]>([]);
  const [actionLogLoading, setActionLogLoading] = useState(false);
  const [forecastEvents, setForecastEvents] = useState<ForecastEvent[]>([]);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [coordsSet, setCoordsSet] = useState<Set<string>>(new Set());
  const [buildCostMultiplier, setBuildCostMultiplier] = useState(1);
  const [upgradeCostMultiplier, setUpgradeCostMultiplier] = useState(1);
  // для показателей города (computeCityStats mods) — политики этого аккаунта + гильдийский income_boost
  const [policyCabinet, setPolicyCabinet] = useState<PolicyCabinet | undefined>(undefined);
  const [guildIncomeBoost, setGuildIncomeBoost] = useState(0);
  const [diversityIncomeBoost, setDiversityIncomeBoost] = useState(0);
  const [balance, setBalance] = useState(0);
  const [buildCriteria, setBuildCriteria] = useState<unknown>(null);
  const [mode, setMode] = useState<CityActionMode>('view');
  const [busy, setBusy] = useState(false);

  // ── общая очередь одноразовых действий (копится между вкладками режима) ─────
  const [queue, setQueue] = useState<PendingAction[]>([]);
  const nextIdRef = useRef(1);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ── переходное состояние выбора (само действие ещё не добавлено в очередь) ──
  const [addLevel, setAddLevel] = useState('20');
  const [buildFamily, setBuildFamily] = useState('');
  const [moveFrom, setMoveFrom] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.city(),
      api.buildingsList('city'),
      account ? api.cityStrategy(account) : Promise.resolve({ ok: true, targets: [] as CityStrategyTarget[], queue: [] as CityStrategyQueueItem[], reconstructPlan: [] as CityStrategyQueueItem[] }),
      fetch('/api/coords?type=').then(r => r.json()).catch(() => ({ coords: [] })),
      api.policies().catch(() => ({ ok: false as const, byAccount: {} })),
      account ? api.cityGuildBenefits(account).catch(() => ({ ok: false as const, building_purchases_discount: 0, upgrades_discount: 0, income_boost: 0 })) : Promise.resolve({ ok: false as const, building_purchases_discount: 0, upgrades_discount: 0, income_boost: 0 }),
      api.accounts().catch(() => ({ ok: false as const, accounts: [] })),
      account ? api.cityBuildCriteria(account).catch(() => ({ ok: false as const, criteria: null })) : Promise.resolve({ ok: false as const, criteria: null }),
      account ? api.cityDiversity(account).catch(() => ({ ok: false as const, income_bonus: 0 })) : Promise.resolve({ ok: false as const, income_bonus: 0 }),
    ]).then(([c, b, t, co, pol, guild, accs, crit, diversity]) => {
      if (c.ok) setRows(c.rows);
      if (b.ok) setBuildingsCatalog(b.buildings);
      if (t.ok) { setTargets(t.targets); setPlanRemoved(new Set()); setManualQueue(t.queue ?? []); setReconstructPlan(t.reconstructPlan ?? []); }
      setCoordsSet(new Set((co.coords ?? []).map((cc: any) => `${cc.x}_${cc.y}`)));
      const accRow = accs.ok ? accs.accounts.find(a => a.name === account) : undefined;
      setBalance(accRow?.balance ?? 0);
      setBuildCriteria(crit.ok ? crit.criteria : null);
      // цена постройки = базовая формула · скидка политик · скидка гильдии — ДВА независимых
      // источника, перемножаются (сверено с бандлом: get actualBasePrice()·Gc().buildCostMultiplier,
      // а поверх — applyBuildingPurchaseDiscount из composable "benefits", building_purchases_discount).
      // Цена улучшения — та же схема, но своя пара полей (upgrade_cost политик · upgrades_discount
      // гильдии, см. modules/progress.js loadPolicyEffects)
      const policyBuildMult = pol.ok ? computePolicyMultiplier(pol.byAccount[account]?.cabinet, 'build_cost') : 1;
      const guildBuildMult = 1 - (guild.ok ? guild.building_purchases_discount : 0);
      setBuildCostMultiplier(policyBuildMult * guildBuildMult);
      const policyUpgradeMult = pol.ok ? computePolicyMultiplier(pol.byAccount[account]?.cabinet, 'upgrade_cost') : 1;
      const guildUpgradeMult = 1 - (guild.ok ? guild.upgrades_discount : 0);
      setUpgradeCostMultiplier(policyUpgradeMult * guildUpgradeMult);
      setPolicyCabinet(pol.ok ? pol.byAccount[account]?.cabinet : undefined);
      setGuildIncomeBoost(guild.ok ? guild.income_boost : 0);
      setDiversityIncomeBoost(diversity.ok ? diversity.income_bonus : 0);
    }).finally(() => setLoading(false));
  }, [account]);

  // смена аккаунта — сбросить режим, очередь и все незавершённые выборы
  useEffect(() => {
    setMode('view'); setQueue([]); setMoveFrom(null); setBuildFamily(''); setSearch(''); setCatFilter('');
  }, [account]);

  // убирает ОДНУ конкретную запись по позиции в массиве — та же клетка может стоять в очереди
  // несколько раз подряд (несколько последовательных апгрейдов), удалять нужно именно этот экземпляр
  const removeQueuedManual = (index: number) => setManualQueue(prev => prev.filter((_, i) => i !== index));
  const saveManualQueue = async () => {
    setBusy(true);
    try {
      const r = await api.saveCityQueue(account, manualQueue);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) refreshMap();
    }
    catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  const refreshMap = useCallback(() => {
    api.city().then(d => { if (d.ok) setRows(d.rows); });
  }, []);

  // "Обновить" — в отличие от refreshMap (читает кэш CitySnapshot из БД), реально дёргает /progress/
  // прямо сейчас, чтобы получить самые свежие постройки с живой игры
  const [liveRefreshing, setLiveRefreshing] = useResumableRefresh(`cityRefresh:${account}`, () => refreshMap());
  const doLiveRefresh = async () => {
    setLiveRefreshing(true);
    try {
      const r = await api.cityRefresh(account);
      if (r.ok) refreshMap(); else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setLiveRefreshing(false); }
  };

  // Строго СВОЙ снимок. Раньше здесь был запасной `?? rows[0]`: если снимка этого аккаунта ещё нет
  // (новая установка — строку создаёт первый проход бота или кнопка «Обновить»), карта молча
  // показывала чужой город — и чужие разблокированные секции, то есть замки не на своих местах.
  // Лучше пустая карта и явная подсказка, чем правдоподобно неверные данные.
  const row = (rows as Array<CityRow | CapitalRow>).find(r =>
    ('account' in r ? r.account : r.guild_title) === account
  ) ?? null;
  // имя берём из адреса, а не из строки снимка: пока снимка нет, заголовок всё равно должен
  // называть аккаунт, карту которого открыли
  const rowName = row ? ('guild_title' in row ? row.guild_title : row.account) : account;
  const noSnapshot = !row;
  const owned: MapBuilding[] = row?.buildings ?? [];
  // секции, уже открытые ЭТИМ аккаунтом — приходит прямо в CityRow (см. /api/city-snapshots), игра
  // отдаёт это готовым в /progress/ (см. modules/progress.js), отдельного живого запроса не нужно
  // null = снимок ещё не знает про секции. В этом случае замки НЕ рисуем: лучше показать карту
  // целиком, чем запереть весь город (у чужой установки именно так и выглядело — весь город под
  // замком, потому что первым снимок записал код, не заполнявший это поле).
  const unlockedSections: string[] | null = (row && 'unlockedSections' in row ? row.unlockedSections : null) ?? null;
  const lockedCellKeys = useMemo(() => {
    const s = new Set<string>();
    if (!unlockedSections) return s;
    const unlocked = new Set(unlockedSections);
    for (const sec of sections) { if (!unlocked.has(sec.id)) for (const c of sec.coordinates) s.add(`${c.x}_${c.y}`); }
    return s;
  }, [sections, unlockedSections]);

  // оптимистичное превью — то, что реально нарисуется и что используется для расчёта валидных клеток
  // индекс каталога по id: раньше по нему искали линейным buildingsCatalog.find() в десяти местах,
  // в том числе внутри filter/map по всем зданиям города — это O(зданий × каталога) на каждый
  // рендер страницы карты. С Map те же выборки стали линейными.
  const buildingParamMap = useMemo(() => new Map(buildingsCatalog.map(b => [b.id, b])), [buildingsCatalog]);
  const displayBuildings = useMemo(() => applyQueue(owned, queue, buildingsCatalog), [owned, queue, buildingsCatalog]);

  const labelFor = (id: string) => { const b = buildingParamMap.get(id); return b ? buildingName(b) : id; };
  // здание на клетке → его каталожная запись (для стоимости реконструкции/реновации в очереди действий)
  const findInfoAt = (x: number, y: number) => {
    const b = owned.find(o => o.x === x && o.y === y);
    return b ? buildingParamMap.get(b.id) : undefined;
  };

  // ── Показатели города (вкладка "Просмотр") — строго формулами игры (см. cityStats.ts, зеркало
  // src/web/cityStats.js) по РЕАЛЬНЫМ уровням из живого снимка (owned), без какой-либо надстройки —
  // должно бит-в-бит совпадать с тем, что отдаёт /progress/. Плюс проекция "после всех
  // запланированных": ручная очередь (+1 за каждую запись), личный план для этого города, общий план
  // по семействам (для клеток без личной цели) — та же приоритетность, что resolveEffectiveTargets в
  // modules/progress.js, но без учёта денег/строителей/времени (просто "если все цели будут
  // достигнуты", а не "когда именно").
  const cityStatsMods = useMemo(
    () => buildCityStatsMods(policyCabinet, guildIncomeBoost, diversityIncomeBoost, buildCostMultiplier, upgradeCostMultiplier),
    [policyCabinet, guildIncomeBoost, diversityIncomeBoost, buildCostMultiplier, upgradeCostMultiplier],
  );
  const currentStats = useMemo(() => computeCityStats(owned, buildingParamMap, cityStatsMods), [owned, buildingParamMap, cityStatsMods]);
  // БЕЗ модификаторов вообще — эмпирически подтверждено: именно ЭТО игра показывает как "Базовый
  // доход" на экране "Обзор доходов" (category_income/building_type_income у нас иначе сворачиваются
  // в per-building сумму ДО happiness — их эффект теперь явно выделяется в "Политики %", см. statsBlock)
  const currentStatsRaw = useMemo(() => computeCityStats(owned, buildingParamMap), [owned, buildingParamMap]);
  const projectedBuildings = useMemo(() => {
    const globalMap = new Map(globalPlan.map(g => [g.family_id, g.target_level]));
    const personalMap = new Map(targets.map(t => [`${t.x},${t.y}`, t.target_level]));
    const queueCounts = new Map<string, number>();
    for (const q of manualQueue) { const k = `${q.x},${q.y}`; queueCounts.set(k, (queueCounts.get(k) || 0) + 1); }
    return owned.map(b => {
      const key = `${b.x},${b.y}`;
      const lvl = Number(b.level) || 0;
      const queueCount = queueCounts.get(key) || 0;
      const target = personalMap.has(key) ? personalMap.get(key)! : (globalMap.get(b.id) ?? 0);
      // end: null — проекция "после всех запланированных" считает здание УЖЕ улучшенным целиком, а
      // не застрявшим в процессе стройки; иначе если здание из очереди прямо сейчас строится
      // (унаследованный b.end в будущем), computeCityStats зануляет его вклад целиком (см.
      // isUnderConstruction в cityStats.ts) — здание из очереди тогда просто пропадало бы из проекции
      return { ...b, level: Math.max(lvl + queueCount, target, lvl), end: null };
    });
  }, [owned, targets, manualQueue, globalPlan]);
  const projectedStats = useMemo(() => computeCityStats(projectedBuildings, buildingParamMap, cityStatsMods), [projectedBuildings, buildingParamMap, cityStatsMods]);
  const boosterLabelFor = (id: string) => { const b = boosters.find(x => x.name === id); return b ? b.label : `#${id}`; };

  function switchMode(m: CityActionMode) {
    setMode(m); setMoveFrom(null);
    if (m !== 'build') { setBuildFamily(''); setSearch(''); setCatFilter(''); }
  }

  // ── множества клеток по режимам (на основе ОПТИМИСТИЧНОГО состояния — с учётом очереди) ───────
  const occupiedSet = useMemo(() => new Set(displayBuildings.map(b => `${b.x}_${b.y}`)), [displayBuildings]);

  const upgradeableSet = useMemo(() => new Set(
    displayBuildings.filter(b => buildingParamMap.get(b.id)?.category !== 'special').map(b => `${b.x}_${b.y}`)
  ), [displayBuildings, buildingsCatalog]);

  // eligibility подтверждена реверсом бандла (BuildingMenu.js): is_reconstructible/is_renovatable +
  // required_lvl достигнут + здание НЕ в стройке (в бандле условие ровно такое:
  // is_reconstructible && !isUnderConstruction && level >= required_lvl). Про стройку мы забыли, и
  // клетка светилась доступной, пока шло улучшение — игра такое действие не принимает: уровень она
  // повышает сразу, а само здание до конца стройки занято.
  // Наличие component/masterplan по-прежнему не проверяем — это скажет сама игра.
  const underConstruction = (b: { end?: string | null }) => !!b.end && new Date(b.end).getTime() > Date.now();

  const reconstructableSet = useMemo(() => new Set(displayBuildings.filter(b => {
    const info = buildingParamMap.get(b.id);
    return !!info?.is_reconstructible && info.required_lvl != null
      && (Number(b.level) || 0) >= info.required_lvl && !underConstruction(b);
  }).map(b => `${b.x}_${b.y}`)), [displayBuildings, buildingsCatalog]);

  const renovatableSet = useMemo(() => new Set(displayBuildings.filter(b => {
    const info = buildingParamMap.get(b.id);
    return !!info?.is_renovatable && info.next_id != null && info.required_lvl != null
      && (Number(b.level) || 0) >= info.required_lvl && !underConstruction(b);
  }).map(b => `${b.x}_${b.y}`)), [displayBuildings, buildingsCatalog]);

  // для "Запланировать" в режиме реконструкции — здание ЕЩЁ не обязано быть на required_lvl прямо
  // сейчас (это и есть смысл планирования: назначить заранее, бот сам отправит реконструкцию, как
  // только уровень будет достигнут и стройка завершится, см. modules/progress.js
  // runPendingReconstructions) — единственное условие: здание вообще умеет реконструироваться
  const reconstructPlannableSet = useMemo(() => new Set(displayBuildings.filter(b => {
    const info = buildingParamMap.get(b.id);
    return !!info?.is_reconstructible && info.required_lvl != null;
  }).map(b => `${b.x}_${b.y}`)), [displayBuildings, buildingsCatalog]);

  // закрытые секции исключаем из "пусто, можно строить" — их разблокировка отдельное действие
  // (клик по такой клетке ловит CityActionsCanvas и предлагает открыть секцию, см. onUnlockCell)
  const emptySet = useMemo(() => new Set([...coordsSet].filter(k => !occupiedSet.has(k) && !lockedCellKeys.has(k))), [coordsSet, occupiedSet, lockedCellKeys]);

  const validSet = useMemo(() => {
    if (executing) return new Set<string>();
    switch (mode) {
      // наведение на клетку/здание в «Плане» — видны только они (как в реконструкции)
      case 'upgrade': return upgradeableSet;
      case 'queue': return upgradeableSet;
      case 'build': return buildFamily ? emptySet : new Set<string>();
      case 'move': return moveFrom ? emptySet : occupiedSet;
      case 'demolish': return occupiedSet;
      case 'reconstruct': return reconstructPlannableSet;
      case 'renovate': return renovatableSet;
      default: return new Set<string>();
    }
  }, [executing, mode, buildFamily, moveFrom, emptySet, occupiedSet, upgradeableSet, reconstructableSet, reconstructPlannableSet, renovatableSet]);

  // подсветка нужна только для переходного "откуда" при перемещении — всё остальное уже видно по
  // самому превью (построенное/снесённое/перемещённое здание меняется прямо на карте)
  const pickedSet = useMemo(() => {
    const s = new Set<string>();
    if (mode === 'move' && moveFrom) s.add(`${moveFrom.x}_${moveFrom.y}`);
    return s;
  }, [mode, moveFrom]);

  const toggleReconRef = useRef<(x: number, y: number) => void>(() => {});
  const handlePick = useCallback((gx: number, gy: number) => {
    if (mode === 'upgrade') {
      const lvl = Math.floor(Number(addLevel)) || 0;
      if (lvl <= 0) return;
      // защита от спец-зданий на уровне самой мутации — не только через validSet (кисть их и так не
      // подсвечивает, но если по какой-то причине validSet их пропустил, сюда они всё равно не попадут)
      const b = displayBuildings.find(o => o.x === gx && o.y === gy);
      if (b && buildingParamMap.get(b.id)?.category === 'special') return;
      // цель привязана к КОНКРЕТНОЙ клетке, не к семье — иначе клик по одному зданию задавал бы
      // цель сразу всем экземплярам той же семьи на карте
      setTargets(prev => [...prev.filter(t => !(t.x === gx && t.y === gy)), { x: gx, y: gy, target_level: lvl }]);
      markPlanRemoved([`${gx},${gy}`], false); // новая цель на помеченной клетке снимает пометку
    } else if (mode === 'queue') {
      const b = displayBuildings.find(o => o.x === gx && o.y === gy);
      if (b && buildingParamMap.get(b.id)?.category === 'special') return;
      // одно и то же здание можно поставить в очередь несколько раз подряд — несколько
      // последовательных апгрейдов (21→22, потом снова оно же 22→23 и т.д.); бот сам не выдаст
      // второй апгрейд той же клетке, пока она не освободится от предыдущего (см. progress.js
      // pickStrategyTargets — по одному апгрейду на клетку за проход). Убрать конкретную запись —
      // кнопкой × в списке ниже, не повторным кликом.
      setManualQueue(prev => [...prev, { x: gx, y: gy }]);
    } else if (mode === 'build') {
      if (!buildFamily) return;
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'build', family_id: buildFamily, x: gx, y: gy }]);
    } else if (mode === 'move') {
      if (!moveFrom) { setMoveFrom({ x: gx, y: gy }); }
      else {
        setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'move', from: moveFrom, to: { x: gx, y: gy } }]);
        setMoveFrom(null);
      }
    } else if (mode === 'demolish') {
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'demolish', x: gx, y: gy }]);
    } else if (mode === 'reconstruct') {
      toggleReconRef.current(gx, gy);
    } else if (mode === 'renovate') {
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'renovate', x: gx, y: gy }]);
    }
  }, [mode, addLevel, buildFamily, moveFrom, displayBuildings, buildingsCatalog, manualQueue]);

  // разблокировка закрытой секции карты — разовое живое действие (POST /progress/unlock-section),
  // клик по клетке закрытой секции ловит CityActionsCanvas сам, независимо от текущего режима
  const [unlockingSection, setUnlockingSection] = useState(false);
  const onUnlockCell = useCallback(async (sectionId: string) => {
    if (unlockingSection) return;
    const sec = sections.find(s => s.id === sectionId);
    const costParts: string[] = [];
    if (sec?.unlockCost.coins) costParts.push(`${fmt(sec.unlockCost.coins)} монет`);
    if (sec?.unlockCost.crystals) costParts.push(`${fmt(sec.unlockCost.crystals)} кристаллов`);
    const costText = costParts.length ? costParts.join(' + ') : 'бесплатно';
    if (!window.confirm(`Разблокировать эту секцию карты за ${costText}?`)) return;
    setUnlockingSection(true);
    try {
      const r = await api.cityActionUnlockSection(account, sectionId);
      if (r.ok) { showFlash('Секция разблокирована', true); refreshMap(); }
      else showFlash(r.error ?? 'Не удалось разблокировать секцию', false);
    } catch (e) { showFlash(String(e), false); } finally { setUnlockingSection(false); }
  }, [account, sections, unlockingSection, refreshMap, showFlash]);

  const removeQueued = (id: number) => setQueue(prev => prev.filter(a => a.id !== id));
  // Реконструкция одним кликом: клетка в плане — убрать из плана; уже отмечена сейчас — снять отметку;
  // готова (уровень набран, стройки нет) — отметить к выполнению кнопкой внизу; иначе — в план,
  // бот сам отправит её, когда здание дорастёт (modules/progress.js runPendingReconstructions).
  // План сохраняется сразу, без отдельной кнопки.
  // Кисть (выделение прямоугольником) зовёт onPick для каждой клетки подряд в одном обработчике:
  // раньше каждый вызов брал устаревший reconstructPlan из замыкания и слал свой POST — параллельные
  // транзакции replaceAll сталкивались на UNIQUE(account,x,y) и падали с ошибкой, а в плане оставалась
  // только последняя клетка. Теперь клики копятся в reconPendingRef и уходят одним запросом, а
  // сохранения идут строго по очереди.
  const reconPendingRef = useRef<{ base: CityStrategyQueueItem[]; next: CityStrategyQueueItem[] } | null>(null);
  const reconSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveReconstructPlanNow = (next: CityStrategyQueueItem[]) => {
    const pend = reconPendingRef.current;
    if (pend) { pend.next = next; setReconstructPlan(next); return; }
    reconPendingRef.current = { base: reconstructPlan, next };
    setReconstructPlan(next);
    reconSaveChainRef.current = reconSaveChainRef.current.then(async () => {
      const batch = reconPendingRef.current;
      reconPendingRef.current = null;
      if (!batch) return;
      try {
        const r = await api.saveReconstructPlan(account, batch.next);
        if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); setReconstructPlan(batch.base); }
      } catch (e) { showFlash(String(e), false); setReconstructPlan(batch.base); }
    });
  };
  const toggleReconstruct = (x: number, y: number) => {
    const plan = reconPendingRef.current?.next ?? reconstructPlan;
    if (plan.some(p => p.x === x && p.y === y)) { saveReconstructPlanNow(plan.filter(p => !(p.x === x && p.y === y))); return; }
    const q = queue.find(a => a.kind === 'reconstruct' && a.x === x && a.y === y);
    if (q) { setQueue(prev => prev.filter(a => a.id !== q.id)); return; }
    if (reconstructableSet.has(`${x}_${y}`)) setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'reconstruct', x, y }]);
    else saveReconstructPlanNow([...plan, { x, y }]);
  };
  toggleReconRef.current = toggleReconstruct;

  const loadBoosters = useCallback(() => {
    if (!account) return;
    setBoostersLoading(true);
    api.cityBoosters(account).then(d => { if (d.ok) { setBoosters(d.boosters); setBoosterQueue(d.queue ?? []); } else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setBoostersLoading(false));
  }, [account]);
  const loadActionLog = useCallback(() => {
    if (!account) return;
    setActionLogLoading(true);
    api.cityActionLog(account).then(d => { if (d.ok) setActionLog(d.rows); else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setActionLogLoading(false));
  }, [account]);
  const loadForecast = useCallback(() => {
    if (!account) return;
    setForecastLoading(true);
    api.cityForecast(account).then(d => { if (d.ok) setForecastEvents(d.events); else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setForecastLoading(false));
  }, [account]);

  // подгружаем данные вкладки при переключении на неё — не на общей загрузке страницы, т.к.
  // ускорители/лог читаются из БД по запросу, а прогноз — единственный живой запрос всего раздела
  useEffect(() => {
    if (mode === 'boosters') loadBoosters();
    else if (mode === 'log') { loadActionLog(); loadBoosters(); } // ускорители тоже — только для названий в логе (boosterLabelFor), из БД
    else if (mode === 'forecast') loadForecast();
  }, [mode, loadBoosters, loadActionLog, loadForecast]);

  const toggleBoosterAuto = async (name: string, enabled: boolean) => {
    setBoosters(prev => prev.map(b => (b.name === name ? { ...b, auto: enabled } : b)));
    const r = await api.saveBoosterAuto(account, name, enabled);
    if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); loadBoosters(); }
  };

  // ── Очередь активации ускорителей ───────────────────────────────────────────
  // Порядок = приоритет: цикл активирует первый доступный сверху, а когда слот освободится —
  // следующий. Так делается «сначала легендарный, потом мифический». Сохраняем весь порядок разом.
  const saveQueue = async (order: string[]) => {
    const prev = boosterQueue;
    setBoosterQueue(order.map(n => ({ name: n, label: boosterLabelFor(n) })));   // оптимистично
    const r = await api.saveBoosterQueue(account, order);
    if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); setBoosterQueue(prev); }
    else loadBoosters();   // подтянуть настоящие id позиций с сервера
  };
  // одно нажатие = +1 экземпляр в конец очереди
  const queueAdd = (name: string) => saveQueue([...boosterQueue.map(q => q.name), name]);
  // удаляем КОНКРЕТНУЮ позицию по индексу, а не все экземпляры типа
  const queueRemoveAt = (idx: number) => saveQueue(boosterQueue.filter((_, i) => i !== idx).map(q => q.name));
  // перетаскивание: позиция from встаёт на место to
  const queueReorder = (from: number, to: number) => {
    const next = boosterQueue.map(q => q.name);
    const [x] = next.splice(from, 1); next.splice(to, 0, x);
    saveQueue(next);
  };
  const activateBooster = async (name: string) => {
    setBoosterActivating(prev => new Set(prev).add(name));
    try {
      const r = await api.activateBooster(account, name);
      showFlash(r.ok ? `${boosterLabelFor(name)} активирован` : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) loadBoosters();
    } catch (e) { showFlash(String(e), false); }
    finally { setBoosterActivating(prev => { const next = new Set(prev); next.delete(name); return next; }); }
  };
  const checkBoosters = async () => {
    setBoostersChecking(true);
    try {
      const r = await api.checkBoosters(account);
      showFlash(r.ok ? (r.added ? `Сверено с игрой, новых ускорителей: ${r.added}` : 'Сверено с игрой') : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) loadBoosters();
    } catch (e) { showFlash(String(e), false); }
    finally { setBoostersChecking(false); }
  };

  const removeTarget = (x: number, y: number) => setTargets(prev => prev.filter(t => !(t.x === x && t.y === y)));
  const saveTargets = async () => {
    setBusy(true);
    try {
      const keep = targets.filter(t => !planRemoved.has(`${t.x},${t.y}`));
      const r = await api.saveCityStrategy(account, keep);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) { setTargets(keep); setPlanRemoved(new Set()); }
      // сервер сразу подтягивает актуальную карту построек с игры при сохранении целей (см.
      // cityStrategy.js) — обновляем отображение, не дожидаясь планового цикла бота
      if (r.ok) refreshMap();
    }
    catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  // выполнение очереди — по одному действию в секунду (рейтлимит), последовательно, не прерываясь
  // на ошибках отдельных действий (остальные всё равно выполняются)
  const runQueue = async () => {
    if (!queue.length || executing) return;
    setExecuting(true);
    setProgress({ done: 0, total: queue.length });
    let ok = 0, fail = 0;
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      try {
        let r: { ok: boolean };
        if (a.kind === 'build') r = await api.cityActionBuild(account, a.family_id, a.x, a.y);
        else if (a.kind === 'move') r = await api.cityActionMove(account, a.from, a.to);
        else if (a.kind === 'demolish') r = await api.cityActionDemolish(account, a.x, a.y);
        else if (a.kind === 'reconstruct') r = await api.cityActionReconstruct(account, a.x, a.y);
        else r = await api.cityActionRenovate(account, a.x, a.y);
        if (r.ok) ok++; else fail++;
      } catch { fail++; }
      setProgress({ done: i + 1, total: queue.length });
      if (i < queue.length - 1) await new Promise(res => setTimeout(res, 1000));
    }
    setQueue([]);
    setExecuting(false);
    setProgress(null);
    showFlash(`Выполнено: ${ok}${fail ? `, ошибок: ${fail}` : ''}`, fail === 0);
    refreshMap();
    // перемещение переносит координату цели улучшения вместе со зданием (см. cityStrategy.js) —
    // подтягиваем свежий список целей, чтобы бейдж "цур→цель" не остался на старой клетке
    api.cityStrategy(account).then(t => { if (t.ok) setTargets(t.targets); });
  };

  // цена каждого апгрейда в ручной очереди — та же формула, что использует бот (upgradeStep ·
  // множитель политик · скидка гильдии, см. modules/progress.js pickStrategyTargets), с уровня
  // fromLvl (текущий уровень здания + число более ранних повторов той же клетки в очереди)
  // монет на улучшения клетки с fromLvl до toLvl — для «Плана», та же формула и множитель
  const planUpgradeCost = useCallback((id: string, fromLvl: number, toLvl: number) => {
    const info = buildingParamMap.get(id);
    if (!info) return 0;
    let sum = 0;
    for (let l = Math.max(1, fromLvl); l < toLvl; l++) sum += upgradeStep(info, l);
    return Math.round(sum * upgradeCostMultiplier);
  }, [buildingParamMap, upgradeCostMultiplier]);

  const manualQueuePrices = useMemo(() => manualQueue.map((q, i) => {
    const b = owned.find(o => o.x === q.x && o.y === q.y);
    const info = b ? buildingParamMap.get(b.id) : undefined;
    if (!b || !info) return null;
    const priorSame = manualQueue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
    const fromLvl = (Number(b.level) || 0) + priorSame;
    return Math.round(upgradeStep(info, fromLvl) * upgradeCostMultiplier);
  }), [manualQueue, owned, buildingsCatalog, upgradeCostMultiplier]);

  // сколько уже стоит зданий каждой семьи (с учётом очереди — чтобы цена росла и для ещё не
  // выполненных, но уже поставленных в очередь построек той же семьи) — для buildPriceAt и лимитов
  const familyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of displayBuildings) m.set(familyId(b.id), (m.get(familyId(b.id)) ?? 0) + 1);
    return m;
  }, [displayBuildings]);

  // условие покупки не выполнено — семья уже построена в количестве, равном лимиту (напр.
  // спецздания вроде "Оплот мудрости" — лимит 1 на город); живой критерий игры (/buildings/criteria)
  // явно говорит "не выполнено" (напр. не хватает населения — конкретный порог не храним у себя,
  // это отдаёт сама игра); либо не хватает монет на цену со всеми скидками. Дальнейшая постройка
  // вернёт ошибку от игры, поэтому просто не даём выбрать такое здание, но оставляем в списке
  // видимым (в конце, неактивным).
  const isUnavailable = (b: BuildingDef) => {
    const k = familyCounts.get(familyId(b.id)) ?? 0;
    if (b.limit != null && k >= b.limit) return true;
    if (isCriteriaUnmet(buildCriteria, b.id)) return true;
    return buildPriceAt(b, k, buildCostMultiplier) > balance;
  };

  // палитра построимых зданий (Строительство) — поиск+категории, как в MapEditor.tsx
  const purchasable = useMemo(
    () => buildingsCatalog.filter(b => b.is_purchasable && !/_\d+_star\.png$/i.test(b.id)),
    [buildingsCatalog],
  );
  const paletteFiltered = purchasable.filter(b => {
    if (catFilter && buildingCat(b.id) !== catFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!buildingName(b).toLowerCase().includes(q) && !b.id.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // недоступные к покупке (лимит семьи исчерпан) — всегда в конец списка, вне зависимости от
    // остальной сортировки по категории
    const ua = isUnavailable(a), ub = isUnavailable(b);
    if (ua !== ub) return ua ? 1 : -1;
    // сортировка по показателю, релевантному именно этой категории — коммерческие по прибыли,
    // жилые по населению, служебные по покрытию (всё по убыванию — лучшее сверху); без выбранной
    // категории (ВСЕ) или для остального (SPE) — просто по алфавиту, смешивать разные метрики
    // в одном списке не имеет смысла
    if (catFilter === 'COM') return (b.base_profit ?? 0) - (a.base_profit ?? 0);
    if (catFilter === 'RES') return (b.base_population ?? 0) - (a.base_population ?? 0);
    if (catFilter === 'SER') return (b.service_coverage ?? 0) - (a.service_coverage ?? 0);
    return buildingName(a).localeCompare(buildingName(b), 'ru');
  });
  // COM первой вкладкой (по просьбе), затем остальные в естественном порядке появления в каталоге
  const CAT_ORDER = ['COM', 'RES'];
  const catRank = (c: string) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? 999 : i; };
  const paletteCats = [...new Set(purchasable.map(b => buildingCat(b.id)))].filter(Boolean).sort((a, b) => catRank(a) - catRank(b));

  // ── данные страниц сайдбара ─────────────────────────────────────────────────
  const nameWithStar = (id: string) => { const m = id.match(/_(\d+)_star\.png$/i); return m ? `${labelFor(id)} ★${m[1]}` : labelFor(id); };
  const ownedAt = (x: number, y: number) => owned.find(o => o.x === x && o.y === y);
  // сколько дохода в час и жителей уйдёт вместе со снесёнными зданиями — те же формулы игры, что у
  // показателей: всё вместе и по каждому зданию отдельно (для заливки строки)
  const demolish = useMemo(() => {
    const keys = queue.flatMap(a => a.kind === 'demolish' ? [`${a.x},${a.y}`] : []);
    const per = new Map<string, number>();
    if (!keys.length) return { loss: 0, pop: 0, per };
    const without = (gone: Set<string>) => computeCityStats(owned.filter(b => !gone.has(`${b.x},${b.y}`)), buildingParamMap, cityStatsMods);
    for (const k of keys) per.set(k, Math.max(0, currentStats.profitFinal - without(new Set([k])).profitFinal));
    const left = without(new Set(keys));
    return { loss: Math.max(0, currentStats.profitFinal - left.profitFinal), pop: Math.max(0, currentStats.population - left.population), per };
  }, [queue, owned, buildingParamMap, cityStatsMods, currentStats]);
  const demolishTiles = queue.flatMap(a => {
    if (a.kind !== 'demolish') return [];
    const b = ownedAt(a.x, a.y);
    return b ? [{ id: a.id, sprite: b.id, x: a.x, y: a.y, name: labelFor(b.id), level: Number(b.level) || 0, loss: demolish.per.get(`${a.x},${a.y}`) ?? 0 }] : [];
  });
  // кандидаты на реновацию — по РЕАЛЬНОМУ состоянию (превью очереди уже подменило бы здание на next_id)
  const renovateItems = owned.flatMap(b => {
    const info = buildingParamMap.get(b.id);
    if (!info?.is_renovatable || !info.next_id || info.required_lvl == null) return [];
    if ((Number(b.level) || 0) < info.required_lvl || underConstruction(b)) return [];
    const marked = queue.some(a => a.kind === 'renovate' && a.x === b.x && a.y === b.y);
    return [{ x: b.x, y: b.y, id: b.id, nextId: info.next_id, name: nameWithStar(b.id), nextName: nameWithStar(info.next_id), cost: info.masterplans_num, marked }];
  });
  // доход после реновации отмеченных: здание заменяется на следующий тир с тем же уровнем
  const renovateGain = useMemo(() => {
    const next = new Map(renovateItems.filter(i => i.marked).map(i => [`${i.x},${i.y}`, i.nextId]));
    if (!next.size) return 0;
    const after = owned.map(b => next.has(`${b.x},${b.y}`) ? { ...b, id: next.get(`${b.x},${b.y}`)! } : b);
    return computeCityStats(after, buildingParamMap, cityStatsMods).profitFinal - currentStats.profitFinal;
  }, [renovateItems.map(i => i.marked ? `${i.x},${i.y}` : '').join('|'), owned, buildingParamMap, cityStatsMods, currentStats]);
  // реконструкция: все клетки, которые умеют реконструироваться, группами по типу здания;
  // уровень — реальный (во время стройки игра уже отдаёт целевой, realLevel = level−1)
  const reconGroups = useMemo(() => {
    const m = new Map<string, ReconGroup>();
    for (const b of owned) {
      const info = buildingParamMap.get(b.id);
      if (!info?.is_reconstructible || info.required_lvl == null) continue;
      const building = underConstruction(b);
      const level = (Number(b.level) || 0) - (building ? 1 : 0);
      if (!m.has(b.id)) m.set(b.id, { id: b.id, name: nameWithStar(b.id), comp: info.components_required ?? null, gain: info.masterplans_to_get ?? null, cells: [] });
      m.get(b.id)!.cells.push({
        x: b.x, y: b.y, level, req: info.required_lvl, building, ready: !building && level >= info.required_lvl,
        queued: queue.some(a => a.kind === 'reconstruct' && a.x === b.x && a.y === b.y),
        planned: reconstructPlan.some(p => p.x === b.x && p.y === b.y),
      });
    }
    for (const g of m.values()) g.cells.sort((a, b) => b.level / b.req - a.level / a.req);
    return [...m.values()].sort((a, b) => b.cells.filter(c => c.ready).length - a.cells.filter(c => c.ready).length || a.name.localeCompare(b.name, 'ru'));
  }, [owned, buildingParamMap, queue, reconstructPlan]);
  const toggleRenovate = (x: number, y: number) => setQueue(prev => prev.some(a => a.kind === 'renovate' && a.x === x && a.y === y)
    ? prev.filter(a => !(a.kind === 'renovate' && a.x === x && a.y === y))
    : [...prev, { id: nextIdRef.current++, kind: 'renovate', x, y }]);
  const pendingRows = queue.map(a => {
    const at = a.kind === 'move' ? a.from : a.kind === 'build' ? null : { x: a.x, y: a.y };
    const sprite = a.kind === 'build' ? a.family_id : at ? ownedAt(at.x, at.y)?.id : undefined;
    return { id: a.id, kind: a.kind, label: actionLabel(a, labelFor, findInfoAt), sprite };
  });
  const pendingKinds = new Set(queue.map(a => a.kind));
  const dots: Partial<Record<PanelMode, boolean>> = {
    upgrade: targets.length > 0, queue: manualQueue.length > 0, build: pendingKinds.has('build'), move: pendingKinds.has('move'),
    demolish: pendingKinds.has('demolish'), reconstruct: pendingKinds.has('reconstruct'), renovate: pendingKinds.has('renovate'),
    boosters: boosterQueue.length > 0,
  };
  const moveFromInfo = moveFrom ? { ...moveFrom, id: displayBuildings.find(b => b.x === moveFrom.x && b.y === moveFrom.y)?.id, level: Number(displayBuildings.find(b => b.x === moveFrom.x && b.y === moveFrom.y)?.level) || undefined } : null;
  const moveRows = queue.flatMap(a => a.kind === 'move' ? [{ id: a.id, from: a.from, to: a.to, sprite: ownedAt(a.from.x, a.from.y)?.id }] : []);
  const moveQueued = (from: number, to: number) => setManualQueue(prev => { const n = [...prev]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; });

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const panelMode = mode as PanelMode;
  const HINT: Partial<Record<PanelMode, string>> = {
    view: 'Цифры города по формулам игры: сейчас и после выполнения всех планов и очереди.',
    upgrade: 'Кликните здание или проведите кистью по нескольким — им выставится цель из плашки с уровнем справа от дока. Бот сам ждёт строителей и улучшает до цели.',
    queue: 'Каждый клик по зданию добавляет один уровень в конец очереди, одно здание можно поставить несколько раз подряд. Свободные строители сначала разбирают очередь, потом переходят к плану. Порядок меняется перетаскиванием.',
    forecast: 'Что бот запустит в ближайшие трое суток: очередь, личный и общий план, с учётом накопления монет.',
    build: 'Выберите здание в списке, затем кликайте пустые клетки или проведите кистью. Каждая клетка добавляется в действия, которые выполнит кнопка «Выполнить».',
    move: 'Кликните здание, затем пустую клетку. Можно переместить несколько подряд. Цели и очередь переедут вместе со зданием, на экономику это не влияет.',
    demolish: 'Кликайте здания или проведите кистью. Монеты за снос не возвращаются. Нажмите на плитку, чтобы снять отметку.',
    reconstruct: 'Тратит компоненты, сбрасывает здание на 1 уровень и даёт мастерпланы. Клик по готовому зданию отмечает его к выполнению кнопкой внизу, по неготовому — ставит в план: бот сам сделает, когда здание дойдёт до нужного уровня. Повторный клик снимает.',
    renovate: 'Тратит мастерпланы и переводит здание в следующий звёздный тир. Отметьте здания и нажмите «Выполнить».',
    boosters: 'Бот активирует ускорители из очереди по порядку, как только освобождается слот. Молния рядом с ускорителем включает его сразу.',
    log: 'Последние действия по этому городу, и бота, и ручные.',
  };
  // кнопка действий на всю ширину: если в очереди только действия этой вкладки — её глагол и цвет
  const RUN_LABEL: Partial<Record<PanelMode, [string, 'primary' | 'danger' | 'accent']>> = {
    build: ['Построить', 'primary'], move: ['Переместить', 'accent'], demolish: ['Снести', 'danger'],
    reconstruct: ['Реконструировать', 'primary'], renovate: ['Реновировать', 'primary'],
  };
  const own = RUN_LABEL[mode as PanelMode];
  const [runLabel, runTone] = own && queue.every(a => a.kind === mode) ? own : ['Выполнить', 'primary' as const];
  const runFooter = queue.length > 0 && (
    <>
      <IconButton icon={XIcon} aria-label="Очистить" disabled={executing} onClick={() => setQueue([])} />
      <FooterButton label={executing && progress ? `Выполняется ${progress.done} из ${progress.total}` : runLabel} tone={runTone}
        icon={CheckIcon} count={queue.length} busy={executing} onClick={runQueue} />
    </>
  );
  const footer = mode === 'upgrade'
    ? <PlanSaveButton count={targets.filter(t => !planRemoved.has(`${t.x},${t.y}`)).length} busy={busy} onClick={saveTargets} />
    : mode === 'queue'
      ? <FooterButton label="Сохранить" icon={CheckIcon} count={manualQueue.length} busy={busy} onClick={saveManualQueue} />
      : runFooter || undefined;
  const headActions = mode === 'boosters'
    ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Сверить с игрой" disabled={boostersChecking} onClick={checkBoosters} />
    : mode === 'forecast'
      ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Пересчитать прогноз" disabled={forecastLoading} onClick={loadForecast} />
      : mode === 'log'
        ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Обновить лог" disabled={actionLogLoading} onClick={loadActionLog} />
        : undefined;
  const pendingNoDemolish = pendingRows.filter(r => r.kind !== 'demolish');

  return (
    <Box sx={{
      display: 'flex', height: 'calc(100vh - var(--header-h))',
      // телефон: карта сверху, сайдбар снизу — он всегда на экране, как и на десктопе
      '@media (max-width: 768px)': { flexDirection: 'column', height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        {/* toolbar */}
        <Box sx={{
          p: 2, bg: 'canvas.subtle',
          borderBottom: '1px solid', borderColor: 'border.default',
          display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
        }}>
          <Button leadingVisual={ChevronLeftIcon} onClick={() => navigate('/city')}>
            Назад
          </Button>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Heading as="h3" sx={{ fontSize: 2, m: 0 }}>{rowName}</Heading>
            <Text sx={{ fontSize: 0, color: noSnapshot ? 'attention.fg' : 'fg.muted' }}>
              {noSnapshot
                ? 'Снимка города ещё нет — нажмите «Обновить»'
                : <>Зданий: {owned.length}{row?.updated_at && ` · Обновлено: ${new Date(row.updated_at).toLocaleString('ru')}`}</>}
            </Text>
          </Box>
          <DayNightMenu value={dayNight} onChange={setDayNight} />
          <Button leadingVisual={SyncIcon} loading={liveRefreshing} disabled={liveRefreshing} onClick={doLiveRefresh}>Обновить</Button>
        </Box>

        {flash && (
          <Box sx={{ px: 3, pt: 2, flexShrink: 0 }}>
            <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>
          </Box>
        )}

        {/* canvas + палитра инструментов поверх него, по центру снизу */}
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          {owned.length === 0 && mode === 'view'
            ? <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text sx={{ color: 'fg.muted' }}>Нет данных о зданиях</Text>
              </Box>
            : <CityActionsCanvas
                buildings={displayBuildings}
                type={mapType}
                mapKey={account}
                mode={!executing ? mode : 'view'}
                validSet={validSet}
                pickedSet={pickedSet}
                targets={targets}
                queue={manualQueue}
                globalPlan={globalPlan}
                catalog={buildingsCatalog}
                onPick={handlePick}
                sections={sections}
                unlockedSections={unlockedSections ?? undefined}
                onUnlockCell={onUnlockCell}
                focusSet={mode === 'upgrade' ? planFocus : null}
                dayNight={dayNight}
              />
          }
          {/* док по центру; в «Плане» справа от него — уровень кисти (док при этом не сдвигается) */}
          <Box sx={{
            position: 'absolute', left: 2, right: 2, bottom: 3, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', columnGap: 2,
            pointerEvents: 'none', '& > *': { pointerEvents: 'auto' },
            '@media (max-width: 768px)': { display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 2 },
          }}>
            <Box sx={{ gridColumn: 2, minWidth: 0, maxWidth: '100%', display: 'flex' }}><MapPalette mode={panelMode} onSelect={switchMode} dots={dots} /></Box>
            {mode === 'upgrade' && <Box sx={{ gridColumn: 3, justifySelf: 'start' }}><MapBrushLevel value={Math.max(1, Math.floor(Number(addLevel)) || 1)} onChange={v => setAddLevel(String(v))} /></Box>}
          </Box>
        </Box>
      </Box>

      <Box sx={{
        // ширина как у левого меню навигации — как было у прежнего сайдбара карты
        width: 'var(--sidebar-w)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid', borderColor: 'border.default',
        '@media (max-width: 768px)': { width: '100%', height: '45%', borderLeft: 0, borderTop: '1px solid', borderTopColor: 'border.default' },
      }}>
        <PanelShell mode={panelMode} hint={HINT[panelMode] ?? ''} actions={headActions} footer={footer} gap={mode === 'build' ? 3 : 2}
          count={mode === 'queue' ? manualQueue.length : mode === 'boosters' ? boosterQueue.length : undefined}>

          {mode === 'view' && <StatsPanel raw={currentStatsRaw} s={currentStats} projected={projectedStats} mods={cityStatsMods} />}

          {mode === 'upgrade' && (
            <PlanPanel targets={targets} owned={owned} labelFor={labelFor}
              upgradeCost={planUpgradeCost} onHover={setPlanHover} removed={planRemoved} onMarkRemoved={markPlanRemoved} />
          )}

          {mode === 'queue' && (
            <QueuePanel queue={manualQueue} owned={owned} labelFor={labelFor} prices={manualQueuePrices} balance={balance}
              onReorder={moveQueued} onRemove={removeQueuedManual} />
          )}

          {mode === 'forecast' && <ForecastPanel events={forecastEvents} loading={forecastLoading} labelFor={labelFor} />}

          {mode === 'build' && (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextInput placeholder="Поиск" value={search} onChange={e => setSearch(e.target.value)} block />
                <div id="map-cat-tabs">
                  {['', ...paletteCats].map(cat => (
                    <span key={cat || '__all'} className={'map-cat-tab' + (catFilter === cat ? ' active' : '')} onClick={() => setCatFilter(cat)}>
                      {cat || 'ВСЕ'}
                    </span>
                  ))}
                </div>
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  {paletteFiltered.map(b => {
                    const k = familyCounts.get(familyId(b.id)) ?? 0;
                    const limitReached = b.limit != null && k >= b.limit;
                    const criteriaUnmet = !limitReached && isCriteriaUnmet(buildCriteria, b.id);
                    const price = buildPriceAt(b, k, buildCostMultiplier);
                    const unaffordable = !limitReached && !criteriaUnmet && price > balance;
                    const unavailable = limitReached || criteriaUnmet || unaffordable;
                    return (
                      <div key={b.id}
                        className={'map-bitem' + (buildFamily === b.id ? ' active' : '') + (unavailable ? ' disabled' : '')}
                        onClick={() => { if (!unavailable) setBuildFamily(b.id); }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buildingName(b)}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 600, color: unavailable ? 'var(--fg-muted)' : 'var(--fg)', flexShrink: 0 }}>
                          {limitReached ? 'Построено' : criteriaUnmet ? criteriaReason(buildCriteria, b.id) : <CoinValue value={fmt(price)} />}
                        </span>
                      </div>
                    );
                  })}
                </Box>
              </Box>
              <PendingList rows={pendingRows} disabled={executing} onRemove={removeQueued} />
            </>
          )}

          {mode === 'move' && (
            <>
              <MovePanel from={moveFromInfo} moves={moveRows} labelFor={labelFor} disabled={executing} onCancel={() => setMoveFrom(null)} onRemove={removeQueued} />
              <PendingList rows={pendingRows.filter(r => r.kind !== 'move')} disabled={executing} onRemove={removeQueued} />
            </>
          )}

          {mode === 'demolish' && (
            <>
              <DemolishPanel tiles={demolishTiles} lossPerHour={demolish.loss} popLoss={demolish.pop} income={currentStats.profitFinal} disabled={executing} onRemove={removeQueued} />
              <PendingList rows={pendingNoDemolish} disabled={executing} onRemove={removeQueued} />
            </>
          )}

          {mode === 'reconstruct' && (
            <>
              <ReconstructPanel groups={reconGroups} components={components} disabled={executing} onToggle={toggleReconstruct} />
              <PendingList rows={pendingRows.filter(r => r.kind !== 'reconstruct')} disabled={executing} onRemove={removeQueued} />
            </>
          )}

          {mode === 'renovate' && (
            <>
              <RenovatePanel masterplans={masterplans} items={renovateItems} incomeGain={renovateGain} onToggle={toggleRenovate} disabled={executing} />
              <PendingList rows={pendingRows.filter(r => r.kind !== 'renovate')} disabled={executing} onRemove={removeQueued} />
            </>
          )}

          {mode === 'boosters' && (
            <BoostersPanel boosters={boosters} loading={boostersLoading} queue={boosterQueue} activating={boosterActivating}
              onAdd={queueAdd} onReorder={queueReorder} onRemoveAt={queueRemoveAt} onActivate={activateBooster} />
          )}

          {mode === 'log' && <LogPanel rows={actionLog} loading={actionLogLoading} label={r => logLabel(r, labelFor, boosterLabelFor)} labelFor={labelFor} />}

          {mode === 'skip' && <Empty>—</Empty>}
        </PanelShell>
      </Box>
    </Box>
  );
}
