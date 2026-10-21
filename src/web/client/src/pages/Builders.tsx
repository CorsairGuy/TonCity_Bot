import { useState, useEffect } from 'react';
import { Box, Button, Flash, Text, Spinner, Label } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type BuilderRow, type BuilderLiveRow } from '../api';
import { fmt } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CoinIcon, CrystalIcon } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { useNarrow, narrowCols } from '../hooks/useNarrow';

type Row = BuilderRow & Partial<BuilderLiveRow>;

function BuilderCount({ row }: { row: Row }) {
  if (row.max_builders != null) {
    // live data available
    const current = row.count ?? 0;
    const max = row.max_builders;
    const full = current === max;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Text sx={{ fontFamily: 'mono', fontSize: 1, fontWeight: 'bold', color: full ? 'success.fg' : 'fg.default' }}>
          {current} / {max}
        </Text>
      </Box>
    );
  }
  return <Text sx={{ fontFamily: 'mono', fontSize: 1 }}>{row.count !== null ? row.count : '—'}</Text>;
}

function SlotBadge({ bought, max }: { bought: number; max: number }) {
  if (max === 0) return null;
  const full = bought >= max;
  return (
    <Text sx={{ fontSize: 0, fontFamily: 'mono', color: full ? 'danger.fg' : 'success.fg', fontWeight: 'bold' }}>
      {bought}/{max}
    </Text>
  );
}

