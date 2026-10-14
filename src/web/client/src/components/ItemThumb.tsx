import { useState } from 'react';
import { catalogItemImg, catalogItemImgBySlug, catalogItemName, type CatalogItem } from '../hooks/useItemCatalog';

// Картинка предмета, которого нет в статическом справочнике (новые предметы события: билеты,
// летний/алмазный набор, камни реформ, чертёж). Пробуем по очереди:
//   1) иконку, скачанную ботом по id           — /items/live/<id>.png
//   2) иконку по слагу из каталога игры        — /items/<slug>.png (часть скачана заранее)
//   3) если картинки нет вовсе — показываем название (или #id), чтобы плитка не была пустой,
//      как это было с «42» до появления каталога.
export function ItemThumb({ itemId, item, size = 48, className, style }: {
  itemId: number;
  item?: CatalogItem;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const sources = [catalogItemImg(itemId), catalogItemImgBySlug(item)].filter(Boolean) as string[];
  const [idx, setIdx] = useState(0);
  const label = catalogItemName(item) ?? `#${itemId}`;

  if (idx >= sources.length) {
    return (
      <span style={{ fontSize: 10, textAlign: 'center', padding: 4, wordBreak: 'break-word', ...style }} title={label}>
        {label}
      </span>
    );
  }
  return (
    <img
      className={className}
      src={sources[idx]}
      alt={label}
      title={label}
      style={{ width: size, height: size, objectFit: 'contain', ...style }}
      onError={() => setIdx(i => i + 1)}
    />
  );
}
