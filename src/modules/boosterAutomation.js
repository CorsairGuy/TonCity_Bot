'use strict';
const fs=require('fs'),path=require('path');
const {Inventory,BoosterAutomation,CitySnapshot}=require('../db/index');
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');
const {globalLock}=require('../utils/lock');
const {logAction}=require('./cityActionLog');
const {waitOrWake,wake}=require('../utils/cityWake');

// Автоактивация ускорителей (страница "Карта города" → вкладка "Ускорители", "всегда держать
// активным") — непрерывный цикл, один на аккаунт (см. index.js startAccountLoops), НЕ разовая
// проверка раз в сутки: "всегда держать активным" требует знать ТОЧНОЕ время, когда освобождается
// слот, иначе город простаивает без буста часами.
//
// ВАЖНО: цикл НЕ опрашивает игру (никакого GET /boosters/active на таймере) — время окончания
// известно нам САМИМИ, из end_time ответа игры на наш же POST /boosters/activate (см. ниже и
// web/routes/cityStrategy.js POST .../activate) — точно так же, как страница "Ускорители" читает
// только БД (booster_active_until/booster_currently_active в Inventory). Единственный живой
// запрос ко всему разделу — сама активация (POST) и ручная кнопка "Проверить" на вкладке
// (см. getEndsByType ниже — используется ТОЛЬКО этой кнопкой, не фоновым циклом), которая нужна,
// только если игрок активировал ускоритель напрямую в игре, а не через бота.
const FALLBACK_POLL_MS=15*60*1000; // если у аккаунта вообще нет включённой автоактивации/активных бустов

let _rarityToId=null;
function rarityToId(){
  if(_rarityToId)return _rarityToId;
  _rarityToId=new Map();
  try{
    const p=path.join(process.cwd(),'config','items.json');
    const items=JSON.parse(fs.readFileSync(p,'utf8'));
    for(const[id,v]of Object.entries(items))if(v?.tag)_rarityToId.set(v.tag,id);
  }catch(e){logger.warn(`[booster-loop] не удалось прочитать items.json: ${e.message}`);}
  return _rarityToId;
}

// живой GET /boosters/active → Map<тип, [end_time ms, ...]> — группировка активных записей по типу
// ускорителя (id из каталога) через поле rarity (совпадает с "tag" в config/items.json). Используется
// ТОЛЬКО ручной кнопкой "Проверить" (web/routes/cityStrategy.js POST .../boosters/check) — разовая
// сверка по запросу пользователя, НЕ фоновым циклом (см. комментарий выше).
async function getEndsByType(api){
  const rMap=rarityToId();
  const raw=await api.get('/boosters/active').catch(()=>[]);
  const active=Array.isArray(raw)?raw:(raw?.boosters||[]);
  const endsByType=new Map();
  for(const a of active){
    const id=rMap.get(a?.rarity);
    if(id==null||!a?.end_time)continue;
    const arr=endsByType.get(id)||[];
    arr.push(new Date(a.end_time).getTime());
    endsByType.set(id,arr);
  }
  return endsByType;
}

// сейчас активный ускоритель (игра допускает только ОДИН тип активным разом, но несколько
// инстанций подряд — берём с максимальным end_time) + его реальный множитель скорости стройки —
// оба поля отдаёт сама игра в /boosters/active (a.multiplier, a.end_time), нигде в config/items.json
// не хранятся. Используется вкладкой "Прогноз" (см. web/cityStats.js effectiveUpgradeDuration) —
// единственное место, где боту реально нужен множитель, а не только флаг "активен/нет".
async function getActiveBoosterInfo(api){
  const rMap=rarityToId();
  const raw=await api.get('/boosters/active').catch(()=>[]);
  const active=Array.isArray(raw)?raw:(raw?.boosters||[]);
  let best=null,bestEnd=0;
  for(const a of active){
    const endMs=a?.end_time?new Date(a.end_time).getTime():0;
    if(endMs>bestEnd){bestEnd=endMs;best=a;}
  }
  if(!best)return null;
  return{name:rMap.get(best.rarity)??null,multiplier:Number(best.multiplier)||1,endsAt:bestEnd};
}

