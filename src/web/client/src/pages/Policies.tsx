import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, Tooltip, ConfirmationDialog } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api, type PoliciesAccountData, type PolicyInstance, type PolicyShardItem, type PolicyActionName, type PolicyEconomy } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { ITEMS_BY_ID, itemImgSrc } from '../utils';
import { effectLabel, effectValue } from '../policyEffects';

// цвет/название редкости — как в игре (Библиотека политик)
const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#C0392B',
};
const RARITY_NAME: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};
// от самой редкой к самой частой — для сортировки карточек (13.10.2026)
const RARITY_ORDER = ['eternal', 'mythic', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
const RARITY_RANK: Record<string, number> = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, i]));
// эпическая и выше — расформирование подтверждаем ВСЕГДА, даже на 1 уровне (осколки редкости
// дорогие и их легко случайно сжечь); ниже эпической — подтверждение только если уровень >1
// (вложен стаж/осколки)
const HIGH_RARITIES = new Set(['epic', 'legendary', 'mythic', 'eternal']);

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
  // 13.10.2026: имя под карточкой убрано (разной длины строки ломали ровную сетку — то одна
  // строка, то две) — вместо него мгновенный Tooltip по наведению (noDelay, без стандартной
  // задержки браузерного title).
  return (
    <Tooltip text={policyName(policy)} direction="n" noDelay>
      <div className="item-card clickable" aria-label={policyName(policy)} onClick={onClick}>
        <div className="item-card__box" style={{ background: color }}>
          <span className={`mdi mdi-${icon}`} style={{ fontSize: 30, color: '#fff', lineHeight: 1 }} />
          {enacted && <div style={{ position: 'absolute', top: -3, right: -3, width: 13, height: 13, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg)' }} />}
        </div>
        <span style={{ fontSize: 10, color, fontWeight: 600 }}>Ур. {policy.level}</span>
      </div>
    </Tooltip>
  );
}

// ── Модалка политики: просмотр + действия ────────────────────────────────────
// enact/unequip/levelup/promote/dissolve — payload {instance_id} (enact ещё сам подбирает
// свободный слот кабинета на сервере) — подтверждено реверсом chunks/storage-*.

function PolicyModal({ policy, accountId, enacted, freeSlots, snapshotAt, onClose, onChanged, onStale }: {
  policy: PolicyInstance;
  accountId: number;
  enacted: boolean;
  freeSlots: number;   // свободных слотов кабинета (unlocked && пуст) — без них «Применить» бессмысленно
  snapshotAt: string | null; // когда снят снимок: цифры ниже посчитаны на этот момент
  onClose: () => void;
  onChanged: () => void;
  onStale?: () => void;      // отказ игры → сервер пересинкал, надо перечитать страницу
}) {
  const [busy, setBusy] = useState<PolicyActionName | null>(null);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const { flash, showFlash } = useFlash();
  const color = RARITY_COLOR[policy.rarity] ?? '#6e7681';
  const icon = (policy.definition?.icon_key || 'mdi-script-text').replace(/^mdi-/, '');

  const run = async (action: PolicyActionName) => {
    setBusy(action);
    try {
      const r = await api.policyAction(accountId, action, { instance_id: policy.id });
      if (r.ok) { showFlash('Готово', true); onChanged(); }
      else {
        // сервер при отказе тоже пересинхронизировал снимок с игрой (см. routes/policies.js) —
        // перечитываем данные, иначе на экране остались бы те же устаревшие цифры
        showFlash(r.error ?? 'Ошибка', false);
        onStale?.();
      }
    } catch (e) { showFlash(String(e), false); }
    finally { setBusy(null); }
  };

  const prog = policy.progress;
  const boons = (policy.effects ?? []).filter(e => e.kind === 'boon');
  const banes = (policy.effects ?? []).filter(e => e.kind === 'bane');
  // 13.10.2026: раньше показывались ОБЕ кнопки сразу — "Повысить уровень" и "Улучшить редкость",
  // хотя по правилам игры это взаимоисключающие действия: редкость повышается ТОЛЬКО когда уровень
  // уже упёрся в потолок текущей редкости (policy.max_level), а поднять уровень выше потолка нельзя
  // в принципе. Показывать сразу обе (одна из них неизбежно серая) было лишним и вводило в
  // заблуждение. Теперь показываем только ТУ, что реально имеет смысл сейчас.
  const atLevelCap = policy.max_level != null && policy.level >= policy.max_level;
  const canPromoteFurther = !!policy.promotion;

  return (
    <>
    <Dialog
      title={policyName(policy)}
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      /* кнопки гасим по тем же правилам, что и игра: их присылает сервер в policy.progress
         (стаж/осколки), слоты — freeSlots. Причина недоступности идёт в title, чтобы не гадать */
      footerButtons={[
        enacted
          ? { content: 'Снять', buttonType: 'danger', loading: busy === 'unequip', disabled: !!busy, onClick: () => run('unequip') }
          : {
            content: 'Применить', buttonType: 'primary', loading: busy === 'enact',
            disabled: !!busy || freeSlots <= 0,
            title: freeSlots <= 0 ? 'Нет свободных слотов в кабинете мэра' : undefined,
            onClick: () => run('enact'),
          },
        ...(atLevelCap && canPromoteFurther
          ? [{
              content: 'Улучшить редкость', loading: busy === 'promote',
              // 13.10.2026: игра не даёт повысить редкость НАДЕТОЙ политике — сервер отвечает
              // отказом. Раньше кнопка была активна и вводила в заблуждение (жмёшь — ошибка без
              // объяснения). Теперь гасим её здесь же и прямо говорим, что сначала нужно «Снять».
              disabled: !!busy || enacted || (prog ? !prog.can_promote : false),
              title: enacted ? 'Сначала снимите политику (кнопка «Снять») — игра не повышает редкость надетой политике'
                : prog && !prog.can_promote ? prog.promote_blockers.join('; ') : undefined,
              onClick: () => run('promote'),
            }]
          : atLevelCap
            ? [] // упёрлись в потолок уровня, но дальше повышать редкость уже некуда (максимум)
            : [{
                content: 'Повысить уровень', loading: busy === 'levelup',
                disabled: !!busy || (prog ? !prog.can_level_up : false),
                title: prog && !prog.can_level_up ? prog.level_blockers.join('; ') : undefined,
                onClick: () => run('levelup'),
              }]),
        {
          content: 'Расформировать', buttonType: 'danger', loading: busy === 'dissolve', disabled: !!busy,
          // подтверждение отдельным окном: эпическая и выше — ВСЕГДА (редкие осколки, жалко сжечь
          // даже на 1 уровне), ниже эпической — только если уровень >1 (вложен стаж/осколки)
          onClick: () => (HIGH_RARITIES.has(policy.rarity) || policy.level > 1) ? setConfirmDissolve(true) : run('dissolve'),
        },
      ]}
    >
      <Box>
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
        {prog && (
          <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, mb: 3 }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold', display: 'block', mb: 1 }}>Повышение</Text>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
              <Text sx={{ color: 'fg.muted' }}>Стаж</Text>
              <Text className="mono" sx={{ color: prog.tenure_needed != null && prog.tenure_now >= prog.tenure_needed ? 'success.fg' : 'fg.default' }}>
                {prog.tenure_now}{prog.tenure_needed != null ? ` / ${prog.tenure_needed} дн.` : ' дн.'}
              </Text>
            </Box>
            {prog.level_shards_needed != null && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
                <Text sx={{ color: 'fg.muted' }}>Осколков на уровень</Text>
                <Text className="mono" sx={{ color: prog.have_shards >= prog.level_shards_needed ? 'success.fg' : 'danger.fg' }}>
                  {prog.have_shards} / {prog.level_shards_needed}
                </Text>
              </Box>
            )}
            {prog.promote_shards_needed != null && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
                <Text sx={{ color: 'fg.muted' }}>
                  Осколков на редкость{prog.promote_target_rarity ? ` (${RARITY_NAME[prog.promote_target_rarity] ?? prog.promote_target_rarity})` : ''}
                </Text>
                <Text className="mono" sx={{ color: prog.have_shards >= prog.promote_shards_needed ? 'success.fg' : 'danger.fg' }}>
                  {prog.have_shards} / {prog.promote_shards_needed}
                </Text>
              </Box>
            )}
            {!enacted && (
              <Text sx={{ fontSize: 0, color: freeSlots > 0 ? 'fg.muted' : 'attention.fg', display: 'block', mt: 1 }}>
                {freeSlots > 0 ? `Свободных слотов кабинета: ${freeSlots}` : 'Нет свободных слотов кабинета — «Применить» недоступно'}
              </Text>
            )}
            {!enacted && prog.tenure_needed != null && (
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
                Стаж идёт, только пока политика надета.
              </Text>
            )}
            {/* данные из снимка: если качать политику прямо в игре, мимо панели, числа устареют
                и кнопка может звать на действие, которое игра отклонит */}
            <Text sx={{ fontSize: 0, color: 'fg.subtle', display: 'block', mt: 1 }}>
              По снимку от {snapshotAt ? new Date(snapshotAt).toLocaleString('ru') : '—'}
            </Text>
          </Box>
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
      </Box>
    </Dialog>
    {confirmDissolve && (
      <ConfirmationDialog
        title="Расформировать политику?"
        cancelButtonContent="Отмена"
        confirmButtonContent="Расформировать"
        confirmButtonType="danger"
        onClose={(gesture) => {
          setConfirmDissolve(false);
          if (gesture === 'confirm') run('dissolve');
        }}
      >
        Уровень {policy.level} — вложенные стаж и осколки будут потеряны безвозвратно.
      </ConfirmationDialog>
    )}
    </>
  );
}

