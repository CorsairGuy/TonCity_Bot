import { useState, useEffect } from 'react';
import { Box, Button, CounterLabel, Flash, Label, Spinner, Text, Select, Checkbox, TextInput, IconButton, ToggleSwitch, ActionMenu, ActionList, UnderlineNav } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { SyncIcon, ZapIcon, PlusIcon, PencilIcon, TrashIcon, TelescopeIcon } from '@primer/octicons-react';
import { api, type MarketOffer, type Account, type MarketAutobuyRule, type MarketSnipeRow, type PolicyDefEntry } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { CrystalValue } from '../components/Icons';
import { PolicyCardModal, RARITY_COLOR } from '../components/PolicyCardModal';
import { PolicyIcon } from '../components/PolicyIcon';
import { Scrollable } from '../components/Scrollable';
import { useItemCatalog, itemName, knownItemName } from '../hooks/useItemCatalog';
import { ItemThumb } from '../components/ItemThumb';
import { PageHeader } from '../components/PageHeader';
import { richHeader, RichBody, RichFooter, SectionLabel, EmptyState } from '../components/RichDialog';

// Карточка политики для лота маркета: показываем ИМЕННО тот вариант (def_id/редкость), что
// продаётся в этом лоте — не все варианты названия (в отличие от библиотеки). Берём точное
// совпадение по def_id из каталога (там полные данные, включая описание), иначе строим из
// policy-объекта лота.
function offerPolicyVariants(o: MarketOffer, catalog: PolicyDefEntry[]): PolicyDefEntry[] {
  const p = o.policy;
  if (!p) return [];
  // ищем по ПАРЕ def_id+редкость лота: у одной политики один def_id на несколько редкостей, и поиск
  // только по def_id открывал карточку чужого варианта (эпический лот → карточка обычной политики)
  const exact = catalog.find(d => d.def_id === p.def_id && d.rarity === o.item_rarity)
    ?? catalog.find(d => d.def_id === p.def_id && d.rarity === 'unknown');
  if (exact) return [{ ...exact, rarity: o.item_rarity }];
  return [{
    def_id: p.def_id, rarity: o.item_rarity, name: p.name ?? null, description: null,
    icon_key: p.icon_key ?? null, theme: p.theme ?? null, badge: null, badge_n: null,
    max_level: p.max_level ?? null, seen_account: 'рынок', updated_at: null,
    effects: (p.effects ?? []).map(e => ({
      stat: e.stat ?? '', scope_kind: e.scope_kind ?? 'global', targets: [],
      mode: (e.mode as 'mult' | 'add' | 'set') ?? 'mult', value: e.value ?? 0,
      kind: e.kind as 'boon' | 'bane' | undefined, next_value: e.next_value ?? null,
    })),
  }];
}

const RARITY: Record<string, { c: string; n: string }> = {
  common: { c: '#6e7681', n: 'Обычный' }, uncommon: { c: '#27AE60', n: 'Необычный' },
  rare: { c: '#2E86C1', n: 'Редкий' }, epic: { c: '#8E44AD', n: 'Эпический' },
  legendary: { c: '#D4AC0D', n: 'Легендарный' }, mythic: { c: '#C0392B', n: 'Мифический' },
  eternal: { c: '#C0392B', n: 'Вечный' },
};
const CAT: Record<string, string> = { booster: 'Ускоритель', pack: 'Набор', component: 'Компонент', masterplan: 'Мастерплан' };
// название предмета лота: таблица клиента / локализация игры из каталога бота; у политик имя своё
// (берётся из ответа рынка), поэтому для них каталог не спрашиваем — только категория.
function lotItemName(itemId: number | null | undefined, category: string | null): string {
  const known = category === 'policy' ? null : knownItemName(itemId);
  return known ?? (category ? CAT[category] : null) ?? itemName(itemId);
}
const LIMIT_PERIOD: Record<string, string> = { day: 'день', week: 'нед', month: 'мес', hour: 'ч', total: 'всего' };

// Предмет → серверные фильтры маркета (category + rarity). Пара уникальна = один предмет.
const ITEM_FILTERS: { id: number; category: string; rarity: string }[] = [
  { id: 3, category: 'booster', rarity: 'epic' },
  { id: 4, category: 'booster', rarity: 'legendary' },
  { id: 5, category: 'booster', rarity: 'mythic' },
  { id: 9, category: 'pack', rarity: 'epic' },
  { id: 10, category: 'pack', rarity: 'legendary' },
  { id: 11, category: 'pack', rarity: 'mythic' },
  { id: 15, category: 'pack', rarity: 'eternal' },
  { id: 12, category: 'masterplan', rarity: 'legendary' },
  { id: 13, category: 'component', rarity: 'epic' },
];
const PAGE_SIZE = 20;

