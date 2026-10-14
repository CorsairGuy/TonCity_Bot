import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type TownhallAccount } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

export function ThDiversity() {
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

  const data = [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map((a, i) => ({
      id:             i,
      name:           a.name,
      _score:         a.diversity ? Number(a.diversity.score) : -1,
      _variety:       a.diversity ? Number(a.diversity.variety_score) : -1,
      _profit:        a.diversity ? Number(a.diversity.profit_score) : -1,
      _uniqueTypes:   a.diversity?.unique_types ?? -1,
      _totalBuildings:a.diversity?.total_buildings ?? -1,
      // income_bonus — знаковое число (бывает и отрицательным, дебафф), поэтому "нет данных"
      // отмечаем через -Infinity, а не -1 (иначе реальный дебафф вроде -3% ошибочно читался бы
      // как "нет данных" при проверке ">= 0")
      _incomeBonus:   a.diversity?.income_bonus ?? Number.NEGATIVE_INFINITY,
      _hasDiversity:  !!a.diversity,
    }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Разнообразие города</Heading>
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
              header: 'Индекс',
              field: '_score',
              sortBy: 'basic',
              renderCell: row => {
                if (!row._hasDiversity) return <span className="text-muted">—</span>;
                const color = row._score >= 80 ? 'var(--green)' : row._score >= 60 ? 'var(--cyan)' : 'var(--red)';
                return <span className="mono" style={{ color, fontWeight: 600 }}>{row._score.toFixed(1)}%</span>;
              },
            },
            {
              header: 'Застройка',
              field: '_variety',
              sortBy: 'basic',
              renderCell: row => row._hasDiversity
                ? <span className="mono">{row._variety.toFixed(1)}%</span>
                : <span className="text-muted">—</span>,
            },
            {
              header: 'Экономика',
              field: '_profit',
              sortBy: 'basic',
              renderCell: row => row._hasDiversity
                ? <span className="mono">{row._profit.toFixed(1)}%</span>
                : <span className="text-muted">—</span>,
            },
            {
              header: 'Видов зданий',
              field: '_uniqueTypes',
              sortBy: 'basic',
              renderCell: row => row._hasDiversity
                ? <span className="mono">{row._uniqueTypes}</span>
                : <span className="text-muted">—</span>,
            },
            {
              header: 'Всего зданий',
              field: '_totalBuildings',
              sortBy: 'basic',
              renderCell: row => row._hasDiversity
                ? <span className="mono text-muted">{row._totalBuildings}</span>
                : <span className="text-muted">—</span>,
            },
            {
              header: 'Бонус к доходу',
              field: '_incomeBonus',
              sortBy: 'basic',
              // income_bonus — знаковое число, может быть и дебаффом (отрицательным) — не только бонус
              renderCell: row => Number.isFinite(row._incomeBonus)
                ? <span className="mono" style={{ color: row._incomeBonus >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {row._incomeBonus >= 0 ? '+' : ''}{(row._incomeBonus * 100).toFixed(0)}%
                  </span>
                : <span className="text-muted">—</span>,
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
