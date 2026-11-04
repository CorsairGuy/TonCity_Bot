import { useEffect, useState } from 'react';
import { Box, Button, Flash, Label, Text } from '@primer/react';
import { SyncIcon, CheckIcon, XIcon, ClockIcon } from '@primer/octicons-react';
import { api, type NegotiationOffer } from '../api';
import { ITEMS_BY_ID, fmt } from '../utils';
import { CrystalValue } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { LoadError } from '../components/LoadError';
import { Caption, ItemCard } from './cityMapPanels';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { useFlash } from '../hooks/useFlash';
import { useAsk } from '../hooks/useAsk';

// Переговорные предложения рынка всех аккаунтов (2.5): входящие — принять/отклонить, свои — отозвать
// после revocable_at. Список — последний снимок из БД (routes/marketOffers.js), «Обновить» идёт в игру.

const Price = ({ v, cur }: { v: number; cur: string }) => cur === 'crystals' ? <CrystalValue value={fmt(v)} /> : <Text>{v} GRAM</Text>;
const RARITY: Record<string, string> = { epic: 'Эпическая', legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная' };

function Card({ o, children }: { o: NegotiationOffer; children: React.ReactNode }) {
  const catalog = useItemCatalog(o.item_id && !ITEMS_BY_ID[o.item_id] ? [o.item_id] : undefined);
  const tag = (o.item_id && (ITEMS_BY_ID[o.item_id]?.tag || catalog.get(o.item_id)?.tag)) || '';
  const name = o.policy ? `Политика · ${RARITY[o.item_rarity ?? ''] ?? o.item_rarity ?? ''}` : o.item_id ? itemName(o.item_id, catalog) : 'Предмет';
  return (
    <Box sx={{ p: 2, borderRadius: '12px', bg: 'canvas.subtle', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <ItemCard tag={tag} src={tag ? undefined : null} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</Text>
          <Label size="small" variant="secondary">{o.account}</Label>
        </Box>
      </Box>
      {children}
    </Box>
  );
}
const left = (iso?: string | null) => {
  const s = iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 1000) : 0;
  return s <= 0 ? 0 : s;
};

export function MarketOffers() {
  const [data, setData] = useState<{ received: NegotiationOffer[]; sent: NegotiationOffer[]; updated_at: string | null; accounts: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  const { flash, showFlash } = useFlash();
  const ask = useAsk();
  const load = async () => {
    const r = await api.negotiationOffers();
    if (!r.ok) { setErr(r.error ?? 'Ошибка загрузки'); return; }
    setErr(null); setData({ received: r.received, sent: r.sent, updated_at: r.updated_at, accounts: r.accounts.length });
  };
  useEffect(() => { load(); const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []);
  const refresh = async () => {
    setBusy('refresh');
    const r = await api.negotiationOffersRefresh();
    setBusy(null); await load();
    showFlash(!r.ok ? (r.error ?? 'Ошибка') : r.errors?.length ? `Обновлено с ошибками: ${r.errors.join('; ')}` : 'Обновлено с сервера игры', r.ok && !r.errors?.length);
  };
  const act = async (o: NegotiationOffer, action: 'accept' | 'reject' | 'revoke') => {
    const q = action === 'accept' ? ['Принять предложение?', `${o.account} продаст предмет покупателю ${o.buyer_name ?? ''} — получит ${o.seller_proceeds ?? o.amount} ${o.currency === 'crystals' ? 'кристаллов' : 'GRAM'}.`]
      : action === 'reject' ? ['Отклонить предложение?', `Предложение от ${o.buyer_name ?? 'покупателя'} будет отклонено.`]
      : ['Отозвать предложение?', 'Ваше предложение продавцу будет отозвано.'];
    if (!await ask(q[0], q[1], { ok: action === 'accept' ? 'Принять' : action === 'reject' ? 'Отклонить' : 'Отозвать', danger: action !== 'accept' })) return;
    setBusy(`${action}:${o.id}`);
    const r = await api.negotiationOfferAction(action, o.account_id, o.id);
    setBusy(null);
    showFlash(r.ok ? (action === 'accept' ? 'Предложение принято' : action === 'reject' ? 'Предложение отклонено' : 'Предложение отозвано') : (r.error ?? 'Ошибка'), r.ok);
    load();
  };
  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={load} /></Box>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 2, mt: 2, mb: 4 };
  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Предложения" sub={data?.updated_at ? `снимок от ${new Date(data.updated_at).toLocaleString('ru')}` : 'торг по лотам «Предложение»'}
        actions={<Button leadingVisual={SyncIcon} loading={busy === 'refresh'} disabled={!!busy} onClick={refresh}>Обновить с игры</Button>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {!data ? <Text sx={{ color: 'fg.muted' }}>Загрузка…</Text> : <>
        <Caption right={data.received.length}>Вам предлагают</Caption>
        {!data.received.length ? <Text sx={{ display: 'block', color: 'fg.muted', mt: 2, mb: 4 }}>Входящих предложений нет{!data.updated_at ? ' — нажмите «Обновить с игры»' : ''}.</Text> : (
          <Box sx={grid}>
            {data.received.map(o => (
              <Card key={`r${o.account_id}:${o.id}`} o={o}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1 }}><Text sx={{ color: 'fg.muted' }}>от {o.buyer_name ?? '—'}</Text><Price v={o.amount} cur={o.currency} /></Box>
                {o.seller_proceeds != null && <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1 }}><Text sx={{ color: 'fg.muted' }}>вы получите</Text><Text sx={{ fontWeight: 'bold', color: 'success.fg' }}><Price v={o.seller_proceeds} cur={o.currency} /></Text></Box>}
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <Box sx={{ flex: 1 }}><Button block size="small" variant="primary" leadingVisual={CheckIcon} loading={busy === `accept:${o.id}`} disabled={!!busy} onClick={() => act(o, 'accept')}>Принять</Button></Box>
                  <Box sx={{ flex: 1 }}><Button block size="small" variant="danger" leadingVisual={XIcon} loading={busy === `reject:${o.id}`} disabled={!!busy} onClick={() => act(o, 'reject')}>Отклонить</Button></Box>
                </Box>
              </Card>
            ))}
          </Box>
        )}
        <Caption right={data.sent.length}>Мои предложения</Caption>
        {!data.sent.length ? <Text sx={{ display: 'block', color: 'fg.muted', mt: 2 }}>Отправленных предложений нет.</Text> : (
          <Box sx={grid}>
            {data.sent.map(o => {
              const s = left(o.revocable_at);
              return (
                <Card key={`s${o.account_id}:${o.id}`} o={o}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1 }}><Text sx={{ color: 'fg.muted' }}>ваше предложение</Text><Price v={o.amount} cur={o.currency} /></Box>
                  <Button block size="small" variant="danger" leadingVisual={s ? ClockIcon : XIcon} loading={busy === `revoke:${o.id}`} disabled={!!busy || s > 0} onClick={() => act(o, 'revoke')}>
                    {s > 0 ? `Отозвать можно через ${s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.floor(s % 3600 / 60)} мин` : s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`}` : 'Отозвать'}
                  </Button>
                </Card>
              );
            })}
          </Box>
        )}
      </>}
    </Box>
  );
}
