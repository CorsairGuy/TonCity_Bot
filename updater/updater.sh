#!/bin/sh
# Обновлятель бота (сервис updater в docker-compose.yml). Заменяет Watchtower: тот умеет только
# обновить контейнер на свежий образ ТОГО ЖЕ тега, а панели нужно ещё переключать канал (тег).
#
# Протокол — файлы в общей папке config/updater/ (бот и обновлятель видят её оба, сеть и ключи не
# нужны):
#   request.json   ← пишет бот: {"id":"…","tag":"main|stable|1.0|sha-…","reason":"…"}
#   status.json    → пишет обновлятель: {"id","state":"pulling|restarting|updated|unchanged|error","tag","message","at",
#                    "progress"?} — progress только при скачивании: {layers,downloaded,extracted,cur,total,estTotal}
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
VERSION=7
PORTAINER_URL="${PORTAINER_URL:-}"
PORTAINER_TOKEN="${PORTAINER_TOKEN:-}"

mkdir -p "$Q"
now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ echo "$(now) [updater] $*"; }

write_json(){ # file json
  printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"
}
status(){ # id state tag message [progress-json]
  write_json "$Q/status.json" "$(jq -nc --arg id "$1" --arg state "$2" --arg tag "$3" --arg message "$4" --arg at "$(now)" \
    --argjson progress "${5:-null}" '{id:$id,state:$state,tag:$tag,message:$message,at:$at}+(if $progress then {progress:$progress} else {} end)')"
  [ -n "${5:-}" ] || log "$1: $2 $3 $4"
}

