import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, Label, ProgressBar } from '@primer/react';
import { SyncIcon, GiftIcon } from '@primer/octicons-react';
import { api, type CivicDrawAccount } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { itemImgSrc } from '../utils';

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

// ready_at — линейный прогноз "когда будет готов следующий розыгрыш", посчитанный и сохранённый
// сервером (modules/townhall.js) на каждом синке, с защитой от сдвига назад между снимками (сырой
// прогресс не идеально монотонен). Тикаем раз в минуту, чтобы "готово"/прогресс-бар/обратный отсчёт
// обновлялись вживую между синками, без нажатия "Обновить" — сама попытка claim всё равно
// перепроверяется live перед отправкой на сервере (см. web/routes/civicDraw.js).
function timeLeftText(ms: number): string {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${Math.max(0, m)}м`;
}

function AccountRow({ row, now, onClaimed, onRefresh }: { row: CivicDrawAccount; now: number; onClaimed: (result: unknown) => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();
  // Игра ответила «ещё не готово» — значит наша ОЦЕНКА готовности врала. Гасим кнопку до прихода
  // новых данных по этому аккаунту, иначе получался цикл: клиентский прогноз снова включает
  // кнопку → снова та же ошибка. Сбрасываем, как только строка реально обновится с сервера.
  const [serverSaysNotReady, setServerSaysNotReady] = useState(false);
  useEffect(() => { setServerSaysNotReady(false); }, [row]);
  const drawsReady = row.draws_ready ?? 0;
  const readyAtMs = row.ready_at ? new Date(row.ready_at).getTime() : null;
  const readyByForecast = readyAtMs != null && now >= readyAtMs;
  // Готовность: живой флаг игры ЛИБО наступивший прогноз ready_at. Прогноз снова участвует —
  // после починки формулы в modules/townhall.js он честный (раньше при накопленном draws_ready>=1
  // он давал «готово прямо сейчас», из-за чего кнопка долбила игру одним и тем же отказом).
  // ВАЖНО: сырой draws_ready в условие НЕ входит — именно он приходит равным 1 при claimable:false.
  // Если прогноз всё же ошибётся, serverSaysNotReady погасит кнопку после первого отказа.
  const ready = !serverSaysNotReady && (!!row.claimable || readyByForecast);
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
      const r = await api.policyAction(row.account_id, 'civic-draw-claim');
      if (r.ok) { showFlash('Получено', true); onClaimed(r.result); }
      else {
        // сервер на отказе уже переспросил игру и обновил снимок в БД — подтягиваем его, иначе
        // страница осталась бы со старым «готово: 1» и той же кнопкой (см. web/routes/policies.js)
        setServerSaysNotReady(true);
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
          <Label variant={ready ? 'success' : 'default'}>{ready ? `готово: ${Math.max(1, drawsReady)}` : `≈ через ${timeLeftText(readyAtMs != null ? readyAtMs - now : 0)}`}</Label>
          <Button variant="primary" leadingVisual={GiftIcon} loading={busy} disabled={busy || !ready} onClick={claim}>
            Получить
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
  // Аккаунты, по которым игра ЯВНО ответила «ещё не готово». Наша оценка готовности (draws_ready из
  // снимка + экстраполяция ready_at) может врать — и тогда получался цикл: кнопка снова активна →
  // снова тот же отказ. Для таких аккаунтов до конца сессии страницы верим ТОЛЬКО живому
  // claimable из снимка, игнорируя оценку. Сбрасывается кнопкой «Обновить» и успешным сбором.
  const [denied, setDenied] = useState<Set<string>>(new Set());
  const { flash, showFlash } = useFlash();

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.civicDraw();
      if (d.ok) setAccounts(d.accounts);
      else showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { if (!silent) setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { setDenied(new Set()); await api.refresh('townhall' as Parameters<typeof api.refresh>[0]); await load(true); showFlash('Обновлено', true); }
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
        // аккаунты, которым игра отказала, гасим до явного «Обновить» — страховка от повторного
        // клика по тому же обречённому сбору, даже если снимок почему-то остался прежним
        setDenied(prev => { const s = new Set(prev); for (const x of failed) s.add(x.account); return s; });
        await load(true);
      } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClaimingAll(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(id); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const sorted = [...accounts].sort((a, b) => a.account.localeCompare(b.account, 'ru', { numeric: true }));
  // то же правило, что и в строке аккаунта: живой claimable ЛИБО наступивший прогноз ready_at
  // (сырой draws_ready намеренно не участвует — он бывает 1 при claimable:false, см. AccountRow)
  const isReady = (a: CivicDrawAccount) =>
    !denied.has(a.account) && (!!a.claimable || (a.ready_at != null && now >= new Date(a.ready_at).getTime()));
  const readyCount = sorted.filter(isReady).length;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Городской розыгрыш</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
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
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных — обновите после того, как разнообразие города синхронизируется ботом</Text>
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
