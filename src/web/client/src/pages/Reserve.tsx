import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Button, Flash, Spinner, Text, ToggleSwitch, Label,
  SegmentedControl, Checkbox, ConfirmationDialog, ProgressBar,
} from '@primer/react';
import { DataTable, Table, Dialog } from '@primer/react/experimental';
import {
  SyncIcon, CheckIcon, ClockIcon, AlertIcon, PlusCircleIcon, ZapIcon, XCircleIcon, DatabaseIcon,
} from '@primer/octicons-react';
import { api, type StakingEntryRow, type StakingAccountInfo } from '../api';
import { fmt, fmtDate } from '../utils';
import { StatCard } from '../components/StatCard';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { useNarrow } from '../hooks/useNarrow';
import { richHeader, RichBody, RichFooter, SectionLabel, PickRow } from '../components/RichDialog';

// ── Конфиг ставок ────────────────────────────────────────────────────────────

type Currency = 'coins' | 'crystals';

const AMOUNTS: Record<Currency, number[]> = {
  coins:    [1e8, 1e9, 1e10, 1e11, 1e12],
  crystals: [100, 500, 2e3, 1e4, 1e5],
};
const DURATIONS: Record<Currency, number[]> = {
  coins:    [2, 7, 14, 30],
  crystals: [7, 14, 30],
};
const RATES: Record<Currency, Record<number, number>> = {
  coins:    { 2: 0.01, 7: 0.05, 14: 0.15, 30: 0.50 },
  crystals: { 7: 0.01, 14: 0.04, 30: 0.10 },
};

function getRate(currency: Currency, duration: number) {
  return RATES[currency][duration] ?? 0;
}

function fmtAmt(n: number, currency: Currency) {
  return currency === 'coins' ? fmt(n) : String(n >= 1000 ? fmt(n) : n);
}

// ── Вспомогательные компоненты ───────────────────────────────────────────────

function StatusBadge({ canCollectAt, collected }: { canCollectAt: string; collected: boolean }) {
  if (collected) return <Label variant="success"><CheckIcon size={12} /> Собрано</Label>;
  const ms = new Date(canCollectAt).getTime() - Date.now();
  if (ms <= 0) return <Label variant="attention"><AlertIcon size={12} /> Готово</Label>;
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  const left = d > 0 ? `${d}д ${h % 24}ч` : `${h}ч ${Math.floor((ms % 3600000) / 60000)}м`;
  return <Label><ClockIcon size={12} /> {left}</Label>;
}

// ── Модалка стейкинга ─────────────────────────────────────────────────────────

