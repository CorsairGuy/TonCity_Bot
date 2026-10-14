'use strict';
const axios=require('axios');
const {GuildSnapshot,GuildQuestSnapshot,CapitalSnapshot,GuildMembersSnapshot,MidSnapshot}=require('../db/index');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,fmt}=require('../utils/helpers');

const QUESTS_URL='https://toncityquests.ru/ajax/quests.php';
const BOT_HASH='6f1d76a2f4d6b40103a32b55f8e9b7bb';

// quest-loop опрашивает гильдию непрерывно и раньше слал КАЖДЫЙ ещё активный квест на внешний
// сайт заново на каждой итерации — тот отвечал QUEST_ALREADY_EXISTS, что заваливало логи
// (895 записей за один bot.log). Помним уже отправленные id в рамках процесса и не повторяем.
const _reportedQuestIds=new Set();

async function reportQuest(q,guildName,accountName){
  if(_reportedQuestIds.has(q.id))return; // уже отправляли в этом запуске — не долбим внешний сайт
  try{
    const toUnix=v=>{if(!v)return 0;const n=Number(v);if(!isNaN(n)&&n>1e9)return n;return Math.floor(new Date(v).getTime()/1000)||0;};
    const rewardItemId=q.reward_item_id;
    const params=new URLSearchParams({
      bot_hash:BOT_HASH,
      quest_id:q.id,
      guild:guildName||'',
      reward_amount:q.reward_amount??0,
      reward_item_id:rewardItemId===null||rewardItemId===undefined?0:Number(rewardItemId),
      rarity:q.rarity||'',
      name:q.name?.ru||q.name?.en||q.id||'',
      description:q.description?.ru||q.description?.en||'',
      guild_threshold:q.guild_threshold||0,
      personal_threshold:q.personal_threshold||0,
      created_at:toUnix(q.created_at),
      expires_at:toUnix(q.expires_at),
      action:'new',
    });
    const res=await axios.post(QUESTS_URL,params.toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:10000});
    _reportedQuestIds.add(q.id); // и при успехе, и при "уже существует" — дальше не повторяем
    if(res.data?.status==='error'&&res.data?.message==='QUEST_ALREADY_EXISTS')return; // тихо, не спамим info
    logger.info(`[${accountName||'?'}] [reportQuest] quest ${q.id} -> ${JSON.stringify(res.data)}`);
  }catch(e){logger.warn(`[reportQuest] ${q.id}: ${e.message}`);}
}

// Заклейм гильд-квестов, у которых выполнены ОБА условия — личное (personal_progress, СВОЁ у
// каждого аккаунта, приходит с сервером персонально по токену запроса) и общее (guild_progress,
// одно на гильдию). НЕ привязана к роли — любой участник гильдии может забрать свою награду за
// личный вклад, даже если сам её не создавал и не лидер. Раньше эта проверка была только внутри
// runQuestLoop (leader-only цикл) — обычные участники гильдии никогда не проверялись и не
// заклеймивались автоматически. Теперь вызывается для КАЖДОГО аккаунта (см. bot.js) и переиспользуется
// modules/questAutomation.js сразу после действий, двигающих личный прогресс (см. там же).
async function collectReadyQuests(api,name,qList){
  let collectedAny=false;
  for(const q of qList){
    if(q.is_collected)continue;
    if((q.personal_progress||0)<(q.personal_threshold||0)||(q.guild_progress||0)<(q.guild_threshold||0))continue;
    const ok=await (async()=>{
      try{
        await globalLock.run(async()=>{await sleep(500);await api.post(`/guild-quests/collect/${q.id}`,{});});
        return true;
      }catch(e){logger.warn(`[${name}] [quest] collect ${q.id} failed: ${e.message}`);return false;}
    })();
    if(ok){
      logger.info(`[${name}] [quest] collected: ${q.name?.ru||q.id}`);
      collectedAny=true;
      await sleep(1000);
    }
  }
  return collectedAny;
}

