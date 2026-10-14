'use strict';
// Генератор оптимальных референсов города по фазам.
// Показатели города (население/прибыль/счастье/покрытие) в игре зависят ТОЛЬКО от
// набора {здание, уровень} и не зависят от расположения на карте — поэтому задача
// сводится к подбору мультимножества зданий на доступные (разблокированные) клетки.
//
// Логика:
//  1. По фазе выбираем набор разблокированных секций (дешёвые — раньше) → список клеток.
//  2. Доступные здания = те, чья фаза открытия ≤ текущей.
//  3. Полностью покрываем население тремя основными сервисами (больница/полиция/пожарные)
//     → счастье ≥ 0.9; добавляем немного парков → ближе к 1.0.
//  4. Остальные клетки делим между жильём (население) и коммерцией (прибыль),
//     раскидывая по нескольким типам зданий (разнообразие → бонус к airdrop-диверсити).
const fs = require('fs'), path = require('path');
const { computeCityStats, buildingsMap, popAtLevel, profitAtLevel, coverageAtLevel,
        upgradeCostTo, buildPriceAt, familyId } = require('./cityStats');

function cfg(f) { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', f), 'utf8')); }

// Ключ стоимости разблокировки: бесплатные → первыми, затем монетные по цене,
// кристальные — в самый конец (бот сам их не разблокирует).
function sectionCostKey(s) {
  const c = s.unlockCost || {};
  if (s.defaultUnlocked) return -1;
  if (c.coins != null) return c.coins;
  if (c.crystals != null) return 1e12 + c.crystals * 1e6;
  return 0;
}

// Целевое число клеток по фазам. Секции разблокируются ботом по смежности за монеты
// по мере накопления, поэтому уже на ранних фазах включаем ДЕШЁВЫЕ смежные секции —
// бот расширяет город сразу, а не ждёт перехода на следующую фазу.
//   ph0 = default(13)+20+200+1K+5K = 47 клеток; далее к монетной сети (111);
//   кристальные +30 клеток — только эндгейм (ручная разблокировка).
const CELL_BUDGET = { 0: 47, 1: 55, 2: 75, 3: 85, 4: 102, 5: 111, 6: 141 };
// Целевой уровень продуктивных зданий (жильё/коммерция) и сервисов по фазам.
const PROD_LVL = { 0: 3, 1: 4, 2: 5, 3: 6, 4: 6, 5: 7, 6: 10 };
const SVC_LVL  = { 0: 4, 1: 6, 2: 8, 3: 9, 4: 10, 5: 11, 6: 12 };
const CATS = ['hospital', 'police-station', 'fire-station', 'park'];

// Связное расширение зоны города по смежности — ровно как бот в progress.js:
// добавляем только секцию, смежную с уже открытой, выбирая самую дешёвую.
function sectionsForPhase(phase) {
  const secs = cfg('city_sections.json');
  const budget = CELL_BUDGET[phase] ?? 141;
  const allowCrystal = phase >= 6; // кристальные секции — только эндгейм (ручная разблокировка)
  const open = new Set(secs.filter(s => s.defaultUnlocked).map(s => s.id));
  const chosen = secs.filter(s => s.defaultUnlocked);
  let cells = chosen.reduce((n, s) => n + s.coordinates.length, 0);
  while (cells < budget) {
    const cand = secs.filter(s =>
      !open.has(s.id) &&
      s.adjacentSections.some(a => open.has(a)) &&                    // смежность с открытой зоной
      (allowCrystal || !(s.unlockCost && s.unlockCost.crystals)));    // монетные (иначе бот не откроет)
    if (!cand.length) break;
    cand.sort((a, b) => sectionCostKey(a) - sectionCostKey(b));
    const pick = cand[0];
    open.add(pick.id); chosen.push(pick); cells += pick.coordinates.length;
  }
  return chosen;
}

function buildingsAtPhase(phase) {
  const phMap = cfg('city-building-phases.json');
  return [...buildingsMap().values()].filter(b =>
    phMap[b.id] != null && phMap[b.id] <= phase && !/_\d+_star\.png$/i.test(b.id) && b.category !== 'special');
}

// Полная цена одного здания type на уровне level, если в семействе уже построено k:
// накопительная цена постройки (base_price·factor^k) + цена улучшений до level.
function buildingCost(info, level, k) {
  return buildPriceAt(info, k) + upgradeCostTo(info, level);
}

// Стоимостно-оптимальный план сервиса: покрыть население pop зданиями info.
// Перебираем уровень L: количество k = ceil(pop/coverage(L)); суммарную цену считаем
// с накопительным множителем factor^i. Выбираем минимальную цену. Меньше зданий на
// более высоком уровне почти всегда дешевле (factor^k растёт быстрее, чем e^0.5·L).
// Заполнение сервиса в БЮДЖЕТЕ клеток maxCells: берём МИНИМАЛЬНЫЙ уровень, который
// полностью покрывает население минимальным числом зданий (экономит монеты). Если
// даже L19 не хватает — заполняем весь бюджет на L19 (частичное покрытие). Так и число
// клеток под сервис, и цена ограничены. Возвращает число занятых клеток.
function serviceFill(info, pop, maxCells, level0, list) {
  if (pop <= 0 || maxCells <= 0) return 0;
  for (let L = Math.max(1, level0); L <= 19; L++) {
    const cov = coverageAtLevel(info, L);
    if (cov <= 0) continue;
    const k = Math.ceil(pop / cov);
    if (k <= maxCells) { for (let i = 0; i < k; i++) list.push({ id: info.id, level: L }); return k; }
  }
  for (let i = 0; i < maxCells; i++) list.push({ id: info.id, level: 19 });
  return maxCells;
}

// Предел числа зданий семейства: накопительный множитель цены factor^k не должен
// превышать FACTOR_CAP (иначе очередная копия слишком дорогая). Семейства с factor≈1
// не ограничиваем. Это и есть «учёт накопительной цены»: дорогие семейства сами
// выпадают из подбора, показатели при этом остаются первичными.
const FACTOR_CAP = 1000;
function famLimit(info) {
  const f = info.base_price_factor ?? 1;
  if (f <= 1.0001) return Infinity;
  return Math.max(1, Math.floor(Math.log(FACTOR_CAP) / Math.log(f)) + 1);
}

// Жадное заполнение n клеток из pool: на каждой клетке среди семейств, не достигших
// предела, берём максимум показателя valueFn. Если все исчерпаны — лучшее по
// эффективности (value/цена) как запас. famCount мутируется (общий по всем категориям).
function greedyFill(n, pool, level, valueFn, famCount) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let best = null, bestVal = -Infinity, fb = null, fbEff = -Infinity;
    for (const info of pool) {
      const k = famCount.get(familyId(info.id)) || 0;
      const val = valueFn(info);
      if (k < famLimit(info)) { if (val > bestVal) { bestVal = val; best = info; } }
      const eff = val / Math.max(1, buildingCost(info, level, k));
      if (eff > fbEff) { fbEff = eff; fb = info; }
    }
    const pick = best || fb;
    if (!pick) break;
    const fam = familyId(pick.id);
    famCount.set(fam, (famCount.get(fam) || 0) + 1);
    out.push({ id: pick.id, level });
  }
  return out;
}

