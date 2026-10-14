import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Button, Flash, Heading, Text, Label, Spinner, ProgressBar } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { ZapIcon, CheckIcon } from '@primer/octicons-react';
import { api, type Account } from '../api';
import { fmt, sortByName } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useUtcMidnightReset } from '../hooks/useUtcMidnightReset';
import { CoinValue } from '../components/Icons';

interface Result { won?: boolean; reward?: number | null; score?: number | null }
interface Live { current: number; total: number }

export function Quiz() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<Map<number, Result>>(new Map());
  const [solving, setSolving] = useState<Set<number>>(new Set());
  const [live, setLive] = useState<Map<number, Live>>(new Map());
  // короткая блокировка кнопок ДРУГИХ аккаунтов на 5с при старте решения (чтобы не бомбить
  // сервер одновременными стартами), а не на все ~2.5 мин решения — сами решаемые аккаунты
  // блокируются отдельно через `solving`, независимо от этого таймера
  const [justStarted, setJustStarted] = useState(false);
  const justStartedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (justStartedTimer.current) clearTimeout(justStartedTimer.current); }, []);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const [d, st, liveNow] = await Promise.all([api.accounts(), api.minigameStatus('quiz'), api.quizLive()]);
      if (d.ok) {
        const list = sortByName(d.accounts.filter(a => a.hasToken && a.buildings?.includes('wisdom')), 'name');
        setAccounts(list);
        if (st.ok) {
          const byName = new Map(list.map(a => [a.name, a.id]));
          const map = new Map<number, Result>();
          for (const r of st.rows) {
            const id = byName.get(r.account);
            if (id != null) map.set(id, { won: r.won, reward: r.reward, score: r.score });
          }
          setResults(map);
        }
        // кто-то решается прямо сейчас (в т.ч. запущено до перезагрузки страницы) — подключаемся
        // к уже идущему прогрессу вместо того, чтобы ждать ручного нажатия "Решить"
        if (liveNow.ok) {
          const byId = new Map(list.map(a => [a.id, a.name]));
          for (const row of liveNow.rows) {
            const name = byId.get(row.account_id);
            if (!name) continue;
            setSolving(prev => new Set(prev).add(row.account_id));
            setLive(prev => new Map(prev).set(row.account_id, { current: row.current, total: row.total }));
            attachStream(row.account_id, name);
          }
        }
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useUtcMidnightReset(() => { setResults(new Map()); setSolving(new Set()); setLive(new Map()); load(); });

  // подписка на стрим прогресса конкретного аккаунта — используется и для свежего запуска (solveOne),
  // и для восстановления прогресса после перезагрузки страницы (см. reattachLive ниже): в обоих
  // случаях сервер либо стартует решение, либо, если оно уже идёт, просто подписывает на него —
  // повторного запуска не происходит (см. web/lib/quizProgress.js)
  const attachStream = (id: number, name: string) => {
    const es = new EventSource(`/api/quiz/solve-stream?account_id=${id}`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'progress') {
        setLive(prev => new Map(prev).set(id, { current: data.current, total: data.total }));
        // блокируем кнопки ДРУГИХ аккаунтов на 5с от момента, когда реально начался первый
        // вопрос (не от клика "Решить" — там ещё идёт READING_MS/задержка перед первым ответом).
        // При восстановлении после перезагрузки первый полученный current обычно уже > 1 —
        // блокировка в этом случае не сработает, и это правильно.
        if (data.current === 1) {
          setJustStarted(true);
          if (justStartedTimer.current) clearTimeout(justStartedTimer.current);
          justStartedTimer.current = setTimeout(() => setJustStarted(false), 5000);
        }
      } else if (data.type === 'done') {
        es.close();
        setSolving(prev => { const n = new Set(prev); n.delete(id); return n; });
        setLive(prev => { const n = new Map(prev); n.delete(id); return n; });
        if (data.ok) {
          setResults(prev => new Map(prev).set(id, { won: data.won, reward: data.reward, score: data.score }));
          showFlash(data.skipped ? `[${name}] уже сыграно сегодня` : `[${name}] викторина пройдена, +${fmt(data.reward ?? 0)} монет`, true);
        } else showFlash(`[${name}] ${data.error}`, false);
      }
    };
    es.onerror = () => {
      es.close();
      setSolving(prev => { const n = new Set(prev); n.delete(id); return n; });
      setLive(prev => { const n = new Map(prev); n.delete(id); return n; });
      showFlash(`[${name}] ошибка соединения`, false);
    };
  };

  // одиночное решение со стримом прогресса (какой вопрос сейчас)
  const solveOne = (id: number, name: string) => {
    if (solving.has(id)) return;
    setSolving(prev => new Set(prev).add(id));
    attachStream(id, name);
  };

  // массовое решение — в фоне на сервере, статус подтягиваем поллингом
  const poll = useCallback(async () => {
    const st = await api.minigameStatus('quiz');
    if (!st.ok) return;
    const byName = new Map(accounts.map(a => [a.name, a.id]));
    const doneIds = new Set<number>();
    setResults(prev => {
      const next = new Map(prev);
      for (const r of st.rows) {
        const id = byName.get(r.account);
        if (id != null) { next.set(id, { won: r.won, reward: r.reward, score: r.score }); doneIds.add(id); }
      }
      return next;
    });
    setSolving(prev => { const n = new Set(prev); for (const id of doneIds) n.delete(id); return n; });
  }, [accounts]);

  const [polling, setPolling] = useState(false);
  useEffect(() => {
    if (!polling || solving.size === 0) return;
    const iv = setInterval(poll, 12000);
    return () => clearInterval(iv);
  }, [polling, solving.size, poll]);

  const solveAll = async () => {
    try {
      await api.quizSolveAll();
      const ids = accounts.filter(a => !results.get(a.id)).map(a => a.id);
      setSolving(prev => { const n = new Set(prev); ids.forEach(i => n.add(i)); return n; });
      setPolling(true);
      showFlash('Запущено в фоне — результаты появятся по мере решения (~2.5 мин/аккаунт)', true);
    } catch (e) { showFlash(String(e), false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = accounts.map(a => ({ id: a.id, name: a.name, _res: results.get(a.id), _live: live.get(a.id), _solving: solving.has(a.id) }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 1 }}>Викторина</Heading>
      <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>
        Авто-решение ежедневной викторины. База ответов общая и самообучается — со временем больше монет. Раз в день на аккаунт, ~2.5 мин на каждый.
      </Text>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button variant="primary" leadingVisual={ZapIcon} disabled={solving.size > 0} onClick={solveAll}>
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
              header: 'Статус', field: 'id',
              renderCell: row => {
                if (row._live) {
                  const { current, total } = row._live;
                  return (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box sx={{ width: 90 }}><ProgressBar progress={Math.round(current / (total || 1) * 100)} sx={{ mb: 0 }} /></Box>
                      <span className="mono" style={{ fontSize: 11 }}>Вопрос {current}/{total}</span>
                    </Box>
                  );
                }
                if (row._solving) return <Label variant="accent">Запуск…</Label>;
                const r = row._res;
                if (!r) return <Text sx={{ color: 'fg.muted' }}>—</Text>;
                if (r.won) return <Label variant="success" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><CheckIcon size={12} /> Сыграно</Label>;
                return <Label variant="danger">Поражение</Label>;
              },
            },
            {
              header: 'Монеты', field: 'id', id: 'coins',
              renderCell: row => row._res?.reward != null ? <span className="mono"><CoinValue value={fmt(row._res.reward)} /></span> : <Text sx={{ color: 'fg.muted' }}>—</Text>,
            },
            {
              header: 'Счёт', field: 'id', id: 'score',
              renderCell: row => row._res?.score != null ? <span className="mono">{fmt(row._res.score)}</span> : <Text sx={{ color: 'fg.muted' }}>—</Text>,
            },
            {
              header: '', field: 'id', id: 'action',
              renderCell: row => {
                const done = !!row._res;
                // сам решаемый аккаунт блокируется на всё время (row._solving); остальные —
                // только на 5с после старта любого решения (justStarted), не на всю длительность
                return (
                  <Button variant="primary" leadingVisual={ZapIcon}
                    loading={row._solving} disabled={done || row._solving || (justStarted && !row._solving)}
                    onClick={() => solveOne(row.id, row.name)}>
                    {done ? 'Сыграно' : 'Решить'}
                  </Button>
                );
              },
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
