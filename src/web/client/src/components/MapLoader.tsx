import { Box, ProgressBar, Spinner, Text } from '@primer/react';

// Загрузка карты города/столицы одной шкалой: первые DATA_SHARE — данные страницы (лоадер страницы,
// счётчик ответов API), остальное — сама карта (атласы, нарезка спрайтов, ночная перекраска, см.
// CityActionsCanvas). Карта показывается только целиком готовой, до этого — этот лоадер.
export const DATA_SHARE = 0.1;

export function MapLoader({ pct, text }: { pct: number; text: string }) {
  const p = Math.round(Math.max(0, Math.min(1, pct)) * 100);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <Spinner />
      <ProgressBar progress={p} barSize="small" aria-label={`Загрузка карты: ${p}%`} sx={{ width: 280 }} />
      <Text sx={{ fontSize: 0, color: 'fg.muted', fontVariantNumeric: 'tabular-nums' }}>{text}</Text>
    </Box>
  );
}

// Promise.all, который отмечает каждый пришедший ответ (для счётчика «Данные города 5 / 9»)
export function allCounted<T extends readonly unknown[]>(ps: readonly [...{ [K in keyof T]: Promise<T[K]> }], step: () => void): Promise<T> {
  return Promise.all(ps.map(p => p.finally(step))) as unknown as Promise<T>;
}
