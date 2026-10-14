import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, TextInput, ProgressBar, Tooltip, Select, UnderlineNav, ConfirmationDialog } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon, CheckIcon, LockIcon, UnlockIcon, XIcon, TriangleUpIcon, TriangleDownIcon, ClockIcon, AlertIcon } from '@primer/octicons-react';
import {
  api, type SpecialBuildingRow, type BuildingAccount,
  type TechFactoryOverview, type TechFactoryCategory, type TechFactoryMachine, type TechFactoryTier,
  type AuditoriumStatus, type AuditoriumGate, type AuditoriumCatalog, type AuditoriumSku, type AuditoriumTier, type LocText,
} from '../api';
import { ITEMS_BY_ID, itemImgSrc, fmt, fmtInt } from '../utils';
import { ItemThumb } from '../components/ItemThumb';
import { RARITY_COLOR } from '../components/PolicyCardModal';
import { useItemCatalog, catalogItemName, type CatalogItem } from '../hooks/useItemCatalog';
import { RenownValue } from '../components/Icons';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

type Kind = 'auditorium' | 'factory';
const META: Record<Kind, { title: string; levelKey: 'auditorium_level' | 'factory_level' }> = {
  auditorium: { title: 'Аудиториум', levelKey: 'auditorium_level' },
  factory: { title: 'Фабрика', levelKey: 'factory_level' },
};

