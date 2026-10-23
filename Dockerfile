# Образ собирается под amd64, arm64 и arm/v7. Веб-панель — чистая статика, её собираем один раз на машине
# сборки ($BUILDPLATFORM, без эмуляции), в образ под каждую платформу кладём готовый dist.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /app
COPY src/web/client/package.json src/web/client/package-lock.json ./src/web/client/
RUN cd src/web/client && npm ci
COPY . .
# Сборка веб-панели → src/web/dist/
RUN cd src/web/client && npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata

# Зависимости бэкенда (только чистый JS, под эмуляцией ставятся быстро)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
COPY --from=web /app/src/web/dist ./src/web/dist

# Справочники из config/ (здания, координаты, секции, предметы, слова вордли) — копия в образе. config/ на
# сервере подключается с хоста (там же settings.json и кэши), поэтому при каждом старте scripts/docker-start.sh
# раскладывает копию в config/: справочники обновляются, словарь вордли объединяется с серверным.
RUN mkdir -p logs config && cp -r config /app/config-defaults

# Коммит, из которого собран образ (передаёт GitHub Actions). По нему панель показывает версию
# и сравнивает её с GitHub. Объявлен в конце, чтобы смена коммита не сбрасывала кэш слоёв выше.
# APP_REF — ветка или номер релиза, из которых собран образ.
ARG APP_COMMIT=
ARG APP_REF=
ENV APP_COMMIT=$APP_COMMIT APP_REF=$APP_REF

# Раскладка справочников и запуск node (exec, чтобы SIGTERM от Docker доходил до node) — в скрипте.
CMD ["sh", "/app/scripts/docker-start.sh"]
