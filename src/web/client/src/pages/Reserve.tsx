import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Button, Flash, Heading, Spinner, Text, ToggleSwitch, Label,
  Dialog, TabNav, ButtonGroup, CounterLabel,
} from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import {
  SyncIcon, CheckIcon, ClockIcon, AlertIcon, PlusCircleIcon, ZapIcon, StackAddIcon,
} from '@primer/octicons-react';
import { api, type StakingEntryRow, type StakingAccountInfo } from '../api';
import { fmt, fmtDate } from '../utils';
import { StatCard } from '../components/StatCard';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';
import { Scrollable } from '../components/Scrollable';

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

function AmtBtn({ value, selected, disabled, currency, onClick }: {
  value: number; selected: boolean; disabled: boolean; currency: Currency; onClick: () => void;
}) {
  return (
    <Button
      variant={selected ? 'primary' : 'default'}
      disabled={disabled}
      onClick={onClick}
      sx={{ fontFamily: 'mono', fontSize: 0 }}
    >
      {currency === 'coins' ? <CoinValue value={fmtAmt(value, currency)} /> : <CrystalValue value={fmtAmt(value, currency)} />}
    </Button>
  );
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
  const [staking, setStaking]     = useState<Record<number, boolean>>({});
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
  const toCollect = amount && profit != null ? amount + profit : null;

  // Сбросить выбор при смене валюты
  const switchCurrency = (c: Currency) => {
    setCurrency(c);
    setAmount(null);
    setDuration(null);
    setResults({});
  };

  const slots = (acc: StakingAccountInfo) =>
    currency === 'coins' ? acc.coin_slots : acc.crystal_slots;

  const balance = (acc: StakingAccountInfo) =>
    currency === 'coins' ? acc.coins : acc.crystals;

  const canStake = (acc: StakingAccountInfo) =>
    amount != null && duration != null && slots(acc) < 3 && balance(acc) >= amount;

  const stakeOne = async (acc: StakingAccountInfo) => {
    if (!amount || !duration) return;
    setStaking(s => ({ ...s, [acc.id]: true }));
    const r = await api.stakingStake(acc.id, currency, amount, duration);
    setResults(s => ({ ...s, [acc.id]: r }));
    setStaking(s => ({ ...s, [acc.id]: false }));
    if (r.ok) onStaked();
  };

  const eligible = accounts.filter(canStake);

  const stakeAll = async () => {
    if (!eligible.length) return;
    setStakingAll(true);
    try {
      await Promise.allSettled(eligible.map(stakeOne));
      showFlash(`Вложено для ${eligible.length} аккаунтов`, true);
      onStaked();
    } finally { setStakingAll(false); }
  };

  return (
    <Dialog isOpen onDismiss={onClose} sx={{ maxWidth: 720, width: '95vw' }}>
      <Dialog.Header sx={{ display: 'flex', alignItems: 'center', py: 2, pr: '52px', minHeight: 48 }}>Новый вклад</Dialog.Header>
      <Scrollable style={{ display: 'flex', flexDirection: 'column', gap: 24, maxHeight: '60vh', padding: 8 }}>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>}

        {/* Вкладки валюта */}
        <TabNav aria-label="Валюта">
          <TabNav.Link selected={currency === 'coins'} onClick={() => switchCurrency('coins')}>
            💰 Монеты
          </TabNav.Link>
          <TabNav.Link selected={currency === 'crystals'} onClick={() => switchCurrency('crystals')}>
            💎 Кристаллы
          </TabNav.Link>
        </TabNav>

        {/* Выбор суммы */}
        <Box>
          <Text sx={{ fontSize: 0, fontWeight: 600, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', mb: 2 }}>
            Сумма вклада
          </Text>
          <ButtonGroup>
            {AMOUNTS[currency].map(v => (
              <AmtBtn
                key={v}
                value={v}
                currency={currency}
                selected={amount === v}
                disabled={false}
                onClick={() => setAmount(v)}
              />
            ))}
          </ButtonGroup>
        </Box>

        {/* Выбор срока */}
        <Box>
          <Text sx={{ fontSize: 0, fontWeight: 600, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', mb: 2 }}>
            Срок
          </Text>
          <ButtonGroup>
            {DURATIONS[currency].map(d => (
              <Button
                key={d}
                variant={duration === d ? 'primary' : 'default'}
                onClick={() => setDuration(d)}
                sx={{ fontFamily: 'mono', fontSize: 0 }}
              >
                {d}д — <span style={{ color: duration === d ? 'rgba(255,255,255,0.9)' : 'var(--green)', fontWeight: 700 }}>{(getRate(currency, d) * 100).toFixed(0)}%</span>
              </Button>
            ))}
          </ButtonGroup>
        </Box>

        {/* Итого */}
        {amount && duration && toCollect != null && (
          <Box sx={{ bg: 'canvas.subtle', border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, display: 'flex', gap: 4 }}>
            <Box>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Ставка</Text>
              <Text sx={{ fontWeight: 700, color: 'var(--green)' }}>{((rate ?? 0) * 100).toFixed(0)}%</Text>
            </Box>
            <Box>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Прибыль</Text>
              <Text sx={{ fontWeight: 700, color: 'var(--green)' }}>
                +{currency === 'coins' ? <CoinValue value={fmt(profit!)} /> : <CrystalValue value={fmt(profit!)} />}
              </Text>
            </Box>
            <Box>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>К получению</Text>
              <Text sx={{ fontWeight: 700 }}>
                {currency === 'coins' ? <CoinValue value={fmt(toCollect)} /> : <CrystalValue value={fmt(toCollect)} />}
              </Text>
            </Box>
          </Box>
        )}

        {/* Таблица аккаунтов */}
        <Box>
          <Text sx={{ fontSize: 0, fontWeight: 600, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', mb: 2 }}>
            Аккаунты
          </Text>
          <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-canvas-subtle)', borderBottom: '1px solid var(--color-border-default)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Аккаунт</th>
                  <th style={{ textAlign: 'right', padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Баланс</th>
                  <th style={{ textAlign: 'center', padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Слоты</th>
                  {amount && duration && <th style={{ textAlign: 'right', padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Прибыль</th>}
                  <th style={{ textAlign: 'center', padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Действие</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc, i) => {
                  const sl = slots(acc);
                  const bal = balance(acc);
                  const noSlot = sl >= 3;
                  const noBal  = amount != null && bal < amount;
                  const ok = !noSlot && !noBal && amount != null && duration != null;
                  const res = results[acc.id];
                  return (
                    <tr key={acc.id} style={{ borderBottom: i < accounts.length - 1 ? '1px solid var(--color-border-muted)' : undefined }}>
                      <td style={{ padding: '6px 12px' }}>
                        <strong style={{ opacity: ok ? 1 : 0.5 }}>{acc.name}</strong>
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                        <span style={{ opacity: noBal ? 0.4 : 1, color: noBal ? 'var(--red)' : undefined }}>
                          {currency === 'coins' ? <CoinValue value={fmt(bal)} /> : <CrystalValue value={fmt(bal)} />}
                        </span>
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                        <span style={{ color: noSlot ? 'var(--red)' : sl > 0 ? 'var(--yellow)' : 'var(--green)', fontWeight: 600, fontSize: 12 }}>
                          {sl}/3
                        </span>
                      </td>
                      {amount && duration && (
                        <td style={{ padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--green)' }}>
                          {ok ? <>+{currency === 'coins' ? <CoinValue value={fmt(profit!)} /> : <CrystalValue value={fmt(profit!)} />}</> : '—'}
                        </td>
                      )}
                      <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                        {res && !res.ok
                          ? <Label variant="danger">Ошибка</Label>
                          : (
                            <div style={{ width: 90, display: 'inline-block' }}>
                              <Button
                                variant="primary"
                                leadingVisual={ZapIcon}
                                disabled={!ok || staking[acc.id]}
                                loading={staking[acc.id]}
                                onClick={() => stakeOne(acc)}
                                sx={{ width: '100%', justifyContent: 'center' }}
                              >
                                Вложить
                              </Button>
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Box>
        </Box>
      </Scrollable>
      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', justifyContent: 'flex-end', gap: 2, flexShrink: 0 }}>
        <Button
          variant="primary"
          leadingVisual={StackAddIcon}
          trailingVisual={() => eligible.length > 0 ? <CounterLabel sx={{ bg: 'rgba(255,255,255,0.9)', color: 'success.fg', borderColor: 'transparent' }}>{eligible.length}</CounterLabel> : null}
          disabled={eligible.length === 0 || !amount || !duration || stakingAll}
          loading={stakingAll}
          onClick={stakeAll}
        >
          Вложить всем
        </Button>
      </Box>
    </Dialog>
  );
}

// ── Основная страница ─────────────────────────────────────────────────────────

export function Reserve() {
  const [entries, setEntries]     = useState<StakingEntryRow[]>([]);
  const [accounts, setAccounts]   = useState<StakingAccountInfo[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:staking', () => load());
  const [showCollected, setShowCollected] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
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

  const data = [...entries]
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
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Стейкинг</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Button ref={openBtnRef} leadingVisual={PlusCircleIcon} variant="primary" onClick={() => setModalOpen(true)}>
          Новый вклад
        </Button>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 1 }}>
          <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Собранные</Text>
          {/* Primer ToggleSwitch в управляемом режиме (передан checked) реагирует на клик через
              onClick, а не onChange — onChange там только эффект на смену checked ИЗВНЕ. С onChange
              клик визуально ничего не делал (не менял showCollected) — переключатель "не работал". */}
          <ToggleSwitch size="small" checked={showCollected} onClick={() => setShowCollected(v => !v)} aria-label="Показать собранные" />
        </Box>
        {ready.length > 0 && (
          <Label variant="attention" sx={{ ml: 1 }}>
            <AlertIcon size={14} /> {ready.length} {ready.length === 1 ? 'вклад' : 'вклада'} готово
          </Label>
        )}
      </Box>

      <>
          {active.length > 0 && (
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', marginBottom: 20 }}>
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

          <Table.Container>
            <Table.Title as="h3" id="staking-table">
              {showCollected ? 'Все вклады' : 'Активные вклады'}
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
                ]}
              />
            )}
          </Table.Container>
        </>

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
