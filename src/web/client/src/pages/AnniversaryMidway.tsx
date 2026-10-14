import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, ProgressBar } from '@primer/react';
import { SyncIcon, PlayIcon } from '@primer/octicons-react';
import { api, type MidwayState, type MidwayRun } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { TicketValue, fmtCountdown } from '../components/Ticket';

// «Карнавальная аллея» (19-24.08.2026) — пять балаганов, по одному в день. У дня свой кошелёк
// билетов: победа даёт win_tickets, оплачиваемых побед в день — paid_wins_cap, дальше награда
// нулевая. День 1 — «Четыре в ряд», день 2 — «Морской бой», день 3 — «Пентаго»; балаганы 4-5 игра
// заранее не раскрывает (identifier пустой, пока день не открылся), здесь ничего не захардкожено.
//
// Счётчики берём из блока active (его считает сервер): вчерашний балаган остаётся открытым с уже
// выбранным кошельком, поэтому «сегодняшний» — тот из открытых, где ещё остались победы.
//
// Играет БОТ и только ПРОТИВ БОТА игры (vs_bot). Партия идёт ~минуту, «сыграть на всех» — десятки
// минут, поэтому работа живёт в процессе сервера (web/lib/midwayRunner.js), а страница лишь
// опрашивает /api/midway/status. Отсюда важное свойство: спиннеры на кнопках переживают
// перезагрузку страницы — состояние не во вкладке.

type Row = { id: number; name: string; midway?: MidwayState; error?: string; permanent?: boolean };

const STALL_TITLE: Record<string, string> = { connect_four: 'Четыре в ряд', battleship: 'Морской бой', pentago: 'Пентаго', quoridor: 'Коридор',
  dots_and_boxes: 'Точки и коробки' };
const stallTitle = (id: string) => (id ? STALL_TITLE[id] ?? id : 'откроется позже');

// Осталось ли что забрать у СЕГОДНЯШНЕГО балагана. Считаем по общему блоку active, а не по
// connect_four: со второго дня балаган другой, а вчерашний остаётся открытым с пустым кошельком.
function canPlay(m: MidwayState | undefined): boolean {
  if (!m?.is_open || !m.active?.supported) return false;
  const c = m.active;
  if (!c.paid_wins_cap) return false;
  return c.paid_wins < c.paid_wins_cap;
}

