import { useEffect, useState } from 'react';
import { Box, Button, Flash, Select, Text } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type Account, type ExtraKind } from '../api';
import { useExtra } from '../hooks/useExtra';

// Журнал из игры для выбранного аккаунта: история позиций Башни Сатоши (/satoshi-tower/positions/history)
// или операции кошелька GRAM (/market/toncoin/transactions). Колонки берутся из самого ответа:
// формат строк игра не документирует, поэтому показываем простые поля как есть, суммы в нанотонах — в GRAM.
const listOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === 'object') for (const v of Object.values(d as Record<string, unknown>)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  return [];
};
const cell = (k: string, v: unknown): string => {
  if (v == null) return '—';
  if (typeof v === 'number' && /nanoton/i.test(k)) return `${(v / 1e9).toFixed(3)} GRAM`;
  if (typeof v === 'string' && /_at$|time|date/i.test(k) && !isNaN(Date.parse(v))) return new Date(v).toLocaleString('ru');
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('ru') : v.toFixed(4);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

export function GameLogModal({ kind, title, onClose }: { kind: Extract<ExtraKind, 'satoshi-history' | 'gram-tx'>; title: string; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [acc, setAcc] = useState<number | null>(null);
  useEffect(() => { api.accounts().then(r => { if (r.ok) { setAccounts(r.accounts); setAcc(r.accounts[0]?.id ?? null); } }); }, []);
  const x = useExtra<unknown>(kind, acc);
  const rows = listOf(x.data);
  const cols = [...new Set(rows.slice(0, 50).flatMap(r => Object.keys(r).filter(k => r[k] == null || typeof r[k] !== 'object')))].slice(0, 9);
  return (
    <Dialog title={title} onClose={onClose} width="xlarge" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
        <Select aria-label="Аккаунт" value={acc != null ? String(acc) : ''} onChange={e => setAcc(Number(e.target.value))}>
          {accounts.map(a => <Select.Option key={a.id} value={String(a.id)}>{a.name}</Select.Option>)}
        </Select>
        <Text sx={{ fontSize: 0, color: 'fg.muted', flex: 1 }}>{x.updatedAt ? `Снимок от ${new Date(x.updatedAt).toLocaleString('ru')}` : 'Ещё не загружалось'}</Text>
        <Button leadingVisual={SyncIcon} loading={x.refreshing} disabled={acc == null} onClick={x.refresh}>Обновить с игры</Button>
      </Box>
      {x.error && <Flash variant="danger" sx={{ mb: 2 }}>{x.error}</Flash>}
      {!rows.length
        ? <Text sx={{ color: 'fg.muted', display: 'block', py: 3, textAlign: 'center' }}>{x.updatedAt ? 'Записей нет' : 'Нажмите «Обновить с игры»'}</Text>
        : (
          <Box sx={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c} className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{cell(c, r[c])}</td>)}</tr>)}</tbody>
            </table>
          </Box>
        )}
    </Dialog>
  );
}
