'use strict';
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
const {LoyaltySnapshot,LoyaltyLevelDef}=require('../db/index');

// Дорога верности — условие уровня: "прошло N дней" (current_days в ответе == d.streak, сверено
// живьём 1:1). Проверяется раз в сутки (см. index.js runLoyaltyLoop, тем же паттерном, что вордли).
//
// Локальная оценка решает ТОЛЬКО стоит ли стучаться в игру сегодня — сама она НИКОГДА не клеймит:
// если локально похоже, что порог следующего уровня взят (streak + прошедшие календарные сутки с
// последнего снимка), делаем живой GET /loyalty-road/ (подтверждение актуальным ответом сервера) и
// клеймим уже по нему. Если каталог порогов не полон — тоже живой запрос (бутстрап).
const DAY_MS=24*60*60*1000;

async function loadLevelDefs(){
  const rows=await LoyaltyLevelDef.findAll();
  return new Map(rows.map(r=>[r.level,r.required_days]));
}

async function harvestAndClaim(api,name,levels,streak){
  try{await LoyaltySnapshot.upsert({account:name,streak,levels:JSON.stringify(levels),updated_at:new Date()},{conflictFields:['account']});}catch(_){}
  for(const l of levels){
    const req=l?.condition?.required_days;
    if(req!=null)try{await LoyaltyLevelDef.upsert({level:l.level,required_days:Number(req),updated_at:new Date()},{conflictFields:['level']});}catch(_){}
  }
  const claimable=levels.filter(l=>!l.claimed&&l?.condition?.condition_met);
  logger.info(`[${name}] [loyalty] streak: ${streak} days | claimable: ${claimable.length}`);
  for(const l of claimable){
    await globalLock.run(async()=>{
      await sleep(300);
      const r=await api.post('/loyalty-road/',{level:l.level});
      logger.info(`[${name}] [loyalty] claimed level ${l.level}, crystals: ${r?.crystals??'?'}`);
    });
    await sleep(500);
  }
}

async function runLoyalty(api,name,opts={}){
  try{
    const defs=await loadLevelDefs();
    const snap=await LoyaltySnapshot.findOne({where:{account:name}});
    let levels=[];
    try{levels=snap?.levels?JSON.parse(snap.levels):[];}catch(_){levels=[];}
    const claimedLevels=new Set(levels.filter(l=>l.claimed).map(l=>l.level));
    const knownLevels=[...defs.keys()].sort((a,b)=>a-b);
    const nextLevel=knownLevels.find(l=>!claimedLevels.has(l));
    const haveFullPicture=!!snap&&knownLevels.length>=levels.length&&levels.length>0&&nextLevel!=null;

    const staleSnapshot=!snap?.updated_at||(Date.now()-new Date(snap.updated_at).getTime())>7*24*60*60*1000;

    let needLive=true;
    if(!opts.forceLive&&haveFullPicture&&!staleSnapshot){
      const daysSince=Math.floor((Date.now()-new Date(snap.updated_at).getTime())/DAY_MS);
      const estimated=(snap.streak||0)+daysSince;
      const threshold=defs.get(nextLevel);
      needLive=estimated>=threshold;
      if(!needLive)logger.debug(`[${name}] [loyalty] локально: ур.${nextLevel} нужно ${threshold} дн., оценка ${estimated} дн. — пропуск живого запроса`);
    }

    if(!needLive)return;

    // локально похоже на достигнуто (или бутстрап/forceLive/просрочка) — живой запрос-подтверждение
    const d=await api.get('/loyalty-road/');
    const freshLevels=d?.levels||[];
    const streak=d?.streak??0;
    await harvestAndClaim(api,name,freshLevels,streak);
  }catch(e){logger.error(`[${name}] [loyalty]: ${e.message}`);}
}
module.exports={runLoyalty};
