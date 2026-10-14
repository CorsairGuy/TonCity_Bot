# Запуск через Portainer

Файл стека — [`docker-compose.portainer.yml`](../docker-compose.portainer.yml). Отличия от обычного `docker-compose.yml`:

- Portainer хранит файл стека у себя (`/data/compose/<id>`), поэтому пути вроде `./config` и файл `.env` рядом с ним не работают. Все данные лежат в одной папке на сервере, её абсолютный путь задаёт переменная `DATA_DIR` (например `/DOCKER/toncity_bot`): там `config/`, `logs/` и `db_data/`.
- Переменные (`DB_PASSWORD`, `BOT_TAG` и т.д.) вводятся в Portainer при создании стека, файл `.env` на диске не читается. `DB_HOST` и `WEB_BIND` из старого `.env` не нужны: compose задаёт их сам.
- Смену версии из панели (Настройки → Обновления) делает сервис `updater` через API Portainer: меняет переменную стека `BOT_TAG` и передеплоивает стек со скачиванием образа. Для этого нужен токен Portainer (`PORTAINER_TOKEN`). Без токена бот работает, а версия меняется руками в Portainer.

## 1. Остановить запуск из консоли

На сервере, в папке проекта:

```bash
cd /DOCKER/toncity_bot

# где лежит база: Source должен быть /DOCKER/toncity_bot/db_data
docker inspect toncity_db --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

docker compose down --remove-orphans      # без -v: данные не удаляются

# резервная копия (база, настройки, .env)
tar czf ~/toncity_backup_$(date +%F).tgz db_data config .env
```

Имя контейнера (`toncity_db`) зависит от `STACK_NAME` в `.env`, проверить — `docker ps -a`. Если `Source` у базы — `/var/lib/docker/volumes/…_db_data/_data` (именованный том, а не папка), скопируйте его содержимое в `/DOCKER/toncity_bot/db_data` до запуска стека: `cp -a /var/lib/docker/volumes/<том>/_data/. /DOCKER/toncity_bot/db_data/`.

Папку `/DOCKER/toncity_bot` не удалять: стек будет брать данные из неё.

## 2. Старый стек в Portainer

Если в списке Stacks есть `toncity_bot`:

- с пометкой **Limited** — это и был запуск из консоли, после `docker compose down` он пропадёт сам;
- полноценный стек Portainer — удалите его (Stacks → выбрать → Remove). Контейнеры удалятся, папки с данными на диске останутся.

## 3. Токен для обновлятеля

Portainer → значок пользователя → **My account** → **Access tokens** → **Add access token**, описание `toncity updater`, скопировать токен (показывается один раз).

## 4. Создать стек

**Stacks → Add stack**, имя `toncity_bot`.

**Build method — Web editor:** вставить содержимое [`docker-compose.portainer.yml`](../docker-compose.portainer.yml).

Или **Repository:** URL `https://github.com/CorsairGuy/TonCity_Bot`, reference `refs/heads/main`, compose path `docker-compose.portainer.yml`. Тогда изменения файла стека приезжают из git при передеплое.

**Environment variables:** кнопка **Load variables from .env file** → выбрать старый `.env` (`Z:\DOCKER\toncity_bot\.env`), затем добавить и проверить:

| Переменная | Значение | Зачем |
|---|---|---|
| `DATA_DIR` | `/DOCKER/toncity_bot` | папка с `config/`, `logs/`, `db_data/` (обязательно, абсолютный путь на сервере) |
| `DB_PASSWORD` | из старого `.env` | пароль root базы, должен совпасть со старым, иначе бот не войдёт в существующую базу |
| `DB_NAME` | из старого `.env` (`db_main`) | |
| `STACK_NAME` | из старого `.env` (`toncity`) | префикс имён контейнеров |
| `WEB_PORT` | `3000` | порт панели |
| `DB_EXPOSED_PORT` | `3377` | порт базы снаружи |
| `BOT_TAG` | `latest` | канал: `latest`/`main`, `stable`, `1.0`, `sha-…` |
| `PORTAINER_TOKEN` | токен из шага 3 | смена версии из панели |
| `PORTAINER_URL` | не нужна | обновлятель сам находит Portainer (https :9443, http :9000, http :9443); задавать, только если он на другом адресе |
| `TONCITYQUESTS_BOT_HASH` | из старого `.env` | можно пусто |

Лишние строки из `.env` (`DB_HOST`, `WEB_BIND`, `WATCHTOWER_*`) можно удалить, они ни на что не влияют.

**Deploy the stack.**

## 5. Проверка

- Контейнеры `toncity_db`, `toncity_bot`, `toncity_updater` в статусе running (база — healthy).
- Панель на `http://<сервер>:3000`, аккаунты и настройки на месте.
- Настройки → Обновления: обновлятель на связи. «Обновить сейчас» меняет `BOT_TAG` в переменных стека Portainer и перезапускает только бота.
- Ошибки обновлятеля — в логах контейнера `toncity_updater` (Portainer → Containers → Logs).

## Версия вручную

Stacks → `toncity_bot` → Editor → переменная `BOT_TAG` → **Update the stack** с включённым **Re-pull image and redeploy**.
