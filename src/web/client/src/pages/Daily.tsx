import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Text, Tooltip, Spinner } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, type DailyRewardAccount, type DailyRewardDay } from '../api';
import { fmt, sortByName, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';

// 13.10.2026: было таблицей на одну (последнюю) строку — переделано в карточки на весь 28-дневный
// цикл, как на страницах Предметы/Политики. Один flex-wrap ряд на аккаунт — сам переносится по
// ширине экрана. Источник данных — только БД (см. web/routes/dashboards.js /api/daily), ни одного
// живого запроса при открытии: снимок уже обновляет суточный цикл бота и кнопка "Обновить".
function DayCard({ day }: { day: DailyRewardDay }) {
  const isItem = day.reward_type === 'item' && day.item_id != null;
  const meta = isItem ? (ITEMS_BY_ID[Number(day.item_id)] ?? null) : null;
  const label = day.source === 'actual' ? 'получено' : day.source === 'estimated' ? 'оценка (забрано в игре)' : 'ожидается';
  const tooltip = `День ${day.day} — ${label}`;
  const dimmed = day.source !== 'upcoming' && !day.is_today;

  return (
    <Tooltip text={tooltip} direction="n" noDelay>
      <div className="item-card" aria-label={tooltip}>
        <div
          className={`item-card__box${meta ? ` ic-${meta.tag}` : ''}`}
          style={{
            background: meta ? undefined : 'var(--bgColor-muted, #2d333b)',
            opacity: dimmed ? 0.55 : 1,
            outline: day.is_today ? '2px solid var(--accent)' : 'none',
            outlineOffset: 2,
          }}
        >
          {isItem
            ? (meta
              // тот же масштаб, что на странице Предметов (meta.scale у каждого предмета свой) —
              // раньше здесь был произвольный height:44, из-за чего иконка выглядела не как везде
              ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name} style={{ scale: String(meta.scale) }}
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
              : <span style={{ fontSize: 9 }}>#{day.item_id}</span>)
            : day.reward_type === 'crystals'
              ? <CrystalValue value={fmt(day.amount)} />
              : <CoinValue value={fmt(day.amount)} />}
        </div>
        <span style={{ fontSize: 10, color: day.is_today ? 'var(--accent)' : 'var(--fg-muted)', fontWeight: day.is_today ? 700 : 400 }}>
          День {day.day}
        </span>
      </div>
    </Tooltip>
  );
}

function AccountRewards({ data }: { data: DailyRewardAccount }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'bold' }}>{data.name}</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          Стрик: {data.streak ?? '—'} {data.last_login && `· последний вход ${data.last_login}`}
        </Text>
      </Box>
      <Box sx={{ p: 3 }}>
        {data.days.length === 0
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Ещё не синхронизировано — появится после ближайшего суточного цикла или кнопки «Обновить»</Text>
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {data.days.map(d => <DayCard key={d.day} day={d} />)}
            </div>
          )}
      </Box>
    </Box>
  );
}

export function Daily() {
  const [accounts, setAccounts] = useState<DailyRewardAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:daily', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.dailyRewards();
      if (d.ok) setAccounts(sortByName(d.accounts, 'name'));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('daily'); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Ежедневная награда</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

      {loading
        ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        : accounts.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет аккаунтов</Text>
          : accounts.map(a => <AccountRewards key={a.name} data={a} />)}
    </Box>
  );
}
