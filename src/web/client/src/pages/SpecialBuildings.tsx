import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, TextInput, ProgressBar } from '@primer/react';
import { SyncIcon, CheckIcon, LockIcon, UnlockIcon } from '@primer/octicons-react';
import {
  api, type SpecialBuildingRow, type BuildingAccount,
  type TechFactoryOverview, type TechFactoryCategory, type TechFactoryRecipe,
  type AuditoriumStatus, type AuditoriumGate, type LocText,
} from '../api';
import { ITEMS_BY_ID, itemImgSrc, fmt } from '../utils';
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

function ItemChip({ itemId, quantity }: { itemId: number; quantity: number }) {
  const meta = ITEMS_BY_ID[itemId];
  return (
    <div className="item-card" title={meta?.name ?? `#${itemId}`}>
      <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`} style={{ width: 44, height: 44 }}>
        {meta
          ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt="" style={{ height: 44, scale: String(meta.scale) }}
              onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
          : <span style={{ fontSize: 9 }}>#{itemId}</span>}
        <span className="item-card__count">{quantity}</span>
      </div>
    </div>
  );
}

function RecipeRow({ recipe, onStart, starting, busy }: { recipe: TechFactoryRecipe; onStart: () => void; starting: boolean; busy: boolean }) {
  const limited = (recipe.used ?? 0) >= (recipe.limit_count ?? Infinity);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2, mb: 1, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        {(recipe.inputs ?? []).map((inp, i) => <ItemChip key={i} itemId={inp.item_id} quantity={inp.quantity} />)}
        <Text sx={{ color: 'fg.muted' }}>→</Text>
        {recipe.output && <ItemChip itemId={recipe.output.item_id} quantity={recipe.output.quantity} />}
      </Box>
      <Box sx={{ flex: 1, minWidth: 140 }}>
        <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>{loc(recipe.name)}</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {Math.round(recipe.duration_seconds / 60)} мин · 💎{recipe.fee_crystals} · {recipe.used}/{recipe.limit_count} {recipe.limit_window === 'week' ? 'в неделю' : 'в день'}
        </Text>
      </Box>
      <Button variant="primary" loading={starting} disabled={limited || busy} onClick={onStart}>
        {limited ? 'Лимит исчерпан' : 'Начать крафт'}
      </Button>
    </Box>
  );
}

function CategoryBlock({ accountId, category, jobActive, onRefresh, onFlash }: {
  accountId: number; category: TechFactoryCategory; jobActive: boolean;
  onRefresh: () => void; onFlash: (m: string, ok: boolean) => void;
}) {
  const [amount, setAmount] = useState('');
  const [contributing, setContributing] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);
  const pool = category.pool;
  const pct = pool && pool.target > 0 ? Math.min(100, Math.round(pool.progress / pool.target * 100)) : 0;

  const contribute = async () => {
    const n = Number(amount);
    if (!n || n <= 0) return;
    setContributing(true);
    try {
      const r = await api.techFactoryContribute(accountId, category.code, n);
      if (r.ok) { onFlash('Вложено в пул', true); setAmount(''); onRefresh(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setContributing(false); }
  };

  const start = async (recipeId: number) => {
    setStartingId(recipeId);
    try {
      const r = await api.techFactoryStart(accountId, recipeId);
      if (r.ok) { onFlash('Крафт начат', true); onRefresh(); } else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setStartingId(null); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold' }}>{loc(category.name)}</Text>
        {!category.unlocked && <Label variant="attention" sx={{ fontSize: 0 }}>Не открыта</Label>}
      </Box>
      {category.description && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>{loc(category.description)}</Text>}

      {!category.unlocked && pool && (
        <Box sx={{ mb: 1 }}>
          <ProgressBar progress={pct} sx={{ bg: 'canvas.subtle', mb: 1 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{fmt(pool.progress)}/{fmt(pool.target)} Почёта</Text>
            <TextInput size="small" type="number" placeholder="Сумма" value={amount} onChange={e => setAmount(e.target.value)} sx={{ width: 100 }} />
            <Button variant="primary" loading={contributing} disabled={!amount} onClick={contribute}>Вложить</Button>
          </Box>
        </Box>
      )}

      {category.unlocked && (category.recipes ?? []).map(r => (
        <RecipeRow key={r.id} recipe={r} starting={startingId === r.id} busy={jobActive} onStart={() => start(r.id)} />
      ))}
    </Box>
  );
}

function FactoryAccountBlock({ account, onFlash }: { account: BuildingAccount; onFlash: (m: string, ok: boolean) => void }) {
  const [data, setData] = useState<TechFactoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
                {data.job && (
                  <Box sx={{ mb: 3, p: 2, bg: data.job.ready ? 'success.subtle' : 'canvas.subtle', borderRadius: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    {data.job.output && <ItemChip itemId={data.job.output.item_id} quantity={data.job.output.quantity} />}
                    <Box sx={{ flex: 1, minWidth: 120 }}>
                      <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>Крафт {data.job.ready ? 'готов' : 'в процессе'}</Text>
                      {!data.job.ready && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Осталось: {timeLeft(data.job.finishes_at)}</Text>}
                    </Box>
                    {data.job.ready && <Button variant="primary" leadingVisual={CheckIcon} loading={claiming} onClick={claim}>Забрать</Button>}
                  </Box>
                )}
                {(data.categories ?? []).length === 0
                  ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Категорий рецептов пока нет</Text>
                  : data.categories.map(c => (
                    <CategoryBlock key={c.code} accountId={account.id} category={c} jobActive={!!data.job && !data.job.ready} onRefresh={load} onFlash={onFlash} />
                  ))}
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

const GATE_LABEL: Record<string, string> = {
  renown: 'Заработанный Почёт (за всё время в гильдии)',
  loyalty: 'Верность гильдии (дней подряд)',
  population: 'Население города',
};

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

function AuditoriumAccountBlock({ account, onFlash }: { account: BuildingAccount; onFlash: (m: string, ok: boolean) => void }) {
  const [data, setData] = useState<AuditoriumStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.auditoriumStatus(account.id);
      if (r.ok) setData(r as AuditoriumStatus); else setError(r.error ?? 'Ошибка загрузки');
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const enter = async () => {
    setEntering(true);
    try {
      const r = await api.auditoriumEnter(account.id);
      if (r.ok) onFlash('Вход выполнен', true); else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setEntering(false); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {data?.unlocked ? <UnlockIcon size={16} /> : <LockIcon size={16} />}
          <Text sx={{ fontWeight: 'bold' }}>{account.name}</Text>
        </Box>
        <Button leadingVisual={SyncIcon} onClick={load} disabled={loading}>Обновить</Button>
      </Box>
      <Box sx={{ p: 3 }}>
        {loading
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : error
            ? <Flash variant="danger">{error}</Flash>
            : !data || !data.updated_at ? <Text sx={{ color: 'fg.muted' }}>Ещё не синхронизировано — нажмите «Обновить с игры» выше</Text> : (
              <>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>Снимок от {new Date(data.updated_at).toLocaleString('ru')}</Text>
                <GateRow gateKey="renown" gate={data.renown} />
                <GateRow gateKey="loyalty" gate={data.loyalty} />
                <GateRow gateKey="population" gate={data.population} />
                <Button variant="primary" block disabled={!data.unlocked} loading={entering} onClick={enter}>
                  {data.unlocked ? 'Войти в Аудиториум' : 'Условия ещё не выполнены'}
                </Button>
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
