'use strict';
const logger=require('./logger');
// setTimeout хранит задержку 32-битным int: всё, что больше ~2.147e9 мс (~24.8 суток),
// ПЕРЕПОЛНЯЕТСЯ и таймер срабатывает НЕМЕДЛЕННО. Живой случай 11.08: stakingLoop посчитал паузу
// 40708 мин (2.44e9 мс) до ближайшего вклада, sleep вернулся мгновенно — цикл закрутился вхолостую
// и залил лог сотнями строк в одну секунду. Поэтому длинные паузы режем на куски.
const MAX_TIMEOUT=2147483647;
const sleep=async ms=>{
  let left=Number(ms)||0;
  while(left>0){
    const chunk=Math.min(left,MAX_TIMEOUT);
    await new Promise(r=>setTimeout(r,chunk));
    left-=chunk;
  }
};
function isDifferentDay(iso){
  if(!iso)return true;
  const d=new Date(iso),n=new Date();
  return!(d.getUTCFullYear()===n.getUTCFullYear()&&d.getUTCMonth()===n.getUTCMonth()&&d.getUTCDate()===n.getUTCDate());
}
// Ответа от игры НЕ БЫЛО (таймаут/обрыв). Такую ошибку формирует api/client.js — по ней видно,
// что запрос мог дойти и быть обработанным, просто ответ потерялся.
const isNoAnswerError=e=>/нет ответа от сервера/i.test(String(e?.message||''));

// retries — сколько ПОПЫТОК всего. opts.skipOnNoAnswer=true запрещает повтор, когда игра не
// ответила: для изменяющих запросов (заклейм, взнос, улучшение) молчание НЕ значит «не выполнено»,
// игра такие запросы обрабатывает, и повтор сделал бы действие дважды. Чтение повторять можно и
// нужно — этим занимается сам api/client.js, здесь остаются только доменные ретраи (напр. гонка
// игры, отвечающей 400 на первый заклейм).
async function withRetry(fn,retries=3,delay=2000,label='op',opts={}){
  for(let i=0;i<retries;i++){
    try{return await fn();}
    catch(e){
      if(i===retries-1)throw e;
      if(opts.skipOnNoAnswer&&isNoAnswerError(e)){
        logger.warn(`[${label}] игра не ответила — повтор НЕ делаю (запрос мог быть выполнен)`);
        throw e;
      }
      logger.warn(`[${label}] retry ${i+1}: ${e.message}`);
      await sleep(delay);
    }
  }
}
function textToNumber(s){
  if(typeof s==='number')return s;
  const v=String(s).trim().toUpperCase(),n=parseFloat(v.replace(/[KMBT]/g,''));
  if(v.endsWith('T'))return n*1e12;if(v.endsWith('B'))return n*1e9;
  if(v.endsWith('M'))return n*1e6;if(v.endsWith('K'))return n*1e3;return n;
}
function fmt(n){const v=Number(n);if(v>=1e9)return(v/1e9).toFixed(1).replace(/\.0$/,'')+'B';if(v>=1e6)return(v/1e6).toFixed(1).replace(/\.0$/,'')+'M';if(v>=1e3)return(v/1e3).toFixed(1).replace(/\.0$/,'')+'K';return String(Math.round(v));}
function msUntilUtcMidnight(){
  const now=new Date();
  const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,0,0,10));
  return next-now;
}
async function sleepUntilUtcMidnight(){
  const ms=msUntilUtcMidnight();
  const h=Math.round(ms/3600000*10)/10;
  logger.info(`[daily] следующий запуск через ${h}ч (00:00:10 UTC)`);
  await sleep(ms);
}
module.exports={sleep,isDifferentDay,withRetry,isNoAnswerError,textToNumber,fmt,sleepUntilUtcMidnight};
