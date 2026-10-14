'use strict';
const logger=require('../utils/logger');

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
    if(!(await hasBuilding(name,'factory_level'))){logger.info(`[${name}] [tech-factory] гильдия не строила (или уровень не синхронизирован) — пропуск`);return;}
    const{TechFactoryStatus}=require('../db/index');
    const d=await api.get('/tech-factory/overview');
    // TODO: убрать после проверки — временный дамп сырого ответа, чтобы подтвердить реальные поля
    logger.warn(`[${name}] [tech-factory] raw: ${JSON.stringify(d)}`);
    if(!d)return;
    await TechFactoryStatus.upsert({
      account:name,
      renown_balance:d.renown_balance??null,
      categories:JSON.stringify(d.categories||[]),
      job:d.job?JSON.stringify(d.job):null,
      updated_at:new Date(),
    },{conflictFields:['account']});
    logger.info(`[${name}] [tech-factory] synced, renown: ${d.renown_balance??'?'}, job: ${d.job?'active':'none'}`);
  }catch(e){logger.warn(`[${name}] [tech-factory]: ${e.message}`);}
}

async function runAuditorium(api,name){
  try{
    if(!(await hasBuilding(name,'auditorium_level'))){logger.info(`[${name}] [auditorium] гильдия не строила (или уровень не синхронизирован) — пропуск`);return;}
    const{AuditoriumStatus}=require('../db/index');
    const d=await api.get('/timeless-auditorium/status');
    // TODO: убрать после проверки — временный дамп сырого ответа, чтобы подтвердить реальные поля
    logger.warn(`[${name}] [auditorium] raw: ${JSON.stringify(d)}`);
    if(!d)return;
    await AuditoriumStatus.upsert({
      account:name,
      renown:d.renown?JSON.stringify(d.renown):null,
      loyalty:d.loyalty?JSON.stringify(d.loyalty):null,
      population:d.population?JSON.stringify(d.population):null,
      unlocked:!!d.unlocked,
      updated_at:new Date(),
    },{conflictFields:['account']});
    logger.info(`[${name}] [auditorium] synced, unlocked: ${!!d.unlocked}`);
  }catch(e){logger.warn(`[${name}] [auditorium]: ${e.message}`);}
}

module.exports={runTechFactory,runAuditorium};