// Полный фильтр как в игре (обновление рынка). Значения — РЕАЛЬНЫЕ query-параметры API, проверены
// 13.10.2026 живыми запросами к /market/offers с каждым кандидатом (см. историю правки): объект
// market.categories в бандле (entry.js) — это таблица ПЕРЕВОДОВ (i18n-ключи во множественном числе:
// policies/shards/consumables), а не значения фильтра — попытка взять значения оттуда была ошибкой
// (игра на незнакомое значение молча отдаёт вообще все офферы, что и выглядело как «не фильтрует»).
// Настоящий API принимает ТОЛЬКО единственное число: policy/shard/booster/pack/consumable — что и
// подтвердил прямой перебор (booster→106, pack→165, policy→80, shard→55, consumable→6 из 508; любая
// форма множественного числа возвращала все 508 без фильтрации).
// В игре "Материал" — это группа из трёх категорий разом (masterplan+component+consumable, см.
// chunks/market_utils-*.js, массив W: {key:Masterplan,categories:[Masterplan,Component,Consumable]}).
// В панели сделано ПО-ДРУГОМУ, осознанно: три отдельных пункта вместо одного общего — для бота
// точечный фильтр полезнее, чем повторение группировки игры.
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'booster', label: 'Ускоритель' }, { value: 'pack', label: 'Набор' },
  { value: 'policy', label: 'Политика' }, { value: 'shard', label: 'Осколок' },
  { value: 'component', label: 'Компонент' }, { value: 'masterplan', label: 'Мастерплан' },
  { value: 'consumable', label: 'Материал' },
];
const RARITIES: { value: string; label: string }[] = [
  { value: 'common', label: 'Обычный' }, { value: 'uncommon', label: 'Необычный' },
  { value: 'rare', label: 'Редкий' }, { value: 'epic', label: 'Эпический' },
  { value: 'legendary', label: 'Легендарный' }, { value: 'mythic', label: 'Мифический' },
  { value: 'eternal', label: 'Вечный' },
];
const MARKET_TYPES: { value: string; label: string }[] = [
  { value: 'direct', label: 'Прямой' }, { value: 'auction', label: 'Аукцион' },
  { value: 'negotiation', label: 'Предложения' },
];
const MT_LABEL: Record<string, string> = { direct: 'Прямой', auction: 'Аукцион', negotiation: 'Предложение' };

