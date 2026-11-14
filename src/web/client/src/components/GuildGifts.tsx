import { useState } from 'react';
import { Box, Button, Checkbox, Flash, Label, Spinner, Text, TextInput } from '@primer/react';
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
  return <Box sx={{ px: 3, pb: 3 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
      <Text sx={{ flex: 1, color: 'fg.muted', fontSize: 0 }}>{capturedAt ? `Снимок от ${new Date(capturedAt).toLocaleString('ru')}` : 'Нажмите «Обновить», чтобы получить подарки из игры'}</Text>
      <Button disabled={busy || snapshot.refreshing} loading={snapshot.refreshing} onClick={refresh}>Обновить</Button>
    </Box>
    {(snapshot.error || note) && <Flash variant={note?.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{note?.text ?? snapshot.error}</Flash>}
    {snapshot.loading ? <Spinner /> : data && <>
      <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', mb: 3 }}><Text>Казна: <CrystalValue value={data.balance.toLocaleString('ru')} /></Text><Text>Сброс лимитов: {capturedAt ? new Date(Date.parse(capturedAt) + data.resets_in_seconds * 1000).toLocaleString('ru') : `через ${duration(data.resets_in_seconds)}`}</Text></Box>
      {!canSend && <Flash sx={{ mb: 3 }}>Отправка недоступна для этого аккаунта. Можно просмотреть каталог и историю.</Flash>}
      <Text sx={{ fontWeight: 'bold', display: 'block', mb: 2 }}>Наборы каждому получателю</Text>
      <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 3 }}>{data.items.map(item => <Box key={item.item_id} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, width: 200 }}>
        <ItemThumb itemId={item.item_id} item={catalog.get(item.item_id)} size={40} /><Text sx={{ display: 'block', fontWeight: 'semibold' }}>{itemName(item.item_id, catalog)}</Text>
        <Text sx={{ display: 'block', fontSize: 0 }}>{item.price.toLocaleString('ru')} алмазов · лимит {item.weekly_limit}/нед.</Text>
        <TextInput type="number" min={0} step={1} aria-label={`Каждому: ${itemName(item.item_id, catalog)}`} value={defaults[item.item_id] ?? ''} disabled={!canSend || busy} onChange={e => setDefaults(d => ({ ...d, [item.item_id]: e.target.value }))} sx={{ width: 100, mt: 2 }} />
      </Box>)}</Box>
      <Text sx={{ display: 'block', color: 'fg.muted', fontSize: 0, mb: 2 }}>Общее количество применяется при выборе участника. Ниже можно изменить набор каждого.</Text>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{data.members.map(member => <Box key={member.user_id} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}><Checkbox aria-label={`Подарки: ${member.name}`} checked={selected.has(member.user_id)} disabled={!canSend || busy || member.eligible_in_seconds > 0 || data.items.every(i => !(member.remaining[String(i.item_id)] > 0))} onChange={() => toggle(member)} /><Text sx={{ fontWeight: 'semibold' }}>{member.name}</Text><Label>{member.role}</Label>{member.eligible_in_seconds > 0 && <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Допуск через {duration(member.eligible_in_seconds)} от времени снимка</Text>}</Box>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mt: 2 }}>{data.items.map(item => <Box key={item.item_id}><Text sx={{ display: 'block', fontSize: 0 }}>{itemName(item.item_id, catalog)} · осталось {member.remaining[String(item.item_id)] ?? 0}</Text>{selected.has(member.user_id) && <TextInput type="number" min={0} max={member.remaining[String(item.item_id)] ?? 0} step={1} aria-label={`${member.name}: ${itemName(item.item_id, catalog)}`} value={quantities[member.user_id]?.[item.item_id] ?? ''} disabled={busy} onChange={e => setQuantities(q => ({ ...q, [member.user_id]: { ...q[member.user_id], [item.item_id]: e.target.value } }))} sx={{ width: 100 }} />}</Box>)}</Box>
      </Box>)}</Box>
      {draft.error && <Text sx={{ display: 'block', mt: 2, color: 'danger.fg' }}>{draft.error}</Text>}
      {canSend && <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, my: 3 }}><Text>Получателей: {draft.gifts.length} · итого {draft.cost.toLocaleString('ru')} алмазов</Text><Button variant="primary" disabled={busy || snapshot.refreshing || !draft.gifts.length || !!draft.error} loading={busy} onClick={send}>Проверить и отправить</Button></Box>}
      <Text sx={{ display: 'block', fontWeight: 'bold', my: 3 }}>История подарков</Text>
      {!history.length && <Text sx={{ color: 'fg.muted' }}>Подарков пока нет</Text>}
      {history.map(g => <Box key={g.id} sx={{ borderBottom: '1px solid', borderColor: 'border.muted', py: 2 }}><Text sx={{ display: 'block', fontWeight: 'semibold' }}>{g.giver_name ?? 'Бывший участник'} · {g.crystals?.toLocaleString('ru')} алмазов</Text><Text sx={{ display: 'block', color: 'fg.muted', fontSize: 0 }}>{g.created_at ? new Date(g.created_at).toLocaleString('ru') : ''}</Text>{g.recipients.map(r => <Text key={r.user_id} sx={{ display: 'block' }}>{r.name ?? `#${r.user_id}`}: {r.items.map(i => `${itemName(i.item_id, catalog)} ×${i.quantity}`).join(', ')}</Text>)}</Box>)}
      {(more ?? data.history.has_more) && <Button sx={{ mt: 2 }} loading={loadingMore} disabled={loadingMore || busy} onClick={loadMore}>Ещё подарки</Button>}
    </>}
  </Box>;
}
