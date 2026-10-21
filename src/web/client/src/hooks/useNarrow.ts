import { useEffect, useState } from 'react';
import type { Column } from '@primer/react/experimental';

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

// Колонки DataTable для телефона: на узком экране остаются только перечисленные (по id, а без
// него — по field). Широкая таблица прокручивалась вбок, и кнопки действий уезжали за край.
export function narrowCols<T extends { id: string | number }>(narrow: boolean, keep: string[], cols: Column<T>[]): Column<T>[] {
  if (!narrow) return cols;
  // growCollapse вместо grow: у grow минимум — max-content, и длинное имя аккаунта распирало таблицу
  return cols.filter(c => keep.includes(String(c.id ?? c.field)))
    .map(c => (c.width == null || c.width === 'grow' ? { ...c, width: 'growCollapse' as const } : c));
}
