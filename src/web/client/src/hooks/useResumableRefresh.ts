import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Если "Обновить" всё ещё выполняется на сервере (см. web/lib/opRegistry.js) в момент монтирования
// страницы — например, пользователь перезагрузил вкладку, пока шёл долгий прогон по аккаунтам —
// восстанавливает состояние загрузки кнопки и сам её разблокирует + подтягивает свежие данные,
// когда операция реально закончится. Сам обработчик onClick кнопки не меняется, только объявление
// стейта: `const [refreshing, setRefreshing] = useResumableRefresh(key, load)`.
export function useResumableRefresh(key: string, onResume: () => void) {
  const [refreshing, setRefreshing] = useState(false);
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    api.opStatus([key]).then(d => {
      if (cancelled || !d.ok || !d.running[key]) return;
      setRefreshing(true);
      timer = setInterval(async () => {
        const d2 = await api.opStatus([key]);
        if (cancelled) return;
        if (d2.ok && !d2.running[key]) {
          if (timer) clearInterval(timer);
          setRefreshing(false);
          onResumeRef.current();
        }
      }, 1500);
    }).catch(() => {});

    return () => { cancelled = true; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [refreshing, setRefreshing] as const;
}
