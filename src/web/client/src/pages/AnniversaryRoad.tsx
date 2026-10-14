import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel, ProgressBar } from '@primer/react';
import { SyncIcon, GiftIcon } from '@primer/octicons-react';
import { api, type AnniversaryRoad as Road, type AnniversaryStage } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { TicketIcon, fmtCountdown } from '../components/Ticket';
import { useItemCatalog, catalogItemName, catalogItemImg, type CatalogItem } from '../hooks/useItemCatalog';

// Дорога наград: у каждого этапа ДВА порога — сколько потратил весь мир (global_coins) и сколько
// потратил лично аккаунт (personal_goal). Награда открывается, только когда дошли ОБЕ стороны,
// и тогда игра сама ставит этапу state='claimable'. Прогресс мира общий для всех аккаунтов,
// личный — свой у каждого.

type Row = { id: number; name: string; road?: Road; error?: string; permanent?: boolean };

function StageRewards({ st, ticketItemId, catalog }: { st: AnniversaryStage; ticketItemId: number | null; catalog: Map<number, CatalogItem> }) {
  const items = st.item_rewards ?? [];
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      {st.ticket_reward > 0 && (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
          <TicketIcon size={18} /><Text sx={{ fontSize: 0 }}>×{st.ticket_reward}</Text>
        </Box>
      )}
      {items.map(r => {
        // билеты игра может прислать и обычной наградой-предметом — id приходит в ticket_item_id
        if (ticketItemId != null && r.item_id === ticketItemId) {
          return (
            <Box key={r.item_id} sx={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <TicketIcon size={18} /><Text sx={{ fontSize: 0 }}>×{r.amount}</Text>
            </Box>
          );
        }
        // название и картинку берём из своего справочника, а если предмет новый (его id заранее
        // не известен) — из каталога, который бот забрал у самой игры (hooks/useItemCatalog)
        const meta = ITEMS_BY_ID[r.item_id];
        const title = meta?.name ?? catalogItemName(catalog.get(r.item_id)) ?? `#${r.item_id}`;
        const src = meta ? itemImgSrc(meta.tag) : catalogItemImg(r.item_id);
        return (
          <Box key={r.item_id} sx={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }} title={title}>
            <img src={src} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <Text sx={{ fontSize: 0 }}>×{r.amount}</Text>
          </Box>
        );
      })}
      {st.policy && (
        <Label variant="danger" sx={{ fontSize: 0 }}>
          политика: {typeof st.policy.name === 'string' ? st.policy.name : (st.policy.name?.ru ?? st.policy.name?.en ?? '—')}
        </Label>
      )}
    </Box>
  );
}

function StageRow({ st, row, onClaimed, ticketItemId, catalog }: { st: AnniversaryStage; row: Row; onClaimed: (stage: number, road?: Road | null) => void; ticketItemId: number | null; catalog: Map<number, CatalogItem> }) {
  const [claiming, setClaiming] = useState(false);
  const { flash, showFlash } = useFlash();
  const road = row.road!;
  const cityMet = road.global_total >= st.global_coins;
  const youMet = road.coins_spent >= st.personal_goal;

  const claim = async () => {
    setClaiming(true);
    try {
      const r = await api.anniversaryMilestoneClaim(row.id, st.stage);
      // состояние этапа переключаем СРАЗУ (onClaimed ставит state='claimed' локально), не дожидаясь
      // перечитывания всех аккаунтов: полный проход по игре идёт секунды, и всё это время кнопка
      // оставалась активной — можно было нажать повторно и получить 400 «уже забрано»
      if (r.ok) { onClaimed(st.stage, r.road); showFlash('Этап забран', true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClaiming(false); }
  };

  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
      py: '6px', px: 2, borderRadius: 1, bg: 'canvas.subtle',
      border: '1px solid', borderColor: st.state === 'claimable' ? 'attention.emphasis' : 'border.muted',
    }}>
      <Text sx={{ fontSize: 1, fontWeight: 'bold', minWidth: 70 }}>Этап {st.stage}</Text>
      <StageRewards st={st} ticketItemId={ticketItemId} catalog={catalog} />
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontSize: 0, color: cityMet ? 'success.fg' : 'fg.muted', whiteSpace: 'nowrap' }}>
          мир {fmt(road.global_total)} / {fmt(st.global_coins)}
        </Text>
        <Text sx={{ fontSize: 0, color: youMet ? 'success.fg' : 'fg.muted', whiteSpace: 'nowrap' }}>
          вы {fmt(road.coins_spent)} / {fmt(st.personal_goal)}
        </Text>
        {st.state === 'claimed'
          ? <Label variant="success" sx={{ fontSize: 0 }}>Забрано</Label>
          : st.state === 'claimable'
            ? <Button variant="primary" size="small" leadingVisual={GiftIcon} loading={claiming} disabled={claiming} onClick={claim}>Забрать</Button>

            : <Label variant="secondary" sx={{ fontSize: 0 }}>{cityMet && !youMet ? 'ждём вас' : !cityMet && youMet ? 'ждём мир' : 'закрыт'}</Label>}
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1, width: '100%' }}>{flash.msg}</Flash>}
    </Box>
  );
}

