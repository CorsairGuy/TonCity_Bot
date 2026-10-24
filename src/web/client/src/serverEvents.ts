// События бота для панели (GET /api/events): новая версия, ход обновления, техработы игры. Проверяет
// и следит всё сам бот, вкладки только получают. Соединение одно на весь браузер — его держит общий
// SharedWorker (serverEvents.worker.ts), иначе несколько вкладок съели бы лимит браузера в
// 6 соединений на сайт и панель повисла бы. Где SharedWorker нет (Chrome на Android), вкладка
// подключается к потоку сама.
import { connect } from './serverEventsConnect';

// city — свежие постройки одного города {account,buildings} (общая карта всех городов); это разовое
// событие, а не состояние, поэтому последнее не запоминается
export type ServerEventType = 'build' | 'maintenance' | 'version' | 'city';

const handlers = new Map<ServerEventType, Set<(data: any) => void>>();
const last = new Map<ServerEventType, unknown>();
let started = false;

function deliver(type: ServerEventType, data: unknown) {
  if (type !== 'city') last.set(type, data);
  handlers.get(type)?.forEach(f => f(data));
}

function start() {
  if (started) return;
  started = true;
  if (typeof SharedWorker !== 'undefined') {
    try {
      const w = new SharedWorker(new URL('./serverEvents.worker.ts', import.meta.url), { type: 'module', name: 'tc-events' });
      w.port.onmessage = e => { const m = e.data as { type: ServerEventType; data: unknown }; if (m && m.type) deliver(m.type, m.data); };
      w.port.start();
      window.addEventListener('pagehide', () => w.port.postMessage('bye'));
      return;
    } catch { /* нет поддержки модульных воркеров — подключаемся напрямую */ }
  }
  connect((type, data) => deliver(type as ServerEventType, data));
}

// подписка на события типа; последнее уже пришедшее отдаётся сразу. Возвращает отписку.
export function onServerEvent<T = unknown>(type: ServerEventType, fn: (data: T) => void): () => void {
  start();
  let set = handlers.get(type);
  if (!set) handlers.set(type, set = new Set());
  set.add(fn);
  if (last.has(type)) fn(last.get(type) as T);
  return () => { set!.delete(fn); };
}
