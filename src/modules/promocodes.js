'use strict';
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
const {PromoLog}=require('../db/index');
async function runPromocodes(api,name){
  const codes=getConfig().promoCodes;
  if(!codes.length)return;
  for(const code of codes){
    let success=false,reward=null;
    try{
      await globalLock.run(async()=>{
        await sleep(500);
        const r=await api.post('/promocodes/activate',{code});
        success=!!r?.success;
        reward=r?.reward??null;
        if(success)logger.info(`[${name}] [promocodes] "${code}" activated: ${JSON.stringify(reward||{})}`);
        else logger.info(`[${name}] [promocodes] "${code}": ${JSON.stringify(r)}`);
      });
    }catch(e){
      if(e.message?.includes('404')||e.message?.includes('already')||e.message?.includes('used')){
        logger.info(`[${name}] [promocodes] "${code}" already used or not found`);
      }else{
        logger.error(`[${name}] [promocodes] "${code}": ${e.message}`);
      }
    }
    try{
      await PromoLog.upsert({account:name,code,success,reward:reward?JSON.stringify(reward):null,used_at:new Date()},{conflictFields:['account','code']});
    }catch(_){}
    await sleep(1000);
  }
}
module.exports={runPromocodes};
