import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, Dialog } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, type PoliciesAccountData, type PolicyInstance, type PolicyShardItem, type PolicyActionName, type PolicyEconomy } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { ITEMS_BY_ID, itemImgSrc } from '../utils';
import { effectLabel, effectValue } from '../policyEffects';
import { Scrollable } from '../components/Scrollable';

// цвет/название редкости — как в игре (Библиотека политик)
const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#C0392B',
};
const RARITY_NAME: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};

function rarityFromTag(tag: string): string {
  const m = tag.match(/(common|uncommon|rare|epic|legendary|mythic|eternal)$/);
  return m ? m[1] : 'common';
}

function policyName(p: PolicyInstance): string {
  return p.definition?.name?.ru || p.definition?.name?.en || p.def_id;
}

// ── Иконка-плашка политики: mdi-иконка из icon_key (как в игре, PolicyCard.vue), ────────────
// цвет по редкости — аналогично значкам на странице "Достижения" (Badge)

// Тот же размер/каркас, что у карточки предмета склада (.item-card, 77×77) — единообразие
// со страницами Предметы/Осколки/Тайные политики (ShardCard использует тот же класс).
function PolicyBadge({ policy, enacted, onClick }: { policy: PolicyInstance; enacted?: boolean; onClick: () => void }) {
  const color = RARITY_COLOR[policy.rarity] ?? '#6e7681';
  const icon = (policy.definition?.icon_key || 'mdi-script-text').replace(/^mdi-/, '');
  return (
    <div className="item-card clickable" title={policyName(policy)} onClick={onClick}>
      <div className="item-card__box" style={{ background: color }}>
        <span className={`mdi mdi-${icon}`} style={{ fontSize: 30, color: '#fff', lineHeight: 1 }} />
        {enacted && <div style={{ position: 'absolute', top: -3, right: -3, width: 13, height: 13, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg)' }} />}
      </div>
      <div className="item-card__name">{policyName(policy)}</div>
      <span style={{ fontSize: 10, color, fontWeight: 600 }}>Ур. {policy.level}</span>
    </div>
  );
}

// ── Модалка политики: просмотр + действия ────────────────────────────────────
// enact/unequip/levelup/promote/dissolve — payload {instance_id} (enact ещё сам подбирает
// свободный слот кабинета на сервере) — подтверждено реверсом chunks/storage-*.

function PolicyModal({ policy, accountId, enacted, onClose, onChanged }: {
  policy: PolicyInstance;
  accountId: number;
  enacted: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<PolicyActionName | null>(null);
  const { flash, showFlash } = useFlash();
  const color = RARITY_COLOR[policy.rarity] ?? '#6e7681';
  const icon = (policy.definition?.icon_key || 'mdi-script-text').replace(/^mdi-/, '');

  const run = async (action: PolicyActionName) => {
    setBusy(action);
    try {
      const r = await api.policyAction(accountId, action, { instance_id: policy.id });
      if (r.ok) { showFlash('Готово', true); onChanged(); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBusy(null); }
  };

  const boons = (policy.effects ?? []).filter(e => e.kind === 'boon');
  const banes = (policy.effects ?? []).filter(e => e.kind === 'bane');

  return (
    <Dialog isOpen onDismiss={onClose} sx={{ maxWidth: 480, width: '95vw' }}>
      <Dialog.Header>
        <Text sx={{ fontWeight: 'bold' }}>{policyName(policy)}</Text>
      </Dialog.Header>
      <Scrollable style={{ maxHeight: '65vh', padding: 8 }}>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{flash.msg}</Flash>}
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          <div style={{ width: 72, height: 72, borderRadius: 16, background: color, boxShadow: `0 0 14px ${color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className={`mdi mdi-${icon}`} style={{ fontSize: 36, color: '#fff' }} />
          </div>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
          <Label sx={{ bg: color, color: 'white', borderColor: 'transparent' }}>{RARITY_NAME[policy.rarity] ?? policy.rarity}</Label>
          <Label>Ур. {policy.level}{policy.max_level ? `/${policy.max_level}` : ''}</Label>
          {policy.serial_number != null && <Label>№{policy.serial_number}</Label>}
          {enacted && <Label variant="success">Применена</Label>}
        </Box>
        {policy.definition?.description && (
          <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mb: 3, textAlign: 'center' }}>
            {policy.definition.description.ru || policy.definition.description.en}
          </Text>
        )}
        {(boons.length > 0 || banes.length > 0) && (
          <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, mb: 3 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold', display: 'block', mb: 1 }}>Эффекты</Text>
            {[...boons, ...banes].map((e, i) => (
              <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
                <Text sx={{ color: e.kind === 'boon' ? 'success.fg' : 'danger.fg' }}>{effectLabel(e)}</Text>
                <Text className="mono" sx={{ fontWeight: 'bold' }}>{effectValue(e)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Scrollable>
      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'flex-end' }}>
        {enacted
          ? <Button variant="danger" loading={busy === 'unequip'} disabled={!!busy} onClick={() => run('unequip')}>Снять</Button>
          : <Button variant="primary" loading={busy === 'enact'} disabled={!!busy} onClick={() => run('enact')}>Применить</Button>}
        <Button loading={busy === 'levelup'} disabled={!!busy} onClick={() => run('levelup')}>Повысить уровень</Button>
        <Button loading={busy === 'promote'} disabled={!!busy} onClick={() => run('promote')}>Улучшить редкость</Button>
        <Button variant="danger" loading={busy === 'dissolve'} disabled={!!busy} onClick={() => run('dissolve')}>Расформировать</Button>
      </Box>
    </Dialog>
  );
}

// ── Карточка осколка/тайной политики — как на странице "Предметы" ───────────
// Клик открывает модалку с действием (создать/открыть), кнопка внутри недоступна,
// если условие фичи не выполнено (1 000 000 населения) — не сама карточка.

function ShardCard({ shard, onClick }: { shard: PolicyShardItem; onClick: () => void }) {
  const meta = ITEMS_BY_ID[Number(shard.id)] ?? null;
  return (
    <div className="item-card clickable" title={meta?.name ?? shard.type} onClick={onClick}>
      <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`}>
        {meta
          ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name} style={{ scale: String(meta.scale) }}
              onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
          : <span style={{ fontSize: 10, textAlign: 'center', padding: 4 }}>{shard.type}</span>}
        {shard.qty > 1 && <span className="item-card__count">{shard.qty}</span>}
      </div>
      {meta && <div className="item-card__name">{meta.name}</div>}
    </div>
  );
}

// ── Модалка осколка/тайной политики: просмотр + одно действие ───────────────

function ShardModal({ shard, accountId, locked, lockedReason, economy, onClose, onChanged }: {
  shard: PolicyShardItem;
  accountId: number;
  locked: boolean;
  lockedReason?: string;
  economy: PolicyEconomy | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();
  const meta = ITEMS_BY_ID[Number(shard.id)] ?? null;
  const rarity = meta ? rarityFromTag(meta.tag) : 'common';
  const isMystery = shard.type === 'mystery_policy';
  const color = RARITY_COLOR[rarity] ?? '#6e7681';
  // сколько осколков реально нужно на создание тайной политики этой редкости — приходит с игрой
  // (/policies/ → economy.craft_costs), см. modules/policies.js. Раньше это поле отбрасывалось,
  // и кнопка была активна независимо от количества осколков.
  const craftCost = economy?.craft_costs?.[rarity] ?? null;
  const notEnough = !isMystery && craftCost != null && shard.qty < craftCost;

  const run = async () => {
    setBusy(true);
    try {
      const action: PolicyActionName = isMystery ? 'mystery-open' : 'mystery-craft';
      const r = await api.policyAction(accountId, action, { rarity });
      if (r.ok) { showFlash('Готово', true); onChanged(); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setBusy(false); }
  };

  return (
    <Dialog isOpen onDismiss={onClose} sx={{ maxWidth: 400, width: '95vw' }}>
      <Dialog.Header>
        <Text sx={{ fontWeight: 'bold' }}>{meta?.name ?? shard.type}</Text>
      </Dialog.Header>
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ width: '100%' }}>{flash.msg}</Flash>}
        <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`} style={{ width: 96, height: 96 }}>
          {meta && <img className="item-card__img" src={itemImgSrc(meta.tag)} alt="" style={{ height: 96, scale: String(meta.scale) }}
            onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />}
        </div>
        <Label sx={{ bg: color, color: 'white', borderColor: 'transparent' }}>{RARITY_NAME[rarity] ?? rarity}</Label>
        <Text sx={{ fontSize: 1, color: 'fg.muted' }}>
          У аккаунта: {shard.qty} шт.{!isMystery && craftCost != null && <> · нужно: {craftCost} шт.</>}
        </Text>
        {locked && <Flash variant="warning" sx={{ fontSize: 0, width: '100%', textAlign: 'center' }}>{lockedReason}</Flash>}
        {notEnough && <Flash variant="warning" sx={{ fontSize: 0, width: '100%', textAlign: 'center' }}>Не хватает осколков (нужно {craftCost}, есть {shard.qty})</Flash>}
      </Box>
      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'border.default', display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" loading={busy} disabled={busy || locked || notEnough} onClick={run}>
          {isMystery ? 'Открыть' : 'Создать тайную политику'}
        </Button>
      </Box>
    </Dialog>
  );
}

// ── Блок аккаунта (данные из БД, как на странице "Предметы") ────────────────
// Городской розыгрыш перенесён на отдельную страницу в группе "Мэрия" (как в игре).

function AccountBlock({ accountName, accountId, data, onOpenPolicy, onOpenShard }: {
  accountName: string;
  accountId: number;
  data: PoliciesAccountData;
  onOpenPolicy: (accountId: number, policy: PolicyInstance, enacted: boolean) => void;
  onOpenShard: (accountId: number, shard: PolicyShardItem) => void;
}) {
  const enactedIds = new Set(
    (data.cabinet.slots ?? []).map(s => s.instance?.id).filter((x): x is number => x != null)
  );

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{
        px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2,
      }}>
        <Text sx={{ fontWeight: 'bold' }}>{accountName}</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          Библиотека: {data.library.discovered}/{data.library.total} · Кабинет: {enactedIds.size}/{data.cabinet.slots?.length ?? 0}
          {!data.policies_unlocked && ' · нет 1 000 000 населения'}
        </Text>
      </Box>
      <Box sx={{ p: 3 }}>
        {data.list.length === 0 && data.shards.length === 0
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Нет данных — политики ещё не открыты или не синхронизированы</Text>
          : (
            <>
              {data.list.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: data.shards.length ? 16 : 0 }}>
                  {data.list.map(p => (
                    <PolicyBadge key={p.id} policy={p} enacted={enactedIds.has(p.id)}
                      onClick={() => onOpenPolicy(accountId, p, enactedIds.has(p.id))} />
                  ))}
                </div>
              )}
              {data.shards.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {data.shards.map(s => (
                    <ShardCard key={s.id} shard={s} onClick={() => onOpenShard(accountId, s)} />
                  ))}
                </div>
              )}
            </>
          )}
      </Box>
    </Box>
  );
}

// ── Основная страница ─────────────────────────────────────────────────────────

export function Policies() {
  const [byAccount, setByAccount] = useState<Record<string, PoliciesAccountData>>({});
  const [accIdByName, setAccIdByName] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:policies', () => load(true));
  const [policyModal, setPolicyModal] = useState<{ accountId: number; policy: PolicyInstance; enacted: boolean } | null>(null);
  const [shardModal, setShardModal] = useState<{ accountId: number; shard: PolicyShardItem; locked: boolean; economy: PolicyEconomy | null } | null>(null);
  const { flash, showFlash } = useFlash();

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.policies();
      if (d.ok) { setByAccount(d.byAccount ?? {}); setAccIdByName(d.accIdByName ?? {}); }
      else showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { if (!silent) setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('policies'); await load(true); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const accounts = Object.entries(byAccount).sort(([a], [b]) => a.localeCompare(b, 'ru', { numeric: true }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Политики</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </Box>

      {accounts.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : accounts.map(([accName, data]) => (
            <AccountBlock key={accName} accountName={accName} accountId={accIdByName[accName]} data={data}
              onOpenPolicy={(accountId, policy, enacted) => setPolicyModal({ accountId, policy, enacted })}
              onOpenShard={(accountId, shard) => setShardModal({ accountId, shard, locked: shard.type === 'mystery_policy' && !data.policies_unlocked, economy: data.economy })} />
          ))}

      {policyModal && (
        <PolicyModal
          policy={policyModal.policy}
          accountId={policyModal.accountId}
          enacted={policyModal.enacted}
          onClose={() => setPolicyModal(null)}
          onChanged={() => { setPolicyModal(null); load(true); }}
        />
      )}

      {shardModal && (
        <ShardModal
          shard={shardModal.shard}
          accountId={shardModal.accountId}
          locked={shardModal.locked}
          lockedReason="Открытие тайных политик доступно с 1 000 000 населения"
          economy={shardModal.economy}
          onClose={() => setShardModal(null)}
          onChanged={() => { setShardModal(null); load(true); }}
        />
      )}
    </Box>
  );
}
