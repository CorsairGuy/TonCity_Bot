import { useState, useEffect, useCallback } from 'react';
import { Box, Button, CounterLabel, Flash, Text, Label } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type FortuneRow, type Account, type FortuneCanDrawResult } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue, IC_CRYSTAL } from '../components/Icons';
import { StatCard } from '../components/StatCard';
import { PageHeader } from '../components/PageHeader';

function unwrapReward(raw: FortuneRow['reward']): Record<string, unknown> {
  if (!raw) return {};
  const r = raw as Record<string, unknown>;
  return (r.reward && typeof r.reward === 'object') ? r.reward as Record<string, unknown> : r;
}

function getRewardType(raw: FortuneRow['reward']): string {
  const r = unwrapReward(raw);
  const t = String(r.reward_type ?? r.type ?? '');
  if (t) return t;
  if (r.item_id != null || r.reward_id != null) return 'item';
  return '—';
}

function getRewardCoins(raw: FortuneRow['reward']): number {
  const r = unwrapReward(raw);
  if (getRewardType(raw) !== 'coins') return 0;
  return parseFloat(String(r.actual_coins ?? r.coins_amount ?? r.amount ?? 0)) || 0;
}

function getRewardCrystals(raw: FortuneRow['reward']): number {
  const r = unwrapReward(raw);
  if (getRewardType(raw) !== 'crystals') return 0;
  return parseFloat(String(r.crystals_amount ?? r.amount ?? 0)) || 0;
}

