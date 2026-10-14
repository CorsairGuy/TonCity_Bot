import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Dialog, Flash, Spinner, TabNav, Text, Label } from '@primer/react';
import { ZapIcon, ArrowUpIcon, ArrowDownIcon, PackageIcon, StarFillIcon, SyncIcon } from '@primer/octicons-react';
import { api, type StorageItemFull, type BoosterPackMeta, type CombinationRule } from '../api';
import { ITEMS_BY_ID, fmt, itemImgSrc } from '../utils';
import { CoinValue, CrystalValue } from './Icons';
import { OpenedRewards, RewardRow, RARITY_NAME, type OpenReward } from './StorageModal';
import { Scrollable } from './Scrollable';

export interface BulkHolder { id: number; name: string; qty: number }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Результат массового прогона по аккаунтам
interface BulkResult { ok: number; fail: number; skipped: number; errors: string[] }

export function StorageBulkModal({ itemId, holders, onClose }: { itemId: number; holders: BulkHolder[]; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rep, setRep] = useState<StorageItemFull | null>(null);       // представительный предмет (для UI)
  const [packMeta, setPackMeta] = useState<BoosterPackMeta | null>(null);
  const [rules, setRules] = useState<CombinationRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'target' | 'sell' | 'activate' | 'combine'>('sell');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const [openedRewards, setOpenedRewards] = useState<OpenReward[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<number | null>(null);
  const [liveHolders, setLiveHolders] = useState<BulkHolder[]>(holders); // реальные остатки с игры
  const [counting, setCounting] = useState(false);
  const [done, setDone] = useState(false); // действие выполнено — блокируем повтор до «Обновить»

  const meta = ITEMS_BY_ID[itemId] ?? null;
  const title = meta?.name ?? `Предмет #${itemId}`;
  // реально существующие держатели (qty>0) и суммарное живое количество
  const active = liveHolders.filter(h => h.qty > 0);
  const totalQty = active.reduce((s, h) => s + (h.qty || 0), 0);

  // пересчитать реальные остатки с игры по всем аккаунтам
  const countLive = useCallback(async () => {
    setCounting(true);
    const out: BulkHolder[] = [];
    for (const h of holders) {
      try {
        const d = await api.storageLive(h.id);
        const it = d.ok ? d.items.find(x => x.id === itemId) : undefined;
        out.push({ id: h.id, name: h.name, qty: it?.quantity ?? 0 });
      } catch { out.push({ id: h.id, name: h.name, qty: 0 }); }
      await sleep(120);
    }
    setLiveHolders(out);
    setCounting(false);
  }, [holders, itemId]);

  const loadRep = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // берём первого держателя как образец для UI (тип, награды, правила, цена)
      const first = holders[0];
      const d = await api.storageLive(first.id);
      if (!d.ok) { setError(d.error ?? 'Ошибка загрузки'); return; }
      const found = d.items.find(i => i.id === itemId);
      if (!found) { setError('Предмет не найден'); return; }
      setRep(found);
      setRules(d.combination_rules);
      if (found.type === 'booster_pack') setPackMeta(d.booster_packs.find(p => p.id === itemId) ?? null);
      // дефолтная вкладка по типу
      setTab(found.type === 'booster' ? 'activate' : found.type === 'booster_pack' ? 'open' : 'sell');
      setDone(false);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [itemId, holders]);

  useEffect(() => { loadRep().then(countLive); }, [loadRep, countLive]);

  // Прогон действия по всем держателям: перечитываем live каждого и применяем perAccount.
  const runBulk = useCallback(async (
    perAccount: (h: BulkHolder, live: StorageItemFull, resp: { combination_rules: CombinationRule[] }) => Promise<{ ok: boolean; error?: string; rewards?: OpenReward[] }>,
  ) => {
    setBusy(true); setResult(null); setOpenedRewards([]);
    const res: BulkResult = { ok: 0, fail: 0, skipped: 0, errors: [] };
    const rewards: OpenReward[] = [];
    const list = liveHolders.filter(h => h.qty > 0);
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      setProgress(`${h.name} (${i + 1}/${list.length})`);
      try {
        const d = await api.storageLive(h.id);
        const it = d.ok ? d.items.find(x => x.id === itemId) : undefined;
        if (!it) { res.skipped++; continue; }
        const r = await perAccount(h, it, d);
        if (r.ok) {
          res.ok++; if (r.rewards) rewards.push(...r.rewards);
          await api.storageSync(h.id).catch(() => {}); // синхронизируем инвентарь аккаунта в БД
        }
        else { res.fail++; if (r.error) res.errors.push(`${h.name}: ${r.error}`); }
      } catch (e) { res.fail++; res.errors.push(`${h.name}: ${String(e)}`); }
      if (i < list.length - 1) await sleep(600);
    }
    setOpenedRewards(rewards);
    setResult(res);
    setProgress('');
    setBusy(false);
    setDone(true);           // выполнено — блокируем повтор
    await countLive();       // пересчитываем реальные остатки (кнопка отразит 0)
  }, [liveHolders, itemId, countLive]);

  // ── действия ────────────────────────────────────────────────────────────────
  const doSell = () => runBulk(async (h, it) => {
    if (it.quantity <= 0) return { ok: false, error: 'нет предметов' };
    return api.storageSell(h.id, itemId, it.quantity); // в инвентаре продаётся всё (soulbound — ограничение только маркета)
  });
  const doActivate = () => runBulk(async (h, it) => {
    if (!it.booster || it.booster.currently_active >= it.booster.active_limit) return { ok: false, error: 'слоты заняты' };
    return api.storageActivate(h.id, itemId);
  });
  const doCombine = () => runBulk(async (h, it, resp) => {
    if (!it.booster) return { ok: false, error: 'не бустер' };
    const rule = resp.combination_rules.find(r => r.from_rarity === it.booster!.rarity);
    if (!rule) return { ok: false, error: 'нет правила' };
    const n = Math.floor(it.quantity / rule.required_amount);
    if (n < 1) return { ok: false, error: 'недостаточно' };
    return api.storageCombine(h.id, itemId, n * rule.required_amount);
  });
  const doOpen = () => runBulk(async (h, it) => {
    const n = it.quantity;
    if (n <= 0) return { ok: false, error: 'нет паков' };
    const collected: OpenReward[] = [];
    for (let k = 0; k < n; k++) {
      if (k > 0) await sleep(700);
      const r = await api.storageOpenPack(h.id, itemId);
      if (!r.ok) return { ok: collected.length > 0, error: r.error, rewards: collected };
      collected.push((r.result ?? {}) as OpenReward);
    }
    return { ok: true, rewards: collected };
  });
  const doSetTarget = () => {
    if (selectedTarget == null) return;
    runBulk(async (h) => api.storageSetTarget(h.id, itemId, selectedTarget));
  };

  const switchTab = (t: typeof tab) => { setTab(t); setDone(false); setResult(null); };

  const isCrystals = rep?.sell_currency === 'crystals';
  const sellEstimate = (rep?.sell_price ?? 0) * totalQty;
  const packRewards = packMeta?.rewards ?? [];
  const itemRewards = packRewards.filter(r => r.reward_type === 'item');

  const footerBtn = () => {
    if (!rep) return null;
    const gate = busy || counting || done;               // блокируем повтор до «Обновить»
    const noItems = totalQty === 0;
    if (tab === 'sell') return <Button variant="danger" leadingVisual={ArrowDownIcon} loading={busy} disabled={gate || noItems} onClick={doSell}>{done ? 'Продано' : `Продать всё (${active.length})`}</Button>;
    if (tab === 'activate') return <Button variant="primary" leadingVisual={ZapIcon} loading={busy} disabled={gate || noItems} onClick={doActivate}>{done ? 'Активировано' : `Активировать на всех (${active.length})`}</Button>;
    if (tab === 'combine') return <Button variant="primary" leadingVisual={ArrowUpIcon} loading={busy} disabled={gate || noItems} onClick={doCombine}>{done ? 'Готово' : 'Объединить максимум на всех'}</Button>;
    if (tab === 'open') return <Button variant="primary" leadingVisual={PackageIcon} loading={busy} disabled={gate || noItems} onClick={doOpen}>{done ? 'Открыто' : `Открыть все паки (${totalQty})`}</Button>;
    if (tab === 'target') return <Button variant="primary" leadingVisual={StarFillIcon} loading={busy} disabled={busy || counting || selectedTarget == null} onClick={doSetTarget}>Установить цель на всех</Button>;
    return null;
  };

  return (
    <Dialog isOpen onDismiss={onClose} sx={{ maxWidth: 520, width: '95vw' }}>
      <Dialog.Header>
        <Text sx={{ fontWeight: 'bold' }}>{title}</Text>
        <Text sx={{ color: 'fg.muted', ml: 1 }}>— {active.length} акк. · {counting ? '…' : `${totalQty}шт`}</Text>
      </Dialog.Header>

      <Scrollable style={{ maxHeight: '65vh', padding: 8 }}>
        <OpenedRewards rewards={openedRewards} />
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        ) : error ? (
          <Flash variant="danger">{error}</Flash>
        ) : rep ? (
          <>
            <TabNav aria-label="Действие" sx={{ mb: 3 }}>
              {rep.type === 'booster' && <TabNav.Link as="button" selected={tab === 'activate'} onClick={() => switchTab('activate')}>Активировать</TabNav.Link>}
              {rep.type === 'booster' && rules.some(r => r.from_rarity === rep.booster?.rarity) && <TabNav.Link as="button" selected={tab === 'combine'} onClick={() => switchTab('combine')}>Объединить</TabNav.Link>}
              {rep.type === 'booster_pack' && <TabNav.Link as="button" selected={tab === 'open'} onClick={() => switchTab('open')}>Открыть</TabNav.Link>}
              {rep.type === 'booster_pack' && itemRewards.length > 0 && <TabNav.Link as="button" selected={tab === 'target'} onClick={() => switchTab('target')}>Цель</TabNav.Link>}
              <TabNav.Link as="button" selected={tab === 'sell'} onClick={() => switchTab('sell')}>Продать</TabNav.Link>
            </TabNav>

            {busy && <Flash variant="default" sx={{ mb: 3 }}>Выполняю… {progress}</Flash>}
            {result && (
              <Flash variant={result.fail ? 'warning' : 'success'} sx={{ mb: 3 }}>
                Готово: успешно {result.ok}, ошибок {result.fail}, пропущено {result.skipped}
                {result.errors.length > 0 && <Text sx={{ fontSize: 0, display: 'block', mt: 1, color: 'fg.muted' }}>{result.errors.slice(0, 5).join(' · ')}</Text>}
              </Flash>
            )}

            {tab === 'sell' && (
              <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Продать всё со всех аккаунтов (~{totalQty} шт)</Text>
                <Text sx={{ fontWeight: 'bold' }}>{isCrystals ? <CrystalValue value={fmt(sellEstimate)} /> : <CoinValue value={fmt(sellEstimate)} />}</Text>
              </Box>
            )}

            {tab === 'activate' && rep.booster && (
              <Box sx={{ display: 'flex', gap: 3 }}>
                <Box sx={{ flex: 1, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
                  <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Множитель</Text>
                  <Text sx={{ fontWeight: 'bold', fontSize: 2, color: 'success.fg' }}>{rep.booster.multiplier}×</Text>
                </Box>
                <Box sx={{ flex: 2, p: 2, bg: 'canvas.subtle', borderRadius: 2, textAlign: 'center' }}>
                  <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Активирует по одному на каждом аккаунте</Text>
                  <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{holders.length} аккаунтов</Text>
                </Box>
              </Box>
            )}

            {tab === 'combine' && (
              <Box sx={{ p: 2, bg: 'canvas.subtle', borderRadius: 2 }}>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>На каждом аккаунте объединит максимум возможного ({RARITY_NAME[rep.booster?.rarity ?? ''] ?? rep.booster?.rarity} → выше).</Text>
              </Box>
            )}

            {tab === 'open' && packRewards.length > 0 && (
              <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
                <Box sx={{ px: 2, py: 1, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
                  <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold' }}>Возможные награды</Text>
                </Box>
                {packRewards.map((rw, i) => <RewardRow key={i} rw={rw} i={i} total={packRewards.length} />)}
              </Box>
            )}

            {tab === 'target' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Цель установится на всех аккаунтах — следующий пак гарантирует выбранный предмет.</Text>
                <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
                  {itemRewards.map((rw, i) => {
                    const isSel = selectedTarget === rw.reward_id;
                    return (
                      <Box key={i} onClick={() => setSelectedTarget(rw.reward_id)}
                        sx={{ cursor: 'pointer', bg: isSel ? 'accent.subtle' : 'canvas.default', borderBottom: i < itemRewards.length - 1 ? '1px solid' : 'none', borderColor: 'border.muted', '&:hover': { bg: isSel ? 'accent.subtle' : 'canvas.subtle' } }}>
                        <RewardRow rw={rw} i={i} total={itemRewards.length}>
                          {isSel && <Label sx={{ bg: 'accent.emphasis', color: 'white', borderColor: 'transparent', fontSize: 0 }}>Выбрано</Label>}
                        </RewardRow>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            )}
          </>
        ) : null}
      </Scrollable>

      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <Button leadingVisual={SyncIcon} onClick={() => loadRep().then(countLive)} disabled={loading || busy || counting}>Обновить</Button>
        <Box sx={{ display: 'flex', gap: 2 }}>{footerBtn()}</Box>
      </Box>
    </Dialog>
  );
}
