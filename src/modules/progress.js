'use strict';
const {CityStrategy,GlobalUpgradePlan,CitySnapshot}=require('../db/index');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,fmt,withRetry}=require('../utils/helpers');
const {isCityPaused}=require('../utils/botState');
const cityLive=require('../utils/cityLive');
const {buildingsMap:cityBuildingsMap,upgradeStep,upgradeDuration,effectiveUpgradeDuration,computeCityStats}=require('../web/cityStats');
const {logAction}=require('./cityActionLog');

// Прокачка города управляется пользовательскими целями со страницы "Города" → "Карта" (см.
// web/routes/cityStrategy.js), в порядке приоритета:
//  1. Ручная очередь (CityStrategy.queue: [{x,y}]) — конкретные здания, назначенные "улучшить
//     следующими"; разбирается строителями первой, по одному зданию на строителя, запись
//     вычёркивается из очереди навсегда, как только на неё реально запущен апгрейд.
//  2. Личный план (CityStrategy.targets: [{x,y,target_level}]) — цель привязана к КОНКРЕТНОЙ
//     клетке, не к семье здания, иначе один клик по карте задавал бы цель сразу всем экземплярам
//     семьи.
//  3. Общий план по семействам (GlobalUpgradePlan: [{family_id,target_level}]) — не привязан к
//     аккаунту, действует на любой город, где есть здание этого семейства, НО только если для
//     конкретной клетки нет личной цели (см. resolveEffectiveTargets ниже).
// Раньше здесь была автоматика по эталонному плану фазы (config/city-refplans.json) — убрана
// целиком по решению пользователя: позиция здания ни на что не влияет (все формулы — cityStats.js
// — чистые функции количества/уровня, без позиционной составляющей), поэтому сопоставление сетки
// решало не существующую для игры задачу. Строительство/перемещение/снос теперь разовые живые
// действия (см. cityStrategy.js), сюда не относятся — здесь только цикл улучшений.

// Прогресс стройки (для веб-панели): раньше пытались сами запоминать момент старта апгрейда — но
// это не работало для улучшений, запущенных НАПРЯМУЮ в игре (не через бота). Оказалось, не нужно:
// в бандле игры (deserialize(): s.constructionBegin=n.start?...) видно, что сырой ответ /progress/
// уже содержит поле "start" (точное время начала стройки) наравне с "end" — сервер сам его отдаёт,
// вне зависимости от того, кто запустил улучшение. Раз мы просто прокидываем buildings как есть
// (JSON.stringify(current) без фильтрации полей), start уже сохраняется в CitySnapshot сам по себе —
// клиент считает duration=end-start точно, без формул и без знания о бустах ускорения вообще.

// та же формула, что modules/session.js _saveStats использует для Account.profit (params
// отсортированы от новейшего к старейшему, "текущее" — последний элемент) — переиспользуем уже
// полученный ответ /progress/ вместо отдельного запроса/чтения БД для проверки Пути мэра.
function extractCurrentProfit(prog){
  const params=Array.isArray(prog?.progress?.params)?prog.progress.params:[];
  const v=params[params.length-1]?.profit;
  return (typeof v==='number'&&isFinite(v))?v:null;
}

// prog.progress.unlocked_sections — игра отдаёт это готовым прямо в /progress/ (сверено реверсом
// бандла + живым запросом 22.07.2026), никакого отдельного запроса не нужно, см. CitySnapshot.
function unlockedSectionsOf(prog){
  const list=prog?.progress?.unlocked_sections;
  return JSON.stringify(Array.isArray(list)?list:[]);
}

function describeError(e){
  const status=e?.response?.status;
  const statusText=e?.response?.statusText;
  const data=e?.response?.data;
  const body=typeof data==='string'?data:(data?JSON.stringify(data):'');
  return [e?.message,status?`status ${status}`:'',statusText||'',body].filter(Boolean).join(': ');
}

