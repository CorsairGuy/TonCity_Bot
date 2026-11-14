import { useState } from 'react';
import { Box, Button, Checkbox, Flash, Label, Spinner, Text, TextInput } from '@primer/react';
import { GiftIcon, HistoryIcon, SyncIcon } from '@primer/octicons-react';
import { Row, Summary, SumLine, Empty } from '../pages/cityMapPanels';
import { api } from '../api';
import { useExtra } from '../hooks/useExtra';
import { useAsk } from '../hooks/useAsk';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { ItemThumb } from './ItemThumb';
import { CrystalValue } from './Icons';

type GiftLine = { item_id: number; quantity: number };
type Gift = { id: number; giver_name?: string; crystals?: number; created_at?: string; recipients: { user_id: number; name?: string; items: GiftLine[] }[] };
type GiftItem = { item_id: number; price: number; weekly_limit: number };
type GiftMember = { user_id: number; name: string; role: string; eligible_in_seconds: number; remaining: Record<string, number> };
export type GiftState = { captured_at?: string; guild_id: string; can_send: boolean; balance: number; resets_in_seconds: number; items: GiftItem[]; members: GiftMember[]; history: { gifts: Gift[]; has_more: boolean } };
type Quantities = Record<number, Record<number, string>>;

export function giftDraft(data: GiftState | null, selected: Set<number>, quantities: Quantities) {
  const gifts: { user_id: number; items: GiftLine[] }[] = [];
  let cost = 0, error = '';
  if (!data) return { gifts, cost, error };
  for (const user_id of selected) {
    const member = data.members.find(m => m.user_id === user_id);
    if (!member || member.eligible_in_seconds > 0) { error = 'Получатель пока недоступен'; continue; }
    const items: GiftLine[] = [];
    for (const item of data.items) {
      const raw = quantities[user_id]?.[item.item_id] ?? '', quantity = raw === '' ? 0 : Number(raw);
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > (member.remaining[String(item.item_id)] ?? 0)) { error = 'Проверьте количества и недельные лимиты'; continue; }
      if (quantity) { items.push({ item_id: item.item_id, quantity }); cost += item.price * quantity; }
    }
    if (items.length) gifts.push({ user_id, items });
  }
  if (!Number.isFinite(cost) || cost > data.balance) error = 'Недостаточно алмазов в казне';
  return { gifts, cost, error };
}
const duration = (seconds: number) => seconds >= 86400 ? `${Math.ceil(seconds / 86400)} дн.` : `${Math.ceil(Math.max(0, seconds) / 3600)} ч.`;

