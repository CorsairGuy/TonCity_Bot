import { registerSW } from 'virtual:pwa-register';

// registerType: 'autoUpdate' (vite.config.ts) — новый service worker сам делает skipWaiting() +
// clientsClaim(), т.е. становится активным контроллером всех вкладок сразу после установки. НО это
// не значит, что уже открытая вкладка сама подхватит новый бандл — она продолжает работать с JS,
// уже загруженным в память, пока не перезагрузится сама. Плюс браузер по умолчанию проверяет sw.js
// на новизну не чаще раза в 24ч при обычной навигации — для PWA, которое подолгу висит открытым
// (домашний экран, отдельное окно), этого мало. Поэтому регистрируем SW вручную (injectRegister:
// null в vite.config.ts отключает автогенерируемый registerSW.js) и добавляем: периодическую
// проверку обновлений + автоматическую перезагрузку вкладки при смене активного контроллера.
let controllerChanged = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => { controllerChanged = true; });

let settle: () => void = () => {};
const ready = new Promise<void>(res => { settle = res; });

// Раньше приложение монтировалось сразу на СТАРОМ бандле, а через ~секунду (пока по сети
// проверялось sw.js) прилетал controllerchange и страница перезагружалась — пользователь видел
// мигание "старое → перезагрузка → новое". Теперь main.tsx ждёт этот промис перед монтированием
// React (сплэш из index.html держит экран, пока промис не разрешится):
//  - нет serviceWorker/это первая установка (controller ещё не было) — резолвим сразу, ждать нечего;
//  - иначе ждём "ready" (settle() зовётся ниже, как только явная проверка обновления однозначно
//    покажет, что новой версии НЕТ — обычно доли секунды на маленький sw.js, а не maxWaitMs вслепую);
//  - если контроллер СМЕНИЛСЯ (нашли новую версию, она уже активировалась) — НЕ резолвим вообще:
//    страница и так вот-вот перезагрузится сама (см. ниже), монтировать старый React ради долей
//    секунды перед сносом смысла нет.
//  - maxWaitMs — только страховка на случай медленной/отсутствующей сети, чтобы не зависнуть на
//    сплэше навсегда, если проверка обновления вообще не смогла завершиться.
export function waitForFreshSW(maxWaitMs = 1500): Promise<void> {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { if (!controllerChanged) resolve(); };
    const timer = setTimeout(done, maxWaitMs);
    ready.then(() => { clearTimeout(timer); done(); });
    navigator.serviceWorker.addEventListener('controllerchange', () => clearTimeout(timer)); // не резолвим — идёт перезагрузка
  });
}

// Сколько ждём событие "updatefound" (см. ниже), прежде чем считать, что обновления точно нет.
// РАНЬШЕ здесь была попытка "быстрого пути" через .then() промиса update() — ОШИБКА: update()
// может зарезолвиться ДО того, как браузер синхронно выставит registration.installing (это гонка,
// не гарантия), из-за чего settle() срабатывал слишком рано — приложение монтировалось на старом
// бандле, а спустя секунду-две реальный updatefound/controllerchange всё равно прилетал и рвал
// экран перезагрузкой — то есть баг воспроизводился в точности как до фикса. Правильный сигнал —
// именно DOM-событие "updatefound" на registration (спецификация SW гарантирует: если браузер решил
// ставить новую версию, событие обязано случиться) — ждём его максимум NO_UPDATE_GRACE_MS (сильно
// щедрее, чем обычно занимает скачивание + байт-сравнение маленького sw.js).
const NO_UPDATE_GRACE_MS = 800;

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) { settle(); return; }
    let updateFound = false;
    registration.addEventListener('updatefound', () => {
      updateFound = true; // намеренно НЕ зовём settle() — ждём исход установки, см. комментарий выше waitForFreshSW
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'redundant') settle(); // установка не удалась — ждать больше нечего
      });
    });
    // на случай гонки с внутренней immediate-проверкой virtual:pwa-register (могла стартовать ДО
    // того, как мы успели подписаться на updatefound выше) — свой вызов идемпотентен, не страшно
    registration.update().catch(() => {});
    setTimeout(() => { if (!updateFound) settle(); }, NO_UPDATE_GRACE_MS);
    setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000); // раз в час, пока вкладка открыта
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  },
  onNeedRefresh() { updateSW(true); }, // на случай browser'ов без skipWaiting — форсируем сами
});

// новый SW взял на себя контроль (после skipWaiting) — перезагружаем один раз, чтобы страница сразу
// подхватила свежий бандл, без ожидания ручного F5 от пользователя. Если React ещё не смонтирован
// (см. waitForFreshSW выше) — сплэш из index.html продолжает висеть до самой перезагрузки, старый UI
// пользователь вообще не увидит.
let reloaded = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (reloaded) return;
  reloaded = true;
  window.location.reload();
});
