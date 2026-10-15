export function fmt(n: number | string | null | undefined): string {
  const v = parseFloat(String(n ?? 0));
  if (isNaN(v) || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e15) return sign + (abs / 1e15).toFixed(1).replace(/\.0$/, '') + 'Q';
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
  // "Наборы политик" — новые предметы, появились в обновлении игры в ночь на 31.07.2026 (сверено
  // реверсом свежего бандла: строки локализации policy_rare/policy_epic/policy_legendary/
  // policy_mythic + суффикс policy_suffix="набор политик", id идут по возрастанию редкости, как и
  // весь остальной каталог). Ящик-открывашка со случайной наградой-политикой (см. скрин игрока —
  // "Редкий набор политик" с шансами по редкости награды). Иконки — реальные ассеты игры, найдены
  // пользователем по прямому URL (https://game.toncity.io/assets/booster_packs/policy_{rarity}_v2.png,
  // остальные редкости — перебором того же паттерна), скачаны в src/items/policy_pack_{rarity}.png.
  // ── Предметы «Летнего карнавала» (10-23.08.2026) ────────────────────────────
  // 39/40/41 и 42 — ТОЧНО: id пришли прямо в ответе витрины события (booster.rarity='eternal',
  // booster_pack.type='crystal'/'summer') и в таблице inventory (единственный type='ticket').
  39: { tag: 'eternal_booster', name: 'Вечный ускоритель',       scale: 0.73 },
  40: { tag: 'crystal',         name: 'Алмазный набор',          scale: 0.5  },
  41: { tag: 'summer',          name: 'Летний набор',            scale: 0.5  },
  42: { tag: 'ticket',          name: 'Билет',                   scale: 0.8  },
  // 35-38 — расходники (type='consumable'), и вид игра НЕ присылает нигде: ни в витрине, ни в
  // /storage/allitemdata (там только предметы, которыми аккаунт владеет). Сопоставлено по трём
  // сходящимся признакам: (1) в игре ровно четыре расходника — Чертёж и три Камня реформ
  // (локализация бандла consumables.types); (2) все четыре id созданы одной пачкой 04.08.2026 и
  // идут подряд, в том же порядке, что и в справочнике игры; (3) цены/лимиты витрины растут по
  // редкости камней — 30/80/180 билетов при лимитах 5/3/1, а Чертёж стоит особняком (90, лимит 2).
  // Если игра когда-нибудь пришлёт настоящий слаг — он перекроет это сопоставление (см.
  // hooks/useItemCatalog: каталог игры имеет приоритет над догадкой только при наличии name).
  35: { tag: 'blueprint_tome',          name: 'Чертёж',                        scale: 0.8 },
  36: { tag: 'reform_stone_epic',       name: 'Камень реформ (эпический)',     scale: 0.8 },
  37: { tag: 'reform_stone_legendary',  name: 'Камень реформ (легендарный)',   scale: 0.8 },
  38: { tag: 'reform_stone_mythic',     name: 'Камень реформ (мифический)',    scale: 0.8 },
  31: { tag: 'policy_pack_rare',      name: 'Редкий набор политик',      scale: 0.5 },
  32: { tag: 'policy_pack_epic',      name: 'Эпический набор политик',   scale: 0.5 },
  33: { tag: 'policy_pack_legendary', name: 'Легендарный набор политик', scale: 0.5 },
  34: { tag: 'policy_pack_mythic',    name: 'Мифический набор политик',  scale: 0.5 },
};

export function itemImgSrc(tag: string): string {
  return `/items/${tag}.png`;
}

// Сортировка каталога предметов (13.10.2026): сначала тип предмета (ящики → материалы →
// ускорители → остальное), внутри типа — по редкости (вечная → мифическая → ... → обычная).
// От самой редкой к самой частой — тот же порядок, что и у карточек политик/осколков (Policies.tsx).
export const RARITY_ORDER = ['eternal', 'mythic', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
const RARITY_RANK: Record<string, number> = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, i]));
// Наборы-"ящики" (basic/advanced/elite/premium/ultimate) не содержат слова редкости в теге вообще —
// без этой карты они не попадали под общий regex и проваливались в конец (видно на скрине: "Элитный
// набор" оказался зажат между эпической и необычной карточками). Соответствие цветов УЖЕ установлено
// в global.css (.ic-elite вместе с .ic-rare и т.д.) и подтверждено пользователем вживую — здесь то
// же самое сопоставление, только для сортировки, а не для покраски рамки.
// bare "eternal" (id 11 "Вечный набор") — ИМЯ предмета, не редкость: его настоящая редкость —
// мифическая (см. комментарий у .ic-mythic в global.css), "winter" — редкость ВЫШЕ мифической.
const TAG_RARITY_OVERRIDE: Record<string, string> = {
  basic: 'common', advanced: 'uncommon', elite: 'rare', premium: 'epic', ultimate: 'legendary',
  eternal: 'mythic', winter: 'eternal', blueprint_tome: 'legendary',
};
export function rarityRankFromTag(tag: string): number {
  const override = TAG_RARITY_OVERRIDE[tag];
  if (override) return RARITY_RANK[override];
  const m = tag.match(/(eternal|mythic|legendary|epic|rare|uncommon|common)/);
  return m ? RARITY_RANK[m[1]] : 99;
}

// ящики (наборы-открывашки со случайной наградой): booster_pack id 6-11/15/40/41, наборы политик 31-34
const CRATE_ITEM_IDS = new Set([6, 7, 8, 9, 10, 11, 15, 40, 41, 31, 32, 33, 34]);
// материалы: компонент/мастерплан (технофабрика) + расходники (чертёж, камни реформ)
const MATERIAL_ITEM_IDS = new Set([12, 13, 35, 36, 37, 38]);
// ускорители прокачки города
const BOOSTER_ITEM_IDS = new Set([0, 1, 2, 3, 4, 5, 39]);
export function itemTypeGroupRank(id: number): number {
  if (CRATE_ITEM_IDS.has(id)) return 0;
  if (MATERIAL_ITEM_IDS.has(id)) return 1;
  if (BOOSTER_ITEM_IDS.has(id)) return 2;
  return 3; // осколки/тайные политики/билеты/снежинки и прочее — отдельных страниц ради, в конец
}
