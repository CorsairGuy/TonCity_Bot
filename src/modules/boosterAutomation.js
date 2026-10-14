'use strict';
// Ускорители из событийного магазина приходят НЕПРОДАВАЕМЫМИ (marketable=0, locked=1): продать
// нельзя, а активировать — можно. Поэтому «сколько есть» = свободные + непродаваемые, а списываем
// сначала свободные (их не жалко), и только потом soulbound.
function boosterStock(row){return (row?.marketable??0)+(row?.locked??0);}
function spendOne(row){
  const free=row?.marketable??0;
  return free>0
    ?{marketable:free-1}
    :{locked:Math.max(0,(row?.locked??0)-1)};
}

const fs=require('fs'),path=require('path');
const {Inventory,BoosterAutomation,BoosterQueue,CitySnapshot}=require('../db/index');
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');
const {globalLock}=require('../utils/lock');
const {logAction}=require('./cityActionLog');
const {waitOrWake,wake}=require('../utils/cityWake');
const itemCache=require('../utils/itemCache');
const accountLoops=require('../utils/accountLoops');
// та же выборка, что в modules/progress.js: список разблокированных секций из /progress/
// см. modules/progress.js: «поля нет» ≠ «ничего не разблокировано» — пустой массив запер бы весь
// город на карте, поэтому при отсутствии списка колонку не трогаем вовсе
const unlockedSectionsOf=prog=>Array.isArray(prog?.progress?.unlocked_sections)?JSON.stringify(prog.progress.unlocked_sections):undefined;
const citySnapshotRow=(name,buildings,prog)=>{
  const sections=unlockedSectionsOf(prog);
  const row={account:name,buildings:JSON.stringify(buildings),updated_at:new Date()};
  if(sections!==undefined)row.unlocked_sections=sections;
  return row;
};

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

// ВЫБОР УСКОРИТЕЛЯ ДЛЯ РАСЧЁТА ВРЕМЕНИ — ровно как в игре (реверс бандла entry-*.js,
// getUpgradeDuration городского здания): `const s=r.boosters||[], u=s[s.length-1]` — берётся
// ПОСЛЕДНИЙ элемент массива, а НЕ самый долгий по end_time и НЕ произведение всех активных.
// getActiveBoosterInfo выше выбирает максимум по end_time — это правильно для автоматики (когда
// освободится слот), но для длительности стройки давало ДРУГОЙ множитель, если активно несколько
// ускорителей (в т.ч. серверный, выданный ивентом).
async function getDurationBoosterInfo(api){
  const rMap=rarityToId();
  const raw=await api.get('/boosters/active').catch(()=>[]);
  const active=Array.isArray(raw)?raw:(raw?.boosters||[]);
  if(!active.length)return null;
  const last=active[active.length-1];
  const endMs=last?.end_time?new Date(last.end_time).getTime():0;
  if(!endMs)return null;
  return{name:rMap.get(last.rarity)??null,multiplier:Number(last.multiplier)||1,endsAt:endMs,count:active.length};
}