function timeLeft(iso?: string) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'истёк';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return h > 0 ? `${h}ч ${m}м` : `${m}м ${s}с`;
}
// формат времени: дни+часы → часы+минуты → минуты+секунды
function dh(iso?: string) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'истёк';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м ${s}с`;
}
function Price({ currency, value }: { currency: string; value: number }) {
  // валюта 'ton' в API теперь отображается как GRAM (в игре переименовали, значение прежнее)
  if (currency === 'ton') return <span className="mono" style={{ color: 'var(--green)' }}>{Number(value).toFixed(2)} GRAM</span>;
  return <span className="mono"><CrystalValue value={fmt(value)} /></span>;
}

function bal(a: Account, isTon: boolean, tonBal: Map<number, number | null> | null) {
  return isTon ? (tonBal?.get(a.id) ?? null) : (a.crystals ?? 0);
}

// ── покупка одного лота: выбор одного аккаунта ──────────────────────────────
function BuyDialog({ offer, accounts, onClose, showFlash, onBought }: {
  offer: MarketOffer; accounts: Account[]; onClose: () => void; showFlash: (m: string, ok: boolean) => void; onBought: () => void;
}) {
  const isTon = offer.listing_currency === 'ton';
  const price = offer.display_price;
  const isEscrow = !!offer.available_at && new Date(offer.available_at).getTime() > Date.now();
  const [tonBal, setTonBal] = useState<Map<number, number | null> | null>(isTon ? null : new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<{ name: string; ok: boolean; error?: string } | null>(null);

  useEffect(() => { if (isTon) api.marketTonBalances().then(d => { if (d.ok) setTonBal(new Map(d.balances.map(b => [b.id, b.ton]))); }); }, [isTon]);

  const eligible = accounts.filter(a => { const b = bal(a, isTon, tonBal); return b != null && b >= price; })
    .sort((a, b) => (bal(b, isTon, tonBal) as number) - (bal(a, isTon, tonBal) as number));
  const meta = ITEMS_BY_ID[offer.item_id];

  const buy = async (id: number, name: string) => {
    setBusy(id);
    try {
      if (isEscrow) {
        const d = await api.marketSnipe({ offer_id: offer.id, account_id: id, item_id: offer.item_id, currency: offer.listing_currency, price: offer.display_price, available_at: offer.available_at! });
        const ok = !!d.ok;
        setDone({ name, ok, error: d.error });
        showFlash(ok ? `[${name}] снайп запланирован` : `[${name}] ${d.error || 'ошибка'}`, ok);
        return;
      }
      const d = await api.marketBuy(offer.id, [id]);
      const r = d.results?.[0];
      const ok = !!r?.ok;
      setDone({ name, ok, error: r?.error });
      showFlash(ok ? `[${name}] куплено` : `[${name}] ${r?.error || 'ошибка'}`, ok);
      if (ok) onBought();
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  return (
    <Dialog
      title={isEscrow ? 'Автопокупка эскроу-лота' : 'Купить лот'}
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
    >
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          {meta && <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />}
          <Box>
            <Text sx={{ fontWeight: 'bold', display: 'block' }}>{lotItemName(offer.item_id, offer.item_category)}</Text>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
              <Label sx={{ bg: RARITY[offer.item_rarity]?.c ?? '#6e7681', color: 'white', borderColor: 'transparent', fontSize: 0 }}>{RARITY[offer.item_rarity]?.n ?? offer.item_rarity}</Label>
              <Price currency={offer.listing_currency} value={price} />
              {isEscrow && <Text sx={{ fontSize: 0, color: 'attention.fg' }}>откроется через {timeLeft(offer.available_at)}</Text>}
            </Box>
          </Box>
        </Box>

        {done
          ? <Flash variant={done.ok ? 'success' : 'danger'}>{done.ok ? (isEscrow ? `Снайп запланирован: ${done.name}` : `Куплено: ${done.name}`) : `${done.name}: ${done.error}`}</Flash>
          : tonBal == null
            ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
            : <>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>{isEscrow ? 'Аккаунт для снайпа' : 'Выберите аккаунт'} (хватает баланса: {eligible.length}):</Text>
                <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
                  <Scrollable style={{ maxHeight: '42vh' }}>
                    {eligible.length === 0 && <Box sx={{ p: 3, color: 'fg.muted', textAlign: 'center' }}>Нет аккаунтов с достаточным балансом</Box>}
                    {eligible.map(a => (
                      <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '6px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                        <Text sx={{ fontSize: 1, flex: 1 }}>{a.name}</Text>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--green)' }}>{isTon ? `▽ ${(bal(a, isTon, tonBal) as number).toFixed(2)}` : fmt(bal(a, isTon, tonBal) as number)}</span>
                        <Button variant="primary" loading={busy === a.id} disabled={busy != null} onClick={() => buy(a.id, a.name)}>{isEscrow ? 'Снайп' : 'Купить'}</Button>
                      </Box>
                    ))}
                  </Scrollable>
                </Box>
              </>
        }
      </Box>
    </Dialog>
  );
}

// ── общий диалог «указать сумму + выбрать аккаунт» для ставки (аукцион) и оффера (предложения) ──
function OfferActionDialog({ offer, accounts, title, actionLabel, defaultAmount, hint, submit, onClose, showFlash, onDone }: {
  offer: MarketOffer; accounts: Account[]; title: string; actionLabel: string; defaultAmount: number; hint?: string;
  submit: (accountId: number, amount: number, anon: boolean) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void; showFlash: (m: string, ok: boolean) => void; onDone: () => void;
}) {
  const isTon = offer.listing_currency === 'ton';
  const [amount, setAmount] = useState<string>(String(defaultAmount || ''));
  const [anon, setAnon] = useState(false);
  const [tonBal, setTonBal] = useState<Map<number, number | null> | null>(isTon ? null : new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<{ name: string; ok: boolean; error?: string } | null>(null);
  useEffect(() => { if (isTon) api.marketTonBalances().then(d => { if (d.ok) setTonBal(new Map(d.balances.map(b => [b.id, b.ton]))); }); }, [isTon]);
  const amt = Number(amount);
  const meta = ITEMS_BY_ID[offer.item_id];
  const eligible = accounts.filter(a => { const b = bal(a, isTon, tonBal); return b != null && b >= amt; })
    .sort((a, b) => (bal(b, isTon, tonBal) as number) - (bal(a, isTon, tonBal) as number));

  const act = async (id: number, name: string) => {
    setBusy(id);
    try {
      const d = await submit(id, amt, anon);
      const ok = !!d.ok; setDone({ name, ok, error: d.error });
      showFlash(ok ? `[${name}] ${actionLabel.toLowerCase()} — готово` : `[${name}] ${d.error || 'ошибка'}`, ok);
      if (ok) onDone();
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  return (
    <Dialog title={title} onClose={onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          {meta && <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />}
          <Box>
            <Text sx={{ fontWeight: 'bold', display: 'block' }}>{lotItemName(offer.item_id, offer.item_category)}</Text>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
              <Label sx={{ bg: RARITY[offer.item_rarity]?.c ?? '#6e7681', color: 'white', borderColor: 'transparent', fontSize: 0 }}>{RARITY[offer.item_rarity]?.n ?? offer.item_rarity}</Label>
              <Price currency={offer.listing_currency} value={offer.display_price} />
              {offer.market_type === 'auction' && offer.current_bid != null && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>тек. ставка <Price currency={offer.listing_currency} value={offer.current_bid} /></Text>}
            </Box>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
          <Text sx={{ fontSize: 1, minWidth: 90 }}>Сумма ({isTon ? 'GRAM' : '💎'}):</Text>
          <TextInput type="number" value={amount} onChange={e => setAmount(e.target.value)} sx={{ width: 140 }} />
        </Box>
        {hint && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>{hint}</Text>}
        <Box sx={{ mb: 2 }}><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}><Checkbox checked={anon} onChange={() => setAnon(v => !v)} /> Анонимно</label></Box>

        {done
          ? <Flash variant={done.ok ? 'success' : 'danger'}>{done.ok ? `${actionLabel}: ${done.name}` : `${done.name}: ${done.error}`}</Flash>
          : tonBal == null
            ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
            : <>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Аккаунт (хватает баланса на сумму: {eligible.length}):</Text>
                <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
                  <Scrollable style={{ maxHeight: '38vh' }}>
                    {eligible.length === 0 && <Box sx={{ p: 3, color: 'fg.muted', textAlign: 'center' }}>Нет аккаунтов с достаточным балансом</Box>}
                    {eligible.map(a => (
                      <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '6px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                        <Text sx={{ fontSize: 1, flex: 1 }}>{a.name}</Text>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--green)' }}>{isTon ? `${(bal(a, isTon, tonBal) as number).toFixed(2)} GRAM` : fmt(bal(a, isTon, tonBal) as number)}</span>
                        <Button variant="primary" loading={busy === a.id} disabled={busy != null || !(amt > 0)} onClick={() => act(a.id, a.name)}>{actionLabel}</Button>
                      </Box>
                    ))}
                  </Scrollable>
                </Box>
              </>
        }
      </Box>
    </Dialog>
  );
}

function BidDialog({ offer, accounts, onClose, showFlash, onDone }: {
  offer: MarketOffer; accounts: Account[]; onClose: () => void; showFlash: (m: string, ok: boolean) => void; onDone: () => void;
}) {
  return <OfferActionDialog
    offer={offer} accounts={accounts} title="Ставка на аукционе" actionLabel="Ставка"
    defaultAmount={offer.min_next_bid ?? offer.current_bid ?? offer.display_price}
    hint={offer.min_next_bid != null ? `минимальная следующая ставка: ${offer.min_next_bid}` : undefined}
    submit={(account_id, amount, anonymous) => api.marketAuctionBid({ account_id, auction_id: offer.id, amount, anonymous })}
    onClose={onClose} showFlash={showFlash} onDone={onDone} />;
}

function NegotiationDialog({ offer, accounts, onClose, showFlash, onDone }: {
  offer: MarketOffer; accounts: Account[]; onClose: () => void; showFlash: (m: string, ok: boolean) => void; onDone: () => void;
}) {
  return <OfferActionDialog
    offer={offer} accounts={accounts} title="Предложение продавцу" actionLabel="Оффер"
    defaultAmount={offer.display_price}
    hint="ваша цена предложения продавцу — он может принять или отклонить"
    submit={(account_id, amount, anonymous) => api.marketNegotiationOffer({ account_id, listing_id: offer.id, amount, currency: offer.listing_currency, anonymous })}
    onClose={onClose} showFlash={showFlash} onDone={onDone} />;
}

// ── управление правилами автопокупки ────────────────────────────────────────
const emptyForm = () => ({ itemId: '', currency: 'crystals', maxPrice: '', maxBudget: '', includeEscrow: true, enabled: false, accounts: new Set<number>() });

function AutoBuyManager({ accounts, onClose, showFlash }: {
  accounts: Account[]; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  const [rules, setRules] = useState<MarketAutobuyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const load = async () => { setLoading(true); try { const d = await api.marketAutobuyList(); if (d.ok) { setRules(d.rules); if (!d.rules.length) setFormOpen(true); } } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const resetForm = () => { setEditId(null); setForm(emptyForm()); setFormOpen(false); };
  const openNew = () => { setEditId(null); setForm(emptyForm()); setFormOpen(true); };
  const startEdit = (r: MarketAutobuyRule) => {
    setEditId(r.id); setFormOpen(true);
    setForm({ itemId: String(r.item_id ?? ''), currency: r.currency, maxPrice: String(r.max_price ?? ''), maxBudget: r.max_budget != null ? String(r.max_budget) : '', includeEscrow: r.include_escrow, enabled: r.enabled, accounts: new Set(r.account_ids) });
  };

  const save = async () => {
    const f = ITEM_FILTERS.find(x => String(x.id) === form.itemId);
    if (!f) { showFlash('Выберите предмет', false); return; }
    if (!form.maxPrice) { showFlash('Укажите цену лота до', false); return; }
    if (form.accounts.size === 0) { showFlash('Выберите аккаунты', false); return; }
    const payload = {
      item_id: f.id, categories: f.category, rarities: f.rarity, currency: form.currency,
      max_price: Number(form.maxPrice), max_budget: form.maxBudget ? Number(form.maxBudget) : null,
      include_escrow: form.includeEscrow, enabled: form.enabled, account_ids: [...form.accounts],
    };
    setSaving(true);
    try {
      if (editId) await api.marketAutobuyUpdate(editId, payload); else await api.marketAutobuyCreate(payload);
      showFlash('Сохранено', true); resetForm(); load();
    } finally { setSaving(false); }
  };
  const toggle = async (r: MarketAutobuyRule) => {
    setRules(rs => rs.map(x => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    await api.marketAutobuyUpdate(r.id, { enabled: !r.enabled }); load();
  };
  const del = async (r: MarketAutobuyRule) => { await api.marketAutobuyDelete(r.id); if (editId === r.id) resetForm(); load(); };

  const toggleAcc = (id: number) => setForm(f => { const n = new Set(f.accounts); if (n.has(id)) n.delete(id); else n.add(id); return { ...f, accounts: n }; });
  const allAcc = form.accounts.size === accounts.length;
  const curIcon = (c: string) => c === 'ton' ? '▽' : '💎';
  const active = rules.filter(r => r.enabled).length;

  return (
    <Dialog
      title="Автопокупки"
      subtitle="Бот сам купит лот, когда цена опустится до порога"
      renderHeader={richHeader(ZapIcon)}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      renderFooter={() => (
        <RichFooter summary={rules.length ? <>Активно <b>{active}</b> из <b>{rules.length}</b></> : null}>
          <Button onClick={onClose}>Закрыть</Button>
          <Button variant="primary" leadingVisual={PlusIcon} disabled={formOpen && !editId} onClick={openNew}>Новое правило</Button>
        </RichFooter>
      )}
    >
      <RichBody>
        {loading && !rules.length ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : rules.length === 0 && !formOpen ? <EmptyState icon={ZapIcon} title="Правил пока нет">Добавьте правило: предмет, цену и аккаунты, на которых покупать.</EmptyState>
          : rules.map(r => {
            const meta = r.item_id != null ? ITEMS_BY_ID[r.item_id] : null;
            const name = (r.item_id != null ? knownItemName(r.item_id) : null) ?? r.categories;
            return (
              <div key={r.id} className={`rdlg-card editable${r.enabled ? '' : ' off'}`} onClick={() => startEdit(r)}>
                {meta ? <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 36, height: 36, objectFit: 'contain', flexShrink: 0 }} />
                  : r.item_id != null ? <ItemThumb itemId={r.item_id} size={36} /> : <ZapIcon size={24} />}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <span className="rdlg-card__name">{name}</span>
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    до <b><Price currency={r.currency} value={r.max_price} /></b> · бюджет {r.max_budget != null ? <>{fmt(r.spent)}/{fmt(r.max_budget)}</> : '∞'} · {r.account_ids.length} акк.{r.include_escrow ? ' · эскроу' : ''}
                  </Text>
                </Box>
                <IconButton className="hide-narrow" icon={PencilIcon} aria-label="Изменить" variant="invisible" size="small" onClick={e => { e.stopPropagation(); startEdit(r); }} />
                <IconButton icon={TrashIcon} aria-label="Удалить" variant="invisible" size="small" sx={{ color: 'danger.fg' }} onClick={e => { e.stopPropagation(); del(r); }} />
                <Box onClick={e => e.stopPropagation()}>
                  <ToggleSwitch size="small" checked={r.enabled} onClick={() => toggle(r)} aria-label={`Включить: ${name}`} statusLabelPosition="end" />
                </Box>
              </div>
            );
          })}

        {formOpen && (
          <div className="rdlg-form">
            <SectionLabel>{editId ? 'Изменить правило' : 'Новое правило'}</SectionLabel>
            <Box sx={{ display: 'grid', gridTemplateColumns: ['1fr 1fr', '1fr 1fr', '2fr 1fr 1fr 1fr'], gap: 2 }}>
              <Box sx={{ gridColumn: ['1 / -1', '1 / -1', 'auto'] }}>
                <Select block value={form.itemId} onChange={e => setForm(f => ({ ...f, itemId: e.target.value }))}>
                  <Select.Option value="">Предмет…</Select.Option>
                  {ITEM_FILTERS.map(f => <Select.Option key={f.id} value={String(f.id)}>{ITEMS_BY_ID[f.id]?.name ?? `#${f.id}`}</Select.Option>)}
                </Select>
              </Box>
              <Box sx={{ gridColumn: ['1 / -1', '1 / -1', 'auto'] }}>
                <Select block value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                  <Select.Option value="crystals">💎 Кристаллы</Select.Option>
                  <Select.Option value="ton">▽ TON</Select.Option>
                </Select>
              </Box>
              <TextInput block type="number" placeholder="Цена до" value={form.maxPrice} trailingVisual={curIcon(form.currency)}
                onChange={e => setForm(f => ({ ...f, maxPrice: e.target.value }))} />
              <TextInput block type="number" placeholder="Бюджет" value={form.maxBudget} trailingVisual={curIcon(form.currency)}
                onChange={e => setForm(f => ({ ...f, maxBudget: e.target.value }))} />
            </Box>
            <Box sx={{ display: 'flex', gap: 3, mt: 2, alignItems: 'center', flexWrap: 'wrap', fontSize: 1 }}>
              <ActionMenu>
                <ActionMenu.Button size="small">Аккаунты: {allAcc ? `все ${accounts.length}` : form.accounts.size}</ActionMenu.Button>
                <ActionMenu.Overlay width="medium" maxHeight="large" sx={{ overflow: 'auto' }}>
                  <ActionList selectionVariant="multiple" showDividers={false}>
                    <ActionList.Item selected={allAcc} onSelect={() => setForm(f => ({ ...f, accounts: allAcc ? new Set() : new Set(accounts.map(a => a.id)) }))}>
                      Все аккаунты
                    </ActionList.Item>
                    <ActionList.Divider />
                    {accounts.map(a => (
                      <ActionList.Item key={a.id} selected={form.accounts.has(a.id)} onSelect={() => toggleAcc(a.id)}>{a.name}</ActionList.Item>
                    ))}
                  </ActionList>
                </ActionMenu.Overlay>
              </ActionMenu>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Checkbox checked={form.includeEscrow} onChange={e => setForm(f => ({ ...f, includeEscrow: e.target.checked }))} /> Скупать эскроу
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Checkbox checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} /> Включить сразу
              </label>
              <Box sx={{ display: 'flex', gap: 2, ml: 'auto' }}>
                {(rules.length > 0 || editId) && <Button size="small" onClick={resetForm}>Отмена</Button>}
                <Button size="small" variant="primary" loading={saving} onClick={save}>Сохранить</Button>
              </Box>
            </Box>
          </div>
        )}
      </RichBody>
    </Dialog>
  );
}

