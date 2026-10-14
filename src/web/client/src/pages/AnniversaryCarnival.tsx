import { useState, useEffect, useCallback } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, Label, CounterLabel } from '@primer/react';
import { SyncIcon, GiftIcon, CheckIcon, LockIcon, PlayIcon, EyeIcon } from '@primer/octicons-react';
import { api, type AnniversaryBoard, type AnniversaryTask, type AnniversaryTier, type CarnivalTaskRun } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { fmt } from '../utils';
import { TicketIcon, TicketValue, fmtCountdown } from '../components/Ticket';

// Доска заданий события. Данные живые: /anniversary-event/ отдаёт прогресс каждой ступени готовым
// числом (progress/required), поэтому считать что-либо локально не нужно — достаточно одного
// запроса на аккаунт. Сутки события заканчиваются в event.day_end (UTC), после чего доска
// перевыдаётся игрой с новыми заданиями; эксклюзивное задание дня пропущенным днём теряется.

// У задания может быть несколько ступеней (порогов). Игра показывает ПЕРВУЮ незабранную — она же
// определяет и текущий прогресс, и кнопку. Логика 1:1 с бандлом (функция ce в чанке события).
function activeTier(tiers: AnniversaryTier[] | undefined): { tier: AnniversaryTier; index: number; allClaimed: boolean } | null {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const i = tiers.findIndex(t => !t.claimed);
  if (i === -1) return { tier: tiers[tiers.length - 1], index: tiers.length - 1, allClaimed: true };
  return { tier: tiers[i], index: i, allClaimed: false };
}

function taskName(t: AnniversaryTask): string {
  return t.name?.ru || t.name?.en || t.identifier;
}

type BoardPatch = Omit<AnniversaryBoard, 'id' | 'name'>;
type RunOpts = { ad?: boolean; minigames?: boolean; guild?: boolean; login?: boolean };

// Что из ежедневных заданий бот умеет выполнять сам и какой ключ передать раннеру
// (web/lib/carnivalRunner.js). Идентификаторы приходят от игры и каждый день разные — сопоставляем
// по подстроке, чтобы не ловить каждый новый вариант написания.
// Кнопка стоит РОВНО НА МЕСТЕ «Забрать» и называется просто «Выполнить» — что именно она сделает,
// понятно из названия самого задания в этой же строке, дублировать текстом незачем.
const RUNNABLE: { match: (id: string) => boolean; opts: RunOpts; title: string }[] = [
  { match: id => id.includes('daily_login'), opts: { login: true }, title: 'Выполнить ежедневный вход' },
  { match: id => id.includes('guild_contribute'), opts: { guild: true }, title: 'Внести в казну 1 монету' },
  { match: id => id.includes('watch_ad'), opts: { ad: true }, title: 'Посмотреть рекламу' },
  { match: id => id.includes('minigame'), opts: { minigames: true }, title: 'Играть в мини-игры до нужного числа побед' },
];
function runnableFor(task: AnniversaryTask) {
  const id = String(task.identifier ?? '');
  return RUNNABLE.find(r => r.match(id)) ?? null;
}

