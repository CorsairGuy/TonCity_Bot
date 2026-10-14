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
#
# Режим Portainer (docker-compose.portainer.yml, задан PORTAINER_TOKEN): стек
# принадлежит Portainer, его файл и переменные лежат в базе Portainer, а не на диске. Поэтому
# обновлятель не зовёт docker compose сам, а через API Portainer меняет переменную BOT_TAG стека и
# передеплоивает его с pullImage. Portainer пересоздаёт только то, что изменилось (обычно бота),
# база не трогается, а BOT_TAG в Portainer всегда показывает реальную версию.
set -u

PROJECT_MNT=/project
Q="$PROJECT_MNT/config/updater"
BOT="${BOT_CONTAINER:?нужен BOT_CONTAINER}"
SERVICE="${BOT_SERVICE:-bot}"
POLL="${POLL_SECONDS:-3}"
HEARTBEAT="${HEARTBEAT_SECONDS:-20}"
VERSION=4
PORTAINER_URL="${PORTAINER_URL:-}"
PORTAINER_TOKEN="${PORTAINER_TOKEN:-}"

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
  write_json "$Q/heartbeat.json" "$(jq -nc --arg at "$(now)" --argjson v "$VERSION" --arg tag "${CUR_TAG:-}" --arg mode "${MODE:-}" '{at:$at,version:$v,botTag:$tag,mode:$mode}')"
}
# пока идёт заявка (скачивание, деплой — минуты), основной цикл занят: пульс стучит в фоне,
# иначе панель посреди обновления решает, что обновлятель не запущен
busy(){ # команда…
  ( while :; do sleep "$HEARTBEAT"; heartbeat; done ) & hb_pid=$!
  "$@"
  kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null
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
# --- Portainer ---
# Адрес API: Portainer бывает на https :9443 (самоподписанный сертификат), на http :9000 или на
# http прямо на :9443 (тогда https даёт «TLS packet length too long»). Пробуем заданный адрес и
# типовые варианты, берём первый, где отвечает HTTP-сервер (любой код, кроме 000), и запоминаем.
PBASE=
portainer_base(){
  [ -n "$PBASE" ] && return 0
  h=host.docker.internal; u="${PORTAINER_URL%/}"
  alt=; case "$u" in https://*) alt="http://${u#https://}";; http://*) alt="https://${u#http://}";; esac
  for c in $u $alt https://$h:9443 http://$h:9000 http://$h:9443; do
    code=$(curl -s -k -o /dev/null --max-time 10 -w '%{http_code}' "$c/api/system/status" 2>/dev/null)
    if [ -n "$code" ] && [ "$code" != 000 ]; then
      PBASE="$c"; [ "$c" = "$u" ] || log "Portainer найден по адресу $c (задан ${u:-—})"; return 0
    fi
  done
  return 1
}
portainer(){ # METHOD path [json-тело] → тело ответа; ошибка HTTP = ненулевой код
  set -- "$1" "$PBASE/api$2" "${3:-}"
  k=; case "$PBASE" in https://*) k=-k;; esac   # у Portainer обычно самоподписанный сертификат
  if [ -n "$3" ]; then
    printf '%s' "$3" | curl -sS --fail-with-body --max-time 900 $k -X "$1" \
      -H "X-API-Key: $PORTAINER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$2"
  else
    curl -sS --fail-with-body --max-time 60 $k -X "$1" -H "X-API-Key: $PORTAINER_TOKEN" "$2"
  fi
}
process_portainer(){ # id tag
  id="$1"; tag="$2"
  name="${PORTAINER_STACK:-$(label "$BOT" com.docker.compose.project)}"
  [ -n "$name" ] || { status "$id" error "$tag" "не найдено имя стека (задайте PORTAINER_STACK)"; return; }
  # адрес ищем заново на каждую заявку (Portainer могли переустановить) и не внутри $(…):
  # там найденный адрес не сохранился бы
  PBASE=; portainer_base || { status "$id" error "$tag" "Portainer не найден: задайте PORTAINER_URL (пробовал https :9443, http :9000, http :9443)"; return; }
  if ! stacks=$(portainer GET /stacks 2>&1); then status "$id" error "$tag" "Portainer не ответил: $(echo "$stacks" | tail -n 2 | tr '\n' ' ')"; return; fi
  stack=$(echo "$stacks" | jq -c --arg n "$name" '[.[]|select((.Name|ascii_downcase)==($n|ascii_downcase))][0] // empty')
  [ -n "$stack" ] || { status "$id" error "$tag" "в Portainer нет стека «$name»"; return; }
  sid=$(echo "$stack" | jq -r .Id); eid=$(echo "$stack" | jq -r .EndpointId)
  env=$(echo "$stack" | jq -c --arg t "$tag" '(.Env // []) as $e | if any($e[]; .name=="BOT_TAG") then [$e[]|if .name=="BOT_TAG" then .value=$t else . end] else $e+[{name:"BOT_TAG",value:$t}] end')
  before=$(docker inspect -f '{{.Id}}' "$BOT" 2>/dev/null)
  # Образ скачиваем сами: так сразу видно, есть ли что ставить, и не дёргаем Portainer зря.
  # Portainer (2.2x) выкатывает стек в фоне: PUT отвечает раньше, чем пересоздан бот, а пока идёт
  # деплой, следующий PUT получает 409 «Stack deployment is already in progress».
  cur_img=$(docker inspect -f '{{.Image}}' "$BOT" 2>/dev/null)
  ref=$(docker inspect -f '{{.Config.Image}}' "$BOT" 2>/dev/null); ref="${ref%:*}:$tag"
  status "$id" pulling "$tag" "скачиваю образ"
  if ! out=$(docker pull -q "$ref" 2>&1); then status "$id" error "$tag" "не удалось скачать образ: $(echo "$out" | tail -n 2 | tr '\n' ' ')"; return; fi
  new_img=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null)
  if [ -n "$cur_img" ] && [ "$cur_img" = "$new_img" ] && [ "$tag" = "${CUR_TAG:-latest}" ]; then
    status "$id" unchanged "$tag" "эта версия уже установлена"; return
  fi
  status "$id" restarting "$tag" "Portainer перезапускает бота"
  if [ "$(echo "$stack" | jq -r '.GitConfig // empty | .URL // empty')" ]; then
    # стек из репозитория: передеплой из той же ветки репозитория с новой переменной
    body=$(echo "$stack" | jq -c --argjson env "$env" '{env:$env,prune:false,pullImage:true,repositoryReferenceName:.GitConfig.ReferenceName}')
    path="/stacks/$sid/git/redeploy?endpointId=$eid"
  else
    if ! file=$(portainer GET "/stacks/$sid/file" 2>&1); then status "$id" error "$tag" "не прочитан файл стека: $(echo "$file" | tail -n 2 | tr '\n' ' ')"; return; fi
    body=$(echo "$file" | jq -c --argjson env "$env" '{stackFileContent:.StackFileContent,env:$env,prune:false,pullImage:true}')
    path="/stacks/$sid?endpointId=$eid"
  fi
  # идёт прошлый деплой — ждём и повторяем, до 5 минут
  n=0
  while :; do
    out=$(portainer PUT "$path" "$body" 2>&1); rc=$?
    [ "$rc" -eq 0 ] && break
    if echo "$out" | grep -q 'already in progress' && [ "$n" -lt 30 ]; then n=$((n+1)); sleep 10; continue; fi
    status "$id" error "$tag" "Portainer не обновил стек: $(echo "$out" | tail -n 3 | tr '\n' ' ')"; return
  done
  CUR_TAG="$tag"
  # ждём, пока Portainer пересоздаст бота (до 5 минут)
  i=0; after="$before"
  while [ "$i" -lt 100 ]; do
    after=$(docker inspect -f '{{.Id}}' "$BOT" 2>/dev/null)
    [ -n "$after" ] && [ "$after" != "$before" ] && break
    i=$((i+1)); sleep 3
  done
  if [ -n "$after" ] && [ "$after" != "$before" ]; then status "$id" updated "$tag" "бот перезапущен"; docker image prune -f >/dev/null 2>&1
  else status "$id" error "$tag" "Portainer принял обновление, но бот за 5 минут не перезапустился — проверьте стек в Portainer"; fi
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

if [ -n "$PORTAINER_TOKEN" ]; then
  MODE=portainer; CUR_TAG=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BOT" 2>/dev/null | sed -n 's/^BOT_TAG=//p')
else MODE=compose; CUR_TAG=$(env_tag); fi
log "запущен ($MODE), бот: $BOT"
last_id=$(jq -r '.id // empty' "$Q/status.json" 2>/dev/null)
# обновлятель перезапустили посреди заявки (в Portainer он пересоздаётся вместе со стеком, если
# вышел новый образ обновлятеля): итог неизвестен, честно закрываем заявку, чтобы панель не ждала
last_state=$(jq -r '.state // empty' "$Q/status.json" 2>/dev/null)
case "$last_state" in pulling|restarting)
  status "$last_id" error "$(jq -r '.tag // empty' "$Q/status.json")" "обновлятель перезапустился во время обновления, проверьте версию в панели";;
esac
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
      elif [ "$MODE" = portainer ]; then busy process_portainer "$id" "$tag"
      else busy process "$id" "$tag"; fi
      heartbeat; beat=0
    fi
  fi
  beat=$((beat+POLL))
  if [ "$beat" -ge "$HEARTBEAT" ] || [ ! -f "$Q/heartbeat.json" ]; then heartbeat; beat=0; fi
  sleep "$POLL"
done
