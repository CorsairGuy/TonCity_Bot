import { useCallback, useEffect, useState } from 'react';
import { api, type ExtraKind } from '../api';

// Снимок ответа игры из БД (game_extra_cache) + обновление по кнопке. При открытии в игру не ходит.
export function useExtra<T>(kind: ExtraKind, accountId: number | null | undefined, ref?: string | number) {
  const [data, setData] = useState<T | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountId == null) { setData(null); setUpdatedAt(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    api.extra<T>(kind, accountId, ref).then(r => {
      if (!alive) return;
      if (r.ok) { setData(r.data); setUpdatedAt(r.updated_at); } else setError(r.error ?? 'Ошибка');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind, accountId, ref]);

  const refresh = useCallback(async () => {
    if (accountId == null) return false;
    setRefreshing(true); setError(null);
    try {
      const r = await api.extraRefresh<T>(kind, accountId, ref);
      if (r.ok) { setData(r.data); setUpdatedAt(r.updated_at); return true; }
      setError(r.error ?? 'Ошибка'); return false;
    } finally { setRefreshing(false); }
  }, [kind, accountId, ref]);

  return { data, updatedAt, loading, refreshing, error, refresh, setData };
}
