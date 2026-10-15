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
//   POST /policies/reroll           {instance_id}  — «Провести реформу» за Камень реформ своей редкости
//                                    (15.10.2026, chunks/storage-*: ответ — новый инстанс политики)
//   POST /policies/mystery/craft    {rarity}
//   POST /policies/mystery/open     {rarity}
//   POST /policies/civic-draw/claim {}  (пустое тело)

const ACTION_ENDPOINTS={
  enact:'/policies/enact',
  unequip:'/policies/unequip',
  levelup:'/policies/levelup',
  promote:'/policies/promote',
  dissolve:'/policies/dissolve',
  reroll:'/policies/reroll',
  'mystery-craft':'/policies/mystery/craft',
  'mystery-open':'/policies/mystery/open',
  'civic-draw-claim':'/policies/civic-draw/claim',
};

// осколки политик/тайные политики хранятся в общей таблице Inventory (тот же /storage/allitemdata),
// но помечены типом — здесь их достаём для страницы "Политики" вместо страницы "Предметы"
const SHARD_ITEM_TYPES=new Set(['policy_shard','mystery_policy']);
// Камни реформ (id 36-38, тип consumable) — расходник политик: с 15.10.2026 показываются только
// на странице "Политики" своей линией, со страницы "Предметы" убраны (см. routes/core.js)
const REFORM_STONE_IDS=['36','37','38'];

// Осколки политик — обычные складские предметы, id идут подряд по редкости (config/items.json:
// 16 shard_common … 22 shard_eternal). Нужны, чтобы сверить наличие с ценой повышения.
const SHARD_RARITY_ORDER=['common','uncommon','rare','epic','legendary','mythic','eternal'];
const SHARD_ITEM_ID_BASE=16;
const shardItemIdFor=rarity=>{
  const i=SHARD_RARITY_ORDER.indexOf(String(rarity||''));
  return i===-1?null:SHARD_ITEM_ID_BASE+i;
};

