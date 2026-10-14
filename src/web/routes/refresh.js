'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

const SPECIAL_MODS=new Set(['dailyads','staking','daily','guilds','capitals','mid','city','journey','loyalty']);

// Потолок на ОДИН аккаунт и на весь проход. Зачем: opRegistry.run() снимает ключ операции только
// в finally, т.е. если проход по аккаунтам не завершится НИКОГДА, ключ `refresh:<mod>` остаётся
// занятым навсегда — и каждое следующее нажатие «Обновить» молча присоединяется к мёртвому
// промису, ничего не запуская и ничего не логируя. Ровно это и случилось 03.08: проход по
// политикам встал на 25-м аккаунте из 60 (в логах — обрыв на 14:20:36 и больше ни строки), после
// чего кнопка на странице перестала обновлять что-либо вообще. Внутренние таймауты не спасают:
// axios ограничивает только сам HTTP-запрос, apiLock — только задачу в своей очереди, а зависнуть
// можно и вне их (рефреш/обмен токена у мёртвого аккаунта, запрос к БД без таймаута).
const ACCOUNT_TIMEOUT=90_000;
const PASS_TIMEOUT=20*60_000;
// Промис нельзя отменить — «отвалившаяся» операция продолжит жить в фоне, но цикл уже не ждёт её
// и идёт дальше, а ключ операции освобождается.
function withTimeout(p,ms,label){
  let t;
  return Promise.race([
    Promise.resolve(p).finally(()=>clearTimeout(t)),
    new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(`${label}: не уложился в ${Math.round(ms/1000)}с`)),ms);}),
  ]);
}

