import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type DailyAccount } from '../api';
import { fmt, sortByName, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';

function RewardCell({ reward }: { reward: unknown }) {
  if (!reward) return <span className="text-muted">—</span>;
  const rw = reward as Record<string, unknown>;
  const type = String(rw.type ?? '');
  if (type === 'coins' || typeof reward === 'number') {
    const n = typeof reward === 'number' ? reward : Number(rw.amount ?? 0);
    return <CoinValue value={fmt(n)} />;
  }
  if (type === 'crystals') return <CrystalValue value={fmt(Number(rw.amount ?? 0))} />;
  if (type === 'item') {
    const id = rw.item_id != null ? Number(rw.item_id) : null;
    const qty = Number(rw.amount ?? 1);
    const meta = id != null ? (ITEMS_BY_ID[Number(id)] ?? null) : null;
    return (
      <div className="item-card" style={{ gap: 0, display: 'inline-flex' }}>
        <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`}
          style={{ width: 48, height: 48, borderRadius: 8 }}>
          {meta
            ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name}
                style={{ height: 48, scale: String(meta.scale) }}
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
            : <span style={{ fontSize: 9, padding: 2, textAlign: 'center' }}>{String(id ?? '?')}</span>
          }
          {qty > 1 && <span className="item-card__count">{qty}</span>}
        </div>
      </div>
    );
  }
  return <span className="text-muted mono" style={{ fontSize: 11 }}>{JSON.stringify(reward)}</span>;
}

export function Daily() {
  const [accounts, setAccounts] = useState<DailyAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:daily', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.dailyLog();
      if (d.ok) setAccounts(sortByName(d.accounts, 'name'));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('daily'); await load(); showFlash('Обновлено', true); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  const today = new Date().toISOString().slice(0, 10);

  const data = [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map((a, i) => {
      const last = a.entries && a.entries.length > 0 ? a.entries[0] : null;
      const rw = last?.reward as Record<string, unknown> | null | undefined;
      const rewardVal = rw
        ? (Number(rw.amount ?? rw.coins_amount ?? rw.actual_coins ?? 0) || 0)
        : 0;
      return {
        id:           i,
        name:         a.name,
        _loggedAt:    last?.logged_at ?? '',
        _day:         last?.day ?? 0,
        _isToday:     last?.logged_at === today ? 1 : 0,
        _last:        last,
        _rewardValue: rewardVal,
      };
    });

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Ежедневная награда</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

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
              header: 'Последний вход',
              field: '_loggedAt',
              sortBy: 'alphanumeric',
              renderCell: row => (
                <span className="mono" style={{ color: row._isToday ? 'var(--green)' : 'var(--fg-muted)' }}>
                  {row._last?.logged_at ?? '—'}
                </span>
              ),
            },
            {
              header: 'День',
              field: '_day',
              sortBy: 'basic',
              renderCell: row => (
                <span className="mono">{row._last?.day != null ? `День ${row._last.day}` : '—'}</span>
              ),
            },
            {
              header: 'Награда',
              field: '_rewardValue',
              sortBy: 'basic',
              renderCell: row => <RewardCell reward={row._last?.reward} />,
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
