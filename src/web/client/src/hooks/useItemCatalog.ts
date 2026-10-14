import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ITEMS_BY_ID } from '../utils';

// Каталог предметов игры (id → тип/имя/редкость), который бот забирает из /storage/allitemdata и
// кэширует на сервере (см. src/utils/itemCatalog.js). Нужен, чтобы новые предметы — билеты,
// летний/алмазный набор, камни реформ, чертёж — показывались названием и картинкой, а не «#40»:
// их id заранее не известны и меняются от события к событию.
// title — готовое русское название из локализации игры (бот достаёт её из бандла, utils/itemLocale.js).
// tag — имя файла иконки в src/items (/items/<tag>.png), тот же тег, что и в ITEMS_BY_ID.
export interface CatalogItem { item_id: number; type: string | null; name: string | null; rarity: string | null; title?: string | null; tag?: string | null }

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
  if (it.title) return it.title;
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

// Название предмета по id для любой страницы: сначала название из локализации игры (каталог бота),
// затем статическая таблица клиента, затем имя, собранное из слага; «Предмет #id» — только если
// предмет неизвестен вообще. Читает уже загруженный каталог — страница, которой нужны свежие
// названия, вызывает useItemCatalog(), чтобы перерисоваться после его загрузки.
export function knownItemName(itemId: number | null | undefined, catalog?: Map<number, CatalogItem>): string | null {
  if (itemId == null) return null;
  const it = (catalog ?? cache)?.get(Number(itemId));
  return it?.title ?? ITEMS_BY_ID[Number(itemId)]?.name ?? catalogItemName(it);
}
export function itemName(itemId: number | null | undefined, catalog?: Map<number, CatalogItem>): string {
  if (itemId == null) return 'Предмет';
  return knownItemName(itemId, catalog) ?? `Предмет #${itemId}`;
}

// Иконка предмета — /items/<тег>.png. Тег отдаёт бот в каталоге (utils/itemCatalog.js tagOf), он же
// докачивает туда недостающие картинки из ассетов игры; для известных предметов тег есть и в ITEMS_BY_ID.
export function catalogItemImg(itemId: number, it?: CatalogItem): string | null {
  const tag = it?.tag ?? cache?.get(itemId)?.tag ?? ITEMS_BY_ID[itemId]?.tag;
  return tag ? `/items/${tag}.png` : null;
}

export function itemImgProps(itemId: number, it: CatalogItem | undefined) {
  return {
    src: catalogItemImg(itemId, it) ?? '',
    onError: (e: React.SyntheticEvent<HTMLImageElement>) => { (e.target as HTMLImageElement).style.display = 'none'; },
  };
}
