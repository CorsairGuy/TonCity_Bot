import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel } from '@primer/react';
import { SyncIcon, ZapIcon, EyeIcon, ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { api, type ShopAccountData, type ShopOffer, type ShopOfferType, type ShopBalance } from '../api';
import { useFlash } from '../hooks/useFlash';
import { QtyPicker, affordableCount } from '../components/QtyPicker';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { IC_COIN, IC_CRYSTAL } from '../components/Icons';

const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681',
  uncommon: '#27AE60',
  rare: '#2E86C1',
  epic: '#8E44AD',
  legendary: '#D4AC0D',
};
const RARITY_NAME: Record<string, string> = {
  common: 'Обычный',
  uncommon: 'Необычный',
  rare: 'Редкий',
  epic: 'Эпический',
  legendary: 'Легендарный',
};
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const LEAGUE_NAME: Record<string, string> = { bronze: 'Бронза', silver: 'Серебро', golden: 'Золото' };

function fmtDuration(ns: number): string {
  const s = ns / 1e9;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  if (s < 86400) return `${Math.round(s / 3600)} ч`;
  return `${Math.round(s / 86400)} д`;
}

function OfferIcon({ type }: { type: ShopOfferType }) {
  if (type === 'coins') return <span style={{ display: 'inline-flex', alignItems: 'center' }}>{IC_COIN}</span>;
  if (type === 'crystals') return <span style={{ display: 'inline-flex', alignItems: 'center' }}>{IC_CRYSTAL}</span>;
  return <EyeIcon size={14} />;
}

interface PivotedAccount {
  account_id: number;
  account_name: string;
  offers: ShopOffer[];
  error?: string;
}

interface PivotedItem {
  item_id: number;
  rarity: string;
  multiplier: number;
  duration_ns: number;
  active_limit: number;
  offerTypes: ShopOfferType[];
  accounts: PivotedAccount[];
}

function pivot(accounts: ShopAccountData[]): PivotedItem[] {
  const map = new Map<number, PivotedItem>();
  for (const acc of accounts) {
    for (const item of acc.items ?? []) {
      if (!map.has(item.item_id)) {
        const types: ShopOfferType[] = [];
        for (const o of item.offers) {
          if (!types.includes(o.offer_type)) types.push(o.offer_type);
        }
        map.set(item.item_id, {
          item_id: item.item_id,
          rarity: item.rarity ?? 'common',
          multiplier: item.multiplier ?? 1,
          duration_ns: item.duration_ns ?? 0,
          active_limit: item.active_limit ?? 0,
          offerTypes: types,
          accounts: [],
        });
      }
      map.get(item.item_id)!.accounts.push({
        account_id: acc.id,
        account_name: acc.name,
        offers: item.offers,
        error: acc.error,
      });
    }
  }
  // Аккаунты, по которым игра не ответила, раньше просто ИСЧЕЗАЛИ из списка: список товаров
  // строится из acc.items, а у сбойного аккаунта items пустой. Со стороны это выглядело как
  // «показаны не все аккаунты» (жалоба 21.08.2026). Добавляем их строкой с ошибкой в каждый
  // товар — видно, что аккаунт есть и почему по нему нет данных.
  const failed = accounts.filter(a => a.error);
  for (const item of map.values()) {
    for (const acc of failed) {
      item.accounts.push({ account_id: acc.id, account_name: acc.name, offers: [], error: acc.error });
    }
    item.accounts.sort((a, b) => a.account_name.localeCompare(b.account_name));
  }
  return [...map.values()].sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
}

