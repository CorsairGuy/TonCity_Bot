'use strict';
// Обновление и смена канала бота через обновлятель (сервис updater в docker-compose.yml,
// updater/updater.sh). Бот сам себя не перезапускает: он кладёт заявку «перейди на тег X» в
// config/updater/request.json, обновлятель скачивает образ, прописывает BOT_TAG в .env и
// пересоздаёт контейнер бота. Если образ новый, этот процесс получит SIGTERM ещё до конца ожидания —
// поэтому оборванный запрос панели = обновление идёт.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const logger=require('./logger');

const DIR=path.resolve(__dirname,'..','..','config','updater');
const REQ=path.join(DIR,'request.json');
const STATUS=path.join(DIR,'status.json');
const HEARTBEAT=path.join(DIR,'heartbeat.json');
const HISTORY=path.join(DIR,'history.json');
const ALIVE_MS=90*1000;          // обновлятель пишет heartbeat раз в 20 с
const BUSY_MS=20*60*1000;         // дольше заявка не идёт: скачивание + ожидание деплоя Portainer
const WAIT_MS=10*60*1000;        // скачивание образа на медленном канале
// версия updater/updater.sh в этом образе бота: обновлятель старше — панель просит обновить его вручную
const UPDATER_VERSION=7;
const TAG_RE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
let running=false;

const readJson=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(_){return null;}};
const writeJson=(f,v)=>{fs.mkdirSync(DIR,{recursive:true});fs.writeFileSync(f+'.tmp',JSON.stringify(v,null,2));fs.renameSync(f+'.tmp',f);};

// текущий тег образа: BOT_TAG приходит из .env (env_file), пусто — latest
const currentTag=()=>(process.env.BOT_TAG||'').trim()||'latest';

function updaterInfo(){
  const hb=readJson(HEARTBEAT);
  const at=hb&&Date.parse(hb.at);
  const last=readJson(STATUS);
  // заявка в работе (скачивание/деплой): обновлятель версии до 4 в это время не пишет пульс,
  // а сам бот вот-вот перезапустят — это не «обновлятель не запущен»
  const busy=!!(last&&(last.state==='pulling'||last.state==='restarting')&&Date.now()-Date.parse(last.at)<BUSY_MS);
  return{alive:!!(at&&Date.now()-at<ALIVE_MS),busy,heartbeatAt:hb?hb.at:null,version:hb?hb.version:null,outdated:!!(hb&&Number(hb.version||0)<UPDATER_VERSION),mode:hb&&hb.mode||null,last};
}
const isConfigured=()=>updaterInfo().alive;

// tag — новый тег (по умолчанию текущий: «скачать свежий образ этого же канала»)
async function requestSwitch(tag=currentTag(),reason='manual'){
  if(!TAG_RE.test(tag))throw new Error('недопустимый тег образа');
  if(!isConfigured())throw new Error('обновлятель не запущен: нужен сервис updater из docker-compose.yml (docker compose up -d)');
  if(running)throw new Error('обновление уже запущено');
  running=true;
  const id=crypto.randomBytes(8).toString('hex');
  logger.info(`[update] заявка обновлятелю: ${currentTag()} → ${tag} (${reason})`);
  try{
    writeJson(REQ,{id,tag,reason,from:{tag:currentTag(),commit:process.env.APP_COMMIT||null},ts:Math.floor(Date.now()/1000)});
    const started=Date.now();
    // ждём итог; при успешной смене образа сюда не дойдём — процесс остановят раньше
    while(Date.now()-started<WAIT_MS){
      await new Promise(r=>setTimeout(r,1500));
      const st=readJson(STATUS);
      if(!st||st.id!==id)continue;
      if(st.state==='error')throw new Error(st.message||'обновлятель не смог переключить версию');
      if(st.state==='unchanged'){logger.info(`[update] ${tag}: нового образа нет`);return{updated:0,tag};}
      if(st.state==='updated')return{updated:1,tag};
    }
    throw new Error('обновлятель не ответил за 10 минут, подробности — docker logs '+(process.env.STACK_NAME||'toncity')+'_updater');
  }finally{running=false;}
}

// история запущенных версий (для отката): пишется при старте, если коммит сменился
function recordStart(){
  const commit=(process.env.APP_COMMIT||'').trim();
  if(!commit)return;
  try{
    const h=readJson(HISTORY)||[];
    if(h[0]&&h[0].commit===commit)return;
    h.unshift({commit,ref:process.env.APP_REF||null,tag:currentTag(),at:new Date().toISOString()});
    writeJson(HISTORY,h.slice(0,15));
  }catch(e){logger.warn(`[update] история версий не записана: ${e.message}`);}
}
const history=()=>readJson(HISTORY)||[];

module.exports={isConfigured,updaterInfo,requestSwitch,requestUpdate:()=>requestSwitch(),currentTag,recordStart,history,TAG_RE};
