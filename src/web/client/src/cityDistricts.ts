import mainCoords from './data/city-coords.json';
import mainRoads from './data/road-map.json';
import districtCoords from './data/district-d1-coords.json';
import districtRoads from './data/district-d1-road-map.json';

export type CityDistrict = 'main' | 'd1';
export const CITY_DISTRICTS = [
  { id: 'main' as const, title: 'Главный остров', offsetX: 0, minPopulation: 0 },
  { id: 'd1' as const, title: 'Зелёный предел', offsetX: 1000, minPopulation: 100_000_000 },
];
export const districtOf = (x: number): CityDistrict => x >= 1000 ? 'd1' : 'main';
export const districtOffset = (district: CityDistrict) => district === 'd1' ? 1000 : 0;
export const districtCoordsFor = (district: CityDistrict): { x: number; y: number }[] => district === 'd1' ? districtCoords : mainCoords;
export const districtRoadsFor = (district: CityDistrict): Record<string, { asset: string; big?: boolean }> => district === 'd1' ? districtRoads : mainRoads;
export function buildingDistrict(b: { id: string; district?: string | null }): CityDistrict {
  if (b.district === 'd1' || /^(RES_(rootweave|bough_towers|worldtree)|COM_(bloom_market|amber_vault|eden_consortium)|SER_heartwood)\.png$/.test(b.id)) return 'd1';
  return 'main';
}
export const inDistrict = <T extends { x: number }>(rows: T[], district: CityDistrict): T[] => rows.filter(row => districtOf(row.x) === district);
export function projectDistrict<T extends { x: number; y: number }>(rows: T[], district: CityDistrict, ox = 0, oy = 0): T[] {
  return inDistrict(rows, district).map(row => ({ ...row, x: row.x - districtOffset(district) + ox, y: row.y + oy }));
}
