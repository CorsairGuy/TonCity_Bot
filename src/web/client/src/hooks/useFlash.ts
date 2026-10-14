import { useState, useCallback, useRef } from 'react';

export type FlashState = { msg: string; ok: boolean } | null;

export function useFlash() {
  const [flash, setFlash] = useState<FlashState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string, ok: boolean) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFlash({ msg, ok });
    timerRef.current = setTimeout(() => setFlash(null), 3500);
  }, []);

  return { flash, showFlash: show };
}
