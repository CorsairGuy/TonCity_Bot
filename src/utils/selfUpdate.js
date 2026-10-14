'use strict';
// Обновление бота из панели через Watchtower (docker-compose.yml). Бот сам себя не обновляет:
// он просит Watchtower скачать новый образ и пересоздать контейнер. Watchtower отвечает только
// после конца обновления, а если образ новый — останавливает бота (SIGTERM → gracefulShutdown)
// ещё до ответа, поэтому оборванный запрос здесь = обновление началось.
const axios=require('axios');
const logger=require('./logger');

const URL_=process.env.WATCHTOWER_URL||'';
const TOKEN=process.env.WATCHTOWER_TOKEN||'';
let running=false;

const isConfigured=()=>!!(URL_&&TOKEN);

async function requestUpdate(){
  if(!isConfigured())throw new Error('обновление не настроено: нужны WATCHTOWER_URL и WATCHTOWER_TOKEN (запуск через docker-compose.yml)');
  if(running)throw new Error('обновление уже запущено');
  running=true;
  logger.info('[update] прошу Watchtower обновить бота');
  try{
    const r=await axios.post(URL_.replace(/\/$/,'')+'/v1/update',null,
      {headers:{Authorization:'Bearer '+TOKEN},timeout:10*60*1000,validateStatus:()=>true});
    if(r.status===401)throw new Error('Watchtower отклонил ключ (WATCHTOWER_TOKEN в .env не совпадает)');
    if(r.status!==200)throw new Error(`Watchtower ответил ${r.status}`);
    const sum=r.data&&r.data.summary||{};
    // сюда доходим, только если бот НЕ перезапустили: нового образа нет или обновление не удалось
    if(sum.failed>0)throw new Error('Watchtower не смог обновить контейнер, подробности — docker logs watchtower');
    logger.info(`[update] нового образа нет (${JSON.stringify(sum)})`);
    return{updated:sum.updated||0,summary:sum};
  }finally{running=false;}
}

module.exports={isConfigured,requestUpdate};
