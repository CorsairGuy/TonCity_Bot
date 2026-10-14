'use strict';
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,textToNumber}=require('../utils/helpers');
const {saveStakedStats}=require('./session');
const {StakingEntry}=require('../db/index');

// Сохранить вклады в БД (вызывается только при ручном обновлении)
async function saveEntriesToDb(name,entries){
  for(const e of entries){
    try{
      await StakingEntry.upsert({
        entry_id:e.id,
        account:name,
        currency:e.currency,
        amount_staked:Number(e.amount_staked??0),
        amount_to_collect:Number(e.amount_to_collect??0),
        created_at:e.created_at?new Date(e.created_at):null,
        can_collect_at:e.can_collect_at?new Date(e.can_collect_at):null,
        collected:false,
      },{conflictFields:['entry_id']});
    }catch(_){}
  }
}

// Только сбор готовых наград (для автоматического луп)
async function collectReady(api,name){
  try{
    const sd=await api.get('/federal-reserve/staking');
    const entries=sd?.entries||[];
    const now=Date.now();
    for(const e of entries){
      if(now<new Date(e.can_collect_at).getTime())continue;
      await globalLock.run(async()=>{
        await sleep(500);
        const r=await api.post('/federal-reserve/staking/collect',{entry_id:e.id});
        logger.info(`[${name}] [staking] collected: ${r?.amount_to_collect} ${e.currency}`);
        try{await StakingEntry.update({collected:true,collected_at:new Date()},{where:{entry_id:e.id}});}catch(_){}
      });
      await sleep(500);
    }
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [staking] нет Фед. резерва — пропуск`);return;}
    logger.error(`[${name}] [staking] collect: ${e.message}`);
  }
}

// Полное обновление: сохраняем вклады в БД + собираем готовые + авто-стейкинг
async function runStaking(api,name,account){
  try{
    const[sd,prog]=await Promise.all([api.get('/federal-reserve/staking'),api.get('/progress/')]);
    const coins=prog?.progress?.data?.coins||0,crystals=prog?.progress?.data?.crystals||0;
    const entries=sd?.entries||[];
    if(account)await saveStakedStats(account,name,entries);
    await saveEntriesToDb(name,entries);
    const now=Date.now();
    for(const e of entries){
      if(now<new Date(e.can_collect_at).getTime())continue;
      await globalLock.run(async()=>{
        await sleep(500);
        const r=await api.post('/federal-reserve/staking/collect',{entry_id:e.id});
        logger.info(`[${name}] [staking] collected: ${r?.amount_to_collect} ${e.currency}`);
        try{await StakingEntry.update({collected:true,collected_at:new Date()},{where:{entry_id:e.id}});}catch(_){}
      });
      await sleep(500);
    }
    const sc=getConfig().stakingConfig.trim();if(!sc)return;
    const pts=sc.split(/\s+/),amt=textToNumber(pts[0]),cur=(pts[1]||'').toLowerCase(),dur=parseInt(pts[2]||'0');
    if(!amt||!cur||!dur)return;
    const cnt={coins:0,crystals:0};
    entries.forEach(e=>{if(e.currency&&cnt[e.currency]!==undefined)cnt[e.currency]++;});
    if((cnt[cur]||0)>=3){logger.info(`[${name}] [staking] no free ${cur} slot`);return;}
    const bal=cur==='coins'?Number(coins):Number(crystals);
    if(bal<amt){logger.info(`[${name}] [staking] not enough ${cur}`);return;}
    await globalLock.run(async()=>{
      await sleep(500);
      const r=await api.post('/federal-reserve/staking',{currency:cur,amount:amt,duration:dur});
      if(r?.success)logger.info(`[${name}] [staking] staked ${amt} ${cur} for ${dur} days`);
      else logger.warn(`[${name}] [staking] ${JSON.stringify(r)}`);
    });
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [staking] нет Фед. резерва — пропуск`);return;}
    logger.error(`[${name}] [staking] ${e.message}`);
  }
}

module.exports={runStaking,collectReady,saveEntriesToDb};
