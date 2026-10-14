'use strict';
// Расчёт показателей референса города строго по формулам игры TON City.
// Формулы сверены с бандлом game.toncity.io (класс городского здания):
//   profit (residential):  n===1 ? base_profit : base_profit/1.6 * ln(4n+1)
//   profit (commercial):   normal → base·n^1.3 ; star → base·n^1.1
//                          urban_vitality-здания: i = min(i, max(i·0.01, i·(pop/(urban_vitality_population·urbanVitalityMult))))
//   population (residential): normal → base·n^1.5 ; star → base·n^0.67 ; иначе 0
//   coverage (service):    star → cov·n^0.67 ; n===1 → cov ; n>=19 → cov·n^1.5 ; иначе cov·e^(0.24n) ; иначе 0
//   цена постройки:        base_price · base_price_factor^(уже_построено_в_семействе)  (семейство = id без _N_star)
//   цена улучшения s→s+1:  base_price · e^(0.5·s)
//   ИСКЛЮЧЕНИЯ: 13 конкретных ★2/★3 зданий считаются СВОИМИ формулами вместо общих star-формул выше
//   (объект "Ug" в бандле) — см. BUILDING_OVERRIDES ниже, проверяется ПЕРВЫМ для каждого показателя.
//   здание "в стройке" (b.end в будущем) даёт profit=0 и population=0, ПОКА не завершится — не
//   старый уровень, а именно ноль (сверено с бандлом: actualProfit/actualPopulation = isUnderConstruction?0:...)
const fs = require('fs'), path = require('path');

let _map = null;
function buildingsMap() {
  if (_map) return _map;
  const fp = path.join(process.cwd(), 'config', 'buildings.txt');
  const list = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : [];
  _map = new Map(list.map(b => [b.id, b]));
  return _map;
}

const isStar = info => info.star_lvl !== null && info.star_lvl !== undefined;
const familyId = id => id.replace(/_\d+_star\.png$/i, '.png');
// веса видов сервиса для счастья (из GET /buildings → factors)
const SERVICE_FACTORS = { 'fire-station': 0.3, 'police-station': 0.3, hospital: 0.3, park: 0.1 };
const SERVICE_CATS = ['hospital', 'police-station', 'fire-station', 'park'];

