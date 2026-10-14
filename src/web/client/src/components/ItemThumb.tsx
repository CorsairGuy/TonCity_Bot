import { useState } from 'react';
import { catalogItemImg, catalogItemName, type CatalogItem } from '../hooks/useItemCatalog';

// Картинка предмета, которого нет в статическом справочнике (новые предметы события).
//   1) иконка по тегу из каталога бота — /items/<тег>.png (бот сам докачивает недостающие в src/items)
//   2) если картинки нет вовсе — показываем название (или #id), чтобы плитка не была пустой.
export function ItemThumb({ itemId, item, size = 48, className, style }: {
  itemId: number;
  item?: CatalogItem;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const sources = [catalogItemImg(itemId, item)].filter(Boolean) as string[];
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
