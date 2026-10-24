'use strict';
// Общий поток событий бота для всех открытых вкладок панели (SSE GET /api/events). Всё, что вкладки
// раньше узнавали опросом, бот шлёт сам и сразу:
//   build       — какой процесс отвечает (commit, startedAt) и ход обновления (обновлятель занят,
//                 этап, прогресс скачивания); новый startedAt после перезапуска = панель перезагружается;
//   maintenance — техработы игры (utils/maintenance.js status());
//   version     — каждая свежая проверка GitHub (utils/versionCheck.js events), её делает только бот.
// Браузер держит одно соединение на все вкладки (client/src/serverEvents.worker.ts), поэтому лимит
// в 6 соединений на сайт не съедается. Состояние обновлятеля и техработ — локальные файл и флаг:
// сверяем их раз в TICK_MS и только пока кто-то подключён, наружу ничего не запрашиваем.
const logger=require('../../utils/logger');

// время запуска процесса — ОДНО значение на процесс для /api/events, /api/build и /api/version:
// посчитанные отдельно в разных модулях, они расходились на миллисекунду из-за округления uptime,
// и панель принимала это за перезапуск бота и перезагружалась
const STARTED=Date.now()-Math.round(process.uptime()*1000);
const TICK_MS=1500;
const PING_MS=25*1000;
const subs=new Set();
let last={},timer=null,versionPayload=null,versionHooked=false;

function snapshot(){
  const u=require('../../utils/selfUpdate').updaterInfo(),l=u.busy&&u.last;
  return{
    build:{commit:process.env.APP_COMMIT||null,startedAt:STARTED,busy:u.busy,
      update:l?{state:l.state,message:l.message||null,progress:l.progress||null}:null},
    maintenance:require('../../utils/maintenance').status(),
  };
}

function write(res,type,data){
  try{res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);}catch(_){}
}
function publish(type,data){
  last[type]=JSON.stringify(data);
  for(const res of subs)write(res,type,data);
}

// изменилось состояние обновлятеля или техработ — разослать (retryInMs у техработ тикает, не в счёт)
function tick(){
  let s;
  try{s=snapshot();}catch(e){logger.warn(`[panel-events] ${e.message}`);return;}
  if(JSON.stringify(s.build)!==last.build)publish('build',s.build);
  const m={active:s.maintenance.active,since:s.maintenance.since};
  if(JSON.stringify(m)!==last.maintenance)publish('maintenance',m);
}

// payload — функция «ответ проверки → то, что отдаёт /api/version» (из routes/core.js)
function hookVersion(payload){
  versionPayload=payload;
  if(versionHooked)return;
  versionHooked=true;
  require('../../utils/versionCheck').events.on('checked',v=>{
    if(!subs.size)return;
    try{publish('version',versionPayload(v));}catch(e){logger.warn(`[panel-events] version: ${e.message}`);}
  });
}

function handler(req,res){
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  if(res.flushHeaders)res.flushHeaders();
  // после перезапуска бота браузер переподключается через 2 с и получает новый startedAt
  res.write('retry: 2000\n\n');
  subs.add(res);
  // новому подписчику — текущее состояние целиком
  try{
    const s=snapshot();
    write(res,'build',s.build);
    write(res,'maintenance',{active:s.maintenance.active,since:s.maintenance.since});
    last.build=JSON.stringify(s.build);
    last.maintenance=JSON.stringify({active:s.maintenance.active,since:s.maintenance.since});
  }catch(e){logger.warn(`[panel-events] ${e.message}`);}
  // версия — из кэша бота; если кэш устарел, бот сам сходит на GitHub, и свежий результат придёт
  // этому подписчику вместе со всеми через событие checked
  if(versionPayload)require('../../utils/versionCheck').getVersionInfo()
    .then(v=>{if(v.cached&&subs.has(res))write(res,'version',versionPayload(v));}).catch(()=>{});
  if(!timer)timer=setInterval(tick,TICK_MS);
  const ping=setInterval(()=>{try{res.write(': ping\n\n');}catch(_){}},PING_MS);
  req.on('close',()=>{
    clearInterval(ping);
    subs.delete(res);
    if(!subs.size&&timer){clearInterval(timer);timer=null;}
  });
}

module.exports={handler,hookVersion,STARTED};
