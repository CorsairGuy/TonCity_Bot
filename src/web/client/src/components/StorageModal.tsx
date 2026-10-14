import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Box, Button, Flash, Label, Spinner, TabNav, Text,
} from '@primer/react';
import {
  ZapIcon, ArrowUpIcon, ArrowDownIcon, PackageIcon, StarFillIcon, SyncIcon,
} from '@primer/octicons-react';
import {
  api,
  type StorageItemFull,
  type BoosterPackMeta,
  type CombinationRule,
} from '../api';
import { ITEMS_BY_ID, fmt, itemImgSrc } from '../utils';
import { CoinValue, CrystalValue } from './Icons';
import { Dialog } from '@primer/react/experimental';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { ItemThumb } from './ItemThumb';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RARITY_COLOR: Record<string, string> = {
  common:    '#6e7681',
  uncommon:  '#27AE60',
  rare:      '#2E86C1',
  epic:      '#8E44AD',
  legendary: '#D4AC0D',
  mythic:    '#C0392B',
};

export const RARITY_NAME: Record<string, string> = {
  common:    'Обычный',
  uncommon:  'Необычный',
  rare:      'Редкий',
  epic:      'Эпический',
  legendary: 'Легендарный',
  mythic:    'Мифический',
};

function fmtDuration(ns: number): string {
  const h = Math.round(ns / 3_600_000_000_000);
  if (h >= 24) return `${Math.round(h / 24)}д`;
  return `${h}ч`;
}

export function RarityBadge({ rarity }: { rarity: string }) {
  return (
    <Label sx={{ bg: RARITY_COLOR[rarity] ?? '#6e7681', color: 'white', borderColor: 'transparent', fontSize: 0 }}>
      {RARITY_NAME[rarity] ?? rarity}
    </Label>
  );
}

function AmountInput({ value, onChange, min = 1, max }: { value: number; onChange: (v: number) => void; min?: number; max: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</Button>
      <Box sx={{ width: 52, textAlign: 'center', fontFamily: 'mono', fontSize: 1, fontWeight: 'bold' }}>{value}</Box>
      <Button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</Button>
      <Button onClick={() => onChange(max)} disabled={value === max}>Макс</Button>
    </Box>
  );
}

