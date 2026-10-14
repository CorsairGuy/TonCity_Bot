'use strict';
// Тот же приём, что и в quizProgress.js: общий (на процесс) реестр сейчас идущих просмотров
// рекламы — решение крутится в фоне независимо от конкретного SSE-соединения, поэтому прогресс
// переживает перезагрузку страницы. Просмотр рекламы может занимать больше минуты (до лимита
// аккаунта, ~10с между роликами) — та же проблема, что была у Викторины.
const logger=require('../../utils/logger');

const registry=new Map(); // accountId -> {current,limit,subscribers:Set<Response>,startedAt,promise}

function broadcast(accountId,data){
  const entry=registry.get(accountId);
  if(!entry)return;
  const line=`data: ${JSON.stringify(data)}\n\n`;
  for(const res of entry.subscribers){try{res.write(line);}catch(_){}}
}

function list(){
  return[...registry.entries()].map(([accountId,e])=>({account_id:accountId,current:e.current,limit:e.limit}));
}

function get(accountId){return registry.get(accountId);}

function start(accountId,name,makeApiForAccount){
  const existing=registry.get(accountId);
  if(existing)return existing;
  const entry={current:0,limit:0,subscribers:new Set(),startedAt:Date.now(),promise:null};
  registry.set(accountId,entry);
  entry.promise=(async()=>{
    try{
      const api=await makeApiForAccount(accountId,{noLock:true});
      const{runDailyAds}=require('../../modules/dailyads');
      const{DailyAdsSnapshot}=require('../../db/index');
      const result=await runDailyAds(api,name,(current,limit)=>{
        entry.current=current;entry.limit=limit;
        broadcast(accountId,{type:'progress',current,limit});
      });
      await DailyAdsSnapshot.upsert({account:name,current:result.current,limit:result.limit,reward:result.reward,limit_reached:result.limit_reached,updated_at:new Date()},{conflictFields:['account']});
      broadcast(accountId,{type:'done',ok:true,...result});
      return result;
    }catch(e){
      logger.warn(`[${name}] [daily-ads] watch: ${e.message}`);
      broadcast(accountId,{type:'done',ok:false,error:e.message});
      throw e;
    }finally{
      for(const res of entry.subscribers){try{res.end();}catch(_){}}
      registry.delete(accountId);
    }
  })();
  entry.promise.catch(()=>{});
  return entry;
}

module.exports={start,get,list,broadcast};
