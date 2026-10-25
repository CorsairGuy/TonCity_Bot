'use strict';
// Реальный менеджер worker с управляемыми авариями; запросов к игре и БД нет.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const{EventEmitter}=require('node:events');
const ROOT=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(ROOT,'src/modules/game2048Worker.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function observe(promise){
  const result={settles:0};
  result.done=promise.then(value=>{result.settles++;result.value=value;},error=>{result.settles++;result.error=error;});
  return result;
}
function context(options={}){
  const workers=[],warnings=[],loads=[];let constructors=0,postThrows=options.postThrows||0;
  class FakeWorker extends EventEmitter{
    constructor(){
      super();constructors++;
      if(constructors<=(options.constructorThrows||0))throw new Error('constructor failed');
      this.sent=[];this.alive=true;this.stop=deferred();this.terminateCalls=0;workers.push(this);
    }
    postMessage(message){if(postThrows-->0)throw new Error('postMessage failed');this.sent.push(message);}
    unref(){}
    ref(){}
    terminate(){this.terminateCalls++;return this.stop.promise;}
    finish(){this.alive=false;this.emit('exit',1);this.stop.resolve(1);}
    answer(index,dir='left'){const request=this.sent[index];assert(request,'Нет ожидаемого сообщения');this.emit('message',{id:request.id,dir,ms:3});}
  }
  const sandbox={module:{exports:{}},exports:{},__filename:path.join(ROOT,'src/modules/game2048Worker.js'),process,
    require(name){
      loads.push(name);
      if(name==='worker_threads')return{Worker:FakeWorker,isMainThread:true};
      if(name==='../utils/logger')return{warn:message=>warnings.push(message)};
      throw new Error(`Недопустимая загрузка в основном потоке: ${name}`);
    },setTimeout,clearTimeout,setImmediate,clearImmediate,queueMicrotask,structuredClone};
  vm.runInNewContext(source,sandbox,{filename:'game2048Worker.js'});
  return{api:sandbox.module.exports,workers,warnings,loads,get constructors(){return constructors;}};
}
async function sent(c,count=1){await tick();assert.equal(c.workers.length,count);return c.workers[count-1];}
async function success(result,dir){await result.done;assert.equal(result.error,undefined,result.error?.stack);assert.equal(result.value.dir,dir);assert.equal(result.settles,1);}
async function rejected(result){await result.done;assert(result.error,'Ожидалась явная ошибка после ограниченных попыток');assert.equal(result.settles,1);}
async function test(name,fn){await fn();console.log(`PASS ${name}`);}
async function main(){
  await test('поздние события старого потока не отменяют новый; запуск ждёт остановки',async()=>{
    const c=context(),p=observe(c.api.bestMove('A')),a=await sent(c);
    a.emit('error',new Error('crash A'));await tick();
    assert.equal(a.terminateCalls,1);assert.equal(c.workers.length,1,'Новый поток стартовал до остановки старого');
    a.finish();const b=await sent(c,2);assert.equal(b.sent.length,1);
    a.emit('error',new Error('late error'));a.emit('exit',1);a.emit('message',{id:b.sent[0].id,dir:'wrong',ms:1});await tick();
    assert.equal(p.settles,0);assert.equal(c.workers.length,2);
    b.answer(0,'up');await success(p,'up');
    const next=observe(c.api.bestMove('next'));await tick();assert.equal(c.workers.length,2);b.answer(1,'down');await success(next,'down');
    assert(!c.loads.includes('./game2048'),'Основной поток загрузил WASM-солвер');
  });
  await test('снимок доски сохраняется до первого await и на повторную попытку',async()=>{
    const c=context(),board=[[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],original=structuredClone(board);
    const p=observe(c.api.bestMove(board));board[0][0]=4;
    const a=await sent(c);assert.deepEqual(a.sent[0].board,original);
    a.emit('error',new Error('snapshot retry'));board[0][0]=8;board[1][1]=16;await tick();a.finish();
    const b=await sent(c,2);assert.deepEqual(b.sent[0].board,original);b.answer(0,'down');await success(p,'down');
  });
  await test('несколько ожидающих запросов повторяются ровно один раз и завершаются по ID',async()=>{
    const c=context(),results=['one','two','three'].map(board=>observe(c.api.bestMove(board))),a=await sent(c);
    assert.equal(a.sent.length,3);a.emit('error',new Error('queue crash'));await tick();a.finish();const b=await sent(c,2);
    assert.deepEqual(b.sent.map(m=>m.board),['one','two','three']);
    assert.equal(new Set([...a.sent,...b.sent].map(m=>m.id)).size,6,'ID попыток повторился');
    b.answer(2,'right');b.answer(0,'left');b.answer(1,'up');
    await Promise.all(results.map((p,i)=>success(p,['left','up','right'][i])));
    for(let i=0;i<3;i++)a.answer(i,'wrong');await tick();assert(results.every(p=>p.settles===1));
  });
  await test('завершённый запрос не повторяется при последующей аварии соседнего',async()=>{
    const c=context(),done=observe(c.api.bestMove('done')),pending=observe(c.api.bestMove('pending')),a=await sent(c);
    a.answer(0,'left');await success(done,'left');a.emit('error',new Error('remaining crash'));await tick();a.finish();
    const b=await sent(c,2);assert.deepEqual(b.sent.map(m=>m.board),['pending']);b.answer(0,'right');await success(pending,'right');assert.equal(done.settles,1);
  });
  await test('ошибка вычисления заменяет загрязнённый worker целиком, сохраняя очередь',async()=>{
    const c=context(),p=observe(c.api.bestMove('bad')),q=observe(c.api.bestMove('queued')),a=await sent(c);
    a.emit('message',{id:a.sent[0].id,error:''});await tick();assert.equal(a.terminateCalls,1);assert.equal(c.workers.length,1);
    a.finish();const b=await sent(c,2);assert.deepEqual(b.sent.map(m=>m.board),['bad','queued']);b.answer(0,'left');b.answer(1,'right');
    await Promise.all([success(p,'left'),success(q,'right')]);assert(!c.loads.includes('./game2048'));
  });
  await test('повторная авария отклоняет запрос без бесконечного создания потоков',async()=>{
    const c=context(),p=observe(c.api.bestMove('twice')),a=await sent(c);a.emit('error',new Error('first'));await tick();a.finish();
    const b=await sent(c,2);b.emit('error',new Error('second'));await rejected(p);b.finish();await tick();assert.equal(c.workers.length,2);
    const next=observe(c.api.bestMove('later')),d=await sent(c,3);d.answer(0,'down');await success(next,'down');
  });
  await test('ошибка создания ограничена двумя попытками и не ломает будущие запросы',async()=>{
    const c=context({constructorThrows:2}),p=observe(c.api.bestMove('startup'));await rejected(p);assert.equal(c.constructors,2);assert.equal(c.workers.length,0);
    const next=observe(c.api.bestMove('later')),a=await sent(c);a.answer(0,'left');await success(next,'left');
  });
  await test('синхронная ошибка postMessage повторяется только после остановки',async()=>{
    const c=context({postThrows:1}),p=observe(c.api.bestMove('post')),a=await sent(c);await tick();assert.equal(a.terminateCalls,1);assert.equal(c.workers.length,1);
    a.finish();const b=await sent(c,2);assert.equal(b.sent.length,1);b.answer(0,'right');await success(p,'right');
  });
  await test('exit без предварительного error повторяет ожидающий запрос; новые ждут остановки',async()=>{
    const c=context(),p=observe(c.api.bestMove('old')),a=await sent(c);
    a.emit('exit',0);const q=observe(c.api.bestMove('new'));
    const b=await sent(c,2);assert.equal(a.terminateCalls,0);
    assert.deepEqual(b.sent.map(m=>m.board).sort(),['new','old']);
    for(let i=0;i<b.sent.length;i++)b.answer(i,'up');
    await Promise.all([success(p,'up'),success(q,'up')]);
  });
  await test('новый запрос во время terminate ждёт барьер вместе с повтором старого',async()=>{
    const c=context(),p=observe(c.api.bestMove('old')),a=await sent(c);
    a.emit('error',new Error('crash'));await tick();const q=observe(c.api.bestMove('new'));await tick();
    assert.equal(c.workers.length,1);a.finish();const b=await sent(c,2);
    assert.deepEqual(b.sent.map(m=>m.board).sort(),['new','old']);
    for(let i=0;i<b.sent.length;i++)b.answer(i,'right');
    await Promise.all([success(p,'right'),success(q,'right')]);
  });
  await test('авария простоя не создаёт лишний поток; следующий запрос запускается заново',async()=>{
    const c=context(),p=observe(c.api.bestMove('first')),a=await sent(c);a.answer(0,'left');await success(p,'left');a.emit('exit',0);await tick();assert.equal(c.workers.length,1);
    const next=observe(c.api.bestMove('next')),b=await sent(c,2);b.answer(0,'up');await success(next,'up');
  });
  await test('ошибка terminate не запускает параллельный worker до подтверждённого exit',async()=>{
    const c=context(),p=observe(c.api.bestMove('stop')),a=await sent(c);a.emit('error',new Error('failed'));await tick();a.stop.reject(new Error('terminate failed'));
    await rejected(p);await tick();assert.equal(c.workers.length,1);
    const blocked=observe(c.api.bestMove('blocked'));await rejected(blocked);assert.equal(c.workers.length,1);
    a.emit('exit',1);const next=observe(c.api.bestMove('after exit')),b=await sent(c,2);b.answer(0,'down');await success(next,'down');
  });
  await test('настоящий постоянный worker считает ходы, основной поток не загружает solver',async()=>{
    const solver=path.join(ROOT,'src/modules/game2048.js');
    assert.equal(require.cache[solver],undefined);
    const engine=require(path.join(ROOT,'src/modules/game2048Worker.js'));
    const cases=[{board:Array.from({length:4},()=>[0,0,0,0]),dir:null},
      {board:[[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],dir:'down'},
      {board:[[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]],dir:null}];
    for(const c of cases){const result=await engine.bestMove(c.board);assert.equal(result.dir,c.dir);assert(Number.isFinite(result.ms)&&result.ms>=0);}
    assert.equal(require.cache[solver],undefined,'solver загружен основным потоком');
  });
}
const watchdog=setTimeout(()=>{console.error('FAIL: timeout в regression worker');process.exit(1);},30000);
main().then(()=>console.log('PASS: восстановление worker без основного WASM и потери запросов')).catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
