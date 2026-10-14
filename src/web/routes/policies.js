'use strict';

// Система Политик добавлена в игру 06.07.2026 (см. память project-game-update-2026-07).
// Эндпоинты и payload подтверждены реверсом клиента статически (chunks/storage-*, chunks/townhall-*
// — реальные call-сайты действий), БЕЗ единого живого мутирующего запроса к игре:
//   GET  /policies/                 — список политик игрока (инстансы)
//   GET  /policies/library          — библиотека (все def-ы, сгруппированные по редкости)
//   GET  /policies/cabinet          — кабинет мэра ({slots:[{slot,unlocked,instance}],civic_draw})
//   POST /policies/enact            {instance_id, slot}   — slot берём из первого свободного (unlocked && !instance)
//   POST /policies/unequip          {instance_id}
//   POST /policies/levelup          {instance_id}
//   POST /policies/promote          {instance_id}
//   POST /policies/dissolve         {instance_id}
//   POST /policies/mystery/craft    {rarity}
//   POST /policies/mystery/open     {rarity}
//   POST /policies/civic-draw/claim {}  (пустое тело)

const ACTION_ENDPOINTS={
  enact:'/policies/enact',
  unequip:'/policies/unequip',
  levelup:'/policies/levelup',
  promote:'/policies/promote',
  dissolve:'/policies/dissolve',
  'mystery-craft':'/policies/mystery/craft',
  'mystery-open':'/policies/mystery/open',
  'civic-draw-claim':'/policies/civic-draw/claim',
};

// осколки политик/тайные политики хранятся в общей таблице Inventory (тот же /storage/allitemdata),
// но помечены типом — здесь их достаём для страницы "Политики" вместо страницы "Предметы"
const SHARD_ITEM_TYPES=new Set(['policy_shard','mystery_policy']);

