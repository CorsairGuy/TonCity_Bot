'use strict';
// Раздел «Годовщина» — событие «Летний карнавал» (10-23.08.2026, валюта — билеты).
//
// Все данные ЖИВЫЕ (как /api/shop-live/*): снимков в БД нет намеренно — событие идёт две недели,
// заводить под него таблицы и суточные циклы бессмысленно, а прогресс заданий игра и так отдаёт
// готовым числом в /anniversary-event/ (progress/required у каждой ступени).
//
// Формы ответов сверены с бандлом игры 12.08.2026 (chunks/anniversary_event, anniversary_milestones,
// anniversary_offers), чтобы не гадать по именам полей:
//   GET  /anniversary-event/            → {event:{is_active,current_day,total_days,day_end},
//                                          tasks:{regular[],exclusive[],meta[]},
//                                          tickets_balance,tickets_earned}
//        задание: {identifier,name:{en,ru},task_type,paid_only,tiers:[{id,required,progress,
//                  completed,claimed,reward}]}
//   POST /anniversary-event/claim/{tierId}      → {success,reward_amount}
//   GET  /anniversary-milestones/       → {active,event_ends_at,ticket_item_id,claimed_stages,
//                                          global_total,global_goal,coins_spent,
//                                          stages:[{stage,global_coins,personal_goal,state,
//                                                   ticket_reward,item_rewards[],policy}]}
//   POST /anniversary-milestones/claim/{stage}  → {success}
//   GET  /anniversary/daily-offer       → {active,day,total_days,ends_at,purchased,value_multiplier,
//                                          rewards:[{item_id,amount}],price:{kind,coins,crystals,...},
//                                          ladder:{offers_accepted,rungs:[{rung,offers_required,
//                                                  ticket_reward,state}]}}
//   POST /anniversary/daily-offer/buy   {payment_method:'coins'|'crystals'} → {success,balance}
//   POST /anniversary/offer-ladder/claim {rung} → {success,tickets}
//
// Покупка предложения дня за ЗВЁЗДЫ и TON (dailyOfferBuyStars/dailyOfferBuyTon) намеренно НЕ
// реализована: это реальные деньги, такие платежи делаются руками в самой игре.
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');
const{sweepAccounts}=require('../lib/accountSweep');
const{sleep}=require('../../utils/helpers');
const carnivalRunner=require('../lib/carnivalRunner');

// Пауза между claim-запросами одного аккаунта: игра отвечает 429 «слишком много запросов», если
// дёргать награды подряд (в бандле на этот случай есть отдельный текст ошибки).
const CLAIM_GAP_MS=350;

