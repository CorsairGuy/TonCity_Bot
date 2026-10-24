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
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // перезагрузку на новой версии делает useBuildWatcher по событию build от бота; здесь — только
  // сообщение, если бот так и не поднялся
  const waitForRestart = () => {
    setUpdating(true);
    timerRef.current = window.setTimeout(() => {
      setUpdating(false);
      setMsg('Бот не поднялся за 10 минут. Проверьте docker compose ps и docker logs обновлятеля (…_updater).');
    }, 10 * 60 * 1000);
  };

  // tag не задан — свежий образ текущего канала
  const run = async (tag: string | undefined, force = false) => {
    setMsg(null);
    setBusyOps(null);
    setUpdating(true);
    // этап и прогресс скачивания бот присылает сам (событие build, useBuildWatcher)
    let r: Awaited<ReturnType<typeof api.update>>;
    try { r = await api.update(force, tag); }
    catch { waitForRestart(); return; } // соединение оборвалось: бот уже перезапускается
    if (r.ok && r.updated) { waitForRestart(); return; }
    setUpdating(false);
    if (r.ok) { setMsg('Эта версия уже установлена. Если только что вышла новая — дождитесь конца сборки образа на GitHub.'); return; }
    if (r.busy?.length) { setBusyOps({ ops: r.busy, tag }); return; }
    setMsg(r.error || 'Не удалось обновить');
  };

  return { updating, msg, busyOps, setBusyOps, run };
}

// подпись после ручной проверки: свежий ответ GitHub или повтор из кэша (клик раньше чем через 10 с)
export const checkNote = (d: { cached?: boolean; checkedAt: number; error?: string | null }) =>
  d.error ? null
  : d.cached ? `Проверено ${Math.max(1, Math.round((Date.now() - d.checkedAt) / 1000))} с назад, повторить можно через несколько секунд`
  : 'Проверено только что';
