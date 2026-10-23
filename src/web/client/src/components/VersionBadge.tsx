import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Text, Link, Button, CounterLabel, ConfirmationDialog, Spinner, ProgressBar } from '@primer/react';
import { SyncIcon, PinIcon, DownloadIcon, CheckCircleFillIcon, XCircleFillIcon, ClockFillIcon, AlertFillIcon, QuestionIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';
import { useSelfUpdate, checkNote } from '../hooks/useSelfUpdate';
import { useBuildState } from '../hooks/useBuildWatcher';
import { updateStageView, ProgressRing } from './UpdateProgress';

// Блок версии внизу меню: статус (значок в столбце иконок меню), канал и коммит, список того, что
// придёт с обновлением (названия PR), и кнопка обновления
// (через обновлятель, см. docker-compose.yml). Выбор канала — Настройки → Обновления. Сервер
// кэширует ответ GitHub на 30 минут (3 минуты, пока собирается образ) и проверяет его сразу при запуске.
const MAX_CHANGES = 5;

// стрелка вверх, вырезанная в залитом кружке, — пара к CheckCircleFillIcon (у octicons такой нет)
function ArrowUpCircleFill() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ display: 'block' }}>
      <path fillRule="evenodd" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16ZM8 3.9l3.3 3.3-1.06 1.06-1.49-1.49v4.98h-1.5V6.77L5.76 8.26 4.7 7.2Z" />
    </svg>
  );
}

function Counter({ n }: { n?: number | null }) {
  return n ? <CounterLabel sx={{ ml: 1, bg: 'success.muted', color: 'success.fg' }}>+{n}</CounterLabel> : null;
}

const ext = (href: string, text: string) => <Link href={href} target="_blank" rel="noreferrer" muted>{text}</Link>;

