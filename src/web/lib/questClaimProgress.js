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

// обёртка: begin → fn() → end, с гарантией end даже при исключении. Если заклейм этого квеста уже
// идёт, второй вызов НЕ шлёт свой запрос, а ждёт результата первого (тот же промис): иначе
// параллельные заклеймы (три клика подряд, каждый со своим автозаклеймом, + ручная кнопка + цикл)
// бьют в игру одновременно, первый забирает награду, а остальные получают 400 и шумят ретраями.
const running=new Map();       // `${account}:${questId}` -> Promise
function track(account,questId,source,fn){
  const k=keyOf(account,questId);
  if(running.has(k))return running.get(k);
  begin(account,questId,source);
  const p=(async()=>{
    try{const r=await fn();end(account,questId,true);return r;}
    catch(e){end(account,questId,false,e?.message);throw e;}
    finally{running.delete(k);}
  })();
  running.set(k,p);
  return p;
}

// Заклейм гильд-квеста с правильной обработкой 400. Игра отвечает одним и тем же 400 «Предоставлены
// неверные входные данные» и когда награда УЖЕ забрана, и в гонке на свежевыполненном квесте (живьём
// 30.07.2026: следующая попытка проходит). Поэтому после 400 смотрим на сам квест: is_collected —
// это успех (already:true), без ретраев и WARN; не забран — пробуем ещё раз. Повтор после «игра не
// ответила» не делаем: запрос мог выполниться. opts.post — свой способ отправить POST (цикл
// capital.js шлёт его под globalLock), opts.guildId — чтобы не спрашивать гильдию лишний раз.
// Возвращает {result} или {already:true}; бросает, если награду так и не удалось забрать.
function claim(api,account,questId,source,opts={}){
  const post=opts.post||(()=>api.post(`/guild-quests/collect/${questId}`,{}));
  const attempts=opts.attempts||3;
  return track(account,questId,source,async()=>{
    const logger=require('../../utils/logger');
    const{sleep,isNoAnswerError}=require('../../utils/helpers');
    let guildId=opts.guildId?String(opts.guildId):'';
    const isCollected=async()=>{
      try{
        if(!guildId){const g=await api.get('/users/me/guild');guildId=String(g?.guild?.id||'');}
        if(!guildId)return false;
        const d=await api.get(`/guild-quests/guild/${guildId}`);
        return !!(d?.quests||[]).find(x=>String(x.id)===String(questId))?.is_collected;
      }catch(_){return false;}
    };
    for(let i=1;;i++){
      try{return{result:await post()};}
      catch(e){
        if(isNoAnswerError(e))throw e;
        if(e?.response?.status!==400&&e?.status!==400)throw e;
        if(await isCollected())return{already:true};
        if(i>=attempts)throw e;
        logger.info(`[${account}] [quest] заклейм ${questId}: игра ответила 400, награда ещё не забрана — повтор ${i}/${attempts-1}`);
        await sleep(2000);
      }
    }
  });
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

module.exports={begin,end,track,claim,list,subscribe};
