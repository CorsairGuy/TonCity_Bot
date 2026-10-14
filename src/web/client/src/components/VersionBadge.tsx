import { useEffect, useRef, useState } from 'react';
import { Box, Text, Link, Label, IconButton, Button, ConfirmationDialog, Spinner } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';

// Плашка версии внизу меню: текущий коммит бота, есть ли новее на GitHub и кнопка обновления
// (через Watchtower, см. docker-compose.yml). Сервер кэширует ответ GitHub на 30 минут, поэтому
// опрос раз в 30 минут ничего не стоит; кнопка со стрелками — ручная проверка.
export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { force: boolean; busyOps?: string[] }>(null);
  const [updating, setUpdating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = async (force = false) => {
    setBusy(true);
    try { const d = await api.version(force); if (d && d.ok) setV(d); } catch { /* панель офлайн — молчим */ }
    finally { setBusy(false); }
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 30 * 60 * 1000);
    return () => { clearInterval(id); if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // бот перезапускается: ждём, пока поднимется новый процесс с другим коммитом, и перезагружаем панель
  const waitForRestart = (oldSha: string | undefined) => {
    setUpdating(true);
    const started = Date.now();
    pollRef.current = window.setInterval(async () => {
      if (Date.now() - started > 10 * 60 * 1000) {
        if (pollRef.current) clearInterval(pollRef.current);
        setUpdating(false);
        setMsg('Бот не поднялся за 10 минут. Проверьте docker compose ps и логи watchtower.');
        return;
      }
      try {
        const d = await api.version();
        if (d && d.ok && d.local?.sha && d.local.sha !== oldSha) {
          if (pollRef.current) clearInterval(pollRef.current);
          window.location.reload();
        }
      } catch { /* бот ещё перезапускается */ }
    }, 5000);
  };

  const runUpdate = async (force: boolean) => {
    setMsg(null);
    const oldSha = v?.local?.sha;
    setUpdating(true);
    let r: Awaited<ReturnType<typeof api.update>>;
    try { r = await api.update(force); }
    catch { waitForRestart(oldSha); return; } // соединение оборвалось: бот уже перезапускается
    setUpdating(false);
    if (r.ok && r.updated) { waitForRestart(oldSha); return; }
    if (r.ok) { setMsg('Нового образа пока нет: дождитесь конца сборки на GitHub.'); return; }
    if (r.busy?.length) { setConfirm({ force: true, busyOps: r.busy }); return; }
    setMsg(r.error || 'Не удалось обновить');
  };

  if (!v) return null;
  const short = (s?: string | null) => (s ? s.slice(0, 7) : '—');
  const newLink = v.compareUrl || v.release?.url || v.remote?.url || v.repoUrl;
  const checked = new Date(v.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const buildRunning = v.build && v.build.status !== 'completed';
  const buildFailed = v.build && v.build.status === 'completed' && v.build.conclusion !== 'success';
  const canClick = v.canUpdate && (v.status === 'behind' || v.status === 'unknown') && !buildRunning && !buildFailed;

  return (
    <Box sx={{ px: 3, py: 2, fontSize: 0, color: 'fg.muted', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Text>
          Версия{' '}
          {v.local
            ? <Link href={`${v.repoUrl}/commit/${v.local.sha}`} target="_blank" rel="noreferrer" muted sx={{ fontFamily: 'mono' }}>{short(v.local.sha)}</Link>
            : 'неизвестна'}
        </Text>
        <IconButton icon={SyncIcon} aria-label={`Проверить обновления (проверено в ${checked})`} size="small" variant="invisible"
          disabled={busy || updating} onClick={() => load(true)} />
      </Box>
      {v.status === 'behind' && (
        <Link href={newLink} target="_blank" rel="noreferrer">
          <Label variant="success">Новая версия{v.behindBy ? `: +${v.behindBy}` : ''}</Label>
        </Link>
      )}
      {v.status === 'current' && <Text>Актуальная</Text>}
      {(v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') && (
        <Text>Локальные изменения, не из GitHub</Text>
      )}
      {v.status === 'unknown' && v.remote && (
        <Link href={v.remote.url} target="_blank" rel="noreferrer" muted>
          Последняя на GitHub: {short(v.remote.sha)}
        </Link>
      )}
      {v.release && v.status === 'behind' && (
        <Link href={v.release.url} target="_blank" rel="noreferrer" muted>Релиз {v.release.tag}</Link>
      )}
      {buildRunning && v.build && (
        <Link href={v.build.url} target="_blank" rel="noreferrer" muted>Образ собирается на GitHub…</Link>
      )}
      {buildFailed && v.build && (
        <Link href={v.build.url} target="_blank" rel="noreferrer" sx={{ color: 'danger.fg' }}>Сборка образа не удалась</Link>
      )}
      {updating
        ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Spinner size="small" /><Text>Обновляюсь, бот перезапускается…</Text></Box>
        : canClick && <Button size="small" onClick={() => setConfirm({ force: false })}>Обновить</Button>}
      {msg && <Text sx={{ color: 'attention.fg' }}>{msg}</Text>}
      {v.error && <Text sx={{ color: 'attention.fg' }}>Нет связи с GitHub: {v.error}</Text>}

      {confirm && (
        <ConfirmationDialog
          title="Обновить бота?"
          cancelButtonContent="Отмена"
          confirmButtonContent={confirm.force ? 'Обновить всё равно' : 'Обновить'}
          confirmButtonType={confirm.force ? 'danger' : 'primary'}
          onClose={(gesture) => {
            const c = confirm;
            setConfirm(null);
            if (gesture === 'confirm') runUpdate(c.force);
          }}
        >
          {confirm.busyOps?.length
            ? <>Сейчас идут операции: {confirm.busyOps.join(', ')}. При обновлении они прервутся.</>
            : <>Бот скачает новую версию и перезапустится. Задачи на аккаунтах прервутся и продолжатся после запуска, обычно это меньше минуты. Настройки, база и токены не меняются.</>}
        </ConfirmationDialog>
      )}
    </Box>
  );
}
