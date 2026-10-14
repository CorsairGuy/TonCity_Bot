'use strict';
const {CapitalStrategy,GlobalCapitalUpgradePlan,CapitalSnapshot}=require('../db/index');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,fmt,withRetry}=require('../utils/helpers');
const {isCityPaused}=require('../utils/botState');
const capitalLive=require('../utils/capitalLive');
const {logCapitalAction}=require('./capitalActionLog');
const {loadCapBuildingsMap,capHallLevel,getMaxAllowedLevel,capUpgradePrice,capUpgradeDurationEstimate,enrichCapitalBuildings}=require('./capitalHelpers');
const {waitOrWake}=require('../utils/cityWake');

// Прокачка столицы — та же архитектура, что modules/progress.js для городов (см. заголовок того
// файла): ручная очередь → личный план по клетке → общий план по семействам, только ключ везде
// guild_id вместо account (столица общая на гильдию, не личная). В ОТЛИЧИЕ от городов, у столицы
// НЕТ пула "строителей" — runCapBuildings (прежняя реализация) никогда не ограничивал количество
// одновременных строек, только бюджет (coins*0.8) и то, что конкретное здание уже не строится
// прямо сейчас — поэтому здесь нет параметра "свободных слотов", очередь/план просто перебираются
// по порядку и запускается всё, на что хватает бюджета. Автоматическое "выравнивание по чертежу"
// (move/buy-пассы старой runCapBuildings) убрано вместе с ней — строительство/перемещение теперь
// разовые ручные действия (см. web/routes/capitalStrategy.js), как и у городов.

function describeError(e){
  const status=e?.response?.status;
  const statusText=e?.response?.statusText;
  const data=e?.response?.data;
  const body=typeof data==='string'?data:(data?JSON.stringify(data):'');
  return [e?.message,status?`status ${status}`:'',statusText||'',body].filter(Boolean).join(': ');
}

async function loadCapitalStrategy(guildId){
  try{
    const row=await CapitalStrategy.findOne({where:{guild_id:guildId}});
    let targets=[],queue=[];
    if(row?.targets){const arr=JSON.parse(row.targets);if(Array.isArray(arr))targets=arr;}
    if(row?.queue){const arr=JSON.parse(row.queue);if(Array.isArray(arr))queue=arr;}
    return{targets,queue};
  }catch(_){return{targets:[],queue:[]};}
}

async function loadGlobalCapitalPlan(){
  try{
    const rows=await GlobalCapitalUpgradePlan.findAll();
    const m=new Map();
    for(const r of rows){
      const lvl=Number(r.target_level)||0;
      if(r.family_id&&lvl)m.set(r.family_id,lvl);
    }
    return m;
  }catch(_){return new Map();}
}

// идентична городской resolveEffectiveTargets — личная цель по клетке всегда важнее общего плана
// по точному id здания.
function resolveEffectiveCapitalTargets(current,personalTargets,globalPlan){
  const personal=new Map(personalTargets.map(t=>[`${Number(t.x)},${Number(t.y)}`,t]));
  const result=[...personalTargets];
  if(!globalPlan.size)return result;
  for(const b of current){
    const key=`${Number(b.x)},${Number(b.y)}`;
    if(personal.has(key))continue;
    const lvl=globalPlan.get(b.id);
    if(lvl)result.push({x:b.x,y:b.y,target_level:lvl});
  }
  return result;
}