export function Builders() {
  const narrow = useNarrow();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('buildersRefreshAll', () => load());
  const [buying, setBuying] = useState<Set<number>>(new Set());
  const [buyType, setBuyType] = useState<Record<number, string>>({});
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const [d, accs] = await Promise.all([api.builders(), api.accounts()]);
      if (d.ok) {
        const balMap = new Map((accs.ok ? accs.accounts : []).map((a: { id: number; balance: number | null; crystals: number | null }) => [a.id, { balance: a.balance, crystals: a.crystals }]));
        setRows([...d.rows]
          .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
          .map(r => ({ ...r, ...balMap.get(r.id) })) as Row[]);
      }
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.refreshBuildersAll();
      if (d.ok) {
        const liveMap = new Map(d.rows.map(r => [r.id, r]));
        setRows(prev => prev.map(r => {
          const live = liveMap.get(r.id);
          return live ? { ...r, ...live } : r;
        }));
        const errors = d.rows.filter(r => r.error);
        if (errors.length) showFlash(`Ошибки: ${errors.map(r => r.name).join(', ')}`, false);
        else showFlash('Обновлено', true);
      }
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  const buyOne = async (id: number, name: string, type: string) => {
    setBuying(prev => new Set(prev).add(id));
    try {
      const d = await api.buyBuilder(id, type);
      if (d.ok) {
        showFlash(`[${name}] куплен строитель`, true);
        // update row with fresh data returned by server
        setRows(prev => prev.map(r => r.id === id ? {
          ...r,
          count: (d as { count?: number }).count ?? r.count,
          max_builders: (d as { max_builders?: number }).max_builders ?? r.max_builders,
          cnt_coins: (d as { cnt_coins?: number }).cnt_coins ?? r.cnt_coins,
          max_coins: (d as { max_coins?: number }).max_coins ?? r.max_coins,
          cnt_stars: (d as { cnt_stars?: number }).cnt_stars ?? r.cnt_stars,
          max_stars: (d as { max_stars?: number }).max_stars ?? r.max_stars,
          price_coins: (d as { price_coins?: number }).price_coins ?? r.price_coins,
          price_stars: (d as { price_stars?: number }).price_stars ?? r.price_stars,
          balance: (d as { balance?: number }).balance ?? r.balance,
          crystals: (d as { crystals?: number }).crystals ?? r.crystals,
        } : r));
      } else {
        showFlash(`[${name}] ${d.error}`, false);
      }
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setBuying(prev => { const n = new Set(prev); n.delete(id); return n; }); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = [...rows]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map(a => ({
      ...a,
      _priceCoins: a.price_coins ?? 0,
      _priceStars: a.price_stars ?? 0,
      _count: a.count ?? -1,
      _updatedAt: a.updated_at ? new Date(a.updated_at).getTime() : 0,
    }));

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Строители" actions={<>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Table.Container>
        <DataTable
          data={data}
          initialSortColumn="name"
          initialSortDirection="ASC"
          columns={narrowCols<typeof data[number]>(narrow, ['name', '_count', 'action'], [
            {
              header: 'Аккаунт',
              field: 'name',
              rowHeader: true,
              sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.name}</strong>,
            },
            {
              header: 'Строители',
              field: '_count',
              sortBy: 'basic',
              renderCell: row => <BuilderCount row={row} />,
            },
            {
              header: 'Куплено (монеты)',
              field: 'cnt_coins',
              sortBy: 'basic',
              renderCell: row => (
                row.max_coins != null
                  ? <SlotBadge bought={row.cnt_coins ?? 0} max={row.max_coins ?? 0} />
                  : <Text sx={{ color: 'fg.muted' }}>—</Text>
              ),
            },
            {
              header: 'Куплено (звёзды)',
              field: 'cnt_stars',
              sortBy: 'basic',
              renderCell: row => (
                row.max_stars != null
                  ? <SlotBadge bought={row.cnt_stars ?? 0} max={row.max_stars ?? 0} />
                  : <Text sx={{ color: 'fg.muted' }}>—</Text>
              ),
            },
            {
              header: 'Цена (монеты)',
              field: '_priceCoins',
              sortBy: 'basic',
              renderCell: row => <span className="mono">{row._priceCoins ? <CoinValue value={fmt(row._priceCoins)} /> : '—'}</span>,
            },
            {
              header: 'Цена (звёзды)',
              field: '_priceStars',
              sortBy: 'basic',
              renderCell: row => <span className="mono">{row._priceStars ? `⭐ ${row._priceStars}` : '—'}</span>,
            },
            {
              header: 'Обновлено',
              field: '_updatedAt',
              sortBy: 'basic',
              renderCell: row => (
                <span className="mono" style={{ fontSize: 11 }}>
                  {row.updated_at ? new Date(row.updated_at).toLocaleDateString() : '—'}
                </span>
              ),
            },
            {
              header: '',
              field: 'name',
              id: 'action',
              align: 'end',
              renderCell: row => {
                const coinsFull = row.max_coins != null && (row.cnt_coins ?? 0) >= row.max_coins;
                const starsFull = row.max_stars != null && (row.cnt_stars ?? 0) >= row.max_stars;
                const coinsAffordable = row.price_coins == null || row.balance == null || row.balance >= row.price_coins;
                const starsAffordable = row.price_stars == null || row.crystals == null || row.crystals >= row.price_stars;
                const disableCoins = buying.has(row.id) || coinsFull || !coinsAffordable;
                const disableStars = buying.has(row.id) || starsFull || !starsAffordable;
                return (
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
                    <Button
                      variant="primary"
                      loading={buying.has(row.id) && buyType[row.id] === 'coins'}
                      disabled={disableCoins}
                      leadingVisual={() => <CoinIcon size={14} />}
                      onClick={() => { setBuyType(prev => ({ ...prev, [row.id]: 'coins' })); buyOne(row.id, row.name, 'coins'); }}
                    >
                      Купить
                    </Button>
                    <Button
                      variant="primary"
                      loading={buying.has(row.id) && buyType[row.id] === 'stars'}
                      disabled={disableStars}
                      leadingVisual={() => <CrystalIcon size={14} />}
                      onClick={() => { setBuyType(prev => ({ ...prev, [row.id]: 'stars' })); buyOne(row.id, row.name, 'stars'); }}
                    >
                      Купить
                    </Button>
                  </Box>
                );
              },
            },
          ])}
        />
      </Table.Container>
    </Box>
  );
}