function StallStrip({ stalls, now }: { stalls: MidwayState['stalls']; now: number }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
      {stalls.map(s => {
        const opensIn = s.opens_at ? new Date(s.opens_at).getTime() - now : 0;
        const opensInText = fmtCountdown(s.opens_at, now);
        return (
          <Box key={s.day} sx={{
            px: 2, py: 1, borderRadius: 2, border: '1px solid',
            borderColor: s.is_open ? 'accent.emphasis' : 'border.muted',
            bg: s.is_open ? 'accent.subtle' : 'canvas.subtle', minWidth: 120,
          }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>День {s.day}</Text>
            <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>{stallTitle(s.identifier)}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              {s.is_open
                ? <>взято <TicketValue value={s.tickets_earned} /> из <TicketValue value={s.purse} /></>
                : opensIn > 0 ? `через ${opensInText}` : `${s.purse} билетов`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function AccountCard({ row, run, onPlay }: { row: Row; run?: MidwayRun; onPlay: (id: number) => void }) {
  const m = row.midway;
  const busy = !!run?.running;

  if (row.error) {
    return (
      <Box sx={{ p: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 2 }}>
        <Text sx={{ fontWeight: 'bold' }}>{row.name}</Text>
        <Text sx={{ display: 'block', fontSize: 1, color: 'danger.fg', mt: 1 }}>{row.error}</Text>
      </Box>
    );
  }

  const c = m?.active;
  const done = c ? c.paid_wins : 0;
  const cap = c ? c.paid_wins_cap : 0;
  const playable = canPlay(m);
  const liveGame = m?.active_game && !m.active_game.vs_bot ? m.active_game : null;

  return (
    <Box sx={{ p: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 2 }}>
        <Box>
          <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>{row.name}</Text>
          <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted' }}>
            билетов на руках: <TicketValue value={m?.tickets_balance ?? 0} />
          </Text>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {cap > 0 && (
            <Label variant={done >= cap ? 'success' : 'accent'}>
              побед {done} из {cap}
            </Label>
          )}
          {c && c.tickets_earned > 0 && <Label variant="secondary">+{c.tickets_earned} за день</Label>}
          {playable
            ? <Button variant="primary" leadingVisual={PlayIcon} loading={busy} disabled={busy} onClick={() => onPlay(row.id)}>
                Сыграть
              </Button>
            : <Label variant={done >= cap && cap > 0 ? 'success' : 'secondary'}>
                {!m?.is_open ? 'аллея закрыта'
                  : !m.active?.supported ? `балаган «${stallTitle(m.today_identifier)}» не поддержан`
                    : 'кошелёк дня выбран'}
              </Label>}
        </Box>
      </Box>

      {cap > 0 && <ProgressBar progress={(done / cap) * 100} sx={{ mb: 2 }} />}

      {liveGame && (
        <Text sx={{ display: 'block', fontSize: 0, color: 'attention.fg', mb: 1 }}>
          Есть незавершённая партия с живым игроком ({liveGame.code}) — бот её не трогает, доиграйте в игре.
        </Text>
      )}
      {run && (
        <Text sx={{ display: 'block', fontSize: 0, color: run.error ? 'danger.fg' : 'fg.muted' }}>
          {run.error ?? run.step}
          {run.running && run.needed ? ` · побед ${run.wins} из ${run.needed}` : ''}
        </Text>
      )}
    </Box>
  );
}

export function AnniversaryMidway() {
  const [rows, setRows] = useState<Row[]>([]);
  const [runs, setRuns] = useState<Map<number, MidwayRun>>(new Map());
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [startingAll, setStartingAll] = useState(false);
  const [refreshing, setRefreshing] = useResumableRefresh('midway', () => load());
  const { flash, showFlash } = useFlash();
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  const load = useCallback(async () => {
    try {
      const d = await api.midway();
      if (d.ok) { setRows(d.accounts); return d.accounts; }
      showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // добираем аккаунты, по которым игра не ответила — как на остальных страницах раздела
  const retryFailed = useCallback(async (list: Row[]) => {
    const ids = list.filter(r => r.error && !r.permanent).map(r => r.id);
    if (!ids.length) return;
    try {
      const d = await api.midway(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setRows(prev => prev.map(r => fixed.get(r.id) ?? r));
      }
    } catch { /* строка останется с ошибкой */ }
  }, []);

  useEffect(() => { load().then(list => { if (list) retryFailed(list); }); }, [load, retryFailed]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // Опрос статуса. Работает ВСЕГДА, а не только после нажатия: состояние живёт на сервере, поэтому
  // после F5 кнопки сами возвращаются в спиннер, если партии ещё идут.
  useEffect(() => {
    let stopped = false;
    const wasRunning = new Set<number>();
    const tick = async () => {
      try {
        const d = await api.midwayStatus();
        if (stopped || !d.ok) return;
        setRuns(new Map(d.rows.map(r => [r.account_id, r])));
        const finished: number[] = [];
        for (const r of d.rows) {
          if (r.running) wasRunning.add(r.account_id);
          else if (wasRunning.delete(r.account_id)) finished.push(r.account_id);
        }
        // аккаунт доиграл — сразу перечитываем ЕГО состояние, чтобы счётчик побед и билеты
        // обновились без ручного обновления страницы
        if (finished.length) {
          const fresh = await api.midway(finished);
          if (!stopped && fresh.ok) {
            const byId = new Map(fresh.accounts.map(a => [a.id, a]));
            setRows(prev => prev.map(r => byId.get(r.id) ?? r));
          }
        }
      } catch { /* статус не критичен */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { const list = await load(); if (list) await retryFailed(list); }
    finally { setRefreshing(false); }
  };

  const play = async (accountId: number) => {
    try {
      const r = await api.midwayPlay(accountId);
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      setRuns(prev => {
        const next = new Map(prev);
        const name = rowsRef.current.find(x => x.id === accountId)?.name ?? '';
        next.set(accountId, { account_id: accountId, name, step: 'в очереди', wins: 0, needed: null, tickets: 0, losses: 0, running: true, error: null });
        return next;
      });
    } catch (e) { showFlash(String(e), false); }
  };

  // «Сыграть на всех» — только те, кому реально есть что доигрывать; сервер условия перепроверит сам
  const playAll = async () => {
    const ids = rowsRef.current.filter(r => canPlay(r.midway)).map(r => r.id);
    if (!ids.length) return;
    setStartingAll(true);
    try {
      const r = await api.midwayPlayAll(ids);
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      showFlash(`Запущено аккаунтов: ${r.started ?? ids.length}`, true);
    } catch (e) { showFlash(String(e), false); }
    finally { setStartingAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const anyOpen = rows.some(r => r.midway?.is_open);
  const playable = rows.filter(r => canPlay(r.midway));
  const stalls = rows.find(r => r.midway?.stalls?.length)?.midway?.stalls ?? [];
  const c4 = rows.find(r => r.midway?.active?.win_tickets)?.midway?.active;
  const endsAt = rows.find(r => r.midway?.ends_at)?.midway?.ends_at ?? null;
  const potential = playable.reduce((n, r) => {
    const c = r.midway!.active;
    return n + Math.max(0, c.paid_wins_cap - c.paid_wins) * c.win_tickets;
  }, 0);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2, flexWrap: 'wrap' }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Карнавальная аллея</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant={playable.length ? 'primary' : 'default'} leadingVisual={PlayIcon}
            loading={startingAll} disabled={startingAll || !playable.length}
            title={playable.length ? `Доиграть кошельки: ${playable.length} аккаунтов, до ${potential} билетов` : 'Ни на одном аккаунте не осталось оплачиваемых побед'}
            onClick={playAll}>
            Сыграть на всех{playable.length ? ` (${playable.length})` : ''}
          </Button>
          <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить</Button>
        </Box>
      </Box>

      {flash && <Flash variant={flash.ok ? "success" : "danger"} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {!anyOpen && (
        <Flash sx={{ mb: 3 }}>Аллея закрыта — балаганы работают с 19 по 24 августа.</Flash>
      )}

      {stalls.length > 0 && <StallStrip stalls={stalls} now={now} />}

      {c4 && (
        <Text sx={{ display: 'block', fontSize: 1, color: 'fg.muted', mb: 3 }}>
          Сегодня в аллее — <strong>{c4.title || 'неизвестный балаган'}</strong>. Победа над ботом даёт{' '}
          <TicketValue value={c4.win_tickets} />, оплачиваются первые {c4.paid_wins_cap} побед в день
          (это весь дневной кошелёк). Бот играет только против игрового бота, партии живых игроков не трогает.
          {endsAt && <> Аллея закроется через {fmtCountdown(endsAt, now)}.</>}
        </Text>
      )}

      {rows.map(r => <AccountCard key={r.id} row={r} run={runs.get(r.id)} onPlay={play} />)}
    </Box>
  );
}