function ProgressBar({ current, limit }: { current: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
  const full = current >= limit && limit > 0;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box sx={{ width: 72, height: 6, borderRadius: 99, bg: 'canvas.inset', overflow: 'hidden', flexShrink: 0 }}>
        <Box sx={{ width: `${pct}%`, height: '100%', borderRadius: 99, bg: full ? 'danger.emphasis' : 'success.emphasis', transition: 'width .2s' }} />
      </Box>
      <Text sx={{ fontSize: 0, color: full ? 'danger.fg' : 'fg.muted', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {current}/{limit}
      </Text>
    </Box>
  );
}

// хватает ли у аккаунта монет/алмазов на конкретный оффер — баланс из БД (api.accounts(), тот же
// снимок, что показывает страница "Аккаунты"), не живой запрос. "ads" ничего не стоит — всегда true.
// баланс той валюты, которой оплачивается конкретный оффер (реклама ничего не стоит)
function balanceFor(balances: Map<number, { balance: number; crystals: number }>, accountId: number, offer: ShopOffer): number {
  const b = balances.get(accountId);
  if (!b) return 0;
  return offer.offer_type === 'crystals' ? b.crystals : b.balance;
}

function canAfford(bal: { balance: number; crystals: number } | undefined, offer: ShopOffer): boolean {
  if (offer.offer_type === 'ads') return true;
  if (!bal) return false;
  const have = offer.offer_type === 'crystals' ? bal.crystals : bal.balance;
  return have >= offer.price;
}

interface BoosterCardProps {
  item: PivotedItem;
  onBought: (accountId: number, offerId: number, balance?: ShopBalance | null, amount?: number) => void;
  balances: Map<number, { balance: number; crystals: number }>;
}

function BoosterCard({ item, onBought, balances }: BoosterCardProps) {
  // по умолчанию — кристаллы (если есть), иначе первая доступная валюта
  const [selType, setSelType] = useState<ShopOfferType>(item.offerTypes.includes('crystals') ? 'crystals' : item.offerTypes[0]);
  const [collapsed, setCollapsed] = useState(true);
  const [buying, setBuying] = useState<Set<string>>(new Set());
  const [buyingAll, setBuyingAll] = useState(false);
  // сколько штук покупаем за одно нажатие. Дневной лимит у части товаров — 10 штук, и жать
  // «Купить» десять раз бессмысленно: игра принимает количество одним запросом (amount).
  const [qty, setQty] = useState(1);
  const { flash, showFlash } = useFlash();

  const color = RARITY_COLOR[item.rarity] ?? '#6e7681';
  const meta = ITEMS_BY_ID[item.item_id] ?? null;
  const name = meta?.name ?? RARITY_NAME[item.rarity] ?? item.rarity;

  const eligibleAccounts = item.accounts.filter(acc => {
    if (acc.error) return false;
    const offer = acc.offers.find(o => o.offer_type === selType);
    if (!offer) return false;
    return offer.current < offer.limit && offer.league_met && canAfford(balances.get(acc.account_id), offer);
  });
  // сводка для выбранной валюты: куплено (лимит исчерпан) / всего
  // потолок для пикера — самый большой доступный объём среди подходящих аккаунтов
  const maxQty = Math.max(1, ...eligibleAccounts.map(acc => {
    const offer = acc.offers.find(o => o.offer_type === selType);
    return offer ? affordableCount(offer, balanceFor(balances, acc.account_id, offer)) : 1;
  }), 1);
  const boughtCount = item.accounts.filter(acc => {
    const offer = acc.offers.find(o => o.offer_type === selType);
    return offer && offer.current >= offer.limit;
  }).length;

  const buy = useCallback(async (accountId: number, offer: ShopOffer, amount: number) => {
    const key = `${accountId}-${offer.offer_id}`;
    setBuying(prev => new Set(prev).add(key));
    try {
      const r = await api.shopBuy(accountId, offer.offer_id, amount, offer.offer_type);
      if (r.ok) onBought(accountId, offer.offer_id, r.balance, amount);
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuying(prev => { const s = new Set(prev); s.delete(key); return s; }); }
  }, [onBought, showFlash]);

  // «Купить всем»: количество у каждого аккаунта своё — у одного остался лимит 3, у другого
  // 10, у третьего не хватает монет на выбранное число. Поэтому идём по аккаунтам по очереди
  // и каждому покупаем min(выбранное, доступное ему), а не один общий запрос с одним amount.
  const buyAll = useCallback(async () => {
    if (eligibleAccounts.length === 0) return;
    setBuyingAll(true);
    try {
      const results: { name: string; ok: boolean; error?: string }[] = [];
      let bought = 0;
      for (const acc of eligibleAccounts) {
        const offer = acc.offers.find(o => o.offer_type === selType);
        if (!offer) continue;
        const amount = Math.max(1, Math.min(qty, affordableCount(offer, balanceFor(balances, acc.account_id, offer))));
        try {
          const r = await api.shopBuy(acc.account_id, offer.offer_id, amount, selType);
          if (r.ok) { bought += amount; onBought(acc.account_id, offer.offer_id, r.balance, amount); results.push({ name: acc.account_name, ok: true }); }
          else results.push({ name: acc.account_name, ok: false, error: r.error });
        } catch (e) { results.push({ name: acc.account_name, ok: false, error: String(e) }); }
      }
      const failed = results.filter(r => !r.ok);
      const ok = results.filter(r => r.ok).length;
      if (failed.length === 0) showFlash(`Куплено ${bought} шт. для ${ok} аккаунтов`, true);
      else showFlash(`${ok} куплено, ошибки: ${failed.map(f => f.name).join(', ')}`, false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuyingAll(false); }
  }, [eligibleAccounts, selType, qty, balances, onBought, showFlash]);

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderLeft: '3px solid', borderLeftColor: color, borderRadius: 2, overflow: 'hidden', mb: 3 }}>
      {/* Header (клик — свернуть/развернуть список аккаунтов) */}
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: collapsed ? 'none' : '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setCollapsed(c => !c)}>
          <Box sx={{ color: 'fg.muted', flexShrink: 0 }}>{collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}</Box>
          <Box sx={{ width: 30, height: 30, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {meta
              ? <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }}
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
              : <span style={{ fontSize: 9 }}>#{item.item_id}</span>}
          </Box>
          <Text sx={{ fontWeight: 'bold', fontSize: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Text>
          <Text sx={{ fontWeight: 'bold', fontSize: 1, flexShrink: 0 }}>{item.multiplier}×</Text>
          <Text sx={{ fontSize: 1, color: 'fg.muted', flexShrink: 0, display: ['none', 'inline'] }}>· {fmtDuration(item.duration_ns)}</Text>
          <Text sx={{ fontSize: 1, color: 'fg.muted', flexShrink: 0, display: ['none', 'inline'] }}>· {item.active_limit} слотов</Text>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Text sx={{ fontSize: 0, whiteSpace: 'nowrap' }}>
            <Text as="span" sx={{ color: eligibleAccounts.length > 0 ? 'success.fg' : 'fg.subtle', fontWeight: 'bold' }}>{eligibleAccounts.length} можно</Text>
            <Text as="span" sx={{ color: 'fg.muted' }}>{` · ✓${boughtCount} · ${item.accounts.length}`}</Text>
          </Text>
          <QtyPicker value={qty} max={maxQty} onChange={setQty} disabled={buyingAll} />
          <Button
            variant={eligibleAccounts.length > 0 ? 'primary' : 'default'}
            leadingVisual={ZapIcon}
            loading={buyingAll}
            disabled={buyingAll || eligibleAccounts.length === 0}
            onClick={buyAll}
          >
            Купить{qty > 1 ? ` ×${qty}` : ''} всем {eligibleAccounts.length > 0 && <CounterLabel sx={{ ml: 1 }}>{eligibleAccounts.length}</CounterLabel>}
          </Button>
        </Box>
      </Box>

      {/* Flash (виден и в свёрнутом состоянии — фидбек «Купить всем») */}
      {flash && (
        <Box sx={{ px: 3, pt: 2 }}>
          <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1 }}>{flash.msg}</Flash>
        </Box>
      )}

      {!collapsed && (<>
      {/* Offer type tabs */}
      {item.offerTypes.length > 1 && (
        <Box sx={{ px: 3, pt: 2, pb: 1, display: 'flex', gap: 1 }}>
          {item.offerTypes.map(type => {
            const sample = item.accounts[0]?.offers.find(o => o.offer_type === type);
            return (
              <Button
                key={type}
                variant={selType === type ? 'primary' : 'default'}
                onClick={() => setSelType(type)}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <OfferIcon type={type} />
                  <span>{type === 'ads' ? 'Реклама' : sample ? fmt(sample.price) : type}</span>
                </Box>
              </Button>
            );
          })}
        </Box>
      )}

      {/* Accounts list */}
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {item.accounts.map(acc => {
          const offer = acc.offers.find(o => o.offer_type === selType);
          const isBuying = buying.has(`${acc.account_id}-${offer?.offer_id}`);
          const exhausted = offer ? offer.current >= offer.limit : true;
          const leagueMet = offer?.league_met ?? true;
          const afford = offer ? canAfford(balances.get(acc.account_id), offer) : false;
          const canBuy = !!offer && !exhausted && leagueMet && afford && !acc.error && !isBuying;

          return (
            <Box key={acc.account_id} sx={{
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
              py: '6px', px: 2, borderRadius: 1,
              bg: 'canvas.subtle', border: '1px solid', borderColor: 'border.muted',
            }}>
              <Text sx={{ fontSize: 1, fontWeight: 'semibold', flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {acc.account_name}
              </Text>

              {acc.error ? (
                <Text sx={{ fontSize: 0, color: 'danger.fg' }}>Ошибка</Text>
              ) : !offer ? (
                <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>Недоступно</Text>
              ) : (
                <>
                  <ProgressBar current={offer.current} limit={offer.limit} />
                  <Text sx={{ fontSize: 0, color: 'fg.subtle', whiteSpace: 'nowrap' }}>
                    в {offer.limit_type === 'weekly' ? 'нед.' : 'день'}
                  </Text>
                  {offer.league_required && (
                    <Label variant={leagueMet ? 'success' : 'danger'} sx={{ fontSize: 0, py: 0 }}>
                      {LEAGUE_NAME[offer.league_required] ?? offer.league_required}
                    </Label>
                  )}
                  {offer.offer_type !== 'ads' && (
                    <Text sx={{ fontSize: 0, color: 'fg.muted', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                      {fmt(offer.price)} <OfferIcon type={offer.offer_type} />
                    </Text>
                  )}
                  {exhausted ? (
                    <Text sx={{ fontSize: 0, color: 'fg.subtle', whiteSpace: 'nowrap' }}>Исчерпано</Text>
                  ) : leagueMet && !afford ? (
                    <Text sx={{ fontSize: 0, color: 'danger.fg', whiteSpace: 'nowrap' }}>Не хватает средств</Text>
                  ) : (
                    <Button
                      variant="primary"
                      leadingVisual={offer.offer_type === 'ads' ? EyeIcon : ZapIcon}
                      loading={isBuying}
                      disabled={!canBuy}
                      onClick={() => offer && buy(acc.account_id, offer, Math.max(1, Math.min(qty, affordableCount(offer, balanceFor(balances, acc.account_id, offer)))))}
                    >
                      {(() => { const n = offer ? Math.max(1, Math.min(qty, affordableCount(offer, balanceFor(balances, acc.account_id, offer)))) : 1; return n > 1 ? `Купить ×${n}` : 'Купить'; })()}
                    </Button>
                  )}
                </>
              )}
            </Box>
          );
        })}
      </Box>
      </>)}
    </Box>
  );
}

export function ShopBoosters() {
  const [accounts, setAccounts] = useState<ShopAccountData[]>([]);
  const [balances, setBalances] = useState<Map<number, { balance: number; crystals: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('shopBoosters', () => load());
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // баланс — из БД (та же страница "Аккаунты"), не живой запрос; нужен, чтобы кнопка "Купить"
      // не предлагала покупку, на которую реально не хватает монет/алмазов на счету
      const [d, accs] = await Promise.all([api.shopBoosters(), api.accounts().catch(() => null)]);
      if (d.ok) {
        setAccounts(d.accounts);
        // добираем тех, по кому игра не ответила: сервер повторит проход только по ним
        const retryIds = d.accounts.filter(a => a.error && !a.permanent).map(a => a.id);
        if (retryIds.length) {
          api.shopBoosters(retryIds).then(r => {
            if (!r.ok) return;
            const fixed = new Map(r.accounts.map(a => [a.id, a]));
            setAccounts(prev => prev.map(a => fixed.get(a.id) ?? a));
          }).catch(() => { /* строка останется с ошибкой */ });
        }
      }
      else showFlash(d.error ?? 'Ошибка загрузки', false);
      if (accs?.ok) setBalances(new Map(accs.accounts.map(a => [a.id, { balance: a.balance, crystals: a.crystals }])));
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
  }, [showFlash]);

  const refresh = async () => {
    setRefreshing(true);
    try { await load(); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, [load]);

  const handleBought = useCallback((accountId: number, offerId: number, balance?: ShopBalance | null, amount = 1) => {
    // баланс приходит с сервера уже пересчитанным из игры — без этого кнопка «Купить»
    // осталась бы активной по старому числу, и следующая покупка упиралась бы в
    // 400 «Недостаточно монет»
    if (balance) {
      setBalances(prev => {
        const cur = prev.get(accountId);
        const next = new Map(prev);
        next.set(accountId, {
          balance: balance.balance ?? cur?.balance ?? 0,
          crystals: balance.crystals ?? cur?.crystals ?? 0,
        });
        return next;
      });
    }
    setAccounts(prev => prev.map(acc => {
      if (acc.id !== accountId) return acc;
      return {
        ...acc,
        items: acc.items.map(item => ({
          ...item,
          offers: item.offers.map(o => o.offer_id === offerId ? { ...o, current: o.current + amount } : o),
        })),
      };
    }));
  }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const items = pivot(accounts);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Магазин — Ускорители</Heading>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing || loading} onClick={refresh}>
          Обновить
        </Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {items.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : items.map(item => <BoosterCard key={item.item_id} item={item} onBought={handleBought} balances={balances} />)
      }
    </Box>
  );
}
