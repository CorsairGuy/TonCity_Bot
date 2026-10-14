import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, type InventoryItem } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { ITEMS_BY_ID, itemImgSrc, fmt, itemTypeGroupRank, rarityRankFromTag } from '../utils';

// общий компаратор: сначала тип предмета (ящики/материалы/ускорители/остальное), внутри — по
// редкости (высокая→низкая), остаток — по количеству (чем больше, тем выше)
function compareItems(aId: number, bId: number, aQty: number, bQty: number): number {
  const ga = itemTypeGroupRank(aId), gb = itemTypeGroupRank(bId);
  if (ga !== gb) return ga - gb;
  const metaA = ITEMS_BY_ID[aId], metaB = ITEMS_BY_ID[bId];
  const ra = metaA ? rarityRankFromTag(metaA.tag) : 99;
  const rb = metaB ? rarityRankFromTag(metaB.tag) : 99;
  if (ra !== rb) return ra - rb;
  return bQty - aQty;
}
// новые предметы (билеты, летний/алмазный набор, камни реформ) в статическом справочнике не
// прописаны — их имя и картинку берём из каталога, который бот забрал у игры
import { useItemCatalog, catalogItemName } from '../hooks/useItemCatalog';
import { ItemThumb } from '../components/ItemThumb';
import { CoinValue, CrystalValue } from '../components/Icons';
import { StorageModal } from '../components/StorageModal';
import { StorageBulkModal, type BulkHolder } from '../components/StorageBulkModal';

interface AggItem {
  id: number;
  name: string;
  totalQty: number;
  holders: BulkHolder[];
}

