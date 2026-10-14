'use strict';
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

// Уровни гильдейских квестов (Guild Quest Tiers) — новая система обновления 06.07.2026.
// Эндпоинты подтверждены реверсом карты роутов в бандле игры (объект apiRoutes.guildQuests):
//   GET  /guild-quests/tiers/{guildId}              — статус тиров
//   POST /guild-quests/tiers/{guildId}/contribute    — внести вклад Почёта в пул тира
// Ответ GET подтверждён живым запросом (DevTools, 09.07.2026):
//   { renown_balance, eligible_members, tiers:[{ id, rarity, unlocked, pool:{ target, progress, fundable } }] }
// 13.10.2026: тело POST contribute НАКОНЕЦ подтверждено реверсом живого бандла (chunks/
// useGuildAchievements-*.js, вызов F=(e,t)=>u(m.guildQuests.contributeTier(e)).post(t).json(),
// сам вызов — chunks/quest_dome-*.js: ct(guildId,{tier:g.id,amount:r,source:l})) — раньше стояло
// {tier_id,amount} (угадано, без поля source), игра такое тело молча не принимала, взнос не работал
// НИ РАЗУ. Настоящая форма: {tier:<id тира>, amount:<число>, source:'personal'|'guild'} — source
// переключает, откуда списывается Почёт (chunks/RenownSourceToggle-*.js: 'personal' — свой баланс
// участника, 'guild' — казна гильдии). Бот всегда шлёт 'personal' — свой Почёт КАЖДОГО аккаунта
// (привязан к участнику, см. eligible_members в ответе GET), взнос делаем от лица каждого выбранного
// аккаунта гильдии, а не только лидера.
module.exports=function(app,ctx){
  const{apiForAcc}=ctx;

  async function guildMemberAccounts(guildId){
    const{GuildSnapshot,Account}=require('../../db/index');
    const rows=await GuildSnapshot.findAll({where:{guild_id:guildId}});
    if(!rows.length)return[];
    const names=rows.map(r=>r.account);
    const accs=await Account.findAll({where:{name:names}});
    return accs.filter(a=>a.access_token);
  }
  // Статус тиров общий на всю гильдию (не привязан к конкретному участнику) — раньше читался
  // ТОЛЬКО через anyMemberApi() (лидер либо первый попавшийся аккаунт), без фолбэка: временный
  // сбой (протухший WS/сигнатура) именно у ЭТОГО аккаунта ронял refresh целиком, хотя у гильдии
  // есть и другие свои аккаунты, способные прочитать те же данные. Пробуем по очереди.
  async function fetchTiers(guildId){
    const accs=await guildMemberAccounts(guildId);
    if(!accs.length)throw new Error('Ни один свой аккаунт не найден в этой гильдии');
    let lastErr=null;
    for(const acc of accs){
      try{return await apiForAcc(acc).get(`/guild-quests/tiers/${guildId}`);}
      catch(e){lastErr=e;if(!(e.wsNotReady||e.noSeed||e.status===403))throw e;}
    }
    throw lastErr||new Error('не удалось прочитать тиры ни с одного аккаунта гильдии');
  }
  async function saveSnapshot(guildId,data){
    const{QuestTierSnapshot,GuildSnapshot}=require('../../db/index');
    const row=await GuildSnapshot.findOne({where:{guild_id:guildId}});
    await QuestTierSnapshot.upsert({
      guild_id:guildId,guild_title:row?.guild_title||guildId,
      data:JSON.stringify(data),updated_at:new Date(),
    },{conflictFields:['guild_id']});
  }

  app.get('/api/quest-tiers',async(req,res)=>{
    try{
      const{QuestTierSnapshot}=require('../../db/index');
      const rows=await QuestTierSnapshot.findAll({order:[['guild_title','ASC']]});
      res.json({ok:true,guilds:rows.map(r=>({
        guild_id:r.guild_id,guild_title:r.guild_title,
        data:r.data?JSON.parse(r.data):null,updated_at:r.updated_at,
      }))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/quest-tiers/:guildId/refresh',async(req,res)=>{
    try{
      const guildId=req.params.guildId;
      const data=await opRegistry.run(`questTiersRefresh:${guildId}`,async()=>{
        const d=await fetchTiers(guildId);
        await saveSnapshot(guildId,d);
        return d;
      });
      res.json({ok:true,data});
    }catch(e){
      logger.warn(`[quest-tiers] refresh ${req.params.guildId}: ${e.message}`);
      res.status(500).json({ok:false,error:e.message});
    }
  });

  // обновить сразу ВСЕ гильдии, где когда-либо были свои аккаунты (все guild_id из GuildSnapshot,
  // включая те, откуда аккаунт уже вышел — строки там не удаляются, копятся историей)
  app.post('/api/quest-tiers/refresh-all',async(req,res)=>{
    try{
      const results=await opRegistry.run('questTiersRefreshAll',async()=>{
        const{GuildSnapshot}=require('../../db/index');
        const rows=await GuildSnapshot.findAll({attributes:['guild_id']});
        const guildIds=[...new Set(rows.map(r=>r.guild_id).filter(Boolean))];
        const out=[];
        for(const guildId of guildIds){ // последовательно — общий apiLock и так рейт-лимитит, но так проще читать лог
          try{
            const data=await fetchTiers(guildId);
            await saveSnapshot(guildId,data);
            out.push({guild_id:guildId,ok:true});
          }catch(e){
            logger.warn(`[quest-tiers] refresh-all ${guildId}: ${e.message}`);
            out.push({guild_id:guildId,ok:false,error:e.message});
          }
        }
        return out;
      });
      const ok=results.filter(r=>r.ok).length;
      res.json({ok:true,results,succeeded:ok,total:results.length});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // взнос Почёта с ВЫБРАННЫХ пользователем аккаунтов этой гильдии (можно все разом, можно по
  // отдельности — выбор делает фронт) — каждый аккаунт вносит независимо от своего лица, т.к.
  // Почёт похоже привязан к участнику, а не к гильдии целиком (см. eligible_members в ответе)
  app.post('/api/quest-tiers/:guildId/contribute-all',async(req,res)=>{
    try{
      const guildId=req.params.guildId;
      const{tier_id,amount,accounts}=req.body||{};
      if(tier_id==null||!(amount>0))return res.status(400).json({ok:false,error:'tier_id и amount (>0) обязательны'});
      if(!Array.isArray(accounts)||!accounts.length)return res.status(400).json({ok:false,error:'Выберите хотя бы один аккаунт'});
      const guildAccs=await guildMemberAccounts(guildId);
      const selected=new Set(accounts);
      const accs=guildAccs.filter(a=>selected.has(a.name));
      if(!accs.length)return res.status(404).json({ok:false,error:'Ни один из выбранных аккаунтов не найден в этой гильдии (или нет токена)'});
      const results=await Promise.allSettled(accs.map(async acc=>{
        const api=apiForAcc(acc);
        // настоящая форма тела — см. комментарий в шапке файла (tier_id/amount был угадан неверно)
        const r=await api.post(`/guild-quests/tiers/${guildId}/contribute`,{tier:Number(tier_id),amount:Number(amount),source:'personal'});
        return{account:acc.name,ok:true,result:r};
      }));
      const mapped=results.map((r,i)=>r.status==='fulfilled'?r.value:{account:accs[i].name,ok:false,error:r.reason?.message||String(r.reason)});
      // перечитываем актуальный статус тиров любым аккаунтом гильдии и обновляем кэш
      let data=null;
      try{data=await fetchTiers(guildId);await saveSnapshot(guildId,data);}catch(_){}
      const ok=mapped.filter(m=>m.ok).length;
      res.json({ok:true,results:mapped,succeeded:ok,total:mapped.length,data});
    }catch(e){
      logger.warn(`[quest-tiers] contribute-all ${req.params.guildId} (tier=${req.body?.tier_id} amount=${req.body?.amount}): ${e.message}`);
      res.status(500).json({ok:false,error:e.message});
    }
  });
};
