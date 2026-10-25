'use strict';
// Расчёт хода 2048 в отдельном потоке (worker_threads): ход считается в среднем ~66 мс, в пике
// до ~3,5 с, а бот и панель живут в одном процессе — в основном потоке это подвешивало бы всё
// остальное. Поток один на все партии и живёт, пока жив бот: WASM и его таблицы грузятся один раз
// (раньше поток поднимался на каждую партию, и первый ход стоил ~300 мс). Ходы разных партий
// считаются по очереди. При ошибке ждём остановки старого потока и повторяем расчёт один раз
// в новом. Основной поток никогда не загружает WASM и не выполняет поиск.
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
const MAX_ATTEMPTS=2;

function retire(state,error,exited=false){
  if(state.failed)return;
  state.failed=true;
  state.error=error;
  // Барьер устанавливается до отклонения запросов: их повторы ждут освобождения старого WASM.
  state.stopping=(exited?Promise.resolve():Promise.resolve().then(()=>state.thread.terminate())).then(()=>{
    if(worker===state)worker=null;
  });
  // Ошибка terminate не разрешает создавать второй живой worker. Поздний exit снимет барьер.
  state.stopping.catch(()=>{});
  for(const p of state.pending.values())p.reject(error);
  state.pending.clear();
}
function spawn(){
  const state={thread:new Worker(__filename),pending:new Map(),failed:false,stopping:null};
  state.thread.on('message',m=>{
    if(state.failed)return;
    const p=state.pending.get(m.id);
    if(!p)return;
    if(Object.prototype.hasOwnProperty.call(m,'error')){
      // После исключения WASM больше не используем: стек/память могли остаться повреждёнными.
      retire(state,new Error(m.error||'ошибка расчёта 2048'));
      return;
    }
    state.pending.delete(m.id);
    p.resolve({dir:m.dir,ms:m.ms});
  });
  state.thread.on('error',error=>retire(state,error));
  state.thread.on('exit',code=>{
    if(state.failed){
      if(worker===state)worker=null;
      return;
    }
    retire(state,new Error(`поток 2048 завершился (код ${code})`),true);
  });
  state.thread.unref(); // после on('message'), чтобы простой worker не держал процесс
  return state;
}
async function getWorker(){
  while(worker?.failed){
    const state=worker;
    await state.stopping;
    if(worker===state)worker=null;
  }
  if(!worker)worker=spawn();
  return worker;
}
function calculate(state,board){
  return new Promise((resolve,reject)=>{
    if(state.failed){reject(state.error);return;}
    const id=++seq;
    state.pending.set(id,{resolve,reject});
    try{state.thread.postMessage({id,board});}
    catch(error){retire(state,error);}
  });
}

// лучший ход для доски: {dir:'up'|'down'|'left'|'right'|null, ms — сколько думал алгоритм}
async function bestMove(board){
  // Фиксируем вход до первого await, в том числе на время перезапуска и повторной попытки.
  const snapshot=structuredClone(board);
  for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
    try{return await calculate(await getWorker(),snapshot);}
    catch(error){
      if(attempt===MAX_ATTEMPTS){
        throw new Error(`не удалось рассчитать ход 2048 за ${MAX_ATTEMPTS} попытки: ${error.message}`,{cause:error});
      }
    }
  }
}

module.exports={bestMove};
