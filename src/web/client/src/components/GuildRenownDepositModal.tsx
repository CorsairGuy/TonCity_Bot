import { useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, Flash, Text, TextInput, Spinner } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type GuildMembership } from '../api';
import { useAsk } from '../hooks/useAsk';
import { LoadError } from './LoadError';
import { RenownValue } from './Icons';
import { Summary, Tile, SumLine } from '../pages/cityMapPanels';

type Balance = { balance?: number | null; guild_id?: string };
type Saved = { max: number | null; updatedAt: string | null; error?: string };
type Result = { name: string; ok: boolean; msg: string };
const card = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 1 } as const;
const maximum = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value)));

export function GuildRenownDepositModal({ rows, onClose, onChanged }: { rows: GuildMembership[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const guildId = rows[0]?.guild_id;
  const members = rows.filter((r, i) => r.account_id != null && r.guild_id === guildId && rows.findIndex(x => x.account_id === r.account_id) === i);
  const [saved, setSaved] = useState<Record<number, Saved>>({});
  const [uncertain, setUncertain] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null), [results, setResults] = useState<Result[]>([]);
  const lock = useRef(false), alive = useRef(true);
  const ask = useAsk();
  const ids = members.map(m => m.account_id!).join(',');
  const read = async (live = false) => {
    const data: Record<number, Saved> = {};
    await Promise.all(members.map(async m => {
      try {
        const r = live ? await api.extraRefresh<Balance>('renown', m.account_id!) : await api.extra<Balance>('renown', m.account_id!);
        if (!r.ok) { data[m.account_id!] = { max: null, updatedAt: null, error: r.error ?? 'Ошибка загрузки' }; return; }
        const matches = !r.data?.guild_id || String(r.data.guild_id) === m.guild_id;
        data[m.account_id!] = { max: matches ? maximum(r.data?.balance) : null, updatedAt: r.updated_at, error: matches ? undefined : 'Снимок другой гильдии — обновите Почёт' };
      } catch (e) { data[m.account_id!] = { max: null, updatedAt: null, error: String(e) }; }
    }));
    if (alive.current) { setSaved(data); if (live) setUncertain(old => new Set([...old].filter(id => data[id]?.max == null))); setSelected(old => new Set([...old].filter(id => data[id]?.max != null && data[id].max! > 0))); }
    return data;
  };
  useEffect(() => {
    alive.current = true; setLoading(true); setError(null);
    void read().catch(e => { if (alive.current) setError(String(e)); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [ids, guildId]);
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true; setRefreshing(true); setError(null);
    try { await read(true); setAmounts({}); setResults([]); }
    catch (e) { setError(String(e)); } finally { lock.current = false; setRefreshing(false); }
  };
  const choose = (id: number, value: number) => setAmounts(old => ({ ...old, [id]: String(Math.max(0, Math.min(saved[id]?.max ?? 0, Math.floor(value)))) }));
  const choices = members.map(row => {
    const id = row.account_id!, max = uncertain.has(id) ? null : saved[id]?.max ?? null, amount = Number(amounts[id] ?? 0);
    return { row, id, max, amount, valid: selected.has(id) && max != null && Number.isSafeInteger(amount) && amount > 0 && amount <= max };
  });
  const invalidSelection = choices.some(x => selected.has(x.id) && amounts[x.id] !== undefined && amounts[x.id] !== '' && (!Number.isSafeInteger(x.amount) || x.amount < 0 || x.max == null || x.amount > x.max));
  const payees = choices.filter(x => x.valid), total = payees.reduce((sum, x) => sum + x.amount, 0);
  const pay = async () => {
    if (lock.current || !payees.length || loading || refreshing || invalidSelection) return;
    lock.current = true; setBusy(true); setResults([]);
    const batch = payees.map(x => ({ ...x }));
    try {
      if (!await ask('Внести Почёт в гильдию?', <Box><Text>Гильдия «{rows[0]?.guild_title}». Всего <RenownValue value={total.toLocaleString('ru')} />.</Text>{batch.map(x => <Text key={x.id} sx={{ display: 'block' }}>{x.row.account}: {x.amount.toLocaleString('ru')}</Text>)}</Box>, { ok: 'Внести' })) return;
      const out: Result[] = [];
      for (const member of batch) {
        try {
          const r = await api.extraAction<Balance>('renown-deposit', { account_id: member.id, expected_guild_id: member.row.guild_id, amount: member.amount });
          const detail = r as typeof r & { refresh_error?: string };
          if (!r.data && alive.current) setUncertain(old => new Set(old).add(member.id));
          out.push({ name: member.row.account, ok: r.ok, msg: r.ok ? `Внесено ${member.amount.toLocaleString('ru')} Почёта${detail.refresh_error ? '; часть данных не обновлена' : ''}` : r.error ?? 'Ошибка взноса. Проверьте историю перед повтором.' });
        } catch (e) { if (alive.current) setUncertain(old => new Set(old).add(member.id)); out.push({ name: member.row.account, ok: false, msg: `${String(e)}. Проверьте историю перед повтором.` }); }
        if (alive.current) setResults([...out]);
      }
      setAmounts({});
      await read(); // backend уже обновил снимки; после действия читаем только БД.
      await onChanged();
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const disabled = busy || refreshing || loading;
  return <Dialog title={`Взнос Почёта · ${rows[0]?.guild_title ?? ''}`} onClose={busy || refreshing ? () => {} : onClose} width="xlarge" position={{ narrow: 'bottom', regular: 'center' }}>
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Выберите свои аккаунты и суммы. Каждый взнос выполняется отдельно в эту гильдию.</Text>
      {error && <LoadError error={error} onRetry={() => { void read(); }} />}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}><Button disabled={disabled} onClick={() => setSelected(new Set(choices.filter(x => x.max != null && x.max > 0).map(x => x.id)))}>Выбрать всех</Button><Button disabled={disabled} onClick={() => setSelected(new Set())}>Снять выбор</Button><Button leadingVisual={SyncIcon} disabled={disabled} loading={refreshing} onClick={refresh}>Обновить Почёт</Button></Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>{[25, 50, 75, 100].map(p => <Button key={p} disabled={disabled || !selected.size} onClick={() => setAmounts(old => ({ ...old, ...Object.fromEntries(choices.filter(x => selected.has(x.id) && x.max != null).map(x => [x.id, String(Math.floor(x.max! * p / 100))])) }))}>{p}% выбранным</Button>)}</Box>
      {loading ? <Spinner /> : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '55vh', overflowY: 'auto' }}>{choices.map(({ row, id, max, amount }) => <Box key={id} sx={card}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}><Box as="label" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}><Checkbox aria-label={`Выбрать ${row.account}`} checked={selected.has(id)} disabled={disabled || max == null || max <= 0} onChange={() => setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /><Text sx={{ fontWeight: 'semibold' }}>{row.account}</Text></Box><Text sx={{ color: 'fg.muted', fontSize: 0 }}>Доступно: {max == null ? 'нет снимка' : <RenownValue value={max.toLocaleString('ru')} />}</Text></Box>
        {selected.has(id) && amounts[id] !== undefined && amounts[id] !== '' && (!Number.isSafeInteger(amount) || amount < 0 || max == null || amount > max) && <Text sx={{ color: 'danger.fg', fontSize: 0 }}>Укажите целую сумму в пределах сохранённого баланса</Text>}
        {uncertain.has(id) && <Text sx={{ color: 'attention.fg', fontSize: 0 }}>После попытки нет свежего баланса — обновите Почёт перед новым взносом</Text>}
        {saved[id]?.error && <Text sx={{ color: 'danger.fg', fontSize: 0 }}>{saved[id].error}</Text>}
        <Box sx={{ display: 'grid', gridTemplateColumns: ['1fr', 'minmax(0, 1fr) 140px'], alignItems: 'center', gap: 2 }}><Box as="input" aria-label={`Сумма Почёта с аккаунта ${row.account}`} type="range" min={0} max={max ?? 0} step={1} value={Number.isFinite(amount) ? Math.max(0, Math.min(max ?? 0, amount)) : 0} disabled={disabled || !selected.has(id) || max == null || max === 0} onChange={(e: React.ChangeEvent<HTMLInputElement>) => choose(id, Number(e.target.value))} sx={{ width: '100%', m: 0, accentColor: 'var(--cyan)' }} /><TextInput aria-label={`Точная сумма Почёта с аккаунта ${row.account}`} type="number" min={0} max={max ?? 0} step={1} value={amounts[id] ?? ''} disabled={disabled || !selected.has(id) || max == null || max === 0} onChange={e => setAmounts(old => ({ ...old, [id]: e.target.value }))} placeholder="0" /></Box>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{max == null ? 'Обновите Почёт для получения баланса' : `Останется: ${Math.max(0, max - (Number.isFinite(amount) ? amount : 0)).toLocaleString('ru')}`}{saved[id]?.updatedAt ? ` · снимок ${new Date(saved[id].updatedAt!).toLocaleString('ru')}` : ''}</Text>
      </Box>)}</Box>}
      {results.length > 0 && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{results.map((r, i) => <Flash key={`${r.name}:${i}`} variant={r.ok ? 'success' : 'danger'}>{r.name}: {r.msg}</Flash>)}</Box>}
      <Summary tone="accent"><Tile value={payees.length} label="аккаунтов для взноса" size={2} /><SumLine left="Всего Почёта" right={<RenownValue value={total.toLocaleString('ru')} />} /></Summary>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}><Button disabled={busy || refreshing} onClick={onClose}>Закрыть</Button><Button variant="primary" disabled={disabled || !payees.length || invalidSelection || !Number.isSafeInteger(total)} loading={busy} onClick={pay}>Внести выбранное</Button></Box>
    </Box>
  </Dialog>;
}
