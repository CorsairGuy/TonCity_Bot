'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');

module.exports=function(app,ctx){


  // ── Справочники карты, пауза прокачки, снимки городов/столиц ──────────────
  function readSections(){
    const fp=path.join(process.cwd(),'config','city_sections.json');
    if(!fs.existsSync(fp))return[];
    try{return JSON.parse(fs.readFileSync(fp,'utf8'));}catch(_){return[];}
  }

  app.get('/api/sections',(req,res)=>{
    try{res.json({ok:true,sections:readSections()});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.get('/api/bot-state',(req,res)=>{
    try{const{read}=require('../../utils/botState');res.json({ok:true,state:read()});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/bot-state',(req,res)=>{
    try{
      const{setCityPaused}=require('../../utils/botState');
      const state=setCityPaused(!!(req.body&&req.body.cityPaused));
      res.json({ok:true,state});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/coords',(req,res)=>{
    try{
      const type=req.query.type==='capital'?'capital-coords.json':'city-coords.json';
      const fp=path.join(process.cwd(),'config',type);
      if(!fs.existsSync(fp))return res.json({ok:true,coords:[]});
      res.json({ok:true,coords:JSON.parse(fs.readFileSync(fp,'utf8'))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/buildingslist',(req,res)=>{
    try{
      // ГОРОД: отдаём тот же каталог, по которому считает бот — живой (config/buildings-live.json,
      // см. utils/buildingCatalog.js), а статичный buildings.txt только фолбэком. Иначе панель
      // показывает ДОСОБЫТИЙНЫЕ цены: на карнавале скидку −75% сервер отдаёт прямо в каталоге
      // (base_price ×0.25), и без живого каталога все цены на карте города вчетверо завышены —
      // ровно на это была жалоба 21.08.2026, уже ПОСЛЕ починки каталога у бота.
      // СТОЛИЦА: у неё свой формат и свой файл, живого каталога для неё нет.
      if(req.query.type==='capital'){
        const fp=path.join(process.cwd(),'config','capital_buildings.txt');
        if(!fs.existsSync(fp))return res.json({ok:true,buildings:[]});
        return res.json({ok:true,buildings:JSON.parse(fs.readFileSync(fp,'utf8'))});
      }
      const map=require('../cityStats').buildingsMap();
      res.json({ok:true,buildings:[...map.values()]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/city-snapshots',async(req,res)=>{
    try{
      const{CitySnapshot}=require('../../db/index');
      // ?account= — снимок одного города (карте не нужен весь флот)
      const where=req.query.account?{account:String(req.query.account)}:undefined;
      const rows=await CitySnapshot.findAll({where,order:[['account','ASC']]});
      // unlockedSections=null означает «в снимке этих данных ещё нет» (старая строка или снимок
      // писал код, который поле не заполнял). Это НЕ то же самое, что пустой список: на пустом
      // списке карта заперла бы весь город. Клиент по null просто не рисует замки — см. CityMapCity.
      res.json({ok:true,rows:rows.map(r=>({account:r.account,buildings:r.buildings?JSON.parse(r.buildings):[],unlockedSections:r.unlocked_sections?JSON.parse(r.unlocked_sections):null,updated_at:r.updated_at}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Общая карта всех городов: снимки построек, показатели из Account, ручные очереди и личные цели одним
  // запросом. Порядок городов — config.ui.cityOrder (ручное перетаскивание), остальные по доходу.
  app.get('/api/city-world',async(req,res)=>{
    try{
      const{CitySnapshot,Account}=require('../../db/index');
      const plansMod=require('../../db/cityPlans');
      const[snaps,accs,queues,builds,targets]=await Promise.all([
        CitySnapshot.findAll({order:[['account','ASC']]}),
        Account.findAll({attributes:['name','balance','profit','profit_final','population','population_final','happiness']}),
        plansMod.loadAllQueues(),
        plansMod.loadBuildPlans(),
        plansMod.loadAllTargets(),
      ]);
      const byName=new Map(accs.map(a=>[a.name,a]));
      const n=v=>{const x=Number(v);return isFinite(x)?x:0;};
      const rows=snaps.filter(r=>byName.has(r.account)).map(r=>{
        const a=byName.get(r.account);
        return{account:r.account,buildings:r.buildings?JSON.parse(r.buildings):[],unlockedSections:r.unlocked_sections?JSON.parse(r.unlocked_sections):null,updated_at:r.updated_at,
          balance:n(a.balance),profit:n(a.profit),profit_final:n(a.profit_final),population:n(a.population),population_final:n(a.population_final),happiness:n(a.happiness),
          queue:queues[r.account]||[],targets:targets[r.account]||[],buildPlan:builds[r.account]||[]};
      });
      const order=require('../../config').getConfig().ui?.cityOrder;
      res.json({ok:true,rows,order:Array.isArray(order)?order:[]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/capital-snapshots',async(req,res)=>{
    try{
      const{CapitalSnapshot,GuildSnapshot,Account}=require('../../db/index');
      const{loadCapBuildingsMap,enrichCapitalBuildings}=require('../../modules/capitalHelpers');
      const capBuildingsMap=loadCapBuildingsMap();
      // Показываем только столицы гильдий, где среди наших аккаунтов реально ЕСТЬ лидер (только
      // лидер видит/апгрейдит столицу, см. capitalStrategy.js findGuildContext) — иначе после
      // удаления аккаунта-лидера гильдия годами висела бы в списке осиротевшей записью
      // CapitalSnapshot, хотя мы её больше не контролируем.
      const leaderRows=await GuildSnapshot.findAll({where:{role:['Leader','Officer']},attributes:['guild_id','account']});
      const accountNames=new Set((await Account.findAll({attributes:['name']})).map(a=>a.name));
      const leaderGuildIds=new Set(leaderRows.filter(r=>accountNames.has(r.account)).map(r=>r.guild_id));
      const rows=leaderGuildIds.size
        ?await CapitalSnapshot.findAll({where:{guild_id:[...leaderGuildIds]},order:[['guild_title','ASC']]})
        :[];
      res.json({ok:true,rows:rows.map(r=>{
        const buildings=enrichCapitalBuildings(r.buildings?JSON.parse(r.buildings):[],capBuildingsMap);
        return{guild_id:r.guild_id,guild_title:r.guild_title,buildings,coins:r.coins,crystals:r.crystals,profit_coins:r.profit_coins,profit_crystals:r.profit_crystals,profit_coins_final:r.profit_coins_final,profit_crystals_final:r.profit_crystals_final,economic_strength:r.economic_strength,updated_at:r.updated_at};
      })});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
