'use strict';
// Планы города построчно: цели улучшений, ручная очередь, запланированные реконструкции.
// Строка = клетка (account,x,y), а не JSON-блоб на весь список, как было в city_strategy.
//
// Зачем переписано (19.08.2026): блоб переписывался ЦЕЛИКОМ на каждое действие. Пока на
// city_strategy стоял UNIQUE(account) — это работало, но было хрупко: одно сохранение всегда
// перезаписывало весь список, а параллельная запись бота и панели могла потерять чужие правки.
// На базе без UNIQUE (любая новая установка — ключ не создавался, см. ensureUpsertKeys) upsert
// вырождался в INSERT частичной строки, и планы пропадали целиком.
//
// Здесь нет ни одного upsert: сохранение — это ЯВНЫЙ diff (что удалить, что добавить, что
// поменять). Поэтому слой корректен даже на базе, где UNIQUE по какой-то причине не появился;
// сам ключ остаётся вторым рубежом и объявлен в UPSERT_KEYS.
//
// Блобы city_strategy.targets/queue/reconstruct_plan НЕ удаляются и больше не пишутся — это
// снимок на момент переноса и путь отката на старую версию кода.

const MARK = 'city_plans_rows_v1';       // отметка одноразового переноса блобов, таблица schema_marks

// db/index требует этот модуль внутри init() — тянем его лениво, чтобы не замкнуть require
function db() { return require('./index'); }
const key = (x, y) => `${Number(x)},${Number(y)}`;
const num = v => (v == null ? null : Number(v));

// ── чтение ───────────────────────────────────────────────────────────────────────────────────
// Форма ответа намеренно совпадает со старой (targets/queue/reconstructPlan из блобов) — ни
// фронтенд, ни расчёты в progress.js менять не пришлось.
async function loadPlans(account) {
  const { CityUpgradeTarget, CityUpgradeQueue, CityReconstructPlan } = db();
  const [t, q, r] = await Promise.all([
    CityUpgradeTarget.findAll({ where: { account }, order: [['id', 'ASC']], raw: true }),
    CityUpgradeQueue.findAll({ where: { account }, order: [['pos', 'ASC'], ['id', 'ASC']], raw: true }),
    CityReconstructPlan.findAll({ where: { account }, order: [['id', 'ASC']], raw: true }),
  ]);
  return {
    targets: t.map(v => ({ x: num(v.x), y: num(v.y), target_level: Number(v.target_level) || 0 })),
    queue: q.map(v => ({ x: num(v.x), y: num(v.y) })),
    reconstructPlan: r.map(v => ({ x: num(v.x), y: num(v.y) })),
  };
}

// ── сохранение списка целиком (панель присылает весь список) ────────────────────────────────
// Не «удалить всё и вставить заново», а diff: неизменные клетки не трогаем вообще, поэтому
// параллельная точечная правка (бот вычёркивает выполненную позицию) не конфликтует с сохранением.
async function replaceAll(Model, account, wanted, sameFn, patchFn) {
  const { seq } = db();
  await seq.transaction(async tx => {
    const rows = await Model.findAll({ where: { account }, order: [['id', 'ASC']], transaction: tx });
    const seen = new Set(), drop = [];
    for (const row of rows) {
      const k = key(row.x, row.y), want = wanted.get(k);
      if (!want || seen.has(k)) { drop.push(row.id); continue; }  // клетки больше нет в плане (или это дубль от старой схемы)
      seen.add(k);
      if (!sameFn(row, want)) await row.update({ ...patchFn(want), updated_at: new Date() }, { transaction: tx });
    }
    if (drop.length) await Model.destroy({ where: { id: drop }, transaction: tx });
    const add = [];
    for (const [k, want] of wanted) if (!seen.has(k)) add.push({ account, x: want.x, y: want.y, ...patchFn(want), updated_at: new Date() });
    if (add.length) await Model.bulkCreate(add, { transaction: tx });
  });
}

