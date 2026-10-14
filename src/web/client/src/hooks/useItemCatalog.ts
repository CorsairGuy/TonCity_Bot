import React, { useEffect, useState } from 'react';
import { api } from '../api';

// Каталог предметов игры (id → тип/имя/редкость), который бот забирает из /storage/allitemdata и
// кэширует на сервере (см. src/utils/itemCatalog.js). Нужен, чтобы новые предметы — билеты,
// летний/алмазный набор, камни реформ, чертёж — показывались названием и картинкой, а не «#40»:
// их id заранее не известны и меняются от события к событию.
export interface CatalogItem { item_id: number; type: string | null; name: string | null; rarity: string | null }

let cache: Map<number, CatalogItem> | null = null;
let pending: Promise<Map<number, CatalogItem>> | null = null;

function fetchCatalog(ids?: number[]): Promise<Map<number, CatalogItem>> {
  const needed = (ids ?? []).filter(id => !cache?.get(id)?.name);
  if (cache && !needed.length) return Promise.resolve(cache);
  if (!pending || needed.length) {
    pending = api.items(needed)
      .then(r => {
        cache = new Map((r.ok ? r.items : []).map(i => [i.item_id, i]));
        return cache;
      })
      .catch(() => cache ?? new Map<number, CatalogItem>())
      .finally(() => { pending = null; });
  }
  return pending;
}

// ids — предметы, которые страница собирается показать. Про новые предметы (расходники события)
// витрина отдаёт только item_id, поэтому их названия бот доразрешает поштучно у игры.
export function useItemCatalog(ids?: number[]): Map<number, CatalogItem> {
  const [map, setMap] = useState<Map<number, CatalogItem>>(() => cache ?? new Map());
  const key = (ids ?? []).join(',');
  useEffect(() => {
    let stop = false;
    fetchCatalog(key ? key.split(',').map(Number) : undefined).then(m => { if (!stop) setMap(new Map(m)); });
    return () => { stop = true; };
  }, [key]);
  return map;
}

// Русские названия по слагу — вытащены из локализации игры (bundle, раздел склада).
// Слаг приходит в каталоге полем name, тип — полем type; из пары собираем нормальное имя.
const RARITY_RU: Record<string, string> = {
  common: 'Обычный', uncommon: 'Необычный', rare: 'Редкий', epic: 'Эпический',
  legendary: 'Легендарный', mythic: 'Мифический', eternal: 'Вечный',
};
const PACK_RU: Record<string, string> = {
  basic: 'Базовый', advanced: 'Продвинутый', elite: 'Элитный', premium: 'Премиум',
  ultimate: 'Ультимейт', winter: 'Зимний', crystal: 'Алмазный', summer: 'Летний',
  policy_rare: 'Редкий', policy_epic: 'Эпический', policy_legendary: 'Легендарный', policy_mythic: 'Мифический',
};
const SIMPLE_RU: Record<string, string> = {
  masterplan: 'Мастерплан', component: 'Компонент', snowflake: 'Снежинка', ticket: 'Билет',
  blueprint_tome: 'Чертёж',
  reform_stone_epic: 'Камень реформ (эпический)',
  reform_stone_legendary: 'Камень реформ (легендарный)',
  reform_stone_mythic: 'Камень реформ (мифический)',
};

// когда вид предмета неизвестен, а тип известен — пишем хотя бы тип по-русски
const TYPE_RU: Record<string, string> = {
  consumable: 'Материал', booster: 'Ускоритель', booster_pack: 'Набор',
  policy_shard: 'Осколок', mystery_policy: 'Тайная политика', ticket: 'Билет',
  masterplan: 'Мастерплан', component: 'Компонент',
};

export function catalogItemName(it: CatalogItem | undefined): string | null {
  if (!it) return null;
  const slug = it.name ?? '';
  if (!slug) return it.type ? (TYPE_RU[it.type] ?? it.type) : null;
  if (SIMPLE_RU[slug]) return SIMPLE_RU[slug];
  switch (it.type) {
    case 'booster': return `${RARITY_RU[slug] ?? slug} ускоритель`;
    case 'booster_pack': return slug.startsWith('policy_')
      ? `${PACK_RU[slug] ?? slug} набор политик`
      : `${PACK_RU[slug] ?? slug} набор`;
    case 'policy_shard': return `${RARITY_RU[slug.replace(/^shard_/, '')] ?? slug} осколок`;
    case 'mystery_policy': return `${RARITY_RU[slug.replace(/^mystery_/, '')] ?? slug} тайная политика`;
    case 'consumable': return SIMPLE_RU[slug] ?? slug;
    default: return SIMPLE_RU[slug] ?? (slug || null);
  }
}

// Иконку для неизвестного предмета отдаёт сам бот: он скачал её из ассетов игры при обновлении
// каталога (src/items/live/<id>.png раздаётся как /items/live/<id>.png).
export function catalogItemImg(itemId: number): string {
  return `/items/live/${itemId}.png`;
}

// Часть картинок новых предметов уже лежит в src/items под слагом игры (скачаны заранее:
// crystal/summer наборы, blueprint_tome, reform_stone_*, eternal ускоритель) — используем их как
// запасной вариант, если бот ещё не успел обновить каталог и докачать иконку по id.
export function catalogItemImgBySlug(it: CatalogItem | undefined): string | null {
  const slug = it?.name;
  if (!slug) return null;
  if (it?.type === 'booster' && slug === 'eternal') return '/items/eternal_booster.png';
  return `/items/${slug}.png`;
}

// <img> с цепочкой запасных адресов: сначала иконка по id, затем по слагу, иначе прячемся.
export function itemImgProps(itemId: number, it: CatalogItem | undefined) {
  const fallback = catalogItemImgBySlug(it);
  return {
    src: catalogItemImg(itemId),
    onError: (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.target as HTMLImageElement;
      if (fallback && !img.dataset.fallbackTried) { img.dataset.fallbackTried = '1'; img.src = fallback; return; }
      img.style.display = 'none';
    },
  };
}
