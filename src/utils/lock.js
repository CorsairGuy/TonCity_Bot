'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class AsyncLock{
  constructor(){this._l=false;this._q=[];}
  acquire(){return new Promise(r=>{if(!this._l){this._l=true;r();}else this._q.push(r);});}
  release(){if(this._q.length)this._q.shift()();else this._l=false;}
  async run(fn){await this.acquire();try{return await fn();}finally{this.release();}}
}
// Rate limiter: rps = max requests per second, concurrency = max simultaneous requests
class RateLimiter{
  constructor({rps=5,concurrency=3}={}){
    this._interval=1000/rps;
    this._concurrency=concurrency;
    this._running=0;
    this._queue=[];
    this._lastStart=0;
    this._timer=null;
  }
  _schedule(){
    if(this._timer||this._queue.length===0||this._running>=this._concurrency)return;
    const wait=Math.max(0,this._lastStart+this._interval-Date.now());
    this._timer=setTimeout(()=>{
      this._timer=null;
      if(this._queue.length===0||this._running>=this._concurrency)return;
      const resolve=this._queue.shift();
      this._running++;
      this._lastStart=Date.now();
      resolve();
      this._schedule();
    },wait);
  }
  acquire(){return new Promise(r=>{this._queue.push(r);this._schedule();});}
  release(){this._running--;this._schedule();}
  // КРИТИЧЕСКИЙ БАГ (найден 2026-07-17): apiLock — ОДИН общий лимитер (concurrency:1) на ВСЕ
  // аккаунты и ВСЕ модули разом. Раньше run() ждал fn() без тайм-аута — если хоть один запрос
  // зависал (не резолвился и не падал: например TCP-соединение застряло в состоянии, которое не
  // ловит даже axios timeout:30000 в api/client.js, потому что зависание случилось ДО реального
  // HTTP-запроса), release() не вызывался никогда, _running оставался на пределе навечно — и вся
  // очередь молча вставала для АБСОЛЮТНО ВСЕХ аккаунтов, без единой строки в логе (весь бот
  // выглядел просто "замолчавшим" — ровно это и наблюдалось: одновременная тишина у всех
  // аккаунтов с одной и той же секунды, без единой ошибки/рестарта). Теперь run() гарантированно
  // освобождает слот максимум через LOCK_TASK_TIMEOUT, даже если сам fn() так и не решится —
  // очередь остальных аккаунтов больше не может встать из-за одного зависшего запроса.
  async run(fn,timeoutMs=LOCK_TASK_TIMEOUT){
    await this.acquire();
    let timer;
    try{
      return await Promise.race([
        fn(),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`apiLock: задача не завершилась за ${timeoutMs}мс`)),timeoutMs);}),
      ]);
    }finally{
      clearTimeout(timer);
      this.release();
    }
  }
}
const LOCK_TASK_TIMEOUT=35000; // чуть больше axios timeout:30000 (api/client.js) — запас на случаи, когда зависание происходит до реального HTTP-запроса и собственный timeout axios не срабатывает
module.exports={AsyncLock,RateLimiter,globalLock:{run:fn=>fn()},apiLock:new RateLimiter({rps:2,concurrency:1})};
