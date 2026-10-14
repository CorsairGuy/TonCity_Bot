import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type TownhallAccount } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

const DIST_KEYS = ['city', 'activity', 'friends', 'transactions', 'achievements'] as const;
const DIST_LABELS: Record<string, string> = {
  city: 'Развитие города', activity: 'Активность', friends: 'Сеть друзей',
  transactions: 'Транзакции', achievements: 'Достижения',
};

export function ThDistribution() {
  const [accounts, setAccounts] = useState<TownhallAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:townhall', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.townhall();
      if (d.ok) setAccounts([...d.accounts].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('townhall' as Parameters<typeof api.refresh>[0]); await load(); showFlash('Обновлено', true); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = accounts
    .filter(a => a.airdrop != null)
    .map((a, i) => {
      const air = a.airdrop!;
      const total = DIST_KEYS.reduce((s, k) => s + (parseFloat(String(air[k] ?? 0)) || 0), 0);
      return {
        id:           i,
        name:         a.name,
        _total:       total,
        _city:        parseFloat(String(air.city ?? 0)) || 0,
        _activity:    parseFloat(String(air.activity ?? 0)) || 0,
        _friends:     parseFloat(String(air.friends ?? 0)) || 0,
        _transactions:parseFloat(String(air.transactions ?? 0)) || 0,
        _achievements:parseFloat(String(air.achievements ?? 0)) || 0,
        _percentile:  air.percentile ?? Infinity,
      };
    });

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Распределение (Airdrop)</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

      {data.length === 0
        ? <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>Нет данных airdrop</Box>
        : <Table.Container>
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
                  header: 'Итого',
                  field: '_total',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono" style={{ fontWeight: 600, color: 'var(--cyan)' }}>{row._total.toFixed(2)}</span>,
                },
                {
                  header: DIST_LABELS.city,
                  field: '_city',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._city.toFixed(2)}</span>,
                },
                {
                  header: DIST_LABELS.activity,
                  field: '_activity',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._activity.toFixed(2)}</span>,
                },
                {
                  header: DIST_LABELS.friends,
                  field: '_friends',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._friends.toFixed(2)}</span>,
                },
                {
                  header: DIST_LABELS.transactions,
                  field: '_transactions',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._transactions.toFixed(2)}</span>,
                },
                {
                  header: DIST_LABELS.achievements,
                  field: '_achievements',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono">{row._achievements.toFixed(2)}</span>,
                },
                {
                  header: 'Топ',
                  field: '_percentile',
                  sortBy: 'basic',
                  renderCell: row => <span className="mono" style={{ color: 'var(--fg-muted)' }}>{isFinite(row._percentile) ? `Топ ${row._percentile}%` : '—'}</span>,
                },
              ]}
            />
          </Table.Container>
      }
    </Box>
  );
}
