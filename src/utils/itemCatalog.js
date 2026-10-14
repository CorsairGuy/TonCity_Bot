'use strict';
// Каталог предметов игры (id → тип/имя/редкость) + их картинки.
//
// Зачем: id новых предметов мы заранее не знаем (игра добавляет их с каждым событием — билеты,
// летний/алмазный набор, камни реформ, чертёж), а панель показывала такие награды как «#40».
// Спрашиваем каталог у самой игры (GET /storage/allitemdata) и складываем в config/items-live.json,
// иконки качаем из ассетов игры в items-live/<item_id>.png (раздаётся как /items/live, см. server.js).
//
// 13.10.2026: раньше иконки качались в src/items/live/ — это ПОД src/, которую nodemon отслеживает
// (watch:["src",".env"], legacyWatch:true — полный опрос файлов, нужен из-за сетевого диска). Новый
// файл под src/ заставляет nodemon перезапустить весь процесс бота — при докачке иконки НОВОГО
// предмета (появляется только с обновлениями игры, редко) это била бы настоящую перезагрузку панели
// без видимой причины. Не основная причина частого зависания после рекламы+сапёра (это бывает
// слишком часто для раз-в-полгода события) — но латентный баг сам по себе, поэтому вынесено не
// дожидаясь локализации основной причины. Доказано датой файла: items/live/6.png докачан 04.10, на
// 6 дней позже остальной партии от 27.09 — докачка реально происходит на лету в проде. Теперь
// каталог иконок лежит в items-live/ (корень проекта, рядом с logs/config/db_data) — вне зоны
// видимости nodemon, без изменения публичного URL (/items/live/<id>.png).
//
// Правила путей к картинкам сверены с бандлом (компонент иконки предмета):
//   masterplan → /assets/masterplans/masterplan.png      component  → /assets/components/component.png
//   snowflake  → /assets/snowflakes/snowflake.png        ticket     → /assets/tickets/ticket.png
//   booster_pack → /assets/booster_packs/<name>_v2.png   policy_shard → /assets/policies/shards/<name>.png
//   mystery_policy → /assets/policies/mystery/<name>.png consumable → /assets/consumables/<name>.png
//   booster → /assets/boosters/<name>.png                прочее → /assets/<name>.png
const fs=require('fs'),path=require('path');
const https=require('https');
const logger=require('./logger');

const FILE=path.join(process.cwd(),'config','items-live.json');
const ICON_DIR=path.join(process.cwd(),'items-live');
const BASE='https://game.toncity.io';
const TTL_MS=12*60*60*1000;
let inFlight=null,cache=null,cacheAt=0;

function assetPath(it){
  const n=it.name||'';
  switch(it.type){
    case 'masterplan':return '/assets/masterplans/masterplan.png';
    case 'component':return '/assets/components/component.png';
    case 'snowflake':return '/assets/snowflakes/snowflake.png';
    case 'ticket':return '/assets/tickets/ticket.png';
    case 'booster_pack':return `/assets/booster_packs/${n}_v2.png`;
    case 'policy_shard':return `/assets/policies/shards/${n}.png`;
    case 'mystery_policy':return `/assets/policies/mystery/${n}.png`;
    case 'consumable':return `/assets/consumables/${n}.png`;
    case 'booster':return `/assets/boosters/${n}.png`;
    default:return `/assets/${n}.png`;
  }
}

function download(url,dest){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{
      if(res.statusCode!==200){res.resume();return reject(new Error(`HTTP ${res.statusCode}`));}
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const buf=Buffer.concat(chunks);
        if(buf.length<100)return reject(new Error('пустой файл'));
        fs.writeFileSync(dest,buf);
        resolve(buf.length);
      });
    }).on('error',reject);
  });
}

// Форма ответа /storage/allitemdata заранее не известна и уже менялась: items бывает массивом,
// бывает объектом-словарём (ключ = id предмета), а сами записи — то плоскими, то с вложенными
// booster/booster_pack. Разбираем все варианты и, если ничего не вышло, пишем в лог реальные ключи
// ответа — иначе диагностика превращается в гадание (13.08 каталог молча не собирался).
function pickList(raw){
  const cand=[raw,raw?.items,raw?.data,raw?.data?.items,raw?.storage,raw?.all_item_data];
  // сначала ищем обычный массив предметов…
  for(const c of cand)if(Array.isArray(c)&&c.length)return c.map(v=>[null,v]);
  // …и только потом словарь вида {"35":{...}} (ключ — id предмета); значения-массивы пропускаем,
  // иначе за «словарь предметов» принимается сам ответ {items:[...]}
  const looksLikeItem=(k,v)=>Number.isFinite(Number(k))||v.item_id!=null||v.id!=null;
  for(const c of cand){
    if(!c||typeof c!=='object'||Array.isArray(c))continue;
    const entries=Object.entries(c).filter(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)&&looksLikeItem(k,v));
    if(entries.length)return entries;
  }
  return [];
}

