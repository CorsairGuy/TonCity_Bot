'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

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
    const shuffled=[...tokened].sort(()=>Math.random()-0.5);
    let lastErr;
    for(const acc of shuffled.slice(0,3)){
      try{
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await api.get('/market/direct/stats');
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
  app.get('/api/market/ton-balances',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const tokened=accs.filter(a=>a.access_token&&a.access_token!=='placeholder');
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
      const accs=await Account.findAll({where:{id:account_ids}});
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
  const snipeTimers=new Map();
  async function fireSnipe(id){
    snipeTimers.delete(id);
    const db=require('../../db/index');
    const s=await db.MarketSnipe.findByPk(id);
    if(!s||s.status!=='pending')return;
    try{
      const api=await makeApiForAccount(s.account_id,{noLock:true});
      await api.post('/market/direct/buy',{offer_id:s.offer_id});
      await s.update({status:'done'});
      logger.info(`[snipe] offer ${s.offer_id} куплен аккаунтом ${s.account_id}`);
    }catch(e){await s.update({status:'failed',error:e.message});logger.warn(`[snipe] offer ${s.offer_id}: ${e.message}`);}
  }
  function scheduleSnipe(id,availableAtMs){
    if(snipeTimers.has(id))clearTimeout(snipeTimers.get(id));
    const delay=availableAtMs-Date.now();
    if(delay>SNIPE_CHUNK)snipeTimers.set(id,setTimeout(()=>scheduleSnipe(id,availableAtMs),SNIPE_CHUNK));
    else snipeTimers.set(id,setTimeout(()=>fireSnipe(id),Math.max(0,delay)+400));
  }
  function startSnipeScheduler(){
    (async()=>{const db=require('../../db/index');const pend=await db.MarketSnipe.findAll({where:{status:'pending'}});for(const s of pend)scheduleSnipe(s.id,new Date(s.available_at).getTime());})().catch(e=>logger.warn(`[snipe] init: ${e.message}`));
  }
  app.post('/api/market/snipe',async(req,res)=>{
    try{
      const{offer_id,account_id,item_id,currency,price,available_at}=req.body||{};
      if(!offer_id||!account_id||!available_at)return res.status(400).json({ok:false,error:'offer_id, account_id, available_at обязательны'});
      const db=require('../../db/index');
      const[row,created]=await db.MarketSnipe.findOrCreate({where:{offer_id,account_id},defaults:{item_id:item_id??null,currency,price:price??null,available_at,status:'pending',created_at:new Date()}});
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

  // ── выставление предмета на рынок ───────────────────────────────────────────
  app.get('/api/market/sellable',async(req,res)=>{
    try{
      const{account_id}=req.query;
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const[lim,stor]=await Promise.all([
        api.get('/market/user/listing-rules').catch(()=>null),
        api.get('/storage/allitemdata').catch(()=>null),
      ]);
      const limits=lim?.rules||[];
      const raw=stor?.items;
      const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
      const owned=new Map();
      for(const it of sItems){const id=it.item_id??it.id;const q=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));if(id!=null)owned.set(Number(id),(owned.get(Number(id))||0)+q);}
      const items=limits
        .filter(i=>i.can_list&&i.enabled_for_trade!==false&&(i.listings_limit==null||i.current_listings<i.listings_limit)&&(owned.get(i.item_id)||0)>0)
        .map(i=>({market_id:i.market_id,item_id:i.item_id,currency:i.currency,floor_price:i.floor_price,ceiling_price:i.ceiling_price,item_category:i.item_category,item_rarity:i.item_rarity,current_listings:i.current_listings,listings_limit:i.listings_limit,owned:owned.get(i.item_id)||0}));
      res.json({ok:true,items});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // агрегированный список продаваемых предметов по ВСЕМ аккаунтам (для режима «случайные аккаунты»)
  app.get('/api/market/sellable-all',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const idSet=req.query.account_ids?new Set(String(req.query.account_ids).split(',').map(s=>Number(s.trim())).filter(Boolean)):null;
      let accs=(await Account.findAll({order:[['id','ASC']]})).filter(a=>a.access_token&&a.access_token!=='placeholder');
      if(idSet)accs=accs.filter(a=>idSet.has(a.id));
      const byMarket=new Map();
      for(const acc of accs){
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const[lim,stor]=await Promise.all([
            api.get('/market/user/listing-rules').catch(()=>null),
            api.get('/storage/allitemdata').catch(()=>null),
          ]);
          const limits=lim?.rules||[];
          const raw=stor?.items;const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
          const owned=new Map();
          for(const it of sItems){const id=it.item_id??it.id;const q=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));if(id!=null)owned.set(Number(id),(owned.get(Number(id))||0)+q);}
          for(const i of limits){
            const own=owned.get(i.item_id)||0;
            if(i.can_list&&i.enabled_for_trade!==false&&own>0){
              const cur=byMarket.get(i.market_id);
              const freeSlots=i.listings_limit==null?own:Math.max(0,i.listings_limit-i.current_listings);
              if(cur){cur.owned+=own;cur.free_slots+=Math.min(freeSlots,own);cur.accounts+=1;}
              else byMarket.set(i.market_id,{market_id:i.market_id,item_id:i.item_id,currency:i.currency,floor_price:i.floor_price,ceiling_price:i.ceiling_price,item_category:i.item_category,item_rarity:i.item_rarity,current_listings:0,listings_limit:null,owned:own,free_slots:Math.min(freeSlots,own),accounts:1});
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
      const{item_id}=req.query;
      if(item_id==null)return res.status(400).json({ok:false,error:'item_id обязателен'});
      const{Inventory,Account}=require('../../db/index');
      const rows=await Inventory.findAll({where:{name:String(item_id)}});
      const accs=await Account.findAll({attributes:['id','name','access_token']});
      const byName=new Map(accs.map(a=>[a.name,a]));
      const out=[];
      for(const r of rows){
        const owned=Number(r.marketable)||0;
        if(owned<=0)continue;
        const a=byName.get(r.account);
        if(!a||!a.access_token||a.access_token==='placeholder')continue;
        out.push({id:a.id,name:a.name,owned});
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
  app.post('/api/market/list',async(req,res)=>{
    try{
      const{account_id,market_id,price,currency,anonymous,listing_days}=req.body||{};
      if(!account_id||!market_id||price==null||!currency)return res.status(400).json({ok:false,error:'account_id, market_id, price, currency обязательны'});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/market/direct',{market_id:Number(market_id),price:Number(price),currency,anonymous_sale:!!anonymous,listing_days:listingDays(listing_days)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // выставить N штук, распределяя по случайным аккаунтам (по доступным слотам), запрос раз в секунду
  app.post('/api/market/list-spread',async(req,res)=>{
    try{
      const{market_id,item_id,price,currency,anonymous,quantity,account_ids,listing_days}=req.body||{};
      if(!market_id||item_id==null||price==null||!currency||!quantity)return res.status(400).json({ok:false,error:'market_id, item_id, price, currency, quantity обязательны'});
      const days=listingDays(listing_days);
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
          const[lim,stor]=await Promise.all([
            api.get('/market/user/listing-rules').catch(()=>null),
            api.get('/storage/allitemdata').catch(()=>null),
          ]);
          const limits=lim?.rules||[];
          const raw=stor?.items;const sItems=Array.isArray(raw)?raw:Object.values(raw||{});
          let owned=0;for(const it of sItems){const id=it.item_id??it.id;if(Number(id)===Number(item_id))owned+=Math.max(0,(Number(it.quantity)||0)-(Number(it.soulbound)||0));}
          const li=limits.find(x=>Number(x.market_id)===Number(market_id));
          if(!li||li.can_list===false){results.push({name:acc.name,listed:0,skip:'не выставляет'});continue;}
          const slotFree=li.listings_limit==null?owned:Math.max(0,li.listings_limit-li.current_listings);
          const free=Math.min(slotFree,owned,remaining);
          if(free<=0){results.push({name:acc.name,listed:0,skip:owned<=0?'нет предмета':'лимит исчерпан'});continue;}
          let cnt=0,err='';
          for(let k=0;k<free;k++){
            if(!firstReq)await sleep(1000);
            firstReq=false;
            try{
              await api.post('/market/direct',{market_id:Number(market_id),price:Number(price),currency,anonymous_sale:!!anonymous,listing_days:days});
              cnt++;listed++;remaining--;
            }catch(e){err=e.message;break;}
          }
          results.push({name:acc.name,listed:cnt,...(err?{error:err}:{})});
          if(err)break; // вероятно rate-limit/проблема — останавливаемся
        }catch(e){results.push({name:acc.name,listed:0,error:e.message});}
      }
      res.json({ok:true,listed,requested:Number(quantity),results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // отмена одного лота
  app.post('/api/market/listing/cancel',async(req,res)=>{
    try{
      const{account,offer_id}=req.body||{};
      if(!account||offer_id==null)return res.status(400).json({ok:false,error:'account и offer_id обязательны'});
      const{Account,MarketListing}=require('../../db/index');
      const acc=await Account.findOne({where:{name:account}});
      if(!acc||!acc.access_token||acc.access_token==='placeholder')return res.status(404).json({ok:false,error:'аккаунт без токена'});
      const api=await makeApiForAccount(acc.id,{noLock:true});
      await api.post('/market/direct/cancel',{offer_id:Number(offer_id)});
      await MarketListing.destroy({where:{account,listing_id:Number(offer_id)}});
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
          results.push({account:r.account,listing_id:r.listing_id,ok:true});
        }catch(e){results.push({account:r.account,listing_id:r.listing_id,ok:false,error:e.message});}
      }
      res.json({ok:true,count:results.filter(x=>x.ok).length,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
