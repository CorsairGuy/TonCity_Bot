import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Box, Button, Flash, Heading, IconButton, Label, Select, Text, TextInput, ActionMenu, ActionList, UnderlineNav } from '@primer/react';
import { SyncIcon, XIcon, PlusIcon, LockIcon, UnlockIcon, ClockIcon, PeopleIcon, StopIcon, TriangleUpIcon } from '@primer/octicons-react';
import {
  api, type TechFactoryOverview, type TechFactoryCategory, type TechFactoryMachine, type TechFactoryTier,
  type TechFactorySummaryRow, type LocText,
} from '../api';
import { ITEMS_BY_ID, fmt, fmtInt } from '../utils';
import { RenownValue } from '../components/Icons';
import { LoadError } from '../components/LoadError';
import { SidePage, CatTabs, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row, Summary, Tile, SumLine, Val, ItemCard, Empty, fillOf, FILL_DONE, SWAP } from './cityMapPanels';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

// Технологическая фабрика: справа аккаунты, слева очередь и витрина станков выбранного аккаунта.
// У аккаунта одна переработка за раз на всю фабрику (overview отдаёт один job), остальное — в общей
// очереди, её разбирает бот (modules/guildBuildings.js runTechFactoryLoop), он же забирает готовое.
// Страница читает снимки из БД, игру спрашивает только «Обновить с игры» и действия.

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const loc = (v: LocText | undefined): string => !v ? '' : typeof v === 'string' ? v : (v.ru || v.en || '');
const tagOf = (id: number) => ITEMS_BY_ID[id]?.tag ?? '';
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const dur = (sec: number) => sec >= 3600 ? `${+(sec / 3600).toFixed(1)} ч` : `${Math.round(sec / 60)} мин`;
const left = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'готово';
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return h ? `${h}ч ${m}м` : `${m}м`;
};
const pctOf = (job: { started_at: string; finishes_at: string; ready?: boolean }) => {
  if (job.ready) return 100;
  const s = new Date(job.started_at).getTime(), f = new Date(job.finishes_at).getTime();
  return f > s ? Math.max(0, Math.min(100, (Date.now() - s) / (f - s) * 100)) : 0;
};
const limitText = (t: TechFactoryTier) => !t.limit ? 'без лимита'
  : `${t.limit.used}/${t.limit.count} ${t.limit.window === 'week' ? 'в неделю' : t.limit.window === 'day' ? 'в день' : t.limit.window ?? ''}`;

function Item({ id, q, short }: { id: number; q?: number | string; short?: boolean }) {
  const catalog = useItemCatalog(ITEMS_BY_ID[id] ? undefined : [id]);
  const tag = tagOf(id) || catalog.get(id)?.tag || '';
  return <Box title={itemName(id, catalog)} sx={{ flexShrink: 0 }}><ItemCard tag={tag} count={q} short={short} src={tag ? undefined : null} /></Box>;
}
function QueueNum({ n }: { n: number }) {
  return <Box sx={{ position: 'absolute', top: '-4px', left: '-4px', minWidth: 18, height: 18, px: '4px', borderRadius: '9px', bg: 'neutral.emphasis', color: 'fg.onEmphasis', border: '2px solid', borderColor: 'canvas.subtle', fontSize: '10px', fontWeight: 'bold', display: 'grid', placeItems: 'center' }}>{n}</Box>;
}