function AllItemsBlock({ byAccount, accValues, accIdByName, onItemClick }: {
  byAccount: Record<string, InventoryItem[]>;
  accValues: Record<string, { coins: number; crystals: number }>;
  accIdByName: Record<string, number>;
  onItemClick: (itemId: number, holders: BulkHolder[]) => void;
}) {
  const catalog = useItemCatalog();
  const map = new Map<number, AggItem & { totalLocked: number }>();
  for (const [accName, items] of Object.entries(byAccount)) {
    const accId = accIdByName[accName];
    for (const item of items) {
      const key = Number(item.id);
      if (!map.has(key)) map.set(key, { id: key, name: item.name, totalQty: 0, totalLocked: 0, holders: [] });
      const agg = map.get(key)!;
      const marketable = item.marketable ?? 0;
      const locked = item.locked ?? 0;
      agg.totalQty += marketable;            // синий бейдж — продаваемые
      agg.totalLocked += locked;             // красный бейдж — непродаваемые (soulbound)
      // держателю передаём полное количество (в инвентаре доступны и залоченные)
      if (accId != null) agg.holders.push({ id: accId, name: accName, qty: marketable + locked });
    }
  }
  const items = [...map.values()].sort((a, b) => compareItems(a.id, b.id, a.totalQty, b.totalQty));
  if (items.length === 0) return null;
  const totalCoins = Object.values(accValues).reduce((s, v) => s + (v.coins ?? 0), 0);
  const totalCrystals = Object.values(accValues).reduce((s, v) => s + (v.crystals ?? 0), 0);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Text sx={{ fontWeight: 'bold' }}>Все аккаунты</Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 2 }}>{items.length} уникальных</Text>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, fontSize: 0 }}>
          {totalCoins > 0 && <CoinValue value={fmt(totalCoins)} />}
          {totalCrystals > 0 && <CrystalValue value={fmt(totalCrystals)} />}
        </Box>
      </Box>
      <Box sx={{ p: 3 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {items.map(agg => {
            const meta = ITEMS_BY_ID[agg.id] ?? null;
            const fromGame = catalog.get(Number(agg.id));
            const canAct = agg.holders.length > 0;
            return (
              <div key={agg.id} title={agg.name} className={canAct ? 'item-card clickable' : undefined}
                onClick={canAct ? () => onItemClick(agg.id, agg.holders) : undefined}
                style={canAct ? undefined : { cursor: 'default' }}>
                <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`} title={meta?.name ?? catalogItemName(fromGame) ?? `#${agg.id}`}>
                  {meta
                    ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={agg.name}
                        style={{ scale: String(meta.scale) }}
                        onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
                    : <ItemThumb itemId={Number(agg.id)} item={fromGame} size={44} className="item-card__img" />
                  }
                  {agg.totalQty > 1 && <span className="item-card__count">{agg.totalQty}</span>}
                  {agg.totalLocked > 0 && <span className="item-card__locked">{agg.totalLocked}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Box>
    </Box>
  );
}

interface ModalState { accountName: string; accountId: number; itemId: number }

export function Inventory() {
  const catalog = useItemCatalog();
  const [byAccount, setByAccount] = useState<Record<string, InventoryItem[]>>({});
  const [accValues, setAccValues] = useState<Record<string, { coins: number; crystals: number }>>({});
  const [accIdByName, setAccIdByName] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:inventory', () => load());
  const [modal, setModal] = useState<ModalState | null>(null);
  const [bulk, setBulk] = useState<{ itemId: number; holders: BulkHolder[] } | null>(null);
  const { flash, showFlash } = useFlash();

  // silent=true — обновить данные без спиннера (не размонтировать список, не сбрасывать скролл)
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.inventory();
      if (d.ok) {
        setByAccount(d.byAccount ?? {});
        setAccValues(d.accValues ?? {});
        setAccIdByName(d.accIdByName ?? {});
      }
    } finally { if (!silent) setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('inventory'); await load(); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  const accounts = Object.entries(byAccount).sort(([a], [b]) => a.localeCompare(b, 'ru', { numeric: true }));

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Предметы</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

      {modal && (
        <StorageModal
          accountName={modal.accountName}
          accountId={modal.accountId}
          itemId={modal.itemId}
          onClose={() => { setModal(null); load(true); }}
        />
      )}

      {bulk && (
        <StorageBulkModal
          itemId={bulk.itemId}
          holders={bulk.holders}
          onClose={() => { setBulk(null); load(true); }}
        />
      )}

      {accounts.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
          : (
            <>
              <AllItemsBlock byAccount={byAccount} accValues={accValues} accIdByName={accIdByName}
                onItemClick={(itemId, holders) => setBulk({ itemId, holders })} />
              {accounts.map(([accName, items]) => {
                const val = accValues[accName];
                const accountId = accIdByName[accName];
                return (
                  <Box key={accName} sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
                    <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box>
                        <Text sx={{ fontWeight: 'bold' }}>{accName}</Text>
                        <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 2 }}>{items.length} предметов</Text>
                      </Box>
                      {val && (
                        <Box sx={{ display: 'flex', gap: 2, fontSize: 0 }}>
                          {val.coins > 0 && <CoinValue value={fmt(val.coins)} />}
                          {val.crystals > 0 && <CrystalValue value={fmt(val.crystals)} />}
                        </Box>
                      )}
                    </Box>
                    <Box sx={{ p: 3 }}>
                      {items.length === 0
                        ? <Text sx={{ color: 'fg.subtle', fontSize: 1 }}>Инвентарь пуст</Text>
                        : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                            {[...items].sort((a, b) => compareItems(Number(a.id), Number(b.id), a.qty, b.qty)).map((item, i) => {
                              const meta = ITEMS_BY_ID[Number(item.id)] ?? null;
                              const fromGame = catalog.get(Number(item.id));
                              const canOpen = !!accountId;
                              return (
                                <div
                                  key={i}
                                  className={`item-card${canOpen ? ' clickable' : ''}`}
                                  onClick={canOpen ? () => setModal({ accountName: accName, accountId, itemId: Number(item.id) }) : undefined}
                                  title={meta?.name ?? catalogItemName(fromGame) ?? item.name}
                                >
                                  <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`}>
                                    {meta
                                      ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={item.name} style={{ scale: String(meta.scale) }} onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
                                      : <ItemThumb itemId={Number(item.id)} item={fromGame} size={44} className="item-card__img" />
                                    }
                                    {item.marketable > 0 && <span className="item-card__count">{item.marketable}</span>}
                                    {item.locked > 0 && <span className="item-card__locked">{item.locked}</span>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )
                      }
                    </Box>
                  </Box>
                );
              })}
            </>
          )
      }
    </Box>
  );
}
