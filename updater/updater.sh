#!/bin/sh
# Обновлятель бота (сервис updater в docker-compose.yml). Заменяет Watchtower: тот умеет только
# обновить контейнер на свежий образ ТОГО ЖЕ тега, а панели нужно ещё переключать канал (тег).
#
# Протокол — файлы в общей папке config/updater/ (бот и обновлятель видят её оба, сеть и ключи не
# нужны):
#   request.json   ← пишет бот: {"id":"…","tag":"main|stable|1.0|sha-…","reason":"…"}
#   status.json    → пишет обновлятель: {"id","state":"pulling|restarting|updated|unchanged|error","tag","message","at"}
#   heartbeat.json → пишет обновлятель раз в HEARTBEAT секунд: панель понимает, что он жив.
#
# Переключение = docker compose pull bot (с BOT_TAG=<тег>) → BOT_TAG в .env → docker compose up -d
# --no-deps bot. Так ручной `docker compose up -d` потом поднимает ту же версию. База и сам
# обновлятель не трогаются. Компоуз запускается с теми же файлами и рабочей папкой, что и у бота
# (метки com.docker.compose.* контейнера бота), папка проекта смонтирована в /project, а по
# хостовому пути на неё ставится симлинк — так относительные пути (./config, ./logs, .env)
# раскрываются в правильные пути хоста.
set -u

PROJECT_MNT=/project
Q="$PROJECT_MNT/config/updater"
BOT="${BOT_CONTAINER:?нужен BOT_CONTAINER}"
SERVICE="${BOT_SERVICE:-bot}"
POLL="${POLL_SECONDS:-3}"
HEARTBEAT="${HEARTBEAT_SECONDS:-20}"
VERSION=2

mkdir -p "$Q"
now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ echo "$(now) [updater] $*"; }

write_json(){ # file json
  printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"
}
status(){ # id state tag message
  write_json "$Q/status.json" "$(jq -nc --arg id "$1" --arg state "$2" --arg tag "$3" --arg message "$4" --arg at "$(now)" \
    '{id:$id,state:$state,tag:$tag,message:$message,at:$at}')"
  log "$1: $2 $3 $4"
}
heartbeat(){
  write_json "$Q/heartbeat.json" "$(jq -nc --arg at "$(now)" --argjson v "$VERSION" --arg tag "${CUR_TAG:-}" '{at:$at,version:$v,botTag:$tag}')"
}

label(){ # container label
  docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null
}

# BOT_TAG в .env: правим содержимое на месте (тот же файл, владелец и права не меняются)
set_env_tag(){
  f="$PROJECT_MNT/.env"
  [ -f "$f" ] || { echo "BOT_TAG=$1" > "$f"; return; }
  if grep -q '^BOT_TAG=' "$f"; then
    body=$(sed "s|^BOT_TAG=.*|BOT_TAG=$1|" "$f") && printf '%s\n' "$body" > "$f"
  else
    [ -n "$(tail -c1 "$f")" ] && echo >> "$f"
    echo "BOT_TAG=$1" >> "$f"
  fi
}
env_tag(){ sed -n 's/^BOT_TAG=//p' "$PROJECT_MNT/.env" 2>/dev/null | tail -n1 | tr -d '\r'; }

process(){ # id tag
  id="$1"; tag="$2"
  if ! echo "$tag" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; then status "$id" error "$tag" "недопустимый тег"; return; fi

  src="$BOT"; docker inspect "$BOT" >/dev/null 2>&1 || src="$(hostname)"
  dir=$(label "$src" com.docker.compose.project.working_dir)
  project=$(label "$src" com.docker.compose.project)
  files=$(label "$src" com.docker.compose.project.config_files)
  [ -n "$dir" ] && [ -n "$project" ] || { status "$id" error "$tag" "не найдены метки docker compose (бот запущен не через docker-compose.yml?)"; return; }
  case "$files" in *docker-compose.dev.yml*) status "$id" error "$tag" "режим разработки (docker-compose.dev.yml): образ собирается локально, переключение канала не поддерживается"; return;; esac
  if [ "$dir" != "$PROJECT_MNT" ] && [ ! -e "$dir" ]; then mkdir -p "$(dirname "$dir")" && ln -s "$PROJECT_MNT" "$dir"; fi

  set -- -p "$project" --project-directory "$dir"
  old_ifs=$IFS; IFS=,
  for f in $files; do set -- "$@" -f "$f"; done
  IFS=$old_ifs
  [ $# -gt 4 ] || set -- "$@" -f "$dir/docker-compose.yml"

  # сравниваем id контейнера: compose пересоздаёт его и при новом образе, и при смене тега
  before=$(docker inspect -f '{{.Id}}' "$BOT" 2>/dev/null)
  status "$id" pulling "$tag" "скачиваю образ"
  if ! out=$(cd "$dir" && BOT_TAG="$tag" docker compose "$@" pull "$SERVICE" 2>&1); then
    status "$id" error "$tag" "не удалось скачать образ: $(echo "$out" | tail -n 3 | tr '\n' ' ')"; return
  fi
  set_env_tag "$tag"
  status "$id" restarting "$tag" "перезапускаю бота"
  if ! out=$(cd "$dir" && BOT_TAG="$tag" docker compose "$@" up -d --no-deps "$SERVICE" 2>&1); then
    status "$id" error "$tag" "не удалось перезапустить бота: $(echo "$out" | tail -n 3 | tr '\n' ' ')"; return
  fi
  after=$(docker inspect -f '{{.Id}}' "$BOT" 2>/dev/null)
  CUR_TAG="$tag"
  if [ -n "$before" ] && [ "$before" = "$after" ]; then status "$id" unchanged "$tag" "эта версия уже установлена"
  else status "$id" updated "$tag" "бот перезапущен"; docker image prune -f >/dev/null 2>&1; fi
}

log "запущен, бот: $BOT"
CUR_TAG=$(env_tag)
last_id=$(jq -r '.id // empty' "$Q/status.json" 2>/dev/null)
beat=0
while :; do
  if [ -f "$Q/request.json" ]; then
    id=$(jq -r '.id // empty' "$Q/request.json" 2>/dev/null)
    tag=$(jq -r '.tag // empty' "$Q/request.json" 2>/dev/null)
    ts=$(jq -r '.ts // 0' "$Q/request.json" 2>/dev/null)
    if [ -n "$id" ] && [ "$id" != "$last_id" ]; then
      last_id="$id"
      # заявка старше 10 минут — забытая (обновлятель был выключен), не исполняем её внезапно
      if [ $(( $(date +%s) - ${ts%.*} )) -gt 600 ]; then status "$id" error "$tag" "заявка устарела, повторите из панели"
      else process "$id" "$tag"; fi
      heartbeat; beat=0
    fi
  fi
  beat=$((beat+POLL))
  if [ "$beat" -ge "$HEARTBEAT" ] || [ ! -f "$Q/heartbeat.json" ]; then heartbeat; beat=0; fi
  sleep "$POLL"
done
