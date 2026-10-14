'use strict';
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');
const {waitOrWake}=require('../utils/cityWake');
const accountLoops=require('../utils/accountLoops');

// Технологическая фабрика и Вечный аудиториум — спецздания ГИЛЬДИИ (строятся в общей Столице,
// см. web/routes/dashboards.js /api/special-buildings), сами действия (overview/status) —
// персональные, за Почёт/кристаллы/предметы каждого аккаунта. Снимок пишем в БД, страница читает
// оттуда (live-запрос к игре только по кнопке "Обновить" — как и везде в проекте).
async function hasBuilding(accountName,levelField){
  const{GuildSnapshot,GuildSpecialBuilding}=require('../db/index');
  const snap=await GuildSnapshot.findOne({where:{account:accountName}});
  if(!snap?.guild_id)return false;
  const b=await GuildSpecialBuilding.findOne({where:{guild_id:snap.guild_id}});
  return !!(b&&b[levelField]!=null&&b[levelField]>0);
}

async function runTechFactory(api,name){
  try{
    const{TechFactoryStatus}=require('../db/index');
    // 13.10.2026: раньше здесь стоял hasBuilding('factory_level') — он читает guild_special_buildings,
    // которую заполняет ТОЛЬКО кнопка "Обновить" на странице спецзданий, а она сама дёргает
    // /capitals/progress/ только от лица ЛИДЕРА/ОФИЦЕРА гильдии (рядовому участнику эта ручка 403).
    // Итог: аккаунт-рядовой участник гильдии, где у бота нет лидера/офицера, НИКОГДА не получал
    // снимок технофабрики, даже если здание реально построено. /tech-factory/overview же — личная
    // ручка, доступна любому члену гильдии и сама содержит has_factory. Убрали gate, спрашиваем игру
    // напрямую и смотрим на её же ответ.
    const d=await api.get('/tech-factory/overview');
    if(!d)return;
    // 13.10.2026: имена полей сверены с ЖИВЫМ ответом игры (сохранился в логе до чистки
    // temp-дампа) — is_member/can_upgrade были неверной догадкой по статике бандла, реальные поля
    // другие (in_guild/can_spend_guild_crystals и т.д., см. db/index.js TechFactoryStatus)
    await TechFactoryStatus.upsert({
      account:name,
      renown_balance:d.renown_balance??null,
      categories:JSON.stringify(d.categories||[]),
      job:d.job?JSON.stringify(d.job):null,
      is_member:!!d.in_guild,
      has_factory:!!d.has_factory,
      membership_eligible:!!d.membership_eligible,
      economy_unlocked:!!d.economy_unlocked,
      guild_crystal_balance:d.guild_crystal_balance??null,
      can_upgrade:!!d.can_spend_guild_crystals,
      guild_renown_balance:d.guild_renown_balance??null,
      can_spend_guild_renown:!!d.can_spend_guild_renown,
      eligible_members:d.eligible_members??null,
      updated_at:new Date(),
    },{conflictFields:['account']});
    if(!d.has_factory){logger.info(`[${name}] [tech-factory] гильдия ещё не построила здание — пропуск`);return d;}
    logger.info(`[${name}] [tech-factory] synced, renown: ${d.renown_balance??'?'}, job: ${d.job?'active':'none'}`);
    return d;
  }catch(e){logger.warn(`[${name}] [tech-factory]: ${e.message}`);}
}

// ── Автозапуск очереди переработок (своя очередь у каждого аккаунта) ──────────────────────────
// Правило простое: job!=null → ждём finishes_at, затем claim и сразу пробуем следующую запись
// очереди; job==null → берём первую запись очереди (по pos), проверяем, что станок/тир всё ещё
// разблокирован и лимит (limit_count/limit_window) не исчерпан — если да, start и ждём; если тир
// недоступен (лимит/заблокирован) — ПРОПУСКАЕМ эту запись (удаляем из очереди, не блокируя
// остальные) и логируем почему, пробуем следующую. Входных предметов (inputs) заранее не проверяем:
// их не хватит — игра сама откажет на start() понятной ошибкой, та же запись тогда тоже снимается
// с очереди (чтобы не долбить одну и ту же нехватку материалов каждый круг).
function findTier(categories,machineId,level){
  for(const cat of categories||[]){
    for(const m of cat.machines||[]){
      if(m.id===machineId){
        const tier=(m.tiers||[]).find(t=>t.level===level);
        return{machine:m,tier};
      }
    }
  }
  return{machine:null,tier:null};
}