async function runBoosterAutomationLoop(api,name,accountId){
  logger.info(`[${name}] [booster-loop] started`);
  while(true){
    try{
      if(accountLoops.isStopped(accountId)){logger.info(`[${name}] [booster-loop] аккаунт удалён, останавливаюсь`);return;}
      // ОЧЕРЕДЬ активации: строка = ОДИН экземпляр, повторы одного типа разрешены («мифик, мифик,
      // лега»). Идём строго по pos; каждая успешно активированная позиция УДАЛЯЕТСЯ (расходуется).
      // Порядок = приоритет: если первая позиция сейчас недоступна (занят слот или активен другой
      // тип), ждём именно её и следующие позиции не трогаем вообще — иначе заданная пользователем
      // последовательность нарушалась бы. Пропускаем только позиции, которых вообще нет в инвентаре
      // или запас которых кончился (иначе застрянем).
      const queueRows=await BoosterQueue.findAll({where:{account:name},order:[['pos','ASC'],['id','ASC']]});
      if(!queueRows.length){await waitOrWake(name,6*60*60*1000);continue;}

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
      // идём ПО ОЧЕРЕДИ, а не по инвентарю: порядок позиций и есть приоритет
      for(const qrow of queueRows){
        const row=rows.find(r=>r.name===qrow.booster_name);
        if(!row){await qrow.destroy().catch(()=>{});continue;} // типа нет в инвентаре — позиция мертва
        const activeLimit=row.booster_active_limit??0;
        const stillActive=isStillActive(row);
        const untilMs=row.booster_active_until?new Date(row.booster_active_until).getTime():0;
        const currentlyActive=stillActive?(row.booster_currently_active??0):0;
        if(activeTypeName!=null&&activeTypeName!==row.name){
          // заблокировано ДРУГИМ активным типом — блокировка снимется, когда закончится он
          // Дальше по очереди НЕ идём: иначе следующая позиция того же типа, что активен сейчас,
          // обходила бы стоящую впереди («лега, эпик×4» при активном эпике включал эпик, а лега ждала)
          const blocker=rows.find(r=>r.name===activeTypeName);
          if(blocker?.booster_active_until)soonest=Math.min(soonest??Infinity,new Date(blocker.booster_active_until).getTime());
          break;
        }
        if(currentlyActive<activeLimit){
          if(boosterStock(row)<=0){await qrow.destroy().catch(()=>{});continue;} // запас кончился — позиция мертва
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
              ...spendOne(row),
              booster_currently_active:Math.min(currentlyActive+1,activeLimit),
              booster_active_until:endTime?new Date(Math.max(endTime,prevUntil)):row.booster_active_until,
            });
            await logAction(name,'booster_activate',{building_id:row.name,detail:JSON.stringify({auto:true,queue:true})});
            await qrow.destroy().catch(()=>{});   // позиция израсходована
            activeTypeName=row.name;              // теперь активен этот тип — другие за ним ждут его окончания
            logger.info(`[${name}] [booster-loop] активирован ${row.name} (из очереди)`);
            continue;
          }
          break;   // не удалось — повторим ту же позицию в следующий проход, следующие не трогаем
        }
        // на лимите — ждём именно эту позицию: ближайшее освобождение = конец уже активного этого типа
        if(stillActive)soonest=Math.min(soonest??Infinity,untilMs);
        break;
      }

      if(activatedAny){
        // активация меняет end у текущих строек на стороне игры (сверено с бандлом:
        // Ht().updateConstructionTimesForBooster()) — перечитываем /progress/, чтобы веб-панель и
        // цикл улучшений увидели свежие времена, и будим его пересчитать время пробуждения
        try{
          const prog=await api.get('/progress/');
          const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
          // unlocked_sections пишем ВСЕГДА вместе со зданиями: если строка снимка создаётся здесь
          // первой (новая установка/новый аккаунт — этот цикл может отработать раньше цикла
          // прокачки), поле осталось бы пустым, и карта показала бы ВСЕ секции запертыми
          await CitySnapshot.upsert(citySnapshotRow(name,buildings,prog),{conflictFields:['account']});
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
  const row=rows.find(r=>r.name===String(itemId));
  if(!row||boosterStock(row)<=0)return{ok:false,error:`Нет доступного ускорителя редкости "${rarity}" в инвентаре`};
  const activeLimit=row.booster_active_limit??0;
  // Слоты считаем по РЕАЛЬНОМУ списку активных инстансов из игры, а не по одному полю
  // Inventory.booster_active_until. Причина: у типа бывает несколько слотов (например 4 у
  // эпических), и они освобождаются ПО ОДНОМУ, по мере истечения каждого. В БД же хранится только
  // МАКСИМАЛЬНОЕ время окончания, а booster_currently_active не уменьшается сам — из-за этого
  // раньше при 4/4 занятых кнопка отказывала до истечения ПОСЛЕДНЕГО, хотя первый слот
  // освобождался гораздо раньше и активировать уже было можно.
  const endsByType=await getEndsByType(api);
  const aliveOf=id=>(endsByType.get(String(id))||endsByType.get(Number(id))||[]).filter(t=>t>now);
  let otherUntil=0;
  for(const[id,arr]of endsByType){
    if(String(id)===String(itemId))continue;
    for(const t of arr)if(t>now&&t>otherUntil)otherUntil=t;
  }
  if(otherUntil>0)
    return{ok:false,error:`Уже активен ускоритель другого типа — освободится ${new Date(otherUntil).toLocaleString('ru')}`,blockedUntil:new Date(otherUntil).toISOString()};
  const mine=aliveOf(itemId);
  if(activeLimit>0&&mine.length>=activeLimit){
    const firstFree=Math.min(...mine);   // ждём ПЕРВЫЙ освобождающийся слот, не последний
    return{ok:false,error:`Заняты все слоты этого типа (${mine.length}/${activeLimit}) — первый освободится ${new Date(firstFree).toLocaleString('ru')}`,blockedUntil:new Date(firstFree).toISOString()};
  }
  const currentlyActive=mine.length;
  let endTime=null;
  const ok=await runAction(name,`booster activate ${row.name} (manual, quest)`,async()=>{
    await sleep(500);
    const r=await api.post('/boosters/activate',{id:Number(row.name)});
    if(r?.end_time)endTime=new Date(r.end_time).getTime();
  });
  if(!ok)return{ok:false,error:'Не удалось активировать ускоритель — см. лог'};
  const prevUntil=mine.length?Math.max(...mine):0;
  await row.update({
    ...spendOne(row),
    booster_currently_active:Math.min(currentlyActive+1,activeLimit||currentlyActive+1),
    booster_active_until:endTime?new Date(Math.max(endTime,prevUntil)):row.booster_active_until,
  });
  // itemCache — источник слотов для страницы «Квесты» (обновляется фоновым runInventory). Дописываем
  // свежий инстанс сразу, иначе до следующего цикла кнопка считала бы слот всё ещё свободным.
  try{
    const{Account}=require('../db/index');
    const acc=await Account.findOne({where:{name},attributes:['id']});
    if(acc&&endTime){
      const cur=itemCache.get(acc.id)||{};
      itemCache.set(acc.id,{...cur,active_boosters:[...(cur.active_boosters||[]),{item_id:Number(row.name),rarity,end_time:new Date(endTime).toISOString()}]});
    }
  }catch(_){}
  await logAction(name,'booster_activate',{building_id:row.name,detail:JSON.stringify({manual:true,quest:true})});
  logger.info(`[${name}] [quest] активирован ${row.name} (${rarity}) вручную под квест`);
  // активация меняет end у текущих строек (сверено с бандлом) — перечитываем /progress/, чтобы
  // веб-панель/цикл улучшений увидели свежие времена (тот же приём, что и фоновый цикл выше)
  try{
    const prog=await api.get('/progress/');
    const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
    await CitySnapshot.upsert(citySnapshotRow(name,buildings,prog),{conflictFields:['account']});
  }catch(_){}
  wake(name);
  return{ok:true,name:row.name};
}

// Правила конверсии ускорителей — сверено реверсом бандла игры 30.07.2026: GET
// /boosters/combination-rules → [{from_rarity,to_rarity,required_amount}], statically определяет
// на какую редкость и по сколько штук конвертируется каждая исходная редкость (обычно N младших →
// 1 следующего тира). Не кэшируем — правила крошечные (по числу редкостей), а живой запрос всё
// равно уже используется только по явному действию пользователя (кнопка "Комбинировать"), не в
// фоновом цикле.
async function getCombinationRules(api){
  const raw=await api.get('/boosters/combination-rules').catch(()=>[]);
  const list=Array.isArray(raw)?raw:(raw?.rules||[]);
  const rules=new Map();
  for(const r of list){
    if(r?.from_rarity&&r?.to_rarity&&r?.required_amount)rules.set(r.from_rarity,{toRarity:r.to_rarity,requiredAmount:Number(r.required_amount)});
  }
  return rules;
}

// Ручное комбинирование ускорителей под квест booster_combine (кнопка "Комбинировать" на странице
// "Квесты", добавлено 30.07.2026 — раньше у этого типа квеста не было вообще никакого способа
// продвинуть его, ни автоматики, ни ручной кнопки). Реальный игровой эндпоинт — POST
// /boosters/combine {amount,from_item_id}, amount ДОЛЖЕН быть кратен required_amount из правил
// (сверено с бандлом: клиент игры округляет amount вниз до кратного и отказывает, если получилось
// меньше required_amount). Комбинируем РОВНО ОДНУ конверсию (amount=requiredAmount) — минимально
// необходимое количество, чтобы выполнить условие квеста, не тратя лишние ускорители игрока сверх
// того, что реально нужно (тот же принцип, что и у остальной ручной автоматики в этом файле).
async function combineBoosterForRarity(api,name,rarity){
  const rMap=rarityToId();
  const rules=await getCombinationRules(api);
  const rule=rules.get(rarity);
  if(!rule)return{ok:false,error:`Ускорители редкости "${rarity}" не комбинируются (нет правила конверсии)`};
  const fromItemId=rMap.get(rarity);
  const toItemId=rMap.get(rule.toRarity);
  if(fromItemId==null||toItemId==null)return{ok:false,error:`Неизвестная редкость ускорителя "${rarity}"/"${rule.toRarity}"`};
  const rows=await Inventory.findAll({where:{account:name,type:'booster'}});
  const fromRow=rows.find(r=>r.name===String(fromItemId));
  const have=fromRow?.marketable??0;
  if(have<rule.requiredAmount)return{ok:false,error:`Недостаточно ускорителей редкости "${rarity}" (нужно ${rule.requiredAmount}, есть ${have})`};
  const ok=await runAction(name,`booster combine ${fromItemId}->${toItemId} (manual, quest)`,async()=>{
    await sleep(500);
    await api.post('/boosters/combine',{amount:rule.requiredAmount,from_item_id:Number(fromItemId)});
  });
  if(!ok)return{ok:false,error:'Не удалось скомбинировать ускорители — см. лог'};
  await fromRow.update({marketable:Math.max(0,have-rule.requiredAmount)});
  const toRow=rows.find(r=>r.name===String(toItemId));
  if(toRow)await toRow.update({marketable:(toRow.marketable??0)+1});
  else await Inventory.create({account:name,name:String(toItemId),type:'booster',marketable:1});
  await logAction(name,'booster_combine',{building_id:String(fromItemId),detail:JSON.stringify({manual:true,quest:true,toItemId,requiredAmount:rule.requiredAmount})});
  logger.info(`[${name}] [quest] скомбинировано ${rule.requiredAmount}× ${fromItemId} (${rarity}) -> 1× ${toItemId} (${rule.toRarity}) вручную под квест`);
  return{ok:true,toName:toItemId};
}

module.exports={runBoosterAutomationLoop,getEndsByType,getActiveBoosterInfo,getDurationBoosterInfo,rarityToId,activateBoosterForRarity,combineBoosterForRarity};
