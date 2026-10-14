export function fmt(n: number | string | null | undefined): string {
  const v = parseFloat(String(n ?? 0));
  if (isNaN(v) || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v));
}

// Точное целое с разделением тысяч (для баланса алмазов — без сокращений).
export function fmtInt(n: number | string | null | undefined): string {
  const v = Math.round(parseFloat(String(n ?? 0)));
  if (isNaN(v) || !isFinite(v)) return '—';
  return v.toLocaleString('ru-RU');
}

// Прибыль в алмазах — реальное дробное значение (до 1 знака, без сокращений/округления до целого).
export function fmtCr(n: number | string | null | undefined): string {
  const v = parseFloat(String(n ?? 0));
  if (isNaN(v) || !isFinite(v)) return '—';
  return (Math.round(v * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

export function fmtPop(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

export function sortByName<T>(arr: T[], key = 'name'): T[] {
  return [...arr].sort((a, b) =>
    String((a as Record<string, unknown>)[key] ?? '').localeCompare(
      String((b as Record<string, unknown>)[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' }
    )
  );
}

export const ITEMS_BY_ID: Record<number, { tag: string; name: string; scale: number }> = {
  0:  { tag: 'common',      name: 'Обычный ускоритель',     scale: 0.73 },
  1:  { tag: 'uncommon',    name: 'Необычный ускоритель',   scale: 0.73 },
  2:  { tag: 'rare',        name: 'Редкий ускоритель',      scale: 0.73 },
  3:  { tag: 'epic',        name: 'Эпический ускоритель',   scale: 0.73 },
  4:  { tag: 'legendary',   name: 'Легендарный ускоритель', scale: 0.73 },
  5:  { tag: 'mythic',      name: 'Мифический ускоритель',  scale: 0.73 },
  6:  { tag: 'basic',       name: 'Базовый набор',          scale: 0.5  },
  7:  { tag: 'advanced',    name: 'Продвинутый набор',      scale: 0.5  },
  8:  { tag: 'elite',       name: 'Элитный набор',          scale: 0.5  },
  9:  { tag: 'premium',     name: 'Премиум набор',          scale: 0.5  },
  10: { tag: 'ultimate',    name: 'Ультимейт набор',        scale: 0.5  },
  11: { tag: 'eternal',     name: 'Вечный набор',           scale: 0.5  },
  12: { tag: 'masterplan',  name: 'Мастерплан',             scale: 0.9  },
  13: { tag: 'component',   name: 'Компонент',              scale: 0.9  },
  14: { tag: 'snowflake',   name: 'Снежинка',               scale: 0.9  },
  15: { tag: 'winter',      name: 'Зимний набор',           scale: 0.5  },
  16: { tag: 'shard_common',      name: 'Обычный осколок',              scale: 0.85 },
  17: { tag: 'shard_uncommon',    name: 'Необычный осколок',            scale: 0.85 },
  18: { tag: 'shard_rare',        name: 'Редкий осколок',               scale: 0.85 },
  19: { tag: 'shard_epic',        name: 'Эпический осколок',            scale: 0.85 },
  20: { tag: 'shard_legendary',   name: 'Легендарный осколок',          scale: 0.85 },
  21: { tag: 'shard_mythic',      name: 'Мифический осколок',           scale: 0.85 },
  22: { tag: 'shard_eternal',     name: 'Вечный осколок',               scale: 0.85 },
  23: { tag: 'mystery_common',    name: 'Обычная тайная политика',      scale: 0.85 },
  24: { tag: 'mystery_uncommon',  name: 'Необычная тайная политика',    scale: 0.85 },
  25: { tag: 'mystery_rare',      name: 'Редкая тайная политика',       scale: 0.85 },
  26: { tag: 'mystery_epic',      name: 'Эпическая тайная политика',    scale: 0.85 },
  27: { tag: 'mystery_legendary', name: 'Легендарная тайная политика',  scale: 0.85 },
  28: { tag: 'mystery_mythic',    name: 'Мифическая тайная политика',   scale: 0.85 },
  29: { tag: 'mystery_eternal',   name: 'Вечная тайная политика',       scale: 0.85 },
};

export function itemImgSrc(tag: string): string {
  return `/items/${tag}.png`;
}
