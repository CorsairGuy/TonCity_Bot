import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Flash, Heading, Label, Spinner, Text, TextInput } from '@primer/react';
import { DatabaseIcon, SyncIcon } from '@primer/octicons-react';
import { api, type ReserveEntry, type ReserveSnapshot, type StakingAccountInfo, type StakingEntryRow } from '../api';
import { SidePage, CatTabs, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row, Summary, Tile, SumLine } from './cityMapPanels';
import { CoinValue, CrystalValue } from '../components/Icons';
import { useAsk } from '../hooks/useAsk';
import { fmt, fmtDate } from '../utils';

type Currency = 'coins' | 'crystals';
const panel = { bg: 'canvas.default', border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3 } as const;
const value = (amount: number, currency: Currency) => currency === 'coins' ? <CoinValue value={fmt(amount)} /> : <CrystalValue value={fmt(amount)} />;
function remaining(date: string | null) {
  if (!date || !Number.isFinite(new Date(date).getTime())) return 'Срок неизвестен';
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'Готов к сбору';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  return d ? `${d} дн. ${h % 24} ч.` : `${h} ч. ${Math.floor(ms % 3600000 / 60000)} мин.`;
}
const ready = (date: string | null) => !!date && Number.isFinite(new Date(date).getTime()) && new Date(date).getTime() <= Date.now();