async function runBoosterAutomationLoop(api,name){
  logger.info(`[${name}] [booster-loop] started`);
  while(true){
    try{
      const settings=await BoosterAutomation.findAll({where:{account:name,enabled:1}});
      if(!settings.length){await waitOrWake(name,6*60*60*1000);continue;}
      const enabledNames=new Set(settings.map(s=>s.booster_name));

      const rows=await Inventory.findAll({where:{account:name,type:'booster'}});
      const now=Date.now();
      // "ещё активен" — целиком из БД (booster_active_until пишем сами при активации), без единого
      // живого запроса к игре. Если игрок активировал что-то напрямую в игре — это увидит только
      // ручная кнопка "Проверить" на вкладке (web/routes/cityStrategy.js POST .../boosters/check).
      const isStillActive=r=>r.booster_active_until&&new Date(r.booster_active_until).getTime()>now;
      // ПРАВИЛО ИГРЫ (подтверждено пользователем вживую): пока активен ХОТЬ ОДИН ускоритель, можно
      // активировать ТОЛЬКО ТОТ ЖЕ тип (если он стакается, т.е. active_limit>1) — любой ДРУГОЙ тип
      // заблокирован целиком, независимо от его собственного active_limit.
      let activeTypeName=null;
      for(const r of rows)if(isStillActive(r)){activeTypeName=r.name;break;}

      let activatedAny=false,soonest=null;
      for(const row of rows){
        if(!enabledNames.has(row.name))continue;
        const activeLimit=row.booster_active_limit??0;
        const stillActive=isStillActive(row);
        const untilMs=row.booster_active_until?new Date(row.booster_active_until).getTime():0;
        const currentlyActive=stillActive?(row.booster_currently_active??0):0;
        if(activeTypeName!=null&&activeTypeName!==row.name){
          // заблокировано ДРУГИМ активным типом — блокировка снимется, когда закончится он
          const blocker=rows.find(r=>r.name===activeTypeName);
          if(blocker?.booster_active_until)soonest=Math.min(soonest??Infinity,new Date(blocker.booster_active_until).getTime());
          continue;
        }
        if(currentlyActive<activeLimit){
          if((row.marketable??0)<=0)continue; // нечем активировать — ждём общего цикла проверки
          let endTime=null;
          const ok=await runAction(name,`booster activate ${row.name}`,async()=>{
            await sleep(500);
            const r=await api.post('/boosters/activate',{id:Number(row.name)});
            if(r?.end_time)endTime=new Date(r.end_time).getTime();
          });
          if(ok){
            activatedAny=true;
            const prevUntil=stillActive?untilMs:0;
            await row.update({
              marketable:Math.max(0,(row.marketable??0)-1),
              booster_currently_active:Math.min(currentlyActive+1,activeLimit),
              booster_active_until:endTime?new Date(Math.max(endTime,prevUntil)):row.booster_active_until,
            });
            await logAction(name,'booster_activate',{building_id:row.name,detail:JSON.stringify({auto:true})});
            logger.info(`[${name}] [booster-loop] активирован ${row.name}`);
          }
          continue;
        }
        // на лимите — ближайшее освобождение = когда закончится уже активный этого типа
        if(stillActive)soonest=Math.min(soonest??Infinity,untilMs);
      }

      if(activatedAny){
        // активация меняет end у текущих строек на стороне игры (сверено с бандлом:
        // Ht().updateConstructionTimesForBooster()) — перечитываем /progress/, чтобы веб-панель и
        // цикл улучшений увидели свежие времена, и будим его пересчитать время пробуждения
        try{
          const prog=await api.get('/progress/');
          const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
          await CitySnapshot.upsert({account:name,buildings:JSON.stringify(buildings),updated_at:new Date()},{conflictFields:['account']});
        }catch(e){logger.warn(`[${name}] [booster-loop] resync: ${e.message}`);}
        wake(name);
      }

      const waitMs=soonest!=null?Math.max(5000,soonest-Date.now()+2000):FALLBACK_POLL_MS;
      logger.info(`[${name}] [booster-loop] следующая проверка через ${Math.ceil(waitMs/1000)}s`);
      await waitOrWake(name,waitMs);
    }catch(e){
      logger.error(`[${name}] [booster-loop] ${e.message}`);
      await sleep(60000);
    }
  }
}

