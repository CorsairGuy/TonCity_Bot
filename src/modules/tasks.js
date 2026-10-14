'use strict';
const logger=require('../utils/logger');
const {isDifferentDay,sleep}=require('../utils/helpers');
const {globalLock}=require('../utils/lock');
const {DailyLog}=require('../db/index');
async function runDailyLogin(api,name){
  try{
    const d=await api.get('/daily-login/');
    if(!isDifferentDay(d?.daily_login?.last_login)){logger.info(`[${name}] [daily] already claimed`);return;}
    let reward=null,day=null;
    await globalLock.run(async()=>{
      await sleep(300);
      const r=await api.post('/daily-login/',{});
      day=r?.daily_login?.streak??r?.streak??r?.daily_login?.day??r?.day??null;
      const itemId=r?.reward_item_id??r?.item_id??null;
      reward=r?.reward!=null?{amount:r.reward,type:r.reward_type||'coins',...(itemId!=null?{item_id:itemId}:{})}:null;
      logger.info(`[${name}] [daily] streak ${day}, reward: ${JSON.stringify(reward)}`);
    });
    await DailyLog.upsert({account:name,logged_at:new Date().toISOString().slice(0,10),day,reward:reward?JSON.stringify(reward):null},{conflictFields:['account','logged_at']});
  }catch(e){logger.error(`[${name}] Daily: ${e.message}`);}
}
module.exports={runDailyLogin};
