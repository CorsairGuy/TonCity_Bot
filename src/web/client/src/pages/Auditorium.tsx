import { useEffect, useState } from 'react';
import { Box, Button, Flash, Text, TextInput, ProgressBar, UnderlineNav, ConfirmationDialog } from '@primer/react';
import { SyncIcon, LockIcon, CheckCircleIcon } from '@primer/octicons-react';
import { api, type AuditoriumStatus, type AuditoriumSku, type AuditoriumTier, type AuditoriumGate, type AuditoriumSummaryRow } from '../api';
import { ITEMS_BY_ID, itemImgSrc, fmt, fmtInt } from '../utils';
import { RenownValue } from '../components/Icons';
import { PageHeader } from '../components/PageHeader';
import { LoadError } from '../components/LoadError';
import { SidePage, CatTabs, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row, Summary, Tile, Val, Caption, Empty, fillOf, FILL_DONE, FILL_WIP } from './cityMapPanels';
import { useItemCatalog, itemName, type CatalogItem } from '../hooks/useItemCatalog';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

// Вечный аудиториум: справа аккаунты с их Почётом, слева магазин выбранного аккаунта.
// Карточка товара — как раньше (название, лимит, кнопка с ценой), а сам предмет — карточкой склада.
// Данные — снимки из БД; игру спрашивают только «Обновить с игры» и покупка.

const GATE_LABEL: Record<string, string> = {
  renown: 'Заработанный Почёт (за всё время в гильдии)',
  loyalty: 'Верность гильдии (дней в текущей гильдии)',
  population: 'Население города (до Квантовой лиги)',
};
const TIER_NAME: Record<string, string> = { foyer: 'Фойе', gallery: 'Галерея', vault: 'Хранилище' };
const SECTION_NAME: Record<string, string> = {
  shards: 'Осколки', mysteries: 'Тайные политики', packs: 'Наборы политик',
  boosters: 'Ускорители', consumables: 'Уникальные артефакты',
};
const PERIOD_NAME: Record<number, string> = { 1: 'день', 7: 'неделю', 30: 'месяц' };
const ROMAN = ['I', 'II', 'III'];
const tierName = (t?: string | null) => t ? TIER_NAME[t] ?? t : '';