// ── модалка снайпов (только просмотр) ───────────────────────────────────────
// Снайп создаётся из лота эскроу (кнопка «Купить» у лота, который ещё не открыт) — отдельной
// формы нет, поэтому кнопка в подвале просто возвращает к списку офферов.
function SnipeManager({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const [snipes, setSnipes] = useState<MarketSnipeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => { setLoading(true); try { const d = await api.marketSnipeList(); if (d.ok) setSnipes(d.snipes); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const del = async (id: number) => { await api.marketSnipeDelete(id); load(); };

  const accName = (id: number) => accounts.find(a => a.id === id)?.name ?? `#${id}`;
  const sorted = [...snipes].sort((a, b) => {
    const oa = a.status === 'pending' ? 0 : 1, ob = b.status === 'pending' ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const ta = new Date(a.available_at || 0).getTime(), tb = new Date(b.available_at || 0).getTime();
    return a.status === 'pending' ? ta - tb : tb - ta;
  });
  const pending = snipes.filter(s => s.status === 'pending').length;

  return (
    <Dialog
      title="Снайпы"
      subtitle="Покупка лота эскроу в первую секунду, когда он откроется"
      renderHeader={richHeader(TelescopeIcon)}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      renderFooter={() => (
        <RichFooter summary={snipes.length ? <>Ждут <b>{pending}</b> · всего <b>{snipes.length}</b></> : null}>
          <Button variant="primary" leadingVisual={PlusIcon} onClick={onClose}>Выбрать лот</Button>
        </RichFooter>
      )}
    >
      <RichBody>
        {loading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : sorted.length === 0 ? (
            <EmptyState icon={TelescopeIcon} title="Снайпов пока нет">
              Снайп ставится на лот эскроу, который ещё не открылся: нажмите «Купить» у такого лота в списке офферов, и бот купит его сразу после открытия.
            </EmptyState>
          )
          : sorted.map(s => {
            const meta = s.item_id != null ? ITEMS_BY_ID[s.item_id] : null;
            return (
              <div key={s.id} className={`rdlg-card${s.status === 'pending' ? '' : ' off'}`}>
                {meta && <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 36, height: 36, objectFit: 'contain', flexShrink: 0 }} />}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Text sx={{ fontWeight: 600, fontSize: 1, display: 'block' }}>{lotItemName(s.item_id, null)}</Text>
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    {accName(s.account_id)} · {s.price != null && s.currency ? <Price currency={s.currency} value={s.price} /> : '—'}
                    {s.status === 'pending' && <> · через {timeLeft(s.available_at || undefined)}</>}
                  </Text>
                </Box>
                {s.status === 'pending' ? <Label variant="accent">Ждёт</Label>
                  : s.status === 'done' ? <Label variant="success">Куплено</Label>
                  : <Label variant="danger" title={s.error || ''}>Ошибка</Label>}
                {s.status === 'pending' && <IconButton icon={TrashIcon} aria-label="Удалить снайп" variant="invisible" size="small" sx={{ color: 'danger.fg' }} onClick={() => del(s.id)} />}
              </div>
            );
          })}
      </RichBody>
    </Dialog>
  );
}

export function MarketLots() {
  const catalog = useItemCatalog();
  const [offers, setOffers] = useState<MarketOffer[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState('all');
  const [sort, setSort] = useState('price_asc');
  const [item, setItem] = useState('all');       // быстрый выбор конкретного предмета (гибрид)
  const [marketType, setMarketType] = useState('all'); // тип рынка: all/direct/auction/negotiation
  const [category, setCategory] = useState('all');     // полный фильтр: категория
  const [rarity, setRarity] = useState('all');         // полный фильтр: редкость
  const [page, setPage] = useState(1);
  const [buyOffer, setBuyOffer] = useState<MarketOffer | null>(null);
  const [bidOffer, setBidOffer] = useState<MarketOffer | null>(null);   // ставка на аукцион
  const [negOffer, setNegOffer] = useState<MarketOffer | null>(null);   // оффер в предложениях
  const [policyModal, setPolicyModal] = useState<MarketOffer | null>(null); // карточка политики
  const [policyDefs, setPolicyDefs] = useState<PolicyDefEntry[]>([]);   // каталог для вариантов
  const [autoBuy, setAutoBuy] = useState(false);
  const [snipesOpen, setSnipesOpen] = useState(false);
  // счётчики на кнопках «Автопокупки»/«Снайпы» — сколько правил включено и сколько снайпов ждёт
  const [autoBuyCount, setAutoBuyCount] = useState(0);
  const [snipeCount, setSnipeCount] = useState(0);
  const loadCounters = () => {
    api.marketAutobuyList().then(d => { if (d.ok) setAutoBuyCount(d.rules.filter(r => r.enabled).length); }).catch(() => {});
    api.marketSnipeList().then(d => { if (d.ok) setSnipeCount(d.snipes.filter(x => x.status === 'pending').length); }).catch(() => {});
  };
  useEffect(() => { loadCounters(); }, []);
  const { flash, showFlash } = useFlash();

  // гибрид: если выбран конкретный предмет — категория+редкость берутся из него (фильтр редкости
  // прячется); иначе действует полный фильтр «категория/редкость» как в игре
  const pickedItem = item === 'all' ? null : ITEM_FILTERS.find(x => String(x.id) === item);
  const effCategory = pickedItem ? pickedItem.category : (category === 'all' ? undefined : category);
  const effRarity = pickedItem ? pickedItem.rarity : (rarity === 'all' ? undefined : rarity);

  const load = async (toPage = page) => {
    setLoading(true);
    try {
      const [o, a] = await Promise.all([
        api.marketOffers({
          categories: effCategory, rarities: effRarity,
          currencies: currency === 'all' ? undefined : currency,
          market_types: marketType === 'all' ? undefined : marketType,
          sort, page: toPage, page_size: PAGE_SIZE,
        }),
        accounts.length ? Promise.resolve({ ok: true, accounts }) : api.accounts(),
      ]);
      if (o.ok) { setOffers(o.offers); setTotal(o.pagination?.total ?? o.offers.length); }
      if (a.ok) setAccounts(a.accounts);
    } finally { setLoading(false); }
  };

  // смена фильтров → на первую страницу
  useEffect(() => { setPage(1); load(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [currency, sort, item, marketType, category, rarity]);
  // каталог политик для карточки при клике (варианты одного названия) — грузим один раз
  useEffect(() => { api.policyDefs().then(d => { if (d.ok) setPolicyDefs(d.defs); }).catch(() => {}); }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goPage = (p: number) => { const np = Math.min(Math.max(1, p), totalPages); setPage(np); load(np); };

  if (loading && !offers.length) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader
        title="Офферы"
        sub={`${total} лотов · витрина с рандомного аккаунта`}
        actions={<>
          <Button leadingVisual={ZapIcon} onClick={() => setAutoBuy(true)}>
            Автопокупки{autoBuyCount > 0 && <CounterLabel sx={{ ml: 1 }}>{autoBuyCount}</CounterLabel>}
          </Button>
          <Button onClick={() => setSnipesOpen(true)}>
            Снайпы{snipeCount > 0 && <CounterLabel sx={{ ml: 1 }}>{snipeCount}</CounterLabel>}
          </Button>
          <Button leadingVisual={SyncIcon} loading={loading} onClick={() => load()}>Обновить</Button>
        </>}
      />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {/* категории — табы как на страницах логов и аудиториума (на узком экране лишние уходят в «Ещё») */}
      <UnderlineNav aria-label="Категория" sx={{ mb: 3 }}>
        {[{ value: 'all', label: 'Все' }, ...CATEGORIES].map(c => (
          <UnderlineNav.Item key={c.value} href="#"
            aria-current={(c.value === 'all' ? !pickedItem && category === 'all' : (pickedItem ? pickedItem.category : category) === c.value) ? 'page' : undefined}
            onSelect={e => { e.preventDefault(); setItem('all'); setCategory(c.value); }}>
            {c.label}
          </UnderlineNav.Item>
        ))}
      </UnderlineNav>

      {/* уточняющие списки */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center', flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', gap: 2, ml: 'auto', flexWrap: 'wrap' }}>
          <Select size="small" value={item} onChange={e => setItem(e.target.value)}>
            <Select.Option value="all">Все предметы</Select.Option>
            {ITEM_FILTERS.map(f => <Select.Option key={f.id} value={String(f.id)}>{ITEMS_BY_ID[f.id]?.name ?? `#${f.id}`}</Select.Option>)}
          </Select>
          {/* редкость — только когда НЕ выбран конкретный предмет (у предмета она своя) */}
          {!pickedItem && (
            <Select size="small" value={rarity} onChange={e => setRarity(e.target.value)}>
              <Select.Option value="all">Любая редкость</Select.Option>
              {RARITIES.map(r => <Select.Option key={r.value} value={r.value}>{r.label}</Select.Option>)}
            </Select>
          )}
          <Select size="small" value={currency} onChange={e => setCurrency(e.target.value)}>
            <Select.Option value="all">Все валюты</Select.Option>
            <Select.Option value="crystals">💎 Кристаллы</Select.Option>
            <Select.Option value="ton">GRAM</Select.Option>
          </Select>
          <Select size="small" value={marketType} onChange={e => setMarketType(e.target.value)}>
            <Select.Option value="all">Все типы</Select.Option>
            {MARKET_TYPES.map(t => <Select.Option key={t.value} value={t.value}>{t.label}</Select.Option>)}
          </Select>
          <Select size="small" value={sort} onChange={e => setSort(e.target.value)}>
            <Select.Option value="ends_at">Скоро закончатся</Select.Option>
            <Select.Option value="price_asc">Сначала дешевле</Select.Option>
            <Select.Option value="price_desc">Сначала дороже</Select.Option>
          </Select>
        </Box>
      </Box>

      <Table.Container>
        <DataTable
          data={offers}
          columns={[
            {
              header: 'Предмет', field: 'item_id', rowHeader: true,
              renderCell: o => {
                const meta = ITEMS_BY_ID[o.item_id];
                const pol = o.policy;
                // имя: метаданные → имя политики из маркета → «Осколок/Категория» → #id
                const name = meta?.name || pol?.name?.ru || pol?.name?.en
                  || (o.item_category === 'shard' ? `Осколок${o.item_rarity ? ' · ' + (RARITY[o.item_rarity]?.n ?? o.item_rarity) : ''}`
                      : lotItemName(o.item_id, o.item_category));
                // краткая расшифровка эффектов политики — в подсказке при наведении
                const effTitle = pol?.effects?.length
                  ? pol.effects.map(e => `${(e.value ?? 0) >= 0 ? '+' : ''}${Math.round((e.value ?? 0) * 100)}% ${e.stat}`).join(', ')
                  : undefined;
                // политику можно открыть карточкой (как в библиотеке)
                const clickable = !!pol;
                // иконка политики из игры (mdi-*) на фоне цвета редкости — как в библиотеке
                const polIcon = pol ? (pol.icon_key || 'mdi-script-text').replace(/^mdi-/, '') : null;
                return (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, cursor: clickable ? 'pointer' : undefined }} title={clickable ? 'Открыть карточку политики' : effTitle}
                    onClick={clickable ? () => setPolicyModal(o) : undefined}>
                    {!meta && polIcon
                      ? <PolicyIcon rarity={o.item_rarity || 'common'} iconKey={pol?.icon_key} size={30} iconSize={19} radius={6} style={{ flexShrink: 0 }} />
                      : <Box sx={{ width: 30, height: 30, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bg: 'canvas.subtle' }}>
                      {meta
                        ? <img src={itemImgSrc(meta.tag)} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }}
                            onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
                        : o.item_category === 'shard' ? <span style={{ fontSize: 14 }}>🔷</span>
                          : <ItemThumb itemId={o.item_id} item={catalog.get(o.item_id)} size={24} style={{ fontSize: 8, padding: 0 }} />}
                    </Box>}
                    <Text sx={{ fontSize: 1, whiteSpace: 'nowrap', minWidth: 0 }}>{name}</Text>
                    {o.market_type && o.market_type !== 'direct' && (
                      <Label variant={o.market_type === 'auction' ? 'attention' : 'accent'} sx={{ fontSize: 0 }}>{MT_LABEL[o.market_type] ?? o.market_type}</Label>
                    )}
                  </Box>
                );
              },
            },
            {
              header: 'Продавец', field: 'seller_name',
              renderCell: o => {
                const mine = o.mine_account != null;
                if (mine) return (
                  <Label variant="accent">★ Мой{o.mine_account ? ` · ${o.mine_account}` : ''}</Label>
                );
                return <Text sx={{ fontSize: 1 }}>{o.seller_name === 'Anonymous' ? 'Аноним' : (o.seller_name || '—')}</Text>;
              },
            },
            {
              header: 'Редкость', field: 'item_rarity',
              renderCell: o => {
                const r = RARITY[o.item_rarity];
                return r ? <Text sx={{ fontSize: 1, color: r.c, whiteSpace: 'nowrap' }}>{r.n}</Text> : <Text sx={{ fontSize: 1, color: 'fg.muted' }}>—</Text>;
              },
            },
            {
              header: 'Цена', field: 'display_price',
              renderCell: o => (
                <Box>
                  <Price currency={o.listing_currency} value={o.display_price} />
                  {o.purchase_limit != null && (
                    <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>лимит {o.purchase_limit}{o.purchase_limit_type ? `/${LIMIT_PERIOD[o.purchase_limit_type] ?? o.purchase_limit_type}` : ''}</Text>
                  )}
                  {o.market_type === 'auction' && o.current_bid != null && (
                    <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>ставка: <Price currency={o.listing_currency} value={o.current_bid} /></Text>
                  )}
                </Box>
              ),
            },
            {
              header: 'Статус', field: 'status',
              renderCell: o => {
                const sold = o.status === 'sold' || !!o.sold_at;
                const escrow = !sold && !!o.available_at && new Date(o.available_at).getTime() > Date.now();
                if (sold) return <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Продано</Text>;
                return (
                  <Text sx={{ fontSize: 0, color: escrow ? 'attention.fg' : 'fg.muted', whiteSpace: 'nowrap' }}>
                    {escrow ? 'Откроется через ' : 'Конец через '}<span className="mono">{dh(escrow ? o.available_at : o.ends_at)}</span>
                  </Text>
                );
              },
            },
            {
              header: () => <></>, field: 'id', align: 'end',
              renderCell: o => {
                const sold = o.status === 'sold' || !!o.sold_at;
                const mine = o.mine_account != null;
                const escrow = !sold && !!o.available_at && new Date(o.available_at).getTime() > Date.now();
                const mt = o.market_type ?? 'direct';
                // Аукционы: своим тоже можно ставить ставки (боты набивают друг другу цену) — блок "Свой" их не касается
                const btn = (mine && mt !== 'auction') ? <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Свой лот</Text>
                  : sold ? <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Продано</Text>
                  : mt === 'auction' ? <Button variant="primary" onClick={() => setBidOffer(o)}>Ставка</Button>
                  : mt === 'negotiation' ? <Button variant="primary" onClick={() => setNegOffer(o)}>Оффер</Button>
                  : <Button variant="primary" onClick={() => setBuyOffer(o)}>{escrow ? 'Снайп' : 'Купить'}</Button>;
                return <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>{btn}</Box>;
              },
            },
          ]}
        />
      </Table.Container>

      {totalPages > 1 && (
        <Box sx={{ display: 'flex', gap: 2, mt: 3, alignItems: 'center', justifyContent: 'center' }}>
          <Button disabled={page <= 1 || loading} onClick={() => goPage(page - 1)}>← Назад</Button>
          <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Стр. {page} из {totalPages}</Text>
          <Button disabled={page >= totalPages || loading} onClick={() => goPage(page + 1)}>Вперёд →</Button>
        </Box>
      )}

      {buyOffer && <BuyDialog offer={buyOffer} accounts={accounts} onClose={() => setBuyOffer(null)} showFlash={showFlash} onBought={() => load()} />}
      {bidOffer && <BidDialog offer={bidOffer} accounts={accounts} onClose={() => setBidOffer(null)} showFlash={showFlash} onDone={() => load()} />}
      {negOffer && <NegotiationDialog offer={negOffer} accounts={accounts} onClose={() => setNegOffer(null)} showFlash={showFlash} onDone={() => load()} />}
      {policyModal && <PolicyCardModal variants={offerPolicyVariants(policyModal, policyDefs)} onClose={() => setPolicyModal(null)} />}
      {autoBuy && <AutoBuyManager accounts={accounts} onClose={() => { setAutoBuy(false); loadCounters(); }} showFlash={showFlash} />}
      {snipesOpen && <SnipeManager accounts={accounts} onClose={() => { setSnipesOpen(false); loadCounters(); }} />}
    </Box>
  );
}
