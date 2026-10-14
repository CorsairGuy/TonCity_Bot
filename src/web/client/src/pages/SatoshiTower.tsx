import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  Box, Button, Flash, Heading, Spinner, Text, Select, ButtonGroup, TextInput, Checkbox, Label,
} from '@primer/react';
import { DataTable, Table, type Column, Dialog } from '@primer/react/experimental';
import { ArrowUpIcon, ArrowDownIcon, SyncIcon, XCircleIcon, GearIcon, PlusIcon } from '@primer/octicons-react';
import {
  api, type SatoshiCandle, type SatoshiConfig, type SatoshiTimeframe, type Account,
  type SatoshiTpSl, type SatoshiOpenPosition, type SatoshiHistoryPosition, type SatoshiPendingOrder,
} from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt, fmtDate } from '../utils';
import { SatoshiChart, type ChartPosition } from '../components/SatoshiChart';
import { useSatoshiFeed } from '../hooks/useSatoshiFeed';
import { CrystalValue, IC_CRYSTAL } from '../components/Icons';
import { Scrollable } from '../components/Scrollable';

const TIMEFRAMES: { value: SatoshiTimeframe; label: string }[] = [
  { value: '1m', label: '1м' }, { value: '5m', label: '5м' }, { value: '15m', label: '15м' },
  { value: '1h', label: '1ч' }, { value: '4h', label: '4ч' }, { value: '1d', label: '1д' },
];

// маржа/размер/комиссия/выплата — в кристаллах игры, а не в $ (это цена GRAM на бирже/в игре)
const Cr = ({ n }: { n: number | null | undefined }) => n == null ? <span>—</span> : <CrystalValue value={fmt(n)} />;
// PnL со знаком: сначала +/-, потом число, потом иконка кристалла (у CrystalValue иконка всегда
// первая — для суммы это нормально, для "прибыль/убыток" привычнее знак+число впереди значка)
const SignedCr = ({ n }: { n: number | null | undefined }) => {
  if (n == null) return <span>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {n >= 0 ? '+' : '−'} {fmt(Math.abs(n))} {IC_CRYSTAL}
    </span>
  );
};

// ── Мелкие общие куски ────────────────────────────────────────────────────────

// Комиссия — 1% на ВСЮ сделку (одна ставка на весь round-trip, не отдельно open+close).
function estCloseFee(notional: number, config: SatoshiConfig | null) {
  if (!config) return 0;
  return Math.max(config.min_fee, notional * config.fee_rate);
}
function calcPnl(entry: number, notional: number, margin: number, side: 'long' | 'short', mark: number, config: SatoshiConfig | null) {
  if (!mark || !entry) return { pnl: 0, pnlPct: 0, breakeven: entry };
  const dir = side === 'long' ? 1 : -1;
  const closeFee = estCloseFee(notional, config);
  const pnl = dir * ((mark - entry) / entry) * notional - closeFee;
  const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
  const breakeven = notional > 0 ? entry * (1 + dir * (closeFee / notional)) : entry;
  return { pnl, pnlPct, breakeven };
}

// Три способа задать TP/SL:
// - roi_pct  — % ROI от маржи (то, что реально хранится и сравнивается в satoshiAutoClose.js —
//              plnPct = (pnl/margin)*100, плечо уже внутри: сработает при более мелком движении курса)
// - move_pct — % движения самого курса GRAM/USDT (привычнее большинству трейдеров) — переводим
//              в ROI умножением на плечо перед отправкой боту (roi% = move% × leverage)
// - price    — конкретный целевой курс $ (напр. "продать при 1.6")
// Оценка прибыли/убытка в кристаллах — чтобы сразу было видно, сколько это в реальных деньгах,
// а не только проценты/курс. Без учёта ещё не взятой комиссии закрытия — это ориентир, не точная сумма.
type TpSlMode = 'price' | 'roi_pct' | 'move_pct';
function estimateCrystalsForTarget(mode: TpSlMode, value: number, side: 'long' | 'short', margin: number, notional: number, entryPrice: number): number | null {
  if (!margin || !isFinite(value)) return null;
  if (mode === 'roi_pct') return margin * (value / 100);
  if (mode === 'move_pct') return notional * (value / 100);
  if (!entryPrice || !notional) return null;
  const dir = side === 'long' ? 1 : -1;
  return dir * ((value - entryPrice) / entryPrice) * notional;
}

// Обратно к цене: при каком курсе позиция достигнет заданного ROI% (pnlPct от маржи, net после
// комиссии закрытия) — чтобы нарисовать уровни TP/SL на графике, когда они заданы как ROI%, а не ценой.
function priceForPnlPct(entry: number, notional: number, margin: number, side: 'long' | 'short', pnlPct: number, config: SatoshiConfig | null): number | null {
  if (!entry || !notional) return null;
  const dir = side === 'long' ? 1 : -1;
  const closeFee = config ? Math.max(config.min_fee, notional * config.fee_rate) : 0;
  const rawPnl = margin * (pnlPct / 100) + closeFee; // валовый PnL до вычета комиссии закрытия
  return entry * (1 + dir * rawPnl / notional);
}

