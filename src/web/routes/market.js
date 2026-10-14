'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

const marketAccess=require('../lib/marketAccess');
module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  // ── Центральный рынок: статистика по аккаунтам ──────────────────────────────
  app.get('/api/market-stats',async(req,res)=>{
    try{
      const{MarketStatsSnapshot}=require('../../db/index');
      const rows=await MarketStatsSnapshot.findAll({order:[['account','ASC']]});
      res.json({ok:true,rows:rows.map(r=>({
        account:r.account,
        total_purchases:r.total_purchases,total_sales:r.total_sales,
        total_crystals_earned:r.total_crystals_earned,total_crystals_spent:r.total_crystals_spent,
        total_ton_earned:r.total_ton_earned,total_ton_spent:r.total_ton_spent,
        updated_at:r.updated_at,
      }))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/market-stats/refresh',async(req,res)=>{
    try{
      const results=await opRegistry.run('marketStatsRefresh',async()=>{
        const{Account,MarketStatsSnapshot}=require('../../db/index');
        const accs=await Account.findAll({order:[['id','ASC']]});
        const out=[];
        for(const acc of accs){
          if(!acc.access_token||acc.access_token==='placeholder'){out.push({name:acc.name,ok:false,error:'нет токена'});continue;}
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const d=await api.get('/market/user/stats');
            const s=d?.stats||{};
            await MarketStatsSnapshot.upsert({
              account:acc.name,
              total_purchases:s.total_purchases??0,total_sales:s.total_sales??0,
              total_crystals_earned:s.total_crystals_earned??0,total_crystals_spent:s.total_crystals_spent??0,
              total_ton_earned:s.total_ton_earned??0,total_ton_spent:s.total_ton_spent??0,
              updated_at:new Date(),
            },{conflictFields:['account']});
            out.push({name:acc.name,ok:true});
          }catch(e){out.push({name:acc.name,ok:false,error:e.message});}
        }
        return out;
      });
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // ── Центральный рынок: листинги / покупки / продажи ─────────────────────────
  async function fetchAllMarketPages(api,path){
    const all=[];let page=1,total=Infinity;
    while(all.length<total&&page<=300){
      let d;try{d=await api.get(`${path}?page=${page}`);}catch(_){break;}
      const arrKey=d&&typeof d==='object'?Object.keys(d).find(k=>Array.isArray(d[k])):null;
      const items=arrKey?d[arrKey]:[];
      if(!items.length)break;
      all.push(...items);
      total=d?.pagination?.total??all.length;
      const size=d?.pagination?.page_size||20;
      if(items.length<size)break;
      page++;
    }
    return all;
  }
  const MARKET_DEAL=(()=>{
    const cp=r=>[r.seller_first_name,r.seller_last_name].filter(Boolean).join(' ')||r.seller_name||null;
    return {
      // цена листинга есть только в /market/direct/{id} (в /market/user/listings её нет) — дотягиваем
      listings:{path:'/market/user/listings',model:'MarketListing',enrich:async(api,items)=>{
        for(const r of items){
          try{const d=await api.get(`/market/direct/${r.id}`);const o=d?.offer||d;if(o){r.listing_price=o.listing_price??null;r.display_price=o.display_price??null;}}catch(_){}
        }
      },map:(acc,r)=>({account:acc,listing_id:r.id,market_id:r.market_id,item_id:r.item_id,item_category:r.item_category,item_rarity:r.item_rarity,currency:r.listing_currency,price:r.listing_price??r.display_price??null,qty:r.total_count??null,status:r.status,created_at:r.created_at||null,available_at:r.available_at||null,ends_at:r.ends_at||null})},
      purchases:{path:'/market/user/purchases',model:'MarketPurchase',map:(acc,r)=>({account:acc,record_id:r.id,market_id:r.market_id,item_id:r.item_id,item_category:r.item_category,item_rarity:r.item_rarity,currency:r.currency,price:r.price??null,fee:r.fee??null,qty:r.total_count??null,counterparty:cp(r),sold_at:r.sold_at||null})},
      sales:{path:'/market/user/sales',model:'MarketSale',map:(acc,r)=>({account:acc,record_id:r.id,market_id:r.market_id,item_id:r.item_id,item_category:r.item_category,item_rarity:r.item_rarity,currency:r.currency,price:r.price??null,fee:r.fee??null,qty:r.total_count??null,counterparty:cp(r),sold_at:r.sold_at||null})},
    };
  })();
  app.get('/api/market-deals',async(req,res)=>{
    try{
      const cfg=MARKET_DEAL[req.query.type];
      if(!cfg)return res.status(400).json({ok:false,error:'type: listings|purchases|sales'});
      const db=require('../../db/index');
      const Model=db[cfg.model];
      const rows=await Model.findAll({order:[['id','ASC']]});
      res.json({ok:true,rows:rows.map(r=>r.toJSON())});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/market-deals/refresh',async(req,res)=>{
    try{
      const type=req.body&&req.body.type;
      const cfg=MARKET_DEAL[type];
      if(!cfg)return res.status(400).json({ok:false,error:'type: listings|purchases|sales'});
      const results=await opRegistry.run(`marketDealsRefresh:${type}`,async()=>{
        const db=require('../../db/index');
        const{Account}=db;const Model=db[cfg.model];
        const accs=await Account.findAll({order:[['id','ASC']]});
        const out=[];
        for(const acc of accs){
          if(!acc.access_token||acc.access_token==='placeholder'){out.push({name:acc.name,ok:false,error:'нет токена'});continue;}
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const items=await fetchAllMarketPages(api,cfg.path);
            if(cfg.enrich)await cfg.enrich(api,items);
            await Model.destroy({where:{account:acc.name}});
            if(items.length)await Model.bulkCreate(items.map(r=>cfg.map(acc.name,r)));
            out.push({name:acc.name,ok:true,count:items.length});
          }catch(e){out.push({name:acc.name,ok:false,error:e.message});}
        }
        return out;
      });
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // ── Центральный рынок: витрина лотов + мульти-аккаунт покупка ────────────────
  // Раньше брали ОДИН случайный аккаунт без проверки — если он попадал на проблемную сессию
  // (протухший WS/подпись, нет здания Рынка и т.п.), вся страница лотов падала целиком. Игра при
  // этом не менялась (сверено: тот же билд бандла) — проблема была именно в отсутствии ретрая.
  // Теперь пробуем до 3 разных случайных аккаунтов, проверяя каждый лёгким запросом
  // /market/direct/stats — как и market-prices.js пробует другого аккаунта при сбое.
  async function randomTokenedApi(){
    const{Account}=require('../../db/index');
    const accs=await Account.findAll({order:[['id','ASC']]});
    const tokened=accs.filter(a=>a.access_token&&a.access_token!=='placeholder');
    if(!tokened.length)throw new Error('нет аккаунтов с токеном');
    // Спрашиваем витрину ТОЛЬКО у аккаунтов, которым рынок доступен: без Центрального рынка на
    // карте игра отвечает 403 «нет здания», а наш собственный гейт (utils/buildingReg) такой
    // запрос вообще не выпускает. Раньше кандидаты выбирались случайно из всех — если в тройку
    // попадали аккаунты без рынка, страница лотов падала целиком, хотя рынок был у других.
    // Признак тот же, что в index.js и modules/inventory.js: CSV accs.special_buildings из /progress/.
    // Плюс исключаем аккаунты, которым игра ограничила рынок (is_frozen/is_warned из ответа
    // /market/offers — см. web/lib/marketAccess.js): у них вместо витрины приходит баннер.
    const statuses=await marketAccess.map();
    // Если состав зданий ещё не синхронизирован НИ У КОГО (первый запуск на чистой установке —
    // special_buildings пуст), не отсекаем никого: пусть решает сам игровой ответ.
    const known=tokened.some(a=>String(a.special_buildings||'').trim());
    const candidates=known?tokened.filter(a=>marketAccess.usable(a,statuses)):tokened;
    if(!candidates.length)throw new Error('нет аккаунтов с рабочим Центральным рынком (нет здания или рынок заморожен)');
    const shuffled=[...candidates].sort(()=>Math.random()-0.5);
    let lastErr;
    for(const acc of shuffled.slice(0,3)){
      try{
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await api.get('/market/direct/stats');
        api._accName=acc.name;      // чтобы попутно записать статус рынка этого аккаунта
        return api;
      }catch(e){lastErr=e;}
    }
    throw lastErr||new Error('не удалось подключиться ни к одному аккаунту для витрины рынка');
  }
  app.get('/api/market/offers',async(req,res)=>{
    try{
      // Обновление игры: единая витрина /market/offers (была /market/direct) с фильтром по ТИПУ
      // рынка. Параметры множественные, списками через запятую: categories, rarities, currencies,
      // market_types (direct|auction|negotiation). Валюта GRAM = значение 'ton' (только подпись
      // переименована в игре, значение в API прежнее). Ответ: {offers, pagination:{total}}.
      const{categories,rarities,currency,currencies,market_types,sort='ends_at',page='1',page_size='20'}=req.query;
      const api=await randomTokenedApi();
      const qs=new URLSearchParams({sort,page:String(page),page_size:String(page_size)});
      if(categories)qs.set('categories',categories);
      if(rarities)qs.set('rarities',rarities);
      const cur=currencies||currency; // принимаем и старое имя currency, и новое currencies
      if(cur)qs.set('currencies',cur);
      if(market_types)qs.set('market_types',market_types);
      const d=await api.get('/market/offers?'+qs.toString());
      // ответ несёт is_frozen/is_warned — попутно фиксируем статус аккаунта-источника
      marketAccess.record(api._accName||null,d).catch(()=>{});
      const offers=d?.offers||[];
      // копим в каталог политики, «засветившиеся» на рынке (даже те, которых нет на аккаунтах) —
      // фоном, чтобы не задерживать ответ витрины
      const withPolicy=offers.filter(o=>o.item_category==='policy'&&o.policy);
      if(withPolicy.length)require('../../modules/policies').harvestMarketPolicies(withPolicy).catch(()=>{});
      // пометить лоты наших аккаунтов: сверяем id лота со своими листингами (ловит и анонимные)
      const{MarketListing}=require('../../db/index');
      const mine=await MarketListing.findAll({attributes:['listing_id','account']});
      const mineMap=new Map(mine.map(r=>[Number(r.listing_id),r.account]));
      const enriched=offers.map(o=>({...o,mine_account:mineMap.get(Number(o.id))||(o.your_offer?'':null)}));
      res.json({ok:true,offers:enriched,pagination:d?.pagination||{page:Number(page),page_size:Number(page_size),total:offers.length}});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // Кто реально может торговать: здание Центрального рынка есть И игра не ограничила рынок.
  // Список нужен странице лотов, чтобы не предлагать мёртвые аккаунты в покупке/ставке/автоскупке.
  app.get('/api/market/access',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const statuses=await marketAccess.map();
      res.json({ok:true,rows:accs.map(a=>{
        const st=statuses.get(a.name)||null;
        return{
          id:a.id,name:a.name,
          has_building:String(a.special_buildings||'').split(',').includes('market'),
          frozen:!!st?.frozen,warned:!!st?.warned,
          checked_at:st?.checked_at??null,
          usable:marketAccess.usable(a,statuses),
        };
      })});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // Разовая проверка: по одной лёгкой странице витрины на аккаунт — она же несёт is_frozen/is_warned
  app.post('/api/market/access/refresh',async(req,res)=>{
    try{
      const rows=await opRegistry.run('marketAccessRefresh',()=>marketAccess.refresh(makeApiForAccount));
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.get('/api/market/ton-balances',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      // Только аккаунты с Центральным рынком: у остальных /market/toncoin/balance всё равно
      // не уйдёт (гейт по зданию) и строка была бы пустой — 27 из 60 запросов впустую.
      const statuses=await marketAccess.map();
      const anyKnown=accs.some(a=>String(a.special_buildings||'').trim());
      const tokened=accs.filter(a=>a.access_token&&a.access_token!=='placeholder'&&(!anyKnown||marketAccess.usable(a,statuses)));
      const out=[];const CONC=8;
      for(let i=0;i<tokened.length;i+=CONC){
        const chunk=tokened.slice(i,i+CONC);
        const part=await Promise.all(chunk.map(async acc=>{
          try{const api=await makeApiForAccount(acc.id,{noLock:true});const d=await api.get('/market/toncoin/balance');return{id:acc.id,name:acc.name,ton:Number(d?.nanotons_amount||0)/1e9};}
          catch(_){return{id:acc.id,name:acc.name,ton:null};}
        }));
        out.push(...part);
      }
      res.json({ok:true,balances:out});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // Автоскупка: скупить все доступные лоты предмета дешевле max_price, распределяя по аккаунтам, в рамках бюджета.
  app.post('/api/market/auto-buy',async(req,res)=>{
    try{
      const{categories,rarities,currency,max_price,max_budget,account_ids}=req.body||{};
      if(!currency||max_price==null||!Array.isArray(account_ids)||!account_ids.length)
        return res.status(400).json({ok:false,error:'currency, max_price, account_ids обязательны'});
      const{Account}=require('../../db/index');
      // даже если страница прислала «мёртвый» аккаунт (открытая вкладка, старый список автоскупки),
      // сервер сам отсеивает тех, кому рынок ограничен — покупка с них всё равно не пройдёт
      const statuses=await marketAccess.map();
      const picked=await Account.findAll({where:{id:account_ids}});
      const skipped=picked.filter(a=>!marketAccess.usable(a,statuses)).map(a=>a.name);
      const accs=picked.filter(a=>marketAccess.usable(a,statuses));
      if(!accs.length)return res.status(400).json({ok:false,error:`нет аккаунтов с рабочим рынком${skipped.length?` (пропущены: ${skipped.join(', ')})`:''}`});
      if(skipped.length)logger.warn(`[market] автоскупка: пропускаю аккаунты с ограниченным рынком: ${skipped.join(', ')}`);
      const ids=accs.map(a=>a.id);
      const nameOf=id=>accs.find(a=>a.id===id)?.name||String(id);
      // балансы выбранных аккаунтов
      const balance=new Map();
      if(currency==='ton'){
        await Promise.all(accs.map(async a=>{try{const api=await makeApiForAccount(a.id,{noLock:true});const d=await api.get('/market/toncoin/balance');balance.set(a.id,Number(d?.nanotons_amount||0)/1e9);}catch(_){balance.set(a.id,0);}}));
      }else{
        for(const a of accs)balance.set(a.id,Number(a.crystals)||0);
      }
      // собираем офферы предмета дешевле max_price (price_asc), доступные сейчас
      const api=await randomTokenedApi();
      const offers=[];
      for(let p=1;p<=25;p++){
        const qs=new URLSearchParams({sort:'price_asc',page:String(p),page_size:'20',currencies:currency,market_types:'direct'});
        if(categories)qs.set('categories',categories);
        if(rarities)qs.set('rarities',rarities);
        let d;try{d=await api.get('/market/offers?'+qs.toString());}catch(_){break;}
        const list=d?.offers||[];let stop=false;
        for(const o of list){if(o.display_price>Number(max_price)){stop=true;break;}offers.push(o);}
        if(stop||list.length<20)break;
        await new Promise(r=>setTimeout(r,150));
      }
      const now=Date.now();
      const avail=offers.filter(o=>o.status==='active'&&(!o.available_at||new Date(o.available_at).getTime()<=now)&&o.your_offer!==true&&o.can_buy!==false);
      // жадное распределение в рамках бюджета; раскидываем по аккаунтам (least-assigned, кап 5/день)
      const budget=max_budget!=null&&max_budget!==''?Number(max_budget):Infinity;
      const assigned=new Map();let spent=0;const plan=[];
      for(const o of avail){
        const price=o.display_price;
        if(spent+price>budget)break;
        const elig=ids.filter(id=>(balance.get(id)||0)>=price&&(assigned.get(id)||0)<5);
        if(!elig.length)continue;
        elig.sort((a,b)=>((assigned.get(a)||0)-(assigned.get(b)||0))||((balance.get(b)||0)-(balance.get(a)||0)));
        const aid=elig[0];
        balance.set(aid,(balance.get(aid)||0)-price);assigned.set(aid,(assigned.get(aid)||0)+1);spent+=price;
        plan.push({offer_id:o.id,account_id:aid,price});
      }
      // параллельное исполнение
      const results=[];const CONC=10;
      for(let i=0;i<plan.length;i+=CONC){
        const chunk=plan.slice(i,i+CONC);
        const part=await Promise.all(chunk.map(async pl=>{
          try{const a=await makeApiForAccount(pl.account_id,{noLock:true});await a.post('/market/direct/buy',{offer_id:pl.offer_id});return{offer_id:pl.offer_id,account_id:pl.account_id,name:nameOf(pl.account_id),price:pl.price,ok:true};}
          catch(e){return{offer_id:pl.offer_id,account_id:pl.account_id,name:nameOf(pl.account_id),price:pl.price,ok:false,error:e.message};}
        }));
        results.push(...part);
      }
      const spentOk=results.filter(r=>r.ok).reduce((s,r)=>s+r.price,0);
      res.json({ok:true,available:avail.length,planned:plan.length,spent:spentOk,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/market/buy',async(req,res)=>{
    try{
      const{offer_id,account_ids}=req.body||{};
      if(!offer_id||!Array.isArray(account_ids)||!account_ids.length)return res.status(400).json({ok:false,error:'offer_id и account_ids обязательны'});
      const{Account}=require('../../db/index');
      const results=[];const CONC=10;
      for(let i=0;i<account_ids.length;i+=CONC){
        const chunk=account_ids.slice(i,i+CONC);
        const part=await Promise.all(chunk.map(async id=>{
          let name=String(id);
          try{
            const acc=await Account.findByPk(Number(id),{attributes:['name']});name=acc?.name||name;
            const api=await makeApiForAccount(Number(id),{noLock:true});
            const r=await api.post('/market/direct/buy',{offer_id:Number(offer_id)});
            return{id:Number(id),name,ok:true,result:r};
          }catch(e){return{id:Number(id),name,ok:false,error:e.message};}
        }));
        results.push(...part);
      }
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Аукцион: ставка (payload из бандла: {auction_id, amount, anonymous}) ──────
  app.post('/api/market/auction/bid',async(req,res)=>{
    try{
      const{account_id,auction_id,amount,anonymous}=req.body||{};
      if(!account_id||!auction_id||!(amount>0))return res.status(400).json({ok:false,error:'account_id, auction_id, amount (>0) обязательны'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/market/auction/bid',{auction_id:Number(auction_id),amount:Number(amount),anonymous:!!anonymous});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Предложения (negotiation): сделать оффер
  //    (payload из бандла: {listing_id, amount, currency, anonymous}) ────────────
  app.post('/api/market/negotiation/offer',async(req,res)=>{
    try{
      const{account_id,listing_id,amount,currency,anonymous}=req.body||{};
      if(!account_id||!listing_id||!(amount>0)||!currency)return res.status(400).json({ok:false,error:'account_id, listing_id, amount (>0), currency обязательны'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/market/negotiation/offer',{listing_id:Number(listing_id),amount:Number(amount),currency,anonymous:!!anonymous});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Автопокупка: правила (CRUD) + фоновый воркер ────────────────────────────
  async function abFetchOffers(api,{categories,rarities,currency,max_price}){
    const offers=[];
    for(let p=1;p<=25;p++){
      // унифицированная витрина + только прямой рынок для автопокупки (мгновенная покупка)
      const qs=new URLSearchParams({sort:'price_asc',page:String(p),page_size:'20',currencies:currency,market_types:'direct'});
      if(categories)qs.set('categories',categories);
      if(rarities)qs.set('rarities',rarities);
      let d;try{d=await api.get('/market/offers?'+qs.toString());}catch(_){break;}
      const list=d?.offers||[];let stop=false;
      for(const o of list){if(o.display_price>Number(max_price)){stop=true;break;}offers.push(o);}
      if(stop||list.length<20)break;
      await new Promise(r=>setTimeout(r,150));
    }
    return offers;
  }
  async function abBalances(accs,currency){
    const balance=new Map();
    if(currency==='ton'){
      await Promise.all(accs.map(async a=>{try{const api=await makeApiForAccount(a.id,{noLock:true});const d=await api.get('/market/toncoin/balance');balance.set(a.id,Number(d?.nanotons_amount||0)/1e9);}catch(_){balance.set(a.id,0);}}));
    }else{for(const a of accs)balance.set(a.id,Number(a.crystals)||0);}
    return balance;
  }
  function abPlan(offers,ids,balance,budgetRemaining){
    const assigned=new Map();let spent=0;const plan=[];
    for(const o of offers){
      const price=o.display_price;
      if(spent+price>budgetRemaining)break;
      const elig=ids.filter(id=>(balance.get(id)||0)>=price&&(assigned.get(id)||0)<5);
      if(!elig.length)continue;
      elig.sort((a,b)=>((assigned.get(a)||0)-(assigned.get(b)||0))||((balance.get(b)||0)-(balance.get(a)||0)));
      const aid=elig[0];
      balance.set(aid,(balance.get(aid)||0)-price);assigned.set(aid,(assigned.get(aid)||0)+1);spent+=price;
      plan.push({offer_id:o.id,account_id:aid,price});
    }
    return plan;
  }
  async function abExecute(plan,accsById){
    const results=[];const CONC=10;
    for(let i=0;i<plan.length;i+=CONC){
      const chunk=plan.slice(i,i+CONC);
      const part=await Promise.all(chunk.map(async pl=>{
        const name=accsById.get(pl.account_id)?.name||String(pl.account_id);
        try{const a=await makeApiForAccount(pl.account_id,{noLock:true});await a.post('/market/direct/buy',{offer_id:pl.offer_id});return{...pl,name,ok:true};}
        catch(e){return{...pl,name,ok:false,error:e.message};}
      }));
      results.push(...part);
    }
    return results;
  }
  const abScheduled=new Set();
  async function abRunRule(rule){
    const{MarketAutobuy,Account}=require('../../db/index');
    const ids=JSON.parse(rule.account_ids||'[]');
    if(!ids.length)return;
    const budgetRemaining=rule.max_budget!=null?(rule.max_budget-(rule.spent||0)):Infinity;
    if(budgetRemaining<=0)return;
    const accs=await Account.findAll({where:{id:ids}});
    const accsById=new Map(accs.map(a=>[a.id,a]));
    const balance=await abBalances(accs,rule.currency);
    const api=await randomTokenedApi();
    const offers=await abFetchOffers(api,{categories:rule.categories,rarities:rule.rarities,currency:rule.currency,max_price:rule.max_price});
    const now=Date.now();
    const availableNow=offers.filter(o=>o.status==='active'&&(!o.available_at||new Date(o.available_at).getTime()<=now)&&o.your_offer!==true&&o.can_buy!==false);
    const plan=abPlan(availableNow,ids,balance,budgetRemaining);
    if(plan.length){
      const results=await abExecute(plan,accsById);
      const spentOk=results.filter(r=>r.ok).reduce((s,r)=>s+r.price,0);
      if(spentOk>0){await MarketAutobuy.update({spent:(rule.spent||0)+spentOk,updated_at:new Date()},{where:{id:rule.id}});rule.spent=(rule.spent||0)+spentOk;logger.info(`[autobuy] rule ${rule.id}: куплено ${results.filter(r=>r.ok).length}, потрачено ${spentOk}`);}
    }
    // эскроу: купить точно в available_at
    if(rule.include_escrow){
      const escrow=offers.filter(o=>o.status==='active'&&o.available_at&&new Date(o.available_at).getTime()>now&&o.display_price<=rule.max_price&&!abScheduled.has(o.id));
      for(const o of escrow){
        abScheduled.add(o.id);
        const delay=Math.max(0,new Date(o.available_at).getTime()-Date.now()+300);
        setTimeout(async()=>{
          try{
            const db=require('../../db/index');
            const r=await db.MarketAutobuy.findByPk(rule.id);
            if(!r||!r.enabled){return;}
            const br=r.max_budget!=null?(r.max_budget-(r.spent||0)):Infinity;
            if(br<o.display_price)return;
            const accs2=await db.Account.findAll({where:{id:ids}});
            const bal2=await abBalances(accs2,r.currency);
            const plan2=abPlan([o],ids,bal2,br);
            if(plan2.length){
              const res2=await abExecute(plan2,new Map(accs2.map(a=>[a.id,a])));
              const s=res2.filter(x=>x.ok).reduce((acc,x)=>acc+x.price,0);
              if(s>0){await db.MarketAutobuy.update({spent:(r.spent||0)+s,updated_at:new Date()},{where:{id:r.id}});logger.info(`[autobuy] rule ${r.id}: эскроу offer ${o.id} куплен (+${s})`);}
            }
          }catch(e){logger.warn(`[autobuy] escrow ${o.id}: ${e.message}`);}
          finally{abScheduled.delete(o.id);}
        },delay);
      }
    }
  }
  function startAutobuyWorker(){
    const tick=async()=>{
      try{
        const{MarketAutobuy}=require('../../db/index');
        const rules=await MarketAutobuy.findAll({where:{enabled:true}});
        for(const rule of rules){await abRunRule(rule).catch(e=>logger.warn(`[autobuy] rule ${rule.id}: ${e.message}`));}
      }catch(e){logger.warn(`[autobuy] tick: ${e.message}`);}
    };
    setInterval(tick,25000);
    setTimeout(tick,5000);
  }
  app.__startAutobuyWorker=startAutobuyWorker;
  app.get('/api/market/autobuy',async(req,res)=>{
    try{
      const{MarketAutobuy}=require('../../db/index');
      const rows=await MarketAutobuy.findAll({order:[['id','DESC']]});
      res.json({ok:true,rules:rows.map(r=>({id:r.id,item_id:r.item_id,categories:r.categories,rarities:r.rarities,currency:r.currency,max_price:r.max_price,max_budget:r.max_budget,spent:r.spent,account_ids:JSON.parse(r.account_ids||'[]'),include_escrow:!!r.include_escrow,enabled:!!r.enabled}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/market/autobuy',async(req,res)=>{
    try{
      const{MarketAutobuy}=require('../../db/index');const b=req.body||{};
      const row=await MarketAutobuy.create({item_id:b.item_id??null,categories:b.categories,rarities:b.rarities,currency:b.currency,max_price:b.max_price,max_budget:b.max_budget||null,spent:0,account_ids:JSON.stringify(b.account_ids||[]),include_escrow:b.include_escrow!==false,enabled:!!b.enabled,updated_at:new Date()});
      res.json({ok:true,id:row.id});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.put('/api/market/autobuy/:id',async(req,res)=>{
    try{
      const{MarketAutobuy}=require('../../db/index');const b=req.body||{};const upd={updated_at:new Date()};
      for(const k of ['item_id','categories','rarities','currency','max_price','max_budget','include_escrow','enabled'])if(k in b)upd[k]=b[k];
      if('account_ids' in b)upd.account_ids=JSON.stringify(b.account_ids||[]);
      if(b.reset_spent)upd.spent=0;
      await MarketAutobuy.update(upd,{where:{id:req.params.id}});
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.delete('/api/market/autobuy/:id',async(req,res)=>{
    try{const{MarketAutobuy}=require('../../db/index');await MarketAutobuy.destroy({where:{id:req.params.id}});res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── снайп конкретного эскроу-лота: купить точно в available_at ───────────────
  const SNIPE_CHUNK=55*60*1000;
  // Серия коротких попыток вместо одной. Стреляем ровно в available_at (искусственного запаса
  // больше нет), а часы бота и игры расходятся — запрос может уйти на десятки миллисекунд раньше,
  // чем лот реально открылся, и игра ответит отказом. Повторы закрывают этот зазор, не жертвуя
  // временем: если первая попытка успешна, остальных не будет. Всего окно ~450мс.
  const SNIPE_TRIES=4;
  const SNIPE_RETRY_DELAY=150;
  const snipeTimers=new Map();
  // Прогрев за SNIPE_WARMUP_LEAD до открытия лота. Без него ПЕРВЫЙ же запрос снайпа платил за
  // поднятие сессии прямо в момент выстрела: в ApiClient._request перед отправкой проверяется
  // seed подписи (нет — синхронный рефреш токена) и живой авторизованный WS через
  // wsSession.ensureReady, а тот ЖДЁТ готовности до READY_WAIT=12000мс. Живой пример 03.08:
  // лот открылся в 11:14:41, покупка прошла в 11:14:53 — ровно эти 12 секунд, при том что
  // таймер сработал вовремя. Холостой GET заранее поднимает WS/подпись/токен, и боевой POST
  // уходит уже по готовому соединению.
  // Аккаунт для отложенной покупки: сначала по сохранённому id, а если строки уже нет (аккаунт
  // передобавляли — id новый), ищем по имени и ЧИНИМ ссылку в снайпе. Без этого снайп, поставленный
  // утром, срывался вечером только потому, что аккаунт заново вошёл в игру.
  async function apiForSnipe(s){
    const db=require('../../db/index');
    try{ return await makeApiForAccount(s.account_id,{noLock:true}); }
    catch(e){
      if(!s.account)throw e;
      const acc=await db.Account.findOne({where:{name:s.account},attributes:['id','name']});
      if(!acc)throw e;
      logger.warn(`[snipe] offer ${s.offer_id}: аккаунт «${s.account}» сменил id ${s.account_id} → ${acc.id}, чиню ссылку`);
      await s.update({account_id:acc.id});
      return makeApiForAccount(acc.id,{noLock:true});
    }
  }

  const SNIPE_WARMUP_LEAD=15000;
  async function warmThenFire(id,availableAtMs){
    snipeTimers.delete(id);
    const db=require('../../db/index');
    const{sleep}=require('../../utils/helpers');
    const s=await db.MarketSnipe.findByPk(id);
    if(!s||s.status!=='pending')return;
    let api=null;
    try{
      api=await apiForSnipe(s);
      // лёгкий запрос по тому же лоту: и сессию поднимает, и подтверждает, что лот на месте
      await api.get(`/market/direct/${s.offer_id}`);
    }catch(e){logger.warn(`[snipe] прогрев offer ${s.offer_id}: ${e.message}`);}
    const wait=availableAtMs-Date.now();
    if(wait>0)await sleep(wait);
    await fireSnipe(id,api);
  }
  async function fireSnipe(id,warmApi){
    snipeTimers.delete(id);
    const db=require('../../db/index');
    const{sleep}=require('../../utils/helpers');
    const s=await db.MarketSnipe.findByPk(id);
    if(!s||s.status!=='pending')return;
    let api=warmApi;
    if(!api){
      try{api=await apiForSnipe(s);}
      catch(e){await s.update({status:'failed',error:e.message});logger.warn(`[snipe] offer ${s.offer_id}: ${e.message}`);return;}
    }
    let lastErr=null;
    for(let i=0;i<SNIPE_TRIES;i++){
      if(i)await sleep(SNIPE_RETRY_DELAY);
      try{
        await api.post('/market/direct/buy',{offer_id:s.offer_id});
        await s.update({status:'done',error:null});
        logger.info(`[snipe] offer ${s.offer_id} куплен аккаунтом ${s.account_id}${i?` (попытка ${i+1})`:''}`);
        return;
      }catch(e){
        lastErr=e;
        logger.warn(`[snipe] offer ${s.offer_id} попытка ${i+1}/${SNIPE_TRIES}: ${e.message}`);
      }
    }
    await s.update({status:'failed',error:lastErr?.message||'не удалось купить'});
  }
  // Ждём ровно до available_at, без искусственного запаса.
  // Ожидание нарезано кусками по 55 минут. Максимальный эскроу в игре — 12 часов, то есть в лимит
  // setTimeout (~24.8 суток, дальше 32-битное переполнение и срабатывание НЕМЕДЛЕННО) мы и одним
  // таймером укладываемся — переполнение тут лишь дешёвая страховка. Реальный смысл нарезки в
  // другом: остаток каждый раз считается заново от абсолютного availableAtMs по ТЕКУЩИМ часам.
  // Таймеры Node живут по монотонным часам и не знают о правках системного времени (NTP-шаг,
  // выход из сна), а available_at задан в календарном времени. Один таймер на 12 часов унёс бы
  // с собой всю накопленную поправку; при пересчёте раз в 55 минут промах ограничен последним
  // коротким отрезком.
  function scheduleSnipe(id,availableAtMs){
    if(snipeTimers.has(id))clearTimeout(snipeTimers.get(id));
    const delay=availableAtMs-Date.now();
    // порог с запасом на прогрев: иначе остаток после последнего чанка мог оказаться короче
    // SNIPE_WARMUP_LEAD, и прогрев не успел бы отработать до момента открытия
    if(delay>SNIPE_CHUNK+SNIPE_WARMUP_LEAD){snipeTimers.set(id,setTimeout(()=>scheduleSnipe(id,availableAtMs),SNIPE_CHUNK));return;}
    // просыпаемся ЗАРАНЕЕ, на прогрев; сам выстрел warmThenFire делает точно в availableAtMs
    snipeTimers.set(id,setTimeout(()=>warmThenFire(id,availableAtMs),Math.max(0,delay-SNIPE_WARMUP_LEAD)));
  }
  function startSnipeScheduler(){
    (async()=>{const db=require('../../db/index');const pend=await db.MarketSnipe.findAll({where:{status:'pending'}});for(const s of pend)scheduleSnipe(s.id,new Date(s.available_at).getTime());})().catch(e=>logger.warn(`[snipe] init: ${e.message}`));
  }
  app.post('/api/market/snipe',async(req,res)=>{
    try{
      const{offer_id,account_id,item_id,currency,price,available_at}=req.body||{};
      if(!offer_id||!account_id||!available_at)return res.status(400).json({ok:false,error:'offer_id, account_id, available_at обязательны'});
      const db=require('../../db/index');
      const acc=await db.Account.findByPk(Number(account_id),{attributes:['id','name']});
      if(!acc)return res.status(404).json({ok:false,error:'аккаунт не найден'});
      const[row,created]=await db.MarketSnipe.findOrCreate({where:{offer_id,account_id},defaults:{account:acc.name,item_id:item_id??null,currency,price:price??null,available_at,status:'pending',created_at:new Date()}});
      if(created&&!row.account)await row.update({account:acc.name});
      if(!created)await row.update({status:'pending',error:null,available_at,price:price??row.price});
      scheduleSnipe(row.id,new Date(available_at).getTime());
      res.json({ok:true,id:row.id});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.get('/api/market/snipe',async(req,res)=>{
    try{const db=require('../../db/index');const rows=await db.MarketSnipe.findAll({order:[['available_at','DESC']]});
    res.json({ok:true,snipes:rows.map(r=>r.toJSON())});}catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.delete('/api/market/snipe/:id',async(req,res)=>{
    try{const db=require('../../db/index');const id=Number(req.params.id);if(snipeTimers.has(id)){clearTimeout(snipeTimers.get(id));snipeTimers.delete(id);}await db.MarketSnipe.destroy({where:{id}});res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.__startSnipeScheduler=startSnipeScheduler;

  // Карты политик (не путать с "наборами"/"тайными политиками" mystery_* — те стакаются как обычные
  // предметы, id 23-29, и нормально считаются через /storage/allitemdata) НЕ хранятся в общем
  // сторедже вообще — каждая карта уникальный инстанс (свой id, уровень, эффекты — см.
  // modules/policies.js/PolicySnapshot). На рынке под них выделен ОБЩИЙ "бакет"-item_id=30
  // (сверено живым запросом 31.07.2026: /market/user/listing-rules отдаёт для него ОТДЕЛЬНЫЙ
  // market_id на каждую редкость epic/legendary/mythic/eternal, а /storage/allitemdata карты
  // политик не содержит вовсе — раньше это и было причиной, почему они никогда не показывались
  // как доступные к продаже: bot искал owned по item_id=30 в сторедже и всегда находил 0).
  // Считаем "сколько есть" ПО РЕДКОСТИ из живого /policies/ вместо storage; enacted (в кабинете
  // мэра) или заблокированная (lock_until) карта недоступна к продаже, как экипированный предмет.
  const POLICY_CARD_BUCKET_ITEM_ID=30;
  // Живой список СВОБОДНЫХ (не в кабинете мэра, не заблокированных) карт политик аккаунта, по
  // ОДНОЙ записи на инстанс, с def_id+названием — нужно, чтобы UI мог показать не общий "бакет"
  // редкости, а КАЖДУЮ конкретную политику отдельно (у разных политик одной редкости разные
  // названия/эффекты, продавать их "не глядя" одним лотом-редкостью нельзя было по просьбе
  // пользователя 31.07.2026 — см. группировку ниже).
  async function ownedPolicyCards(api){
    const pol=await api.get('/policies/').catch(()=>null);
    // БАГ (найден 31.07.2026): раньше тут стояло pol?.list — такого поля в СЫРОМ ответе игры нет
    // вообще (list — это имя КОЛОНКИ в нашей БД PolicySnapshot, куда modules/policies.js кладёт УЖЕ
    // извлечённый массив). Сырой live-ответ — либо голый массив, либо {instances:[...]}/{policies:[...]}
    // — та же экстракция, что и в modules/policies.js runPolicies, теперь скопирована 1:1.
    const list=Array.isArray(pol)?pol:(pol?.instances||pol?.policies||[]);
    // instance_id (p.id) нужен, чтобы при выставлении указать игре КОНКРЕТНУЮ карту через
    // policy_instance_id (реверс бандла 31.07.2026, см. CREATE_ENDPOINT/listingBody ниже) — без него
    // игра сама выбирает любую карту редкости, что могло случайно продать не ту политику.
    return list
      .filter(p=>p.enacted_slot==null&&!p.lock_until&&p.rarity)
      .map(p=>({instance_id:p.id,def_id:p.def_id,rarity:p.rarity,name:p.definition?.name?.ru||p.definition?.name?.en||String(p.def_id)}));
  }
  function countByRarity(cards){
    const m=new Map();for(const c of cards)m.set(c.rarity,(m.get(c.rarity)||0)+1);return m;
  }
  // группировка по КОНКРЕТНОЙ политике (def_id) — то, что реально показываем в UI выбора
  function groupByDefId(cards){
    const m=new Map();
    for(const c of cards){
      const cur=m.get(c.def_id);
      if(cur)cur.count++;else m.set(c.def_id,{def_id:c.def_id,rarity:c.rarity,name:c.name,count:1});
    }
    return m;
  }

  // Разделение логики выставления (31.07.2026, по просьбе пользователя): обычные предметы (booster/
  // pack/component/masterplan/…) — быстрый путь, как на странице "Предметы", без лишнего живого
  // запроса к /policies/. "Политики"+"осколки" — отдельная кнопка на странице, ей всегда нужен живой
  // /policies/ (карты политик не в сторедже, см. выше) — раз уж он всё равно живой, заодно там же
  // считаем и осколки живьём (хотя у них с этим бага не было, id из listing-rules 1:1 совпадает со
  // storage — но один общий "живой" путь для обеих специальных категорий проще поддерживать, чем
  // размазывать разницу по всему файлу). mode=special — только category IN (policy,shard),
  // mode=items (по умолчанию) — все остальные категории.
  const SPECIAL_CATEGORIES=new Set(['policy','shard']);
  function categoryAllowed(category,mode){
    const special=SPECIAL_CATEGORIES.has(category);
    return mode==='special'?special:!special;
  }

  // ── локальный учёт хранилища при выставлении/возврате лота (БЕЗ запроса к игре) ──
  // Карты политик живут в PolicySnapshot.list (снимок /policies/), обычные предметы и осколки —
  // в Inventory. Выставили лот — вещь физически уходит из хранилища игры, отменили — возвращается.
  // Раньше в БД не отражалось ни то, ни другое: страницы «Политики»/«Предметы» до следующей полной
  // синхронизации показывали уже выставленное как имеющееся, а вернувшееся — как отсутствующее.
  // Карту НЕ удаляем из списка, а помечаем (_listed_at/_listed_offer_id) — тогда возврат отдаёт
  // ИМЕННО ТУ карту со всеми её полями (уровень, эффекты, серийник), а не собранную заново.
  // Читающие места обязаны такие записи пропускать: /api/policies (routes/policies.js) и
  // /api/market/item-accounts ниже.
  async function policyMarkListed(accountName,instanceId,offerId){
    if(instanceId==null)return;
    try{
      const{PolicySnapshot}=require('../../db/index');
      const row=await PolicySnapshot.findOne({where:{account:accountName}});
      if(!row)return;
      const list=JSON.parse(row.list||'[]');
      const p=list.find(x=>String(x.id)===String(instanceId));
      if(!p)return;
      p._listed_offer_id=offerId??null; // id лота узнать не всегда удаётся — тогда вернём по редкости
      p._listed_at=new Date().toISOString();
      await row.update({list:JSON.stringify(list)});
    }catch(e){logger.warn(`[market] локальная пометка политики ${instanceId}: ${e.message}`);}
  }
  async function policyReturnListed(accountName,{offer_id,rarity}){
    try{
      const{PolicySnapshot}=require('../../db/index');
      const row=await PolicySnapshot.findOne({where:{account:accountName}});
      if(!row)return false;
      const list=JSON.parse(row.list||'[]');
      const flagged=list.filter(x=>x._listed_at);
      if(!flagged.length)return false;
      // сначала по id лота — точное попадание; иначе самая ранняя выставленная карта той же редкости
      let p=offer_id!=null?flagged.find(x=>x._listed_offer_id!=null&&String(x._listed_offer_id)===String(offer_id)):null;
      if(!p&&rarity)p=flagged.filter(x=>x.rarity===rarity).sort((a,b)=>String(a._listed_at).localeCompare(String(b._listed_at)))[0];
      if(!p)return false;
      delete p._listed_offer_id;delete p._listed_at;
      await row.update({list:JSON.stringify(list)});
      return true;
    }catch(e){logger.warn(`[market] локальный возврат политики: ${e.message}`);return false;}
  }
  async function inventoryAdjust(accountName,itemId,delta){
    if(itemId==null||!delta)return;
    try{
      const{Inventory}=require('../../db/index');
      const row=await Inventory.findOne({where:{account:accountName,name:String(itemId)}});
      if(!row)return;
      await row.update({marketable:Math.max(0,Number(row.marketable||0)+delta)});
    }catch(e){logger.warn(`[market] локальная правка предмета ${itemId}: ${e.message}`);}
  }
  // id созданного лота из ответа игры — форма ответа не документирована, поэтому пробуем варианты;
  // если не нашли, возврат отработает по редкости (см. policyReturnListed)
  const createdOfferId=r=>r?.offer?.id??r?.id??r?.listing_id??r?.offer_id??null;

  // ── выставление предмета на рынок ───────────────────────────────────────────
  app.get('/api/market/sellable',async(req,res)=>{
    try{
      const{account_id,mode}=req.query;
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const needCards=mode==='special';
      const[lim,stor,cards]=await Promise.all([
        api.get('/market/user/listing-rules').catch(()=>null),
        api.get('/storage/allitemdata').catch(()=>null),
        needCards?ownedPolicyCards(api):Promise.resolve([]),
      ]);
      const limits=lim?.rules||[];
      const raw=stor?.items;
      const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
      const owned=new Map();
      for(const it of sItems){const id=it.item_id??it.id;const q=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));if(id!=null)owned.set(Number(id),(owned.get(Number(id))||0)+q);}
      const cardsByDefId=groupByDefId(cards);
      const items=[];
      for(const i of limits){
        if(!categoryAllowed(i.item_category,mode)||!i.can_list||i.enabled_for_trade===false)continue;
        if(i.listings_limit!=null&&i.current_listings>=i.listings_limit)continue;
        const base={market_id:i.market_id,item_id:i.item_id,market_type:i.market_type||'direct',currency:i.currency,floor_price:i.floor_price,ceiling_price:i.ceiling_price,item_category:i.item_category,item_rarity:i.item_rarity,current_listings:i.current_listings,listings_limit:i.listings_limit};
        if(i.item_id===POLICY_CARD_BUCKET_ITEM_ID){
          // одна карта-редкость = много РАЗНЫХ политик (разные названия/эффекты) — раньше лепили их
          // в одну строку "Политика (Эпическая)", по просьбе пользователя 31.07.2026 показываем
          // каждую отдельно (def_id+название), owned = сколько именно ЭТОЙ политики есть
          for(const c of cardsByDefId.values()){
            if(c.rarity!==i.item_rarity||c.count<=0)continue;
            items.push({...base,def_id:c.def_id,policy_name:c.name,owned:c.count});
          }
        }else{
          const own=owned.get(i.item_id)||0;
          if(own>0)items.push({...base,owned:own});
        }
      }
      res.json({ok:true,items});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // агрегированный список продаваемых предметов по ВСЕМ аккаунтам (для режима «случайные аккаунты»)
  app.get('/api/market/sellable-all',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const{mode}=req.query;
      const needCards=mode==='special';
      const idSet=req.query.account_ids?new Set(String(req.query.account_ids).split(',').map(s=>Number(s.trim())).filter(Boolean)):null;
      let accs=(await Account.findAll({order:[['id','ASC']]})).filter(a=>a.access_token&&a.access_token!=='placeholder');
      if(idSet)accs=accs.filter(a=>idSet.has(a.id));
      const byMarket=new Map();
      for(const acc of accs){
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const[lim,stor,cards]=await Promise.all([
            api.get('/market/user/listing-rules').catch(()=>null),
            api.get('/storage/allitemdata').catch(()=>null),
            needCards?ownedPolicyCards(api):Promise.resolve([]),
          ]);
          const limits=lim?.rules||[];
          const raw=stor?.items;const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
          const owned=new Map();
          for(const it of sItems){const id=it.item_id??it.id;const q=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));if(id!=null)owned.set(Number(id),(owned.get(Number(id))||0)+q);}
          const cardsByDefId=groupByDefId(cards);
          for(const i of limits){
            if(!categoryAllowed(i.item_category,mode)||!i.can_list||i.enabled_for_trade===false)continue;
            const mt=i.market_type||'direct';
            if(i.item_id===POLICY_CARD_BUCKET_ITEM_ID){
              // ключ группировки — market_id+market_type+def_id (market_id общий и на всю редкость,
              // И на несколько market_type сразу — см. listing-rules; каждой комбинации своя строка)
              for(const c of cardsByDefId.values()){
                if(c.rarity!==i.item_rarity||c.count<=0)continue;
                const key=`${i.market_id}:${mt}:${c.def_id}`;
                const cur=byMarket.get(key);
                const freeSlots=i.listings_limit==null?c.count:Math.max(0,i.listings_limit-i.current_listings);
                if(cur){cur.owned+=c.count;cur.free_slots+=Math.min(freeSlots,c.count);cur.accounts+=1;}
                else byMarket.set(key,{market_id:i.market_id,item_id:i.item_id,market_type:mt,def_id:c.def_id,policy_name:c.name,currency:i.currency,floor_price:i.floor_price,ceiling_price:i.ceiling_price,item_category:i.item_category,item_rarity:i.item_rarity,current_listings:0,listings_limit:null,owned:c.count,free_slots:Math.min(freeSlots,c.count),accounts:1});
              }
            }else{
              const own=owned.get(i.item_id)||0;
              if(own<=0)continue;
              const key=`${i.market_id}:${mt}`;
              const cur=byMarket.get(key);
              const freeSlots=i.listings_limit==null?own:Math.max(0,i.listings_limit-i.current_listings);
              if(cur){cur.owned+=own;cur.free_slots+=Math.min(freeSlots,own);cur.accounts+=1;}
              else byMarket.set(key,{market_id:i.market_id,item_id:i.item_id,market_type:mt,currency:i.currency,floor_price:i.floor_price,ceiling_price:i.ceiling_price,item_category:i.item_category,item_rarity:i.item_rarity,current_listings:0,listings_limit:null,owned:own,free_slots:Math.min(freeSlots,own),accounts:1});
            }
          }
        }catch(_){}
      }
      res.json({ok:true,items:[...byMarket.values()].sort((a,b)=>b.owned-a.owned)});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // аккаунты, у которых есть данный предмет (для выбора при выставлении) — из снапшота инвентаря, без обращения к игре
  app.get('/api/market/item-accounts',async(req,res)=>{
    try{
      const{item_id,rarity,def_id}=req.query;
      if(item_id==null)return res.status(400).json({ok:false,error:'item_id обязателен'});
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({attributes:['id','name','access_token']});
      const out=[];
      // карты политик — item_id общий "бакет" (см. POLICY_CARD_BUCKET_ITEM_ID выше), в Inventory их
      // нет вообще (не стандартный складской предмет, живут в PolicySnapshot), считаем ПО РЕДКОСТИ
      // из уже закэшированного снимка (modules/policies.js), без единого живого запроса — тот же
      // принцип, что и у обычных предметов ниже (эта страница вообще не ходит в игру). def_id — если
      // передан, фильтруем до КОНКРЕТНОЙ политики (см. правку 31.07.2026 — разбивка по def_id).
      if(Number(item_id)===POLICY_CARD_BUCKET_ITEM_ID){
        if(!rarity)return res.status(400).json({ok:false,error:'rarity обязателен для карт политик'});
        const{PolicySnapshot}=require('../../db/index');
        const rows=await PolicySnapshot.findAll({attributes:['account','list']});
        const byName=new Map(accs.map(a=>[a.name,a]));
        for(const r of rows){
          let list=[];try{list=r.list?JSON.parse(r.list):[];}catch(_){continue;}
          const owned=list.filter(p=>p.rarity===rarity&&p.enacted_slot==null&&!p.lock_until&&!p._listed_at&&(!def_id||String(p.def_id)===String(def_id))).length;
          if(owned<=0)continue;
          const a=byName.get(r.account);
          if(!a||!a.access_token||a.access_token==='placeholder')continue;
          out.push({id:a.id,name:a.name,owned});
        }
      }else{
        const{Inventory}=require('../../db/index');
        const rows=await Inventory.findAll({where:{name:String(item_id)}});
        const byName=new Map(accs.map(a=>[a.name,a]));
        for(const r of rows){
          const owned=Number(r.marketable)||0;
          if(owned<=0)continue;
          const a=byName.get(r.account);
          if(!a||!a.access_token||a.access_token==='placeholder')continue;
          out.push({id:a.id,name:a.name,owned});
        }
      }
      out.sort((x,y)=>x.name.localeCompare(y.name,'ru',{numeric:true}));
      res.json({ok:true,accounts:out});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // Обновление игры (маркет): создание direct-лота теперь ТРЕБУЕТ поле listing_days (дней размещения).
  // Без него сервер отвечает 400 "Невозможно обработать данные запроса" (проверено реверсом бандла
  // market_profile-*.js: тело {market_id,price,currency,anonymous_sale,listing_days} и живым тестом).
  // Допустимые значения игры: [1,3,7] (у части предметов только [3,7]); дефолт клиента — 3.
  const listingDays=v=>{const n=Number(v);return[1,3,7].includes(n)?n:3;};
  // Три типа рынка — три РАЗНЫХ эндпоинта создания лота и разная форма тела запроса (реверс
  // бандла 31.07.2026, chunks/listing-*.js + market_profile-*.js, функция be=async() диалога
  // выставления): direct — price+listing_days; auction — starting_bid (НЕ price!)+listing_days;
  // negotiation — БЕЗ цены и БЕЗ listing_days вообще (покупатель сам предлагает цену, продавец
  // потом принимает/отклоняет через /market/negotiation/accept|reject). Общее для всех трёх —
  // опциональный policy_instance_id (конкретная карта политики, если известна — см. ownedPolicyCards).
  const CREATE_ENDPOINT={direct:'/market/direct',auction:'/market/auction',negotiation:'/market/negotiation'};
  function listingBody(marketType,{market_id,price,currency,anonymous,listing_days,policy_instance_id}){
    const base={market_id:Number(market_id),currency,anonymous_sale:!!anonymous};
    if(policy_instance_id!=null)base.policy_instance_id=policy_instance_id;
    if(marketType==='direct')return{...base,price:Number(price),listing_days:listingDays(listing_days)};
    if(marketType==='auction')return{...base,starting_bid:Number(price),listing_days:listingDays(listing_days)};
    if(marketType==='negotiation')return base;
    throw new Error('неизвестный market_type: '+marketType);
  }
  app.post('/api/market/list',async(req,res)=>{
    try{
      const{account_id,market_id,market_type,price,currency,anonymous,listing_days,policy_instance_id}=req.body||{};
      const mt=market_type||'direct';
      if(!account_id||!market_id||!currency||!CREATE_ENDPOINT[mt])return res.status(400).json({ok:false,error:'account_id, market_id, currency обязательны, market_type — direct|auction|negotiation'});
      if(mt!=='negotiation'&&price==null)return res.status(400).json({ok:false,error:'price обязателен для direct/auction'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post(CREATE_ENDPOINT[mt],listingBody(mt,{market_id,price,currency,anonymous,listing_days,policy_instance_id}));
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // выставить N штук, распределяя по случайным аккаунтам (по доступным слотам), запрос раз в секунду
  app.post('/api/market/list-spread',async(req,res)=>{
    try{
      const{market_id,item_id,item_rarity,def_id,price,currency,anonymous,quantity,account_ids,listing_days}=req.body||{};
      const marketType=req.body?.market_type||'direct';
      if(!market_id||item_id==null||!currency||!quantity||!CREATE_ENDPOINT[marketType])return res.status(400).json({ok:false,error:'market_id, item_id, currency, quantity обязательны, market_type — direct|auction|negotiation'});
      if(marketType!=='negotiation'&&price==null)return res.status(400).json({ok:false,error:'price обязателен для direct/auction'});
      const{sleep}=require('../../utils/helpers');
      const{Account}=require('../../db/index');
      let accs=(await Account.findAll({order:[['id','ASC']]})).filter(a=>a.access_token&&a.access_token!=='placeholder');
      if(Array.isArray(account_ids)&&account_ids.length){const s=new Set(account_ids.map(Number));accs=accs.filter(a=>s.has(a.id));}
      // перемешиваем (случайные аккаунты)
      for(let i=accs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[accs[i],accs[j]]=[accs[j],accs[i]];}
      let remaining=Number(quantity),listed=0,firstReq=true;
      const results=[];
      for(const acc of accs){
        if(remaining<=0)break;
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const isPolicyCard=Number(item_id)===POLICY_CARD_BUCKET_ITEM_ID;
          const[lim,stor,cards]=await Promise.all([
            api.get('/market/user/listing-rules').catch(()=>null),
            isPolicyCard?Promise.resolve(null):api.get('/storage/allitemdata').catch(()=>null),
            isPolicyCard?ownedPolicyCards(api):Promise.resolve([]),
          ]);
          const limits=lim?.rules||[];
          let owned=0,cardInstances=[];
          if(isPolicyCard){
            // если задан def_id — считаем ТОЛЬКО эту конкретную политику (см. правку 31.07.2026);
            // без def_id (устар. вызовы) — по всей редкости, как раньше. instance_id каждой карты
            // передаём в запрос ниже (policy_instance_id) — чтобы игра списала ИМЕННО её, а не
            // случайную карту той же редкости (см. listingBody выше).
            cardInstances=cards.filter(c=>c.rarity===item_rarity&&(!def_id||String(c.def_id)===String(def_id)));
            owned=cardInstances.length;
          }else{
            const raw=stor?.items;const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
            for(const it of sItems){const id=it.item_id??it.id;if(Number(id)===Number(item_id))owned+=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));}
          }
          // market_id может быть общим на несколько market_type (напр. direct+auction на одной
          // редкости) — сверяем ОБА поля, иначе рискуем выставить не тем типом рынка.
          const li=limits.find(x=>Number(x.market_id)===Number(market_id)&&x.market_type===marketType);
          if(!li||li.can_list===false){results.push({name:acc.name,listed:0,skip:'не выставляет'});continue;}
          const slotFree=li.listings_limit==null?owned:Math.max(0,li.listings_limit-li.current_listings);
          const free=Math.min(slotFree,owned,remaining);
          if(free<=0){results.push({name:acc.name,listed:0,skip:owned<=0?'нет предмета':'лимит исчерпан'});continue;}
          let cnt=0,err='';
          for(let k=0;k<free;k++){
            if(!firstReq)await sleep(1000);
            firstReq=false;
            try{
              const policy_instance_id=isPolicyCard?cardInstances[k]?.instance_id:undefined;
              const created=await api.post(CREATE_ENDPOINT[marketType],listingBody(marketType,{market_id,price,currency,anonymous,listing_days,policy_instance_id}));
              cnt++;listed++;remaining--;
              // хранилище правим локально, без повторного похода в игру
              if(isPolicyCard)await policyMarkListed(acc.name,policy_instance_id,createdOfferId(created));
              else await inventoryAdjust(acc.name,item_id,-1);
            }catch(e){err=e.message;break;}
          }
          results.push({name:acc.name,listed:cnt,...(err?{error:err}:{})});
          if(err)break; // вероятно rate-limit/проблема — останавливаемся
        }catch(e){results.push({name:acc.name,listed:0,error:e.message});}
      }
      res.json({ok:true,listed,requested:Number(quantity),results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // Вернуть отменённый лот в локальное хранилище. row — строка MarketListing (item_id/категория/
  // редкость); её может не быть, если листинг ещё не попадал в снимок — тогда просто пропускаем,
  // ближайшая полная синхронизация всё равно всё выправит.
  async function returnToStorage(accountName,row,offerId){
    if(!row)return;
    if(row.item_category==='policy')await policyReturnListed(accountName,{offer_id:offerId,rarity:row.item_rarity});
    else await inventoryAdjust(accountName,row.item_id,+1);
  }
  // отмена одного лота
  app.post('/api/market/listing/cancel',async(req,res)=>{
    try{
      const{account,offer_id}=req.body||{};
      if(!account||offer_id==null)return res.status(400).json({ok:false,error:'account и offer_id обязательны'});
      const{Account,MarketListing}=require('../../db/index');
      const acc=await Account.findOne({where:{name:account}});
      if(!acc||!acc.access_token||acc.access_token==='placeholder')return res.status(404).json({ok:false,error:'аккаунт без токена'});
      const api=await makeApiForAccount(acc.id,{noLock:true});
      // строку листинга читаем ДО удаления — из неё берём, что именно вернуть в хранилище
      const row=await MarketListing.findOne({where:{account,listing_id:Number(offer_id)}});
      await api.post('/market/direct/cancel',{offer_id:Number(offer_id)});
      await MarketListing.destroy({where:{account,listing_id:Number(offer_id)}});
      await returnToStorage(account,row,Number(offer_id));
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // отмена всех лотов: для одного аккаунта (account) или для всех (без account)
  app.post('/api/market/listings/cancel-all',async(req,res)=>{
    try{
      const{account}=req.body||{};
      const{Account,MarketListing}=require('../../db/index');
      const where={};
      if(account&&account!=='all')where.account=account;
      const rows=await MarketListing.findAll({where});
      const apiCache=new Map();
      const results=[];
      for(const r of rows){
        try{
          let api=apiCache.get(r.account);
          if(!api){
            const acc=await Account.findOne({where:{name:r.account}});
            if(!acc||!acc.access_token||acc.access_token==='placeholder')throw new Error('аккаунт без токена');
            api=await makeApiForAccount(acc.id,{noLock:true});
            apiCache.set(r.account,api);
          }
          await api.post('/market/direct/cancel',{offer_id:Number(r.listing_id)});
          await MarketListing.destroy({where:{account:r.account,listing_id:r.listing_id}});
          await returnToStorage(r.account,r,Number(r.listing_id));
          results.push({account:r.account,listing_id:r.listing_id,ok:true});
        }catch(e){results.push({account:r.account,listing_id:r.listing_id,ok:false,error:e.message});}
      }
      res.json({ok:true,count:results.filter(x=>x.ok).length,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
