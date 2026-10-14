'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');

module.exports=function(app,ctx){


  // ── Reference plans ──────────────────────────────────────────────────────
  function refplansFile(type){
    return path.join(process.cwd(),'config',type==='capital'?'capital-refplans.json':'city-refplans.json');
  }
  function readRefplans(type){
    const fp=refplansFile(type);
    if(!fs.existsSync(fp))return[];
    try{return JSON.parse(fs.readFileSync(fp,'utf8'));}catch(_){return[];}
  }
  function writeRefplans(type,plans){
    // атомарная запись: temp + rename, чтобы работающий цикл бота не прочитал полу-сохранённый файл
    const fp=refplansFile(type);
    const tmp=fp+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(plans,null,2),'utf8');
    fs.renameSync(tmp,fp);
  }
  function readPhases(){
    const fp=path.join(process.cwd(),'config','phases.json');
    if(!fs.existsSync(fp))return[];
    try{return JSON.parse(fs.readFileSync(fp,'utf8'));}catch(_){return[];}
  }
  function phaseMeta(ph){return readPhases().find(p=>Number(p.phase)===Number(ph))||null;}
  function readSections(){
    const fp=path.join(process.cwd(),'config','city_sections.json');
    if(!fs.existsSync(fp))return[];
    try{return JSON.parse(fs.readFileSync(fp,'utf8'));}catch(_){return[];}
  }
  function defaultUnlockedSections(){return readSections().filter(s=>s.defaultUnlocked).map(s=>s.id);}

  app.get('/api/refplans',(req,res)=>{
    try{
      const type=req.query.type==='capital'?'capital':'city';
      let plans;
      if(type==='city'){
        const{computeCityStats}=require('../cityStats');
        plans=readRefplans(type).map(({buildings,...p})=>({...p,stats:computeCityStats(buildings||[])}));
      }else{
        plans=readRefplans(type).map(({buildings,...p})=>p);
      }
      res.json({ok:true,plans});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/refplans/:id',(req,res)=>{
    try{
      const type=req.query.type==='capital'?'capital':'city';
      const plan=readRefplans(type).find(p=>String(p.id)===req.params.id);
      if(!plan)return res.status(404).json({ok:false,error:'Not found'});
      res.json({ok:true,plan});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/refplans',(req,res)=>{
    try{
      const{type='city',name,threshold,buildings,id,phase,popThreshold,profitThreshold,unlockedSections}=req.body||{};
      const t=type==='capital'?'capital':'city';
      const plans=readRefplans(t);
      if(t==='city'){
        // режим фаз: ровно один план на фазу. Фазу берём из тела или из существующей записи.
        const existing=id!=null?plans.find(p=>p.id===id):null;
        const ph=phase!=null?Number(phase):(existing?Number(existing.phase):NaN);
        if(!Number.isInteger(ph))return res.status(400).json({ok:false,error:'phase required'});
        const dup=plans.find(p=>Number(p.phase)===ph&&p.id!==id);
        if(dup)return res.status(409).json({ok:false,error:`На фазу ${ph} уже есть референс — отредактируйте его`});
        const meta=phaseMeta(ph);
        const pop=popThreshold!=null?Number(popThreshold):(existing?.popThreshold??meta?.popThreshold??0);
        const profit=profitThreshold!=null?Number(profitThreshold):(existing?.profitThreshold??meta?.profitThreshold??0);
        const rec={
          id: id!=null?id:(plans.length?Math.max(...plans.map(p=>p.id))+1:1),
          name: (name??existing?.name??meta?.name??String(ph)),
          phase: ph,
          popThreshold: pop,
          profitThreshold: profit,
          threshold: pop,
          unlockedSections: Array.isArray(unlockedSections)?unlockedSections:(existing?.unlockedSections??defaultUnlockedSections()),
          buildings: buildings!=null?buildings:(existing?.buildings||[]),
        };
        const idx=plans.findIndex(p=>p.id===rec.id);
        if(idx>=0)plans[idx]=rec; else plans.push(rec);
        writeRefplans(t,plans);
        const{buildings:_b,...metaOut}=rec;
        return res.json({ok:true,plan:metaOut});
      }
      // capital — без изменений (старый формат threshold)
      if(id!=null){
        const idx=plans.findIndex(p=>p.id===id);
        if(idx>=0)plans[idx]={id,name,threshold:Number(threshold),buildings};
        else plans.push({id,name,threshold:Number(threshold),buildings});
      }else{
        const newId=plans.length?Math.max(...plans.map(p=>p.id))+1:1;
        plans.push({id:newId,name,threshold:Number(threshold),buildings});
      }
      writeRefplans(t,plans);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/phases',(req,res)=>{
    try{res.json({ok:true,phases:readPhases()});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.get('/api/building-phases',(req,res)=>{
    try{
      const fp=path.join(process.cwd(),'config','city-building-phases.json');
      const map=fs.existsSync(fp)?JSON.parse(fs.readFileSync(fp,'utf8')):{};
      res.json({ok:true,map});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
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

  app.delete('/api/refplans/:id',(req,res)=>{
    try{
      const type=req.query.type==='capital'?'capital':'city';
      const plans=readRefplans(type).filter(p=>String(p.id)!==req.params.id);
      writeRefplans(type,plans);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Импорт карты города конкретного аккаунта как референса фазы.
  app.post('/api/refplans/:id/from-account',async(req,res)=>{
    try{
      const{CitySnapshot}=require('../../db/index');
      const account=(req.body&&req.body.account)||'';
      const row=await CitySnapshot.findOne({where:{account}});
      if(!row)return res.status(404).json({ok:false,error:'Снимок города аккаунта не найден'});
      const buildings=(row.buildings?JSON.parse(row.buildings):[]).map(b=>({x:b.x,y:b.y,id:b.id,level:Number(b.level||1)}));
      const plans=readRefplans('city');
      const idx=plans.findIndex(p=>String(p.id)===req.params.id);
      if(idx<0)return res.status(404).json({ok:false,error:'Референс не найден'});
      plans[idx]={...plans[idx],buildings};
      writeRefplans('city',plans);
      const{computeCityStats}=require('../cityStats');
      res.json({ok:true,count:buildings.length,stats:computeCityStats(buildings)});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Автогенерация оптимальной раскладки для одной фазы.
  app.post('/api/refplans/:id/generate',(req,res)=>{
    try{
      const{generateCityRefplan}=require('../cityGen');
      const plans=readRefplans('city');
      const idx=plans.findIndex(p=>String(p.id)===req.params.id);
      if(idx<0)return res.status(404).json({ok:false,error:'Референс не найден'});
      const phase=Number(plans[idx].phase);
      const g=generateCityRefplan(phase);
      plans[idx]={...plans[idx],unlockedSections:g.unlockedSections,buildings:g.buildings};
      writeRefplans('city',plans);
      res.json({ok:true,count:g.buildings.length,stats:g.stats});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Автогенерация всех фаз (создаёт отсутствующие референсы фаз).
  app.post('/api/refplans/generate-all',(req,res)=>{
    try{
      const{generateCityRefplan}=require('../cityGen');
      const phases=readPhases();
      const plans=readRefplans('city');
      const results=[];
      for(const ph of phases){
        const p=Number(ph.phase);
        const g=generateCityRefplan(p);
        let rec=plans.find(x=>Number(x.phase)===p);
        if(!rec){
          rec={id:(plans.length?Math.max(...plans.map(x=>x.id))+1:1),phase:p,name:ph.name||String(p),
               popThreshold:ph.popThreshold||0,profitThreshold:ph.profitThreshold||0,threshold:ph.popThreshold||0};
          plans.push(rec);
        }
        rec.unlockedSections=g.unlockedSections;
        rec.buildings=g.buildings;
        results.push({phase:p,count:g.buildings.length,population:g.stats.population,profit:g.stats.profit,happiness:g.stats.happiness});
      }
      writeRefplans('city',plans);
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Legacy plan endpoints (kept for backward compat) ─────────────────────
  app.get('/api/cityplan',(req,res)=>{
    try{
      const fp=path.join(process.cwd(),'config','city-plan.json');
      if(!fs.existsSync(fp))return res.json({ok:true,buildings:[]});
      res.json({ok:true,buildings:JSON.parse(fs.readFileSync(fp,'utf8')).buildings||[]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/cityplan',(req,res)=>{
    try{
      const fp=path.join(process.cwd(),'config','city-plan.json');
      fs.writeFileSync(fp,JSON.stringify({buildings:req.body.buildings||[]},null,2),'utf8');
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/capitalplan',(req,res)=>{
    try{
      const fp=path.join(process.cwd(),'config','capital-plan.json');
      if(!fs.existsSync(fp))return res.json({ok:true,buildings:[]});
      res.json({ok:true,buildings:JSON.parse(fs.readFileSync(fp,'utf8')).buildings||[]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/capitalplan',(req,res)=>{
    try{
      const fp=path.join(process.cwd(),'config','capital-plan.json');
      fs.writeFileSync(fp,JSON.stringify({buildings:req.body.buildings||[]},null,2),'utf8');
      res.json({ok:true});
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
      const type=req.query.type==='capital'?'capital_buildings.txt':'buildings.txt';
      const fp=path.join(process.cwd(),'config',type);
      if(!fs.existsSync(fp))return res.json({ok:true,buildings:[]});
      res.json({ok:true,buildings:JSON.parse(fs.readFileSync(fp,'utf8'))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/city-snapshots',async(req,res)=>{
    try{
      const{CitySnapshot}=require('../../db/index');
      const rows=await CitySnapshot.findAll({order:[['account','ASC']]});
      res.json({ok:true,rows:rows.map(r=>({account:r.account,buildings:r.buildings?JSON.parse(r.buildings):[],unlockedSections:r.unlocked_sections?JSON.parse(r.unlocked_sections):[],updated_at:r.updated_at}))});
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
      const leaderRows=await GuildSnapshot.findAll({where:{role:'Leader'},attributes:['guild_id','account']});
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