// Что РЕАЛЬНО уйдёт в игру. С обновления 31.07.2026 у игры свой серверный TP/SL, но он принимает
// только АБСОЛЮТНУЮ ЦЕНУ — а вводить у нас можно и в ROI%, и в «% движения курса». Пересчёт делает
// сервер (utils/satoshiTriggers, тот же код, что и само открытие), чтобы показанное здесь совпадало
// с отправленным. Уровни ещё и подрезаются под границы игры, поэтому увидеть итог до клика важно.
function GameTriggerPreview({ side, leverage, margin, price, tpSl }: {
  side: 'long' | 'short'; leverage: number; margin: number; price: number; tpSl: SatoshiTpSl;
}) {
  const [preview, setPreview] = useState<{ tp: number | null; sl: number | null } | null>(null);
  const key = JSON.stringify({ side, leverage, margin, price, tpSl });
  useEffect(() => {
    const has = tpSl.tp_price != null || tpSl.sl_price != null || tpSl.tp_pnl_pct != null || tpSl.sl_pnl_pct != null;
    if (!has || !(price > 0) || !(margin > 0)) { setPreview(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.satoshiTriggerPreview({ side, leverage, margin, price, ...tpSl })
        .then(d => { if (!cancelled && d.ok) setPreview({ tp: d.take_profit_price, sl: d.stop_loss_price }); })
        .catch(() => {});
    }, 350);   // дебаунс: значения меняются ползунками/вводом
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!preview || (preview.tp == null && preview.sl == null)) return null;
  return (
    <Box sx={{ mb: 2, bg: 'canvas.subtle', borderRadius: 2, p: 2 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Уйдёт в игру (игровой TP/SL, цена):</Text>
      <Box sx={{ display: 'flex', gap: 3, fontSize: 0 }}>
        {preview.tp != null && <Text className="mono" style={{ color: 'var(--green)' }}>TP ${preview.tp.toFixed(3)}</Text>}
        {preview.sl != null && <Text className="mono" style={{ color: 'var(--red)' }}>SL ${preview.sl.toFixed(3)}</Text>}
      </Box>
    </Box>
  );
}

function TpSlBadge({ p }: { p: SatoshiTpSl }) {
  const parts: string[] = [];
  if (p.tp_price != null) parts.push(`TP $${p.tp_price}`);
  if (p.tp_pnl_pct != null) parts.push(`TP +${p.tp_pnl_pct}%`);
  if (p.sl_price != null) parts.push(`SL $${p.sl_price}`);
  if (p.sl_pnl_pct != null) parts.push(`SL -${p.sl_pnl_pct}%`);
  if (!parts.length) return <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>—</Text>;
  return <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{parts.map((t, i) => <Label key={i} sx={{ fontSize: 0 }}>{t}</Label>)}</Box>;
}

// Разумное значение по умолчанию при переключении режима — иначе после смены "% → цена" в поле
// оставалось старое процентное число (напр. "50"), что выглядит как курс $50 и сбивает с толку.
// direction: для TP — в сторону прибыли, для SL — в сторону убытка.
function defaultPriceFor(side: 'long' | 'short', direction: 'profit' | 'loss', referencePrice: number): number {
  const up = (side === 'long') === (direction === 'profit');
  return Number((referencePrice * (up ? 1.05 : 0.95)).toFixed(3));
}

const TP_SL_MODE_LABEL: Record<TpSlMode, string> = {
  move_pct: '% движения курса', roi_pct: '% ROI (от маржи)', price: 'Курс, напр. 1.6',
};

function TpSlFields({
  useTp, setUseTp, tpMode, setTpMode, tpValue, setTpValue, useSl, setUseSl, slMode, setSlMode, slValue, setSlValue,
  side, referencePrice, leverage,
}: {
  useTp: boolean; setUseTp: (v: boolean) => void; tpMode: TpSlMode; setTpMode: (v: TpSlMode) => void; tpValue: number; setTpValue: (v: number) => void;
  useSl: boolean; setUseSl: (v: boolean) => void; slMode: TpSlMode; setSlMode: (v: TpSlMode) => void; slValue: number; setSlValue: (v: number) => void;
  // курс входа/ориентир — для разумного дефолта при переключении режима и подсказки "сейчас $X"
  side?: 'long' | 'short'; referencePrice?: number; leverage?: number;
}) {
  const changeTpMode = (mode: TpSlMode) => {
    setTpMode(mode);
    if (mode === 'price' && side && referencePrice) setTpValue(defaultPriceFor(side, 'profit', referencePrice));
    else if (mode === 'roi_pct') setTpValue(5);
    else if (mode === 'move_pct') setTpValue(1);
  };
  const changeSlMode = (mode: TpSlMode) => {
    setSlMode(mode);
    if (mode === 'price' && side && referencePrice) setSlValue(defaultPriceFor(side, 'loss', referencePrice));
    else if (mode === 'roi_pct') setSlValue(5);
    else if (mode === 'move_pct') setSlValue(1);
  };
  const roiHint = (mode: TpSlMode, value: number) => mode === 'move_pct' && leverage
    ? <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>= {(value * leverage).toFixed(1)}% ROI при плече {leverage}×</Text>
    : null;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: useTp ? 1 : 0 }}>
        <Checkbox checked={useTp} onChange={e => setUseTp(e.target.checked)} id="tp-check" />
        <Text as="label" htmlFor="tp-check" sx={{ fontSize: 1 }}>Тейк-профит (авто-закрытие)</Text>
      </Box>
      {useTp && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Select size="small" value={tpMode} onChange={e => changeTpMode(e.target.value as TpSlMode)}>
              <Select.Option value="move_pct">{TP_SL_MODE_LABEL.move_pct}</Select.Option>
              <Select.Option value="roi_pct">{TP_SL_MODE_LABEL.roi_pct}</Select.Option>
              <Select.Option value="price">{TP_SL_MODE_LABEL.price}</Select.Option>
            </Select>
            <TextInput
              type="number" value={tpValue} onChange={e => setTpValue(Number(e.target.value))}
              leadingVisual={tpMode === 'price' ? '$' : undefined} trailingVisual={tpMode !== 'price' ? '%' : undefined}
            />
          </Box>
          {tpMode === 'price' && !!referencePrice && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>Текущий курс: ${referencePrice.toFixed(3)}</Text>
          )}
          {roiHint(tpMode, tpValue)}
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: useSl ? 1 : 0, mt: 2 }}>
        <Checkbox checked={useSl} onChange={e => setUseSl(e.target.checked)} id="sl-check" />
        <Text as="label" htmlFor="sl-check" sx={{ fontSize: 1 }}>Стоп-лосс (авто-закрытие)</Text>
      </Box>
      {useSl && (
        <Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Select size="small" value={slMode} onChange={e => changeSlMode(e.target.value as TpSlMode)}>
              <Select.Option value="move_pct">{TP_SL_MODE_LABEL.move_pct}</Select.Option>
              <Select.Option value="roi_pct">{TP_SL_MODE_LABEL.roi_pct}</Select.Option>
              <Select.Option value="price">{TP_SL_MODE_LABEL.price}</Select.Option>
            </Select>
            <TextInput
              type="number" value={slValue} onChange={e => setSlValue(Number(e.target.value))}
              leadingVisual={slMode === 'price' ? '$' : undefined} trailingVisual={slMode !== 'price' ? '%' : undefined}
            />
          </Box>
          {slMode === 'price' && !!referencePrice && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>Текущий курс: ${referencePrice.toFixed(3)}</Text>
          )}
          {roiHint(slMode, slValue)}
        </Box>
      )}
    </Box>
  );
}

function useTpSlState(initTp?: number | null, initTpPct?: number | null, initSl?: number | null, initSlPct?: number | null) {
  const [useTp, setUseTp] = useState(initTp != null || initTpPct != null);
  const [tpMode, setTpMode] = useState<TpSlMode>(initTpPct != null ? 'roi_pct' : initTp != null ? 'price' : 'roi_pct');
  const [tpValue, setTpValue] = useState(initTpPct ?? initTp ?? 5);
  const [useSl, setUseSl] = useState(initSl != null || initSlPct != null);
  const [slMode, setSlMode] = useState<TpSlMode>(initSlPct != null ? 'roi_pct' : initSl != null ? 'price' : 'roi_pct');
  const [slValue, setSlValue] = useState(initSlPct ?? initSl ?? 5);
  // leverage нужен, чтобы перевести "% движения курса" в ROI% перед отправкой боту — хранится и
  // сравнивается в satoshiAutoClose.js только как ROI% от маржи (см. estimateCrystalsForTarget выше)
  const build = (leverage: number): SatoshiTpSl => {
    const toRoiPct = (mode: TpSlMode, value: number) => mode === 'move_pct' ? value * leverage : value;
    const tpSl: SatoshiTpSl = {};
    if (useTp) { if (tpMode === 'price') tpSl.tp_price = tpValue; else tpSl.tp_pnl_pct = toRoiPct(tpMode, tpValue); }
    if (useSl) { if (slMode === 'price') tpSl.sl_price = slValue; else tpSl.sl_pnl_pct = toRoiPct(slMode, slValue); }
    return tpSl;
  };
  return { useTp, setUseTp, tpMode, setTpMode, tpValue, setTpValue, useSl, setUseSl, slMode, setSlMode, slValue, setSlValue, build };
}

function TpSlModal({ position, onClose, onSaved }: { position: SatoshiOpenPosition; onClose: () => void; onSaved: () => void }) {
  const t = useTpSlState(position.tp_price, position.tp_pnl_pct, position.sl_price, position.sl_pnl_pct);
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();

  const tpCrystals = t.useTp ? estimateCrystalsForTarget(t.tpMode, t.tpValue, position.side, position.margin, position.notional, position.entry_price) : null;
  const slCrystals = t.useSl ? estimateCrystalsForTarget(t.slMode, t.slMode !== 'price' ? -Math.abs(t.slValue) : t.slValue, position.side, position.margin, position.notional, position.entry_price) : null;

  const save = async () => {
    setBusy(true);
    try {
      const built = t.build(position.leverage);
      const payload: SatoshiTpSl = { tp_price: built.tp_price ?? null, tp_pnl_pct: built.tp_pnl_pct ?? null, sl_price: built.sl_price ?? null, sl_pnl_pct: built.sl_pnl_pct ?? null };
      const r = await api.satoshiUpdateTpSl(position.id, payload);
      if (r.ok) { showFlash('Сохранено', true); onSaved(); } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={`TP/SL — позиция #${position.id}`}
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{ content: 'Сохранить', buttonType: 'primary', loading: busy, disabled: busy, onClick: save }]}
    >
      <Box>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{flash.msg}</Flash>}
        <TpSlFields {...t} side={position.side} referencePrice={position.entry_price} leverage={position.leverage} />
        {(tpCrystals != null || slCrystals != null) && (
          <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 2, mt: 2, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {tpCrystals != null && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}>
                <Text sx={{ color: 'fg.muted' }}>≈ Тейк-профит даст</Text>
                <Text className="mono" style={{ color: 'var(--green)' }}>+<Cr n={tpCrystals} /></Text>
              </Box>
            )}
            {slCrystals != null && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}>
                <Text sx={{ color: 'fg.muted' }}>≈ Стоп-лосс заберёт</Text>
                <Text className="mono" style={{ color: 'var(--red)' }}>−<Cr n={Math.abs(slCrystals)} /></Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Dialog>
  );
}