// без параметра "свободных слотов" (см. заголовок файла) — бюджет единственное ограничение.
// Очередь разбирается первой (порядок массива), затем план (тоже порядок массива — нет проверенной
// формулы длительности апгрейда столицы, чтобы сортировать "короткие вперёд", как у городов).
function pickCapitalStrategyTargets(current,queue,targets,buildingsMap,hallLevel,econStrength,coins,now=Date.now()){
  const result=[],consumedQueueKeys=[];
  const pickedKeys=new Set();
  let left=coins*0.8;

  const tryPick=(x,y,keySource)=>{
    const key=`${Number(x)},${Number(y)}`;
    if(pickedKeys.has(key))return false;
    const b=current.find(c=>Number(c.x)===Number(x)&&Number(c.y)===Number(y));
    if(!b)return false;
    if(b.end&&new Date(b.end).getTime()>now)return false; // уже строится
    const info=buildingsMap.get(b.id);
    if(!info||info.is_upgradable===false)return false;
    const lvl=Number(b.level||0);
    if(info.max_level&&lvl>=info.max_level)return false;
    if(lvl>=getMaxAllowedLevel(info,hallLevel))return false;
    return{key,b,info,lvl};
  };

  for(const q of queue){
    const cand=tryPick(q.x,q.y);
    if(!cand)continue;
    const price=capUpgradePrice(cand.b.id,cand.info,cand.lvl,econStrength);
    if(price>left)continue;
    result.push({...cand.b,upgrade_price:price});
    consumedQueueKeys.push(cand.key);
    pickedKeys.add(cand.key);
    left-=price;
  }

  for(const t of targets){
    const targetLevel=Number(t.target_level)||0;
    if(!targetLevel)continue;
    const cand=tryPick(t.x,t.y);
    if(!cand)continue;
    if(cand.lvl>=targetLevel)continue;
    const price=capUpgradePrice(cand.b.id,cand.info,cand.lvl,econStrength);
    if(price>left)continue;
    result.push({...cand.b,upgrade_price:price});
    pickedKeys.add(cand.key);
    left-=price;
  }
  return{picked:result,consumedQueueKeys};
}

// прогноз (вкладка "Прогноз") — тот же дискретно-событийный подход, что simulateFutureActions у
// городов, но без пула строителей: на каждом шаге просто запускает всё доступное по бюджету разом,
// а не ограничиваясь количеством свободных строителей. Длительность — capUpgradeDurationEstimate
// (capitalHelpers.js), формула подтверждена реверсом бандла (класс qp.getUpgradeDuration), у
// столицы нет бонусов гильдии/политик/ускорителей на время стройки, в отличие от города. НЕ
// ограничено фиксированным горизонтом (раньше было 3 суток) — считает ВСЕ запланированные
// улучшения (очередь+личный+общий план), пока не исчерпаются либо не упрёмся в MAX_ITERATIONS.
function simulateFutureCapitalActions(current,queue,personalTargets,globalPlan,buildingsMap,hallLevel,econStrength,coins,capitalProfitPerHour){
  const sim=current.map(b=>({...b,_busyUntil:b.end?new Date(b.end).getTime():0}));
  let simQueue=queue.map(q=>({...q}));
  let simCoins=coins,simTime=Date.now();
  const events=[];
  const MAX_ITERATIONS=5000;
  let iterations=0;

  while(iterations++<MAX_ITERATIONS){
    for(const b of sim){
      if(b._busyUntil&&b._busyUntil<=simTime){b.level=(Number(b.level)||0)+1;b._busyUntil=0;}
    }
    const currentView=sim.map(b=>({...b,end:b._busyUntil>simTime?new Date(b._busyUntil).toISOString():null}));
    const effectiveTargets=resolveEffectiveCapitalTargets(currentView,personalTargets,globalPlan);
    const{picked,consumedQueueKeys}=pickCapitalStrategyTargets(currentView,simQueue,effectiveTargets,buildingsMap,hallLevel,econStrength,simCoins,simTime);
    if(consumedQueueKeys.length){
      const toRemove=[...consumedQueueKeys];
      simQueue=simQueue.filter(q=>{
        const key=`${Number(q.x)},${Number(q.y)}`;
        const idx=toRemove.indexOf(key);
        if(idx===-1)return true;
        toRemove.splice(idx,1);
        return false;
      });
    }
    if(!picked.length){
      if(capitalProfitPerHour>0){simTime+=3600000;simCoins+=capitalProfitPerHour;continue;}
      break;
    }
    for(const b of picked){
      const info=buildingsMap.get(b.id);
      const lvl=Number(b.level||0);
      const durationMs=info?Math.round(capUpgradeDurationEstimate(info,lvl)*1000):0;
      const idx=sim.findIndex(s=>Number(s.x)===Number(b.x)&&Number(s.y)===Number(b.y));
      if(idx===-1)continue;
      sim[idx]._busyUntil=simTime+durationMs;
      simCoins-=b.upgrade_price||0;
      events.push({x:b.x,y:b.y,building_id:b.id,level_from:lvl,level_to:lvl+1,start:simTime,end:simTime+durationMs,duration_ms:durationMs});
    }
  }
  return events.sort((a,b)=>a.start-b.start);
}

