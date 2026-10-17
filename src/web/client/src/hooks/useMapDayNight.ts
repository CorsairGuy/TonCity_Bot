import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { DayNightMode } from '../components/mapNight';

// Время суток на карте города: по часам устройства, всегда день или всегда ночь. Источник истины —
// config.ui.mapDayNight на сервере (localStorage PWA на iOS чистится, см. App.tsx saveOpenGroups),
// localStorage — только чтобы карта сразу открылась в нужном режиме, не дожидаясь ответа сервера.
const LS_KEY = 'tc_map_daynight';
const MODES: DayNightMode[] = ['auto', 'day', 'night'];
const isMode = (v: unknown): v is DayNightMode => MODES.includes(v as DayNightMode);

function loadLocal(): DayNightMode {
  try { const v = localStorage.getItem(LS_KEY); return isMode(v) ? v : 'auto'; } catch { return 'auto'; }
}

export function useMapDayNight(): [DayNightMode, (m: DayNightMode) => void] {
  const [mode, setMode] = useState<DayNightMode>(loadLocal);
  useEffect(() => {
    let cancelled = false;
    api.config().then(r => {
      const v = r.ok ? r.settings.ui?.mapDayNight : undefined;
      if (cancelled || !isMode(v)) return;
      setMode(v);
      try { localStorage.setItem(LS_KEY, v); } catch { /* */ }
    }).catch(() => { /* офлайн — остаётся локальный выбор */ });
    return () => { cancelled = true; };
  }, []);
  const change = useCallback((m: DayNightMode) => {
    setMode(m);
    try { localStorage.setItem(LS_KEY, m); } catch { /* */ }
    api.saveConfig({ ui: { mapDayNight: m } }).catch(() => { /* */ });
  }, []);
  return [mode, change];
}
