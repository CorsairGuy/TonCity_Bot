'use strict';
const logger=require('../../utils/logger');

// Технологическая фабрика и Вечный аудиториум — спецздания ГИЛЬДИИ (строятся в общей Столице,
// см. dashboards.js /api/special-buildings), но сами действия (overview/contribute/start/claim,
// status/enter) — персональные, за СВОЙ Почёт/кристаллы/предметы каждого аккаунта в такой гильдии.
// Эндпоинты и структура реверснуты из бандла игры (chunks/tech_factory-*.js, timeless_auditorium-*.js).
// GET-эндпоинты читают из БД (снимок пишет modules/guildBuildings.js по кнопке "Обновить" —
// /api/refresh/techfactory|auditorium), как и везде в проекте. Раньше страницы дёргали игру
// напрямую при каждом открытии — из-за этого ломались.
module.exports=function(app,ctx){
  const{apiForAcc,midErr}=ctx;

  // свои аккаунты, чья гильдия построила здание нужного уровня (>0) — джойн через
  // GuildSnapshot.account→guild_id и GuildSpecialBuilding.guild_id→{auditorium,factory}_level
  async function eligibleAccounts(levelField){
    const{Account,GuildSnapshot,GuildSpecialBuilding}=require('../../db/index');
    const[accs,snaps,buildings]=await Promise.all([
      Account.findAll({order:[['id','ASC']]}),
      GuildSnapshot.findAll(),
      GuildSpecialBuilding.findAll(),
    ]);
    const guildByAccount=new Map(snaps.map(s=>[s.account,s.guild_id]));
    const levelByGuild=new Map(buildings.map(b=>[b.guild_id,b[levelField]]));
    return accs.filter(a=>{
      if(!a.access_token)return false;
      const gid=guildByAccount.get(a.name);
      if(!gid)return false;
      const lvl=levelByGuild.get(gid);
      return lvl!=null&&lvl>0;
    });
  }

  async function findAccount(id){
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(id);
    if(!acc?.access_token)throw Object.assign(new Error('Аккаунт не найден'),{status:404});
    return acc;
  }

  // ── Технологическая фабрика ───────────────────────────────────────────────
  app.get('/api/tech-factory/accounts',async(req,res)=>{
    try{
      const accs=await eligibleAccounts('factory_level');
      res.json({ok:true,accounts:accs.map(a=>({id:a.id,name:a.name}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // снимок из БД — без обращения к игре
  app.get('/api/tech-factory/:accountId/overview',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{TechFactoryStatus}=require('../../db/index');
      const row=await TechFactoryStatus.findOne({where:{account:acc.name}});
      if(!row)return res.json({ok:true,renown_balance:null,categories:[],job:null,updated_at:null});
      res.json({
        ok:true,
        renown_balance:row.renown_balance,
        categories:row.categories?JSON.parse(row.categories):[],
        job:row.job?JSON.parse(row.job):null,
        updated_at:row.updated_at,
      });
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.post('/api/tech-factory/:accountId/contribute',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{category,amount}=req.body||{};
      if(!category||!(Number(amount)>0))return res.status(400).json({ok:false,error:'category и amount обязательны'});
      const data=await apiForAcc(acc).post('/tech-factory/contribute',{category,amount:Number(amount)});
      await require('../../modules/guildBuildings').runTechFactory(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/tech-factory/:accountId/start',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{recipe_id}=req.body||{};
      if(!recipe_id)return res.status(400).json({ok:false,error:'recipe_id обязателен'});
      const data=await apiForAcc(acc).post('/tech-factory/start',{recipe_id});
      await require('../../modules/guildBuildings').runTechFactory(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/tech-factory/:accountId/claim',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const data=await apiForAcc(acc).post('/tech-factory/claim');
      await require('../../modules/guildBuildings').runTechFactory(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  // ── Вечный аудиториум ─────────────────────────────────────────────────────
  app.get('/api/timeless-auditorium/accounts',async(req,res)=>{
    try{
      const accs=await eligibleAccounts('auditorium_level');
      res.json({ok:true,accounts:accs.map(a=>({id:a.id,name:a.name}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/timeless-auditorium/:accountId/status',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{AuditoriumStatus}=require('../../db/index');
      const row=await AuditoriumStatus.findOne({where:{account:acc.name}});
      if(!row)return res.json({ok:true,renown:null,loyalty:null,population:null,unlocked:false,updated_at:null});
      res.json({
        ok:true,
        renown:row.renown?JSON.parse(row.renown):null,
        loyalty:row.loyalty?JSON.parse(row.loyalty):null,
        population:row.population?JSON.parse(row.population):null,
        unlocked:!!row.unlocked,
        updated_at:row.updated_at,
      });
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.post('/api/timeless-auditorium/:accountId/enter',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const data=await apiForAcc(acc).post('/timeless-auditorium/enter');
      await require('../../modules/guildBuildings').runAuditorium(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });
};