async function runCapitalProgressAction(guildId,label,work){
  try{
    await globalLock.run(work);
    return true;
  }catch(e){
    logger.error(`[capital:${guildId}] [capital-progress] ${label} failed: ${describeError(e)}`);
    return false;
  }
}

// основной цикл — вызывается из modules/capital.js runCapUpgradeLoop (leader-only, см. там же)
async function runCapitalProgress(api,name,guildId){
  if(isCityPaused()){logger.info(`[${name}] [capital-progress] прокачка на паузе — пропускаю`);return;}
  try{
    const buildingsMap=loadCapBuildingsMap();
    let prog;
    try{
      prog=await withRetry(()=>api.get(`/capitals/progress/${guildId}`),2,1500,`${name} capital progress load`);
    }catch(e){
      logger.error(`[${name}] [capital-progress] load failed: ${describeError(e)}`);
      return;
    }
    const coins=prog?.progress?.coins||0;
    const econStrength=prog?.economic_strength||1;
    let current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
    // /capitals/progress/{guildId} никогда не отдаёт guild_title (только buildings/coins/economic_
    // strength) — раньше тут падали на account name (`name`) как "заглушку", из-за чего в списке
    // "Столицы" вперемешку показывались то настоящие названия гильдий (их пишет modules/capital.js
    // runCapital из /users/me/guild), то имена аккаунтов бота (их писал этот цикл поверх). Сохраняем
    // уже известное название из снимка, а не имя аккаунта, которое к гильдии вообще не относится.
    try{
      const existing=await CapitalSnapshot.findOne({where:{guild_id:guildId}});
      await CapitalSnapshot.upsert({guild_id:guildId,guild_title:prog?.guild_title||existing?.guild_title||guildId,buildings:JSON.stringify(current),updated_at:new Date()},{conflictFields:['guild_id']});
    }catch(_){}
    // сырые данные игры не несут is_upgradable — без него бейджи/подсветка уровней на карте
    // "стирались" бы каждым живым обновлением (см. capitalHelpers.js enrichCapitalBuildings)
    capitalLive.broadcast(guildId,enrichCapitalBuildings(current,buildingsMap));
    let hallLevel=capHallLevel(current,buildingsMap);
    const busy=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now()).length;
    logger.info(`[${name}] [capital-progress] coins: ${fmt(coins)} | строек: ${busy} | зданий: ${current.length} | холл: ${hallLevel} | сила: ${econStrength.toFixed(2)}`);

    const{targets:personalTargets,queue:initialQueue}=await loadCapitalStrategy(guildId);
    const globalPlan=await loadGlobalCapitalPlan();
    if(!personalTargets.length&&!initialQueue.length&&!globalPlan.size){
      logger.info(`[${name}] [capital-progress] нет настроенных целей улучшений — простой`);
      return;
    }
    let queue=initialQueue.slice();
    const persistQueue=async()=>{
      try{
        const row=await CapitalStrategy.findOne({where:{guild_id:guildId}});
        if(row)await row.update({queue:JSON.stringify(queue),updated_at:new Date()});
      }catch(e){logger.warn(`[${name}] [capital-progress] не удалось сохранить очередь: ${e.message}`);}
    };

    const refreshState=async()=>{
      const latest=await withRetry(()=>api.get(`/capitals/progress/${guildId}`),2,1500,`${name} capital progress refresh`);
      current=Array.isArray(latest?.progress?.data?.buildings)?latest.progress.data.buildings:[];
      hallLevel=capHallLevel(current,buildingsMap);
      try{
        const existing=await CapitalSnapshot.findOne({where:{guild_id:guildId}});
        await CapitalSnapshot.upsert({guild_id:guildId,guild_title:latest?.guild_title||existing?.guild_title||guildId,buildings:JSON.stringify(current),updated_at:new Date()},{conflictFields:['guild_id']});
      }catch(_){}
      capitalLive.broadcast(guildId,enrichCapitalBuildings(current,buildingsMap));
      return{coins:latest?.progress?.coins||0,econStrength:latest?.economic_strength||econStrength};
    };

    while(true){
      if(isCityPaused()){logger.info(`[${name}] [capital-progress] прокачка на паузе — выхожу из цикла`);break;}
      const state=await refreshState();
      const effectiveTargets=resolveEffectiveCapitalTargets(current,personalTargets,globalPlan);
      const{picked,consumedQueueKeys}=pickCapitalStrategyTargets(current,queue,effectiveTargets,buildingsMap,hallLevel,state.econStrength,state.coins);
      if(consumedQueueKeys.length){
        const toRemove=[...consumedQueueKeys];
        queue=queue.filter(q=>{
          const key=`${Number(q.x)},${Number(q.y)}`;
          const idx=toRemove.indexOf(key);
          if(idx===-1)return true;
          toRemove.splice(idx,1);
          return false;
        });
        await persistQueue();
      }
      if(!picked.length){
        const stillBusy=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now());
        if(stillBusy.length){
          const nextEnd=Math.min(...stillBusy.map(b=>new Date(b.end).getTime()));
          const waitMs=Math.max(5000,nextEnd-Date.now()+2000);
          logger.info(`[${name}] [capital-progress] нет доступных апгрейдов по целям, жду ${Math.ceil(waitMs/1000)}s`);
          // waitOrWake, а не голый sleep — иначе ручное "Ускорить за алмазы" (или новая цель/очередь)
          // будило бы этот цикл впустую: пока он спит ЗДЕСЬ (внутри одного прохода
          // runCapitalProgress), а не в waitOrWake снаружи (см. runCapUpgradeLoop), wake() улетал бы
          // в пустоту — цикл узнал бы о готовом здании только когда истечёт СТАРЫЙ таймер стройки,
          // хотя после ускорения здание уже готово прямо сейчас
          await waitOrWake(`capital:${guildId}`,waitMs);
          continue;
        }
        logger.info(`[${name}] [capital-progress] цели сейчас недостижимы (нет зданий/не хватает денег) — завершаю цикл`);
        break;
      }
      let launched=false;
      for(const b of picked){
        const nextLvl=(Number(b.level)||1)+1;
        const ok=await runCapitalProgressAction(guildId,`upgrade ${b.id} at (${b.x},${b.y}) to lvl ${nextLvl}`,async()=>{
          await sleep(1500);
          const r=await api.post(`/capitals/progress/${guildId}`,{actions:[{type:'upgrade',id:b.id,x:b.x,y:b.y}]});
          if(r?.coins!==undefined)logger.info(`[${name}] [capital-progress] upgraded ${b.id} | LVL ${b.level} -> ${nextLvl}`);
        });
        if(ok){
          launched=true;
          await logCapitalAction(guildId,'upgrade',{x:b.x,y:b.y,building_id:b.id,level_from:Number(b.level||0),level_to:nextLvl});
          try{await refreshState();}catch(e){logger.error(`[${name}] [capital-progress] refresh failed after upgrade: ${describeError(e)}`);}
        }
        await sleep(2000);
      }
      if(!launched){
        logger.info(`[${name}] [capital-progress] апгрейды не запустились, жду 30s`);
        await sleep(30000);
      }
    }
  }catch(e){logger.error(`[${name}] [capital-progress] ${describeError(e)}`);}
}

module.exports={
  runCapitalProgress,
  loadCapitalStrategy,loadGlobalCapitalPlan,
  resolveEffectiveCapitalTargets,pickCapitalStrategyTargets,simulateFutureCapitalActions,
};
