import { useEffect, useState } from 'react';
import { Box, Flash } from '@primer/react';
import { onServerEvent } from '../serverEvents';

// Баннер техработ игры: пока API игры отвечает 503+maintenance, бот и панель ставят запросы на паузу.
// Стоит в потоке страницы над её содержимым (раньше висел fixed поверх и закрывал бургер и шапку).
// Начало и конец техработ бот присылает сам (событие maintenance, serverEvents.ts), опроса нет.
export function MaintenanceBanner() {
  const [active, setActive] = useState(false);
  const [since, setSince] = useState<number | null>(null);

  useEffect(() => onServerEvent<{ active: boolean; since: number | null }>('maintenance', d => {
    setActive(!!d.active); setSince(d.since ?? null);
  }), []);

  if (!active) return null;
  const mins = since ? Math.max(0, Math.round((Date.now() - since) / 60000)) : 0;

  return (
    <Box sx={{ px: 3, pt: 3 }}>
      <Flash variant="warning">
        🛠️ <strong>Игра на технических работах</strong> — запросы к игре автоматически поставлены на паузу
        {mins > 0 ? ` (уже ~${mins} мин)` : ''}. Действия и автозадачи возобновятся сами после завершения.
      </Flash>
    </Box>
  );
}
