import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, ProgressBar, CounterLabel } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon, StarIcon } from '@primer/octicons-react';
import { api, type AnniversaryVault as Vault, type AnniversaryVaultSpinAllRow } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useItemCatalog, catalogItemName, type CatalogItem } from '../hooks/useItemCatalog';
import { ItemThumb } from '../components/ItemThumb';
import { TicketValue, fmtCountdown } from '../components/Ticket';

// «Хранилище призов» — открылось 15.08. Поле из 11 ячеек, каждая выигрывается ОДИН раз, цена
// следующего вращения растёт. Формы ответов сверены с бандлом (chunks/anniversary_vault-*):
//   GET  /anniversary-vault/     — состояние поля
//   POST /anniversary-vault/spin — вращение (списывает билеты)
//
// Есть и общая кнопка «Крутить всем» — по ОДНОМУ вращению на каждый аккаунт, которому хватает
// билетов. Поскольку это трата, она спрашивает подтверждение с суммой и потом показывает, что
// именно выпало на каждом аккаунте (сервер перед списанием перепроверяет баланс сам).

type Row = { id: number; name: string; vault?: Vault; error?: string; permanent?: boolean };

// «Летний набор ×3, Билет ×20» — общий формат для флеша одного аккаунта и для итогов «крутить всем»
function rewardsText(rewards: { item_id: number; amount: number }[] | undefined, catalog: Map<number, CatalogItem>): string {
  return (rewards ?? []).map(x => {
    const meta = ITEMS_BY_ID[x.item_id];
    return `${meta?.name ?? catalogItemName(catalog.get(x.item_id)) ?? `#${x.item_id}`} ×${x.amount}`;
  }).join(', ');
}

// сколько билетов стоит следующее вращение и по карману ли оно — правило одно и на кнопке
// аккаунта, и на общей кнопке, чтобы списки «кому крутим» не разъезжались
function canSpinNow(v: Vault | undefined): boolean {
  if (!v?.is_open || v.next_cost == null) return false;
  if (v.total_spins > 0 && v.spins_done >= v.total_spins) return false;
  return v.tickets_balance >= v.next_cost;
}

function PrizeCell({ prize, catalog }: { prize: Vault['prizes'][number]; catalog: Map<number, CatalogItem> }) {
  return (
    <Box sx={{
      position: 'relative', p: 2, borderRadius: 2, minWidth: 92,
      border: '1px solid', borderColor: prize.grand ? 'attention.emphasis' : 'border.muted',
      bg: prize.won ? 'success.subtle' : 'canvas.subtle',
      opacity: prize.won ? 0.65 : 1,
    }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1 }}>
        {prize.grand && <Label variant="attention" sx={{ fontSize: 0 }}>Главный</Label>}
        {prize.won
          ? <Label variant="success" sx={{ fontSize: 0, ml: 'auto' }}>Взят</Label>
          : prize.odds_bp != null && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 'auto' }}>{(prize.odds_bp / 100).toFixed(1)}%</Text>
          )}
      </Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        {(prize.rewards ?? []).map(r => {
          const meta = ITEMS_BY_ID[r.item_id];
          const title = meta?.name ?? catalogItemName(catalog.get(r.item_id)) ?? `#${r.item_id}`;
          return (
            <Box key={r.item_id} sx={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }} title={title}>
              {meta
                ? <img src={itemImgSrc(meta.tag)} alt={title} style={{ width: 26, height: 26, objectFit: 'contain' }} />
                : <ItemThumb itemId={r.item_id} item={catalog.get(r.item_id)} size={26} />}
              <Text sx={{ fontSize: 0, fontWeight: 'bold' }}>×{r.amount}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function VaultCard({ row, now, catalog, onSpun }: {
  row: Row; now: number; catalog: Map<number, CatalogItem>;
  onSpun: (accountId: number, vault: Vault | null) => void;
}) {
  const [spinning, setSpinning] = useState(false);
  const { flash, showFlash } = useFlash();
  const v = row.vault;

  const spin = async () => {
    if (!v) return;
    setSpinning(true);
    try {
      const r = await api.anniversaryVaultSpin(row.id);
      if (r.ok) {
        const got = rewardsText(r.result?.rewards, catalog);
        showFlash(`${r.result?.grand ? 'ГЛАВНЫЙ ПРИЗ! ' : ''}Выпало: ${got || '—'}`, true);
        onSpun(row.id, r.vault ?? null);
      } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setSpinning(false); }
  };

  const cleared = !!v && v.total_spins > 0 && v.spins_done >= v.total_spins;
  const notEnough = !!v?.is_open && v.next_cost != null && v.tickets_balance < v.next_cost;
  const canSpin = canSpinNow(v);

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'bold' }}>{row.name}</Text>
        {row.error ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{row.error}</Text> : v ? (
          <>
            {!v.is_open && v.opens_at && (
              <Label variant="secondary" sx={{ fontSize: 0 }}>откроется через {fmtCountdown(v.opens_at, now)}</Label>
            )}
            {v.is_open && v.ends_at && (
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>до конца {fmtCountdown(v.ends_at, now)}</Text>
            )}
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>призов {v.spins_done}/{v.total_spins}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>потрачено <TicketValue value={v.tickets_spent} size={13} /></Text>
            <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
              <Text sx={{ fontSize: 1, fontWeight: 'bold' }}><TicketValue value={v.tickets_balance} /></Text>
              {cleared
                ? <Label variant="success" sx={{ fontSize: 0 }}>Всё забрано</Label>
                : v.is_open && (
                  <Button variant="primary" leadingVisual={StarIcon} loading={spinning}
                    disabled={!canSpin || spinning}
                    title={notEnough ? `Не хватает ${(v.next_cost ?? 0) - v.tickets_balance} билетов` : undefined}
                    onClick={spin}>
                    Крутить{v.next_cost != null ? ` · ${v.next_cost}` : ''}
                  </Button>
                )}
            </Box>
          </>
        ) : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>нет данных</Text>}
      </Box>

      {!row.error && v && (
        <Box sx={{ p: 3 }}>
          {v.total_spins > 0 && (
            <Box sx={{ mb: 2 }}>
              <ProgressBar progress={Math.min(100, (v.spins_done / v.total_spins) * 100)} />
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {v.prizes.map(p => <PrizeCell key={p.index} prize={p} catalog={catalog} />)}
          </Box>
          {notEnough && (
            <Text as="p" sx={{ fontSize: 0, color: 'attention.fg', mt: 2 }}>
              Не хватает {(v.next_cost ?? 0) - v.tickets_balance} билетов на следующее вращение
            </Text>
          )}
          {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mt: 2 }}>{flash.msg}</Flash>}
        </Box>
      )}
    </Box>
  );
}

