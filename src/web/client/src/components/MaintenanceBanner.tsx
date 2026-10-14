import { useEffect, useState } from 'react';
import { api } from '../api';

// Баннер техработ игры: пока API игры отвечает 503+maintenance, бот и панель ставят запросы на паузу.
// Компонент опрашивает /api/maintenance и показывает предупреждение вверху.
export function MaintenanceBanner() {
  const [active, setActive] = useState(false);
  const [since, setSince] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.maintenance();
        if (!alive) return;
        setActive(!!d.active);
        setSince(d.since ?? null);
      } catch { /* сеть панели недоступна — молчим */ }
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000); // раз в 5 минут
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!active) return null;
  const mins = since ? Math.max(0, Math.round((Date.now() - since) / 60000)) : 0;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: '#9a6700', color: '#fff', textAlign: 'center',
      padding: '8px 16px', fontSize: 14, fontWeight: 600,
      boxShadow: '0 2px 8px rgba(0,0,0,.3)',
    }}>
      🛠️ Игра на технических работах — запросы к игре автоматически поставлены на паузу
      {mins > 0 ? ` (уже ~${mins} мин)` : ''}. Действия и автозадачи возобновятся сами после завершения.
    </div>
  );
}
