import type { CSSProperties, ReactNode } from 'react';

// Иконка политики в стиле карточек предметов (15.10.2026, вариант «объёмная»): фон и рамка
// редкости как у предметов (.ic-<редкость>), mdi-иконка из icon_key игры с градиентом и тенью
// цвета редкости (.pol-ic / .r-<редкость> в global.css) — вместо сплошной заливки с белой иконкой.
export function PolicyIcon({ rarity, iconKey, size = 77, iconSize, radius, style, children }: {
  rarity: string; iconKey?: string | null; size?: number; iconSize?: number; radius?: number;
  style?: CSSProperties; children?: ReactNode;
}) {
  const r = rarity || 'common';
  const icon = (iconKey || 'mdi-script-text').replace(/^mdi-/, '');
  const box: CSSProperties = size === 77 ? { ...style } : { width: size, height: size, borderRadius: radius ?? Math.round(size / 5), ...style };
  return (
    <div className={`item-card__box pol-box ic-${r} r-${r}`} style={box}>
      <span className={`mdi mdi-${icon} pol-ic`} style={{ fontSize: iconSize ?? Math.round(size * 0.47) }} />
      {children}
    </div>
  );
}
