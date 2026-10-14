'use strict';
// Реестр ИДУЩИХ ПРЯМО СЕЙЧАС автозаклеймов гильд-квестов + SSE-раздача этого состояния странице
// «Квесты». Задача: пользователь не должен гадать, нажимать ли «Заклеймить» — если заклейм уже
// запущен (автоматикой после активации/комбинирования ускорителя или фоновым циклом capital.js),
// кнопка показывает это состояние и не даёт ткнуть второй раз в тот же квест.
//
// Тот же приём, что в adsProgress.js/quizProgress.js: реестр общий на процесс и живёт независимо от
// конкретного SSE-соединения, поэтому состояние переживает перезагрузку страницы (новый подписчик
// сразу получает снимок текущих заклеймов). Ключ — имя аккаунта + id квеста: заклейм бывает и из
// фонового цикла, где есть только имя аккаунта (accountId там не прокидывается).
const inflight=new Map();      // `${account}:${questId}` -> {account,quest_id,source,startedAt}
const subscribers=new Set();   // Response — общий поток на всю страницу, не по аккаунтам

const keyOf=(account,questId)=>`${account}:${questId}`;

function broadcast(data){
  const line=`data: ${JSON.stringify(data)}\n\n`;
  for(const res of subscribers){try{res.write(line);}catch(_){}}
}

function list(){return[...inflight.values()];}

// source — откуда пришёл заклейм: 'action' (после активации/комбинирования по кнопке) | 'loop'
// (фоновый цикл). Показываем в подсказке кнопки, чтобы было понятно, кто именно уже забирает.
function begin(account,questId,source){
  const k=keyOf(account,questId);
  if(inflight.has(k))return false;   // уже идёт — второй раз не запускаем и не шумим в SSE
  const entry={account,quest_id:questId,source:source||'action',startedAt:Date.now()};
  inflight.set(k,entry);
  broadcast({type:'begin',...entry});
  return true;
}

function end(account,questId,ok,error){
  const k=keyOf(account,questId);
  if(!inflight.has(k))return;
  inflight.delete(k);
  broadcast({type:'end',account,quest_id:questId,ok:!!ok,error:error||null});
}

// обёртка: begin → fn() → end, с гарантией end даже при исключении
async function track(account,questId,source,fn){
  begin(account,questId,source);
  try{const r=await fn();end(account,questId,true);return r;}
  catch(e){end(account,questId,false,e?.message);throw e;}
}

function subscribe(res){
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders?.();
  subscribers.add(res);
  // снимок текущего состояния сразу — иначе после F5 страница не знала бы про уже идущие заклеймы
  res.write(`data: ${JSON.stringify({type:'snapshot',items:list()})}\n\n`);
  const ping=setInterval(()=>{try{res.write(': ping\n\n');}catch(_){}},25000);
  const close=()=>{clearInterval(ping);subscribers.delete(res);};
  res.on('close',close);
  res.on('error',close);
}

module.exports={begin,end,track,list,subscribe};