export function GuildGifts({ accountId }: { accountId: number }) {
  const snapshot = useExtra<GiftState>('guild-gifts', accountId);
  const data = snapshot.data;
  const capturedAt = data?.captured_at ?? snapshot.updatedAt;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [quantities, setQuantities] = useState<Quantities>({});
  const [defaults, setDefaults] = useState<Record<number, string>>({});
  const [extraHistory, setExtraHistory] = useState<Gift[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const catalog = useItemCatalog(data?.items?.map(i => i.item_id) ?? []);
  const ask = useAsk();
  const draft = giftDraft(data, selected, quantities);
  const history = [...(data?.history?.gifts ?? []), ...extraHistory];
  const canSend = data?.can_send === true;
  const clear = () => { setSelected(new Set()); setQuantities({}); setExtraHistory([]); setMore(null); };
  const refresh = async () => { if (await snapshot.refresh()) clear(); };
  const toggle = (member: GiftMember) => {
    const next = new Set(selected);
    if (next.has(member.user_id)) next.delete(member.user_id);
    else { next.add(member.user_id); setQuantities(q => ({ ...q, [member.user_id]: Object.fromEntries(data!.items.map(i => [i.item_id, String(Math.min(Number(defaults[i.item_id]) || 0, member.remaining[String(i.item_id)] ?? 0))])) })); }
    setSelected(next);
  };
  const send = async () => {
    if (!data || !canSend || !draft.gifts.length || draft.error || busy) return;
    if (!await ask('Отправить подарки гильдии?', <Box><Text>Получателей: {draft.gifts.length}. Из казны будет списано {draft.cost.toLocaleString('ru')} алмазов.</Text><Box sx={{ mt: 2 }}>{draft.gifts.map(g => <Text key={g.user_id} sx={{ display: 'block' }}>{data.members.find(m => m.user_id === g.user_id)?.name}: {g.items.map(i => `${itemName(i.item_id, catalog)} ×${i.quantity}`).join(', ')}</Text>)}</Box><Text sx={{ display: 'block', mt: 2 }}>Наборы будут привязаны к аккаунтам получателей.</Text></Box>, { ok: 'Отправить' })) return;
    setBusy(true); setNote(null);
    try {
      const r = await api.extraAction<GiftState>('guild-gifts-send', { account_id: accountId, expected_guild_id: data.guild_id, expected_cost: draft.cost, gifts: draft.gifts });
      if (r.data) { snapshot.setData(r.data); clear(); }
      setNote({ ok: r.ok, text: r.ok ? (r.data ? 'Подарки отправлены' : 'Подарки отправлены, но снимок не обновился. Нажмите «Обновить».') : r.error ?? 'Ошибка отправки' });
    } catch (e) { setNote({ ok: false, text: `${String(e)}. Перед повтором проверьте историю подарков.` }); }
    finally { setBusy(false); }
  };
  const loadMore = async () => {
    const before = history[history.length - 1]?.id;
    if (!before || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.extraRefresh<{ gifts: Gift[]; has_more: boolean }>('guild-gifts-history', accountId, before);
      if (r.ok && r.data) { setExtraHistory(h => [...h, ...r.data!.gifts]); setMore(r.data.has_more); }
      else setNote({ ok: false, text: r.error ?? 'Не удалось загрузить историю' });
    } catch (e) { setNote({ ok: false, text: String(e) }); }
    finally { setLoadingMore(false); }
  };
  const card = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2 } as const;
  return <>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
      <Text sx={{ flex: 1, color: 'fg.muted', fontSize: 0 }}>{capturedAt ? `Снимок от ${new Date(capturedAt).toLocaleString('ru')}` : 'Нажмите «Обновить», чтобы получить подарки из игры'}</Text>
      <Button size="small" leadingVisual={SyncIcon} disabled={busy || snapshot.refreshing} loading={snapshot.refreshing} onClick={refresh}>Обновить подарки</Button>
    </Box>
    {(snapshot.error || note) && <Flash variant={note?.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{note?.text ?? snapshot.error}</Flash>}
    {snapshot.loading ? <Spinner /> : data ? <>
      <Box sx={{ ...card, mb: 3 }}>
        <Row lead={<Box sx={{ width: 36, height: 36, borderRadius: 2, bg: 'canvas.default', color: 'accent.fg', display: 'grid', placeItems: 'center', flexShrink: 0 }}><GiftIcon size={18} /></Box>}
          title="Подарки участникам" sub="Наборы привязаны к аккаунтам получателей" trail={<CrystalValue value={`${data.balance.toLocaleString('ru')} в казне`} />} />
        <SumLine left="Сброс недельных лимитов" right={capturedAt ? new Date(Date.parse(capturedAt) + data.resets_in_seconds * 1000).toLocaleString('ru') : `через ${duration(data.resets_in_seconds)}`} />
      </Box>
      {!canSend && <Flash sx={{ mb: 3 }}>Отправка недоступна для этого аккаунта. Можно просмотреть каталог и историю.</Flash>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 3, mb: 3 }}>
        <Box sx={card}>
          <Text sx={{ fontWeight: 'semibold', px: 1 }}>Набор подарков</Text>
          {data.items.map(item => <Row key={item.item_id} lead={<ItemThumb itemId={item.item_id} item={catalog.get(item.item_id)} size={36} />}
            title={itemName(item.item_id, catalog)} sub={<><CrystalValue value={item.price.toLocaleString('ru')} /> · лимит {item.weekly_limit}/нед.</>}
            trail={<TextInput type="number" min={0} step={1} aria-label={`Каждому: ${itemName(item.item_id, catalog)}`} value={defaults[item.item_id] ?? ''} disabled={!canSend || busy} onChange={e => setDefaults(d => ({ ...d, [item.item_id]: e.target.value }))} sx={{ width: 68 }} />} />)}
          <Text sx={{ color: 'fg.muted', fontSize: 0, px: 1 }}>Общее количество применяется при выборе участника. Его набор можно изменить отдельно.</Text>
        </Box>
        <Box sx={card}>
          <Text sx={{ fontWeight: 'semibold', px: 1 }}>Получатели</Text>
          {data.members.map(member => <Row key={member.user_id}
            lead={<Checkbox aria-label={`Подарки: ${member.name}`} checked={selected.has(member.user_id)} disabled={!canSend || busy || member.eligible_in_seconds > 0 || data.items.every(i => !(member.remaining[String(i.item_id)] > 0))} onChange={() => toggle(member)} />}
            title={member.name} trail={<Label>{member.role}</Label>}
            sub={member.eligible_in_seconds > 0 ? `Допуск через ${duration(member.eligible_in_seconds)} от времени снимка` : data.items.map(i => `${itemName(i.item_id, catalog)}: осталось ${member.remaining[String(i.item_id)] ?? 0}`).join(' · ')}>
            {selected.has(member.user_id) && <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', p: 2, pt: 0 }}>{data.items.map(item => <Box key={item.item_id} sx={{ flex: '1 1 120px', minWidth: 0 }}>
              <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', mb: 1 }}>{itemName(item.item_id, catalog)} · осталось {member.remaining[String(item.item_id)] ?? 0}</Text>
              <TextInput block type="number" min={0} max={member.remaining[String(item.item_id)] ?? 0} step={1} aria-label={`${member.name}: ${itemName(item.item_id, catalog)}`} value={quantities[member.user_id]?.[item.item_id] ?? ''} disabled={busy} onChange={e => setQuantities(q => ({ ...q, [member.user_id]: { ...q[member.user_id], [item.item_id]: e.target.value } }))} />
            </Box>)}</Box>}
          </Row>)}
        </Box>
      </Box>
      {draft.error && <Flash variant="danger" sx={{ mb: 3 }}>{draft.error}</Flash>}
      {canSend && <Box sx={{ ...card, mb: 3 }}>
        <Summary tone="accent"><SumLine left={`Получателей: ${draft.gifts.length}`} right={<CrystalValue value={draft.cost.toLocaleString('ru')} />} /><SumLine left="Останется в казне" right={<CrystalValue value={(data.balance - draft.cost).toLocaleString('ru')} />} /></Summary>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}><Button variant="primary" disabled={busy || snapshot.refreshing || !draft.gifts.length || !!draft.error} loading={busy} onClick={send}>Проверить и отправить</Button></Box>
      </Box>}
      <Box sx={{ ...card, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1 }}><HistoryIcon /><Text sx={{ fontWeight: 'semibold' }}>История подарков</Text></Box>
        {!history.length && <Empty>Подарков пока нет</Empty>}
        {history.map(g => <Row key={g.id} title={g.giver_name ?? 'Бывший участник'} sub={g.created_at ? new Date(g.created_at).toLocaleString('ru') : 'Время неизвестно'} trail={<CrystalValue value={g.crystals == null ? '—' : g.crystals.toLocaleString('ru')} />}>
          <Box sx={{ p: 2, pt: 0 }}>{g.recipients.map(r => <Text key={r.user_id} sx={{ display: 'block', fontSize: 0 }}>{r.name ?? `#${r.user_id}`}: {r.items.map(i => `${itemName(i.item_id, catalog)} ×${i.quantity}`).join(', ')}</Text>)}</Box>
        </Row>)}
        {(more ?? data.history.has_more) && <Button loading={loadingMore} disabled={loadingMore || busy} onClick={loadMore}>Ещё подарки</Button>}
      </Box>
    </> : <Empty>Нет сохранённых данных подарков</Empty>}
  </>;
}