function resetIn(iso: string | null): string {
  const ms = iso ? new Date(iso).getTime() - Date.now() : 0;
  if (ms <= 0) return 'скоро сброс';
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return `сброс через ${d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`}`;
}
const tagFor = (id: number, catalog: Map<number, CatalogItem>) => ITEMS_BY_ID[id]?.tag ?? catalog.get(id)?.tag ?? '';

// предмет карточкой склада: 77px коробка с цветом редкости, масштаб иконки, синий счётчик, красный замок
function StoreItem({ sku, catalog, locked }: { sku: AuditoriumSku; catalog: Map<number, CatalogItem>; locked?: boolean }) {
  const tag = tagFor(sku.item_id, catalog);
  return (
    <div className="item-card"><div className={`item-card__box ic-${tag}`}>
      {tag && <img className="item-card__img" src={itemImgSrc(tag)} alt="" style={{ scale: String((ITEMS_BY_ID[sku.item_id] as { scale?: number } | undefined)?.scale ?? 1) }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
      {sku.quantity > 1 && <span className="item-card__count">{sku.quantity}</span>}
      {locked && <span className="item-card__locked"><LockIcon size={12} /></span>}
    </div></div>
  );
}

function SkuCard({ sku, balance, tiers, catalog, onBuy }: { sku: AuditoriumSku; balance: number; tiers: AuditoriumTier[]; catalog: Map<number, CatalogItem>; onBuy: () => void }) {
  const lim = sku.limits;
  const locked = !sku.tier_met;
  const spent = !!lim && lim.remaining <= 0;
  const poor = balance < sku.renown;
  const can = sku.purchasable && !poor;
  const tn = tierName(tiers.find(t => t.threshold === sku.min_lifetime_renown)?.tier);
  const sub = locked ? (tn ? `зал «${tn}»` : 'нужен зал выше')
    : spent ? resetIn(lim!.resets_at)
    : lim ? `${lim.used} из ${lim.limit} за ${PERIOD_NAME[lim.limit_days] ?? `${lim.limit_days} дн.`}` : 'без лимита';
  return (
    <Box sx={{ borderRadius: '12px', bg: 'canvas.subtle', p: 2, pt: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, opacity: locked ? 0.55 : 1 }}>
      <StoreItem sku={sku} catalog={catalog} locked={locked} />
      <Text sx={{ fontWeight: 'semibold', fontSize: 1, textAlign: 'center', lineHeight: '18px' }}>{itemName(sku.item_id, catalog)}</Text>
      <Text sx={{ fontSize: 0, color: spent ? 'attention.fg' : 'fg.muted', textAlign: 'center' }}>{sub}</Text>
      <Button size="small" block variant={can ? 'primary' : 'default'} disabled={!can} onClick={onBuy} sx={{ mt: 'auto' }}
        title={!locked && !spent && poor ? `Не хватает ${fmt(sku.renown - balance)} Почёта` : undefined}>
        <RenownValue value={fmt(sku.renown)} />
      </Button>
    </Box>
  );
}

function GateRow({ k, gate }: { k: string; gate: AuditoriumGate | null }) {
  if (!gate) return null;
  const pct = gate.required > 0 ? Math.min(100, gate.current / gate.required * 100) : 100;
  return <Row fill={fillOf([[gate.met ? FILL_DONE : FILL_WIP, pct]])} lead={gate.met ? <CheckCircleIcon size={16} /> : <LockIcon size={16} />}
    title={GATE_LABEL[k] ?? k} trail={<Val color={gate.met ? 'success.fg' : 'fg.default'}>{fmt(gate.current)} / {fmt(gate.required)}</Val>} />;
}

function Shop({ accId, accName, data, onBought, onFlash }: { accId: number; accName: string; data: AuditoriumStatus; onBought: () => void; onFlash: (m: string, ok: boolean) => void }) {
  const c = data.catalog!;
  const sections = c.sections ?? [];
  const [sec, setSec] = useState(0);
  const [selected, setSelected] = useState<AuditoriumSku | null>(null);
  const catalog = useItemCatalog(sections.flatMap(s => s.skus.map(k => k.item_id)).filter(id => !ITEMS_BY_ID[id]));
  const tiers = c.tiers ?? [];
  const next = tiers.find(t => !t.reached);
  const buy = async (sku: AuditoriumSku) => {
    const r = await api.auditoriumBuy(accId, sku.code);
    if (r.ok) { onFlash(`${accName}: куплено «${itemName(sku.item_id, catalog)}»${sku.quantity > 1 ? ` ×${sku.quantity}` : ''}`, true); onBought(); }
    else onFlash(`${accName}: ${r.error ?? 'ошибка покупки'}`, false);
  };
  const shown = sec === 0 ? sections : [sections[sec - 1]].filter(Boolean);
  return (
    <>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Box sx={{ flex: '1 1 180px', borderRadius: '12px', p: 3, bg: 'canvas.subtle' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Баланс</Text>
          <Text sx={{ fontSize: 4, fontWeight: 'bold' }}><RenownValue value={fmtInt(c.balance)} /></Text>
        </Box>
        <Box sx={{ flex: '1 1 180px', borderRadius: '12px', p: 3, bg: 'canvas.subtle' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Заработано всего</Text>
          <Text sx={{ fontSize: 4, fontWeight: 'bold' }}>{fmt(c.lifetime_earned)}</Text>
        </Box>
        <Box sx={{ flex: '2 1 280px', borderRadius: '12px', p: 3, bg: 'canvas.subtle' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{next ? `До зала «${tierName(next.tier)}»` : 'Все залы открыты'}</Text>
            {next && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{fmt(c.lifetime_earned)} / {fmt(next.threshold)}</Text>}
          </Box>
          <Text sx={{ fontSize: 4, fontWeight: 'bold', color: next ? 'fg.default' : 'success.fg', display: 'block' }}>
            {next ? fmt(Math.max(0, next.threshold - c.lifetime_earned)) : tierName(tiers[tiers.length - 1]?.tier)}
          </Text>
          {next && <ProgressBar progress={next.threshold > 0 ? Math.min(100, c.lifetime_earned / next.threshold * 100) : 100} barSize="small" />}
        </Box>
      </Box>
      {sections.length > 0 && (
        <UnderlineNav aria-label="Разделы аудиториума" sx={{ mb: 3 }}>
          {[{ key: '', skus: sections.flatMap(s => s.skus) }, ...sections].map((s, i) => (
            <UnderlineNav.Item key={s.key || 'all'} href="#" aria-current={i === sec ? 'page' : undefined} counter={s.skus.length}
              onSelect={e => { e.preventDefault(); setSec(i); }}>{i === 0 ? 'Все' : SECTION_NAME[s.key] ?? s.key}</UnderlineNav.Item>
          ))}
        </UnderlineNav>
      )}
      {!sections.length && <Text sx={{ color: 'fg.muted' }}>Витрина пуста.</Text>}
      {shown.map(s => (
        <Box key={s.key} sx={{ mb: 3 }}>
          <Caption right={s.skus.length}>{SECTION_NAME[s.key] ?? s.key}</Caption>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 2, mt: 2 }}>
            {s.skus.map(k => <SkuCard key={k.code} sku={k} balance={c.balance} tiers={tiers} catalog={catalog} onBuy={() => setSelected(k)} />)}
          </Box>
        </Box>
      ))}
      {selected && (
        <ConfirmationDialog title="Обменять Почёт на предмет?" cancelButtonContent="Отмена" confirmButtonContent="Подтвердить покупку"
          onClose={g => { const k = selected; setSelected(null); if (g === 'confirm') buy(k); }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: 3 }}>
            <StoreItem sku={selected} catalog={catalog} />
            <Text sx={{ fontWeight: 'bold' }}>{itemName(selected.item_id, catalog)}{selected.quantity > 1 ? ` ×${selected.quantity}` : ''}</Text>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}><Text sx={{ color: 'fg.muted' }}>Аккаунт</Text><Text>{accName}</Text></Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}><Text sx={{ color: 'fg.muted' }}>Цена</Text><RenownValue value={fmtInt(selected.renown)} /></Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Text sx={{ color: 'fg.muted' }}>Останется</Text><RenownValue value={fmtInt(c.balance - selected.renown)} /></Box>
        </ConfirmationDialog>
      )}
    </>
  );
}

export function Auditorium() {
  const [rows, setRows] = useState<AuditoriumSummaryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [data, setData] = useState<AuditoriumStatus | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(0);
  const { flash, showFlash } = useFlash();
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:auditorium', () => loadAll());

  const loadAll = async () => {
    const r = await api.auditoriumSummary();
    if (!r.ok) { setErr(r.error ?? 'Ошибка загрузки'); return; }
    setErr(null); setRows(r.accounts);
    setSel(s => s != null && r.accounts.some(a => a.id === s) ? s : [...r.accounts].sort((a, b) => (b.balance ?? -1) - (a.balance ?? -1))[0]?.id ?? null);
  };
  const loadOne = async (id: number) => {
    const r = await api.auditoriumStatus(id);
    if (r.ok) setData(r as AuditoriumStatus); else showFlash(r.error ?? 'Ошибка загрузки', false);
  };
  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (sel != null) { setData(null); loadOne(sel); } }, [sel]);
  const refresh = async () => {
    setRefreshing(true);
    const r = await api.refresh('auditorium');
    setRefreshing(false);
    await loadAll(); if (sel != null) loadOne(sel);
    showFlash(r.ok ? 'Обновлено с сервера игры' : 'Ошибка обновления', r.ok);
  };

  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={loadAll} /></Box>;
  const all = rows ?? [];
  const list = all.filter(a => a.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === 0 ? (b.balance ?? -1) - (a.balance ?? -1) : sort === 1 ? (b.lifetime ?? -1) - (a.lifetime ?? -1) : a.name.localeCompare(b.name));
  const acc = all.find(a => a.id === sel) ?? null;

  const side = (
    <PanelShell mode="view" title="Аккаунты" busy={rows == null}
      hint="Выберите аккаунт — слева откроется его магазин. Значок — открытый зал, «по карману» — сколько товаров можно купить сейчас."
      footer={<Button block leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить с игры</Button>}>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile size={2} value={<RenownValue value={fmt(all.reduce((s, a) => s + (a.balance ?? 0), 0))} />} label="Почёт на всех" />
          <Tile size={2} value={all.filter(a => a.affordable > 0).length} label="могут купить" color="success.fg" />
        </Box>
      </Summary>
      <TextInput placeholder="Поиск" value={q} onChange={e => setQ(e.target.value)} block />
      <CatTabs tabs={['Баланс', 'Всего', 'Имя']} value={sort} onChange={setSort} />
      {!all.length && <Empty>Нет аккаунтов, чья гильдия построила Аудиториум. Нажмите «Обновить с игры».</Empty>}
      {list.map(a => (
        <Row key={a.id} onClick={() => setSel(a.id)} sx={{ ...(a.id === sel ? SELECTED_RING : null), ...(a.unlocked ? null : { opacity: 0.6 }) }}
          lead={<Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: a.tier_index >= 2 ? 'done.emphasis' : a.tier_index >= 1 ? 'accent.emphasis' : 'neutral.emphasis', color: 'fg.onEmphasis', display: 'grid', placeItems: 'center', fontWeight: 'bold', fontSize: 0 }}>
            {a.unlocked ? ROMAN[Math.max(0, a.tier_index)] ?? '' : <LockIcon size={14} />}
          </Box>}
          title={a.name}
          sub={!a.updated_at ? 'нет снимка' : !a.unlocked ? 'нет входа' : a.affordable ? `по карману ${a.affordable}` : 'пока не хватает'}
          trail={a.balance != null ? <Val><RenownValue value={fmt(a.balance)} /></Val> : undefined} />
      ))}
    </PanelShell>
  );

  const main = (
    <>
      <PageHeader title="Аудиториум" sub={acc ? `${acc.name} · обмен Почёта на предметы` : undefined} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {!acc ? <Text sx={{ color: 'fg.muted' }}>Выберите аккаунт справа</Text>
        : !data ? <Text sx={{ color: 'fg.muted' }}>Загрузка…</Text>
        : !data.updated_at ? <Text sx={{ color: 'fg.muted' }}>Снимка ещё нет — нажмите «Обновить с игры»</Text>
        : data.unlocked && data.catalog ? <Shop key={acc.id} accId={acc.id} accName={acc.name} data={data} onBought={() => { loadOne(acc.id); loadAll(); }} onFlash={showFlash} />
        : (
          <Box sx={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {data.in_guild === false && <Flash>Аккаунт не в гильдии — вступите, чтобы открыть путь в Аудиториум.</Flash>}
            {data.in_guild !== false && data.has_auditorium === false && <Flash>Гильдия ещё не построила Вечный аудиториум.</Flash>}
            {data.unlocked && !data.catalog && <Flash variant="warning">Вход открыт, но витрину загрузить не удалось — нажмите «Обновить с игры».</Flash>}
            <Caption>Условия входа</Caption>
            <GateRow k="renown" gate={data.renown} />
            <GateRow k="loyalty" gate={data.loyalty} />
            <GateRow k="population" gate={data.population} />
            {!data.unlocked && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Выполните все условия, чтобы войти.</Text>}
          </Box>
        )}
      {data?.updated_at && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Снимок от {new Date(data.updated_at).toLocaleString('ru')}</Text>}
    </>
  );
  return <SidePage main={main} side={side} />;
}