export function AnniversaryVault() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const [spinningAll, setSpinningAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [spinResults, setSpinResults] = useState<AnniversaryVaultSpinAllRow[] | null>(null);
  const [refreshing, setRefreshing] = useResumableRefresh('anniversaryVault', () => load());
  const { flash, showFlash } = useFlash();
  const catalog = useItemCatalog(
    rows.flatMap(r => (r.vault?.prizes ?? []).flatMap(p => (p.rewards ?? []).map(x => x.item_id)))
  );

  const load = useCallback(async () => {
    try {
      const d = await api.anniversaryVault();
      if (d.ok) { setRows(d.accounts); return d.accounts; }
      showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // добираем аккаунты, по которым игра не ответила (та же схема, что на остальных страницах раздела)
  const retryFailed = useCallback(async (list: Row[]) => {
    const ids = list.filter(r => r.error && !r.permanent).map(r => r.id);
    if (!ids.length) return;
    setRetrying(true);
    try {
      const d = await api.anniversaryVault(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setRows(prev => prev.map(r => fixed.get(r.id) ?? r));
      }
    } catch { /* останется строка с ошибкой */ }
    finally { setRetrying(false); }
  }, []);

  useEffect(() => { load().then(list => { if (list) retryFailed(list); }); }, [load, retryFailed]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { const list = await load(); if (list) await retryFailed(list); }
    finally { setRefreshing(false); }
  };

  // после вращения игра возвращает уже обновлённое поле — подставляем его без общего прохода
  const onSpun = useCallback((accountId: number, vault: Vault | null) => {
    if (!vault) { load(); return; }
    setRows(prev => prev.map(r => (r.id === accountId ? { ...r, vault } : r)));
  }, [load]);

  // Общее вращение: список тех, кому билетов ХВАТАЕТ прямо сейчас. Сервер эти же условия
  // перепроверит перед списанием — билеты могли уйти в другой вкладке.
  const spinAll = async () => {
    const ids = rows.filter(r => canSpinNow(r.vault)).map(r => r.id);
    if (!ids.length) return;
    setSpinningAll(true);
    try {
      const r = await api.anniversaryVaultSpinAll(ids);
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      setSpinResults(r.results);
      // подставляем обновлённые поля тем, кто реально крутил
      const byId = new Map(r.results.filter(x => x.vault).map(x => [x.id, x.vault as Vault]));
      setRows(prev => prev.map(row => (byId.has(row.id) ? { ...row, vault: byId.get(row.id) } : row)));
      const spun = r.results.filter(x => x.spun).length;
      const grand = r.results.filter(x => x.grand).length;
      showFlash(`Крутили на ${spun} аккаунтах${grand ? `, главных призов: ${grand}` : ''}`, true);
    } catch (e) { showFlash(String(e), false); }
    finally { setSpinningAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const open = rows.some(r => r.vault?.is_open);
  const spinnable = rows.filter(r => canSpinNow(r.vault));
  const totalCost = spinnable.reduce((n, r) => n + (r.vault?.next_cost ?? 0), 0);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2, flexWrap: 'wrap' }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Хранилище призов</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant={spinnable.length ? 'primary' : 'default'} leadingVisual={StarIcon}
            loading={spinningAll} disabled={spinningAll || !spinnable.length}
            title={spinnable.length ? `Спишется ${totalCost} билетов суммарно` : 'Ни на одном аккаунте не хватает билетов'}
            onClick={() => setConfirmAll(true)}>
            Крутить всем {spinnable.length > 0 && <CounterLabel sx={{ ml: 1 }}>{spinnable.length}</CounterLabel>}
          </Button>
          <Button leadingVisual={SyncIcon} loading={refreshing || retrying} disabled={refreshing || retrying} onClick={refresh}>
            Обновить
          </Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Text as="p" sx={{ color: 'fg.muted', fontSize: 0, mb: 3 }}>
        Каждая ячейка выигрывается один раз, поэтому поле «редеет», а каждое следующее вращение
        дороже предыдущего. «Крутить всем» делает по одному вращению на каждом аккаунте, которому
        хватает билетов, и показывает, что выпало у каждого.
      </Text>
      {!open && rows.length > 0 && (
        <Flash variant="warning" sx={{ mb: 3 }}>Хранилище закрыто — игра ещё не открыла его для этих аккаунтов.</Flash>
      )}
      {/* Итоги общего вращения: что именно выпало на каждом аккаунте и кого пропустили.
          Держим на странице до следующего запуска — по одному флешу тут ничего не понять. */}
      {spinResults && (
        <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
          <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2 }}>
            <Text sx={{ fontWeight: 'bold' }}>Результаты вращения</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              крутили: {spinResults.filter(x => x.spun).length} · пропущено: {spinResults.filter(x => !x.spun).length}
            </Text>
            <Button size="small" sx={{ ml: 'auto' }} onClick={() => setSpinResults(null)}>Скрыть</Button>
          </Box>
          <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {spinResults.map(x => (
              <Box key={x.id} sx={{
                display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
                py: '6px', px: 2, borderRadius: 1, bg: 'canvas.subtle',
                border: '1px solid', borderColor: x.grand ? 'attention.emphasis' : 'border.muted',
              }}>
                <Text sx={{ fontSize: 1, fontWeight: 'semibold', minWidth: 140 }}>{x.name}</Text>
                {x.spun ? (
                  <>
                    {x.grand && <Label variant="attention" sx={{ fontSize: 0 }}>Главный приз</Label>}
                    <Text sx={{ fontSize: 0 }}>{rewardsText(x.rewards, catalog) || '—'}</Text>
                    {x.tickets_paid != null && (
                      <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 'auto' }}>
                        <TicketValue value={`−${x.tickets_paid}`} size={13} />
                      </Text>
                    )}
                  </>
                ) : (
                  <Text sx={{ fontSize: 0, color: x.error ? 'danger.fg' : 'fg.muted' }}>
                    {x.error ?? x.skipped ?? 'пропущен'}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {rows.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : rows.map(row => <VaultCard key={row.id} row={row} now={now} catalog={catalog} onSpun={onSpun} />)}

      {confirmAll && (
        <Dialog
          title="Крутить на всех?"
          onClose={() => setConfirmAll(false)}
          footerButtons={[
            { content: 'Отмена', onClick: () => setConfirmAll(false) },
            {
              content: 'Крутить', buttonType: 'primary',
              onClick: () => { setConfirmAll(false); spinAll(); },
            },
          ]}
        >
          <Text as="p">
            По одному вращению на {spinnable.length} аккаунтах. Суммарно спишется {totalCost} билетов —
            цена у каждого своя и растёт с каждым вращением.
          </Text>
        </Dialog>
      )}
    </Box>
  );
}