async function runTechFactoryLoop(api,name,accountId){
  // 13.10.2026: больше не гейтим стартом по hasBuilding('factory_level') — та проверка зависела от
  // guild_special_buildings, которую видит только лидер/офицер гильдии (см. runTechFactory выше).
  // Цикл теперь стартует для всех и сам решает по ответу /tech-factory/overview (d.has_factory).
  const{TechFactoryQueue}=require('../db/index');
  logger.info(`[${name}] [tech-factory-loop] started`);
  while(true){
    try{
      if(accountLoops.isStopped(accountId)){logger.info(`[${name}] [tech-factory-loop] аккаунт удалён, останавливаюсь`);return;}
      const d=await runTechFactory(api,name);
      if(!d||!d.has_factory){
        // гильдия ещё не построила (или аккаунт вне гильдии) — не долбим игру чаще раза в несколько часов
        await waitOrWake(`techfactory:${name}`,6*60*60*1000);
        continue;
      }
      if(d.job){
        const finishesAt=new Date(d.job.finishes_at).getTime();
        const waitMs=Math.max(5000,finishesAt-Date.now()+3000);
        if(!d.job.ready&&waitMs>5000){
          logger.info(`[${name}] [tech-factory-loop] задание ещё не готово, жду ${Math.ceil(waitMs/60000)} мин`);
          await waitOrWake(`techfactory:${name}`,Math.min(waitMs,6*60*60*1000));
          continue;
        }
        try{
          const r=await api.post('/tech-factory/claim');
          const item=r?.item_id!=null?`#${r.item_id} ×${r.quantity}`:'';
          logger.info(`[${name}] [tech-factory-loop] забрано: ${item}`);
        }catch(e){logger.warn(`[${name}] [tech-factory-loop] claim: ${e.message}`);}
        await sleep(500);
        continue; // перечитываем overview (job должен стать null) и сразу пробуем следующий в очереди
      }
      // job==null — берём следующую запись очереди
      const next=await TechFactoryQueue.findOne({where:{account:name},order:[['pos','ASC']]});
      if(!next){
        logger.info(`[${name}] [tech-factory-loop] очередь пуста, жду 1ч`);
        await waitOrWake(`techfactory:${name}`,60*60*1000);
        continue;
      }
      const{tier}=findTier(d.categories,next.machine_id,next.level);
      if(!tier||!tier.unlocked||(tier.used??0)>=(tier.limit_count??Infinity)){
        logger.warn(`[${name}] [tech-factory-loop] ${next.machine_id} ур.${next.level} недоступен (заблокирован или лимит ${tier?.used}/${tier?.limit_count}) — убираю из очереди`);
        await next.destroy();
        continue;
      }
      try{
        await api.post('/tech-factory/start',{machine_id:next.machine_id,level:next.level});
        logger.info(`[${name}] [tech-factory-loop] запущено: ${next.machine_id} ур.${next.level}`);
        await next.destroy();
      }catch(e){
        logger.warn(`[${name}] [tech-factory-loop] start ${next.machine_id} ур.${next.level}: ${e.message} — убираю из очереди (не хватает предметов?)`);
        await next.destroy();
      }
      await sleep(1000);
    }catch(e){
      logger.error(`[${name}] [tech-factory-loop] ${e.message}`);
      await sleep(5*60*1000);
    }
  }
}

// Вечный аудиториум. Эндпоинты сверены с бандлом игры (chunks/timeless_auditorium-*.js, 14.10.2026):
//   GET  /timeless-auditorium/status  → {unlocked,in_guild,has_auditorium,renown,loyalty,population}
//        (условия входа, gate={current,required,met}; доступен любому, даже без гильдии)
//   GET  /timeless-auditorium/catalog → {balance,lifetime_earned,tiers[],sections[{key,skus[]}]}
//        (витрина; закрытому аккаунту — ошибка, поэтому зовём только при unlocked)
//   POST /timeless-auditorium/buy {sku:code} → {balance,limits,purchasable}
// Эндпоинта /enter у игры НЕТ — «войти» означает просто выполнить условия.
// 14.10.2026: gate hasBuilding('auditorium_level') убран по той же причине, что у технофабрики:
// guild_special_buildings видит только лидер/офицер, а /status сам говорит has_auditorium.
async function runAuditorium(api,name){
  try{
    const{AuditoriumStatus}=require('../db/index');
    const d=await api.get('/timeless-auditorium/status');
    if(!d)return;
    let catalog=null;
    if(d.unlocked){
      try{catalog=await api.get('/timeless-auditorium/catalog');}
      catch(e){logger.warn(`[${name}] [auditorium] catalog: ${e.message}`);}
    }
    await AuditoriumStatus.upsert({
      account:name,
      renown:d.renown?JSON.stringify(d.renown):null,
      loyalty:d.loyalty?JSON.stringify(d.loyalty):null,
      population:d.population?JSON.stringify(d.population):null,
      unlocked:!!d.unlocked,
      in_guild:d.in_guild==null?null:!!d.in_guild,
      has_auditorium:d.has_auditorium==null?null:!!d.has_auditorium,
      catalog:catalog?JSON.stringify(catalog):null,
      updated_at:new Date(),
    },{conflictFields:['account']});
    logger.info(`[${name}] [auditorium] synced, unlocked: ${!!d.unlocked}${catalog?`, renown: ${catalog.balance??'?'}`:''}`);
  }catch(e){logger.warn(`[${name}] [auditorium]: ${e.message}`);}
}

module.exports={runTechFactory,runTechFactoryLoop,runAuditorium,hasBuilding};
