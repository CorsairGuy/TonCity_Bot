import { useState, useEffect, useMemo, useCallback, useRef, type DragEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, IconButton, Octicon, Text } from '@primer/react';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon, SyncIcon, XIcon } from '@primer/octicons-react';
import { api, type BuildingDef, type CityActionLogRow, type CityStrategyQueueItem, type CityWorldRow, type ForecastEvent, type GlobalUpgradeRule, type MapSection } from '../api';
import { WorldMapCanvas, LEAVE_SHARE, type WorldCell } from '../components/WorldMapCanvas';
import type { CityActionMode } from '../components/CityActionsCanvas';
import { CityMapCity, buildingName, logLabel } from './CityMapCity';
import { useFarActions } from './cityWorldActions';
import {
  MapPalette, PanelShell, Row, Val, Caption, Empty, Thumb, BadgeThumb, Summary, Tile, SumLine, PlanBar, fillOf, FooterButton, CancelButton,
  LogPanel, ForecastPanel, FILL_DONE, FILL_WIP, type PanelMode,
} from './cityMapPanels';
import { CoinValue } from '../components/Icons';
import { LoadError } from '../components/LoadError';
import { useFlash } from '../hooks/useFlash';
import { useNarrow } from '../hooks/useNarrow';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { knownItemName } from '../hooks/useItemCatalog';
import { onServerEvent } from '../serverEvents';
import { fmt } from '../utils';
import cityCoordsData from '../data/city-coords.json';

const coordsList = cityCoordsData as { x: number; y: number }[];

// Страница «Города»: одна карта всех городов. Издалека сайдбар показывает все города сразу (вкладку
// переключает тот же док, что у карты города), а когда город приблизили шире половины экрана (З1) или
// кликнули по нему — открывается его карта со всеми действиями (CityMapCity), на той же вкладке.
// Колесо наружу на самом мелком масштабе города или кнопка «Все города» возвращают сюда, город при
// этом стоит в центре на треть экрана. Список городов обновляется сам: бот присылает свежие постройки
// событием city в общем потоке /api/events.

const isBuilding = (b: { end?: string | null }) => !!b.end && new Date(b.end).getTime() > Date.now();
const topBuilding = (r: CityWorldRow) => [...r.buildings].sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0))[0]?.id;

// издалека подсказки короче: действия делаются в приближенном городе
const FAR_HINT: Partial<Record<PanelMode, string>> = {
  view: 'Все города по доходу. Порядок меняется перетаскиванием, клик открывает город.',
  upgrade: 'Общий план: целевой уровень по типу здания сразу для всех городов. Личный план города виден, когда город приближен.',
  queue: 'Ручные очереди улучшений всех городов. Порядок внутри города меняется перетаскиванием, здания добавляются в приближенном городе.',
  forecast: 'Что бот запустит в ближайшие трое суток во всех городах, одной лентой.',
  log: 'Последние действия во всех городах, и бота, и ручные.',
};

