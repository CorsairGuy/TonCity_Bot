import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Text, Link, Label, ConfirmationDialog, Spinner } from '@primer/react';
import { SyncIcon, PinIcon, GitBranchIcon, TagIcon, DownloadIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';
import { useSelfUpdate } from '../hooks/useSelfUpdate';
import { useBuildState } from '../hooks/useBuildWatcher';

// Плашка версии внизу меню: канал обновлений, текущий коммит, есть ли новее и кнопка обновления
// (через обновлятель, см. docker-compose.yml). Выбор канала — Настройки → Обновления. Сервер
// кэширует ответ GitHub на 30 минут (3 минуты, пока собирается образ) и проверяет его сразу при запуске.
export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const upd = useSelfUpdate();
  // обновление идёт на сервере (в т.ч. начатое с другой страницы/вкладки или автообновлением)
  const serverBusy = useBuildState().busy;

  const load = async (force = false) => {
    setBusy(true);
    try { const d = await api.version(force); if (d && d.ok) setV(d); } catch { /* панель офлайн — молчим */ }
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
  const ChIcon = pinned ? PinIcon : ch?.kind === 'stable' ? TagIcon : GitBranchIcon;
  const chText = !ch ? '' : ch.kind === 'stable' ? `stable${v.currentRelease ? ' ' + v.currentRelease : ''}` : ch.name;

  const hasUpdate = v.status === 'behind' || (!!pinned && !!v.newerReleases);
  const pinnedToBottom = updating || hasUpdate;

  // одна строка состояния: цветная точка + текст
  const state: { color: string; text: ReactNode } =
    updating ? { color: 'accent.fg', text: 'Обновляюсь, бот перезапускается…' }
    : buildFailed && v.build ? { color: 'danger.fg', text: <Link href={v.build.url} target="_blank" rel="noreferrer" sx={{ color: 'danger.fg' }}>Сборка образа не удалась</Link> }
    : buildRunning && v.build ? { color: 'attention.fg', text: <Link href={v.build.url} target="_blank" rel="noreferrer" muted>Образ собирается на GitHub…</Link> }
    : v.status === 'behind' ? { color: 'success.fg', text: <Link href={newLink} target="_blank" rel="noreferrer" sx={{ color: 'success.fg' }}>Доступна новая{v.behindBy ? ` (+${v.behindBy})` : ''}</Link> }
    : pinned && !!v.newerReleases ? { color: 'success.fg', text: <RouterLink to="/settings#updates" style={{ color: 'inherit' }}>Есть релизы новее: {v.newerReleases}</RouterLink> }
    : v.status === 'current' ? { color: 'success.fg', text: 'Актуальная версия' }
    : (v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') ? { color: 'attention.fg', text: 'Локальные изменения' }
    : { color: 'fg.subtle', text: 'Статус неизвестен' };

  return (
    <>
      <div className="nav-separator" />
      {/* карточка ровно по ширине пунктов меню (nav-item): те же края, радиус 9px и внутренний
          отступ 8px с рамкой (7+1), поэтому текст и иконки стоят на одной вертикали с «Логи»/«Настройки» */}
      {/* есть что ставить (или уже ставится) — карточка прилипает к низу меню и видна при любой
          прокрутке; иначе стоит на своём месте после «Настроек» */}
      <div className={pinnedToBottom ? 'version-dock' : undefined}>
      <Box sx={{ mb: 2, px: '7px', py: '8px', borderRadius: '9px', border: '1px solid', borderColor: 'border.muted', bg: 'canvas.subtle',
        fontSize: '12px', lineHeight: '18px', color: 'fg.muted', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', height: 20 }}>
          <Text sx={{ fontSize: '14px', fontWeight: 'semibold', color: 'fg.default' }}>Версия</Text>
          <Box as="button" type="button" title={`Проверить обновления (проверено в ${checked})`} aria-label="Проверить обновления"
            disabled={busy || updating} onClick={() => load(true)}
            sx={{ ml: 'auto', width: 20, height: 20, p: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: 0, borderRadius: '6px', bg: 'transparent', color: 'fg.muted', cursor: 'pointer',
              ':hover:not(:disabled)': { color: 'fg.default', bg: 'neutral.muted' }, ':disabled': { opacity: 0.5, cursor: 'default' } }}>
            {busy ? <Spinner size="small" sx={{ width: 14, height: 14 }} /> : <SyncIcon size={14} />}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
          {ch && (
            <RouterLink to="/settings#updates" style={{ textDecoration: 'none', display: 'inline-flex', minWidth: 0 }} title="Канал обновлений — Настройки">
              <Label variant={pinned ? 'attention' : 'accent'} sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, maxWidth: '100%' }}>
                <ChIcon size={12} /><Box as="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chText}</Box>
              </Label>
            </RouterLink>
          )}
          {v.local
            ? <Link href={`${v.repoUrl}/commit/${v.local.sha}`} target="_blank" rel="noreferrer" muted sx={{ fontFamily: 'mono', ml: 'auto' }}>{short(v.local.sha)}</Link>
            : <Text sx={{ ml: 'auto' }}>версия неизвестна</Text>}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {updating
            ? <Spinner size="small" sx={{ width: 12, height: 12 }} />
            : <Box sx={{ width: 8, height: 8, mx: '2px', borderRadius: '50%', bg: state.color, flexShrink: 0 }} />}
          <Text sx={{ color: 'fg.default' }}>{state.text}</Text>
        </Box>
        {!updating && (
          <RouterLink to="/settings#updates" style={{ color: 'inherit', textDecoration: 'none' }} title="Канал и автообновление — Настройки">
            <Text sx={{ color: 'fg.subtle', ':hover': { color: 'fg.muted' } }}>
              {pinned ? 'Версия закреплена' : v.auto ? 'Автообновление включено' : 'Обновление вручную'}
            </Text>
          </RouterLink>
        )}
        {!updating && canClick && (
          // как пункты меню (nav-item); отрицательные поля — чтобы подсветка доходила до краёв карточки
          <button type="button" className="nav-item" style={{ margin: '0 -4px', width: 'calc(100% + 8px)', padding: '6px 4px', color: 'var(--fg)' }}
            onClick={() => setConfirm(true)}>
            <DownloadIcon /><span>Обновить</span>
          </button>
        )}
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