// Личный+общий список квестов гильдии текущего аккаунта — один живой запрос, переиспользуется
// капиталом (создание/заклейм/отчёт) и questAutomation.js (решение, что стоит делать сегодня).
// Возвращает null, если аккаунт не состоит в гильдии.
async function fetchOwnGuildQuests(api){
  const g=await api.get('/users/me/guild');
  const guildId=String(g?.guild?.id||'');
  if(!guildId)return null;
  const qData=await api.get(`/guild-quests/guild/${guildId}`);
  return{guildId,role:g?.guild?.role||'',guildTitle:g?.guild?.title||'',qList:qData?.quests||[]};
}

async function runCapital(api,name){
  try{
    const g=await api.get('/users/me/guild');
    const role=g?.guild?.role,guildId=String(g?.guild?.id||'');
    if(!guildId){logger.info(`[${name}] [capital] not in guild`);return;}

    let capProg;
    if(role==='Leader'||role==='Officer'){
      capProg=await api.get(`/capitals/progress/${guildId}`);
    }

    const guildName=g?.guild?.title||'';

    // save guild snapshot
    try{
      const ben=await api.get('/guilds/benefits').catch(()=>null);
      await GuildSnapshot.upsert({
        account:name,guild_id:guildId,guild_title:guildName,role:role||'',
        benefits:ben?JSON.stringify(ben):null,updated_at:new Date(),
      },{conflictFields:['account','guild_id']});
    }catch(_){}

    // save capital snapshot (buildings) for all who can see it
    if(capProg){
      try{
        const buildings=capProg?.progress?.data?.buildings||[];
        const allParams=Array.isArray(capProg?.progress?.params)?capProg.progress.params:[];
        const sorted=[...allParams].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
        const now=Date.now();
        const past=sorted.filter(p=>new Date(p.timestamp).getTime()<=now);
        const pCurrent=past[past.length-1]??sorted[0]??null;
        const pFinal=sorted[sorted.length-1]??pCurrent;
        await CapitalSnapshot.upsert({
          guild_id:guildId,guild_title:guildName,
          buildings:JSON.stringify(buildings),
          coins:capProg?.progress?.coins??null,
          crystals:capProg?.progress?.crystals??null,
          profit_coins:pCurrent?.profit_coins??null,
          profit_crystals:pCurrent?.profit_crystals??null,
          profit_coins_final:pFinal?.profit_coins??null,
          profit_crystals_final:pFinal?.profit_crystals??null,
          economic_strength:capProg?.economic_strength??null,
          updated_at:new Date(),
        },{conflictFields:['guild_id']});
      }catch(_){}
    }

    const qData=await api.get(`/guild-quests/guild/${guildId}`);
    let qList=qData?.quests||[];
    logger.info(`[${name}] [quest] quests: ${qList.length}`);

    if((role==='Leader'||role==='Officer')&&qList.length<3){
      let created=[];
      await globalLock.run(async()=>{
        await sleep(500);
        const r=await api.post(`/guild-quests/create/${guildId}`,{});
        if(r?.success&&Array.isArray(r?.quests))created=r.quests;
        logger.info(`[${name}] [quest] created: ${created.length} new`);
      });
      qList=[...qList,...created];
    }

    for(const q of qList){
      const name_=q?.name?.ru||q?.name?.en||q?.id||'?';
      const status=q.is_collected?'collected':`personal ${q.personal_progress||0}/${q.personal_threshold||0} | guild ${q.guild_progress||0}/${q.guild_threshold||0}`;
      logger.info(`[${name}] [quest]: ${name_} | ${status}`);
      await reportQuest(q,guildName,name);
    }

    // снимок для веб-панели (страница "Квесты") — своя строка на (guild_id,account), НЕ затирает
    // личный прогресс других своих аккаунтов в той же гильдии (см. миграцию в db/index.js)
    try{await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:guildName,account:name,quests:JSON.stringify(qList),updated_at:new Date()},{conflictFields:['guild_id','account']});}catch(e){logger.warn(`[${name}] [quest] snapshot save: ${e.message}`);}

    await collectReadyQuests(api,name,qList);

  }catch(e){logger.error(`[${name}] [capital] ${e.message}`);}
}

