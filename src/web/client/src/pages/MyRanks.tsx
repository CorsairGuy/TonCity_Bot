import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Flash, Text, ProgressBar } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type Account } from '../api';
import { PageHeader } from '../components/PageHeader';
import { LoadError } from '../components/LoadError';
import { CoinValue } from '../components/Icons';
import { fmt } from '../utils';
import { useNarrow, narrowCols } from '../hooks/useNarrow';

// «Мои аккаунты» в рейтинге: место каждого аккаунта (GET /leaderboard/global/me) и серверные
// население/доход (GET /progress/metrics) рядом с тем, что бот сохранил из /progress/. Страница
// читает снимки из БД; игру спрашивает только кнопка «Обновить с игры» (по аккаунтам по очереди).
type Rank = { me?: { rank_population?: number | null; rank_profit?: number | null } };
type Metrics = { population?: number; profit?: number };
type Row = { id: number; name: string; rp: number | null; rf: number | null; mp: number | null; mf: number | null; pop: number; prof: number; at: string | null };

const place = (v: number | null) => v == null ? '—' : `#${v.toLocaleString('ru')}`;

export function MyRanks() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [rank, setRank] = useState<Map<number, { d: Rank | null; at: string | null }>>(new Map());
  const [metrics, setMetrics] = useState<Map<number, Metrics | null>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [sweep, setSweep] = useState<{ done: number; total: number; failed: number } | null>(null);
  const narrow = useNarrow();

  const load = async () => {
    const [a, r, m] = await Promise.all([api.accounts(), api.extraAll<Rank>('rank'), api.extraAll<Metrics>('metrics')]);
    if (!a.ok) { setErr((a as { error?: string }).error ?? 'Ошибка загрузки'); return; }
    setAccounts(a.accounts);
    if (r.ok) setRank(new Map(r.rows.map(x => [x.account_id, { d: x.data, at: x.updated_at }])));
    if (m.ok) setMetrics(new Map(m.rows.map(x => [x.account_id, x.data])));
  };
  useEffect(() => { load(); }, []);

  const refreshAll = async () => {
    const list = (accounts ?? []);
    setSweep({ done: 0, total: list.length, failed: 0 });
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      const r1 = await api.extraRefresh<Rank>('rank', list[i].id);
      const r2 = await api.extraRefresh<Metrics>('metrics', list[i].id);
      if (!r1.ok || !r2.ok) failed++;
      setSweep({ done: i + 1, total: list.length, failed });
    }
    await load();
    setSweep(s => s && { ...s, done: s.total });
  };

  const rows: Row[] = useMemo(() => (accounts ?? []).map(a => {
    const r = rank.get(a.id), m = metrics.get(a.id);
    return { id: a.id, name: a.name, rp: r?.d?.me?.rank_population ?? null, rf: r?.d?.me?.rank_profit ?? null, mp: m?.population ?? null, mf: m?.profit ?? null, pop: a.population, prof: a.profit, at: r?.at ?? null };
  }), [accounts, rank, metrics]);

  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={load} /></Box>;
  const busy = !!sweep && sweep.done < sweep.total;
  const mism = (a: number | null, b: number) => a != null && b > 0 && Math.abs(a - b) / b > 0.01;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Мои аккаунты в рейтинге" sub="Место в «Величайших мэрах» и показатели города по данным игры"
        actions={<Button leadingVisual={SyncIcon} loading={busy} disabled={busy || !accounts?.length} onClick={refreshAll}>Обновить с игры</Button>} />
      {sweep && (
        <Box sx={{ mb: 3 }}>
          <ProgressBar progress={sweep.total ? sweep.done / sweep.total * 100 : 100} sx={{ mb: 1 }} />
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{sweep.done} из {sweep.total}{sweep.failed ? ` · ошибок: ${sweep.failed}` : ''}</Text>
        </Box>
      )}
      {rows.some(r => mism(r.mp, r.pop) || mism(r.mf, r.prof)) && <Flash variant="warning" sx={{ mb: 3 }}>У части аккаунтов показатели игры расходятся с сохранёнными ботом больше чем на 1% (выделены). Обычно это значит, что снимок города устарел.</Flash>}
      <Table.Container>
        <DataTable data={rows} initialSortColumn="rp" initialSortDirection="ASC"
          columns={narrowCols<Row>(narrow, ['name', 'rp', 'rf'], [
            { header: 'Аккаунт', field: 'name', rowHeader: true, sortBy: 'alphanumeric', renderCell: r => <strong>{r.name}</strong> },
            { header: 'Место · население', field: 'rp', sortBy: (a, b) => (a.rp ?? 1e12) - (b.rp ?? 1e12), renderCell: r => <Text sx={{ fontVariantNumeric: 'tabular-nums' }}>{place(r.rp)}</Text> },
            { header: 'Место · доход', field: 'rf', sortBy: (a, b) => (a.rf ?? 1e12) - (b.rf ?? 1e12), renderCell: r => <Text sx={{ fontVariantNumeric: 'tabular-nums' }}>{place(r.rf)}</Text> },
            { header: 'Население (игра)', field: 'mp', sortBy: 'basic', renderCell: r => <Text sx={{ color: mism(r.mp, r.pop) ? 'attention.fg' : undefined }}>{r.mp == null ? '—' : fmt(r.mp)}</Text> },
            { header: 'Доход/ч (игра)', field: 'mf', sortBy: 'basic', renderCell: r => r.mf == null ? <Text sx={{ color: 'fg.muted' }}>—</Text> : <Text sx={{ color: mism(r.mf, r.prof) ? 'attention.fg' : undefined }}><CoinValue value={fmt(r.mf)} /></Text> },
            { header: 'Обновлено', field: 'at', renderCell: r => <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{r.at ? new Date(r.at).toLocaleString('ru') : 'нет данных'}</Text> },
          ])} />
      </Table.Container>
    </Box>
  );
}
