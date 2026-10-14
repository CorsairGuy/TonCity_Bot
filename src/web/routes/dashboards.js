'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

module.exports=function(app,ctx){
  const{apiForAcc,makeApiForAccount,midErr}=ctx;

  app.get('/api/shop',async(req,res)=>{
    try{
      const{ShopSnapshot}=require('../../db/index');
      const rows=await ShopSnapshot.findAll({order:[['account','ASC']]});
      const map=new Map();
      for(const r of rows){
        if(!map.has(r.account))map.set(r.account,{});
        try{map.get(r.account)[r.type]=JSON.parse(r.data);}catch(_){}
        map.get(r.account).updated_at=r.updated_at;
      }
      const accounts=[...map.entries()].map(([name,d])=>({name,...d}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/townhall',async(req,res)=>{
    try{
      const{TownhallAirdrop,TownhallDiversity}=require('../../db/index');
      const [airRows,divRows]=await Promise.all([
        TownhallAirdrop.findAll({order:[['account','ASC']]}),
        TownhallDiversity.findAll({order:[['account','ASC']]}),
      ]);
      const airMap=new Map(airRows.map(r=>[r.account,{city:r.city,activity:r.activity,friends:r.friends,transactions:r.transactions,achievements:r.achievements,percentile:r.percentile,updated_at:r.updated_at}]));
      const divMap=new Map(divRows.map(r=>[r.account,{score:r.score,variety_score:r.variety_score,profit_score:r.profit_score,unique_types:r.unique_types,total_buildings:r.total_buildings,income_bonus:r.income_bonus,updated_at:r.updated_at}]));
      const names=[...new Set([...airMap.keys(),...divMap.keys()])].sort();
      const accounts=names.map(name=>({name,airdrop:airMap.get(name)||null,diversity:divMap.get(name)||null}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/daily-log',async(req,res)=>{
    try{
      const{DailyLog}=require('../../db/index');
      const rows=await DailyLog.findAll({order:[['account','ASC'],['logged_at','DESC']]});
      // группируем по аккаунту
      const map=new Map();
      for(const r of rows){
        if(!map.has(r.account))map.set(r.account,[]);
        map.get(r.account).push({logged_at:r.logged_at,day:r.day,reward:r.reward?JSON.parse(r.reward):null});
      }
      const accounts=[...map.entries()].map(([name,entries])=>({name,entries}));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Весь 28-дневный график наград (карточки на странице "Ежедневная награда") — чисто из БД,
  // никаких живых запросов: снимок (DailyRewardSnapshot.rewards) пишет суточный цикл бота и кнопка
  // "Обновить" (см. modules/tasks.js saveRewardSnapshot), а он и так уже ходит в игру каждый день.
  // Правило на день: если есть НАША запись о реальном вручении (DailyLog.day совпал) — показываем
  // её (факт); иначе — calculated_reward из снимка (посчитан игрой под ТЕКУЩИЕ показатели — для
  // ещё не наступивших дней это и есть то, что реально придёт, для прошлых без нашей записи —
  // лучшая доступная оценка, если забирали руками в игре).
  app.get('/api/daily',async(req,res)=>{
    try{
      const{Account,DailyRewardSnapshot,DailyLog}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const[snaps,logs]=await Promise.all([
        DailyRewardSnapshot.findAll({where:{account:accs.map(a=>a.name)}}),
        DailyLog.findAll({where:{account:accs.map(a=>a.name)},order:[['logged_at','DESC']]}),
      ]);
      const snapByAcc=new Map(snaps.map(s=>[s.account,s]));
      const logsByAcc=new Map();
      for(const l of logs){
        if(!logsByAcc.has(l.account))logsByAcc.set(l.account,new Map());
        const byDay=logsByAcc.get(l.account);
        if(l.day!=null&&!byDay.has(l.day))byDay.set(l.day,l); // DESC по дате — первое вхождение самое свежее
      }
      const today=new Date().toISOString().slice(0,10);
      const accounts=accs.map(acc=>{
        const snap=snapByAcc.get(acc.name);
        const rewards=snap?.rewards?JSON.parse(snap.rewards):[];
        const streak=snap?.streak??null;
        // last_login — полный ISO-таймстамп (2026-10-13T05:42:...Z), сравниваем только дату —
        // раньше сравнивалось с голой датой и НИКОГДА не совпадало, подсветка "сегодня" съезжала
        // на день вперёд (считала, что сегодняшний вход ещё не забран, хотя он уже был)
        const claimedToday=snap?.last_login?.slice(0,10)===today;
        const todayCycleDay=streak==null?null:(claimedToday?((streak-1)%28)+1:(streak%28)+1);
        const byDay=logsByAcc.get(acc.name)||new Map();
        const days=rewards.map(r=>{
          const actualRow=byDay.get(r.streak_day);
          const actual=actualRow?.reward?JSON.parse(actualRow.reward):null;
          const isPast=todayCycleDay!=null&&(r.streak_day<todayCycleDay||(r.streak_day===todayCycleDay&&claimedToday));
          const base=actual??{type:r.reward_type,amount:r.calculated_reward,item_id:r.item_id??null};
          return{
            day:r.streak_day,
            reward_type:base.type??r.reward_type,
            amount:base.amount??r.calculated_reward,
            item_id:base.item_id??r.item_id??null,
            source:actual?'actual':(isPast?'estimated':'upcoming'),
            is_today:todayCycleDay!=null&&r.streak_day===todayCycleDay,
          };
        });
        return{name:acc.name,streak,last_login:snap?.last_login??null,updated_at:snap?.updated_at??null,days};
      });
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ВАЖНО: идём от ТЕКУЩЕГО списка аккаунтов (Account.findAll), а НЕ от таблицы снимков напрямую —
  // раньше запрос брал JourneyLevel как есть, и после удаления аккаунта его старые строки в
  // journey_log никуда не девались и продолжали показываться на странице "Путь мэра" вечно (тот же
  // паттерн уже был правильно сделан в /api/loyalty-road, см. web/routes/economy.js).
  app.get('/api/journey',async(req,res)=>{
    try{
      const{Account,JourneyLevel}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const accounts=await Promise.all(accs.map(async a=>{
        const rows=await JourneyLevel.findAll({where:{account:a.name},order:[['level','ASC']]});
        return{name:a.name,levels:rows.map(r=>({level:r.level,claimed:!!r.claimed,condition_met:!!r.condition_met,updated_at:r.updated_at}))};
      }));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/achievements',async(req,res)=>{
    try{
      const{AchievementSnapshot}=require('../../db/index');
      const rows=await AchievementSnapshot.findAll({order:[['account','ASC'],['achievement_id','ASC']]});
      const map=new Map();
      for(const r of rows){
        if(!map.has(r.achievement_id))map.set(r.achievement_id,{id:r.achievement_id,accounts:[]});
        map.get(r.achievement_id).accounts.push({name:r.account,progress:r.progress,tiers:r.tiers?JSON.parse(r.tiers):[],secret:!!r.secret,updated_at:r.updated_at});
      }
      res.json({ok:true,achievements:[...map.values()]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/promo-log',async(req,res)=>{
    try{
      const{Account,PromoLog}=require('../../db/index');
      const[accs,rows]=await Promise.all([
        Account.findAll({order:[['id','ASC']]}),
        PromoLog.findAll({order:[['used_at','DESC']]}),
      ]);
      const map=new Map(accs.map(a=>[a.name,{id:a.id,name:a.name,entries:[]}]));
      for(const r of rows){
        if(!map.has(r.account))map.set(r.account,{id:null,name:r.account,entries:[]});
        map.get(r.account).entries.push({code:r.code,success:!!r.success,reward:r.reward?JSON.parse(r.reward):null,used_at:r.used_at});
      }
      res.json({ok:true,accounts:[...map.values()]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/promo/activate',async(req,res)=>{
    try{
      const{account_id,code}=req.body||{};
      if(!account_id||!code)return res.status(400).json({ok:false,error:'account_id и code обязательны'});
      const{Account,PromoLog}=require('../../db/index');
      const acc=await Account.findByPk(account_id);
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const ApiClient=require('../../api/client');
      const api=apiForAcc(acc);
      const r=await api.post('/promocodes/activate',{code:code.trim()});
      const success=!!(r?.success||r?.activated);
      const reward=r?.reward||r?.prize||null;
      await PromoLog.upsert({account:acc.name,code:code.trim(),success,reward:reward?JSON.stringify(reward):null,used_at:new Date()},{conflictFields:['account','code']});
      res.json({ok:true,success,reward});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/promo/activate-all',async(req,res)=>{
    try{
      const{code}=req.body||{};
      if(!code)return res.status(400).json({ok:false,error:'code обязателен'});
      const{Account,PromoLog}=require('../../db/index');
      const ApiClient=require('../../api/client');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const results=[];
      for(const acc of accs){
        if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
        try{
          const api=apiForAcc(acc);
          const r=await api.post('/promocodes/activate',{code:code.trim()});
          const success=!!(r?.success||r?.activated);
          const reward=r?.reward||r?.prize||null;
          await PromoLog.upsert({account:acc.name,code:code.trim(),success,reward:reward?JSON.stringify(reward):null,used_at:new Date()},{conflictFields:['account','code']});
          results.push({name:acc.name,ok:true,success,reward});
        }catch(e){results.push({name:acc.name,ok:false,error:midErr(e)});}
      }
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/guilds',async(req,res)=>{
    try{
      const{GuildSnapshot,Account}=require('../../db/index');
      const rows=await GuildSnapshot.findAll({order:[['account','ASC']]});
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      res.json({ok:true,rows:rows.map(r=>({account:r.account,account_id:accIdByName[r.account]??null,guild_id:r.guild_id,guild_title:r.guild_title,role:r.role,benefits:r.benefits?JSON.parse(r.benefits):null,updated_at:r.updated_at}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Обогащение квеста данными для кнопок (общее для списка и для ответов на действия) ─────────
  // Держим ОДНОЙ функцией: ответ на действие тоже отдаёт свежий квест, и если бы он обогащался
  // отдельным кодом, строка после действия теряла бы «есть N»/стоимость буста и они бы разъехались.
  const itemCache=require('../../utils/itemCache');
  // Слоты ускорителей. У типа их может быть несколько (напр. 4 у эпических) и освобождаются они ПО
  // ОДНОМУ, по мере истечения каждого инстанса — ждать окончания всех не нужно. Считаем по РЕАЛЬНОМУ
  // списку активных из снимка игры (itemCache.active_boosters, пишет фоновый runInventory и
  // дописывает сама активация), а не по одному Inventory-полю booster_active_until, где лежит лишь
  // МАКСИМАЛЬНОЕ время окончания. {until,used,limit}: until — когда освободится ближайший слот.
  function slotInfoFor(accId,rows2,itemId){
    const now=Date.now();
    const limit=rows2.find(r=>String(r.name)===String(itemId))?.booster_active_limit??null;
    const cached=(accId!=null?itemCache.get(accId)?.active_boosters:null);
    if(!Array.isArray(cached)){
      // кэша ещё нет (бот только стартовал) — грубый фолбэк, чтобы не показать «свободно», когда занято
      const stillActive=r=>r.booster_active_until&&new Date(r.booster_active_until).getTime()>now;
      const other=rows2.find(r=>stillActive(r)&&String(r.name)!==String(itemId));
      if(other)return{until:other.booster_active_until,used:null,limit};
      const own=rows2.find(r=>String(r.name)===String(itemId));
      if(own&&stillActive(own)&&(own.booster_currently_active??0)>=(own.booster_active_limit??0))return{until:own.booster_active_until,used:own.booster_currently_active??null,limit};
      return{until:null,used:null,limit};
    }
    const alive=cached.filter(b=>b?.end_time&&new Date(b.end_time).getTime()>now);
    // правило игры: пока активен ЛЮБОЙ другой тип — этот активировать нельзя вообще
    const others=alive.filter(b=>String(b.item_id)!==String(itemId));
    if(others.length)return{until:new Date(Math.max(...others.map(b=>new Date(b.end_time).getTime()))).toISOString(),used:0,limit};
    const mine=alive.filter(b=>String(b.item_id)===String(itemId));
    if(limit==null||mine.length<limit)return{until:null,used:mine.length,limit};
    const firstFree=Math.min(...mine.map(b=>new Date(b.end_time).getTime())); // ближайший слот
    return{until:new Date(firstFree).toISOString(),used:mine.length,limit};
  }
  function enrichQuest(q,{rows2,accId,crystals}){
    const{rarityToId}=require('../../modules/boosterAutomation');
    const{extractRarity}=require('../../modules/questAutomation');
    if(q.type==='guild_boost'){
      return{...q,
        boost_cost_personal:boostCrystalsFor(q,'personal'),
        boost_cost_guild:boostCrystalsFor(q,'guild'),
        account_crystals:crystals??null,
      };
    }
    if(q.type!=='booster_activate'&&q.type!=='booster_combine')return q;
    const rarity=extractRarity(q.description?.ru||q.description?.en);
    if(!rarity)return q;
    const itemId=rarityToId().get(rarity);
    const owned=new Map((rows2||[]).map(r=>[String(r.name),Number(r.marketable)||0]));
    const have=itemId==null?null:(owned.get(String(itemId))||0);
    const rules=(accId!=null?itemCache.get(accId)?.combination_rules:null)||[];
    // для комбинирования нужно required_amount штук за одну конверсию, для активации — 1
    const rule=q.type==='booster_combine'?rules.find(x=>x?.from_rarity===rarity):null;
    const need=q.type==='booster_combine'?(rule?.required_amount!=null?Number(rule.required_amount):null):1;
    // слоты — только про активацию; комбинированию активный ускоритель не мешает
    const slot=(q.type==='booster_activate'&&itemId!=null)?slotInfoFor(accId,rows2||[],itemId):null;
    return{...q,booster_rarity:rarity,booster_owned:have,booster_needed:need,
      booster_blocked_until:slot?.until??null,
      booster_slots_used:slot?.used??null,booster_slots_limit:slot?.limit??null};
  }
  // обогащение ОДНОГО квеста по имени аккаунта — для ответов на действия
  async function enrichQuestFor(accountName,q){
    if(!q)return q;
    try{
      const{Account,Inventory}=require('../../db/index');
      const acc=await Account.findOne({where:{name:accountName},attributes:['id','crystals']});
      const rows2=await Inventory.findAll({where:{account:accountName,type:'booster'},attributes:['name','marketable','booster_active_until','booster_currently_active','booster_active_limit']});
      return enrichQuest(q,{rows2,accId:acc?.id??null,crystals:acc?Number(acc.crystals)||0:null});
    }catch(_){return q;}
  }

  // гильдейские квесты: читаем из БД. Пишет modules/capital.js runCapital (теперь раз в день у
  // КАЖДОГО аккаунта, не только у лидеров — см. bot.js) и runQuestLoop (непрерывно у лидера).
  // Своя строка на (guild_id,account) — если в одной гильдии несколько СВОИХ аккаунтов, у каждого
  // своё личное (personal_progress), поэтому один "guild" в ответе теперь может встретиться
  // несколько раз, по разу на аккаунт.
  app.get('/api/guild-quests',async(req,res)=>{
    try{
      const{GuildQuestSnapshot,Account,Inventory}=require('../../db/index');
      const rows=await GuildQuestSnapshot.findAll({order:[['guild_title','ASC'],['account','ASC']]});
      const accs=await Account.findAll({attributes:['id','name','crystals']});
      const idByName=new Map(accs.map(a=>[a.name,a.id]));
      const invRows=await Inventory.findAll({where:{type:'booster'},attributes:['account','name','marketable','booster_active_until','booster_currently_active','booster_active_limit']});
      const invByAcc=new Map();
      for(const r of invRows){
        if(!invByAcc.has(r.account))invByAcc.set(r.account,[]);
        invByAcc.get(r.account).push(r);
      }
      const crystalsByName=new Map(accs.map(a=>[a.name,Number(a.crystals)||0]));
      const enrich=(quests,account)=>quests.map(q=>enrichQuest(q,{
        rows2:invByAcc.get(account)||[],accId:idByName.get(account),crystals:crystalsByName.get(account)??null,
      }));
      const guilds=rows
        // только гильдии, где есть ДЕЙСТВУЮЩИЙ аккаунт: снимок живёт своей жизнью и после удаления
        // аккаунта его строка осталась бы висеть навсегда (кнопки в ней всё равно не работают —
        // account_id null). Физически такие строки подчищает POST /api/guild-quests/refresh.
        .filter(r=>idByName.has(r.account))
        .map(r=>{
          const quests=r.quests?JSON.parse(r.quests):[];
          return{
            guild_id:r.guild_id,
            guild_title:r.guild_title,
            account:r.account,
            account_id:idByName.get(r.account)??null,
            quests:enrich(quests,r.account),
            updated_at:r.updated_at,
          };
        });
      res.json({ok:true,guilds});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Бусты гильдии (квест guild_boost) ─────────────────────────────────────────
  // Реверс бандла 31.07.2026 (chunks/_id_-*.js, компонент BoostsCard):
  //   POST /guilds/boosts/invoice {amount}  → {success:true}; amount В АЛМАЗАХ
  //   GET  /guilds/boosts/positions         → [{guild_id,boosts,position,population}]
  // Шаг покупки в UI игры — ±10 алмазов, минимум 10; 1 буст = 10 алмазов (подпись количества
  // бустов считается как floor(totalBoostAmount/10)). Бусты живут 3 дня.
  const BOOST_STEP=10;
  // Сколько алмазов нужно, чтобы дотянуть условие квеста. ЕДИНИЦА ИЗМЕРЕНИЯ ПОРОГА берётся из
  // ТЕКСТА квеста, а не угадывается: у этой игры бывают и «потратьте N алмазов», и «сделайте N
  // бустов» — при ошибке в 10 раз разошёлся бы списываемый баланс. Если в тексте явно алмазы —
  // порог уже в алмазах; если бусты — умножаем на 10. Округляем ВВЕРХ до кратного 10 (иначе игра
  // не примет) — но никогда не берём больше, чем реально осталось до порога, с точностью до шага.
  function boostCrystalsFor(q,scope){
    const done=scope==='guild'?(q.guild_progress||0):(q.personal_progress||0);
    const need=scope==='guild'?(q.guild_threshold||0):(q.personal_threshold||0);
    const left=need-done;
    if(!(left>0))return 0;
    const text=`${q.description?.ru||''} ${q.description?.en||''}`.toLowerCase();
    const inCrystals=/алмаз|кристал|crystal|💎/.test(text);
    const inBoosts=/буст|boost/.test(text);
    // приоритет у явного упоминания алмазов; «бусты» → ×10; ничего не распознали → null (кнопку
    // не включаем, чтобы не списать неизвестно сколько — см. фронт)
    const crystals=inCrystals?left:(inBoosts?left*BOOST_STEP:null);
    if(crystals==null)return null;
    return Math.ceil(crystals/BOOST_STEP)*BOOST_STEP;
  }

  // Покупка бустов под квест. Одно нажатие закрывает ОДНО условие целиком: пока не выполнено
  // личное — добираем личное, дальше тем же нажатием добираем общее (просьба пользователя).
  app.post('/api/guild-quests/:accountId/guild-boost',async(req,res)=>{
    const{quest_id}=req.body||{};
    if(quest_id==null)return res.status(400).json({ok:false,error:'quest_id обязателен'});
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name','crystals']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    try{
      const g=await api.get('/users/me/guild').catch(()=>null);
      const guildId=String(g?.guild?.id||'');
      if(!guildId)return res.status(400).json({ok:false,error:'Аккаунт не в гильдии'});
      const qData=await api.get(`/guild-quests/guild/${guildId}`);
      const q=(qData?.quests||[]).find(x=>String(x.id)===String(quest_id));
      if(!q)return res.status(404).json({ok:false,error:'Квест не найден'});
      if(q.type!=='guild_boost')return res.status(400).json({ok:false,error:'Квест не про бусты гильдии'});
      // Оба условия уже выполнены (частый случай: общее ПЕРЕВЫПОЛНЕНО гильдией, личное закрыл наш
      // же предыдущий клик) — покупать нечего, надо ЗАБРАТЬ НАГРАДУ. Раньше здесь возвращалась
      // ошибка «Оба условия уже выполнены», из-за чего фронт не получал свежий квест и кнопка
      // заклейма не появлялась вовсе.
      const bothDone=(q.personal_progress||0)>=(q.personal_threshold||0)&&(q.guild_progress||0)>=(q.guild_threshold||0);
      if(bothDone&&!q.is_collected){
        const fin=await finishQuestAction(api,acc.name,quest_id,(q.personal_progress||0)-1);
        return res.json({ok:true,spent:0,scope:null,quest:await enrichQuestFor(acc.name,fin.quest),collected:fin.collected});
      }
      // сначала личное условие, когда оно закрыто — общее
      const scope=(q.personal_progress||0)<(q.personal_threshold||0)?'personal':'guild';
      const amount=boostCrystalsFor(q,scope);
      if(amount==null)return res.status(400).json({ok:false,error:'Не удалось понять из текста квеста, в чём измеряется условие (алмазы или бусты) — покупка отменена',quest:await enrichQuestFor(acc.name,q)});
      if(amount<=0)return res.status(400).json({ok:false,error:'Условие уже закрыто, покупать нечего',quest:await enrichQuestFor(acc.name,q)});
      // баланс берём живой из ответа игры (в БД он мог устареть), но и БД-значение проверяем
      const crystals=Number(acc.crystals)||0;
      if(crystals<amount)return res.status(400).json({ok:false,error:`Не хватает алмазов: нужно ${amount}, есть ${crystals}`,quest:await enrichQuestFor(acc.name,q)});
      const r=await api.post('/guilds/boosts/invoice',{amount});
      if(r&&r.success===false)return res.status(409).json({ok:false,error:'Игра отклонила покупку буста',quest:await enrichQuestFor(acc.name,q)});
      // игра не возвращает новый баланс — списываем ровно на потраченное, как это делает клиент игры
      await acc.update({crystals:Math.max(0,crystals-amount)}).catch(()=>{});
      logger.info(`[${acc.name}] [quest] куплено бустов гильдии на ${amount} алмазов (условие: ${scope}, ответ игры: ${JSON.stringify(r)})`);
      const fin=await finishQuestAction(api,acc.name,quest_id,q.personal_progress||0);
      res.json({ok:true,spent:amount,scope,quest:await enrichQuestFor(acc.name,fin.quest),collected:fin.collected});
    }catch(e){
      await resyncGuildQuests(api,acc.name);
      res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});
    }
  });

  // SSE-поток идущих автозаклеймов (см. web/lib/questClaimProgress.js): страница «Квесты» слушает
  // его, чтобы кнопка «Заклеймить» показывала «забираем…», когда награду уже забирает автоматика
  // (после активации/комбинирования или фоновый цикл), и её не нужно было жать руками.
  app.get('/api/guild-quests/claim-stream',(req,res)=>{
    require('../lib/questClaimProgress').subscribe(res);
  });

  // Кнопка "Обновить" на странице "Квесты" — тянет квесты ЖИВЬЁМ по всем аккаунтам с токеном
  // (раньше кнопка перечитывала только снимок из БД, т.е. по сути ничего не обновляла, а свежесть
  // зависела от фонового цикла — просьба пользователя 31.07.2026). Заодно чистит осиротевшие
  // строки снимка: аккаунты, которых уже нет в списке актуальных, иначе на странице вечно висят
  // гильдии «с мусором», куда бот больше не заходит.
  app.post('/api/guild-quests/refresh',async(req,res)=>{
    try{
      const results=await opRegistry.run('guildQuestsRefresh',async()=>{
        const{Account,GuildQuestSnapshot}=require('../../db/index');
        const accs=await Account.findAll({order:[['id','ASC']]});
        const out=[];
        for(const acc of accs){
          if(!acc.access_token||acc.access_token==='placeholder'){out.push({name:acc.name,ok:false,error:'нет токена'});continue;}
          try{
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const qData=await resyncGuildQuests(api,acc.name);
            if(qData)out.push({name:acc.name,ok:true,count:(qData.quests||[]).length});
            else out.push({name:acc.name,ok:false,error:'не в гильдии'});
          }catch(e){out.push({name:acc.name,ok:false,error:e.message});}
        }
        // снимки аккаунтов, которых больше нет в БД аккаунтов — удаляем
        try{
          const live=new Set(accs.map(a=>a.name));
          const rows=await GuildQuestSnapshot.findAll({attributes:['id','account']});
          const stale=rows.filter(r=>!live.has(r.account)).map(r=>r.id);
          if(stale.length)await GuildQuestSnapshot.destroy({where:{id:stale}});
        }catch(e){logger.warn(`[quests] чистка осиротевших снимков: ${e.message}`);}
        return out;
      });
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // общий ресинк снимка гильд-квестов после ручного действия (заклейм/активация ускорителя/
  // комбинирование) — переиспользуется всеми тремя роутами ниже. Возвращает свежий qData (или
  // null при ошибке), чтобы вызывающий код мог проверить, действительно ли personal_progress
  // изменился (см. комментарий у activate-booster ниже про гонку на стороне игры).
  async function resyncGuildQuests(api,accountName){
    try{
      const{GuildQuestSnapshot}=require('../../db/index');
      const g=await api.get('/users/me/guild').catch(()=>null);
      const guildId=String(g?.guild?.id||'');
      if(!guildId)return null;
      const qData=await api.get(`/guild-quests/guild/${guildId}`).catch(()=>null);
      if(qData)await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:g?.guild?.title||'',account:accountName,quests:JSON.stringify(qData.quests||[]),updated_at:new Date()},{conflictFields:['guild_id','account']});
      return qData;
    }catch(_){return null;}
  }

  // заклейм квеста вручную (кнопка "Заклеймить" на странице "Квесты") — для типов, которые
  // автоматика не продвигает (invitations/item_acquire/booster_combine/market_*/guild_boost/
  // crystal_purchase), но условия которых пользователь мог выполнить сам, в игре напрямую или
  // через другие страницы бота. Ресинкает снимок ВСЕГДА, даже если сам collect игра отклонила
  // (напр. 400 "неверные входные данные" — квест мог уже стать неактуальным/собранным другим
  // участником гильдии к моменту клика) — иначе страница вечно показывает устаревший "готово к
  // сбору" с той же ошибкой при каждой повторной попытке, вместо того чтобы подтянуть актуальный
  // is_collected и убрать кнопку.
  app.post('/api/guild-quests/:accountId/collect',async(req,res)=>{
    const{quest_id}=req.body||{};
    if(quest_id==null)return res.status(400).json({ok:false,error:'quest_id обязателен'});
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    const resync=()=>resyncGuildQuests(api,acc.name);
    // свежее состояние квеста после ресинка — по нему и решаем, чем всё кончилось
    const freshQuest=async()=>{
      const d=await resync();
      return (d?.quests||[]).find(x=>String(x.id)===String(quest_id))||null;
    };
    try{
      const{withRetry}=require('../../utils/helpers');
      // живьём подтверждено (30.07.2026): игра иногда отвечает 400 на ПЕРВУЮ попытку заклейма,
      // хотя оба условия реально выполнены — следующая попытка того же quest_id проходит успешно
      // (см. modules/capital.js collectReadyQuests, тот же приём) — похоже на race condition
      // на стороне игры, не в боте, поэтому несколько быстрых ретраев вместо мгновенной ошибки.
      const result=await withRetry(()=>api.post(`/guild-quests/collect/${quest_id}`,{}),3,2000,`${acc.name} collect ${quest_id}`,{skipOnNoAnswer:true});
      res.json({ok:true,result,quest:await freshQuest()});
    }catch(e){
      // 400 "Предоставлены неверные входные данные" игра отдаёт и на УЖЕ ЗАБРАННУЮ награду —
      // это не ошибка, а гонка: квест успели заклеймить (циклом бота, автозаклеймом после
      // действия или прошлым кликом, чей ответ потерялся). Поэтому вердикт выносим не по коду
      // ответа, а по фактическому состоянию квеста после ресинка: is_collected → успех.
      // Раньше такой квест намертво залипал — кнопка «Заклеймить» оставалась на месте, потому
      // что страница на ошибке не обновляла строку, и каждый следующий клик давал тот же 400.
      const q=await freshQuest();
      if(q?.is_collected)return res.json({ok:true,already:true,quest:q});
      res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message,quest:q});
    }
  });

  // после успешного действия (активация/комбинирование ускорителя) квест-прогресс на стороне игры
  // обновляется НЕ мгновенно — та же гонка, что и у collect (см. выше): первый ресинк сразу после
  // действия часто ещё видит СТАРЫЙ personal_progress. Несколько попыток с паузой вместо одной,
  // пока прогресс реально не подрастёт (или пока попытки не кончатся — тогда просто отдаём
  // последний снимок, следующий фоновый цикл/ручное "Обновить" всё равно досчитает).
  async function resyncUntilProgressChanges(api,accountName,questId,prevProgress){
    const{sleep}=require('../../utils/helpers');
    let fresh=null;
    for(let i=0;i<6;i++){
      await sleep(1200);
      fresh=await resyncGuildQuests(api,accountName);
      const freshQ=fresh?.quests?.find(x=>String(x.id)===String(questId));
      if(freshQ&&((freshQ.personal_progress||0)>prevProgress||freshQ.is_collected))break;
    }
    return fresh;
  }

  // Общий хвост ручных действий по квесту (активация/комбинирование ускорителя): дождаться, пока
  // игра реально учтёт прогресс, и — если ПОСЛЕ этого оба условия выполнены — сразу же попробовать
  // заклеймить награду (просьба пользователя 31.07.2026: «если условия выполнены сразу менять
  // кнопки на кнопку клейма и пробовать сделать автоклейм»), не заставляя жать ещё раз.
  // Возвращает СВЕЖИЙ объект квеста, чтобы фронт применил его сразу, не дожидаясь отдельной
  // перезагрузки списка (раньше данные обновлялись только со второго нажатия — ответ приходил
  // раньше, чем снимок успевал стать актуальным).
  async function finishQuestAction(api,accountName,questId,prevProgress){
    const fresh=await resyncUntilProgressChanges(api,accountName,questId,prevProgress);
    let q=fresh?.quests?.find(x=>String(x.id)===String(questId))||null;
    let collected=false;
    const ready=q&&!q.is_collected&&(q.personal_progress||0)>=(q.personal_threshold||0)&&(q.guild_progress||0)>=(q.guild_threshold||0);
    if(ready){
      const claimProgress=require('../lib/questClaimProgress');
      try{
        const{withRetry}=require('../../utils/helpers');
        // те же ретраи, что и у ручного заклейма выше — игра иногда отвечает 400 на первую попытку.
        // track(...) держит квест в реестре идущих автозаклеймов и раздаёт это по SSE, чтобы кнопка
        // «Заклеймить» на странице показывала «забираем…», а не выглядела как «нажми меня».
        await claimProgress.track(accountName,questId,'action',()=>
          withRetry(()=>api.post(`/guild-quests/collect/${questId}`,{}),3,2000,`${accountName} autoclaim ${questId}`,{skipOnNoAnswer:true}));
        collected=true;
        const after=await resyncGuildQuests(api,accountName);
        q=after?.quests?.find(x=>String(x.id)===String(questId))||q;
      }catch(e){logger.warn(`[${accountName}] [quest] автозаклейм ${questId} не удался: ${e.message}`);}
    }
    return{quest:q,collected};
  }

  // ручная активация ускорителя под квест booster_activate (кнопка "Активировать" на странице
  // "Квесты") — заменила автоматику questAutomation.js runBoosterQuestAutomation по просьбе
  // пользователя 22.07.2026 (активация — намеренное решение игрока, тратит инвентарь и блокирует
  // другие типы ускорителей на часы/сутки). rarity извлекается из ТЕКСТА квеста (см.
  // questAutomation.js extractRarity), сама активация + правило "пока активен другой тип — нельзя"
  // — modules/boosterAutomation.js activateBoosterForRarity, тот же код, что использует фоновый
  // цикл вкладки "Ускорители".
  app.post('/api/guild-quests/:accountId/activate-booster',async(req,res)=>{
    const{quest_id}=req.body||{};
    if(quest_id==null)return res.status(400).json({ok:false,error:'quest_id обязателен'});
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    try{
      const g=await api.get('/users/me/guild').catch(()=>null);
      const guildId=String(g?.guild?.id||'');
      if(!guildId)return res.status(400).json({ok:false,error:'Аккаунт не в гильдии'});
      const qData=await api.get(`/guild-quests/guild/${guildId}`);
      const q=(qData?.quests||[]).find(x=>String(x.id)===String(quest_id));
      if(!q)return res.status(404).json({ok:false,error:'Квест не найден'});
      const{extractRarity}=require('../../modules/questAutomation');
      const rarity=extractRarity(q.description?.ru||q.description?.en);
      if(!rarity)return res.status(400).json({ok:false,error:'Не удалось определить редкость ускорителя из текста квеста'});
      const{activateBoosterForRarity}=require('../../modules/boosterAutomation');
      const result=await activateBoosterForRarity(api,acc.name,rarity);
      if(!result.ok){await resyncGuildQuests(api,acc.name);return res.status(409).json({ok:false,error:result.error});}
      const fin=await finishQuestAction(api,acc.name,quest_id,q.personal_progress||0);
      res.json({ok:true,name:result.name,quest:await enrichQuestFor(acc.name,fin.quest),collected:fin.collected});
    }catch(e){
      await resyncGuildQuests(api,acc.name);
      res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});
    }
  });

  // ручное комбинирование ускорителей под квест booster_combine (кнопка "Комбинировать" на
  // странице "Квесты") — раньше ничего подобного не было (тип квеста был в списке сознательно НЕ
  // автоматизируемых, и ручной кнопки тоже не было). Реверс бандла игры 30.07.2026: правила
  // конверсии отдаёт GET /boosters/combination-rules → [{from_rarity,to_rarity,required_amount}],
  // сама конверсия — POST /boosters/combine {amount, from_item_id} (amount ОБЯЗАН быть кратен
  // required_amount, за раз можно скомбинировать сколько угодно кратных required_amount штук).
  // Для квеста комбинируем МИНИМУМ — ровно один required_amount (одна конверсия) — не тратим
  // ускорители игрока сверх необходимого для выполнения условия квеста (тот же принцип, что и у
  // остальной автоматики: не сжигать ресурсы больше, чем реально нужно для конкретной цели).
  app.post('/api/guild-quests/:accountId/combine-booster',async(req,res)=>{
    const{quest_id}=req.body||{};
    if(quest_id==null)return res.status(400).json({ok:false,error:'quest_id обязателен'});
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    try{
      const g=await api.get('/users/me/guild').catch(()=>null);
      const guildId=String(g?.guild?.id||'');
      if(!guildId)return res.status(400).json({ok:false,error:'Аккаунт не в гильдии'});
      const qData=await api.get(`/guild-quests/guild/${guildId}`);
      const q=(qData?.quests||[]).find(x=>String(x.id)===String(quest_id));
      if(!q)return res.status(404).json({ok:false,error:'Квест не найден'});
      const{extractRarity}=require('../../modules/questAutomation');
      const rarity=extractRarity(q.description?.ru||q.description?.en);
      if(!rarity)return res.status(400).json({ok:false,error:'Не удалось определить редкость ускорителя из текста квеста'});
      const{combineBoosterForRarity}=require('../../modules/boosterAutomation');
      const result=await combineBoosterForRarity(api,acc.name,rarity);
      if(!result.ok){await resyncGuildQuests(api,acc.name);return res.status(409).json({ok:false,error:result.error});}
      const fin=await finishQuestAction(api,acc.name,quest_id,q.personal_progress||0);
      res.json({ok:true,toName:result.toName,quest:await enrichQuestFor(acc.name,fin.quest),collected:fin.collected});
    }catch(e){
      await resyncGuildQuests(api,acc.name);
      res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});
    }
  });

  // спец-здания гильдий (Аудиториум / Фабрика) — из капитала. Читаем из БД.
  const SPECIAL_BUILDINGS={auditorium:'CAP_SPE_timeless_market.png',factory:'CAP_SPE_tech_factory.png',ministry:'CAP_SPE_foreign_ministry.png'};
  app.get('/api/special-buildings',async(req,res)=>{
    try{
      const{GuildSpecialBuilding}=require('../../db/index');
      const rows=await GuildSpecialBuilding.findAll({order:[['guild_title','ASC']]});
      res.json({ok:true,rows:rows.map(r=>({guild_id:r.guild_id,guild_title:r.guild_title,auditorium_level:r.auditorium_level,factory_level:r.factory_level,ministry_level:r.ministry_level,updated_at:r.updated_at}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // обновление с сервера игры — по кнопке. Капитал виден лидеру/офицеру.
  app.post('/api/special-buildings/refresh',async(req,res)=>{
    try{
      const results=await opRegistry.run('specialBuildingsRefresh',async()=>{
        const{GuildSnapshot,Account,GuildSpecialBuilding}=require('../../db/index');
        const snaps=await GuildSnapshot.findAll({where:{role:['Leader','Officer']},order:[['account','ASC']]});
        const byGuild=new Map();
        for(const s of snaps){if(s.guild_id&&!byGuild.has(s.guild_id))byGuild.set(s.guild_id,{guild_title:s.guild_title,account:s.account});}
        const out=[];
        for(const[gid,info]of byGuild){
          try{
            const acc=await Account.findOne({where:{name:info.account}});
            if(!acc||!acc.access_token||acc.access_token==='placeholder'){out.push({guild:info.guild_title,ok:false,error:'нет токена'});continue;}
            const api=await makeApiForAccount(acc.id,{noLock:true});
            const capProg=await api.get(`/capitals/progress/${gid}`);
            const blds=capProg?.progress?.data?.buildings||[];
            const lvl=id=>{const b=blds.find(x=>x.id===id);return b?Number(b.level||0):null;};
            await GuildSpecialBuilding.upsert({
              guild_id:gid,guild_title:info.guild_title,
              auditorium_level:lvl(SPECIAL_BUILDINGS.auditorium),
              factory_level:lvl(SPECIAL_BUILDINGS.factory),
              ministry_level:lvl(SPECIAL_BUILDINGS.ministry),
              updated_at:new Date(),
            },{conflictFields:['guild_id']});
            out.push({guild:info.guild_title,ok:true});
          }catch(e){out.push({guild:info.guild_title,ok:false,error:e.message});}
        }
        return out;
      });
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/builders',async(req,res)=>{
    try{
      const{Account,BuilderSnapshot}=require('../../db/index');
      const accs=await Account.findAll({order:[['id','ASC']]});
      const rows=await Promise.all(accs.map(async a=>{
        const snap=await BuilderSnapshot.findOne({where:{account:a.name}});
        if(!snap)return{id:a.id,name:a.name,count:null,price_coins:null,price_stars:null,max_builders:null,cnt_coins:null,max_coins:null,cnt_stars:null,max_stars:null};
        return{id:a.id,name:a.name,count:snap.count,price_coins:snap.price_coins,price_stars:snap.price_stars,max_builders:snap.max_builders,cnt_coins:snap.cnt_coins,max_coins:snap.max_coins,cnt_stars:snap.cnt_stars,max_stars:snap.max_stars,updated_at:snap.updated_at};
      }));
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  function parseBuilders(d){
    const max_builders=d?.max_builders??null;
    const max_coins=d?.max_coins??0;
    const max_stars=d?.max_stars??0;
    const cnt_coins=d?.cnt_coins??0;
    const cnt_stars=d?.cnt_stars??0;
    const base=(max_builders??0)-max_coins-max_stars;
    const count=base+cnt_coins+cnt_stars;
    return{count,max_builders,cnt_coins,max_coins,cnt_stars,max_stars,price_coins:d?.coins??null,price_stars:d?.stars??null};
  }

  app.post('/api/builders/refresh-all',async(req,res)=>{
    try{
      const rows=await opRegistry.run('buildersRefreshAll',async()=>{
        const{Account,BuilderSnapshot}=require('../../db/index');
        const accs=await Account.findAll({order:[['id','ASC']]});
        const results=await Promise.allSettled(accs.map(async a=>{
          try{
            const gameApi=await makeApiForAccount(a.id);
            const[d,prog]=await Promise.all([gameApi.get('/builders/'),gameApi.get('/progress/')]);
            const p=parseBuilders(d);
            const coins=prog?.progress?.data?.coins??null;
            const crystals=prog?.progress?.data?.crystals??null;
            await BuilderSnapshot.upsert({account:a.name,count:p.count,price_coins:p.price_coins,price_stars:p.price_stars,max_builders:p.max_builders,cnt_coins:p.cnt_coins,max_coins:p.max_coins,cnt_stars:p.cnt_stars,max_stars:p.max_stars,updated_at:new Date()},{conflictFields:['account']});
            if(coins!==null||crystals!==null){
              const upd={};
              if(coins!==null)upd.balance=String(coins);
              if(crystals!==null)upd.crystals=String(crystals);
              await Account.update(upd,{where:{id:a.id}});
            }
            return{id:a.id,name:a.name,...p,balance:coins,crystals,updated_at:new Date()};
          }catch(e){return{id:a.id,name:a.name,error:e.message};}
        }));
        return results.map(r=>r.status==='fulfilled'?r.value:{error:r.reason?.message});
      });
      res.json({ok:true,rows});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/builders/buy',async(req,res)=>{
    try{
      const{account_id,type}=req.body||{};
      if(!account_id||!type)return res.status(400).json({ok:false,error:'account_id и type обязательны'});
      const gameApi=await makeApiForAccount(account_id);
      const result=await gameApi.post('/builders/purchase',{type});
      // refresh balance and builder state after purchase
      try{
        const{Account,BuilderSnapshot}=require('../../db/index');
        const[d,prog]=await Promise.all([gameApi.get('/builders/'),gameApi.get('/progress/')]);
        const p=parseBuilders(d);
        const acc=await Account.findByPk(account_id,{attributes:['name']});
        if(acc){
          await BuilderSnapshot.upsert({account:acc.name,count:p.count,price_coins:p.price_coins,price_stars:p.price_stars,max_builders:p.max_builders,cnt_coins:p.cnt_coins,max_coins:p.max_coins,cnt_stars:p.cnt_stars,max_stars:p.max_stars,updated_at:new Date()},{conflictFields:['account']});
          const coins=prog?.progress?.data?.coins??null;
          const crystals=prog?.progress?.data?.crystals??null;
          const upd={};
          if(coins!==null)upd.balance=String(coins);
          if(crystals!==null)upd.crystals=String(crystals);
          if(Object.keys(upd).length)await Account.update(upd,{where:{id:account_id}});
          return res.json({ok:true,result,...p,balance:coins,crystals});
        }
      }catch(_){}
      res.json({ok:true,result});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
