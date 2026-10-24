// Общий на все вкладки браузера SharedWorker: держит ОДНО соединение с потоком событий бота
// (GET /api/events) и раздаёт события всем вкладкам панели. Новой вкладке сразу отдаёт последнее
// событие каждого типа. Вкладка закрылась — её порт просто перестаёт получать сообщения.
// Подключается из serverEvents.ts.
import { connect } from './serverEventsConnect';

type Port = { postMessage(m: unknown): void; start(): void; onmessage: ((e: MessageEvent) => void) | null };

const ports = new Set<Port>();
const last = new Map<string, unknown>();
let opened = false;

function open() {
  opened = true;
  connect((type, data) => {
    last.set(type, data);
    for (const p of ports) p.postMessage({ type, data });
  });
}

(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = e => {
  const port = e.ports[0] as unknown as Port;
  ports.add(port);
  port.onmessage = m => { if (m.data === 'bye') ports.delete(port); };
  port.start();
  for (const [type, data] of last) port.postMessage({ type, data });
  if (!opened) open();
};