module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;
  // Политики (и открытие тайных политик) открываются игрой при населении 1M —
  // используем для дизейбла кнопки "Открыть" на аккаунтах, которые условие не выполнили
  const POLICIES_UNLOCK_POPULATION=1_000_000;

  // данные читаются из БД (снимок пишет src/modules/policies.js в дневном цикле бота
  // или по кнопке "Обновить" → POST /api/refresh/policies) — аналогично странице "Предметы"
  app.get('/api/policies',async(req,res)=>{
    try{
      const{Account,PolicySnapshot,Inventory}=require('../../db/index');
      const{Op}=require('sequelize');
      const accs=await Account.findAll({attributes:['id','name','population_final']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const accNames=accs.map(a=>a.name);

      const snaps=await PolicySnapshot.findAll({where:{account:{[Op.in]:accNames.length?accNames:['__none__']}}});
      const shardRows=await Inventory.findAll({
        where:{account:{[Op.in]:accNames.length?accNames:['__none__']},type:{[Op.in]:[...SHARD_ITEM_TYPES]}},
        order:[['account','ASC'],['name','ASC']],
      });

      const byAccount={};
      for(const a of accs){
        const pop=parseFloat(a.population_final);
        byAccount[a.name]={list:[],library:{discovered:0,total:0,sections:[]},cabinet:{slots:[],civic_draw:null},economy:null,shards:[],updated_at:null,
          population:isFinite(pop)?pop:null,policies_unlocked:isFinite(pop)&&pop>=POLICIES_UNLOCK_POPULATION};
      }

      for(const s of snaps){
        if(!byAccount[s.account])continue;
        try{byAccount[s.account].list=JSON.parse(s.list||'[]');}catch(_){}
        try{byAccount[s.account].library=JSON.parse(s.library||'{}');}catch(_){}
        try{byAccount[s.account].cabinet=JSON.parse(s.cabinet||'{}');}catch(_){}
        try{byAccount[s.account].economy=JSON.parse(s.economy||'null');}catch(_){}
        byAccount[s.account].updated_at=s.updated_at;
      }
      for(const r of shardRows){
        if(!byAccount[r.account])continue;
        byAccount[r.account].shards.push({
          id:r.name,type:r.type,
          marketable:Number(r.marketable||0),locked:Number(r.locked||0),
          qty:Number(r.marketable||0)+Number(r.locked||0),
        });
      }
      res.json({ok:true,byAccount,accIdByName});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // "Библиотека политик" (Мэрия): каталог описаний, накопленный со ВСЕХ аккаунтов бота —
  // полного списка всех политик клиент игры не хранит (см. src/modules/policies.js), поэтому
  // отдаём то, что реально было замечено (растёт со временем), плюс totals по редкости из
  // /policies/library любого аккаунта (эти числа общие для игры, не зависят от аккаунта)
  app.get('/api/policy-defs',async(req,res)=>{
    try{
      const{PolicyDefCatalog,PolicySnapshot}=require('../../db/index');
      const rows=await PolicyDefCatalog.findAll({order:[['rarity','ASC'],['def_id','ASC']]});
      const defs=rows.map(r=>{
        let name=null,description=null,effects=[];
        try{name=JSON.parse(r.name||'null');}catch(_){}
        try{description=JSON.parse(r.description||'null');}catch(_){}
        try{effects=JSON.parse(r.effects||'[]');}catch(_){}
        return{
          def_id:r.def_id,rarity:r.rarity,name,description,
          icon_key:r.icon_key,theme:r.theme,badge:r.badge,badge_n:r.badge_n,
          max_level:r.max_level,effects,seen_account:r.seen_account,updated_at:r.updated_at,
        };
      });
      // totals по редкости — берём из первого снимка библиотеки, где они есть (общие для игры)
      let totalsByRarity={};
      const snap=await PolicySnapshot.findOne({where:{},order:[['updated_at','DESC']]});
      if(snap){
        try{
          const lib=JSON.parse(snap.library||'{}');
          for(const s of lib.sections||[])totalsByRarity[s.rarity]=s.total;
        }catch(_){}
      }
      res.json({ok:true,defs,totalsByRarity});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/policies/:accountId/action',async(req,res)=>{
    try{
      const{action,instance_id,rarity}=req.body||{};
      const endpoint=ACTION_ENDPOINTS[action];
      if(!endpoint)return res.status(400).json({ok:false,error:'Неизвестное действие: '+action});
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name','population_final']});
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      if(action==='mystery-open'){
        const pop=parseFloat(acc.population_final);
        if(!isFinite(pop)||pop<POLICIES_UNLOCK_POPULATION)return res.status(400).json({ok:false,error:'Открытие тайных политик доступно с 1 000 000 населения'});
      }
      const api=await makeApiForAccount(acc.id,{noLock:true});

      let body;
      switch(action){
        case 'enact':{
          if(instance_id==null)return res.status(400).json({ok:false,error:'instance_id обязателен'});
          const cab=await api.get('/policies/cabinet').catch(()=>null);
          const free=(cab?.slots||[]).find(s=>s.unlocked&&!s.instance);
          if(!free)return res.status(400).json({ok:false,error:'Нет свободных слотов в кабинете'});
          body={instance_id:Number(instance_id),slot:free.slot};
          break;
        }
        case 'unequip':case 'levelup':case 'promote':case 'dissolve':
          if(instance_id==null)return res.status(400).json({ok:false,error:'instance_id обязателен'});
          body={instance_id:Number(instance_id)};
          break;
        case 'mystery-craft':case 'mystery-open':
          if(!rarity)return res.status(400).json({ok:false,error:'rarity обязателен'});
          body={rarity};
          break;
        case 'civic-draw-claim':
          body={};
          break;
      }

      // Прогресс розыгрыша копится не строго линейно от времени (завязан на живое "разнообразие
      // города", может и падать) — кнопка "Получить" на странице включается по клиентской
      // экстраполяции (см. liveDrawState в CivicDraw.tsx), которая иногда ошибается. Перепроверяем
      // актуальный claimable живым запросом перед самим claim, чтобы не слать обречённый запрос
      // и сразу освежить снимок в БД, если оценка устарела (см. claim-all в civicDraw.js).
      if(action==='civic-draw-claim'){
        const{runTownhall}=require('../../modules/townhall');
        const diversity=await api.get('/progress/diversity').catch(()=>null);
        if(diversity?.civic_draw?.claimable!==true){
          await runTownhall(api,acc.name).catch(()=>{});
          return res.status(409).json({ok:false,error:'Розыгрыш ещё не готов по факту в игре (оценка на странице устарела) — снимок обновлён'});
        }
      }
      const result=await api.post(endpoint,body);
      // синхронизируем снимок в БД, чтобы страница сразу отражала актуальное состояние.
      // mystery-craft/open/levelup/promote/dissolve тратят или производят осколки (policy_shard/
      // mystery_policy) — они живут в таблице Inventory, которую пишет ТОЛЬКО runInventory, а не
      // runPolicies (тот синкает только list/library/cabinet/economy). Раньше после этих действий
      // Inventory не резинкался вообще — новая тайная политика/осталось осколков не появлялись,
      // пока не отработает дневной цикл бота или ручное обновление на странице "Предметы".
      if(action==='civic-draw-claim'){
        await require('../../modules/townhall').runTownhall(api,acc.name).catch(()=>{});
      }else{
        await require('../../modules/policies').runPolicies(api,acc.name).catch(()=>{});
        if(action!=='enact'&&action!=='unequip')await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
      }
      res.json({ok:true,result});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
