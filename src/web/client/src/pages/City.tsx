import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Flash, Heading, Spinner, Text } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type Account, type CityRow } from '../api';
import { fmt } from '../utils';
import { StatCard } from '../components/StatCard';
import { CoinValue, CrystalValue } from '../components/Icons';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

export function City() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cityRows, setCityRows] = useState<CityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:city', () => load());
  const { flash, showFlash } = useFlash();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const [a, c] = await Promise.all([api.accounts(), api.city()]);
    if (a.ok) setAccounts(a.accounts);
    if (c.ok) setCityRows(c.rows);
  }, []);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  // тянет свежие постройки всех городов прямо с игры (не из кэша БД) — та же живая синхронизация,
  // что и кнопка "Обновить" на странице карты одного города, только сразу по всем аккаунтам
  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('city'); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const sum = (f: keyof Account) => accounts.reduce((s, a) => {
    const v = Number(a[f]);
    return s + (isFinite(v) ? v : 0);
  }, 0);
  const avg = (f: keyof Account) => {
    const s = sum(f);
    return accounts.length && isFinite(s) ? s / accounts.length : 0;
  };

  const totalCoins     = sum('balance');
  const totalCrystals  = sum('crystals');
  const totalProfit    = sum('profit');
  const totalProfitFin = sum('profit_final');
  const totalPop       = sum('population');
  const totalPopFin    = sum('population_final');
  const avgHappy       = avg('happiness');
  const avgHappyFin    = avg('happiness_final');

  const cityMap = Object.fromEntries(cityRows.map(r => [r.account, r]));

  const diffColor = (d: number) => d > 0 ? 'var(--green)' : d < 0 ? 'var(--red)' : 'var(--fg-muted)';
  const diff = (current: number, final: number) => {
    const d = (final ?? 0) - (current ?? 0);
    if (!isFinite(d) || d === 0) return { text: '—', color: 'var(--fg-muted)' };
    return { text: (d > 0 ? '+' : '') + fmt(d), color: diffColor(d) };
  };
  const diffPct = (current: number, final: number) => {
    const d = (final ?? 0) - (current ?? 0);
    if (!isFinite(d) || d === 0) return { text: '—', color: 'var(--fg-muted)' };
    return { text: (d > 0 ? '+' : '') + d.toFixed(1) + '%', color: diffColor(d) };
  };

  const data = [...accounts].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })).map(a => ({
    ...a,
    profit_diff:     (a.profit_final ?? 0) - (a.profit ?? 0),
    population_diff: (a.population_final ?? 0) - (a.population ?? 0),
    happiness_diff:  (a.happiness_final ?? 0) - (a.happiness ?? 0),
    hasMap:          !!cityMap[a.name],
  }));

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3, m: 0 }}>Города</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
            Обновить
          </Button>
          <Button onClick={() => navigate('/global-upgrade-plan')}>Общий план улучшений</Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <StatCard label="Монеты" color="cyan">
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CoinValue value={fmt(totalCoins)} /></Text>
        </StatCard>
        <StatCard label="Кристаллы" color="default">
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CrystalValue value={fmt(totalCrystals)} /></Text>
        </StatCard>
        <StatCard label="Прибыль/ч" color="green">
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CoinValue value={fmt(totalProfit)} /></Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>после: <CoinValue value={fmt(totalProfitFin)} /></Text>
        </StatCard>
        <StatCard label="Население" color="ton">
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}>{fmt(totalPop)}</Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>после: {fmt(totalPopFin)}</Text>
        </StatCard>
        <StatCard label="Счастье" color="purple">
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}>{isFinite(avgHappy) ? avgHappy.toFixed(1) : '—'}%</Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>после: {isFinite(avgHappyFin) ? avgHappyFin.toFixed(1) : '—'}%</Text>
        </StatCard>
      </div>

      <Table.Container>
        <DataTable
          data={data}
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
              header: 'Монеты',
              field: 'balance',
              sortBy: 'basic',
              renderCell: row => <span className="mono"><CoinValue value={fmt(row.balance ?? 0)} /></span>,
            },
            {
              header: 'Кристаллы',
              field: 'crystals',
              sortBy: 'basic',
              renderCell: row => <span className="mono"><CrystalValue value={fmt(row.crystals ?? 0)} /></span>,
            },
            {
              header: 'Прибыль/ч',
              field: 'profit',
              sortBy: 'basic',
              renderCell: row => <span className="mono"><CoinValue value={fmt(row.profit ?? 0)} /></span>,
            },
            {
              header: 'После',
              field: 'profit_diff',
              sortBy: 'basic',
              renderCell: row => { const d = diff(row.profit ?? 0, row.profit_final ?? 0); return <span className="mono" style={{ color: d.color }}>{d.text}</span>; },
            },
            {
              header: 'Население',
              field: 'population',
              sortBy: 'basic',
              renderCell: row => <span className="mono">{fmt(row.population ?? 0)}</span>,
            },
            {
              header: 'После',
              field: 'population_diff',
              sortBy: 'basic',
              renderCell: row => { const d = diff(row.population ?? 0, row.population_final ?? 0); return <span className="mono" style={{ color: d.color }}>{d.text}</span>; },
            },
            {
              header: 'Счастье',
              field: 'happiness',
              sortBy: 'basic',
              renderCell: row => <span className="mono">{row.happiness ?? 0}%</span>,
            },
            {
              header: 'После',
              field: 'happiness_diff',
              sortBy: 'basic',
              renderCell: row => { const d = diffPct(row.happiness ?? 0, row.happiness_final ?? 0); return <span className="mono" style={{ color: d.color }}>{d.text}</span>; },
            },
            {
              header: '',
              field: 'hasMap',
              renderCell: row => (
                row.hasMap && (
                  <Button variant="primary"
                    onClick={() => navigate(`/city-map?account=${encodeURIComponent(row.name)}`)}>
                    Карта / Действия
                  </Button>
                )
              ),
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
