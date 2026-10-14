// Клиентский расчёт показателей референса города — зеркало src/web/cityStats.js.
// Формулы сверены verbatim с бандлом игры и end-to-end с живым городом
// (население и счастье совпали до 7 знаков). При правках синхронизировать ОБА файла.
// 13 ★2/★3 зданий считаются СВОИМИ формулами вместо общих star-формул — см. BUILDING_OVERRIDES.
import type { CityStats, MapBuilding, ServiceCat } from './api';

export interface BuildingParam {
  id: string;
  category: string;
  service_category: string | null;
  base_profit: number | null;
  base_population: number | null;
  service_coverage: number | null;
  base_price: number | null;
  base_price_factor: number | null;
  urban_vitality_population: number | null;
  star_lvl: number | null;
}

const SERVICE_FACTORS: Record<ServiceCat, number> = { 'fire-station': 0.3, 'police-station': 0.3, hospital: 0.3, park: 0.1 };
const SERVICE_CATS: ServiceCat[] = ['hospital', 'police-station', 'fire-station', 'park'];
const isStar = (o: BuildingParam) => o.star_lvl !== null && o.star_lvl !== undefined;
const familyId = (id: string) => id.replace(/_\d+_star\.png$/i, '.png');

// точечные исключения формул для конкретных эволюционировавших (★2/★3) зданий — сверено с бандлом
// (объект "Ug": getProfitAtLevel/getPopulationAtLevel/getCoverage/getPriceForLevel у ВСЕХ городских
// зданий сначала проверяют Ug[id], и только если там нет нужного поля — падают на общую
// star/non-star формулу по показателю). 13 зданий, у каждого свой набор изменённых показателей (не
// все три сразу) и часто своя цена улучшения, отличная и от общей, и от чужих исключений.
interface BuildingOverride { population?: (b: number, n: number) => number; profit?: (b: number, n: number) => number; coverage?: (b: number, n: number) => number; upgradePrice?: (b: number, n: number) => number }
const BUILDING_OVERRIDES: Record<string, BuildingOverride> = {
  'COM_grand_arcanum_2_star.png': { profit: (b, n) => b * Math.pow(n, 1.11), upgradePrice: (b, n) => n <= 4 ? b * Math.exp(0.45 * n) : b * Math.exp(0.48 * n) },
  'COM_grand_arcanum_3_star.png': { profit: (b, n) => b * Math.pow(n, 1.07), upgradePrice: (b, n) => b * Math.exp(0.52 * n) },
  'COM_startup_hub_3_star.png': { profit: (b, n) => b * Math.pow(n, 1.15), upgradePrice: (b, n) => n <= 5 ? b * Math.exp(0.46 * n) : b * Math.exp(0.49 * n) },
  'RES_crystal_aurora_3_star.png': { population: (b, n) => b * Math.pow(n, 0.72), profit: (b, n) => b / 1.5 * Math.log(4 * n + 1), upgradePrice: (b, n) => b * Math.exp(0.51 * n) },
  'RES_nova_nexus_2_star.png': { population: (b, n) => b * Math.pow(n, 0.63), profit: (b, n) => b / 1.7 * Math.log(4 * n + 1) },
  'RES_nova_nexus_3_star.png': { population: (b, n) => b * Math.pow(n, 0.7), profit: (b, n) => b / 1.55 * Math.log(3.5 * n + 1), upgradePrice: (b, n) => b * Math.exp(0.52 * n) },
  'SER_botanical_garden_2_star.png': { coverage: (b, n) => b * Math.pow(n, 0.71), upgradePrice: (b, n) => b * Math.exp(0.49 * n) },
  'SER_botanical_garden_3_star.png': { coverage: (b, n) => b * Math.pow(n, 0.74), upgradePrice: (b, n) => b * Math.exp(0.51 * n) },
  'SER_fire_headquarters_2_star.png': { coverage: (b, n) => b * Math.pow(n, 0.64), upgradePrice: (b, n) => b * Math.exp(0.48 * n) },
  'SER_fire_headquarters_3_star.png': { coverage: (b, n) => b * Math.pow(n, 0.69), upgradePrice: (b, n) => b * Math.exp(0.51 * n) },
  'SER_medical_center_3_star.png': { coverage: (b, n) => b * Math.pow(n, 0.72), upgradePrice: (b, n) => b * Math.exp(0.52 * n) },
  'SER_police_headquarters_2_star.png': { coverage: (b, n) => b * Math.pow(n, 0.66), upgradePrice: (b, n) => b * Math.exp(0.49 * n) },
  'SER_police_headquarters_3_star.png': { coverage: (b, n) => b * Math.pow(n, 0.7), upgradePrice: (b, n) => b * Math.exp(0.515 * n) },
};

