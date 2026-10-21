import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Flash, Spinner, Text } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type CapitalRow } from '../api';
import { fmt, fmtCr } from '../utils';
import { StatCard } from '../components/StatCard';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { LoadError, errText } from '../components/LoadError';
import { useNarrow, narrowCols } from '../hooks/useNarrow';

export function Capitals() {
  const [rows, setRows] = useState<CapitalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const narrow = useNarrow();
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:capitals', () => load());
  const { flash, showFlash } = useFlash();
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.capitals();
      if (d.ok) { setRows(d.rows); setLoadErr(''); }
      else setLoadErr(errText(d));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('capitals' as Parameters<typeof api.refresh>[0]); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const totalCoins          = rows.reduce((s, r) => s + (r.coins ?? 0), 0);
  const totalCrystals       = rows.reduce((s, r) => s + (r.crystals ?? 0), 0);
  const totalProfit         = rows.reduce((s, r) => s + (r.profit_coins ?? 0), 0);
  const totalProfitFinal    = rows.reduce((s, r) => s + (r.profit_coins_final ?? 0), 0);
  const totalProfitCr       = rows.reduce((s, r) => s + (r.profit_crystals ?? 0), 0);
  const totalProfitCrFinal  = rows.reduce((s, r) => s + (r.profit_crystals_final ?? 0), 0);

  const diffColor = (d: number) => d > 0 ? 'var(--green)' : d < 0 ? 'var(--red)' : 'var(--fg-muted)';
  const diff = (current: number, final: number) => {
    const d = (final ?? 0) - (current ?? 0);
    if (!isFinite(d) || d === 0) return { text: '—', color: 'var(--fg-muted)' };
    return { text: (d > 0 ? '+' : '') + fmt(d), color: diffColor(d) };
  };
  // diff для алмазов — точное число без сокращений
  const diffCr = (current: number, final: number) => {
    const d = (final ?? 0) - (current ?? 0);
    if (!isFinite(d) || d === 0) return { text: '—', color: 'var(--fg-muted)' };
    return { text: (d > 0 ? '+' : '') + fmtCr(d), color: diffColor(d) };
  };

  const data = [...rows]
    .sort((a, b) => a.guild_title.localeCompare(b.guild_title, 'ru', { numeric: true }))
    .map((r, i) => ({
      id:                    i,
      guild_title:           r.guild_title,
      _coins:                r.coins ?? 0,
      _crystals:             r.crystals ?? 0,
      _profit_coins:         r.profit_coins ?? 0,
      _profit_coins_diff:    r.profit_coins_final != null ? r.profit_coins_final - (r.profit_coins ?? 0) : null,
      _profit_crystals:      r.profit_crystals ?? 0,
      _profit_crystals_diff: r.profit_crystals_final != null ? r.profit_crystals_final - (r.profit_crystals ?? 0) : null,
      _hasMap:               (r.buildings ?? []).length > 0,
    }));

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Столицы" actions={<>
        <Button onClick={() => navigate('/global-capital-upgrade-plan')}>Общий план улучшений</Button>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <LoadError error={loadErr} onRetry={load} />

      {loadErr ? null : rows.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : (
          <>
            <div className="stat-grid stat-grid--reserve">
              <StatCard label="Монеты" color="cyan">
                <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CoinValue value={fmt(totalCoins)} /></Text>
              </StatCard>
              <StatCard label="Кристаллы" color="default">
                <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CrystalValue value={fmt(totalCrystals)} /></Text>
              </StatCard>
              <StatCard label="Прибыль/ч" color="green">
                <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CoinValue value={fmt(totalProfit)} /></Text>
                {totalProfitFinal > 0 && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>после: <CoinValue value={fmt(totalProfitFinal)} /></Text>}
              </StatCard>
              <StatCard label="Приб.кр/ч" color="purple">
                <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}><CrystalValue value={fmtCr(totalProfitCr)} /></Text>
                {totalProfitCrFinal > 0 && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>после: <CrystalValue value={fmtCr(totalProfitCrFinal)} /></Text>}
              </StatCard>
            </div>

            <Table.Container>
              <DataTable
                data={data}
                initialSortColumn="guild_title"
                initialSortDirection="ASC"
                columns={narrowCols<typeof data[number]>(narrow, ['guild_title', '_profit_coins', '_profit_crystals', '_hasMap'], [
                  {
                    header: 'Гильдия',
                    field: 'guild_title',
                    rowHeader: true,
                    sortBy: 'alphanumeric',
                    renderCell: row => <strong>{row.guild_title}</strong>,
                  },
                  {
                    header: 'Монеты',
                    field: '_coins',
                    sortBy: 'basic',
                    renderCell: row => <span className="mono"><CoinValue value={fmt(row._coins)} /></span>,
                  },
                  {
                    header: 'Кристаллы',
                    field: '_crystals',
                    sortBy: 'basic',
                    renderCell: row => <span className="mono"><CrystalValue value={fmt(row._crystals)} /></span>,
                  },
                  {
                    header: 'Прибыль/ч',
                    field: '_profit_coins',
                    sortBy: 'basic',
                    renderCell: row => <span className="mono"><CoinValue value={fmt(row._profit_coins)} /></span>,
                  },
                  {
                    header: 'Прибыль после',
                    field: '_profit_coins_diff',
                    sortBy: 'basic',
                    renderCell: row => {
                      if (row._profit_coins_diff == null) return <span className="mono" style={{ color: 'var(--fg-muted)' }}>—</span>;
                      const d = diff(row._profit_coins, row._profit_coins + row._profit_coins_diff);
                      return <span className="mono" style={{ color: d.color }}>{d.text}</span>;
                    },
                  },
                  {
                    header: 'Приб.кр/ч',
                    field: '_profit_crystals',
                    sortBy: 'basic',
                    renderCell: row => row._profit_crystals > 0
                      ? <span className="mono"><CrystalValue value={fmtCr(row._profit_crystals)} /></span>
                      : <span className="mono" style={{ color: 'var(--fg-muted)' }}>—</span>,
                  },
                  {
                    header: 'Приб.кр после',
                    field: '_profit_crystals_diff',
                    sortBy: 'basic',
                    renderCell: row => {
                      if (row._profit_crystals_diff == null) return <span className="mono" style={{ color: 'var(--fg-muted)' }}>—</span>;
                      const d = diffCr(row._profit_crystals, row._profit_crystals + row._profit_crystals_diff);
                      return <span className="mono" style={{ color: d.color }}>{d.text}</span>;
                    },
                  },
                  {
                    header: '',
                    field: '_hasMap',
                    align: 'end',
                    renderCell: row => (
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                        {row._hasMap
                          ? <Button variant="primary"
                              onClick={() => navigate(`/city-map?account=${encodeURIComponent(row.guild_title)}&type=capital`)}>
                              Карта
                            </Button>
                          : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>—</Text>}
                      </Box>
                    ),
                  },
                ])}
              />
            </Table.Container>
          </>
        )
      }
    </Box>
  );
}
