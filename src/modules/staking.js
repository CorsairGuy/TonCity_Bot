'use strict';
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,textToNumber,withRetry}=require('../utils/helpers');
const {saveStakedStats}=require('./session');
const {StakingEntry}=require('../db/index');

// Сохранить вклады в БД + свести список с игрой (вызывается только когда живой список реально
// получен). Вклады, которых в ответе игры больше НЕТ, помечаем собранными: это и есть штатный
// признак того, что награда забрана (игра просто перестаёт их отдавать). Без этой сверки в БД
// вечно оставались "готовые к сбору" строки по уже собранным вкладам, и офлайн-сбор (см.
// collectReady) молотил бы по ним POST'ами на каждом цикле.
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
  try{
    const{Op}=require('sequelize');
    const live=entries.map(e=>e.id).filter(id=>id!=null);
    await StakingEntry.update(
      {collected:true,collected_at:new Date()},
      {where:{account:name,collected:false,...(live.length?{entry_id:{[Op.notIn]:live}}:{})}},
    );
  }catch(_){}
}

// Забрать один вклад. Ошибку НЕ глотаем — решает вызывающий (один упавший вклад не должен
// отменять сбор остальных).
async function collectEntry(api,name,e){
  await globalLock.run(async()=>{
    await sleep(500);
    await api.post('/federal-reserve/staking/collect',{entry_id:e.id});
    // сумму берём из своей записи: ответ игры на collect её не содержит, и в логах годами
    // писалось «collected: undefined crystals»
    logger.info(`[${name}] [staking] collected: ${e.amount_to_collect??'?'} ${e.currency} (вклад ${e.id})`);
    try{await StakingEntry.update({collected:true,collected_at:new Date()},{where:{entry_id:e.id}});}catch(_){}
  });
}

// Список вкладов: сперва живой ответ игры, при неудаче — то, что уже сохранено в БД.
//
// ЗАЧЕМ фолбэк: GET /federal-reserve/staking у игры регулярно висит до нашего таймаута в 30с
// (в логах за 01.08 — 332 таких обрыва и НИ ОДНОГО успешного сбора, при этом остальные ручки
// отвечают штатно). Раньше этот единственный GET стоял в начале функции без ретраев, и любой
// его обрыв отменял весь сбор для аккаунта — награды не забирались вообще. Но чтобы забрать
// вклад, живой список не нужен: entry_id и срок лежат в staking_entries, а сверку списка
// делает следующий удачный проход (см. saveEntriesToDb).
async function listEntries(api,name){
  try{
    // таймаут 15с вместо общих 30с и всего две попытки: эта ручка либо отвечает быстро, либо
    // висит намертво, а каждая секунда ожидания занимает общий apiLock на все аккаунты
    const sd=await withRetry(()=>api.get('/federal-reserve/staking',{},{timeout:15000}),2,2000,`${name} staking list`);
    return{entries:sd?.entries||[],live:true};
  }catch(err){
    if(err?.noBuilding)throw err;
    const rows=await StakingEntry.findAll({where:{account:name,collected:false}});
    logger.warn(`[${name}] [staking] список не получен (${err.message}) — беру из БД: ${rows.length}`);
    return{entries:rows.map(r=>({id:r.entry_id,currency:r.currency,can_collect_at:r.can_collect_at,amount_to_collect:r.amount_to_collect})),live:false};
  }
}

// Собрать все созревшие вклады из списка. Возвращает число собранных.
async function collectDue(api,name,entries){
  const now=Date.now();
  let done=0;
  for(const e of entries){
    if(!e.can_collect_at||now<new Date(e.can_collect_at).getTime())continue;
    try{await collectEntry(api,name,e);done++;}
    catch(err){logger.warn(`[${name}] [staking] вклад ${e.id} не собран: ${err.message}`);}
    await sleep(500);
  }
  return done;
}

// Только сбор готовых наград (для автоматического луп)
async function collectReady(api,name){
  try{
    const{entries}=await listEntries(api,name);
    await collectDue(api,name,entries);
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [staking] нет Фед. резерва — пропуск`);return;}
    logger.error(`[${name}] [staking] collect: ${e.message}`);
  }
}

// Полное обновление: сохраняем вклады в БД + собираем готовые + авто-стейкинг
async function runStaking(api,name,account){
  try{
    // раздельно, а не Promise.all: раньше обрыв ЛЮБОГО из двух запросов ронял всю функцию —
    // в том числе авто-стейкинг, который от списка вкладов не зависит
    const{entries,live}=await listEntries(api,name);
    if(live){
      if(account)await saveStakedStats(account,name,entries);
      await saveEntriesToDb(name,entries);
    }
    await collectDue(api,name,entries);

    const sc=getConfig().stakingConfig.trim();if(!sc)return;
    const pts=sc.split(/\s+/),amt=textToNumber(pts[0]),cur=(pts[1]||'').toLowerCase(),dur=parseInt(pts[2]||'0');
    if(!amt||!cur||!dur)return;
    // свободные слоты считаем только по живому списку — по устаревшему из БД можно занять
    // несуществующий слот или, наоборот, зря пропустить вклад
    if(!live){logger.warn(`[${name}] [staking] список не живой — авто-вклад пропущен`);return;}
    const cnt={coins:0,crystals:0};
    entries.forEach(e=>{if(e.currency&&cnt[e.currency]!==undefined)cnt[e.currency]++;});
    if((cnt[cur]||0)>=3){logger.info(`[${name}] [staking] no free ${cur} slot`);return;}
    const prog=await api.get('/progress/');
    const coins=prog?.progress?.data?.coins||0,crystals=prog?.progress?.data?.crystals||0;
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

// Досрочная отмена вклада (кнопка на странице «Стейкинг»).
// ВНИМАНИЕ: путь и тело запроса НЕ сверены с бандлом игры (14.10.2026 бандл был недоступен) —
// взяты по аналогии с /staking/collect. Перед первым боевым использованием сверить с клиентом
// игры (кнопка отмены вклада в Федрезерве) и поправить здесь, больше нигде менять не нужно.
const CANCEL_PATH='/federal-reserve/staking/cancel';
const cancelBody=e=>({entry_id:e.id});

// Вердикт по состоянию после ресинка, а не по коду ответа (игра на что угодно отвечает 400):
// вклад отменён, если его больше нет в живом списке. Изменяющий запрос не повторяем.
async function cancelEntry(api,name,e){
  let postErr=null,resp=null;
  await globalLock.run(async()=>{
    try{resp=await api.post(CANCEL_PATH,cancelBody(e));}catch(err){postErr=err;}
  });
  if(postErr?.noBuilding)throw postErr;
  let sd=null;
  try{sd=await api.get('/federal-reserve/staking',{},{timeout:15000});}catch(_){}
  if(!sd?.entries){
    if(postErr)throw postErr;
    throw new Error('запрос отправлен, но список вкладов не получен — нажмите «Обновить»');
  }
  const still=sd.entries.some(x=>String(x.id)===String(e.id));
  if(!still){
    try{await StakingEntry.destroy({where:{entry_id:e.id}});}catch(_){}
    logger.info(`[${name}] [staking] вклад ${e.id} (${e.amount_staked??'?'} ${e.currency??''}) отменён`);
  }
  await saveEntriesToDb(name,sd.entries);
  if(still){
    const msg=postErr?postErr.message:`игра не отменила вклад: ${JSON.stringify(resp)}`;
    logger.warn(`[${name}] [staking] отмена вклада ${e.id} не прошла: ${msg}`);
    throw new Error(msg);
  }
  return resp;
}

module.exports={runStaking,collectReady,saveEntriesToDb,cancelEntry};