function TaskRow({ task, accountId, onClaimed, run, busy, hasWisdom, hasGuild, actionDone }: {
  task: AnniversaryTask; accountId: number;
  onClaimed: (tierId: number, board?: BoardPatch | null) => void;
  run: (accountId: number, opts: RunOpts) => void;
  busy: boolean;
  hasWisdom: boolean;
  hasGuild: boolean;
  actionDone: boolean;   // действие этого задания уже сделано сегодня
}) {
  const [claiming, setClaiming] = useState(false);
  const { flash, showFlash } = useFlash();
  const act = activeTier(task.tiers);
  if (!act) return null;
  const { tier, allClaimed } = act;
  const hasGoal = tier.required != null;
  // «Забрать» показываем ТОЛЬКО когда игра сама признала задание выполненным. Пробовать claim
  // раньше бесполезно — игра отвечает «задание не выполнено» (проверено 13.08 на взносе в казну).
  // Пока не выполнено, но выполнимо ботом (RUNNABLE ниже) — показываем «Выполнить».
  const ready = tier.completed && !tier.claimed;
  const pct = hasGoal && tier.required ? Math.min(100, Math.round((tier.progress / tier.required) * 100)) : (ready ? 100 : 0);

  const runnable = runnableFor(task);
  // мини-игры живут в «Оплоте Мудрости», взнос — только у члена гильдии: без них выполнять нечем
  const noBuilding = !!runnable?.opts.minigames && !hasWisdom;
  const noGuild = !!runnable?.opts.guild && !hasGuild;

  const claim = async () => {
    setClaiming(true);
    try {
      const r = await api.anniversaryEventClaim(accountId, tier.id);
      // ступень помечаем забранной СРАЗУ (см. markTierClaimed) — перечитывание всех аккаунтов идёт
      // секунды, и всё это время кнопка оставалась бы нажимаемой
      if (r.ok) { onClaimed(tier.id, r.board); showFlash(`+${r.reward ?? tier.reward} билетов`, true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setClaiming(false); }
  };

  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
      py: '6px', px: 2, borderRadius: 1, bg: 'canvas.subtle',
      border: '1px solid', borderColor: ready ? 'attention.emphasis' : 'border.muted',
    }}>
      <Box sx={{ flex: 1, minWidth: 160 }}>
        <Text sx={{ fontSize: 1, fontWeight: 'semibold' }}>{taskName(task)}</Text>
        {task.paid_only && <Label variant="secondary" sx={{ fontSize: 0, ml: 2 }}>за деньги</Label>}
        {(task.tiers?.length ?? 0) > 1 && (
          <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 2 }}>
            ступень {act.index + 1}/{task.tiers.length}
          </Text>
        )}
        {hasGoal && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: '4px' }}>
            <Box sx={{ width: 90, height: 6, borderRadius: 99, bg: 'canvas.inset', overflow: 'hidden' }}>
              <Box sx={{ width: `${pct}%`, height: '100%', bg: ready ? 'attention.emphasis' : 'success.emphasis' }} />
            </Box>
            <Text sx={{ fontSize: 0, color: 'fg.muted', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(tier.progress)} / {fmt(tier.required ?? 0)}
            </Text>
          </Box>
        )}
      </Box>

      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
        +{tier.reward} <TicketIcon size={14} />
      </Text>

      {allClaimed && !ready ? (
        <Label variant="success" sx={{ fontSize: 0 }}>Собрано</Label>
      ) : ready ? (
        <Button variant="primary" size="small" leadingVisual={GiftIcon} loading={claiming} disabled={claiming} onClick={claim}>
          Забрать
        </Button>
      ) : noBuilding ? (
        <Text sx={{ fontSize: 0, color: 'danger.fg', whiteSpace: 'nowrap' }}>Нет здания</Text>
      ) : noGuild ? (
        <Text sx={{ fontSize: 0, color: 'danger.fg', whiteSpace: 'nowrap' }}>Не состоит в гильдии</Text>
      ) : runnable && !hasGoal && actionDone ? (
        // Действие за сегодня уже сделано (наш DailyLog / лог действий), а игра всё ещё держит
        // completed=false — показываем ОДНУ кнопку «Забрать»: примет claim или ответит отказом,
        // который мы покажем как есть. Дважды за сутки выполнять такое задание незачем.
        <Button size="small" variant="primary" leadingVisual={GiftIcon} loading={claiming} disabled={claiming || busy}
          title="Действие уже выполнено сегодня — забрать награду" onClick={claim}>
          Забрать
        </Button>
      ) : runnable ? (
        <Button size="small" leadingVisual={PlayIcon} loading={busy} disabled={busy || claiming} title={runnable.title}
          onClick={() => run(accountId, runnable.opts)}>
          Выполнить
        </Button>
      ) : (
        <Label variant="secondary" sx={{ fontSize: 0 }}>В процессе</Label>
      )}

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ fontSize: 0, py: 1, width: '100%' }}>{flash.msg}</Flash>}
    </Box>
  );
}

