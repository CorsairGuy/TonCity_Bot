import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Spinner, Text, TextInput } from '@primer/react';
import { ChevronLeftIcon, SidebarExpandIcon, SyncIcon, XIcon } from '@primer/octicons-react';
import { useRegisterPanelToggle } from '../contexts/PanelToggleContext';
import { api, type CapitalRow, type MapBuilding, type CapitalStrategyTarget, type CapitalStrategyQueueItem, type CapitalActionLogRow, type ForecastEvent, type GlobalUpgradeRule } from '../api';
import { CityActionsCanvas, type CityActionMode } from '../components/CityActionsCanvas';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { useMapDayNight } from '../hooks/useMapDayNight';
import { DayNightMenu } from '../components/DayNightMenu';
import { Scrollable } from '../components/Scrollable';
import { fmt } from '../utils';
import { CoinValue } from '../components/Icons';

// Здания столицы (config/capital_buildings.txt) — принципиально другая форма, чем городской
// BuildingDef (api.ts): нет category/star_lvl/is_reconstructible и т.п., зато есть type
// (hall|beneficial|commercial|decoration|special), rate/coefficient (формулы цены) и
// hall_lvl_required/levels_per_hall_lvl (лимит уровня от штаб-квартиры) — см. modules/capitalHelpers.js.
interface CapitalBuildingDef {
  id: string;
  name: string; // JSON-строка {en,ru}
  type: string;
  base_price: number | null;
  coefficient: number | null;
  rate: number | null;
  base_construction_duration: number | null;
  construction_increment: number | null;
  max_level: number | null;
  is_purchasable: boolean;
  is_upgradable: boolean;
  is_removable: boolean;
  hall_lvl_required: number | null;
  levels_per_hall_lvl: number | null;
  limit: number | null;
}

function buildingName(b: CapitalBuildingDef): string {
  try { const n = JSON.parse(b.name) as { en?: string; ru?: string } | null; return n?.ru || n?.en || b.id; } catch { return b.id; }
}
// та же схема раскраски/подписи тайлов, что и у города (CityActionsCanvas.buildingCat читает
// префикс после "CAP_": BEN/SPE/COM/DEC — совпадает с полем type у соответствующих зданий)
function buildingCat(id: string): string {
  const m = id.slice(4).match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}