# Скачивание образа с прогрессом. docker pull без терминала прогресс по байтам не печатает, поэтому
# идём прямо в Docker Engine API (POST /images/create): он стримит JSON по каждому слою с
# progressDetail {current,total}. Раз в секунду сводим поток в один объект progress и пишем его в
# status.json — панель рисует полосу. В потоке слой узнаёт свой размер только когда начал качаться
# (Docker качает по 3 сразу), а оценка по среднему скакала (100 → 40 → 20 МБ: первым идёт крупный
# слой). Поэтому размеры слоёв берём заранее из манифеста образа в реестре ($S: короткий id слоя →
# байты), а оценка средним осталась запасной — когда реестр не ответил.
PULL_LOG=/tmp/pull.log
PULL_JQ='[inputs|fromjson?]
  | reduce (.[]|select(.id and ((.status//"")|IN("Pulling fs layer","Waiting","Downloading","Verifying Checksum","Download complete","Extracting","Pull complete","Already exists")))) as $e ({};
      (.[$e.id]//{}) as $l | .[$e.id]=(
        if $e.status=="Downloading" then $l+{cur:($e.progressDetail.current//0),total:($e.progressDetail.total//$l.total//0)}
        elif $e.status=="Verifying Checksum" or $e.status=="Download complete" or $e.status=="Extracting" then $l+{dl:true}
        elif $e.status=="Pull complete" then $l+{dl:true,ex:true}
        elif $e.status=="Already exists" then $l+{skip:true}
        else $l end))
  | [to_entries[]|.value+{total:($S[.key]//.value.total//0)}|select(.skip|not)] as $L
  | ($L|map(select((.total//0)>0))) as $K
  | ($K|map(.total)|add//0) as $kt
  | ($L|map(select((.total//0)==0 and (.dl|not)))|length) as $u
  | {layers:($L|length),downloaded:($L|map(select(.dl))|length),extracted:($L|map(select(.ex))|length),
     cur:($L|map(if .dl then (.total//0) else (.cur//0) end)|add//0),total:$kt,
     estTotal:($kt+(if ($K|length)>0 then $u*$kt/($K|length) else 0 end))}'
# размеры слоёв образа из манифеста ghcr.io (анонимный токен, пакет публичный): {"<12 hex>":байты}.
# Мульти-арх индекс → манифест под архитектуру Docker Engine. Любая ошибка → {} (оценка средним).
layer_sizes(){ # ref
  img="${1%:*}"; t="${1##*:}"; repo="${img#ghcr.io/}"
  [ "$repo" != "$img" ] || { echo '{}'; return; }
  acc='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
  tok=$(curl -fsS --max-time 10 "https://ghcr.io/token?scope=repository:$repo:pull" 2>/dev/null | jq -r '.token//empty') &&
  m=$(curl -fsS --max-time 10 -H "Authorization: Bearer $tok" -H "Accept: $acc" "https://ghcr.io/v2/$repo/manifests/$t" 2>/dev/null) || { echo '{}'; return; }
  if printf '%s' "$m" | jq -e '.manifests' >/dev/null 2>&1; then
    arch=$(docker version -f '{{.Server.Arch}}' 2>/dev/null | tr -d '[:space:]'); [ -n "$arch" ] || arch=amd64
    d=$(printf '%s' "$m" | jq -r --arg a "$arch" '[.manifests[]|select(.platform.os=="linux" and .platform.architecture==$a)][0].digest//empty')
    [ -n "$d" ] && m=$(curl -fsS --max-time 10 -H "Authorization: Bearer $tok" -H "Accept: $acc" "https://ghcr.io/v2/$repo/manifests/$d" 2>/dev/null) || { echo '{}'; return; }
  fi
  printf '%s' "$m" | jq -c '[.layers[]?|{key:.digest[7:19],value:.size}]|from_entries' 2>/dev/null || echo '{}'
}
pull_progress(){ # id tag ref → 0 скачан; иначе запасной путь (docker pull)
  ref="$3"; img="${ref%:*}"; t="${ref##*:}"
  [ -S /var/run/docker.sock ] && [ "$img" != "$ref" ] || return 1
  sizes=$(layer_sizes "$ref"); [ -n "$sizes" ] || sizes='{}'
  [ "$sizes" = '{}' ] && log "$1: размеры слоёв из реестра не получены, оцениваю по ходу скачивания"
  : > "$PULL_LOG"
  curl -sS -N --max-time 1800 --unix-socket /var/run/docker.sock -X POST \
    "http://localhost/images/create?fromImage=$img&tag=$t" > "$PULL_LOG" 2>&1 &
  pid=$!; last=
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    p=$(jq -ncR --argjson S "$sizes" "$PULL_JQ" < "$PULL_LOG" 2>/dev/null) || continue
    [ "$p" = "$last" ] || { status "$1" pulling "$2" "скачиваю образ" "$p"; last="$p"; }
  done
  wait "$pid" || return 1
  # ошибка реестра приходит строкой {"error":…} при HTTP 200, ошибка API — {"message":…}
  ! jq -ncR '[inputs|fromjson?|select(.error or .message)]|length>0' < "$PULL_LOG" | grep -q true
}
# образ бота с другим тегом: из контейнера бота (имя образа то же, меняется только тег)
bot_ref(){ r=$(docker inspect -f '{{.Config.Image}}' "$BOT" 2>/dev/null) && [ -n "$r" ] && echo "${r%:*}:$1"; }
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
  if ! pull_progress "$id" "$tag" "$ref"; then
    log "$id: скачивание через Docker API не вышло ($(tail -n 1 "$PULL_LOG" 2>/dev/null)), повторяю через docker pull"
    if ! out=$(docker pull -q "$ref" 2>&1); then status "$id" error "$tag" "не удалось скачать образ: $(echo "$out" | tail -n 2 | tr '\n' ' ')"; return; fi
  fi
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
  # Docker Desktop на Windows пишет в метки путь хоста вида D:\TonCity_Bot. Внутри контейнера (Linux)
  # такой путь — относительное имя с обратными слешами: compose склеивал его с рабочей папкой и
  # искал /D:\TonCity_Bot/D:\TonCity_Bot/docker-compose.yml. Берём путь папки проекта так, как его
  # видит Docker Engine (источник тома /project у обновлятеля), а файлы — относительно неё.
  case "$dir" in [A-Za-z]:[\\/]*|*\\*)
    wdir=$(printf '%s' "$dir" | tr '\\' / | sed 's|/*$||')
    edir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "'"$PROJECT_MNT"'"}}{{.Source}}{{end}}{{end}}' "$(hostname)" 2>/dev/null)
    [ -n "$edir" ] || edir="/run/desktop/mnt/host/$(printf '%s' "${wdir%%:*}" | tr 'A-Z' 'a-z')${wdir#?:}"
    nf=; old_ifs=$IFS; IFS=,
    for f in $files; do
      f=$(printf '%s' "$f" | tr '\\' /)
      lf=$(printf '%s' "$f" | tr 'A-Z' 'a-z'); lw=$(printf '%s' "$wdir/" | tr 'A-Z' 'a-z')
      case "$lf" in "$lw"*) f="$edir/${f#"$wdir/"}";; [A-Za-z]:/*) f="$edir/${f##*/}";; esac
      nf="${nf:+$nf,}$f"
    done
    IFS=$old_ifs
    log "$id: путь Windows $dir → $edir"
    dir="$edir"; files="$nf";;
  esac
  if [ "$dir" != "$PROJECT_MNT" ] && [ ! -e "$dir" ]; then mkdir -p "$(dirname "$dir")" && ln -s "$PROJECT_MNT" "$dir"; fi

  set -- -p "$project" --project-directory "$dir"
  old_ifs=$IFS; IFS=,
  for f in $files; do set -- "$@" -f "$f"; done
  IFS=$old_ifs
  [ $# -gt 4 ] || set -- "$@" -f "$dir/docker-compose.yml"

  # сравниваем id контейнера: compose пересоздаёт его и при новом образе, и при смене тега
  before=$(docker inspect -f '{{.Id}}' "$BOT" 2>/dev/null)
  status "$id" pulling "$tag" "скачиваю образ"
  # сначала качаем с прогрессом сами; compose pull после этого лишь сверяет образ с реестром
  ref=$(bot_ref "$tag") && { pull_progress "$id" "$tag" "$ref" || log "$id: скачивание через Docker API не вышло, качает docker compose"; }
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