// Аккаунт, у которого запрос к игре не удался (протух токен, 403 «нет здания», таймаут), приезжает
// без tasks/event — раньше обращение к b.tasks.regular роняло ВСЮ страницу из-за одной такой строки.
function tasksOf(b: AnniversaryBoard): AnniversaryTask[] {
  return [...(b.tasks?.regular ?? []), ...(b.tasks?.exclusive ?? []), ...(b.tasks?.meta ?? [])];
}
// Сделано ли сегодня действие этого задания (по нашим записям на сервере — см. actions_done).
// Нужно там, где игра не обновляет completed: ежедневный вход и взнос в казну.
function isActionDone(b: AnniversaryBoard, t: AnniversaryTask): boolean {
  const id = String(t.identifier ?? '');
  const done = b.actions_done ?? {};
  if (id.includes('daily_login')) return !!done.daily_login;
  if (id.includes('guild_contribute')) return !!done.guild_contribute;
  return false;
}

// Ступени, которые есть смысл забирать: игра пометила completed ЛИБО действие уже сделано сегодня,
// а игра просто не обновила флаг. Ровно это же считает и сервер в «Забрать всё» (readyTiers).
function readyCount(b: AnniversaryBoard): number {
  return tasksOf(b).reduce((n, t) => n + (t.tiers ?? []).filter(x =>
    !x.claimed && (x.completed || (x.required == null && isActionDone(b, t)))).length, 0);
}
// сколько ещё нужно по заданию: ищем задание по идентификатору и берём первую незабранную ступень
// (та же логика, что у игры и у раннера на сервере — web/lib/carnivalRunner.js)
function remainingFor(b: AnniversaryBoard, match: (id: string) => boolean): number | null {
  const task = tasksOf(b).find(t => match(String(t.identifier ?? '')));
  if (!task) return null;
  const tier = (task.tiers ?? []).find(x => !x.claimed);
  if (!tier) return null;
  if (tier.completed) return 0;
  if (tier.required == null) return 1;
  return Math.max(0, tier.required - (tier.progress ?? 0));
}

function BoardCard({ b, now, onChanged, run, runState }: {
  b: AnniversaryBoard; now: number;
  onChanged: (tierId: number, board?: BoardPatch | null) => void;
  run: (accountId: number, opts: RunOpts) => void;
  runState?: CarnivalTaskRun;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const ready = readyCount(b);
  const adsLeft = remainingFor(b, id => id.includes('watch_ad'));
  const winsLeft = remainingFor(b, id => id.includes('minigame'));
  // «Пополнить Казну Гильдии» — игре важен сам факт взноса, поэтому кнопка кладёт минимум (1 монету)
  const guildLeft = remainingFor(b, id => id.includes('guild_contribute'));
  const busy = !!runState?.running;

  const section = (title: string, tasks: AnniversaryTask[], icon?: React.ReactNode) => tasks.length > 0 && (
    <Box sx={{ mb: 2 }}>
      <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted', display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        {icon}{title}
      </Text>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {tasks.map(t => (
          <TaskRow key={t.identifier} task={t} accountId={b.id} onClaimed={onChanged}
            run={run} busy={busy} hasWisdom={b.has_wisdom !== false} hasGuild={b.has_guild !== false}
            actionDone={isActionDone(b, t)} />
        ))}
      </Box>
    </Box>
  );

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box
        onClick={() => setCollapsed(c => !c)}
        sx={{ px: 3, py: 2, bg: 'canvas.subtle', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', cursor: 'pointer' }}
      >
        <Text sx={{ fontWeight: 'bold' }}>{b.name}</Text>
        {b.error ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{b.error}</Text> : b.event?.is_active ? (
          <>
            <Label variant="accent" sx={{ fontSize: 0 }}>День {b.event.current_day} из {b.event.total_days}</Label>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>до конца дня {fmtCountdown(b.event.day_end, now)}</Text>
            <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
              {ready > 0 && <Label variant="attention" sx={{ fontSize: 0 }}>готово: {ready}</Label>}
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>заработано <TicketValue value={b.tickets_earned} size={13} /></Text>
              <Text sx={{ fontSize: 1, fontWeight: 'bold' }}><TicketValue value={b.tickets_balance} /></Text>
            </Box>
          </>
        ) : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>событие неактивно</Text>}
      </Box>

      {/* Кнопки выполнения теперь стоят у самих заданий (см. TaskRow) — здесь только строка о том,
          что фоновый раннер сейчас делает по этому аккаунту. */}
      {!b.error && runState && (runState.running || runState.error) && (
        <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'border.muted' }}>
          <Text sx={{ fontSize: 0, color: runState.error ? 'danger.fg' : 'fg.muted' }}>
            {runState.error
              ? runState.error
              : `${runState.step}${runState.needed ? ` · победы ${runState.wins}/${runState.needed}` : ''}`}
          </Text>
        </Box>
      )}
      {!collapsed && !b.error && b.event?.is_active && (
        <Box sx={{ p: 3 }}>
          {section('Задания дня', b.tasks?.regular ?? [])}
          {section('Только сегодня', b.tasks?.exclusive ?? [])}
          {section('Финал дня', b.tasks?.meta ?? [], <CheckIcon size={12} />)}
        </Box>
      )}
    </Box>
  );
}

