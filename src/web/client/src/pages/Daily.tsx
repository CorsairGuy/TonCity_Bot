import { useState, useEffect } from 'react';
import { Box, Button, Flash, Text, Tooltip, Spinner } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, type DailyRewardAccount, type DailyRewardDay } from '../api';
import { fmt, sortByName, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinIcon, CrystalIcon } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';

// 13.10.2026: было таблицей на одну (последнюю) строку — переделано в карточки на весь 28-дневный
// цикл, как на страницах Предметы/Политики. Один flex-wrap ряд на аккаунт — сам переносится по
// ширине экрана. Источник данных — только БД (см. web/routes/dashboards.js /api/daily), ни одного
// живого запроса при открытии: снимок уже обновляет суточный цикл бота и кнопка "Обновить".
function DayCard({ day }: { day: DailyRewardDay }) {
  const isItem = day.reward_type === 'item' && day.item_id != null;
  const meta = isItem ? (ITEMS_BY_ID[Number(day.item_id)] ?? null) : null;
  const label = day.source === 'actual' ? 'получено' : day.source === 'estimated' ? 'оценка (забрано в игре)' : 'ожидается';
  const tooltip = `День ${day.day} — ${label}`;
  // 15.10.2026: сегодня — мягкий ореол цвета редкости, прошедшие дни — обычные карточки,
  // будущие — приглушены (как «прожектор»), см. .dr-today/.dr-future в global.css
  const future = day.source === 'upcoming' && !day.is_today;

  return (
    <Tooltip text={tooltip} direction="n" noDelay>
      <div className="item-card" aria-label={tooltip}>
        <div
          className={`item-card__box${meta ? ` ic-${meta.tag}` : isItem ? '' : day.reward_type === 'crystals' ? ' dr-crystals' : ' dr-coins'}${day.is_today ? ' dr-today' : future ? ' dr-future' : ''}`}
        >
          {isItem
            ? (meta
              // тот же масштаб, что на странице Предметов (meta.scale у каждого предмета свой) —
              // раньше здесь был произвольный height:44, из-за чего иконка выглядела не как везде
              ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name} style={{ scale: String(meta.scale) }}
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
              : <span style={{ fontSize: 9 }}>#{day.item_id}</span>)
            // монеты/кристаллы — иконка над суммой на полупрозрачной подложке своего цвета (как у
            // редкостей): читается и на светлой, и на тёмной теме, длинные суммы не обрезаются
            : <>
              {day.reward_type === 'crystals' ? <CrystalIcon size={26} /> : <CoinIcon size={26} />}
              <span className="dr-amount">{fmt(day.amount)}</span>
            </>}
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
      <PageHeader title="Ежедневная награда" actions={<>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {loading
        ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        : accounts.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет аккаунтов</Text>
          : accounts.map(a => <AccountRewards key={a.name} data={a} />)}
    </Box>
  );
}