export function AnniversaryRoad() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [claimingAll, setClaimingAll] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const catalog = useItemCatalog();
  const [refreshing, setRefreshing] = useResumableRefresh('anniversaryMilestones', () => load());
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    try {
      const d = await api.anniversaryMilestones();
      if (d.ok) { setRows(d.accounts); return d.accounts; }
      showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // добираем аккаунты, по которым игра не ответила: спрашиваем ровно их (?ids=...) и вклеиваем
  // свежие строки в уже показанные — ретраи внутри прохода ограничены бюджетом accountSweep
  const retryFailed = useCallback(async (rows: Row[]) => {
    const ids = rows.filter(r => r.error && !r.permanent).map(r => r.id);
    if (!ids.length) return;
    setRetrying(true);
    try {
      const d = await api.anniversaryMilestones(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setRows(prev => prev.map(r => fixed.get(r.id) ?? r));
      }
    } catch { /* останется строка с ошибкой — есть кнопка «Обновить» */ }
    finally { setRetrying(false); }
  }, []);

  useEffect(() => { load().then(rows => { if (rows) retryFailed(rows); }); }, [load, retryFailed]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { const rows = await load(); if (rows) await retryFailed(rows); }
    finally { setRefreshing(false); }
  };

  // локально гасим забранный этап (кнопка → «Забрано») и только потом идём перечитывать данные:
  // полный живой проход по всем аккаунтам занимает секунды, кнопка не должна оставаться нажимаемой
  const markClaimed = useCallback((accountId: number, stage: number, fresh?: Road | null) => {
    setRows(prev => prev.map(r => {
      if (r.id !== accountId || !r.road) return r;
      if (fresh) return { ...r, road: fresh };   // сервер уже перечитал дорогу этого аккаунта
      return {
        ...r,
        road: {
          ...r.road,
          claimed_stages: r.road.claimed_stages + 1,
          stages: r.road.stages.map(s => s.stage === stage ? { ...s, state: 'claimed' } : s),
        },
      };
    }));
  }, []);

  const claimAll = async () => {
    setClaimingAll(true);
    try {
      const r = await api.anniversaryMilestoneClaimAll();
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      const claimed = r.results.reduce((n, x) => n + (x.claimed ?? 0), 0);
      const failed = r.results.filter(x => x.error);
      showFlash(`Забрано этапов: ${claimed}` + (failed.length ? `; ошибки: ${failed.map(f => f.name).join(', ')}` : ''), failed.length === 0);
      await load();
    } catch (e) { showFlash(String(e), false); }
    finally { setClaimingAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const anyRoad = rows.find(r => r.road?.active)?.road ?? null;
  const totalReady = rows.reduce((n, r) => n + (r.road?.stages ?? []).filter(s => s.state === 'claimable').length, 0);
  const worldPct = anyRoad && anyRoad.global_goal > 0 ? Math.min(100, (anyRoad.global_total / anyRoad.global_goal) * 100) : 0;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2, flexWrap: 'wrap' }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Дорога наград</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant={totalReady > 0 ? 'primary' : 'default'} leadingVisual={GiftIcon}
            loading={claimingAll} disabled={claimingAll || totalReady === 0} onClick={claimAll}>
            Забрать всё {totalReady > 0 && <CounterLabel sx={{ ml: 1 }}>{totalReady}</CounterLabel>}
          </Button>
          <Button leadingVisual={SyncIcon} loading={refreshing || retrying} disabled={refreshing || retrying} onClick={refresh}>Обновить</Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {/* прогресс мира — общий для всех аккаунтов, показываем один раз */}
      {anyRoad && (
        <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 2 }}>
            <Text sx={{ fontWeight: 'bold' }}>Мир потратил</Text>
            <Text sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(anyRoad.global_total)} / {fmt(anyRoad.global_goal)}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{worldPct.toFixed(2)}%</Text>
            {anyRoad.event_ends_at && (
              <Text sx={{ ml: 'auto', fontSize: 0, color: 'fg.muted' }}>до конца события {fmtCountdown(anyRoad.event_ends_at, now)}</Text>
            )}
          </Box>
          <ProgressBar progress={worldPct} />
        </Box>
      )}

      {rows.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text> : rows.map(row => {
        const road = row.road;
        const ready = (road?.stages ?? []).filter(s => s.state === 'claimable').length;
        return (
          <Box key={row.id} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
            <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              <Text sx={{ fontWeight: 'bold' }}>{row.name}</Text>
              {row.error ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{row.error}</Text> : road?.active ? (
                <>
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>потрачено {fmt(road.coins_spent)}</Text>
                  <Box sx={{ ml: 'auto', display: 'flex', gap: 2, alignItems: 'center' }}>
                    {ready > 0 && <Label variant="attention" sx={{ fontSize: 0 }}>готово: {ready}</Label>}
                    <Text sx={{ fontSize: 0, color: 'fg.muted' }}>этапов забрано {road.claimed_stages}/{road.stages.length}</Text>
                  </Box>
                </>
              ) : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>дорога закрыта</Text>}
            </Box>
            {road?.active && (
              <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {road.stages.map(st => (
                  <StageRow key={st.stage} st={st} row={row} catalog={catalog} onClaimed={(stage, fresh) => markClaimed(row.id, stage, fresh)} ticketItemId={road.ticket_item_id} />
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
