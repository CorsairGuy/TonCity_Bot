import { useState, useEffect } from 'react';
import { Box, Button, Flash, Spinner, Text, Tooltip } from '@primer/react';
import { api, type AchievementEntry } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt } from '../utils';
import { PageHeader } from '../components/PageHeader';

// Иконки и названия — как в игре (mdi-классы из клиента игры)
const ACHIEV_META: Record<string, { name: string; mdi: string; secret?: boolean; fixedTier?: number }> = {
  gold_rush:    { name: 'Золотая лихорадка', mdi: 'gold' },
  magnate:      { name: 'Магнат',            mdi: 'cash-multiple' },
  metropolia:   { name: 'Метрополия',        mdi: 'city' },
  trader:       { name: 'Трейдер',           mdi: 'finance' },
  stargazer:    { name: 'Звездочёт',         mdi: 'star' },
  market_maker: { name: 'Брокер',            mdi: 'swap-horizontal-bold' },
  the_original: { name: 'Завсегдатай',       mdi: 'calendar-check' },
  prime_time:   { name: 'Прайм-тайм',        mdi: 'play-circle' },
  ton_trader:   { name: 'Крипто-кит',        mdi: 'currency-btc' },
  perfect_letter:{ name: 'Буквоед',          mdi: 'alpha-a-box' },
  clean_sweep:  { name: 'Без осечки',        mdi: 'bomb' },
  architect:    { name: 'Архитектор',        mdi: 'home-city' },
  networker:    { name: 'Общительный',       mdi: 'account-group' },
  numbers_game: { name: 'Повелитель цифр',   mdi: 'numeric-9-plus-box' },
  patron:       { name: 'Меценат',           mdi: 'hand-heart' },
  brainiac:     { name: 'Знаток',            mdi: 'brain' },
  tile_master:  { name: 'Нумеролог',         mdi: 'numeric' },
  lucky_break:  { name: 'Счастливчик',       mdi: 'gift' },
  fmn:          { name: 'Рыбак',             mdi: 'fish',        secret: true, fixedTier: 2 },
  jpt:          { name: 'Джекпот',           mdi: 'slot-machine',secret: true, fixedTier: 5 },
  utp:          { name: 'Совершенство',      mdi: 'crown',       secret: true, fixedTier: 4 },
};

const META_ORDER = Object.keys(ACHIEV_META);

// Сплошные цвета уровней — из тиров игры (grey/bronze/silver/gold/sapphire/emerald/ruby), без градиента.
// index 0 не используется для открытых (см. логику ниже).
const TIER_COLOR = [
  '#3a3a3a', // 0 — не используется как фон открытых
  '#8d6e63', // 1 bronze
  '#939a9f', // 2 silver
  '#c89b3a', // 3 gold
  '#4564c4', // 4 sapphire
  '#11a571', // 5 emerald
  '#d81e3a', // 6 ruby
];
const TIER_SHADOW = [
  'none',
  '0 2px 10px #8d6e6355',
  '0 2px 10px #939a9f55',
  '0 0 12px #c89b3a88',
  '0 0 12px #4564c488',
  '0 0 12px #11a57188',
  '0 0 14px #d81e3a99',
];
const CLOSED_BG = '#e8edf1';      // закрытые обычные — светлые
const CLOSED_ICON = '#aab6c0';
const SECRET_BG = '#2f2f2f';      // закрытые секретные — тёмные (как есть)

type AccountAch = { name: string; progress?: number; tiers?: { tier: number; requirement: number }[]; secret?: boolean; updated_at?: string };

function getCurrentTier(d: AccountAch, meta: (typeof ACHIEV_META)[string]): number {
  if (meta.fixedTier !== undefined) return meta.fixedTier;
  const tiers = (d.tiers ?? []) as { tier: number; requirement: number }[];
  let cur = 0;
  const sorted = [...tiers].sort((a, b) => a.tier - b.tier);
  for (const t of sorted) {
    if ((d.progress ?? 0) >= t.requirement) cur = t.tier;
  }
  return Math.min(cur, TIER_COLOR.length - 1);
}

