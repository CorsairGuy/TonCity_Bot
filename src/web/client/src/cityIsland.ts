import island from './data/d1-island.json';
import mainIsland from './data/main-island.json';
import type { SpriteInfo } from './components/mapSprites';

type SourceRect = { x: number; y: number; w: number; h: number };
export type IslandBounds = { x0: number; y0: number; x1: number; y1: number };
function placeRect(r: SourceRect, x: number, y: number, sx: number, sy: number): IslandBounds {
  return { x0: x + r.x * sx, y0: y + r.y * sy, x1: x + (r.x + r.w) * sx, y1: y + (r.y + r.h) * sy };
}
// Общая граница в физических пикселях: соседние фрагменты покрывают её один раз.
// Сэмплинг идёт из расширенного frame с пикселями соседей, не с обрезанного края.
export function islandClipRect(core: IslandBounds, m: Pick<DOMMatrix, 'a' | 'd' | 'e' | 'f'>): IslandBounds {
  return { x0: (Math.round(core.x0 * m.a + m.e) - m.e) / m.a, y0: (Math.round(core.y0 * m.d + m.f) - m.f) / m.d,
    x1: (Math.round(core.x1 * m.a + m.e) - m.e) / m.a, y1: (Math.round(core.y1 * m.d + m.f) - m.f) / m.d };
}

// Привязка из оригинального движка 2.5: начало клетки D1(0,0) относительно
// исходного изображения острова. X/Y масштабируются отдельно: в Canvas TH округлена.
const GRID_X = 3444.3 - 376.5, GRID_Y = -173.9 - 217;
export const D1_ISLAND_SPRITES: Record<string, SpriteInfo> = Object.fromEntries(island.tiles.map(t => [
  `d1-island/${t.index}/${t.image}`, { pngUrl: `/sprites/d1-island/${t.image}`, frame: t.frame },
]));
export function d1IslandRects(originX: number, originY: number, tileW: number, tileH: number) {
  const sx = tileW / 753, sy = tileH / 434;
  return island.tiles.map(t => ({
    id: `d1-island/${t.index}/${t.image}`,
    ...placeRect(t.sourceRect, originX - GRID_X * sx, originY - GRID_Y * sy, sx, sy),
    core: placeRect(t.coreSourceRect, originX - GRID_X * sx, originY - GRID_Y * sy, sx, sy),
  }));
}

// Главный остров: field 22×22, getStartCoordinates(-400), floating_island
// center=(5508.5,7623-400), scale=.851. Эти величины взяты из оригинального движка.
const MAIN_SCALE = 0.851;
const MAIN_ORIGIN = { x: 22 * 500 / 2 - 753 * 0.5 / 2, y: 22 * 500 / 2 - 434 * 0.5 * 22 / 2 - 400 };
const MAIN_TOP_LEFT = { x: 5508.5 - mainIsland.meta.sourceSize.w * MAIN_SCALE / 2, y: 7623 - 400 - mainIsland.meta.sourceSize.h * MAIN_SCALE / 2 };
export const MAIN_ISLAND_SPRITES: Record<string, SpriteInfo> = Object.fromEntries(mainIsland.tiles.map(t => [
  `main-island/${t.index}/${t.image}`, { pngUrl: `/sprites/main-island/${t.image}`, frame: t.frame },
]));
export function mainIslandRects(originX: number, originY: number, tileW: number, tileH: number) {
  const sx = tileW / (753 * 0.5), sy = tileH / (434 * 0.5);
  const x = originX + (MAIN_TOP_LEFT.x - MAIN_ORIGIN.x) * sx, y = originY + (MAIN_TOP_LEFT.y - MAIN_ORIGIN.y) * sy;
  return mainIsland.tiles.map(t => ({
    id: `main-island/${t.index}/${t.image}`,
    ...placeRect(t.sourceRect, x, y, MAIN_SCALE * sx, MAIN_SCALE * sy),
    core: placeRect(t.coreSourceRect, x, y, MAIN_SCALE * sx, MAIN_SCALE * sy),
  }));
}
