import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, Select, Dialog, Checkbox } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon, PlusIcon } from '@primer/octicons-react';
import { api, type MarketDealRow, type MarketSellableItem } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';
import { Scrollable } from '../components/Scrollable';

type DealType = 'listings' | 'purchases' | 'sales';

const TITLE: Record<DealType, string> = { listings: 'Листинги', purchases: 'Покупки', sales: 'Продажи' };
const PAGE_SIZE = 20;

const CAT: Record<string, string> = { booster: 'Ускоритель', pack: 'Набор', component: 'Компонент', masterplan: 'Мастерплан' };

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function timeLeft(iso?: string | null) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'истёк';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}д ${h % 24}ч` : `${h}ч ${m}м`;
}

function ItemCell({ row }: { row: MarketDealRow }) {
  const meta = row.item_id != null ? ITEMS_BY_ID[row.item_id] : null;
  const name = meta?.name ?? (row.item_category ? CAT[row.item_category] ?? row.item_category : `#${row.item_id}`);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      <Box sx={{ width: 28, height: 28, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {meta && <img src={itemImgSrc(meta.tag)} alt={name} style={{ width: 22, height: 22, objectFit: 'contain' }}
          onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />}
      </Box>
      <Text sx={{ fontSize: 1, whiteSpace: 'nowrap' }}>{name}</Text>
    </Box>
  );
}

function PriceCell({ row }: { row: MarketDealRow }) {
  if (row.price == null) return <Text sx={{ color: 'fg.muted' }}>—</Text>;
  if (row.currency === 'crystals') return <span className="mono"><CrystalValue value={fmt(row.price)} /></span>;
  if (row.currency === 'coins') return <span className="mono"><CoinValue value={fmt(row.price)} /></span>;
  if (row.currency === 'ton') return <span className="mono" style={{ color: 'var(--green)' }}>▽ {Number(row.price).toFixed(2)}</span>;
  return <span className="mono">{fmt(row.price)}</span>;
}

