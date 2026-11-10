type Cell = { x: number; y: number };
const key = (c: Cell) => `${Number(c.x)},${Number(c.y)}`;
export const sameUpgradeQueue = (a: Cell[], b: Cell[]) => a.length === b.length && a.every((c, i) => key(c) === key(b[i]));
const counts = (rows: Cell[]) => { const m = new Map<string, number>(); for (const c of rows) m.set(key(c), (m.get(key(c)) ?? 0) + 1); return m; };

// Бот потребляет одно вхождение, а пользователь может в это время редактировать черновик.
// Применяем к нему только серверную разницу; не затираем добавления/перестановки целиком.
export function reconcileUpgradeQueue(local: Cell[], previous: Cell[], next: Cell[]): Cell[] {
  if (sameUpgradeQueue(local, previous)) return next;
  if (sameUpgradeQueue(previous, next)) return local;
  const before = counts(previous), after = counts(next), removed = new Map<string, number>(), added = new Map<string, number>();
  for (const [k, n] of before) if (n > (after.get(k) ?? 0)) removed.set(k, n - (after.get(k) ?? 0));
  for (const [k, n] of after) if (n > (before.get(k) ?? 0)) added.set(k, n - (before.get(k) ?? 0));
  const result = local.filter(c => { const k = key(c), n = removed.get(k) ?? 0; if (!n) return true; removed.set(k, n - 1); return false; });
  for (const c of next) { const k = key(c), n = added.get(k) ?? 0; if (n) { result.push(c); added.set(k, n - 1); } }
  return result;
}
