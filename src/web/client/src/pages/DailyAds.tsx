import { useState, useEffect, useRef } from 'react';
import { Box, Button, Flash, Label } from '@primer/react';
import { ProgressBar } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { EyeIcon, SyncIcon } from '@primer/octicons-react';
import { api, type DailyAdsRow } from '../api';
import { fmt, sortByName } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { useNarrow, narrowCols } from '../hooks/useNarrow';

interface LiveProgress { current: number; limit: number; }

export function DailyAds() {
  const narrow = useNarrow();
  const [rows, setRows] = useState<DailyAdsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [watchingAll, setWatchingAll] = useState(false);
  const [watchingOne, setWatchingOne] = useState<Set<number>>(new Set());
  const [liveProgress, setLiveProgress] = useState<Map<number, LiveProgress>>(new Map());
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:dailyads', () => load());
  const [verifying, setVerifying] = useState(false);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const [d, liveNow] = await Promise.all([api.dailyAdsStatus(), api.dailyAdsLive()]);
      if (d.ok) setRows(sortByName(d.rows, 'name'));
      // кто-то уже смотрит рекламу прямо сейчас (в т.ч. запущено до перезагрузки страницы) —
      // подключаемся к уже идущему просмотру вместо того, чтобы ждать ручного нажатия "Смотреть"
      if (d.ok && liveNow.ok) {
        const byId = new Map(d.rows.map(r => [r.id, r.name]));
        for (const row of liveNow.rows) {
          const name = byId.get(row.account_id);
          if (!name) continue;
          setWatchingOne(prev => new Set(prev).add(row.account_id));
          setLiveProgress(prev => new Map(prev).set(row.account_id, { current: row.current, limit: row.limit }));
          attachStream(row.account_id, name);
        }
      }
    } finally { setLoading(false); }
  };

  // Снимок из БД мог остаться со вчера: игра сбрасывает счётчик рекламы каждые сутки, и вчерашние
  // 10/10 выглядели на странице сегодняшним «Готово», хотя ни одна реклама за новый день не
  // смотрена. Поэтому при открытии страницы (и всегда, когда среди строк есть устаревшие) идём за
  // живым статусом в игру и заменяем строки на правдивые. Снимок при этом показываем сразу — без
  // пустого экрана, но со статусом «нужно обновить», пока не приедет ответ.
  const verifyLive = async () => {
    setVerifying(true);
    try {
      const d = await api.dailyAdsLiveStatus();
      if (d.ok) setRows(sortByName(d.rows, 'name'));
    } catch { /* сеть моргнула — на странице останется пометка «нужно обновить» */ }
    finally { setVerifying(false); }
  };

  // подписка на стрим прогресса конкретного аккаунта — используется и для свежего запуска
  // (watchOne), и для восстановления прогресса после перезагрузки страницы (см. load выше):
  // сервер либо стартует просмотр, либо, если он уже идёт, просто подписывает на него —
  // повторного запуска не происходит (см. web/lib/adsProgress.js)
  // 13.10.2026: раньше EventSource закрывался только по 'done' от сервера или по ошибке — если
  // уйти со страницы, пока реклама ещё смотрится (до ~100с, по 10с на ролик), соединение оставалось
  // висеть в браузере. Браузер по HTTP/1.1 держит не больше 6 одновременных соединений на адрес —
  // несколько таких утечек (реклама/викторина/2048 с других страниц) исчерпывали лимит, и панель
  // переставала открывать НОВЫЕ страницы вообще (похоже на зависание бота, хотя сам бот работал
  // нормально). streamsRef — открытые по этой странице соединения, закрываются при уходе со
  // страницы; прогресс при возврате не теряется — load() выше сам переподключается к ещё идущим
  // просмотрам и получает текущее состояние первым же сообщением (см. web/lib/adsProgress.js start()).
  const streamsRef = useRef<Set<EventSource>>(new Set());
  useEffect(() => () => { for (const es of streamsRef.current) es.close(); streamsRef.current.clear(); }, []);

  const attachStream = (id: number, name: string) => {
    const es = new EventSource(`/api/daily-ads/watch-stream?account_id=${id}`);
    streamsRef.current.add(es);
    const close = () => { es.close(); streamsRef.current.delete(es); };
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'progress') {
        setLiveProgress(prev => new Map(prev).set(id, { current: data.current, limit: data.limit }));
      } else if (data.type === 'done') {
        close();
        setWatchingOne(prev => { const n = new Set(prev); n.delete(id); return n; });
        setLiveProgress(prev => { const n = new Map(prev); n.delete(id); return n; });
        if (data.ok) { showFlash(`[${name}] просмотрено ${data.claimed}/${data.limit}`, true); load(); }
        else showFlash(`[${name}] ${data.error}`, false);
      }
    };
    es.onerror = () => {
      close();
      setWatchingOne(prev => { const n = new Set(prev); n.delete(id); return n; });
      setLiveProgress(prev => { const n = new Map(prev); n.delete(id); return n; });
      showFlash(`[${name}] ошибка соединения`, false);
    };
  };

  const watchOne = (id: number, name: string) => {
    if (watchingOne.has(id)) return;
    setWatchingOne(prev => new Set(prev).add(id));
    attachStream(id, name);
  };

  const watchAll = async () => {
    setWatchingAll(true);
    try {
      const d = await api.dailyAdsWatchAll();
      if (d.ok) {
        const ok = d.results.filter(x => x.ok).length;
        showFlash(`Выполнено: ${ok} аккаунтов`, ok > 0);
        await load();
      } else showFlash((d as { ok: boolean; error?: string }).error ?? 'Ошибка', false);
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setWatchingAll(false); }
  };

  // тянет реальные current/limit_reached с игры по всем аккаунтам (раньше кнопка "Обновить" читала
  // только кэш из БД — тот мог отставать от игры до следующего фактического просмотра рекламы)
  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('dailyads'); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load().then(verifyLive); }, []);

  const data = [...rows]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map(r => ({
      ...r,
      // backend отдаёт {id,name,ok:false,error} БЕЗ current/limit/reward, если по аккаунту ещё нет
      // снимка (см. web/routes/economy.js) — тип DailyAdsRow объявляет их обязательными, но
      // реально они undefined в этом случае; без фолбэков current/(limit||1) давало NaN в
      // прогресс-баре и "undefined/undefined" в тексте
      current:  r.current ?? 0,
      limit:    r.limit ?? 0,
      reward:   r.reward ?? 0,
      _reward:  (r.reward ?? 0) * (r.limit ?? 0), // награда за все просмотры (за просмотр × лимит)
      _done:    r.limit_reached ? 1 : 0,
      _progress: (r.current ?? 0) / (r.limit || 1),
    }));

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Ежедневная реклама" actions={<>
        <Button leadingVisual={SyncIcon} loading={refreshing || verifying} disabled={refreshing || verifying} onClick={refresh}>
          Обновить
        </Button>
        {verifying && <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--fg-muted)' }}>уточняю статус у игры…</span>}
        <Button variant="primary" leadingVisual={EyeIcon} loading={watchingAll} disabled={watchingAll} onClick={watchAll}>
          Смотреть всем
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Table.Container>
        <DataTable
          data={data}
          initialSortColumn="name"
          initialSortDirection="ASC"
          columns={narrowCols<typeof data[number]>(narrow, ['name', '_progress', 'action'], [
            {
              header: 'Аккаунт',
              field: 'name',
              rowHeader: true,
              sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.name}</strong>,
            },
            {
              header: 'Прогресс',
              field: '_progress',
              sortBy: 'basic',
              renderCell: row => {
                if (!row.ok) return <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{row.error ?? 'нет данных'}</span>;
                const live = liveProgress.get(row.id);
                const current = live?.current ?? row.current;
                const limit = live?.limit ?? row.limit;
                return (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Box sx={{ width: 80 }}>
                      <ProgressBar progress={Math.min(100, Math.round(current / (limit || 1) * 100))} sx={{ mb: 0 }} />
                    </Box>
                    <span className="mono" style={{ fontSize: 11 }}>{current}/{limit}</span>
                  </Box>
                );
              },
            },
            {
              header: 'Награда',
              field: '_reward',
              sortBy: 'basic',
              renderCell: row => {
                const total = (row.reward ?? 0) * (row.limit ?? 0);
                return <span className="mono">{total > 0 ? <CoinValue value={fmt(total)} /> : '—'}</span>;
              },
            },
            {
              header: 'Статус',
              field: '_done',
              sortBy: 'basic',
              renderCell: row => row.stale
                ? <Label variant="secondary" title="данные за прошлые сутки — уточняются у игры">Нужно обновить</Label>
                : row.limit_reached
                  ? <Label variant="success">Готово</Label>
                  : <Label>Доступно</Label>,
            },
            {
              header: '',
              field: 'name',
              id: 'action',
              align: 'end',
              renderCell: row => (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {(!row.limit_reached || row.stale) && (
                    <Button
                      variant="primary"
                      leadingVisual={EyeIcon}
                      loading={watchingOne.has(row.id)}
                      disabled={watchingOne.has(row.id)}
                      onClick={() => watchOne(row.id, row.name)}
                    >
                      Смотреть
                    </Button>
                  )}
                </Box>
              ),
            },
          ])}
        />
      </Table.Container>
    </Box>
  );
}
