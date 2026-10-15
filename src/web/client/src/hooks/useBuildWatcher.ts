import { useSyncExternalStore } from 'react';
import { api, type UpdateStage } from '../api';

// Следит, какой процесс бота отвечает панели (GET /api/build — без GitHub, дёшево). Когда бот
// перезапустился (другое startedAt или коммит) — перезагружаем страницу, на какой бы ни был
// пользователь: у новой версии свой фронт. Пока идёт обновление (обновлятель занят), опрос частый,
// а в update приходит этап и прогресс скачивания образа (полоса в плашке версии).
type BuildState = { busy: boolean; startedAt: number | null; update: UpdateStage | null };

let state: BuildState = { busy: false, startedAt: null, update: null };
// после нажатия «Обновить» обновлятель подхватывает заявку не сразу — до этого опрашиваем часто
let fastUntil = 0;
let base: { startedAt: number; commit: string | null } | null = null;
let timer: number | null = null;
let started = false;
const subs = new Set<() => void>();

const set = (next: BuildState) => {
  if (next.busy === state.busy && next.startedAt === state.startedAt && JSON.stringify(next.update) === JSON.stringify(state.update)) return;
  state = next; subs.forEach(f => f());
};

const schedule = () => {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(check, state.busy || Date.now() < fastUntil ? 1500 : 30000);
};

export async function check() {
  try {
    const d = await api.build();
    if (d && d.ok && d.startedAt) {
      if (!base) base = { startedAt: d.startedAt, commit: d.commit };
      else if (d.startedAt !== base.startedAt || (d.commit && d.commit !== base.commit)) { window.location.reload(); return; }
      // бот уже перезапускается и не отвечает — остаётся последний известный этап
      set({ busy: !!d.busy, startedAt: d.startedAt, update: d.busy ? d.update ?? null : null });
    }
  } catch { /* бот перезапускается или нет связи — проверим позже */ }
  schedule();
}

// обновление только что запрошено из панели: чаще опрашиваем, пока обновлятель не взял заявку
export function watchUpdate() {
  fastUntil = Date.now() + 60 * 1000;
  check();
}

// запуск один раз на всё приложение (App)
export function startBuildWatcher() {
  if (started) return;
  started = true;
  check();
  // вернулись на вкладку (телефон, свёрнутый браузер) — проверяем сразу, не дожидаясь таймера
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

export function useBuildState(): BuildState {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
}
