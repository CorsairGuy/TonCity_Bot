'use strict';
// Живой каталог зданий столицы: GET /capitals/buildings/ (как у клиента игры, стор capital-buildings
// в entry-*.js). Цены, лимиты, is_purchasable и hall_lvl_required приходят оттуда же, что и у игры.
// Обновляется только кнопкой «Обновить» (модуль buildings в routes/refresh.js), хранится в
// config/capital-buildings-live.json; статичный config/capital_buildings.txt — фолбэк.
const fs=require('fs'),path=require('path');
const logger=require('./logger');
const LIVE_FILE=path.join(process.cwd(),'config','capital-buildings-live.json');
const STATIC_FILE=path.join(process.cwd(),'config','capital_buildings.txt');
let cache=null,cacheKey=null;

function extractList(raw){
  const list=Array.isArray(raw)?raw:(Array.isArray(raw?.buildings)?raw.buildings:null);
  if(!Array.isArray(list)||list.length<5)return null;
  const ok=list.filter(b=>b&&typeof b.id==='string'&&b.id.startsWith('CAP_')&&b.base_price!=null).length;
  return ok>=Math.floor(list.length*0.9)?list:null;
}
async function refresh(api){
  const list=extractList(await api.get('/capitals/buildings/'));
  if(!list)throw new Error('ответ /capitals/buildings/ не похож на каталог столицы');
  fs.writeFileSync(LIVE_FILE,JSON.stringify(list,null,1),'utf8');
  cache=null;
  logger.info(`[capital] каталог столицы обновлён с игры: ${list.length} зданий`);
  return list.length;
}
// список зданий столицы: живой, иначе статичный (с кэшем по mtime файла)
function list(){
  for(const fp of[LIVE_FILE,STATIC_FILE]){
    try{
      const key=fp+':'+fs.statSync(fp).mtimeMs;
      if(cache&&cacheKey===key)return cache;
      const l=JSON.parse(fs.readFileSync(fp,'utf8'));
      if(Array.isArray(l)&&l.length){cache=l;cacheKey=key;return l;}
    }catch(_){}
  }
  return[];
}
module.exports={refresh,list,LIVE_FILE};
