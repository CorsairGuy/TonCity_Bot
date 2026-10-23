import { useEffect, useState } from 'react';
import { Box, Flash } from '@primer/react';
import { api } from '../api';

// Баннер техработ игры: пока API игры отвечает 503+maintenance, бот и панель ставят запросы на паузу.
// Стоит в потоке страницы над её содержимым (раньше висел fixed поверх и закрывал бургер и шапку).
// Опрос раз в 5 минут, а пока пауза активна — раз в минуту, чтобы баннер не висел после конца работ.
export function MaintenanceBanner() {
  const [active, setActive] = useState(false);
  const [since, setSince] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await api.maintenance();
      if (!alive) return;
      const on = !!(d.ok && d.active);
      if (d.ok) { setActive(on); setSince(d.since ?? null); }
      timer = setTimeout(tick, on ? 60 * 1000 : 5 * 60 * 1000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

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
