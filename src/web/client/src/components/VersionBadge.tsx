import { useEffect, useState } from 'react';
import { Box, Text, Link, Label, IconButton } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, VersionInfo } from '../api';

// Плашка версии внизу меню: текущий коммит бота и есть ли новее на GitHub.
// Только показывает (без обновления). Сервер кэширует ответ GitHub на 30 минут, поэтому
// опрос раз в 30 минут ничего не стоит; кнопка обновления — ручная проверка.
export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);

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
  const newLink = v.compareUrl || v.release?.url || v.remote?.url || v.repoUrl;
  const checked = new Date(v.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

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
          disabled={busy} onClick={() => load(true)} />
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
      {v.error && <Text sx={{ color: 'attention.fg' }}>Нет связи с GitHub: {v.error}</Text>}
    </Box>
  );
}
