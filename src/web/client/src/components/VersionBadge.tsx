import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Text, Link, Label, IconButton, Button, ConfirmationDialog, Spinner } from '@primer/react';
import { SyncIcon, PinIcon, GitBranchIcon, TagIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';
import { useSelfUpdate } from '../hooks/useSelfUpdate';

// Плашка версии внизу меню: канал обновлений, текущий коммит, есть ли новее и кнопка обновления
// (через обновлятель, см. docker-compose.yml). Выбор канала — Настройки → Обновления. Сервер
// кэширует ответ GitHub на 30 минут, поэтому опрос раз в 30 минут ничего не стоит.
export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const upd = useSelfUpdate();

  const load = async (force = false) => {
    setBusy(true);
    try { const d = await api.version(force); if (d && d.ok) setV(d); } catch { /* панель офлайн — молчим */ }
    finally { setBusy(false); }
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!v) return null;
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

  return (
    <Box sx={{ px: 3, py: 2, fontSize: 0, color: 'fg.muted', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {ch && (
          <RouterLink to="/settings#updates" style={{ textDecoration: 'none' }} title="Канал обновлений — Настройки">
            <Label variant={pinned ? 'attention' : 'secondary'} sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
              <ChIcon size={12} />{chText}
            </Label>
          </RouterLink>
        )}
        {v.local
          ? <Link href={`${v.repoUrl}/commit/${v.local.sha}`} target="_blank" rel="noreferrer" muted sx={{ fontFamily: 'mono' }}>{short(v.local.sha)}</Link>
          : <Text>версия неизвестна</Text>}
        <IconButton icon={SyncIcon} aria-label={`Проверить обновления (проверено в ${checked})`} size="small" variant="invisible"
          disabled={busy || upd.updating} onClick={() => load(true)} />
      </Box>
      {v.status === 'behind' && (
        <Link href={newLink} target="_blank" rel="noreferrer">
          <Label variant="success">Доступна новая{v.behindBy ? `: +${v.behindBy}` : ''}</Label>
        </Link>
      )}
      {pinned && !!v.newerReleases && (
        <RouterLink to="/settings#updates" style={{ textDecoration: 'none' }}>
          <Label variant="success">Есть релизы новее: {v.newerReleases}</Label>
        </RouterLink>
      )}
      {v.status === 'current' && <Text>Актуальная{v.auto ? ', автообновление' : ''}</Text>}
      {(v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') && (
        <Text>Локальные изменения, не из GitHub</Text>
      )}
      {buildRunning && v.build && (
        <Link href={v.build.url} target="_blank" rel="noreferrer" muted>Образ собирается на GitHub…</Link>
      )}
      {buildFailed && v.build && (
        <Link href={v.build.url} target="_blank" rel="noreferrer" sx={{ color: 'danger.fg' }}>Сборка образа не удалась</Link>
      )}
      {upd.updating
        ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Spinner size="small" /><Text>Обновляюсь, бот перезапускается…</Text></Box>
        : canClick && <Button size="small" onClick={() => setConfirm(true)}>Обновить</Button>}
      {upd.msg && <Text sx={{ color: 'attention.fg' }}>{upd.msg}</Text>}
      {v.error && <Text sx={{ color: 'attention.fg' }}>Нет связи с GitHub: {v.error}</Text>}

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
    </Box>
  );
}