async function saveTargets(account, list) {
  const wanted = new Map();
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || t.x == null || t.y == null) continue;
    const lvl = Math.floor(Number(t.target_level) || 0);
    if (lvl <= 0) continue;
    wanted.set(key(t.x, t.y), { x: Number(t.x), y: Number(t.y), target_level: lvl });
  }
  await replaceAll(db().CityUpgradeTarget, account, wanted,
    (row, w) => Number(row.target_level) === w.target_level, w => ({ target_level: w.target_level }));
}

// Очередь — ЕДИНСТВЕННЫЙ план, где одна и та же клетка может встречаться несколько раз подряд:
// так задаётся серия последовательных апгрейдов одного здания (1→2, 2→3, ...). Поэтому строка тут
// опознаётся по МЕСТУ в очереди (account,pos), а не по клетке, и дубли клеток НЕ схлопываются.
async function saveQueue(account, list) {
  const { seq, CityUpgradeQueue } = db();
  const wanted = [];
  for (const q of Array.isArray(list) ? list : []) {
    if (!q || q.x == null || q.y == null) continue;
    wanted.push({ x: Number(q.x), y: Number(q.y), pos: wanted.length });
  }
  await seq.transaction(async tx => {
    const rows = await CityUpgradeQueue.findAll({ where: { account }, order: [['pos', 'ASC'], ['id', 'ASC']], transaction: tx });
    const byPos = new Map();
    const drop = [];
    for (const row of rows) {
      const p = Number(row.pos);
      if (byPos.has(p)) { drop.push(row.id); continue; }   // подстраховка от дублей позиции
      byPos.set(p, row);
    }
    for (const w of wanted) {
      const row = byPos.get(w.pos);
      if (!row) continue;
      byPos.delete(w.pos);
      if (Number(row.x) !== w.x || Number(row.y) !== w.y) await row.update({ x: w.x, y: w.y, updated_at: new Date() }, { transaction: tx });
    }
    for (const row of byPos.values()) drop.push(row.id);   // очередь стала короче — хвост убираем
    if (drop.length) await CityUpgradeQueue.destroy({ where: { id: drop }, transaction: tx });
    const have = new Set(rows.filter(r => !drop.includes(r.id)).map(r => Number(r.pos)));
    const add = wanted.filter(w => !have.has(w.pos)).map(w => ({ account, ...w, updated_at: new Date() }));
    if (add.length) await CityUpgradeQueue.bulkCreate(add, { transaction: tx });
  });
}

async function saveReconstruct(account, list) {
  const wanted = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || p.x == null || p.y == null) continue;
    wanted.set(key(p.x, p.y), { x: Number(p.x), y: Number(p.y) });
  }
  await replaceAll(db().CityReconstructPlan, account, wanted, () => true, () => ({}));
}

// ── точечные операции (то, ради чего всё и затевалось) ───────────────────────────────────────
// Выполненная реконструкция/улучшение вычёркивает СВОЮ строку и не трогает остальные — раньше
// ради этого перезаписывался весь список, и правки пользователя, сделанные в этот момент, терялись.
async function removeCells(Model, account, cells) {
  const list = (Array.isArray(cells) ? cells : []).filter(c => c && c.x != null && c.y != null);
  if (!list.length) return 0;
  const { Op } = require('sequelize');
  return Model.destroy({
    where: { account, [Op.or]: list.map(c => ({ x: Number(c.x), y: Number(c.y) })) },
  });
}
const removeReconstruct = (account, cells) => removeCells(db().CityReconstructPlan, account, cells);
const removeTargets = (account, cells) => removeCells(db().CityUpgradeTarget, account, cells);

// В очереди одна клетка может стоять несколько раз (серия апгрейдов), поэтому выполненный апгрейд
// вычёркивает РОВНО ОДНО вхождение — самое раннее по pos, а не все сразу.
async function removeQueue(account, cells) {
  const { seq, CityUpgradeQueue } = db();
  const list = (Array.isArray(cells) ? cells : []).filter(c => c && c.x != null && c.y != null);
  if (!list.length) return 0;
  let removed = 0;
  await seq.transaction(async tx => {
    const rows = await CityUpgradeQueue.findAll({ where: { account }, order: [['pos', 'ASC'], ['id', 'ASC']], transaction: tx });
    const used = new Set();
    for (const c of list) {
      const hit = rows.find(r => !used.has(r.id) && Number(r.x) === Number(c.x) && Number(r.y) === Number(c.y));
      if (hit) used.add(hit.id);
    }
    if (used.size) removed = await CityUpgradeQueue.destroy({ where: { id: [...used] }, transaction: tx });
  });
  return removed;
}

