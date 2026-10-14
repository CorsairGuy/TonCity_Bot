'use strict';
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');

async function getDailyAdsStatus(api,name){
  const status=await api.get('/daily-ads/');
  const info=status?.daily_ad||status;
  return{current:info?.current??0,limit:info?.limit??10,reward:info?.reward??0,limit_reached:!!info?.limit_reached};
}

async function runDailyAds(api,name,onProgress){
  try{
    const info=await getDailyAdsStatus(api,name);
    let{current,limit,reward}=info;
    logger.info(`[${name}] [daily-ads] прогресс: ${current}/${limit}, награда: ${reward}`);
    if(info.limit_reached){logger.info(`[${name}] [daily-ads] лимит достигнут`);return{current,limit,reward,claimed:0,limit_reached:true};}
    if(onProgress)onProgress(current,limit);
    let claimed=0;
    while(current<limit){
      const r=await api.post('/daily-ads/',{});
      if(r&&('balance' in r)){current++;claimed++;if(onProgress)onProgress(current,limit);await sleep(10000);}
      else{logger.info(`[${name}] [daily-ads] ошибка: ${JSON.stringify(r)}`);break;}
    }
    if(claimed)logger.info(`[${name}] [daily-ads] получено ${claimed} наград (+${reward*claimed} монет)`);
    return{current,limit,reward,claimed,limit_reached:current>=limit};
  }catch(e){logger.error(`[${name}] [daily-ads]: ${e.message}`);throw e;}
}

module.exports={getDailyAdsStatus,runDailyAds};
