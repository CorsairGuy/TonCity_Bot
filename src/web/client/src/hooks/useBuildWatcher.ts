import { useSyncExternalStore } from 'react';
import { api, type UpdateStage } from '../api';
import { onServerEvent } from '../serverEvents';

// Следит, какой процесс бота отвечает панели. Бот сам шлёт событие build (serverEvents.ts): при
// подключении, при каждом изменении хода обновления (обновлятель занят, этап, прогресс скачивания
// образа для полосы в плашке версии) и после перезапуска — когда поток переподключится к новому
// процессу. Другое startedAt или коммит — перезагружаем страницу, на какой бы ни был пользователь:
// у новой версии свой фронт. Опроса нет; разовая сверка — только при возврате на вкладку.
type BuildState = { busy: boolean; startedAt: number | null; update: UpdateStage | null };
type BuildEvent = { commit: string | null; startedAt: number; busy: boolean; update?: UpdateStage | null };

let state: BuildState = { busy: false, startedAt: null, update: null };
let base: { startedAt: number; commit: string | null } | null = null;
let started = false;
const subs = new Set<() => void>();

const set = (next: BuildState) => {
  if (next.busy === state.busy && next.startedAt === state.startedAt && JSON.stringify(next.update) === JSON.stringify(state.update)) return;
  state = next; subs.forEach(f => f());
};

function apply(d: BuildEvent) {
  if (!d || !d.startedAt) return;
  if (!base) base = { startedAt: d.startedAt, commit: d.commit };
  else if (d.startedAt !== base.startedAt || (d.commit && d.commit !== base.commit)) { window.location.reload(); return; }
  // бот уже перезапускается и не отвечает — остаётся последний известный этап
  set({ busy: !!d.busy, startedAt: d.startedAt, update: d.busy ? d.update ?? null : null });
}

export async function check() {
  try { const d = await api.build(); if (d && d.ok) apply(d); }
  catch { /* бот перезапускается или нет связи — событие придёт, когда поток переподключится */ }
}

// запуск один раз на всё приложение (App)
export function startBuildWatcher() {
  if (started) return;
  started = true;
  onServerEvent<BuildEvent>('build', apply);
  // вернулись на вкладку (телефон, свёрнутый браузер мог оборвать поток) — сверяемся сразу
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

export function useBuildState(): BuildState {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
}
