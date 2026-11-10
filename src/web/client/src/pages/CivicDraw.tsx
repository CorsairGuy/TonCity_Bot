import { useState, useEffect, useRef } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, ProgressBar, ToggleSwitch } from '@primer/react';
import { SyncIcon, GiftIcon } from '@primer/octicons-react';
import { api, type CivicDrawAccount, type PolicyGrantStatus } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { itemImgSrc } from '../utils';
import { useItemCatalog, itemName } from '../hooks/useItemCatalog';
import { ItemThumb } from '../components/ItemThumb';
import { onServerEvent } from '../serverEvents';

// Формат ответа /policies/civic-draw/claim подтверждён живым сбором (скриншот 14.07.2026):
// {draw_progress, draws_consumed, shards?: {rarity: qty}, quartermaster_shards?: {rarity: qty}}.
// Осколки квартирмейстера — отдельный от обычных осколков политик ресурс, но выделенной иконки
// под него в игре нет (в паках склада и на скриншотах используется та же графика "осколка"),
// поэтому переиспользуем shard_{rarity}.png с отдельной подписью группы, чтобы не путать их.
type RawResult = { account: string; result: unknown; error?: string };
type CivicDrawResult = {
  draw_progress?: number;
  draws_consumed?: number;
  shards?: Record<string, number>;
  quartermaster_shards?: Record<string, number>;
};
function isCivicDrawResult(v: unknown): v is CivicDrawResult {
  return !!v && typeof v === 'object' && ('shards' in v || 'quartermaster_shards' in v || 'draws_consumed' in v);
}

const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#C0392B',
};
const RARITY_NAME: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'eternal'];

