import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Spinner, Text, TextInput } from '@primer/react';
import { ChevronLeftIcon, SidebarExpandIcon, SyncIcon, XIcon } from '@primer/octicons-react';
import { useRegisterPanelToggle } from '../contexts/PanelToggleContext';
import { api, type CityRow, type CapitalRow, type BuildingDef, type CityStrategyTarget, type CityStrategyQueueItem, type MapBuilding, type PolicyCabinet, type CityBoosterRow, type CityActionLogRow, type ForecastEvent, type GlobalUpgradeRule, type CityStats, type ServiceCat, type MapSection } from '../api';
import { CityActionsCanvas, type CityActionMode } from '../components/CityActionsCanvas';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { Scrollable } from '../components/Scrollable';
import { fmt, itemImgSrc } from '../utils';
import { CoinValue } from '../components/Icons';
import { upgradeStep, computeCityStats, type CityStatsMods } from '../cityStats';

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

const SERVICE_CAT_LABEL: Record<ServiceCat, string> = { hospital: 'Больницы', 'police-station': 'Полиция', 'fire-station': 'Пожарные', park: 'Парки' };
// как в игре — 2 знака после запятой (fmt() из utils.ts даёт 1, используется везде ещё, здесь нужна
// именно игровая точность: "2.19B", "2.97B")
function fmtStat(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}
function statRow(label: string, value: string) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{label}</Text>
      <Text sx={{ fontSize: 0 }}>{value}</Text>
    </Box>
  );
}
// запас предмета сверху вкладки "Реконструкция"/"Реновация" — иконка + число из БД (Inventory)
function resourceHeader(tag: 'component' | 'masterplan', label: string, count: number) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <img src={itemImgSrc(tag)} alt="" width={28} height={28}
        onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
      <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>{label}: {count}</Text>
    </Box>
  );
}
// разбивка прибыли — точно как в игре на экране "Обзор доходов": Базовый доход → Бонус гильдии %
// → Политики % → Разнообразие % → Итого. "Базовый доход" в игре — это доход СОВСЕМ без политик
// (даже без category_income/building_type_income, которые у нас иначе сворачиваются в per-building
// сумму до happiness) — поэтому база берётся из `raw` (computeCityStats БЕЗ mods), а "Политики %" —
// комбинированный эффект category/type-множителей (уже осевших в s.profit) И глобального
// (mods.globalIncomeMult), взятых ВМЕСТЕ относительно raw.profit, а не только глобальный множитель.
// "Разнообразие" — GET /progress/diversity → income_bonus (найден 2026-07-17, формулы в бандле нет).
function statsBlock(title: string, raw: CityStats, s: CityStats, mods: CityStatsMods) {
  const base = raw.profit * raw.happiness;
  const guildPct = (mods.incomeBoost ?? 0) * 100;
  const combinedPolicyMult = raw.profit > 0 ? (s.profit / raw.profit) * (mods.globalIncomeMult ?? 1) : (mods.globalIncomeMult ?? 1);
  const policyPct = (combinedPolicyMult - 1) * 100;
  const diversityPct = (mods.diversityIncomeBoost ?? 0) * 100;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
      <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>{title}</Text>
      <Box sx={{ mb: 2 }}>
        {statRow('Население', fmtStat(s.population))}
      </Box>
      {statRow('Базовый доход/ч', fmtStat(base))}
      {statRow('Бонус гильдии', `${guildPct >= 0 ? '+' : ''}${guildPct.toFixed(0)}%`)}
      {statRow('Политики', `${policyPct >= 0 ? '+' : ''}${policyPct.toFixed(0)}%`)}
      {statRow('Разнообразие', `${diversityPct >= 0 ? '+' : ''}${diversityPct.toFixed(0)}%`)}
      {statRow('Итого/ч', fmtStat(s.profitFinal))}
      <Box sx={{ mt: 2 }}>
        {statRow('Счастье', `${(s.happiness * 100).toFixed(1)}%`)}
      </Box>
      {(Object.keys(SERVICE_CAT_LABEL) as ServiceCat[]).map(k => (
        statRow(`${SERVICE_CAT_LABEL[k]}: ${fmtStat(s.coverageByCat[k])}`, `${(s.serviceRatios[k] * 100).toFixed(0)}%`)
      ))}
    </Box>
  );
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
function fmtTimeLeft(ms: number): string {
  if (ms <= 0) return '0м';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
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

  const [rows, setRows] = useState<CityRow[] | CapitalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildingsCatalog, setBuildingsCatalog] = useState<BuildingDef[]>([]);
  const [targets, setTargets] = useState<CityStrategyTarget[]>([]);
  const [manualQueue, setManualQueue] = useState<CityStrategyQueueItem[]>([]);
  const [reconstructPlan, setReconstructPlan] = useState<CityStrategyQueueItem[]>([]);
  const [schedulingReconstruct, setSchedulingReconstruct] = useState(false);
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
  // правый сайдбар (показатели/действия) на мобильном — по умолчанию свёрнут, как левое меню
  // навигации, открывается кнопкой в общем мобильном хидере (см. .map-panel в global.css)
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const openMobilePanel = useCallback(() => setMobilePanelOpen(true), []);
  useRegisterPanelToggle(useMemo(() => ({ onOpen: openMobilePanel, icon: SidebarExpandIcon, label: 'Открыть панель' }), [openMobilePanel]));

  // ── общая очередь одноразовых действий (копится между вкладками режима) ─────
  const [queue, setQueue] = useState<PendingAction[]>([]);
  const nextIdRef = useRef(1);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ── переходное состояние выбора (само действие ещё не добавлено в очередь) ──
  const [addLevel, setAddLevel] = useState('10');
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
      if (t.ok) { setTargets(t.targets); setManualQueue(t.queue ?? []); setReconstructPlan(t.reconstructPlan ?? []); }
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
  const projectedStatsRaw = useMemo(() => computeCityStats(projectedBuildings, buildingParamMap), [projectedBuildings, buildingParamMap]);
  const boosterLabelFor = (id: string) => { const b = boosters.find(x => x.name === id); return b ? b.label : `#${id}`; };

  function switchMode(m: CityActionMode) {
    setMode(m); setMoveFrom(null);
    if (m !== 'build') { setBuildFamily(''); setSearch(''); setCatFilter(''); }
    // на мобильном выбор вкладки — это и есть намерение увидеть её содержимое, поэтому сразу
    // открываем правый сайдбар (на десктопе класс .open ни на что не влияет — там сайдбар всегда виден)
    if (window.innerWidth <= 768) setMobilePanelOpen(true);
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
      case 'upgrade': case 'queue': return upgradeableSet;
      case 'build': return buildFamily ? emptySet : new Set<string>();
      case 'move': return moveFrom ? emptySet : occupiedSet;
      case 'demolish': return occupiedSet;
      case 'reconstruct': return schedulingReconstruct ? reconstructPlannableSet : reconstructableSet;
      case 'renovate': return renovatableSet;
      default: return new Set<string>();
    }
  }, [executing, mode, buildFamily, moveFrom, emptySet, occupiedSet, upgradeableSet, reconstructableSet, reconstructPlannableSet, renovatableSet, schedulingReconstruct]);

  // подсветка нужна только для переходного "откуда" при перемещении — всё остальное уже видно по
  // самому превью (построенное/снесённое/перемещённое здание меняется прямо на карте)
  const pickedSet = useMemo(() => {
    const s = new Set<string>();
    if (mode === 'move' && moveFrom) s.add(`${moveFrom.x}_${moveFrom.y}`);
    return s;
  }, [mode, moveFrom]);

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
      if (schedulingReconstruct) {
        // план — не список повторов, а просто "запланировано/нет" для клетки: повторный клик снимает
        setReconstructPlan(prev => prev.some(p => p.x === gx && p.y === gy)
          ? prev.filter(p => !(p.x === gx && p.y === gy))
          : [...prev, { x: gx, y: gy }]);
      } else {
        setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'reconstruct', x: gx, y: gy }]);
      }
    } else if (mode === 'renovate') {
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'renovate', x: gx, y: gy }]);
    }
  }, [mode, addLevel, buildFamily, moveFrom, displayBuildings, buildingsCatalog, manualQueue, schedulingReconstruct]);

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
  const removeReconstructPlanned = (x: number, y: number) => setReconstructPlan(prev => prev.filter(p => !(p.x === x && p.y === y)));
  const saveReconstructPlan = async () => {
    setBusy(true);
    try {
      const r = await api.saveReconstructPlan(account, reconstructPlan);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

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
  // сколько экземпляров этого типа уже стоит в очереди (повторы разрешены)
  const queuedCount = (name: string) => boosterQueue.filter(q => q.name === name).length;
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
  const queueMove = (idx: number, dir: -1 | 1) => {
    const next = boosterQueue.map(q => q.name);
    const to = idx + dir;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to], next[idx]];
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
      const r = await api.saveCityStrategy(account, targets);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
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
  const manualQueuePrices = useMemo(() => manualQueue.map((q, i) => {
    const b = owned.find(o => o.x === q.x && o.y === q.y);
    const info = b ? buildingParamMap.get(b.id) : undefined;
    if (!b || !info) return null;
    const priorSame = manualQueue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
    const fromLvl = (Number(b.level) || 0) + priorSame;
    return Math.round(upgradeStep(info, fromLvl) * upgradeCostMultiplier);
  }), [manualQueue, owned, buildingsCatalog, upgradeCostMultiplier]);
  const manualQueueTotal = manualQueuePrices.reduce((s: number, p) => s + (p ?? 0), 0);

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

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const showSidebar = true;

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - var(--header-h))' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
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
          <Button leadingVisual={SyncIcon} loading={liveRefreshing} disabled={liveRefreshing} onClick={doLiveRefresh}>Обновить</Button>
        </Box>

        {flash && (
          <Box sx={{ px: 3, pt: 2, flexShrink: 0 }}>
            <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>
          </Box>
        )}

        {/* canvas */}
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
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
              />
          }
        </Box>
      </Box>

      {showSidebar && (
        <div className={`map-panel-overlay${mobilePanelOpen ? ' show' : ''}`} onClick={() => setMobilePanelOpen(false)} />
      )}
      {showSidebar && (
        <div className={`map-panel${mobilePanelOpen ? ' open' : ''}`}>
          {/* крестик — только на мобильном оверлее (см. .map-panel-head в global.css), ровно на
              месте кнопки открытия в хидере */}
          <div className="map-panel-head">
            <IconButton icon={XIcon} aria-label="Закрыть панель" variant="invisible" onClick={() => setMobilePanelOpen(false)} />
          </div>
          <div className="map-panel-tabs">
            <Button variant={mode === 'view' ? 'primary' : 'default'} onClick={() => switchMode('view')}>Показатели</Button>
            {(['queue', 'upgrade', 'build', 'move', 'demolish', 'reconstruct', 'renovate', 'boosters', 'log', 'forecast'] as const).map(m => (
              <Button key={m} variant={mode === m ? 'primary' : 'default'} onClick={() => switchMode(m)}>{MODE_TITLE[m]}</Button>
            ))}
          </div>
          <Scrollable style={{ flex: 1 }}>
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>

                      {mode === 'view' && (
                        <>
                          {statsBlock('Сейчас', currentStatsRaw, currentStats, cityStatsMods)}
                          {statsBlock('После улучшений', projectedStatsRaw, projectedStats, cityStatsMods)}
                        </>
                      )}

                      {mode === 'queue' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            Кликните здание — оно встанет в конец очереди. Можно выбрать одно и то же
                            здание несколько раз подряд — несколько последовательных апгрейдов (бот
                            сам не запустит следующий, пока клетка не освободится от предыдущего).
                            Пока в очереди есть здания, свободные строители сначала разбирают их (по
                            одному на строителя, в порядке очереди) и только потом переходят к плану.
                          </Text>
                          {manualQueue.length === 0
                            ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Очередь пуста</Text>
                            : <>
                              {manualQueue.map((q, i) => {
                                const b = owned.find(o => o.x === q.x && o.y === q.y);
                                // порядковый номер ЭТОГО же здания среди более ранних записей очереди —
                                // каждый последующий повтор поднимает уровень ещё на 1 относительно текущего
                                const priorSame = manualQueue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
                                const fromLvl = b ? (Number(b.level) || 0) + priorSame : null;
                                const price = manualQueuePrices[i];
                                return (
                                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                    <Text sx={{ fontSize: 1 }}>
                                      {i + 1}. {b ? labelFor(b.id) : '—'} ({q.x},{q.y}){fromLvl != null ? ` ${fromLvl}→${fromLvl + 1}` : ''}
                                    </Text>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                      {price != null && <CoinValue value={fmt(price)} />}
                                      <Button variant="danger" onClick={() => removeQueuedManual(i)}>×</Button>
                                    </Box>
                                  </Box>
                                );
                              })}
                              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1, borderTop: '1px solid', borderColor: 'border.default' }}>
                                <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>Итого (со скидками)</Text>
                                <Text sx={{ fontSize: 1, fontWeight: 'bold' }}><CoinValue value={fmt(manualQueueTotal)} /></Text>
                              </Box>
                            </>}
                          <Button variant="primary" block loading={busy} disabled={busy} onClick={saveManualQueue}>Сохранить</Button>
                        </>
                      )}

                      {mode === 'upgrade' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            Кликните по зданию — цель сохранится для этой клетки. Можно и «кистью»:
                            зажмите левую кнопку и проведите по нескольким зданиям сразу — всем им
                            выставится один и тот же целевой уровень. Бот сам ждёт освобождения
                            строителей и улучшает до нужного уровня.
                          </Text>
                          <Box>
                            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Целевой уровень</Text>
                            <TextInput type="number" value={addLevel} onChange={e => setAddLevel(e.target.value)} block />
                          </Box>
                          {targets.length === 0
                            ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Целей пока нет</Text>
                            : targets.map(t => {
                              const b = owned.find(o => o.x === t.x && o.y === t.y);
                              return (
                                <Box key={`${t.x},${t.y}`} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                  <Text sx={{ fontSize: 1 }}>{b ? labelFor(b.id) : '—'} ({t.x},{t.y}) → ур. {t.target_level}</Text>
                                  <Button variant="danger" onClick={() => removeTarget(t.x, t.y)}>×</Button>
                                </Box>
                              );
                            })}
                          <Button variant="primary" block loading={busy} disabled={busy} onClick={saveTargets}>Сохранить</Button>
                        </>
                      )}

                      {mode === 'build' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            Выберите здание в списке, затем кликайте пустые клетки на карте — или
                            зажмите левую кнопку и проведите кистью по нескольким сразу. Каждая клетка
                            добавляется в очередь ниже.
                          </Text>
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
                        </>
                      )}

                      {mode === 'move' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            {!moveFrom ? 'Кликните здание, которое хотите переместить.' : 'Теперь кликните пустую клетку — куда переместить.'}
                            {' '}Можно переместить сразу несколько — после каждой пары карта сразу
                            покажет здание на новом месте, а старая клетка освобождается для следующего.
                            Косметика — на экономику не влияет.
                          </Text>
                          {moveFrom && <Text sx={{ fontSize: 1 }}>Откуда: ({moveFrom.x},{moveFrom.y})</Text>}
                          {moveFrom && <Button onClick={() => setMoveFrom(null)}>Отменить выбор</Button>}
                        </>
                      )}

                      {mode === 'demolish' && (
                        <Text sx={{ fontSize: 0, color: 'danger.fg' }}>
                          Кликайте здания для сноса — или зажмите левую кнопку и проведите кистью,
                          чтобы отметить сразу область. Без возврата монет.
                        </Text>
                      )}

                      {mode === 'reconstruct' && (
                        <>
                          {resourceHeader('component', 'Компонентов', components)}
                          <Box sx={{ display: 'flex', gap: 1 }}>
                            <Button variant={!schedulingReconstruct ? 'primary' : 'default'} onClick={() => setSchedulingReconstruct(false)}>Сейчас</Button>
                            <Button variant={schedulingReconstruct ? 'primary' : 'default'} onClick={() => setSchedulingReconstruct(true)}>Запланировать</Button>
                          </Box>
                          {!schedulingReconstruct ? (
                            <>
                              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                                Тратит «Компонент», сбрасывает здание на 1 уровень взамен на мастерпланы.
                                Подсвечены только уже подходящие здания (уровень уже достигнут) — кликайте
                                или выделяйте кистью, выполнится сразу кнопкой «Выполнить».
                              </Text>
                              {reconstructableSet.size === 0 && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Нет зданий, подходящих под реконструкцию прямо сейчас</Text>}
                            </>
                          ) : (
                            <>
                              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                                Кликните здание (не обязательно уже готовое) — бот сам отправит
                                реконструкцию, как только оно достигнет нужного уровня и не будет занято
                                стройкой. Повторный клик снимает план.
                              </Text>
                              {reconstructPlan.length === 0
                                ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Ничего не запланировано</Text>
                                : reconstructPlan.map(p => {
                                  const b = owned.find(o => o.x === p.x && o.y === p.y);
                                  const info = b ? buildingParamMap.get(b.id) : undefined;
                                  const endMs = b?.end ? new Date(b.end).getTime() : 0;
                                  const underConstruction = endMs > Date.now();
                                  // во время стройки игра уже отдаёт b.level КАК ЦЕЛЕВОЙ (после завершения), а не
                                  // текущий реальный — поэтому пока стройка идёт, показываем b.level-1 как реальный
                                  // уровень и явно помечаем "в процессе", вместо вводящего в заблуждение "25/25"
                                  // (реконструкция всё равно не уйдёт, пока стройка не закончится — см. progress.js)
                                  const realLevel = b ? (Number(b.level) || 0) - (underConstruction ? 1 : 0) : null;
                                  return (
                                    <Box key={`${p.x},${p.y}`} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                      <Box>
                                        <Text sx={{ fontSize: 1 }}>
                                          {b ? labelFor(b.id) : '—'} ({p.x},{p.y})
                                          {underConstruction
                                            ? ` — ур. ${realLevel}→${b!.level} (стройка, осталось ${fmtTimeLeft(endMs - Date.now())})`
                                            : info?.required_lvl != null ? ` — ур. ${realLevel ?? '?'}/${info.required_lvl}` : ''}
                                        </Text>
                                        {(info?.components_required != null || info?.masterplans_to_get != null) && (
                                          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>
                                            {info?.components_required != null && `−${info.components_required} компонентов`}
                                            {info?.components_required != null && info?.masterplans_to_get != null && ' · '}
                                            {info?.masterplans_to_get != null && `+${info.masterplans_to_get} мастерпланов`}
                                          </Text>
                                        )}
                                      </Box>
                                      <Button variant="danger" onClick={() => removeReconstructPlanned(p.x, p.y)}>×</Button>
                                    </Box>
                                  );
                                })}
                              <Button variant="primary" block loading={busy} disabled={busy} onClick={saveReconstructPlan}>Сохранить</Button>
                            </>
                          )}
                        </>
                      )}

                      {mode === 'renovate' && (
                        <>
                          {resourceHeader('masterplan', 'Мастерпланов', masterplans)}
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            Тратит «Мастерплан», эволюционирует здание в следующий звёздный тир.
                            Подсвечены только подходящие здания — кликайте или выделяйте кистью.
                          </Text>
                          {renovatableSet.size === 0 && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Нет зданий, подходящих под реновацию</Text>}
                        </>
                      )}

                      {mode === 'boosters' && (
                        <>
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <Button disabled={boostersChecking} loading={boostersChecking} onClick={checkBoosters}>Обновить с игры</Button>
                          </Box>

                          {/* Очередь активации: порядок = приоритет. Цикл активирует первый доступный
                              сверху, а как освободится слот — следующий (напр. лега → мифик). */}
                          <Box sx={{ p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                            <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block', mb: 1 }}>Очередь активации</Text>
                            {boosterQueue.length === 0
                              ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Пусто — добавьте ускорители кнопкой «В очередь» ниже</Text>
                              : boosterQueue.map((q, i) => (
                                  <Box key={`${q.name}:${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '4px' }}>
                                    <Text sx={{ fontSize: 0, color: 'fg.muted', width: 18 }}>{i + 1}.</Text>
                                    <Text sx={{ fontSize: 1, flex: 1, minWidth: 0 }}>{q.label}</Text>
                                    <Button size="small" variant="invisible" disabled={i === 0} onClick={() => queueMove(i, -1)}>↑</Button>
                                    <Button size="small" variant="invisible" disabled={i === boosterQueue.length - 1} onClick={() => queueMove(i, 1)}>↓</Button>
                                    <Button size="small" variant="danger" onClick={() => queueRemoveAt(i)}>✕</Button>
                                  </Box>
                                ))}
                            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
                              Бот активирует по порядку: пока занят слот одного типа, другой тип ждёт; как только
                              освободится — встанет следующий из очереди.
                            </Text>
                          </Box>

                          {boostersLoading ? <Spinner />
                            : boosters.length === 0 ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Ускорителей в инвентаре нет</Text>
                            : boosters.map(b => {
                              const canActivate = b.available > 0 && b.currently_active < b.active_limit && !b.blocked_by_other;
                              const activating = boosterActivating.has(b.name);
                              return (
                                <Box key={b.name} sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                  <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>{b.label}</Text>
                                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                                    Активно: {b.currently_active}/{b.active_limit} · В наличии: {b.available}
                                    {b.currently_active > 0 && b.ends_at != null && ` · осталось ${fmtTimeLeft(b.ends_at - Date.now())}`}
                                  </Text>
                                  {b.blocked_by_other && <Text sx={{ fontSize: 0, color: 'attention.fg' }}>Заблокировано другим активным ускорителем</Text>}
                                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    {/* вместо «Активировать» — постановка в очередь: цикл сам активирует
                                        по порядку, как только освободится слот (см. modules/boosterAutomation.js) */}
                                    {/* одно нажатие = +1 экземпляр; ограничение — сколько реально
                                        есть в наличии, больше в очередь ставить бессмысленно */}
                                    <Button variant="primary" disabled={queuedCount(b.name) >= b.available}
                                      onClick={() => queueAdd(b.name)}>
                                      В очередь{queuedCount(b.name) > 0 ? ` (${queuedCount(b.name)}/${b.available})` : ''}
                                    </Button>
                                    <Button variant="invisible" disabled={!canActivate || activating} loading={activating}
                                      onClick={() => activateBooster(b.name)} sx={{ fontSize: 0 }}>Активировать сейчас</Button>
                                  </Box>
                                </Box>
                              );
                            })}
                        </>
                      )}

                      {mode === 'log' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Последние действия по этому городу — и бота, и ручные.</Text>
                          {actionLogLoading ? <Spinner />
                            : actionLog.length === 0 ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Лог пуст</Text>
                            : actionLog.map(r => (
                              <Box key={r.id} sx={{ p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                <Text sx={{ fontSize: 1, display: 'block' }}>{logLabel(r, labelFor, boosterLabelFor)}</Text>
                                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{new Date(r.created_at).toLocaleString('ru')}</Text>
                              </Box>
                            ))}
                        </>
                      )}

                      {mode === 'forecast' && (
                        <>
                          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                            Реальные предполагаемые действия бота на ближайшие ~3 суток — очередь,
                            личный и общий планы, с учётом накопления монет от прибыли города.
                          </Text>
                          <Button loading={forecastLoading} disabled={forecastLoading} onClick={loadForecast}>Обновить прогноз</Button>
                          {forecastLoading ? null : forecastEvents.length === 0
                            ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Прогноз пуст — нечего запускать в ближайшие 3 суток</Text>
                            : (() => {
                              const groups = new Map<string, ForecastEvent[]>();
                              for (const e of forecastEvents) {
                                const day = new Date(e.start).toLocaleDateString('ru');
                                if (!groups.has(day)) groups.set(day, []);
                                groups.get(day)!.push(e);
                              }
                              return [...groups.entries()].map(([day, evs]) => (
                                <Box key={day} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted' }}>{day}</Text>
                                  {evs.map((e, i) => (
                                    <Box key={i} sx={{ p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                                      <Text sx={{ fontSize: 1, display: 'block' }}>{labelFor(e.building_id)} ({e.x},{e.y}) {e.level_from}→{e.level_to}</Text>
                                      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                                        {new Date(e.start).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} — займёт {fmtTimeLeft(e.duration_ms)}
                                      </Text>
                                    </Box>
                                  ))}
                                </Box>
                              ));
                            })()}
                        </>
                      )}

                      {/* ── общая очередь действий — видна в любой вкладке ── */}
                      {queue.length > 0 && (
                        <Box sx={{ borderTop: '1px solid', borderColor: 'border.default', pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted' }}>Очередь ({queue.length})</Text>
                          {queue.map(a => (
                            <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                              <Text sx={{ fontSize: 1 }}>{actionLabel(a, labelFor, findInfoAt)}</Text>
                              <Button variant="danger" disabled={executing} onClick={() => removeQueued(a.id)}>×</Button>
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  </Scrollable>

                  {queue.length > 0 && (
                    <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default' }}>
                      <Button variant="primary" block loading={executing} disabled={executing} onClick={runQueue}>
                        {executing && progress ? `Выполняется ${progress.done}/${progress.total}…` : `Выполнить очередь (${queue.length})`}
                      </Button>
                    </Box>
                  )}
                </div>
              )}
    </Box>
  );
}