// ── диалог выставления предмета ─────────────────────────────────────────────
function SellDialog({ onClose, onListed, showFlash }: { onClose: () => void; onListed: () => void; showFlash: (m: string, ok: boolean) => void }) {
  const [items, setItems] = useState<MarketSellableItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [sel, setSel] = useState<MarketSellableItem | null>(null);
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const [anon, setAnon] = useState(false);
  const [days, setDays] = useState(3); // срок размещения лота (обновление игры: обязательное поле listing_days ∈ [1,3,7])
  const [busy, setBusy] = useState(false);
  // аккаунты, у которых есть выбранный предмет (ленивая загрузка из снапшота инвентаря)
  const [itemAccounts, setItemAccounts] = useState<{ id: number; name: string; owned: number }[]>([]);
  const [loadingAccs, setLoadingAccs] = useState(false);
  const [selAccounts, setSelAccounts] = useState<Set<number>>(new Set());

  // список продаваемых предметов (агрегат по всем аккаунтам) — при открытии
  useEffect(() => {
    setLoadingItems(true);
    api.marketSellableAll().then(d => { if (d.ok) setItems(d.items); }).finally(() => setLoadingItems(false));
  }, []);

  // при выборе предмета подтягиваем аккаунты с этим предметом; по умолчанию никто не выбран
  useEffect(() => {
    if (!sel) return;
    setSelAccounts(new Set());
    setItemAccounts([]);
    setLoadingAccs(true);
    api.marketItemAccounts(sel.item_id).then(d => { if (d.ok) setItemAccounts(d.accounts); }).finally(() => setLoadingAccs(false));
  }, [sel]);

  const toggleAcc = (id: number, on: boolean) => setSelAccounts(prev => { const s = new Set(prev); if (on) s.add(id); else s.delete(id); return s; });
  const selOwned = itemAccounts.filter(a => selAccounts.has(a.id)).reduce((s, a) => s + a.owned, 0);
  const maxQty = Math.max(1, selOwned || (sel?.owned ?? 1));

  const curIcon = (c: string) => c === 'ton' ? '▽' : '💎';
  const list = async () => {
    if (!sel) return;
    if (selAccounts.size === 0) { showFlash('Выберите аккаунты', false); return; }
    const p = Number(price);
    if (!price || p < sel.floor_price || p > sel.ceiling_price) { showFlash(`Цена должна быть ${fmt(sel.floor_price)}–${fmt(sel.ceiling_price)}`, false); return; }
    const n = Math.max(1, Math.min(Math.floor(qty) || 1, maxQty));
    setBusy(true);
    try {
      const d = await api.marketListSpread({ market_id: sel.market_id, item_id: sel.item_id, price: p, currency: sel.currency, anonymous: anon, quantity: n, account_ids: [...selAccounts], listing_days: days });
      if (d.ok) {
        const accs = (d.results ?? []).filter(r => r.listed > 0).length;
        showFlash(`Выставлено ${d.listed ?? 0} из ${n} (с ${accs} аккаунтов)`, (d.listed ?? 0) > 0);
        onListed();
        if ((d.listed ?? 0) >= n) onClose();
      } else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  const inputStyle = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, width: 140 };
  const meta = sel ? ITEMS_BY_ID[sel.item_id] : null;

  return (
    <Dialog isOpen onDismiss={onClose} aria-labelledby="sell-title" sx={{ maxWidth: 520, width: '95vw' }}>
      <Dialog.Header id="sell-title">{sel ? 'Выставить предмет' : 'Выберите предмет'}</Dialog.Header>
      <Box sx={{ p: 2 }}>
        {!sel ? (
          // ── ШАГ 1: список продаваемых предметов ──
          loadingItems ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
            : items.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Нет предметов для продажи на рынке</Text>
            : <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
                <Scrollable style={{ maxHeight: '60vh' }}>
                  {items.map(it => {
                    const m = ITEMS_BY_ID[it.item_id];
                    return (
                      <Box key={it.market_id} onClick={() => { setSel(it); setPrice(String(it.floor_price)); setQty(1); }}
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '8px', cursor: 'pointer', borderBottom: '1px solid', borderColor: 'border.muted', '&:hover': { bg: 'canvas.subtle' } }}>
                        {m && <img src={itemImgSrc(m.tag)} alt="" style={{ width: 28, height: 28, objectFit: 'contain' }} />}
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Text sx={{ fontSize: 1 }}>{m?.name ?? `#${it.item_id}`} {curIcon(it.currency)}</Text>
                          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>есть {it.owned} (на {it.accounts ?? '?'} акк.) · {fmt(it.floor_price)}–{fmt(it.ceiling_price)}</Text>
                        </Box>
                        <Text sx={{ color: 'fg.muted', fontSize: 2 }}>›</Text>
                      </Box>
                    );
                  })}
                </Scrollable>
              </Box>
        ) : (
          // ── ШАГ 2: цена, количество, выбор аккаунтов ──
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Button variant="invisible" sx={{ alignSelf: 'flex-start', px: 0 }} onClick={() => setSel(null)}>← К списку предметов</Button>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {meta && <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 32, height: 32, objectFit: 'contain' }} />}
              <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{meta?.name ?? `#${sel.item_id}`} {curIcon(sel.currency)}</Text>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Text sx={{ fontSize: 1 }}>Цена ({curIcon(sel.currency)} {fmt(sel.floor_price)}–{fmt(sel.ceiling_price)}):</Text>
              <input type="number" value={price} onChange={e => setPrice(e.target.value)} style={inputStyle} />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Text sx={{ fontSize: 1 }}>Количество:</Text>
              <input type="number" min={1} max={maxQty} value={qty}
                onChange={e => setQty(Math.max(1, Math.min(maxQty, Math.floor(Number(e.target.value)) || 1)))} style={inputStyle} />
              <Button onClick={() => setQty(maxQty)}>Макс {maxQty}</Button>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Text sx={{ fontSize: 1 }}>Срок:</Text>
              {[1, 3, 7].map(d => (
                <Button key={d} variant={days === d ? 'primary' : 'default'} onClick={() => setDays(d)}>{d} дн.</Button>
              ))}
            </Box>

            {/* выбор аккаунтов, с которых выставлять */}
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Text sx={{ fontSize: 1, fontWeight: 'semibold' }}>Аккаунты: {selAccounts.size}/{itemAccounts.length}</Text>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button onClick={() => setSelAccounts(new Set(itemAccounts.map(a => a.id)))}>Все</Button>
                  <Button onClick={() => setSelAccounts(new Set())}>Снять</Button>
                </Box>
              </Box>
              {loadingAccs ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><Spinner /></Box>
                : itemAccounts.length === 0 ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Нет аккаунтов с этим предметом (обновите инвентарь)</Text>
                : <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
                    <Scrollable style={{ maxHeight: 150, padding: 4 }}>
                      {itemAccounts.map(a => (
                        <label key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, padding: '2px 4px', cursor: 'pointer' }}>
                          <Checkbox checked={selAccounts.has(a.id)} onChange={e => toggleAcc(a.id, e.target.checked)} />
                          <span style={{ flex: 1 }}>{a.name}</span>
                          <span style={{ color: 'var(--fgColor-muted, #848d97)' }}>×{a.owned}</span>
                        </label>
                      ))}
                    </Scrollable>
                  </Box>}
            </Box>

            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              Выставится по выбранным аккаунтам (по свободным слотам, раз в секунду, чтобы не словить лимит игры).
            </Text>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <Checkbox checked={anon} onChange={e => setAnon(e.target.checked)} /> Разместить анонимно
            </label>
          </Box>
        )}
      </Box>
      {sel && (
        <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" loading={busy} disabled={busy || selAccounts.size === 0} onClick={list}>
            {busy ? 'Выставляю…' : `Выставить ×${Math.min(qty, maxQty)}`}
          </Button>
        </Box>
      )}
    </Dialog>
  );
}