function StakeModal({
  accounts,
  onClose,
  onStaked,
}: {
  accounts: StakingAccountInfo[];
  onClose: () => void;
  onStaked: () => void;
}) {
  const [currency, setCurrency] = useState<Currency>('coins');
  const [amount, setAmount]     = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  // снятые галочки (по умолчанию выбраны все подходящие аккаунты)
  const [unpicked, setUnpicked] = useState<Set<number>>(new Set());
  const [stakingAll, setStakingAll] = useState(false);
  const [results, setResults]   = useState<Record<number, { ok: boolean; error?: string }>>({});
  const { flash, showFlash }    = useFlash();
  const prevAccountsRef = useRef(accounts);
  if (prevAccountsRef.current !== accounts) {
    prevAccountsRef.current = accounts;
    // Сбрасываем успешные результаты когда обновились данные аккаунтов
    const hasSuccess = Object.values(results).some(r => r.ok);
    if (hasSuccess) setResults(r => Object.fromEntries(Object.entries(r).filter(([, v]) => !v.ok)));
  }

  const rate    = amount && duration ? getRate(currency, duration) : null;
  const profit  = rate != null && amount ? Math.floor(amount * rate) : null;

  // Сбросить выбор при смене валюты
  const switchCurrency = (c: Currency) => {
    setCurrency(c);
    setAmount(null);
    setDuration(null);
    setUnpicked(new Set());
    setResults({});
  };

  const slots = (acc: StakingAccountInfo) =>
    currency === 'coins' ? acc.coin_slots : acc.crystal_slots;

  const balance = (acc: StakingAccountInfo) =>
    currency === 'coins' ? acc.coins : acc.crystals;

  const canStake = (acc: StakingAccountInfo) =>
    amount != null && duration != null && slots(acc) < 3 && balance(acc) >= amount;

  const eligible = accounts.filter(canStake);
  const picked = eligible.filter(a => !unpicked.has(a.id));
  const togglePick = (id: number) => setUnpicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = picked.length === eligible.length;

  const stakeOne = async (acc: StakingAccountInfo) => {
    if (!amount || !duration) return { ok: false };
    const r = await api.stakingStake(acc.id, currency, amount, duration);
    setResults(s => ({ ...s, [acc.id]: r }));
    return r;
  };

  const stakePicked = async () => {
    if (!picked.length) return;
    setStakingAll(true);
    try {
      const rs = await Promise.allSettled(picked.map(stakeOne));
      const ok = rs.filter(r => r.status === 'fulfilled' && r.value.ok).length;
      showFlash(ok === picked.length ? `Вложено на ${ok} акк.` : `Вложено на ${ok} из ${picked.length} акк.`, ok === picked.length);
      onStaked();
    } finally { setStakingAll(false); }
  };

  const Val = ({ v }: { v: number }) => currency === 'coins' ? <CoinValue value={fmt(v)} /> : <CrystalValue value={fmt(v)} />;
  const n = picked.length;
  const summary = !amount || !duration
    ? 'Выберите сумму и срок'
    : n === 0 ? 'Нет подходящих аккаунтов'
    : <>{n} акк. · <b><Val v={amount * n} /></b> → <b style={{ color: 'var(--green)' }}><Val v={(amount + (profit ?? 0)) * n} /></b> через {duration} дн.</>;

  return (
    <Dialog
      title="Новый вклад"
      subtitle="Федеральный резерв · вклад вернётся с процентом в конце срока"
      renderHeader={richHeader(DatabaseIcon)}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      renderFooter={() => (
        <RichFooter summary={summary}>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" leadingVisual={ZapIcon} disabled={!amount || !duration || n === 0 || stakingAll}
            loading={stakingAll} onClick={stakePicked}>
            {n > 0 ? `Вложить в ${n}` : 'Вложить'}
          </Button>
        </RichFooter>
      )}
    >
      <RichBody>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>}

        <SegmentedControl fullWidth aria-label="Валюта" onChange={i => switchCurrency(i === 0 ? 'coins' : 'crystals')}>
          <SegmentedControl.Button selected={currency === 'coins'}>Монеты</SegmentedControl.Button>
          <SegmentedControl.Button selected={currency === 'crystals'}>Кристаллы</SegmentedControl.Button>
        </SegmentedControl>

        <Box sx={{ display: 'grid', gap: 3 }}>
          <Box>
            <SectionLabel>Сумма на аккаунт</SectionLabel>
            <SegmentedControl fullWidth size="small" aria-label="Сумма" onChange={i => setAmount(AMOUNTS[currency][i])}>
              {AMOUNTS[currency].map(v => (
                <SegmentedControl.Button key={v} selected={amount === v}>{fmtAmt(v, currency)}</SegmentedControl.Button>
              ))}
            </SegmentedControl>
          </Box>
          <Box>
            <SectionLabel>Срок и доход</SectionLabel>
            <SegmentedControl fullWidth size="small" aria-label="Срок" onChange={i => setDuration(DURATIONS[currency][i])}>
              {DURATIONS[currency].map(d => (
                <SegmentedControl.Button key={d} selected={duration === d}>{`${d}д · ${(getRate(currency, d) * 100).toFixed(0)}%`}</SegmentedControl.Button>
              ))}
            </SegmentedControl>
          </Box>
        </Box>

        <Box>
          <SectionLabel action={eligible.length > 0 && (
            <Button size="small" variant="invisible" onClick={() => setUnpicked(allPicked ? new Set(eligible.map(a => a.id)) : new Set())}>
              {allPicked ? 'Снять все' : 'Выбрать все подходящие'}
            </Button>
          )}>
            {amount && duration ? `Аккаунты · выбрано ${n} из ${eligible.length}` : 'Аккаунты'}
          </SectionLabel>
          <div className="rdlg-list">
            {accounts.map(acc => {
              const sl = slots(acc);
              const ok = canStake(acc);
              const on = ok && !unpicked.has(acc.id);
              const res = results[acc.id];
              const why = res && !res.ok ? 'ошибка'
                : res?.ok ? 'вложено'
                : sl >= 3 ? 'нет слотов'
                : amount != null && balance(acc) < amount ? (currency === 'coins' ? 'мало монет' : 'мало кристаллов')
                : `слоты ${sl}/3`;
              return (
                <PickRow key={acc.id} on={on} off={!ok} onClick={() => togglePick(acc.id)}>
                  <Checkbox checked={on} disabled={!ok} onChange={() => togglePick(acc.id)} onClick={e => e.stopPropagation()} aria-label={acc.name} />
                  <b style={{ fontWeight: 600 }}>{acc.name}</b>
                  <span className="num"><Val v={balance(acc)} /></span>
                  <span className="why" style={res?.ok ? { color: 'var(--green)' } : res && !res.ok ? { color: 'var(--red)' } : undefined}
                    title={res?.error}>{why}</span>
                </PickRow>
              );
            })}
          </div>
        </Box>
      </RichBody>
    </Dialog>
  );
}

