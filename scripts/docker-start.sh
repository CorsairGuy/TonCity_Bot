#!/bin/sh
# Запуск бота в контейнере. config/ подключается с хоста, а справочники из git (здания, координаты,
# секции, предметы, словарь вордли) лежат копией в образе (/app/config-defaults). При каждом старте
# они раскладываются в config/, чтобы правка справочника в git приезжала на сервер с обновлением:
#  - файла нет — копируется;
#  - словарь вордли — объединяется: слова из образа добавляются, слова, дописанные на сервере, остаются;
#  - остальные справочники — заменяются копией из образа (бот и панель их не правят).
# Кэши и настройки (settings.json, *-live.json, items-locale.json) в образ не попадают и не трогаются.
D=/app/config-defaults
C=/app/config
for f in "$D"/*; do
  n=${f##*/}
  if [ ! -e "$C/$n" ]; then
    cp -r "$f" "$C/"
  elif [ "$n" = wordle-words.txt ]; then
    cat "$f" "$C/$n" | tr -d '\r' | grep -v '^$' | LC_ALL=C sort -u | awk '{printf "%s\r\n",$0}' > "$C/$n.tmp" \
      && { cmp -s "$C/$n.tmp" "$C/$n" && rm -f "$C/$n.tmp" || mv -f "$C/$n.tmp" "$C/$n"; }
  elif [ -f "$f" ] && ! cmp -s "$f" "$C/$n"; then
    cp "$f" "$C/$n"
  fi
done

# exec — чтобы SIGTERM от Docker доходил до node (штатное закрытие WS и БД).
# На 32-битном ARM куча 3 ГБ не помещается в адресное пространство процесса — там 1,5 ГБ.
case "$(uname -m)" in arm*) H=1536;; *) H=3072;; esac
exec node --max-old-space-size=$H src/index.js