export function MarketDeals({ type }: { type: DealType }) {
  const [rows, setRows] = useState<MarketDealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh(`marketDealsRefresh:${type}`, () => load());
  const [account, setAccount] = useState('all');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>(
    { field: type === 'listings' ? 'created_at' : 'sold_at', dir: 'desc' }
  );
  const [sellOpen, setSellOpen] = useState(false);
  const [canceling, setCanceling] = useState<Set<number>>(new Set());
  const [cancelingAll, setCancelingAll] = useState(false);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.marketDeals(type);
      if (d.ok) setRows(d.rows);
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.marketDealsRefresh(type);
      if (d.ok) {
        const errs = d.results.filter(r => !r.ok);
        await load();
        showFlash(errs.length ? `Обновлено, ошибки: ${errs.map(e => e.name).join(', ')}` : 'Обновлено', errs.length === 0);
      } else showFlash('Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  const cancelOne = async (r: MarketDealRow) => {
    if (r.listing_id == null) return;
    const id = r.listing_id;
    setCanceling(s => new Set(s).add(id));
    try {
      const d = await api.marketCancelListing(r.account, id);
      if (d.ok) { setRows(rs => rs.filter(x => x.listing_id !== id)); showFlash('Лот отменён', true); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setCanceling(s => { const n = new Set(s); n.delete(id); return n; }); }
  };

  const cancelAll = async () => {
    const scope = account === 'all' ? 'ВСЕХ аккаунтов' : account;
    if (!confirm(`Отменить все лоты ${scope}? (${sorted.length} шт)`)) return;
    setCancelingAll(true);
    try {
      const d = await api.marketCancelAllListings(account);
      if (d.ok) {
        const fail = (d.results ?? []).filter(x => !x.ok).length;
        showFlash(`Отменено ${d.count ?? 0} лот(ов)${fail ? ` · ошибок ${fail}` : ''}`, fail === 0);
        await load();
      } else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setCancelingAll(false); }
  };

  useEffect(() => { load(); setPage(0); }, [type]);

  const accounts = useMemo(() => [...new Set(rows.map(r => r.account))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [rows]);

  const itemName = (r: MarketDealRow) => {
    const m = r.item_id != null ? ITEMS_BY_ID[r.item_id] : null;
    return (m?.name ?? (r.item_category ? CAT[r.item_category] ?? r.item_category : '') ?? '').toString();
  };
  const sortValue = (r: MarketDealRow, field: string): number | string => {
    switch (field) {
      case 'item_id': return itemName(r).toLowerCase();
      case 'price': return r.price ?? -Infinity;
      case 'fee': return r.fee ?? -Infinity;
      case 'created_at': case 'ends_at': case 'sold_at': return new Date((r as unknown as Record<string, unknown>)[field] as string ?? 0).getTime();
      default: return ((r as unknown as Record<string, unknown>)[field] as string) ?? '';
    }
  };

  const sorted = useMemo(() => {
    const arr = rows.filter(r => account === 'all' || r.account === account);
    const { field, dir } = sort;
    arr.sort((a, b) => {
      const va = sortValue(a, field), vb = sortValue(b, field);
      const c = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb
        : String(va).localeCompare(String(vb), 'ru', { numeric: true });
      return dir === 'asc' ? c : -c;
    });
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, account, sort]);

  const pageRows = sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const toggleSort = (field: string) => {
    setSort(s => (s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' }));
    setPage(0);
  };
  const SortHeader = (field: string, label: string) => () => {
    const active = sort.field === field;
    return (
      <Box as="span" onClick={() => toggleSort(field)}
        sx={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 1, fontWeight: active ? 'bold' : 'normal', color: active ? 'fg.default' : 'inherit' }}>
        {label}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </Box>
    );
  };

  type Col = { header: () => ReactNode; field: keyof MarketDealRow; rowHeader?: boolean; renderCell: (r: MarketDealRow) => ReactNode };
  const cols: Col[] = [
    { header: SortHeader('account', 'Аккаунт'), field: 'account', rowHeader: true, renderCell: r => <strong>{r.account}</strong> },
    { header: SortHeader('item_id', 'Предмет'), field: 'item_id', renderCell: r => <ItemCell row={r} /> },
    { header: SortHeader('price', 'Цена'), field: 'price', renderCell: r => <PriceCell row={r} /> },
    ...(type === 'listings'
      ? ([
          { header: SortHeader('status', 'Статус'), field: 'status', renderCell: r => <Label variant={r.status === 'active' ? 'success' : 'default'}>{r.status ?? '—'}</Label> },
          { header: SortHeader('created_at', 'Создан'), field: 'created_at', renderCell: r => <span className="mono" style={{ fontSize: 11 }}>{fmtDate(r.created_at)}</span> },
          { header: SortHeader('ends_at', 'Осталось'), field: 'ends_at', renderCell: r => <span className="mono" style={{ fontSize: 11 }}>{timeLeft(r.ends_at)}</span> },
          { header: () => <></>, field: 'listing_id', renderCell: r => (
            r.status === 'active' && r.listing_id != null
              ? <Button variant="danger" disabled={canceling.has(r.listing_id)} loading={canceling.has(r.listing_id)} onClick={() => cancelOne(r)}>
                  Отменить
                </Button>
              : null
          ) },
        ] as Col[])
      : ([
          { header: SortHeader('fee', 'Комиссия'), field: 'fee', renderCell: r => <span className="mono" style={{ color: 'var(--fg-muted)' }}>{r.fee != null ? Number(r.fee).toFixed(2) : '—'}</span> },
          { header: SortHeader('counterparty', type === 'purchases' ? 'Продавец' : 'Покупатель'), field: 'counterparty', renderCell: r => <Text sx={{ fontSize: 1 }}>{r.counterparty || '—'}</Text> },
          { header: SortHeader('sold_at', 'Дата'), field: 'sold_at', renderCell: r => <span className="mono" style={{ fontSize: 11 }}>{fmtDate(r.sold_at)}</span> },
        ] as Col[])),
  ];

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>{TITLE[type]}</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить</Button>
        {type === 'listings' && <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setSellOpen(true)}>Выставить предмет</Button>}
        {type === 'listings' && sorted.length > 0 && (
          <Button variant="danger" loading={cancelingAll} disabled={cancelingAll} onClick={cancelAll}>
            {account === 'all' ? 'Отменить все лоты' : `Отменить лоты ${account}`}
          </Button>
        )}
        <Select value={account} onChange={e => { setAccount(e.target.value); setPage(0); }}>
          <Select.Option value="all">Все аккаунты</Select.Option>
          {accounts.map(a => <Select.Option key={a} value={a}>{a}</Select.Option>)}
        </Select>
        <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Всего: {sorted.length}</Text>
      </Box>

      {sorted.length === 0
        ? <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>Нет данных — нажмите «Обновить»</Box>
        : <Table.Container>
            <DataTable data={pageRows} columns={cols} />
            <Table.Pagination
              aria-label={`Страницы — ${TITLE[type]}`}
              pageSize={PAGE_SIZE}
              totalCount={sorted.length}
              onChange={({ pageIndex }) => setPage(pageIndex)}
            />
          </Table.Container>
      }
      {sellOpen && <SellDialog onClose={() => setSellOpen(false)} onListed={() => refresh()} showFlash={showFlash} />}
    </Box>
  );
}

export function MarketListings() { return <MarketDeals type="listings" />; }
export function MarketPurchases() { return <MarketDeals type="purchases" />; }
export function MarketSales() { return <MarketDeals type="sales" />; }
