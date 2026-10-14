import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel } from '@primer/react';
import { SyncIcon, PackageIcon, EyeIcon, ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { api, type ShopAccountData, type ShopOffer, type ShopOfferType } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { IC_COIN, IC_CRYSTAL } from '../components/Icons';

const PACK_NAME: Record<string, string> = {
  basic:    'Базовый',
  advanced: 'Продвинутый',
  elite:    'Элитный',
  premium:  'Премиум',
  ultimate: 'Высший',
  eternal:  'Вечный',
};
const PACK_COLOR: Record<string, string> = {
  basic:    '#6e7681',
  advanced: '#27AE60',
  elite:    '#2E86C1',
  premium:  '#8E44AD',
  ultimate: '#D4AC0D',
  eternal:  '#C0392B',
};
const PACK_ORDER = ['basic', 'advanced', 'elite', 'premium', 'ultimate', 'eternal'];

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

interface PivotedPack {
  item_id: number;
  pack_type: string;
  offerTypes: ShopOfferType[];
  accounts: PivotedAccount[];
}

function pivot(accounts: ShopAccountData[]): PivotedPack[] {
  const map = new Map<number, PivotedPack>();
  for (const acc of accounts) {
    for (const item of acc.items ?? []) {
      if (!map.has(item.item_id)) {
        const types: ShopOfferType[] = [];
        for (const o of item.offers) {
          if (!types.includes(o.offer_type)) types.push(o.offer_type);
        }
        map.set(item.item_id, {
          item_id: item.item_id,
          pack_type: item.pack_type ?? 'basic',
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
  return [...map.values()].sort((a, b) => PACK_ORDER.indexOf(a.pack_type) - PACK_ORDER.indexOf(b.pack_type));
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

interface PackCardProps {
  item: PivotedPack;
  onBought: (accountId: number, offerId: number) => void;
}

function PackCard({ item, onBought }: PackCardProps) {
  // по умолчанию — кристаллы (если есть), иначе первая доступная валюта
  const [selType, setSelType] = useState<ShopOfferType>(item.offerTypes.includes('crystals') ? 'crystals' : item.offerTypes[0]);
  const [collapsed, setCollapsed] = useState(true);
  const [buying, setBuying] = useState<Set<string>>(new Set());
  const [buyingAll, setBuyingAll] = useState(false);
  const { flash, showFlash } = useFlash();

  const color = PACK_COLOR[item.pack_type] ?? '#6e7681';
  const meta = ITEMS_BY_ID[item.item_id] ?? null;
  const name = meta?.name ?? PACK_NAME[item.pack_type] ?? item.pack_type;

  const eligibleAccounts = item.accounts.filter(acc => {
    if (acc.error) return false;
    const offer = acc.offers.find(o => o.offer_type === selType);
    if (!offer) return false;
    return offer.current < offer.limit;
  });
  const boughtCount = item.accounts.filter(acc => {
    const offer = acc.offers.find(o => o.offer_type === selType);
    return offer && offer.current >= offer.limit;
  }).length;

  const buy = useCallback(async (accountId: number, offer: ShopOffer) => {
    const key = `${accountId}-${offer.offer_id}`;
    setBuying(prev => new Set(prev).add(key));
    try {
      const r = await api.shopBuy(accountId, offer.offer_id, 1, offer.offer_type);
      if (r.ok) onBought(accountId, offer.offer_id);
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuying(prev => { const s = new Set(prev); s.delete(key); return s; }); }
  }, [onBought, showFlash]);

  const buyAll = useCallback(async () => {
    if (eligibleAccounts.length === 0) return;
    setBuyingAll(true);
    try {
      const byOffer = new Map<number, number[]>();
      for (const acc of eligibleAccounts) {
        const offer = acc.offers.find(o => o.offer_type === selType);
        if (!offer) continue;
        if (!byOffer.has(offer.offer_id)) byOffer.set(offer.offer_id, []);
        byOffer.get(offer.offer_id)!.push(acc.account_id);
      }
      const results: { name: string; id: number; ok: boolean; error?: string }[] = [];
      for (const [offerId, accountIds] of byOffer) {
        const r = await api.shopBuyAll(accountIds, offerId, selType);
        if (r.ok) {
          for (const res of r.results) {
            results.push(res);
            if (res.ok) onBought(res.id, offerId);
          }
        } else {
          results.push({ name: 'все', id: 0, ok: false, error: r.error });
        }
      }
      const failed = results.filter(r => !r.ok);
      const ok = results.filter(r => r.ok).length;
      if (failed.length === 0) showFlash(`Куплено для ${ok} аккаунтов`, true);
      else showFlash(`${ok} куплено, ошибки: ${failed.map(f => f.name).join(', ')}`, false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuyingAll(false); }
  }, [eligibleAccounts, selType, onBought, showFlash]);

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
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Text sx={{ fontSize: 0, whiteSpace: 'nowrap' }}>
            <Text as="span" sx={{ color: eligibleAccounts.length > 0 ? 'success.fg' : 'fg.subtle', fontWeight: 'bold' }}>{eligibleAccounts.length} можно</Text>
            <Text as="span" sx={{ color: 'fg.muted' }}>{` · ✓${boughtCount} · ${item.accounts.length}`}</Text>
          </Text>
          <Button
            variant={eligibleAccounts.length > 0 ? 'primary' : 'default'}
            leadingVisual={PackageIcon}
            loading={buyingAll}
            disabled={buyingAll || eligibleAccounts.length === 0}
            onClick={buyAll}
          >
            Купить всем {eligibleAccounts.length > 0 && <CounterLabel sx={{ ml: 1 }}>{eligibleAccounts.length}</CounterLabel>}
          </Button>
        </Box>
      </Box>

      {/* Flash (виден и в свёрнутом состоянии) */}
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

      {/* Accounts */}
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {item.accounts.map(acc => {
          const offer = acc.offers.find(o => o.offer_type === selType);
          const isBuying = buying.has(`${acc.account_id}-${offer?.offer_id}`);
          const exhausted = offer ? offer.current >= offer.limit : true;
          const canBuy = !!offer && !exhausted && !acc.error && !isBuying;

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
                  {offer.offer_type !== 'ads' && (
                    <Text sx={{ fontSize: 0, color: 'fg.muted', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                      {fmt(offer.price)} <OfferIcon type={offer.offer_type} />
                    </Text>
                  )}
                  {exhausted ? (
                    <Text sx={{ fontSize: 0, color: 'fg.subtle', whiteSpace: 'nowrap' }}>Исчерпано</Text>
                  ) : (
                    <Button
                      variant="primary"
                      leadingVisual={offer.offer_type === 'ads' ? EyeIcon : PackageIcon}
                      loading={isBuying}
                      disabled={!canBuy}
                      onClick={() => offer && buy(acc.account_id, offer)}
                    >
                      Купить
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

export function ShopPacks() {
  const [accounts, setAccounts] = useState<ShopAccountData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('shopPacks', () => load());
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.shopPacks();
      if (d.ok) setAccounts(d.accounts);
      else showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
  }, [showFlash]);

  const refresh = async () => {
    setRefreshing(true);
    try { await load(); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, [load]);

  const handleBought = useCallback((accountId: number, offerId: number) => {
    setAccounts(prev => prev.map(acc => {
      if (acc.id !== accountId) return acc;
      return {
        ...acc,
        items: acc.items.map(item => ({
          ...item,
          offers: item.offers.map(o => o.offer_id === offerId ? { ...o, current: o.current + 1 } : o),
        })),
      };
    }));
  }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const items = pivot(accounts);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Магазин — Наборы</Heading>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing || loading} onClick={refresh}>
          Обновить
        </Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {items.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : items.map(item => <PackCard key={item.item_id} item={item} onBought={handleBought} />)
      }
    </Box>
  );
}
