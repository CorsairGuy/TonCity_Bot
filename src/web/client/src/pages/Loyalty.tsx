import { useState, useEffect } from 'react';
import { Box, Flash, Heading, Text, Spinner, Label, Button } from '@primer/react';
import { api, type LoyaltyRow, type LoyaltyLevel, type LoyaltyReward } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { CrystalValue } from '../components/Icons';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

function isMet(l: LoyaltyLevel): boolean {
  return !!(l.condition?.condition_met ?? l.condition_met);
}

// Собирает бот сам (modules/loyalty.js runLoyalty, раз в сутки на UTC-полночь, см. index.js
// runLoyaltyLoop) — ручной кнопки "Собрать" здесь больше нет, страница только отображает статус.
// БАГ (найден и исправлен 21.07.2026): здесь раньше трактовали НОМЕР уровня (l.level, 1..8) как
// требуемую длину серии — это НЕВЕРНО и не имеет отношения к реальным порогам. Настоящие пороги —
// 3/7/14/30/60/90/180/360 дней (сверено живьём, лежат в l.condition.required_days — игра ИХ ОТДАЁТ,
// вопреки прежнему предположению, что условие только boolean). Из-за старой логики "Готово ≈"
// показывалось почти на всех уровнях уже при streak >8 дней, хотя реальный порог мог требовать ещё
// сотни дней. Теперь сравниваем оценку серии именно с l.condition.required_days.
function estimateStreak(streak: number, updatedAt: string | null, now: number): number {
  if (!updatedAt) return streak;
  const elapsedDays = Math.floor(Math.max(0, now - new Date(updatedAt).getTime()) / 86400000);
  return streak + elapsedDays;
}
function rewardTag(r: LoyaltyReward): string {
  if (r.booster) return r.booster;
  if (r.booster_pack) return r.booster_pack;
  if (r.item_id === 13) return 'component';
  return 'masterplan';
}

function RewardView({ r }: { r: LoyaltyReward }) {
  if (r.type === 'crystals') {
    return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 52, fontWeight: 'bold' }}>
      <CrystalValue value={fmt(r.quantity)} />
    </Box>;
  }
  const tag = rewardTag(r);
  const known = Object.values(ITEMS_BY_ID).find(m => m.tag === tag);
  return (
    <div className={`item-card__box ic-${tag}`} style={{ width: 52, height: 52, flexShrink: 0 }} title={known?.name ?? tag}>
      <img className="item-card__img" src={itemImgSrc(tag)} alt="" style={{ height: 52, scale: String(known?.scale ?? 0.7) }}
        onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
      {r.quantity > 1 && <span className="item-card__count">{r.quantity}</span>}
    </div>
  );
}

function LevelNode({ l, estStreak }: { l: LoyaltyLevel; estStreak: number }) {
  const met = isMet(l);
  const claimed = l.claimed;
  const ready = met && !claimed;
  // не подтверждено игрой (condition_met всё ещё false в снимке), но по оценке серии уже похоже,
  // что бот заберёт награду на следующем проходе (см. modules/loyalty.js) — чисто информационно.
  // ВАЖНО: сравниваем с РЕАЛЬНЫМ порогом (required_days), а НЕ с номером уровня — см. комментарий
  // выше про исправленный баг. Если required_days неизвестен (совсем старый снимок без этого поля) —
  // не показываем "почти готово" вообще, а не гадаем по неверной формуле.
  const requiredDays = l.condition?.required_days;
  const probablyReady = !ready && !claimed && requiredDays != null && requiredDays <= estStreak;
  const border = claimed ? 'var(--borderColor-success-emphasis, #2da44e)' : ready ? '#d4ac0d' : probablyReady ? '#9a6700' : 'var(--borderColor-default, #d0d7de)';

  return (
    <Box sx={{
      position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
      minWidth: 92, p: 2, borderRadius: '14px', border: '2px solid', borderColor: 'transparent',
      bg: 'canvas.default', flexShrink: 0,
      opacity: !met && !claimed ? 0.65 : 1,
      boxShadow: ready ? `0 0 0 2px ${border}, 0 0 10px 0 ${border}66` : probablyReady ? `0 0 0 2px ${border}` : `inset 0 0 0 2px ${border}`,
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
        {(l.rewards ?? []).map((r, i) => <RewardView key={i} r={r} />)}
        {(!l.rewards || l.rewards.length === 0) && <Box sx={{ width: 52, height: 52 }} />}
      </Box>
      <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted' }}>Ур. {l.level}</Text>
      {claimed
        ? <Label variant="success" sx={{ fontSize: 0 }}>Получено</Label>
        : ready
          ? <Label variant="attention" sx={{ fontSize: 0 }}>Готово — заберёт бот</Label>
          : probablyReady
            ? <Label variant="attention" sx={{ fontSize: 0 }}>Готово ≈</Label>
            : <Label variant="secondary" sx={{ fontSize: 0 }}>—</Label>}
    </Box>
  );
}

export function Loyalty() {
  const [rows, setRows] = useState<LoyaltyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:loyalty', () => load());
  const [now, setNow] = useState(() => Date.now());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.loyalty();
      if (d.ok) setRows([...d.rows].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true })));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('loyalty'); await load(); showFlash('Обновлено', true); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(id); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Дорога верности</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button onClick={refresh} disabled={refreshing} loading={refreshing}>
          ↻ Обновить
        </Button>
      </Box>

      {rows.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : rows.map(r => {
          const levels = r.data?.levels ?? [];
          const streak = r.data?.streak ?? 0;
          const estStreak = estimateStreak(streak, r.updated_at, now);
          const claimed = levels.filter(l => l.claimed).length;
          const ready = levels.filter(l => isMet(l) && !l.claimed).length;
          return (
            <Box key={r.account_id} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
              <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Text sx={{ fontWeight: 'bold' }}>{r.account}</Text>
                <Label variant="severe" sx={{ fontSize: 0 }}>
                  🔥 {streak} дней подряд{estStreak > streak && <> (≈{estStreak} сейчас)</>}
                </Label>
                <Box sx={{ ml: 'auto', display: 'flex', gap: 2 }}>
                  {ready > 0 && <Label variant="attention" sx={{ fontSize: 0 }}>Готово к получению: {ready}</Label>}
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Получено {claimed}/{levels.length}</Text>
                </Box>
              </Box>
              <Box sx={{ p: 3, display: 'flex', gap: 2, overflowX: 'auto' }}>
                {levels.map(l => <LevelNode key={l.level} l={l} estStreak={estStreak} />)}
              </Box>
            </Box>
          );
        })
      }
    </Box>
  );
}
