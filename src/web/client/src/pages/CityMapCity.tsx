import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Text, TextInput } from '@primer/react';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronUpIcon, SyncIcon, XIcon, ZapIcon } from '@primer/octicons-react';
import { api, type CityRow, type CapitalRow, type BuildingDef, type CityStrategyTarget, type CityStrategyQueueItem, type MapBuilding, type PolicyCabinet, type CityBoosterRow, type CityActiveBooster, type CityActionLogRow, type ForecastEvent, type GlobalUpgradeRule, type CityStats, type ServiceCat, type MapSection } from '../api';
import { CityActionsCanvas, type CityActionMode, type CellFill } from '../components/CityActionsCanvas';
import { MapLoader, DATA_SHARE, allCounted } from '../components/MapLoader';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { useMapDayNight } from '../hooks/useMapDayNight';
import { DayNightMenu } from '../components/DayNightMenu';
import type { DayNightMode } from '../components/mapNight';
import { fmt } from '../utils';
import { CoinValue } from '../components/Icons';
import { upgradeStep, computeCityStats, type CityStatsMods } from '../cityStats';
import { MapPalette, MapBrushLevel, PanelShell, BuildItem, Val, fmtUp, StatsPanel, PlanPanel, PlanSaveButton, FooterButton, CancelButton, QueuePanel, PendingList, MovePanel, DemolishPanel, ReconstructPanel, RenovatePanel, BoostersPanel, type DemolishTile, type RenovItem, LogPanel, ForecastPanel, Empty, fmtTimeLeft, Caption, Row, Thumb, fillOf, FILL_ATTENTION, type PanelMode, type ReconGroup } from './cityMapPanels';
import { useAsk } from '../hooks/useAsk';
import { useNarrow } from '../hooks/useNarrow';
import { LoadError } from '../components/LoadError';
import { onServerEvent } from '../serverEvents';

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

// проекция «после всех запланированных»: ручная очередь (+1 за запись), личный план, общий план по семействам
export function projectBuildings(owned: MapBuilding[], targets: CityStrategyTarget[], manualQueue: CityStrategyQueueItem[], globalPlan: GlobalUpgradeRule[]): MapBuilding[] {
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
}