const toUnixTs=v=>{if(!v)return 0;const n=Number(v);if(!isNaN(n)&&n>1e9)return n;return Math.floor(new Date(v).getTime()/1000)||0;};

async function runQuestLoop(api,name){
  let guildId,role,guildName;
  try{
    const g=await api.get('/users/me/guild');
    role=g?.guild?.role;guildId=String(g?.guild?.id||'');guildName=g?.guild?.title||'';
    if(guildId){
      try{
        const ben=await api.get('/guilds/benefits').catch(()=>null);
        await GuildSnapshot.upsert({account:name,guild_id:guildId,guild_title:guildName,role:role||'',benefits:ben?JSON.stringify(ben):null,updated_at:new Date()},{conflictFields:['account','guild_id']});
      }catch(_){}
    }
  }catch(e){logger.error(`[${name}] [quest-loop] guild fetch: ${e.message}`);return;}
  if(!guildId){logger.info(`[${name}] [quest-loop] not in guild`);return;}
  if(role!=='Leader'){logger.info(`[${name}] [quest-loop] not leader, skip`);return;}
  // сохраняем участников (только лидер имеет доступ)
  try{
    const members=await api.get(`/guilds/${guildId}`).catch(()=>null);
    if(members)await GuildMembersSnapshot.upsert({guild_id:guildId,guild_title:guildName,members:JSON.stringify(members),updated_at:new Date()},{conflictFields:['guild_id']});
  }catch(_){}
  // МИД НЕ перезаписываем здесь: полные данные (alliances/enemies/scouting) пишет только кнопка
  // «Обновить» на странице МИД; цикл затирал бы их одним overview → ложное «данные устарели».
  logger.info(`[${name}] [quest-loop] started`);
  while(true){
    try{
      const qData=await api.get(`/guild-quests/guild/${guildId}`);
      let qList=qData?.quests||[];
      for(const q of qList)await reportQuest(q,guildName,name);
      // сохраняем квесты гильдии в БД (страница «Квесты» читает отсюда) — своя строка на
      // (guild_id,account), не затирает личный прогресс других своих аккаунтов в той же гильдии
      try{await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:guildName,account:name,quests:JSON.stringify(qList),updated_at:new Date()},{conflictFields:['guild_id','account']});}catch(e){logger.warn(`[${name}] [quest-loop] save: ${e.message}`);}

      await collectReadyQuests(api,name,qList);

      // создать новые если в списке меньше 3 (API отдаёт только актуальные)
      if((role==='Leader'||role==='Officer')&&qList.length<3){
        await sleep(500);
        const r=await api.post(`/guild-quests/create/${guildId}`,{});
        const created=r?.success&&Array.isArray(r?.quests)?r.quests:[];
        if(created.length){
          logger.info(`[${name}] [quest-loop] created: ${created.length} new`);
          for(const q of created){
            const n_=q?.name?.ru||q?.name?.en||q?.id||'?';
            logger.info(`[${name}] [quest-loop] new: ${n_} | personal 0/${q.personal_threshold||0} | guild 0/${q.guild_threshold||0}`);
            await reportQuest(q,guildName,name);
          }
          qList=[...qList,...created];
          try{await GuildQuestSnapshot.upsert({guild_id:guildId,guild_title:guildName,account:name,quests:JSON.stringify(qList),updated_at:new Date()},{conflictFields:['guild_id','account']});}catch(_){}
        }
      }

      // спать до истечения ближайшего квеста
      const now=Date.now();
      const active=qList.filter(q=>!q.is_collected&&q.expires_at);
      if(!active.length){logger.info(`[${name}] [quest-loop] no active quests, retry in 1h`);await sleep(60*60*1000);continue;}
      const nearest=Math.min(...active.map(q=>toUnixTs(q.expires_at)*1000));
      const waitMs=nearest+5000-now;
      if(waitMs>0){
        logger.info(`[${name}] [quest-loop] sleeping ${Math.ceil(waitMs/60000)}m until quest expires`);
        await sleep(waitMs);
      }
    }catch(e){
      if(e?.cause?.response?.status===401||e?.message?.includes('status 401')){logger.error(`[${name}] [quest-loop] auth failed, stopping loop`);return;}
      logger.error(`[${name}] [quest-loop] ${e.message}`);await sleep(60000);
    }
  }
}