export function Reserve() {
  const [accounts, setAccounts] = useState<StakingAccountInfo[]>([]);
  const [rows, setRows] = useState<StakingEntryRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<ReserveSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(0);
  const [currency, setCurrency] = useState<Currency>('coins');
  const [amount, setAmount] = useState<number | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState(false);
  const ask = useAsk();
  const load = useCallback(async () => {
    const result = await api.staking(true);
    if (!result.ok) { setError('Не удалось загрузить вклады'); setLoading(false); return; }
    setAccounts(result.accounts ?? []); setRows(result.entries ?? []);
    setSelected(s => s != null && result.accounts.some(a => a.id === s) ? s : result.accounts[0]?.id ?? null);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    setSnapshot(null); setAmount(null); setDays(null); setError(''); setNotice('');
    if (selected != null) api.stakingSnapshot(selected).then(r => { if (active) { setSnapshot(r.ok ? r : null); if (!r.ok) setError(r.error ?? 'Нет снимка'); } });
    return () => { active = false; };
  }, [selected]);
  const refresh = async (id: number) => {
    setBusy(true); setError('');
    const r = await api.stakingRefreshAccount(id);
    if (r.ok) { if (id === selected) setSnapshot(r); await load(); }
    else if (id === selected) setError(r.error ?? 'Не удалось обновить данные игры');
    setBusy(false);
    return r.ok;
  };
  const acc = accounts.find(a => a.id === selected);
  const allActive = rows.filter(e => !e.collected);
  const dbEntries = allActive.filter(e => e.account === acc?.name);
  const data = snapshot?.data;
  const entries: ReserveEntry[] = data?.entries ?? dbEntries.map(e => ({ id: e.entry_id, currency: e.currency, amount_staked: e.amount_staked, amount_to_collect: e.amount_to_collect, created_at: e.created_at, can_collect_at: e.can_collect_at }));
  const per = data?.stakes_per_currency;
  const terms = (currency === 'coins' ? data?.coin_terms : data?.crystal_terms) ?? [];
  const amounts = (currency === 'coins' ? data?.coin_amounts : data?.crystal_amounts) ?? [];
  const whale = currency === 'coins' ? data?.whale_slots ?? [] : [];
  const term = terms.find(t => t.days === days);
  const multiplier = data?.staking_rate_multiplier;
  const payout = amount != null && term && multiplier != null ? Math.floor(amount * (1 + term.rate * multiplier)) : null;
  const count = (c: Currency) => entries.filter(e => e.currency === c).length;
  const balance = snapshot?.balance?.[currency] ?? acc?.[currency] ?? 0;
  const validAmount = amount != null && (amounts.includes(amount) || whale.some(w => w.amount === amount && !w.in_use));
  const canStake = !!data && Number.isSafeInteger(per) && count(currency) < (per ?? 0) && validAmount && days != null && !!term && payout != null && amount != null && amount <= balance;
  const current = accounts.filter(a => {
    const active = allActive.filter(e => e.account === a.name);
    return a.name.toLowerCase().includes(query.toLowerCase()) && (filter === 0 || (filter === 1 ? active.length > 0 : active.some(e => ready(e.can_collect_at))));
  });
  const perform = async (kind: 'stake' | 'collect' | 'cancel', entry?: ReserveEntry) => {
    if (!acc) return;
    const message = kind === 'stake' ? `Создать вклад ${fmt(amount!)} на ${days} дней для ${acc.name}?` : kind === 'collect' ? 'Забрать созревший вклад?' : 'Досрочно закрыть монетный вклад без процентов?';
    if (!await ask(kind === 'cancel' ? 'Отменить вклад?' : kind === 'collect' ? 'Забрать вклад?' : 'Создать вклад?', message, { danger: kind === 'cancel', ok: kind === 'cancel' ? 'Отменить вклад' : kind === 'collect' ? 'Забрать' : 'Вложить' })) return;
    setBusy(true); setError(''); setNotice('');
    const r = kind === 'stake' ? await api.stakingStake(acc.id, currency, amount!, days!) : kind === 'collect' ? await api.stakingCollect(entry!.id) : await api.stakingCancel(entry!.id);
    if (!r.ok) { setError(r.error ?? 'Действие не подтверждено'); setBusy(false); return; }
    setNotice(kind === 'stake' ? 'Вклад создан' : kind === 'collect' ? 'Вклад собран' : 'Вклад отменён');
    setAmount(null); setDays(null); await refresh(acc.id);
  };
  const side = <PanelShell mode="view" title="Аккаунты" busy={loading} hint="Выберите аккаунт. Данные не загружаются из игры до нажатия «Обновить».">
    <Summary tone="accent"><Box sx={{ display: 'flex', gap: 2 }}><Tile size={2} value={accounts.length} label="аккаунтов" color="accent.fg"/><Tile size={2} value={allActive.filter(e => ready(e.can_collect_at)).length} label="готово" color="success.fg"/></Box><SumLine left={`вкладов ${allActive.length}`} right="локальные данные"/></Summary>
    <TextInput placeholder="Поиск" value={query} onChange={e => setQuery(e.target.value)} block/><CatTabs tabs={['Все','Активные','Готово']} value={filter} onChange={setFilter}/>
    {current.map(a => { const own=allActive.filter(e => e.account === a.name), n=own.filter(e => ready(e.can_collect_at)).length; return <Row key={a.id} onClick={() => { if (!busy) setSelected(a.id); }} sx={selected === a.id ? SELECTED_RING : undefined} lead={<Box sx={{ width: 36, height: 36, borderRadius: 2, bg: 'accent.subtle', display: 'grid', placeItems: 'center', color: 'accent.fg' }}><DatabaseIcon/></Box>} title={a.name} sub={own.length ? `вкладов: ${own.length}` : 'нет вкладов'} trail={<Text sx={{ fontSize: 0, color: n ? 'success.fg' : 'fg.muted' }}>{n ? `готово ${n}` : '—'}</Text>}/>; })}
  </PanelShell>;
  const grade = data?.reserve_grade;
  const start = Number(grade?.grade_floor ?? 0), next = Number(grade?.next_grade_at ?? 0), progress = Number(grade?.gold_rush_progress ?? 0);
  const pct = next > start ? Math.max(0, Math.min(100, (progress - start) / (next - start) * 100)) : 0;
  const cell = (entry: ReserveEntry) => <Box key={entry.id} sx={{ ...panel, p: 2, borderLeft: '4px solid', borderLeftColor: entry.currency === 'coins' ? 'attention.emphasis' : 'accent.emphasis', minWidth: 0 }}>
    <Text sx={{ fontWeight: 'bold', display: 'block' }}>{value(entry.amount_staked, entry.currency)}</Text>
    <Text sx={{ fontSize: 0, color: 'success.fg', display: 'block', mt: 1 }}>+{value(entry.amount_to_collect - entry.amount_staked, entry.currency)}</Text>
    <Text sx={{ fontSize: 0, color: ready(entry.can_collect_at) ? 'success.fg' : 'fg.muted', display: 'block', mt: 1 }}>{remaining(entry.can_collect_at)}</Text>
    {ready(entry.can_collect_at) ? <Button size="small" sx={{ mt: 2 }} disabled={busy} onClick={() => void perform('collect', entry)}>Забрать</Button> : entry.currency === 'coins' && entry.can_collect_at ? <Button size="small" variant="invisible" sx={{ mt: 1 }} disabled={busy} onClick={() => void perform('cancel', entry)}>Отменить</Button> : null}
  </Box>;
  const main = <>
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 3 }}><Box><Heading as="h2" sx={{ fontSize: 3 }}>Федеральный резерв</Heading><Text sx={{ color: 'fg.muted', fontSize: 1 }}>{acc ? `${acc.name} · вклады выбранного аккаунта` : 'Выберите аккаунт справа'}</Text></Box><Button leadingVisual={SyncIcon} disabled={!acc || busy} loading={busy} onClick={() => acc && void refresh(acc.id)}>Обновить</Button></Box>
    {error && <Flash variant="warning" sx={{ mb: 3 }}>{error}</Flash>}{notice && <Flash variant="success" sx={{ mb: 3 }}>{notice}</Flash>}
    {acc && <>
      {snapshot?.updated_at && <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', mb: 2 }}>Снимок от {fmtDate(snapshot.updated_at)} · обновление только по кнопке</Text>}
      {grade && <Box sx={{ ...panel, display: 'flex', gap: 3, alignItems: 'center', mb: 3 }}><Box sx={{ width: 48, height: 48, borderRadius: '50%', bg: 'accent.subtle', color: 'accent.fg', display: 'grid', placeItems: 'center', fontWeight: 'bold', flexShrink: 0 }}>{grade.grade}</Box><Box sx={{ flex: 1, minWidth: 0 }}><Text sx={{ fontWeight: 'bold', display: 'block' }}>Уровень резерва {grade.grade}</Text><Text sx={{ color: 'fg.muted', fontSize: 0 }}>«Золотая лихорадка»: {fmt(progress)}{next ? ` / ${fmt(next)}` : ''}</Text><Box sx={{ mt: 2, height: 6, borderRadius: 2, bg: 'neutral.muted' }}><Box sx={{ width: `${pct}%`, height: '100%', borderRadius: 2, bg: 'accent.emphasis' }}/></Box></Box></Box>}
      <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>Ячейки хранилища</Heading>
      {(['coins','crystals'] as Currency[]).map(c => { const own=entries.filter(e => e.currency === c), empty=Number.isSafeInteger(per) && (per ?? 0) >= 0 ? Math.max(0, (per ?? 0) - own.length) : 0; return <Box key={c} sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 2, mb: 2 }}>{own.map(cell)}{Array.from({length: Math.min(empty, 50)}, (_, i) => <Box key={i} sx={{ ...panel, borderStyle: 'dashed', bg: 'canvas.subtle', minHeight: 90, display: 'grid', placeItems: 'center', color: 'fg.muted', fontSize: 0 }}>Свободна для {c === 'coins' ? 'монет' : 'алмазов'}</Box>)}</Box>; })}
      {!entries.length && !data && <Text sx={{ display: 'block', color: 'fg.muted', mb: 3 }}>В локальной базе вкладов нет. Обновите данные, чтобы увидеть ячейки и условия.</Text>}
      <Heading as="h3" sx={{ fontSize: 2, mt: 3, mb: 2 }}>Новый вклад</Heading>
      <Box sx={panel}><CatTabs tabs={[`Монеты ${count('coins')}${per != null ? ` / ${per}` : ''}`, `Алмазы ${count('crystals')}${per != null ? ` / ${per}` : ''}`]} value={currency === 'coins' ? 0 : 1} onChange={i => { setCurrency(i ? 'crystals' : 'coins'); setAmount(null); setDays(null); }}/>
        {!data ? <Text sx={{ display: 'block', color: 'fg.muted', fontSize: 1, mt: 3 }}>Нажмите «Обновить», чтобы получить доступные суммы и сроки.</Text> : <>
          <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', fontWeight: 'bold', mt: 3, mb: 2 }}>СУММА</Text><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 2 }}>{amounts.map(a => <Button key={a} disabled={busy || a > balance} variant={amount === a ? 'primary' : 'default'} onClick={() => setAmount(a)}>{fmt(a)}</Button>)}</Box>
          {whale.length > 0 && <><Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', fontWeight: 'bold', mt: 3, mb: 2 }}>СЛИТКИ «АКУЛЫ БИЗНЕСА»</Text><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 2 }}>{whale.map((w,i) => <Button key={i} disabled={busy || w.in_use || w.amount > balance} variant={amount === w.amount && !w.in_use ? 'primary' : 'default'} onClick={() => setAmount(w.amount)}>{fmt(w.amount)}{w.in_use ? ' · занят' : ` · ${w.rarity}`}</Button>)}</Box></>}
          <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', fontWeight: 'bold', mt: 3, mb: 2 }}>СРОК</Text><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 2 }}>{terms.map(t => <Button key={t.days} disabled={busy} variant={days === t.days ? 'primary' : 'default'} onClick={() => setDays(t.days)}>{`+${Number((t.rate * (multiplier ?? 0) * 100).toFixed(2))}% · ${t.days} дн.`}</Button>)}</Box>
          <Box sx={{ mt: 2, mb: 2, py: 2, bg: 'canvas.subtle', borderRadius: 2 }}>{[['Вклад', amount == null ? '—' : value(amount,currency)],['Доход', payout == null || amount == null ? '—' : value(payout-amount,currency)],['Срок вклада',days == null ? '—' : `${days} дн.`],['К получению',payout == null ? '—' : value(payout,currency)]].map(([label,v]) => <Box key={String(label)} sx={{ display: 'flex', justifyContent: 'space-between', py: 1, fontWeight: label === 'К получению' ? 'bold' : 'normal', borderTop: label === 'К получению' ? '1px solid' : 0, borderColor: 'border.default' }}><Text>{label}</Text><Text>{v}</Text></Box>)}</Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>{count(currency) >= (per ?? 0) ? 'Все ячейки для этой валюты заняты' : <>Доступно: {value(balance,currency)}</>}</Text><Button variant="primary" disabled={!canStake || busy} onClick={() => void perform('stake')}>Создать вклад</Button></Box>
        </>}
      </Box>
      <Box sx={{ mt: 3 }}><Button size="small" onClick={() => setHistory(!history)}>{history ? 'Скрыть историю' : 'История вкладов'}</Button>{history && <Box sx={{ ...panel, mt: 2 }}>{rows.filter(e => e.account === acc.name && e.collected).length === 0 ? <Text sx={{ color: 'fg.muted' }}>Собранных вкладов нет</Text> : rows.filter(e => e.account === acc.name && e.collected).map(e => <Box key={e.entry_id} sx={{ py: 2, borderBottom: '1px solid', borderColor: 'border.muted', display: 'flex', justifyContent: 'space-between', gap: 2 }}><Text>{value(e.amount_to_collect,e.currency)}</Text><Text sx={{ color: 'fg.muted', fontSize: 0 }}>{e.collected_at ? fmtDate(e.collected_at) : 'Дата неизвестна'}</Text></Box>)}</Box>}</Box>
    </>}
  </>;
  return <SidePage main={main} side={side}/>;
}
