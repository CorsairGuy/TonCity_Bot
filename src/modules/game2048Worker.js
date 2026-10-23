'use strict';
// Расчёт хода 2048 в отдельном потоке (worker_threads): со змейкой (v3) ход считается ~60 мс, в пике
// до ~0,7 с, а бот и панель живут в одном процессе — в основном потоке это подвешивало бы всё
// остальное. Одна партия = один поток (create() в web/lib/game2048Progress.js), поток закрывается
// вместе с партией. Если поток упал, ход считается прямо в основном потоке, чтобы партия не встала.
const{Worker,isMainThread,parentPort}=require('worker_threads');

if(!isMainThread){
  const{bestMove}=require('./game2048');
  parentPort.on('message',({id,board})=>{
    try{
      const t0=process.hrtime.bigint();
      const dir=bestMove(board);
      parentPort.postMessage({id,dir,ms:Number(process.hrtime.bigint()-t0)/1e6});
    }catch(e){parentPort.postMessage({id,error:e.message});}
  });
}

function create(){
  let worker=null,seq=0,closed=false;
  const pending=new Map();
  const failAll=err=>{for(const p of pending.values())p.reject(err);pending.clear();worker=null;};
  function spawn(){
    worker=new Worker(__filename);
    worker.on('message',m=>{
      const p=pending.get(m.id);
      if(!p)return;
      pending.delete(m.id);
      if(m.error)p.reject(new Error(m.error));else p.resolve({dir:m.dir,ms:m.ms});
    });
    worker.on('error',e=>failAll(e));
    worker.on('exit',code=>{if(pending.size)failAll(new Error(`поток 2048 завершился (код ${code})`));worker=null;});
  }
  async function bestMove(board){
    if(!closed){
      try{
        if(!worker)spawn();
        const id=++seq;
        return await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,board});});
      }catch(e){
        require('../utils/logger').warn(`[2048] поток расчёта хода: ${e.message} — считаю в основном потоке`);
      }
    }
    const t0=process.hrtime.bigint();
    const dir=require('./game2048').bestMove(board);
    return{dir,ms:Number(process.hrtime.bigint()-t0)/1e6};
  }
  function close(){
    closed=true;
    if(worker){worker.terminate().catch(()=>{});worker=null;}
  }
  return{bestMove,close};
}

module.exports={create};