export function AnniversaryCarnival() {
  const [accounts, setAccounts] = useState<AnniversaryBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [claimingAll, setClaimingAll] = useState(false);
  const [runs, setRuns] = useState<Map<number, CarnivalTaskRun>>(new Map());
  const [retrying, setRetrying] = useState(false);
  const [refreshing, setRefreshing] = useResumableRefresh('anniversaryEvent', () => load());
  const { flash, showFlash } = useFlash();

  const load = useCallback(async () => {
    try {
      const d = await api.anniversaryEvent();
      if (d.ok) { setAccounts(d.accounts); return d.accounts; }
      showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setLoading(false); }
    return null;
  }, [showFlash]);

  // Автоповтор сбойных: после общего прохода добираем ровно те аккаунты, по которым игра не
  // ответила (?ids=...), и вклеиваем их строки в уже показанные. Ретраи внутри одного прохода
  // ограничены бюджетом (web/lib/accountSweep.js), поэтому дожимаем ещё и снаружи.
  const retryFailed = useCallback(async (rows: AnniversaryBoard[]) => {
    const ids = rows.filter(b => b.error && !b.permanent).map(b => b.id);
    if (!ids.length) return;
    setRetrying(true);
    try {
      const d = await api.anniversaryEvent(ids);
      if (d.ok) {
        const fixed = new Map(d.accounts.map(a => [a.id, a]));
        setAccounts(prev => prev.map(b => fixed.get(b.id) ?? b));
      }
    } catch { /* не вышло — строки останутся с ошибкой, поможет кнопка «Обновить» */ }
    finally { setRetrying(false); }
  }, []);

  useEffect(() => { load().then(rows => { if (rows) retryFailed(rows); }); }, [load, retryFailed]);

  // пока фоновый раннер что-то делает — раз в 5с тянем его статус
  useEffect(() => {
    let stopped = false;
    // как только по аккаунту работа ЗАКОНЧИЛАСЬ, сразу перечитываем ЕГО доску: игра уже засчитала
    // задание, и кнопка «Выполнить» должна смениться на «Забрать» без ручного обновления страницы
    const wasRunning = new Set<number>();
    const tick = async () => {
      try {
        const d = await api.anniversaryTasksStatus();
        if (stopped || !d.ok) return;
        setRuns(new Map(d.rows.map(r => [r.account_id, r])));
        const finished: number[] = [];
        for (const r of d.rows) {
          if (r.running) wasRunning.add(r.account_id);
          else if (wasRunning.delete(r.account_id)) finished.push(r.account_id);
        }
        if (finished.length) {
          const fresh = await api.anniversaryEvent(finished);
          if (!stopped && fresh.ok) {
            const byId = new Map(fresh.accounts.map(a => [a.id, a]));
            setAccounts(prev => prev.map(b => byId.get(b.id) ?? b));
          }
        }
      } catch { /* статус не критичен */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { const rows = await load(); if (rows) await retryFailed(rows); }
    finally { setRefreshing(false); }
  };

  const runTasks = useCallback((accountId: number, opts: RunOpts) => {
    api.anniversaryTasksRun(accountId, opts)
      .then(r => showFlash(r.ok ? 'Запущено' : (r.error ?? 'Ошибка'), !!r.ok))
      .catch(e => showFlash(String(e), false));
  }, [showFlash]);

  // Каждая кнопка «на всех» запускает РОВНО ОДИН вид задания и только по тем аккаунтам, которым
  // оно ещё нужно (account_ids). Раннер на сервере всё равно перепроверит доску перед работой.
  const runAllOf = async (opts: RunOpts, ids: number[], what: string) => {
    if (!ids.length) { showFlash(`Некому: ${what} уже выполнено везде`, true); return; }
    try {
      const r = await api.anniversaryTasksRunAll({ ...opts, account_ids: ids });
      showFlash(r.ok ? `${what}: поставлено в очередь ${r.started ?? ids.length} аккаунтов` : (r.error ?? 'Ошибка'), !!r.ok);
    } catch (e) { showFlash(String(e), false); }
  };

  // Ступень гаснет сразу после ответа игры. Вместе с ответом сервер присылает СВЕЖУЮ доску этого
  // аккаунта (он перечитал её сразу после сбора) — подставляем её целиком, и прогресс следующей
  // ступени задания виден мгновенно. Полный проход по всем аккаунтам при этом не запускаем: он
  // занимает секунды и, как показал 12.08, при 60 аккаунтах разом упирается в таймауты игры.
  // Если свежей доски нет (сеть моргнула) — просто гасим забранную ступень локально.
  const markTierClaimed = useCallback((accountId: number, tierId: number, board?: BoardPatch | null) => {
    setAccounts(prev => prev.map(b => {
      if (b.id !== accountId) return b;
      if (board) return { ...b, ...board };
      const fix = (list: AnniversaryTask[]) => list.map(t => ({
        ...t,
        tiers: (t.tiers ?? []).map(x => x.id === tierId ? { ...x, claimed: true, completed: true } : x),
      }));
      return {
        ...b,
        tasks: {
          regular: fix(b.tasks?.regular ?? []),
          exclusive: fix(b.tasks?.exclusive ?? []),
          meta: fix(b.tasks?.meta ?? []),
        },
      };
    }));
  }, []);

  const claimAll = async () => {
    setClaimingAll(true);
    try {
      const r = await api.anniversaryEventClaimAll();
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); return; }
      const claimed = r.results.reduce((n, x) => n + (x.claimed ?? 0), 0);
      const tickets = r.results.reduce((n, x) => n + (x.tickets ?? 0), 0);
      const failed = r.results.filter(x => x.error);
      showFlash(
        `Забрано наград: ${claimed}, билетов +${tickets}` + (failed.length ? `; ошибки: ${failed.map(f => f.name).join(', ')}` : ''),
        failed.length === 0,
      );
      await load();
    } catch (e) { showFlash(String(e), false); }
    finally { setClaimingAll(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  // «Забрать всё» считает ТОЛЬКО реально готовые ступени (completed && !claimed) — раньше сюда
  // попадали ещё и невыполненные задания без порога, и счётчик показывал сотню, хотя собирать
  // было нечего и игра на каждую такую попытку отвечала отказом
  const totalReady = accounts.reduce((n, b) => n + readyCount(b), 0);
  // Аккаунты, которым конкретное задание ещё НЕ засчитано: только их и ставим в очередь, чтобы
  // «на всех» не гоняло бота по тем, кто уже всё сделал (у каждого запуск — это живые запросы,
  // мини-игры вообще минуты). Считаем по уже загруженным доскам, без лишних обращений к игре.
  const needIds = (match: (id: string) => boolean) =>
    accounts.filter(b => !b.error && b.event?.is_active && (remainingFor(b, match) ?? 0) > 0).map(b => b.id);
  // виды заданий, по которым прямо сейчас идёт работа (состояние с сервера — переживает перезагрузку)
  const runningKinds = new Set([...runs.values()].filter(r => r.running).flatMap(r => r.kinds ?? []));
  const minigameIds = needIds(id => id.includes('minigame')).filter(id => accounts.find(b => b.id === id)?.has_wisdom !== false);
  const adIds = needIds(id => id.includes('watch_ad'));
  const guildIds = needIds(id => id.includes('guild_contribute')).filter(id => accounts.find(b => b.id === id)?.has_guild !== false);
  const loginIds = needIds(id => id.includes('daily_login'));
  const active = accounts.some(b => b.event?.is_active);
  const failed = accounts.filter(b => b.error);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2, flexWrap: 'wrap' }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Летний карнавал</Heading>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant={totalReady > 0 ? 'primary' : 'default'} leadingVisual={GiftIcon}
            loading={claimingAll} disabled={claimingAll || totalReady === 0} onClick={claimAll}>
            Забрать всё {totalReady > 0 && <CounterLabel sx={{ ml: 1 }}>{totalReady}</CounterLabel>}
          </Button>
          <Button leadingVisual={PlayIcon} loading={runningKinds.has('minigames')} disabled={!minigameIds.length || runningKinds.has('minigames')}
            onClick={() => runAllOf({ minigames: true }, minigameIds, 'Мини-игры')}>
            Мини-игры на всех {minigameIds.length > 0 && <CounterLabel sx={{ ml: 1 }}>{minigameIds.length}</CounterLabel>}
          </Button>
          <Button leadingVisual={PlayIcon} loading={runningKinds.has('login')} disabled={!loginIds.length || runningKinds.has('login')}
            onClick={() => runAllOf({ login: true }, loginIds, 'Ежедневный вход')}>
            Ежедневный вход на всех {loginIds.length > 0 && <CounterLabel sx={{ ml: 1 }}>{loginIds.length}</CounterLabel>}
          </Button>
          <Button leadingVisual={EyeIcon} loading={runningKinds.has('ad')} disabled={!adIds.length || runningKinds.has('ad')}
            onClick={() => runAllOf({ ad: true }, adIds, 'Реклама')}>
            Реклама на всех {adIds.length > 0 && <CounterLabel sx={{ ml: 1 }}>{adIds.length}</CounterLabel>}
          </Button>
          <Button leadingVisual={PlayIcon} loading={runningKinds.has('guild')} disabled={!guildIds.length || runningKinds.has('guild')}
            onClick={() => runAllOf({ guild: true }, guildIds, 'Взнос в казну')}>
            Взнос в казну на всех {guildIds.length > 0 && <CounterLabel sx={{ ml: 1 }}>{guildIds.length}</CounterLabel>}
          </Button>
          <Button leadingVisual={SyncIcon} loading={refreshing || retrying} disabled={refreshing || retrying} onClick={refresh}>Обновить</Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {!active && accounts.length > 0 && failed.length < accounts.length && (
        <Flash sx={{ mb: 3 }} variant="warning">
          <LockIcon /> Событие сейчас неактивно — карнавал идёт 10-23.08.
        </Flash>
      )}
      {failed.length > 0 && (
        <Flash sx={{ mb: 3 }} variant="danger">
          Игра не ответила по {failed.length} аккаунтам: {failed.slice(0, 5).map(f => f.name).join(', ')}
          {failed.length > 5 ? ` и ещё ${failed.length - 5}` : ''}.
          {failed[0]?.error ? ` Первая ошибка: ${failed[0].error}.` : ''}
          {retrying ? ' Повторяю…' : ''}
        </Flash>
      )}
      {accounts.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : accounts.map(b => (
          <BoardCard key={b.id} b={b} now={now}
            onChanged={(tierId, board) => markTierClaimed(b.id, tierId, board)}
            run={runTasks} runState={runs.get(b.id)} />
        ))}
    </Box>
  );
}