function popAtLevel(o: BuildingParam, n: number): number {
  if (o.category !== 'residential') return 0;
  const base = o.base_population || 0;
  const ov = BUILDING_OVERRIDES[o.id];
  if (ov?.population) return ov.population(base, n);
  return isStar(o) ? base * Math.pow(n, 0.67) : base * Math.pow(n, 1.5);
}
// urbanVitalityMult — множитель порога от политики "urban_vitality_requirement" (сверено с
// бандлом: getProfitAtLevel(n,cityPop,urbanVitalityMult=1) → l=urban_vitality_population·mult)
function profitAtLevel(o: BuildingParam, n: number, cityPop: number, urbanVitalityMult = 1): number {
  const ov = BUILDING_OVERRIDES[o.id];
  if (o.category === 'residential') {
    const bp = o.base_profit || 0;
    if (ov?.profit) return ov.profit(bp, n); // исключение НЕ имеет частного случая n===1, в отличие от общей формулы
    return n === 1 ? bp : (bp / 1.6) * Math.log(4 * n + 1);
  }
  if (o.category === 'commercial') {
    const bp = o.base_profit || 0;
    let i = ov?.profit ? ov.profit(bp, n) : (isStar(o) ? bp * Math.pow(n, 1.1) : bp * Math.pow(n, 1.3));
    if (o.urban_vitality_population != null) {
      const uv = o.urban_vitality_population * urbanVitalityMult;
      const x = Math.max(i * 0.01, i * ((cityPop || 0) / uv));
      i = Math.min(i, x);
    }
    return i;
  }
  return 0;
}
function coverageAtLevel(o: BuildingParam, n: number): number {
  if (o.category !== 'service') return 0;
  const cov = o.service_coverage || 0;
  const ov = BUILDING_OVERRIDES[o.id];
  if (ov?.coverage) return ov.coverage(cov, n);
  if (isStar(o)) return cov * Math.pow(n, 0.67);
  if (n === 1) return cov;
  if (n >= 19) return cov * Math.pow(n, 1.5);
  return cov * Math.exp(0.24 * n);
}
export function upgradeStep(o: BuildingParam, s: number): number {
  const base = o.base_price || 0;
  const ov = BUILDING_OVERRIDES[o.id];
  if (ov?.upgradePrice) return ov.upgradePrice(base, s);
  return base * Math.exp(0.5 * s);
}
function upgradeCostTo(o: BuildingParam, target: number): number {
  let sum = 0;
  for (let s = 1; s < target; s++) sum += upgradeStep(o, s);
  return sum;
}

// здание "в стройке" (b.end в будущем) даёт profit=0/population=0, ПОКА не завершится — не старый
// уровень, а именно ноль (сверено с бандлом игры: actualProfit/actualPopulation = isUnderConstruction?0:...)
const isUnderConstruction = (b: MapBuilding, now: number) => !!(b.end && new Date(b.end).getTime() > now);

// живые модификаторы от гильдии/политик/разнообразия аккаунта (см. reference_game_formulas.md,
// раздел "Модификаторы дохода/населения/счастья"). Без mods (или с нейтральными значениями по
// умолчанию) функция считает "голую" формулу — так работали референсы города и раньше, обратная
// совместимость не нарушена. Собираются в CityMap.tsx (buildCityStatsMods) из живых
// /guilds/benefits, /policies/cabinet и /progress/diversity.
export interface CityStatsMods {
  incomeBoost?: number;              // гильдия: benefits.income_boost, множитель ×(1+x)
  diversityIncomeBoost?: number;     // "Разнообразие": GET /progress/diversity → income_bonus, множитель ×(1+x), ПОСЛЕДНИЙ по порядку
  globalIncomeMult?: number;         // policyMultiplier("global_income")
  categoryIncomeMult?: (category: string) => number;      // ("category_income","building_category",cat)
  buildingTypeIncomeMult?: (id: string) => number;        // ("building_type_income","building_type",id)
  populationMult?: number;           // policyMultiplier("population")
  serviceCoverageMult?: (cat: ServiceCat) => number;      // ("service_category_coverage",cat) × ("total_coverage")
  urbanVitalityMult?: number;        // max(.01, policyMultiplier("urban_vitality_requirement"))
  happinessFloorDelta?: number;      // min(.75, policyAddend("happiness_floor")/100)
  happinessCeilingDelta?: number;    // policyAddend("happiness_ceiling")/100
  buildCostMult?: number;
  upgradeCostMult?: number;
}
const NEUTRAL_MODS: Required<CityStatsMods> = {
  incomeBoost: 0, diversityIncomeBoost: 0, globalIncomeMult: 1,
  categoryIncomeMult: () => 1, buildingTypeIncomeMult: () => 1,
  populationMult: 1, serviceCoverageMult: () => 1,
  urbanVitalityMult: 1, happinessFloorDelta: 0, happinessCeilingDelta: 0,
  buildCostMult: 1, upgradeCostMult: 1,
};

