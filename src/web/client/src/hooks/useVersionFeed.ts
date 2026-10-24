import { useSyncExternalStore } from 'react';
import type { VersionInfo } from '../api';

// Общая на все вкладки лента свежих проверок версии. Сервер рассылает каждую свою проверку по SSE
// (GET /api/version/stream) — сам по таймеру, по ручной проверке из любой вкладки или из
// автообновления. Браузер держит не больше 6 соединений на сайт на ВСЕ вкладки, поэтому поток
// открывает только одна вкладка-лидер (Web Locks), а остальным раздаёт его через BroadcastChannel.
// Без Web Locks (панель по http не с localhost) лидера не выбрать — тогда каждая вкладка изредка
// спрашивает дешёвый кэш сервера (GitHub при этом не дёргается), а найденное всё равно разлетается
// по остальным вкладкам через BroadcastChannel.
const CHANNEL = 'tc-version';
const LOCK = 'tc-version-stream';
const POLL_MS = 60 * 1000;

let latest: VersionInfo | null = null;
let started = false;
let bc: BroadcastChannel | null = null;
const subs = new Set<() => void>();

// берём только не более старое, чем уже есть (ответ из кэша мог прийти позже свежей рассылки)
function accept(v: VersionInfo | null | undefined, relay: boolean) {
  if (!v || !v.ok) return;
  if (latest && v.checkedAt < latest.checkedAt) return;
  latest = v;
  subs.forEach(f => f());
  if (relay) { try { bc?.postMessage(v); } catch { /* вкладка закрывается */ } }
}

// данные, полученные вкладкой самостоятельно (загрузка, ручная проверка), — тоже всем вкладкам
export function publishVersion(v: VersionInfo | null | undefined) { accept(v, true); }

function openStream(): Promise<void> {
  return new Promise(resolve => {
    const es = new EventSource('/api/version/stream');
    es.onmessage = e => { try { accept(JSON.parse(e.data), true); } catch { /* битое сообщение */ } };
    // EventSource сам переподключается; при перезапуске бота страница перезагрузится (useBuildWatcher)
    window.addEventListener('pagehide', () => { es.close(); resolve(); }, { once: true });
  });
}

async function poll() {
  try {
    const r = await fetch('/api/version');
    if ((r.headers.get('content-type') || '').includes('json')) accept(await r.json(), true);
  } catch { /* нет связи — следующая попытка по таймеру */ }
}

// запуск один раз на всё приложение
export function startVersionFeed() {
  if (started) return;
  started = true;
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = e => accept(e.data as VersionInfo, false);
  }
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  // лидер держит замок, пока жива вкладка; закрыли её — замок и поток переходят к следующей
  if (locks) locks.request(LOCK, () => openStream()).catch(() => {});
  else setInterval(poll, POLL_MS);
}

export function useVersionFeed(): VersionInfo | null {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => latest);
}
