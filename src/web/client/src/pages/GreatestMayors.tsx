import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, CounterLabel, Flash, SegmentedControl, Spinner, Text } from '@primer/react';
import { PeopleIcon, SyncIcon, TrophyIcon } from '@primer/octicons-react';
import { api, type LbPlayer, type LeaderboardGlobal } from '../api';
import { PageHeader } from '../components/PageHeader';
import { CoinIcon } from '../components/Icons';
import { cityHref, isLeague, LeagueIcon, MEDAL, mayorLeague, Place, PlayerAvatar, PopValue, ProfitValue, type League } from '../components/League';

type Metric = 'population' | 'profit';
const TOP = 500;
const STEP = 50;

// «Величайшие мэры» — топ-500 игры по населению и по доходу (как в игре: подиум и список),
// плюс места своих аккаунтов. Данные — /api/leaderboard/global (сервер кэширует 10 минут).
export function GreatestMayors() {
  const [data, setData] = useState<LeaderboardGlobal | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<Metric>('population');
  const [shown, setShown] = useState(STEP);
  const [allOwn, setAllOwn] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try { setData(await api.leaderboardGlobal(force)); }
    catch (e) { setData({ ok: false, error: String(e) }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => (metric === 'population' ? data?.population : data?.profit) ?? [], [data, metric]);
  const value = (p: { population: number | null; profit: number | null }) => metric === 'population' ? p.population : p.profit;

  // свои аккаунты: из топа — с местом и аватаром, остальные — «500+» со своими показателями из БД
  const own = useMemo(() => {
    const inTop = new Map(list.filter(p => p.account).map(p => [p.account!, p]));
    return (data?.own ?? []).map(o => {
      const p = inTop.get(o.account);
      return {
        account: o.account, rank: p?.rank ?? null, small_url: p?.small_url ?? null,
        league: (isLeague(p?.league) ? p!.league : mayorLeague(o.population)) as League | null,
        population: p?.population ?? o.population, profit: p?.profit ?? o.profit,
      };
    }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (value(b) ?? 0) - (value(a) ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, list]);
  const ownInTop = own.filter(o => o.rank != null).length;
  const ownShown = allOwn ? own : own.slice(0, Math.max(5, ownInTop));

  const Val = ({ p, strong = true }: { p: { population: number | null; profit: number | null }; strong?: boolean }) =>
    metric === 'population' ? <PopValue v={p.population} strong={strong} /> : <ProfitValue v={p.profit} strong={strong} />;

  const sub = data?.updated_at ? `топ-${TOP} игры · обновлено ${new Date(data.updated_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : `топ-${TOP} игры`;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Величайшие мэры" sub={sub} actions={<>
        <SegmentedControl aria-label="Метрика рейтинга" size="small" onChange={i => { setMetric(i ? 'profit' : 'population'); setShown(STEP); }}>
          <SegmentedControl.Button selected={metric === 'population'} leadingIcon={PeopleIcon}>Население</SegmentedControl.Button>
          <SegmentedControl.Button selected={metric === 'profit'} leadingIcon={() => <CoinIcon size={14} />}>Доход</SegmentedControl.Button>
        </SegmentedControl>
        <Button leadingVisual={SyncIcon} onClick={() => load(true)} disabled={loading}>Обновить</Button>
      </>} />

      {data?.error && <Flash variant={data.stale ? 'warning' : 'danger'} sx={{ mb: 3 }}>
        {data.stale ? 'Не удалось обновить, показан прошлый снимок: ' : 'Не удалось загрузить рейтинг: '}{data.error}
      </Flash>}

      {!data && loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><Spinner /></Box>}

      {list.length > 0 && (
        <Box sx={{ maxWidth: 820, mx: 'auto' }}>
          <Podium top={list.slice(0, 3)} Val={Val} onOpen={p => navigate(cityHref(p, 'top'))} />

          {own.length > 0 && (
            <Card sx={{ mb: 3 }}>
              <CardHead><TrophyIcon />Наши аккаунты<CounterLabel>{ownInTop} в топе</CounterLabel></CardHead>
              {ownShown.map(o => (
                <Row key={o.account} me onClick={() => navigate(`/city-map?account=${encodeURIComponent(o.account)}`)}>
                  <Box sx={{ width: 48, flexShrink: 0 }}><Place n={o.rank} /></Box>
                  {o.league ? <LeagueIcon league={o.league} size={24} /> : <Box sx={{ width: 20 }} />}
                  <Who name={o.account} src={o.small_url} />
                  <Val p={o} />
                </Row>
              ))}
              {own.length > ownShown.length || allOwn ? (
                <Box sx={{ px: 3, py: 1, borderTop: '1px solid', borderColor: 'border.muted' }}>
                  <Button variant="invisible" size="small" onClick={() => setAllOwn(v => !v)}>
                    {allOwn ? 'Свернуть' : `Показать все (${own.length})`}
                  </Button>
                </Box>
              ) : null}
            </Card>
          )}

          <Card>
            {list.slice(3, shown + 3).map(p => (
              <Row key={p.user_id} me={!!p.account} onClick={() => navigate(cityHref(p, 'top'))}>
                <Box sx={{ width: 48, flexShrink: 0 }}><Place n={p.rank} /></Box>
                {isLeague(p.league) ? <LeagueIcon league={p.league} size={24} /> : <Box sx={{ width: 20 }} />}
                <Who name={p.name} src={p.small_url} own={p.account} />
                <Val p={p} />
              </Row>
            ))}
            {list.length > shown + 3 && (
              <Box sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'border.muted', display: 'flex', justifyContent: 'center' }}>
                <Button size="small" onClick={() => setShown(s => s + STEP)}>Показать ещё {Math.min(STEP, list.length - shown - 3)}</Button>
              </Box>
            )}
          </Card>
        </Box>
      )}
      {data?.ok && !list.length && <Text sx={{ color: 'fg.muted' }}>Здесь пока никого нет</Text>}
    </Box>
  );
}

function Podium({ top, Val, onOpen }: { top: LbPlayer[]; Val: (p: { p: LbPlayer }) => JSX.Element; onOpen: (p: LbPlayer) => void }) {
  // порядок на подиуме: 2 — 1 — 3
  const order = [1, 0, 2].filter(i => top[i]);
  const H = [128, 96, 76], AV = [72, 56, 56];
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: [2, 3], mb: 3 }}>
      {order.map(i => {
        const p = top[i];
        return (
          <Box key={p.user_id} onClick={() => onOpen(p)} title="Открыть город" sx={{ width: 190, minWidth: 0, flexShrink: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, cursor: 'pointer' }}>
            <Box sx={{ position: 'relative', width: 'fit-content' }}>
              <Box sx={{ borderRadius: '50%', p: '3px', bg: MEDAL[i], display: 'flex' }}><PlayerAvatar src={p.small_url} name={p.name} size={AV[i]} /></Box>
              {isLeague(p.league) && <Box sx={{ position: 'absolute', right: '-8px', bottom: '-4px' }}><LeagueIcon league={p.league} size={28} /></Box>}
            </Box>
            <Text sx={{ fontWeight: 'bold', mt: 1, maxWidth: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</Text>
            {p.account && <Text sx={{ fontSize: 0, color: 'accent.fg' }}>наш</Text>}
            <Val p={p} />
            <Box sx={{ width: '100%', height: H[i], mt: 1, borderRadius: '8px 8px 0 0', border: '1px solid', borderColor: 'border.default', borderBottom: 0,
              bg: 'canvas.subtle', boxShadow: `inset 0 3px 0 ${MEDAL[i]}`, display: 'flex', justifyContent: 'center', pt: 2 }}>
              <Text sx={{ fontSize: 5, fontWeight: 'bold', color: MEDAL[i] }}>{i + 1}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Card({ children, sx }: { children: React.ReactNode; sx?: object }) {
  return <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, bg: 'canvas.default', overflow: 'hidden', ...sx }}>{children}</Box>;
}
function CardHead({ children }: { children: React.ReactNode }) {
  return <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, fontWeight: 'bold', fontSize: 1 }}>{children}</Box>;
}
// строка списка; свой аккаунт подсвечен полосой слева, клик открывает карту города
function Row({ me, children, onClick }: { me?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Box onClick={onClick} title={onClick ? 'Открыть город' : undefined} sx={{ display: 'flex', alignItems: 'center', gap: [2, 3], px: 3, py: '7px', borderTop: '1px solid', borderColor: 'border.muted',
      bg: me ? 'accent.subtle' : undefined, boxShadow: me ? 'inset 3px 0 0 var(--fgColor-accent, #0969da)' : undefined,
      cursor: onClick ? 'pointer' : undefined, '&:hover': onClick ? { bg: me ? 'accent.muted' : 'canvas.subtle' } : undefined }}>
      {children}
    </Box>
  );
}
function Who({ name, src, own }: { name: string; src: string | null; own?: string | null }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flex: 1 }}>
      <PlayerAvatar src={src} name={name} size={28} />
      <Text sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: own ? 'bold' : 'normal' }}>{name}</Text>
      {own && own !== name && <Text sx={{ fontSize: 0, color: 'fg.muted', whiteSpace: 'nowrap' }}>({own})</Text>}
    </Box>
  );
}
