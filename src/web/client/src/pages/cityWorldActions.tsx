import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, IconButton, Octicon, Text, TextInput } from '@primer/react';
import { ArrowBothIcon, CheckIcon, IterationsIcon, PlusIcon, StarIcon, TrashIcon, XIcon, ZapIcon } from '@primer/octicons-react';
import { api, type BuildingDef, type CityActiveBooster, type CityBoosterRow, type CityWorldRow, type MapBuilding, type MapSection } from '../api';
import type { WorldCell } from '../components/WorldMapCanvas';
import { CoinValue } from '../components/Icons';
import { computeCityStats } from '../cityStats';
import { fmt, ITEMS_BY_ID } from '../utils';
import { catalogItemImg } from '../hooks/useItemCatalog';
import { buildingCat, buildingName, buildPriceAt, computePolicyMultiplier } from './CityMapCity';
import {
  Row, Val, Caption, Empty, Thumb, BadgeThumb, BuildItem, Summary, Tile, SumLine, PlanBar, ItemCard, FooterButton, CancelButton, fillOf, fmtUp,
  FILL_WIP, type PanelMode,
} from './cityMapPanels';
import cityCoordsData from '../data/city-coords.json';

// Действия прямо на общей карте всех городов (pages/CityWorld.tsx): строительство, перемещение,
// снос, реконструкция, реновация и ускорители сразу в нескольких городах. Клик по клетке любого
// города добавляет действие в общий список, кнопка внизу выполняет его по одному запросу в секунду
// теми же ручками, что и карта города. Стройка в городе, которому не хватает монет, не теряется:
// всё, что не влезает в баланс, уходит в отложенную стройку, и бот строит сам, когда монет хватит.

const COORDS = cityCoordsData as { x: number; y: number }[];
const VALID = new Set(COORDS.map(c => `${c.x}_${c.y}`));
const familyId = (id: string) => id.replace(/_\d+_star\.png$/i, '.png');
const isBuilding = (b: { end?: string | null }) => !!b.end && new Date(b.end).getTime() > Date.now();
const ACTION_MODES = new Set<PanelMode>(['build', 'move', 'demolish', 'reconstruct', 'renovate', 'boosters']);

type Kind = 'build' | 'move' | 'demolish' | 'reconstruct' | 'renovate';
interface FarAction { id: number; account: string; kind: Kind; x: number; y: number; family_id?: string; to?: { x: number; y: number } }

const RUN_LABEL: Record<Kind, [string, 'primary' | 'danger' | 'accent']> = {
  build: ['Построить', 'primary'], move: ['Переместить', 'accent'], demolish: ['Снести', 'danger'],
  reconstruct: ['Реконструировать', 'primary'], renovate: ['Реновировать', 'primary'],
};
const KIND_ICON: Record<Kind, React.ElementType> = { build: PlusIcon, move: ArrowBothIcon, demolish: TrashIcon, reconstruct: IterationsIcon, renovate: StarIcon };
const KIND_BADGE: Record<Kind, string> = { build: 'accent.emphasis', move: 'accent.emphasis', demolish: 'danger.emphasis', reconstruct: 'done.emphasis', renovate: 'done.emphasis' };
const HINT: Partial<Record<PanelMode, string>> = {
  build: 'Выберите здание в списке и кликайте пустые клетки в любых городах. Если городу не хватает монет, стройка ждёт: бот построит сам, когда монет хватит.',
  move: 'Кликните здание в любом городе, затем пустую клетку в том же городе. Другие города на это время приглушены.',
  demolish: 'Кликайте здания в любых городах. Монеты за снос не возвращаются.',
  reconstruct: 'Подсвечены здания, готовые к реконструкции во всех городах, остальные серые. Клик отмечает, кнопка внизу выполняет.',
  renovate: 'Подсвечены здания, готовые к реновации во всех городах, остальные серые. Клик отмечает, кнопка внизу выполняет.',
  boosters: 'Выберите ускоритель в списке и кликайте города: он встанет в конец их очереди активации. «Применить» сохраняет очереди.',
};

export interface FarActionsCtx {
  mode: PanelMode;
  cities: CityWorldRow[];
  catalog: BuildingDef[];
  catMap: Map<string, BuildingDef>;
  sections: MapSection[];
  labelFor: (id: string) => string;
  showFlash: (msg: string, ok: boolean) => void;
  reload: () => void;
}