module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  // Проход по всем живым аккаунтам параллельно — тот же приём, что в shop-live: ошибка одного
  // аккаунта не роняет всю страницу, а приезжает в его же строке.
  // fallback — форма ответа для аккаунта, у которого запрос НЕ УДАЛСЯ. Без неё в строке оставались
  // только {id,name,error}, и страница, обращаясь к b.tasks.regular, падала целиком из-за одного
  // мёртвого аккаунта (у части аккаунтов игра отвечает 403 «нет здания»/протух токен — это норма).
  //
  // Ретраи по сбойным аккаунтам, бюджет и «вечные» ошибки — в общем хелпере (web/lib/accountSweep.js),
  // им же пользуется магазин билетов в routes/economy.js.
  const forAllAccounts=(fn,fallback={},onlyIds=null)=>sweepAccounts(makeApiForAccount,fn,{fallback,label:'anniversary',onlyIds});
  // Проходы, которые ЗАБИРАЮТ награды/тратят билеты: молчание игры не повод повторять — она
  // такой запрос обрабатывает, и повтор увёл бы награду или списал билеты дважды.
  const forAllAccountsMutating=(fn,fallback={},onlyIds=null)=>sweepAccounts(makeApiForAccount,fn,{fallback,label:'anniversary',onlyIds,mutating:true});
  // ?ids=1,2,3 — добрать только перечисленные аккаунты (страница так повторяет сбойные, не гоняя
  // весь список заново). Ключ операции с ids отдельный, иначе повтор «прилип» бы к общему проходу.
  const idsOf=req=>{
    const raw=String(req.query?.ids||'').trim();
    if(!raw)return null;
    const ids=raw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite);
    return ids.length?ids:null;
  };
  const opKey=(base,ids)=>ids?`${base}:${ids.join(',')}`:base;

  // Что аккаунт уже сделал сегодня по нашим собственным записям — нужно, чтобы у заданий без
  // числового порога показывать «Забрать» вместо «Выполнить» и учитывать их в «Забрать всё».
  // Источники локальные, лишних запросов к игре нет:
  //   ежедневный вход  — DailyLog (пишет и суточный цикл бота, и раннер карнавала)
  //   взнос в казну    — CityActionLog с type='guild_deposit' (пишет раннер)
  async function actionsDoneToday(accountName){
    const{DailyLog,CityActionLog}=require('../../db/index');
    const{Op}=require('sequelize');
    const today=new Date().toISOString().slice(0,10);
    const dayStart=new Date(`${today}T00:00:00.000Z`);
    const[login,deposit]=await Promise.all([
      DailyLog.findOne({where:{account:accountName,logged_at:today}}).catch(()=>null),
      CityActionLog.findOne({where:{account:accountName,type:'guild_deposit',created_at:{[Op.gte]:dayStart}}}).catch(()=>null),
    ]);
    return{daily_login:!!login,guild_contribute:!!deposit};
  }

  // ── Летний карнавал: доска заданий ─────────────────────────────────────────
  function normalizeBoard(raw){
    const ev=raw?.event||null;
    const t=raw?.tasks||{};
    const list=k=>Array.isArray(t[k])?t[k]:[];
    return{
      event:ev?{
        is_active:!!ev.is_active,
        current_day:ev.current_day??null,
        total_days:ev.total_days??null,
        day_end:ev.day_end??null,
      }:null,
      tasks:{regular:list('regular'),exclusive:list('exclusive'),meta:list('meta')},
      tickets_balance:raw?.tickets_balance??0,
      tickets_earned:raw?.tickets_earned??0,
    };
  }
  // Готовые к сбору ступени: игра помечает завершённую ступень completed, забранную — claimed.
  // Порядок важен — ступени одного задания забираются снизу вверх, иначе игра отвечает 400.
  // ЗАБИРАЕМ ТОЛЬКО реально выполненные ступени (completed && !claimed). Пробовать claim у
  // невыполненных бессмысленно: игра отвечает «задание не выполнено» — проверено 13.08 на взносе
  // в казну. Сначала задание надо ВЫПОЛНИТЬ (кнопки «Выполнить» на странице → carnivalRunner).
  // done — что аккаунт уже сделал сегодня (см. actionsDoneToday). Такие задания игра иногда
  // держит с completed=false, хотя действие выполнено; claim по ним пробуем «мягко» (optimistic):
  // откажет — молчим, это не ошибка прохода.
  function readyTiers(board,done={}){
    const all=[...board.tasks.regular,...board.tasks.exclusive,...board.tasks.meta];
    const out=[];
    for(const task of all){
      const id=String(task.identifier||'');
      const actionDone=(id.includes('daily_login')&&done.daily_login)||(id.includes('guild_contribute')&&done.guild_contribute);
      for(const tier of (task.tiers||[])){
        if(tier.claimed)continue;
        if(tier.completed){out.push({id:tier.id,reward:tier.reward||0,task:id,optimistic:false});continue;}
        if(actionDone&&tier.required==null)out.push({id:tier.id,reward:tier.reward||0,task:id,optimistic:true});
      }
    }
    return out;
  }

  app.get('/api/anniversary/event',async(req,res)=>{
    try{
      const ids=idsOf(req);
      const accounts=await opRegistry.run(opKey('anniversaryEvent',ids),()=>forAllAccounts(async(api,acc)=>{
        const raw=await api.get('/anniversary-event/');
        return{...normalizeBoard(raw),actions_done:await actionsDoneToday(acc.name)};
      },()=>normalizeBoard(null),ids));
      // Мини-игры живут в «Оплоте Мудрости»: без здания играть нечем, и страница должна показать
      // это вместо кнопки «Выполнить», а не гонять бота впустую. Наличие здания уже лежит в БД
      // (accs.special_buildings, заполняется из /progress/ — тот же признак, что у страниц Оплота).
      const{Account,GuildSnapshot}=require('../../db/index');
      const rows=await Account.findAll({attributes:['id','special_buildings']});
      const wisdom=new Map(rows.map(a=>[a.id,String(a.special_buildings||'').split(',').includes('wisdom')]));
      // Взнос в казну возможен только у члена гильдии — иначе кнопку показывать нельзя (раньше она
      // была и падала с «аккаунт не состоит в гильдии»). Членство берём из GuildSnapshot по имени.
      const guilds=new Set((await GuildSnapshot.findAll({attributes:['account','guild_id']}))
        .filter(g=>g.guild_id).map(g=>g.account));
      res.json({ok:true,accounts:accounts.map(a=>({
        ...a,
        has_wisdom:wisdom.get(a.id)??false,
        has_guild:guilds.has(a.name),
      }))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/event/claim',async(req,res)=>{
    try{
      const{account_id,tier_id}=req.body||{};
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post(`/anniversary-event/claim/${Number(tier_id)}`);
      // Сразу перечитываем доску ИМЕННО ЭТОГО аккаунта и отдаём её вместе с ответом: у задания
      // может быть несколько ступеней, и после сбора первой игра открывает следующую со своим
      // порогом. Страница подставляет свежую доску в свою строку — прогресс следующей ступени
      // виден мгновенно, и при этом НЕ нужен полный живой проход по всем аккаунтам.
      const board=await api.get('/anniversary-event/').then(normalizeBoard).catch(()=>null);
      res.json({ok:true,result:r,reward:r?.reward_amount??null,board});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // «Забрать всё» — по всем аккаунтам сразу: у каждого перечитываем доску, забираем все готовые
  // ступени по очереди и возвращаем сколько билетов реально прилетело.
  app.post('/api/anniversary/event/claim-all',async(req,res)=>{
    try{
      const results=await opRegistry.run('anniversaryEventClaimAll',()=>forAllAccountsMutating(async(api,acc)=>{
        const board=normalizeBoard(await api.get('/anniversary-event/'));
        const tiers=readyTiers(board,await actionsDoneToday(acc.name));
        let claimed=0,tickets=0;const errors=[];
        for(const tier of tiers){
          try{
            const r=await api.post(`/anniversary-event/claim/${tier.id}`);
            if(r?.success!==false){claimed++;tickets+=Number(r?.reward_amount??tier.reward)||0;}
            await sleep(CLAIM_GAP_MS);
          }catch(e){if(!tier.optimistic)errors.push(`${tier.task}: ${e.message}`);}
        }
        if(claimed)logger.info(`[${acc.name}] [anniversary] заклеймлено ступеней: ${claimed}, билетов +${tickets}`);
        return{claimed,tickets,error:errors.length?errors.join('; '):undefined};
      }));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Выполнение заданий карнавала (реклама + мини-игры) ─────────────────────
  // Работа фоновая (см. web/lib/carnivalRunner.js): викторина одна решается ~2.5 минуты, а «сделать
  // всем» — это десятки аккаунтов. Ручка только ставит в очередь и сразу отвечает; страница
  // спрашивает прогресс у /api/anniversary/tasks/status.
  app.post('/api/anniversary/tasks/run',async(req,res)=>{
    try{
      const{account_id,ad=true,minigames=true,guild=false,login=false}=req.body||{};
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(account_id),{attributes:['id','name']});
      if(!acc)return res.status(404).json({ok:false,error:'аккаунт не найден'});
      carnivalRunner.enqueue(acc.id,acc.name,makeApiForAccount,{ad:!!ad,minigames:!!minigames,guild:!!guild,login:!!login});
      res.json({ok:true,started:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // «всем»: ставим в очередь все аккаунты с токеном. Что именно делать (и надо ли вообще) раннер
  // решает уже на месте — по живой доске заданий этого аккаунта.
  app.post('/api/anniversary/tasks/run-all',async(req,res)=>{
    try{
      // по умолчанию ничего: страница всегда явно говорит, ЧТО запускать и по каким аккаунтам
      const{ad=false,minigames=false,guild=false,login=false,account_ids}=req.body||{};
      const{Account}=require('../../db/index');
      const{Op}=require('sequelize');
      const where={access_token:{[Op.not]:null}};
      if(Array.isArray(account_ids)&&account_ids.length)where.id=account_ids.map(Number).filter(Number.isFinite);
      const accs=await Account.findAll({where,order:[['name','ASC']],attributes:['id','name']});
      for(const acc of accs)carnivalRunner.enqueue(acc.id,acc.name,makeApiForAccount,{ad:!!ad,minigames:!!minigames,guild:!!guild,login:!!login});
      res.json({ok:true,started:accs.length});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/anniversary/tasks/status',(req,res)=>{
    carnivalRunner.prune();
    res.json({ok:true,rows:carnivalRunner.list()});
  });

  // ── Хранилище призов (открылось 15.08) ─────────────────────────────────────
  // Формы сверены с бандлом 15.08 (chunks/anniversary_vault-*, пути anniversaryVault):
  //   GET  /anniversary-vault/      → {is_open,opens_at,ends_at,spins_done,total_spins,next_cost,
  //                                    tickets_balance,tickets_spent,
  //                                    prizes:[{index,grand,rewards:[{item_id,amount}],won,odds_bp,won_at}]}
  //   POST /anniversary-vault/spin  → {prize_index,grand,rewards,prizes,spins_done,next_cost,
  //                                    tickets_balance,tickets_paid}
  // Каждая ячейка выигрывается ОДИН раз, цена следующего вращения растёт — поэтому «крутить всем»
  // здесь нет: это трата билетов, решение по каждому аккаунту принимает человек.
  function normalizeVault(raw){
    return{
      is_open:!!raw?.is_open,
      opens_at:raw?.opens_at??null,
      ends_at:raw?.ends_at??null,
      spins_done:Number(raw?.spins_done??0),
      total_spins:Number(raw?.total_spins??0),
      next_cost:raw?.next_cost==null?null:Number(raw.next_cost),
      tickets_balance:Number(raw?.tickets_balance??0),
      tickets_spent:Number(raw?.tickets_spent??0),
      prizes:Array.isArray(raw?.prizes)?raw.prizes:[],
    };
  }

  app.get('/api/anniversary/vault',async(req,res)=>{
    try{
      const ids=idsOf(req);
      const accounts=await opRegistry.run(opKey('anniversaryVault',ids),()=>forAllAccounts(async api=>{
        const raw=await api.get('/anniversary-vault/');
        return{vault:normalizeVault(raw)};
      },()=>({vault:normalizeVault(null)}),ids));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/vault/spin',async(req,res)=>{
    try{
      const{account_id}=req.body||{};
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(account_id),{attributes:['id','name']});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/anniversary-vault/spin');
      if(acc){
        const items=(r?.rewards||[]).map(x=>`${x.item_id}×${x.amount}`).join(', ');
        logger.info(`[${acc.name}] [anniversary] хранилище: вращение за ${r?.tickets_paid??'?'} билетов${r?.grand?' (ГЛАВНЫЙ ПРИЗ)':''} → ${items||'нет данных'}`);
        // выигранное попадает на склад — подтягиваем инвентарь, чтобы страницы предметов не врали
        await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
      }
      res.json({ok:true,result:r,vault:r?normalizeVault({...r,is_open:true}):null});
    }catch(e){res.status(500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // «Крутить всем» — ОДНО вращение на каждый переданный аккаунт. Список аккаунтов присылает
  // страница (те, у кого по её данным хватает билетов), но сервер ПЕРЕПРОВЕРЯЕТ состояние сам:
  // билеты могли уйти на покупку в другой вкладке, а вращение — это трата, второй раз списывать
  // не за что. Не подошёл — молча пропускаем со строкой-пояснением.
  app.post('/api/anniversary/vault/spin-all',async(req,res)=>{
    try{
      const{account_ids}=req.body||{};
      const ids=Array.isArray(account_ids)?account_ids.map(Number).filter(Number.isFinite):null;
      if(!ids||!ids.length)return res.status(400).json({ok:false,error:'account_ids обязателен'});
      const results=await opRegistry.run('anniversaryVaultSpinAll',()=>forAllAccountsMutating(async(api,acc)=>{
        const before=normalizeVault(await api.get('/anniversary-vault/'));
        if(!before.is_open)return{skipped:'хранилище закрыто'};
        if(before.total_spins>0&&before.spins_done>=before.total_spins)return{skipped:'все призы уже забраны'};
        if(before.next_cost==null)return{skipped:'игра не назвала цену вращения'};
        if(before.tickets_balance<before.next_cost)
          return{skipped:`не хватает ${before.next_cost-before.tickets_balance} билетов`};
        const r=await api.post('/anniversary-vault/spin');
        const items=(r?.rewards||[]).map(x=>`${x.item_id}×${x.amount}`).join(', ');
        logger.info(`[${acc.name}] [anniversary] хранилище: вращение за ${r?.tickets_paid??'?'} билетов${r?.grand?' (ГЛАВНЫЙ ПРИЗ)':''} → ${items||'нет данных'}`);
        await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
        return{
          spun:true,
          grand:!!r?.grand,
          tickets_paid:r?.tickets_paid??null,
          rewards:Array.isArray(r?.rewards)?r.rewards:[],
          vault:normalizeVault({...r,is_open:true}),
        };
      },{skipped:'не удалось'},ids));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Дорога наград ──────────────────────────────────────────────────────────
  function normalizeRoad(raw){
    return{
      active:!!raw?.active,
      event_ends_at:raw?.event_ends_at??null,
      ticket_item_id:raw?.ticket_item_id??null,
      claimed_stages:raw?.claimed_stages??0,
      global_total:Number(raw?.global_total??0),
      global_goal:Number(raw?.global_goal??0),
      coins_spent:Number(raw?.coins_spent??0),
      stages:Array.isArray(raw?.stages)?raw.stages:[],
    };
  }

  app.get('/api/anniversary/milestones',async(req,res)=>{
    try{
      const ids=idsOf(req);
      const accounts=await opRegistry.run(opKey('anniversaryMilestones',ids),()=>forAllAccounts(async api=>{
        const raw=await api.get('/anniversary-milestones/');
        return{road:normalizeRoad(raw)};
      },()=>({road:normalizeRoad(null)}),ids));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/milestones/claim',async(req,res)=>{
    try{
      const{account_id,stage}=req.body||{};
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post(`/anniversary-milestones/claim/${Number(stage)}`);
      const road=await api.get('/anniversary-milestones/').then(normalizeRoad).catch(()=>null);
      res.json({ok:true,result:r,road});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/milestones/claim-all',async(req,res)=>{
    try{
      const results=await opRegistry.run('anniversaryMilestonesClaimAll',()=>forAllAccountsMutating(async(api,acc)=>{
        const road=normalizeRoad(await api.get('/anniversary-milestones/'));
        const ready=road.stages.filter(s=>s.state==='claimable');
        let claimed=0;const errors=[];
        for(const st of ready){
          try{
            const r=await api.post(`/anniversary-milestones/claim/${st.stage}`);
            if(r?.success!==false)claimed++;
            await sleep(CLAIM_GAP_MS);
          }catch(e){errors.push(`этап ${st.stage}: ${e.message}`);}
        }
        if(claimed)logger.info(`[${acc.name}] [anniversary] Дорога наград: забрано этапов ${claimed}`);
        return{claimed,error:errors.length?errors.join('; '):undefined};
      }));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Предложение дня + билетная лестница ────────────────────────────────────
  function normalizeOffer(raw){
    if(!raw)return{offer:null,ladder:null};
    return{
      offer:{
        active:!!raw.active,
        day:raw.day??null,
        total_days:raw.total_days??null,
        ends_at:raw.ends_at??null,
        purchased:!!raw.purchased,
        value_multiplier:raw.value_multiplier??0,
        rewards:Array.isArray(raw.rewards)?raw.rewards:[],
        price:raw.price??null,
      },
      ladder:raw.ladder?{
        offers_accepted:raw.ladder.offers_accepted??0,
        rungs:Array.isArray(raw.ladder.rungs)?raw.ladder.rungs:[],
      }:null,
    };
  }

  app.get('/api/anniversary/offers',async(req,res)=>{
    try{
      const ids=idsOf(req);
      const accounts=await opRegistry.run(opKey('anniversaryOffers',ids),()=>forAllAccounts(async api=>{
        const raw=await api.get('/anniversary/daily-offer');
        return normalizeOffer(raw);
      },()=>normalizeOffer(null),ids));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Покупка за монеты/алмазы. После неё, как и в магазине, перечитываем баланс и склад из игры:
  // предложение выдаёт предметы, а списанные монеты иначе останутся в БД старым числом
  // (тот же баг, что чинили в shop-live 01.08 — см. syncAfterPurchase в routes/economy.js).
  app.post('/api/anniversary/offers/buy',async(req,res)=>{
    try{
      const{account_id,payment_method}=req.body||{};
      const method=payment_method==='crystals'?'crystals':'coins';
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(account_id),{attributes:['id','name']});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/anniversary/daily-offer/buy',{payment_method:method});
      let balance=null;
      if(acc){
        await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
        try{
          const prog=await api.get('/progress/');
          const d=prog?.progress?.data;
          if(d){
            const upd={};
            if(d.coins!=null)upd.balance=d.coins;
            if(d.crystals!=null)upd.crystals=d.crystals;
            if(Object.keys(upd).length)await Account.update(upd,{where:{id:acc.id}});
            balance={balance:d.coins??null,crystals:d.crystals??null};
          }
        }catch(_){}
        logger.info(`[${acc.name}] [anniversary] предложение дня куплено за ${method}`);
      }
      res.json({ok:true,result:r,balance});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/offers/ladder/claim',async(req,res)=>{
    try{
      const{account_id,rung}=req.body||{};
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await api.post('/anniversary/offer-ladder/claim',{rung:Number(rung)});
      const fresh=await api.get('/anniversary/daily-offer').then(normalizeOffer).catch(()=>null);
      res.json({ok:true,result:r,tickets:r?.tickets??null,...(fresh||{})});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/anniversary/offers/ladder/claim-all',async(req,res)=>{
    try{
      const results=await opRegistry.run('anniversaryLadderClaimAll',()=>forAllAccountsMutating(async(api,acc)=>{
        const{ladder}=normalizeOffer(await api.get('/anniversary/daily-offer'));
        const ready=(ladder?.rungs||[]).filter(r=>r.state==='claimable');
        let claimed=0,tickets=0;const errors=[];
        for(const rung of ready){
          try{
            const r=await api.post('/anniversary/offer-ladder/claim',{rung:rung.rung});
            if(r?.success!==false){claimed++;tickets+=Number(r?.tickets??rung.ticket_reward)||0;}
            await sleep(CLAIM_GAP_MS);
          }catch(e){errors.push(`ступень ${rung.rung}: ${e.message}`);}
        }
        if(claimed)logger.info(`[${acc.name}] [anniversary] лестница: ступеней ${claimed}, билетов +${tickets}`);
        return{claimed,tickets,error:errors.length?errors.join('; '):undefined};
      }));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
