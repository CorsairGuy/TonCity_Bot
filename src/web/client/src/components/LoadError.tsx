import { Box, Button, Flash } from '@primer/react';

// Ошибка загрузки данных страницы: вместо пустого «Нет данных», которое выглядело как правда.
export function LoadError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Flash variant="danger" sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box sx={{ flex: 1, minWidth: 200 }}>Не удалось загрузить данные: {error}</Box>
      {onRetry && <Button size="small" onClick={onRetry}>Повторить</Button>}
    </Flash>
  );
}

export const errText = (d: unknown, fallback = 'ошибка сервера') =>
  (d as { error?: string } | null)?.error || fallback;