// карточка группы осколков — 1:1 со стилем item-card на страницах Хранилище/Политики
function ShardGroup({ title, shards }: { title: string; shards?: Record<string, number> }) {
  const entries = RARITY_ORDER.filter(r => (shards?.[r] ?? 0) > 0);
  if (!entries.length) return null;
  return (
    <Box sx={{ mb: 2 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>{title}</Text>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {entries.map(rarity => (
          <div key={rarity} className="item-card" title={`${RARITY_NAME[rarity] ?? rarity} осколок`}>
            <div className={`item-card__box ic-shard_${rarity}`}>
              <img className="item-card__img" src={itemImgSrc(`shard_${rarity}`)} alt=""
                onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
              <span className="item-card__count">{shards![rarity]}</span>
            </div>
          </div>
        ))}
      </div>
    </Box>
  );
}

// ready_at хранит точный серверный срок, а не оценку по скорости.
export function canCollectRewards(row: CivicDrawAccount, now: number): boolean {
  const due = (at?: string | null) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) + 5000 <= now;
  return !!row.claimable || (row.timer_source === 'server' && due(row.ready_at)) || (row.grants ?? []).some(g => g.ready > 0 || due(g.ready_at));
}

function timeLeftText(ms: number): string {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return m > 0 ? `${m}м` : `${Math.max(0, Math.ceil(ms / 1000))}с`;
}

function GrantRow({ grant, now }: { grant: PolicyGrantStatus; now: number }) {
  const itemId = grant.kind === 'item' ? Number(grant.reward) : null;
  const catalog = useItemCatalog(itemId != null && Number.isFinite(itemId) ? [itemId] : []);
  const ready = grant.ready > 0;
  const remaining = grant.ready_at ? Math.max(0, Date.parse(grant.ready_at) - now) : null;
  const label = itemId != null ? itemName(itemId, catalog) : `${RARITY_NAME[String(grant.reward)] ?? grant.reward} осколки`;
  return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2, p: 2, bg: 'canvas.subtle', borderRadius: 2 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {itemId != null ? <ItemThumb itemId={itemId} item={catalog.get(itemId)} size={32} /> : <Box as="img" src={itemImgSrc(`shard_${grant.reward}`)} alt="" sx={{ width: 32, height: 32 }} />}
      <Box>
        <Text sx={{ display: 'block', fontWeight: 'semibold' }}>{label} ×{grant.amount}</Text>
        <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted' }}>Политика {grant.def_id} · {ready ? `готово: ${grant.ready}` : remaining == null ? 'время неизвестно' : remaining === 0 ? 'Срок наступил'  : `через ${timeLeftText(remaining)}`}</Text>
      </Box>
    </Box>
  </Box>;
}

function AccountRow({ row, now, onClaimed, onRefresh }: { row: CivicDrawAccount; now: number; onClaimed: (result: unknown) => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();
  const readyAtMs = row.ready_at ? new Date(row.ready_at).getTime() : null;
  const ready = !!row.claimable;
  // прогресс-бар: реальный draw_progress НА МОМЕНТ снимка, экстраполированный вперёд по прошедшему
  // времени × скорости (draws_per_day) — тикает вживую между синками, не трогая прогноз ready_at
  // (используется только для готовности/обратного отсчёта). ВАЖНО: раньше бар считал долю пути
  // "от снимка до ready_at" (now-updatedAt)/(readyAt-updatedAt) — это неявно считало прогресс РОВНО
  // 0% в момент самого снимка, полностью игнорируя настоящий draw_progress оттуда же — сразу после
  // "Обновить" (now≈updatedAt) бар всегда показывал ~0%, независимо от реального прогресса.
  const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : null;
  const baseProgress = row.draw_progress ?? 0;
  const ratePerMs = row.draws_per_day ? row.draws_per_day / 86400000 : 0;
  const elapsedMs = updatedAtMs != null ? Math.max(0, now - updatedAtMs) : 0;
  const liveFraction = baseProgress + elapsedMs * ratePerMs;
  const progressPct = ready ? 100 : Math.min(100, Math.max(0, Math.round(liveFraction * 100)));

  const claim = async () => {
    setBusy(true);
    try {
      const r = await api.civicDrawClaimAccount(row.account_id);
      if (r.ok) { showFlash(`Получено: розыгрышей ${r.draws ?? 0}, наград политик ${r.grants ?? 0}`, true); onClaimed(r.result ?? { draws_consumed: r.draws, grants_collected: r.grants }); }
      else {
        // сервер на отказе уже переспросил игру и обновил снимок в БД — подтягиваем его, иначе
        // страница осталась бы со старым «готово: 1» и той же кнопкой (см. web/routes/policies.js)
        showFlash(r.error ?? 'Ошибка', false);
        onRefresh();
      }
    } catch (e) { showFlash(String(e), false); }
    finally { setBusy(false); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 2, p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2, mb: 2 }}>
        <Text sx={{ fontWeight: 'bold' }}>{row.account}</Text>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1, px: 2 }}>{flash.msg}</Flash>}
          <Label variant={ready ? 'success' : 'default'}>{ready ? `готово: ${Math.max(1, row.draws_ready ?? 0)}` : readyAtMs == null ? 'время неизвестно' : readyAtMs <= now ? 'Срок наступил · проверка при сборе' : `${row.timer_source === 'server' ? '' : '≈ '}через ${timeLeftText(readyAtMs - now)}`}</Label>
          <Button variant="primary" leadingVisual={GiftIcon} loading={busy} disabled={busy || !canCollectRewards(row, now)} onClick={claim}>
            Получить всё
          </Button>
        </Box>
      </Box>

      <Box sx={{ mb: 2 }}>
        <ProgressBar progress={progressPct} sx={{ bg: 'canvas.subtle' }} />
        {row.draws_per_day != null && (
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
            ≈{row.draws_per_day.toFixed(2)} /день{row.updated_at && <> · снимок от {new Date(row.updated_at).toLocaleString('ru')}</>}
          </Text>
        )}
      </Box>

      {row.odds.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {row.odds.map((o, i) => (
            <Label key={i} sx={{ bg: RARITY_COLOR[o.rarity] ?? '#6e7681', color: 'white', borderColor: 'transparent', fontSize: 0 }}>
              {RARITY_NAME[o.rarity] ?? o.rarity} · {(o.chance * 100).toFixed(1)}% · ×{o.count}
            </Label>
          ))}
        </Box>
      )}
      {(row.grants?.length ?? 0) > 0 && <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Text sx={{ fontWeight: 'semibold' }}>Награды политик</Text>
        {row.grants!.map(g => <GrantRow key={`${g.def_id}:${g.kind}:${g.reward}`} grant={g} now={now} />)}
      </Box>}
    </Box>
  );
}