async function loadGuildBonuses(api){
  try{
    const d=await api.get('/guilds/benefits');
    return{
      discount:Number(d?.benefits?.upgrades_discount||0),
      // "Камни Основания" (столичное здание гильдии) — +N строителей всем участникам. Подтверждено
      // реверсом бандла (additional_builder в том же объекте benefits), но НЕ прибавляется клиентом
      // игры к счётчику строителей нигде явно — по факту у аккаунтов с этим бонусом /progress/
      // отдаёт builders БЕЗ него, поэтому прибавляем сами.
      additionalBuilder:Math.floor(Number(d?.benefits?.additional_builder)||0),
      // "бонус от столицы" на время улучшений (по факту дают столичные здания гильдии, напр. Часовая
      // башня) — сверено с бандлом: S0().upgradeTimeReduction=1-reduced_upgrade_times, множитель
      // применяется к базовой длительности улучшения (см. cityStats.js effectiveUpgradeDuration).
      reducedUpgradeTimes:Number(d?.benefits?.reduced_upgrade_times||0),
    };
  }catch(_){return{discount:0,additionalBuilder:0,reducedUpgradeTimes:0};}
}

// бонус строителей и множитель цены улучшений от надетых в кабинете мэра политик (/policies/cabinet,
// см. policyEffects.ts) — один живой запрос на оба эффекта, каждая инстанция уже несёт готовые к
// применению значения (масштабированные по уровню политики), без доп. вычислений.
// upgradeCostMultiplier — сверено с бандлом игры (getPriceForLevel(): basePriceFormula(n)·
// Gc().upgradeCostMultiplier, а ПОВЕРХ этого при самом апгрейде (levelUp()) умножается ЕЩЁ и на
// гильдийскую скидку S0().upgradeDiscount — те же ДВА независимых множителя, что и у цены постройки
// (build_cost политик + building_purchases_discount гильдии), просто с другой парой полей).
async function loadPolicyEffects(api){
  try{
    const cab=await api.get('/policies/cabinet');
    let builderBonus=0,upgradeCostSum=0,constructionTimeSum=0;
    for(const slot of cab?.slots||[]){
      for(const e of slot?.instance?.effects||[]){
        if(e?.stat==='concurrent_builders'&&e?.mode==='add')builderBonus+=Number(e.value)||0;
        if(e?.stat==='upgrade_cost'&&e?.mode==='mult')upgradeCostSum+=Number(e.value)||0;
        // constructionTimeMultiplier — сверено с бандлом (Gc().constructionTimeMultiplier=
        // policyMultiplier('construction_time')), та же схема, что upgrade_cost/build_cost
        if(e?.stat==='construction_time'&&e?.mode==='mult')constructionTimeSum+=Number(e.value)||0;
      }
    }
    return{builderBonus:Math.floor(builderBonus),upgradeCostMultiplier:Math.max(0,1+upgradeCostSum),constructionTimeMultiplier:Math.max(0,1+constructionTimeSum)};
  }catch(_){return{builderBonus:0,upgradeCostMultiplier:1,constructionTimeMultiplier:1};}
}

