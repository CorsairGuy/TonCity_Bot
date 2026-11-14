import { useState } from 'react';
import { Box, Button, Flash, Text } from '@primer/react';
import { GiftIcon, HistoryIcon, PeopleIcon, PlusIcon, SyncIcon } from '@primer/octicons-react';
import { api } from '../api';
import { useExtra } from '../hooks/useExtra';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { fmt, fmtInt } from '../utils';
import { CoinIcon, CoinValue, CrystalIcon, CrystalValue } from './Icons';
import { CatTabs } from './SidePage';
import { Empty, Row, Summary, Tile, SumLine, Val } from '../pages/cityMapPanels';

// Только явная кнопка страницы/окна вызывает этот refresh. Монтирование читает снимки БД.
export async function refreshGuildTreasury(accountId: number) {
  const results = await Promise.all(['treasury', 'treasury-actions', 'treasury-lb'].map(kind =>
    api.extraRefresh(kind as 'treasury' | 'treasury-actions' | 'treasury-lb', accountId)));
  return results.every(r => r.ok);
}

type Person = { user_id?: number; first_name?: string | null; last_name?: string | null; username?: string | null; name?: string | null };
type GiftLine = { item_id: number; quantity: number };
type TreasuryAction = Person & { action_type?: string; currency?: string; amount?: number | string | null; created_at?: string; items?: GiftLine[]; recipient_name?: string | null; recipients?: number };
type Contributor = Person & { coins_contribution?: number; crystals_contribution?: number };
type Treasury = { coins?: number | string | null; crystals?: number | string | null };
const person = (p: Person) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.username || (p.user_id != null ? `#${p.user_id}` : '—');
const listOf = <T,>(data: unknown, key: string): T[] => Array.isArray(data) ? data as T[]
  : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key]) ? (data as Record<string, T[]>)[key] : [];
const known = (value: unknown): number | null => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const card = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2 } as const;