export function CivicDraw() {
  const [accounts, setAccounts] = useState<CivicDrawAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:townhall', () => load(true));
  const [claimingAll, setClaimingAll] = useState(false);
  // сырой результат последнего сбора (одиночного или массового) — сбрасывается перед новым сбором
  const [lastResults, setLastResults] = useState<RawResult[]>([]);
  // тикает раз в минуту, чтобы "готово"/прогресс/обратный отсчёт по прогнозу (ready_at) обновлялись
  // вживую между синками бота, без нажатия "Обновить"
  const [now, setNow] = useState(() => Date.now());
  // автосбор (modules/civicDrawAuto.js): бот сам забирает розыгрыш, когда игра говорит «готово»
  const [auto, setAuto] = useState(true);
  const [savingAuto, setSavingAuto] = useState(false);
  const [autoGrants, setAutoGrants] = useState(false);
  const [savingGrants, setSavingGrants] = useState(false);
  const { flash, showFlash } = useFlash();

  const toggleAuto = async (next: boolean) => {
    setAuto(next);
    setSavingAuto(true);
    try {
      const d = await api.saveConfig({ features: { civicDraw: next } });
      if (!d.ok) { setAuto(!next); showFlash('Ошибка: ' + d.error, false); }
    } catch (e) { setAuto(!next); showFlash(String(e), false); }
    finally { setSavingAuto(false); }
  };

  const toggleGrants = async () => {
    const next = !autoGrants;
    setSavingGrants(true);
    try {
      const d = await api.saveConfig({ features: { policyGrants: next } });
      if (d.ok) setAutoGrants(next); else showFlash(d.error ?? 'Ошибка сохранения', false);
    } finally { setSavingGrants(false); }
  };
  const loadRef = useRef<Promise<void> | null>(null);
  const reloadRef = useRef(false);
  const load = (silent = false): Promise<void> => {
    if (loadRef.current) { reloadRef.current = true; return loadRef.current; }
    const task = (async () => {
    if (!silent) setLoading(true);
    try {
      do {
        reloadRef.current = false;
        const d = await api.civicDraw();
        if (d.ok) setAccounts(d.accounts);
        else showFlash(d.error ?? 'Ошибка загрузки', false);
      } while (reloadRef.current);
    } catch (e) { showFlash(String(e), false); }
    finally { if (!silent) setLoading(false); }
    })();
    loadRef.current = task;
    void task.finally(() => { if (loadRef.current === task) loadRef.current = null; });
    return task;
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('townhall' as Parameters<typeof api.refresh>[0]); await load(true); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  const claimAll = async () => {
    setClaimingAll(true);
    setLastResults([]);
    try {
      const r = await api.civicDrawClaimAll();
      if (r.ok) {
        const results = r.results ?? [];
        const failed = results.filter(x => !x.ok);
        // раньше причину отказа конкретного аккаунта нигде не показывали — при 0 успехов флеш
        // говорил только "собрано 0/N" без объяснения; теперь подмешиваем первую ошибку в текст
        // и показываем все неудачные аккаунты с их error в панели "Последний сбор" ниже
        const flashMsg = `Собрано с ${r.succeeded}/${r.total} аккаунтов` + (failed.length && failed[0].error ? ` (${failed[0].error})` : '');
        showFlash(flashMsg, (r.succeeded ?? 0) > 0);
        setLastResults(results.map(x => ({ account: x.account, result: x.result, error: x.ok ? undefined : (x.error ?? 'Ошибка') })));
        await load(true);
      } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClaimingAll(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.config().then(d => {
      if (d.ok) { setAuto(((d.settings.features as Record<string, boolean> | undefined)?.civicDraw) ?? true); setAutoGrants((d.settings.features as Record<string, boolean> | undefined)?.policyGrants === true); }
    }).catch(() => {});
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onServerEvent('civic-draw', () => { clearTimeout(timer); timer = setTimeout(() => load(true), 100); });
    const offConnection = onServerEvent('connection', () => { clearTimeout(timer); timer = setTimeout(() => load(true), 100); });
    const visible = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', visible);
    return () => { off(); offConnection(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const sorted = [...accounts].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true }));
  const isReady = (a: CivicDrawAccount) => canCollectRewards(a, now);
  const readyCount = sorted.filter(isReady).length;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Городской розыгрыш</Heading>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Text id="civic-auto-label" sx={{ fontSize: 1 }}>Автосбор</Text>
            <ToggleSwitch size="small" aria-labelledby="civic-auto-label" statusLabelPosition="end"
              checked={auto} disabled={savingAuto} onClick={() => toggleAuto(!auto)} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Text id="grants-auto-label" sx={{ fontSize: 1 }}>Автосбор наград политик</Text>
            <ToggleSwitch size="small" aria-labelledby="grants-auto-label" statusLabelPosition="end" checked={autoGrants} disabled={savingGrants} onClick={toggleGrants} />
          </Box>
          <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
            Обновить
          </Button>
          <Button
            variant="primary" leadingVisual={GiftIcon}
            loading={claimingAll} disabled={claimingAll || readyCount === 0}
            onClick={claimAll}
          >
            Собрать со всех ({readyCount})
          </Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {lastResults.length > 0 && (
        <Box sx={{ mb: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, bg: 'canvas.subtle' }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold', display: 'block', mb: 2 }}>
            Последний сбор
          </Text>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {lastResults.map((r, i) => {
              const parsed = isCivicDrawResult(r.result) ? r.result : null;
              return (
                <Box key={i}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                    <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>{r.account}</Text>
                    {r.error && <Label variant="danger">ошибка</Label>}
                  </Box>
                  {r.error ? (
                    <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{r.error}</Text>
                  ) : parsed ? (
                    (parsed.shards && Object.values(parsed.shards).some(Boolean)) || (parsed.quartermaster_shards && Object.values(parsed.quartermaster_shards).some(Boolean)) ? (
                      <>
                        <ShardGroup title="Осколки политик" shards={parsed.shards} />
                        <ShardGroup title="Осколки квартирмейстера" shards={parsed.quartermaster_shards} />
                      </>
                    ) : (
                      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Осколков не выпало</Text>
                    )
                  ) : (
                    <Box as="pre" sx={{ fontSize: 0, m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {JSON.stringify(r.result)}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {sorted.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Данные ещё не получены — ожидается фоновая синхронизация</Text>
        : sorted.map(row => (
            <AccountRow
              key={row.account_id} row={row} now={now}
              onClaimed={result => { setLastResults([{ account: row.account, result }]); load(true); }}
              onRefresh={() => load(true)}
            />
          ))}
    </Box>
  );
}
