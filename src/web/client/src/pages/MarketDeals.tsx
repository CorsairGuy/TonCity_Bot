import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, Button, Flash, Spinner, Text, Label, Select, Checkbox, TextInput } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon, PlusIcon } from '@primer/octicons-react';
import { api, type MarketDealRow, type MarketSellableItem, type PolicyDefEntry } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { CoinValue, CrystalValue } from '../components/Icons';
import { Scrollable } from '../components/Scrollable';
import { PolicyCardModal } from '../components/PolicyCardModal';
import { useItemCatalog, knownItemName } from '../hooks/useItemCatalog';
import { PageHeader } from '../components/PageHeader';
import { useAsk } from '../hooks/useAsk';

type DealType = 'listings' | 'purchases' | 'sales';

const TITLE: Record<DealType, string> = { listings: 'Листинги', purchases: 'Покупки', sales: 'Продажи' };
const PAGE_SIZE = 20;

const CAT: Record<string, string> = { booster: 'Ускоритель', pack: 'Набор', component: 'Компонент', masterplan: 'Мастерплан' };
// карты политик (не путать с "наборами"/"тайными политиками" — те обычные стакающиеся предметы,
// есть в ITEMS_BY_ID) продаются через общий item_id-"бакет" на редкость, без своего катaложного
// имени/иконки — см. web/routes/market.js POLICY_CARD_BUCKET_ITEM_ID. Показываем по item_rarity.
const RARITY_RU: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};
function policyCardLabel(rarity: string): string { return `Политика (${RARITY_RU[rarity] ?? rarity})`; }
// у карты политики свой def_id и название (разные политики одной редкости различаются, показываем
// конкретное имя, а не общий "Политика (Редкость)" — по просьбе пользователя 31.07.2026)
function policyItemLabel(it: { item_category: string; item_rarity: string; policy_name?: string }): string {
  if (it.item_category !== 'policy') return '';
  return it.policy_name ? `${it.policy_name} (${RARITY_RU[it.item_rarity] ?? it.item_rarity})` : policyCardLabel(it.item_rarity);
}
const MARKET_TYPE_RU: Record<string, string> = { direct: 'Прямая продажа', auction: 'Аукцион', negotiation: 'Предложение' };
// Ключ «склада»: один и тот же физический запас предметов представлен НЕСКОЛЬКИМИ строками списка —
// по строке на каждый тип рынка (direct/auction/negotiation). Выставив 1 шт. через прямую продажу,
// надо уменьшить остаток и в строке аукциона того же предмета, иначе список соврёт.
function stockKey(it: MarketSellableItem): string {
  return it.item_category === 'policy' ? `p:${it.item_id}:${it.item_rarity}:${it.def_id ?? ''}` : `i:${it.item_id}`;
}
// характеристики выставляемой политики берём из общего каталога по def_id (как на странице лотов);
// если политики там ещё нет — показываем хотя бы имя+редкость, без эффектов
function sellablePolicyVariants(it: MarketSellableItem, catalog: PolicyDefEntry[]): PolicyDefEntry[] {
  // ВАЖНО: искать по паре (def_id, rarity) — это первичный ключ каталога, одна и та же политика
  // лежит там отдельной строкой на КАЖДУЮ редкость. Поиск только по def_id возвращал первую строку
  // в порядке rarity ASC, то есть по клику на названии открывалась карточка чужой редкости
  // (обычно 'common') вместо той, что реально выставляется. На странице лотов это уже было учтено,
  // см. MarketLots.tsx — здесь осталась старая однополевая выборка.
  const exact = it.def_id != null
    ? (catalog.find(d => String(d.def_id) === String(it.def_id) && d.rarity === it.item_rarity)
      ?? catalog.find(d => String(d.def_id) === String(it.def_id) && d.rarity === 'unknown'))
    : null;
  if (exact) return [exact];
  return [{
    def_id: String(it.def_id ?? ''), rarity: it.item_rarity,
    name: it.policy_name ? { ru: it.policy_name, en: it.policy_name } : null,
    description: null, icon_key: null, theme: null, badge: null, badge_n: null,
    max_level: null, seen_account: null, updated_at: null, effects: [],
  }];
}

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
  const name = (row.item_category !== 'policy' ? knownItemName(row.item_id) : null)
    ?? (row.item_category === 'policy' && row.item_rarity ? policyCardLabel(row.item_rarity) : null)
    ?? (row.item_category ? CAT[row.item_category] ?? row.item_category : `Предмет #${row.item_id}`);
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
// mode='items' — обычные предметы (как на странице "Предметы"), mode='special' — политики+осколки
// (отдельная кнопка, всегда живой запрос к /policies/, см. web/routes/market.js SPECIAL_CATEGORIES)
function SellDialog({ mode, onClose, onListed, showFlash: showPageFlash }: { mode: 'items' | 'special'; onClose: () => void; onListed: () => void; showFlash: (m: string, ok: boolean) => void }) {
  // ошибки — внутри окна: флэш на странице прятался под затемнением открытого диалога
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const showFlash = (msg: string, ok: boolean) => { if (ok) showPageFlash(msg, ok); else setNote({ msg, ok }); };
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
  // каталог политик (для карточки с характеристиками по клику на название — как на странице лотов)
  const [policyDefs, setPolicyDefs] = useState<PolicyDefEntry[]>([]);
  const [policyModal, setPolicyModal] = useState<MarketSellableItem | null>(null);
  // Уже выставленное за эту сессию диалога, по аккаунтам: `${stockKey}|${имя аккаунта}` → сколько.
  // Нужно, чтобы после выставления не перезапрашивать весь список с игры (долго — живые запросы на
  // все аккаунты), а просто уменьшить остаток и вернуться к выбору (просьба пользователя 31.07.2026).
  // Через ref, а не state: читается внутри эффекта по [sel], в deps его добавлять нельзя (перезапрос).
  const listedRef = useRef<Record<string, number>>({});

  // список продаваемых предметов (агрегат по всем аккаунтам) — при открытии
  useEffect(() => {
    setLoadingItems(true);
    api.marketSellableAll(undefined, mode).then(d => { if (d.ok) setItems(d.items); }).finally(() => setLoadingItems(false));
    if (mode === 'special') api.policyDefs().then(d => { if (d.ok) setPolicyDefs(d.defs); }).catch(() => {});
  }, [mode]);

  // при выборе предмета подтягиваем аккаунты с этим предметом; по умолчанию никто не выбран
  useEffect(() => {
    if (!sel) return;
    setSelAccounts(new Set());
    setItemAccounts([]);
    setLoadingAccs(true);
    const key = stockKey(sel);
    api.marketItemAccounts(sel.item_id, sel.item_category === 'policy' ? sel.item_rarity : undefined, sel.item_category === 'policy' ? sel.def_id : undefined)
      .then(d => {
        if (!d.ok) return;
        // вычитаем то, что уже выставили с этих аккаунтов в этой же сессии диалога (снапшот
        // инвентаря в БД обновляется не сразу, сам бы он ещё показывал старое количество)
        setItemAccounts(d.accounts
          .map(a => ({ ...a, owned: a.owned - (listedRef.current[`${key}|${a.name}`] ?? 0) }))
          .filter(a => a.owned > 0));
      })
      .finally(() => setLoadingAccs(false));
  }, [sel]);

  const toggleAcc = (id: number, on: boolean) => setSelAccounts(prev => { const s = new Set(prev); if (on) s.add(id); else s.delete(id); return s; });
  const selOwned = itemAccounts.filter(a => selAccounts.has(a.id)).reduce((s, a) => s + a.owned, 0);
  const maxQty = Math.max(1, selOwned || (sel?.owned ?? 1));

  const curIcon = (c: string) => c === 'ton' ? '▽' : '💎';
  // «Предложение» (negotiation): игра не принимает ни цену, ни срок — покупатель сам предлагает
  // сумму, продавец потом принимает/отклоняет (реверс бандла 31.07.2026)
  const selType = sel?.market_type ?? 'direct';
  const needsPrice = selType !== 'negotiation';
  const list = async () => {
    if (!sel) return;
    if (selAccounts.size === 0) { showFlash('Выберите аккаунты', false); return; }
    const p = Number(price);
    if (needsPrice) {
      const lo = sel.floor_price, hi = sel.ceiling_price;
      if (!price || (lo != null && p < lo) || (hi != null && p > hi)) { showFlash(`Цена должна быть ${fmt(lo ?? 0)}–${hi != null ? fmt(hi) : '∞'}`, false); return; }
    }
    const n = Math.max(1, Math.min(Math.floor(qty) || 1, maxQty));
    setBusy(true);
    try {
      const d = await api.marketListSpread({ market_id: sel.market_id, item_id: sel.item_id, item_rarity: sel.item_rarity, def_id: sel.def_id, market_type: selType, price: needsPrice ? p : undefined, currency: sel.currency, anonymous: anon, quantity: n, account_ids: [...selAccounts], listing_days: days });
      if (d.ok) {
        const results = d.results ?? [];
        const done = d.listed ?? 0;
        const accs = results.filter(r => r.listed > 0).length;
        showFlash(`Выставлено ${done} из ${n} (с ${accs} аккаунтов)`, done > 0);
        onListed();
        if (done > 0) {
          // не закрываем диалог и НЕ перезапрашиваем весь список с игры — просто списываем остаток
          // локально и возвращаемся к выбору (по просьбе пользователя 31.07.2026)
          const key = stockKey(sel);
          for (const r of results) if (r.listed > 0) listedRef.current[`${key}|${r.name}`] = (listedRef.current[`${key}|${r.name}`] ?? 0) + r.listed;
          setItems(prev => prev
            .map(it => stockKey(it) === key
              ? { ...it, owned: it.owned - done, free_slots: it.free_slots != null ? Math.max(0, it.free_slots - done) : it.free_slots }
              : it)
            .filter(it => it.owned > 0));
          setSel(null);
        }
      } else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  const inputSx = { width: 140 } as const;
  const meta = sel ? ITEMS_BY_ID[sel.item_id] : null;

  return (
    <Dialog
      title={sel ? 'Выставить предмет' : (mode === 'special' ? 'Выберите политику/осколок' : 'Выберите предмет')}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      /* кнопка появляется только на 2-м шаге (когда предмет уже выбран) */
      footerButtons={sel ? [{
        content: busy ? 'Выставляю…' : `Выставить ×${Math.min(qty, maxQty)}`,
        buttonType: 'primary',
        loading: busy,
        disabled: busy || selAccounts.size === 0,
        onClick: list,
      }] : undefined}
    >
      <Box>
        {note && <Flash variant="danger" sx={{ mb: 2 }}>{note.msg}</Flash>}
        {!sel ? (
          // ── ШАГ 1: список продаваемых предметов ──
          loadingItems ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
            : items.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Нет предметов для продажи на рынке</Text>
            : <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
                <Scrollable style={{ maxHeight: '60vh' }}>
                  {items.map(it => {
                    const m = ITEMS_BY_ID[it.item_id];
                    const mt = it.market_type ?? 'direct';
                    const isPolicy = it.item_category === 'policy';
                    return (
                      <Box key={`${it.market_id}:${mt}:${it.def_id ?? ''}`} onClick={() => { setSel(it); setPrice(String(it.floor_price ?? '')); setQty(1); }}
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '8px', cursor: 'pointer', borderBottom: '1px solid', borderColor: 'border.muted', '&:hover': { bg: 'canvas.subtle' } }}>
                        {m && <img src={itemImgSrc(m.tag)} alt="" style={{ width: 28, height: 28, objectFit: 'contain' }} />}
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                            {/* клик по названию политики открывает карточку с характеристиками (как на странице лотов) */}
                            <Text sx={{ fontSize: 1, ...(isPolicy ? { textDecoration: 'underline dotted', cursor: 'help' } : {}) }}
                              title={isPolicy ? 'Показать характеристики политики' : undefined}
                              onClick={isPolicy ? (e => { e.stopPropagation(); setPolicyModal(it); }) : undefined}>
                              {isPolicy ? (m?.name ?? policyItemLabel(it)) : (knownItemName(it.item_id) ?? `Предмет #${it.item_id}`)} {curIcon(it.currency)}
                            </Text>
                            <Label variant={mt === 'auction' ? 'attention' : mt === 'negotiation' ? 'accent' : 'default'} sx={{ fontSize: 0 }}>{MARKET_TYPE_RU[mt] ?? mt}</Label>
                          </Box>
                          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>
                            есть {it.owned} (на {it.accounts ?? '?'} акк.){mt === 'negotiation' ? ' · цену предлагает покупатель' : ` · ${fmt(it.floor_price ?? 0)}–${it.ceiling_price != null ? fmt(it.ceiling_price) : '∞'}`}
                          </Text>
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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              {meta && <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 32, height: 32, objectFit: 'contain' }} />}
              <Text sx={{ fontWeight: 'bold', fontSize: 1, ...(sel.item_category === 'policy' ? { textDecoration: 'underline dotted', cursor: 'help' } : {}) }}
                title={sel.item_category === 'policy' ? 'Показать характеристики политики' : undefined}
                onClick={sel.item_category === 'policy' ? () => setPolicyModal(sel) : undefined}>
                {sel.item_category === 'policy' ? (meta?.name ?? policyItemLabel(sel)) : (knownItemName(sel.item_id) ?? `Предмет #${sel.item_id}`)} {curIcon(sel.currency)}
              </Text>
              <Label variant={selType === 'auction' ? 'attention' : selType === 'negotiation' ? 'accent' : 'default'} sx={{ fontSize: 0 }}>{MARKET_TYPE_RU[selType] ?? selType}</Label>
            </Box>

            {needsPrice ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Text sx={{ fontSize: 1 }}>{selType === 'auction' ? 'Стартовая ставка' : 'Цена'} ({curIcon(sel.currency)} {fmt(sel.floor_price ?? 0)}–{sel.ceiling_price != null ? fmt(sel.ceiling_price) : '∞'}):</Text>
                <TextInput type="number" aria-label="Цена" value={price} onChange={e => setPrice(e.target.value)} sx={inputSx} />
              </Box>
            ) : (
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Цена не задаётся: покупатели сами присылают предложения, вы их принимаете или отклоняете.</Text>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Text sx={{ fontSize: 1 }}>Количество:</Text>
              <TextInput type="number" aria-label="Количество" min={1} max={maxQty} value={qty}
                onChange={e => setQty(Math.max(1, Math.min(maxQty, Math.floor(Number(e.target.value)) || 1)))} sx={inputSx} />
              <Button onClick={() => setQty(maxQty)}>Макс {maxQty}</Button>
            </Box>
            {needsPrice && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Text sx={{ fontSize: 1 }}>Срок:</Text>
                {[1, 3, 7].map(d => (
                  <Button key={d} variant={days === d ? 'primary' : 'default'} onClick={() => setDays(d)}>{d} дн.</Button>
                ))}
              </Box>
            )}

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
                          <span style={{ color: 'var(--fg-muted)' }}>×{a.owned}</span>
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
      {policyModal && <PolicyCardModal variants={sellablePolicyVariants(policyModal, policyDefs)} onClose={() => setPolicyModal(null)} />}
    </Dialog>
  );
}

export function MarketDeals({ type }: { type: DealType }) {
  const ask = useAsk();
  useItemCatalog(); // перерисовать таблицу, когда подгрузятся названия предметов из каталога игры
  const [rows, setRows] = useState<MarketDealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh(`marketDealsRefresh:${type}`, () => load());
  const [account, setAccount] = useState('all');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>(
    { field: type === 'listings' ? 'created_at' : 'sold_at', dir: 'desc' }
  );
  const [sellOpen, setSellOpen] = useState(false);
  const [sellSpecialOpen, setSellSpecialOpen] = useState(false);
  // Выставили лот, пока открыт диалог → таблица устарела, но обновлять её ПРЯМО СЕЙЧАС нельзя:
  // refresh() перетряхивает все аккаунты (долго), а его завершение перерисовывает страницу и сбивает
  // открытый диалог — тот заново тянет свой долгий список продаваемого. Копим флаг, обновляем при закрытии.
  // Именно ref, а не state: setState здесь сам вызвал бы перерисовку родителя (то, чего избегаем).
  const pendingRefreshRef = useRef(false);
  const closeSell = (setOpen: (v: boolean) => void) => () => {
    setOpen(false);
    if (pendingRefreshRef.current) { pendingRefreshRef.current = false; refresh(); }
  };
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
    if (!await ask('Отменить все лоты?', `Будут сняты все лоты ${scope}: ${sorted.length} шт.`, { ok: 'Снять лоты', danger: true })) return;
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
    const known = r.item_category !== 'policy' ? knownItemName(r.item_id) : null;
    return (known ?? (r.item_category ? CAT[r.item_category] ?? r.item_category : '') ?? '').toString();
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
          { header: () => <></>, field: 'listing_id', align: 'end', renderCell: r => (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              {r.status === 'active' && r.listing_id != null && (
                <Button variant="danger" disabled={canceling.has(r.listing_id)} loading={canceling.has(r.listing_id)} onClick={() => cancelOne(r)}>
                  Отменить
                </Button>
              )}
            </Box>
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
      <PageHeader title={TITLE[type]} actions={<>
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
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить</Button>
        {type === 'listings' && <Button leadingVisual={PlusIcon} onClick={() => setSellSpecialOpen(true)}>Выставить политику/осколок</Button>}
        {type === 'listings' && <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setSellOpen(true)}>Выставить предмет</Button>}
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

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
      {sellOpen && <SellDialog mode="items" onClose={closeSell(setSellOpen)} onListed={() => { pendingRefreshRef.current = true; }} showFlash={showFlash} />}
      {sellSpecialOpen && <SellDialog mode="special" onClose={closeSell(setSellSpecialOpen)} onListed={() => { pendingRefreshRef.current = true; }} showFlash={showFlash} />}
    </Box>
  );
}

export function MarketListings() { return <MarketDeals type="listings" />; }
export function MarketPurchases() { return <MarketDeals type="purchases" />; }
export function MarketSales() { return <MarketDeals type="sales" />; }
