'use strict';
// Общий (на процесс) реестр сейчас решаемых Викторин — чтобы прогресс переживал перезагрузку
// страницы: само решение крутится в фоне независимо от конкретного SSE-соединения (res), а при
// повторном открытии страницы просто подписываемся на уже идущий прогресс вместо повторного
// запуска (запуск дважды для одного аккаунта не имеет смысла — викторина одна в момент времени).
const logger=require('../../utils/logger');

const registry=new Map(); // accountId -> {current,total,subscribers:Set<Response>,startedAt,promise}

function broadcast(accountId,data){
  const entry=registry.get(accountId);
  if(!entry)return;
  const line=`data: ${JSON.stringify(data)}\n\n`;
  for(const res of entry.subscribers){try{res.write(line);}catch(_){}}
}

function list(){
  return[...registry.entries()].map(([accountId,e])=>({account_id:accountId,current:e.current,total:e.total}));
}

function get(accountId){return registry.get(accountId);}

// стартует решение, если для этого аккаунта ещё не идёт — иначе просто отдаёт существующую запись
// (вызывающий сам подписывает свой res/подписчика на entry.subscribers при необходимости)
function start(accountId,name,makeApiForAccount,pruneWrong=true){
  const existing=registry.get(accountId);
  if(existing)return existing;
  const entry={current:0,total:0,subscribers:new Set(),startedAt:Date.now(),promise:null};
  registry.set(accountId,entry);
  entry.promise=(async()=>{
    try{
      const api=await makeApiForAccount(accountId,{noLock:true});
      const{solveQuiz}=require('../../modules/quiz');
      const result=await solveQuiz(api,name,(current,total)=>{
        entry.current=current;entry.total=total;
        broadcast(accountId,{type:'progress',current,total});
      },pruneWrong);
      broadcast(accountId,{type:'done',ok:true,...result});
      return result;
    }catch(e){
      logger.warn(`[${name}] [quiz] solve: ${e.message}`);
      broadcast(accountId,{type:'done',ok:false,error:e.message});
      throw e;
    }finally{
      for(const res of entry.subscribers){try{res.end();}catch(_){}}
      registry.delete(accountId);
    }
  })();
  entry.promise.catch(()=>{}); // сам факт ошибки уже разослан подписчикам broadcast'ом выше
  return entry;
}

module.exports={start,get,list,broadcast};