// name/description от игры приходят как {en, ru} (см. React error #31 — раньше рендерили объект
// напрямую), но на всякий случай принимаем и голую строку
function loc(v: LocText | undefined): string {
  if (!v) return '';
  return typeof v === 'string' ? v : (v.ru || v.en || '');
}

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'готово';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// ── таблица "какая гильдия имеет здание" — существующая заглушка, оставлена как справочная сводка ──
function GuildLevelsTable({ kind }: { kind: Kind }) {
  const { levelKey } = META[kind];
  const [rows, setRows] = useState<SpecialBuildingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('specialBuildingsRefresh', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try { const d = await api.specialBuildings(); if (d.ok) setRows(d.rows); } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.specialBuildingsRefresh();
      if (d.ok) {
        const errs = d.results.filter(r => !r.ok);
        await load();
        showFlash(errs.length ? `Обновлено, ошибки: ${errs.map(e => e.guild).join(', ')}` : 'Обновлено с сервера игры', errs.length === 0);
      } else showFlash('Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  const present = rows.filter(r => r[levelKey] != null).sort((a, b) => (a.guild_title ?? '').localeCompare(b.guild_title ?? '', 'ru', { numeric: true }));

  return (
    <Box sx={{ mb: 4 }}>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center' }}>
        <Button onClick={refresh} disabled={refreshing} loading={refreshing}>↻ Обновить уровни гильдий</Button>
        <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Гильдий с этим зданием: {present.length}</Text>
      </Box>

      {loading
        ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        : present.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет гильдий с этим зданием. Нажмите «Обновить», чтобы подтянуть данные с сервера игры (видно лидерам/офицерам).</Text>
          : (
            <Box sx={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr><th>Гильдия</th><th>Уровень</th><th>Обновлено</th></tr>
                </thead>
                <tbody>
                  {present.map(r => (
                    <tr key={r.guild_id}>
                      <td>
                        <strong>{r.guild_title}</strong>
                        <div style={{ fontSize: 11, color: 'var(--fgColor-muted, #848d97)' }}>ID: {r.guild_id}</div>
                      </td>
                      <td><Label variant="accent">Ур. {r[levelKey]}</Label></td>
                      <td className="mono" style={{ fontSize: 11 }}>{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          )}
    </Box>
  );
}

// ── Технологическая фабрика: интерактивная часть ─────────────────────────────

const TIER_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function ItemChip({ itemId, quantity, size = 44 }: { itemId: number; quantity: number; size?: number }) {
  const meta = ITEMS_BY_ID[itemId];
  return (
    <Tooltip text={meta?.name ?? `#${itemId}`} direction="n" noDelay>
      <div className="item-card" aria-label={meta?.name ?? `#${itemId}`}>
        <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`} style={{ width: size, height: size }}>
          {meta
            ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt="" style={{ height: size }}
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
            : <span style={{ fontSize: 9 }}>#{itemId}</span>}
          <span className="item-card__count">{quantity}</span>
        </div>
      </div>
    </Tooltip>
  );
}

// 13.10.2026: станок = квадратная карточка (та же сетка, что у Предметов/Политик), клик открывает
// модалку с тирами. Сам крафт — один на аккаунт (job), поэтому "Запустить" внутри модалки гасится,
// пока job активен, а "В очередь" доступно всегда — её разбирает фоновый цикл
// (modules/guildBuildings.js runTechFactoryLoop) сам, по мере освобождения станка.
function MachineCard({ machine, jobActive, onClick }: { machine: TechFactoryMachine; jobActive: boolean; onClick: () => void }) {
  const hasReady = (machine.tiers ?? []).some(t => t.unlocked && (t.used ?? 0) < (t.limit_count ?? Infinity));
  return (
    <Tooltip text={loc(machine.name)} direction="n" noDelay>
      <div className="item-card clickable" aria-label={loc(machine.name)} onClick={onClick}>
        <div className="item-card__box" style={{ background: hasReady && !jobActive ? '#2d6a4f' : '#484868', position: 'relative' }}>
          <span className={`mdi ${(machine.icon_key || 'mdi-cog').replace(/^mdi-?/, 'mdi-')}`} style={{ fontSize: 30, color: '#fff' }} />
        </div>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 600 }}>Ур. {machine.level}/{machine.max_level}</span>
      </div>
    </Tooltip>
  );
}

function TierDetail({ accountId, machine, tier, jobActive, canUpgrade, guildCrystalBalance, onDone, onFlash }: {
  accountId: number; machine: TechFactoryMachine; tier: TechFactoryTier; jobActive: boolean;
  canUpgrade: boolean; guildCrystalBalance: number | null;
  onDone: () => void; onFlash: (m: string, ok: boolean) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const limited = tier.unlocked && (tier.used ?? 0) >= (tier.limit_count ?? Infinity);

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.techFactoryStart(accountId, machine.id, tier.level);
      if (r.ok) { onFlash('Переработка запущена', true); onDone(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setStarting(false); }
  };
  const enqueue = async () => {
    setQueuing(true);
    try {
      const r = await api.techFactoryQueueAdd(accountId, machine.id, tier.level);
      if (r.ok) { onFlash('Добавлено в очередь', true); onDone(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setQueuing(false); }
  };
  const upgrade = async () => {
    setUpgrading(true);
    try {
      const r = await api.techFactoryUpgrade(accountId, machine.id, tier.level);
      if (r.ok) { onFlash('Тир разблокирован', true); onDone(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setUpgrading(false); }
  };

  if (!tier.unlocked) {
    const canAfford = tier.upgrade_crystals != null && guildCrystalBalance != null && guildCrystalBalance >= tier.upgrade_crystals;
    return (
      <Box sx={{ textAlign: 'center', p: 2 }}>
        <LockIcon size={20} />
        <Text sx={{ display: 'block', fontSize: 1, color: 'fg.muted', mt: 1, mb: 2 }}>
          Тир {TIER_ROMAN[tier.level - 1]} заблокирован — разблокировка за 💎{tier.upgrade_crystals ?? '?'} из казны гильдии
          {!canUpgrade && ' (только офицеры/лидер)'}
        </Text>
        <Button variant="primary" leadingVisual={UnlockIcon} loading={upgrading}
          disabled={!canUpgrade || !canAfford} onClick={upgrade}>
          Разблокировать
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {(tier.inputs ?? []).map((inp, i) => <ItemChip key={i} itemId={inp.item_id} quantity={inp.quantity} />)}
        </Box>
        <Text sx={{ color: 'fg.muted', fontSize: 3 }}>→</Text>
        {tier.output && <ItemChip itemId={tier.output.item_id} quantity={tier.output.quantity} size={52} />}
      </Box>
      <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', textAlign: 'center', mb: 3 }}>
        {Math.round(tier.duration_seconds / 60)} мин{tier.fee_crystals > 0 ? ` · 💎${tier.fee_crystals}` : ''} · {tier.used}/{tier.limit_count} {tier.limit_window === 'week' ? 'в неделю' : 'в день'}
      </Text>
      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant="primary" loading={starting} disabled={limited || jobActive} onClick={start}>
          {limited ? 'Лимит исчерпан' : jobActive ? 'Станок занят' : 'Запустить'}
        </Button>
        <Button loading={queuing} disabled={limited} onClick={enqueue}>В очередь</Button>
      </Box>
    </Box>
  );
}

function MachineModal({ accountId, machine, jobActive, canUpgrade, guildCrystalBalance, onClose, onDone, onFlash }: {
  accountId: number; machine: TechFactoryMachine; jobActive: boolean; canUpgrade: boolean; guildCrystalBalance: number | null;
  onClose: () => void; onDone: () => void; onFlash: (m: string, ok: boolean) => void;
}) {
  const unlockedTiers = machine.tiers.filter(t => t.unlocked);
  const firstLocked = machine.tiers.find(t => !t.unlocked);
  const [level, setLevel] = useState(unlockedTiers[unlockedTiers.length - 1]?.level ?? machine.tiers[0]?.level ?? 1);
  const tier = machine.tiers.find(t => t.level === level) ?? machine.tiers[0];

  return (
    <Dialog title={loc(machine.name)} onClose={onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box sx={{ p: 1 }}>
        {machine.description && <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', textAlign: 'center', mb: 3 }}>{loc(machine.description)}</Text>}
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', mb: 3, flexWrap: 'wrap' }}>
          {machine.tiers.map(t => (
            <Button key={t.level} size="small" variant={t.level === level ? 'primary' : 'default'}
              disabled={!t.unlocked && t.level !== firstLocked?.level} onClick={() => setLevel(t.level)}>
              {TIER_ROMAN[t.level - 1] ?? t.level}{!t.unlocked && ' 🔒'}
            </Button>
          ))}
        </Box>
        {tier && (
          <TierDetail accountId={accountId} machine={machine} tier={tier} jobActive={jobActive}
            canUpgrade={canUpgrade} guildCrystalBalance={guildCrystalBalance}
            onDone={() => { onDone(); onClose(); }} onFlash={onFlash} />
        )}
      </Box>
    </Dialog>
  );
}

function QueueList({ accountId, queue, categories, onChanged }: {
  accountId: number; queue: { id: number; machine_id: string; level: number }[];
  categories: TechFactoryCategory[]; onChanged: () => void;
}) {
  const machineName = (id: string) => {
    for (const c of categories) for (const m of c.machines ?? []) if (m.id === id) return loc(m.name);
    return id;
  };
  const move = async (idx: number, dir: -1 | 1) => {
    const ids = queue.map(q => q.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api.techFactoryQueueReorder(accountId, ids);
    onChanged();
  };
  const remove = async (id: number) => { await api.techFactoryQueueRemove(accountId, id); onChanged(); };

  if (!queue.length) return null;
  return (
    <Box sx={{ mb: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2 }}>
      <Text sx={{ fontWeight: 'bold', fontSize: 1, display: 'block', mb: 2 }}>Очередь ({queue.length})</Text>
      {queue.map((q, i) => (
        <Box key={q.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, borderTop: i > 0 ? '1px solid' : 'none', borderColor: 'border.muted' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', width: 20 }}>{i + 1}.</Text>
          <Text sx={{ fontSize: 1, flex: 1 }}>{machineName(q.machine_id)} · {TIER_ROMAN[q.level - 1] ?? q.level}</Text>
          <Button size="small" variant="invisible" icon={TriangleUpIcon} aria-label="Выше" disabled={i === 0} onClick={() => move(i, -1)} />
          <Button size="small" variant="invisible" icon={TriangleDownIcon} aria-label="Ниже" disabled={i === queue.length - 1} onClick={() => move(i, 1)} />
          <Button size="small" variant="danger" icon={XIcon} aria-label="Убрать" onClick={() => remove(q.id)} />
        </Box>
      ))}
    </Box>
  );
}

function CategoryBlock({ accountId, category, jobActive, canUpgrade, guildCrystalBalance, onOpenMachine, onRefresh, onFlash }: {
  accountId: number; category: TechFactoryCategory; jobActive: boolean; canUpgrade: boolean; guildCrystalBalance: number | null;
  onOpenMachine: (m: TechFactoryMachine) => void;
  onRefresh: () => void; onFlash: (m: string, ok: boolean) => void;
}) {
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<'personal' | 'guild'>('personal');
  const [contributing, setContributing] = useState(false);

  const contribute = async () => {
    const n = Number(amount);
    if (!n || n <= 0) return;
    setContributing(true);
    try {
      const r = await api.techFactoryContribute(accountId, category.id, n, source);
      if (r.ok) { onFlash('Вложено', true); setAmount(''); onRefresh(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setContributing(false); }
  };

  const pool = category.pool;
  const pct = pool && pool.target > 0 ? Math.min(100, Math.round(pool.progress / pool.target * 100)) : 0;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold' }}>{category.name ? loc(category.name) : category.code}</Text>
        {!category.unlocked && <Label variant="attention" sx={{ fontSize: 0 }}>Не открыта{category.machine_total ? ` · станков: ${category.machine_total}` : ''}</Label>}
      </Box>
      {category.description && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>{loc(category.description)}</Text>}

      {!category.unlocked && pool && (
        <Box sx={{ mb: 1 }}>
          <ProgressBar progress={pct} sx={{ bg: 'canvas.subtle', mb: 1 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{fmt(pool.progress)}/{fmt(pool.target)} Почёта{!pool.fundable ? ' · сначала откройте предыдущую категорию' : ''}</Text>
            <TextInput size="small" type="number" placeholder="Сумма Почёта" value={amount} onChange={e => setAmount(e.target.value)} sx={{ width: 120 }} disabled={!pool.fundable} />
            <Select size="small" value={source} onChange={e => setSource(e.target.value as 'personal' | 'guild')} disabled={!pool.fundable}>
              <Select.Option value="personal">Свой Почёт</Select.Option>
              <Select.Option value="guild">Казна гильдии</Select.Option>
            </Select>
            <Button variant="primary" loading={contributing} disabled={!amount || !pool.fundable} onClick={contribute}>Вложить</Button>
          </Box>
        </Box>
      )}

      {category.unlocked && (category.machines ?? []).length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 12, mt: 1 }}>
          {category.machines.map(m => (
            <MachineCard key={m.id} machine={m} jobActive={jobActive} onClick={() => onOpenMachine(m)} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function FactoryAccountBlock({ account, onFlash }: { account: BuildingAccount; onFlash: (m: string, ok: boolean) => void }) {
  const [data, setData] = useState<TechFactoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openMachine, setOpenMachine] = useState<TechFactoryMachine | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.techFactoryOverview(account.id);
      if (r.ok) setData(r as TechFactoryOverview); else setError(r.error ?? 'Ошибка загрузки');
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const claim = async () => {
    setClaiming(true);
    try {
      const r = await api.techFactoryClaim(account.id);
      if (r.ok) { onFlash('Награда забрана', true); load(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setClaiming(false); }
  };

  const jobActive = !!data?.job && !data.job.ready;
  // станок активного задания — нужен, чтобы показать его имя в карточке job (job хранит только id)
  const jobMachine = data?.job ? (data.categories ?? []).flatMap(c => c.machines ?? []).find(m => m.id === data.job!.machine_id) : null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'bold' }}>{account.name}</Text>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {data && <RenownValue value={fmt(data.renown_balance)} />}
          <Button leadingVisual={SyncIcon} onClick={load} disabled={loading}>Обновить</Button>
        </Box>
      </Box>
      <Box sx={{ p: 3 }}>
        {loading
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : error
            ? <Flash variant="danger">{error}</Flash>
            : !data || !data.updated_at ? <Text sx={{ color: 'fg.muted' }}>Ещё не синхронизировано — нажмите «Обновить с игры» выше</Text> : (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>Снимок от {new Date(data.updated_at).toLocaleString('ru')}</Text>
                {!data.in_guild && <Flash variant="warning" sx={{ mb: 2, fontSize: 1 }}>Не участник гильдии (или меньше 24ч в ней) — переработки недоступны</Flash>}
                {data.job && (
                  <Box sx={{ mb: 3, p: 2, bg: data.job.ready ? 'success.subtle' : 'canvas.subtle', borderRadius: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    {data.job.output && <ItemChip itemId={data.job.output.item_id} quantity={data.job.output.quantity} />}
                    <Box sx={{ flex: 1, minWidth: 120 }}>
                      <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>
                        {jobMachine ? loc(jobMachine.name) : data.job.machine_id} {TIER_ROMAN[data.job.level - 1] ?? data.job.level} — {data.job.ready ? 'готово' : 'в процессе'}
                      </Text>
                      {!data.job.ready && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Осталось: {timeLeft(data.job.finishes_at)}</Text>}
                    </Box>
                    {data.job.ready && <Button variant="primary" leadingVisual={CheckIcon} loading={claiming} onClick={claim}>Забрать</Button>}
                  </Box>
                )}
                <QueueList accountId={account.id} queue={data.queue ?? []} categories={data.categories ?? []} onChanged={load} />
                {(data.categories ?? []).length === 0
                  ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Категорий станков пока нет</Text>
                  : data.categories.map(c => (
                    <CategoryBlock key={c.id} accountId={account.id} category={c} jobActive={jobActive}
                      canUpgrade={data.can_spend_guild_crystals} guildCrystalBalance={data.guild_crystal_balance}
                      onOpenMachine={setOpenMachine} onRefresh={load} onFlash={onFlash} />
                  ))}
                {openMachine && (
                  <MachineModal accountId={account.id} machine={openMachine} jobActive={jobActive}
                    canUpgrade={data.can_spend_guild_crystals} guildCrystalBalance={data.guild_crystal_balance}
                    onClose={() => setOpenMachine(null)} onDone={load} onFlash={onFlash} />
                )}
              </>
            )}
      </Box>
    </Box>
  );
}

function FactoryLive() {
  const [accounts, setAccounts] = useState<BuildingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:techfactory', () => { load(); setRefreshKey(k => k + 1); });
  const [refreshKey, setRefreshKey] = useState(0);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try { const r = await api.techFactoryAccounts(); if (r.ok) setAccounts(r.accounts); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const refreshFromGame = async () => {
    setRefreshing(true);
    try {
      await api.refresh('techfactory');
      await load();
      setRefreshKey(k => k + 1); // форсирует перезагрузку карточек аккаунтов (снимок в БД обновился)
      showFlash('Обновлено с сервера игры', true);
    } catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>Ваши аккаунты в этих гильдиях</Text>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refreshFromGame}>
          Обновить с игры
        </Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {loading
        ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        : accounts.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет своих аккаунтов, чья гильдия построила Фабрику (по данным таблицы выше — если гильдия там не появилась, нажмите «Обновить уровни гильдий»).</Text>
          : accounts.map(a => <FactoryAccountBlock key={`${a.id}-${refreshKey}`} account={a} onFlash={showFlash} />)}
    </Box>
  );
}

// ── Вечный аудиториум: интерактивная часть ────────────────────────────────────
// Повторяет страницу игры (chunks/timeless_auditorium-*.js): пока вход закрыт — условия входа,
// когда открыт — баланс Почёта, уровни престижа и витрина по разделам с обменом Почёта на предметы.

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

function GateRow({ gateKey, gate }: { gateKey: string; gate: AuditoriumGate | null }) {
  if (!gate) return null;
  const pct = gate.required > 0 ? Math.min(100, Math.round(gate.current / gate.required * 100)) : 100;
  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ fontSize: 1 }}>{GATE_LABEL[gateKey] ?? gateKey}</Text>
        <Text sx={{ fontSize: 0, color: gate.met ? 'success.fg' : 'fg.muted' }}>{fmt(gate.current)}/{fmt(gate.required)}</Text>
      </Box>
      <ProgressBar progress={pct} sx={{ bg: 'canvas.subtle' }} />
    </Box>
  );
}

function TierLadder({ tiers, lifetime }: { tiers: AuditoriumTier[]; lifetime: number }) {
  const next = tiers.find(t => !t.reached);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3, mb: 3 }}>
      <Text sx={{ fontWeight: 'bold', display: 'block', mb: 2 }}>Уровни престижа</Text>
      {tiers.map(t => (
        <Box key={t.tier} sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
            <Box sx={{ color: t.reached ? 'success.fg' : 'fg.muted', display: 'flex' }}>{t.reached ? <CheckIcon size={16} /> : <LockIcon size={16} />}</Box>
            <Text sx={{ fontSize: 1, fontWeight: 'semibold' }}>{TIER_NAME[t.tier] ?? t.tier}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 'auto' }}>{fmt(t.threshold)} Почёта за всё время</Text>
          </Box>
          <ProgressBar progress={t.threshold > 0 ? Math.min(100, lifetime / t.threshold * 100) : 100}
            bg={t.reached ? 'success.emphasis' : 'accent.emphasis'} sx={{ bg: 'canvas.subtle' }} />
        </Box>
      ))}
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', textAlign: 'center' }}>
        {next
          ? `Ещё ${fmt(Math.max(0, next.threshold - lifetime))} Почёта за всё время до уровня «${TIER_NAME[next.tier] ?? next.tier}»`
          : 'Открыты все уровни — весь аудиториум в вашем распоряжении.'}
      </Text>
    </Box>
  );
}

function resetIn(iso: string | null): string {
  if (!iso) return 'Скоро сбросится';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Скоро сбросится';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `Сброс через ${d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`}`;
}

function skuName(sku: AuditoriumSku, catalog: Map<number, CatalogItem>): string {
  return ITEMS_BY_ID[sku.item_id]?.name ?? catalogItemName(catalog.get(sku.item_id)) ?? `Предмет #${sku.item_id}`;
}

function SkuIcon({ sku, catalog, size }: { sku: AuditoriumSku; catalog: Map<number, CatalogItem>; size: number }) {
  const meta = ITEMS_BY_ID[sku.item_id];
  return meta
    ? <img src={itemImgSrc(meta.tag)} alt="" style={{ width: size, height: size, objectFit: 'contain' }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
    : <ItemThumb itemId={sku.item_id} item={catalog.get(sku.item_id)} size={size} />;
}

function SkuCard({ sku, balance, tiers, catalog, onSelect }: {
  sku: AuditoriumSku; balance: number; tiers: AuditoriumTier[]; catalog: Map<number, CatalogItem>; onSelect: () => void;
}) {
  const color = RARITY_COLOR[sku.rarity] ?? '#6e7681';
  const lim = sku.limits;
  const enough = balance >= sku.renown;
  const canBuy = sku.purchasable && enough;
  const tierName = TIER_NAME[tiers.find(t => t.threshold === sku.min_lifetime_renown)?.tier ?? ''];
  let reason: string | null = null;
  if (!canBuy) {
    if (!sku.tier_met) reason = tierName ? `Сначала откройте «${tierName}»` : 'Нужен более высокий уровень престижа';
    else if (lim && lim.remaining <= 0) reason = resetIn(lim.resets_at);
    else if (!enough) reason = `Не хватает ${fmt(sku.renown - balance)} Почёта`;
  }
  return (
    <Box sx={{ border: '1px solid', borderColor: color, borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ width: 48, height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <SkuIcon sku={sku} catalog={catalog} size={44} />
        </Box>
        <Box sx={{ minWidth: 0, textAlign: 'left' }}>
          <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block' }}>
            {skuName(sku, catalog)}{sku.quantity > 1 && <Text sx={{ color: 'fg.muted', fontWeight: 'normal' }}> ×{sku.quantity}</Text>}
          </Text>
          <RenownValue value={fmt(sku.renown)} />
        </Box>
      </Box>
      {lim && (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {lim.used} из {lim.limit} за {PERIOD_NAME[lim.limit_days] ?? `${lim.limit_days} дн.`}
        </Text>
      )}
      {reason && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'fg.muted' }}>
          {!sku.tier_met ? <LockIcon size={12} /> : lim && lim.remaining <= 0 ? <ClockIcon size={12} /> : <AlertIcon size={12} />}
          <Text sx={{ fontSize: 0 }}>{reason}</Text>
        </Box>
      )}
      <Button size="small" block disabled={!canBuy} onClick={onSelect} sx={{ mt: 'auto' }}>Купить</Button>
    </Box>
  );
}

function AuditoriumShop({ account, data, onBought, onFlash }: {
  account: BuildingAccount; data: AuditoriumCatalog; onBought: () => void; onFlash: (m: string, ok: boolean) => void;
}) {
  const sections = data.sections ?? [];
  const [tab, setTab] = useState(sections[0]?.key ?? '');
  const [selected, setSelected] = useState<AuditoriumSku | null>(null);
  const [buying, setBuying] = useState(false);
  const catalog = useItemCatalog(sections.flatMap(s => s.skus.map(k => k.item_id)).filter(id => !ITEMS_BY_ID[id]));
  const skus = sections.find(s => s.key === tab)?.skus ?? [];

  const buy = async (sku: AuditoriumSku) => {
    setBuying(true);
    try {
      const r = await api.auditoriumBuy(account.id, sku.code);
      if (r.ok) { onFlash(`${account.name}: куплено «${skuName(sku, catalog)}»${sku.quantity > 1 ? ` ×${sku.quantity}` : ''}`, true); onBought(); }
      else onFlash(`${account.name}: ${r.error ?? 'ошибка покупки'}`, false);
    } catch (e) { onFlash(String(e), false); } finally { setBuying(false); }
  };

  return (
    <>
      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3, mb: 3, display: 'flex', justifyContent: 'space-between', gap: 3, flexWrap: 'wrap' }}>
        <Box>
          <Text sx={{ fontSize: 3, fontWeight: 'bold', display: 'block' }}><RenownValue value={fmtInt(data.balance)} /></Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Баланс Почёта</Text>
        </Box>
        <Box sx={{ textAlign: 'right' }}>
          <Text sx={{ fontSize: 2, fontWeight: 'bold', display: 'block' }}>{fmtInt(data.lifetime_earned)}</Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Заработано за всё время</Text>
        </Box>
      </Box>
      {data.tiers?.length > 0 && <TierLadder tiers={data.tiers} lifetime={data.lifetime_earned} />}
      {sections.length > 0 && (
        <UnderlineNav aria-label="Разделы аудиториума" sx={{ mb: 3 }}>
          {sections.map(s => (
            <UnderlineNav.Item key={s.key} href="#" aria-current={s.key === tab ? 'page' : undefined}
              counter={s.skus.length} onSelect={e => { e.preventDefault(); setTab(s.key); }}>
              {SECTION_NAME[s.key] ?? s.key}
            </UnderlineNav.Item>
          ))}
        </UnderlineNav>
      )}
      {skus.length === 0
        ? <Text sx={{ color: 'fg.muted', display: 'block', textAlign: 'center', py: 3 }}>Здесь пока пусто.</Text>
        : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 2 }}>
            {skus.map(s => <SkuCard key={s.code} sku={s} balance={data.balance} tiers={data.tiers ?? []} catalog={catalog} onSelect={() => setSelected(s)} />)}
          </Box>
        )}
      {selected && (
        <ConfirmationDialog
          title="Обменять Почёт на предмет?"
          cancelButtonContent="Отмена"
          confirmButtonContent="Подтвердить покупку"
          onClose={gesture => {
            const sku = selected;
            setSelected(null);
            if (gesture === 'confirm' && !buying) buy(sku);
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: 3 }}>
            <SkuIcon sku={selected} catalog={catalog} size={56} />
            <Text sx={{ fontWeight: 'bold' }}>{skuName(selected, catalog)}{selected.quantity > 1 ? ` ×${selected.quantity}` : ''}</Text>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Text sx={{ color: 'fg.muted' }}>Аккаунт</Text><Text>{account.name}</Text>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Text sx={{ color: 'fg.muted' }}>Цена</Text><RenownValue value={fmtInt(selected.renown)} />
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text sx={{ color: 'fg.muted' }}>Останется</Text><RenownValue value={fmtInt(data.balance - selected.renown)} />
          </Box>
        </ConfirmationDialog>
      )}
    </>
  );
}

function AuditoriumAccountBlock({ account, onFlash }: { account: BuildingAccount; onFlash: (m: string, ok: boolean) => void }) {
  const [data, setData] = useState<AuditoriumStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const r = await api.auditoriumStatus(account.id);
      if (r.ok) setData(r as AuditoriumStatus); else setError(r.error ?? 'Ошибка загрузки');
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {data?.unlocked ? <UnlockIcon size={16} /> : <LockIcon size={16} />}
          <Text sx={{ fontWeight: 'bold' }}>{account.name}</Text>
          {data?.catalog && <RenownValue value={fmtInt(data.catalog.balance)} />}
        </Box>
        <Button leadingVisual={SyncIcon} onClick={() => load()} disabled={loading}>Обновить</Button>
      </Box>
      <Box sx={{ p: 3 }}>
        {loading
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : error
            ? <Flash variant="danger">{error}</Flash>
            : !data || !data.updated_at ? <Text sx={{ color: 'fg.muted' }}>Ещё не синхронизировано — нажмите «Обновить с игры» выше</Text> : (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>Снимок от {new Date(data.updated_at).toLocaleString('ru')}</Text>
                {data.unlocked && data.catalog
                  ? <AuditoriumShop account={account} data={data.catalog} onBought={() => load(true)} onFlash={onFlash} />
                  : (
                    <>
                      {data.in_guild === false && <Flash sx={{ mb: 2 }}>Аккаунт не в гильдии — вступите, чтобы открыть путь в Аудиториум.</Flash>}
                      {data.in_guild !== false && data.has_auditorium === false && <Flash sx={{ mb: 2 }}>Гильдия ещё не построила Вечный аудиториум.</Flash>}
                      {data.unlocked && !data.catalog && <Flash variant="warning" sx={{ mb: 2 }}>Вход открыт, но витрину загрузить не удалось — нажмите «Обновить с игры».</Flash>}
                      <Text sx={{ fontWeight: 'bold', display: 'block', mb: 2 }}>Условия входа</Text>
                      <GateRow gateKey="renown" gate={data.renown} />
                      <GateRow gateKey="loyalty" gate={data.loyalty} />
                      <GateRow gateKey="population" gate={data.population} />
                      {!data.unlocked && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', textAlign: 'center' }}>Выполните все условия, чтобы войти.</Text>}
                    </>
                  )}
              </>
            )}
      </Box>
    </Box>
  );
}

function AuditoriumLive() {
  const [accounts, setAccounts] = useState<BuildingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:auditorium', () => { load(); setRefreshKey(k => k + 1); });
  const [refreshKey, setRefreshKey] = useState(0);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try { const r = await api.auditoriumAccounts(); if (r.ok) setAccounts(r.accounts); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const refreshFromGame = async () => {
    setRefreshing(true);
    try {
      await api.refresh('auditorium');
      await load();
      setRefreshKey(k => k + 1);
      showFlash('Обновлено с сервера игры', true);
    } catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>Ваши аккаунты в этих гильдиях</Text>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refreshFromGame}>
          Обновить с игры
        </Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {loading
        ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>
        : accounts.length === 0
          ? <Text sx={{ color: 'fg.muted' }}>Нет своих аккаунтов, чья гильдия построила Аудиториум (по данным таблицы выше — если гильдия там не появилась, нажмите «Обновить уровни гильдий»).</Text>
          : accounts.map(a => <AuditoriumAccountBlock key={`${a.id}-${refreshKey}`} account={a} onFlash={showFlash} />)}
    </Box>
  );
}

// ── страницы ───────────────────────────────────────────────────────────────────

function SpecialBuildings({ kind }: { kind: Kind }) {
  const { title } = META[kind];
  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>{title}</Heading>
      <GuildLevelsTable kind={kind} />
      {kind === 'factory' ? <FactoryLive /> : <AuditoriumLive />}
    </Box>
  );
}

export function Auditorium() { return <SpecialBuildings kind="auditorium" />; }
export function Factory() { return <SpecialBuildings kind="factory" />; }
