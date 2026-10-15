import { useState, useEffect } from 'react';
import { Box, Button, CounterLabel, Flash, Label, Spinner, Text } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon, PencilIcon } from '@primer/octicons-react';
import { api, type WordleRow } from '../api';
import { useFlash } from '../hooks/useFlash';
import { Scrollable } from '../components/Scrollable';
import { PageHeader } from '../components/PageHeader';
import { WordCells } from '../components/WordCells';

// ── модалка ручного ввода слова на все аккаунты ──────────────────────────────
// окно по ширине пяти ячеек: medium = 320px = 5×48 + 4×8 + по 24 слева/справа (8 тела + 16 центровки),
// сверху/снизу те же 24 (8 тела + py 16)
function ManualWordDialog({ pending, onClose, onDone, showFlash }: { pending?: number; onClose: () => void; onDone: () => void; showFlash: (m: string, ok: boolean) => void }) {
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; won?: boolean; skipped?: string; error?: string }[] | null>(null);
  const valid = /^[а-яёa-z]{5}$/i.test(word);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setResults(null);
    try {
      const d = await api.wordleGuessAll(word.toLowerCase());
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
    <Dialog
      title="Ввести слово на все аккаунты"
      onClose={onClose}
      width="medium"
      position={{ narrow: 'bottom', regular: 'center' }}
      renderFooter={() => (
        <Dialog.Footer sx={{ gap: 2 }}>
          <Button block sx={{ flex: 1 }} onClick={onClose}>{results ? 'Закрыть' : 'Отмена'}</Button>
          <Button
            block
            sx={{ flex: 1 }}
            variant="primary"
            disabled={!valid || busy}
            loading={busy}
            onClick={submit}
            trailingVisual={pending != null ? () => (
              <CounterLabel sx={{ bg: '#ffffff', color: 'success.emphasis', fontWeight: 'bold', border: 'none' }}>{pending}</CounterLabel>
            ) : undefined}
          >
            Подать
          </Button>
        </Dialog.Footer>
      )}
    >
      <Box sx={{ py: 3 }}><WordCells value={word} onChange={setWord} onEnter={submit} disabled={busy} autoFocus /></Box>
      {results && (
        <Scrollable style={{ marginBottom: 16, maxHeight: '40vh', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {results.map(r => (
            <Box key={r.name} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 1, py: '2px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
              <Text sx={{ fontWeight: 'bold' }}>{r.name}</Text>
              <Text sx={{ color: r.won ? 'success.fg' : r.ok ? 'fg.muted' : 'danger.fg', textAlign: 'right' }}>
                {r.won ? '🏆 выиграл' : r.skipped ? r.skipped : r.ok ? 'подано' : (r.error || 'ошибка')}
              </Text>
            </Box>
          ))}
        </Scrollable>
      )}
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

  // полноэкранный спиннер только на первой загрузке: перезагрузка после подачи слова не должна
  // размонтировать открытое окно (иначе пропадает список результатов)
  if (loading && !rows.length) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = [...rows].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true })).map((r, i) => ({
    id:        i,
    account:   r.account,
    won:       r.won,
    words:     r.words,
    _attempts: r.attempts ?? r.words?.length ?? 0,
    _won:      r.won ? 1 : 0,
  }));

  // сколько аккаунтов получат слово: сегодня ещё не выиграли и попытки не кончились (по таблице)
  const pending = date === new Date().toISOString().slice(0, 10) ? rows.filter(r => !r.won && (r.attempts ?? r.words?.length ?? 0) < 6).length : undefined;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Wordle" actions={<>
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
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {manualOpen && <ManualWordDialog pending={pending} onClose={() => setManualOpen(false)} onDone={() => load()} showFlash={showFlash} />}

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
