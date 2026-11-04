// Цвет неба за картой — как в игре (2.5, build 14184): фон pixi-приложения — сплошной цвет,
// линейно перетекающий между опорными часами палитры по местному времени, обновляется раз в 5 минут.
// Главный остров (и столица) — палитра по умолчанию, Зелёный предел — своя, бирюзовая.
type Palette = { hour: number; color: number }[];
const MAIN: Palette = [
  { hour: 0, color: 0x3e68a0 }, { hour: 3, color: 0x4470aa }, { hour: 6, color: 0x4a7bb8 }, { hour: 9, color: 0x5592f2 },
  { hour: 12, color: 0x5897fc }, { hour: 15, color: 0x5590f0 }, { hour: 18, color: 0x4c7fc4 }, { hour: 21, color: 0x4673b0 },
];
const D1: Palette = [
  { hour: 0, color: 0x54838c }, { hour: 3, color: 0x5b8d97 }, { hour: 6, color: 0x649aa5 }, { hour: 9, color: 0x78b9c6 },
  { hour: 12, color: 0x7cc0cd }, { hour: 15, color: 0x77b7c4 }, { hour: 18, color: 0x67a0ab }, { hour: 21, color: 0x5e919b },
];

export function skyColor(hour: number, district: 'main' | 'd1' = 'main'): string {
  const p = district === 'd1' ? D1 : MAIN;
  let i = 0;
  for (let k = p.length - 1; k >= 0; k--) if (hour >= p[k].hour) { i = k; break; }
  const a = p[i], b = p[(i + 1) % p.length];
  const t = Math.max(0, Math.min(1, (hour - a.hour) / ((b.hour === 0 ? 24 : b.hour) - a.hour)));
  const ch = (sh: number) => Math.round((a.color >> sh & 255) + ((b.color >> sh & 255) - (a.color >> sh & 255)) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