async function runAction(name,label,work){
  try{await globalLock.run(work);return true;}
  catch(e){logger.error(`[${name}] [booster-loop] ${label} failed: ${e?.response?.data?.error||e.message}`);return false;}
}

// Ручная активация ускорителя нужной редкости — используется кнопкой "Активировать" на странице
// "Квесты" (см. web/routes/dashboards.js, заменила автоматику questAutomation.js runBoosterQuestAutomation
// по просьбе пользователя 22.07.2026: активация ускорителей — намеренное решение игрока, не фоновая
// автоматика). ТО ЖЕ правило игры, что и у фонового цикла выше: пока активен ХОТЬ ОДИН ускоритель —
// можно активировать ТОЛЬКО ТОТ ЖЕ тип (если стакается, active_limit>1), любой ДРУГОЙ тип заблокирован
// целиком до его окончания — отсюда, например, легендарный/мифический (active_limit обычно 1) можно
// активировать только по одному за раз, следующий — только когда предыдущий закончится (для леги это
// обычно ~сутки, ровно длительность самого ускорителя, никакого ДОПОЛНИТЕЛЬНОГО кулдауна сверху нет).
async function activateBoosterForRarity(api,name,rarity){
  const rMap=rarityToId();
  const itemId=rMap.get(rarity);
  if(itemId==null)return{ok:false,error:`Неизвестная редкость ускорителя "${rarity}"`};
  const rows=await Inventory.findAll({where:{account:name,type:'booster'}});
  const now=Date.now();
  const isStillActive=r=>r.booster_active_until&&new Date(r.booster_active_until).getTime()>now;
  let activeTypeName=null,activeUntil=null;
  for(const r of rows)if(isStillActive(r)){activeTypeName=r.name;activeUntil=r.booster_active_until;break;}
  const row=rows.find(r=>r.name===String(itemId));
  if(!row||(row.marketable??0)<=0)return{ok:false,error:`Нет доступного ускорителя редкости "${rarity}" в инвентаре`};
  if(activeTypeName!=null&&activeTypeName!==row.name){
    return{ok:false,error:`Уже активен ускоритель другого типа — освободится ${new Date(activeUntil).toLocaleString('ru')}`,blockedUntil:activeUntil};
  }
  const currentlyActive=isStillActive(row)?(row.booster_currently_active??0):0;
  const activeLimit=row.booster_active_limit??0;
  if(currentlyActive>=activeLimit)return{ok:false,error:`Уже активен максимум одновременных этого типа (${activeLimit}) — дождитесь окончания`,blockedUntil:row.booster_active_until};
  let endTime=null;
  const ok=await runAction(name,`booster activate ${row.name} (manual, quest)`,async()=>{
    await sleep(500);
    const r=await api.post('/boosters/activate',{id:Number(row.name)});
    if(r?.end_time)endTime=new Date(r.end_time).getTime();
  });
  if(!ok)return{ok:false,error:'Не удалось активировать ускоритель — см. лог'};
  const prevUntil=isStillActive(row)?new Date(row.booster_active_until).getTime():0;
  await row.update({
    marketable:Math.max(0,(row.marketable??0)-1),
    booster_currently_active:Math.min(currentlyActive+1,activeLimit),
    booster_active_until:endTime?new Date(Math.max(endTime,prevUntil)):row.booster_active_until,
  });
  await logAction(name,'booster_activate',{building_id:row.name,detail:JSON.stringify({manual:true,quest:true})});
  logger.info(`[${name}] [quest] активирован ${row.name} (${rarity}) вручную под квест`);
  // активация меняет end у текущих строек (сверено с бандлом) — перечитываем /progress/, чтобы
  // веб-панель/цикл улучшений увидели свежие времена (тот же приём, что и фоновый цикл выше)
  try{
    const prog=await api.get('/progress/');
    const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
    await CitySnapshot.upsert({account:name,buildings:JSON.stringify(buildings),updated_at:new Date()},{conflictFields:['account']});
  }catch(_){}
  wake(name);
  return{ok:true,name:row.name};
}

module.exports={runBoosterAutomationLoop,getEndsByType,getActiveBoosterInfo,rarityToId,activateBoosterForRarity};