export function RewardRow({ rw, i, total, children, right }: {
  rw: { reward_id: number; reward_type: string; probability: number; rarity: { booster_rarity: string; valid: boolean } | null; crystals_amount: number | null };
  i: number; total: number; children?: React.ReactNode;
  // чем заменить правую колонку: на вкладке «Цель» полезен не шанс, а сколько паков
  // осталось открыть до гарантированного выпадения
  right?: React.ReactNode;
}) {
  const rarity = rw.rarity?.valid ? rw.rarity.booster_rarity : null;
  const meta = ITEMS_BY_ID[rw.reward_id] ?? null;
  const catalog = useItemCatalog();
  const isCrystals = rw.reward_type === 'crystals';
  return (
    <Box sx={{ px: 2, py: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: i < total - 1 ? '1px solid' : 'none', borderColor: 'border.muted' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flex: 1 }}>
        {isCrystals ? (
          <>
            <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>💎</span>
            <Text sx={{ fontSize: 1 }}>{rw.crystals_amount} кристаллов</Text>
          </>
        ) : meta ? (
          <>
            <Box sx={{ width: 28, height: 28, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src={itemImgSrc(meta.tag)} alt={meta.name} style={{ width: 22, height: 22, objectFit: 'contain' }}
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
            </Box>
            <Text sx={{ fontSize: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.name}</Text>
          </>
        ) : (
          <>
            <Box sx={{ width: 28, height: 28, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ItemThumb itemId={rw.reward_id} item={catalog.get(rw.reward_id)} size={22} style={{ fontSize: 8, padding: 0 }} />
            </Box>
            <Text sx={{ fontSize: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{itemName(rw.reward_id, catalog)}</Text>
          </>
        )}
        {children}
      </Box>
      {right ?? <Text sx={{ fontSize: 0, fontFamily: 'mono', color: 'fg.muted', flexShrink: 0, ml: 2 }}>{(rw.probability * 100).toFixed(1)}%</Text>}
    </Box>
  );
}

// Сколько паков нужно открыть до гарантированного выпадения этой цели. null — у набора нет
// гарантии по этому предмету (в guaranteed_drops он не перечислен).
function attemptsFor(meta: BoosterPackMeta | null, itemId: number | undefined): number | null {
  if (itemId == null) return null;
  const g = (meta?.guaranteed_drops ?? []).find(x => x.target_item_id === itemId);
  return g ? g.attempts_required : null;
}

// Правая колонка вкладки «Цель»: сколько паков открыть до гарантии
export function PacksToGuarantee({ n }: { n: number | null }) {
  if (n == null) return <Text sx={{ fontSize: 0, color: 'fg.subtle', flexShrink: 0, ml: 2 }}>без гарантии</Text>;
  return (
    <Text sx={{ fontSize: 0, fontFamily: 'mono', color: 'fg.muted', flexShrink: 0, ml: 2, whiteSpace: 'nowrap' }}>
      {n} {n % 10 === 1 && n % 100 !== 11 ? 'пак' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'пака' : 'паков'}
    </Text>
  );
}

// ── Booster Modal ─────────────────────────────────────────────────────────────

function BoosterModal({
  item, accountId, rules, onDone, onFooter,
}: {
  item: StorageItemFull;
  accountId: number;
  rules: CombinationRule[];
  onDone: () => void;
  onFooter: (node: React.ReactNode) => void;
}) {
  const [tab, setTab] = useState<'activate' | 'combine' | 'sell'>('activate');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sellAmount, setSellAmount] = useState(1);

  const b = item.booster!;
  const canActivate = b.currently_active < b.active_limit;
  const rule = rules.find(r => r.from_rarity === b.rarity) ?? null;
  const maxUpgrades = rule ? Math.floor(item.quantity / rule.required_amount) : 0;
  const [combineCount, setCombineCount] = useState(Math.max(1, maxUpgrades));

  const isCrystals = item.sell_currency === 'crystals';
  const sellTotal = item.sell_price * sellAmount;

  const activate = useCallback(async () => {
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageActivate(accountId, item.id);
      if (r.ok) { setFlash({ ok: true, msg: 'Бустер активирован!' }); onDone(); }
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка активации' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, onDone]);

  const combine = useCallback(async () => {
    if (!rule || combineCount === 0) return;
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageCombine(accountId, item.id, combineCount * rule.required_amount);
      if (r.ok) { setFlash({ ok: true, msg: `Объединено → ${combineCount} × ${RARITY_NAME[rule.to_rarity] ?? rule.to_rarity}` }); onDone(); }
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка объединения' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, rule, combineCount, onDone]);

  const sell = useCallback(async () => {
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageSell(accountId, item.id, sellAmount);
      if (r.ok) { setFlash({ ok: true, msg: `Продано ${sellAmount} шт.` }); onDone(); }
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка продажи' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, sellAmount, onDone]);

  useEffect(() => {
    if (tab === 'activate') {
      onFooter(
        <Button variant="primary" leadingVisual={ZapIcon} loading={busy} disabled={busy || !canActivate} onClick={activate}>
          {canActivate ? 'Активировать' : `Слоты заняты (${b.active_limit}/${b.active_limit})`}
        </Button>
      );
    } else if (tab === 'combine') {
      onFooter(
        <Button variant="primary" leadingVisual={ArrowUpIcon} loading={busy} disabled={busy || maxUpgrades === 0} onClick={combine}>
          Объединить {combineCount} раз
        </Button>
      );
    } else {
      onFooter(
        <Button variant="danger" leadingVisual={ArrowDownIcon} loading={busy} disabled={busy} onClick={sell}>
          Продать {sellAmount} шт.
        </Button>
      );
    }
    return () => onFooter(null);
  }, [tab, busy, canActivate, combineCount, sellAmount, maxUpgrades, activate, combine, sell, onFooter, b.active_limit]);

  return (
    <>
      <TabNav aria-label="Действие" sx={{ mb: 3 }}>
        <TabNav.Link as="button" selected={tab === 'activate'} onClick={() => { setTab('activate'); setFlash(null); }}>Активировать</TabNav.Link>
        {rule && <TabNav.Link as="button" selected={tab === 'combine'} onClick={() => { setTab('combine'); setFlash(null); }}>Объединить</TabNav.Link>}
        <TabNav.Link as="button" selected={tab === 'sell'} onClick={() => { setTab('sell'); setFlash(null); }}>Продать</TabNav.Link>
      </TabNav>

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {tab === 'activate' && (
        <Box sx={{ display: 'flex', gap: 3 }}>
          <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Активно</Text>
            <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>{b.currently_active} / {b.active_limit}</Text>
          </Box>
          <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Множитель</Text>
            <Text sx={{ fontWeight: 'bold', fontSize: 2, color: 'success.fg' }}>{b.multiplier}×</Text>
          </Box>
          <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Длительность</Text>
            <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>{fmtDuration(b.duration)}</Text>
          </Box>
        </Box>
      )}

      {tab === 'combine' && rule && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <RarityBadge rarity={rule.from_rarity} />
              <Text>→</Text>
              <RarityBadge rarity={rule.to_rarity} />
            </Box>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>
              Нужно <strong>{rule.required_amount}</strong> шт. для одного апгрейда · Максимум: <strong>{maxUpgrades}</strong>
            </Text>
          </Box>
          {maxUpgrades > 0 ? (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Количество апгрейдов</Text>
                <AmountInput value={combineCount} onChange={setCombineCount} min={1} max={maxUpgrades} />
              </Box>
              <Box sx={{ p: 2, bg: 'success.subtle', borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Будет использовано</Text>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Text sx={{ fontWeight: 'bold', color: 'success.fg' }}>{combineCount * rule.required_amount} шт. →</Text>
                  <Text sx={{ fontWeight: 'bold', color: 'success.fg' }}>{combineCount} ×</Text>
                  <RarityBadge rarity={rule.to_rarity} />
                </Box>
              </Box>
            </>
          ) : (
            <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2 }}>
              <Text sx={{ fontSize: 1, color: 'fg.muted' }}>
                Нужно ещё {rule.required_amount - (item.quantity % rule.required_amount || rule.required_amount)} шт.
              </Text>
            </Box>
          )}
        </Box>
      )}

      {tab === 'sell' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Количество (макс {item.quantity})</Text>
            <AmountInput value={sellAmount} onChange={setSellAmount} max={item.quantity} />
          </Box>
          <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Итого</Text>
            <Text sx={{ fontWeight: 'bold' }}>
              {isCrystals ? <CrystalValue value={fmt(sellTotal)} /> : <CoinValue value={fmt(sellTotal)} />}
            </Text>
          </Box>
        </Box>
      )}
    </>
  );
}

// ── Выпавшие из паков награды (живут в родителе, чтобы не пропадать при опустошении) ──
export type OpenReward = { reward_type?: string; reward_id?: number; crystals_amount?: number; rarity?: { booster_rarity?: string } };
export function OpenedRewards({ rewards }: { rewards: OpenReward[] }) {
  const catalog = useItemCatalog();
  const agg = useMemo(() => {
    const map = new Map<string, { type: string; reward_id?: number; count: number; crystals: number }>();
    for (const r of rewards) {
      if (r?.reward_type === 'crystals') {
        const cur = map.get('crystals') ?? { type: 'crystals', count: 0, crystals: 0 };
        cur.count += 1; cur.crystals += Number(r.crystals_amount || 0); map.set('crystals', cur);
      } else {
        const k = `item:${r?.reward_id}`;
        const cur = map.get(k) ?? { type: 'item', reward_id: r?.reward_id, count: 0, crystals: 0 };
        cur.count += 1; map.set(k, cur);
      }
    }
    return [...map.values()];
  }, [rewards]);
  if (!rewards.length) return null;
  return (
    <Box sx={{ mb: 3, border: '1px solid', borderColor: 'success.emphasis', borderRadius: 2, p: 2, bg: 'success.subtle' }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold', display: 'block', mb: 1 }}>Выпало ({rewards.length})</Text>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {agg.map((rr, i) => {
          if (rr.type === 'crystals') return (
            <div key={i} className="item-card__box ic-rare" style={{ width: 56, height: 56 }} title="Кристаллы">
              <span style={{ fontSize: 26 }}>💎</span>
              <span className="item-card__count">{rr.crystals}</span>
            </div>
          );
          const m = rr.reward_id != null ? ITEMS_BY_ID[rr.reward_id] : null;
          return (
            <div key={i} className={`item-card__box${m ? ` ic-${m.tag}` : ' ic-common'}`} style={{ width: 56, height: 56 }} title={m?.name ?? itemName(rr.reward_id, catalog)}>
              {m
                ? <img className="item-card__img" src={itemImgSrc(m.tag)} alt="" style={{ height: 56, scale: String(m.scale) }} onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
                : rr.reward_id != null ? <ItemThumb itemId={rr.reward_id} item={catalog.get(rr.reward_id)} size={44} style={{ fontSize: 9 }} /> : null}
              {rr.count > 1 && <span className="item-card__count">{rr.count}</span>}
            </div>
          );
        })}
      </Box>
    </Box>
  );
}

// ── Pack Modal ────────────────────────────────────────────────────────────────

function PackModal({
  item, packMeta, accountId, onDone, onFooter, onOpened,
}: {
  item: StorageItemFull;
  packMeta: BoosterPackMeta | null;
  accountId: number;
  onDone: () => void;
  onFooter: (node: React.ReactNode) => void;
  onOpened: (rewards: OpenReward[]) => void;
}) {
  const catalog = useItemCatalog();
  const [tab, setTab] = useState<'open' | 'target' | 'sell'>('open');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sellAmount, setSellAmount] = useState(1);
  const [openCount, setOpenCount] = useState(1);
  const [openProgress, setOpenProgress] = useState(0);
  const currentTarget = packMeta?.user_progress?.[0]?.target_item_id ?? null;
  const [selectedTarget, setSelectedTarget] = useState<number | null>(currentTarget);

  const rewards = packMeta?.rewards ?? [];
  const itemRewards = rewards.filter(r => r.reward_type === 'item');
  // На вкладке «Цель» показываем ТОЛЬКО предметы с гарантией: у набора она есть не на всё, что
  // выпадает (у летнего — на 3 позиции из 10), а выбирать цель без серии бессмысленно.
  const targetRewards = itemRewards
    .filter(r => attemptsFor(packMeta, r.reward_id) != null)
    .sort((a, b) => (attemptsFor(packMeta, a.reward_id) ?? 0) - (attemptsFor(packMeta, b.reward_id) ?? 0));
  const isCrystals = item.sell_currency === 'crystals';
  const sellTotal = item.sell_price * sellAmount;

  const openPack = useCallback(async () => {
    const n = Math.max(1, Math.min(Math.floor(openCount) || 1, item.quantity));
    setBusy(true); setFlash(null); onOpened([]); setOpenProgress(0);
    const collected: OpenReward[] = [];
    let err = '';
    for (let i = 0; i < n; i++) {
      setOpenProgress(i + 1);
      if (i > 0) await new Promise(r => setTimeout(r, 1000)); // пауза, чтобы не словить лимит игры
      try {
        const r = await api.storageOpenPack(accountId, item.id);
        if (r.ok) collected.push((r.result ?? {}) as OpenReward);
        else { err = r.error ?? 'Ошибка открытия'; break; }
      } catch (e) { err = String(e); break; }
    }
    onOpened(collected); // результаты живут в родителе — не пропадут при опустошении набора
    if (collected.length) setFlash({ ok: !err, msg: `Открыто ${collected.length} пак(ов)${err ? ` · остановлено: ${err}` : ''}` });
    else if (err) setFlash({ ok: false, msg: err });
    setOpenProgress(0);
    setBusy(false);
    onDone();
  }, [accountId, item.id, item.quantity, openCount, onDone, onOpened]);

  const setTarget = useCallback(async () => {
    if (selectedTarget == null) return;
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageSetTarget(accountId, item.id, selectedTarget);
      if (r.ok) setFlash({ ok: true, msg: 'Цель установлена' });
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, selectedTarget]);

  const sell = useCallback(async () => {
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageSell(accountId, item.id, sellAmount);
      if (r.ok) { setFlash({ ok: true, msg: `Продано ${sellAmount} шт.` }); onDone(); }
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка продажи' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, sellAmount, onDone]);

  useEffect(() => {
    if (tab === 'open') {
      onFooter(
        <Button variant="primary" leadingVisual={PackageIcon} loading={busy} disabled={busy || item.quantity === 0} onClick={openPack}>
          {busy && openProgress ? `Открываю ${openProgress}/${Math.min(openCount, item.quantity)}…` : `Открыть ${Math.min(openCount, item.quantity)} пак(ов)`}
        </Button>
      );
    } else if (tab === 'target') {
      onFooter(
        <Button variant="primary" leadingVisual={StarFillIcon} loading={busy} disabled={busy || selectedTarget == null} onClick={setTarget}>
          Установить цель
        </Button>
      );
    } else {
      onFooter(
        <Button variant="danger" leadingVisual={ArrowDownIcon} loading={busy} disabled={busy} onClick={sell}>
          Продать {sellAmount} шт.
        </Button>
      );
    }
    return () => onFooter(null);
  }, [tab, busy, selectedTarget, sellAmount, item.quantity, openCount, openProgress, openPack, setTarget, sell, onFooter]);

  return (
    <>
      <TabNav aria-label="Действие" sx={{ mb: 3 }}>
        <TabNav.Link as="button" selected={tab === 'open'} onClick={() => { setTab('open'); setFlash(null); }}>Открыть</TabNav.Link>
        {itemRewards.length > 0 && <TabNav.Link as="button" selected={tab === 'target'} onClick={() => { setTab('target'); setFlash(null); }}>Цель</TabNav.Link>}
        <TabNav.Link as="button" selected={tab === 'sell'} onClick={() => { setTab('sell'); setFlash(null); }}>Продать</TabNav.Link>
      </TabNav>

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {tab === 'open' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Сколько открыть (макс {item.quantity})</Text>
            <AmountInput value={openCount} onChange={setOpenCount} max={item.quantity} />
          </Box>

          {rewards.length > 0 && (
            <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: 1, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
                <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold' }}>Возможные награды</Text>
              </Box>
              {rewards.map((rw, i) => <RewardRow key={i} rw={rw} i={i} total={rewards.length} />)}
            </Box>
          )}
        </Box>
      )}

      {tab === 'target' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {packMeta?.user_progress && packMeta.user_progress.length > 0 && (
            <Box sx={{ p: 2, bg: 'accent.subtle', borderRadius: 2 }}>
              <Text sx={{ fontSize: 1, color: 'accent.fg', fontWeight: 'bold', display: 'block', mb: 1 }}>Текущий прогресс</Text>
              {packMeta.user_progress.map((p, i) => {
                const targetMeta = p.target_item_id != null ? ITEMS_BY_ID[p.target_item_id] : null;
                const targetRw = itemRewards.find(r => r.reward_id === p.target_item_id);
                const rarity = targetRw?.rarity?.valid ? targetRw.rarity.booster_rarity : null;
                return (
                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Text sx={{ fontSize: 1 }}>{targetMeta?.name ?? itemName(p.target_item_id, catalog)}</Text>
                    <Text sx={{ fontSize: 1 }}>— открыто {p.current_streak ?? 0} из {attemptsFor(packMeta, p.target_item_id) ?? '?'}</Text>
                  </Box>
                );
              })}
            </Box>
          )}
          <Text sx={{ fontSize: 1, color: 'fg.muted' }}>
            Справа — сколько паков нужно открыть подряд, чтобы цель выпала гарантированно.
            Показаны только предметы с гарантией: на остальные награды набора серия не считается.
          </Text>
          {targetRewards.length === 0 && (
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>У этого набора нет предметов с гарантией.</Text>
          )}
          <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
            {targetRewards.map((rw, i) => {
              const isSelected = selectedTarget === rw.reward_id;
              return (
                <Box
                  key={i}
                  onClick={() => setSelectedTarget(rw.reward_id)}
                  sx={{
                    cursor: 'pointer',
                    bg: isSelected ? 'accent.subtle' : 'canvas.default',
                    borderBottom: i < targetRewards.length - 1 ? '1px solid' : 'none',
                    borderColor: 'border.muted',
                    '&:hover': { bg: isSelected ? 'accent.subtle' : 'canvas.subtle' },
                  }}
                >
                  <RewardRow rw={rw} i={i} total={targetRewards.length} right={<PacksToGuarantee n={attemptsFor(packMeta, rw.reward_id)} />}>
                    {isSelected && <Label sx={{ bg: 'accent.emphasis', color: 'white', borderColor: 'transparent', fontSize: 0 }}>Выбрано</Label>}
                  </RewardRow>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {tab === 'sell' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Количество (макс {item.quantity})</Text>
            <AmountInput value={sellAmount} onChange={setSellAmount} max={item.quantity} />
          </Box>
          <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Итого</Text>
            <Text sx={{ fontWeight: 'bold' }}>
              {isCrystals ? <CrystalValue value={fmt(sellTotal)} /> : <CoinValue value={fmt(sellTotal)} />}
            </Text>
          </Box>
        </Box>
      )}
    </>
  );
}

// ── Simple Item Modal ─────────────────────────────────────────────────────────

function SimpleItemModal({
  item, accountId, onDone, onFooter,
}: {
  item: StorageItemFull;
  accountId: number;
  onDone: () => void;
  onFooter: (node: React.ReactNode) => void;
}) {
  const [sellAmount, setSellAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const isCrystals = item.sell_currency === 'crystals';
  const sellTotal = item.sell_price * sellAmount;

  const sell = useCallback(async () => {
    setBusy(true); setFlash(null);
    try {
      const r = await api.storageSell(accountId, item.id, sellAmount);
      if (r.ok) { setFlash({ ok: true, msg: `Продано ${sellAmount} шт.` }); onDone(); }
      else setFlash({ ok: false, msg: r.error ?? 'Ошибка продажи' });
    } catch (e) { setFlash({ ok: false, msg: String(e) }); }
    finally { setBusy(false); }
  }, [accountId, item.id, sellAmount, onDone]);

  useEffect(() => {
    onFooter(
      <Button variant="danger" leadingVisual={ArrowDownIcon} loading={busy} disabled={busy} onClick={sell}>
        Продать {sellAmount} шт.
      </Button>
    );
    return () => onFooter(null);
  }, [busy, sellAmount, sell, onFooter]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 3 }}>
        <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Количество</Text>
          <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>{item.quantity}</Text>
        </Box>
        <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Цена за шт.</Text>
          <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>
            {isCrystals ? <CrystalValue value={fmt(item.sell_price)} /> : <CoinValue value={fmt(item.sell_price)} />}
          </Text>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Количество (макс {item.quantity})</Text>
        <AmountInput value={sellAmount} onChange={setSellAmount} max={item.quantity} />
      </Box>
      <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Итого</Text>
        <Text sx={{ fontWeight: 'bold' }}>
          {isCrystals ? <CrystalValue value={fmt(sellTotal)} /> : <CoinValue value={fmt(sellTotal)} />}
        </Text>
      </Box>
    </Box>
  );
}

// ── Main StorageModal ─────────────────────────────────────────────────────────

export interface StorageModalProps {
  accountName: string;
  accountId: number;
  itemId: number;
  onClose: () => void;
}

export function StorageModal({ accountName, accountId, itemId, onClose }: StorageModalProps) {
  const [loading, setLoading] = useState(true);
  const [item, setItem] = useState<StorageItemFull | null>(null);
  const [packMeta, setPackMeta] = useState<BoosterPackMeta | null>(null);
  const [rules, setRules] = useState<CombinationRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(false); // предмет израсходован/продан полностью
  const [footerActions, setFooterActions] = useState<React.ReactNode>(null);
  const [openedRewards, setOpenedRewards] = useState<OpenReward[]>([]); // что выпало из паков (живёт здесь, не пропадает)
  const hadItem = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConsumed(false);
    try {
      const d = await api.storageLive(accountId);
      if (!d.ok) { setError(d.error ?? 'Ошибка загрузки'); return; }
      const found = d.items.find(i => i.id === itemId);
      if (!found) {
        // если предмет был, а после действия его не стало — это успех (всё продано/израсходовано), а не ошибка
        if (hadItem.current) { setConsumed(true); setItem(null); }
        else setError('Предмет не найден в инвентаре');
        return;
      }
      hadItem.current = true;
      setItem(found);
      setRules(d.combination_rules);
      if (found.type === 'booster_pack') {
        setPackMeta(d.booster_packs.find(p => p.id === itemId) ?? null);
      }
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [accountId, itemId]);

  useEffect(() => { loadData(); }, [loadData]);

  // после расхода предмета (продажа/активация/объединение/открытие) — синхронизируем
  // инвентарь аккаунта в БД с игры, затем перечитываем live-состояние модалки
  const handleConsumed = useCallback(async () => {
    await api.storageSync(accountId).catch(() => {});
    await loadData();
  }, [accountId, loadData]);

  const catalog = useItemCatalog();
  const title = itemName(itemId, catalog);

  return (
    <Dialog
      title={item ? `${title} — ${item.quantity}шт` : title}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      /* футер здесь — не набор кнопок, а произвольные узлы (footerActions приходят
         от вложенных модалок), поэтому renderFooter вместо footerButtons */
      renderFooter={() => (
        <Dialog.Footer sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Button leadingVisual={SyncIcon} onClick={loadData} disabled={loading}>Обновить</Button>
          <Box sx={{ display: 'flex', gap: 2 }}>{footerActions}</Box>
        </Dialog.Footer>
      )}
    >
      <Box>
        <OpenedRewards rewards={openedRewards} />
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        ) : error ? (
          <Flash variant="danger">{error}</Flash>
        ) : consumed ? (
          <Flash variant="success">Готово — предмет полностью израсходован, в инвентаре больше нет.</Flash>
        ) : item ? (
          <>
            {item.type === 'booster' && item.booster && (
              <BoosterModal item={item} accountId={accountId} rules={rules} onDone={handleConsumed} onFooter={setFooterActions} />
            )}
            {item.type === 'booster_pack' && (
              <PackModal item={item} packMeta={packMeta} accountId={accountId} onDone={handleConsumed} onFooter={setFooterActions} onOpened={setOpenedRewards} />
            )}
            {!['booster', 'booster_pack'].includes(item.type) && (
              <SimpleItemModal item={item} accountId={accountId} onDone={handleConsumed} onFooter={setFooterActions} />
            )}
          </>
        ) : null}
      </Box>
    </Dialog>
  );
}
