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

# Справочники из config/ (здания, координаты, фазы, слова вордли) — копия в образе. config/ на сервере
# подключается с хоста (там же settings.json и кэши), поэтому при старте недостающие файлы
# докладываются из копии; существующие не трогаются (их могли править из панели).
RUN mkdir -p logs config && cp -r config /app/config-defaults

# Коммит, из которого собран образ (передаёт GitHub Actions). По нему панель показывает версию
# и сравнивает её с GitHub. Объявлен в конце, чтобы смена коммита не сбрасывала кэш слоёв выше.
# APP_REF — ветка или номер релиза, из которых собран образ.
ARG APP_COMMIT=
ARG APP_REF=
ENV APP_COMMIT=$APP_COMMIT APP_REF=$APP_REF

# exec — чтобы SIGTERM от Docker/Watchtower доходил до node (штатное закрытие WS и БД).
# На 32-битном ARM куча 3 ГБ не помещается в адресное пространство процесса — там 1,5 ГБ.
CMD ["sh", "-c", "for f in /app/config-defaults/*; do [ -e \"/app/config/${f##*/}\" ] || cp -r \"$f\" /app/config/; done; case \"$(uname -m)\" in arm*) H=1536;; *) H=3072;; esac; exec node --max-old-space-size=$H src/index.js"]
