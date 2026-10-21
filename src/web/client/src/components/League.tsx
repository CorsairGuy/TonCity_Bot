import { useState } from 'react';
import { Box, Text } from '@primer/react';
import { PeopleIcon } from '@primer/octicons-react';
import { CoinIcon } from './Icons';
import { fmt } from '../utils';

// Лиги игры и общие кусочки страниц рейтинга («Величайшие мэры», «Лиги»).
// Пороги — из бандла игры: лига мэра считается по населению (VU в entry), лига гильдии — по доходу
// в час (W в chunks/leaderboard). Значение — верхняя граница лиги, у вечной её нет.
export type League = 'wooden' | 'bronze' | 'silver' | 'golden' | 'platinum' | 'diamond' | 'quantum' | 'celestial' | 'limitless';
export const LEAGUES: League[] = ['wooden', 'bronze', 'silver', 'golden', 'platinum', 'diamond', 'quantum', 'celestial', 'limitless'];
export const LEAGUE_RU: Record<League, string> = {
  wooden: 'Деревянная', bronze: 'Бронзовая', silver: 'Серебряная', golden: 'Золотая', platinum: 'Платиновая',
  diamond: 'Бриллиантовая', quantum: 'Квантовая', celestial: 'Небесная', limitless: 'Вечная',
};
export const MAYOR_UP: Record<League, number> = {
  wooden: 100, bronze: 1e3, silver: 1e4, golden: 5e4, platinum: 25e4, diamond: 1e6, quantum: 1e7, celestial: 1e8, limitless: Infinity,
};
export const GUILD_UP: Record<League, number> = {
  wooden: 1e6, bronze: 1e7, silver: 1e8, golden: 1e9, platinum: 1e10, diamond: 1e11, quantum: 1e12, celestial: 1e13, limitless: Infinity,
};
export const isLeague = (l: unknown): l is League => LEAGUES.includes(l as League);
// нижняя граница лиги = верхняя граница предыдущей
export const leagueFrom = (l: League, up: Record<League, number>) => { const i = LEAGUES.indexOf(l); return i > 0 ? up[LEAGUES[i - 1]] : 0; };
export const mayorLeague = (population: number | null): League | null =>
  population == null ? null : LEAGUES.find(l => population < MAYOR_UP[l]) ?? 'limitless';

export function LeagueIcon({ league, size = 20 }: { league: League; size?: number }) {
  return <img src={`/leagues/${league}.png`} alt="" title={`${LEAGUE_RU[league]} лига`} style={{ height: size, width: 'auto', display: 'block', flexShrink: 0 }} />;
}

// Аватар игрока: картинка из игры, без неё (или если не загрузилась) — первая буква имени на цветном круге
const HUES = [210, 25, 140, 280, 0, 45, 190, 320, 100, 260];
export function PlayerAvatar({ src, name, size = 24, square }: { src?: string | null; name: string; size?: number; square?: boolean }) {
  const [broken, setBroken] = useState(false);
  const radius = square ? 6 : '50%';
  if (src && !broken) return <img src={src} alt="" onError={() => setBroken(true)} style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', flexShrink: 0 }} />;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <Box sx={{ width: size, height: size, borderRadius: radius, flexShrink: 0, bg: `hsl(${HUES[h % HUES.length]},45%,45%)`, color: '#fff',
      fontWeight: 'bold', fontSize: `${Math.round(size * 0.45)}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </Box>
  );
}

export const MEDAL = ['#d4a017', '#a8b2bd', '#c27c4e'];
// место: медаль для первой тройки, «500+» (или другой подписи) — вне рейтинга
export function Place({ n, outside = '500+' }: { n: number | null; outside?: string }) {
  if (n == null) return <Text sx={{ color: 'fg.subtle', fontVariantNumeric: 'tabular-nums' }}>{outside}</Text>;
  if (n <= 3) return (
    <Box sx={{ width: 26, height: 26, borderRadius: '50%', bg: MEDAL[n - 1], color: '#fff', fontWeight: 'bold', fontSize: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n}</Box>
  );
  return <Text sx={{ fontWeight: 'bold', color: 'fg.muted', fontVariantNumeric: 'tabular-nums' }}>#{n}</Text>;
}

const valSx = (strong?: boolean) => ({
  display: 'inline-flex', alignItems: 'center', gap: 1, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums',
  fontWeight: strong ? 'bold' : 'normal', color: strong ? 'fg.default' : 'fg.muted',
});
export const PopValue = ({ v, strong }: { v: number | null; strong?: boolean }) =>
  <Box as="span" sx={valSx(strong)}>{v == null ? '—' : fmt(v)}<PeopleIcon size={14} /></Box>;
export const ProfitValue = ({ v, strong }: { v: number | null; strong?: boolean }) =>
  <Box as="span" sx={valSx(strong)}>{v == null ? '—' : fmt(v)}<CoinIcon size={14} /><Text sx={{ fontWeight: 'normal', color: 'fg.subtle', fontSize: 0 }}>/ч</Text></Box>;