// ПРАВИЛА ПОВЫШЕНИЯ — целиком из ответа игры, ничего не выводим сами (сверено на живых данных
// 07.08.2026, поля инстанса /policies/):
//   next_level_shards  — сколько осколков СВОЕЙ редкости нужно на следующий уровень
//   next_level_tenure  — сколько дней стажа нужно (null = уровень максимальный)
//   tenure_points      — накопленный стаж НА МОМЕНТ СНИМКА
//   promotion:{shard_cost,target_rarity,tenure_carry} — повышение редкости
//   max_level          — потолок уровня
// Стаж идёт, пока политика НАДЕТА (enacted_slot!=null), и ПЕРЕНОСИТСЯ при переодевании: на живых
// данных встретилась политика со стажем 15 при 4.9 днях с последнего enacted_at — поэтому считать
// от enacted_at нельзя, только «tenure_points из снимка + прошедшие с него полные дни».
function policyProgress(inst,snapshotAt,shardQtyByItemId){
  const rarity=String(inst?.rarity||'');
  const shardId=shardItemIdFor(rarity);
  const haveShards=shardId==null?0:(shardQtyByItemId.get(shardId)||0);
  const enacted=inst?.enacted_slot!=null;
  const sinceDays=snapshotAt?Math.max(0,Math.floor((Date.now()-new Date(snapshotAt).getTime())/86400000)):0;
  const tenureNow=Number(inst?.tenure_points||0)+(enacted?sinceDays:0);

  const needShards=inst?.next_level_shards==null?null:Number(inst.next_level_shards);
  const needTenure=inst?.next_level_tenure==null?null:Number(inst.next_level_tenure);
  const atMaxLevel=inst?.max_level!=null&&Number(inst.level||0)>=Number(inst.max_level);
  const levelBlockers=[];
  if(atMaxLevel||needTenure==null)levelBlockers.push('максимальный уровень');
  else{
    if(tenureNow<needTenure)levelBlockers.push(`стаж ${tenureNow}/${needTenure} дн.`);
    if(needShards!=null&&haveShards<needShards)levelBlockers.push(`осколков ${haveShards}/${needShards}`);
  }

  const promoCost=inst?.promotion?.shard_cost==null?null:Number(inst.promotion.shard_cost);
  const promoBlockers=[];
  if(promoCost==null)promoBlockers.push('повышение редкости недоступно'); // игра не прислала promotion — либо потолок редкости, либо условие не выполнено
  else{
    // Редкость повышается только с МАКСИМАЛЬНОГО уровня текущей редкости. Игра присылает
    // promotion.shard_cost и на первом уровне, поэтому кнопка была активна на «Ур. 1/5» и
    // упиралась бы в отказ игры (замечено 13.08).
    if(!atMaxLevel)promoBlockers.push(`нужен максимальный уровень (${Number(inst?.level||0)}/${inst?.max_level??'?'})`);
    if(haveShards<promoCost)promoBlockers.push(`осколков ${haveShards}/${promoCost}`);
  }

  return{
    shard_item_id:shardId,
    have_shards:haveShards,
    tenure_now:tenureNow,
    tenure_needed:needTenure,
    level_shards_needed:needShards,
    can_level_up:levelBlockers.length===0,
    level_blockers:levelBlockers,
    promote_shards_needed:promoCost,
    promote_target_rarity:inst?.promotion?.target_rarity??null,
    can_promote:promoBlockers.length===0,
    promote_blockers:promoBlockers,
  };
}

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
        where:{account:{[Op.in]:accNames.length?accNames:['__none__']},
          [Op.or]:[{type:{[Op.in]:[...SHARD_ITEM_TYPES]}},{name:{[Op.in]:REFORM_STONE_IDS}}]},
        order:[['account','ASC'],['name','ASC']],
      });

      const byAccount={};
      for(const a of accs){
        const pop=parseFloat(a.population_final);
        byAccount[a.name]={list:[],library:{discovered:0,total:0,sections:[]},cabinet:{slots:[],civic_draw:null},economy:null,shards:[],reform_stones:[],updated_at:null,
          population:isFinite(pop)?pop:null,policies_unlocked:isFinite(pop)&&pop>=POLICIES_UNLOCK_POPULATION};
      }

      for(const s of snaps){
        if(!byAccount[s.account])continue;
        // _listed_at — карта выставлена на рынок и физически лежит не в хранилище, а в лоте
        // (пометку ставит web/routes/market.js при создании лота и снимает при отмене, без
        // обращения к игре). В хранилище такие карты не показываем — как их там и нет.
        try{byAccount[s.account].list=JSON.parse(s.list||'[]').filter(p=>!p._listed_at);}catch(_){}
        try{byAccount[s.account].library=JSON.parse(s.library||'{}');}catch(_){}
        try{byAccount[s.account].cabinet=JSON.parse(s.cabinet||'{}');}catch(_){}
        try{byAccount[s.account].economy=JSON.parse(s.economy||'null');}catch(_){}
        byAccount[s.account].updated_at=s.updated_at;
      }
      for(const r of shardRows){
        if(!byAccount[r.account])continue;
        const isStone=REFORM_STONE_IDS.includes(String(r.name));
        byAccount[r.account][isStone?'reform_stones':'shards'].push({
          id:r.name,type:r.type,
          marketable:Number(r.marketable||0),locked:Number(r.locked||0),
          qty:Number(r.marketable||0)+Number(r.locked||0),
        });
      }
      // Готовность к повышению считаем ЗДЕСЬ, а не на фронте: правила приходят от игры в самом
      // инстансе, а наличие осколков лежит в Inventory — оба источника серверные, тащить их в
      // браузер и сводить там значило бы дублировать логику в двух местах.
      for(const [name,acc] of Object.entries(byAccount)){
        const shardQty=new Map();
        for(const sh of acc.shards)shardQty.set(Number(sh.id),Number(sh.qty||0));
        // свободный слот кабинета: разблокирован по населению и пуст
        const slots=Array.isArray(acc.cabinet?.slots)?acc.cabinet.slots:[];
        acc.free_slots=slots.filter(sl=>sl?.unlocked&&!sl?.instance).length;
        acc.total_slots=slots.length;
        acc.list=acc.list.map(inst=>({...inst,progress:policyProgress(inst,acc.updated_at,shardQty)}));
        void name;
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
      const{action,instance_id,rarity,count}=req.body||{};
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
        case 'unequip':case 'levelup':case 'promote':case 'dissolve':case 'reroll':
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
      let result;
      if(action==='mystery-open'&&Number(count)>1){
        // 15.10.2026: открыть несколько тайных политик подряд. Игра открывает по одной на запрос
        // (chunks/storage-*: POST /policies/mystery/open {rarity} → {instance}), поэтому шлём N
        // запросов последовательно и останавливаемся на первой ошибке. Мутация — без повторов.
        const n=Math.min(Math.floor(Number(count)),100);
        const opened=[];
        let stopError=null;
        for(let i=0;i<n;i++){
          try{const r=await api.post(endpoint,body);opened.push(r?.instance??r);}
          catch(e){stopError=e?.message||String(e);break;}
          if(i<n-1)await new Promise(r=>setTimeout(r,300));
        }
        if(!opened.length)throw new Error(stopError||'Не удалось открыть');
        result={opened,requested:n,error:stopError};
      }else{
        result=await api.post(endpoint,body);
      }
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
    }catch(e){
      // РЕСИНК И ПРИ ОТКАЗЕ. Игра отклоняет действие в т.ч. когда наши цифры устарели: уровень
      // политики и запас осколков меняются и при действиях ПРЯМО В ИГРЕ, мимо панели, а Inventory/
      // PolicySnapshot пишутся только нашими проходами. Живой случай 07.08: в БД политика 1/5 и
      // 64 обычных осколка, в игре она уже 5/5 и осколков меньше — кнопка «Улучшить редкость»
      // выглядела доступной, а игра ответила 400 «Недостаточно осколков». Без ресинка страница
      // осталась бы с теми же неверными числами и кнопка звала бы жать снова.
      try{
        const{Account}=require('../../db/index');
        const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
        if(acc){
          const api=await makeApiForAccount(acc.id,{noLock:true});
          await require('../../modules/policies').runPolicies(api,acc.name).catch(()=>{});
          await require('../../modules/inventory').runInventory(api,acc.name).catch(()=>{});
        }
      }catch(_){}
      res.status(500).json({ok:false,error:e.message,resynced:true});
    }
  });
};

// экспорт для проверок/тестов — на регистрацию роутов не влияет
module.exports.policyProgress=policyProgress;
