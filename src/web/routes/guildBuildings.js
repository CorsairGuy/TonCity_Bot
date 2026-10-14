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
    // ВАЖНО (13.10.2026): этот путь (через guild_special_buildings) верен только для данных,
    // видимых ЛИДЕРУ/ОФИЦЕРУ (/capitals/progress/). Для технофабрики заменён на прямой снимок
    // TechFactoryStatus.has_factory (см. /api/tech-factory/accounts ниже) — он доступен любому
    // члену гильдии. Аудиториум пока использует этот путь как раньше.
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
  // 13.10.2026: раньше использовали eligibleAccounts('factory_level') — она смотрит
  // guild_special_buildings, которую видит ТОЛЬКО лидер/офицер гильдии (/capitals/progress/ рядовому
  // участнику недоступна). Рядовой участник в гильдии, где у бота нет лидера/офицера, никогда не
  // попадал в список, хотя здание у гильдии реально построено. Личная ручка /tech-factory/overview
  // доступна ЛЮБОМУ члену гильдии и сама говорит has_factory — используем её снимок (TechFactoryStatus)
  // напрямую, без обращения к guild_special_buildings вообще.
  app.get('/api/tech-factory/accounts',async(req,res)=>{
    try{
      const{Account,TechFactoryStatus}=require('../../db/index');
      const[accs,rows]=await Promise.all([
        Account.findAll({order:[['id','ASC']]}),
        TechFactoryStatus.findAll({where:{has_factory:true}}),
      ]);
      const haveFactory=new Set(rows.map(r=>r.account));
      const result=accs.filter(a=>a.access_token&&haveFactory.has(a.name));
      res.json({ok:true,accounts:result.map(a=>({id:a.id,name:a.name}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // снимок из БД — без обращения к игре
  app.get('/api/tech-factory/:accountId/overview',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{TechFactoryStatus,TechFactoryQueue}=require('../../db/index');
      const[row,queue]=await Promise.all([
        TechFactoryStatus.findOne({where:{account:acc.name}}),
        TechFactoryQueue.findAll({where:{account:acc.name},order:[['pos','ASC']]}),
      ]);
      if(!row){
        return res.json({ok:true,renown_balance:null,categories:[],job:null,in_guild:false,has_factory:false,
          membership_eligible:false,eligible_members:null,economy_unlocked:false,
          guild_renown_balance:null,can_spend_guild_renown:false,
          guild_crystal_balance:null,can_spend_guild_crystals:false,updated_at:null,queue:[]});
      }
      res.json({
        ok:true,
        renown_balance:row.renown_balance,
        categories:row.categories?JSON.parse(row.categories):[],
        job:row.job?JSON.parse(row.job):null,
        in_guild:!!row.is_member,
        has_factory:!!row.has_factory,
        membership_eligible:!!row.membership_eligible,
        eligible_members:row.eligible_members,
        economy_unlocked:!!row.economy_unlocked,
        guild_renown_balance:row.guild_renown_balance,
        can_spend_guild_renown:!!row.can_spend_guild_renown,
        guild_crystal_balance:row.guild_crystal_balance,
        can_spend_guild_crystals:!!row.can_upgrade,
        updated_at:row.updated_at,
        queue:queue.map(q=>({id:q.id,machine_id:q.machine_id,level:q.level})),
      });
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.post('/api/tech-factory/:accountId/contribute',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{category,amount,source}=req.body||{};
      if(!category||!(Number(amount)>0))return res.status(400).json({ok:false,error:'category и amount обязательны'});
      // форма подтверждена реверсом (chunks/tech_factory-*.js) — source:'personal'|'guild', та же
      // модель, что у взноса Почёта в уровни квестов (см. web/routes/questTiers.js)
      const data=await apiForAcc(acc).post('/tech-factory/contribute',{category,amount:Number(amount),source:source==='guild'?'guild':'personal'});
      await require('../../modules/guildBuildings').runTechFactory(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/tech-factory/:accountId/start',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{machine_id,level}=req.body||{};
      if(!machine_id||!(Number(level)>0))return res.status(400).json({ok:false,error:'machine_id и level обязательны'});
      // 13.10.2026: раньше здесь уходило {recipe_id} — поля с таким именем у игры вообще нет,
      // запуск не срабатывал НИ РАЗУ. Настоящее тело подтверждено реверсом: {machine_id,level}
      // (level — тир рецепта I-VI, НЕ уровень самого станка, см. db/index.js TechFactoryStatus).
      const data=await apiForAcc(acc).post('/tech-factory/start',{machine_id,level:Number(level)});
      await require('../../modules/guildBuildings').runTechFactory(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/tech-factory/:accountId/upgrade',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{machine_id,level}=req.body||{};
      if(!machine_id||!(Number(level)>0))return res.status(400).json({ok:false,error:'machine_id и level обязательны'});
      const data=await apiForAcc(acc).post('/tech-factory/upgrade',{machine_id,level:Number(level)});
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

  // ── очередь автозапуска (runTechFactoryLoop в modules/guildBuildings.js разбирает по pos) ──────
  app.post('/api/tech-factory/:accountId/queue',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{machine_id,level}=req.body||{};
      if(!machine_id||!(Number(level)>0))return res.status(400).json({ok:false,error:'machine_id и level обязательны'});
      const{TechFactoryQueue}=require('../../db/index');
      const last=await TechFactoryQueue.findOne({where:{account:acc.name},order:[['pos','DESC']]});
      await TechFactoryQueue.create({account:acc.name,machine_id,level:Number(level),pos:(last?.pos??0)+1,created_at:new Date()});
      require('../../utils/cityWake').wake(`techfactory:${acc.name}`);
      res.json({ok:true});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.delete('/api/tech-factory/:accountId/queue/:queueId',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{TechFactoryQueue}=require('../../db/index');
      await TechFactoryQueue.destroy({where:{id:req.params.queueId,account:acc.name}});
      res.json({ok:true});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // переставить запись очереди на новую позицию (drag-reorder на фронте шлёт новый порядок id)
  app.post('/api/tech-factory/:accountId/queue/reorder',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{ids}=req.body||{};
      if(!Array.isArray(ids)||!ids.length)return res.status(400).json({ok:false,error:'ids обязателен'});
      const{TechFactoryQueue}=require('../../db/index');
      await Promise.all(ids.map((id,i)=>TechFactoryQueue.update({pos:i+1},{where:{id:Number(id),account:acc.name}})));
      res.json({ok:true});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // ── Вечный аудиториум ─────────────────────────────────────────────────────
  // 14.10.2026: список — по снимку /status (has_auditorium виден любому члену гильдии). Старый путь
  // через guild_special_buildings оставлен для строк, у которых флага ещё нет (до первой синхронизации).
  app.get('/api/timeless-auditorium/accounts',async(req,res)=>{
    try{
      const{AuditoriumStatus}=require('../../db/index');
      const[accs,rows,legacy]=await Promise.all([
        require('../../db/index').Account.findAll({order:[['id','ASC']]}),
        AuditoriumStatus.findAll(),
        eligibleAccounts('auditorium_level'),
      ]);
      const flag=new Map(rows.map(r=>[r.account,r.has_auditorium]));
      const legacyNames=new Set(legacy.map(a=>a.name));
      const result=accs.filter(a=>{
        if(!a.access_token)return false;
        const f=flag.get(a.name);
        return f===true||(f==null&&legacyNames.has(a.name));
      });
      res.json({ok:true,accounts:result.map(a=>({id:a.id,name:a.name}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // снимок из БД — без обращения к игре
  app.get('/api/timeless-auditorium/:accountId/status',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const{AuditoriumStatus}=require('../../db/index');
      const row=await AuditoriumStatus.findOne({where:{account:acc.name}});
      if(!row)return res.json({ok:true,renown:null,loyalty:null,population:null,unlocked:false,in_guild:null,has_auditorium:null,catalog:null,updated_at:null});
      res.json({
        ok:true,
        renown:row.renown?JSON.parse(row.renown):null,
        loyalty:row.loyalty?JSON.parse(row.loyalty):null,
        population:row.population?JSON.parse(row.population):null,
        unlocked:!!row.unlocked,
        in_guild:row.in_guild==null?null:!!row.in_guild,
        has_auditorium:row.has_auditorium==null?null:!!row.has_auditorium,
        catalog:row.catalog?JSON.parse(row.catalog):null,
        updated_at:row.updated_at,
      });
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // обмен Почёта на предмет: POST /timeless-auditorium/buy {sku:<code товара>} (как в игре).
  // Мутация — не повторяется; после ответа перечитываем status+catalog, чтобы баланс, лимиты и
  // purchasable на странице были с сервера, а не вычислены локально.
  app.post('/api/timeless-auditorium/:accountId/buy',async(req,res)=>{
    try{
      const acc=await findAccount(req.params.accountId);
      const sku=String(req.body?.sku||'').trim();
      if(!sku)return res.status(400).json({ok:false,error:'sku обязателен'});
      const data=await apiForAcc(acc).post('/timeless-auditorium/buy',{sku});
      logger.info(`[${acc.name}] [auditorium] куплено ${sku}, баланс Почёта: ${data?.balance??'?'}`);
      await require('../../modules/guildBuildings').runAuditorium(apiForAcc(acc),acc.name).catch(()=>{});
      res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });
};