module.exports=function(app,ctx){
  const{apiForAcc,makeApiForAccount}=ctx;

  app.post('/api/refresh/:module',async(req,res)=>{
    const mod=req.params.module;
    try{
      const{Account,GuildSnapshot,GuildMembersSnapshot,MidSnapshot}=require('../../db/index');
      const ApiClient=require('../../api/client');
      const moduleMap={
        achievements:require('../../modules/achievements').runAchievements,
        builders:require('../../modules/builders').runBuilders,
        townhall:require('../../modules/townhall').runTownhall,
        shop:require('../../modules/shop').runShop,
        // каталог зданий (цены) — на событиях игра меняет их прямо в каталоге, см.
        // utils/buildingCatalog.js. Достаточно одного аккаунта, но проход по всем безвреден:
        // повторные вызовы просто перезапишут файл теми же числами.
        buildings:(api)=>require('../../utils/buildingCatalog').refresh(api),
        // каталог предметов + докачка иконок новых предметов (см. utils/itemCatalog.js)
        items:(api)=>require('../../utils/itemCatalog').refresh(api),
        inventory:require('../../modules/inventory').runInventory,
        // Кнопка «Обновить» на странице «Политики» показывает ДВА разных источника: карты политик
        // (PolicySnapshot ← /policies/) и осколки/тайные политики (Inventory ← /storage/allitemdata,
        // см. SHARD_ITEM_TYPES в routes/policies.js). Раньше здесь стоял только runPolicies, поэтому
        // осколки кнопкой не обновлялись вообще — их подтягивал лишь дневной цикл бота или кнопка на
        // странице «Предметы».
        policies:async(api,name)=>{
          await require('../../modules/policies').runPolicies(api,name);
          await require('../../modules/inventory').runInventory(api,name);
        },
        satoshi:require('../../modules/satoshi').runSatoshi,
        staking:(api,name,acc)=>require('../../modules/staking').runStaking(api,name,acc),
        dailyads:require('../../modules/dailyads').getDailyAdsStatus,
        techfactory:require('../../modules/guildBuildings').runTechFactory,
        auditorium:require('../../modules/guildBuildings').runAuditorium,
      };
      if(!SPECIAL_MODS.has(mod)&&!moduleMap[mod])return res.status(400).json({ok:false,error:`Unknown module: ${mod}`});
      // opRegistry.run: если этот же модуль уже обновляется (напр. запрос с одной вкладки ещё не
      // закончился, а пользователь перезагрузил страницу и нажал "Обновить" снова) — второй вызов
      // НЕ запускает повторный проход по аккаунтам, а просто ждёт результата уже идущего.
      // потолок на весь проход — страховка для «специальных» веток ниже, у которых своего
      // пер-аккаунтного таймаута нет: даже если там что-то залипнет, ключ операции освободится
      // и следующее нажатие кнопки запустит новый проход, а не присоединится к мёртвому
      const result=await opRegistry.run(`refresh:${mod}`,()=>withTimeout((async()=>{
        if(mod==='dailyads'){
          const{DailyAdsSnapshot}=require('../../db/index');
          const{getDailyAdsStatus}=require('../../modules/dailyads');
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=await makeApiForAccount(acc.id);
              const s=await getDailyAdsStatus(api,acc.name);
              await DailyAdsSnapshot.upsert({account:acc.name,...s,updated_at:new Date()},{conflictFields:['account']});
              results.push({name:acc.name,ok:true,...s});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='journey'){
          // ручная кнопка "Обновить" — всегда живой запрос (forceLive), в отличие от автоцикла
          // (modules/progress.js, синхронизирован с прокачкой города), который экстраполирует и
          // стучится в игру только когда профит похож на достигший порога (см. modules/journey.js).
          // currentProfit не нужен — forceLive пропускает локальную проверку целиком.
          const{runJourney}=require('../../modules/journey');
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=apiForAcc(acc);
              await runJourney(api,acc.name,null,{forceLive:true});
              results.push({name:acc.name,ok:true});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='loyalty'){
          const{runLoyalty}=require('../../modules/loyalty');
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=apiForAcc(acc);
              await runLoyalty(api,acc.name,{forceLive:true});
              results.push({name:acc.name,ok:true});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='staking'){
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=apiForAcc(acc);
              await require('../../modules/staking').runStaking(api,acc.name,acc);
              results.push({name:acc.name,ok:true});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='daily'){
          const{DailyLog}=require('../../db/index');
          const accs=await Account.findAll({order:[['id','ASC']]});
          const today=new Date().toISOString().slice(0,10);
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=await makeApiForAccount(acc.id);
              const d=await api.get('/daily-login/');
              await require('../../modules/tasks').saveRewardSnapshot(acc.name,d);
              const dl=d?.daily_login??d;
              // extract item_id from various possible fields
              const itemId=dl?.reward_item_id??dl?.item_id??d?.reward_item_id??d?.item_id??null;
              const rewardType=dl?.reward_type??d?.reward_type??null;
              const rewardAmount=dl?.reward??d?.reward??null;
              if(itemId!=null||rewardType!=null||rewardAmount!=null){
                const row=await DailyLog.findOne({where:{account:acc.name,logged_at:today}});
                if(row&&row.reward){
                  const rw=JSON.parse(row.reward);
                  if(rw.type==='item'&&itemId!=null)rw.item_id=itemId;
                  await row.update({reward:JSON.stringify(rw)});
                }
              }
              results.push({name:acc.name,ok:true,itemId,rewardType});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='guilds'){
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token||acc.access_token==='placeholder')continue;
            try{
              const api=apiForAcc(acc);
              const g=await api.get('/users/me/guild');
              const role=g?.guild?.role,guildId=String(g?.guild?.id||''),guildName=g?.guild?.title||'';
              if(guildId){
                const ben=await api.get('/guilds/benefits').catch(()=>null);
                // guild_type есть только в management-настройках (нужны права лидера/офицера)
                let guildType=null;
                if(role==='Leader'||role==='Officer'){
                  const mg=await api.get(`/guilds/management/${guildId}`).catch(()=>null);
                  guildType=mg?.settings?.guild_type||null;
                }
                const blob=(ben||guildType)?JSON.stringify({...(ben||{}),guild_type:guildType}):null;
                await GuildSnapshot.upsert({account:acc.name,guild_id:guildId,guild_title:guildName,role:role||'',benefits:blob,updated_at:new Date()},{conflictFields:['account','guild_id']});
              }else{
                await GuildSnapshot.destroy({where:{account:acc.name}});
              }
              results.push({name:acc.name,ok:true});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='city'){
          // кнопка "Обновить" на странице "Города" — то же самое, что делает "Обновить" на странице
          // карты одного города (cityStrategy.js resyncSnapshot), только сразу по всем аккаунтам:
          // реально дёргает /progress/ у игры (не кэш CitySnapshot из БД) и транслирует свежие
          // постройки через cityLive любой открытой в этот момент карте
          const{CitySnapshot}=require('../../db/index');
          const cityLive=require('../../utils/cityLive');
          const{saveStats}=require('../../modules/session');
          const accs=await Account.findAll({order:[['id','ASC']]});
          const results=[];
          for(const acc of accs){
            if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
            try{
              const api=await makeApiForAccount(acc.id,{noLock:true});
              const prog=await api.get('/progress/');
              // раньше здесь писался только снимок построек (CitySnapshot) — баланс монет/кристаллов
              // аккаунта (Account.balance/crystals) не обновлялся, и кнопка "Обновить" на странице
              // "Города" оставляла старые цифры, хотя саму карту обновляла корректно.
              saveStats(acc,acc.name,prog);
              const buildings=Array.isArray(prog?.progress?.data?.buildings)?prog.progress.data.buildings:[];
              // ВМЕСТЕ с постройками пишем и разблокированные секции. Без них строка снимка
              // создавалась с пустым полем (на новой установке эта кнопка запросто оказывается
              // ПЕРВЫМ писателем снимка), и карта города показывала ВСЕ секции запертыми, а
              // повторные нажатия ничего не чинили — см. тот же баг у boosterAutomation 11.08.
              const rawSections=prog?.progress?.unlocked_sections;
              const row={account:acc.name,buildings:JSON.stringify(buildings),updated_at:new Date()};
              if(Array.isArray(rawSections))row.unlocked_sections=JSON.stringify(rawSections);
              await CitySnapshot.upsert(row,{conflictFields:['account']});
              // видно в логе, что реально прислала игра — иначе «секции не сохраняются» опять
              // придётся выяснять вслепую
              logger.info(`[${acc.name}] [refresh] снимок города: построек ${buildings.length}, секций ${Array.isArray(rawSections)?rawSections.length:'игра список НЕ прислала'}`);
              cityLive.broadcast(acc.name,buildings);
              results.push({name:acc.name,ok:true});
            }catch(e){results.push({name:acc.name,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='capitals'){
          const{GuildSnapshot}=require('../../db/index');
          const{runCapital}=require('../../modules/capital');
          const leaders=await GuildSnapshot.findAll({where:{role:['Leader','Officer']}});
          const results=[];
          const seen=new Set();
          for(const row of leaders){
            if(seen.has(row.guild_id))continue;
            const acc=await Account.findOne({where:{name:row.account}});
            if(!acc?.access_token){results.push({name:row.account,ok:false,error:'no token'});continue;}
            try{
              const api=await makeApiForAccount(acc.id);
              await runCapital(api,acc.name);
              seen.add(row.guild_id);
              results.push({name:row.account,guild:row.guild_title,ok:true});
            }catch(e){results.push({name:row.account,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        if(mod==='mid'){
          // только лидеры имеют доступ — ищем их по GuildSnapshot
          const leaders=await GuildSnapshot.findAll({where:{role:'Leader'}});
          const results=[];
          for(const row of leaders){
            const acc=await Account.findOne({where:{name:row.account}});
            if(!acc?.access_token){results.push({name:row.account,ok:false,error:'no token'});continue;}
            try{
              const api=apiForAcc(acc);
              const guildId=row.guild_id;const guildName=row.guild_title;
              const members=await api.get(`/guilds/${guildId}`).catch(()=>null);
              if(members)await GuildMembersSnapshot.upsert({guild_id:guildId,guild_title:guildName,members:JSON.stringify(members),updated_at:new Date()},{conflictFields:['guild_id']});
              const mid=await api.get(`/foreign-ministry/overview?guild_id=${guildId}`).catch(()=>null);
              if(mid)await MidSnapshot.upsert({guild_id:guildId,guild_title:guildName,data:JSON.stringify(mid),updated_at:new Date()},{conflictFields:['guild_id']});
              results.push({name:row.account,guild:guildName,ok:true});
            }catch(e){results.push({name:row.account,ok:false,error:e.message});}
          }
          return{ok:true,results};
        }
        const fn=moduleMap[mod];
        const accs=await Account.findAll({order:[['id','ASC']]});
        const results=[];
        for(const acc of accs){
          if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
          try{
            const api=apiForAcc(acc);
            await withTimeout(fn(api,acc.name),ACCOUNT_TIMEOUT,`${acc.name} ${mod}`);
            results.push({name:acc.name,ok:true});
          }catch(e){
            logger.warn(`[refresh:${mod}] ${acc.name}: ${e.message}`);
            results.push({name:acc.name,ok:false,error:e.message});
          }
        }
        return{ok:true,results};
      })(),PASS_TIMEOUT,`refresh:${mod}`));
      res.json(result);
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