// текущий активный ускоритель + флаг "стоит автопродление" — для прогноза (вкладка "Прогноз"). Если
// автопродление включено, бонус действует не бесконечно, а ровно на столько, на сколько реально
// хватит уже купленных ускорителей этого типа: конец текущего инстанса + (сколько ещё штук в
// наличии) × (длительность одной активации). Как только запас закончится — бот больше нечем будет
// продлевать, дальше улучшения снова идут без ускорения.
async function loadConstructionBoostMods(api,account){
  try{
    const{getActiveBoosterInfo}=require('./boosterAutomation');
    const info=await getActiveBoosterInfo(api);
    if(!info?.name)return null;
    const{BoosterAutomation,Inventory}=require('../db/index');
    const auto=await BoosterAutomation.findOne({where:{account,booster_name:info.name}});
    if(!auto?.enabled)return{multiplier:info.multiplier,endsAt:info.endsAt};
    const[row,storage]=await Promise.all([
      Inventory.findOne({where:{account,name:info.name,type:'booster'}}),
      api.get('/storage/allitemdata').catch(()=>null),
    ]);
    // активировать можно и marketable, и locked (soulbound/непродаваемые) экземпляры — locked
    // только запрещает продажу на рынке, на использование по прямому назначению не влияет
    const available=Math.max(0,(Number(row?.marketable)||0)+(Number(row?.locked)||0));
    const rawItems=storage?.items;
    const items=Array.isArray(rawItems)?rawItems:Object.values(rawItems||{});
    const item=items.find(i=>String(i?.item_id??i?.id)===String(info.name));
    // длительность ОДНОЙ активации — отдаёт сама игра (item.booster.duration), в наносекундах (та
    // же единица, что и duration_ns в /shop-live/boosters, см. web/routes/economy.js normalizeShopOffers)
    const perInstanceMs=item?.booster?.duration?Number(item.booster.duration)/1e6:0;
    if(!available||!perInstanceMs)return{multiplier:info.multiplier,endsAt:info.endsAt};
    return{multiplier:info.multiplier,endsAt:info.endsAt+available*perInstanceMs};
  }catch(_){return null;}
}

// личный план (targets) + ручная очередь (queue) + запланированные реконструкции (reconstructPlan)
// аккаунта, из одной строки CityStrategy
async function loadStrategy(account){
  try{
    const row=await CityStrategy.findOne({where:{account}});
    let targets=[],queue=[],reconstructPlan=[];
    if(row?.targets){const arr=JSON.parse(row.targets);if(Array.isArray(arr))targets=arr;}
    if(row?.queue){const arr=JSON.parse(row.queue);if(Array.isArray(arr))queue=arr;}
    if(row?.reconstruct_plan){const arr=JSON.parse(row.reconstruct_plan);if(Array.isArray(arr))reconstructPlan=arr;}
    return{targets,queue,reconstructPlan};
  }catch(_){return{targets:[],queue:[],reconstructPlan:[]};}
}

// общий (глобальный) план по семействам зданий — не привязан к аккаунту, см. web/routes/cityStrategy.js
async function loadGlobalPlan(){
  try{
    const rows=await GlobalUpgradePlan.findAll();
    const m=new Map();
    for(const r of rows){
      const lvl=Number(r.target_level)||0;
      if(r.family_id&&lvl)m.set(r.family_id,lvl);
    }
    return m;
  }catch(_){return new Map();}
}

// сводит личный план (по клетке) и общий план (по ТОЧНОМУ id здания) в единый список целей по
// клетке — личная цель для клетки всегда важнее общего правила. Общий план матчится по ТОЧНОМУ b.id
// (без нормализации через familyId) — звёздные тиры настраиваются НЕЗАВИСИМО от базового здания и
// друг от друга (см. GlobalUpgradePlan.tsx): правило "Городской банк" применяется, пока здание не
// эволюционировало ни в один тир, "Городской банк ★2" — отдельное правило, включается только когда
// b.id реально сменился на этот тир. Если для конкретного тира правила нет — общий план для него
// просто не действует (никакого наследования между тирами).
function resolveEffectiveTargets(current,personalTargets,globalPlan){
  const personal=new Map(personalTargets.map(t=>[`${Number(t.x)},${Number(t.y)}`,t]));
  const result=[...personalTargets];
  if(!globalPlan.size)return result;
  for(const b of current){
    const key=`${Number(b.x)},${Number(b.y)}`;
    if(personal.has(key))continue; // личная цель для этой клетки уже задана — общий план её не трогает
    const lvl=globalPlan.get(b.id);
    if(lvl)result.push({x:b.x,y:b.y,target_level:lvl});
  }
  return result;
}