export function useFarActions({ mode, cities, catalog, catMap, sections, labelFor, showFlash, reload }: FarActionsCtx) {
  const active = ACTION_MODES.has(mode);
  const [pending, setPending] = useState<FarAction[]>([]);
  const nextId = useRef(1);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [buildFamily, setBuildFamily] = useState('');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('COM');
  const [moveFrom, setMoveFrom] = useState<{ account: string; x: number; y: number } | null>(null);
  useEffect(() => { setMoveFrom(null); }, [mode]);

  const byName = useMemo(() => new Map(cities.map(c => [c.account, c])), [cities]);
  const lockedOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of cities) {
      const s = new Set<string>();
      if (r.unlockedSections) { const u = new Set(r.unlockedSections); for (const sec of sections) if (!u.has(sec.id)) for (const c of sec.coordinates) s.add(`${c.x}_${c.y}`); }
      m.set(r.account, s);
    }
    return m;
  }, [cities, sections]);
  const at = (r: CityWorldRow, x: number, y: number) => r.buildings.find(b => b.x === x && b.y === y);
  const pendingAt = (account: string, x: number, y: number) => pending.find(a => a.account === account && ((a.x === x && a.y === y) || (a.to && a.to.x === x && a.to.y === y)));

  // ── цена постройки: формула игры · скидка политик (из БД) · скидка гильдии (живой запрос, только
  // для городов, где что-то ставят) ──────────────────────────────────────────────────────────────
  const [policyMult, setPolicyMult] = useState<Record<string, number>>({});
  const [guildMult, setGuildMult] = useState<Record<string, number>>({});
  const guildAsked = useRef(new Set<string>());
  useEffect(() => {
    if (mode !== 'build' || Object.keys(policyMult).length) return;
    api.policies().then(d => {
      if (!d.ok) return;
      setPolicyMult(Object.fromEntries(Object.entries(d.byAccount).map(([a, v]) => [a, computePolicyMultiplier(v.cabinet, 'build_cost')])));
    }).catch(() => {});
  }, [mode]);
  const askGuild = (account: string) => {
    if (guildAsked.current.has(account)) return;
    guildAsked.current.add(account);
    api.cityGuildBenefits(account).then(d => { if (d.ok) setGuildMult(p => ({ ...p, [account]: 1 - d.building_purchases_discount })); }).catch(() => {});
  };
  const mult = (account: string) => (policyMult[account] ?? 1) * (guildMult[account] ?? 1);
  const famCount = (r: CityWorldRow, fam: string) => r.buildings.filter(b => familyId(b.id) === fam).length;
  // цены построек города по порядку постановки: каждая следующая того же семейства дороже
  const buildPrices = (account: string) => {
    const r = byName.get(account);
    const out = new Map<number, number>();
    if (!r) return out;
    const extra = new Map<string, number>();
    for (const a of pending) {
      if (a.account !== account || a.kind !== 'build' || !a.family_id) continue;
      const info = catMap.get(a.family_id), fam = familyId(a.family_id), k = famCount(r, fam) + (extra.get(fam) ?? 0);
      extra.set(fam, (extra.get(fam) ?? 0) + 1);
      out.set(a.id, info ? buildPriceAt(info, k, mult(account)) : 0);
    }
    return out;
  };

  // ── кандидаты реконструкции/реновации ───────────────────────────────────────
  const reconReady = (b: MapBuilding) => { const i = catMap.get(b.id); return !!i?.is_reconstructible && i.required_lvl != null && !isBuilding(b) && (Number(b.level) || 0) >= i.required_lvl; };
  const renovReady = (b: MapBuilding) => { const i = catMap.get(b.id); return !!i?.is_renovatable && !!i.next_id && i.required_lvl != null && !isBuilding(b) && (Number(b.level) || 0) >= i.required_lvl; };
  const [resources, setResources] = useState<Record<string, { components: number; masterplans: number }>>({});
  useEffect(() => {
    if (mode !== 'reconstruct' && mode !== 'renovate') return;
    const ready = mode === 'reconstruct' ? reconReady : renovReady;
    for (const r of cities) {
      if (resources[r.account] || !r.buildings.some(ready)) continue;
      api.cityResources(r.account).then(d => { if (d.ok) setResources(p => ({ ...p, [r.account]: { components: d.components, masterplans: d.masterplans } })); }).catch(() => {});
    }
  }, [mode, cities.length > 0]);

  // ── ускорители: склад и очереди всех городов из БД, правки — черновиком до «Применить» ─────
  const [boosters, setBoosters] = useState<Record<string, { stock: CityBoosterRow[]; active: CityActiveBooster[]; queue: string[] }>>({});
  const [boostersLoading, setBoostersLoading] = useState(false);
  const [boosterPick, setBoosterPick] = useState('');
  const [boosterAdd, setBoosterAdd] = useState<{ id: number; account: string; name: string }[]>([]);
  const loadBoosters = async () => {
    setBoostersLoading(true);
    const out: typeof boosters = {};
    const names = cities.map(c => c.account);
    let i = 0;
    const worker = async () => {
      while (i < names.length) {
        const a = names[i++];
        const d = await api.cityBoosters(a).catch(() => null);
        if (d?.ok) out[a] = { stock: d.boosters, active: d.active ?? [], queue: (d.queue ?? []).map(q => q.name) };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBoosters(out);
    setBoostersLoading(false);
  };
  useEffect(() => { if (mode === 'boosters' && cities.length) loadBoosters(); }, [mode, cities.length > 0]);
  const boosterLabel = (name: string) => {
    for (const v of Object.values(boosters)) { const b = v.stock.find(s => s.name === name) ?? v.active.find(s => s.name === name); if (b) return b.label; }
    return `Ускоритель #${name}`;
  };
  const boosterCard = (name: string, count?: number, dim?: boolean) => {
    const tag = ITEMS_BY_ID[Number(name)]?.tag?.replace(/_booster$/, '') ?? 'common';
    return <ItemCard tag={tag} src={catalogItemImg(Number(name))} count={count} dim={dim} />;
  };
  const freeStock = (account: string, name: string) => {
    const v = boosters[account];
    const have = v?.stock.find(s => s.name === name)?.available ?? 0;
    const used = (v?.queue.filter(q => q === name).length ?? 0) + boosterAdd.filter(b => b.account === account && b.name === name).length;
    return have - used;
  };

  // ── клик по клетке ────────────────────────────────────────────────────────────
  const onCell = (account: string, x: number, y: number) => {
    if (executing) return;
    const r = byName.get(account);
    if (!r) return;
    const key = `${x}_${y}`, b = at(r, x, y), p = pendingAt(account, x, y);
    const add = (a: Omit<FarAction, 'id'>) => setPending(prev => [...prev, { ...a, id: nextId.current++ }]);
    const drop = (id: number) => setPending(prev => prev.filter(a => a.id !== id));
    if (mode === 'build') {
      if (p) { if (p.kind === 'build') drop(p.id); return; }
      if (!buildFamily) { showFlash('Сначала выберите здание в списке', false); return; }
      if (b || !VALID.has(key) || lockedOf.get(account)?.has(key)) return;
      const info = catMap.get(buildFamily);
      const queued = pending.filter(a => a.account === account && a.kind === 'build' && a.family_id && familyId(a.family_id) === familyId(buildFamily)).length;
      if (info?.limit != null && famCount(r, familyId(buildFamily)) + queued >= info.limit) { showFlash(`${labelFor(buildFamily)}: в ${account} уже построено по лимиту`, false); return; }
      askGuild(account);
      add({ account, kind: 'build', x, y, family_id: buildFamily });
    } else if (mode === 'move') {
      if (!moveFrom) {
        if (p) { drop(p.id); return; }
        if (b) setMoveFrom({ account, x, y });
        return;
      }
      if (moveFrom.account !== account) return;
      if (moveFrom.x === x && moveFrom.y === y) { setMoveFrom(null); return; }
      if (b || p || !VALID.has(key) || lockedOf.get(account)?.has(key)) return;
      add({ account, kind: 'move', x: moveFrom.x, y: moveFrom.y, to: { x, y } });
      setMoveFrom(null);
    } else if (mode === 'demolish' || mode === 'reconstruct' || mode === 'renovate') {
      if (p) { if (p.kind === mode) drop(p.id); return; }
      if (!b) return;
      if (mode === 'reconstruct' && !reconReady(b)) return;
      if (mode === 'renovate' && !renovReady(b)) return;
      add({ account, kind: mode, x, y });
    } else if (mode === 'boosters') {
      if (!boosterPick) { showFlash('Сначала выберите ускоритель в списке', false); return; }
      if (freeStock(account, boosterPick) <= 0) { showFlash(`В ${account} нет свободного «${boosterLabel(boosterPick)}»`, false); return; }
      setBoosterAdd(prev => [...prev, { id: nextId.current++, account, name: boosterPick }]);
    }
  };

  // ── выполнение: по одному запросу в секунду, стройка сверх баланса — в отложенную ────────────
  const runAll = async () => {
    if (!pending.length || executing) return;
    setExecuting(true);
    const list = [...pending];
    // что строить сейчас, а что отложить: по порядку постановки, пока хватает баланса города
    const defer = new Map<string, { x: number; y: number; family_id: string }[]>();
    const now = new Set<number>();
    for (const account of new Set(list.filter(a => a.kind === 'build').map(a => a.account))) {
      const prices = buildPrices(account), bal = byName.get(account)?.balance ?? 0;
      let sum = 0;
      for (const a of list) {
        if (a.account !== account || a.kind !== 'build') continue;
        sum += prices.get(a.id) ?? 0;
        if (sum <= bal) now.add(a.id);
        else (defer.get(account) ?? defer.set(account, []).get(account)!).push({ x: a.x, y: a.y, family_id: a.family_id! });
      }
    }
    const run = list.filter(a => a.kind !== 'build' || now.has(a.id));
    setProgress({ done: 0, total: run.length + defer.size });
    let ok = 0, fail = 0, deferred = 0, step = 0;
    const errors: string[] = [];
    for (const a of run) {
      try {
        const r = a.kind === 'build' ? await api.cityActionBuild(a.account, a.family_id!, a.x, a.y)
          : a.kind === 'move' ? await api.cityActionMove(a.account, { x: a.x, y: a.y }, a.to!)
            : a.kind === 'demolish' ? await api.cityActionDemolish(a.account, a.x, a.y)
              : a.kind === 'reconstruct' ? await api.cityActionReconstruct(a.account, a.x, a.y)
                : await api.cityActionRenovate(a.account, a.x, a.y);
        if (r.ok) ok++; else { fail++; if (r.error) errors.push(`${a.account}: ${r.error}`); }
      } catch (e) { fail++; errors.push(`${a.account}: ${String(e)}`); }
      setProgress({ done: ++step, total: run.length + defer.size });
      await new Promise(res => setTimeout(res, 1000));
    }
    for (const [account, add] of defer) {
      const r = await api.saveBuildPlan(account, { add }).catch(() => ({ ok: false, error: 'нет связи' }));
      if (r.ok) deferred += add.length; else { fail += add.length; errors.push(`${account}: ${r.error ?? 'Ошибка'}`); }
      setProgress({ done: ++step, total: run.length + defer.size });
    }
    setPending([]);
    setExecuting(false);
    setProgress(null);
    showFlash(`Выполнено: ${ok}${deferred ? `, ждут монет: ${deferred}` : ''}${fail ? `, ошибок: ${fail}${errors[0] ? ` (${errors[0]})` : ''}` : ''}`, fail === 0);
    reload();
  };

  const [boosterSaving, setBoosterSaving] = useState(false);
  const applyBoosters = async () => {
    setBoosterSaving(true);
    let fail = '';
    for (const account of new Set(boosterAdd.map(b => b.account))) {
      const order = [...(boosters[account]?.queue ?? []), ...boosterAdd.filter(b => b.account === account).map(b => b.name)];
      const r = await api.saveBoosterQueue(account, order);
      if (!r.ok) fail = `${account}: ${r.error ?? 'Ошибка'}`;
    }
    setBoosterSaving(false);
    setBoosterAdd([]);
    showFlash(fail || 'Очереди ускорителей сохранены', !fail);
    loadBoosters();
  };

  const removeDeferred = async (account: string, x: number, y: number) => {
    const r = await api.saveBuildPlan(account, { remove: [{ x, y }] });
    if (!r.ok) showFlash(r.error ?? 'Ошибка', false);
    reload();
  };

  // ── заливки карты ───────────────────────────────────────────────────────────
  const { cells, dim } = useMemo(() => {
    const cells: WorldCell[] = [];
    let dim: Set<string> | null = null;
    if (!active) return { cells, dim };
    const mark = (a: FarAction) => {
      const color = a.kind === 'demolish' ? ['rgba(255,129,130,.75)', '#cf222e'] : a.kind === 'build' ? ['rgba(84,174,255,.8)', '#0969da'] : a.kind === 'move' ? ['rgba(84,174,255,.8)', '#0969da'] : ['rgba(171,125,248,.8)', '#8250df'];
      cells.push({ account: a.account, x: a.x, y: a.y, fill: color[0], stroke: color[1] });
      if (a.to) cells.push({ account: a.account, x: a.to.x, y: a.to.y, fill: color[0], stroke: color[1] });
    };
    if (mode === 'build') {
      for (const r of cities) {
        const prices = buildPrices(r.account);
        const short = [...prices.values()].reduce((s, v) => s + v, 0) > r.balance;
        const busy = new Set(r.buildings.map(b => `${b.x}_${b.y}`)), locked = lockedOf.get(r.account);
        for (const c of COORDS) {
          const k = `${c.x}_${c.y}`;
          if (busy.has(k) || locked?.has(k)) continue;
          cells.push({ account: r.account, x: c.x, y: c.y, fill: short ? 'rgba(212,167,44,.45)' : 'rgba(74,194,107,.4)', stroke: short ? '#9a6700' : '#1a7f37' });
        }
        for (const p of r.buildPlan ?? []) cells.push({ account: r.account, x: p.x, y: p.y, fill: 'rgba(212,167,44,.8)', stroke: '#9a6700' });
      }
    } else if (mode === 'move' && moveFrom) {
      dim = new Set([moveFrom.account]);
      const r = byName.get(moveFrom.account);
      if (r) {
        const busy = new Set(r.buildings.map(b => `${b.x}_${b.y}`)), locked = lockedOf.get(r.account);
        for (const c of COORDS) { const k = `${c.x}_${c.y}`; if (!busy.has(k) && !locked?.has(k)) cells.push({ account: r.account, x: c.x, y: c.y, fill: 'rgba(84,174,255,.25)', stroke: '#54aeff' }); }
      }
      cells.push({ account: moveFrom.account, x: moveFrom.x, y: moveFrom.y, fill: 'rgba(84,174,255,.8)', stroke: '#0969da' });
    } else if (mode === 'reconstruct' || mode === 'renovate') {
      const ready = mode === 'reconstruct' ? reconReady : renovReady;
      for (const r of cities) for (const b of r.buildings) {
        cells.push(ready(b)
          ? { account: r.account, x: b.x, y: b.y, fill: mode === 'reconstruct' ? 'rgba(74,194,107,.5)' : 'rgba(171,125,248,.45)', stroke: mode === 'reconstruct' ? '#1a7f37' : '#8250df' }
          : { account: r.account, x: b.x, y: b.y, fill: 'rgba(110,119,129,.55)' });
      }
    } else if (mode === 'boosters') {
      dim = new Set(cities.filter(r => boosterPick ? freeStock(r.account, boosterPick) > 0 : (boosters[r.account]?.stock.some(s => s.available > 0))).map(r => r.account));
    }
    if (mode !== 'boosters') for (const a of pending) mark(a);
    return { cells, dim };
  }, [active, mode, cities, pending, moveFrom, lockedOf, catMap, policyMult, guildMult, boosters, boosterPick, boosterAdd]);

  if (!active) return { active, cells, dim, onCell: undefined, side: null as ReactNode, footer: undefined as ReactNode, hint: '', dots: {} as Partial<Record<PanelMode, boolean>> };

  // ── сайдбар ─────────────────────────────────────────────────────────────────
  const kinds = new Set(pending.map(a => a.kind));
  const dots: Partial<Record<PanelMode, boolean>> = { build: kinds.has('build'), move: kinds.has('move'), demolish: kinds.has('demolish'), reconstruct: kinds.has('reconstruct'), renovate: kinds.has('renovate'), boosters: boosterAdd.length > 0 };
  const groupsOf = (kind: Kind) => {
    const m = new Map<string, FarAction[]>();
    for (const a of pending) if (a.kind === kind) (m.get(a.account) ?? m.set(a.account, []).get(a.account)!).push(a);
    return [...m];
  };
  const removeBtn = (id: number) => <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={executing} onClick={() => setPending(prev => prev.filter(a => a.id !== id))} />;
  const actionRow = (a: FarAction, sprite: string | undefined, sub: string, trail?: ReactNode, fill?: string) => (
    <Row key={a.id} lead={sprite ? <BadgeThumb id={sprite} badge={<Octicon icon={KIND_ICON[a.kind]} size={10} />} badgeBg={KIND_BADGE[a.kind]} corner="br" dim={a.kind === 'demolish'} /> : <Box sx={{ width: 36 }} />}
      title={sprite ? labelFor(sprite) : RUN_LABEL[a.kind][0]} sub={sub} fill={fill}
      trail={<>{trail}{removeBtn(a.id)}</>} />
  );
  const spriteAt = (a: FarAction) => { const r = byName.get(a.account); return r ? at(r, a.x, a.y)?.id : undefined; };
  // остальные отмеченные действия (с других вкладок) — одной группой внизу, их выполнит та же кнопка
  const others = (kind: Kind) => {
    const rest = pending.filter(a => a.kind !== kind);
    if (!rest.length) return null;
    return <>
      <Caption right={rest.length}>Ждут выполнения</Caption>
      {rest.map(a => actionRow(a, a.kind === 'build' ? a.family_id : spriteAt(a), `${a.account} · ${RUN_LABEL[a.kind][0].toLowerCase()} · ${a.x},${a.y}${a.to ? ` → ${a.to.x},${a.to.y}` : ''}`))}
    </>;
  };

  let side: ReactNode = null;
  if (mode === 'build') {
    const purchasable = catalog.filter(b => b.is_purchasable && !/_\d+_star\.png$/i.test(b.id));
    const cats = [...new Set(purchasable.map(b => buildingCat(b.id)))].filter(Boolean).sort((a, b) => (['COM', 'RES'].indexOf(a) + 1 || 99) - (['COM', 'RES'].indexOf(b) + 1 || 99));
    const cat = cats.includes(catFilter) ? catFilter : cats[0];
    const q = search.toLowerCase();
    const list = purchasable.filter(b => buildingCat(b.id) === cat && (!q || buildingName(b).toLowerCase().includes(q) || b.id.toLowerCase().includes(q))).sort((a, b) =>
      cat === 'COM' ? (b.base_profit ?? 0) - (a.base_profit ?? 0) : cat === 'RES' ? (b.base_population ?? 0) - (a.base_population ?? 0) : cat === 'SER' ? (b.service_coverage ?? 0) - (a.service_coverage ?? 0) : buildingName(a).localeCompare(buildingName(b), 'ru'));
    const deferred = cities.filter(r => (r.buildPlan ?? []).length > 0);
    side = <>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextInput placeholder="Поиск" value={search} onChange={e => setSearch(e.target.value)} block />
        <div id="map-cat-tabs">
          {cats.map(c => <span key={c} className={'map-cat-tab' + (cat === c ? ' active' : '')} onClick={() => setCatFilter(c)}>{c}</span>)}
        </div>
        {list.map(b => {
          const fam = familyId(b.id);
          const have = cities.filter(r => famCount(r, fam) > 0).length;
          const full = b.limit != null && cities.every(r => famCount(r, fam) >= b.limit!);
          const min = cities.length ? Math.min(...cities.filter(r => b.limit == null || famCount(r, fam) < b.limit).map(r => buildPriceAt(b, famCount(r, fam), mult(r.account)))) : 0;
          return <BuildItem key={b.id} id={b.id} name={buildingName(b)} active={buildFamily === b.id} unavailable={full} onClick={() => setBuildFamily(b.id)}
            sub={full ? 'построено везде' : `есть в ${have} гор.`}
            trail={full || !isFinite(min) ? undefined : <Val><CoinValue value={`от ${fmtUp(min)}`} /></Val>} />;
        })}
      </Box>
      {groupsOf('build').map(([account, acts]) => {
        const r = byName.get(account), prices = buildPrices(account);
        const sum = acts.reduce((s, a) => s + (prices.get(a.id) ?? 0), 0), bal = r?.balance ?? 0;
        let run = 0;
        return (
          <Box key={account} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Caption right={sum > bal ? <Text sx={{ color: 'attention.fg' }}>ждёт {fmt(sum - bal)}</Text> : `${fmt(sum)} из ${fmt(bal)}`}>{account}</Caption>
            {acts.map(a => { run += prices.get(a.id) ?? 0; return actionRow(a, a.family_id, `${a.x},${a.y}${run > bal ? ' · когда накопит' : ''}`, <Val color={run > bal ? 'attention.fg' : 'fg.default'}><CoinValue value={fmtUp(prices.get(a.id) ?? 0)} /></Val>); })}
          </Box>
        );
      })}
      {deferred.length > 0 && <>
        <Caption right={deferred.reduce((s, r) => s + r.buildPlan.length, 0)}>Ждут монет</Caption>
        {deferred.flatMap(r => r.buildPlan.map(p => (
          <Row key={`${r.account}:${p.x},${p.y}`} lead={<Thumb id={p.family_id} size={36} bg="canvas.default" />} title={labelFor(p.family_id)}
            sub={`${r.account} · ${p.x},${p.y}`} fill={fillOf([['rgba(212,167,44,.4)', 100]])}
            trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Снять" onClick={() => removeDeferred(r.account, p.x, p.y)} />} />
        )))}
      </>}
      {others('build')}
    </>;
  } else if (mode === 'move') {
    const fromCity = moveFrom ? byName.get(moveFrom.account) : undefined;
    const fromB = moveFrom && fromCity ? at(fromCity, moveFrom.x, moveFrom.y) : undefined;
    side = <>
      {moveFrom && (
        <Row lead={fromB ? <Thumb id={fromB.id} size={36} bg="canvas.default" /> : <Box sx={{ width: 36 }} />} title={fromB ? labelFor(fromB.id) : '—'}
          sub={`${moveFrom.account} · откуда ${moveFrom.x},${moveFrom.y}`} fill={fillOf([[FILL_WIP, 100]])}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Отменить выбор" onClick={() => setMoveFrom(null)} />} />
      )}
      {groupsOf('move').map(([account, acts]) => (
        <Box key={account} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caption right={acts.length}>{account}</Caption>
          {acts.map(a => actionRow(a, spriteAt(a), `${a.x},${a.y} → ${a.to!.x},${a.to!.y}`))}
        </Box>
      ))}
      {!moveFrom && !kinds.has('move') && <Empty>Кликните здание в любом городе</Empty>}
      {others('move')}
    </>;
  } else if (mode === 'demolish') {
    // потеря дохода: доля по формулам игры от фактического дохода города
    const groups = groupsOf('demolish').map(([account, acts]) => {
      const r = byName.get(account)!;
      const gone = new Set(acts.map(a => `${a.x}_${a.y}`));
      const all = computeCityStats(r.buildings, catMap as never).profitFinal;
      const left = computeCityStats(r.buildings.filter(b => !gone.has(`${b.x}_${b.y}`)), catMap as never).profitFinal;
      const loss = all > 0 ? Math.max(0, r.profit * (1 - left / all)) : 0;
      return { account, acts, loss };
    });
    const total = groups.reduce((s, g) => s + g.loss, 0), n = groups.reduce((s, g) => s + g.acts.length, 0);
    side = <>
      {n > 0 ? (
        <Summary tone="danger">
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile size={2} value={n} label={`зданий, ${groups.length} гор.`} />
            <Tile size={2} value={total > 0 ? `−${fmt(total)}` : '0'} label="дохода в час" color="danger.fg" />
          </Box>
        </Summary>
      ) : <Empty>Кликайте здания в любых городах</Empty>}
      {groups.map(g => (
        <Box key={g.account} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caption right={g.loss > 0 ? `−${fmt(g.loss)}/ч` : '0/ч'}>{g.account}</Caption>
          {g.acts.map(a => { const b = at(byName.get(a.account)!, a.x, a.y); return actionRow(a, b?.id, `ур. ${Number(b?.level) || 0} · ${a.x},${a.y}`); })}
        </Box>
      ))}
      {others('demolish')}
    </>;
  } else if (mode === 'reconstruct' || mode === 'renovate') {
    const ready = mode === 'reconstruct' ? reconReady : renovReady;
    const eligible = cities.map(r => ({ r, n: r.buildings.filter(ready).length })).filter(v => v.n > 0);
    const totalReady = eligible.reduce((s, v) => s + v.n, 0);
    const tag = mode === 'reconstruct' ? 'component' : 'masterplan';
    const cost = (id: string) => { const i = catMap.get(id); return mode === 'reconstruct' ? i?.components_required ?? null : i?.masterplans_num ?? null; };
    const marked = groupsOf(mode);
    side = <>
      {totalReady === 0 ? <Empty>Готовых зданий нет ни в одном городе</Empty> : (
        <Summary>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile size={2} value={totalReady} label={`готовы, ${eligible.length} гор.`} color="success.fg" />
            <Tile size={2} value={pending.filter(a => a.kind === mode).length} label="отмечено" />
          </Box>
          <PlanBar done={pending.filter(a => a.kind === mode).length} wip={0} span={totalReady} size="large" bg="canvas.default" />
        </Summary>
      )}
      {marked.map(([account, acts]) => {
        let left = resources[account]?.[mode === 'reconstruct' ? 'components' : 'masterplans'];
        return (
          <Box key={account} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Caption right={left}>{account}</Caption>
            {acts.map(a => {
              const b = at(byName.get(account)!, a.x, a.y), c = b ? cost(b.id) : null;
              const short = left != null && c != null && (left -= c) < 0;
              const shown = mode === 'renovate' && b ? catMap.get(b.id)?.next_id ?? b.id : b?.id;
              return actionRow(a, shown, `${mode === 'reconstruct' ? `ур. ${Number(b?.level) || 0}` : 'реновация'} · ${a.x},${a.y}`, c != null ? <ItemCard tag={tag} count={c} short={short} /> : undefined, fillOf([['rgba(171,125,248,.35)', 100]]));
            })}
          </Box>
        );
      })}
      {others(mode)}
    </>;
  } else if (mode === 'boosters') {
    // склад всех городов по типам; выбранный тип кликами по городам встаёт в их очереди
    const types = new Map<string, { label: string; total: number; cities: number }>();
    for (const v of Object.values(boosters)) for (const s of v.stock) {
      if (s.available <= 0) continue;
      const t = types.get(s.name) ?? { label: s.label, total: 0, cities: 0 };
      t.total += s.available; t.cities++;
      types.set(s.name, t);
    }
    const activeRows = Object.entries(boosters).flatMap(([account, v]) => v.active.map(b => ({ account, b })));
    side = boostersLoading && !Object.keys(boosters).length ? <Empty>Загружаю ускорители…</Empty> : <>
      <Caption>На складе, все города</Caption>
      {types.size === 0 ? <Empty>Ускорителей на складах нет</Empty> : [...types].map(([name, t]) => (
        <Row key={name} lead={boosterCard(name, t.total)} title={t.label} sub={`в ${t.cities} гор.`} onClick={() => setBoosterPick(name)}
          fill={boosterPick === name ? fillOf([[FILL_WIP, 100]]) : undefined} />
      ))}
      {boosterAdd.length > 0 && <>
        <Caption right={boosterAdd.length}>Ждут применения</Caption>
        {boosterAdd.map(b => (
          <Row key={b.id} lead={boosterCard(b.name)} title={b.account} sub={boosterLabel(b.name)}
            trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" onClick={() => setBoosterAdd(prev => prev.filter(x => x.id !== b.id))} />} />
        ))}
      </>}
      {activeRows.length > 0 && <>
        <Caption right={activeRows.length}>Активны</Caption>
        {activeRows.map(({ account, b }) => (
          <Row key={`${account}:${b.name}`} lead={boosterCard(b.name)} title={account} sub={b.label} bg="attention.subtle"
            trail={<Val color="fg.muted">до {new Date(b.ends_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</Val>} />
        ))}
      </>}
    </>;
  }

  let footer: ReactNode = undefined;
  if (mode === 'boosters') {
    if (boosterAdd.length) footer = <>
      <FooterButton label="Применить" icon={ZapIcon} count={boosterAdd.length} busy={boosterSaving} onClick={applyBoosters} />
      <CancelButton disabled={boosterSaving} onClick={() => setBoosterAdd([])} />
    </>;
  } else if (pending.length) {
    const own = RUN_LABEL[mode as Kind];
    const [label, tone] = own && pending.every(a => a.kind === mode) ? own : ['Выполнить', 'primary' as const];
    footer = <>
      <FooterButton label={executing && progress ? `Выполняется ${progress.done} из ${progress.total}` : label} tone={tone} icon={CheckIcon} count={pending.length} busy={executing} onClick={runAll} />
      <CancelButton disabled={executing} onClick={() => { setPending([]); setMoveFrom(null); }} />
    </>;
  }

  return { active, cells, dim, onCell, side, footer, hint: HINT[mode] ?? '', dots };
}