function RewardCell({ reward }: { reward: FortuneRow['reward'] }) {
  const r = unwrapReward(reward);
  const type = getRewardType(reward);

  if (type === 'coins' || type === 'gold') {
    const n = parseFloat(String(r.actual_coins ?? r.coins_amount ?? r.amount ?? 0)) || 0;
    return <CoinValue value={fmt(n)} />;
  }
  if (type === 'crystals') {
    const n = parseFloat(String(r.crystals_amount ?? r.amount ?? 0)) || 0;
    return <CrystalValue value={fmt(n)} />;
  }
  if (type === 'item') {
    const id = (r.item_id ?? r.reward_id) as number | undefined;
    const qty = Number(r.amount ?? 1);
    const meta = id != null ? (ITEMS_BY_ID[Number(id)] ?? null) : null;
    return (
      <div className="item-card" style={{ gap: 0, display: 'inline-flex' }}>
        <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`}
          style={{ width: 48, height: 48, borderRadius: 8 }}>
          {meta
            ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name}
                style={{ height: 48, scale: String(meta.scale) }}
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
            : <span style={{ fontSize: 9, padding: 2, textAlign: 'center', wordBreak: 'break-all' }}>{String(id ?? '?')}</span>
          }
          {qty > 1 && <span className="item-card__count">{qty}</span>}
        </div>
      </div>
    );
  }
  return <Text sx={{ color: 'fg.muted' }}>{type}</Text>;
}

function AllRewardsCell({ rewards }: { rewards: FortuneRow['reward'][] }) {
  if (!rewards.length) return <Text sx={{ color: 'fg.muted' }}>—</Text>;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {rewards.map((r, i) => <RewardCell key={i} reward={r} />)}
    </div>
  );
}

function SpinStatusCell({ info }: { info: FortuneCanDrawResult | undefined }) {
  if (!info) return <Text sx={{ color: 'fg.subtle', fontSize: 0 }}>—</Text>;
  if (!info.ok) return <Text sx={{ color: 'danger.fg', fontSize: 0 }}>Ошибка</Text>;
  if (!info.can_draw) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Label variant="success" sx={{ fontSize: 0, py: 0 }}>Готово</Label>
        <Text sx={{ color: 'fg.muted', fontSize: 0 }}>{info.spins_made} вращений</Text>
      </Box>
    );
  }
  if (info.cost === 0) {
    return <Label variant="attention" sx={{ fontSize: 0, py: 0 }}>Бесплатно</Label>;
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Label variant="accent" sx={{ fontSize: 0, py: 0 }}>Платное</Label>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12 }}>
        {info.cost} {IC_CRYSTAL}
      </span>
    </Box>
  );
}

export function Fortune() {
  const [rows, setRows] = useState<FortuneRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [canDrawMap, setCanDrawMap] = useState<Map<number, FortuneCanDrawResult>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingCanDraw, setLoadingCanDraw] = useResumableRefresh('fortuneCanDrawAll', () => loadCanDraw());
  const [spinningAll, setSpinningAll] = useState(false);
  const [spinningId, setSpinningId] = useState<number | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const { flash, showFlash } = useFlash();

  const isToday = date === new Date().toISOString().slice(0, 10);

  const loadCanDraw = useCallback(async () => {
    setLoadingCanDraw(true);
    try {
      const d = await api.fortuneCanDrawAll();
      if (d.ok) {
        const m = new Map<number, FortuneCanDrawResult>();
        for (const r of d.results) m.set(r.id, r);
        setCanDrawMap(m);
      }
    } finally { setLoadingCanDraw(false); }
  }, []);

  const load = useCallback(async (d = date) => {
    setLoading(true);
    try {
      const [res, accs] = await Promise.all([
        api.fortuneLog(d),
        api.accounts(),
      ]);
      if (res.ok) setRows(res.rows);
      // только аккаунты, у которых на карте есть Павильон удачи (здания берутся из /progress/)
      if (accs.ok) setAccounts(accs.accounts.filter(a => a.hasToken && a.buildings?.includes('fortune')));
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { load(); }, [date, load]);
  // при открытии подгружаем СОХРАНЁННЫЙ статус из БД (без обращения к игре); живой — только по кнопке
  useEffect(() => {
    if (!isToday) { setCanDrawMap(new Map()); return; }
    api.fortuneStatusStored().then(d => {
      if (d.ok) {
        const m = new Map<number, FortuneCanDrawResult>();
        for (const r of d.results) m.set(r.id, r);
        setCanDrawMap(m);
      }
    }).catch(() => {});
  }, [isToday]);

  const spinAll = async () => {
    setSpinningAll(true);
    try {
      const d = await api.fortuneSpinAll();
      if (d.ok) {
        const ok = d.results.filter(x => x.ok).length;
        const fail = d.results.filter(x => !x.ok).length;
        const totalSpins = d.results.reduce((s, x) => s + (x.spins ?? (x.ok ? 1 : 0)), 0);
        const totalCrystals = d.results.reduce((s, x) => s + (x.crystals_spent ?? 0), 0);
        showFlash(
          totalSpins === 0
            ? 'Прокрутов больше нет ни у одного аккаунта'
            : `Прокручено: ${ok} аккаунтов, ${totalSpins} вращений${totalCrystals > 0 ? `, потрачено ${totalCrystals} 💎` : ''}${fail ? `, ошибок: ${fail}` : ''}`,
          totalSpins > 0
        );
        await Promise.all([load(), loadCanDraw()]);
      }
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setSpinningAll(false); }
  };

  const spinOne = async (acc: Account) => {
    setSpinningId(acc.id);
    try {
      const r = await api.fortuneSpin(acc.id);
      if (r.ok) {
        showFlash(
          r.spins
            ? `[${acc.name}] ${r.spins} вращений${r.crystals_spent ? `, потрачено ${r.crystals_spent} 💎` : ''}`
            : `[${acc.name}] нет доступного прокрута`,
          !!r.spins
        );
        if (r.can_draw) {
          setCanDrawMap(prev => {
            const m = new Map(prev);
            m.set(acc.id, {
              id: acc.id,
              name: acc.name,
              ok: true,
              can_draw: r.can_draw!.can_draw,
              cost: r.can_draw!.cost,
              spins_made: r.can_draw!.spins_made,
              crystals: r.crystals_remaining ?? (prev.get(acc.id)?.crystals ?? 0),
            });
            return m;
          });
        }
        await load();
      } else {
        showFlash(`[${acc.name}] ${r.error ?? 'ошибка'}`, false);
      }
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setSpinningId(null); }
  };

  const spunToday = new Set(rows.map(r => r.account));
  const byAccount = new Map<string, FortuneRow[]>();
  for (const row of rows) {
    if (!byAccount.has(row.account)) byAccount.set(row.account, []);
    byAccount.get(row.account)!.push(row);
  }

  const totCoins = rows.reduce((s, r) => s + getRewardCoins(r.reward), 0);
  const totCr = rows.reduce((s, r) => s + getRewardCrystals(r.reward), 0);
  const totItems = rows.filter(r => getRewardType(r.reward) === 'item').length;

  const tableAccounts = [
    ...accounts.map(a => ({ id: a.id as number, name: a.name })),
    ...[...byAccount.keys()]
      .filter(name => !accounts.find(a => a.name === name))
      .map((name, i) => ({ id: -(i + 1), name })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));

  const availableCount = [...canDrawMap.values()].filter(r => r.can_draw && (r.cost === 0 || r.crystals >= r.cost)).length;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Колесо фортуны" actions={<>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ border: '1px solid var(--color-border-default)', borderRadius: 6, padding: '5px 10px', fontSize: 13, fontFamily: 'inherit' }}
        />
        {isToday && (
          <>
            <Button
              variant="default"
              leadingVisual={SyncIcon}
              loading={loadingCanDraw}
              disabled={loadingCanDraw || spinningAll}
              onClick={loadCanDraw}
            >
              Обновить статус
            </Button>
            <Button
              variant="primary"
              leadingVisual={SyncIcon}
              loading={spinningAll}
              onClick={spinAll}
              disabled={spinningAll || accounts.length === 0 || (canDrawMap.size > 0 && availableCount === 0)}
            >
              Крутить всем{availableCount > 0 && <CounterLabel sx={{ ml: 1, bg: 'white', color: 'success.fg' }}>{availableCount}</CounterLabel>}
            </Button>
          </>
        )}
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}


      {rows.length > 0 && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <StatCard label="Прокруток" color="purple">
            <div style={{ fontSize: 22, fontWeight: 700 }}>{rows.length}</div>
          </StatCard>
          <StatCard label="Монеты" color="yellow">
            <div style={{ fontSize: 22, fontWeight: 700 }}><CoinValue value={fmt(totCoins)} /></div>
          </StatCard>
          <StatCard label="Кристаллы" color="cyan">
            <div style={{ fontSize: 22, fontWeight: 700 }}><CrystalValue value={fmt(totCr)} /></div>
          </StatCard>
          <StatCard label="Предметы" color="red">
            <div style={{ fontSize: 22, fontWeight: 700 }}>{totItems || '—'}</div>
          </StatCard>
        </div>
      )}

      <Table.Container>
        <DataTable
          data={tableAccounts}
          initialSortColumn="name"
          initialSortDirection="ASC"
          columns={[
            {
              header: 'Аккаунт',
              field: 'name',
              rowHeader: true,
              sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.name}</strong>,
            },
            {
              header: 'Награда',
              field: 'name',
              id: 'reward',
              renderCell: row => {
                const accRows = byAccount.get(row.name) ?? [];
                return <AllRewardsCell rewards={accRows.map(r => r.reward)} />;
              },
            },
            ...(isToday ? [
              {
                header: 'Статус',
                field: 'name' as const,
                id: 'status',
                renderCell: (row: { id: number; name: string }) => {
                  const info = row.id > 0 ? canDrawMap.get(row.id) : undefined;
                  return <SpinStatusCell info={info} />;
                },
              },
              {
                header: 'Действие',
                field: 'name' as const,
                id: 'action',
                align: 'end' as const,
                renderCell: (row: { id: number; name: string }) => {
                  const isSpinning = spinningId === row.id;
                  const canAct = (row.id ?? 0) > 0;
                  const info = canAct ? canDrawMap.get(row.id) : undefined;
                  const known = info?.ok === true;          // статус загружен для этого аккаунта
                  const canSpin = !known || info!.can_draw === true;
                  const hasCrystals = !known || info!.cost === 0 || info!.crystals >= info!.cost;
                  const disabled = !canAct || isSpinning || spinningAll || (known && (!info!.can_draw || !hasCrystals));

                  let label = spunToday.has(row.name) ? 'Ещё раз' : 'Крутить';
                  if (known && !info!.can_draw) label = 'Исчерпано';
                  else if (known && info!.cost > 0 && !hasCrystals) label = 'Нет 💎';

                  return (
                    <Button
                      variant={canSpin && hasCrystals ? 'primary' : 'default'}
                      leadingVisual={SyncIcon}
                      loading={isSpinning}
                      disabled={disabled}
                      onClick={() => row.id && spinOne(accounts.find(a => a.id === row.id)!)}
                    >
                      {label}
                    </Button>
                  );
                },
              },
            ] : []),
          ]}
        />
      </Table.Container>
    </Box>
  );
}