// ── Основная страница ─────────────────────────────────────────────────────────

export function Reserve() {
  const narrow = useNarrow();
  const [entries, setEntries]     = useState<StakingEntryRow[]>([]);
  const [accounts, setAccounts]   = useState<StakingAccountInfo[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:staking', () => load());
  const [showCollected, setShowCollected] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  // отмена вклада: сначала окно подтверждения (как расформирование политик), потом запрос
  const [confirmCancel, setConfirmCancel] = useState<StakingEntryRow | null>(null);
  const [cancelling, setCancelling] = useState<Record<number, boolean>>({});
  const { flash, showFlash }      = useFlash();
  const openBtnRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.staking(showCollected);
      if (d.ok) { setEntries(d.entries); setAccounts(d.accounts ?? []); }
    } finally { if (!silent) setLoading(false); }
  }, [showCollected]);

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('staking'); await load(); showFlash('Обновлено', true); }
    catch { showFlash('Ошибка', false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, [load]);

  const cancelOne = async (e: StakingEntryRow) => {
    setCancelling(s => ({ ...s, [e.entry_id]: true }));
    try {
      const r = await api.stakingCancel(e.entry_id);
      if (r.ok) {
        // игра в ответе отдаёт amount — сколько вернула на баланс
        const back = r.result?.amount;
        showFlash(`Вклад ${e.account} отменён${back != null ? `, возвращено ${fmt(back)}` : ''}`, true);
        await load(true);
      }
      else showFlash(`Вклад ${e.account} не отменён: ${r.error ?? 'ошибка'}`, false);
    } catch (err) {
      showFlash(`Вклад ${e.account} не отменён: ${(err as Error).message}`, false);
    } finally {
      setCancelling(s => ({ ...s, [e.entry_id]: false }));
    }
  };

  const active  = entries.filter(e => !e.collected);
  const coins   = active.filter(e => e.currency === 'coins');
  const crysts  = active.filter(e => e.currency === 'crystals');
  const ready   = active.filter(e => new Date(e.can_collect_at).getTime() <= Date.now());

  const sum = (arr: StakingEntryRow[], field: keyof StakingEntryRow) =>
    arr.reduce((s, e) => s + Number(e[field] ?? 0), 0);

  const totalStakedCoins   = sum(coins, 'amount_staked');
  const totalStakedCrysts  = sum(crysts, 'amount_staked');
  const totalCollectCoins  = sum(coins, 'amount_to_collect');
  const totalCollectCrysts = sum(crysts, 'amount_to_collect');

  // переключатель «Собранные» показывает в таблице ТОЛЬКО собранные вклады; сводка сверху
  // по-прежнему считается по активным (сервер с ?collected=1 отдаёт и те, и другие)
  const data = entries
    .filter(e => e.collected === showCollected)
    .sort((a, b) => {
      if (a.collected !== b.collected) return a.collected ? 1 : -1;
      const aReady = new Date(a.can_collect_at).getTime() <= Date.now();
      const bReady = new Date(b.can_collect_at).getTime() <= Date.now();
      if (aReady !== bReady) return aReady ? -1 : 1;
      return new Date(a.can_collect_at).getTime() - new Date(b.can_collect_at).getTime();
    })
    .map((e, i) => ({
      ...e,
      id: i,
      _dur: Math.round((new Date(e.can_collect_at).getTime() - new Date(e.created_at).getTime()) / 86400000),
      _profit: e.amount_to_collect - e.amount_staked,
      _ready: !e.collected && new Date(e.can_collect_at).getTime() <= Date.now(),
    }));

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Стейкинг" actions={<>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mr: 1 }}>
          <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Собранные</Text>
          {/* Primer ToggleSwitch в управляемом режиме (передан checked) реагирует на клик через
              onClick, а не onChange — onChange там только эффект на смену checked ИЗВНЕ. С onChange
              клик визуально ничего не делал (не менял showCollected) — переключатель "не работал". */}
          <ToggleSwitch size="small" checked={showCollected} onClick={() => setShowCollected(v => !v)} aria-label="Показать собранные" />
        </Box>
        {ready.length > 0 && (
          <Label variant="attention" sx={{ mr: 1 }}>
            <AlertIcon size={14} /> {ready.length} {ready.length === 1 ? 'вклад' : 'вклада'} готово
          </Label>
        )}
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
        <Button ref={openBtnRef} leadingVisual={PlusCircleIcon} variant="primary" onClick={() => setModalOpen(true)}>
          Новый вклад
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}


      <>
          {active.length > 0 && (
            <div className="stat-grid stat-grid--reserve">
              <StatCard label="Стейк монет" color="ton">
                <div style={{ fontSize: 20, fontWeight: 700 }}><CoinValue value={fmt(totalStakedCoins)} /></div>
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--fg-muted)' }}>{coins.length} из 3 слотов</div>
              </StatCard>
              <StatCard label="К получению монет" color="cyan">
                <div style={{ fontSize: 20, fontWeight: 700 }}><CoinValue value={fmt(totalCollectCoins)} /></div>
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--green)' }}>
                  +<CoinValue value={fmt(totalCollectCoins - totalStakedCoins)} />
                </div>
              </StatCard>
              <StatCard label="Стейк кристаллов" color="purple">
                <div style={{ fontSize: 20, fontWeight: 700 }}><CrystalValue value={fmt(totalStakedCrysts)} /></div>
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--fg-muted)' }}>{crysts.length} из 3 слотов</div>
              </StatCard>
              <StatCard label="К получению крист." color="purple">
                <div style={{ fontSize: 20, fontWeight: 700 }}><CrystalValue value={fmt(totalCollectCrysts)} /></div>
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--green)' }}>
                  +<CrystalValue value={fmt(totalCollectCrysts - totalStakedCrysts)} />
                </div>
              </StatCard>
            </div>
          )}

          {narrow && data.length > 0 ? (
            <Box>
              <Text as="h3" sx={{ fontSize: 2, fontWeight: 'bold', mb: 2 }}>{showCollected ? 'Собранные вклады' : 'Активные вклады'}</Text>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {data.map(row => {
                  const Val = row.currency === 'coins' ? CoinValue : CrystalValue;
                  const start = new Date(row.created_at).getTime(), end = new Date(row.can_collect_at).getTime();
                  const pct = row.collected || row._ready ? 100 : Math.max(0, Math.min(100, ((Date.now() - start) / Math.max(1, end - start)) * 100));
                  const canCancel = row.currency === 'coins' && !row.collected && !row._ready;
                  return (
                    <Box key={row.entry_id} sx={{ border: '1px solid', borderColor: row._ready ? 'attention.muted' : 'border.default', borderRadius: 2, p: 2, px: 3, bg: 'canvas.default' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Text sx={{ fontWeight: 'bold', color: row._ready ? 'success.fg' : undefined }}>{row.account}</Text>
                        <Text className="mono" sx={{ fontSize: 0, color: 'fg.muted' }}>{row._dur}д</Text>
                        <Box sx={{ ml: 'auto' }}><StatusBadge canCollectAt={row.can_collect_at} collected={row.collected} /></Box>
                      </Box>
                      <Box className="mono" sx={{ display: 'flex', alignItems: 'center', gap: 2, my: 2, fontSize: 1, minHeight: 28 }}>
                        <Val value={fmt(row.amount_staked)} />
                        <Text sx={{ color: 'fg.subtle' }}>→</Text>
                        <Text sx={{ fontWeight: 600 }}><Val value={fmt(row.amount_to_collect)} /></Text>
                        {canCancel && (
                          <Button size="small" variant="invisible" sx={{ ml: 'auto', color: 'danger.fg' }}
                            loading={!!cancelling[row.entry_id]} disabled={!!cancelling[row.entry_id]}
                            onClick={() => setConfirmCancel(row)}>
                            Отменить
                          </Button>
                        )}
                      </Box>
                      <ProgressBar progress={pct} barSize="small" bg={row._ready || row.collected ? 'success.emphasis' : 'accent.emphasis'} aria-label="До сбора" />
                    </Box>
                  );
                })}
              </Box>
            </Box>
          ) : (
          <Table.Container>
            <Table.Title as="h3" id="staking-table">
              {showCollected ? 'Собранные вклады' : 'Активные вклады'}
            </Table.Title>
            {data.length === 0 ? (
              <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
                <Text>Нет вкладов</Text>
              </Box>
            ) : (
              <DataTable
                aria-labelledby="staking-table"
                data={data}
                columns={[
                  {
                    header: 'Аккаунт',
                    field: 'account',
                    rowHeader: true,
                    sortBy: 'alphanumeric',
                    renderCell: row => (
                      <strong style={{ color: row._ready ? 'var(--green)' : undefined }}>
                        {row.account}
                      </strong>
                    ),
                  },
                  {
                    header: 'Срок',
                    field: '_dur',
                    sortBy: 'basic',
                    renderCell: row => <span className="mono">{row._dur}д</span>,
                  },
                  {
                    header: 'Вложено',
                    field: 'amount_staked',
                    sortBy: 'basic',
                    renderCell: row => (
                      <span className="mono" style={{ display: 'flex', alignItems: 'center', alignContent: 'center', gap: 3 }}>
                        {row.currency === 'coins'
                          ? <CoinValue value={fmt(row.amount_staked)} />
                          : <CrystalValue value={fmt(row.amount_staked)} />}
                      </span>
                    ),
                  },
                  {
                    header: 'Прибыль',
                    field: '_profit',
                    sortBy: 'basic',
                    renderCell: row => (
                      <span className="mono" style={{ display: 'flex', alignItems: 'center', alignContent: 'center', gap: 3, color: 'var(--green)' }}>
                        +{row.currency === 'coins'
                          ? <CoinValue value={fmt(row._profit)} />
                          : <CrystalValue value={fmt(row._profit)} />}
                      </span>
                    ),
                  },
                  {
                    header: 'К получению',
                    field: 'amount_to_collect',
                    sortBy: 'basic',
                    renderCell: row => (
                      <span className="mono" style={{ display: 'flex', alignItems: 'center', alignContent: 'center', gap: 3, fontWeight: 600 }}>
                        {row.currency === 'coins'
                          ? <CoinValue value={fmt(row.amount_to_collect)} />
                          : <CrystalValue value={fmt(row.amount_to_collect)} />}
                      </span>
                    ),
                  },
                  {
                    header: 'Дата вклада',
                    field: 'created_at',
                    sortBy: 'alphanumeric',
                    renderCell: row => (
                      <span className="mono" style={{ color: 'var(--fg-muted)', fontSize: 12, lineHeight: '20px', height: 18 }}>
                        {fmtDate(row.created_at)}
                      </span>
                    ),
                  },
                  {
                    header: 'Дата сбора',
                    field: 'can_collect_at',
                    sortBy: 'alphanumeric',
                    renderCell: row => (
                      <span className="mono" style={{ fontSize: 12, lineHeight: '20px', height: 18 }}>
                        {fmtDate(row.can_collect_at)}
                      </span>
                    ),
                  },
                  {
                    header: 'Статус',
                    field: 'collected',
                    sortBy: 'basic',
                    renderCell: row => (
                      <StatusBadge canCollectAt={row.can_collect_at} collected={row.collected} />
                    ),
                  },
                  {
                    header: '',
                    id: 'actions',
                    align: 'end',
                    // отменять можно только идущий МОНЕТНЫЙ вклад: созревший забирается, собранного уже
                    // нет, кристальный игра отменить не даёт (в её клиенте кнопки нет)
                    renderCell: row => (row.currency === 'coins' && !row.collected && !row._ready) ? (
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button
                        size="small"
                        variant="danger"
                        leadingVisual={XCircleIcon}
                        loading={!!cancelling[row.entry_id]}
                        disabled={!!cancelling[row.entry_id]}
                        onClick={() => setConfirmCancel(row)}
                      >
                        Отменить
                      </Button>
                      </Box>
                    ) : null,
                  },
                ]}
              />
            )}
          </Table.Container>
          )}
        </>

      {confirmCancel && (
        <ConfirmationDialog
          title="Отменить вклад?"
          cancelButtonContent="Не отменять"
          confirmButtonContent="Отменить вклад"
          confirmButtonType="danger"
          onClose={(gesture) => {
            const e = confirmCancel;
            setConfirmCancel(null);
            if (gesture === 'confirm') cancelOne(e);
          }}
        >
          <Text as="p" sx={{ mt: 0 }}>
            Аккаунт <strong>{confirmCancel.account}</strong>: вклад{' '}
            {confirmCancel.currency === 'coins'
              ? <CoinValue value={fmt(confirmCancel.amount_staked)} />
              : <CrystalValue value={fmt(confirmCancel.amount_staked)} />}
            {' '}до {fmtDate(confirmCancel.can_collect_at)}.
          </Text>
          <Text as="p" sx={{ mb: 0, color: 'danger.fg' }}>
            Вклад будет закрыт досрочно, обещанная прибыль{' '}
            {confirmCancel.currency === 'coins'
              ? <CoinValue value={fmt(confirmCancel.amount_to_collect - confirmCancel.amount_staked)} />
              : <CrystalValue value={fmt(confirmCancel.amount_to_collect - confirmCancel.amount_staked)} />}
            {' '}не будет получена. Действие необратимо.
          </Text>
        </ConfirmationDialog>
      )}

      {modalOpen && (
        <StakeModal
          accounts={accounts}
          onClose={() => setModalOpen(false)}
          onStaked={() => { load(true); }}
        />
      )}
    </Box>
  );
}