// выбор кандидатов на апгрейд: сначала ручная очередь (в порядке очереди — конкретные здания,
// назначенные "улучшить следующими"), затем цели плана (личный + общий, уже сведённые
// resolveEffectiveTargets). Для целей плана — ищем ЗДАНИЕ НА ЭТОЙ КОНКРЕТНОЙ КЛЕТКЕ, ниже целевого
// уровня и не занятое стройкой, сортируем по времени улучшения от меньшего к большему (формула —
// сверена с бандлом getBaseUpgradeDuration, см. cityStats.js upgradeDuration) — короткие апгрейды
// стартуют первыми, чтобы строители быстрее возвращались в оборот; при равном времени — по
// возрастанию текущего уровня здания (сначала ур.3, потом ур.4). Бюджет общий для очереди и плана
// (coins*0.8): если на очередного кандидата не хватает — просто переходим к следующему по списку,
// не прерывая набор. Возвращает {picked,consumedQueueKeys} — consumedQueueKeys нужно вычеркнуть из
// персистентной очереди (она одноразовая, в отличие от плана, который остаётся до достижения цели).
function pickStrategyTargets(current,queue,targets,buildingsMap,discount,policyMult,freeB,coins,now=Date.now()){
  const budget=coins*0.8;
  const result=[],consumedQueueKeys=[];
  // одна и та же клетка не может получить два запуска апгрейда за один проход (после первого она
  // "занята стройкой" только в глазах игры на СЛЕДУЮЩЕЙ загрузке /progress/, а не прямо сейчас в
  // уже прочитанном current) — актуально для очереди: одно и то же здание можно поставить в неё
  // несколько раз подряд (несколько последовательных апгрейдов), но выдать ему нужно СТРОГО по
  // одному апгрейду за заход, остальные его повторы в этом же проходе просто пропускаем.
  const pickedKeys=new Set();
  let left=budget;

  for(const q of queue){
    if(result.length>=freeB)break;
    const key=`${Number(q.x)},${Number(q.y)}`;
    if(pickedKeys.has(key))continue; // это же здание уже получило апгрейд в этом проходе — ждём следующего захода
    const b=current.find(c=>Number(c.x)===Number(q.x)&&Number(c.y)===Number(q.y));
    if(!b)continue; // здание снесено/недостижимо — оставляем решение об удалении вызывающей стороне
    if(b.end&&new Date(b.end).getTime()>now)continue; // уже строится — попробуем в следующий заход
    const lvl=Number(b.level||0);
    const info=buildingsMap.get(b.id);
    if(!info)continue;
    const price=Math.round(upgradeStep(info,lvl)*policyMult*(1-discount));
    if(price>left)continue; // бюджета не хватает сейчас — остаётся в очереди на следующий заход
    result.push({...b,upgrade_price:price});
    consumedQueueKeys.push(key);
    pickedKeys.add(key);
    left-=price;
  }

  const candidates=[];
  for(const t of targets){
    const key=`${Number(t.x)},${Number(t.y)}`;
    if(pickedKeys.has(key))continue; // уже улучшается по очереди в этом же проходе
    const targetLevel=Number(t.target_level)||0;
    if(!targetLevel)continue;
    const b=current.find(c=>Number(c.x)===Number(t.x)&&Number(c.y)===Number(t.y));
    if(!b)continue; // здание снесено/перемещено куда-то ещё — цель тихо недостижима
    if(b.end&&new Date(b.end).getTime()>now)continue;
    const lvl=Number(b.level||0);
    if(lvl>=targetLevel)continue;
    const info=buildingsMap.get(b.id);
    if(!info)continue;
    candidates.push({key,b,info,lvl});
  }
  candidates.sort((x,y)=>upgradeDuration(x.info,x.lvl)-upgradeDuration(y.info,y.lvl)||x.lvl-y.lvl);
  for(const{key,b,info,lvl}of candidates){
    if(result.length>=freeB)break;
    if(pickedKeys.has(key))continue; // несколько personal/global-целей на одну клетку в одном проходе не бывает, но на всякий случай
    const price=Math.round(upgradeStep(info,lvl)*policyMult*(1-discount));
    if(price>left)continue; // не хватает баланса — переходим к следующему по времени кандидату
    result.push({...b,upgrade_price:price});
    pickedKeys.add(key);
    left-=price;
  }
  return{picked:result,consumedQueueKeys};
}

