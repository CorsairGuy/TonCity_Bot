'use strict';
const logger=require('../../utils/logger');
const {logAction}=require('../../modules/cityActionLog');
const opRegistry=require('../lib/opRegistry');
const cityLive=require('../../utils/cityLive');

// Действия по городу (страница "Города" → "Карта" → редактор карты, см. client/src/pages/CityMap.tsx)
// — заменяет автоматику по эталонному плану (см. modules/progress.js). Только цели улучшений
// сохраняются (CityStrategy.targets) — их читает уже существующий цикл ожидания строителей.
// Строительство/перемещение/снос/реконструкция/реновация — разовые живые действия, клетку выбирает
// пользователь кликом на реальной карте аккаунта, никуда не сохраняются.
//
// Игровые эндпоинты (POST /progress/, единый payload-массив) подтверждены реверсом бандла игры:
//   build:        [{type:'build',id,x,y}]      (уже используется modules/progress.js для upgrade)
//   move:         [{type:'move',x,y,to:{x,y}}]
//   demolish:     [{type:'destroy',id,x,y}]     — внутриигровой тип "destroy", не "demolish"
//   reconstruct:  [{type:'reconstruct',id,x,y}] — тратит предмет "component" (components_required шт.),
//                 сбрасывает здание на 1 уровень взамен на мастерпланы. Доступно при
//                 is_reconstructible && required_lvl!=null && level>=required_lvl (клиент игры,
//                 BuildingMenu: be = is_reconstructible && !isUnderConstruction && level>=required_lvl && enoughComponents)
//   renovate:     [{type:'renovate',id,x,y}]    — тратит предмет "masterplan" (masterplans_num шт.),
//                 эволюционирует здание в next_id (следующий звёздный тир). Доступно при
//                 is_renovatable && next_id!=null && required_lvl!=null && level>=required_lvl (клиент игры,
//                 BuildingMenu: pe = is_renovatable && next_id!==null && !isUnderConstruction && level>=required_lvl && enoughMasterplans)
// Наличие нужного количества component/masterplan НЕ проверяем на сервере бота — редактор карты
// фильтрует только структурную применимость (флаг + уровень), нехватку материалов вернёт сама игра.
module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  async function findAccountByName(name){
    const{Account}=require('../../db/index');
    const acc=await Account.findOne({where:{name}});
    if(!acc?.access_token)throw Object.assign(new Error('Аккаунт не найден'),{status:404});
    return acc;
  }

  // синхронизация снимка карты после разового действия — просто перечитать /progress/ и
  // сохранить, БЕЗ запуска цикла улучшений (это делает отдельный фоновый процесс)
  async function resyncSnapshot(api,name){
    try{
      const{CitySnapshot}=require('../../db/index');
      const prog=await api.get('/progress/');
      const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const unlockedSections=Array.isArray(prog?.progress?.unlocked_sections)?prog.progress.unlocked_sections:[];
      await CitySnapshot.upsert({account:name,buildings:JSON.stringify(buildings),unlocked_sections:JSON.stringify(unlockedSections),updated_at:new Date()},{conflictFields:['account']});
      cityLive.broadcast(name,buildings);
      return{buildings,unlockedSections};
    }catch(e){logger.warn(`[${name}] [city-strategy] resync: ${e.message}`);return null;}
  }

  // живые обновления построек (SSE) — без поллинга: подключается к cityLive.broadcast, который
  // уже вызывается на каждой записи CitySnapshot (фоновый цикл прокачки + ручные действия ниже).
  app.get('/api/city-strategy/:account/live-stream',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    cityLive.subscribe(req.params.account,res);
    req.on('close',()=>{cityLive.unsubscribe(req.params.account,res);});
  });

  // ручное обновление карты с живой игры (кнопка "Обновить" на странице карты города) — в отличие
  // от api.city() (читает кэш CitySnapshot из БД), реально дёргает /progress/ прямо сейчас
  app.post('/api/city-strategy/:account/refresh',async(req,res)=>{
    try{
      const result=await opRegistry.run(`cityRefresh:${req.params.account}`,async()=>{
        const acc=await findAccountByName(req.params.account);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        const result=await resyncSnapshot(api,acc.name);
        if(result===null)return{status:500,body:{ok:false,error:'Не удалось получить данные с игры'}};
        return{status:200,body:{ok:true,buildings:result.buildings,unlockedSections:result.unlockedSections}};
      });
      res.status(result.status).json(result.body);
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // запас компонентов/мастерпланов (вкладки "Реконструкция"/"Реновация") — ПОЛНОСТЬЮ из БД
  // (Inventory, синхронизируется modules/inventory.js раз в день), без единого живого запроса.
  // id=13 "Компонент" (тратится на реконструкцию), id=12 "Мастерплан" (тратится на реновацию,
  // выдаётся за реконструкцию) — см. config/items.json.
  app.get('/api/city-strategy/:account/resources',async(req,res)=>{
    try{
      const{Inventory}=require('../../db/index');
      const rows=await Inventory.findAll({where:{account:req.params.account,name:['12','13']}});
      const byName=Object.fromEntries(rows.map(r=>[r.name,Number(r.marketable||0)]));
      res.json({ok:true,components:byName['13']||0,masterplans:byName['12']||0});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // скидки/бонусы гильдии — сверено с бандлом игры (composable "benefits"):
  // buildingPurchaseDiscount = 1-(building_purchases_discount||0) — постройка, применяется ОТДЕЛЬНО
  // от скидки политик (Gc().buildCostMultiplier), обе перемножаются на итоговую цену;
  // upgradeDiscount = 1-(upgrades_discount||0) — улучшение, аналогично перемножается с
  // Gc().upgradeCostMultiplier (см. modules/progress.js loadPolicyEffects); income_boost — доход
  // города ×(1+income_boost), ПОСЛЕДНИЙ множитель по порядку (см. cityStats.js computeCityStats,
  // reference_game_formulas.md — строка "Бонус гильдии" на экране "Обзор доходов" в самой игре)
  app.get('/api/city-strategy/:account/guild-benefits',async(req,res)=>{
    try{
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const d=await api.get('/guilds/benefits');
      res.json({
        ok:true,
        building_purchases_discount:Number(d?.benefits?.building_purchases_discount||0),
        upgrades_discount:Number(d?.benefits?.upgrades_discount||0),
        income_boost:Number(d?.benefits?.income_boost||0),
      });
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // бонус "Разнообразие" (строка "Разнообразие +N%" на экране "Обзор доходов" в игре) — ПОЛНОСТЬЮ
  // из БД, без единого живого запроса: /progress/diversity уже опрашивается в modules/townhall.js
  // (страница "Ратуша" → "Разнообразие") на своём обычном цикле и складывается в TownhallDiversity —
  // income_bonus просто дополнительное поле того же снимка. income_bonus — сырое число (0.1 = +10%).
  app.get('/api/city-strategy/:account/diversity',async(req,res)=>{
    try{
      const{TownhallDiversity}=require('../../db/index');
      const row=await TownhallDiversity.findOne({where:{account:req.params.account}});
      res.json({ok:true,income_bonus:row?.income_bonus??0});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // критерии доступности построек — живой эндпоинт игры (GET /buildings/criteria, найден в бандле:
  // маршрут buildings.criteria в общей карте эндпоинтов), отдаёт настоящее условие покупки для
  // каждого здания (напр. нужное население) — вместо того чтобы угадывать пороги в своём статичном
  // config/buildings.txt. Форма ответа пока не проверена вживую (нет доступа к живому аккаунту в
  // этой среде) — логируем сырой JSON, чтобы свериться по логам бота, и отдаём как есть на клиент.
  app.get('/api/city-strategy/:account/build-criteria',async(req,res)=>{
    try{
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const d=await api.get('/buildings/criteria');
      logger.info(`[${acc.name}] [city-strategy] /buildings/criteria: ${JSON.stringify(d)}`);
      res.json({ok:true,criteria:d});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.get('/api/city-strategy/:account',async(req,res)=>{
    try{
      const{CityStrategy}=require('../../db/index');
      const row=await CityStrategy.findOne({where:{account:req.params.account}});
      let targets=[],queue=[],reconstructPlan=[];
      if(row?.targets){try{targets=JSON.parse(row.targets)||[];}catch(_){}}
      if(row?.queue){try{queue=JSON.parse(row.queue)||[];}catch(_){}}
      if(row?.reconstruct_plan){try{reconstructPlan=JSON.parse(row.reconstruct_plan)||[];}catch(_){}}
      res.json({ok:true,targets,queue,reconstructPlan});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ручная приоритетная очередь улучшений (вкладка "Улучшение") — разбирается строителями ПЕРЕД
  // личным планом (targets) и общим планом по семействам, см. modules/progress.js
  app.post('/api/city-strategy/:account/queue',async(req,res)=>{
    try{
      const{CityStrategy}=require('../../db/index');
      const queue=Array.isArray(req.body?.queue)?req.body.queue:[];
      const clean=queue
        .filter(q=>q&&q.x!=null&&q.y!=null)
        .map(q=>({x:Number(q.x),y:Number(q.y)}));
      await CityStrategy.upsert({account:req.params.account,queue:JSON.stringify(clean),updated_at:new Date()},{conflictFields:['account']});
      try{
        const acc=await findAccountByName(req.params.account);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await resyncSnapshot(api,req.params.account);
      }catch(_){}
      require('../../utils/cityWake').wake(req.params.account);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // запланированные реконструкции (вкладка "Реконструкция" → "Запланировать") — фоновый цикл
  // (modules/progress.js runPendingReconstructions) сам отправит реконструкцию, как только здание
  // достигнет required_lvl и не будет занято стройкой — пользователю не нужно возвращаться руками.
  app.post('/api/city-strategy/:account/reconstruct-plan',async(req,res)=>{
    try{
      const{CityStrategy}=require('../../db/index');
      const plan=Array.isArray(req.body?.plan)?req.body.plan:[];
      const clean=plan
        .filter(p=>p&&p.x!=null&&p.y!=null)
        .map(p=>({x:Number(p.x),y:Number(p.y)}));
      await CityStrategy.upsert({account:req.params.account,reconstruct_plan:JSON.stringify(clean),updated_at:new Date()},{conflictFields:['account']});
      require('../../utils/cityWake').wake(req.params.account);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Ускорители (вкладка "Ускорители") — ПОЛНОСТЬЮ из БД, без единого живого запроса. Время
  // окончания (booster_active_until) пишем САМИ при активации (см. web/routes/cityStrategy.js
  // POST .../activate и modules/boosterAutomation.js) — из end_time ответа игры на
  // POST /boosters/activate, поэтому знаем его точно без опроса /boosters/active. Если
  // active_until уже в прошлом — считаем тип неактивным, даже если старый счётчик
  // booster_currently_active в БД (обновляется раз в день синком инвентаря) ещё не в курсе.
  app.get('/api/city-strategy/:account/boosters',async(req,res)=>{
    try{
      const{Inventory,BoosterAutomation}=require('../../db/index');
      const fs=require('fs'),path=require('path');
      const itemsPath=path.join(process.cwd(),'config','items.json');
      const items=fs.existsSync(itemsPath)?JSON.parse(fs.readFileSync(itemsPath,'utf8')):{};
      const[rows,settings]=await Promise.all([
        Inventory.findAll({where:{account:req.params.account,type:'booster'}}),
        BoosterAutomation.findAll({where:{account:req.params.account}}),
      ]);
      const now=Date.now();
      const isStillActive=r=>r.booster_active_until&&new Date(r.booster_active_until).getTime()>now;
      let activeTypeName=null;
      for(const r of rows)if(isStillActive(r)){activeTypeName=r.name;break;}
      const autoMap=new Map(settings.map(s=>[s.booster_name,!!s.enabled]));
      const boosters=rows.map(r=>{
        const stillActive=isStillActive(r);
        return{
          name:r.name,
          label:items[r.name]?.name||r.name,
          available:r.marketable??0,
          active_limit:r.booster_active_limit??0,
          currently_active:stillActive?(r.booster_currently_active??0):0,
          ends_at:stillActive?new Date(r.booster_active_until).getTime():null,
          blocked_by_other:activeTypeName!=null&&activeTypeName!==r.name,
          auto:autoMap.get(r.name)??false,
        };
      });
      res.json({ok:true,boosters});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ручная сверка с игрой (кнопка "Проверить" на вкладке) — единственное место, где раздел вообще
  // делает живой GET /boosters/active: фоновый цикл (modules/boosterAutomation.js) его больше не
  // опрашивает на таймере, только эта кнопка — на случай если игрок активировал ускоритель
  // напрямую в игре, а не через бота, и БД про это ещё не знает.
  app.post('/api/city-strategy/:account/boosters/check',async(req,res)=>{
    try{
      await opRegistry.run(`boostersCheck:${req.params.account}`,async()=>{
        const acc=await findAccountByName(req.params.account);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        const{getEndsByType}=require('../../modules/boosterAutomation');
        const{Inventory}=require('../../db/index');
        const[endsByType,rows]=await Promise.all([
          getEndsByType(api),
          Inventory.findAll({where:{account:acc.name,type:'booster'}}),
        ]);
        for(const row of rows){
          const ends=endsByType.get(row.name)||[];
          await row.update({
            booster_currently_active:ends.length,
            booster_active_until:ends.length?new Date(Math.max(...ends)):null,
          });
        }
      });
      res.json({ok:true});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // автоактивация ("всегда держать активным") — фоновый цикл см. modules/boosterAutomation.js
  app.post('/api/city-strategy/:account/boosters/:name/auto',async(req,res)=>{
    try{
      const{BoosterAutomation}=require('../../db/index');
      const enabled=!!req.body?.enabled;
      await BoosterAutomation.upsert({account:req.params.account,booster_name:req.params.name,enabled:enabled?1:0,updated_at:new Date()},{conflictFields:['account','booster_name']});
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ручная активация — правило "currently_active<active_limit" сверено с бандлом игры
  // (chunks/storage1.js: кнопка "Активировать" задизейблена при обратном условии), сервер её тоже
  // применит сам, фронт лишь заранее отражает то же правило. После активации — resyncSnapshot
  // (активация меняет end у текущих строек НА СТОРОНЕ ИГРЫ, см. Ht().updateConstructionTimesForBooster()
  // в бандле), затем будим фоновый цикл улучшений, чтобы он пересчитал время следующего
  // пробуждения с учётом нового ускорения (иначе он проспал бы до старого, уже неактуального end).
  app.post('/api/city-strategy/:account/boosters/:name/activate',async(req,res)=>{
    try{
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const r=await api.post('/boosters/activate',{id:Number(req.params.name)});
      await resyncSnapshot(api,acc.name);
      // оптимистично отражаем расход и время окончания в БД сразу (не отдельный опрос — часть
      // самой активации, end_time — прямо из ответа игры); точные числа всё равно перезапишет
      // очередной суточный runInventory
      try{
        const{Inventory}=require('../../db/index');
        const row=await Inventory.findOne({where:{account:acc.name,name:req.params.name}});
        if(row){
          const nextActive=(row.booster_currently_active??0)+1;
          const endMs=r?.end_time?new Date(r.end_time).getTime():null;
          const prevUntil=row.booster_active_until?new Date(row.booster_active_until).getTime():0;
          await row.update({
            booster_currently_active:row.booster_active_limit!=null?Math.min(nextActive,row.booster_active_limit):nextActive,
            marketable:Math.max(0,(row.marketable??0)-1),
            booster_active_until:endMs?new Date(Math.max(endMs,prevUntil)):row.booster_active_until,
          });
        }
      }catch(_){}
      await logAction(acc.name,'booster_activate',{building_id:req.params.name});
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:true});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Лог действий по городу (вкладка "Лог") — запрос уже написан так, что без WHERE account он
  // станет общим логом всех аккаунтов разом (задел на будущее из плана).
  app.get('/api/city-strategy/:account/action-log',async(req,res)=>{
    try{
      const{CityActionLog}=require('../../db/index');
      const limit=Math.min(500,Math.max(1,Number(req.query.limit)||200));
      const rows=await CityActionLog.findAll({where:{account:req.params.account},order:[['created_at','DESC']],limit});
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Прогноз (вкладка "Прогноз") — единственный живой запрос всего раздела: нужны актуальные
  // end/level/coins/builders для честной симуляции, дальше — чистая функция simulateFutureActions
  // (modules/progress.js), переиспользующая ТУ ЖЕ логику выбора целей, что реальный бот.
  app.get('/api/city-strategy/:account/forecast',async(req,res)=>{
    try{
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const{buildingsMap:cityBuildingsMap,computeCityStats}=require('../cityStats');
      const{loadStrategy,loadGlobalPlan,loadGuildBonuses,loadPolicyEffects,loadConstructionBoostMods,simulateFutureActions}=require('../../modules/progress');
      const prog=await api.get('/progress/');
      const data=prog?.progress?.data||{};
      const current=Array.isArray(data.buildings)?data.buildings:[];
      const coins=data.coins||0;
      const buildingsMap=cityBuildingsMap();
      const[{discount,additionalBuilder,reducedUpgradeTimes},{builderBonus:policyBuilderBonus,upgradeCostMultiplier,constructionTimeMultiplier},{targets,queue},globalPlan,booster]=await Promise.all([
        loadGuildBonuses(api),loadPolicyEffects(api),loadStrategy(acc.name),loadGlobalPlan(),loadConstructionBoostMods(api,acc.name),
      ]);
      const builders=(prog?.progress?.builders||1)+additionalBuilder+policyBuilderBonus;
      const stats=computeCityStats(current,buildingsMap);
      const cityProfitPerHour=stats?.profit||0; // прибыль/час — та же величина, что везде в проекте
      // реальные бонусы на время улучшения — гильдийский (бонус от столицы) + политика +
      // активный ускоритель (с учётом автопродления, см. loadConstructionBoostMods) — точно как в игре
      const durationMods={reducedUpgradeTimes,constructionTimeMultiplier,booster};
      const events=simulateFutureActions(current,queue,targets,globalPlan,buildingsMap,discount,upgradeCostMultiplier,builders,coins,cityProfitPerHour,durationMods);
      res.json({ok:true,events});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  // общий (глобальный) план улучшений по семействам зданий (страница "Общий план улучшений") — не
  // привязан к аккаунту, читает modules/progress.js resolveEffectiveTargets
  app.get('/api/global-upgrade-plan',async(req,res)=>{
    try{
      const{GlobalUpgradePlan}=require('../../db/index');
      const rows=await GlobalUpgradePlan.findAll();
      res.json({ok:true,plan:rows.map(r=>({family_id:r.family_id,target_level:r.target_level}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/global-upgrade-plan',async(req,res)=>{
    try{
      const{GlobalUpgradePlan,Account}=require('../../db/index');
      const plan=Array.isArray(req.body?.plan)?req.body.plan:[];
      const clean=plan
        .filter(p=>p&&p.family_id&&Number(p.target_level)>0)
        .map(p=>({family_id:String(p.family_id),target_level:Math.floor(Number(p.target_level))}));
      await GlobalUpgradePlan.destroy({where:{}});
      if(clean.length)await GlobalUpgradePlan.bulkCreate(clean.map(p=>({...p,updated_at:new Date()})));
      // правило может коснуться любого города — будим все активные циклы апгрейда, а не один аккаунт
      try{
        const accounts=await Account.findAll();
        const{wake}=require('../../utils/cityWake');
        for(const a of accounts)wake(a.name);
      }catch(_){}
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/city-strategy/:account',async(req,res)=>{
    try{
      const{CityStrategy}=require('../../db/index');
      const targets=Array.isArray(req.body?.targets)?req.body.targets:[];
      const clean=targets
        .filter(t=>t&&t.x!=null&&t.y!=null&&Number(t.target_level)>0)
        .map(t=>({x:Number(t.x),y:Number(t.y),target_level:Math.floor(Number(t.target_level))}));
      await CityStrategy.upsert({account:req.params.account,targets:JSON.stringify(clean),updated_at:new Date()},{conflictFields:['account']});
      // сразу подтягиваем актуальную карту построек с живой игры — иначе таблица городов и карта
      // ещё какое-то время показывали бы старый снимок, дожидаясь планового цикла бота
      try{
        const acc=await findAccountByName(req.params.account);
        const api=await makeApiForAccount(acc.id,{noLock:true});
        await resyncSnapshot(api,req.params.account);
      }catch(_){}
      // будим фоновый цикл прокачки этого аккаунта, если он сейчас спит в ожидании (см.
      // index.js cityUpgradeLoop) — иначе новая цель могла бы ждать применения до 6ч
      require('../../utils/cityWake').wake(req.params.account);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Строительство: разово, клетку выбирает пользователь кликом на карте (позиция сама по себе
  // ни на что не влияет, см. cityStats.js — но раз есть полноценный редактор карты, пусть строит
  // где укажут, а не куда попало автоподбором).
  app.post('/api/city-actions/:account/build',async(req,res)=>{
    try{
      const{family_id,x,y}=req.body||{};
      if(!family_id)return res.status(400).json({ok:false,error:'family_id обязателен'});
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get('/progress/').catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      if(current.some(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y)))
        return res.status(400).json({ok:false,error:'Клетка уже занята'});
      const r=await api.post('/progress/',[{type:'build',id:family_id,x:Number(x),y:Number(y)}]);
      await resyncSnapshot(api,acc.name);
      if(r?.coins!==undefined)await logAction(acc.name,'build',{x:Number(x),y:Number(y),building_id:family_id});
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Перемещение: разово. Цель улучшения привязана к клетке (см. CityStrategy.targets) — если на
  // перемещаемой клетке была цель, переносим её координату вместе со зданием, иначе она стала бы
  // указывать в пустоту.
  app.post('/api/city-actions/:account/move',async(req,res)=>{
    try{
      const{from,to}=req.body||{};
      if(!from||!to)return res.status(400).json({ok:false,error:'from и to обязательны'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const r=await api.post('/progress/',[{type:'move',x:Number(from.x),y:Number(from.y),to:{x:Number(to.x),y:Number(to.y)}}]);
      await resyncSnapshot(api,acc.name);
      if(r?.coins!==undefined){
        try{
          const{CityStrategy}=require('../../db/index');
          const row=await CityStrategy.findOne({where:{account:acc.name}});
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
          if(row?.reconstruct_plan){
            const arr=JSON.parse(row.reconstruct_plan);
            if(Array.isArray(arr)){
              const p=arr.find(p=>Number(p.x)===Number(from.x)&&Number(p.y)===Number(from.y));
              if(p){p.x=Number(to.x);p.y=Number(to.y);patch.reconstruct_plan=JSON.stringify(arr);}
            }
          }
          if(Object.keys(patch).length){patch.updated_at=new Date();await row.update(patch);}
        }catch(e){logger.warn(`[${acc.name}] [city-strategy] перенос цели при перемещении: ${e.message}`);}
        await logAction(acc.name,'move',{x:Number(to.x),y:Number(to.y),from_x:Number(from.x),from_y:Number(from.y)});
      }
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Снос: разово (внутриигровой тип действия — "destroy"). id берём из живого состояния по
  // (x,y), а не у пользователя — снос всегда конкретного экземпляра, его id клиент игры тоже
  // читает из уже загруженного здания, не запрашивает отдельно.
  app.post('/api/city-actions/:account/demolish',async(req,res)=>{
    try{
      const{x,y}=req.body||{};
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get('/progress/').catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const target=current.find(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y));
      if(!target)return res.status(400).json({ok:false,error:'На этой клетке нет здания'});
      const r=await api.post('/progress/',[{type:'destroy',id:target.id,x:Number(x),y:Number(y)}]);
      await resyncSnapshot(api,acc.name);
      if(r?.coins!==undefined)await logAction(acc.name,'demolish',{x:Number(x),y:Number(y),building_id:target.id,level_from:Number(target.level||0)});
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Реконструкция: разово. Тратит "component", сбрасывает здание на 1 уровень, даёт мастерпланы.
  app.post('/api/city-actions/:account/reconstruct',async(req,res)=>{
    try{
      const{x,y}=req.body||{};
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get('/progress/').catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const target=current.find(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y));
      if(!target)return res.status(400).json({ok:false,error:'На этой клетке нет здания'});
      const r=await api.post('/progress/',[{type:'reconstruct',id:target.id,x:Number(x),y:Number(y)}]);
      await resyncSnapshot(api,acc.name);
      // если эта же клетка стояла в запланированных реконструкциях — она уже выполнена вручную,
      // убираем из плана, чтобы фоновый цикл не попытался повторить её ещё раз
      if(r?.coins!==undefined){
        await logAction(acc.name,'reconstruct',{x:Number(x),y:Number(y),building_id:target.id,level_from:Number(target.level||0)});
        try{
          const{CityStrategy}=require('../../db/index');
          const row=await CityStrategy.findOne({where:{account:acc.name}});
          if(row?.reconstruct_plan){
            const arr=JSON.parse(row.reconstruct_plan);
            if(Array.isArray(arr)){
              const filtered=arr.filter(p=>!(Number(p.x)===Number(x)&&Number(p.y)===Number(y)));
              if(filtered.length!==arr.length)await row.update({reconstruct_plan:JSON.stringify(filtered),updated_at:new Date()});
            }
          }
        }catch(_){}
      }
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Реновация: разово. Тратит "masterplan", эволюционирует здание в next_id.
  app.post('/api/city-actions/:account/renovate',async(req,res)=>{
    try{
      const{x,y}=req.body||{};
      if(x==null||y==null)return res.status(400).json({ok:false,error:'x и y обязательны'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const prog=await api.get('/progress/').catch(()=>null);
      const current=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
      const target=current.find(b=>Number(b.x)===Number(x)&&Number(b.y)===Number(y));
      if(!target)return res.status(400).json({ok:false,error:'На этой клетке нет здания'});
      const r=await api.post('/progress/',[{type:'renovate',id:target.id,x:Number(x),y:Number(y)}]);
      await resyncSnapshot(api,acc.name);
      if(r?.coins!==undefined)await logAction(acc.name,'renovate',{x:Number(x),y:Number(y),building_id:target.id,level_from:Number(target.level||0)});
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:r?.coins!==undefined});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  // ── Разблокировка закрытой секции карты: разово, ОТДЕЛЬНЫЙ игровой эндпоинт (НЕ общий /progress/
  // массив-экшенов, в отличие от всех действий выше) — сверено реверсом бандла игры 22.07.2026:
  // POST /progress/unlock-section {section_id}, ответ {success,unlocked_sections,coins_spent,
  // crystals_spent}. Список секций (id/координаты/adjacentSections/unlockCost) статический —
  // config/city_sections.json, отдаётся фронту через /api/sections (см. plans.js); список УЖЕ
  // разблокированных секций по аккаунту — CitySnapshot.unlocked_sections, само поле игра отдаёт
  // прямо в /progress/ (см. modules/progress.js), отдельного live-запроса на чтение не нужно.
  // Проверку "хватает ли денег"/"смежна ли с открытой зоной" бот НЕ делает — вернёт сама игра.
  app.post('/api/city-actions/:account/unlock-section',async(req,res)=>{
    try{
      const{section_id}=req.body||{};
      if(!section_id)return res.status(400).json({ok:false,error:'section_id обязателен'});
      const acc=await findAccountByName(req.params.account);
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const r=await api.post('/progress/unlock-section',{section_id});
      if(!r?.success)return res.status(400).json({ok:false,error:r?.message||'Не удалось разблокировать секцию'});
      await resyncSnapshot(api,acc.name);
      await logAction(acc.name,'unlock_section',{detail:JSON.stringify({section_id,coins_spent:r.coins_spent,crystals_spent:r.crystals_spent})});
      require('../../utils/cityWake').wake(acc.name);
      res.json({ok:true,unlockedSections:r.unlocked_sections});
    }catch(e){res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });
};