// 13.10.2026: подпись под иконкой убрана (разной длины названия ломали ровную сетку) — вместо неё
// мгновенный Tooltip (noDelay) с названием и прогрессом конкретного достижения, см. AchievBadge.
function Badge({ bg, shadow, icon, iconColor, tooltip }: {
  bg: string; shadow: string; icon: string; iconColor: string; tooltip: string;
}) {
  return (
    <Tooltip text={tooltip} direction="n" noDelay>
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', width: 68 }} aria-label={tooltip}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: bg, boxShadow: shadow, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span className={`mdi mdi-${icon}`} style={{ fontSize: 28, color: iconColor, lineHeight: 1 }} />
        </div>
      </div>
    </Tooltip>
  );
}

function AchievBadge({ id, data }: { id: string; data: AccountAch | undefined }) {
  const meta = ACHIEV_META[id] ?? { name: id, mdi: 'medal' };
  const tier = data ? getCurrentTier(data, meta) : 0;
  const earned = tier >= 1;

  // закрытое секретное — тёмное (как есть)
  if (meta.secret && !earned) {
    return <Badge bg={SECRET_BG} shadow="none" icon="lock" iconColor="rgba(255,255,255,.4)" tooltip="Секрет" />;
  }
  // текст тултипа: название + прогресс до следующего уровня (или "максимум", если дальше некуда)
  const tiersSorted = [...(data?.tiers ?? [])].sort((a, b) => a.tier - b.tier);
  const next = tiersSorted.find(t => t.tier > tier);
  const tooltip = next
    ? `${meta.name} — ${fmt(data?.progress ?? 0)}/${fmt(next.requirement)}${tier > 0 ? ` (ур. ${tier})` : ''}`
    : `${meta.name}${tier > 0 ? ' — максимальный уровень' : ''}`;
  // закрытое обычное — светлое, чтобы открытые выделялись
  if (!earned) {
    return <Badge bg={CLOSED_BG} shadow="none" icon={meta.mdi} iconColor={CLOSED_ICON} tooltip={tooltip} />;
  }
  // открытое — сплошной цвет уровня
  return <Badge bg={TIER_COLOR[tier]} shadow={TIER_SHADOW[tier]} icon={meta.mdi} iconColor="#fff" tooltip={tooltip} />;
}

export function Achievements() {
  const [achievements, setAchievements] = useState<AchievementEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:achievements', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.achievements();
      if (d.ok) setAchievements(d.achievements);
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('achievements'); await load(); showFlash('Обновлено', true); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  // per-account map: name → Map<achievId, data>
  const accMap = new Map<string, Map<string, AccountAch>>();
  for (const ach of achievements) {
    const id = String(ach.id);
    for (const x of ach.accounts) {
      if (!accMap.has(x.name)) accMap.set(x.name, new Map());
      accMap.get(x.name)!.set(id, x as AccountAch);
    }
  }

  const extraIds = achievements.map(a => String(a.id)).filter(id => !ACHIEV_META[id]);
  const allIds = [...META_ORDER, ...extraIds];
  const accounts = [...accMap.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Достижения" actions={<>
        <Button onClick={refresh} disabled={refreshing} loading={refreshing}>
          ↻ Обновить
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {accounts.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных — запустите бота</Text>
        : accounts.map(name => {
          const data = accMap.get(name)!;
          return (
            <Box key={name} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: '10px', bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
                <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{name}</Text>
              </Box>
              <div style={{ padding: '10px 14px 14px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {allIds.map(id => (
                  <AchievBadge key={id} id={id} data={data.get(id)} />
                ))}
              </div>
            </Box>
          );
        })
      }
    </Box>
  );
}