const COLLECT_INTERVAL_MS=12*60*60*1000;

function _needsCollect(lastCollectedStr){
  if(!lastCollectedStr)return true;
  return Date.now()-new Date(lastCollectedStr).getTime()>=COLLECT_INTERVAL_MS;
}

async function collectCapitalResources(api,name,guildId,prog){
  const uncoinedCoins=Number(prog?.uncollected_coins||0);
  const uncoinedCrystals=Number(prog?.uncollected_crystals||0);
  const lastCoins=prog?.progress?.last_coins_collected;
  const lastCrystals=prog?.progress?.last_crystals_collected;

  if(uncoinedCoins>0&&_needsCollect(lastCoins)){
    await globalLock.run(async()=>{
      await sleep(500);
      const r=await api.post(`/capitals/progress/${guildId}/collect/coins`,{});
      if(Number(r?.collected)>0)logger.info(`[${name}] [capital] coins collected: ${fmt(r.collected)}`);
    });
    await sleep(500);
  }
  if(uncoinedCrystals>0&&_needsCollect(lastCrystals)){
    await globalLock.run(async()=>{
      await sleep(500);
      const r=await api.post(`/capitals/progress/${guildId}/collect/crystals`,{});
      if(Number(r?.collected)>0)logger.info(`[${name}] [capital] crystals collected: ${fmt(r.collected)}`);
    });
    await sleep(500);
  }
}

// цикл прокачки столицы (leader-only) — сам проход теперь делает modules/capitalProgress.js
// (та же трёхуровневая система целей, что у городов, см. заголовок того файла), здесь только
// внешняя обёртка: определить гильдию, вызвать проход, поспать до следующего (будится раньше,
// если пользователь сохранил новые цели — см. web/routes/capitalStrategy.js cityWake.wake).
async function runCapUpgradeLoop(api,name){
  let guildId;
  try{
    const g=await api.get('/users/me/guild');
    if(g?.guild?.role!=='Leader'){logger.info(`[${name}] [cap-loop] not leader, skip`);return;}
    guildId=String(g?.guild?.id||'');
  }catch(e){logger.error(`[${name}] [cap-loop] guild fetch: ${e.message}`);return;}
  if(!guildId){logger.info(`[${name}] [cap-loop] not in guild`);return;}
  logger.info(`[${name}] [cap-loop] started`);
  const{runCapitalProgress}=require('./capitalProgress');
  const{waitOrWake}=require('../utils/cityWake');
  while(true){
    try{
      await runCapitalProgress(api,name,guildId);
      logger.info(`[${name}] [cap-loop] nothing to upgrade, sleeping up to 6h (or until targets change)`);
      await waitOrWake(`capital:${guildId}`,6*60*60*1000);
    }catch(e){
      if(e?.cause?.response?.status===401||e?.message?.includes('status 401')){logger.error(`[${name}] [cap-loop] auth failed, stopping loop`);return;}
      logger.error(`[${name}] [cap-loop] ${e.message}`);await sleep(60000);
    }
  }
}

module.exports={runCapital,runQuestLoop,runCapUpgradeLoop,collectCapitalResources,collectReadyQuests,fetchOwnGuildQuests};
