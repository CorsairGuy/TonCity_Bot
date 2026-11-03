import island from './data/d1-island.json';
import mainIsland from './data/main-island.json';
import type { SpriteInfo } from './components/mapSprites';

// Привязка из оригинального движка 2.5: начало клетки D1(0,0) относительно
// исходного изображения острова. X/Y масштабируются отдельно: в Canvas TH округлена.
const GRID_X = 3444.3 - 376.5, GRID_Y = -173.9 - 217;
export const D1_ISLAND_SPRITES: Record<string, SpriteInfo> = Object.fromEntries(island.tiles.map(t => [
  `d1-island/${t.image}`, { pngUrl: `/sprites/d1-island/${t.image}`, frame: { x: 0, y: 0, w: t.textureW, h: t.textureH } },
]));
export function d1IslandRects(originX: number, originY: number, tileW: number, tileH: number) {
  const sx = tileW / 753, sy = tileH / 434;
  return island.tiles.map(t => ({
    id: `d1-island/${t.image}`,
    x0: originX + (t.x - GRID_X) * sx, y0: originY + (t.y - GRID_Y) * sy,
    x1: originX + (t.x + t.w - GRID_X) * sx, y1: originY + (t.y + t.h - GRID_Y) * sy,
  }));
}

// Главный остров: field 22×22, getStartCoordinates(-400), floating_island
// center=(5508.5,7623-400), scale=.851. Эти величины взяты из оригинального движка.
const MAIN_SCALE = 0.851;
const MAIN_ORIGIN = { x: 22 * 500 / 2 - 753 * 0.5 / 2, y: 22 * 500 / 2 - 434 * 0.5 * 22 / 2 - 400 };
const MAIN_TOP_LEFT = { x: 5508.5 - mainIsland.meta.sourceSize.w * MAIN_SCALE / 2, y: 7623 - 400 - mainIsland.meta.sourceSize.h * MAIN_SCALE / 2 };
export const MAIN_ISLAND_SPRITES: Record<string, SpriteInfo> = Object.fromEntries(mainIsland.tiles.map(t => [
  `main-island/${t.image}`, { pngUrl: `/sprites/main-island/${t.image}`, frame: { x: 0, y: 0, w: t.textureW, h: t.textureH } },
]));
export function mainIslandRects(originX: number, originY: number, tileW: number, tileH: number) {
  const sx = tileW / (753 * 0.5), sy = tileH / (434 * 0.5);
  return mainIsland.tiles.map(t => ({
    id: `main-island/${t.image}`,
    x0: originX + (MAIN_TOP_LEFT.x + t.x * MAIN_SCALE - MAIN_ORIGIN.x) * sx,
    y0: originY + (MAIN_TOP_LEFT.y + t.y * MAIN_SCALE - MAIN_ORIGIN.y) * sy,
    x1: originX + (MAIN_TOP_LEFT.x + (t.x + t.w) * MAIN_SCALE - MAIN_ORIGIN.x) * sx,
    y1: originY + (MAIN_TOP_LEFT.y + (t.y + t.h) * MAIN_SCALE - MAIN_ORIGIN.y) * sy,
  }));
}
