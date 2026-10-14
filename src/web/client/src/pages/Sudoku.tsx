import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Text, Label, Spinner, Select } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { ZapIcon, CheckIcon } from '@primer/octicons-react';
import { api, type Account } from '../api';
import { fmt, sortByName } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useUtcMidnightReset } from '../hooks/useUtcMidnightReset';
import { CoinValue } from '../components/Icons';

interface Result { won?: boolean; skipped?: boolean; reward?: number | null; error?: string }

const DIFFICULTIES = [
  { value: 'beginner', label: 'Новичок' },
  { value: 'medium',   label: 'Средний' },
  { value: 'advanced', label: 'Продвинутый' },
  { value: 'expert',   label: 'Эксперт' },
  { value: 'master',   label: 'Мастер (макс. награда)' },
];

export function Sudoku() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [difficulty, setDifficulty] = useState('master');
  const [solvingAll, setSolvingAll] = useState(false);
  const [solvingOne, setSolvingOne] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Map<number, Result>>(new Map());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const [d, st] = await Promise.all([api.accounts(), api.minigameStatus('sudoku')]);
      if (d.ok) {
        const list = sortByName(d.accounts.filter(a => a.hasToken && a.buildings?.includes('wisdom')), 'name');
        setAccounts(list);
        if (st.ok) {
          const byName = new Map(list.map(a => [a.name, a.id]));
          const map = new Map<number, Result>();
          for (const r of st.rows) {
            const id = byName.get(r.account);
            if (id != null) map.set(id, { won: r.won, skipped: true, reward: r.reward });
          }
          setResults(map);
        }
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useUtcMidnightReset(() => { setResults(new Map()); load(); });

  const solveOne = async (id: number, name: string) => {
    setSolvingOne(prev => new Set(prev).add(id));
    try {
      const r = await api.sudokuSolve(id, difficulty);
      if (r.ok) {
        setResults(prev => new Map(prev).set(id, r));
        showFlash(r.skipped ? `[${name}] уже решено` : `[${name}] решено, +${fmt(r.reward ?? 0)}`, true);
      } else { setResults(prev => new Map(prev).set(id, { error: r.error })); showFlash(`[${name}] ${r.error}`, false); }
    } catch (e) { showFlash(String(e), false); }
    finally { setSolvingOne(prev => { const n = new Set(prev); n.delete(id); return n; }); }
  };

  const solveAll = async () => {
    setSolvingAll(true);
    try {
      const d = await api.sudokuSolveAll(difficulty);
      if (d.ok) {
        const map = new Map<number, Result>();
        for (const r of d.results) map.set(r.id, r);
        setResults(map);
        const won = d.results.filter(r => r.ok && r.won && !r.skipped).length;
        const total = d.results.reduce((s, r) => s + (r.ok && r.won && !r.skipped ? (r.reward ?? 0) : 0), 0);
        showFlash(`Решено ${won} аккаунтов · +${fmt(total)} монет`, true);
      } else showFlash('Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setSolvingAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = accounts.map(a => ({ id: a.id, name: a.name, _res: results.get(a.id) }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 1 }}>Судоку</Heading>
      <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>
        Авто-решение ежедневного «Судоку» с получением награды (раз в день на аккаунт).
      </Text>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={difficulty} onChange={e => setDifficulty(e.target.value)} disabled={solvingAll}>
          {DIFFICULTIES.map(d => <Select.Option key={d.value} value={d.value}>{d.label}</Select.Option>)}
        </Select>
        <Button variant="primary" leadingVisual={ZapIcon} loading={solvingAll} disabled={solvingAll} onClick={solveAll}>
          Решить всем
        </Button>
      </Box>

      <Table.Container>
        <DataTable
          data={data}
          columns={[
            {
              header: 'Аккаунт', field: 'name', rowHeader: true, sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.name}</strong>,
            },
            {
              header: 'Результат', field: 'id',
              renderCell: row => {
                const r = row._res;
                if (!r) return <Text sx={{ color: 'fg.muted' }}>—</Text>;
                if (r.error) return <Label variant="danger">{r.error}</Label>;
                if (r.won) return <Label variant="success" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><CheckIcon size={12} /> Решено</Label>;
                return <Label variant="danger">Поражение</Label>;
              },
            },
            {
              header: 'Награда', field: 'id', id: 'reward',
              renderCell: row => row._res?.reward ? <span className="mono"><CoinValue value={fmt(row._res.reward)} /></span> : <Text sx={{ color: 'fg.muted' }}>—</Text>,
            },
            {
              header: '', field: 'id', id: 'action', align: 'end',
              renderCell: row => {
                const done = !!(row._res && !row._res.error);
                return (
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button variant="primary" leadingVisual={ZapIcon}
                      loading={solvingOne.has(row.id)} disabled={done || solvingOne.has(row.id) || solvingAll}
                      onClick={() => solveOne(row.id, row.name)}>
                      {done ? 'Решено' : 'Решить'}
                    </Button>
                  </Box>
                );
              },
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
