'use strict';
const logger=require('../utils/logger');
const {isDifferentDay,sleep}=require('../utils/helpers');
const {globalLock}=require('../utils/lock');
const {DailyLog,DailyRewardSnapshot}=require('../db/index');

// GET /daily-login/ отдаёт график наград на ВСЕ 28 дней цикла разом (rewards:[{streak_day,
// reward_type,calculated_reward,item_id?}]), посчитанный под ТЕКУЩИЕ показатели аккаунта — не
// только на сегодня. Раньше этот ответ использовался только для проверки "уже забирали?" и
// выбрасывался; теперь сохраняем его как снимок — страница "Ежедневная награда" читает отсюда,
// отдельный живой запрос ей не нужен (см. web/routes/dashboards.js /api/daily).
async function saveRewardSnapshot(name,d){
  if(!d)return;
  try{
    await DailyRewardSnapshot.upsert({
      account:name,
      streak:d.daily_login?.streak??null,
      last_login:d.daily_login?.last_login??null,
      rewards:Array.isArray(d.rewards)?JSON.stringify(d.rewards):null,
      updated_at:new Date(),
    },{conflictFields:['account']});
  }catch(e){logger.warn(`[${name}] [daily] snapshot save: ${e.message}`);}
}

async function runDailyLogin(api,name){
  try{
    const d=await api.get('/daily-login/');
    await saveRewardSnapshot(name,d);
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
module.exports={runDailyLogin,saveRewardSnapshot};