// прогноз действий бота (страница "Карта города" → вкладка "Прогноз") — ЧИСТАЯ функция, без единого
// API-вызова: дискретно-событийная симуляция, которая на каждом шаге вызывает ТЕ ЖЕ
// resolveEffectiveTargets/pickStrategyTargets, что и реальный runProgress — поэтому показывает
// буквально те решения, которые бот примет (очередь → личный план → общий план, тот же бюджет
// coins*0.8, та же сортировка по времени апгрейда), а не отдельную "похожую" эвристику.
// cityProfitPerHour — накопление монет со временем (computeCityStats(current,buildingsMap).profit
// из web/cityStats.js), иначе прогноз остановился бы на первом же апгрейде, на который прямо сейчас
// не хватает денег. НЕ ограничено фиксированным горизонтом времени (раньше было 3 суток) — считает
// ВСЕ запланированные улучшения (очередь+личный+общий план), пока они не будут исчерпаны либо не
// упрёмся в MAX_ITERATIONS (защита от зависания, а не намеренный лимит). durationMods —
// {reducedUpgradeTimes, constructionTimeMultiplier, booster:{multiplier,endsAt}|null}, см.
// cityStats.js effectiveUpgradeDuration — те же бонусы, что реально действуют в игре на время стройки.
function simulateFutureActions(current,queue,personalTargets,globalPlan,buildingsMap,discount,policyMult,builders,coins,cityProfitPerHour,durationMods=null){
  const sim=current.map(b=>({...b,_busyUntil:b.end?new Date(b.end).getTime():0}));
  let simQueue=queue.map(q=>({...q}));
  let simCoins=coins,simTime=Date.now();
  const events=[];
  const MAX_ITERATIONS=5000;
  let iterations=0;

  while(iterations++<MAX_ITERATIONS){
    // "завершаем" стройки, чьё время уже прошло к этому моменту симуляции — иначе повторные записи
    // в очереди того же здания считались бы с одного и того же устаревшего уровня
    for(const b of sim){
      if(b._busyUntil&&b._busyUntil<=simTime){b.level=(Number(b.level)||0)+1;b._busyUntil=0;}
    }
    const busyCount=sim.filter(b=>b._busyUntil>simTime).length;
    const free=builders-busyCount;
    if(free<=0){
      const busyUntils=sim.filter(b=>b._busyUntil>simTime).map(b=>b._busyUntil);
      if(!busyUntils.length)break; // строителей нет вообще — дальше нечего прогнозировать
      simTime=Math.min(...busyUntils);
      continue;
    }
    // представление current для pickStrategyTargets/resolveEffectiveTargets — b.end как ISO-строка,
    // ровно как приходит с живого /progress/, чтобы код не пришлось дублировать под "плоские числа"
    const currentView=sim.map(b=>({...b,end:b._busyUntil>simTime?new Date(b._busyUntil).toISOString():null}));
    const effectiveTargets=resolveEffectiveTargets(currentView,personalTargets,globalPlan);
    const{picked,consumedQueueKeys}=pickStrategyTargets(currentView,simQueue,effectiveTargets,buildingsMap,discount,policyMult,free,simCoins,simTime);
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
      // нечего запускать прямо сейчас — если дело в деньгах (а не в отсутствии целей вообще),
      // прокручиваем время вперёд с накоплением прибыли и пробуем снова
      if(cityProfitPerHour>0){simTime+=3600000;simCoins+=cityProfitPerHour;continue;}
      break; // денег больше не будет и целей нет — дальше нечего прогнозировать
    }
    for(const b of picked){
      const info=buildingsMap.get(b.id);
      const lvl=Number(b.level||0);
      const durationMs=info?Math.round(effectiveUpgradeDuration(info,lvl,durationMods,simTime)*1000):0;
      const idx=sim.findIndex(s=>Number(s.x)===Number(b.x)&&Number(s.y)===Number(b.y));
      if(idx===-1)continue;
      sim[idx]._busyUntil=simTime+durationMs;
      simCoins-=b.upgrade_price||0;
      events.push({x:b.x,y:b.y,building_id:b.id,level_from:lvl,level_to:lvl+1,start:simTime,end:simTime+durationMs,duration_ms:durationMs});
    }
  }
  return events.sort((a,b)=>a.start-b.start);
}

