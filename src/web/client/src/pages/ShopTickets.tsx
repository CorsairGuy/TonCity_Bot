import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel } from '@primer/react';
import { SyncIcon, ZapIcon } from '@primer/octicons-react';
import { api, type ShopAccountData, type ShopOffer, type ShopNormalizedItem } from '../api';
import { useFlash } from '../hooks/useFlash';
import { QtyPicker, affordableCount } from '../components/QtyPicker';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { ITEMS_BY_ID, itemImgSrc } from '../utils';
import { TicketIcon, TicketValue } from '../components/Ticket';
import { useItemCatalog, catalogItemName, type CatalogItem } from '../hooks/useItemCatalog';
import { ItemThumb } from '../components/ItemThumb';

// Магазин за билеты «Летнего карнавала». Своей витрины у билетов нет: игра подмешивает билетные
// офферы (offer_type='tickets') в обычные категории магазина, сервер их выбирает — см.
// /api/shop-live/tickets в web/routes/economy.js. Пока игра такие офферы не включила, список пуст.
//
// Баланс билетов берём из доски события (/api/anniversary/event, то же, что показывает страница
// «Летний карнавал») — иначе кнопка «Купить» предлагала бы покупку, на которую билетов не хватает,
// и игра отвечала бы 400, как это было с монетами в обычном магазине.

const CURRENCY_NAME: Record<string, string> = {
  coins: 'монеты',
  crystals: 'алмазы',
  ads: 'реклама',
  tickets: 'билеты',
};

const CATEGORY_NAME: Record<string, string> = {
  anniversary_event: 'Годовщина',
  booster: 'Ускорители',
  booster_pack: 'Наборы',
  policy_bureau: 'Политики',
};

interface PivotedItem {
  item_id: number;
  category?: string;
  game?: CatalogItem;   // то, что игра сказала о предмете прямо в ответе витрины
  accounts: { account_id: number; account_name: string; offer: ShopOffer; error?: string }[];
}

// Собираем описание предмета из того, что пришло в самой витрине: этого хватает, чтобы показать
// «Летний набор»/«Мифический ускоритель» ещё до того, как подтянется общий каталог предметов.
function itemFromShop(item: ShopNormalizedItem): CatalogItem | undefined {
  const name = item.game_name ?? item.pack_type ?? item.rarity ?? null;
  const type = item.game_type ?? (item.pack_type ? 'booster_pack' : item.rarity ? 'booster' : null);
  if (!name && !type) return undefined;
  return { item_id: item.item_id, type, name, rarity: item.game_rarity ?? item.rarity ?? null };
}

function pivot(accounts: ShopAccountData[]): PivotedItem[] {
  const map = new Map<number, PivotedItem>();
  for (const acc of accounts) {
    for (const item of acc.items ?? []) {
      const offer = item.offers.find(o => o.offer_type === 'tickets');
      if (!offer) continue;
      if (!map.has(item.item_id)) map.set(item.item_id, {
        item_id: item.item_id,
        category: item.category,
        // вид предмета игра отдаёт по-разному: у наборов это booster_pack.type (pack_type),
        // у ускорителей — booster.rarity, иногда есть общие поля name/type
        game: itemFromShop(item),
        accounts: [],
      });
      map.get(item.item_id)!.accounts.push({ account_id: acc.id, account_name: acc.name, offer, error: acc.error });
    }
  }
  return [...map.values()].sort((a, b) => a.item_id - b.item_id);
}