// Перемещение здания: цель/очередь/план реконструкции привязаны к клетке, поэтому переезжают
// вместе со зданием — иначе указывали бы в пустоту. Если на клетке назначения уже что-то было,
// оно перетирается (здание там теперь только одно).
async function moveCell(account, from, to) {
  const { seq, CityUpgradeTarget, CityUpgradeQueue, CityReconstructPlan } = db();
  const fx = Number(from.x), fy = Number(from.y), tx2 = Number(to.x), ty = Number(to.y);
  let moved = 0;
  await seq.transaction(async tx => {
    for (const Model of [CityUpgradeTarget, CityReconstructPlan]) {
      const row = await Model.findOne({ where: { account, x: fx, y: fy }, transaction: tx });
      if (!row) continue;
      await Model.destroy({ where: { account, x: tx2, y: ty }, transaction: tx });
      await row.update({ x: tx2, y: ty, updated_at: new Date() }, { transaction: tx });
      moved++;
    }
    // очередь: у клетки может быть несколько вхождений — переезжают ВСЕ, порядок сохраняется
    const qRows = await CityUpgradeQueue.findAll({ where: { account, x: fx, y: fy }, transaction: tx });
    for (const row of qRows) { await row.update({ x: tx2, y: ty, updated_at: new Date() }, { transaction: tx }); moved++; }
  });
  return moved;
}

// ── одноразовый перенос старых блобов ────────────────────────────────────────────────────────
// Идёт ровно один раз (отметка в schema_marks). Без отметки пустой план после переноса выглядел
// бы как «ещё не переносили», и старый блоб воскрешал бы удалённые пользователем цели.
async function migrateFromBlobs() {
  const { CityStrategy, SchemaMark } = db();
  const logger = require('../utils/logger');
  if (await SchemaMark.findOne({ where: { name: MARK } })) return 0;

  const parse = v => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
  // ASC + перезапись непустым: если дубли строк по account всё же остались, побеждает более поздняя
  // непустая колонка — ровно то, что видел пользователь в панели (та читала строку с наибольшим id)
  const rows = await CityStrategy.findAll({ order: [['id', 'ASC']], raw: true });
  const byAccount = new Map();
  for (const r of rows) {
    if (!r.account) continue;
    const cur = byAccount.get(r.account) || { targets: [], queue: [], reconstructPlan: [] };
    const t = parse(r.targets), q = parse(r.queue), p = parse(r.reconstruct_plan);
    if (t.length) cur.targets = t;
    if (q.length) cur.queue = q;
    if (p.length) cur.reconstructPlan = p;
    byAccount.set(r.account, cur);
  }

  let accounts = 0, cells = 0;
  for (const [account, plans] of byAccount) {
    const existing = await loadPlans(account);
    // если по этому аккаунту в новых таблицах уже что-то есть — не трогаем, это уже актуальные данные
    if (plans.targets.length && !existing.targets.length) { await saveTargets(account, plans.targets); cells += plans.targets.length; }
    if (plans.queue.length && !existing.queue.length) { await saveQueue(account, plans.queue); cells += plans.queue.length; }
    if (plans.reconstructPlan.length && !existing.reconstructPlan.length) { await saveReconstruct(account, plans.reconstructPlan); cells += plans.reconstructPlan.length; }
    accounts++;
  }
  await SchemaMark.create({ name: MARK, done_at: new Date() });
  if (cells) logger.info(`[db] планы города перенесены в построчные таблицы: аккаунтов ${accounts}, клеток ${cells}`);
  return cells;
}

module.exports = {
  loadPlans, saveTargets, saveQueue, saveReconstruct,
  removeReconstruct, removeQueue, removeTargets, moveCell, migrateFromBlobs, MARK,
};
