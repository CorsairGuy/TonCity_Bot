'use strict';
// Автообновление по каналу (Настройки → Обновления). Плавающий канал (ветка или stable) +
// update.auto=true: как только на GitHub есть новая версия канала и её образ собран, бот сам
// просит обновлятель поставить её. Закреплённая версия (релиз 1.0 или sha-…) не обновляется никогда.
// Не стартует посреди ручных операций панели (opRegistry) — ждёт следующей проверки.
const logger=require('./logger');
const{sleep}=require('./helpers');
const{DEFAULTS,mergeDeep,loadSettings}=require('../config');
const versionCheck=require('./versionCheck');
const selfUpdate=require('./selfUpdate');

const PERIOD_MS=10*60*1000;
const FIRST_DELAY_MS=3*60*1000;   // дать боту прогреться после старта
const attempted=new Set();        // коммиты, на которые уже пробовали обновиться в этом процессе

async function tick(){
  const s=mergeDeep(DEFAULTS,loadSettings()); // getConfig() не пробрасывает update
  if(!(s.update&&s.update.auto))return;
  if(!selfUpdate.isConfigured())return;
  const v=await versionCheck.getVersionInfo({maxAge:PERIOD_MS});
  if(!v||v.error||!v.remote)return;
  if(!['branch','stable'].includes(v.channel&&v.channel.kind))return;
  if(v.status!=='behind')return;
  if(!v.build||v.build.status!=='completed'||v.build.conclusion!=='success')return; // образ ещё не готов
  if(attempted.has(v.remote.sha))return;
  const busy=require('../web/lib/opRegistry').activeKeys();
  if(busy.length){logger.info(`[auto-update] есть новая версия ${v.remote.sha.slice(0,7)}, жду конца операций: ${busy.join(', ')}`);return;}
  attempted.add(v.remote.sha);
  logger.info(`[auto-update] канал ${v.channel.name}: новая версия ${v.remote.sha.slice(0,7)} (+${v.behindBy||'?'}), ставлю`);
  const r=await selfUpdate.requestSwitch(selfUpdate.currentTag(),'auto');
  // сюда доходим, только если перезапуска не было
  if(!r.updated){logger.info('[auto-update] образ ещё не опубликован в реестре, повторю позже');attempted.delete(v.remote.sha);}
}

async function autoUpdateLoop(){
  await sleep(FIRST_DELAY_MS);
  for(;;){
    try{await tick();}catch(e){logger.warn(`[auto-update] ${e.message}`);}
    await sleep(PERIOD_MS);
  }
}

module.exports={autoUpdateLoop};
