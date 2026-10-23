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

// Этап обновления для блока «Версия» в меню: заголовок — сам этап, подпись — подробность, stage —
// ход этапа для полосы (null — полосы нет, 'run' — бегущая), overall — общий ход для кольца
// (скачивание 0–80%, распаковка 80–95%, перезапуск 95%; null — крутится спиннером).
export interface StageView { title: string; sub: string | null; stage: number | 'run' | null; overall: number | null }
export function updateStageView(stage: UpdateStage | null): StageView {
  const p = stage?.progress;
  if (stage?.state === 'restarting')
    return { title: cap(stage.message || 'перезапускаю бота'), sub: 'обычно меньше минуты', stage: 'run', overall: 95 };
  if (stage?.state === 'pulling' && p && p.layers > 0) {
    if (p.downloaded < p.layers) {
      const dl = p.estTotal > 0 ? Math.min(1, p.cur / p.estTotal) : p.downloaded / p.layers;
      return { title: 'Скачиваю', sub: `${mb(p.cur)} из ${p.estTotal > p.total ? '~' : ''}${mb(p.estTotal)} МБ`, stage: dl * 100, overall: dl * 80 };
    }
    const ex = p.extracted / p.layers;
    return { title: 'Распаковываю', sub: `слой ${Math.min(p.extracted + 1, p.layers)} из ${p.layers}`, stage: ex * 100, overall: 80 + ex * 15 };
  }
  // слоёв нет — всё скачано раньше; прогресса нет — обновлятель старой версии
  if (stage?.state === 'pulling') return { title: p ? 'Проверяю образ' : cap(stage.message || 'скачиваю образ'), sub: null, stage: null, overall: null };
  return { title: 'Обновляюсь', sub: null, stage: null, overall: null };
}

// кольцо общего хода обновления 16×16 — по размеру иконок меню
export function ProgressRing({ pct }: { pct: number }) {
  const r = 6.25, c = 2 * Math.PI * r;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-label={`${Math.round(pct)}%`} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.5} />
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(0, Math.min(100, pct))) / 100} ${c}`} style={{ transition: 'stroke-dasharray .4s' }} />
    </svg>
  );
}
