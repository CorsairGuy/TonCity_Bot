'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');
const{sweepAccounts,isPermanent}=require('../lib/accountSweep');

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
      // ВАЖНО: раскрываем booster/booster_pack ВНЕ ЗАВИСИМОСТИ от того, из какой витрины пришёл
      // предмет. Событийная витрина (anniversary_event) продаёт те же наборы и ускорители, но
      // раньше эти поля читались только при gameType==='booster'/'booster_pack', и товар события
      // оставался безымянным («набор» без вида) — 13.08.
      if(item.booster){
        base.game_type='booster';base.game_name=item.booster.rarity||null;
        base.rarity=item.booster.rarity;
        base.multiplier=item.booster.multiplier;
        base.duration_ns=item.booster.duration;
        base.active_limit=item.booster.active_limit;
      }
      if(item.booster_pack){
        base.game_type='booster_pack';base.game_name=item.booster_pack.type||null;
        base.pack_type=item.booster_pack.type;
      }
      // Универсальный разбор для НЕ-ускорителей: у таких предметов игра кладёт описание в свой
      // вложенный объект (напр. consumable). Ключ 'item' пропускаем СПЕЦИАЛЬНО — это служебная
      // обёртка вида {id,type,sell_factor,...} (видно в логе витрины события 13.08), из неё
      // получается бесполезное имя «consumable» вместо «Камень реформ (мифический)».
      const SKIP_KEYS=new Set(['offers','limit','item','booster','booster_pack']);
      if(!base.game_name){
        for(const [key,val] of Object.entries(item)){
          if(SKIP_KEYS.has(key)||!val||typeof val!=='object'||Array.isArray(val))continue;
          const slug=val.name||val.type||val.rarity;
          if(!slug)continue;
          base.game_type=base.game_type||key;
          base.game_name=slug;
          if(val.rarity)base.game_rarity=val.rarity;
          break;
        }
      }
      // Событийная витрина (anniversary_event) продаёт предметы с НОВЫМИ id, которых нет в нашем
      // справочнике. Если игра прислала про них хоть что-то (тип/слаг/редкость) — прокидываем как
      // есть: страница сделает из этого нормальное название и найдёт картинку по слагу, не дожидаясь
      // обновления общего каталога предметов (utils/itemCatalog.js).
      if(item.name)base.game_name=item.name;
      if(item.type)base.game_type=item.type;
      if(item.rarity)base.game_rarity=item.rarity;
      // 'consumable'/'booster' в game_name — это ТИП, а не вид предмета: показывать «consumable»
      // вместо названия хуже, чем честное «Предмет #38», поэтому такое имя отбрасываем
      if(base.game_name&&base.game_name===base.game_type)base.game_name=null;
      return base;
    });
  }

  app.get('/api/shop-live/boosters',async(req,res)=>{
    try{
      // ?ids=1,2 — добрать только перечисленные аккаунты (страница так повторяет сбойные)
      const idsRaw=String(req.query?.ids||'').trim();
      const ids=idsRaw?idsRaw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite):null;
      const accounts=await opRegistry.run(ids?`shopBoosters:${ids.join(',')}`:'shopBoosters',()=>sweepAccounts(makeApiForAccount,async api=>{
        const raw=await api.get('/shop/offers/booster');
        return{items:normalizeShopOffers(raw,'booster')};
      },{fallback:{items:[]},label:'shop-boosters',onlyIds:ids}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/shop-live/packs',async(req,res)=>{
    try{
      // ?ids=1,2 — добрать только перечисленные аккаунты (страница так повторяет сбойные)
      const idsRaw=String(req.query?.ids||'').trim();
      const ids=idsRaw?idsRaw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite):null;
      const accounts=await opRegistry.run(ids?`shopPacks:${ids.join(',')}`:'shopPacks',()=>sweepAccounts(makeApiForAccount,async api=>{
        const raw=await api.get('/shop/offers/booster_pack');
        return{items:normalizeShopOffers(raw,'booster_pack')};
      },{fallback:{items:[]},label:'shop-packs',onlyIds:ids}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // вкладка "Политики" в Магазине (Бюро политик) — появилась в обновлении 06.07.2026,
  // тот же generic-паттерн /shop/offers/{gameType}, что и boosters/booster_pack
  app.get('/api/shop-live/policies',async(req,res)=>{
    try{
      // ?ids=1,2 — добрать только перечисленные аккаунты (страница так повторяет сбойные)
      const idsRaw=String(req.query?.ids||'').trim();
      const ids=idsRaw?idsRaw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite):null;
      const accounts=await opRegistry.run(ids?`shopPolicies:${ids.join(',')}`:'shopPolicies',()=>sweepAccounts(makeApiForAccount,async api=>{
        const raw=await api.get('/shop/offers/policy_bureau');
        return{items:normalizeShopOffers(raw,'policy_bureau')};
      },{fallback:{items:[]},label:'shop-policies',onlyIds:ids}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Магазин билетов («Летний карнавал», событие 10-23.08.2026). Отдельной витрины у билетов нет:
  // игра продаёт за них товары ИЗ ТЕХ ЖЕ категорий (/shop/offers/{type}), просто у части офферов
  // offer_type='tickets' (путь покупки — /shop/buy/tickets, сверено с бандлом: shop.buyTickets).
  // Поэтому собираем все три витрины и оставляем только предметы, у которых есть билетный оффер.
  // Если игра билетные офферы ещё не включила, страница честно покажет пустой список.
  // 'anniversary_event' — витрина события: она НАШЛАСЬ перебором 13.08 (именно там игра держит
  // товары за билеты), поэтому это уже не догадка, а рабочая категория наравне с остальными.
  let loggedEventShopSample=false;
  const TICKET_SHOP_CATEGORIES=['anniversary_event','booster','booster_pack','policy_bureau'];
  // Категории-кандидаты для событийной витрины. Названия угаданы: в бандле игры есть путь
  // shop.buyTickets (/shop/buy/tickets), но НИ ОДНА страница клиента его пока не дёргает, а самой
  // вкладки «за билеты» в UI игры нет — то есть игра ещё не открыла эту витрину. Поэтому пробуем
  // «на всякий случай» и МОЛЧА пропускаем любую ошибку: неизвестная категория закономерно отвечает
  // 4xx, и это не повод ни ретраить аккаунт, ни показывать ошибку на странице.
  const TICKET_SHOP_PROBE=['ticket','tickets','anniversary','event'];
  app.get('/api/shop-live/tickets',async(req,res)=>{
    try{
      // Сбойный аккаунт не бросаем — дожимаем повторами (web/lib/accountSweep.js). ВАЖНО: здесь
      // .catch(()=>null) на отдельной витрине убран намеренно — иначе разовый таймаут одной
      // категории тихо превращался в «товаров нет», и ретраить было уже нечего.
      const idsRaw=String(req.query?.ids||'').trim();
      const ids=idsRaw?idsRaw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite):null;
      const accounts=await opRegistry.run(ids?`shopTickets:${ids.join(',')}`:'shopTickets',()=>sweepAccounts(makeApiForAccount,async api=>{
        // три витрины запрашиваем ПО ОЧЕРЕДИ, а не Promise.all: параллелизм и так ограничен пулом
        // на уровне аккаунтов (accountSweep), и утраивать его здесь — прямой путь обратно к
        // ECONNABORTED, когда игра захлёбывается и ни один аккаунт не отвечает
        const parts=[];
        for(const type of TICKET_SHOP_CATEGORIES){
          try{
            const raw=await api.get(`/shop/offers/${type}`);
            // ДИАГНОСТИКА (одна строка на запуск бота): событийная витрина продаёт предметы с
            // новыми id, и по каким полям игра называет их — заранее не известно. Пишем сырую
            // запись целиком ровно один раз, чтобы не гадать по скриншотам.
            if(type==='anniversary_event'&&!loggedEventShopSample&&Array.isArray(raw)&&raw.length){
              // нужен пример предмета БЕЗ booster/booster_pack — именно у них не хватает названия
              const odd=raw.find(x=>x&&!x.booster&&!x.booster_pack);
              if(odd){
                loggedEventShopSample=true;
                logger.info(`[shop-tickets] пример нового предмета витрины: ${JSON.stringify(odd).slice(0,800)}`);
              }
            }
            parts.push(normalizeShopOffers(raw,type).map(item=>({...item,category:type})));
          }catch(e){
            // витрина закрыта именно ДЛЯ ЭТОГО аккаунта (403 «нет здания», «Экономика политик
            // откроется при населении 1 000 000») — молча пропускаем категорию, а не роняем и не
            // ретраим аккаунт целиком: ответ игры от повторов не изменится. Всё остальное
            // (таймаут, 5xx) бросаем наверх, чтобы сработали ретраи accountSweep.
            if(!isPermanent(e))throw e;
          }
        }
        for(const type of TICKET_SHOP_PROBE){
          try{
            const raw=await api.get(`/shop/offers/${type}`,{},{timeout:8000});
            const norm=normalizeShopOffers(raw,type).map(item=>({...item,category:type}));
            if(norm.length)parts.push(norm);
          }catch(_){/* нет такой категории — так и ожидалось */}
        }
        const all=parts.flat();
        // какие валюты игра вообще предлагает — чтобы страница могла честно сказать «билетных
        // офферов нет, есть только монеты/алмазы/реклама», а не показывать молчаливую пустоту
        const offerTypes=[...new Set(all.flatMap(i=>i.offers.map(o=>o.offer_type)).filter(Boolean))];
        const items=all
          .map(item=>({...item,offers:item.offers.filter(o=>o.offer_type==='tickets')}))
          .filter(item=>item.offers.length>0);
        return{items,offer_types:offerTypes};
      },{fallback:{items:[]},label:'shop-tickets',onlyIds:ids}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // После покупки в магазине сразу переливаем купленное в БД, чтобы страницы "Предметы"/"Политики"
  // показывали покупку без ручного "Обновить" (просьба пользователя 31.07.2026). sync_policies
  // ставит только страница "Магазин политик" — там покупка может дать и карту политики (её нет в
  // обычном складе, живёт в PolicySnapshot), на остальных страницах лишний запрос не нужен.
  // Баланс аккаунта в БД после покупки устаревал: игра списала монеты/алмазы, а Account.balance
  // остался прежним. Страницы магазина берут баланс ИМЕННО ОТТУДА (см. api.accounts() в
  // ShopBoosters/ShopPacks/ShopPolicies), поэтому кнопка «Купить» продолжала предлагать покупку,
  // на которую денег уже нет, и игра отвечала 400 «Недостаточно монет».
  // Читаем фактический баланс из /progress/, а не вычитаем цену локально: монеты параллельно
  // капают с города, так что арифметика на стороне бота всё равно разошлась бы с игрой.
  async function refreshBalance(api,accountId){
    try{
      const prog=await api.get('/progress/');
      const d=prog?.progress?.data;
      if(!d)return null;
      const upd={};
      if(d.coins!=null)upd.balance=d.coins;
      if(d.crystals!=null)upd.crystals=d.crystals;
      if(!Object.keys(upd).length)return null;
      const{Account}=require('../../db/index');
      await Account.update(upd,{where:{id:accountId}});
      return{balance:d.coins??null,crystals:d.crystals??null};
    }catch(_){return null;}
  }
  async function syncAfterPurchase(api,acc,{policies=false}={}){
    await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
    if(policies)await require('../../modules/policies').runPolicies(api,acc.name).catch(()=>{});
    return refreshBalance(api,acc.id);
  }
  // 'tickets' — валюта «Летнего карнавала» (см. /api/shop-live/tickets выше)
  const BUY_PATHS={coins:'/shop/buy/coins',crystals:'/shop/buy/crystals',ads:'/shop/buy/ads',tickets:'/shop/buy/tickets'};
  const buyPathFor=t=>BUY_PATHS[t]||BUY_PATHS.coins;
  app.post('/api/shop-live/buy',async(req,res)=>{
    try{
      const{account_id,offer_id,amount=1,offer_type,sync_policies}=req.body||{};
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(account_id),{attributes:['id','name']});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const path=buyPathFor(offer_type);
      const r=await api.post(path,{offer_id:Number(offer_id),amount:Number(amount)});
      const balance=acc?await syncAfterPurchase(api,acc,{policies:!!sync_policies}):null;
      res.json({ok:true,result:r,balance});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/shop-live/buy-all',async(req,res)=>{
    try{
      const{offer_id,amount=1,offer_type,account_ids,sync_policies}=req.body||{};
      if(!Array.isArray(account_ids)||account_ids.length===0)return res.status(400).json({ok:false,error:'account_ids required'});
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({where:{id:account_ids},attributes:['id','name']});
      const path=buyPathFor(offer_type);
      const results=await Promise.all(accs.map(async acc=>{
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const r=await api.post(path,{offer_id:Number(offer_id),amount:Number(amount)});
          const balance=await syncAfterPurchase(api,acc,{policies:!!sync_policies});
          return{id:acc.id,name:acc.name,ok:true,result:r,balance};
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

  // Досрочная отмена вклада. Аккаунт берём из записи вклада в БД — с фронта приходит только entry_id.
  app.post('/api/staking/cancel',async(req,res)=>{
    try{
      const entry_id=Number(req.body?.entry_id);
      if(!entry_id)return res.status(400).json({ok:false,error:'missing entry_id'});
      const{StakingEntry,Account}=require('../../db/index');
      const row=await StakingEntry.findOne({where:{entry_id}});
      if(!row)return res.status(404).json({ok:false,error:'вклад не найден — нажмите «Обновить»'});
      if(row.collected)return res.json({ok:false,error:'вклад уже собран'});
      if(row.can_collect_at&&new Date(row.can_collect_at).getTime()<=Date.now())return res.json({ok:false,error:'вклад уже созрел — его нужно забрать, а не отменять'});
      const acc=await Account.findOne({where:{name:row.account}});
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'account not found'});
      const api=await makeApiForAccount(acc.id);
      const{cancelEntry}=require('../../modules/staking');
      const r=await cancelEntry(api,acc.name,{id:row.entry_id,currency:row.currency,amount_staked:row.amount_staked});
      // баланс — из /progress/, не вычитанием: монеты параллельно капают с города
      const prog=await api.get('/progress/').catch(()=>null);
      if(prog?.progress?.data){
        const d=prog.progress.data;
        const upd={};
        if(d.coins!=null)upd.balance=d.coins;
        if(d.crystals!=null)upd.crystals=d.crystals;
        if(Object.keys(upd).length)await acc.update(upd).catch(()=>{});
      }
      res.json({ok:true,result:r});
    }catch(e){res.json({ok:false,error:e.message});}
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
      // ЗАТО помечаем снимок устаревшим, если он сделан ДО последней UTC-полуночи. Не обнуляем и не
      // гадаем — просто говорим странице «этому числу верить нельзя»: иначе вчерашние 10/10
      // показывались сегодня как «Готово», хотя реклама за новый день ещё не смотрена (жалоба
      // 13.08). Страница по этому флагу сама сходит за живым статусом (/api/daily-ads/live-status).
      const lastUtcMidnight=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate());
      const rows=accs.map(a=>{
        const s=snapMap[a.name];
        if(!s)return{id:a.id,name:a.name,ok:false,error:'нет данных — нажмите ↻'};
        const stale=!s.updated_at||new Date(s.updated_at).getTime()<lastUtcMidnight;
        return{id:a.id,name:a.name,ok:true,current:s.current,limit:s.limit,reward:s.reward,limit_reached:s.limit_reached,updated_at:s.updated_at,stale};
      });
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Живой статус рекламы по всем аккаунтам: спрашиваем игру, обновляем снимки в БД и отдаём
  // результат. Нужен странице при открытии — снимок из БД мог остаться со вчера (см. stale выше).
  // Проход идёт пулом с ретраями (web/lib/accountSweep.js), а не 60 запросами разом.
  app.get('/api/daily-ads/live-status',async(req,res)=>{
    try{
      const{DailyAdsSnapshot}=require('../../db/index');
      const{getDailyAdsStatus}=require('../../modules/dailyads');
      const rows=await opRegistry.run('dailyAdsLiveStatus',()=>sweepAccounts(makeApiForAccount,async(api,acc)=>{
        const s=await getDailyAdsStatus(api,acc.name);
        // Ошибка ЗАПИСИ в БД не должна выглядеть как «игра не ответила» и уж тем более уходить в
        // ретраи к игре: статус мы уже получили, показать его можно и без сохранения снимка.
        try{
          await DailyAdsSnapshot.upsert({account:acc.name,...s,updated_at:new Date()},{conflictFields:['account']});
        }catch(dbErr){logger.warn(`[${acc.name}] [daily-ads] снимок не сохранён: ${dbErr.message}`);}
        return{ok:true,...s,stale:false};
      },{fallback:{ok:false},label:'daily-ads'}));
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
