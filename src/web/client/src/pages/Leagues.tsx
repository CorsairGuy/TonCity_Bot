import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Flash, Label, SegmentedControl, Spinner, Text, Token } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { ChevronDownIcon, ChevronRightIcon, PeopleIcon, SyncIcon } from '@primer/octicons-react';
import { api, type LbGuild, type LbPlayer, type LeaderboardLeagues } from '../api';
import { PageHeader } from '../components/PageHeader';
import { CoinIcon } from '../components/Icons';
import { fmt } from '../utils';
import { useNarrow } from '../hooks/useNarrow';
import {
  GUILD_UP, isLeague, LEAGUE_RU, LEAGUES, LeagueIcon, leagueFrom, MAYOR_UP, mayorLeague, Place, PlayerAvatar, PopValue, ProfitValue, type League,
} from '../components/League';

type Kind = 'players' | 'guilds';
const LADDER = [...LEAGUES].reverse(); // сверху вниз: от вечной к деревянной
const TOKENS = 8;  // сколько своих аккаунтов показывать в строке лиги, остальное — «+N»
const FIRST = 20;  // строк в раскрытой лиге до «Показать все»

// Лиги игры — «лестница»: все 9 лиг сверху вниз с порогом, своими аккаунтами и лидером, раскрытая лига —
// её топ-100. Мэры делятся по населению, гильдии — по доходу в час. Данные — /api/leaderboard/leagues.
export function Leagues() {
  const [data, setData] = useState<LeaderboardLeagues | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>('players');
  const [open, setOpen] = useState<League | null>(null);
  const [full, setFull] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try { setData(await api.leaderboardLeagues(force)); }
    catch (e) { setData({ ok: false, error: String(e) }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const byLeague = useMemo(() => {
    const m = new Map<League, (LbPlayer | LbGuild)[]>();
    for (const e of (kind === 'players' ? data?.players : data?.guilds) ?? []) {
      if (!isLeague(e.league)) continue;
      if (!m.has(e.league)) m.set(e.league, []);
      m.get(e.league)!.push(e);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.rank - b.rank);
    return m;
  }, [data, kind]);

  // свои: аккаунты — по лиге из их населения (как считает игра), гильдии — те, что нашлись в списках
  const own = useMemo(() => {
    const m = new Map<League, { key: string; name: string; src: string | null }[]>();
    const add = (l: League | null, v: { key: string; name: string; src: string | null }) => { if (!l) return; if (!m.has(l)) m.set(l, []); m.get(l)!.push(v); };
    if (kind === 'players') {
      const seen = new Map((data?.players ?? []).filter(p => p.account).map(p => [p.account!, p]));
      for (const o of [...(data?.own ?? [])].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))) {
        const p = seen.get(o.account);
        add(p && isLeague(p.league) ? p.league : mayorLeague(o.population), { key: o.account, name: o.account, src: p?.small_url ?? null });
      }
    } else {
      for (const g of data?.guilds ?? []) if (g.own && isLeague(g.league)) add(g.league, { key: String(g.id), name: g.title, src: g.photo });
    }
    return m;
  }, [data, kind]);

  // по умолчанию раскрыта самая высокая лига, где есть свои
  useEffect(() => {
    if (!data?.ok) return;
    setOpen(LADDER.find(l => own.get(l)?.length) ?? LADDER.find(l => byLeague.get(l)?.length) ?? null);
    setFull(false);
  }, [data, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const up = kind === 'players' ? MAYOR_UP : GUILD_UP;
  const sub = data?.updated_at ? `топ-100 каждой лиги · обновлено ${new Date(data.updated_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : 'топ-100 каждой лиги';

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Лиги" sub={sub} actions={<>
        <SegmentedControl aria-label="Мэры или гильдии" size="small" onChange={i => setKind(i ? 'guilds' : 'players')}>
          <SegmentedControl.Button selected={kind === 'players'}>Мэры</SegmentedControl.Button>
          <SegmentedControl.Button selected={kind === 'guilds'}>Гильдии</SegmentedControl.Button>
        </SegmentedControl>
        <Button leadingVisual={SyncIcon} onClick={() => load(true)} disabled={loading}>Обновить</Button>
      </>} />

      {data?.error && <Flash variant={data.stale ? 'warning' : 'danger'} sx={{ mb: 3 }}>
        {data.stale ? 'Не удалось обновить, показан прошлый снимок: ' : 'Не удалось загрузить лиги: '}{data.error}
      </Flash>}
      {!data && loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><Spinner /></Box>}

      {data?.ok && (
        <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, bg: 'canvas.default', overflow: 'hidden' }}>
          {LADDER.map((l, i) => {
            const list = byLeague.get(l) ?? [];
            const mine = own.get(l) ?? [];
            const isOpen = open === l;
            const from = leagueFrom(l, up);
            const leader = list[0];
            return (
              <Box key={l} sx={{ borderTop: i ? '1px solid' : 0, borderColor: 'border.default' }}>
                <Box as="button" type="button" onClick={() => { setOpen(isOpen ? null : l); setFull(false); }}
                  sx={{ all: 'unset', boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: [2, 3], px: 3, py: 2, cursor: 'pointer',
                    bg: isOpen ? 'canvas.subtle' : undefined, '&:hover': { bg: 'canvas.subtle' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'accent.fg' } }}>
                  <Box sx={{ color: 'fg.muted', display: 'flex' }}>{isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}</Box>
                  <LeagueIcon league={l} size={36} />
                  <Box sx={{ width: [120, 170], flexShrink: 0 }}>
                    <Text sx={{ fontWeight: 'bold', display: 'block' }}>{LEAGUE_RU[l]}</Text>
                    <Box sx={{ fontSize: 0, color: 'fg.muted', display: 'flex', alignItems: 'center', gap: 1 }}>
                      {from ? `от ${fmt(from)}` : 'с нуля'}{kind === 'players' ? <PeopleIcon size={12} /> : <><CoinIcon size={12} />/ч</>}
                    </Box>
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0, display: ['none', 'flex'], gap: 1, flexWrap: 'wrap' }}>
                    {mine.slice(0, TOKENS).map(o => (
                      <Token key={o.key} text={o.name} leadingVisual={() => <PlayerAvatar src={o.src} name={o.name} size={16} square={kind === 'guilds'} />} />
                    ))}
                    {mine.length > TOKENS && <Token text={`+${mine.length - TOKENS}`} />}
                    {!mine.length && <Text sx={{ fontSize: 1, color: 'fg.subtle' }}>наших нет</Text>}
                  </Box>
                  {mine.length > 0 && <Label variant="accent" sx={{ display: ['inline-flex', 'none'], ml: 'auto' }}>наших {mine.length}</Label>}
                  <Text sx={{ fontSize: 1, color: 'fg.muted', whiteSpace: 'nowrap', display: ['none', 'none', 'block'], ml: 'auto' }}>
                    {leader ? <>лидер: <Text sx={{ fontWeight: 'bold', color: 'fg.default' }}>{'title' in leader ? leader.title : leader.name}</Text></> : 'пока никого'}
                  </Text>
                </Box>
                {isOpen && (
                  <Box sx={{ px: [2, 3], pb: 3, pt: 1, bg: 'canvas.subtle' }}>
                    {list.length ? <>
                      {kind === 'players'
                        ? <PlayersTable list={(full ? list : list.slice(0, FIRST)) as LbPlayer[]} />
                        : <GuildsTable list={(full ? list : list.slice(0, FIRST)) as LbGuild[]} />}
                      {list.length > FIRST && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                          <Button size="small" onClick={() => setFull(v => !v)}>{full ? 'Свернуть' : `Показать все (${list.length})`}</Button>
                        </Box>
                      )}
                    </> : (
                      <Text sx={{ color: 'fg.muted', fontSize: 1 }}>
                        {kind === 'players' ? 'В эту лигу пока не вышел ни один мэр' : 'В эту лигу пока не вышла ни одна гильдия'}
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function PlayersTable({ list }: { list: LbPlayer[] }) {
  const narrow = useNarrow(); // на телефоне население прячем: таблица не влезает в ширину
  return (
    <Table.Container>
      <DataTable aria-label="Мэры лиги" data={list.map(p => ({ ...p, id: p.user_id }))} columns={[
        { header: 'Место', id: 'rank', width: '72px', renderCell: p => <Place n={p.rank} /> },
        { header: 'Мэр', id: 'name', renderCell: p => (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <PlayerAvatar src={p.small_url} name={p.name} />
            <Text sx={{ fontWeight: p.account ? 'bold' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</Text>
            {p.account && <Label variant="accent">наш</Label>}
          </Box>
        ) },
        ...(narrow ? [] : [{ header: 'Население', id: 'population' as const, align: 'end' as const, renderCell: (p: LbPlayer) => <PopValue v={p.population} /> }]),
        { header: 'Доход', id: 'profit', align: 'end', renderCell: p => <ProfitValue v={p.profit} strong /> },
      ]} />
    </Table.Container>
  );
}

function GuildsTable({ list }: { list: LbGuild[] }) {
  const narrow = useNarrow(); // на телефоне население прячем: таблица не влезает в ширину
  return (
    <Table.Container>
      <DataTable aria-label="Гильдии лиги" data={list} columns={[
        { header: 'Место', id: 'rank', width: '72px', renderCell: g => <Place n={g.rank} /> },
        { header: 'Гильдия', id: 'title', renderCell: g => (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <PlayerAvatar src={g.photo} name={g.title} square />
            <Text sx={{ fontWeight: g.own ? 'bold' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</Text>
            {g.own && <Label variant="accent">наша</Label>}
          </Box>
        ) },
        ...(narrow ? [] : [{ header: 'Население', id: 'population' as const, align: 'end' as const, renderCell: (g: LbGuild) => <PopValue v={g.population} /> }]),
        { header: 'Доход', id: 'profit', align: 'end', renderCell: g => <ProfitValue v={g.profit} strong /> },
      ]} />
    </Table.Container>
  );
}