async function runProgressAction(name,label,work){
  try{
    await globalLock.run(work);
    return true;
  }catch(e){
    logger.error(`[${name}] [progress] ${label} failed: ${describeError(e)}`);
    return false;
  }
}

// запланированные реконструкции (вкладка "Реконструкция" → "Запланировать", CityStrategy.
// reconstruct_plan: [{x,y}]) — не привязаны к строителям (реконструкция не занимает строителя,
// это мгновенный сброс уровня, не стройка), поэтому проверяются НЕЗАВИСИМО от builders/targets:
// как только здание на этой клетке достигнет required_lvl и не будет занято текущей стройкой,
// сразу шлём [{type:'reconstruct',id,x,y}] и вычёркиваем запись (одноразовая, как и очередь
// улучшений). Если условие ещё не выполнено — запись просто остаётся ждать следующего вызова.
async function runPendingReconstructions(api,name,current,buildingsMap){
  let plan;
  try{
    const row=await CityStrategy.findOne({where:{account:name}});
    plan=row?.reconstruct_plan?JSON.parse(row.reconstruct_plan):[];
    if(!Array.isArray(plan))plan=[];
  }catch(_){return false;}
  if(!plan.length)return false;
  const now=Date.now();
  const remaining=[];
  let changed=false;
  for(const p of plan){
    const b=current.find(c=>Number(c.x)===Number(p.x)&&Number(c.y)===Number(p.y));
    if(!b)continue; // здание снесено/перемещено куда-то ещё — план на него тихо недостижим
    const info=buildingsMap.get(b.id);
    if(!info||!info.is_reconstructible||info.required_lvl==null)continue; // здание больше не реконструируемо (напр. уже эволюционировало) — план снят
    const busy=b.end&&new Date(b.end).getTime()>now;
    if(busy||Number(b.level||0)<info.required_lvl){remaining.push(p);continue;} // ещё не готово — ждём
    const ok=await runProgressAction(name,`reconstruct ${b.id} at (${b.x},${b.y})`,async()=>{
      await sleep(1000);
      await api.post('/progress/',[{type:'reconstruct',id:b.id,x:b.x,y:b.y}]);
      logger.info(`[${name}] [progress] reconstruct ${b.id} at (${b.x},${b.y}) — план выполнен`);
    });
    if(ok){
      changed=true;
      await logAction(name,'reconstruct',{x:b.x,y:b.y,building_id:b.id,level_from:Number(b.level||0)});
    }
    else remaining.push(p); // не получилось (напр. не хватило components) — попробуем в следующий заход
  }
  if(remaining.length!==plan.length){
    try{
      const row=await CityStrategy.findOne({where:{account:name}});
      if(row)await row.update({reconstruct_plan:JSON.stringify(remaining),updated_at:new Date()});
    }catch(e){logger.warn(`[${name}] [progress] не удалось сохранить план реконструкций: ${e.message}`);}
  }
  return changed;
}

