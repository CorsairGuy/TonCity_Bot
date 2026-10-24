import { useState, useEffect, useMemo, useCallback, useRef, type DragEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Octicon, Text, TextInput } from '@primer/react';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, DotFillIcon, PencilIcon, SyncIcon, XIcon, ZapIcon } from '@primer/octicons-react';
import { api, type CityBoosterRow, type CityActiveBooster, type BuildingDef, type CityActionLogRow, type CityWorldRow, type ForecastEvent, type GlobalUpgradeRule, type MapSection } from '../api';
import { CityActionsCanvas, type CityActionMode, type MapCamera, type MapView, type WorldLayout, type CellFill, type RegionFill } from '../components/CityActionsCanvas';
import { CityMapCity, buildingName, buildingCat, buildPriceAt, familyId, logLabel, cityCellSets, validCellsFor, type CityMapState, type CityCellSets } from './CityMapCity';
import { DayNightMenu } from '../components/DayNightMenu';
import { useMapDayNight } from '../hooks/useMapDayNight';
import {
  MapPalette, MapBrushLevel, PanelShell, Row, Val, Caption, Empty, Thumb, BadgeThumb, Summary, Tile, SumLine, PlanBar, fillOf,
  LogPanel, ForecastPanel, QueuePanel, PendingList, DemolishPanel, ReconstructPanel, RenovatePanel, MasterplanBar, ItemIcon, Glyph, BuildItem, fmtUp, boosterCard, fmtTimeLeft, FooterButton, CancelButton, FILL_DONE, FILL_WIP, FILL_ATTENTION, type PanelMode,
} from './cityMapPanels';
import { CoinValue } from '../components/Icons';
import { LoadError } from '../components/LoadError';
import { useFlash } from '../hooks/useFlash';
import { useAsk } from '../hooks/useAsk';
import { useNarrow } from '../hooks/useNarrow';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { knownItemName } from '../hooks/useItemCatalog';
import { onServerEvent } from '../serverEvents';
import { fmt } from '../utils';
import cityCoordsData from '../data/city-coords.json';
import cityRoadMapData from '../data/road-map.json';

const COORDS = cityCoordsData as { x: number; y: number }[];
const ROAD_MAP = cityRoadMapData as Record<string, { asset: string; big?: boolean }>;
// города стоят сеткой на одной карте: SPAN клеток города (с дорогами и лесом), шаг STEP — 3 клетки зазора
const SPAN = 22, STEP = 25;
const TH_K = 434 / 753;
// город шире этой доли экрана — сайдбар и шапка переходят к нему; уже LEAVE — обратно ко всем городам
const ENTER_SHARE = 0.5, LEAVE_SHARE = 0.42;
const FADE = 'rgba(216,216,216,.62)';
const ACTION_TABS = new Set<CityActionMode>(['build', 'move', 'demolish', 'reconstruct', 'renovate']);

// Страница «Города»: одна карта всех городов на движке карты города (CityActionsCanvas), без отдельной
// страницы города. Издалека сайдбар показывает все города сразу, а когда город у центра экрана шире
// половины экрана (З1), шапка и сайдбар переходят к нему (CityMapCity без своей карты, через порталы), и
// всё, что умеет карта города, работает в его клетках. Зум непрерывный: карта та же, меняется только
// детализация (см. BADGE_PX/COARSE_PX в движке). Список городов обновляется сам: бот присылает свежие
// постройки событием city в общем потоке /api/events.

const isBuilding = (b: { end?: string | null }) => !!b.end && new Date(b.end).getTime() > Date.now();
const topBuilding = (r: CityWorldRow) => [...r.buildings].sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0))[0]?.id;

// сводка всех городов (ни один город не выбран). Действия на карте работают на любом масштабе:
// клик или кисть по клеткам любых городов выполняет код карты города для каждого из них
const ACT = ' Кликните или проведите кистью по клеткам любых городов, хоть нескольких сразу: каждый город выполнит это по правилам своей карты, справа откроется его панель.';
const FAR_HINT: Partial<Record<PanelMode, string>> = {
  view: 'Все города по доходу. Порядок меняется перетаскиванием. Клик по городу на карте или в списке открывает его панель, приближение тоже.',
  upgrade: 'Общий план: целевой уровень по типу здания сразу для всех городов. Личный план: выберите уровень справа от дока и кликайте здания.' + ACT,
  queue: 'Ручные очереди улучшений всех городов. Каждый клик по зданию добавляет уровень в очередь его города.' + ACT,
  forecast: 'Что бот запустит в ближайшие трое суток во всех городах, одной лентой.',
  log: 'Последние действия во всех городах, и бота, и ручные.',
  build: 'Выберите здание в списке: пустые клетки всех городов, где его ещё можно построить, принимают его. Если монет не хватает, стройка подождёт их и бот построит сам.' + ACT,
  move: 'Кликните здание, затем пустую клетку того же города.' + ACT,
  demolish: 'Монеты за снос не возвращаются.' + ACT,
  reconstruct: 'Подсвечены здания, которые умеют реконструироваться: готовое отмечается к выполнению, неготовое встаёт в план.' + ACT,
  renovate: 'Подсвечены здания, готовые к реновации.' + ACT,
  boosters: 'Выберите ускоритель, затем кликайте города: каждый клик ставит один в конец очереди города. Города, где его нет на складе, погашены. В очередь ускорители уходят только по «Применить».',
};