// ── Модалка "Новая позиция" ───────────────────────────────────────────────────

function NewPositionModal({ config, accounts, price, openCountByAccount, maxOpen, maxLevByAccount, onRefreshBalances, balanceRefreshing, onClose, onOpened }: {
  config: SatoshiConfig | null; accounts: Account[]; price: number; openCountByAccount: Record<number, number>; maxOpen: number; maxLevByAccount: Record<number, number>; onRefreshBalances: () => void; balanceRefreshing: boolean; onClose: () => void; onOpened: () => void;
}) {
  // Один список аккаунтов с чекбоксами и видимым балансом каждого — вместо режима
  // "один счёт (select, баланс не виден пока не выбрал) / все счета (вслепую)".
  // По умолчанию отмечен первый аккаунт, у которого реально хватает кристаллов на минимальную маржу.
  // useMemo — модалка получает live price и перерендеривается на каждый тик, пока открыта; сортировка
  // зависит только от accounts, незачем пересчитывать её при каждом тике.
  const sortedAccounts = useMemo(() => [...accounts].sort((a, b) => (b.crystals ?? 0) - (a.crystals ?? 0)), [accounts]);
  const firstAffordable = sortedAccounts.find(a => (a.crystals ?? 0) >= (config?.min_margin ?? 1));
  const [selected, setSelected] = useState<Set<number>>(new Set(firstAffordable ? [firstAffordable.id] : []));
  const [side, setSide] = useState<'long' | 'short' | 'both'>('long');
  const [leverage, setLeverage] = useState(10);
  const [margin, setMargin] = useState(config?.min_margin ?? 10);
  // процентный режим маржи: null = фикс. число (поле), число = % от баланса КАЖДОГО аккаунта.
  // При нескольких аккаунтах кнопки 25/50/75/100% берут % с баланса каждого, а не фикс. значение.
  const [marginPct, setMarginPct] = useState<number | null>(null);
  const t = useTpSlState();
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();
  // «Ждать курс» — вместо немедленного открытия позиции создаётся условный ордер, который игра
  // исполнит при достижении цены. Отдельной модалки «Ордер по цене» больше нет: это тот же набор
  // параметров (аккаунты/сторона/плечо/маржа/TP-SL) плюс цена срабатывания.
  const [wait, setWait] = useState(false);
  const [triggerPrice, setTriggerPrice] = useState(price || 0);
  // цена, от которой считаются сводка и проценты TP/SL: в режиме ожидания — цена срабатывания
  const refPrice = wait ? triggerPrice : price;

  const bothMode = side === 'both';
  const slotsNeeded = bothMode ? 2 : 1;            // «Оба» = 2 позиции (лонг+шорт) → 2 слота
  const dirSide: 'long' | 'short' = side === 'short' ? 'short' : 'long'; // для сводки/TP-SL нужна одна сторона

  // В режиме «Оба» выбранный бюджет делится на ДВЕ позиции (floor — обе гарантированно влезают в
  // бюджет). В обычном режиме — вся выбранная маржа идёт на одну позицию.
  const splitBudget = (budget: number) => bothMode ? Math.floor(budget / 2) : budget;

  // сводка — по марже НА ОДНУ сторону (margin = выбранный бюджет; в «Оба» показываем половину)
  const refMargin = splitBudget(margin);
  const notional = refMargin * leverage;
  const closeFee = config ? Math.max(config.min_fee, notional * config.fee_rate) : 0; // 1% на всю сделку, одна ставка
  const maint = refMargin * 0.005;
  const v = notional > 0 ? Math.max(0, refMargin - maint) / notional : 0;
  const estLiqPrice = refPrice > 0 ? (dirSide === 'short' ? refPrice * (1 + v) : refPrice * (1 - v)) : 0;
  const estBreakeven = refPrice > 0 && notional > 0
    ? (dirSide === 'short' ? refPrice * (1 - closeFee / notional) : refPrice * (1 + closeFee / notional))
    : 0;
  const tpCrystals = t.useTp ? estimateCrystalsForTarget(t.tpMode, t.tpValue, dirSide, refMargin, notional, refPrice) : null;
  const slCrystals = t.useSl ? estimateCrystalsForTarget(t.slMode, t.slMode !== 'price' ? -Math.abs(t.slValue) : t.slValue, dirSide, refMargin, notional, refPrice) : null;

  const selectedAccounts = sortedAccounts.filter(a => selected.has(a.id));
  // выбранный бюджет для КОНКРЕТНОГО аккаунта: % от его баланса (процентный режим) либо фикс. число
  const effMargin = (a: Account) => marginPct != null ? Math.floor((a.crystals ?? 0) * marginPct / 100) : margin;
  // маржа НА ОДИН ордер аккаунта (в «Оба» — половина бюджета с учётом комиссии)
  const perSideMargin = (a: Account) => splitBudget(effMargin(a));
  // хватает: маржа на сторону ≥ мин и баланса достаёт на все ордера (игра списывает маржу, не
  // комиссию сверху — как и было в исходной проверке `balance >= margin`, поэтому 100% проходит)
  const affordableSelected = selectedAccounts.filter(a => {
    const m = perSideMargin(a);
    return m >= (config?.min_margin ?? 1) && (a.crystals ?? 0) >= m * slotsNeeded;
  });
  const allChecked = selected.size > 0 && selected.size === sortedAccounts.length;
  const toggleOne = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(sortedAccounts.map(a => a.id)));

  // кнопки процента: включают % режим (маржа = N% баланса каждого) и заодно ставят reference-маржу
  // для сводки = N% наименьшего из выбранных балансов (самая маленькая позиция)
  const minSelBal = selectedAccounts.length ? Math.min(...selectedAccounts.map(a => Math.floor(a.crystals ?? 0))) : 0;
  const setPct = (p: number) => {
    setMarginPct(p);
    setMargin(Math.max(config?.min_margin ?? 1, Math.floor(minSelBal * p / 100)));
  };

  // per-account макс. плечо (политика на плечо): у кого есть — до 20×, у остальных базовые 10×.
  const defaultMax = config?.max_leverage ?? 10;
  const accMaxLev = (id: number) => maxLevByAccount[id] ?? defaultMax;
  // Максимум плеча — по ВЫБРАННЫМ аккаунтам, а не по всему флоту. Раньше брался общий максимум:
  // если хоть у кого-то есть политика на 50×, ползунок предлагал 50× даже когда выбран аккаунт с
  // лимитом 10× — а при открытии плечо всё равно капится его реальным (min с accMaxLev), т.е. UI
  // обещал не то, что произойдёт. Пока никто не выбран — базовый лимит.
  const effMaxLev = selectedAccounts.length
    ? Math.max(...selectedAccounts.map(a => accMaxLev(a.id)))
    : defaultMax;
  // если выбор сменился на аккаунт с меньшим лимитом — подрезаем текущее значение, иначе в поле
  // остались бы прежние 50× при максимуме 10×
  useEffect(() => { setLeverage(l => Math.min(l, effMaxLev)); }, [effMaxLev]);

  const canOpen = !!config && leverage >= 1 && leverage <= effMaxLev && refPrice > 0 && affordableSelected.length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      // плечо капим по каждому аккаунту (у кого нет политики — max 10×); маржа на сторону = perSideMargin
      // (в «Оба» — половина бюджета с учётом комиссии). Открываем ПОСЛЕДОВАТЕЛЬНО с паузой 1с между
      // запросами — иначе игра отдаёт "too many requests" при пачке (особенно лонг+шорт сразу).
      const sides: ('long' | 'short')[] = side === 'both' ? ['long', 'short'] : [side];
      const outcomes: { ok: boolean; error?: string }[] = [];
      let first = true;
      for (const a of affordableSelected) {
        const lev = Math.min(leverage, accMaxLev(a.id));
        const m = perSideMargin(a);
        for (const s of sides) {
          if (!first) await new Promise(r => setTimeout(r, 1000));
          first = false;
          try {
            const r = wait
              ? await api.satoshiCreatePending(a.id, s, lev, m, triggerPrice, t.build(lev))
              : await api.satoshiOpen(a.id, s, lev, m, t.build(lev));
            outcomes.push({ ok: !!r.ok, error: r.error });
          }
          catch (e) { outcomes.push({ ok: false, error: String(e) }); }
        }
      }
      const ok = outcomes.filter(o => o.ok).length;
      if (outcomes.length === 1) {
        showFlash(outcomes[0].ok ? (wait ? 'Ордер создан' : 'Позиция открыта') : (outcomes[0].error ?? 'Ошибка'), outcomes[0].ok);
      } else {
        const firstErr = outcomes.find(o => !o.ok)?.error;
        const noun = wait ? 'ордеров' : 'позиций';
        showFlash(ok === outcomes.length ? `Создано ${noun}: ${ok}` : `Создано ${ok} из ${outcomes.length}${firstErr ? ` · ${firstErr}` : ''}`, ok === outcomes.length);
      }
      onOpened();
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  return (
    // height="large" (640px) — высота ЗАФИКСИРОВАНА (не max-height): иначе любое появление или
    // исчезновение строки внутри (предупреждение о балансе, оценка TP/SL) меняет высоту диалога,
    // он перецентровывается на экране, и кнопка снизу визуально "прыгает". Скроллит тело само.
    <Dialog
      title={wait ? 'Новый ордер по цене' : 'Новая позиция'}
      onClose={onClose}
      width="large"
      height="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{
        content: (() => {
          const verb = wait ? 'Заказать' : 'Открыть';
          if (bothMode) return `${verb} Лонг+Шорт${affordableSelected.length > 1 ? ` ×${affordableSelected.length}` : ''}`;
          if (affordableSelected.length > 1) return `${verb} на ${affordableSelected.length} аккаунтах`;
          return `${verb} ${side === 'long' ? 'Лонг' : 'Шорт'}`;
        })(),
        buttonType: side === 'short' ? 'danger' : 'primary',
        block: true,
        loading: busy,
        disabled: busy || !canOpen,
        onClick: submit,
        sx: side === 'both' ? { bg: '#8250df', borderColor: '#8250df', '&:hover:not([disabled])': { bg: '#6f42c1' } } : undefined,
      }]}
    >
      <Box>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{flash.msg}</Flash>}

        <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, gap: 2, flexWrap: 'wrap' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Аккаунты ({selected.size}/{sortedAccounts.length})</Text>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button variant="invisible" leadingVisual={SyncIcon} loading={balanceRefreshing} disabled={balanceRefreshing} onClick={onRefreshBalances}>Баланс</Button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                <Checkbox checked={allChecked} onChange={toggleAll} />
                Выбрать все
              </label>
            </Box>
          </Box>
          <Scrollable style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180 }}>
            {sortedAccounts.map(a => {
              const enough = (a.crystals ?? 0) >= margin;
              const slotsFree = maxOpen - (openCountByAccount[a.id] ?? 0);
              const accLev = accMaxLev(a.id);
              return (
                <label key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', fontSize: 13, padding: '3px 0' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Checkbox checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} />
                    {a.name}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {accLev > defaultMax && <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }} title="макс. плечо (политика)">до {accLev}×</span>}
                    <span style={{ fontSize: 11, color: slotsFree <= 0 ? 'var(--red)' : 'var(--fg-muted)' }} title="свободные / всего слотов позиций">слоты {slotsFree}/{maxOpen}</span>
                    <span className="mono" style={{ color: enough ? undefined : 'var(--red)' }}><Cr n={a.crystals} /></span>
                  </span>
                </label>
              );
            })}
          </Scrollable>
        </Box>

        {/* сторона: обычные Button-ы (не ButtonGroup) — иначе активный вариант (danger у Шорта)
            визуально не всегда применяется. Лонг — зелёный, Шорт — остаётся КРАСНЫМ при выборе,
            Оба — фиолетовый (открывает и лонг, и шорт одновременно на каждый выбранный аккаунт) */}
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Button block variant={side === 'long' ? 'primary' : 'default'} leadingVisual={ArrowUpIcon} onClick={() => setSide('long')}>Лонг</Button>
          <Button block variant="default" onClick={() => setSide('both')} sx={side === 'both' ? { bg: '#8250df', color: '#fff', borderColor: '#8250df', '&:hover:not([disabled])': { bg: '#6f42c1' } } : undefined}>Оба</Button>
          <Button block variant={side === 'short' ? 'danger' : 'default'} leadingVisual={ArrowDownIcon} onClick={() => setSide('short')}>Шорт</Button>
        </Box>

        {/* «Ждать курс» — переключает создание позиции на условный ордер по цене */}
        <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 2, mb: 2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <Checkbox checked={wait} onChange={() => setWait(v => !v)} />
            Ждать курс — открыть не сейчас, а по цене
          </label>
          {wait && (
            <Box sx={{ mt: 2 }}>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>
                Цена срабатывания $ {price > 0 && `(сейчас ${price.toFixed(3)})`}
              </Text>
              <TextInput type="number" step="0.001" value={triggerPrice} onChange={e => setTriggerPrice(Number(e.target.value))} block />
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
                Позиция откроется автоматически, когда биржевой курс GRAM/USDT достигнет этой цены.
              </Text>
            </Box>
          )}
        </Box>

        <Box sx={{ mb: 2 }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Плечо: {leverage}× (макс {effMaxLev}×){effMaxLev > defaultMax ? ' — где нет политики, применится не выше 10×' : ''}</Text>
          <input type="range" min={1} max={effMaxLev} value={leverage} onChange={e => setLeverage(Number(e.target.value))} style={{ width: '100%' }} />
        </Box>

        <Box sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, gap: 2, flexWrap: 'wrap' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Маржа (кристаллы) {config && `— мин ${fmt(config.min_margin)}`}</Text>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {[25, 50, 75, 100].map(p => (
                <Button key={p} variant={marginPct === p ? 'primary' : 'default'} disabled={!selectedAccounts.length} onClick={() => setPct(p)}>{p}%</Button>
              ))}
            </Box>
          </Box>
          <TextInput type="number" value={margin} min={config?.min_margin ?? 1} onChange={e => { setMarginPct(null); setMargin(Number(e.target.value)); }} block />
          {marginPct != null && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
              = {marginPct}% баланса каждого аккаунта — у разных аккаунтов бюджет свой
            </Text>
          )}
          {bothMode && (
            <Text sx={{ fontSize: 0, color: '#8250df', display: 'block', mt: 1 }}>
              «Оба»: бюджет делится на 2 — ≈<Cr n={refMargin} /> маржи на каждую сторону
            </Text>
          )}
          {selectedAccounts.length > 0 && affordableSelected.length < selectedAccounts.length && (
            <Text sx={{ fontSize: 0, color: 'danger.fg', display: 'block', mt: 1 }}>
              Не хватает у {selectedAccounts.length - affordableSelected.length} из {selectedAccounts.length} выбранных — позиция откроется только у тех, кому хватает
            </Text>
          )}
        </Box>

        <Box sx={{ mb: 2 }}><TpSlFields {...t} side={dirSide} referencePrice={refPrice} leverage={leverage} /></Box>
        <GameTriggerPreview side={dirSide} leverage={leverage} margin={perSideMargin(affordableSelected[0]) || 0} price={refPrice} tpSl={t.build(leverage)} />

        <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}><Text sx={{ color: 'fg.muted' }}>Размер позиции</Text><Text className="mono"><Cr n={notional} /></Text></Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}><Text sx={{ color: 'fg.muted' }}>Комиссия</Text><Text className="mono"><Cr n={closeFee} /></Text></Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}><Text sx={{ color: 'fg.muted' }}>Безубыток</Text><Text className="mono">${estBreakeven.toFixed(3)}</Text></Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}><Text sx={{ color: 'fg.muted' }}>Ликвидация</Text><Text className="mono" style={{ color: 'var(--red)' }}>${estLiqPrice.toFixed(3)}</Text></Box>
          {t.useTp && tpCrystals != null && (
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}>
              <Text sx={{ color: 'fg.muted' }}>≈ Тейк-профит даст</Text>
              <Text className="mono" style={{ color: 'var(--green)' }}>+<Cr n={tpCrystals} /></Text>
            </Box>
          )}
          {t.useSl && slCrystals != null && (
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 0 }}>
              <Text sx={{ color: 'fg.muted' }}>≈ Стоп-лосс заберёт</Text>
              <Text className="mono" style={{ color: 'var(--red)' }}>−<Cr n={Math.abs(slCrystals)} /></Text>
            </Box>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}