// ── Карточка осколка/тайной политики — как на странице "Предметы" ───────────
// Клик открывает модалку с действием (создать/открыть), кнопка внутри недоступна,
// если условие фичи не выполнено (1 000 000 населения) — не сама карточка.

function ShardCard({ shard, onClick }: { shard: PolicyShardItem; onClick: () => void }) {
  const meta = ITEMS_BY_ID[Number(shard.id)] ?? null;
  const name = meta?.name ?? shard.type;
  return (
    <Tooltip text={name} direction="n" noDelay>
      <div className="item-card clickable" aria-label={name} onClick={onClick}>
        <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`}>
          {/* 13.10.2026: карточки осколков выглядели заметно мельче карточек политик (та же
              item-card__box, 77×77, но картинка внутри уменьшалась через scale) — без подписи снизу
              (убрали в пользу тултипа) разница в заполненности бросалась в глаза ещё сильнее.
              Убран scale — иконка теперь занимает всю высоту бокса, как у политик. */}
          {meta
            // object-fit:cover (не contain, как в общем .item-card__img) — у картинок осколков
            // много прозрачных полей внутри самого файла, из-за contain бокс выглядел пустее и
            // мельче, чем у политик (там сплошная заливка + mdi-иконка, не файл с паддингом)
            ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt={meta.name}
                style={{ width: 77, objectFit: 'cover' }}
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
            : <span style={{ fontSize: 10, textAlign: 'center', padding: 4 }}>{shard.type}</span>}
          {shard.qty > 1 && <span className="item-card__count">{shard.qty}</span>}
        </div>
      </div>
    </Tooltip>
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
    <Dialog
      title={meta?.name ?? shard.type}
      onClose={onClose}
      width="medium"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{
        content: isMystery ? 'Открыть' : 'Создать тайную политику',
        buttonType: 'primary',
        loading: busy,
        disabled: busy || locked || notEnough,
        onClick: run,
      }]}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
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
                  {/* 13.10.2026: сначала применённые (в кабинете мэра), затем по редкости от вечной к обычной,
                      внутри одной редкости — одинаковые политики (def_id) рядом друг с другом */}
                  {[...data.list]
                    .sort((a, b) =>
                      (Number(enactedIds.has(b.id)) - Number(enactedIds.has(a.id)))
                      || ((RARITY_RANK[a.rarity] ?? 99) - (RARITY_RANK[b.rarity] ?? 99))
                      || a.def_id.localeCompare(b.def_id))
                    .map(p => (
                      <PolicyBadge key={p.id} policy={p} enacted={enactedIds.has(p.id)}
                        onClick={() => onOpenPolicy(accountId, p, enactedIds.has(p.id))} />
                    ))}
                </div>
              )}
              {data.shards.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {/* от самой редкой к самой частой — тот же порядок, что и у карточек политик выше */}
                  {[...data.shards]
                    .sort((a, b) => (RARITY_RANK[ITEMS_BY_ID[Number(a.id)]?.tag] ?? 99) - (RARITY_RANK[ITEMS_BY_ID[Number(b.id)]?.tag] ?? 99))
                    .map(s => (
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
  const [policyModal, setPolicyModal] = useState<{ accountId: number; policy: PolicyInstance; enacted: boolean; freeSlots: number; snapshotAt: string | null } | null>(null);
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

  // После действия (повысить уровень, вставить осколки, сменить редкость) окно НЕ закрываем —
  // подряд обычно делают несколько действий, и захлопывающаяся модалка заставляла каждый раз
  // искать ту же политику заново. Вместо этого перечитываем данные и подставляем в открытое окно
  // свежую версию той же политики/осколка; если её больше нет (распустили, слили в другую) —
  // тогда уже закрываем, показывать нечего.
  // ВАЖНО: обновляем ИМЕННО ТО окно, действие в котором вызвало перезагрузку. Раньше здесь
  // использовался снимок состояния на момент вызова: пока шёл запрос, пользователь успевал открыть
  // карточку ДРУГОГО аккаунта, и ответ подменял/закрывал уже другое окно (жалоба 13.08). Теперь
  // сверяем аккаунт и id политики в функциональном setState — чужое окно не трогаем вовсе.
  const refreshOpenPolicy = async (target: { accountId: number; policyId: number }) => {
    const d = await api.policies().catch(() => null);
    if (d?.ok) { setByAccount(d.byAccount ?? {}); setAccIdByName(d.accIdByName ?? {}); }
    const accName = Object.keys(d?.accIdByName ?? {}).find(n => (d?.accIdByName ?? {})[n] === target.accountId);
    const data = accName ? d?.byAccount?.[accName] : null;
    const fresh = data?.list?.find(p => p.id === target.policyId) ?? null;
    setPolicyModal(cur => {
      if (!cur || cur.accountId !== target.accountId || cur.policy.id !== target.policyId) return cur;
      if (!fresh || !data) return null;   // политику распустили/слили — показывать нечего
      return {
        ...cur,
        policy: fresh,
        enacted: fresh.enacted_slot != null,
        freeSlots: data.free_slots ?? 0,
        snapshotAt: data.updated_at,
      };
    });
  };

  const refreshOpenShard = async (target: { accountId: number; shardId: string }) => {
    const d = await api.policies().catch(() => null);
    if (d?.ok) { setByAccount(d.byAccount ?? {}); setAccIdByName(d.accIdByName ?? {}); }
    const accName = Object.keys(d?.accIdByName ?? {}).find(n => (d?.accIdByName ?? {})[n] === target.accountId);
    const data = accName ? d?.byAccount?.[accName] : null;
    const fresh = data?.shards?.find(x => x.id === target.shardId) ?? null;
    setShardModal(cur => {
      if (!cur || cur.accountId !== target.accountId || cur.shard.id !== target.shardId) return cur;
      if (!fresh || !data) return null;
      return { ...cur, shard: fresh, economy: data.economy };
    });
  };

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
              onOpenPolicy={(accountId, policy, enacted) => setPolicyModal({ accountId, policy, enacted, freeSlots: data.free_slots ?? 0, snapshotAt: data.updated_at })}
              onOpenShard={(accountId, shard) => setShardModal({ accountId, shard, locked: shard.type === 'mystery_policy' && !data.policies_unlocked, economy: data.economy })} />
          ))}

      {policyModal && (
        <PolicyModal
          policy={policyModal.policy}
          accountId={policyModal.accountId}
          enacted={policyModal.enacted}
          freeSlots={policyModal.freeSlots}
          snapshotAt={policyModal.snapshotAt}
          onStale={() => load(true)}
          onClose={() => setPolicyModal(null)}
          onChanged={() => refreshOpenPolicy({ accountId: policyModal.accountId, policyId: policyModal.policy.id })}
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
          onChanged={() => refreshOpenShard({ accountId: shardModal.accountId, shardId: shardModal.shard.id })}
        />
      )}
    </Box>
  );
}
