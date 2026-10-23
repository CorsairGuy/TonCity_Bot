import { useCallback, useEffect, useLayoutEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

// Состояние страницы в адресе (?kind=guilds&league=quantum&all=1): «Назад» из чужого города
// возвращает ту же раскрытую лигу и длину списка, а ссылку на лигу можно переслать.
// replace — не плодим записи истории на каждое переключение.
export function useQueryState() {
  const [q, setQ] = useSearchParams();
  const patch = useCallback((p: Record<string, string | null>) => {
    setQ(prev => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(p)) { if (v == null) n.delete(k); else n.set(k, v); }
      return n;
    }, { replace: true });
  }, [setQ]);
  return [q, patch] as const;
}

// Прокрутка окна для этого адреса: запоминаем при уходе, восстанавливаем, когда данные готовы.
export function useScrollRestore(ready: boolean) {
  const { pathname, search } = useLocation();
  const key = `tc-scroll:${pathname}${search}`;
  useEffect(() => {
    const save = () => { try { sessionStorage.setItem(key, String(window.scrollY)); } catch { /* */ } };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [key]);
  useLayoutEffect(() => {
    if (!ready) return;
    let y = 0;
    try { y = Number(sessionStorage.getItem(key)) || 0; } catch { /* */ }
    if (y > 0) window.scrollTo(0, y);
    // только при готовности данных: дальше прокруткой управляет пользователь
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}
