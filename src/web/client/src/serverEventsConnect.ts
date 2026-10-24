// Подключение к потоку событий бота (GET /api/events) с переподключением. Сам EventSource
// переподключается только после обрыва сети; ответ не-200 (401 до входа в панель, 502 от прокси,
// пока бот перезапускается) закрывает его навсегда — тогда открываем заново с нарастающей паузой.
const TYPES = ['build', 'maintenance', 'version'];

export function connect(onEvent: (type: string, data: unknown) => void) {
  let delay = 2000;
  const open = () => {
    const es = new EventSource('/api/events');
    es.onopen = () => { delay = 2000; };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
    for (const type of TYPES) {
      es.addEventListener(type, e => {
        let data: unknown;
        try { data = JSON.parse((e as MessageEvent).data); } catch { return; }
        onEvent(type, data);
      });
    }
  };
  open();
}
