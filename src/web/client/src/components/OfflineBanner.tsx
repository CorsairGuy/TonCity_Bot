import { useEffect, useState } from 'react';
import { Box, Button, Flash } from '@primer/react';
import { api } from '../api';

// Бот перезапускается (обновление) или пропала сеть: запросы панели возвращают не-JSON или
// обрываются. Без баннера страницы молча показывали «нет данных». Пока бот недоступен, раз в
// 5 с проверяем /api/auth/status; первый удачный ответ любого запроса баннер снимает.
export function OfflineBanner() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const off = (e: Event) => setError((e as CustomEvent<string>).detail || 'Бот недоступен');
    const on = () => setError(null);
    window.addEventListener('tc-api-offline', off);
    window.addEventListener('tc-api-online', on);
    return () => { window.removeEventListener('tc-api-offline', off); window.removeEventListener('tc-api-online', on); };
  }, []);

  useEffect(() => {
    if (!error) return;
    const id = setInterval(() => { api.authStatus(); }, 5000);
    return () => clearInterval(id);
  }, [error]);

  if (!error) return null;
  return (
    <Box sx={{ px: 3, pt: 3 }}>
      <Flash variant="danger" sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <strong>{error}.</strong> Данные на странице могут быть пустыми или устаревшими, проверка связи каждые 5 с.
        </Box>
        <Button size="small" onClick={() => window.location.reload()}>Обновить страницу</Button>
      </Flash>
    </Box>
  );
}