function normalize(raw){
  const entries=pickList(raw);
  // Вид предмета игра отдаёт по-разному: у ускорителей он в booster.rarity, у наборов — в
  // booster_pack.type, и только у части предметов есть плоские поля name/type.
  return entries.map(([key,it])=>{
    const id=Number(it.item_id??it.id??key);
    if(!Number.isFinite(id))return null;
    return{
      item_id:id,
      type:it.type||(it.booster?'booster':it.booster_pack?'booster_pack':null),
      name:it.name||it.booster?.rarity||it.booster_pack?.type||null,
      rarity:it.rarity||it.booster?.rarity||it.booster_pack?.type||null,
    };
  }).filter(Boolean);
}

// картинки качаем только для тех предметов, которых ещё нет локально
async function fetchIcons(items){
  try{fs.mkdirSync(ICON_DIR,{recursive:true});}catch(_){}
  let got=0;
  for(const it of items){
    const dest=path.join(ICON_DIR,`${it.item_id}.png`);
    if(fs.existsSync(dest))continue;
    // без слага путь к картинке собрать не из чего — игра ответит 403 на .../null.png
    if(!it.name&&!['masterplan','component','snowflake','ticket'].includes(it.type||''))continue;
    try{await download(BASE+assetPath(it),dest);got++;}
    catch(e){logger.warn(`[items] иконка ${it.item_id} (${it.type}/${it.name}): ${e.message}`);}
  }
  return got;
}

// Точечного доразрешения по id БОЛЬШЕ НЕТ (убрано 19.08.2026). Раньше недостающие предметы
// спрашивались поштучно через GET /storage/items/{id} — но этот эндпоинт принимает id ЗАПИСИ
// в хранилище аккаунта, а не id предмета из каталога, и на каждый такой запрос игра отвечала
// 400 «Предоставлены неверные входные данные». Результат не кэшировался, поэтому каждая
// загрузка страницы устраивала шторм из ~30 бесполезных запросов, после которого игра давала
// 429 Rate limit — и он прилетал уже соседним разделам (магазин билетов, годовщина).
// Единственный корректный источник каталога — GET /storage/allitemdata (см. refresh ниже),
// он отдаёт и предметы, и наборы разом; названия предметов, которых нет ни на одном аккаунте,
// берутся из статической таблицы в клиенте (ITEMS_BY_ID в web/client/src/utils.ts).
// Ответ про ОДИН предмет может быть не списком, а объектом — собираем из него запись теми же
// правилами (вид лежит в booster/booster_pack/consumable/…, а не в плоском name).
function normalizeSingle(raw,id){
  const it=raw?.item&&typeof raw.item==='object'?{...raw,...raw.item}:raw;
  if(!it||typeof it!=='object')return null;
  let type=it.type||null,name=it.name||null;
  for(const [key,val] of Object.entries(it)){
    if(['offers','limit','item','sell_currency'].includes(key))continue;
    if(!val||typeof val!=='object'||Array.isArray(val))continue;
    const slug=val.name||val.type||val.rarity;
    if(!slug)continue;
    type=type||key;name=name||slug;break;
  }
  if(name&&name===type)name=null;
  return{item_id:Number(it.item_id??it.id??id),type,name,rarity:it.rarity||null};
}

let loggedItemSample=false;

async function refresh(api){
  const raw=await api.get('/storage/allitemdata');
  const items=normalize(raw);
  if(items.length<5){
    const keys=raw&&typeof raw==='object'?Object.keys(raw).join(','):typeof raw;
    const sample=JSON.stringify(pickList(raw)[0]?.[1]??raw).slice(0,300);
    throw new Error(`ответ /storage/allitemdata не похож на каталог предметов (ключи: ${keys}; пример записи: ${sample})`);
  }
  // Сливаем с уже известным: /storage/allitemdata отдаёт только то, чем владеет ЭТОТ аккаунт,
  // поэтому простая перезапись стирала бы предметы, известные от других аккаунтов (а именно так
  // названия и «терялись» — каталог зависел от того, чей аккаунт попался обновлению первым).
  const merged=new Map(read().map(x=>[x.item_id,x]));
  for(const it of items){
    const prev=merged.get(it.item_id);
    merged.set(it.item_id,prev?{...prev,...Object.fromEntries(Object.entries(it).filter(([,v])=>v!=null))}:it);
  }
  const all=[...merged.values()].sort((a,b)=>a.item_id-b.item_id);
  fs.writeFileSync(FILE,JSON.stringify(all,null,1),'utf8');
  cache=all;cacheAt=Date.now();
  const icons=await fetchIcons(all);
  logger.info(`[items] каталог обновлён: ${items.length} у аккаунта, всего известно ${cache.length}${icons?`, скачано иконок: ${icons}`:''}`);
  return items;
}

function read(){
  if(cache&&Date.now()-cacheAt<60_000)return cache;
  try{cache=JSON.parse(fs.readFileSync(FILE,'utf8'));cacheAt=Date.now();}
  catch(_){cache=cache||[];}
  return cache;
}

function ageMs(){
  try{return Date.now()-fs.statSync(FILE).mtimeMs;}catch(_){return Infinity;}
}

// не бросает: не получилось — работаем на том, что уже есть
async function ensureFresh(api){
  if(ageMs()<TTL_MS)return false;
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try{await refresh(api);return true;}
    catch(e){logger.warn(`[items] не удалось обновить каталог: ${e.message}`);return false;}
    finally{inFlight=null;}
  })();
  return inFlight;
}

module.exports={refresh,ensureFresh,read,ageMs};