type TreasuryProps = {
  accountId: number; coins: number | null; crystals: number | null; onDeposit: (currency: 'coins' | 'crystals') => void; onFees: () => void; reloadKey?: number;
};
export function GuildTreasury(props: TreasuryProps) {
  return <GuildTreasuryContent key={`${props.accountId}:${props.reloadKey ?? 0}`} {...props} />;
}
function GuildTreasuryContent({ accountId, coins, crystals, onDeposit, onFees }: TreasuryProps) {
  const treasury = useExtra<Treasury>('treasury', accountId);
  const actions = useExtra<unknown>('treasury-actions', accountId);
  const leaderboard = useExtra<{ coins?: unknown; crystals?: unknown }>('treasury-lb', accountId);
  const [view, setView] = useState(0), [currency, setCurrency] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const acts = listOf<TreasuryAction>(actions.data, 'actions');
  const catalog = useItemCatalog(acts.flatMap(a => (a.items ?? []).map(i => i.item_id)));
  const top = listOf<Contributor>(currency === 0 ? leaderboard.data?.coins : leaderboard.data?.crystals, 'leaderboard');
  const refreshing = treasury.refreshing || actions.refreshing || leaderboard.refreshing;
  const refresh = async () => {
    setNote(null);
    try {
      const result = await Promise.all([treasury.refresh(), actions.refresh(), leaderboard.refresh()]);
      if (result.some(r => !r)) setNote('Часть данных казны обновить не удалось');
    } catch (e) { setNote(String(e)); }
  };
  const error = note || treasury.error || actions.error || leaderboard.error;
  return <>
    {error && <Flash variant="danger" sx={{ mb: 3 }}>{error}</Flash>}
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 3 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{treasury.updatedAt ? `Снимок от ${new Date(treasury.updatedAt).toLocaleString('ru')}` : 'Данных казны ещё нет — нажмите «Обновить казну»'}</Text>
      <Button size="small" leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить казну</Button>
    </Box>
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 3, mb: 3 }}>
      {(['coins', 'crystals'] as const).map(c => {
        const balance = known(treasury.data?.[c]), mine = c === 'coins' ? coins : crystals;
        return <Box key={c} sx={card}>
          <Row lead={c === 'coins' ? <CoinIcon size={30} /> : <CrystalIcon size={30} />} title={c === 'coins' ? 'Монеты казны' : 'Алмазы казны'} sub="Общий баланс гильдии" />
          <Summary tone={c === 'coins' ? 'attention' : 'accent'}>
            <Tile value={balance == null ? '—' : c === 'coins' ? <CoinValue value={fmt(balance)} /> : <CrystalValue value={fmtInt(balance)} />} label="в казне" size={3} />
            <SumLine left="На аккаунте" right={mine == null ? '—' : c === 'coins' ? <CoinValue value={fmt(mine)} /> : <CrystalValue value={fmtInt(mine)} />} />
          </Summary>
          <Button block disabled={mine == null || mine <= 0} onClick={() => onDeposit(c)}>Внести {c === 'coins' ? 'монеты' : 'алмазы'}</Button>
        </Box>;
      })}
    </Box>
    <Box sx={{ ...card, mb: 3 }}>
      <Row lead={<PeopleIcon size={20} />} title="Членский взнос" sub="Текущий долг проверяется по кнопке, отдельно от добровольного взноса" trail={<Button size="small" onClick={onFees}>Проверить взнос</Button>} />
    </Box>
    <Box sx={{ ...card, mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'semibold', flex: 1 }}>{view === 0 ? 'История казны' : 'Лучшие вкладчики'}</Text>
        <Box sx={{ minWidth: 220 }}><CatTabs tabs={['История', 'Вкладчики']} value={view} onChange={setView} /></Box>
      </Box>
      {view === 0 ? acts.length ? acts.slice(0, 30).map((a, i) => {
        const gift = !!a.items?.length, amount = known(a.amount), incoming = a.action_type === 'deposit';
        const value = amount == null ? '—' : `${incoming ? '+' : '−'}${a.currency === 'coins' ? fmt(amount) : fmtInt(amount)}`;
        return <Row key={i} lead={<Box sx={{ width: 36, height: 36, borderRadius: 2, bg: 'canvas.default', display: 'grid', placeItems: 'center', color: incoming ? 'success.fg' : 'accent.fg', flexShrink: 0 }}>{gift ? <GiftIcon size={18} /> : incoming ? <PlusIcon size={18} /> : <HistoryIcon size={18} />}</Box>}
          title={`${person(a)}${gift ? ' · подарки' : ''}`}
          sub={<>{a.created_at ? new Date(a.created_at).toLocaleString('ru') : 'Время неизвестно'}{gift && <> · {a.items!.map(x => `${itemName(x.item_id, catalog)} ×${x.quantity}`).join(', ')} → {a.recipient_name || (a.recipients != null ? `${a.recipients} получателей` : 'участникам')}</>}</>}
          trail={<Val color={incoming ? 'success.fg' : 'fg.default'}>{a.currency === 'coins' ? <CoinValue value={value} /> : a.currency === 'crystals' ? <CrystalValue value={value} /> : value}</Val>} />;
      }) : <Empty>{actions.updatedAt ? 'Операций нет' : 'Нет сохранённой истории'}</Empty> : <>
        <CatTabs tabs={['Монеты', 'Алмазы']} value={currency} onChange={setCurrency} />
        {top.length ? top.slice(0, 20).map((r, i) => <Row key={i} title={`${i + 1}. ${person(r)}`} trail={currency === 0 ? <CoinValue value={r.coins_contribution == null ? '—' : fmt(r.coins_contribution)} /> : <CrystalValue value={r.crystals_contribution == null ? '—' : fmtInt(r.crystals_contribution)} />} />) : <Empty>{leaderboard.updatedAt ? 'Вкладчиков нет' : 'Нет сохранённых вкладчиков'}</Empty>}
      </>}
    </Box>
  </>;
}