function fmtTimeLeft(ms: number): string {
  if (ms <= 0) return '0м';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// уровень штаб-квартиры — от него зависят lvl-ограничения остальных зданий (getMaxAllowedLevel),
// формулы сверены с modules/capitalHelpers.js (бэкенд)
function capHallLevel(current: MapBuilding[], catalog: CapitalBuildingDef[]): number {
  const hallInfo = catalog.find(c => c.type === 'hall');
  if (!hallInfo) return 0;
  const b = current.find(x => x.id === hallInfo.id);
  if (!b) return 0;
  const upgrading = !!b.end && new Date(b.end).getTime() > Date.now();
  return Math.max(0, (Number(b.level) || 0) - (upgrading ? 1 : 0));
}
function getMaxAllowedLevel(info: CapitalBuildingDef, hallLevel: number): number {
  if (info.levels_per_hall_lvl == null) return 99;
  const r = info.hall_lvl_required ?? 1;
  return Math.max(0, (hallLevel + 1 - r) * info.levels_per_hall_lvl);
}
// CAP_COM_* — экспоненциально от уровня, остальное — итеративное произведение rate/k (сверено с
// capitalHelpers.js capUpgradePrice)
function capUpgradePrice(buildingId: string, info: CapitalBuildingDef, lvl: number, econStrength: number): number {
  if (buildingId.startsWith('CAP_COM_')) return Math.round((info.base_price ?? 0) * Math.exp(0.5 * lvl) * econStrength);
  let p = info.base_price ?? 0;
  for (let k = 1; k < lvl; k++) p *= (info.rate ?? 1) / k;
  return Math.round(p * econStrength);
}
function capBuyPrice(info: CapitalBuildingDef, count: number, econStrength: number): number {
  return Math.round((info.base_price ?? 0) * Math.pow(info.coefficient ?? 1, count) * econStrength);
}
// цена ускорения текущей стройки за алмазы — реверс бандла игры (класс qp.getSkipUpgradeCost()):
// зависит ТОЛЬКО от оставшегося времени стройки, не от здания/уровня. Чем меньше осталось — тем
// дешевле. Это лишь оценка на момент показа — реальную цену считает сама игра при выполнении.
function capSkipUpgradeCost(secondsLeft: number): number {
  return secondsLeft <= 0 ? 0 : Math.max(1, Math.round(0.394 * Math.pow(secondsLeft, 0.735)));
}

const MODE_TITLE: Record<Exclude<CityActionMode, 'view' | 'reconstruct' | 'renovate' | 'boosters'>, string> = {
  queue: 'Улучшение', upgrade: 'План', build: 'Строительство', move: 'Перемещение',
  demolish: 'Снос', skip: 'Ускорить', log: 'Лог', forecast: 'Прогноз',
};
const CAPITAL_TABS = ['queue', 'upgrade', 'build', 'move', 'demolish', 'skip', 'log', 'forecast'] as const;

type PendingAction =
  | { id: number; kind: 'build'; family_id: string; x: number; y: number }
  | { id: number; kind: 'move'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { id: number; kind: 'demolish'; x: number; y: number }
  | { id: number; kind: 'skip'; x: number; y: number };

function applyQueue(owned: MapBuilding[], queue: PendingAction[]): MapBuilding[] {
  let list = owned.map(b => ({ ...b }));
  for (const a of queue) {
    if (a.kind === 'build') list.push({ x: a.x, y: a.y, id: a.family_id, level: 1 });
    else if (a.kind === 'move') {
      const idx = list.findIndex(b => b.x === a.from.x && b.y === a.from.y);
      if (idx >= 0) list[idx] = { ...list[idx], x: a.to.x, y: a.to.y };
    } else if (a.kind === 'demolish') list = list.filter(b => !(b.x === a.x && b.y === a.y));
    // 'skip' — не меняет вид карты (здание и так уже показывает целевой уровень, просто снимает
    // таймер после реального выполнения), поэтому в превью очереди ничего не трогаем
  }
  return list;
}
function actionLabel(a: PendingAction, labelFor: (id: string) => string, costFor: (x: number, y: number) => number | null): string {
  if (a.kind === 'build') return `Строительство: ${labelFor(a.family_id)} (${a.x},${a.y})`;
  if (a.kind === 'move') return `Перемещение: (${a.from.x},${a.from.y}) → (${a.to.x},${a.to.y})`;
  if (a.kind === 'demolish') return `Снос: (${a.x},${a.y})`;
  const cost = costFor(a.x, a.y);
  return `Ускорение: (${a.x},${a.y})${cost != null ? ` (~${cost} 💎)` : ''}`;
}
function logLabel(r: CapitalActionLogRow, labelFor: (id: string) => string): string {
  const name = r.building_id ? labelFor(r.building_id) : '—';
  const dur = r.duration_ms ? ` за ${fmtTimeLeft(r.duration_ms)}` : '';
  switch (r.type) {
    case 'upgrade': return `Улучшение: ${name} (${r.x},${r.y}) ${r.level_from}→${r.level_to}${dur}`;
    case 'build': return `Строительство: ${name} (${r.x},${r.y})`;
    case 'move': return `Перемещение: (${r.from_x},${r.from_y}) → (${r.x},${r.y})`;
    case 'demolish': return `Снос: ${name} (${r.x},${r.y}), был ур. ${r.level_from}`;
    case 'skip-upgrade': {
      let crystals: number | null = null;
      try { crystals = r.detail ? JSON.parse(r.detail).crystals_spent ?? null : null; } catch { /* ignore */ }
      return `Ускорение за алмазы: ${name} (${r.x},${r.y})${crystals != null ? ` (−${crystals} 💎)` : ''}`;
    }
    default: return r.type;
  }
}

interface Props { account: string }

// Действия по столице — тот же каркас тулбара/сайдбара, что и у города (CityMapCity.tsx), но:
// - guildTitle вместо account (столица общая на гильдию, CapitalSnapshot ключуется по guild_id);
// - нет Реконструкции/Реновации/Ускорителей (не подтверждены реверсом для столицы, см. план);
// - формулы цены/лимита уровня — hall_lvl_required/levels_per_hall_lvl/rate/coefficient, а не
//   гильдийские/политик скидки, как у города.
export function CityMapCapital({ account: guildTitle }: Props) {
  const navigate = useNavigate();
  const { flash, showFlash } = useFlash();

  const [rows, setRows] = useState<CapitalRow[]>([]);
  const [dayNight, setDayNight] = useMapDayNight();
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CapitalBuildingDef[]>([]);
  const [targets, setTargets] = useState<CapitalStrategyTarget[]>([]);
  const [manualQueue, setManualQueue] = useState<CapitalStrategyQueueItem[]>([]);
  const [globalPlan, setGlobalPlan] = useState<GlobalUpgradeRule[]>([]);
  const [coordsSet, setCoordsSet] = useState<Set<string>>(new Set());
  const [actionLog, setActionLog] = useState<CapitalActionLogRow[]>([]);
  const [actionLogLoading, setActionLogLoading] = useState(false);
  const [forecastEvents, setForecastEvents] = useState<ForecastEvent[]>([]);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [mode, setMode] = useState<CityActionMode>('view');
  const [busy, setBusy] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const openMobilePanel = useCallback(() => setMobilePanelOpen(true), []);
  useRegisterPanelToggle(useMemo(() => ({ onOpen: openMobilePanel, icon: SidebarExpandIcon, label: 'Открыть панель' }), [openMobilePanel]));

  const [queue, setQueue] = useState<PendingAction[]>([]);
  const nextIdRef = useRef(1);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const [addLevel, setAddLevel] = useState('5');
  const [buildFamily, setBuildFamily] = useState('');
  const [moveFrom, setMoveFrom] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.capitals(),
      api.buildingsList('capital') as unknown as Promise<{ ok: boolean; buildings: CapitalBuildingDef[] }>,
      guildTitle ? api.capitalStrategy(guildTitle) : Promise.resolve({ ok: true, targets: [] as CapitalStrategyTarget[], queue: [] as CapitalStrategyQueueItem[] }),
      fetch('/api/coords?type=capital').then(r => r.json()).catch(() => ({ coords: [] })),
      api.globalCapitalUpgradePlan().catch(() => ({ ok: false as const, plan: [] })),
    ]).then(([c, b, t, co, gp]) => {
      if (c.ok) setRows(c.rows);
      if (b.ok) setCatalog(b.buildings);
      if (t.ok) { setTargets(t.targets); setManualQueue(t.queue ?? []); }
      setCoordsSet(new Set((co.coords ?? []).map((cc: any) => `${cc.x}_${cc.y}`)));
      if (gp.ok) setGlobalPlan(gp.plan);
    }).finally(() => setLoading(false));
  }, [guildTitle]);

  useEffect(() => {
    setMode('view'); setQueue([]); setMoveFrom(null); setBuildFamily(''); setSearch(''); setTypeFilter('');
  }, [guildTitle]);

  useEffect(() => {
    if (!guildTitle) return;
    const es = new EventSource(`/api/capital-strategy/${encodeURIComponent(guildTitle)}/live-stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as { buildings: MapBuilding[] };
      setRows(prev => prev.map(r => r.guild_title === guildTitle ? { ...r, buildings: data.buildings } : r));
    };
    return () => es.close();
  }, [guildTitle]);

  const refreshMap = useCallback(() => {
    api.capitals().then(d => { if (d.ok) setRows(d.rows); });
  }, []);
  const [liveRefreshing, setLiveRefreshing] = useResumableRefresh(`capitalRefresh:${guildTitle}`, () => refreshMap());
  const doLiveRefresh = async () => {
    setLiveRefreshing(true);
    try {
      const r = await api.capitalRefresh(guildTitle);
      if (r.ok) refreshMap(); else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setLiveRefreshing(false); }
  };

  const row = rows.find(r => r.guild_title === guildTitle) ?? rows[0] ?? null;
  const rowName = row?.guild_title ?? '—';
  const owned: MapBuilding[] = row?.buildings ?? [];
  const econStrength = row?.economic_strength ?? 1;

  const displayBuildings = useMemo(() => applyQueue(owned, queue), [owned, queue]);
  const catalogMap = useMemo(() => new Map(catalog.map(b => [b.id, b])), [catalog]);
  const labelFor = (id: string) => { const b = catalogMap.get(id); return b ? buildingName(b) : id; };
  const hallLevel = useMemo(() => capHallLevel(owned, catalog), [owned, catalog]);

  function switchMode(m: CityActionMode) {
    setMode(m); setMoveFrom(null);
    if (m !== 'build') { setBuildFamily(''); setSearch(''); setTypeFilter(''); }
    if (window.innerWidth <= 768) setMobilePanelOpen(true);
  }

  const occupiedSet = useMemo(() => new Set(displayBuildings.map(b => `${b.x}_${b.y}`)), [displayBuildings]);
  const upgradeableSet = useMemo(() => new Set(
    displayBuildings.filter(b => catalogMap.get(b.id)?.is_upgradable === true).map(b => `${b.x}_${b.y}`)
  ), [displayBuildings, catalogMap]);
  const removableSet = useMemo(() => new Set(
    displayBuildings.filter(b => catalogMap.get(b.id)?.is_removable !== false).map(b => `${b.x}_${b.y}`)
  ), [displayBuildings, catalogMap]);
  // ускорение доступно только для зданий, которые СЕЙЧАС строятся (реверс бандла — qp.skipUpgrade
  // требует isUnderConstruction), уже выставленные в очередь клетки исключаем — повторно ускорять
  // ту же стройку нет смысла, пока первая заявка не выполнена
  const underConstructionSet = useMemo(() => new Set(
    displayBuildings.filter(b => b.end && new Date(b.end).getTime() > Date.now()).map(b => `${b.x}_${b.y}`)
  ), [displayBuildings]);
  const skippableSet = useMemo(() => {
    const queued = new Set(queue.filter(a => a.kind === 'skip').map(a => `${a.x}_${a.y}`));
    return new Set([...underConstructionSet].filter(k => !queued.has(k)));
  }, [underConstructionSet, queue]);
  const emptySet = useMemo(() => new Set([...coordsSet].filter(k => !occupiedSet.has(k))), [coordsSet, occupiedSet]);

  const validSet = useMemo(() => {
    if (executing) return new Set<string>();
    switch (mode) {
      case 'upgrade': case 'queue': return upgradeableSet;
      case 'build': return buildFamily ? emptySet : new Set<string>();
      case 'move': return moveFrom ? emptySet : occupiedSet;
      case 'demolish': return removableSet;
      case 'skip': return skippableSet;
      default: return new Set<string>();
    }
  }, [executing, mode, buildFamily, moveFrom, emptySet, occupiedSet, upgradeableSet, removableSet, skippableSet]);

  const pickedSet = useMemo(() => {
    const s = new Set<string>();
    if (mode === 'move' && moveFrom) s.add(`${moveFrom.x}_${moveFrom.y}`);
    return s;
  }, [mode, moveFrom]);

  const handlePick = useCallback((gx: number, gy: number) => {
    if (mode === 'upgrade') {
      const lvl = Math.floor(Number(addLevel)) || 0;
      if (lvl <= 0) return;
      setTargets(prev => [...prev.filter(t => !(t.x === gx && t.y === gy)), { x: gx, y: gy, target_level: lvl }]);
    } else if (mode === 'queue') {
      setManualQueue(prev => [...prev, { x: gx, y: gy }]);
    } else if (mode === 'build') {
      if (!buildFamily) return;
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'build', family_id: buildFamily, x: gx, y: gy }]);
    } else if (mode === 'move') {
      if (!moveFrom) setMoveFrom({ x: gx, y: gy });
      else { setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'move', from: moveFrom, to: { x: gx, y: gy } }]); setMoveFrom(null); }
    } else if (mode === 'demolish') {
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'demolish', x: gx, y: gy }]);
    } else if (mode === 'skip') {
      setQueue(prev => [...prev, { id: nextIdRef.current++, kind: 'skip', x: gx, y: gy }]);
    }
  }, [mode, addLevel, buildFamily, moveFrom]);

  const removeQueued = (id: number) => setQueue(prev => prev.filter(a => a.id !== id));
  const removeQueuedManual = (index: number) => setManualQueue(prev => prev.filter((_, i) => i !== index));
  const removeTarget = (x: number, y: number) => setTargets(prev => prev.filter(t => !(t.x === x && t.y === y)));

  const saveManualQueue = async () => {
    setBusy(true);
    try {
      const r = await api.saveCapitalQueue(guildTitle, manualQueue);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) refreshMap();
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };
  const saveTargets = async () => {
    setBusy(true);
    try {
      const r = await api.saveCapitalStrategy(guildTitle, targets);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
      if (r.ok) refreshMap();
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  const runQueue = async () => {
    if (!queue.length || executing) return;
    setExecuting(true);
    setProgress({ done: 0, total: queue.length });
    let ok = 0, fail = 0;
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      try {
        let r: { ok: boolean };
        if (a.kind === 'build') r = await api.capitalActionBuild(guildTitle, a.family_id, a.x, a.y);
        else if (a.kind === 'move') r = await api.capitalActionMove(guildTitle, a.from, a.to);
        else if (a.kind === 'demolish') r = await api.capitalActionDemolish(guildTitle, a.x, a.y);
        else r = await api.capitalActionSkipUpgrade(guildTitle, a.x, a.y);
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
    api.capitalStrategy(guildTitle).then(t => { if (t.ok) setTargets(t.targets); });
  };

  const manualQueuePrices = useMemo(() => manualQueue.map((q, i) => {
    const b = owned.find(o => o.x === q.x && o.y === q.y);
    const info = b ? catalogMap.get(b.id) : undefined;
    if (!b || !info) return null;
    const priorSame = manualQueue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
    const fromLvl = (Number(b.level) || 0) + priorSame;
    return capUpgradePrice(b.id, info, fromLvl, econStrength);
  }), [manualQueue, owned, catalogMap, econStrength]);
  const manualQueueTotal = manualQueuePrices.reduce((s: number, p) => s + (p ?? 0), 0);

  // оценка цены ускорения для клетки — по факту оставшегося времени стройки СЕЙЧАС (в момент показа
  // очереди); окончательную цену считает сама игра при выполнении (могло чуть измениться, если
  // очередь долго не запускали)
  const skipCostFor = useCallback((x: number, y: number): number | null => {
    const b = owned.find(o => o.x === x && o.y === y);
    if (!b?.end) return null;
    const secondsLeft = (new Date(b.end).getTime() - Date.now()) / 1000;
    return capSkipUpgradeCost(secondsLeft);
  }, [owned]);

  const familyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of displayBuildings) m.set(b.id, (m.get(b.id) ?? 0) + 1);
    return m;
  }, [displayBuildings]);

  const purchasable = useMemo(() => catalog.filter(b => b.is_purchasable), [catalog]);
  const isUnavailable = (b: CapitalBuildingDef) => {
    const k = familyCounts.get(b.id) ?? 0;
    if (b.limit != null && k >= b.limit) return true;
    if (b.hall_lvl_required != null && hallLevel < b.hall_lvl_required) return true;
    return capBuyPrice(b, k, econStrength) > (row?.coins ?? 0);
  };
  const paletteFiltered = purchasable.filter(b => {
    if (typeFilter && buildingCat(b.id) !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!buildingName(b).toLowerCase().includes(q) && !b.id.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const ua = isUnavailable(a), ub = isUnavailable(b);
    if (ua !== ub) return ua ? 1 : -1;
    return buildingName(a).localeCompare(buildingName(b), 'ru');
  });
  // те же короткие коды категорий, что и на странице "Общий план улучшений" (COM/BEN/SPE/DEC —
  // префикс id, см. buildingCat выше), не человеческое название типа
  const paletteTypes = [...new Set(purchasable.map(b => buildingCat(b.id)))].filter(Boolean);

  const loadActionLog = useCallback(() => {
    if (!guildTitle) return;
    setActionLogLoading(true);
    api.capitalActionLog(guildTitle).then(d => { if (d.ok) setActionLog(d.rows); else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setActionLogLoading(false));
  }, [guildTitle]);
  const loadForecast = useCallback(() => {
    if (!guildTitle) return;
    setForecastLoading(true);
    api.capitalForecast(guildTitle).then(d => { if (d.ok) setForecastEvents(d.events); else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setForecastLoading(false));
  }, [guildTitle]);
  useEffect(() => {
    if (mode === 'log') loadActionLog();
    else if (mode === 'forecast') loadForecast();
  }, [mode, loadActionLog, loadForecast]);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - var(--header-h))' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Box sx={{ p: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <Button leadingVisual={ChevronLeftIcon} onClick={() => navigate('/capitals')}>Назад</Button>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Heading as="h3" sx={{ fontSize: 2, m: 0 }}>{rowName}</Heading>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              Зданий: {owned.length}
              {row?.updated_at && ` · Обновлено: ${new Date(row.updated_at).toLocaleString('ru')}`}
            </Text>
          </Box>
          <DayNightMenu value={dayNight} onChange={setDayNight} />
          <Button leadingVisual={SyncIcon} loading={liveRefreshing} disabled={liveRefreshing} onClick={doLiveRefresh}>Обновить</Button>
        </Box>

        {flash && <Box sx={{ px: 3, pt: 2, flexShrink: 0 }}><Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash></Box>}

        <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {owned.length === 0 && mode === 'view'
            ? <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Text sx={{ color: 'fg.muted' }}>Нет данных о зданиях</Text></Box>
            : <CityActionsCanvas
                buildings={displayBuildings}
                type="capital"
                mapKey={guildTitle}
                mode={!executing ? mode : 'view'}
                validSet={validSet}
                pickedSet={pickedSet}
                targets={targets}
                queue={manualQueue}
                globalPlan={globalPlan}
                catalog={[]}
                onPick={handlePick}
                dayNight={dayNight}
              />
          }
        </Box>
      </Box>

      <div className={`map-panel-overlay${mobilePanelOpen ? ' show' : ''}`} onClick={() => setMobilePanelOpen(false)} />
      <div className={`map-panel${mobilePanelOpen ? ' open' : ''}`}>
        <div className="map-panel-head">
          <IconButton icon={XIcon} aria-label="Закрыть панель" variant="invisible" onClick={() => setMobilePanelOpen(false)} />
        </div>
        <div className="map-panel-tabs">
          <Button variant={mode === 'view' ? 'primary' : 'default'} onClick={() => switchMode('view')}>Показатели</Button>
          {CAPITAL_TABS.map(m => (
            <Button key={m} variant={mode === m ? 'primary' : 'default'} onClick={() => switchMode(m)}>{MODE_TITLE[m]}</Button>
          ))}
        </div>
        <Scrollable style={{ flex: 1 }}>
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>

            {mode === 'view' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>Показатели</Text>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Монеты</Text><CoinValue value={fmt(row?.coins ?? 0)} /></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Кристаллы</Text><Text sx={{ fontSize: 0 }}>{fmt(row?.crystals ?? 0)}</Text></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Прибыль монет/ч</Text><Text sx={{ fontSize: 0 }}>{fmt(row?.profit_coins_final ?? row?.profit_coins ?? 0)}</Text></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Прибыль кристаллов/ч</Text><Text sx={{ fontSize: 0 }}>{fmt(row?.profit_crystals_final ?? row?.profit_crystals ?? 0)}</Text></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Сила экономики</Text><Text sx={{ fontSize: 0 }}>{econStrength.toFixed(2)}</Text></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Уровень штаб-квартиры</Text><Text sx={{ fontSize: 0 }}>{hallLevel}</Text></Box>
              </Box>
            )}

            {mode === 'queue' && (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Кликните здание — оно встанет в конец очереди. Можно выбрать одно и то же здание
                  несколько раз подряд — несколько последовательных апгрейдов.
                </Text>
                {manualQueue.length === 0
                  ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Очередь пуста</Text>
                  : <>
                    {manualQueue.map((q, i) => {
                      const b = owned.find(o => o.x === q.x && o.y === q.y);
                      const priorSame = manualQueue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
                      const fromLvl = b ? (Number(b.level) || 0) + priorSame : null;
                      const price = manualQueuePrices[i];
                      return (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                          <Text sx={{ fontSize: 1 }}>{i + 1}. {b ? labelFor(b.id) : '—'} ({q.x},{q.y}){fromLvl != null ? ` ${fromLvl}→${fromLvl + 1}` : ''}</Text>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            {price != null && <CoinValue value={fmt(price)} />}
                            <Button variant="danger" onClick={() => removeQueuedManual(i)}>×</Button>
                          </Box>
                        </Box>
                      );
                    })}
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1, borderTop: '1px solid', borderColor: 'border.default' }}>
                      <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>Итого</Text>
                      <Text sx={{ fontSize: 1, fontWeight: 'bold' }}><CoinValue value={fmt(manualQueueTotal)} /></Text>
                    </Box>
                  </>}
                <Button variant="primary" block loading={busy} disabled={busy} onClick={saveManualQueue}>Сохранить</Button>
              </>
            )}

            {mode === 'upgrade' && (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Кликните по зданию — цель сохранится для этой клетки. Бот сам улучшает до нужного
                  уровня, когда хватает монет.
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
                  Выберите здание в списке, затем кликайте пустые клетки на карте. Каждая клетка
                  добавляется в очередь ниже.
                </Text>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <TextInput placeholder="Поиск" value={search} onChange={e => setSearch(e.target.value)} block />
                  <div id="map-cat-tabs">
                    {['', ...paletteTypes].map(t => (
                      <span key={t || '__all'} className={'map-cat-tab' + (typeFilter === t ? ' active' : '')} onClick={() => setTypeFilter(t)}>
                        {t || 'ВСЕ'}
                      </span>
                    ))}
                  </div>
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    {paletteFiltered.map(b => {
                      const k = familyCounts.get(b.id) ?? 0;
                      const limitReached = b.limit != null && k >= b.limit;
                      const hallUnmet = !limitReached && b.hall_lvl_required != null && hallLevel < b.hall_lvl_required;
                      const price = capBuyPrice(b, k, econStrength);
                      const unaffordable = !limitReached && !hallUnmet && price > (row?.coins ?? 0);
                      const unavailable = limitReached || hallUnmet || unaffordable;
                      return (
                        <div key={b.id}
                          className={'map-bitem' + (buildFamily === b.id ? ' active' : '') + (unavailable ? ' disabled' : '')}
                          onClick={() => { if (!unavailable) setBuildFamily(b.id); }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buildingName(b)}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 600, color: unavailable ? 'var(--fg-muted)' : 'var(--fg)', flexShrink: 0 }}>
                            {limitReached ? 'Построено' : hallUnmet ? `Нужен холл ${b.hall_lvl_required}` : <CoinValue value={fmt(price)} />}
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
                </Text>
                {moveFrom && <Text sx={{ fontSize: 1 }}>Откуда: ({moveFrom.x},{moveFrom.y})</Text>}
                {moveFrom && <Button onClick={() => setMoveFrom(null)}>Отменить выбор</Button>}
              </>
            )}

            {mode === 'demolish' && (
              <Text sx={{ fontSize: 0, color: 'danger.fg' }}>
                Кликайте здания для сноса. Без возврата монет. Не проверено вживую на столице — если
                игра откажет, ошибка придёт как есть.
              </Text>
            )}

            {mode === 'skip' && (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Кликайте здания, которые прямо сейчас строятся — стройка завершится мгновенно за
                  алмазы. Цена зависит только от оставшегося времени (чем меньше осталось — тем
                  дешевле) и списывается самой игрой в момент выполнения, показанная цифра — оценка.
                </Text>
                {skippableSet.size === 0 && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Сейчас ничего не строится</Text>}
              </>
            )}

            {mode === 'log' && (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Последние действия по этой столице — и бота, и ручные.</Text>
                {actionLogLoading ? <Spinner />
                  : actionLog.length === 0 ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Лог пуст</Text>
                  : actionLog.map(r => (
                    <Box key={r.id} sx={{ p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                      <Text sx={{ fontSize: 1, display: 'block' }}>{logLabel(r, labelFor)}</Text>
                      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{new Date(r.created_at).toLocaleString('ru')}</Text>
                    </Box>
                  ))}
              </>
            )}

            {mode === 'forecast' && (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Реальные предполагаемые действия бота на ближайшие ~3 суток — очередь, личный и
                  общий планы, с учётом накопления монет от прибыли столицы.
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

            {queue.length > 0 && (
              <Box sx={{ borderTop: '1px solid', borderColor: 'border.default', pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted' }}>Очередь ({queue.length})</Text>
                {queue.map(a => (
                  <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                    <Text sx={{ fontSize: 1 }}>{actionLabel(a, labelFor, skipCostFor)}</Text>
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
    </Box>
  );
}