// Основной генератор: возвращает {unlockedSections, buildings, stats}.
function generateCityRefplan(phase) {
  const secs = sectionsForPhase(phase);
  const unlockedSections = secs.map(s => s.id);
  const cells = [];
  for (const s of secs) for (const c of s.coordinates) cells.push(c);
  const N = cells.length;

  const avail = buildingsAtPhase(phase);
  const plvl = PROD_LVL[phase] ?? 6;
  const meta = cfg('phases.json').find(p => Number(p.phase) === Number(phase)) || { popThreshold: 0, profitThreshold: 0 };

  const svc = {};
  for (const c of CATS) {
    const opts = avail.filter(b => b.category === 'service' && b.service_category === c);
    if (opts.length) { opts.sort((a, b) => (b.service_coverage || 0) - (a.service_coverage || 0)); svc[c] = opts[0]; }
  }
  const main = ['hospital', 'police-station', 'fire-station'].filter(c => svc[c]);
  const resTypes = avail.filter(b => b.category === 'residential');
  const comTypes = avail.filter(b => b.category === 'commercial');
  if (!resTypes.length) return { unlockedSections, buildings: [], stats: computeCityStats([]) };

  const slvl = SVC_LVL[phase] ?? 8;
  const svcBudget = Math.max(1, Math.round(N * 0.08)); // клеток на каждый основной сервис
  const parkBudget = svc['park'] ? Math.max(1, Math.round(N * 0.05)) : 0;
  // Собрать раскладку для заданного числа жилых клеток resCells (жильё на уровне resLvl).
  // Сервисы — в фиксированном бюджете клеток, минимальным уровнем покрывают население;
  // остаток — коммерция. Всё продуктивное — жадный подбор с лимитом на семейство.
  function layout(resLvl, resCells) {
    const famCount = new Map();
    // жильё: максимум населения среди семейств, не достигших предела по цене
    const resList = greedyFill(resCells, resTypes, resLvl, info => popAtLevel(info, resLvl), famCount);
    let pop = 0;
    for (const b of resList) pop += popAtLevel(buildingsMap().get(b.id), resLvl);
    const list = resList.slice();
    let used = resCells;
    for (const c of main) used += serviceFill(svc[c], pop, Math.min(svcBudget, N - used), slvl, list);
    if (svc['park']) used += serviceFill(svc['park'], pop, Math.min(parkBudget, N - used), slvl, list);
    const comCells = N - used;
    if (comCells < 0) return null;
    // коммерция: максимум прибыли среди семейств, не достигших предела (urban_vitality учитывает pop)
    const comPool = comTypes.length ? comTypes : resTypes;
    list.push(...greedyFill(comCells, comPool, plvl, info => profitAtLevel(info, plvl, pop) || popAtLevel(info, plvl), famCount));
    return list;
  }

  // Перебор (уровень жилья × число жилых клеток). Цель: макс. прибыль при населении ≥
  // порога фазы; счастье — множитель к прибыли (низкое счастье штрафует).
  let best = null, bestScore = -Infinity;
  const maxRes = Math.max(1, Math.floor(N * 0.55));
  for (let resLvl = plvl; resLvl >= 1; resLvl--) {
    for (let resCells = 1; resCells <= maxRes; resCells++) {
      const list = layout(resLvl, resCells);
      if (!list) break;
      const st = computeCityStats(list);
      const meetsPop = st.population >= meta.popThreshold ? 1 : 0;
      const score = meetsPop * 1e30 + st.profit * (0.5 + 0.5 * st.happiness) + st.population * 1e-3;
      if (score > bestScore) { bestScore = score; best = list; }
    }
  }
  const list = best || [];
  const placed = list.slice(0, N).map((b, i) => ({ x: cells[i].x, y: cells[i].y, id: b.id, level: b.level }));
  return { unlockedSections, buildings: placed, stats: computeCityStats(placed) };
}

module.exports = { generateCityRefplan, sectionsForPhase, CELL_BUDGET };
