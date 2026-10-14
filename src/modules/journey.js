'use strict';
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
const {JourneyLevel,JourneyLevelDef}=require('../db/index');

// Путь мэра — условие уровня: `current_profit >= required_profit`, где `current_profit` (сверено
// живьём) это ПРОСТО ТЕКУЩАЯ прибыль/час города (то же число, что и Account.profit), НЕ
// накопительный счётчик.
//
// Синхронизировано с циклом прокачки города (modules/progress.js runProgress), а НЕ с отдельным
// суточным/интервальным таймером — профит меняется ИМЕННО тогда, когда завершается апгрейд, и
// progress.js и так на каждой такой точке уже знает свежий профит из ответа игры (params[].profit,
// та же формула, что session.js saveStats) — передаёт его сюда БЕЗ единого дополнительного запроса.
//
// Локальная оценка решает ТОЛЬКО стоит ли вообще стучаться в игру сегодня — сама она НИКОГДА не
// клеймит: если локально похоже, что порог следующего уровня взят, делаем живой GET /mjourney/
// (подтверждение актуальным ответом сервера) и клеймим уже по нему. Если каталог порогов не полон
// или профит неизвестен — тоже живой запрос (безопасный дефолт, бутстрап).
async function loadLevelDefs(){
  const rows=await JourneyLevelDef.findAll();
  return new Map(rows.map(r=>[r.level,Number(r.required_profit)]));
}

async function harvestDefsAndClaim(api,name,lvls){
  // сохраняем снапшот по уровням (страница "Путь мэра" читает отсюда) + харвестим пороги + клеймим
  await Promise.all(lvls.map(async l=>{
    const[row,created]=await JourneyLevel.findOrCreate({where:{account:name,level:l.level},defaults:{claimed:!!l.claimed,condition_met:!!l?.condition?.condition_met,updated_at:new Date()}});
    if(!created)await row.update({claimed:!!l.claimed,condition_met:!!l?.condition?.condition_met,updated_at:new Date()});
    const req=l?.condition?.required_profit;
    if(req!=null)try{await JourneyLevelDef.upsert({level:l.level,required_profit:Number(req),updated_at:new Date()},{conflictFields:['level']});}catch(_){}
  }));

  for(const l of lvls){
    if(l.claimed||!l?.condition?.condition_met)continue;
    await globalLock.run(async()=>{await sleep(300);const r=await api.post('/mjourney/',{level:l.level});logger.info(`[${name}] [journey] claimed LVL ${l.level}: ${JSON.stringify(r.reward)}`);});
    await sleep(500);
  }
}

// currentProfit — уже известная прибыль/час (из свежего /progress/ ответа, который вызывающий код
// и так только что получил для своих целей) либо null (тогда локальная проверка невозможна, идём
// живым запросом — тот же безопасный дефолт, что и при неполном каталоге порогов).
async function runJourney(api,name,currentProfit,opts={}){
  try{
    const defs=await loadLevelDefs();
    const rows=await JourneyLevel.findAll({where:{account:name}});
    const claimedLevels=new Set(rows.filter(r=>r.claimed).map(r=>r.level));
    const knownLevels=[...defs.keys()].sort((a,b)=>a-b);
    const nextLevel=knownLevels.find(l=>!claimedLevels.has(l));
    const haveFullPicture=knownLevels.length>=20&&nextLevel!=null; // 20 — сколько уровней видели живьём на 21.07.2026

    let needLive=true;
    if(!opts.forceLive&&haveFullPicture&&currentProfit!=null){
      const threshold=defs.get(nextLevel);
      needLive=currentProfit>=threshold;
      if(!needLive)logger.debug(`[${name}] [journey] локально: ур.${nextLevel} нужен профит ${threshold}, сейчас ${Math.round(currentProfit)} — пропуск живого запроса`);
    }

    if(!needLive)return;

    // локально похоже на достигнуто (или бутстрап/forceLive) — живой запрос-подтверждение, клеймим
    // уже по его реальному condition_met, не по своей оценке
    const lvls=await api.get('/mjourney/');
    if(!Array.isArray(lvls))return;
    await harvestDefsAndClaim(api,name,lvls);
  }catch(e){logger.error(`[${name}] [journey]: ${e.message}`);}
}
module.exports={runJourney};
