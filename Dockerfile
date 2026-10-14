FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata

# Зависимости бэкенда
COPY package.json package-lock.json ./
RUN npm ci

# Зависимости веб-панели
COPY src/web/client/package.json src/web/client/package-lock.json ./src/web/client/
RUN cd src/web/client && npm ci

COPY . .

# Сборка веб-панели → src/web/dist/
RUN cd src/web/client && npm run build

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

# exec — чтобы SIGTERM от Docker/Watchtower доходил до node (штатное закрытие WS и БД)
CMD ["sh", "-c", "for f in /app/config-defaults/*; do [ -e \"/app/config/${f##*/}\" ] || cp -r \"$f\" /app/config/; done; exec node --max-old-space-size=3072 src/index.js"]