export function CityWorld() {
  const narrow = useNarrow();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<CityActionMode>('view');
  const [dayNight, setDayNight] = useMapDayNight();
  const { flash, showFlash } = useFlash();
  const ask = useAsk();
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const [rows, setRows] = useState<CityWorldRow[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [catalog, setCatalog] = useState<BuildingDef[]>([]);
  const [globalPlan, setGlobalPlan] = useState<GlobalUpgradeRule[]>([]);
  const [sections, setSections] = useState<MapSection[]>([]);

  const load = useCallback(async () => {
    const d = await api.cityWorld();
    if (d.ok) { setRows(d.rows); setOrder(d.order ?? []); setLoadErr(''); }
    else setLoadErr(d.error || 'города не загрузились');
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.buildingsList('city').then(d => { if (d.ok) setCatalog(d.buildings); });
    api.globalUpgradePlan().then(d => { if (d.ok) setGlobalPlan(d.plan); });
    api.sections().then(d => { if (d.ok) setSections(d.sections); });
  }, []);
  // живые постройки: бот шлёт свежий снимок города при каждом старте и конце стройки
  useEffect(() => onServerEvent<{ account: string; buildings: CityWorldRow['buildings'] }>('city', d => {
    setRows(prev => prev.map(r => r.account === d.account ? { ...r, buildings: d.buildings } : r));
  }), []);

  const [refreshing, setRefreshing] = useResumableRefresh('refresh:city', () => load());
  const refreshAll = async () => {
    setRefreshing(true);
    try { await api.refresh('city'); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  // порядок: сначала перетащенные вручную (config.ui.cityOrder), остальные по доходу
  const cities = useMemo(() => {
    const pos = new Map(order.map((a, i) => [a, i]));
    return [...rows].sort((a, b) => {
      const pa = pos.get(a.account), pb = pos.get(b.account);
      if (pa != null || pb != null) return (pa ?? Infinity) - (pb ?? Infinity);
      return b.profit - a.profit || a.account.localeCompare(b.account, 'ru', { numeric: true });
    });
  }, [rows, order]);
  const saveOrder = (next: string[]) => {
    setOrder(next);
    api.saveConfig({ ui: { cityOrder: next } }).then(r => { if (!r.ok) showFlash('Порядок не сохранился', false); }).catch(() => showFlash('Порядок не сохранился', false));
  };
  const [drag, setDrag] = useState<number | null>(null);
  const reorderCity = (from: number, to: number) => {
    const list = cities.map(c => c.account);
    const [x] = list.splice(from, 1); list.splice(to, 0, x);
    saveOrder(list);
  };

  const catMap = useMemo(() => new Map(catalog.map(b => [b.id, b])), [catalog]);
  const labelFor = (id: string) => { const b = catMap.get(id); return b ? buildingName(b) : id; };

  // ── раскладка: город i в общей сетке стоит со сдвигом (col·STEP, row·STEP) ──────────────────
  const cols = Math.max(1, Math.ceil(Math.sqrt(cities.length)));
  const offOf = useMemo(() => new Map(cities.map((c, i) => [c.account, { i, ox: (i % cols) * STEP, oy: Math.floor(i / cols) * STEP }])), [cities, cols]);
  const cityAtCell = useCallback((gx: number, gy: number) => {
    const c = Math.floor(gx / STEP), r = Math.floor(gy / STEP);
    if (gx - c * STEP >= SPAN || gy - r * STEP >= SPAN || c < 0 || r < 0 || c >= cols) return -1;
    const i = r * cols + c;
    return i < cities.length ? i : -1;
  }, [cols, cities.length]);
  // ближайший город к клетке: зазор между городами делится пополам между соседями
  const nearestCity = useCallback((gx: number, gy: number) => {
    const gap = (STEP - SPAN) / 2, rowsN = Math.ceil(cities.length / cols);
    const c = Math.floor((gx + gap) / STEP), r = Math.floor((gy + gap) / STEP);
    if (c < 0 || c >= cols || r < 0 || r >= rowsN || gx - c * STEP >= SPAN + gap || gy - r * STEP >= SPAN + gap) return -1;
    const i = r * cols + c;
    return i < cities.length ? i : -1;
  }, [cols, cities.length]);
  const layoutKey = cities.map(c => `${c.account}:${c.unlockedSections?.join(',') ?? '-'}`).join('|');
  const world = useMemo<WorldLayout>(() => {
    const coordsList: { x: number; y: number }[] = [], roadMap: WorldLayout['roadMap'] = {}, lockedCells = new Map<string, string>();
    for (const c of cities) {
      const o = offOf.get(c.account)!;
      for (const p of COORDS) coordsList.push({ x: p.x + o.ox, y: p.y + o.oy });
      for (const [k, v] of Object.entries(ROAD_MAP)) { const i = k.indexOf('_'); roadMap[`${+k.slice(0, i) + o.ox}_${+k.slice(i + 1) + o.oy}`] = v; }
      if (c.unlockedSections) { const u = new Set(c.unlockedSections); for (const sec of sections) if (!u.has(sec.id)) for (const p of sec.coordinates) lockedCells.set(`${p.x + o.ox}_${p.y + o.oy}`, `${c.account}|${sec.id}`); }
    }
    const regions = cities.map(c => { const o = offOf.get(c.account)!; return { gx: o.ox, gy: o.oy, span: SPAN }; });
    return { coordsList, roadMap, lockedCells, cityAt: cityAtCell, regions };
  }, [layoutKey, sections, cityAtCell]);

  // ── города, открытые кодом карты города ───────────────────────────────────────────────────
  // Текущий город показывает свою шапку и панель; кроме него открыты (скрыто) города с черновиком
  // и те, куда клик или кисть уже ушли, пока город грузится. Каждый отдаёт наверх свои постройки с
  // превью и клетки для действий (CityMapState), клик по клетке выполняет код его города.
  const [cur, setCur] = useState<string | null>(null);
  const curRef = useRef<string | null>(null); curRef.current = cur;
  const movingRef = useRef<string | null>(null);   // город, где идёт перемещение: выбор города не меняется
  const curAuto = useRef(false);   // город выбран приближением — отдалились, и он уходит сам
  const choose = useCallback((a: string | null, auto: boolean) => { curAuto.current = auto; setCur(a); }, []);
  const [states, setStates] = useState<Record<string, CityMapState>>({});
  const onMap = useCallback((m: CityMapState) => setStates(p => ({ ...p, [m.account]: m })), []);
  const [touched, setTouched] = useState<string[]>([]);
  const mounted = useMemo(() => {
    const out = new Set<string>();
    if (cur) out.add(cur);
    for (const a of touched) out.add(a);
    // «Очередь» издалека: города с ручной очередью открыты (скрыто) — цены, перестановка и сохранение их кодом
    if (mode === 'queue' && !cur) for (const r of rows) if (r.queue.length) out.add(r.account);
    for (const [a, st] of Object.entries(states)) if (st.draft) out.add(a);
    return [...out].filter(a => offOf.has(a));
  }, [cur, touched, states, offOf, mode, rows]);
  const mountedKey = mounted.join('|');
  // закрытый город больше не рисуется по своему старому состоянию
  useEffect(() => {
    const keep = new Set(mounted);
    setStates(p => Object.keys(p).every(a => keep.has(a)) ? p : Object.fromEntries(Object.entries(p).filter(([a]) => keep.has(a))));
  }, [mountedKey]);
  const live = useCallback((a: string) => mounted.includes(a) ? states[a] : undefined, [mountedKey, states]);
  const curState = cur ? live(cur) : undefined;
  // черновик города сохранён или отменён — перечитать общий снимок (очереди, цели, отложенная стройка)
  const draftsRef = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(Object.entries(states).filter(([, st]) => st.draft).map(([a]) => a));
    const done = [...draftsRef.current].some(a => !now.has(a));
    draftsRef.current = now;
    if (done) load();
  }, [states]);

  // выбранное здание для стройки и уровень кисти — общие: кисть через несколько городов ставит одно и то же
  const [buildFamily, setBuildFamily] = useState('');
  const [addLevel, setAddLevel] = useState('20');
  useEffect(() => { if (mode !== 'build') setBuildFamily(''); }, [mode]);
  const tool = useMemo(() => ({ buildFamily, setBuildFamily, addLevel, setAddLevel }), [buildFamily, addLevel]);

  // ── камера: первая расстановка, наезд на город по клику, «Все города» ─────────────────────────
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<MapCamera | null>(null);
  const camKey = useRef(0);
  const viewRef = useRef<MapView | null>(null);
  const boxSize = () => ({ W: mapBoxRef.current?.clientWidth || 1000, H: mapBoxRef.current?.clientHeight || 700 });
  const fitTile = () => {
    const { W, H } = boxSize(), rowsN = Math.max(1, Math.ceil(cities.length / cols));
    const wc = (cols - 1) * STEP + SPAN, wr = (rowsN - 1) * STEP + SPAN, half = (wc + wr) / 2;
    return { tile: Math.max(2, Math.min(W / half, H / (half * TH_K + 3)) * 0.92), cx: wc / 2 - 0.5, cy: wr / 2 - 0.5 };
  };
  const enterTile = () => boxSize().W * ENTER_SHARE / SPAN;
  const cityCenter = (account: string) => { const o = offOf.get(account); return o ? { cx: o.ox + SPAN / 2 - 0.5, cy: o.oy + SPAN / 2 - 0.5 } : null; };
  const lookAll = (animate: boolean) => { const f = fitTile(); setCamera({ gx: f.cx, gy: f.cy, tile: f.tile, key: ++camKey.current, animate }); };
  const flyTo = (account: string) => {
    const c = cityCenter(account);
    if (c) setCamera({ gx: c.cx, gy: c.cy, tile: Math.max(enterTile() * 1.25, viewRef.current?.tile ?? 0), key: ++camKey.current, animate: true });
  };
  const zoomedIn = () => { const v = viewRef.current; return !!v && SPAN * v.tile / v.W >= LEAVE_SHARE; };
  // «Все города»: снять выбор; если город был крупно — отъехать ко всем
  const goAll = () => { choose(null, false); if (zoomedIn()) lookAll(true); };
  // первая расстановка: город из адреса (?account=) крупно, иначе все города
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !cities.length) return;
    placed.current = true;
    const a = params.get('account'), c = a ? cityCenter(a) : null;
    if (c) setCamera({ gx: c.cx, gy: c.cy, tile: boxSize().W * 0.8 / SPAN, key: ++camKey.current });
    else lookAll(false);
  }, [cities.length > 0]);

  // крупный план: текущим становится город у центра экрана (когда центр переезжает в другой город);
  // отдалились — город, выбранный приближением, уходит, выбранный кликом остаётся
  const centreRef = useRef<string | null>(null);
  const onView = useCallback((v: MapView) => {
    viewRef.current = v;
    const share = SPAN * v.tile / v.W;
    if (share >= ENTER_SHARE || (centreRef.current && share >= LEAVE_SHARE)) {
      const i = nearestCity(Math.round(v.cx), Math.round(v.cy));
      const a = i < 0 ? null : cities[i].account;
      if (a !== centreRef.current) { centreRef.current = a; if (a && a !== curRef.current && !movingRef.current) choose(a, true); }
    } else {
      centreRef.current = null;
      if (curAuto.current && curRef.current && !movingRef.current) choose(null, false);
    }
  }, [nearestCity, cities, choose]);
  // адрес помнит текущий город — ссылку можно открыть сразу на нём
  useEffect(() => {
    if (!placed.current) return;
    const c = params.get('account');
    if ((cur ?? null) !== c) setParams(cur ? { account: cur } : {}, { replace: true });
  }, [cur]);

  // ── сводка всех городов: лог и прогноз одной лентой ─────────────────────────────────────────
  const [log, setLog] = useState<CityActionLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const loadLog = useCallback(() => {
    setLogLoading(true);
    api.cityActionLogAll().then(d => { if (d.ok) setLog(d.rows); else showFlash(d.error ?? 'Ошибка', false); }).finally(() => setLogLoading(false));
  }, []);

  // прогноз — живой запрос на город, поэтому по два города за раз и только когда вкладку открыли
  const [forecast, setForecast] = useState<(ForecastEvent & { account: string })[]>([]);
  const [forecastLoading, setForecastLoading] = useState(false);
  const forecastRun = useRef(0);
  const loadForecast = useCallback(async () => {
    const run = ++forecastRun.current;
    setForecastLoading(true);
    const names = cities.map(c => c.account), out: (ForecastEvent & { account: string })[] = [];
    let i = 0;
    const worker = async () => {
      while (i < names.length && forecastRun.current === run) {
        const a = names[i++];
        const d = await api.cityForecast(a).catch(() => null);
        if (d?.ok) out.push(...d.events.map(e => ({ ...e, account: a })));
      }
    };
    await Promise.all([worker(), worker()]);
    if (forecastRun.current !== run) return;
    setForecast(out.sort((a, b) => a.start - b.start));
    setForecastLoading(false);
  }, [cities.length > 0]);

  useEffect(() => {
    if (cur) return;
    if (mode === 'log') loadLog();
    else if (mode === 'forecast' && cities.length) loadForecast();
  }, [mode, cur, cities.length > 0]);

  // ── реконструкция и реновация издалека: компоненты и мастерпланы каждого города (из БД)
  const [resources, setResources] = useState<Record<string, { components: number; masterplans: number }>>({});
  useEffect(() => {
    if ((mode !== 'reconstruct' && mode !== 'renovate') || cur || !cities.length) return;
    let alive = true;
    (async () => {
      const names = cities.map(c => c.account), out: typeof resources = {};
      let i = 0;
      const worker = async () => { while (i < names.length) { const a = names[i++]; const d = await api.cityResources(a).catch(() => null); if (d?.ok) out[a] = { components: d.components, masterplans: d.masterplans }; } };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (alive) setResources(out);
    })();
    return () => { alive = false; };
  }, [mode, cur, cities.length > 0]);

  // ── ускорители издалека: склад и очередь каждого города из БД, клик по городу ставит выбранный в очередь
  const [boosters, setBoosters] = useState<Record<string, { stock: CityBoosterRow[]; queue: string[]; active: CityActiveBooster[] }>>({});
  const [boostersLoading, setBoostersLoading] = useState(false);
  const [boosterPick, setBoosterPick] = useState('');
  const [boosterAdd, setBoosterAdd] = useState<{ account: string; name: string }[]>([]);
  const [boosterSaving, setBoosterSaving] = useState(false);
  const loadBoosters = useCallback(async () => {
    setBoostersLoading(true);
    const names = cities.map(c => c.account), out: typeof boosters = {};
    let i = 0;
    const worker = async () => {
      while (i < names.length) {
        const a = names[i++];
        const d = await api.cityBoosters(a).catch(() => null);
        if (d?.ok) out[a] = { stock: d.boosters, queue: (d.queue ?? []).map(q => q.name), active: d.active ?? [] };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBoosters(out);
    setBoostersLoading(false);
  }, [cities]);
  useEffect(() => { if (mode === 'boosters' && !cur && cities.length) loadBoosters(); }, [mode, cur, cities.length > 0]);
  const freeStock = (account: string, name: string) => {
    const v = boosters[account];
    const have = v?.stock.find(s => s.name === name)?.available ?? 0;
    return have - (v?.queue.filter(q => q === name).length ?? 0) - boosterAdd.filter(b => b.account === account && b.name === name).length;
  };
  const boosterDim = mode === 'boosters' && !cur && boosterPick ? new Set(cities.filter(r => freeStock(r.account, boosterPick) <= 0).map(r => r.account)) : null;
  const boosterLabel = (name: string) => { for (const v of Object.values(boosters)) { const b = v.stock.find(s => s.name === name); if (b) return b.label; } return knownItemName(Number(name)) ?? `Ускоритель #${name}`; };
  const applyBoosters = async () => {
    setBoosterSaving(true);
    let fail = 0, error: string | undefined;
    for (const a of [...new Set(boosterAdd.map(b => b.account))]) {
      const order = [...(boosters[a]?.queue ?? []), ...boosterAdd.filter(b => b.account === a).map(b => b.name)];
      const r = await api.saveBoosterQueue(a, order).catch(e => ({ ok: false, error: String(e) }));
      if (!r.ok) { fail++; error ??= r.error; }
    }
    setBoosterSaving(false);
    setBoosterAdd([]);
    showFlash(fail ? `Не сохранилось в ${fail} ${plural(fail, 'городе', 'городах', 'городах')}${error ? ` (${error})` : ''}` : 'Очереди ускорителей обновлены', !fail);
    loadBoosters();
  };

  // ── всё для общей карты в общих координатах ─────────────────────────────────────────────────
  const shiftKey = (account: string, x: number, y: number) => { const o = offOf.get(account); return o ? `${x + o.ox}_${y + o.oy}` : ''; };
  const shiftInto = (out: Set<string>, account: string, set: Iterable<string> | null | undefined) => {
    const o = offOf.get(account);
    if (!o || !set) return;
    for (const k of set) { const i = k.indexOf('_'); out.add(`${+k.slice(0, i) + o.ox}_${+k.slice(i + 1) + o.oy}`); }
  };
  const allBuildings = useMemo(() => cities.flatMap(c => {
    const o = offOf.get(c.account)!;
    return (live(c.account)?.buildings ?? c.buildings).map(b => ({ ...b, x: b.x + o.ox, y: b.y + o.oy }));
  }), [cities, offOf, live]);
  const allQueue = useMemo(() => cities.flatMap(c => {
    const o = offOf.get(c.account)!;
    return (live(c.account)?.queue ?? c.queue).map(v => ({ ...v, x: v.x + o.ox, y: v.y + o.oy }));
  }), [cities, offOf, live]);
  const allTargets = useMemo(() => cities.flatMap(c => {
    const o = offOf.get(c.account)!;
    return (live(c.account)?.targets ?? c.targets ?? []).map(t => ({ ...t, x: t.x + o.ox, y: t.y + o.oy }));
  }), [cities, offOf, live]);
  // клетки для действий: открытый город отдаёт свои, ещё не открытый считается той же функцией по
  // своему снимку (cityCellSets) — клик по ней откроет город, и выполнит его уже код карты города
  const coordKeys = useMemo(() => COORDS.map(c => `${c.x}_${c.y}`), []);
  const rowSets = useMemo(() => {
    const m = new Map<string, CityCellSets>();
    for (const c of cities) {
      const locked = new Set<string>();
      if (c.unlockedSections) { const u = new Set(c.unlockedSections); for (const sec of sections) if (!u.has(sec.id)) for (const p of sec.coordinates) locked.add(`${p.x}_${p.y}`); }
      m.set(c.account, cityCellSets(c.buildings, catMap, coordKeys, locked, new Set((c.buildPlan ?? []).map(p => `${p.x}_${p.y}`))));
    }
    return m;
  }, [cities, catMap, sections, coordKeys]);
  // выбранное здание по лимиту уже не построить в этих городах: их клетки не принимают стройку и гаснут
  const famLimitHit = useCallback((r: CityWorldRow, id: string) => {
    const info = catMap.get(id);
    if (info?.limit == null) return false;
    const f = familyId(id);
    return (live(r.account)?.buildings ?? r.buildings).filter(b => familyId(b.id) === f).length >= info.limit;
  }, [catMap, live]);
  const buildBlockedIn = useMemo(() => new Set(mode === 'build' && buildFamily ? cities.filter(r => famLimitHit(r, buildFamily)).map(r => r.account) : []), [mode, buildFamily, cities, famLimitHit]);
  // перемещение идёт внутри одного города: пока здание взято, остальные города гаснут и не принимают клики
  const movingCity = mode === 'move' ? cities.find(c => live(c.account)?.moving)?.account ?? null : null;
  movingRef.current = movingCity;
  const mapSets = useMemo(() => {
    const valid = new Set<string>(), picked = new Set<string>();
    for (const c of cities) {
      const st = live(c.account);
      if (movingCity && c.account !== movingCity) { if (st) shiftInto(picked, c.account, st.pickedSet); continue; }
      if (st) { shiftInto(valid, c.account, st.validSet); shiftInto(picked, c.account, st.pickedSet); }
      else if (!buildBlockedIn.has(c.account)) { const rs = rowSets.get(c.account); if (rs) shiftInto(valid, c.account, validCellsFor(mode, rs, buildFamily, null)); }
    }
    const focus = curState?.focusSet ? new Set<string>() : null;
    if (focus && cur) shiftInto(focus, cur, curState!.focusSet);
    return { valid, picked, focus };
  }, [cities, live, rowSets, mode, buildFamily, curState, cur, offOf, movingCity, buildBlockedIn]);

  // заливки: отложенная стройка; в сводке — оттенок городов по логу/прогнозу и бледность вне курсора
  const [hoverCity, setHoverCity] = useState<string | null>(null);
  const globalMap = useMemo(() => new Map(globalPlan.map(g => [g.family_id, g.target_level])), [globalPlan]);
  const { fills, regions } = useMemo(() => {
    const fills: CellFill[] = [], regions: RegionFill[] = [];
    for (const c of cities) {
      const st = live(c.account);
      if (st) { for (const f of st.fills) { const k = new Set<string>(); shiftInto(k, c.account, [f.key]); for (const key of k) fills.push({ ...f, key }); } }
      else if (mode === 'build') for (const p of c.buildPlan ?? []) fills.push({ key: shiftKey(c.account, p.x, p.y), fill: 'rgba(212,167,44,.8)', stroke: '#9a6700' });
    }
    if (movingCity) {
      for (const c of cities) if (c.account !== movingCity) { const o = offOf.get(c.account)!; regions.push({ gx: o.ox, gy: o.oy, span: SPAN, fill: FADE }); }
      return { fills, regions };
    }
    if (cur) return { fills, regions };
    const n = new Map<string, number>();
    if (mode === 'forecast' || mode === 'log') for (const e of mode === 'forecast' ? forecast : log) n.set(e.account, (n.get(e.account) ?? 0) + 1);
    const max = Math.max(1, ...n.values());
    const fade = mode === 'view' || mode === 'forecast' || mode === 'log';
    for (const c of cities) {
      const o = offOf.get(c.account)!, k = n.get(c.account);
      if (boosterDim?.has(c.account)) regions.push({ gx: o.ox, gy: o.oy, span: SPAN, fill: FADE });
      if (buildBlockedIn.has(c.account)) regions.push({ gx: o.ox, gy: o.oy, span: SPAN, fill: FADE });
      if (k) regions.push({ gx: o.ox, gy: o.oy, span: SPAN, fill: `rgba(130,80,223,${(0.06 + k / max * 0.3).toFixed(2)})` });
      if (fade && hoverCity && hoverCity !== c.account) regions.push({ gx: o.ox, gy: o.oy, span: SPAN, fill: FADE });
    }
    return { fills, regions };
  }, [cities, live, mode, cur, forecast, log, offOf, hoverCity, movingCity, buildBlockedIn, boosterDim && [...boosterDim].join()]);
  // для курсора зазор между городами делится пополам между соседями: подсветка не гаснет на переходе
  const onHoverCell = useCallback((gx: number | null, gy: number | null) => {
    const i = gx == null || gy == null ? -1 : nearestCity(gx, gy);
    setHoverCity(i >= 0 ? cities[i].account : null);
  }, [nearestCity, cities]);
  const toLocal = (gx: number, gy: number) => {
    const i = cityAtCell(gx, gy);
    if (i < 0) return null;
    const o = offOf.get(cities[i].account)!;
    return { account: cities[i].account, x: gx - o.ox, y: gy - o.oy };
  };

  // ── клики и кисть: каждую клетку выполняет код её города ─────────────────────────────────────
  // Кисть зовёт onPick для всех клеток подряд, поэтому клетки копятся и разбираются одной пачкой:
  // открытому городу — сразу, остальные ждут, пока город загрузится (pending).
  const statesRef = useRef(states); statesRef.current = states;
  const mountedRef = useRef(mounted); mountedRef.current = mounted;
  const pending = useRef(new Map<string, { picks: { x: number; y: number }[]; unlock?: string }>());
  const batch = useRef<{ account: string; x: number; y: number }[] | null>(null);
  const settle = useRef(new Set<string>());
  const deliver = (a: string, st: CityMapState) => {
    const p = pending.current.get(a);
    if (!p) return;
    pending.current.delete(a);
    for (const c of p.picks) if (st.validSet.has(`${c.x}_${c.y}`)) st.onPick(c.x, c.y);
    if (p.unlock) st.onUnlockCell(p.unlock);
    settle.current.add(a);
  };
  const route = (a: string) => {
    const st = mountedRef.current.includes(a) ? statesRef.current[a] : undefined;
    if (st) deliver(a, st);
    else setTouched(t => t.includes(a) ? t : [...t, a]);
  };
  const onPick = useCallback((gx: number, gy: number) => {
    const l = toLocal(gx, gy);
    if (!l) return;
    if (!batch.current) {
      batch.current = [];
      queueMicrotask(() => {
        const list = batch.current ?? [];
        batch.current = null;
        const order: string[] = [];
        for (const c of list) {
          const p = pending.current.get(c.account) ?? { picks: [] };
          if (!pending.current.has(c.account)) { pending.current.set(c.account, p); order.push(c.account); }
          p.picks.push({ x: c.x, y: c.y });
        }
        if (order.length && !order.includes(curRef.current ?? '')) choose(order[0], false);
        for (const a of order) route(a);
      });
    }
    batch.current.push(l);
  }, [offOf, cityAtCell, choose]);
  const onUnlockCell = useCallback((v: string) => {
    const i = v.indexOf('|'), account = v.slice(0, i);
    const p = pending.current.get(account) ?? { picks: [] };
    p.unlock = v.slice(i + 1);
    pending.current.set(account, p);
    if (curRef.current !== account) choose(account, false);
    route(account);
  }, [choose]);
  // город загрузился — отдать ему то, что накликали, пока он грузился
  useEffect(() => {
    for (const [a, st] of Object.entries(states)) {
      if (!mounted.includes(a)) continue;
      if (pending.current.has(a)) deliver(a, st);
      else if (settle.current.has(a)) { settle.current.delete(a); setTouched(t => t.filter(x => x !== a)); }
    }
  }, [states, mountedKey]);
  // клик по городу мимо действий открывает его панель на том же масштабе (камера не двигается)
  // на «Ускорителях» с выбранным ускорителем клик по городу ставит его в очередь этого города
  const boosterTap = useRef<((a: string) => boolean) | null>(null);
  boosterTap.current = mode === 'boosters' && !cur && boosterPick && !boosterSaving ? (a: string) => {
    if (freeStock(a, boosterPick) > 0) setBoosterAdd(p => [...p, { account: a, name: boosterPick }]);
    return true;
  } : null;
  const onTap = useCallback((gx: number, gy: number) => {
    const l = toLocal(gx, gy);
    if (movingRef.current) return;
    if (l && boosterTap.current?.(l.account)) return;
    if (l && l.account !== curRef.current) choose(l.account, false);
  }, [offOf, cityAtCell, choose]);
  const minScale = useMemo(() => (cities.length ? fitTile().tile * 0.7 / 90 : 0.05), [cities.length, cols]);

  // слоты для города: его шапка, сайдбар и плашка кисти встают сюда порталами
  const [headEl, setHeadEl] = useState<HTMLDivElement | null>(null);
  const [sideEl, setSideEl] = useState<HTMLDivElement | null>(null);
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);
  const slots = useMemo(() => ({ head: headEl, side: sideEl, dock: dockEl }), [headEl, sideEl, dockEl]);

  const panelMode = mode as PanelMode;
  const totalProfit = cities.reduce((s, r) => s + r.profit, 0);
  const totalFinal = cities.reduce((s, r) => s + r.profit_final, 0);
  const totalPop = cities.reduce((s, r) => s + r.population, 0);
  const buildingNow = cities.reduce((s, r) => s + r.buildings.filter(isBuilding).length, 0);
  const summary = `${cities.length} ${plural(cities.length, 'город', 'города', 'городов')} · ${fmt(totalProfit)}/ч · строится ${buildingNow}`;
  const thumb = (r: CityWorldRow, dim?: boolean) => { const id = topBuilding(r); return id ? <Thumb id={id} size={36} bg="canvas.default" dim={dim} /> : <Box sx={{ width: 36, height: 36, flexShrink: 0 }} />; };
  const queueOf = (r: CityWorldRow) => live(r.account)?.queue ?? r.queue;
  const queueTotal = cities.reduce((s, r) => s + queueOf(r).length, 0);
  const drafts = cities.filter(r => live(r.account)?.draft);
  // клик по городу в списке: открывается его панель, карта подъезжает к нему
  const openCity = (a: string) => { choose(a, false); flyTo(a); };

  // список городов: перетаскивание меняет порядок (только на «Показателях»)
  const cityList = (list: CityWorldRow[], sub: (r: CityWorldRow) => string, trail: (r: CityWorldRow) => ReactNode, draggable = false) => list.map((r, i) => (
    <Box key={r.account} draggable={draggable}
      onDragStart={draggable ? (e: DragEvent) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      onDragEnd={draggable ? () => setDrag(null) : undefined}
      onDragOver={draggable ? (e: DragEvent) => e.preventDefault() : undefined}
      onDrop={draggable ? (e: DragEvent) => { e.preventDefault(); if (drag != null && drag !== i) reorderCity(drag, i); setDrag(null); } : undefined}
      sx={{ borderRadius: '12px', opacity: draggable && drag === i ? 0.5 : 1, cursor: draggable ? 'grab' : undefined }}>
      <Row lead={thumb(r)} title={r.account} sub={sub(r)} trail={trail(r)} onClick={() => openCity(r.account)} chevron />
    </Box>
  ));
  // города с несохранёнными действиями: их черновики живут, пока не выполнены или не отменены
  const draftList = drafts.length > 0 && <>
    <Caption right={drafts.length}>Черновики</Caption>
    {cityList(drafts, () => 'не сохранено и не выполнено', () => <Val color="attention.fg"><Octicon icon={DotFillIcon} /></Val>)}
  </>;

  // выбор здания без города: цена — от самой дешёвой (по числу уже построенных в каждом городе)
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('COM');
  const purchasable = useMemo(() => catalog.filter(b => b.is_purchasable && !/_\d+_star\.png$/i.test(b.id)), [catalog]);
  const buildCats = [...new Set(purchasable.map(b => buildingCat(b.id)))].filter(Boolean).sort((a, b) => ((['COM', 'RES'].indexOf(a) + 1) || 99) - ((['COM', 'RES'].indexOf(b) + 1) || 99));
  const buildCat = buildCats.includes(catFilter) ? catFilter : buildCats[0];
  const buildPicker = mode === 'build' && !cur && (() => {
    const q = search.toLowerCase();
    const list = purchasable.filter(b => buildingCat(b.id) === buildCat && (!q || buildingName(b).toLowerCase().includes(q) || b.id.toLowerCase().includes(q))).sort((a, b) =>
      buildCat === 'COM' ? (b.base_profit ?? 0) - (a.base_profit ?? 0) : buildCat === 'RES' ? (b.base_population ?? 0) - (a.base_population ?? 0)
        : buildCat === 'SER' ? (b.service_coverage ?? 0) - (a.service_coverage ?? 0) : buildingName(a).localeCompare(buildingName(b), 'ru'));
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextInput placeholder="Поиск" value={search} onChange={e => setSearch(e.target.value)} block />
        <div id="map-cat-tabs">
          {buildCats.map(c => <span key={c} className={'map-cat-tab' + (buildCat === c ? ' active' : '')} onClick={() => setCatFilter(c)}>{c}</span>)}
        </div>
        {list.map(b => {
          const f = familyId(b.id);
          const open = cities.filter(r => !famLimitHit(r, b.id));
          const price = open.length ? Math.min(...open.map(r => buildPriceAt(b, (live(r.account)?.buildings ?? r.buildings).filter(o => familyId(o.id) === f).length))) : 0;
          return <BuildItem key={b.id} id={b.id} name={buildingName(b)} active={buildFamily === b.id} unavailable={!open.length} onClick={() => setBuildFamily(b.id)}
            sub={!open.length ? 'Построено везде' : `в ${open.length} ${plural(open.length, 'городе', 'городах', 'городах')}`}
            trail={open.length ? <Val><CoinValue value={`от ${fmtUp(price)}`} /></Val> : undefined} />;
        })}
      </Box>
    );
  })();

  // «Ждут выполнения» всех городов: строки по городам, одна кнопка выполняет их город за городом
  const withPending = cities.filter(r => (live(r.account)?.pending.length ?? 0) > 0);
  const pendingTotal = withPending.reduce((s, r) => s + live(r.account)!.pending.length, 0);
  const [runAll, setRunAll] = useState<{ done: number; total: number } | null>(null);
  const executeAll = async () => {
    if (runAll) return;
    const list = withPending.map(r => r.account);
    const dem = list.map(a => [a, statesRef.current[a]?.pending.filter(p => p.kind === 'demolish').length ?? 0] as const).filter(([, n]) => n > 0);
    if (dem.length && !await ask('Снести здания?', `${dem.map(([a, n]) => `${a}: ${n}`).join(', ')}. Монеты за снос не возвращаются.`, { ok: 'Снести', danger: true })) return;
    let ok = 0, fail = 0, deferred = 0, error: string | undefined;
    setRunAll({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      const r = await statesRef.current[list[i]]?.run();
      if (r) { ok += r.ok; fail += r.fail; deferred += r.deferred; error ??= r.error; }
      setRunAll({ done: i + 1, total: list.length });
      if (i < list.length - 1) await new Promise(res => setTimeout(res, 1000));
    }
    setRunAll(null);
    showFlash(`Выполнено: ${ok}${deferred ? `, ждут монет: ${deferred}` : ''}${fail ? `, ошибок: ${fail}${error ? ` (${error})` : ''}` : ''}`, fail === 0);
  };
  // Снос: общая сводка потерь сверху, у каждого города своя потеря дохода в подписи
  const demCities = mode === 'demolish' ? withPending.filter(r => live(r.account)!.demolish.tiles.length > 0) : [];
  const demSum = demCities.reduce((a, r) => { const d = live(r.account)!.demolish; return { n: a.n + d.tiles.length, loss: a.loss + d.loss, pop: a.pop + d.pop }; }, { n: 0, loss: 0, pop: 0 });
  const demolishSummary = demCities.length > 0 && (
    <Summary tone="danger">
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Tile size={2} value={demSum.n} label={`${plural(demSum.n, 'здание', 'здания', 'зданий')}, ${demCities.length} ${plural(demCities.length, 'город', 'города', 'городов')}`} />
        <Tile size={2} value={`−${fmt(demSum.loss)}`} label="дохода в час" color="danger.fg" />
      </Box>
      <SumLine left={demSum.pop > 0 ? `жителей −${fmt(demSum.pop)}` : 'жители без изменений'} right={totalFinal > 0 ? `−${(demSum.loss / totalFinal * 100).toFixed(1)}% дохода` : undefined} />
    </Summary>
  );
  // Реконструкция: готовые и все умеющие по снимкам, компоненты всех городов, отмеченное — по открытым городам
  let reconSummary: ReactNode = null;
  if (mode === 'reconstruct') {
    let ready = 0, all = 0, readyCities = 0, comp = 0, marked = 0, spend = 0, gain = 0, planned = 0;
    for (const r of cities) {
      const rs = rowSets.get(r.account);
      if (rs) { ready += rs.reconstructable.size; all += rs.reconstructPlannable.size; if (rs.reconstructable.size) readyCities++; }
      comp += resources[r.account]?.components ?? 0;
      for (const g of live(r.account)?.recon.groups ?? []) for (const c of g.cells) {
        if (c.queued) { marked++; spend += g.comp ?? 0; gain += g.gain ?? 0; }
        if (c.planned) planned++;
      }
    }
    reconSummary = all > 0 && (
      <Summary>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile size={2} value={`${ready}/${all}`} label={`готовы, ${readyCities} ${plural(readyCities, 'город', 'города', 'городов')}`} color="success.fg" />
          <Tile size={2} value={<Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><ItemIcon tag="component" size={18} />{comp}</Box>} label="компонентов" />
        </Box>
        <PlanBar done={ready} wip={0} span={all} size="large" bg="canvas.default" />
        <SumLine left={marked ? <>отмечено {marked}: <Glyph tag="component" v={`−${spend}`} /> <Glyph tag="masterplan" v={`+${gain}`} /></> : 'отметьте готовые здания'} right={planned ? `в плане ${planned}` : undefined} />
      </Summary>
    );
  }
  const mpAll = Object.values(resources).reduce((s, v) => s + v.masterplans, 0);
  const mpUsed = cities.reduce((s, r) => s + (live(r.account)?.renov.items.filter(i => i.marked).reduce((a, i) => a + (i.cost ?? 0), 0) ?? 0), 0);
  const renovSummary = mode === 'renovate' && <MasterplanBar masterplans={mpAll} used={mpUsed} />;
  // города с отмеченной реконструкцией (или реконструкцией в плане) и реновацией — их списки кодом карты города
  const reconCities = mode === 'reconstruct' ? cities.filter(r => (live(r.account)?.recon.groups ?? []).some(g => g.cells.some(c => c.queued || c.planned))) : [];
  const renovCities = mode === 'renovate' ? cities.filter(r => (live(r.account)?.renov.items ?? []).some(i => i.marked)) : [];
  const toolGroups = [...reconCities, ...renovCities].map(r => {
    const st = live(r.account)!, res = resources[r.account];
    const rest = st.pending.filter(p => p.kind !== mode);
    return <Box key={r.account} sx={{ display: 'contents' }}>
      <Caption right={mode === 'reconstruct' ? res?.components ?? '' : res?.masterplans ?? ''}>{r.account}</Caption>
      {mode === 'reconstruct'
        ? <ReconstructPanel summary={false} groups={st.recon.groups} components={st.recon.components} disabled={!!runAll || st.executing} onToggle={st.onPick} />
        : <RenovatePanel summary={false} masterplans={st.renov.masterplans} items={st.renov.items} disabled={!!runAll || st.executing} onToggle={st.onPick} />}
      <PendingList caption={r.account} rows={rest} labelFor={labelFor} disabled={!!runAll || st.executing} onRemove={st.removePending} right={rest.length} />
    </Box>;
  });
  const toolDone = new Set([...reconCities, ...renovCities].map(r => r.account));
  const pendingGroups = withPending.filter(r => !toolDone.has(r.account)).map(r => {
    const st = live(r.account)!;
    if (mode === 'demolish' && st.demolish.tiles.length) {
      const rest = st.pending.filter(p => p.kind !== 'demolish');
      return <Box key={r.account} sx={{ display: 'contents' }}>
        <Caption right={st.demolish.loss > 0 ? `−${fmt(st.demolish.loss)}/ч` : st.demolish.tiles.length}>{r.account}</Caption>
        <DemolishPanel summary={false} tiles={st.demolish.tiles} lossPerHour={st.demolish.loss} popLoss={st.demolish.pop} income={st.demolish.income} disabled={!!runAll || st.executing} onRemove={st.removePending} />
        <PendingList caption={r.account} rows={rest} labelFor={labelFor} disabled={!!runAll || st.executing} onRemove={st.removePending} right={rest.length} />
      </Box>;
    }
    const builds = st.pending.filter(p => p.kind === 'build'), sum = builds.reduce((s, p) => s + (p.price ?? 0), 0);
    return <PendingList key={r.account} caption={r.account} rows={st.pending} labelFor={labelFor} disabled={!!runAll || st.executing} onRemove={st.removePending}
      right={builds.length ? (sum > st.balance ? <Text sx={{ color: 'attention.fg' }}>ждёт {fmt(sum - st.balance)}</Text> : `${fmt(sum)} из ${fmt(st.balance)}`) : st.pending.length} />;
  });
  // все действия этой вкладки — её глагол и цвет, как на карте города
  const RUN_VERB: Partial<Record<CityActionMode, [string, 'primary' | 'danger' | 'accent']>> = {
    build: ['Построить', 'primary'], move: ['Переместить', 'accent'], demolish: ['Снести', 'danger'], reconstruct: ['Реконструировать', 'primary'], renovate: ['Реновировать', 'primary'],
  };
  const runVerb: [string, 'primary' | 'danger' | 'accent'] = RUN_VERB[mode] && withPending.every(r => live(r.account)!.pending.every(p => p.kind === mode)) ? RUN_VERB[mode]! : ['Выполнить', 'primary'];
  const pendingFooter = pendingTotal > 0 && <>
    <FooterButton label={runAll ? `Выполняется ${runAll.done} из ${runAll.total} городов` : runVerb[0]} tone={runVerb[1]} icon={CheckIcon} count={pendingTotal} busy={!!runAll}
      onClick={() => { void executeAll(); }} />
    <CancelButton disabled={!!runAll} onClick={() => { for (const r of withPending) live(r.account)!.cancelPending(); }} />
  </>;

  const queueDirtyCities = mode === 'queue' && !cur ? mounted.filter(a => states[a]?.queueDirty) : [];
  const [queueSaving, setQueueSaving] = useState(false);
  const saveQueues = async () => {
    setQueueSaving(true);
    let fail = 0;
    for (const a of queueDirtyCities) if (!await statesRef.current[a]?.saveQueue()) fail++;
    setQueueSaving(false);
    showFlash(fail ? `Не сохранилось в ${fail} ${plural(fail, 'городе', 'городах', 'городах')}` : 'Очереди сохранены', !fail);
    load();
  };
  const queueFooter = queueDirtyCities.length > 0 && <>
    <FooterButton label="Сохранить" icon={CheckIcon} count={queueTotal} busy={queueSaving} onClick={() => { void saveQueues(); }} />
    <CancelButton disabled={queueSaving} onClick={() => { for (const a of queueDirtyCities) states[a]?.resetQueue(); }} />
  </>;
  const boosterFooter = <>
    <FooterButton label="Применить" icon={ZapIcon} count={boosterAdd.length} busy={boosterSaving} onClick={() => { void applyBoosters(); }} />
    <CancelButton disabled={boosterSaving} onClick={() => setBoosterAdd([])} />
  </>;
  let side: ReactNode = null, headActions: ReactNode = undefined;
  const hovered = mode === 'view' && !narrow && hoverCity ? cities.find(r => r.account === hoverCity) : undefined;
  if (hovered) {
    // Показатели Б: на ПК наведение на город показывает его цифры, увели курсор — снова все города
    const n = hovered.buildings.filter(isBuilding).length, q = queueOf(hovered).length;
    side = <>
      <Caption>{hovered.account}</Caption>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile value={<CoinValue value={fmt(hovered.profit)} />} label="доход в час" color="accent.fg" />
          <Tile value={hovered.profit > 0 ? `+${Math.max(0, (hovered.profit_final / hovered.profit - 1) * 100).toFixed(0)}%` : '—'} label="после планов" color="success.fg" />
        </Box>
        <SumLine left={`жителей ${fmt(hovered.population)}`} right={`строится ${n}`} />
      </Summary>
      <Row lead={thumb(hovered)} title={`${hovered.buildings.length} ${plural(hovered.buildings.length, 'здание', 'здания', 'зданий')}`} sub={q ? `в очереди ${q}` : 'очередь пуста'} trail={<Val><CoinValue value={fmt(hovered.balance ?? 0)} /></Val>} />
    </>;
  } else if (mode === 'view') {
    side = <>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile value={<CoinValue value={fmt(totalProfit)} />} label="доход в час" color="accent.fg" />
          <Tile value={totalProfit > 0 ? `+${Math.max(0, (totalFinal / totalProfit - 1) * 100).toFixed(0)}%` : '—'} label="потенциал" color="success.fg" />
        </Box>
        <SumLine left={`жителей ${fmt(totalPop)}`} right={`строится ${buildingNow}`} />
      </Summary>
      {draftList}
      <Caption right={cities.length}>Города</Caption>
      {cityList(cities, r => { const n = r.buildings.filter(isBuilding).length; return n ? `строится ${n}` : `жителей ${fmt(r.population)}`; },
        r => <Val><CoinValue value={fmt(r.profit)} /></Val>, true)}
    </>;
  } else if (mode === 'upgrade') {
    const rules = globalPlan.map(g => {
      let n = 0, done = 0;
      for (const r of cities) for (const b of r.buildings) if (b.id === g.family_id) { n++; if ((Number(b.level) || 0) >= g.target_level) done++; }
      return { ...g, n, done };
    }).filter(g => g.n > 0).sort((a, b) => b.n - a.n);
    const all = rules.reduce((s, g) => s + g.n, 0), allDone = rules.reduce((s, g) => s + g.done, 0);
    const withPlan = cities.filter(r => (live(r.account)?.targets ?? r.targets ?? []).length > 0);
    side = <>
      <Button leadingVisual={PencilIcon} block onClick={() => navigate('/global-upgrade-plan')}>Изменить общий план</Button>
      {draftList}
      {rules.length > 0 && (
        <Summary>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile value={`${all ? Math.round(allDone / all * 100) : 0}%`} label="выполнено" color="success.fg" />
            <Tile value={`${allDone}/${all}`} label="на цели" />
          </Box>
          <PlanBar done={allDone} wip={0} span={all || 1} size="large" bg="canvas.default" />
          <SumLine left={`${rules.length} ${plural(rules.length, 'правило', 'правила', 'правил')} · все города`} />
        </Summary>
      )}
      {rules.length === 0 ? <Empty>Общий план пуст</Empty> : rules.map(g => (
        <Row key={g.family_id} lead={<Thumb id={g.family_id} size={36} bg="canvas.default" />} title={labelFor(g.family_id)}
          sub={`до ур. ${g.target_level} · ${g.n} шт.`}
          fill={fillOf([[FILL_DONE, g.done / g.n * 100]])}
          trail={g.done >= g.n ? <Val><Octicon icon={CheckIcon} /></Val> : <Val color="fg.muted">{g.done}/{g.n}</Val>} />
      ))}
      {withPlan.length > 0 && <>
        <Caption right={withPlan.length}>Личные планы</Caption>
        {cityList(withPlan, r => { const n = (live(r.account)?.targets ?? r.targets ?? []).length; return `${n} ${plural(n, 'цель', 'цели', 'целей')}`; }, () => null)}
      </>}
    </>;
  } else if (mode === 'queue') {
    const groups = cities.filter(r => queueOf(r).length > 0);
    // на каждый город свой бюджет (80% его монет): «хватит» считается по городу, итог — сумма
    let total = 0, fit = 0;
    for (const r of groups) {
      const st = live(r.account);
      if (!st) continue;
      let run = 0;
      for (const p of st.queuePrices) { total += p ?? 0; if ((run += p ?? 0) <= st.balance * 0.8) fit++; }
    }
    side = <>
      {groups.length === 0 ? <Empty>Ручных улучшений в очереди нет</Empty> : <>
        <Summary tone="accent">
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile size={2} value={queueTotal} label="в очереди" color="accent.fg" />
            <Tile size={2} value={<CoinValue value={fmt(total)} />} label="монет на всё" />
          </Box>
          <SumLine left={`хватит на ${fit} из ${queueTotal}`} right="бюджет 80%" />
        </Summary>
        {groups.map(r => {
          const st = live(r.account), q = queueOf(r);
          return (
            <Box key={r.account} sx={{ display: 'contents' }}>
              <Caption right={q.length}>{r.account}</Caption>
              <QueuePanel summary={false} queue={q} owned={st?.buildings ?? r.buildings} labelFor={labelFor} prices={st?.queuePrices ?? q.map(() => null)} balance={st?.balance ?? r.balance ?? 0}
                onReorder={(from, to) => st?.editQueue(p => { const n = [...p]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; })}
                onRemove={i => st?.editQueue(p => p.filter((_, k) => k !== i))} />
            </Box>
          );
        })}
      </>}
    </>;
  } else if (mode === 'boosters') {
    const totals = new Map<string, number>();
    for (const v of Object.values(boosters)) for (const b of v.stock) totals.set(b.name, (totals.get(b.name) ?? 0) + b.available);
    const list = [...totals].sort((a, b) => b[1] - a[1]);
    const activeAll = Object.entries(boosters).flatMap(([a, v]) => v.active.map(b => ({ ...b, account: a }))).sort((x, y) => x.ends_at - y.ends_at);
    side = <>
      {boostersLoading && !list.length ? <Empty>Загрузка…</Empty> : list.length === 0 ? <Empty>Ускорителей на складах нет</Empty> : <>
        <Caption>На складе, все города</Caption>
        {list.map(([name, n]) => {
          const where = cities.filter(r => freeStock(r.account, name) > 0).length;
          return <Row key={name} lead={boosterCard(name, n || undefined, !n)} title={boosterLabel(name)}
            sub={where ? `в ${where} ${plural(where, 'городе', 'городах', 'городах')}` : 'всё уже в очередях'}
            fill={boosterPick === name ? fillOf([[FILL_WIP, 100]]) : undefined}
            onClick={() => setBoosterPick(p => p === name ? '' : name)} />;
        })}
      </>}
      {boosterAdd.length > 0 && <Caption right={boosterAdd.length}>Ждут выполнения</Caption>}
      {boosterAdd.map((b, i) => (
        <Row key={i} lead={boosterCard(b.name)} title={b.account} sub={boosterLabel(b.name)}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={boosterSaving} onClick={() => setBoosterAdd(p => p.filter((_, k) => k !== i))} />} />
      ))}
      {activeAll.length > 0 && <Caption right={activeAll.length}>Активны</Caption>}
      {activeAll.map(b => (
        <Row key={`${b.account}:${b.name}`} lead={boosterCard(b.name)} title={b.account} bg="attention.subtle"
          sub={`${b.label || boosterLabel(b.name)} · ещё ${fmtTimeLeft(b.ends_at - Date.now())}`}
          trail={<Val mono color="attention.fg">{new Date(b.ends_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</Val>} />
      ))}
    </>;
    headActions = <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Обновить склады" disabled={boostersLoading} onClick={loadBoosters} />;
  } else if (mode === 'forecast') {
    side = <ForecastPanel events={forecast} loading={forecastLoading} labelFor={labelFor} place={e => e.account} />;
    headActions = <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Пересчитать прогноз" disabled={forecastLoading} onClick={loadForecast} />;
  } else if (mode === 'log') {
    const boosterLabel = (id: string) => knownItemName(Number(id)) ?? `Ускоритель #${id}`;
    side = <LogPanel rows={log} loading={logLoading} label={r => logLabel(r, labelFor, boosterLabel)} labelFor={labelFor} place={r => r.account} />;
    headActions = <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Обновить лог" disabled={logLoading} onClick={loadLog} />;
  } else {
    const deferred = cities.filter(r => (r.buildPlan ?? []).length > 0);
    side = <>
      {buildPicker}
      {demolishSummary}
      {reconSummary}
      {renovSummary}
      {toolGroups}
      {pendingGroups}
      {mode === 'build' && deferred.length > 0 && <>
        <Caption right={deferred.reduce((s, r) => s + r.buildPlan.length, 0)}>Ждут монет</Caption>
        {deferred.flatMap(r => r.buildPlan.map(p => (
          <Row key={`${r.account}:${p.x},${p.y}`} lead={<Thumb id={p.family_id} size={36} bg="canvas.default" />} title={labelFor(p.family_id)}
            sub={`${r.account} · ${p.x},${p.y}`} fill={fillOf([[FILL_ATTENTION, 100]])} onClick={() => openCity(r.account)} />
        )))}
      </>}
      <Caption right={cities.length}>Города</Caption>
      {cityList(cities, r => { const n = r.buildings.filter(isBuilding).length; return n ? `строится ${n}` : `жителей ${fmt(r.population)}`; }, () => null)}
    </>;
  }

  const panelToggle = narrow
    ? <IconButton size="small" variant="invisible" icon={panelCollapsed ? ChevronUpIcon : ChevronDownIcon}
        aria-label={panelCollapsed ? 'Развернуть панель' : 'Свернуть панель'} onClick={() => setPanelCollapsed(v => !v)} />
    : null;
  // точки на доке: у текущего города — его, в сводке — общий план, очереди и черновики всех городов
  const dots: Partial<Record<PanelMode, boolean>> = { upgrade: globalPlan.length > 0, queue: queueTotal > 0 };
  for (const a of mounted) for (const [k, v] of Object.entries(states[a]?.dots ?? {})) if (v) dots[k as PanelMode] = true;

  const mapEl = (
    <CityActionsCanvas
      buildings={allBuildings}
      type="city"
      mapKey="world"
      mode={mode}
      validSet={mapSets.valid}
      pickedSet={mapSets.picked}
      targets={allTargets}
      queue={allQueue}
      globalPlan={globalPlan}
      catalog={catalog}
      onPick={onPick}
      onUnlockCell={onUnlockCell}
      focusSet={mapSets.focus}
      dayNight={dayNight}
      world={world}
      minScale={minScale}
      camera={camera}
      onView={onView}
      fills={fills}
      regions={regions}
      onTap={onTap}
      onHoverCell={cur ? undefined : onHoverCell}
    />
  );

  return (
    <Box sx={{
      display: 'flex', height: 'calc(100vh - var(--header-h))',
      '@media (max-width: 768px)': { flexDirection: 'column', height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        {/* шапка: все города или текущий город (его шапка встаёт сюда порталом) */}
        <Box ref={setHeadEl} sx={{ flexShrink: 0 }}>
          {!cur && <>
            <Box sx={{ p: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2, flexWrap: narrow ? 'nowrap' : 'wrap' }} title={summary}>
                <Heading as="h3" sx={{ fontSize: 2, m: 0, whiteSpace: 'nowrap' }}>Все города</Heading>
                {!narrow && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{summary}</Text>}
              </Box>
              <DayNightMenu value={dayNight} onChange={setDayNight} />
              {narrow
                ? <IconButton icon={SyncIcon} aria-label="Обновить" disabled={refreshing} onClick={refreshAll} />
                : <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refreshAll}>Обновить</Button>}
            </Box>
            {flash && <Box sx={{ px: 3, pt: 2 }}><Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash></Box>}
          </>}
        </Box>
        <Box ref={mapBoxRef} sx={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          {loadErr
            ? <Box sx={{ flex: 1, p: 3 }}><LoadError error={loadErr} onRetry={load} /></Box>
            : loaded && cities.length === 0
              ? <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Text sx={{ color: 'fg.muted' }}>Снимков городов ещё нет — нажмите «Обновить»</Text></Box>
              : cities.length > 0 && mapEl}
          <Box sx={{
            position: 'absolute', left: 2, right: 2, bottom: 3, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', columnGap: 2,
            pointerEvents: 'none', '& > *': { pointerEvents: 'auto' },
            '@media (max-width: 768px)': { display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 2 },
          }}>
            <Box sx={{ gridColumn: 2, minWidth: 0, maxWidth: '100%', display: 'flex' }}><MapPalette mode={panelMode} onSelect={m => { setPanelCollapsed(false); setMode(m); }} dots={dots} /></Box>
            {/* уровень кисти «Плана» — общий для всех городов, виден и без текущего города */}
            <Box ref={setDockEl} sx={{ gridColumn: 3, justifySelf: 'start', '&:empty': { display: 'none' } }}>
              {!cur && mode === 'upgrade' && <MapBrushLevel value={Math.max(1, Math.floor(Number(addLevel)) || 1)} onChange={v => setAddLevel(String(v))} />}
            </Box>
          </Box>
        </Box>
      </Box>
      <Box sx={{
        width: 'var(--sidebar-w)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid', borderColor: 'border.default',
        '@media (max-width: 768px)': { width: '100%', height: panelCollapsed ? '49px' : '45%', borderLeft: 0, borderTop: '1px solid', borderTopColor: 'border.default', overflow: 'hidden' },
      }}>
        {/* сайдбар: все города или текущий город (его панель встаёт сюда порталом) */}
        <Box ref={setSideEl} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {!cur && (
            <PanelShell mode={panelMode} hint={FAR_HINT[panelMode] ?? ''} actions={<>{headActions}{panelToggle}</>} footer={ACTION_TABS.has(mode) ? pendingFooter || undefined : mode === 'boosters' && boosterAdd.length ? boosterFooter : mode === 'queue' ? queueFooter || undefined : undefined}>
              {side}
            </PanelShell>
          )}
        </Box>
      </Box>
      {mounted.map(a => (
        <CityMapCity key={a} account={a} mode={mode} onModeChange={setMode} onBack={goAll} hidden={a !== cur} tool={tool}
          slots={slots} onMap={onMap} dayNight={dayNight} onDayNight={setDayNight} panelActions={panelToggle} />
      ))}
    </Box>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