// ── очередь: список шагов, первая строка — текущая переработка ──────────────────
function QueueList({ data, accountId, onChanged, onFlash }: { data: TechFactoryOverview; accountId: number; onChanged: () => void; onFlash: (m: string, ok: boolean) => void }) {
  const machines = useMemo(() => new Map(data.categories.flatMap(c => c.machines ?? []).map(m => [m.id, m])), [data.categories]);
  const [order, setOrder] = useState(data.queue);
  useEffect(() => setOrder(data.queue), [data.queue]);
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const job = data.job;
  const jobMachine = job ? machines.get(job.machine_id) : null;
  // расчёт времени шагов: от конца текущей переработки (или от сейчас), по длительности тира
  let t = job && !job.ready ? new Date(job.finishes_at).getTime() : Date.now();
  const steps = order.map(q => {
    const m = machines.get(q.machine_id), tier = m?.tiers.find(x => x.level === q.level);
    const st = t; t += (tier?.duration_seconds ?? 0) * 1000;
    return { q, m, tier, st, en: t };
  });
  const drop = async (e: DragEvent, to: number) => {
    e.preventDefault(); setOver(null);
    const from = drag.current; drag.current = null;
    if (from == null || from === to) return;
    const next = [...order]; const [x] = next.splice(from, 1); next.splice(to, 0, x);
    setOrder(next);
    const r = await api.techFactoryQueueReorder(accountId, next.map(q => q.id));
    if (!r.ok) { onFlash(r.error ?? 'Не удалось изменить порядок', false); onChanged(); }
  };
  const remove = async (id: number) => {
    const r = await api.techFactoryQueueRemove(accountId, id);
    if (r.ok) onChanged(); else onFlash(r.error ?? 'Ошибка', false);
  };
  return (
    <Box sx={{ mb: 3, p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'semibold', flex: 1 }}>Очередь</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {order.length ? <>{order.length} в очереди · всё готово к <strong>{hhmm(t)}</strong> · </> : null}бот запускает и забирает готовое сам
        </Text>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 2 }}>
        {job
          ? <Row fill={fillOf([[FILL_DONE, pctOf(job)]])} lead={<Item id={job.output.item_id} q={job.output.quantity} />}
              title={`${jobMachine ? loc(jobMachine.name) : job.machine_id} ${ROMAN[job.level - 1] ?? job.level}`}
              sub={<Text sx={{ color: 'success.fg' }}>{job.ready ? 'готово · бот заберёт сам' : `сейчас · ${Math.round(pctOf(job))}% · осталось ${left(job.finishes_at)}`}</Text>} />
          : <Row lead={<Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', color: 'attention.fg' }}><StopIcon size={16} /></Box>}
              title="Станок простаивает" sub={order.length ? 'первый шаг запустится в ближайший проход бота' : 'добавьте переработку с витрины'} />}
        {steps.map(({ q, m, tier, st, en }, i) => (
          <Box key={q.id} draggable onDragStart={() => { drag.current = i; }} onDragEnd={() => { drag.current = null; setOver(null); }}
            onDragOver={e => { e.preventDefault(); if (over !== i) setOver(i); }} onDrop={e => drop(e, i)}
            sx={{ cursor: 'grab', borderRadius: '12px', boxShadow: over === i ? '0 0 0 2px var(--cyan)' : undefined, ...SWAP }}>
            <Row lead={<Box sx={{ position: 'relative' }}>{tier ? <Item id={tier.output.item_id} q={tier.output.quantity} /> : <Box sx={{ width: 36 }} />}<QueueNum n={i + 1} /></Box>}
              title={`${m ? loc(m.name) : q.machine_id} ${ROMAN[q.level - 1] ?? q.level}`}
              sub={tier ? `${hhmm(st)} → ${hhmm(en)} · ${dur(tier.duration_seconds)}` : 'станок не найден в снимке'}
              trail={<Box as="span" className="sw-x"><IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => remove(q.id)} /></Box>} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── карточка станка ─────────────────────────────────────────────────────────────
function MachineCard({ m, cat, data, accountId, accounts, onChanged, onFlash }: {
  m: TechFactoryMachine; cat: string; data: TechFactoryOverview; accountId: number; accounts: TechFactorySummaryRow[];
  onChanged: () => void; onFlash: (msg: string, ok: boolean) => void;
}) {
  const unlocked = m.tiers.filter(t => t.unlocked);
  const [level, setLevel] = useState(unlocked[unlocked.length - 1]?.level ?? m.tiers[0]?.level ?? 1);
  const tier = m.tiers.find(t => t.level === level) ?? m.tiers[0];
  const [busy, setBusy] = useState<string | null>(null);
  const [others, setOthers] = useState<Set<number>>(new Set());
  if (!tier) return null;
  const idle = !data.job;
  const limited = tier.unlocked && !tier.limit_available;
  // есть/нужно по снимку склада; нет снимка склада — не гасим кнопку, проверит игра
  const inv = data.inventory;
  const haveOf = (id: number) => inv ? inv[String(id)] ?? 0 : null;
  const short = !!inv && tier.inputs.some(x => (haveOf(x.item_id) ?? 0) < x.quantity);
  const nextLocked = m.tiers.find(t => !t.unlocked);
  const run = async (key: string, p: Promise<{ ok: boolean; error?: string }>, ok: string) => {
    setBusy(key);
    const r = await p;
    setBusy(null);
    if (r.ok) { onFlash(ok, true); onChanged(); } else onFlash(r.error ?? 'Ошибка', false);
  };
  const start = () => idle
    ? run('go', api.techFactoryStart(accountId, m.id, tier.level), 'Переработка запущена')
    : run('go', api.techFactoryQueueAdd(accountId, m.id, tier.level), 'Добавлено в очередь');
  // тот же рецепт в очередь других аккаунтов: проверку тира и лимита делает бот при запуске
  const addOthers = async () => {
    const ids = [...others]; if (!ids.length) return;
    setBusy('others');
    let fail = 0;
    for (const id of ids) { const r = await api.techFactoryQueueAdd(id, m.id, tier.level); if (!r.ok) fail++; }
    setBusy(null); setOthers(new Set());
    onFlash(fail ? `Добавлено: ${ids.length - fail}, ошибок: ${fail}` : `Добавлено в очередь ${ids.length} акк.`, !fail);
  };
  const canAffordUnlock = tier.upgrade_crystals != null && data.guild_crystal_balance != null && data.guild_crystal_balance >= tier.upgrade_crystals;
  return (
    <Box sx={{ p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2, opacity: limited ? 0.65 : 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: 2, bg: limited ? 'done.emphasis' : 'success.emphasis', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span className={`mdi ${(m.icon_key || 'mdi-cog').replace(/^mdi-?/, 'mdi-')}`} style={{ fontSize: 22, color: '#fff' }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Text sx={{ fontWeight: 'semibold', display: 'block' }}>{loc(m.name)}</Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>ур. {m.level} из {m.max_level}{cat ? ` · ${cat}` : ''}</Text>
        </Box>
        {nextLocked && <IconButton size="small" variant="invisible" icon={TriangleUpIcon} aria-label="Улучшить станок" onClick={() => setLevel(nextLocked.level)} />}
      </Box>
      <CatTabs tabs={m.tiers.map(t => t.unlocked ? ROMAN[t.level - 1] : <LockIcon size={12} />)} value={m.tiers.indexOf(tier)} onChange={i => setLevel(m.tiers[i].level)} />
      {!tier.unlocked ? (
        <Box sx={{ flex: 1, minHeight: '100px', py: 2, px: 2, bg: 'canvas.subtle', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Тир {ROMAN[tier.level - 1]} закрыт: открывается за 💎{tier.upgrade_crystals ?? '?'} из казны гильдии{!data.can_spend_guild_crystals ? ' (только лидер или офицер)' : ''}</Text>
          <Button size="small" leadingVisual={UnlockIcon} loading={busy === 'up'} disabled={!data.can_spend_guild_crystals || !canAffordUnlock || !!busy}
            onClick={() => run('up', api.techFactoryUpgrade(accountId, m.id, tier.level), 'Тир открыт')}>Открыть тир</Button>
        </Box>
      ) : <>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, height: '60px', px: 2, bg: 'canvas.subtle', borderRadius: '12px', flexWrap: 'nowrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>{tier.inputs.map((x, i) => { const h = haveOf(x.item_id); return <Item key={i} id={x.item_id} q={h == null ? x.quantity : `${h}/${x.quantity}`} short={h != null && h < x.quantity} />; })}</Box>
          <Text sx={{ color: 'fg.muted' }}>→</Text>
          <Item id={tier.output.item_id} q={tier.output.quantity} />
          <Box sx={{ ml: 1, minWidth: 0, whiteSpace: 'nowrap' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}><ClockIcon size={12} /> {dur(tier.duration_seconds)}{tier.fee_crystals > 0 ? ` · 💎${tier.fee_crystals}` : ''}</Text>
            <Text sx={{ fontSize: 0, color: limited ? 'danger.fg' : 'fg.muted' }}>{limited ? 'лимит исчерпан' : limitText(tier)}</Text>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, mt: 'auto' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Button block variant="primary" leadingVisual={PlusIcon} loading={busy === 'go'} disabled={limited || short || !!busy} onClick={start}>
              {short ? 'Не хватает сырья' : idle ? 'Запустить' : 'В очередь'}
            </Button>
          </Box>
          {accounts.length > 1 && (
            <ActionMenu>
              <ActionMenu.Anchor><IconButton sx={{ flexShrink: 0 }} icon={PeopleIcon} aria-label="Тот же рецепт другим аккаунтам" disabled={!!busy} /></ActionMenu.Anchor>
              <ActionMenu.Overlay width="medium">
                <ActionList selectionVariant="multiple">
                  <ActionList.Group title="Тот же рецепт в очередь">
                    {accounts.filter(a => a.id !== accountId).map(a => (
                      <ActionList.Item key={a.id} selected={others.has(a.id)}
                        onSelect={e => { e.preventDefault(); setOthers(s => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; }); }}>
                        {a.name}
                        <ActionList.TrailingVisual>{a.job ? `после ${a.queue.length + 1}` : 'сразу'}</ActionList.TrailingVisual>
                      </ActionList.Item>
                    ))}
                  </ActionList.Group>
                  <ActionList.Divider />
                  <ActionList.Item disabled={!others.size} onSelect={addOthers}>Добавить ({others.size})</ActionList.Item>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          )}
        </Box>
      </>}
    </Box>
  );
}

// закрытая категория: копим Почёт в общий пул категории
function LockedCategory({ c, accountId, onChanged, onFlash }: { c: TechFactoryCategory; accountId: number; onChanged: () => void; onFlash: (m: string, ok: boolean) => void }) {
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<'personal' | 'guild'>('personal');
  const [busy, setBusy] = useState(false);
  const pool = c.pool;
  const pct = pool && pool.target > 0 ? Math.min(100, pool.progress / pool.target * 100) : 0;
  const send = async () => {
    const n = Number(amount); if (!(n > 0)) return;
    setBusy(true);
    const r = await api.techFactoryContribute(accountId, c.id, n, source);
    setBusy(false);
    if (r.ok) { onFlash('Почёт вложен', true); setAmount(''); onChanged(); } else onFlash(r.error ?? 'Ошибка', false);
  };
  return (
    <Box sx={{ p: 2, borderRadius: '12px', border: '1px dashed', borderColor: 'border.default', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <LockIcon size={16} />
        <Text sx={{ fontWeight: 'semibold', flex: 1 }}>{loc(c.name) || c.code}</Text>
        {c.machine_total ? <Label>станков: {c.machine_total}</Label> : null}
      </Box>
      {c.description && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{loc(c.description)}</Text>}
      {pool && <>
        <Row fill={fillOf([[FILL_DONE, pct]])} title={`${fmt(pool.progress)} из ${fmt(pool.target)} Почёта`} sub={pool.fundable ? 'категория откроется, когда пул заполнится' : 'сначала откройте предыдущую категорию'} />
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextInput size="small" type="number" placeholder="Сумма" value={amount} onChange={e => setAmount(e.target.value)} sx={{ width: 110 }} disabled={!pool.fundable} />
          <Select size="small" value={source} onChange={e => setSource(e.target.value as 'personal' | 'guild')} disabled={!pool.fundable}>
            <Select.Option value="personal">Свой Почёт</Select.Option>
            <Select.Option value="guild">Казна гильдии</Select.Option>
          </Select>
          <Button size="small" variant="primary" loading={busy} disabled={!amount || !pool.fundable} onClick={send}>Вложить</Button>
        </Box>
      </>}
    </Box>
  );
}

// ── страница ───────────────────────────────────────────────────────────────────
export function Factory() {
  const [rows, setRows] = useState<TechFactorySummaryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [data, setData] = useState<TechFactoryOverview | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(0);
  const [cat, setCat] = useState(0);
  const { flash, showFlash } = useFlash();
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:techfactory', () => loadAll());

  const loadAll = async () => {
    const r = await api.techFactorySummary();
    if (!r.ok) { setErr(r.error ?? 'Ошибка загрузки'); return; }
    setErr(null); setRows(r.accounts);
    setSel(s => s != null && r.accounts.some(a => a.id === s) ? s : r.accounts[0]?.id ?? null);
  };
  const loadOne = async (id: number) => {
    const r = await api.techFactoryOverview(id);
    if (r.ok) setData(r as TechFactoryOverview); else showFlash(r.error ?? 'Ошибка загрузки', false);
  };
  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (sel != null) { setData(null); loadOne(sel); } }, [sel]);
  const changed = () => { if (sel != null) loadOne(sel); loadAll(); };

  const refresh = async () => {
    setRefreshing(true);
    const r = await api.refresh('techfactory');
    setRefreshing(false);
    await loadAll(); if (sel != null) loadOne(sel);
    showFlash(r.ok ? 'Обновлено с сервера игры' : 'Ошибка обновления', r.ok);
  };

  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={loadAll} /></Box>;
  const all = rows ?? [];
  const working = all.filter(a => a.job).length;
  const queued = all.reduce((s, a) => s + a.queue.length, 0);
  const list = all.filter(a => (filter === 0 || (filter === 1 ? !!a.job : !a.job)) && a.name.toLowerCase().includes(q.toLowerCase()));
  const acc = all.find(a => a.id === sel) ?? null;
  // когда освободятся все: конец текущей + длительность очереди (у сводки нет длительностей — только конец текущей)
  const allDone = Math.max(0, ...all.filter(a => a.job && !a.job.ready).map(a => new Date(a.job!.finishes_at).getTime()));

  const side = (
    <PanelShell mode="view" title="Аккаунты" busy={rows == null}
      hint="Выберите аккаунт — слева откроется его витрина станков и очередь. Готовое бот забирает сам.">
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile size={2} value={working} label="работают" color="accent.fg" />
          <Tile size={2} value={all.length - working} label="простаивают" color={all.length - working ? 'attention.fg' : undefined} />
        </Box>
        <SumLine left={`в очередях ${queued}`} right={allDone ? `до ${hhmm(allDone)}` : `аккаунтов ${all.length}`} />
      </Summary>
      <TextInput placeholder="Поиск" value={q} onChange={e => setQ(e.target.value)} block />
      <CatTabs tabs={['Все', 'Работают', 'Свободны']} value={filter} onChange={setFilter} />
      {!all.length && <Empty>Нет аккаунтов, чья гильдия построила фабрику. Нажмите «Обновить с игры».</Empty>}
      {list.map(a => (
        <Row key={a.id} onClick={() => setSel(a.id)} sx={a.id === sel ? SELECTED_RING : undefined}
          lead={a.job ? <Item id={a.job.output.item_id} q={a.job.output.quantity} />
            : <Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', color: 'attention.fg' }}><StopIcon size={16} /></Box>}
          fill={a.job ? fillOf([[FILL_DONE, pctOf(a.job)]]) : undefined}
          title={a.name}
          sub={a.job ? `${a.job.machine_name} ${ROMAN[a.job.level - 1] ?? ''}${a.queue.length ? ` · +${a.queue.length}` : ''}` : a.queue.length ? `ждёт запуска · ${a.queue.length} в очереди` : 'станок свободен'}
          trail={<Val color={a.job ? 'fg.default' : 'attention.fg'}>{a.job ? left(a.job.finishes_at) : '—'}</Val>} />
      ))}
    </PanelShell>
  );

  const cats = data?.categories ?? [];
  const shownCats = cat === 0 ? cats : [cats[cat - 1]].filter(Boolean);
  const main = (
    <>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Box>
          <Heading as="h2" sx={{ fontSize: 3 }}>Фабрика</Heading>
          {acc && <Text sx={{ color: 'fg.muted', fontSize: 1 }}>{acc.name} · <RenownValue value={fmtInt(data?.renown_balance ?? acc.renown_balance ?? 0)} /></Text>}
        </Box>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить</Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {!acc ? <Text sx={{ color: 'fg.muted' }}>Выберите аккаунт справа</Text>
        : !data ? <Text sx={{ color: 'fg.muted' }}>Загрузка…</Text>
        : !data.updated_at ? <Text sx={{ color: 'fg.muted' }}>Снимка ещё нет — нажмите «Обновить»</Text>
        : <>
          {!data.in_guild && <Flash variant="warning" sx={{ mb: 3 }}>Аккаунт не в гильдии (или меньше суток в ней) — переработки недоступны</Flash>}
          <QueueList data={data} accountId={acc.id} onChanged={changed} onFlash={showFlash} />
          {cats.length > 0 && (
            <UnderlineNav aria-label="Категории" sx={{ mb: 3 }}>
              {[null, ...cats].map((c, i) => (
                <UnderlineNav.Item key={c?.id ?? 'all'} href="#" aria-current={i === cat ? 'page' : undefined}
                  onSelect={e => { e.preventDefault(); setCat(i); }}
                  counter={c == null ? cats.reduce((n, x) => n + (x.unlocked ? x.machines?.length ?? 0 : 0), 0) : c.unlocked ? c.machines?.length ?? 0 : undefined}
                  icon={c && !c.unlocked ? LockIcon : undefined}>
                  {c == null ? 'Все' : loc(c.name) || c.code}
                </UnderlineNav.Item>
              ))}
            </UnderlineNav>
          )}
          {(() => {
            const open = shownCats.filter(c => c.unlocked);
            const machines = open.flatMap(c => (c.machines ?? []).map(m => ({ m, c })));
            return <>
              {machines.length > 0 && (
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 3, mb: 3 }}>
                  {machines.map(({ m, c }) => <MachineCard key={`${acc.id}:${m.id}`} m={m} cat={loc(c.name) || c.code} data={data} accountId={acc.id} accounts={all} onChanged={changed} onFlash={showFlash} />)}
                </Box>
              )}
              {cat !== 0 && shownCats.filter(c => !c.unlocked).map(c => <Box key={c.id} sx={{ mb: 3, maxWidth: 640 }}><LockedCategory c={c} accountId={acc.id} onChanged={changed} onFlash={showFlash} /></Box>)}
            </>;
          })()}
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Снимок от {new Date(data.updated_at).toLocaleString('ru')}</Text>
        </>}
    </>
  );
  return <SidePage main={main} side={side} />;
}
