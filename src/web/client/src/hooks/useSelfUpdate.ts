import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Обновление / смена канала бота из панели (плашка версии и Настройки → Обновления).
// Обновлятель пересоздаёт контейнер, поэтому запрос часто обрывается — это значит «бот
// перезапускается». Ждём, пока поднимется новый процесс (другое startedAt), и перезагружаем панель.
export function useSelfUpdate() {
  const [updating, setUpdating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // сервер ответил 409: идут операции — спросить, обновлять ли всё равно
  const [busyOps, setBusyOps] = useState<{ ops: string[]; tag?: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const waitForRestart = (oldStart: number | undefined) => {
    setUpdating(true);
    const started = Date.now();
    pollRef.current = window.setInterval(async () => {
      if (Date.now() - started > 10 * 60 * 1000) {
        if (pollRef.current) clearInterval(pollRef.current);
        setUpdating(false);
        setMsg('Бот не поднялся за 10 минут. Проверьте docker compose ps и docker logs обновлятеля (…_updater).');
        return;
      }
      try {
        const d = await api.version();
        if (d && d.ok && d.startedAt && d.startedAt !== oldStart) {
          if (pollRef.current) clearInterval(pollRef.current);
          window.location.reload();
        }
      } catch { /* бот ещё перезапускается */ }
    }, 4000);
  };

  // tag не задан — свежий образ текущего канала
  const run = async (tag: string | undefined, force = false) => {
    setMsg(null);
    setBusyOps(null);
    let oldStart: number | undefined;
    try { oldStart = (await api.version()).startedAt; } catch { /* нет связи */ }
    setUpdating(true);
    let r: Awaited<ReturnType<typeof api.update>>;
    try { r = await api.update(force, tag); }
    catch { waitForRestart(oldStart); return; } // соединение оборвалось: бот уже перезапускается
    if (r.ok && r.updated) { waitForRestart(oldStart); return; }
    setUpdating(false);
    if (r.ok) { setMsg('Эта версия уже установлена. Если только что вышла новая — дождитесь конца сборки образа на GitHub.'); return; }
    if (r.busy?.length) { setBusyOps({ ops: r.busy, tag }); return; }
    setMsg(r.error || 'Не удалось обновить');
  };

  return { updating, msg, busyOps, setBusyOps, run };
}