export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const upd = useSelfUpdate();
  // обновление идёт на сервере (в т.ч. начатое с другой страницы/вкладки или автообновлением)
  const build = useBuildState();
  const serverBusy = build.busy;

  const load = async (force = false) => {
    setBusy(true);
    if (force) setNote(null);
    try {
      const d = await api.version(force);
      if (d && d.ok) {
        setV(d);
        if (force) { setNote(checkNote(d)); setTimeout(() => setNote(null), 6000); }
      }
    } catch { if (force) setNote('Панель не отвечает'); }
    finally { setBusy(false); }
  };

  useEffect(() => { load(); }, []);
  // свежие данные из карточки «Обновления» в настройках
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<VersionInfo>).detail; if (d) setV(d); };
    window.addEventListener('tc-version', on);
    return () => window.removeEventListener('tc-version', on);
  }, []);
  // пока образ собирается на GitHub — чаще (сервер тогда сам держит кэш 3 минуты), иначе раз в 30 минут
  const building = !!v?.build && v.build.status !== 'completed';
  useEffect(() => {
    const id = setInterval(() => load(), (building ? 3 : 30) * 60 * 1000);
    return () => clearInterval(id);
  }, [building]);

  if (!v) return null;
  const updating = upd.updating || serverBusy;
  const outdated = !!(v.updater?.alive && v.updater.outdated);
  const short = (s?: string | null) => (s ? s.slice(0, 7) : '—');
  const ch = v.channel;
  const pinned = ch && (ch.kind === 'release' || ch.kind === 'commit');
  const newLink = v.compareUrl || v.remote?.url || v.repoUrl;
  const checked = new Date(v.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const buildRunning = v.build && v.build.status !== 'completed';
  const buildFailed = v.build && v.build.status === 'completed' && v.build.conclusion !== 'success';
  const canClick = v.canUpdate && !pinned && (v.status === 'behind' || v.status === 'unknown') && !buildRunning && !buildFailed;
  const chText = !ch ? '' : ch.kind === 'stable' ? `stable${v.currentRelease ? ' ' + v.currentRelease : ''}` : ch.name;

  const hasUpdate = v.status === 'behind' || (!!pinned && !!v.newerReleases);
  const pinnedToBottom = updating || hasUpdate;

  // идёт обновление: этап в заголовке, полоса — ход этапа, кольцо слева — общий ход
  const prog = updating ? updateStageView(build.update) : null;
  // значок слева (16×16, на вертикали иконок меню), заголовок и подпись под ним
  const st: { icon: ReactNode; color: string; title: ReactNode; sub?: ReactNode } =
    updating ? { icon: prog!.overall != null ? <ProgressRing pct={prog!.overall} /> : <Spinner size="small" sx={{ width: 16, height: 16, color: 'success.fg' }} />,
      color: 'success.fg', title: prog!.title, sub: prog!.sub ?? undefined }
    : buildFailed && v.build ? { icon: <XCircleFillIcon size={16} />, color: 'danger.fg', title: 'Сборка не удалась', sub: ext(v.build.url, 'открыть лог на GitHub') }
    : buildRunning && v.build ? { icon: <ClockFillIcon size={16} />, color: 'attention.fg', title: 'Образ собирается', sub: ext(v.build.url, 'идёт на GitHub') }
    : v.status === 'behind' ? { icon: <ArrowUpCircleFill />, color: 'success.fg', title: <>Новая версия<Counter n={v.changes?.length || v.behindBy} /></> }
    : pinned && !!v.newerReleases ? { icon: <ArrowUpCircleFill />, color: 'success.fg', title: <>Есть релизы новее<Counter n={v.newerReleases} /></> }
    : v.status === 'current' ? { icon: <CheckCircleFillIcon size={16} />, color: 'success.fg', title: 'Актуальная версия' }
    : (v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') ? { icon: <AlertFillIcon size={16} />, color: 'attention.fg', title: 'Локальные изменения' }
    : { icon: <QuestionIcon size={16} />, color: 'fg.muted', title: 'Статус неизвестен' };
  // подпись по умолчанию: канал · коммит (+ «авто», если включено автообновление)
  const sub = st.sub ?? (
    <>
      {ch && <RouterLink to="/settings#updates" title="Канал обновлений — Настройки" style={{ color: 'inherit', textDecoration: 'none' }}>
        {pinned && <PinIcon size={10} />} {chText}
      </RouterLink>}
      {ch && ' · '}
      {v.local
        ? <Link href={`${v.repoUrl}/commit/${v.local.sha}`} target="_blank" rel="noreferrer" muted sx={{ fontFamily: 'mono' }}>{short(v.local.sha)}</Link>
        : 'версия неизвестна'}
      {!pinned && v.auto && <span title="Автообновление включено"> · авто</span>}
    </>
  );
  // что придёт: до пяти изменений, остальное — ссылкой на сравнение; старый ответ сервера без
  // списка — только заголовок головы канала
  const changes = v.status === 'behind'
    ? (v.changes?.length ? v.changes : v.remote?.message ? [{ title: v.remote.message, pr: null, url: newLink }] : [])
    : [];
  const shown = changes.slice(0, MAX_CHANGES);
  // зелёный заголовок и свечение значка — только когда новую версию можно ставить (не сборка/ошибка)
  const fresh = hasUpdate && !updating && !buildRunning && !buildFailed;

  return (
    <>
      {/* блок без подложки, по сетке пунктов меню: значок на вертикали их иконок, кнопка проверки —
          на вертикали стрелок групп, заголовок — с той же позиции, что текст пунктов. Над блоком
          разделитель; отступы до него и после равны (14px до текста). Есть что ставить (или уже
          ставится) — блок прилипает к низу меню и виден при любой прокрутке. */}
      <div className={pinnedToBottom ? 'version-dock' : undefined} style={pinnedToBottom ? undefined : { paddingTop: 8 }}>
      <Box sx={{ height: 1, mx: 2, bg: 'border.muted' }} />
      <Box sx={{ pt: '13px', px: 2, pb: 1, fontSize: '12px', lineHeight: '16px', color: 'fg.muted', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Box sx={{ display: 'flex', gap: 2, minWidth: 0 }}>
          <Box sx={{ width: 16, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: st.color }}>
            <Box as="span" className={fresh ? 'version-glow' : undefined} sx={{ display: 'inline-flex', borderRadius: '50%' }}>{st.icon}</Box>
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Text as="div" sx={{ fontSize: '13px', lineHeight: '18px', fontWeight: 'semibold', color: fresh ? 'success.fg' : 'fg.default', display: 'flex', alignItems: 'center' }}>{st.title}</Text>
            <Box sx={{ color: 'fg.subtle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</Box>
          </Box>
          {!updating && (
            <Box sx={{ width: 16, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Box as="button" type="button" title={`Проверить обновления (проверено в ${checked})`} aria-label="Проверить обновления"
                disabled={busy} onClick={() => load(true)}
                sx={{ width: 22, height: 22, p: 0, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  border: 0, borderRadius: '6px', bg: 'transparent', color: 'fg.muted', cursor: 'pointer',
                  ':hover:not(:disabled)': { color: 'fg.default', bg: 'neutral.muted' }, ':disabled': { opacity: 0.5, cursor: 'default' } }}>
                {busy ? <Spinner size="small" sx={{ width: 14, height: 14 }} /> : <SyncIcon size={14} />}
              </Box>
            </Box>
          )}
        </Box>
        {prog && prog.stage != null && (
          <ProgressBar barSize="small" aria-label={prog.title} progress={prog.stage === 'run' ? 100 : prog.stage} animated={prog.stage === 'run'} />
        )}
        {!updating && shown.length > 0 && (
          // линия идёт из-под значка по его вертикали, текст — с позиции заголовка
          <Box sx={{ ml: '7px', pl: '15px', mt: '-20px', pt: '20px', borderLeft: '2px solid', borderColor: 'success.muted', color: 'fg.default',
            display: 'flex', flexDirection: 'column', gap: '5px' }}
            style={{ borderImage: 'linear-gradient(to bottom, transparent 2px, var(--version-line) 8px) 1' }}>
            {shown.map((c, i) => (
              // при наведении — без синего и подчёркивания: участок линии напротив пункта загорается зелёным
              <Link key={i} href={c.url} target="_blank" rel="noreferrer" sx={{ position: 'relative', color: 'fg.default',
                ':hover': { color: 'fg.default', textDecoration: 'none' },
                ':hover::before': { content: '""', position: 'absolute', left: '-17px', top: 0, bottom: 0, width: '2px', bg: 'success.fg' } }}>
                {c.title}{c.pr ? <Text sx={{ color: 'fg.subtle' }}> #{c.pr}</Text> : null}
              </Link>
            ))}
            {changes.length > MAX_CHANGES && <Link href={newLink} target="_blank" rel="noreferrer" muted>ещё {changes.length - MAX_CHANGES} на GitHub →</Link>}
          </Box>
        )}
        {!updating && hasUpdate && canClick && <Button size="small" variant="primary" block leadingVisual={DownloadIcon} onClick={() => setConfirm(true)}>Обновить</Button>}
        {!updating && pinned && !!v.newerReleases && <Button as={RouterLink} to="/settings#updates" size="small" block>Выбрать версию</Button>}
        {(note || upd.msg || v.error || outdated) && (
          <Box sx={{ pl: '24px', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {note && <Text sx={{ color: 'fg.subtle' }}>{note}</Text>}
            {upd.msg && <Text sx={{ color: 'attention.fg' }}>{upd.msg}</Text>}
            {outdated && <Link as={RouterLink} to="/settings#updates" sx={{ color: 'attention.fg' }}>Обновлятель устарел, обновите его один раз вручную: как — в Настройки → Обновления</Link>}
            {v.error && <Text sx={{ color: 'attention.fg' }}>Нет связи с GitHub: {v.error}</Text>}
          </Box>
        )}
      </Box>
      </div>

      {(confirm || upd.busyOps) && (
        <ConfirmationDialog
          title="Обновить бота?"
          cancelButtonContent="Отмена"
          confirmButtonContent={upd.busyOps ? 'Обновить всё равно' : 'Обновить'}
          confirmButtonType={upd.busyOps ? 'danger' : 'primary'}
          onClose={(gesture) => {
            const force = !!upd.busyOps;
            setConfirm(false);
            upd.setBusyOps(null);
            if (gesture === 'confirm') upd.run(undefined, force);
          }}
        >
          {upd.busyOps
            ? <>Сейчас идут операции: {upd.busyOps.ops.join(', ')}. При обновлении они прервутся.</>
            : <>Бот скачает новую версию канала {chText} и перезапустится. Задачи на аккаунтах прервутся и продолжатся после запуска, обычно это меньше минуты. Настройки, база и токены не меняются.</>}
        </ConfirmationDialog>
      )}
    </>
  );
}
