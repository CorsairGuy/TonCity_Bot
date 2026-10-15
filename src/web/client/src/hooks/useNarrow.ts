import { useEffect, useState } from 'react';

// Узкий экран — та же граница, что у мобильной раскладки в global.css (бургер вместо сайдбара).
const QUERY = '(max-width: 768px)';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
