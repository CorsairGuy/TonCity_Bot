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

  // гильдейские квесты: читаем из БД. Пишет modules/capital.js runCapital (теперь раз в день у
  // КАЖДОГО аккаунта, не только у лидеров — см. bot.js) и runQuestLoop (непрерывно у лидера).
  // Своя строка на (guild_id,account) — если в одной гильдии несколько СВОИХ аккаунтов, у каждого
  // своё личное (personal_progress), поэтому один "guild" в ответе теперь может встретиться
  // несколько раз, по разу на аккаунт.
  app.get('/api/guild-quests',async(req,res)=>{
    try{
      const{GuildQuestSnapshot,Account}=require('../../db/index');
      const rows=await GuildQuestSnapshot.findAll({order:[['guild_title','ASC'],['account','ASC']]});
      const accs=await Account.findAll({attributes:['id','name']});
      const idByName=new Map(accs.map(a=>[a.name,a.id]));
      const guilds=rows.map(r=>({
        guild_id:r.guild_id,
        guild_title:r.guild_title,
        account:r.account,
        account_id:idByName.get(r.account)??null,
        quests:r.quests?JSON.parse(r.quests):[],
        updated_at:r.updated_at,
      }));
      res.json({ok:true,guilds});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

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
    const{Account,GuildQuestSnapshot}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    const resync=async()=>{
      try{
        const g=await api.get('/users/me/guild').catch(()=>null);
        const guildId=String(g?.guild?.id||'');
        if(!guildId)return;
        const qData=await api.get(`/guild-quests/guild/${guildId}`).catch(()=>null);
        if(qData)await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:g?.guild?.title||'',account:acc.name,quests:JSON.stringify(qData.quests||[]),updated_at:new Date()},{conflictFields:['guild_id','account']});
      }catch(_){}
    };
    try{
      const result=await api.post(`/guild-quests/collect/${quest_id}`,{});
      await resync();
      res.json({ok:true,result});
    }catch(e){
      await resync();
      res.status(e.status||500).json({ok:false,error:e?.response?.data?.error||e.message});
    }
  });

  // ручная активация ускорителя под квест booster_activate (кнопка "Активировать" на странице
  // "Квесты") — заменила автоматику questAutomation.js runBoosterQuestAutomation по просьбе
  // пользователя 22.07.2026 (активация — намеренное решение игрока, тратит инвентарь и блокирует
  // другие типы ускорителей на часы/сутки). rarity извлекается из ТЕКСТА квеста (см.
  // questAutomation.js extractRarity), сама активация + правило "пока активен другой тип — нельзя"
  // — modules/boosterAutomation.js activateBoosterForRarity, тот же код, что использует фоновый
  // цикл вкладки "Ускорители". Ресинкает снимок квестов ВСЕГДА, как и collect выше.
  app.post('/api/guild-quests/:accountId/activate-booster',async(req,res)=>{
    const{quest_id}=req.body||{};
    if(quest_id==null)return res.status(400).json({ok:false,error:'quest_id обязателен'});
    const{Account,GuildQuestSnapshot}=require('../../db/index');
    const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
    if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
    const api=await makeApiForAccount(acc.id,{noLock:true});
    const resync=async()=>{
      try{
        const g=await api.get('/users/me/guild').catch(()=>null);
        const guildId=String(g?.guild?.id||'');
        if(!guildId)return null;
        const qData=await api.get(`/guild-quests/guild/${guildId}`).catch(()=>null);
        if(qData)await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:g?.guild?.title||'',account:acc.name,quests:JSON.stringify(qData.quests||[]),updated_at:new Date()},{conflictFields:['guild_id','account']});
        return qData;
      }catch(_){return null;}
    };
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
      await resync();
      if(!result.ok)return res.status(409).json({ok:false,error:result.error});
      res.json({ok:true,name:result.name});
    }catch(e){
      await resync();
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
