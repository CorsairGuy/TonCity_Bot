'use strict';
const logger=require('../../utils/logger');
const {logCapitalAction}=require('../../modules/capitalActionLog');
const opRegistry=require('../lib/opRegistry');
const capitalLive=require('../../utils/capitalLive');

// Действия по столице (страница "Карта города" → тип столица) — та же архитектура, что
// web/routes/cityStrategy.js для городов, минус Реконструкция/Реновация/Ускорители (нет
// подтверждённых реверсом игровых механизмов для столицы — см. план), плюс Снос (тип действия
// 'destroy' универсален для игры, уже подтверждён у городов). Идентификатор в URL — guild_title
// (как и на странице "Столицы"/карте — CapitalSnapshot не хранит account, столица общая на
// гильдию), резолвится в guild_id + аккаунт-лидера гильдии (только лидер может реально исполнять
// строительные действия — см. modules/capital.js).
//
// Игровой эндпоинт — POST /capitals/progress/{guildId}, тело {actions:[{type,...}]} (обёртка
// объектом с ключом actions, В ОТЛИЧИЕ от городского /progress/, который принимает голый массив —
// подтверждено уже работающим modules/capital.js): build/move/upgrade уже использовались там;
// 'destroy' для столицы новый, не проверялся вживую — если сервер её не примет, ошибка прилетит
// на фронт как есть.
module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  async function findGuildContext(guildTitle){
    const{CapitalSnapshot,GuildSnapshot,Account}=require('../../db/index');
    const snap=await CapitalSnapshot.findOne({where:{guild_title:guildTitle}});
    if(!snap?.guild_id)throw Object.assign(new Error('Столица не найдена'),{status:404});
    const guildId=snap.guild_id;
    const leaderRow=await GuildSnapshot.findOne({where:{guild_id:guildId,role:'Leader'}});
    if(!leaderRow)throw Object.assign(new Error('Среди ваших аккаунтов нет лидера этой гильдии — действие невозможно'),{status:404});
    const acc=await Account.findOne({where:{name:leaderRow.account}});
    if(!acc?.access_token)throw Object.assign(new Error('Аккаунт-лидер не найден'),{status:404});
    return{guildId,acc};
  }

  async function resyncSnapshot(api,guildId,guildTitle){
    try{
      const{CapitalSnapshot}=require('../../db/index');
      const{loadCapBuildingsMap,enrichCapitalBuildings}=require('../../modules/capitalHelpers');
      const prog=await api.get(`/capitals/progress/${guildId}`);
      const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      await CapitalSnapshot.upsert({guild_id:guildId,guild_title:guildTitle,buildings:JSON.stringify(buildings),updated_at:new Date()},{conflictFields:['guild_id']});
      // без is_upgradable живая рассылка "стирала" бейджи/подсветку уровней на карте при каждом
      // SSE-обновлении — сырые данные игры этого поля не несут вообще (см. capitalHelpers.js)
      capitalLive.broadcast(guildId,enrichCapitalBuildings(buildings,loadCapBuildingsMap()));
      return buildings;
    }catch(e){logger.warn(`[capital:${guildId}] [capital-strategy] resync: ${e.message}`);return null;}
  }

  app.get('/api/capital-strategy/:guildTitle/live-stream',async(req,res)=>{
    const{CapitalSnapshot}=require('../../db/index');
    const snap=await CapitalSnapshot.findOne({where:{guild_title:req.params.guildTitle}});
    if(!snap?.guild_id)return res.status(404).end();
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    capitalLive.subscribe(snap.guild_id,res);
    req.on('close',()=>{capitalLive.unsubscribe(snap.guild_id,res);});
  });

  app.post('/api/capital-strategy/:guildTitle/refresh',async(req,res)=>{
    try{
      const result=await opRegistry.run(`capitalRefresh:${req.params.guildTitle}`,async()=>{
        const{guildId,acc}=await findGuildContext(req.params.guildTitle);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        const buildings=await resyncSnapshot(api,guildId,req.params.guildTitle);
        if(buildings===null)return{status:500,body:{ok:false,error:'Не удалось получить данные с игры'}};
        return{status:200,body:{ok:true,buildings}};
      });
      res.status(result.status).json(result.body);
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.get('/api/capital-strategy/:guildTitle',async(req,res)=>{
    try{
      const{CapitalSnapshot,CapitalStrategy}=require('../../db/index');
      const snap=await CapitalSnapshot.findOne({where:{guild_title:req.params.guildTitle}});
      if(!snap?.guild_id)return res.json({ok:true,targets:[],queue:[]});
      const row=await CapitalStrategy.findOne({where:{guild_id:snap.guild_id}});
      let targets=[],queue=[];
      if(row?.targets){try{targets=JSON.parse(row.targets)||[];}catch(_){}}
      if(row?.queue){try{queue=JSON.parse(row.queue)||[];}catch(_){}}
      res.json({ok:true,targets,queue});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/capital-strategy/:guildTitle/queue',async(req,res)=>{
    try{
      const{CapitalSnapshot,CapitalStrategy}=require('../../db/index');
      const snap=await CapitalSnapshot.findOne({where:{guild_title:req.params.guildTitle}});
      if(!snap?.guild_id)return res.status(404).json({ok:false,error:'Столица не найдена'});
      const queue=Array.isArray(req.body?.queue)?req.body.queue:[];
      const clean=queue.filter(q=>q&&q.x!=null&&q.y!=null).map(q=>({x:Number(q.x),y:Number(q.y)}));
      await CapitalStrategy.upsert({guild_id:snap.guild_id,queue:JSON.stringify(clean),updated_at:new Date()},{conflictFields:['guild_id']});
      try{
        const{acc}=await findGuildContext(req.params.guildTitle);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await resyncSnapshot(api,snap.guild_id,req.params.guildTitle);
      }catch(_){}
      require('../../utils/cityWake').wake(`capital:${snap.guild_id}`);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/capital-strategy/:guildTitle',async(req,res)=>{
    try{
      const{CapitalSnapshot,CapitalStrategy}=require('../../db/index');
      const snap=await CapitalSnapshot.findOne({where:{guild_title:req.params.guildTitle}});
      if(!snap?.guild_id)return res.status(404).json({ok:false,error:'Столица не найдена'});
      const targets=Array.isArray(req.body?.targets)?req.body.targets:[];
      const clean=targets
        .filter(t=>t&&t.x!=null&&t.y!=null&&Number(t.target_level)>0)
        .map(t=>({x:Number(t.x),y:Number(t.y),target_level:Math.floor(Number(t.target_level))}));
      await CapitalStrategy.upsert({guild_id:snap.guild_id,targets:JSON.stringify(clean),updated_at:new Date()},{conflictFields:['guild_id']});
      try{
        const{acc}=await findGuildContext(req.params.guildTitle);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await resyncSnapshot(api,snap.guild_id,req.params.guildTitle);
      }catch(_){}
      require('../../utils/cityWake').wake(`capital:${snap.guild_id}`);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/capital-strategy/:guildTitle/action-log',async(req,res)=>{
    try{
      const{CapitalSnapshot,CapitalActionLog}=require('../../db/index');
      const snap=await CapitalSnapshot.findOne({where:{guild_title:req.params.guildTitle}});
      if(!snap?.guild_id)return res.json({ok:true,rows:[]});
      const limit=Math.min(500,Math.max(1,Number(req.query.limit)||200));
      const rows=await CapitalActionLog.findAll({where:{guild_id:snap.guild_id},order:[['created_at','DESC']],limit});
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Прогноз — единственный живой запрос всего раздела: свежие end/level/coins/сила экономики,
  // дальше чистая функция simulateFutureCapitalActions (modules/capitalProgress.js).
  app.get('/api/capital-strategy/:guildTitle/forecast',async(req,res)=>{
    try{
      const{guildId,acc}=await findGuildContext(req.params.guildTitle);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const{loadCapBuildingsMap,capHallLevel}=require('../../modules/capitalHelpers');
      const{loadCapitalStrategy,loadGlobalCapitalPlan,simulateFutureCapitalActions}=require('../../modules/capitalProgress');
      const prog=await api.get(`/capitals/progress/${guildId}`);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const coins=prog?.progress?.coins||0;
      const econStrength=prog?.economic_strength||1;
      const buildingsMap=loadCapBuildingsMap();
      const hallLevel=capHallLevel(current,buildingsMap);
      const[{targets,queue},globalPlan]=await Promise.all([loadCapitalStrategy(guildId),loadGlobalCapitalPlan()]);
      // profit_coins из живого ответа — та же величина "прибыль/ч", что уже показывает страница
      // "Столицы" (CapitalSnapshot.profit_coins), берём самую свежую точку таймлайна params
      const allParams=Array.isArray(prog?.progress?.params)?prog.progress.params:[];
      const sorted=[...allParams].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
      const now=Date.now();
      const past=sorted.filter(p=>new Date(p.timestamp).getTime()<=now);
      const pCurrent=past[past.length-1]??sorted[0]??null;
      const capitalProfitPerHour=pCurrent?.profit_coins||0;
      const events=simulateFutureCapitalActions(current,queue,targets,globalPlan,buildingsMap,hallLevel,econStrength,coins,capitalProfitPerHour);
      res.json({ok:true,events});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.get('/api/global-capital-upgrade-plan',async(req,res)=>{
    try{
      const{GlobalCapitalUpgradePlan}=require('../../db/index');
      const rows=await GlobalCapitalUpgradePlan.findAll();
      res.json({ok:true,plan:rows.map(r=>({family_id:r.family_id,target_level:r.target_level}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/global-capital-upgrade-plan',async(req,res)=>{
    try{
      const{GlobalCapitalUpgradePlan,GuildSnapshot}=require('../../db/index');
      const plan=Array.isArray(req.body?.plan)?req.body.plan:[];
      const clean=plan
        .filter(p=>p&&p.family_id&&Number(p.target_level)>0)
        .map(p=>({family_id:String(p.family_id),target_level:Math.floor(Number(p.target_level))}));
      await GlobalCapitalUpgradePlan.destroy({where:{}});
      if(clean.length)await GlobalCapitalUpgradePlan.bulkCreate(clean.map(p=>({...p,updated_at:new Date()})));
      // правило может коснуться любой столицы — будим все активные циклы прокачки столиц
      try{
        const rows=await GuildSnapshot.findAll({where:{role:'Leader'},attributes:['guild_id']});
        const{wake}=require('../../utils/cityWake');
        const seen=new Set();
        for(const r of rows){if(seen.has(r.guild_id))continue;seen.add(r.guild_id);wake(`capital:${r.guild_id}`);}
      }catch(_){}
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Строительство: разово, клетку выбирает пользователь кликом на карте.
  app.post('/api/capital-actions/:guildTitle/build',async(req,res)=>{
    try{
      const{family_id,x,y}=req.body||{};
      if(!family_id)return res.status(400).json({ok:false,error:'family_id обязателен'});
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const{guildId,acc}=await findGuildContext(req.params.guildTitle);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get(`/capitals/progress/${guildId}`).catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      if(current.some(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y)))
        return res.status(400).json({ok:false,error:'Клетка уже занята'});
      const r=await api.post(`/capitals/progress/${guildId}`,{actions:[{type:'build',id:family_id,x:Number(x),y:Number(y)}]});
      await resyncSnapshot(api,guildId,req.params.guildTitle);
      if(r?.coins!==undefined)await logCapitalAction(guildId,'build',{x:Number(x),y:Number(y),building_id:family_id});
      require('../../utils/cityWake').wake(`capital:${guildId}`);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Перемещение: разово. Переносим координату личной цели, если она стояла на исходной клетке.
  app.post('/api/capital-actions/:guildTitle/move',async(req,res)=>{
    try{
      const{from,to}=req.body||{};
      if(!from||!to)return res.status(400).json({ok:false,error:'from и to обязательны'});
      const{guildId,acc}=await findGuildContext(req.params.guildTitle);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const r=await api.post(`/capitals/progress/${guildId}`,{actions:[{type:'move',x:Number(from.x),y:Number(from.y),to:{x:Number(to.x),y:Number(to.y)}}]});
      await resyncSnapshot(api,guildId,req.params.guildTitle);
      if(r?.coins!==undefined){
        try{
          const{CapitalStrategy}=require('../../db/index');
          const row=await CapitalStrategy.findOne({where:{guild_id:guildId}});
          const patch={};
          if(row?.targets){
            const arr=JSON.parse(row.targets);
            if(Array.isArray(arr)){
              const t=arr.find(t=>Number(t.x)===Number(from.x)&&Number(t.y)===Number(from.y));
              if(t){t.x=Number(to.x);t.y=Number(to.y);patch.targets=JSON.stringify(arr);}
            }
          }
          if(row?.queue){
            const arr=JSON.parse(row.queue);
            if(Array.isArray(arr)){
              const q=arr.find(q=>Number(q.x)===Number(from.x)&&Number(q.y)===Number(from.y));
              if(q){q.x=Number(to.x);q.y=Number(to.y);patch.queue=JSON.stringify(arr);}
            }
          }
          if(Object.keys(patch).length){patch.updated_at=new Date();await row.update(patch);}
        }catch(e){logger.warn(`[capital:${guildId}] [capital-strategy] перенос цели при перемещении: ${e.message}`);}
        await logCapitalAction(guildId,'move',{x:Number(to.x),y:Number(to.y),from_x:Number(from.x),from_y:Number(from.y)});
      }
      require('../../utils/cityWake').wake(`capital:${guildId}`);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Снос: разово (тип 'destroy' — тот же, что у городов; для столицы вживую не проверялся,
  // ошибка сервера, если он его не примет, придёт на фронт как есть).
  app.post('/api/capital-actions/:guildTitle/demolish',async(req,res)=>{
    try{
      const{x,y}=req.body||{};
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const{guildId,acc}=await findGuildContext(req.params.guildTitle);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get(`/capitals/progress/${guildId}`).catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const target=current.find(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y));
      if(!target)return res.status(400).json({ok:false,error:'На этой клетке нет здания'});
      const r=await api.post(`/capitals/progress/${guildId}`,{actions:[{type:'destroy',id:target.id,x:Number(x),y:Number(y)}]});
      await resyncSnapshot(api,guildId,req.params.guildTitle);
      if(r?.coins!==undefined)await logCapitalAction(guildId,'demolish',{x:Number(x),y:Number(y),building_id:target.id,level_from:Number(target.level||0)});
      require('../../utils/cityWake').wake(`capital:${guildId}`);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Ускорить за алмазы: разово, только для здания, которое СЕЙЧАС строится (тип 'skip-upgrade' —
  // реверс бандла игры, см. память проекта: класс qp.skipUpgrade()/getSkipUpgradeCost() —
  // ЕДИНСТВЕННОЕ место в бандле, где встречается этот тип действия — механика только у столицы, у
  // обычных городских зданий её нет). Цену считает сама игра по факту (зависит от оставшегося
  // времени стройки на момент запроса — присланная фронтом оценка может чуть разойтись с реальным
  // списанием, если пользователь долго держал открытой очередь), поэтому явно проверяем баланс
  // алмазов ДО и ПОСЛЕ только для лога, не для валидации (её делает сама игра).
  app.post('/api/capital-actions/:guildTitle/skip-upgrade',async(req,res)=>{
    try{
      const{x,y}=req.body||{};
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const{guildId,acc}=await findGuildContext(req.params.guildTitle);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get(`/capitals/progress/${guildId}`).catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const target=current.find(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y));
      if(!target)return res.status(400).json({ok:false,error:'На этой клетке нет здания'});
      const underConstruction=!!target.end&&new Date(target.end).getTime()>Date.now();
      if(!underConstruction)return res.status(400).json({ok:false,error:'Здание сейчас не строится'});
      const crystalsBefore=prog?.progress?.crystals;
      const r=await api.post(`/capitals/progress/${guildId}`,{actions:[{type:'skip-upgrade',id:target.id,x:Number(x),y:Number(y)}]});
      await resyncSnapshot(api,guildId,req.params.guildTitle);
      if(r?.coins!==undefined){
        const crystalsSpent=(typeof crystalsBefore==='number'&&typeof r?.crystals==='number')?Math.max(0,crystalsBefore-r.crystals):null;
        await logCapitalAction(guildId,'skip-upgrade',{x:Number(x),y:Number(y),building_id:target.id,detail:crystalsSpent!=null?JSON.stringify({crystals_spent:crystalsSpent}):null});
      }
      require('../../utils/cityWake').wake(`capital:${guildId}`);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });
};
