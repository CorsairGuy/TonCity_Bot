'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  app.get('/api/loyalty-road',async(req,res)=>{
    try{
      const{Account,LoyaltySnapshot}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const rows=await Promise.all(accs.map(async a=>{
        const snap=await LoyaltySnapshot.findOne({where:{account:a.name}});
        if(!snap)return{account_id:a.id,account:a.name,data:{levels:[],streak:0},updated_at:null};
        return{account_id:a.id,account:a.name,data:{levels:JSON.parse(snap.levels||'[]'),streak:snap.streak},updated_at:snap.updated_at};
      }));
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Storage live endpoints ─────────────────────────────────────────────────
  async function getStorageLive(accountId){
    const api=await makeApiForAccount(accountId,{noLock:true});
    const[storData,rulesData,activeData]=await Promise.all([
      api.get('/storage/allitemdata').catch(()=>null),
      api.get('/boosters/combination-rules').catch(()=>null),
      api.get('/boosters/active').catch(()=>null),
    ]);
    const rawItems=storData?.items;
    const items=Array.isArray(rawItems)?rawItems:Object.values(rawItems||{});
    return{
      items,
      booster_packs:storData?.booster_packs||[],
      combination_rules:rulesData?.combination_rules||rulesData||[],
      active_boosters:Array.isArray(activeData)?activeData:(activeData?.boosters||[]),
    };
  }

  app.get('/api/storage-live/:accountId',async(req,res)=>{
    try{
      const data=await getStorageLive(Number(req.params.accountId));
      res.json({ok:true,...data});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/storage-live/:accountId/sell',async(req,res)=>{
    try{
      const{item_id,amount}=req.body||{};
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const r=await api.post('/storage/items/sell',{item_id:Number(item_id),amount:Number(amount)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/storage-live/:accountId/activate',async(req,res)=>{
    try{
      const{item_id}=req.body||{};
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const r=await api.post('/boosters/activate',{id:Number(item_id)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/storage-live/:accountId/combine',async(req,res)=>{
    try{
      const{from_item_id,amount}=req.body||{};
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const r=await api.post('/boosters/combine',{from_item_id:Number(from_item_id),amount:Number(amount)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/storage-live/:accountId/open-pack',async(req,res)=>{
    try{
      const{item_id}=req.body||{};
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const r=await api.post('/booster-packs/open',{id:Number(item_id)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/storage-live/:accountId/set-target',async(req,res)=>{
    try{
      const{pack_id,target_item_id}=req.body||{};
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const r=await api.post('/booster-packs/set-target',{pack_id:Number(pack_id),target_item_id:Number(target_item_id)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // синхронизация инвентаря одного аккаунта в БД с игры (после расхода предметов)
  app.post('/api/storage-live/:accountId/sync',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId));
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const api=await makeApiForAccount(acc.id,{noLock:true});
      await require('../../modules/inventory').runInventory(api,acc.name);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Shop Live ─────────────────────────────────────────────────────────────
  function normalizeShopOffers(rawItems,gameType){
    return (Array.isArray(rawItems)?rawItems:[]).map(item=>{
      const base={
        item_id:item.item_id,
        offers:(item.offers||[]).map(o=>({
          offer_id:o.id,
          offer_type:o.offer_type,
          price:o.price,
          limit:o.limit?.limit||0,
          current:o.limit?.current||0,
          limit_type:o.limit?.type||'daily',
          league_required:o.league_condition?.league||null,
          league_met:o.league_condition?o.league_condition.met:true,
        })),
      };
      if(gameType==='booster'&&item.booster){
        base.rarity=item.booster.rarity;
        base.multiplier=item.booster.multiplier;
        base.duration_ns=item.booster.duration;
        base.active_limit=item.booster.active_limit;
      }
      if(gameType==='booster_pack'&&item.booster_pack){
        base.pack_type=item.booster_pack.type;
      }
      return base;
    });
  }

  app.get('/api/shop-live/boosters',async(req,res)=>{
    try{
      const accounts=await opRegistry.run('shopBoosters',async()=>{
        const{Account}=require('../../db/index');
        const{Op}=require('sequelize');
        const accs=await Account.findAll({where:{access_token:{[Op.not]:null}},order:[['name','ASC']],attributes:['id','name']});
        return Promise.all(accs.map(async acc=>{
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const raw=await api.get('/shop/offers/booster');
            return{id:acc.id,name:acc.name,items:normalizeShopOffers(raw,'booster')};
          }catch(e){return{id:acc.id,name:acc.name,items:[],error:e.message};}
        }));
      });
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/shop-live/packs',async(req,res)=>{
    try{
      const accounts=await opRegistry.run('shopPacks',async()=>{
        const{Account}=require('../../db/index');
        const{Op}=require('sequelize');
        const accs=await Account.findAll({where:{access_token:{[Op.not]:null}},order:[['name','ASC']],attributes:['id','name']});
        return Promise.all(accs.map(async acc=>{
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const raw=await api.get('/shop/offers/booster_pack');
            return{id:acc.id,name:acc.name,items:normalizeShopOffers(raw,'booster_pack')};
          }catch(e){return{id:acc.id,name:acc.name,items:[],error:e.message};}
        }));
      });
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // вкладка "Политики" в Магазине (Бюро политик) — появилась в обновлении 06.07.2026,
  // тот же generic-паттерн /shop/offers/{gameType}, что и boosters/booster_pack
  app.get('/api/shop-live/policies',async(req,res)=>{
    try{
      const accounts=await opRegistry.run('shopPolicies',async()=>{
        const{Account}=require('../../db/index');
        const{Op}=require('sequelize');
        const accs=await Account.findAll({where:{access_token:{[Op.not]:null}},order:[['name','ASC']],attributes:['id','name']});
        return Promise.all(accs.map(async acc=>{
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const raw=await api.get('/shop/offers/policy_bureau');
            return{id:acc.id,name:acc.name,items:normalizeShopOffers(raw,'policy_bureau')};
          }catch(e){return{id:acc.id,name:acc.name,items:[],error:e.message};}
        }));
      });
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/shop-live/buy',async(req,res)=>{
    try{
      const{account_id,offer_id,amount=1,offer_type}=req.body||{};
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const path=offer_type==='crystals'?'/shop/buy/crystals':offer_type==='ads'?'/shop/buy/ads':'/shop/buy/coins';
      const r=await api.post(path,{offer_id:Number(offer_id),amount:Number(amount)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/shop-live/buy-all',async(req,res)=>{
    try{
      const{offer_id,amount=1,offer_type,account_ids}=req.body||{};
      if(!Array.isArray(account_ids)||account_ids.length===0)return res.status(400).json({ok:false,error:'account_ids required'});
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({where:{id:account_ids},attributes:['id','name']});
      const path=offer_type==='crystals'?'/shop/buy/crystals':offer_type==='ads'?'/shop/buy/ads':'/shop/buy/coins';
      const results=await Promise.all(accs.map(async acc=>{
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const r=await api.post(path,{offer_id:Number(offer_id),amount:Number(amount)});
          return{id:acc.id,name:acc.name,ok:true,result:r};
        }catch(e){return{id:acc.id,name:acc.name,ok:false,error:e.message};}
      }));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/staking',async(req,res)=>{
    try{
      const{StakingEntry,Account}=require('../../db/index');
      const{Op}=require('sequelize');
      const includeCollected=req.query.collected==='1';
      const where=includeCollected?{}:{collected:false};
      const [entries,accs]=await Promise.all([
        StakingEntry.findAll({where,order:[['can_collect_at','ASC']]}),
        Account.findAll({order:[['id','ASC']]}),
      ]);
      // Считаем занятые слоты по валюте для каждого аккаунта
      const activeEntries=await StakingEntry.findAll({where:{collected:false}});
      const slotMap={};
      for(const e of activeEntries){
        if(!slotMap[e.account])slotMap[e.account]={coins:0,crystals:0};
        slotMap[e.account][e.currency]=(slotMap[e.account][e.currency]||0)+1;
      }
      const accounts=accs.filter(a=>a.access_token).map(a=>({
        id:a.id,name:a.name,
        coins:parseFloat(a.balance)||0,
        crystals:parseFloat(a.crystals)||0,
        coin_slots:slotMap[a.name]?.coins||0,
        crystal_slots:slotMap[a.name]?.crystals||0,
      }));
      res.json({ok:true,entries:entries.map(e=>e.toJSON()),accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/staking/stake',async(req,res)=>{
    try{
      const{account_id,currency,amount,duration}=req.body;
      if(!account_id||!currency||!amount||!duration)return res.status(400).json({ok:false,error:'missing fields'});
      const{Account}=require('../../db/index');
      const ApiClient=require('../../api/client');
      const acc=await Account.findByPk(account_id);
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'account not found'});
      const api=await makeApiForAccount(account_id);
      const r=await api.post('/federal-reserve/staking',{currency,amount:Number(amount),duration:Number(duration)});
      if(r?.success){
        // Параллельно: обновить вклады в БД + получить актуальный баланс
        const{saveEntriesToDb}=require('../../modules/staking');
        const[sd,prog]=await Promise.all([
          api.get('/federal-reserve/staking').catch(()=>null),
          api.get('/progress/').catch(()=>null),
        ]);
        if(sd?.entries)await saveEntriesToDb(acc.name,sd.entries);
        // Записать точный баланс из ответа игры
        if(prog?.progress?.data){
          const d=prog.progress.data;
          const upd={};
          if(d.coins!=null)upd.balance=d.coins;
          if(d.crystals!=null)upd.crystals=d.crystals;
          if(Object.keys(upd).length)await acc.update(upd).catch(()=>{});
        }
        res.json({ok:true,result:r});
      } else {
        res.json({ok:false,error:JSON.stringify(r)});
      }
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/daily-ads/status',async(req,res)=>{
    try{
      const{Account,DailyAdsSnapshot}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const snaps=await DailyAdsSnapshot.findAll();
      const snapMap=Object.fromEntries(snaps.map(s=>[s.account,s]));
      // раньше здесь ещё и обнулялись current/limit_reached, если snapshot.updated_at не совпадал с
      // "сегодня" по UTC-календарной дате — эта эвристика гадает момент сброса лимита в игре (сама
      // игра нигде явно не сообщает, когда именно сбрасывает счётчик — необязательно ровно в 00:00
      // UTC), и на границе суток то и дело ложно прятала реально свежий "Готово" сразу после
      // просмотра. Снимок и так обновляется на каждом реальном просмотре/автообновлении (см.
      // web/lib/adsProgress.js, POST .../watch-all, /api/refresh/dailyads) — доверяем ему как есть,
      // без дополнительного клиентского "угадывания" свежести.
      const rows=accs.map(a=>{
        const s=snapMap[a.name];
        if(!s)return{id:a.id,name:a.name,ok:false,error:'нет данных — нажмите ↻'};
        return{id:a.id,name:a.name,ok:true,current:s.current,limit:s.limit,reward:s.reward,limit_reached:s.limit_reached,updated_at:s.updated_at};
      });
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // общий реестр (см. web/lib/adsProgress.js) — как и у Викторины, решение крутится в фоне
  // независимо от конкретного SSE-соединения, поэтому прогресс переживает перезагрузку страницы:
  // при повторном открытии фронт спрашивает /api/daily-ads/live и подписывается на уже идущий
  // просмотр вместо повторного запуска.
  const adsProgress=require('../lib/adsProgress');

  app.get('/api/daily-ads/live',(req,res)=>{
    res.json({ok:true,rows:adsProgress.list()});
  });

  app.get('/api/daily-ads/watch-stream',async(req,res)=>{
    const accountId=parseInt(req.query&&req.query.account_id);
    if(!accountId)return res.status(400).json({ok:false,error:'account_id required'});
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    let entry=adsProgress.get(accountId);
    if(!entry){
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(accountId);
      if(!acc){res.write(`data: ${JSON.stringify({type:'done',ok:false,error:'Аккаунт не найден'})}\n\n`);return res.end();}
      entry=adsProgress.start(accountId,acc.name,makeApiForAccount);
    }else if(entry.current){
      res.write(`data: ${JSON.stringify({type:'progress',current:entry.current,limit:entry.limit})}\n\n`);
    }
    entry.subscribers.add(res);
    req.on('close',()=>{entry.subscribers.delete(res);});
  });

  app.post('/api/daily-ads/watch',async(req,res)=>{
    try{
      const{account_id}=req.body||{};
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const{Account,DailyAdsSnapshot}=require('../../db/index');
      const acc=await Account.findByPk(account_id);
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const api=await makeApiForAccount(account_id,{noLock:true});
      const result=await require('../../modules/dailyads').runDailyAds(api,acc.name);
      await DailyAdsSnapshot.upsert({account:acc.name,current:result.current,limit:result.limit,reward:result.reward,limit_reached:result.limit_reached,updated_at:new Date()},{conflictFields:['account']});
      res.json({ok:true,...result});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/daily-ads/watch-all',async(req,res)=>{
    try{
      const{Account,DailyAdsSnapshot}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const{sleep}=require('../../utils/helpers');
      const results=[];
      for(let i=0;i<accs.length;i++){
        const acc=accs[i];
        if(!acc.access_token){results.push({id:acc.id,name:acc.name,ok:false,error:'no token'});continue;}
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const r=await require('../../modules/dailyads').runDailyAds(api,acc.name);
          await DailyAdsSnapshot.upsert({account:acc.name,current:r.current,limit:r.limit,reward:r.reward,limit_reached:r.limit_reached,updated_at:new Date()},{conflictFields:['account']});
          results.push({id:acc.id,name:acc.name,ok:true,...r});
        }catch(e){results.push({id:acc.id,name:acc.name,ok:false,error:e.message});}
        if(i<accs.length-1)await sleep(1000);
      }
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