export function computeCityStats(buildings: MapBuilding[], map: Map<string, BuildingParam>, mods: CityStatsMods = NEUTRAL_MODS): CityStats {
  const m: Required<CityStatsMods> = { ...NEUTRAL_MODS, ...mods };
  const list = Array.isArray(buildings) ? buildings : [];
  const now = Date.now();

  // население — множитель политики "population" применяется здесь же (сверено с бандлом:
  // getPopulation везде возвращает population·populationMultiplier, не только на экране)
  let rawPopulation = 0;
  for (const b of list) {
    const o = map.get(b.id); if (!o) continue;
    const lvl = Number(b.level || 1); if (lvl < 1 || isUnderConstruction(b, now)) continue;
    rawPopulation += popAtLevel(o, lvl);
  }
  const population = rawPopulation * m.populationMult;

  // прибыль + покрытие — category/building type множители применяются НА ЗДАНИЕ, до суммирования
  let profit = 0;
  const coverageByCatRaw: Record<ServiceCat, number> = { hospital: 0, 'police-station': 0, 'fire-station': 0, park: 0 };
  for (const b of list) {
    const o = map.get(b.id); if (!o) continue;
    const lvl = Number(b.level || 1); if (lvl < 1 || isUnderConstruction(b, now)) continue;
    let p = profitAtLevel(o, lvl, population, m.urbanVitalityMult);
    p *= m.categoryIncomeMult(o.category) * m.buildingTypeIncomeMult(o.id);
    profit += p;
    if (o.category === 'service' && o.service_category && (o.service_category as ServiceCat) in coverageByCatRaw) {
      coverageByCatRaw[o.service_category as ServiceCat] += coverageAtLevel(o, lvl);
    }
  }
  // ОТОБРАЖАЕМОЕ покрытие — СЫРАЯ сумма, БЕЗ serviceCoverageMult (сверено verbatim с бандлом: Map
  // "coverages" в getHappiness копится из RAW T.coverage, множитель туда не попадает — он участвует
  // ТОЛЬКО во внутреннем расчёте happiness ниже, не в отображаемом числе)
  const coverageByCat: Record<ServiceCat, number> = { hospital: 0, 'police-station': 0, 'fire-station': 0, park: 0 };
  for (const k of SERVICE_CATS) coverageByCat[k] = Math.round(coverageByCatRaw[k]);

  const serviceRatios: Record<ServiceCat, number> = { hospital: 1, 'police-station': 1, 'fire-station': 1, park: 1 };
  for (const k of SERVICE_CATS) {
    const adjusted = coverageByCatRaw[k] * m.serviceCoverageMult(k);
    serviceRatios[k] = population > 0 ? Math.min(adjusted / population, 1) : 1;
  }

  // floor/ceiling — базовая кривая по населению + дельты политик (сверено verbatim с бандлом:
  // y=min(1,y+floorDelta); k=max(.01,min(1,1+ceilingDelta)); итог ОДНОЙ формулой для любого
  // населения, включая 0 — при 0 населения weighted=0, и если ceiling-политика активна, happiness
  // будет ПОТОЛКОМ, а не автоматической единицей)
  let floor: number;
  if (population <= 20) floor = 1;
  else if (population >= 500) floor = 0.01;
  else floor = 1 - (population - 20) / 480 * (1 - 0.01);
  floor = Math.min(1, floor + m.happinessFloorDelta);
  const ceiling = Math.max(0.01, Math.min(1, 1 + m.happinessCeilingDelta));
  let weighted = 0;
  if (population > 0) {
    for (const k of SERVICE_CATS) weighted += (SERVICE_FACTORS[k] || 0) * serviceRatios[k];
  }
  const happiness = Math.min(ceiling, Math.max(floor, weighted));
  for (const k of SERVICE_CATS) serviceRatios[k] = Math.round(serviceRatios[k] * 1000) / 1000;

  // итоговая прибыль строго по игре: raw·happiness·policyGlobalIncome, и ПОВЕРХ — гильдийский
  // income_boost (сверено: getTotalProfitPerHour=(...)×(1+cityIncomeBoost), applyIncomeBoost=
  // y=>y×(1+income_boost) — тот же порядок, что "Доход города→Политики→[Разнообразие]→Гильдия" в UI)
  const profitFinal = profit * happiness * m.globalIncomeMult * (1 + m.incomeBoost) * (1 + m.diversityIncomeBoost);

  let buildCost = 0, upgradeCost = 0;
  const famCount = new Map<string, number>();
  for (const b of list) {
    const o = map.get(b.id); if (!o) continue;
    const lvl = Number(b.level || 1); if (lvl < 1) continue;
    const fam = familyId(b.id);
    const k = famCount.get(fam) || 0;
    buildCost += Math.round((o.base_price || 0) * Math.pow(o.base_price_factor ?? 1, k)) * m.buildCostMult;
    famCount.set(fam, k + 1);
    upgradeCost += upgradeCostTo(o, lvl) * m.upgradeCostMult;
  }
  buildCost = Math.round(buildCost);
  upgradeCost = Math.round(upgradeCost);

  return {
    count: list.length,
    population: Math.round(population),
    profit: Math.round(profit),
    profitFinal: Math.round(profitFinal),
    coverageByCat,
    serviceRatios,
    happiness: Math.round(happiness * 1000) / 1000,
    buildCost,
    upgradeCost,
    totalCost: buildCost + upgradeCost,
  };
}
