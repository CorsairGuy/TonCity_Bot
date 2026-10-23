import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Text, Link, Button, CounterLabel, ConfirmationDialog, Spinner } from '@primer/react';
import { SyncIcon, PinIcon, DownloadIcon, ArrowUpIcon, CheckIcon, ClockIcon, AlertIcon, GitCommitIcon, QuestionIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';
import { useSelfUpdate, checkNote } from '../hooks/useSelfUpdate';
import { useBuildState } from '../hooks/useBuildWatcher';
import { UpdateProgress } from './UpdateProgress';

// Плашка версии внизу меню (вид «уведомление»: при новой версии зелёная, с последним изменением
// канала и кнопками «Обновить»/«Что нового»): канал обновлений, текущий коммит и кнопка обновления
// (через обновлятель, см. docker-compose.yml). Выбор канала — Настройки → Обновления. Сервер
// кэширует ответ GitHub на 30 минут (3 минуты, пока собирается образ) и проверяет его сразу при запуске.
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
  // пока образ собирается на GitHub — чаще (сервер тогда сам держит кэш 3 минуты), иначе раз в 30 минут
  const building = !!v?.build && v.build.status !== 'completed';
  useEffect(() => {
    const id = setInterval(() => load(), (building ? 3 : 30) * 60 * 1000);
    return () => clearInterval(id);
  }, [building]);

  if (!v) return null;
  const updating = upd.updating || serverBusy;
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

  // вид карточки по состоянию: тон (фон/рамка/кружок), иконка в кружке, заголовок и подпись под ним
  type Tone = 'success' | 'attention' | 'danger' | 'neutral';
  const ext = (href: string, text: string) => <Link href={href} target="_blank" rel="noreferrer" muted>{text}</Link>;
  const st: { tone: Tone; icon: ReactNode; title: ReactNode; sub?: ReactNode } =
    updating ? { tone: 'neutral', icon: <Spinner size="small" sx={{ width: 14, height: 14, color: 'success.fg' }} />, title: 'Обновляюсь' }
    : buildFailed && v.build ? { tone: 'danger', icon: <AlertIcon size={14} />, title: 'Сборка не удалась', sub: ext(v.build.url, 'открыть лог на GitHub') }
    : buildRunning && v.build ? { tone: 'attention', icon: <ClockIcon size={14} />, title: 'Образ собирается', sub: ext(v.build.url, 'идёт на GitHub') }
    : v.status === 'behind' ? { tone: 'success', icon: <ArrowUpIcon size={14} />, title: <>Новая версия{v.behindBy ? <CounterLabel sx={{ ml: 1, bg: 'success.muted', color: 'success.fg' }}>+{v.behindBy}</CounterLabel> : null}</> }
    : pinned && !!v.newerReleases ? { tone: 'success', icon: <ArrowUpIcon size={14} />, title: <>Есть релизы новее<CounterLabel sx={{ ml: 1, bg: 'success.muted', color: 'success.fg' }}>{v.newerReleases}</CounterLabel></> }
    : v.status === 'current' ? { tone: 'neutral', icon: <CheckIcon size={14} />, title: 'Актуальная версия' }
    : (v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') ? { tone: 'attention', icon: <GitCommitIcon size={14} />, title: 'Локальные изменения' }
    : { tone: 'neutral', icon: <QuestionIcon size={14} />, title: 'Статус неизвестен' };
  const tones: Record<Tone, { bg: string; border: string; dot: string; dotFg: string }> = {
    success: { bg: 'success.subtle', border: 'success.muted', dot: 'success.emphasis', dotFg: 'fg.onEmphasis' },
    attention: { bg: 'attention.subtle', border: 'attention.muted', dot: 'attention.emphasis', dotFg: 'fg.onEmphasis' },
    danger: { bg: 'danger.subtle', border: 'danger.muted', dot: 'danger.emphasis', dotFg: 'fg.onEmphasis' },
    neutral: { bg: 'canvas.subtle', border: 'border.muted', dot: 'neutral.muted', dotFg: v.status === 'current' ? 'success.fg' : 'fg.muted' },
  };
  const t = tones[st.tone];
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
  // последнее изменение канала — первая строка сообщения коммита головы
  const headMsg = v.status === 'behind' ? (v.remote?.message || '').split('\n')[0].trim() : '';

  return (
    <>
      {/* карточка ровно по ширине пунктов меню (nav-item): те же края и радиус 9px */}
      {/* есть что ставить (или уже ставится) — карточка прилипает к низу меню и видна при любой
          прокрутке; иначе стоит на своём месте после «Настроек» */}
      <div className={pinnedToBottom ? 'version-dock' : undefined} style={pinnedToBottom ? undefined : { marginTop: 8 }}>
      <Box sx={{ p: '9px', borderRadius: '9px', border: '1px solid', borderColor: t.border, bg: t.bg,
        fontSize: '12px', lineHeight: '16px', color: 'fg.muted', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <Box sx={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            bg: t.dot, color: t.dotFg }}>{st.icon}</Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Text as="div" sx={{ fontSize: '13px', lineHeight: '18px', fontWeight: 'semibold', color: 'fg.default', display: 'flex', alignItems: 'center' }}>{st.title}</Text>
            <Box sx={{ color: 'fg.subtle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</Box>
          </Box>
          {!updating && (
            <Box as="button" type="button" title={`Проверить обновления (проверено в ${checked})`} aria-label="Проверить обновления"
              disabled={busy} onClick={() => load(true)}
              sx={{ alignSelf: 'flex-start', width: 22, height: 22, p: 0, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 0, borderRadius: '6px', bg: 'transparent', color: 'fg.muted', cursor: 'pointer',
                ':hover:not(:disabled)': { color: 'fg.default', bg: 'neutral.muted' }, ':disabled': { opacity: 0.5, cursor: 'default' } }}>
              {busy ? <Spinner size="small" sx={{ width: 14, height: 14 }} /> : <SyncIcon size={14} />}
            </Box>
          )}
        </Box>
        {updating && <UpdateProgress stage={build.update} />}
        {!updating && headMsg && (
          <Box title={headMsg} sx={{ borderLeft: '2px solid', borderColor: st.tone === 'neutral' ? 'border.default' : t.border, pl: 2, color: 'fg.default', overflow: 'hidden' }}
            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{headMsg}</Box>
        )}
        {!updating && hasUpdate && (
          <Box sx={{ display: 'flex', gap: '6px' }}>
            {canClick && <Button size="small" variant="primary" leadingVisual={DownloadIcon} onClick={() => setConfirm(true)} sx={{ flex: 1 }}>Обновить</Button>}
            {pinned
              ? <Button as={RouterLink} to="/settings#updates" size="small" sx={{ flex: canClick ? undefined : 1 }}>Выбрать версию</Button>
              : <Button as="a" href={newLink} target="_blank" rel="noreferrer" size="small" sx={{ flex: canClick ? undefined : 1 }}>Что нового</Button>}
          </Box>
        )}
        {note && <Text sx={{ color: 'fg.subtle' }}>{note}</Text>}
        {upd.msg && <Text sx={{ color: 'attention.fg' }}>{upd.msg}</Text>}
        {v.error && <Text sx={{ color: 'attention.fg' }}>Нет связи с GitHub: {v.error}</Text>}
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
