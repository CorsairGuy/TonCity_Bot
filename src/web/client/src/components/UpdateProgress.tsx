import { Box, Text, ProgressBar, Spinner } from '@primer/react';
import type { UpdateStage } from '../api';

const mb = (b: number) => { const v = b / 1048576; return v < 100 ? v.toFixed(1) : v.toFixed(0); };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Ход обновления бота: скачивание образа по байтам (обновлятель читает поток Docker Engine API),
// распаковка слоёв и перезапуск. Шкала: скачивание 0–85%, распаковка 85–100%; на перезапуске
// полоса полная и анимирована. Нет данных (заявку ещё не взяли, старый обновлятель) — спиннер с текстом.
export function UpdateProgress({ stage, fallback = 'Обновляюсь, бот перезапускается…' }: { stage: UpdateStage | null; fallback?: string }) {
  const p = stage?.progress;
  let text: string, right: string | null = null, pct: number | null = null, animated = false;
  if (stage?.state === 'restarting') {
    text = `${cap(stage.message || 'перезапускаю бота')}…`; pct = 100; animated = true;
  } else if (stage?.state === 'pulling' && p && p.layers > 0) {
    const dl = p.downloaded >= p.layers ? 1 : p.estTotal > 0 ? Math.min(1, p.cur / p.estTotal) : p.downloaded / p.layers;
    pct = Math.round((0.85 * dl + 0.15 * (p.extracted / p.layers)) * 100);
    right = `${pct}%`;
    text = p.downloaded < p.layers
      ? `Скачиваю ${mb(p.cur)} из ${p.estTotal > p.total ? '~' : ''}${mb(p.estTotal)} МБ`
      : `Распаковываю слои: ${p.extracted} из ${p.layers}`;
  } else if (stage?.state === 'pulling') {
    // слоёв нет — всё уже скачано раньше; прогресса нет — обновлятель старой версии
    text = p ? 'Проверяю образ…' : `${cap(stage.message || 'скачиваю образ')}…`;
  } else text = fallback;

  if (pct === null) return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Spinner size="small" sx={{ width: 12, height: 12, flexShrink: 0 }} />
      <Text sx={{ color: 'fg.default' }}>{text}</Text>
    </Box>
  );
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <Text sx={{ color: 'fg.default', minWidth: 0 }}>{text}</Text>
        {right && <Text sx={{ ml: 'auto', fontFamily: 'mono', color: 'fg.muted' }}>{right}</Text>}
      </Box>
      <ProgressBar progress={pct} barSize="small" animated={animated} aria-label={text} />
    </Box>
  );
}
