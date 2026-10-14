import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Label, Dialog, Spinner, Text } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon, PencilIcon } from '@primer/octicons-react';
import { api, type WordleRow } from '../api';
import { useFlash } from '../hooks/useFlash';
import { Scrollable } from '../components/Scrollable';

// ── модалка ручного ввода слова на все аккаунты ──────────────────────────────
function ManualWordDialog({ onClose, onDone, showFlash }: { onClose: () => void; onDone: () => void; showFlash: (m: string, ok: boolean) => void }) {
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; won?: boolean; skipped?: string; error?: string }[] | null>(null);
  const valid = /^[а-яёa-z]{5}$/i.test(word.trim());

  const submit = async () => {
    if (!valid) { showFlash('Нужно слово из 5 букв', false); return; }
    setBusy(true); setResults(null);
    try {
      const d = await api.wordleGuessAll(word.trim().toLowerCase());
      if (d.ok) {
        setResults(d.results ?? []);
        const won = (d.results ?? []).filter(r => r.won).length;
        const fail = (d.results ?? []).filter(r => !r.ok).length;
        showFlash(`Слово "${d.word}" подано · выиграли ${won}${fail ? ` · ошибок ${fail}` : ''}`, fail === 0);
        onDone();
      } else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  return (
    <Dialog isOpen onDismiss={onClose} aria-labelledby="manual-word-title" sx={{ maxWidth: 460, width: '95vw' }}>
      <Dialog.Header id="manual-word-title">Ввести слово на все аккаунты</Dialog.Header>
      <Box sx={{ p: 2 }}>
        <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mb: 2 }}>
          Слово (6-я попытка) будет подано на все аккаунты, которые ещё не выиграли и не исчерпали попытки.
        </Text>
        <input
          autoFocus
          value={word}
          maxLength={5}
          placeholder="слово из 5 букв"
          onChange={e => setWord(e.target.value.replace(/[^а-яёa-z]/gi, ''))}
          onKeyDown={e => { if (e.key === 'Enter' && valid && !busy) submit(); }}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 18, letterSpacing: 4, textTransform: 'lowercase', fontFamily: 'monospace' }}
        />
        {results && (
          <Scrollable style={{ marginTop: 24, maxHeight: '40vh', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {results.map(r => (
              <Box key={r.name} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                <Text sx={{ fontWeight: 'bold' }}>{r.name}</Text>
                <Text sx={{ color: r.won ? 'success.fg' : r.ok ? 'fg.muted' : 'danger.fg' }}>
                  {r.won ? '🏆 выиграл' : r.skipped ? r.skipped : r.ok ? 'подано' : (r.error || 'ошибка')}
                </Text>
              </Box>
            ))}
          </Scrollable>
        )}
      </Box>
      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button onClick={onClose}>{results ? 'Закрыть' : 'Отмена'}</Button>
        <Button variant="primary" disabled={!valid || busy} loading={busy} onClick={submit}>
          Подать на все
        </Button>
      </Box>
    </Dialog>
  );
}

export function Wordle() {
  const [rows, setRows] = useState<WordleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualOpen, setManualOpen] = useState(false);
  const { flash, showFlash } = useFlash();

  const load = async (d = date) => {
    setLoading(true);
    try {
      const res = await api.wordleLog(d);
      if (res.ok) setRows([...res.rows].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true })));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [date]);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = [...rows].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true })).map((r, i) => ({
    id:        i,
    account:   r.account,
    won:       r.won,
    words:     r.words,
    _attempts: r.attempts ?? r.words?.length ?? 0,
    _won:      r.won ? 1 : 0,
  }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Wordle</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center' }}>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ border: '1px solid var(--color-border-default)', borderRadius: 6, padding: '5px 10px', fontSize: 13, fontFamily: 'inherit' }}
        />
        <Button leadingVisual={SyncIcon} loading={loading} disabled={loading} onClick={() => load()}>
          Обновить
        </Button>
        <Button leadingVisual={PencilIcon} variant="primary" onClick={() => setManualOpen(true)}>
          Ввести слово
        </Button>
      </Box>

      {manualOpen && <ManualWordDialog onClose={() => setManualOpen(false)} onDone={() => load()} showFlash={showFlash} />}

      <Table.Container>
        <DataTable
          data={data}
          initialSortColumn="account"
          initialSortDirection="ASC"
          columns={[
            {
              header: 'Аккаунт',
              field: 'account',
              rowHeader: true,
              sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.account}</strong>,
            },
            {
              header: 'Решено',
              field: '_won',
              sortBy: 'basic',
              renderCell: row => row.won
                ? <Label variant="success">Да</Label>
                : <Label variant="danger">Нет</Label>,
            },
            {
              header: 'Попыток',
              field: '_attempts',
              sortBy: 'basic',
              renderCell: row => <span className="mono">{row._attempts || '—'}</span>,
            },
            {
              header: 'Слова',
              field: 'account',
              id: 'words',
              renderCell: row => (
                <span style={{ fontSize: 13, fontFamily: 'monospace', letterSpacing: 1 }}>
                  {(row.words ?? []).join(' · ')}
                </span>
              ),
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
