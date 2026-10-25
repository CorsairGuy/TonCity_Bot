# Проверка окна сайдбара в браузере

Локальный стенд настоящих компонентов React/Primer и OverlayScrollbars. Игровые аккаунты, БД и игровой API не используются. По 500 записей в 11 типах панелей, включая план улучшений; отдельно 36 вложенных групп городов. Проверяет появление viewport после effects, прокрутку к последней записи, ограниченное число DOM-карточек, отсутствие наложений, абсолютные индексы удаления/перетаскивания, Tab между строками и группами и пропуск отключённых кнопок ускорителей.

После установки зависимостей фронтенда:

```bash
node scripts/tests/browser/city-sidebar-window/server.mjs
# В другом терминале, если playwright доступен в Node:
node scripts/tests/browser/city-sidebar-window/run.cjs
```

Без добавления Playwright в зависимости проекта можно указать существующую установку и Chromium:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core CHROMIUM_PATH=/usr/bin/chromium node scripts/tests/browser/city-sidebar-window/run.cjs
```

`PORT` меняет порт сервера (по умолчанию 5200), `CITY_FIXTURE_URL` — адрес стенда для теста. Стенд проверяет поведение компонентов, а не производительность боевого устройства.
