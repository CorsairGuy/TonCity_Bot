'use strict';
// Расчёт хода 2048 в отдельном потоке (worker_threads): ход считается в среднем ~66 мс, в пике
// до ~3,5 с, а бот и панель живут в одном процессе — в основном потоке это подвешивало бы всё
// остальное. Поток один на все партии и живёт, пока жив бот: WASM и его таблицы грузятся один раз
// (раньше поток поднимался на каждую партию, и первый ход стоил ~300 мс). Ходы разных партий
// считаются по очереди. Если поток упал, следующий ход поднимет его заново, а текущий считается
// прямо в основном потоке, чтобы партия не встала.
const{Worker,isMainThread,parentPort}=require('worker_threads');

if(!isMainThread){
  const{bestMove}=require('./game2048');
  bestMove([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,2]]); // прогрев: WASM и таблицы ходов — до первой партии
  parentPort.on('message',({id,board})=>{
    try{
      const t0=process.hrtime.bigint();
      const dir=bestMove(board);
      parentPort.postMessage({id,dir,ms:Number(process.hrtime.bigint()-t0)/1e6});
    }catch(e){parentPort.postMessage({id,error:e.message});}
  });
}

let worker=null,seq=0;
const pending=new Map();
function failAll(err){for(const p of pending.values())p.reject(err);pending.clear();worker=null;}
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
  worker.unref(); // поток не держит процесс при остановке; unref — после on('message'), иначе подписка вернёт ref
}

// лучший ход для доски: {dir:'up'|'down'|'left'|'right'|null, ms — сколько думал алгоритм}
async function bestMove(board){
  try{
    if(!worker)spawn();
    const id=++seq;
    return await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,board});});
  }catch(e){
    require('../utils/logger').warn(`[2048] поток расчёта хода: ${e.message} — считаю в основном потоке`);
  }
  const t0=process.hrtime.bigint();
  const dir=require('./game2048').bestMove(board);
  return{dir,ms:Number(process.hrtime.bigint()-t0)/1e6};
}

module.exports={bestMove};