// Колонки таблицы закрытых позиций — вынесены в константу МОДУЛЬНОГО уровня (не пересоздаются
// каждый рендер). Раньше массив columns объявлялся inline в JSX и получал новую ссылку на КАЖДЫЙ
// рендер страницы (в т.ч. на каждый тик курса биржи), из-за чего DataTable считал колонки
// изменившимися и заново пересортировывал/перерисовывал все строки — хотя закрытые позиции от
// курса вообще не зависят. Ни один renderCell тут не берёт ничего кроме row, поэтому вынос
// полностью безопасен.
const CLOSED_POSITIONS_COLUMNS: Column<SatoshiHistoryPosition>[] = [
  { header: 'Аккаунт', field: 'account', rowHeader: true, sortBy: 'alphanumeric', renderCell: row => <strong>{row.account}</strong> },
  { header: 'Сторона', field: 'side', sortBy: 'alphanumeric', renderCell: row => <Label variant={row.side === 'long' ? 'success' : 'danger'}>{row.side === 'long' ? 'Лонг' : 'Шорт'}</Label> },
  { header: 'Плечо', field: 'leverage', sortBy: 'basic', renderCell: row => <span className="mono">{row.leverage}×</span> },
  { header: 'Маржа', field: 'margin', sortBy: 'basic', renderCell: row => <span className="mono"><Cr n={row.margin} /></span> },
  { header: 'Размер', field: 'notional', sortBy: 'basic', renderCell: row => <span className="mono"><Cr n={row.notional} /></span> },
  { header: 'Вход', field: 'entry_price', sortBy: 'basic', renderCell: row => <span className="mono">${row.entry_price?.toFixed(3)}</span> },
  { header: 'Выход', field: 'close_price', sortBy: 'basic', renderCell: row => <span className="mono">{row.close_price != null ? `$${row.close_price.toFixed(3)}` : '—'}</span> },
  {
    // realized_pnl из игры — «грязный» показатель ДО вычета комиссии закрытия (не совпадает
    // с тем, что игра сама показывает пользователю). Первая попытка чинить через
    // payout-margin не сработала — оказалось, payout тоже посчитан без вычета fee
    // (то же самое число). Чистый PnL = realized_pnl - fee (комиссия закрытия, которую
    // синкаем отдельно) — совпадает с тем, что видно в самой игре.
    header: 'PnL', field: 'realized_pnl', sortBy: 'basic',
    renderCell: row => {
      const netPnl = row.realized_pnl != null ? row.realized_pnl - (row.fee ?? 0) : null;
      return <span className="mono" style={{ color: (netPnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}><SignedCr n={netPnl} /></span>;
    },
  },
  { header: 'Выплата', field: 'payout', sortBy: 'basic', renderCell: row => <span className="mono" style={{ fontWeight: 600 }}><Cr n={row.payout} /></span> },
  { header: 'Открыта', field: 'opened_at', sortBy: 'alphanumeric', renderCell: row => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{fmtDate(row.opened_at)}</span> },
  { header: 'Закрыта', field: 'closed_at', sortBy: 'alphanumeric', renderCell: row => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{row.closed_at ? fmtDate(row.closed_at) : '—'}</span> },
];

const HISTORY_PAGE_SIZE = 30;

// Серверная пагинация: компонент сам запрашивает у бэкенда ровно ту страницу закрытых позиций,
// которую показывает (см. GET /api/satoshi/history?page=&pageSize=) — вместо того чтобы держать
// на фронте всю историю (у активно торгующего флота — тысячи строк) и резать её на страницы
// локально. `refreshSignal` — родитель увеличивает счётчик, когда что-то могло измениться
// (WS positions-changed, ручное закрытие, кнопка "Обновить"), чтобы перезапросить ТУ ЖЕ страницу
// заново (вдруг туда попала новая запись), не трогая процесс пролистывания пользователем.
// Обёрнуто в React.memo — DataTable сам не мемоизирован, а родитель перерендеривается на каждый
// тик курса; без этой обёртки таблица закрытых позиций пересобиралась бы каждую секунду.
const ClosedPositionsTable = memo(function ClosedPositionsTable({ page, onPageChange, refreshSignal }: {
  page: number; onPageChange: (page: number) => void; refreshSignal: number;
}) {
  const [rows, setRows] = useState<SatoshiHistoryPosition[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.satoshiHistory(page, HISTORY_PAGE_SIZE).then(d => {
      if (cancelled) return;
      if (d.ok) { setRows(d.history); setTotal(d.total); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, refreshSignal]);

  return (
    <Table.Container>
      {loading && rows.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>
      ) : total === 0 ? (
        <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}><Text>Нет закрытых позиций</Text></Box>
      ) : (
        // сортировка по колонке действует только внутри текущей страницы (сама страница уже
        // отсортирована по closed_at DESC на сервере) — сортировка по всей истории потребовала бы
        // ORDER BY на бэкенде по выбранной колонке, не делаем это ради второстепенного удобства
        <DataTable
          aria-labelledby="satoshi-closed-table"
          data={rows}
          initialSortColumn="closed_at"
          initialSortDirection="DESC"
          columns={CLOSED_POSITIONS_COLUMNS}
        />
      )}
      {total > HISTORY_PAGE_SIZE && (
        <Table.Pagination
          aria-label="Страницы закрытых позиций"
          pageSize={HISTORY_PAGE_SIZE}
          totalCount={total}
          defaultPageIndex={page}
          onChange={({ pageIndex }) => onPageChange(pageIndex)}
        />
      )}
    </Table.Container>
  );
});

// ── Основная страница ─────────────────────────────────────────────────────────

export function SatoshiTower() {
  const [timeframe, setTimeframe] = useState<SatoshiTimeframe>('1h');
  const [exCandles, setExCandles] = useState<SatoshiCandle[]>([]);
  const [exLive, setExLive] = useState<SatoshiCandle | null>(null);
  const [exPrice, setExPrice] = useState({ price: 0, change_percent: 0 });
  // курс игры — только текущая цена (для верхнего тикера и линии поверх биржевого графика,
  // см. SatoshiChart gamePrice), отдельный график игры убран — свечи игры больше не нужны
  const [gamePrice, setGamePrice] = useState({ price: 0, change_percent: 0 });

  const [config, setConfig] = useState<SatoshiConfig | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [maxLevByAccount, setMaxLevByAccount] = useState<Record<number, number>>({}); // per-account макс. плечо (политика)

  const [openRows, setOpenRows] = useState<SatoshiOpenPosition[]>([]);
  const [historyPage, setHistoryPage] = useState(0); // серверная пагинация закрытых позиций — см. ClosedPositionsTable
  // родитель бампает это число, когда закрытые позиции МОГЛИ измениться (WS-событие, ручное
  // закрытие, кнопка "Обновить") — ClosedPositionsTable перезапрашивает свою текущую страницу
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);
  const [dailyProfit, setDailyProfit] = useState(0);
  const [weeklyProfit, setWeeklyProfit] = useState(0);
  const [pendingRows, setPendingRows] = useState<SatoshiPendingOrder[]>([]);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [cancelling, setCancelling] = useState<Set<number>>(new Set());
  const [tpSlModal, setTpSlModal] = useState<SatoshiOpenPosition | null>(null);
  const [newPosModal, setNewPosModal] = useState(false);
  const [tablesRefreshing, setTablesRefreshing] = useResumableRefresh('refresh:satoshi', () => { loadOpen(true); loadProfitSummary(); refreshHistory(); });
  const [showPosLines, setShowPosLines] = useState(true); // накладывать уровни позиций на график

  const [loading, setLoading] = useState(true);
  const { flash, showFlash } = useFlash();

  // открытые позиции + условные ордера — маленькие, живые данные, отдельно от закрытых (см.
  // ClosedPositionsTable — сама тянет свою страницу) и от прибыли (см. loadProfitSummary — готовый
  // агрегат из БД, без самих строк истории)
  const loadOpen = async (silent = false) => {
    if (!silent) setTablesRefreshing(true);
    try {
      const [d, p] = await Promise.all([api.satoshiOpenPositions(), api.satoshiPending()]);
      if (d.ok) setOpenRows(d.open); else showFlash(d.error ?? 'Ошибка загрузки', false);
      if (p.ok) setPendingRows(p.orders);
    } catch (e) { showFlash(String(e), false); }
    finally { setTablesRefreshing(false); }
  };

  const loadProfitSummary = async () => {
    try {
      const d = await api.satoshiProfitSummary();
      if (d.ok) { setDailyProfit(d.daily); setWeeklyProfit(d.weekly); }
      else console.warn('[satoshi] profit-summary:', d.error);
    } catch (e) { console.warn('[satoshi] profit-summary:', e); }
  };

  // просит ClosedPositionsTable перезапросить текущую страницу (что-то могло измениться)
  const refreshHistory = () => setHistoryRefreshSignal(s => s + 1);

  const positionsChangedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (positionsChangedTimer.current) clearTimeout(positionsChangedTimer.current); }, []);

  // курс/свечи ОБОИХ источников — только пока открыта эта страница (см. useSatoshiFeed).
  // positions-changed — толкает бэкенд сразу при открытии/закрытии (в т.ч. авто по TP/SL) —
  // таблицы обновляются сами, без ожидания опроса и без перезагрузки страницы.
  // Тик курса биржи (~раз в секунду) обновляет exPrice БЕЗ троттлинга — колонки обеих таблиц
  // вынесены в модульную константу/useMemo (см. CLOSED_POSITIONS_COLUMNS и openColumns выше/ниже),
  // поэтому на каждый тик реально пересчитываются только график (через chartPositions, отдельно
  // мемоизированный) и таблица открытых позиций (её data и должна жить — там live PnL); таблица
  // закрытых позиций получает ту же ссылку на data/columns и не перерисовывается зря.
  useSatoshiFeed({
    sources: ['exchange', 'game'],
    onTick: (source, p) => {
      if (source === 'exchange') setExPrice({ price: p.price, change_percent: p.change_percent });
      else setGamePrice({ price: p.price, change_percent: p.change_percent });
    },
    onCandle: (source, tf, candle) => {
      if (tf !== timeframe || source !== 'exchange') return;
      setExLive(candle);
    },
    // закрытие (ручное или авто по TP/SL/ордеру) меняет баланс — бэкенд пишет new_balance в БД
    // (applyBalance), поэтому лёгким перечитыванием подтягиваем свежий баланс во фронт (в т.ч.
    // в открытую модалку новой позиции — она получает accounts пропом).
    // Событие приходит по WS на КАЖДОЕ закрытие/открытие ЛЮБОГО аккаунта БОТА (в т.ч. чужого
    // авто-закрытия по TP/SL, не только вашего) — раньше это дёргало api.accounts(), тянущий ВЕСЬ
    // флот (десятки аккаунтов) ради баланса одного изменившегося. Событие несёт имя аккаунта —
    // обновляем точечно только его (см. api.accountById), а не всех разом. Дебаунс остаётся —
    // если события идут пачкой (несколько авто-закрытий подряд), не дёргаем на каждое отдельно.
    onPositionsChanged: (account) => {
      if (positionsChangedTimer.current) clearTimeout(positionsChangedTimer.current);
      positionsChangedTimer.current = setTimeout(() => {
        loadOpen(true); loadAccountBalance(account); loadProfitSummary(); refreshHistory();
      }, 800);
    },
  });

  const loadCandles = useCallback(async (tf: SatoshiTimeframe) => {
    try {
      const ex = await api.satoshiCandles(tf, 300, 'exchange');
      if (ex.ok) setExCandles(ex.candles);
    } catch (e) { showFlash(String(e), false); }
  }, [showFlash]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [cfg, accs, exP, gameP] = await Promise.all([
          api.satoshiConfig(), api.accounts(), api.satoshiPrice('exchange'), api.satoshiPrice('game'),
        ]);
        if (cfg.ok) setConfig(cfg.config);
        if (accs.ok) setAccounts(accs.accounts.filter(a => a.hasToken && a.buildings?.includes('satoshi')));
        if (exP.ok) setExPrice({ price: exP.price, change_percent: exP.change_percent });
        if (gameP.ok) setGamePrice({ price: gameP.price, change_percent: gameP.change_percent });
        // закрытые позиции грузит сама ClosedPositionsTable при монтировании (page=0) — сюда её
        // не включаем
        await Promise.all([loadCandles(timeframe), loadOpen(true), loadProfitSummary()]);
        // per-account макс. плечо (политика на плечо 20× и т.п.) — грузим отдельно, не блокируя UI
        api.satoshiLeverageLimits().then(d => { if (d.ok) setMaxLevByAccount(d.limits); }).catch(() => {});
      } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setExLive(null); loadCandles(timeframe); }, [timeframe, loadCandles]);

  // основное обновление — событие positions-changed по WS (см. выше), это лишь подстраховка
  // на случай обрыва соединения, поэтому интервал не частый
  useEffect(() => {
    const t = setInterval(() => { loadOpen(true); loadProfitSummary(); refreshHistory(); }, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // useCallback (не пересоздаётся каждый рендер) — нужен стабильной ссылкой в useMemo колонок
  // открытых позиций ниже, иначе колонки пересоздавались бы на каждый тик курса вместе с ним
  const closePosition = useCallback(async (p: SatoshiOpenPosition) => {
    if (!p.account_id) return;
    setClosing(prev => new Set(prev).add(p.id));
    try {
      const r = await api.satoshiClose(p.account_id, p.id);
      if (r.ok) {
        showFlash('Позиция закрыта', true);
        await loadOpen(true); loadAccountBalance(p.account); loadProfitSummary(); refreshHistory();
      } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClosing(prev => { const s = new Set(prev); s.delete(p.id); return s; }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelPending = async (o: SatoshiPendingOrder) => {
    setCancelling(prev => new Set(prev).add(o.id));
    try {
      const r = await api.satoshiCancelPending(o.id);
      if (r.ok) { showFlash('Ордер отменён', true); await loadOpen(true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setCancelling(prev => { const s = new Set(prev); s.delete(o.id); return s; }); }
  };

  const refreshAll = async () => {
    setTablesRefreshing(true);
    try {
      await api.refresh('satoshi');
      await loadOpen(true); loadProfitSummary(); refreshHistory();
      showFlash('Обновлено', true);
    } catch (e) { showFlash(String(e), false); }
    finally { setTablesRefreshing(false); }
  };

  // перечитать аккаунты (балансы) в стейт — БЕЗ перезагрузки страницы. Раньше refreshBalances
  // обновлял только БД и не тянул свежие данные во фронт, поэтому «иногда нужно перезагрузить».
  const loadAccounts = useCallback(async () => {
    const accs = await api.accounts();
    if (accs.ok) setAccounts(accs.accounts.filter(a => a.hasToken && a.buildings?.includes('satoshi')));
  }, []);

  // точечное обновление баланса ОДНОГО аккаунта по имени из WS-события positions-changed — вместо
  // loadAccounts() (весь флот) ради баланса одного изменившегося. Если аккаунт не наш/не в списке
  // (не Satoshi Tower) — тихо ничего не делаем.
  // Читает accounts через ref, а не напрямую из замыкания: closePosition вызывает эту функцию из
  // useCallback с пустыми deps (нужна стабильная ссылка для колонок таблицы) — без ref замыкание
  // навсегда застряло бы на пустом accounts[] из самого первого рендера.
  const accountsRef = useRef<Account[]>(accounts);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);
  const loadAccountBalance = useCallback(async (name: string) => {
    const match = accountsRef.current.find(a => a.name === name);
    if (!match) return;
    try {
      const r = await api.accountById(match.id);
      if (r.ok) setAccounts(prev => prev.map(a => a.id === r.account.id ? r.account : a));
    } catch (_e) { /* фоновое обновление баланса — не критично, тихо пропускаем */ }
  }, []);

  const [balanceRefreshing, setBalanceRefreshing] = useResumableRefresh('satoshiRefreshBalances', () => loadAccounts());
  const refreshBalances = useCallback(async () => {
    setBalanceRefreshing(true);
    try {
      const r = await api.satoshiRefreshBalances();
      if (r.ok) { await loadAccounts(); showFlash(`Баланс обновлён: ${r.updated}/${r.total}`, true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBalanceRefreshing(false); }
  }, [loadAccounts, showFlash]);

  // Цена ДЛЯ ТАБЛИЦЫ — троттлится до 2с, тогда как заголовок и график продолжают жить на каждом
  // тике (~1/с). Пересчёт PnL сам по себе дешёвый, дорог его побочный эффект: новая ссылка на
  // openData заставляет DataTable перерисовать все открытые позиции — это сотни ячеек с
  // компонентами Primer. Раз в 2с для индикатора нереализованного PnL достаточно, а нагрузка
  // на главный поток падает вдвое (и ещё сильнее — вместе с переводом иконок валют на <img>,
  // см. components/Icons.tsx).
  const priceRef = useRef(exPrice.price);
  priceRef.current = exPrice.price;
  const [tablePrice, setTablePrice] = useState(exPrice.price);
  useEffect(() => {
    const id = setInterval(() => setTablePrice(prev => (prev === priceRef.current ? prev : priceRef.current)), 2000);
    return () => clearInterval(id);
  }, []);

  // useMemo не убирает работу на тик (цена меняется каждый тик — PnL и должен обновляться), но
  // даёт стабильную ссылку на массив в остальные разы (например, когда меняется что-то другое,
  // не связанное с ценой) и не пересоздаёт объекты без необходимости
  const openData = useMemo(() => openRows.map(p => {
    const { pnl, pnlPct, breakeven } = calcPnl(p.entry_price, p.notional, p.margin, p.side, tablePrice, config);
    return { ...p, _pnl: pnl, _pnlPct: pnlPct, _breakeven: breakeven };
  }), [openRows, tablePrice, config]);
  type OpenRow = (typeof openData)[number];

  // колонки открытых позиций — мемоизированы отдельно от строк: сами cell-рендеры читают live PnL
  // из row (обновляется каждый тик так и должно), а вот массив колонок пересоздавать на каждый тик
  // не нужно — иначе DataTable считает это "новой таблицей" и заново обсчитывает вообще всё
  const openColumns: Column<OpenRow>[] = useMemo(() => [
    { header: 'Аккаунт', field: 'account', rowHeader: true, sortBy: 'alphanumeric', renderCell: row => <strong>{row.account}</strong> },
    { header: 'Сторона', field: 'side', sortBy: 'alphanumeric', renderCell: row => <Label variant={row.side === 'long' ? 'success' : 'danger'}>{row.side === 'long' ? 'Лонг' : 'Шорт'}</Label> },
    { header: 'Плечо', field: 'leverage', sortBy: 'basic', renderCell: row => <span className="mono">{row.leverage}×</span> },
    { header: 'Маржа', field: 'margin', sortBy: 'basic', renderCell: row => <span className="mono"><Cr n={row.margin} /></span> },
    { header: 'Размер', field: 'notional', sortBy: 'basic', renderCell: row => <span className="mono"><Cr n={row.notional} /></span> },
    { header: 'Вход', field: 'entry_price', sortBy: 'basic', renderCell: row => <span className="mono">${row.entry_price?.toFixed(3)}</span> },
    { header: 'Безубыток', field: '_breakeven', sortBy: 'basic', renderCell: row => <span className="mono" style={{ color: 'var(--fg-muted)' }}>${row._breakeven.toFixed(3)}</span> },
    { header: 'Ликв.', field: 'liquidation_price', sortBy: 'basic', renderCell: row => <span className="mono" style={{ color: 'var(--red)' }}>${row.liquidation_price?.toFixed(3)}</span> },
    {
      header: 'PnL', field: '_pnl', sortBy: 'basic',
      renderCell: row => <span className="mono" style={{ color: row._pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{row._pnl >= 0 ? '+' : ''}{fmt(row._pnl)} ({row._pnlPct >= 0 ? '+' : ''}{row._pnlPct.toFixed(1)}%)</span>,
    },
    { header: 'TP/SL', field: 'tp_price', sortBy: 'basic', renderCell: row => <TpSlBadge p={row} /> },
    { header: 'Открыта', field: 'opened_at', sortBy: 'alphanumeric', renderCell: row => <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{fmtDate(row.opened_at)}</span> },
    {
      header: 'Действия', field: 'id', sortBy: 'basic', align: 'end',
      renderCell: row => (
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button leadingVisual={GearIcon} onClick={() => setTpSlModal(row)}>TP/SL</Button>
          <Button variant="danger" leadingVisual={XCircleIcon} loading={closing.has(row.id)} disabled={closing.has(row.id) || !row.account_id} onClick={() => closePosition(row)}>Закрыть</Button>
        </Box>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [closing, closePosition]);

  // сколько открытых позиций у каждого аккаунта (для лимита max_open_positions в модалках) — не
  // зависит от цены, но раньше пересоздавался на каждый рендер (в т.ч. на каждый тик курса) и новой
  // ссылкой уходил пропом в закрытые модалки; мемоизируем по openRows
  const maxOpen = config?.max_open_positions ?? 5;
  const openCountByAccount = useMemo(() => {
    const m: Record<number, number> = {};
    for (const p of openRows) if (p.account_id != null) m[p.account_id] = (m[p.account_id] ?? 0) + 1;
    return m;
  }, [openRows]);

  // открытые позиции для графика (заливка зон вход→TP/SL + дедуп линий делает сам компонент графика).
  // Мемоизируем по ключу из позиций, чтобы не пересобирать на каждый тик курса. TP/SL, заданные как
  // ROI%, переводим в цену (с учётом плеча и комиссии закрытия). Сам ключ тоже не зависит от цены —
  // строим его через useMemo, чтобы не гонять .map()/.join() по openRows на каждый тик
  const posLinesKey = useMemo(
    () => openRows.map(p => `${p.id}:${p.entry_price}:${p.tp_price ?? ''}:${p.tp_pnl_pct ?? ''}:${p.sl_price ?? ''}:${p.sl_pnl_pct ?? ''}:${p.liquidation_price ?? ''}`).join('|'),
    [openRows],
  );
  // золотой угол 137.5° даёт максимально различимые оттенки для соседних позиций
  const posHue = (i: number) => Math.round((i * 137.508) % 360);
  const chartPositions = useMemo<ChartPosition[]>(() => {
    if (!showPosLines) return [];
    return openRows.map((p, i) => ({
      id: p.id, side: p.side, entry: p.entry_price, liq: p.liquidation_price, hue: posHue(i),
      tp: p.tp_price ?? (p.tp_pnl_pct != null ? priceForPnlPct(p.entry_price, p.notional, p.margin, p.side, p.tp_pnl_pct, config) : null),
      sl: p.sl_price ?? (p.sl_pnl_pct != null ? priceForPnlPct(p.entry_price, p.notional, p.margin, p.side, -p.sl_pnl_pct, config) : null),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posLinesKey, showPosLines, config]);

  // дневной/недельный профит теперь — готовый агрегат из БД (см. loadProfitSummary), а не цикл по
  // historyRows на фронте: закрытых позиций может быть тысячи, а фронт больше не держит их все
  // разом (см. ClosedPositionsTable — серверная пагинация).

  // сводка по открытым позициям: число, суммарная маржа, суммарный размер (с плечом) и расчётная
  // прибыль, если у позиций сработает их TP (roi% → margin·%, либо целевой курс → calcPnl).
  // Маржа/размер/TP-прибыль зависят от margin/notional/tp_price самих позиций, а НЕ от текущей
  // цены — раньше пересчитывались на каждый тик вместе с PnL, хотя меняются только когда меняются
  // сами openRows. openPnlSum отдельно — он единственный реально должен обновляться каждый тик.
  const { openMarginSum, openNotionalSum, openTpProfit } = useMemo(() => {
    let margin = 0, notional = 0, tpProfit = 0;
    for (const p of openRows) {
      margin += p.margin ?? 0;
      notional += p.notional ?? 0;
      if (p.tp_pnl_pct != null) tpProfit += p.margin * (p.tp_pnl_pct / 100);
      else if (p.tp_price != null) tpProfit += calcPnl(p.entry_price, p.notional, p.margin, p.side, p.tp_price, config).pnl;
    }
    return { openMarginSum: margin, openNotionalSum: notional, openTpProfit: tpProfit };
  }, [openRows, config]);
  const openPnlSum = openData.reduce((s, p) => s + (p._pnl ?? 0), 0); // текущий нереализованный PnL по всем позициям — должен считаться каждый тик

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Башня Сатоши</Heading>
        <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Биржа</Text>
            <Text className="mono" sx={{ fontSize: 3, fontWeight: 'bold' }}>${exPrice.price ? exPrice.price.toFixed(3) : '—'}</Text>
            {!!exPrice.price && <Text className="mono" sx={{ fontSize: 1, color: exPrice.change_percent >= 0 ? 'success.fg' : 'danger.fg', fontWeight: 'bold' }}>{exPrice.change_percent >= 0 ? '+' : ''}{exPrice.change_percent.toFixed(2)}%</Text>}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Игра</Text>
            <Text className="mono" sx={{ fontSize: 3, fontWeight: 'bold' }}>${gamePrice.price ? gamePrice.price.toFixed(3) : '—'}</Text>
            {!!gamePrice.price && <Text className="mono" sx={{ fontSize: 1, color: gamePrice.change_percent >= 0 ? 'success.fg' : 'danger.fg', fontWeight: 'bold' }}>{gamePrice.change_percent >= 0 ? '+' : ''}{gamePrice.change_percent.toFixed(2)}%</Text>}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Профит 24ч</Text>
            <Text className="mono" sx={{ fontSize: 2, fontWeight: 'bold', color: dailyProfit >= 0 ? 'success.fg' : 'danger.fg' }}><SignedCr n={dailyProfit} /></Text>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Профит 7д</Text>
            <Text className="mono" sx={{ fontSize: 2, fontWeight: 'bold', color: weeklyProfit >= 0 ? 'success.fg' : 'danger.fg' }}><SignedCr n={weeklyProfit} /></Text>
          </Box>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <ButtonGroup>
          {TIMEFRAMES.map(tf => (
            <Button key={tf.value} variant={timeframe === tf.value ? 'primary' : 'default'} onClick={() => setTimeframe(tf.value)}>{tf.label}</Button>
          ))}
        </ButtonGroup>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setNewPosModal(true)}>Новая позиция</Button>
        </Box>
      </Box>

      <Box sx={{ mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: 1, flexWrap: 'wrap' }}>
          <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>Реальные биржи (Binance/OKX/KuCoin)</Text>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 14, height: 0, borderTop: '2px dashed #8250df' }} />
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>— курс игры</Text>
          </Box>
          {openRows.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <Checkbox checked={showPosLines} onChange={() => setShowPosLines(v => !v)} />
              Позиции на графике
            </label>
          )}
        </Box>
        {showPosLines && openRows.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>
              Каждая позиция своим цветом (зона = коридор TP↔SL). Линии: — вход, - - TP/SL, ·· ликвидация.
            </Text>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
              {openRows.map((p, i) => (
                <Box key={p.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 0 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: 2, flexShrink: 0 }} style={{ background: `hsl(${posHue(i)}, 68%, 45%)` }} />
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{p.account} {p.side === 'long' ? 'Лонг' : 'Шорт'}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, bg: 'canvas.default' }}>
          <SatoshiChart key={`exchange-${timeframe}`} candles={exCandles} liveCandle={exLive} gamePrice={gamePrice.price || null} positions={chartPositions} height={440} />
        </Box>
      </Box>

      {pendingRows.length > 0 && (
        <>
          <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>Ордера по цене</Heading>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px', mb: 4 }}>
            {pendingRows.map(o => (
              <Box key={o.id} sx={{ display: 'flex', alignItems: 'center', gap: 3, p: 2, border: '1px solid', borderColor: 'border.default', borderRadius: 2, flexWrap: 'wrap' }}>
                <Text sx={{ fontWeight: 'bold', minWidth: 100 }}>{o.account}</Text>
                <Label variant={o.side === 'long' ? 'success' : 'danger'}>{o.side === 'long' ? 'Лонг' : 'Шорт'}</Label>
                <Text sx={{ fontSize: 1 }}>{o.leverage}× · <Cr n={o.margin} /></Text>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>цель: <span className="mono">${o.trigger_price.toFixed(3)}</span></Text>
                {o.status !== 'pending' && <Label variant={o.status === 'failed' ? 'danger' : 'default'}>{o.status}</Label>}
                <Box sx={{ flex: 1 }} />
                <Button variant="danger" loading={cancelling.has(o.id)} disabled={cancelling.has(o.id) || (o.status !== 'pending' && o.status !== 'failed')} onClick={() => cancelPending(o)}>Отменить</Button>
              </Box>
            ))}
          </Box>
        </>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap' }}>
          <Heading as="h3" id="satoshi-open-table" sx={{ fontSize: 2 }}>Открытые позиции</Heading>
          {openRows.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 3, fontSize: 1, flexWrap: 'wrap' }}>
              <Text sx={{ color: 'fg.muted' }}>Позиций: <Text as="span" sx={{ color: 'fg.default', fontWeight: 'bold' }}>{openRows.length}</Text></Text>
              <Text sx={{ color: 'fg.muted' }}>Маржа: <Text as="span" className="mono" sx={{ color: 'fg.default', fontWeight: 'bold' }}><Cr n={openMarginSum} /></Text></Text>
              <Text sx={{ color: 'fg.muted' }}>Размер: <Text as="span" className="mono" sx={{ color: 'fg.default', fontWeight: 'bold' }}><Cr n={openNotionalSum} /></Text></Text>
              <Text sx={{ color: 'fg.muted' }}>Текущий PnL: <Text as="span" className="mono" sx={{ color: openPnlSum >= 0 ? 'success.fg' : 'danger.fg', fontWeight: 'bold' }}><SignedCr n={openPnlSum} /></Text></Text>
              <Text sx={{ color: 'fg.muted' }}>Прибыль с TP: <Text as="span" className="mono" sx={{ color: openTpProfit >= 0 ? 'success.fg' : 'danger.fg', fontWeight: 'bold' }}><SignedCr n={openTpProfit} /></Text></Text>
            </Box>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button loading={balanceRefreshing} disabled={balanceRefreshing} onClick={refreshBalances}>Обновить баланс</Button>
          <Button leadingVisual={SyncIcon} loading={tablesRefreshing} disabled={tablesRefreshing} onClick={refreshAll}>Обновить</Button>
        </Box>
      </Box>
      <Table.Container sx={{ mb: 4 }}>
        {openData.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}><Text>Нет открытых позиций</Text></Box>
        ) : (
          <DataTable
            aria-labelledby="satoshi-open-table"
            data={openData}
            initialSortColumn="opened_at"
            initialSortDirection="DESC"
            columns={openColumns}
          />
        )}
      </Table.Container>

      <Heading as="h3" id="satoshi-closed-table" sx={{ fontSize: 2, mb: 2 }}>Закрытые позиции</Heading>
      <ClosedPositionsTable page={historyPage} onPageChange={setHistoryPage} refreshSignal={historyRefreshSignal} />

      {tpSlModal && <TpSlModal position={tpSlModal} onClose={() => setTpSlModal(null)} onSaved={() => { setTpSlModal(null); loadOpen(true); }} />}
      {newPosModal && <NewPositionModal config={config} accounts={accounts} price={exPrice.price} openCountByAccount={openCountByAccount} maxOpen={maxOpen} maxLevByAccount={maxLevByAccount} onRefreshBalances={refreshBalances} balanceRefreshing={balanceRefreshing} onClose={() => setNewPosModal(false)} onOpened={() => { setNewPosModal(false); loadOpen(true); }} />}
    </Box>
  );
}
