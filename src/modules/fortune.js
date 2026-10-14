'use strict';
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
const {FortuneLog}=require('../db/index');
async function runFortune(api,name){
  try{
    const r=await api.get('/fortune-pavilion/can-draw');
    if(!r?.can_draw){logger.info(`[${name}] [fortune] can_draw=false, skip`);return;}
    let result;
    await globalLock.run(async()=>{
      await sleep(300);
      result=await api.post('/fortune-pavilion/daily-draw',{type:'free'});
      logger.info(`[${name}] [fortune] spin done`);
    });
    await FortuneLog.create({account:name,spun_at:new Date(),reward:result?JSON.stringify(result):null});
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [fortune] нет Павильона удачи — пропуск`);return;}
    logger.error(`[${name}] [fortune]: ${e.message}`);
  }
}
module.exports={runFortune};
