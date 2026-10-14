import { useState, useEffect, useRef } from 'react';
import { Box, Button, Flash, Heading, Text, Label, Spinner } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { PlayIcon, CheckIcon, ZapIcon, StopIcon } from '@primer/octicons-react';
import { api, type Account, type Game2048Status, type Game2048Direction } from '../api';
import { fmt, sortByName } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useUtcMidnightReset } from '../hooks/useUtcMidnightReset';
import { CoinValue } from '../components/Icons';
import { Game2048Modal } from '../components/Game2048Modal';

interface Result { won?: boolean; reward?: number | null; score?: number | null }
interface BoardMsg { type: 'snapshot' | 'move' | 'done'; board?: number[][]; score?: number; max_tile?: number; game_status?: Game2048Status; direction?: Game2048Direction; reward?: number; error?: string }

export function Game2048() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<Map<number, Result>>(new Map());
  const [playing, setPlaying] = useState<{ id: number; name: string } | null>(null);
  // фоновое авто-решение прямо из таблицы, без открытия модалки — для тех, кто не хочет наблюдать
  const [solvingIds, setSolvingIds] = useState<Set<number>>(new Set());
  // ОДНО SSE-соединение на аккаунт на весь процесс страницы — раньше, пока шла автоигра, модалка
  // при открытии заводила ВТОРОЕ, отдельное соединение к тому же /solve-stream (таблица уже держит
  // одно для отслеживания "Играет…"), из-за чего при нескольких одновременно играющих аккаунтах
  // легко упереться в лимит браузера на число одновременных HTTP/1.1-соединений к одному origin (6) —
  // новое соединение модалки просто зависало в очереди, доска не обновлялась. Теперь модалка не
  // открывает свой поток вообще, а подписывается на уже открытый здесь через subscribeBoard.
  const streamsRef = useRef<Map<number, EventSource>>(new Map());
  const lastMsgRef = useRef<Map<number, BoardMsg>>(new Map());
  const listenersRef = useRef<Map<number, Set<(m: BoardMsg) => void>>>(new Map());
  const subscribeBoard = (id: number, cb: (m: BoardMsg) => void) => {
    if (!listenersRef.current.has(id)) listenersRef.current.set(id, new Set());
    listenersRef.current.get(id)!.add(cb);
    const last = lastMsgRef.current.get(id);
    if (last) cb({ ...last, type: 'snapshot' }); // уже известное состояние — отдаём как snapshot, без анимации хода
    return () => { listenersRef.current.get(id)?.delete(cb); };
  };
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const [d, st, live] = await Promise.all([api.accounts(), api.minigameStatus('2048'), api.game2048Live()]);
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
        // кто-то уже доигрывается в фоне (запущено раньше, до перезагрузки страницы, из этой же
        // таблицы или из модалки) — подключаемся к уже идущей партии вместо ожидания ручного клика
        if (live.ok) {
          const byId = new Map(list.map(a => [a.id, a.name]));
          for (const row of live.rows) {
            const name = byId.get(row.account_id);
            if (name) startTableSolve(row.account_id, name);
          }
        }
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useUtcMidnightReset(() => { setResults(new Map()); load(); });
  useEffect(() => () => { for (const es of streamsRef.current.values()) es.close(); }, []);

  // solvingIds — единственный источник правды "кто сейчас автоиграет", общий для таблицы И
  // модалки (передаётся ей пропом, см. рендер ниже) — стартовать/останавливать можно из ЛЮБОГО
  // места (кнопка в таблице или в открытой модалке), кнопки в обеих сразу видят один и тот же
  // статус, а не рассинхронизированные локальные состояния.
  const startTableSolve = (id: number, name: string) => {
    if (solvingIds.has(id)) return;
    setSolvingIds(prev => new Set(prev).add(id));
    const es = new EventSource(`/api/game2048/${id}/solve-stream`);
    streamsRef.current.set(id, es);
    es.onmessage = e => {
      const data: BoardMsg = JSON.parse(e.data);
      // доска/ход кэшируем и рассылаем ЛЮБОЙ открытой на этот аккаунт модалке (см. subscribeBoard) —
      // этому единственному соединению больше не нужно ждать 'done', чтобы быть полезным
      if (data.type === 'snapshot' || data.type === 'move') lastMsgRef.current.set(id, data);
      for (const cb of listenersRef.current.get(id) ?? []) cb(data);
      if (data.type !== 'done') return;
      es.close(); streamsRef.current.delete(id); lastMsgRef.current.delete(id);
      setSolvingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      if (data.game_status && data.game_status !== 'ongoing') {
        setResults(prev => new Map(prev).set(id, { won: data.game_status === 'won', reward: data.reward }));
        showFlash(data.game_status === 'won' ? `[${name}] 2048 пройдена, +${fmt(data.reward ?? 0)} монет` : `[${name}] игра окончена`, data.game_status === 'won');
      } else if (data.error) showFlash(`[${name}] ${data.error}`, false);
    };
    es.onerror = () => {
      es.close(); streamsRef.current.delete(id); lastMsgRef.current.delete(id);
      setSolvingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    };
  };
  // "Стоп" — партия крутится в фоне независимо от SSE (см. web/lib/game2048Progress.js), поэтому
  // просто закрыть соединение недостаточно — явно останавливаем её на сервере
  const stopTableSolve = (id: number) => {
    api.game2048Stop(id).catch(() => {});
    streamsRef.current.get(id)?.close();
    streamsRef.current.delete(id);
    setSolvingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const data = accounts.map(a => ({ id: a.id, name: a.name, _res: results.get(a.id), _solving: solvingIds.has(a.id) }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 1 }}>2048</Heading>
      <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>
        Оплот Мудрости — ежедневная игра в 2048. Раз в день на аккаунт. «Играть» открывает живое поле —
        управление стрелками, свайпом или мышью. «Решить» запускает автоматическую игру в фоне —
        продолжает играть, даже если закрыть модалку, перейти на другую страницу или закрыть вкладку;
        «Смотреть» открывает то же поле, чтобы понаблюдать за уже идущей партией.
      </Text>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

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
                if (row._solving) return <Label variant="accent">Играет…</Label>;
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
                return (
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button variant="primary" leadingVisual={PlayIcon}
                      disabled={done} onClick={() => setPlaying({ id: row.id, name: row.name })}>
                      {done ? 'Сыграно' : row._solving ? 'Смотреть' : 'Играть'}
                    </Button>
                    {row._solving
                      ? <Button variant="danger" leadingVisual={StopIcon} onClick={() => stopTableSolve(row.id)}>Стоп</Button>
                      : <Button variant="default" leadingVisual={ZapIcon}
                          disabled={done} onClick={() => startTableSolve(row.id, row.name)}>Решить</Button>}
                  </Box>
                );
              },
            },
          ]}
        />
      </Table.Container>

      {playing && (
        <Game2048Modal
          accountId={playing.id}
          accountName={playing.name}
          solving={solvingIds.has(playing.id)}
          onStartSolve={() => startTableSolve(playing.id, playing.name)}
          onStopSolve={() => stopTableSolve(playing.id)}
          onSubscribeBoard={cb => subscribeBoard(playing.id, cb)}
          onClose={() => setPlaying(null)}
          onResult={r => {
            setResults(prev => new Map(prev).set(playing.id, { won: r.won, reward: r.reward, score: r.score }));
            showFlash(r.won ? `[${playing.name}] 2048 пройдена, +${fmt(r.reward ?? 0)} монет` : `[${playing.name}] игра окончена`, r.won);
          }}
        />
      )}
    </Box>
  );
}
