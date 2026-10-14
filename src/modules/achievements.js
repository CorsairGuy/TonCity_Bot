'use strict';
const logger=require('../utils/logger');
const {AchievementSnapshot}=require('../db/index');
async function runAchievements(api,name){
  try{
    const data=await api.get('/achievements/unlocked').catch(()=>null);
    if(!Array.isArray(data))return;
    const now=new Date();
    await Promise.all(data.filter(a=>a.id).map(a=>
      AchievementSnapshot.upsert({
        account:name,
        achievement_id:a.id,
        progress:a.progress??null,
        tiers:JSON.stringify(a.tiers||[]),
        secret:!!a.secret,
        updated_at:now,
      },{conflictFields:['account','achievement_id']})
    ));
    logger.info(`[${name}] [achievements] saved ${data.filter(a=>a.id).length}`);
  }catch(e){logger.error(`[${name}] [achievements]: ${e.message}`);}
}
module.exports={runAchievements};
