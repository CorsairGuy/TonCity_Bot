# Обновлятель бота: docker CLI + compose + jq + curl (API Portainer) и скрипт updater.sh. См. updater/updater.sh.
FROM docker:27-cli
RUN apk add --no-cache jq curl
COPY updater.sh /usr/local/bin/updater.sh
RUN chmod +x /usr/local/bin/updater.sh
ENTRYPOINT ["/usr/local/bin/updater.sh"]
