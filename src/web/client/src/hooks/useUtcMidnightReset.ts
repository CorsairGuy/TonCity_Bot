import { useEffect, useRef } from 'react';

// Вызывает cb в 00:00 UTC (и при возврате на вкладку, если сменился UTC-день).
// Нужно для ежедневных мини-игр: отображение «решено» должно сбрасываться каждый день.
export function useUtcMidnightReset(cb: () => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const dayRef = useRef(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = new Date();
      // +5 сек буфер, чтобы сервер уже считал новый день
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
      timer = setTimeout(() => {
        dayRef.current = new Date().toISOString().slice(0, 10);
        cbRef.current();
        schedule();
      }, next - now.getTime());
    };
    schedule();

    // если вкладку усыпили/вернулись после полуночи — досрочно проверим смену дня
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const today = new Date().toISOString().slice(0, 10);
      if (today !== dayRef.current) { dayRef.current = today; cbRef.current(); }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
}
