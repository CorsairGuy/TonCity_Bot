'use strict';
// Серверные сроки 2.5 + 5с. Пауза после ошибки имеет абсолютный конец и не продлевает себя.
const logger=require('../utils/logger');
const{getConfig}=require('../config');
const{waitOrWake}=require('../utils/cityWake');
const accountLoops=require('../utils/accountLoops');
const{collectCivicRewards}=require('./townhall');
const DAY=86400000,OFF_POLL=600000,ERROR_RETRY=900000,NOT_READY_RETRY=60000;
const drawEnabled=()=>getConfig().features?.civicDraw!==false;
// Один переключатель управляет обоими типами наград; старый policyGrants игнорируется.
const grantsEnabled=drawEnabled;
const enabled=()=>drawEnabled()||grantsEnabled();
function plan(row,notBefore=0,now=Date.now()){
  if(!enabled())return DAY;
  if(!row)return Math.max(0,notBefore-now);
  const due=[];
  if(drawEnabled()){
    if(row.claimable)due.push(now);
    else if(row.timer_source==='server'&&row.ready_at&&Number.isFinite(new Date(row.ready_at).getTime()))due.push(new Date(row.ready_at).getTime()+5000);
  }
  if(grantsEnabled()){
    let grants=[];try{grants=typeof row.grants==='string'?JSON.parse(row.grants):row.grants||[];}catch{}
    for(const g of grants){if(Number(g.ready)>0)due.push(now);else if(g.ready_at&&Number.isFinite(Date.parse(g.ready_at)))due.push(Date.parse(g.ready_at)+5000);}
  }
  const synced=new Date(row.updated_at).getTime();
  return Math.max(0,Math.max(due.length?Math.min(...due):Number.isFinite(synced)?synced+DAY:now,notBefore)-now);
}
async function runCivicDrawLoop(api,name,accountId){
  const{CivicDrawStatus}=require('../db/index');
  const key=`civic:${name}`;let notBefore=0;
  logger.info(`[${name}] [civic-draw] автосбор запущен`);
  while(!accountLoops.isStopped(accountId)){
    if(!enabled()){await waitOrWake(key,OFF_POLL);continue;}
    try{
      const row=await CivicDrawStatus.findOne({where:{account:name}});
      const wait=plan(row,notBefore,Date.now());
      if(wait>0){await waitOrWake(key,Math.min(wait,DAY));continue;}
      const out=await collectCivicRewards(api,name,{draws:drawEnabled(),grants:grantsEnabled()});
      notBefore=Date.now()+(out.error&&!out.notReady?ERROR_RETRY:out.got?0:out.cd?NOT_READY_RETRY:DAY);
      if(out.error&&!out.notReady)logger.warn(`[${name}] [civic-draw] ${out.error}`);
    }catch(e){
      if(e?.cause?.response?.status===401||e?.response?.status===401||e?.message?.includes('status 401')){logger.error(`[${name}] [civic-draw] auth failed`);return;}
      notBefore=Date.now()+ERROR_RETRY;logger.warn(`[${name}] [civic-draw] ${e.message}`);
    }
  }
}
module.exports={runCivicDrawLoop,plan};