async function runProgress(api,name,opts={}){
  const{upgrading=true}=opts;
  if(isCityPaused()){logger.info(`[${name}] [progress] прокачка на паузе — пропускаю`);return;}
  try{
    const buildingsMap=cityBuildingsMap();
    const[{discount,additionalBuilder},{builderBonus:policyBuilderBonus,upgradeCostMultiplier}]=await Promise.all([loadGuildBonuses(api),loadPolicyEffects(api)]);
    const builderBonus=additionalBuilder+policyBuilderBonus;
    let prog;
    try{
      prog=await withRetry(()=>api.get('/progress/'),2,1500,`${name} progress load`);
    }catch(e){
      logger.error(`[${name}] [progress] load failed: ${describeError(e)}`);
      return;
    }
    const data=prog?.progress?.data||{},coins=data.coins||0,builders=(prog?.progress?.builders||1)+builderBonus;
    let current=Array.isArray(data.buildings)?data.buildings:[];
    try{await CitySnapshot.upsert({account:name,buildings:JSON.stringify(current),unlocked_sections:unlockedSectionsOf(prog),updated_at:new Date()},{conflictFields:['account']});}catch(_){}
    cityLive.broadcast(name,current);
    const busy=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now()).length;
    logger.info(`[${name}] [progress] coins: ${fmt(coins)} | builders: ${builders-busy}/${builders}${builderBonus?` (+${builderBonus} бонус)`:''} | buildings: ${current.length} | discount: ${Math.round(discount*100)}%`);

    // Путь мэра — синхронизирован с этим же живым /progress/ (никакого отдельного запроса к игре,
    // см. modules/journey.js): проверяем на каждом свежем ответе, в т.ч. если ниже дальше цикл
    // выйдет рано (нет целей улучшений) — профит всё равно мог измениться с прошлого раза.
    if(require('../config').getConfig().features.journey){
      try{await require('./journey').runJourney(api,name,extractCurrentProfit(prog));}catch(e){logger.warn(`[${name}] [progress] journey check: ${e.message}`);}
    }

    // запланированные реконструкции не занимают строителя (не стройка, а мгновенный сброс) —
    // проверяются НЕЗАВИСИМО от builders/targets, поэтому делаем это до всех ранних return ниже
    if(await runPendingReconstructions(api,name,current,buildingsMap)){
      try{await CitySnapshot.upsert({account:name,buildings:JSON.stringify(current),unlocked_sections:unlockedSectionsOf(prog),updated_at:new Date()},{conflictFields:['account']});}catch(_){}
      cityLive.broadcast(name,current);
    }

    const{targets:personalTargets,queue:initialQueue}=await loadStrategy(name);
    const globalPlan=await loadGlobalPlan();
    if(!personalTargets.length&&!initialQueue.length&&!globalPlan.size){
      logger.info(`[${name}] [progress] нет настроенных целей улучшений — простой`);
      return;
    }
    if(!upgrading||builders<=0)return;
    let queue=initialQueue.slice();
    const persistQueue=async()=>{
      try{
        const row=await CityStrategy.findOne({where:{account:name}});
        if(row)await row.update({queue:JSON.stringify(queue),updated_at:new Date()});
      }catch(e){logger.warn(`[${name}] [progress] не удалось сохранить очередь: ${e.message}`);}
    };

    const refreshState=async()=>{
      const latest=await withRetry(()=>api.get('/progress/'),2,1500,`${name} progress refresh`);
      const latestData=latest?.progress?.data||{};
      current=Array.isArray(latestData.buildings)?latestData.buildings:[];
      // раньше CitySnapshot писался только ОДИН раз в начале цикла (см. выше) — пока бот улучшает
      // здания несколько итераций подряд (ждёт строителей, запускает следующее и т.д.), веб-панель
      // (таблица городов, карта города) весь этот период показывала устаревший снимок из начала
      // цикла, не видя уже запущенные апгрейды. Пишем свежий снимок при каждом обновлении состояния,
      // а не только при первой загрузке.
      try{await CitySnapshot.upsert({account:name,buildings:JSON.stringify(current),unlocked_sections:unlockedSectionsOf(latest),updated_at:new Date()},{conflictFields:['account']});}catch(_){}
      cityLive.broadcast(name,current);
      // тот же живой ответ — тут профит мог измениться относительно прошлого refreshState (именно
      // здесь цикл узнаёт о завершившемся апгрейде), см. комментарий у первого вызова выше
      if(require('../config').getConfig().features.journey){
        try{await require('./journey').runJourney(api,name,extractCurrentProfit(latest));}catch(e){logger.warn(`[${name}] [progress] journey check: ${e.message}`);}
      }
      return{coins:latestData.coins||0,builders:(latest?.progress?.builders||(builders-builderBonus))+builderBonus};
    };

    while(true){
      if(isCityPaused()){logger.info(`[${name}] [progress] прокачка на паузе — выхожу из цикла`);break;}
      const state=await refreshState();
      await runPendingReconstructions(api,name,current,buildingsMap); // здание могло дойти до required_lvl прямо во время этого цикла апгрейдов
      const busyNow=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now()).length;
      const free=Math.max(0,state.builders-busyNow);
      if(free<=0){
        const nextEnd=current
          .filter(b=>b.end&&new Date(b.end).getTime()>Date.now())
          .map(b=>new Date(b.end).getTime())
          .sort((a,b)=>a-b)[0];
        const waitMs=nextEnd?Math.max(5000,nextEnd-Date.now()+2000):30000;
        logger.info(`[${name}] [progress] builders busy, waiting ${Math.ceil(waitMs/1000)}s`);
        await sleep(waitMs);
        continue;
      }
      const effectiveTargets=resolveEffectiveTargets(current,personalTargets,globalPlan);
      const{picked,consumedQueueKeys}=pickStrategyTargets(current,queue,effectiveTargets,buildingsMap,discount,upgradeCostMultiplier,free,state.coins);
      if(consumedQueueKeys.length){
        // ВАЖНО: одно и то же здание может стоять в очереди НЕСКОЛЬКО раз подряд (несколько
        // последовательных апгрейдов) — consumedQueueKeys содержит ключ клетки РОВНО столько раз,
        // сколько её реально запустили в этом проходе (обычно 1). Раньше здесь стоял Set-based
        // filter — он вычёркивал ВСЕ записи с таким ключом разом, а не только использованную,
        // из-за чего при частичном разборе очереди с повторами (напр. 5× одно и то же здание,
        // а сейчас выполнился только 1 апгрейд) остальные 4 повтора того же здания тоже пропадали
        // из персистентной очереди. Убираем строго по ОДНОЙ записи на каждый потреблённый ключ.
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
          logger.info(`[${name}] [progress] нет доступных апгрейдов по целям, жду ${Math.ceil(waitMs/1000)}s строителя`);
          await sleep(waitMs);
          continue;
        }
        logger.info(`[${name}] [progress] цели сейчас недостижимы (нет зданий/не хватает денег) — завершаю цикл`);
        break;
      }
      let launched=false;
      for(const b of picked){
        const nextLvl=(Number(b.level)||1)+1;
        const ok=await runProgressAction(name,`upgrade ${b.id} at (${b.x},${b.y}) to lvl ${nextLvl}`,async()=>{
          await sleep(500);
          const r=await api.post('/progress/',[{type:'upgrade',id:b.id,x:b.x,y:b.y}]);
          if(r?.coins!==undefined)logger.info(`[${name}] [progress] upgraded ${b.id} | LVL ${b.level} -> ${nextLvl}`);
        });
        if(ok){
          launched=true;
          const info=buildingsMap.get(b.id);
          await logAction(name,'upgrade',{x:b.x,y:b.y,building_id:b.id,level_from:Number(b.level||0),level_to:nextLvl,duration_ms:info?Math.round(upgradeDuration(info,Number(b.level||0))*1000):null});
          try{await refreshState();}catch(e){logger.error(`[${name}] [progress] refresh failed after upgrade: ${describeError(e)}`);}
        }
        await sleep(500);
      }
      if(!launched){
        logger.info(`[${name}] [progress] апгрейды не запустились, жду 30s`);
        await sleep(30000);
      }
    }
  }catch(e){logger.error(`[${name}] [progress] ${describeError(e)}`);}
}
module.exports={
  runProgress,
  // экспортировано для web/routes/cityStrategy.js (прогноз) — переиспользуют ту же логику, что
  // реальный цикл, вместо дублирования
  loadStrategy,loadGlobalPlan,loadGuildBonuses,loadPolicyEffects,loadConstructionBoostMods,
  resolveEffectiveTargets,pickStrategyTargets,simulateFutureActions,
};
