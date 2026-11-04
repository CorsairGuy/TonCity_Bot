'use strict';
// Автооплата гильдейских взносов (2.5, частичный зачёт): ОТДЕЛЬНАЯ настройка guildFees.auto,
// по умолчанию выключена — это трата монет/кристаллов (CLAUDE.md §8). Цикл общий на все аккаунты
// из живого реестра accountLoops. Раз в CHECK_EVERY для каждого аккаунта: GET /users/me/guild +
// /guilds/{id}/fees; при открытом долге платит остаток через тот же payGuildFees, что и ручная
// кнопка (сверка суммы/валюты/срока, проверка баланса, без повтора POST после неоднозначного ответа),
// но только если после оплаты на балансе останется не меньше резерва guildFees.reserve[валюта].
const logger=require('../utils/logger');
const {getConfig}=require('../config');
const {sleep}=require('../utils/helpers');
const accountLoops=require('../utils/accountLoops');
const {readGuildFees,payGuildFees}=require('./guildFees');

const MIN=60000;
const CHECK_EVERY=3*60*MIN;  // взнос — период в сутки и больше, чаще проверять незачем
const OFF_POLL=10*MIN;       // выключено — только локальная проверка настроек

function settings(){
  const g=getConfig().guildFees||{};
  const r=g.reserve||{};
  return{auto:g.auto===true,reserve:{coins:Math.max(0,Number(r.coins)||0),crystals:Math.max(0,Number(r.crystals)||0)}};
}

async function payOne(api,account,reserve){
  const state=await readGuildFees(api);
  if(!state.payable)return null;
  const p=await api.get('/progress/');
  const balance=Number(p?.progress?.data?.[state.currency]);
  const keep=reserve[state.currency]||0;
  if(!Number.isFinite(balance)||balance-state.remaining<keep){
    logger.info(`[${account.name}] [guild-fees] долг ${state.remaining} ${state.currency}, баланс ${Number.isFinite(balance)?Math.floor(balance):'?'} — ниже резерва ${keep}, пропускаю`);
    return{skipped:true};
  }
  const r=await payGuildFees(api,{expected_guild_id:state.guild_id,expected_amount:state.remaining,expected_currency:state.currency,expected_deadline:state.deadline});
  if(r.ok)logger.info(`[${account.name}] [guild-fees] оплачен взнос ${state.remaining} ${state.currency} в «${state.guild_title}»${r.already?' (уже был зачтён)':''}`);
  else logger.warn(`[${account.name}] [guild-fees] оплата не прошла: ${r.error}`);
  return r;
}

async function runGuildFeesAutoLoop(){
  const {isRefreshDead}=require('./session');
  while(true){
    const s=settings();
    if(!s.auto){await sleep(OFF_POLL);continue;}
    for(const{api,account}of accountLoops.listClients()){
      if(!settings().auto)break;  // выключили посреди прохода — дальше не платим
      if(!account?.access_token||account.access_token==='placeholder'||isRefreshDead(account.id)||accountLoops.isStopped(account.id))continue;
      try{await payOne(api,account,settings().reserve);}
      catch(e){if(e.status!==404)logger.warn(`[${account.name}] [guild-fees] ${e.message}`);}
      await sleep(1500);
    }
    // ждём следующий проход, но выключение замечаем быстро
    for(let t=0;t<CHECK_EVERY&&settings().auto;t+=OFF_POLL)await sleep(OFF_POLL);
  }
}

module.exports={runGuildFeesAutoLoop,payOne};