// «Показатели» города по снимку и данным из БД (политики, бонусы гильдии и разнообразия) — без загрузки
// самого города: «Города» показывают их при наведении и пока город грузится. Те же формулы, что у панели города
export function cityStatsFor(owned: MapBuilding[], paramMap: Map<string, BuildingDef>, cabinet: PolicyCabinet | undefined,
  guild: { income_boost: number; building_purchases_discount: number; upgrades_discount: number } | undefined, diversity: number,
  targets: CityStrategyTarget[], queue: CityStrategyQueueItem[], globalPlan: GlobalUpgradeRule[]) {
  const mods = buildCityStatsMods(cabinet, guild?.income_boost ?? 0, diversity,
    computePolicyMultiplier(cabinet, 'build_cost') * (1 - (guild?.building_purchases_discount ?? 0)),
    computePolicyMultiplier(cabinet, 'upgrade_cost') * (1 - (guild?.upgrades_discount ?? 0)));
  return {
    raw: computeCityStats(owned, paramMap), s: computeCityStats(owned, paramMap, mods),
    projected: computeCityStats(projectBuildings(owned, targets, queue, globalPlan), paramMap, mods), mods,
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

export function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
export function buildingName(b: BuildingDef): string {
  try { const n = JSON.parse(b.name) as { en?: string; ru?: string } | null; return n?.ru || n?.en || b.id; } catch { return b.id; }
}
// та же семья, что и familyId() в web/cityStats.js — звёздные варианты одного здания считаются
// одной семьёй ("_2_star.png" и т.п. -> ".png")
export const familyId = (id: string) => id.replace(/_\d+_star\.png$/i, '.png');

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
export function buildPriceAt(info: BuildingDef, k: number, buildCostMultiplier = 1): number {
  return Math.round(Math.round((info.base_price || 0) * Math.pow(info.base_price_factor ?? 1, k)) * buildCostMultiplier);
}
// множитель цены от надетых политик (build_cost — постройка, upgrade_cost — улучшение) — сверено с
// бандлом (policyMultiplier: суммируем ВСЕ mult-эффекты с этим stat'ом аддитивно, затем 1+сумма,
// не ниже 0 — не перемножаем по одной, иначе две политики по -10% дали бы 0.81 вместо верных 0.8)
export function computePolicyMultiplier(cabinet: PolicyCabinet | undefined, stat: string): number {
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
export function logLabel(r: CityActionLogRow, labelFor: (id: string) => string, boosterLabelFor: (id: string) => string): string {
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

const isUnderway = (b: { end?: string | null }) => !!b.end && new Date(b.end).getTime() > Date.now();

// Какие клетки города годятся для каждого действия — одна функция для карты города и для городов
// общей карты, которые ещё не открывались (их клик потом выполняет этот же код города).
// Реконструкция/реновация сверены с бандлом (BuildingMenu.js): флаг здания + required_lvl достигнут +
// здание НЕ в стройке (игра повышает уровень сразу, а само здание до конца стройки занято). Наличие
// компонентов/мастерпланов не проверяем — это скажет сама игра. Для плана реконструкции уровень не
// нужен: бот отправит её сам, когда здание дорастёт (progress.js runPendingReconstructions).
// Закрытые секции и клетки отложенной стройки — не «пусто».
export interface CityCellSets { occupied: Set<string>; upgradeable: Set<string>; reconstructable: Set<string>; renovatable: Set<string>; reconstructPlannable: Set<string>; empty: Set<string> }
export function cityCellSets(display: MapBuilding[], catMap: Map<string, BuildingDef>, coords: Iterable<string>, locked: Set<string>, deferred: Set<string>): CityCellSets {
  const out: CityCellSets = { occupied: new Set(), upgradeable: new Set(), reconstructable: new Set(), renovatable: new Set(), reconstructPlannable: new Set(), empty: new Set() };
  for (const b of display) {
    const k = `${b.x}_${b.y}`, info = catMap.get(b.id), lvl = Number(b.level) || 0, busy = isUnderway(b);
    out.occupied.add(k);
    if (info?.category !== 'special') out.upgradeable.add(k);
    if (info?.is_reconstructible && info.required_lvl != null) {
      out.reconstructPlannable.add(k);
      if (lvl >= info.required_lvl && !busy) out.reconstructable.add(k);
    }
    if (info?.is_renovatable && info.next_id != null && info.required_lvl != null && lvl >= info.required_lvl && !busy) out.renovatable.add(k);
  }
  for (const k of coords) if (!out.occupied.has(k) && !locked.has(k) && !deferred.has(k)) out.empty.add(k);
  return out;
}
const cellsKeyOf = (a: { x: number; y: number }[]) => a.map(v => `${v.x},${v.y}`).join(';');

export function validCellsFor(mode: CityActionMode, s: CityCellSets, buildFamily: string, moveFrom: { x: number; y: number } | null): Set<string> {
  switch (mode) {
    case 'upgrade': case 'queue': return s.upgradeable;
    case 'build': return buildFamily ? s.empty : new Set<string>();
    case 'move': return moveFrom ? s.empty : s.occupied;
    case 'demolish': return s.occupied;
    case 'reconstruct': return s.reconstructPlannable;
    case 'renovate': return s.renovatable;
    default: return new Set<string>();
  }
}

// Город крупным планом. Открывается с общей карты всех городов (pages/CityWorld.tsx): account,
// вкладка и выход обратно приходят оттуда. Без пропсов (старый адрес /city-map?account=) аккаунт
// берётся из адреса.
export interface CityMapCityProps {
  account?: string;
  mode?: CityActionMode;
  onModeChange?: (m: CityActionMode) => void;
  onBack?: () => void;     // «Все города»
  onZoomOut?: () => void;  // колесо наружу на самом мелком масштабе — обратно на общую карту
  // ── город на общей карте всех городов (pages/CityWorld.tsx): своей карты и страницы нет ──
  slots?: { head: HTMLElement | null; side: HTMLElement | null; dock: HTMLElement | null };
  onMap?: (m: CityMapState) => void;   // что рисовать на общей карте в этом городе (координаты города)
  dayNight?: DayNightMode;
  onDayNight?: (m: DayNightMode) => void;
  panelActions?: ReactNode;            // кнопки общей страницы в шапке сайдбара
  hidden?: boolean;                    // город не текущий: панели нет, но черновик и превью на карте живут
  // выбранное здание для стройки и уровень кисти — общие для всех городов общей карты
  tool?: { buildFamily: string; setBuildFamily: (v: string) => void; addLevel: string; setAddLevel: (v: string) => void };
}

export interface RunResult { ok: number; fail: number; deferred: number; error?: string }
export interface PendingView { id: number; kind: string; label: string; sprite?: string; price?: number; over?: boolean }

// город на общей карте: его постройки с превью действий и всё, что карта выделяет в его клетках
export interface CityMapState {
  account: string;
  buildings: MapBuilding[];
  mode: CityActionMode;
  validSet: Set<string>;
  pickedSet: Set<string>;
  targets: CityStrategyTarget[];
  queue: CityStrategyQueueItem[];
  focusSet: Set<string> | null;
  onPick: (x: number, y: number) => void;
  onUnlockCell: (sectionId: string) => void;
  draft: boolean;                      // есть несохранённые действия: город держится на карте и не теряет их
  dots: Partial<Record<PanelMode, boolean>>;
  fills: CellFill[];                   // отложенная стройка («ждёт монет»)
  // «Ждут выполнения» для сводки всех городов: строки, деньги и запуск без своей панели
  pending: PendingView[];
  demolish: { tiles: DemolishTile[]; loss: number; pop: number; income: number };
  balance: number;
  buildBlock: string | null;           // выбранное здание здесь не построить: причина (лимит, условие игры)
  buildMult: number;                   // множитель цены постройки (политики · гильдия)
  moving: boolean;                     // перемещение: здание взято, ждёт клетку «куда»
  executing: boolean;
  run: () => Promise<RunResult | null>;
  removePending: (id: number) => void;
  cancelPending: () => void;
  cancelMove: () => void;
  // ручная очередь для сводки всех городов: цены, правка черновика и сохранение без своей панели
  recon: { groups: ReconGroup[]; components: number };
  renov: { masterplans: number; items: RenovItem[] };
  queuePrices: (number | null)[];
  queueDirty: boolean;
  editQueue: (fn: (q: CityStrategyQueueItem[]) => CityStrategyQueueItem[]) => void;
  saveQueue: () => Promise<boolean>;
  resetQueue: () => void;
}

export function CityMapCity(props: CityMapCityProps = {}) {
  const ask = useAsk();
  const narrow = useNarrow();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { flash, showFlash } = useFlash();

  const account = props.account ?? searchParams.get('account') ?? '';
  const goBack = props.onBack ?? (() => navigate('/city'));
  const mapType = 'city' as const;
  const [ownDayNight, setOwnDayNight] = useMapDayNight();
  const dayNight = props.dayNight ?? ownDayNight;
  const setDayNight = props.onDayNight ?? setOwnDayNight;

  const [rows, setRows] = useState<CityRow[] | CapitalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataDone, setDataDone] = useState(0); // сколько запросов загрузки страницы уже ответило
  const [buildingsCatalog, setBuildingsCatalog] = useState<BuildingDef[]>([]);
  const [targets, setTargets] = useState<CityStrategyTarget[]>([]);
  const [manualQueue, setManualQueue] = useState<CityStrategyQueueItem[]>([]);
  // сохранённые на сервере цели и очередь — к ним возвращает «Отменить»
  const [savedTargets, setSavedTargets] = useState<CityStrategyTarget[]>([]);
  const [savedManualQueue, setSavedManualQueue] = useState<CityStrategyQueueItem[]>([]);
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
  // accountRef — ответ за прошлый аккаунт (быстрый переход назад/вперёд) не затирает текущий
  const accountRef = useRef(account);
  accountRef.current = account;
  const loadResources = useCallback(() => {
    if (!account) return;
    api.cityResources(account).then(d => {
      if (d.ok && accountRef.current === account) { setComponents(d.components); setMasterplans(d.masterplans); }
    });
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
    // на общей карте городов открыто сразу несколько: свой SSE на каждый упёрся бы в лимит соединений
    // браузера, поэтому там постройки приходят из общего потока событий бота
    if (props.slots) return onServerEvent<{ account: string; buildings: MapBuilding[] }>('city', d => {
      if (d.account === account) setRows(prev => (prev as CityRow[]).map(r => r.account === account ? { ...r, buildings: d.buildings } : r));
    });
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
  const [boosterActive, setBoosterActive] = useState<CityActiveBooster[]>([]);
  // очередь активации: порядок = приоритет, цикл идёт по ней сверху вниз
  const [boosterQueue, setBoosterQueue] = useState<{ name: string; label: string }[]>([]);
  // сохранённая очередь: правки копятся черновиком и уходят только по «Применить»
  const [boosterQueueSaved, setBoosterQueueSaved] = useState<{ name: string; label: string }[]>([]);
  const [boosterSaving, setBoosterSaving] = useState(false);
  const [boostersLoading, setBoostersLoading] = useState(false);
  const [boostersChecking, setBoostersChecking] = useResumableRefresh(`boostersCheck:${account}`, () => loadBoosters());
  const [actionLog, setActionLog] = useState<CityActionLogRow[]>([]);
  const [actionLogLoading, setActionLogLoading] = useState(false);
  const [forecastEvents, setForecastEvents] = useState<ForecastEvent[]>([]);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [coordsSet, setCoordsSet] = useState<Set<string>>(new Set());
  // множители цены: политики (из БД) · скидка гильдии (живой запрос) — перемножаются
  const [policyMults, setPolicyMults] = useState({ build: 1, upgrade: 1 });
  const [guildDisc, setGuildDisc] = useState({ build: 0, upgrade: 0 });
  const buildCostMultiplier = policyMults.build * (1 - guildDisc.build);
  const upgradeCostMultiplier = policyMults.upgrade * (1 - guildDisc.upgrade);
  // для показателей города (computeCityStats mods) — политики этого аккаунта + гильдийский income_boost
  const [policyCabinet, setPolicyCabinet] = useState<PolicyCabinet | undefined>(undefined);
  const [guildIncomeBoost, setGuildIncomeBoost] = useState(0);
  const [diversityIncomeBoost, setDiversityIncomeBoost] = useState(0);
  const [balance, setBalance] = useState(0);
  const [walletRest, setWalletRest] = useState({ crystals: 0, stakedCoins: 0, stakedCrystals: 0 });
  const [buildCriteria, setBuildCriteria] = useState<unknown>(null);
  const [ownMode, setOwnMode] = useState<CityActionMode>(props.mode ?? 'view');
  const mode = props.mode ?? ownMode;
  const setMode = (m: CityActionMode) => { setOwnMode(m); props.onModeChange?.(m); };
  const [busy, setBusy] = useState(false);

  // ── общая очередь одноразовых действий (копится между вкладками режима) ─────
  const [queue, setQueue] = useState<PendingAction[]>([]);
  const nextIdRef = useRef(1);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ── переходное состояние выбора (само действие ещё не добавлено в очередь) ──
  const [ownAddLevel, setOwnAddLevel] = useState('20');
  const [ownBuildFamily, setOwnBuildFamily] = useState('');
  const addLevel = props.tool?.addLevel ?? ownAddLevel;
  const setAddLevel = props.tool?.setAddLevel ?? setOwnAddLevel;
  const buildFamily = props.tool?.buildFamily ?? ownBuildFamily;
  const setBuildFamily = props.tool?.setBuildFamily ?? setOwnBuildFamily;
  // отложенная стройка: здания, на которые не хватило монет; бот построит сам (progress.js runPendingBuilds)
  const [buildPlan, setBuildPlan] = useState<{ x: number; y: number; family_id: string }[]>([]);
  const [moveFrom, setMoveFrom] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState('');
  // вкладки категорий без «ВСЕ»: по умолчанию COM
  const [catFilter, setCatFilter] = useState('COM');

  const [loadErr, setLoadErr] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setDataDone(0);
    setLoadErr('');
    // только этот аккаунт: раньше карта тянула снимки, политики и балансы всего флота
    allCounted([
      account ? api.city(account) : Promise.resolve({ ok: true, rows: [] as CityRow[] }),
      api.buildingsList('city'),
      account ? api.cityStrategy(account) : Promise.resolve({ ok: true, targets: [] as CityStrategyTarget[], queue: [] as CityStrategyQueueItem[], reconstructPlan: [] as CityStrategyQueueItem[], buildPlan: [] as { x: number; y: number; family_id: string }[] }),
      fetch('/api/coords?type=').then(r => r.json()).catch(() => ({ coords: [] })),
      (account ? api.policies(account) : Promise.resolve({ ok: false as const, byAccount: {} })).catch(() => ({ ok: false as const, byAccount: {} })),
      // скидки гильдии и условия построек — из БД: их пишет бот (цикл прокачки, квесты гильдии) и кнопка «Обновить»
      account ? api.cityGuildBenefits(account).catch(() => ({ ok: false as const, building_purchases_discount: 0, upgrades_discount: 0, income_boost: 0 })) : Promise.resolve({ ok: false as const, building_purchases_discount: 0, upgrades_discount: 0, income_boost: 0 }),
      (account ? api.accounts(account) : Promise.resolve({ ok: false as const, accounts: [] })).catch(() => ({ ok: false as const, accounts: [] })),
      account ? api.cityBuildCriteria(account).catch(() => ({ ok: false as const, criteria: null })) : Promise.resolve({ ok: false as const, criteria: null }),
      account ? api.cityDiversity(account).catch(() => ({ ok: false as const, income_bonus: 0 })) : Promise.resolve({ ok: false as const, income_bonus: 0 }),
    ], () => { if (!stale) setDataDone(n => n + 1); }).then(([c, b, t, co, pol, guild, accs, crit, diversity]) => {
      if (stale) return;
      if (c.ok) setRows(c.rows);
      else setLoadErr((c as { error?: string }).error || 'снимок города не загрузился');
      if (b.ok) setBuildingsCatalog(b.buildings);
      if (t.ok) { setTargets(t.targets); setSavedTargets(t.targets); setPlanRemoved(new Set()); setManualQueue(t.queue ?? []); setSavedManualQueue(t.queue ?? []); setReconstructPlan(t.reconstructPlan ?? []); setBuildPlan(t.buildPlan ?? []); }
      setCoordsSet(new Set((co.coords ?? []).map((cc: any) => `${cc.x}_${cc.y}`)));
      const accRow = accs.ok ? accs.accounts.find(a => a.name === account) : undefined;
      setBalance(accRow?.balance ?? 0);
      setWalletRest({ crystals: accRow?.crystals ?? 0, stakedCoins: accRow?.staked_coins ?? 0, stakedCrystals: accRow?.staked_crystals ?? 0 });
      setBuildCriteria(crit.ok ? crit.criteria : null);
      // цена постройки = базовая формула · скидка политик · скидка гильдии — ДВА независимых
      // источника, перемножаются (сверено с бандлом: get actualBasePrice()·Gc().buildCostMultiplier,
      // а поверх — applyBuildingPurchaseDiscount из composable "benefits", building_purchases_discount).
      // Цена улучшения — та же схема, но своя пара полей (upgrade_cost политик · upgrades_discount
      // гильдии, см. modules/progress.js loadPolicyEffects)
      setPolicyMults({
        build: pol.ok ? computePolicyMultiplier(pol.byAccount[account]?.cabinet, 'build_cost') : 1,
        upgrade: pol.ok ? computePolicyMultiplier(pol.byAccount[account]?.cabinet, 'upgrade_cost') : 1,
      });
      setGuildDisc({ build: guild.ok ? guild.building_purchases_discount : 0, upgrade: guild.ok ? guild.upgrades_discount : 0 });
      setPolicyCabinet(pol.ok ? pol.byAccount[account]?.cabinet : undefined);
      setGuildIncomeBoost(guild.ok ? guild.income_boost : 0);
      setDiversityIncomeBoost(diversity.ok ? diversity.income_bonus : 0);
    }).catch(e => { if (!stale) setLoadErr(String(e)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [account, reloadTick]);

  // смена аккаунта — сбросить очередь и все незавершённые выборы (вкладка остаётся, если её ведёт общая карта)
  useEffect(() => {
    if (!props.mode) setOwnMode('view');
    setQueue([]); setMoveFrom(null); setOwnBuildFamily(''); setSearch(''); setCatFilter('');
  }, [account]);

  // убирает ОДНУ конкретную запись по позиции в массиве — та же клетка может стоять в очереди
  // несколько раз подряд (несколько последовательных апгрейдов), удалять нужно именно этот экземпляр
  const removeQueuedManual = (index: number) => setManualQueue(prev => prev.filter((_, i) => i !== index));
  const saveManualQueue = async () => {
    setBusy(true);
    try {
      const r = await api.saveCityQueue(account, manualQueue);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) { setSavedManualQueue(manualQueue); refreshMap(); }
    }
    catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  const refreshMap = useCallback(() => {
    if (!account) return;
    api.city(account).then(d => { if (d.ok && accountRef.current === account) setRows(d.rows); });
  }, [account]);

  // "Обновить" — в отличие от refreshMap (читает кэш CitySnapshot из БД), реально дёргает /progress/
  // прямо сейчас, чтобы получить самые свежие постройки с живой игры
  const [liveRefreshing, setLiveRefreshing] = useResumableRefresh(`cityRefresh:${account}`, () => refreshMap());
  const doLiveRefresh = async () => {
    setLiveRefreshing(true);
    try {
      const r = await api.cityRefresh(account);
      if (r.ok) {
        refreshMap();
        // «Обновить» переписал в БД и бонусы гильдии с условиями построек — перечитываем их
        api.cityGuildBenefits(account).then(g => { if (g.ok && accountRef.current === account) { setGuildDisc({ build: g.building_purchases_discount, upgrade: g.upgrades_discount }); setGuildIncomeBoost(g.income_boost); } }).catch(() => {});
        api.cityBuildCriteria(account).then(c => { if (c.ok && accountRef.current === account) setBuildCriteria(c.criteria); }).catch(() => {});
      } else showFlash(r.error ?? 'Ошибка', false);
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
  const projectedBuildings = useMemo(() => projectBuildings(owned, targets, manualQueue, globalPlan), [owned, targets, manualQueue, globalPlan]);
  const projectedStats = useMemo(() => computeCityStats(projectedBuildings, buildingParamMap, cityStatsMods), [projectedBuildings, buildingParamMap, cityStatsMods]);
  const boosterLabelFor = (id: string) => { const b = boosters.find(x => x.name === id); return b ? b.label : `#${id}`; };

  function switchMode(m: CityActionMode) {
    setPanelCollapsed(false); // выбор режима на телефоне раскрывает свёрнутую панель
    setMode(m); setMoveFrom(null);
    if (m !== 'build') { setBuildFamily(''); setSearch(''); setCatFilter(''); }
  }

  // на общей карте вкладку переключает док общей страницы — сброс выбора тот же, что у switchMode
  const embedded = !!props.slots;
  useEffect(() => {
    if (!embedded) return;
    setMoveFrom(null);
    if (mode !== 'build') { setOwnBuildFamily(''); setSearch(''); setCatFilter(''); }
  }, [mode, embedded]);

  // ── множества клеток по режимам (на основе ОПТИМИСТИЧНОГО состояния — с учётом очереди) ───────
  // клетки отложенной стройки тоже заняты: здание туда уже назначено
  const deferredSet = useMemo(() => new Set(buildPlan.map(p => `${p.x}_${p.y}`)), [buildPlan]);
  const sets = useMemo(() => cityCellSets(displayBuildings, buildingParamMap, coordsSet, lockedCellKeys, deferredSet),
    [displayBuildings, buildingParamMap, coordsSet, lockedCellKeys, deferredSet]);
  const { occupied: occupiedSet, reconstructable: reconstructableSet } = sets;
  const underConstruction = isUnderway;
  // выбранное здание этому городу не построить (лимит или условие игры) — его клетки не принимают
  // стройку; на общей карте здание выбирают сразу для всех городов
  const buildBlocked = useMemo(() => {
    if (!buildFamily) return false;
    const info = buildingParamMap.get(buildFamily);
    const have = displayBuildings.filter(b => familyId(b.id) === familyId(buildFamily)).length;
    return (info?.limit != null && have >= info.limit) || isCriteriaUnmet(buildCriteria, buildFamily);
  }, [buildFamily, buildingParamMap, displayBuildings, buildCriteria]);
  const buildBlock = !buildFamily ? null : (() => {
    const info = buildingParamMap.get(buildFamily);
    const have = displayBuildings.filter(b => familyId(b.id) === familyId(buildFamily)).length;
    return info?.limit != null && have >= info.limit ? 'уже построено' : isCriteriaUnmet(buildCriteria, buildFamily) ? criteriaReason(buildCriteria, buildFamily) : null;
  })();
  const validSet = useMemo(() => executing || (mode === 'build' && buildBlocked) ? new Set<string>() : validCellsFor(mode, sets, buildFamily, moveFrom),
    [executing, mode, buildFamily, buildBlocked, moveFrom, sets]);
  // Esc отменяет начатое перемещение
  useEffect(() => {
    if (!moveFrom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoveFrom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveFrom]);

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
      // повторный клик снимает отметку, как крестик в списке
      setQueue(prev => prev.some(a => a.kind === 'renovate' && a.x === gx && a.y === gy)
        ? prev.filter(a => !(a.kind === 'renovate' && a.x === gx && a.y === gy))
        : [...prev, { id: nextIdRef.current++, kind: 'renovate', x: gx, y: gy }]);
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
    if (!await ask('Открыть секцию карты?', `Разблокировать эту секцию за ${costText}?`, { ok: 'Открыть' })) return;
    setUnlockingSection(true);
    try {
      const r = await api.cityActionUnlockSection(account, sectionId);
      if (r.ok) { showFlash('Секция разблокирована', true); refreshMap(); }
      else showFlash(r.error ?? 'Не удалось разблокировать секцию', false);
    } catch (e) { showFlash(String(e), false); } finally { setUnlockingSection(false); }
  }, [account, sections, unlockingSection, refreshMap, showFlash, ask]);

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
    api.cityBoosters(account).then(d => { if (d.ok) { setBoosters(d.boosters); setBoosterActive(d.active ?? []); setBoosterQueue(d.queue ?? []); setBoosterQueueSaved(d.queue ?? []); } else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setBoostersLoading(false));
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
  // следующий. Так делается «сначала легендарный, потом мифический». Правки — черновик: весь
  // порядок уходит на сервер разом по «Применить», «Отменить» возвращает сохранённый.
  const saveQueue = (order: string[]) => setBoosterQueue(order.map(n => ({ name: n, label: boosterLabelFor(n) })));
  const boosterDirty = boosterQueue.map(q => q.name).join('|') !== boosterQueueSaved.map(q => q.name).join('|');
  const applyBoosterQueue = async () => {
    setBoosterSaving(true);
    try {
      const r = await api.saveBoosterQueue(account, boosterQueue.map(q => q.name));
      if (!r.ok) showFlash(r.error ?? 'Ошибка', false);
      else loadBoosters();   // подтянуть настоящие id позиций с сервера
    } catch (e) { showFlash(String(e), false); } finally { setBoosterSaving(false); }
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
      if (r.ok) { setTargets(keep); setSavedTargets(keep); setPlanRemoved(new Set()); }
      // сервер сразу подтягивает актуальную карту построек с игры при сохранении целей (см.
      // cityStrategy.js) — обновляем отображение, не дожидаясь планового цикла бота
      if (r.ok) refreshMap();
    }
    catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  // выполнение очереди — по одному действию в секунду (рейтлимит), последовательно, не прерываясь
  // на ошибках отдельных действий (остальные всё равно выполняются)
  // quiet — запуск со сводки всех городов: подтверждение и итог показывает она, одним на все города
  const runQueue = async (quiet = false): Promise<RunResult | null> => {
    if (!queue.length || executing) return null;
    const demolishN = queue.filter(a => a.kind === 'demolish').length;
    if (!quiet && demolishN && !await ask('Снести здания?', `${demolishN} зд. в ${account}. Монеты за снос не возвращаются.`, { ok: 'Снести', danger: true })) return null;
    setExecuting(true);
    // стройка сверх баланса не теряется: по порядку постановки, что не влезает в монеты, уходит в
    // отложенную стройку, и бот строит сам, когда монет хватит
    const prices = buildPrices();
    const defer: { x: number; y: number; family_id: string }[] = [];
    let sum = 0;
    const run = queue.filter(a => {
      if (a.kind !== 'build') return true;
      sum += prices.get(a.id) ?? 0;
      if (sum <= balance) return true;
      defer.push({ x: a.x, y: a.y, family_id: a.family_id });
      return false;
    });
    const total = run.length + (defer.length ? 1 : 0);
    setProgress({ done: 0, total });
    let ok = 0, fail = 0, deferred = 0, error: string | undefined;
    for (let i = 0; i < run.length; i++) {
      const a = run[i];
      try {
        let r: { ok: boolean; error?: string };
        if (a.kind === 'build') r = await api.cityActionBuild(account, a.family_id, a.x, a.y);
        else if (a.kind === 'move') r = await api.cityActionMove(account, a.from, a.to);
        else if (a.kind === 'demolish') r = await api.cityActionDemolish(account, a.x, a.y);
        else if (a.kind === 'reconstruct') r = await api.cityActionReconstruct(account, a.x, a.y);
        else r = await api.cityActionRenovate(account, a.x, a.y);
        if (r.ok) ok++; else { fail++; error ??= r.error; }
      } catch (e) { fail++; error ??= String(e); }
      setProgress({ done: i + 1, total });
      if (i < run.length - 1) await new Promise(res => setTimeout(res, 1000));
    }
    if (defer.length) {
      const r = await api.saveBuildPlan(account, { add: defer }).catch(() => ({ ok: false }));
      if (r.ok) deferred = defer.length; else fail += defer.length;
    }
    setQueue([]);
    setExecuting(false);
    setProgress(null);
    if (!quiet) showFlash(`Выполнено: ${ok}${deferred ? `, ждут монет: ${deferred}` : ''}${fail ? `, ошибок: ${fail}${error ? ` (${error})` : ''}` : ''}`, fail === 0);
    refreshMap();
    // перемещение переносит координату цели улучшения вместе со зданием (см. cityStrategy.js) —
    // подтягиваем свежий список целей, чтобы бейдж "цур→цель" не остался на старой клетке
    api.cityStrategy(account).then(t => { if (t.ok) { setTargets(t.targets); setSavedTargets(t.targets); setBuildPlan(t.buildPlan ?? []); } });
    return { ok, fail, deferred, error };
  };
  const removeDeferred = async (x: number, y: number) => {
    setBuildPlan(prev => prev.filter(p => !(p.x === x && p.y === y)));
    const r = await api.saveBuildPlan(account, { remove: [{ x, y }] }).catch(() => ({ ok: false, error: 'нет связи' }));
    if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); api.cityStrategy(account).then(t => { if (t.ok) setBuildPlan(t.buildPlan ?? []); }); }
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

  // цена каждой постройки из действий по порядку постановки: следующая того же семейства дороже
  const pendingBuildPrices = useMemo(() => {
    const out = new Map<number, number>(), have = new Map<string, number>();
    for (const b of owned) have.set(familyId(b.id), (have.get(familyId(b.id)) ?? 0) + 1);
    for (const a of queue) {
      if (a.kind !== 'build') continue;
      const info = buildingParamMap.get(a.family_id), fam = familyId(a.family_id), k = have.get(fam) ?? 0;
      have.set(fam, k + 1);
      out.set(a.id, info ? buildPriceAt(info, k, buildCostMultiplier) : 0);
    }
    return out;
  }, [owned, queue, buildingParamMap, buildCostMultiplier]);
  const buildPrices = () => pendingBuildPrices;
  // постройки, на которые монет уже не хватит: при выполнении уйдут в отложенную стройку
  const overBudget = useMemo(() => {
    const s = new Set<number>();
    let sum = 0;
    for (const a of queue) if (a.kind === 'build') { sum += pendingBuildPrices.get(a.id) ?? 0; if (sum > balance) s.add(a.id); }
    return s;
  }, [queue, pendingBuildPrices, balance]);
  const deferFills = useMemo<CellFill[]>(() => mode === 'build' ? buildPlan.map(p => ({ key: `${p.x}_${p.y}`, fill: 'rgba(212,167,44,.8)', stroke: '#9a6700' })) : [], [mode, buildPlan]);

  // условие покупки не выполнено — семья уже построена в количестве, равном лимиту (напр.
  // спецздания вроде "Оплот мудрости" — лимит 1 на город); живой критерий игры (/buildings/criteria)
  // явно говорит "не выполнено" (напр. не хватает населения — конкретный порог не храним у себя,
  // это отдаёт сама игра); либо не хватает монет на цену со всеми скидками. Дальнейшая постройка
  // вернёт ошибку от игры, поэтому просто не даём выбрать такое здание, но оставляем в списке
  // видимым (на своём месте в сортировке, неактивным).

  // палитра построимых зданий (Строительство) — поиск+категории, как в MapEditor.tsx
  const purchasable = useMemo(
    () => buildingsCatalog.filter(b => b.is_purchasable && !/_\d+_star\.png$/i.test(b.id)),
    [buildingsCatalog],
  );
  const paletteFiltered = purchasable.filter(b => {
    if (buildingCat(b.id) !== catFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!buildingName(b).toLowerCase().includes(q) && !b.id.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // сортировка по показателю, релевантному именно этой категории — коммерческие по прибыли,
    // жилые по населению, служебные по покрытию (всё по убыванию — лучшее сверху); остальное (SPE) —
    // по алфавиту. Недоступные и те, на которые не хватает монет, — на своём месте, а не в конце
    if (catFilter === 'COM') return (b.base_profit ?? 0) - (a.base_profit ?? 0);
    if (catFilter === 'RES') return (b.base_population ?? 0) - (a.base_population ?? 0);
    if (catFilter === 'SER') return (b.service_coverage ?? 0) - (a.service_coverage ?? 0);
    return buildingName(a).localeCompare(buildingName(b), 'ru');
  });
  // COM первой вкладкой (по просьбе), затем остальные в естественном порядке появления в каталоге
  const CAT_ORDER = ['COM', 'RES'];
  const catRank = (c: string) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? 999 : i; };
  const paletteCats = [...new Set(purchasable.map(b => buildingCat(b.id)))].filter(Boolean).sort((a, b) => catRank(a) - catRank(b));
  // выбранной категории в каталоге нет (COM у столицы без торговых зданий) — первая из имеющихся
  const paletteCatsKey = paletteCats.join(',');
  useEffect(() => { if (paletteCats.length && !paletteCats.includes(catFilter)) setCatFilter(paletteCats[0]); }, [paletteCatsKey, catFilter]);
  // порядок зданий в «Плане» — как в «Строительстве»: категории в порядке вкладок, внутри — по показателю
  // категории (звёздные тиры — по базовому зданию, чтобы стояли рядом), затем по названию
  const planSortKey = useMemo(() => {
    const byId = new Map(buildingsCatalog.map(b => [b.id, b]));
    return (id: string): (string | number)[] => {
      const cat = buildingCat(id), b = byId.get(familyId(id)), i = paletteCats.indexOf(cat);
      const v = !b ? 0 : cat === 'COM' ? b.base_profit ?? 0 : cat === 'RES' ? b.base_population ?? 0 : cat === 'SER' ? b.service_coverage ?? 0 : 0;
      return [i === -1 ? 999 : i, -v, labelFor(familyId(id)), id];
    };
  }, [buildingsCatalog, paletteCatsKey, labelFor]);

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
    return { id: a.id, kind: a.kind, label: actionLabel(a, labelFor, findInfoAt) + (overBudget.has(a.id) ? ' · когда накопит' : ''), sprite };
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

  // общая карта: состояние города наверх; обработчики через ref, чтобы не гонять лишние обновления
  const pickRef = useRef(handlePick); pickRef.current = handlePick;
  const unlockRef = useRef(onUnlockCell); unlockRef.current = onUnlockCell;
  const stablePick = useCallback((x: number, y: number) => pickRef.current(x, y), []);
  const runRef = useRef(runQueue); runRef.current = runQueue;
  const stableRun = useCallback(() => runRef.current(true), []);
  const stableRemove = useCallback((id: number) => setQueue(prev => prev.filter(a => a.id !== id)), []);
  const stableCancel = useCallback(() => setQueue([]), []);
  const stableCancelMove = useCallback(() => setMoveFrom(null), []);
  const stableEditQueue = useCallback((fn: (q: CityStrategyQueueItem[]) => CityStrategyQueueItem[]) => setManualQueue(fn), []);
  const saveQueueRef = useRef(async () => false); saveQueueRef.current = async () => {
    const r = await api.saveCityQueue(account, manualQueue).catch(() => ({ ok: false }));
    if (r.ok) { setSavedManualQueue(manualQueue); refreshMap(); }
    return !!r.ok;
  };
  const stableSaveQueue = useCallback(() => saveQueueRef.current(), []);
  const savedQueueRef = useRef(savedManualQueue); savedQueueRef.current = savedManualQueue;
  const stableResetQueue = useCallback(() => setManualQueue(savedQueueRef.current), []);
  const queueDirtyNow = cellsKeyOf(manualQueue) !== cellsKeyOf(savedManualQueue);
  const queuePricesKey = JSON.stringify(manualQueuePrices);
  const demolishKey = JSON.stringify({ tiles: demolishTiles, loss: demolish.loss, pop: demolish.pop, income: currentStats.profitFinal });
  const reconKey = JSON.stringify({ groups: reconGroups, components }), renovKey = JSON.stringify({ masterplans, items: renovateItems });
  const pendingKey = JSON.stringify(pendingRows.map(r => ({ ...r, price: pendingBuildPrices.get(r.id), over: overBudget.has(r.id) })));
  const stableUnlock = useCallback((id: string) => { void unlockRef.current(id); }, []);
  const cellsKey = (a: { x: number; y: number; target_level?: number }[]) => a.map(v => `${v.x},${v.y},${v.target_level ?? ''}`).join(';');
  const draft = queue.length > 0 || !!moveFrom || planRemoved.size > 0 || cellsKey(targets) !== cellsKey(savedTargets) || cellsKey(manualQueue) !== cellsKey(savedManualQueue)
    || boosterQueue.map(b => b.name).join() !== boosterQueueSaved.map(b => b.name).join();
  const onMapRef = useRef(props.onMap); onMapRef.current = props.onMap;
  const dotsKey = JSON.stringify(dots);
  // пока город грузится, наверх ничего не уходит: общая карта рисует его по своему снимку
  useEffect(() => {
    if (loading) return;
    onMapRef.current?.({
      account, buildings: displayBuildings, mode: !executing ? mode : 'view', validSet, pickedSet, targets, queue: manualQueue,
      focusSet: mode === 'upgrade' ? planFocus : null, onPick: stablePick, onUnlockCell: stableUnlock, draft: draft || executing, dots: dotsKey ? JSON.parse(dotsKey) : {},
      fills: deferFills, pending: JSON.parse(pendingKey), demolish: JSON.parse(demolishKey), recon: JSON.parse(reconKey), renov: JSON.parse(renovKey), balance, buildBlock, buildMult: buildCostMultiplier, moving: !!moveFrom, executing,
      run: stableRun, removePending: stableRemove, cancelPending: stableCancel, cancelMove: stableCancelMove,
      queuePrices: JSON.parse(queuePricesKey), queueDirty: queueDirtyNow, editQueue: stableEditQueue, saveQueue: stableSaveQueue, resetQueue: stableResetQueue,
    });
  }, [loading, account, displayBuildings, executing, mode, validSet, pickedSet, targets, manualQueue, planFocus, stablePick, stableUnlock, draft, dotsKey, deferFills, pendingKey, demolishKey, reconKey, renovKey, balance, moveFrom, queuePricesKey, queueDirtyNow, buildBlock, buildCostMultiplier]);

  if (props.hidden) return null;
  // во встроенном виде шапку и спиннер на время загрузки рисуют «Города» — свой лоадер не нужен
  if (loading && props.slots) return null;
  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><MapLoader pct={DATA_SHARE * dataDone / 9} text={`Данные города ${dataDone} / 9`} /></Box>;

  const panelMode = mode as PanelMode;
  const HINT: Partial<Record<PanelMode, string>> = {
    view: 'Цифры города по формулам игры: сейчас и после выполнения всех планов и очереди.',
    upgrade: 'Кликните здание или проведите кистью по нескольким — им выставится цель из плашки с уровнем справа от дока. Бот сам ждёт строителей и улучшает до цели.',
    queue: 'Каждый клик по зданию добавляет один уровень в конец очереди, одно здание можно поставить несколько раз подряд. Свободные строители сначала разбирают очередь, потом переходят к плану. Порядок меняется перетаскиванием.',
    forecast: 'Что бот запустит в ближайшие трое суток: очередь, личный и общий план, с учётом накопления монет.',
    build: 'Выберите здание в списке, затем кликайте пустые клетки или проведите кистью. Каждая клетка добавляется в действия, которые выполнит кнопка «Выполнить».',
    move: 'Кликните здание, затем пустую клетку. Можно переместить несколько подряд. Цели и очередь переедут вместе со зданием, на экономику это не влияет.',
    demolish: 'Кликайте здания или проведите кистью. Монеты за снос не возвращаются. Нажмите на плитку, чтобы снять отметку.',
    reconstruct: 'Тратит компоненты, сбрасывает здание на 1 уровень и даёт мастерпланы. Кликните или проведите кистью по зданиям на карте: готовое отмечается к выполнению кнопкой внизу, неготовое ставится в план — бот сам сделает, когда здание дойдёт до нужного уровня. В списке — только выбранное, снимает выбор повторный клик или кисть.',
    renovate: 'Тратит мастерпланы и переводит здание в следующий звёздный тир. Кликните по подсвеченным зданиям на карте и нажмите «Выполнить». В списке — только выбранное, снимает отметку повторный клик по зданию.',
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
      <FooterButton label={executing && progress ? `Выполняется ${progress.done} из ${progress.total}` : runLabel} tone={runTone}
        icon={CheckIcon} count={queue.length} busy={executing} onClick={() => { void runQueue(); }} />
      <CancelButton disabled={executing} onClick={() => setQueue([])} />
    </>
  );
  const sameCells = (a: { x: number; y: number; target_level?: number }[], b: typeof a) => a.length === b.length && a.every((v, i) => v.x === b[i].x && v.y === b[i].y && v.target_level === b[i].target_level);
  const planDirty = planRemoved.size > 0 || !sameCells(targets, savedTargets);
  const queueDirty = !sameCells(manualQueue, savedManualQueue);
  // «Сохранить»/«Отменить» — только когда есть несохранённые изменения
  const footer = mode === 'upgrade'
    ? (planDirty ? <>
        <PlanSaveButton count={targets.filter(t => !planRemoved.has(`${t.x},${t.y}`)).length} busy={busy} onClick={saveTargets} />
        <CancelButton disabled={busy} onClick={() => { setTargets(savedTargets); setPlanRemoved(new Set()); }} />
      </> : undefined)
    : mode === 'queue'
      ? (queueDirty ? <>
          <FooterButton label="Сохранить" icon={CheckIcon} count={manualQueue.length} busy={busy} onClick={saveManualQueue} />
          <CancelButton disabled={busy} onClick={() => setManualQueue(savedManualQueue)} />
        </> : undefined)
      : mode === 'boosters'
        ? (boosterDirty ? <>
            <FooterButton label="Применить" icon={ZapIcon} count={boosterQueue.length} busy={boosterSaving} onClick={applyBoosterQueue} />
            <CancelButton disabled={boosterSaving} onClick={() => setBoosterQueue(boosterQueueSaved)} />
          </> : undefined)
        : runFooter || undefined;
  const headActions = mode === 'boosters'
    ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Сверить с игрой" disabled={boostersChecking} onClick={checkBoosters} />
    : mode === 'forecast'
      ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Пересчитать прогноз" disabled={forecastLoading} onClick={loadForecast} />
      : mode === 'log'
        ? <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Обновить лог" disabled={actionLogLoading} onClick={loadActionLog} />
        : undefined;
  const pendingNoDemolish = pendingRows.filter(r => r.kind !== 'demolish');
  const summary = `Зданий: ${owned.length}${row?.updated_at ? ` · Обновлено: ${new Date(row.updated_at).toLocaleString('ru')}` : ''}`;
  // телефон: сайдбар снизу сворачивается до шапки, чтобы карте доставался почти весь экран
  const panelToggle = narrow
    ? <IconButton size="small" variant="invisible" icon={panelCollapsed ? ChevronUpIcon : ChevronDownIcon}
        aria-label={panelCollapsed ? 'Развернуть панель' : 'Свернуть панель'} onClick={() => setPanelCollapsed(v => !v)} />
    : null;

  const headRow = <CityHead name={rowName} summary={summary} noSnapshot={noSnapshot} narrow={narrow} onBack={goBack}
    dayNight={dayNight} onDayNight={setDayNight} refreshing={liveRefreshing} onRefresh={doLiveRefresh} />;
  const flashEl = flash && (
      <Box sx={{ px: 3, pt: 2, flexShrink: 0 }}>
        <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>
      </Box>
  );
  const sidePanel = (
    <PanelShell mode={panelMode} hint={HINT[panelMode] ?? ''} actions={<>{headActions}{props.slots ? props.panelActions : panelToggle}</>} footer={footer} gap={mode === 'build' ? 3 : 2}
      busy={mode === 'forecast' ? forecastLoading : mode === 'boosters' ? boostersLoading && boosters.length === 0 : mode === 'log' ? actionLogLoading && actionLog.length === 0 : false}>
      {mode === 'view' && <StatsPanel raw={currentStatsRaw} s={currentStats} projected={projectedStats} mods={cityStatsMods} wallet={{ coins: balance, ...walletRest, income: currentStats.profitFinal }} />}

      {mode === 'upgrade' && (
        <PlanPanel targets={targets} owned={owned} labelFor={labelFor} sortKey={planSortKey}
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
              {paletteCats.map(cat => (
                <span key={cat} className={'map-cat-tab' + (catFilter === cat ? ' active' : '')} onClick={() => setCatFilter(cat)}>
                  {cat}
                </span>
              ))}
            </div>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {paletteFiltered.map(b => {
                const k = familyCounts.get(familyId(b.id)) ?? 0;
                const limitReached = b.limit != null && k >= b.limit;
                const criteriaUnmet = !limitReached && isCriteriaUnmet(buildCriteria, b.id);
                const price = buildPriceAt(b, k, buildCostMultiplier);
                const unaffordable = !limitReached && !criteriaUnmet && price > balance;
                // монет не хватает — выбрать всё равно можно: стройка подождёт монет (отложенная стройка)
                const unavailable = limitReached || criteriaUnmet;
                return (
                  <BuildItem key={b.id} id={b.id} name={buildingName(b)} active={buildFamily === b.id} unavailable={unavailable} onClick={() => setBuildFamily(b.id)}
                    sub={limitReached ? 'Построено' : criteriaUnmet ? criteriaReason(buildCriteria, b.id) : unaffordable ? 'построится, когда накопит' : undefined}
                    trail={limitReached || criteriaUnmet ? undefined : <Val color={unaffordable ? 'fg.muted' : 'fg.default'}><CoinValue value={fmtUp(price)} /></Val>} />
                );
              })}
            </Box>
          </Box>
          <PendingList labelFor={labelFor} rows={pendingRows} disabled={executing} onRemove={removeQueued} />
          {buildPlan.length > 0 && <>
            <Caption right={buildPlan.length}>Ждут монет</Caption>
            {buildPlan.map(p => (
              <Row key={`${p.x},${p.y}`} lead={<Thumb id={p.family_id} size={36} bg="canvas.default" />} title={labelFor(p.family_id)}
                sub={`${p.x},${p.y}`} fill={fillOf([[FILL_ATTENTION, 100]])}
                trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Снять" onClick={() => removeDeferred(p.x, p.y)} />} />
            ))}
          </>}
        </>
      )}

      {mode === 'move' && (
        <>
          <MovePanel from={moveFromInfo} moves={moveRows} labelFor={labelFor} disabled={executing} onCancel={() => setMoveFrom(null)} onRemove={removeQueued} />
          <PendingList labelFor={labelFor} rows={pendingRows.filter(r => r.kind !== 'move')} disabled={executing} onRemove={removeQueued} />
        </>
      )}

      {mode === 'demolish' && (
        <>
          <DemolishPanel tiles={demolishTiles} lossPerHour={demolish.loss} popLoss={demolish.pop} income={currentStats.profitFinal} disabled={executing} onRemove={removeQueued} />
          <PendingList labelFor={labelFor} rows={pendingNoDemolish} disabled={executing} onRemove={removeQueued} />
        </>
      )}

      {mode === 'reconstruct' && (
        <>
          <ReconstructPanel groups={reconGroups} components={components} disabled={executing} onToggle={toggleReconstruct} />
          <PendingList labelFor={labelFor} rows={pendingRows.filter(r => r.kind !== 'reconstruct')} disabled={executing} onRemove={removeQueued} />
        </>
      )}

      {mode === 'renovate' && (
        <>
          <RenovatePanel masterplans={masterplans} items={renovateItems} onToggle={toggleRenovate} disabled={executing} />
          <PendingList labelFor={labelFor} rows={pendingRows.filter(r => r.kind !== 'renovate')} disabled={executing} onRemove={removeQueued} />
        </>
      )}

      {mode === 'boosters' && (
        <BoostersPanel boosters={boosters} active={boosterActive} loading={boostersLoading} queue={boosterQueue}
          onAdd={queueAdd} onReorder={queueReorder} onRemoveAt={queueRemoveAt} />
      )}

      {mode === 'log' && <LogPanel rows={actionLog} loading={actionLogLoading} label={r => logLabel(r, labelFor, boosterLabelFor)} labelFor={labelFor} />}

      {mode === 'skip' && <Empty>—</Empty>}
    </PanelShell>
  );
  const brush = <MapBrushLevel value={Math.max(1, Math.floor(Number(addLevel)) || 1)} onChange={v => setAddLevel(String(v))} />;
  // на общей карте всех городов (pages/CityWorld.tsx) у города нет своей страницы: шапка, сайдбар и плашка
  // кисти встают в места общей страницы, а карта — общая
  if (props.slots) return <>
    {props.slots.head && createPortal(<>{headRow}{flashEl}</>, props.slots.head)}
    {/* «Строительство»: список зданий один на все города — сайдбар рисуют «Города» */}
    {props.slots.side && mode !== 'build' && createPortal(sidePanel, props.slots.side)}
    {props.slots.dock && mode === 'upgrade' && createPortal(brush, props.slots.dock)}
  </>;

  return (
    <Box sx={{
      display: 'flex', height: 'calc(100vh - var(--header-h))',
      // телефон: карта сверху, сайдбар снизу — он всегда на экране, как и на десктопе
      '@media (max-width: 768px)': { flexDirection: 'column', height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        {headRow}
        {flashEl}

        {/* canvas + палитра инструментов поверх него, по центру снизу */}
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          {loadErr
            ? <Box sx={{ flex: 1, p: 3 }}><LoadError error={loadErr} onRetry={() => setReloadTick(n => n + 1)} /></Box>
            : owned.length === 0 && mode === 'view'
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
                fills={deferFills}
                dayNight={dayNight}
                onZoomOut={props.onZoomOut}
              />
          }
          {/* док по центру; в «Плане» справа от него — уровень кисти (док при этом не сдвигается) */}
          <Box sx={{
            position: 'absolute', left: 2, right: 2, bottom: 3, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', columnGap: 2,
            pointerEvents: 'none', '& > *': { pointerEvents: 'auto' },
            '@media (max-width: 768px)': { display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 2 },
          }}>
            <Box sx={{ gridColumn: 2, minWidth: 0, maxWidth: '100%', display: 'flex' }}><MapPalette mode={panelMode} onSelect={switchMode} dots={dots} /></Box>
            {mode === 'upgrade' && <Box sx={{ gridColumn: 3, justifySelf: 'start' }}>{brush}</Box>}
          </Box>
        </Box>
      </Box>

      <Box sx={{
        // ширина как у левого меню навигации — как было у прежнего сайдбара карты
        width: 'var(--sidebar-w)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid', borderColor: 'border.default',
        '@media (max-width: 768px)': { width: '100%', height: panelCollapsed ? '49px' : '45%', borderLeft: 0, borderTop: '1px solid', borderTopColor: 'border.default', overflow: 'hidden' },
      }}>
        {sidePanel}
      </Box>
    </Box>
  );
}

// шапка города над картой. Её же «Города» рисуют, пока данные города грузятся, — переход без прыжков
export function CityHead({ name, summary, noSnapshot, narrow, onBack, dayNight, onDayNight, refreshing, onRefresh }: {
  name: string; summary?: string; noSnapshot?: boolean; narrow: boolean; onBack: () => void;
  dayNight: DayNightMode; onDayNight: (v: DayNightMode) => void; refreshing?: boolean; onRefresh?: () => void;
}) {
  return (
    <Box sx={{
      p: 2, bg: 'canvas.subtle',
      borderBottom: '1px solid', borderColor: 'border.default',
      display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
    }}>
      {/* телефон: шапка в одну строку — кнопки иконками, сводка уходит в подсказку заголовка */}
      {narrow
        ? <IconButton icon={ChevronLeftIcon} aria-label="Все города" onClick={onBack} />
        : <Button leadingVisual={ChevronLeftIcon} onClick={onBack}>Все города</Button>}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2, flexWrap: narrow ? 'nowrap' : 'wrap' }}
        title={noSnapshot ? undefined : summary}>
        <Heading as="h3" sx={{ fontSize: 2, m: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Heading>
        {(noSnapshot || !narrow) && <Text sx={{ fontSize: 0, color: noSnapshot ? 'attention.fg' : 'fg.muted' }}>
          {noSnapshot ? (narrow ? 'Нет снимка' : 'Снимка города ещё нет — нажмите «Обновить»') : summary}
        </Text>}
      </Box>
      <DayNightMenu value={dayNight} onChange={onDayNight} />
      {narrow
        ? <IconButton icon={SyncIcon} aria-label="Обновить" disabled={!!refreshing} onClick={onRefresh} />
        : <Button leadingVisual={SyncIcon} loading={!!refreshing} disabled={!!refreshing} onClick={onRefresh}>Обновить</Button>}
    </Box>
  );
}
