import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type MarketStatsRow } from '../api';
import { fmt } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CrystalValue } from '../components/Icons';

const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));
const ton = (v: number | null | undefined) => (v == null ? '0' : Number(v).toFixed(2));

export function MarketStats() {
  const [rows, setRows] = useState<MarketStatsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('marketStatsRefresh', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.marketStats();
      if (d.ok) setRows([...d.rows].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true })));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.marketStatsRefresh();
      if (d.ok) {
        const errs = d.results.filter(r => !r.ok);
        await load();
        showFlash(errs.length ? `Обновлено, ошибки: ${errs.map(e => e.name).join(', ')}` : 'Обновлено', errs.length === 0);
      } else showFlash('Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = rows.map((r, i) => ({
    id: i,
    account: r.account,
    _purchases: num(r.total_purchases),
    _sales: num(r.total_sales),
    _crEarned: num(r.total_crystals_earned),
    _crSpent: num(r.total_crystals_spent),
    _tonEarned: num(r.total_ton_earned),
    _tonSpent: num(r.total_ton_spent),
  }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Статистика рынка</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

      {data.length === 0
        ? <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>Нет данных — нажмите «Обновить»</Box>
        : <Table.Container>
            <DataTable
              data={data}
              initialSortColumn="account"
              initialSortDirection="ASC"
              columns={[
                {
                  header: 'Аккаунт', field: 'account', rowHeader: true, sortBy: 'alphanumeric',
                  renderCell: row => <strong>{row.account}</strong>,
                },
                {
                  header: 'Покупки', field: '_purchases', sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._purchases}</span>,
                },
                {
                  header: 'Продажи', field: '_sales', sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._sales}</span>,
                },
                {
                  header: 'Кристаллы получено', field: '_crEarned', sortBy: 'basic',
                  renderCell: row => <span className="mono" style={{ color: 'var(--green)' }}><CrystalValue value={fmt(row._crEarned)} /></span>,
                },
                {
                  header: 'Кристаллы потрачено', field: '_crSpent', sortBy: 'basic',
                  renderCell: row => <span className="mono"><CrystalValue value={fmt(row._crSpent)} /></span>,
                },
                {
                  header: 'TON получено', field: '_tonEarned', sortBy: 'basic',
                  renderCell: row => <span className="mono" style={{ color: 'var(--green)' }}>▽ {ton(row._tonEarned)}</span>,
                },
                {
                  header: 'TON потрачено', field: '_tonSpent', sortBy: 'basic',
                  renderCell: row => <span className="mono">▽ {ton(row._tonSpent)}</span>,
                },
              ]}
            />
          </Table.Container>
      }
      {rows[0]?.updated_at && (
        <Text sx={{ display: 'block', mt: 2, fontSize: 0, color: 'fg.muted' }}>
          Обновлено: {new Date(rows[0].updated_at).toLocaleString()}
        </Text>
      )}
    </Box>
  );
}