export function CityWorld() {
  const narrow = useNarrow();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const near = params.get('account');
  const [mode, setMode] = useState<CityActionMode>('view');
  const [focus, setFocus] = useState<{ account: string; share: number } | null>(null);
  const { flash, showFlash } = useFlash();
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
  useEffect(() => { load(); }, [load, near]);
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
  const reorderCity = (from: number, to: number) => {
    const list = cities.map(c => c.account);
    const [x] = list.splice(from, 1); list.splice(to, 0, x);
    saveOrder(list);
  };

  const catMap = useMemo(() => new Map(catalog.map(b => [b.id, b])), [catalog]);
  const labelFor = (id: string) => { const b = catMap.get(id); return b ? buildingName(b) : id; };

  // ── вход в город и выход ─────────────────────────────────────────────────
  const enter = useCallback((account: string) => { setParams({ account }, { replace: false }); }, [setParams]);
  const leave = useCallback(() => {
    if (near) setFocus({ account: near, share: LEAVE_SHARE });
    setParams({}, { replace: false });
  }, [near, setParams]);

  // ── вкладки издалека ─────────────────────────────────────────────────────
  // очередь: черновик по городам, «Сохранить» отправляет только изменённые
  const [queues, setQueues] = useState<Record<string, CityStrategyQueueItem[]>>({});
  const savedQueues = useMemo(() => Object.fromEntries(rows.map(r => [r.account, r.queue])), [rows]);
  useEffect(() => { setQueues(savedQueues); }, [savedQueues]);
  const qKey = (q: CityStrategyQueueItem[] | undefined) => (q ?? []).map(v => `${v.x},${v.y}`).join(';');
  const changedQueues = Object.keys(queues).filter(a => qKey(queues[a]) !== qKey(savedQueues[a]));
  const [queueBusy, setQueueBusy] = useState(false);
  const saveQueues = async () => {
    setQueueBusy(true);
    let fail = '';
    for (const a of changedQueues) {
      const r = await api.saveCityQueue(a, queues[a]);
      if (!r.ok) fail = r.error ?? 'Ошибка';
    }
    setQueueBusy(false);
    showFlash(fail || 'Сохранено', !fail);
    load();
  };
  const [drag, setDrag] = useState<{ a: string; i: number } | null>(null);
  const moveQ = (a: string, from: number, to: number) => setQueues(p => { const n = [...(p[a] ?? [])]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return { ...p, [a]: n }; });
  const removeQ = (a: string, i: number) => setQueues(p => ({ ...p, [a]: (p[a] ?? []).filter((_, k) => k !== i) }));

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
    if (near) return;
    if (mode === 'log') loadLog();
    else if (mode === 'forecast' && cities.length) loadForecast();
  }, [mode, near, cities.length > 0]);

  // ── заливки карты по вкладке ─────────────────────────────────────────────
  const globalMap = useMemo(() => new Map(globalPlan.map(g => [g.family_id, g.target_level])), [globalPlan]);
  const { cells, tint, dim } = useMemo(() => {
    const cells: WorldCell[] = [];
    const tint = new Map<string, string>();
    let dim: Set<string> | null = null;
    if (mode === 'upgrade') {
      for (const r of cities) for (const b of r.buildings) {
        const t = globalMap.get(b.id);
        if (!t) continue;
        const done = (Number(b.level) || 0) >= t;
        cells.push({ account: r.account, x: b.x, y: b.y, fill: done ? 'rgba(74,194,107,.55)' : 'rgba(84,174,255,.55)', stroke: done ? '#1a7f37' : '#0969da' });
      }
    } else if (mode === 'queue') {
      for (const r of cities) for (const q of queues[r.account] ?? []) cells.push({ account: r.account, x: q.x, y: q.y, fill: 'rgba(84,174,255,.6)', stroke: '#0969da' });
    } else if (mode === 'forecast' || mode === 'log') {
      const n = new Map<string, number>();
      for (const e of mode === 'forecast' ? forecast : log) n.set(e.account, (n.get(e.account) ?? 0) + 1);
      const max = Math.max(1, ...n.values());
      for (const [a, k] of n) tint.set(a, `rgba(130,80,223,${(0.06 + k / max * 0.3).toFixed(2)})`);
    }
    return { cells, tint, dim };
  }, [mode, cities, globalMap, queues, forecast, log]);

  // ── действия прямо на общей карте (стройка, перемещение, снос, реконструкция, реновация, ускорители)
  const far = useFarActions({ mode: mode as PanelMode, cities, catalog, catMap, sections, labelFor, showFlash, reload: load });

  // ── страница города ──────────────────────────────────────────────────────
  if (near) return <CityMapCity key={near} account={near} mode={mode} onModeChange={setMode} onBack={leave} onZoomOut={leave} />;

  const panelMode = mode as PanelMode;
  const totalProfit = cities.reduce((s, r) => s + r.profit, 0);
  const totalFinal = cities.reduce((s, r) => s + r.profit_final, 0);
  const totalPop = cities.reduce((s, r) => s + r.population, 0);
  const buildingNow = cities.reduce((s, r) => s + r.buildings.filter(isBuilding).length, 0);
  const summary = `${cities.length} ${plural(cities.length, 'город', 'города', 'городов')} · ${fmt(totalProfit)}/ч · строится ${buildingNow}`;
  const thumb = (r: CityWorldRow, dim?: boolean) => { const id = topBuilding(r); return id ? <Thumb id={id} size={36} bg="canvas.default" dim={dim} /> : <Box sx={{ width: 36, height: 36, flexShrink: 0 }} />; };
  const queueTotal = Object.values(queues).reduce((s, q) => s + q.length, 0);

  // список городов (Показатели и вкладки действий издалека): клик открывает город на этой вкладке
  const cityList = (list: CityWorldRow[], sub: (r: CityWorldRow) => string, trail: (r: CityWorldRow) => ReactNode, draggable = false) => list.map((r, i) => (
    <Box key={r.account} draggable={draggable}
      onDragStart={draggable ? (e: DragEvent) => { setDrag({ a: '', i }); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      onDragEnd={draggable ? () => setDrag(null) : undefined}
      onDragOver={draggable ? (e: DragEvent) => e.preventDefault() : undefined}
      onDrop={draggable ? (e: DragEvent) => { e.preventDefault(); if (drag && drag.a === '' && drag.i !== i) reorderCity(drag.i, i); setDrag(null); } : undefined}
      sx={{ borderRadius: '12px', opacity: drag && drag.a === '' && drag.i === i ? 0.5 : 1, cursor: draggable ? 'grab' : undefined }}>
      <Row lead={thumb(r)} title={r.account} sub={sub(r)} trail={trail(r)} onClick={() => enter(r.account)} chevron />
    </Box>
  ));

  let side: ReactNode = null, footer: ReactNode = undefined, headActions: ReactNode = undefined;
  if (mode === 'view') {
    side = <>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile value={<CoinValue value={fmt(totalProfit)} />} label="доход в час" color="accent.fg" />
          <Tile value={totalProfit > 0 ? `+${Math.max(0, (totalFinal / totalProfit - 1) * 100).toFixed(0)}%` : '—'} label="потенциал" color="success.fg" />
        </Box>
        <SumLine left={`жителей ${fmt(totalPop)}`} right={`строится ${buildingNow}`} />
      </Summary>
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
    side = <>
      <Button leadingVisual={PencilIcon} block onClick={() => navigate('/global-upgrade-plan')}>Изменить общий план</Button>
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
    </>;
  } else if (mode === 'queue') {
    const groups = cities.filter(r => (queues[r.account] ?? []).length > 0);
    side = groups.length === 0 ? <Empty>Ручных улучшений в очереди нет</Empty> : <>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile size={2} value={queueTotal} label="в очереди" color="accent.fg" />
          <Tile size={2} value={groups.length} label={plural(groups.length, 'город', 'города', 'городов')} />
        </Box>
      </Summary>
      {groups.map(r => {
        const q = queues[r.account] ?? [];
        return (
          <Box key={r.account} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Caption right={q.length}>{r.account}</Caption>
            {q.map((item, i) => {
              const b = r.buildings.find(o => o.x === item.x && o.y === item.y);
              const prior = q.slice(0, i).filter(v => v.x === item.x && v.y === item.y).length;
              const from = b ? (Number(b.level) || 0) + prior : null;
              return (
                <Box key={i} draggable onDragStart={e => { setDrag({ a: r.account, i }); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
                  onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag && drag.a === r.account && drag.i !== i) moveQ(r.account, drag.i, i); setDrag(null); }}
                  sx={{ borderRadius: '12px', cursor: 'grab', opacity: drag && drag.a === r.account && drag.i === i ? 0.5 : 1 }}>
                  <Row lead={b ? <BadgeThumb id={b.id} badge={i + 1} badgeBg={i === 0 ? 'accent.emphasis' : 'neutral.emphasis'} /> : <Box sx={{ width: 36 }} />}
                    title={b ? labelFor(b.id) : '—'} fill={i === 0 ? fillOf([[FILL_WIP, 100]]) : undefined}
                    sub={from != null ? `${from} → ${from + 1}` : `${item.x},${item.y}`}
                    trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => removeQ(r.account, i)} />} />
                </Box>
              );
            })}
          </Box>
        );
      })}
    </>;
    footer = <>
      <FooterButton label="Сохранить" icon={CheckIcon} count={queueTotal} busy={queueBusy} disabled={changedQueues.length === 0} onClick={saveQueues} />
      <CancelButton disabled={queueBusy || changedQueues.length === 0} onClick={() => setQueues(savedQueues)} />
    </>;
  } else if (mode === 'forecast') {
    side = <ForecastPanel events={forecast} loading={forecastLoading} labelFor={labelFor} place={e => e.account} />;
    headActions = <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Пересчитать прогноз" disabled={forecastLoading} onClick={loadForecast} />;
  } else if (mode === 'log') {
    const boosterLabel = (id: string) => knownItemName(Number(id)) ?? `Ускоритель #${id}`;
    side = <LogPanel rows={log} loading={logLoading} label={r => logLabel(r, labelFor, boosterLabel)} labelFor={labelFor} place={r => r.account} />;
    headActions = <IconButton size="small" variant="invisible" icon={SyncIcon} aria-label="Обновить лог" disabled={logLoading} onClick={loadLog} />;
  } else if (far.active) {
    side = far.side;
    footer = far.footer;
  }

  const panelToggle = narrow
    ? <IconButton size="small" variant="invisible" icon={panelCollapsed ? ChevronUpIcon : ChevronDownIcon}
        aria-label={panelCollapsed ? 'Развернуть панель' : 'Свернуть панель'} onClick={() => setPanelCollapsed(v => !v)} />
    : null;
  const dots: Partial<Record<PanelMode, boolean>> = { ...far.dots, upgrade: globalPlan.length > 0, queue: queueTotal > 0 };

  return (
    <Box sx={{
      display: 'flex', height: 'calc(100vh - var(--header-h))',
      '@media (max-width: 768px)': { flexDirection: 'column', height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <Box sx={{ p: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2, flexWrap: narrow ? 'nowrap' : 'wrap' }} title={summary}>
            <Heading as="h3" sx={{ fontSize: 2, m: 0, whiteSpace: 'nowrap' }}>Все города</Heading>
            {!narrow && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{summary}</Text>}
          </Box>
          {narrow
            ? <IconButton icon={SyncIcon} aria-label="Обновить" disabled={refreshing} onClick={refreshAll} />
            : <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refreshAll}>Обновить</Button>}
        </Box>
        {flash && <Box sx={{ px: 3, pt: 2, flexShrink: 0 }}><Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash></Box>}
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          {loadErr
            ? <Box sx={{ flex: 1, p: 3 }}><LoadError error={loadErr} onRetry={load} /></Box>
            : loaded && cities.length === 0
              ? <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Text sx={{ color: 'fg.muted' }}>Снимков городов ещё нет — нажмите «Обновить»</Text></Box>
              : <WorldMapCanvas cities={cities} sections={sections} cells={far.active ? far.cells : cells} tint={tint} dim={far.active ? far.dim : dim} focus={focus} onEnter={enter} onCell={far.onCell} />}
          <Box sx={{
            position: 'absolute', left: 2, right: 2, bottom: 3, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', columnGap: 2,
            pointerEvents: 'none', '& > *': { pointerEvents: 'auto' },
            '@media (max-width: 768px)': { display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 2 },
          }}>
            <Box sx={{ gridColumn: 2, minWidth: 0, maxWidth: '100%', display: 'flex' }}><MapPalette mode={panelMode} onSelect={m => { setPanelCollapsed(false); setMode(m); }} dots={dots} /></Box>
          </Box>
        </Box>
      </Box>
      <Box sx={{
        width: 'var(--sidebar-w)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid', borderColor: 'border.default',
        '@media (max-width: 768px)': { width: '100%', height: panelCollapsed ? '49px' : '45%', borderLeft: 0, borderTop: '1px solid', borderTopColor: 'border.default', overflow: 'hidden' },
      }}>
        <PanelShell mode={panelMode} hint={far.active ? far.hint : FAR_HINT[panelMode] ?? ''}
          actions={<>{headActions}{panelToggle}</>} footer={footer}>
          {side}
        </PanelShell>
      </Box>
    </Box>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
