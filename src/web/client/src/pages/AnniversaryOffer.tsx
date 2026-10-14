import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel } from '@primer/react';
import { SyncIcon, GiftIcon } from '@primer/octicons-react';
import { api, type AnniversaryOffer as Offer, type AnniversaryLadder } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { IC_COIN, IC_CRYSTAL } from '../components/Icons';
import { TicketIcon, fmtCountdown } from '../components/Ticket';
import { useItemCatalog, catalogItemName, catalogItemImg, type CatalogItem } from '../hooks/useItemCatalog';

// Предложение дня: игра выдаёт по одному персональному предложению в сутки (сброс по UTC — момент
// смены лежит в offer.ends_at), пропущенное сгорает. Здесь показываем предложение каждого аккаунта
// и его билетную лестницу (ступени за суммарно принятые предложения за всё событие).
//
// Покупка только за монеты/алмазы. Оплата ЗВЁЗДАМИ и TON (price.kind='money') намеренно не
// реализована — это реальные деньги, их платят руками в самой игре.

type Row = { id: number; name: string; offer?: Offer | null; ladder?: AnniversaryLadder | null; error?: string; permanent?: boolean };

function Rewards({ rewards, catalog }: { rewards: { item_id: number; amount: number }[]; catalog: Map<number, CatalogItem> }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
      {rewards.map(r => {
        // новые предметы (билеты, летний/алмазный набор, камни реформ) знает только каталог игры
        const meta = ITEMS_BY_ID[r.item_id];
        const title = meta?.name ?? catalogItemName(catalog.get(r.item_id)) ?? `#${r.item_id}`;
        const src = meta ? itemImgSrc(meta.tag) : catalogItemImg(r.item_id);
        return (
          <Box key={r.item_id} sx={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title={title}>
            <img src={src} alt="" style={{ width: 26, height: 26, objectFit: 'contain' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <Text sx={{ fontSize: 0, fontWeight: 'bold' }}>×{r.amount}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Ladder({ ladder, row, onClaimed }: { ladder: AnniversaryLadder; row: Row; onClaimed: (rung: number, ladder?: AnniversaryLadder | null) => void }) {
  const [claiming, setClaiming] = useState<number | null>(null);
  const { flash, showFlash } = useFlash();

  const claim = async (rung: number) => {
    setClaiming(rung);
    try {
      const r = await api.anniversaryLadderClaim(row.id, rung);
      // ступень гасим сразу, не дожидаясь перечитывания всех аккаунтов (иначе кнопку можно нажать
      // второй раз и получить от игры отказ «уже забрано»)
      if (r.ok) { onClaimed(rung, r.ladder); showFlash(`+${r.tickets ?? 0} билетов`, true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClaiming(null); }
  };

  return (
    <Box sx={{ mt: 2 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
        Билетная лестница · принято предложений: {ladder.offers_accepted}
      </Text>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
        {ladder.rungs.map(r => (
          <Box key={r.rung} sx={{
            display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderRadius: 1,
            border: '1px solid', borderColor: r.state === 'claimable' ? 'attention.emphasis' : 'border.muted',
            bg: r.state === 'claimed' ? 'success.subtle' : 'canvas.subtle',
          }}>
            <Text sx={{ fontSize: 0, fontWeight: 'bold' }}>{r.offers_required}</Text>
            <TicketIcon size={14} />
            <Text sx={{ fontSize: 0 }}>+{r.ticket_reward}</Text>
            {r.state === 'claimable' && (
              <Button size="small" variant="primary" loading={claiming === r.rung} disabled={claiming !== null} onClick={() => claim(r.rung)}>
                Забрать
              </Button>
            )}
          </Box>
        ))}
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1, mt: 2 }}>{flash.msg}</Flash>}
    </Box>
  );
}

function OfferCard({ row, now, onChanged, onRungClaimed, catalog }: { row: Row; now: number; onChanged: () => void; onRungClaimed: (rung: number, ladder?: AnniversaryLadder | null) => void; catalog: Map<number, CatalogItem> }) {
  const [buying, setBuying] = useState(false);
  const { flash, showFlash } = useFlash();
  const offer = row.offer;
  const price = offer?.price ?? null;
  const kind = price?.kind;
  const payable = kind === 'coins' || kind === 'crystals';

  const buy = async () => {
    if (!payable) return;
    setBuying(true);
    try {
      const r = await api.anniversaryOfferBuy(row.id, kind === 'crystals' ? 'crystals' : 'coins');
      if (r.ok) { showFlash('Предложение забрано', true); onChanged(); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBuying(false); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'bold' }}>{row.name}</Text>
        {row.error ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{row.error}</Text> : offer?.active ? (
          <>
            <Label variant="accent" sx={{ fontSize: 0 }}>День {offer.day} из {offer.total_days}</Label>
            {offer.value_multiplier > 0 && <Label variant="severe" sx={{ fontSize: 0 }}>выгода {offer.value_multiplier}×</Label>}
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>до смены {fmtCountdown(offer.ends_at, now)}</Text>
            {offer.purchased && <Label variant="success" sx={{ fontSize: 0, ml: 'auto' }}>Получено</Label>}
          </>
        ) : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>предложений нет</Text>}
      </Box>

      {!row.error && offer?.active && (
        <Box sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <Rewards rewards={offer.rewards} catalog={catalog} />
            <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
              {offer.purchased ? (
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>уже забрано</Text>
              ) : payable ? (
                <>
                  <Text sx={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 'bold' }}>
                    {kind === 'crystals' ? <>{fmt(price?.crystals ?? 0)} {IC_CRYSTAL}</> : <>{fmt(price?.coins ?? 0)} {IC_COIN}</>}
                  </Text>
                  <Button variant="primary" leadingVisual={GiftIcon} loading={buying} disabled={buying} onClick={buy}>Забрать</Button>
                </>
              ) : (
                // price.kind='money' — звёзды/TON: покупается только в самой игре
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  платное предложение (звёзды/TON) — покупка только в игре
                </Text>
              )}
            </Box>
          </Box>
          {row.ladder && <Ladder ladder={row.ladder} row={row} onClaimed={onRungClaimed} />}
          {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mt: 2 }}>{flash.msg}</Flash>}
        </Box>
      )}
    </Box>
  );
}

export function AnniversaryOffer() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [claimingAll, setClaimingAll] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const catalog = useItemCatalog();
  const [refreshing, setRefreshing] = useResumableRefresh('anniversaryOffers', () => load());
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    try {
      const d = await api.anniversaryOffers();
      if (d.ok) { setRows(d.accounts); return d.accounts; }
      showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // повтор по сбойным аккаунтам — ровно те, кому игра не ответила (?ids=...)
  const retryFailed = useCallback(async (rows: Row[]) => {
    const ids = rows.filter(r => r.error && !r.permanent).map(r => r.id);
    if (!ids.length) return;
    setRetrying(true);
    try {
      const d = await api.anniversaryOffers(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setRows(prev => prev.map(r => fixed.get(r.id) ?? r));
      }
    } catch { /* останется строка с ошибкой */ }
    finally { setRetrying(false); }
  }, []);

  useEffect(() => { load().then(rows => { if (rows) retryFailed(rows); }); }, [load, retryFailed]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { const rows = await load(); if (rows) await retryFailed(rows); }
    finally { setRefreshing(false); }
  };

  // забранная ступень лестницы гаснет сразу, перечитывание идёт следом
  const markRungClaimed = useCallback((accountId: number, rung: number, fresh?: AnniversaryLadder | null) => {
    setRows(prev => prev.map(r => r.id !== accountId || !r.ladder ? r : {
      ...r,
      // свежая лестница приходит прямо в ответе на сбор — полный проход по аккаунтам не нужен
      ladder: fresh ?? { ...r.ladder, rungs: r.ladder.rungs.map(x => x.rung === rung ? { ...x, state: 'claimed' } : x) },
    }));
  }, []);

  const claimLadders = async () => {
    setClaimingAll(true);
    try {
      const r = await api.anniversaryLadderClaimAll();
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      const claimed = r.results.reduce((n, x) => n + (x.claimed ?? 0), 0);
      const tickets = r.results.reduce((n, x) => n + (x.tickets ?? 0), 0);
      const failed = r.results.filter(x => x.error);
      showFlash(`Ступеней: ${claimed}, билетов +${tickets}` + (failed.length ? `; ошибки: ${failed.map(f => f.name).join(', ')}` : ''), failed.length === 0);
      await load();
    } catch (e) { showFlash(String(e), false); }
    finally { setClaimingAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const readyRungs = rows.reduce((n, r) => n + (r.ladder?.rungs ?? []).filter(x => x.state === 'claimable').length, 0);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2, flexWrap: 'wrap' }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Предложение дня</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant={readyRungs > 0 ? 'primary' : 'default'} leadingVisual={GiftIcon}
            loading={claimingAll} disabled={claimingAll || readyRungs === 0} onClick={claimLadders}>
            Забрать ступени {readyRungs > 0 && <CounterLabel sx={{ ml: 1 }}>{readyRungs}</CounterLabel>}
          </Button>
          <Button leadingVisual={SyncIcon} loading={refreshing || retrying} disabled={refreshing || retrying} onClick={refresh}>Обновить</Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {rows.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : rows.map(row => (
          <OfferCard key={row.id} row={row} now={now} onChanged={load} catalog={catalog}
            onRungClaimed={(rung, fresh) => markRungClaimed(row.id, rung, fresh)} />
        ))}
    </Box>
  );
}