function ItemCard({ item, balances, onBought, catalog }: {
  item: PivotedItem;
  balances: Map<number, number>;
  onBought: (accountId: number, offerId: number, amount: number) => void;
  catalog: Map<number, CatalogItem>;
}) {
  const [buying, setBuying] = useState<string | null>(null);
  const [buyingAll, setBuyingAll] = useState(false);
  // количество за одно нажатие (у товаров дневной лимит, игра принимает amount одним запросом)
  const [qty, setQty] = useState(1);
  const { flash, showFlash } = useFlash();
  const meta = ITEMS_BY_ID[item.item_id];

  const canBuy = (a: PivotedItem['accounts'][number]) =>
    !a.error && a.offer.current < a.offer.limit && a.offer.league_met && (balances.get(a.account_id) ?? 0) >= a.offer.price;
  const eligible = item.accounts.filter(canBuy);
  // потолок пикера — самый большой доступный объём среди подходящих аккаунтов
  const maxQty = Math.max(1, ...eligible.map(a => affordableCount(a.offer, balances.get(a.account_id))), 1);

  const buy = async (accountId: number, offer: ShopOffer, amount: number) => {
    const key = `${accountId}-${offer.offer_id}`;
    setBuying(key);
    try {
      const r = await api.shopBuy(accountId, offer.offer_id, amount, 'tickets');
      if (r.ok) onBought(accountId, offer.offer_id, amount);
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuying(null); }
  };

  // у каждого аккаунта свой остаток лимита и свой запас билетов — покупаем каждому min(выбранное,
  // доступное ему) по очереди, а не один общий запрос с единым количеством
  const buyAll = async () => {
    if (!eligible.length) return;
    setBuyingAll(true);
    try {
      const failed: string[] = [];
      let ok = 0, total = 0;
      for (const a of eligible) {
        const amount = Math.max(1, Math.min(qty, affordableCount(a.offer, balances.get(a.account_id))));
        try {
          const r = await api.shopBuy(a.account_id, a.offer.offer_id, amount, 'tickets');
          if (r.ok) { ok++; total += amount; onBought(a.account_id, a.offer.offer_id, amount); }
          else failed.push(a.account_name);
        } catch { failed.push(a.account_name); }
      }
      showFlash(failed.length ? `${ok} куплено, ошибки: ${failed.join(', ')}` : `Куплено ${total} шт. для ${ok} аккаунтов`, failed.length === 0);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuyingAll(false); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {meta
            ? <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <ItemThumb itemId={item.item_id} item={catalog.get(item.item_id) ?? item.game} size={24} />}
        </Box>
        <Text sx={{ fontWeight: 'bold' }}>
          {meta?.name ?? catalogItemName(catalog.get(item.item_id) ?? item.game) ?? `Предмет #${item.item_id}`}
        </Text>
        {item.category && <Label variant="secondary" sx={{ fontSize: 0 }}>{CATEGORY_NAME[item.category] ?? item.category}</Label>}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          <Text sx={{ fontSize: 0, color: eligible.length ? 'success.fg' : 'fg.subtle' }}>{eligible.length} можно</Text>
          <QtyPicker value={qty} max={maxQty} onChange={setQty} disabled={buyingAll} />
          <Button variant={eligible.length ? 'primary' : 'default'} leadingVisual={ZapIcon}
            loading={buyingAll} disabled={buyingAll || !eligible.length} onClick={buyAll}>
            Купить{qty > 1 ? ` ×${qty}` : ''} всем {eligible.length > 0 && <CounterLabel sx={{ ml: 1 }}>{eligible.length}</CounterLabel>}
          </Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1, mx: 3, mt: 2 }}>{flash.msg}</Flash>}
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {item.accounts.map(a => {
          const exhausted = a.offer.current >= a.offer.limit;
          const enough = (balances.get(a.account_id) ?? 0) >= a.offer.price;
          return (
            <Box key={a.account_id} sx={{
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
              py: '6px', px: 2, borderRadius: 1, bg: 'canvas.subtle', border: '1px solid', borderColor: 'border.muted',
            }}>
              <Text sx={{ fontSize: 1, fontWeight: 'semibold', flex: 1, minWidth: 120 }}>{a.account_name}</Text>
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{a.offer.current}/{a.offer.limit} в {a.offer.limit_type === 'weekly' ? 'нед.' : 'день'}</Text>
              <Text sx={{ fontSize: 0, display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                {a.offer.price} <TicketIcon size={14} />
              </Text>
              <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>есть <TicketValue value={balances.get(a.account_id) ?? 0} size={13} /></Text>
              {a.error ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>Ошибка</Text>
                : exhausted ? <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>Исчерпано</Text>
                : !enough ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>Не хватает билетов</Text>
                : <Button variant="primary" leadingVisual={ZapIcon}
                    loading={buying === `${a.account_id}-${a.offer.offer_id}`}
                    disabled={buying !== null}
                    onClick={() => buy(a.account_id, a.offer, Math.max(1, Math.min(qty, affordableCount(a.offer, balances.get(a.account_id)))))}>
                    {(() => { const n = Math.max(1, Math.min(qty, affordableCount(a.offer, balances.get(a.account_id)))); return n > 1 ? `Купить ×${n}` : 'Купить'; })()}
                  </Button>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function ShopTickets() {
  const [accounts, setAccounts] = useState<ShopAccountData[]>([]);
  const [balances, setBalances] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('shopTickets', () => load());
  const [retrying, setRetrying] = useState(false);
  const shownIds = accounts.flatMap(a => (a.items ?? []).map(i => i.item_id));
  const catalog = useItemCatalog(shownIds);
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    try {
      const [d, ev] = await Promise.all([api.shopTickets(), api.anniversaryEvent().catch(() => null)]);
      if (d.ok) setAccounts(d.accounts);
      else showFlash(d.error ?? 'Ошибка загрузки', false);
      if (ev?.ok) setBalances(new Map(ev.accounts.map(a => [a.id, a.tickets_balance ?? 0])));
      return d.ok ? d.accounts : null;
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // добираем аккаунты, по которым игра не ответила (таймауты); «вечные» отказы игры — вроде
  // «Экономика политик откроется при населении 1 000 000» — не повторяем, они не изменятся
  const retryFailed = useCallback(async (rows: ShopAccountData[]) => {
    const ids = rows.filter(a => a.error && !a.permanent).map(a => a.id);
    if (!ids.length) return;
    setRetrying(true);
    try {
      const d = await api.shopTickets(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setAccounts(prev => prev.map(a => fixed.get(a.id) ?? a));
      }
    } catch { /* останется строка с ошибкой */ }
    finally { setRetrying(false); }
  }, []);

  useEffect(() => { load().then(rows => { if (rows) retryFailed(rows); }); }, [load, retryFailed]);

  const refresh = async () => {
    setRefreshing(true);
    try { const rows = await load(); if (rows) await retryFailed(rows); }
    finally { setRefreshing(false); }
  };

  // после покупки уменьшаем локальный баланс билетов и счётчик лимита — до следующего «Обновить».
  // ВАЖНО: цену считаем ДО setAccounts и баланс правим отдельным вызовом. Раньше setBalances стоял
  // внутри апдейтера setAccounts — это побочный эффект в фазе рендера: React (StrictMode) прогоняет
  // апдейтер дважды, и билеты списывались в двойном размере, а сам вложенный setState роняет
  // страницу предупреждением «Cannot update a component while rendering a different component».
  const handleBought = useCallback((accountId: number, offerId: number, amount = 1) => {
    const acc = accounts.find(a => a.id === accountId);
    const price = (acc?.items.flatMap(i => i.offers).find(o => o.offer_id === offerId)?.price ?? 0) * amount;
    setAccounts(prev => prev.map(a => a.id !== accountId ? a : {
      ...a,
      items: a.items.map(item => ({
        ...item,
        offers: item.offers.map(o => o.offer_id === offerId ? { ...o, current: o.current + amount } : o),
      })),
    }));
    setBalances(prev => {
      const next = new Map(prev);
      next.set(accountId, Math.max(0, (next.get(accountId) ?? 0) - price));
      return next;
    });
  }, [accounts]);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const items = pivot(accounts);
  const failed = accounts.filter(a => a.error);
  // какие валюты магазин реально предлагает (по всем аккаунтам) — см. offer_types в ответе сервера
  const seenTypes = [...new Set(accounts.flatMap(a => a.offer_types ?? []))];

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Магазин билетов</Heading>
        <Button leadingVisual={SyncIcon} loading={refreshing || retrying} disabled={refreshing || retrying} onClick={refresh}>Обновить</Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {failed.length > 0 && (
        <Flash variant="danger" sx={{ mb: 3 }}>
          Игра не ответила по {failed.length} аккаунтам: {failed.slice(0, 5).map(f => f.name).join(', ')}
          {failed.length > 5 ? ` и ещё ${failed.length - 5}` : ''}.
          {failed[0]?.error ? ` Первая ошибка: ${failed[0].error}` : ''}
        </Flash>
      )}
      {items.length === 0
        ? <Box>
            <Text sx={{ color: 'fg.muted' }}>
              {failed.length === accounts.length && accounts.length > 0
                ? 'Ни один аккаунт не ответил — витрину показать не из чего.'
                : 'Игра пока не выставила ни одного товара за билеты.'}
            </Text>
            {seenTypes.length > 0 && (
              <Text as="p" sx={{ color: 'fg.subtle', fontSize: 0, mt: 2 }}>
                Магазин ответил, но билетных предложений в нём нет — сейчас игра принимает только:{' '}
                {seenTypes.map(t => CURRENCY_NAME[t] ?? t).join(', ')}. В клиенте игры вкладки «за билеты»
                тоже нет: путь покупки за билеты в коде игры есть, но им пока ничего не пользуется —
                похоже, тратить билеты можно будет в «Хранилище призов», которое открывается 15.08.
              </Text>
            )}
          </Box>
        : items.map(item => <ItemCard key={item.item_id} item={item} balances={balances} onBought={handleBought} catalog={catalog} />)}
    </Box>
  );
}