// точечные исключения формул для конкретных эволюционировавших (★2/★3) зданий — сверено с бандлом
// (объект "Ug": getProfitAtLevel/getPopulationAtLevel/getCoverage/getPriceForLevel у ВСЕХ городских
// зданий сначала проверяют Ug[id], и только если там нет нужного поля — падают на общую
// star/non-star формулу по показателю). Раньше в проекте был захардкожен только один такой случай
// (grand_arcanum_2_star) — в бандле их 13, у каждого СВОЙ набор изменённых показателей (не все три
// сразу) и часто СВОЯ цена улучшения, отличная и от общей, и от чужих исключений.
const BUILDING_OVERRIDES = {
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

function popAtLevel(info, n) {
  if (info.category !== 'residential') return 0;
  const base = info.base_population || 0;
  const ov = BUILDING_OVERRIDES[info.id];
  if (ov?.population) return ov.population(base, n);
  return isStar(info) ? base * Math.pow(n, 0.67) : base * Math.pow(n, 1.5);
}

// cityPop нужен только для commercial-зданий с urban_vitality_population; urbanVitalityMult —
// множитель порога от политики "urban_vitality_requirement" (сверено с бандлом:
// getProfitAtLevel(n,cityPop,urbanVitalityMult=1) → l=urban_vitality_population·urbanVitalityMult)
function profitAtLevel(info, n, cityPop, urbanVitalityMult = 1) {
  const ov = BUILDING_OVERRIDES[info.id];
  if (info.category === 'residential') {
    const bp = info.base_profit || 0;
    if (ov?.profit) return ov.profit(bp, n); // исключение НЕ имеет частного случая n===1, в отличие от общей формулы
    return n === 1 ? bp : (bp / 1.6) * Math.log(4 * n + 1);
  }
  if (info.category === 'commercial') {
    const bp = info.base_profit || 0;
    let i = ov?.profit ? ov.profit(bp, n) : (isStar(info) ? bp * Math.pow(n, 1.1) : bp * Math.pow(n, 1.3));
    if (info.urban_vitality_population != null) {
      const uv = info.urban_vitality_population * urbanVitalityMult;
      const o = Math.max(i * 0.01, i * ((cityPop || 0) / uv));
      i = Math.min(i, o);
    }
    return i;
  }
  return 0; // service / special
}

function coverageAtLevel(info, n) {
  if (info.category !== 'service') return 0;
  const cov = info.service_coverage || 0;
  const ov = BUILDING_OVERRIDES[info.id];
  if (ov?.coverage) return ov.coverage(cov, n);
  if (isStar(info)) return cov * Math.pow(n, 0.67);
  if (n === 1) return cov;
  if (n >= 19) return cov * Math.pow(n, 1.5);
  return cov * Math.exp(0.24 * n);
}

// цена улучшения с уровня s на s+1 (нетто, без скидки гильдии/политик)
function upgradeStep(info, s) {
  const base = info.base_price || 0;
  const ov = BUILDING_OVERRIDES[info.id];
  if (ov?.upgradePrice) return ov.upgradePrice(base, s);
  return base * Math.exp(0.5 * s);
}
// суммарная цена улучшения здания с уровня 1 до target
function upgradeCostTo(info, target) {
  let sum = 0;
  for (let s = 1; s < target; s++) sum += upgradeStep(info, s);
  return sum;
}

// время улучшения с уровня s на s+1, в секундах — сверено с бандлом game.toncity.io
// (getBaseUpgradeDuration городского здания): длительность растёт вдвое с каждым уровнем от
// construction_increment (тот же множитель для всех городских зданий), с потолком 24ч
const UPGRADE_TIME_CAP_SEC = 86400;
function upgradeDuration(info, s) {
  const inc = info.construction_increment || 0;
  if (!inc) return 0;
  const capLevel = Math.floor(Math.log2(UPGRADE_TIME_CAP_SEC / inc)) + 2;
  return s > capLevel ? UPGRADE_TIME_CAP_SEC : inc * Math.pow(2, s - 2);
}

// реальное время улучшения с учётом гильдийского бонуса/политики/активного ускорителя — сверено с
// бандлом (qp.getUpgradeDuration городского здания, НЕ путать с одноимённым методом у столичных
// зданий, у которых бонусов вообще нет): база (upgradeDuration выше) сначала домножается на
// (1-reducedUpgradeTimes) — гильдийский бонус "Сокращение времени улучшений" (по факту дают
// столичные здания, отсюда "бонус от столицы"), затем на constructionTimeMultiplier (эффект
// надетых политик, stat "construction_time"). Если сейчас активен ускоритель — время делится на его
// множитель ЦЕЛИКОМ, если ускорителя хватает на всю стройку (endsAt после расчётного финиша), либо
// расщепляется на "ускоренный" + "обычный" отрезок, если он истечёт раньше (см. formula ниже —
// 1:1 математика из бандла, только в секундах вместо Luxon Duration).
function effectiveUpgradeDuration(info, s, mods, startMs = Date.now()) {
  let a = upgradeDuration(info, s);
  if (mods?.reducedUpgradeTimes) a *= (1 - mods.reducedUpgradeTimes);
  if (mods?.constructionTimeMultiplier && mods.constructionTimeMultiplier !== 1) a *= mods.constructionTimeMultiplier;
  const booster = mods?.booster;
  if (!booster?.multiplier || booster.multiplier === 1 || !booster.endsAt) return a;
  const h = booster.multiplier;
  const finishIfFullyBoostedMs = startMs + (a * 1000) / h;
  if (booster.endsAt >= finishIfFullyBoostedMs) return a / h;
  const boostedSec = Math.max(0, (booster.endsAt - startMs) / 1000);
  const remainingSec = Math.max(0, a - boostedSec * h);
  return boostedSec + remainingSec;
}

// mods — необязательные живые модификаторы от гильдии/политик/разнообразия аккаунта (см.
// reference_game_formulas.md, раздел "Модификаторы дохода/населения/счастья"). Без mods (или с
// нейтральными значениями по умолчанию) функция считает "голую" формулу — так работали референсы
// города и раньше, обратная совместимость не нарушена. Источник данных для mods — живые
// /guilds/benefits, /policies/cabinet и /progress/diversity, см. CityMap.tsx buildCityStatsMods.
//   incomeBoost           — гильдия: benefits.income_boost, множитель ×(1+x)
//   diversityIncomeBoost  — "Разнообразие": GET /progress/diversity → income_bonus, множитель ×(1+x), ПОСЛЕДНИЙ по порядку
//   globalIncomeMult      — policyMultiplier("global_income")
//   categoryIncomeMult(cat) — policyMultiplier("category_income","building_category",cat)
//   buildingTypeIncomeMult(id) — policyMultiplier("building_type_income","building_type",id)
//   populationMult        — policyMultiplier("population")
//   serviceCoverageMult(cat) — policyMultiplier("service_category_coverage","service_category",cat) × policyMultiplier("total_coverage")
//   urbanVitalityMult     — max(.01, policyMultiplier("urban_vitality_requirement"))
//   happinessFloorDelta   — min(.75, policyAddend("happiness_floor")/100)
//   happinessCeilingDelta — policyAddend("happiness_ceiling")/100
//   buildCostMult/upgradeCostMult — как в actualBasePrice/nextLevelPrice бандла (Gc().buildCostMultiplier/upgradeCostMultiplier)
const NEUTRAL_MODS = {
  incomeBoost: 0, diversityIncomeBoost: 0, globalIncomeMult: 1,
  categoryIncomeMult: () => 1, buildingTypeIncomeMult: () => 1,
  populationMult: 1, serviceCoverageMult: () => 1,
  urbanVitalityMult: 1, happinessFloorDelta: 0, happinessCeilingDelta: 0,
  buildCostMult: 1, upgradeCostMult: 1,
};

// buildings: [{id, level, ...}]
function computeCityStats(buildings, map = buildingsMap(), mods = NEUTRAL_MODS) {
  const m = { ...NEUTRAL_MODS, ...mods };
  const list = Array.isArray(buildings) ? buildings : [];

  // здание "в стройке" (сверено с бандлом игры: getter isUnderConstruction = constructionEnd!==null
  // && now<constructionEnd) даёт actualProfit=0 и actualPopulation=0, ПОКА строится — не старый
  // уровень, а именно ноль. current.end — то же самое поле, что constructionEnd в игре (см.
  // modules/progress.js: "start"/"end" из живого /progress/ без изменений).
  const now = Date.now();
  const isUnderConstruction = b => !!(b.end && new Date(b.end).getTime() > now);

  // 1) население — не зависит от коммерции, считаем первым (нужно для urban_vitality). Множитель
  // политики "population" применяется здесь же — сверено с бандлом: getPopulation уже возвращает
  // population·populationMultiplier ВЕЗДЕ (включая happiness и urban_vitality), не только на экране.
  let rawPopulation = 0;
  for (const b of list) {
    const info = map.get(b.id); if (!info) continue;
    const lvl = Number(b.level || 1); if (lvl < 1 || isUnderConstruction(b)) continue;
    rawPopulation += popAtLevel(info, lvl);
  }
  const population = rawPopulation * m.populationMult;

  // 2) прибыль + покрытие (по категориям сервиса — НЕ суммируем между видами). category/building
  // type множители применяются НА ЗДАНИЕ, до суммирования (сверено с бандлом: T*=categoryIncomeMult
  // (k.category)*buildingTypeIncomeMult(k.id) внутри цикла по зданиям)
  let profit = 0;
  const coverageByCatRaw = { hospital: 0, 'police-station': 0, 'fire-station': 0, park: 0 };
  for (const b of list) {
    const info = map.get(b.id); if (!info) continue;
    const lvl = Number(b.level || 1); if (lvl < 1 || isUnderConstruction(b)) continue;
    let p = profitAtLevel(info, lvl, population, m.urbanVitalityMult);
    p *= m.categoryIncomeMult(info.category) * m.buildingTypeIncomeMult(info.id);
    profit += p;
    if (info.category === 'service' && info.service_category in coverageByCatRaw) {
      coverageByCatRaw[info.service_category] += coverageAtLevel(info, lvl);
    }
  }
  // ОТОБРАЖАЕМОЕ покрытие — СЫРАЯ сумма, БЕЗ serviceCoverageMult (сверено verbatim с бандлом: Map
  // "coverages", которую возвращает getHappiness/getEffectiveHappiness, копится из RAW T.coverage
  // — `_.set(cat,(_.get(cat)||0)+T.coverage)` — множитель туда НЕ попадает вообще, это отдельная
  // "жизнь" числа: multiplier участвует ТОЛЬКО во внутреннем расчёте happiness ниже, за отображаемое
  // число не отвечает. Раньше здесь домножали coverageByCat на serviceCoverageMult — это и давало
  // расхождение с игрой (10.5M вместо честных 12.5M при -16% policy debuff: 12.5×0.84≈10.5).
  const coverageByCat = {};
  for (const k of SERVICE_CATS) coverageByCat[k] = Math.round(coverageByCatRaw[k]);

  // 3) счастье строго по игре: для каждого вида сервиса min(покрытие/население, 1),
  //    взвешенно по factor (из /buildings). serviceRatios — насколько каждый вид покрывает
  //    население (1 = полностью), ЗДЕСЬ множитель применяется (сверено: O=v?A*serviceCoverageMultiplier
  //    (T):A, B=min(O/b*I,I) — используется ТОЛЬКО для доли/happiness, не для coverageByCat выше).
  //    floor/ceiling — базовая кривая по населению + дельты политик (сверено verbatim с бандлом:
  //    y=min(1,y+floorDelta); k=max(.01,min(1,1+ceilingDelta)); итог считается ОДНОЙ формулой для
  //    любого населения, включая 0 — при 0 населения x=0, и если ceiling-политика активна, happiness
  //    будет ПОТОЛКОМ, а не автоматической единицей)
  const serviceRatios = {};
  for (const k of SERVICE_CATS) {
    const adjusted = coverageByCatRaw[k] * m.serviceCoverageMult(k);
    serviceRatios[k] = population > 0 ? Math.min(adjusted / population, 1) : 1;
  }
  let floor;
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

  // 4) итоговая прибыль строго по игре: raw·happiness·policyGlobalIncome, и ПОВЕРХ — гильдийский
  // income_boost и бонус "Разнообразие" (/progress/diversity → income_bonus, найден 2026-07-17 через
  // Network в браузере — формулы в статическом бандле нет вообще; в проекте уже опрашивается в
  // modules/townhall.js на своём цикле и лежит в TownhallDiversity — cityStrategy.js читает
  // ОТТУДА, без единого живого запроса). Порядок множителей не важен (умножение коммутативно), но
  // соответствует порядку строк на экране игры: "Доход города→Политики→Разнообразие→Гильдия".
  const profitFinal = profit * happiness * m.globalIncomeMult * (1 + m.incomeBoost) * (1 + m.diversityIncomeBoost);

  // 5) стоимость: постройка (по семействам) + улучшения до целевых уровней — тоже домножаются на
  // политику (Gc().buildCostMultiplier/upgradeCostMultiplier), гильдийская скидка — уже включена в
  // buildCostMult/upgradeCostMult, если вызывающая сторона их так посчитала (см. CityMap.tsx)
  let buildCost = 0, upgradeCost = 0;
  const famCount = new Map();
  for (const b of list) {
    const info = map.get(b.id); if (!info) continue;
    const lvl = Number(b.level || 1); if (lvl < 1) continue;
    const fam = familyId(b.id);
    const k = famCount.get(fam) || 0;
    buildCost += Math.round((info.base_price || 0) * Math.pow(info.base_price_factor ?? 1, k)) * m.buildCostMult;
    famCount.set(fam, k + 1);
    upgradeCost += upgradeCostTo(info, lvl) * m.upgradeCostMult;
  }
  buildCost = Math.round(buildCost);
  upgradeCost = Math.round(upgradeCost);

  for (const k of SERVICE_CATS) serviceRatios[k] = Math.round(serviceRatios[k] * 1000) / 1000;

  return {
    count: list.length,
    population: Math.round(population),
    profit: Math.round(profit),        // "голая" база — без happiness/политик/гильдии (обратная совместимость)
    profitFinal: Math.round(profitFinal), // как в игре: raw·happiness·глобальные_политики·(1+гильдия), без "Разнообразия"
    coverageByCat,        // абсолютное покрытие по каждому виду (с учётом serviceCoverageMult)
    serviceRatios,        // доля покрытия населения по каждому виду (1 = полностью)
    happiness: Math.round(happiness * 1000) / 1000,
    buildCost,
    upgradeCost,
    totalCost: buildCost + upgradeCost,
  };
}

// цена постройки k-го здания семейства (0-индекс): base_price · factor^k
function buildPriceAt(info, k) {
  return Math.round((info.base_price || 0) * Math.pow(info.base_price_factor ?? 1, k));
}

module.exports = { computeCityStats, buildingsMap, popAtLevel, profitAtLevel, coverageAtLevel, upgradeCostTo, upgradeStep, upgradeDuration, effectiveUpgradeDuration, buildPriceAt, familyId };
