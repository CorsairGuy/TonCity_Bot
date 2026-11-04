import { useEffect, useState } from 'react';
import { Box, Button, Flash, Label, Link, Text } from '@primer/react';
import { CheckCircleFillIcon, XCircleFillIcon, PulseIcon } from '@primer/octicons-react';
import { api, type ProbeResult } from '../api';

// Настройки → «Проверка ответов игры»: только GET-запросы через самого бота (routes/probe.js).
// Нужна после обновления игры: видно, какие ответы изменились, и каких зданий нет в резервном каталоге.
export function ProbeCard() {
  const [data, setData] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.probe().then(r => r.ok && setData(r)); }, []);
  const run = async () => {
    setBusy(true); setErr(null);
    const r = await api.probeRun();
    setBusy(false);
    if (r.ok) setData(r); else setErr(r.error ?? 'Ошибка');
  };
  const okN = data?.results.filter(r => r.ok).length ?? 0;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
        <Text sx={{ fontWeight: 'bold' }}>Проверка ответов игры</Text>
      </Box>
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Text sx={{ color: 'fg.muted', fontSize: 1 }}>
          Бот сам запрашивает у игры районы, каталоги зданий, политики, сезон, фабрику, взносы, чат гильдии и предложения рынка.
          Только чтение, ничего не покупает и не отправляет. Нужна после обновления игры.
        </Text>
        {err && <Flash variant="danger">{err}</Flash>}
        <Box sx={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button leadingVisual={PulseIcon} loading={busy} disabled={busy} onClick={run}>Проверить</Button>
          {data?.at && <Text sx={{ color: 'fg.muted', fontSize: 1 }}>{new Date(data.at).toLocaleString('ru')} · успешно {okN} из {data.results.length}</Text>}
        </Box>
        {!!data?.results.length && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {data.results.map(r => (
              <Box key={r.label}>
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', fontSize: 1, cursor: r.shape ? 'pointer' : 'default' }} onClick={() => r.shape && setOpen(open === r.label ? null : r.label)}>
                  <Box sx={{ color: r.ok ? 'success.fg' : 'danger.fg', display: 'flex' }}>{r.ok ? <CheckCircleFillIcon size={14} /> : <XCircleFillIcon size={14} />}</Box>
                  <Text sx={{ fontFamily: 'mono' }}>{r.label}</Text>
                  {r.account && <Label size="small" variant="secondary">{r.account}</Label>}
                  {!r.ok && <Text sx={{ color: 'danger.fg' }}>{r.status ? `${r.status} · ` : ''}{r.error}</Text>}
                </Box>
                {open === r.label && <Box as="pre" sx={{ m: 0, mt: 1, p: 2, bg: 'canvas.inset', borderRadius: 2, fontSize: 0, overflow: 'auto', maxHeight: 260 }}>{JSON.stringify(r.shape, null, 1)}</Box>}
              </Box>
            ))}
          </Box>
        )}
        {data?.missing_buildings && (data.missing_buildings.length
          ? <Flash variant="warning">
              В резервном каталоге нет {data.missing_buildings.length} зданий: {data.missing_buildings.join(', ')}.{' '}
              <Link href="/api/diag/probe/buildings.txt">Скачать дополненный buildings.txt</Link> — его нужно положить в репозиторий вместо config/buildings.txt.
            </Flash>
          : <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Резервный каталог зданий совпадает с игрой.</Text>)}
      </Box>
    </Box>
  );
}
