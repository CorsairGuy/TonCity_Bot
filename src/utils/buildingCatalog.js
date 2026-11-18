'use strict';
// Живой каталог городских зданий (цены/приросты) — берём его У ИГРЫ, а не из статичного
// config/buildings.txt.
//
// Зачем: цены в каталоге меняются событиями. На «Летнем карнавале» (10-23.08.2026) действует
// скидка −75% на постройку и улучшение города, и клиентская формула игры её НЕ содержит (в бандле
// у цены есть только множители политик buildCostMultiplier/upgradeCostMultiplier) — значит скидку
// отдаёт сервер прямо в каталоге. Пока мы считали по файлу, снятому до события, бот выбирал цели
// по ЧЕТЫРЕХКРАТНО завышенным ценам: «дорогое» улучшение казалось недоступным, а деньги копились
// впустую. Тот же класс проблемы, что с потолком времени улучшения (см. cityStats.upgradeTimeCapSec).
//
// Файл config/buildings.txt остаётся фолбэком: если игра недоступна, считаем по нему.
const fs=require('fs'),path=require('path');
const logger=require('./logger');

const LIVE_FILE=path.join(process.cwd(),'config','buildings-live.json');
const OBSERVED_FILE=path.join(process.cwd(),'config','buildings-observed.json');
const TTL_MS=6*60*60*1000;      // как часто переспрашивать игру
let inFlight=null;

function liveAgeMs(){
  try{return Date.now()-fs.statSync(LIVE_FILE).mtimeMs;}catch(_){return Infinity;}
}
function liveFile(){return LIVE_FILE;}

// Ответы каталога могут различаться: сохраняем ранее увиденные записи отдельно от
// действующего каталога цен и доступности. Последний ответ имеет приоритет по совпадающим id.
function mergeObserved(...lists){
  const map=new Map();
  for(const list of lists)if(Array.isArray(list))for(const item of list)if(item&&typeof item.id==='string')map.set(item.id,item);
  return [...map.values()];
}
function readList(file){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(data)?data:[];}catch(_){return[];}}
function statisticsFallback(live){
  const fallback=readList(path.join(process.cwd(),'config','buildings.txt'));
  const observed=readList(OBSERVED_FILE);
  const ids=new Set((Array.isArray(live)?live:[]).map(b=>b.id));
  return mergeObserved(fallback,observed).filter(b=>!ids.has(b.id));
}

// Ответ игры: либо массив зданий, либо {buildings:[...], factors:{...}} — принимаем оба вида и
// проверяем, что это действительно каталог (есть id и base_price), чтобы не затереть фолбэк мусором.
function extractList(raw){
  const list=Array.isArray(raw)?raw:(Array.isArray(raw?.buildings)?raw.buildings:null);
  if(!Array.isArray(list)||list.length<10)return null;
  const ok=list.filter(b=>b&&typeof b.id==='string'&&b.base_price!=null).length;
  return ok>=Math.floor(list.length*0.9)?list:null;
}

async function refresh(api){
  // ВАЖНО: путь именно со слэшем на конце — в бандле он такой (buildings:"/buildings/"), а на
  // '/buildings' игра отвечает 500. Из-за этой опечатки каталог не обновлялся НИ РАЗУ за весь
  // ивент (в логе только «не удалось обновить каталог»), и бот считал цены по статичному
  // config/buildings.txt — то есть ВЧЕТВЕРО выше реальных при скидке −75%. Отсюда «пропускает
  // улучшения, хотя монет хватает».
  const raw=await api.get('/buildings/');
  const list=extractList(raw);
  if(!list)throw new Error('ответ /buildings не похож на каталог зданий');
  // Не затираем повреждённый архив: его можно восстановить вручную.
  let previous=[];
  if(fs.existsSync(OBSERVED_FILE)){
    previous=JSON.parse(fs.readFileSync(OBSERVED_FILE,'utf8'));
    if(!Array.isArray(previous))throw new Error('повреждён архив каталога зданий');
  }
  const observed=mergeObserved(previous,readList(LIVE_FILE),list);
  fs.writeFileSync(OBSERVED_FILE,JSON.stringify(observed,null,1),'utf8');
  fs.writeFileSync(LIVE_FILE,JSON.stringify(list,null,1),'utf8');
  require('../web/cityStats').invalidateBuildingsMap();
  const sample=list.find(b=>b.base_price>0);
  logger.info(`[buildings] каталог обновлён с игры: ${list.length} зданий (напр. ${sample?.id} = ${sample?.base_price})`);
  return list.length;
}

// Каталог обновляется кнопкой и автоматическим ensureFresh из цикла прокачки.

// ensureExists получает каталог при первом запуске без файла.

async function ensureExists(api){
  if(liveAgeMs()!==Infinity)return false;      // файл есть — ничего не делаем
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try{await refresh(api);return true;}
    catch(e){logger.warn(`[buildings] не удалось получить каталог: ${e.message}`);return false;}
    finally{inFlight=null;}
  })();
  return inFlight;
}

// Устаревшее авто-обновление по TTL. Оставлено для совместимости, но нигде не вызывается.
async function ensureFresh(api){
  if(liveAgeMs()<TTL_MS)return false;
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try{await refresh(api);return true;}
    catch(e){logger.warn(`[buildings] не удалось обновить каталог: ${e.message}`);return false;}
    finally{inFlight=null;}
  })();
  return inFlight;
}

module.exports={refresh,ensureExists,ensureFresh,liveFile,liveAgeMs,mergeObserved,statisticsFallback};
