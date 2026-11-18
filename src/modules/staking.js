'use strict';
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,textToNumber}=require('../utils/helpers');
const {saveStakedStats}=require('./session');
const {StakingEntry}=require('../db/index');

// Сохранить вклады в БД + свести список с игрой (вызывается только когда живой список реально
// получен). Вклады, которых в ответе игры больше НЕТ, помечаем собранными: это и есть штатный
// признак того, что награда забрана (игра просто перестаёт их отдавать). Без этой сверки в БД
// вечно оставались "готовые к сбору" строки по уже собранным вкладам, и офлайн-сбор (см.
// collectReady) молотил бы по ним POST'ами на каждом цикле.
async function saveEntriesToDb(name,entries){
  if(!Array.isArray(entries)||entries.some(e=>!e||e.id==null))throw new Error('некорректный список вкладов');
  entries=normalizeEntries(entries,Date.now());
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
    const result=await api.post('/federal-reserve/staking/collect',{entry_id:e.id});
    logger.info(`[${name}] [staking] collected: ${result?.amount??e.amount_to_collect??'?'} ${result?.currency??e.currency} (вклад ${e.id})`);
    try{await StakingEntry.update({collected:true,collected_at:new Date()},{where:{entry_id:e.id}});}catch(_){}
  });
}

// Относительное время привязываем к моменту получения ответа один раз, до сохранения в БД.
function normalizeEntries(entries,receivedAt){
  return entries.map(e=>{
    const {collect_in_seconds:seconds,...entry}=e;
    const absolute=e.can_collect_at==null?NaN:new Date(e.can_collect_at).getTime();
    if(Number.isFinite(absolute))return {...entry,can_collect_at:new Date(absolute)};
    if(typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0){
      const deadline=receivedAt+seconds*1000;
      return {...entry,can_collect_at:Number.isFinite(new Date(deadline).getTime())?new Date(deadline):null};
    }
    return {...entry,can_collect_at:null};
  });
}

// Для изменяющих действий необходим свежий и корректный список.
async function listEntries(api,name){
  const sd=await api.get('/federal-reserve/staking',{},{timeout:15000});
  const receivedAt=Date.now();
  if(!Array.isArray(sd?.entries)||sd.entries.some(e=>!e||e.id==null))throw new Error('некорректный список вкладов');
  return{entries:normalizeEntries(sd.entries,receivedAt),data:sd};
}

// Собрать все созревшие вклады из списка. Возвращает число собранных.
async function collectDue(api,name,entries){
  const now=Date.now();
  let done=0;
  for(const e of entries){
    const deadline=e.can_collect_at==null?NaN:new Date(e.can_collect_at).getTime();
    if(!Number.isFinite(deadline)||now<deadline)continue;
    try{await collectEntry(api,name,e);done++;}
    catch(err){logger.warn(`[${name}] [staking] вклад ${e.id} не собран: ${err.message}`);}
    await sleep(500);
  }
  return done;
}

const runningAccounts=new Set();
// Только сбор готовых наград (для автоматического луп)
async function collectReady(api,name){
  if(runningAccounts.has(name))return;
  runningAccounts.add(name);
  try{
    const{entries}=await listEntries(api,name);
    await saveEntriesToDb(name,entries);
    await collectDue(api,name,entries);
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [staking] нет Фед. резерва — пропуск`);return;}
    logger.error(`[${name}] [staking] collect: ${e.message}`);
  }finally{runningAccounts.delete(name);}
}

// Не повторять создание после неизвестного исхода до перезапуска и проверки игроком.
const uncertainStakes=new Set();
// Полное обновление: сохраняем вклады в БД + собираем готовые + авто-стейкинг
async function runStaking(api,name,account){
  if(runningAccounts.has(name))return;
  runningAccounts.add(name);
  try{
    // раздельно, а не Promise.all: раньше обрыв ЛЮБОГО из двух запросов ронял всю функцию —
    // в том числе авто-стейкинг, который от списка вкладов не зависит
    const{entries,data}=await listEntries(api,name);
    if(account)await saveStakedStats(account,name,entries);
    await saveEntriesToDb(name,entries);
    await collectDue(api,name,entries);

    const sc=getConfig().stakingConfig.trim();if(!sc)return;
    const pts=sc.split(/\s+/),amt=textToNumber(pts[0]),cur=(pts[1]||'').toLowerCase(),dur=Number(pts[2]);
    if(!['coins','crystals'].includes(cur)||!Number.isSafeInteger(amt)||amt<=0||!Number.isSafeInteger(dur)||dur<=0)return;
    if(uncertainStakes.has(name)){logger.warn(`[${name}] [staking] исход прошлого авто-вклада неизвестен; проверьте игру`);return;}
    const terms=data[cur==='coins'?'coin_terms':'crystal_terms'],amounts=data[cur==='coins'?'coin_amounts':'crystal_amounts'];
    const multiplier=data.staking_rate_multiplier,limit=data.stakes_per_currency;
    if(!Array.isArray(terms)||!Array.isArray(amounts)||!Number.isFinite(multiplier)||multiplier<0||!Number.isSafeInteger(limit)||limit<0){logger.warn(`[${name}] [staking] условия сервера неполны`);return;}
    const term=terms.find(t=>t?.days===dur&&Number.isFinite(t.rate)&&t.rate>=0);
    const whale=cur==='coins'&&Array.isArray(data.whale_slots)&&data.whale_slots.some(s=>s?.amount===amt&&s.in_use===false);
    if(!term||(!amounts.includes(amt)&&!whale)){logger.warn(`[${name}] [staking] сумма или срок недоступны`);return;}
    if(entries.filter(e=>e.currency===cur).length>=limit){logger.info(`[${name}] [staking] нет свободной ячейки ${cur}`);return;}
    const prog=await api.get('/progress/'),balance=Number(prog?.progress?.data?.[cur]);
    if(!Number.isFinite(balance)||balance<amt){logger.info(`[${name}] [staking] недостаточно ${cur}`);return;}
    const payout=Math.floor(amt*(1+term.rate*multiplier));
    await globalLock.run(async()=>{
      await sleep(500);
      try{await api.post('/federal-reserve/staking',{currency:cur,amount:amt,duration:dur});logger.info(`[${name}] [staking] вложено ${amt} ${cur}, ожидается ${payout}`);}
      catch(e){uncertainStakes.add(name);throw e;}
    });
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [staking] нет Фед. резерва — пропуск`);return;}
    logger.error(`[${name}] [staking] ${e.message}`);
  }finally{runningAccounts.delete(name);}
}

// Досрочная отмена вклада (кнопка на странице «Стейкинг»).
// Путь сверен буквально по entry-E5PzOcWX-99471.js (14.10.2026): объект api.federalReserve.staking
// содержит entries:"/federal-reserve/staking", canCollect:"/federal-reserve/staking/can-collect",
// collect:"/federal-reserve/staking/collect", cancel:"/federal-reserve/staking/cancel".
// Тело {entry_id} этим куском бандла не видно (собирается в вызывающей функции), поэтому
// вердикт — по факту: кнопка только у монетных и ещё не созревших вкладов, ответ несёт amount —
// сколько вернули.
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
  if(!Array.isArray(sd?.entries)||sd.entries.some(x=>!x||x.id==null)){
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
