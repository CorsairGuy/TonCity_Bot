'use strict';
// Русские названия предметов прямо из локализации игры.
//
// Зачем: каталог (/storage/allitemdata, utils/itemCatalog.js) отдаёт только слаг вида предмета
// (rare, policy_epic, reform_stone_mythic…), а панель собирала из него имя по своей ручной таблице.
// Новые предметы появляются с каждым событием, таблица отставала — и в панели всплывали «#43»/слаги.
// Локализация игры лежит прямо в JS-бандле (entry-*.js, ru-сообщения vue-i18n в скомпилированном
// виде {t:0,b:{t:2,i:[{t:3}],s:"Текст"}}), отдаётся без авторизации — берём названия оттуда.
//
// Разделы локали, нужные для названий (сверено с бандлом 14.10.2026):
//   boosters{rarities{<rarity>},suffix}               → «Редкий ускоритель»
//   booster_packs{types{<type>},suffix,policy_suffix} → «Летний набор», «Редкий набор политик»
//   policy_shards{types{<rarity>},name}               → «Редкий осколок»
//   mystery_policies{types{<rarity>},name}            → «Редкая тайная политика»
//   consumables{types{<slug>}}                        → «Камень реформ (эпический)»
//   masterplans/components/snowflakes/tickets{name}   → «Мастерплан», «Компонент», …
// Заодно берём справочник id→{name,type} из chunks/storage-*.js (см. extractItems).
// Кэш — config/items-locale.json (вне src/, чтобы nodemon не перезапускал бота).
const fs=require('fs'),path=require('path');
const https=require('https');
const logger=require('./logger');

const FILE=path.join(process.cwd(),'config','items-locale.json');
const BASE='https://game.toncity.io';
const TTL_MS=24*60*60*1000;
const SECTIONS={
  boosters:'rarities',booster_packs:'types',policy_shards:'types',mystery_policies:'types',
  consumables:'types',masterplans:'name',components:'name',snowflakes:'name',tickets:'name',
};
let inFlight=null,cache=null;

function get(url){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'user-agent':'Mozilla/5.0','accept-language':'ru'}},res=>{
      if(res.statusCode!==200){res.resume();return reject(new Error(`HTTP ${res.statusCode} ${url}`));}
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(60_000,()=>req.destroy(new Error('таймаут')));
    req.on('error',reject);
  });
}

// ── мини-парсер JS-литерала объекта (только {} [] строки числа идентификаторы) ─────────────────
function parseLiteral(s,pos){
  let i=pos;
  const ws=()=>{while(i<s.length&&/\s/.test(s[i]))i++;};
  const str=()=>{
    const q=s[i++];let out='';
    while(i<s.length&&s[i]!==q){
      if(s[i]==='\\'){
        const n=s[i+1];
        if(n==='u'){out+=String.fromCharCode(parseInt(s.substr(i+2,4),16));i+=6;continue;}
        out+=({n:'\n',t:'\t',r:'\r'})[n]??n;i+=2;continue;
      }
      out+=s[i++];
    }
    i++;return out;
  };
  const word=()=>{const m=/^[!$\w.]+/.exec(s.slice(i,i+64));if(!m)throw new Error(`неожиданный символ «${s[i]}» на ${i}`);i+=m[0].length;return m[0];};
  const val=()=>{
    ws();const c=s[i];
    if(c==='{'){
      i++;const o={};
      for(;;){
        ws();if(s[i]==='}'){i++;return o;}
        const k=(s[i]==='"'||s[i]==="'")?str():word();
        ws();if(s[i++]!==':')throw new Error(`ожидалось «:» на ${i-1}`);
        o[k]=val();ws();
        if(s[i]===','){i++;continue;}
        if(s[i]==='}'){i++;return o;}
        throw new Error(`ожидалось «,» или «}» на ${i}`);
      }
    }
    if(c==='['){
      i++;const a=[];
      for(;;){
        ws();if(s[i]===']'){i++;return a;}
        a.push(val());ws();
        if(s[i]===','){i++;continue;}
        if(s[i]===']'){i++;return a;}
        throw new Error(`ожидалось «,» или «]» на ${i}`);
      }
    }
    if(c==='"'||c==="'")return str();
    const w=word();
    return /^-?\d/.test(w)?Number(w):w;
  };
  return val();
}

// скомпилированное сообщение vue-i18n {t:0,b:{s:"…"}} → строка; вложенные разделы — рекурсивно
function simplify(v){
  if(!v||typeof v!=='object'||Array.isArray(v))return v;
  if('t' in v&&'b' in v){
    const b=v.b;
    if(typeof b?.s==='string')return b.s;
    return null; // сообщение с подстановками — для названий предметов не бывает
  }
  const o={};
  for(const [k,x] of Object.entries(v))o[k]=simplify(x);
  return o;
}

const hasCyr=o=>/[а-яё]/i.test(JSON.stringify(o));

// В бандле каждая локаль (ru/en/…) — свой объект, поэтому один раздел встречается несколько раз.
// Берём вхождение с нужным подразделом и кириллицей; чужие одноимённые объекты отсеются по форме.
function extract(js){
  const out={};
  for(const [sec,need] of Object.entries(SECTIONS)){
    const re=new RegExp(`[{,]${sec}:\\{`,'g');let m;
    while((m=re.exec(js))){
      try{
        const obj=simplify(parseLiteral(js,m.index+sec.length+2));
        if(obj&&obj[need]!=null&&hasCyr(obj)){out[sec]=obj;break;}
      }catch(_){/* не наш объект — ищем дальше */}
    }
  }
  return out;
}

// Справочник предметов клиента игры: chunks/storage-*.js, функция вида ({0:{name:"common",type:"booster"},…})[id].
// В нём ВСЕ предметы, а не только те, что лежат на складе у наших аккаунтов (/storage/allitemdata).
function extractItems(js){
  const m=/\(\{0:\{name:"/.exec(js);
  if(!m)return null;
  try{
    const obj=parseLiteral(js,m.index+1);
    const out={};
    for(const [id,v] of Object.entries(obj))if(v&&typeof v==='object'&&v.name&&v.type)out[id]={name:v.name,type:v.type};
    return Object.keys(out).length?out:null;
  }catch(_){return null;}
}

async function refresh(){
  const html=await get(BASE+'/');
  const entry=(html.match(/\/_nuxt\/[^"'\s]*entry-[^"'\s]*\.js/)||[])[0];
  if(!entry)throw new Error('не найден entry-*.js на главной странице игры');
  const entryJs=await get(BASE+entry);
  const loc=extract(entryJs);
  const n=Object.keys(loc).length;
  if(n<5)throw new Error(`в бандле найдено только ${n} разделов локали (${Object.keys(loc).join(',')||'ни одного'})`);
  // справочник id→{name,type} — в одном из чанков склада; не нашли — живём на каталоге аккаунтов
  let items=null;
  const chunks=[...new Set(entryJs.match(/[./\w-]*chunks\/storage-[\w-]+\.js/g)||[])];
  for(const c of chunks){
    try{items=extractItems(await get(new URL(c,BASE+entry).href));}
    catch(e){logger.warn(`[items] чанк ${c}: ${e.message}`);}
    if(items)break;
  }
  if(!items)logger.warn('[items] справочник предметов в чанках склада не найден — названия только по каталогу аккаунтов');
  const data={entry,updated_at:new Date().toISOString(),sections:loc,items};
  fs.writeFileSync(FILE,JSON.stringify(data,null,1),'utf8');
  cache=data;
  logger.info(`[items] локализация предметов из бандла игры обновлена (${entry}, разделов: ${n}, предметов в справочнике: ${items?Object.keys(items).length:0})`);
  return data;
}

function read(){
  if(cache)return cache;
  try{cache=JSON.parse(fs.readFileSync(FILE,'utf8'));}catch(_){cache=null;}
  return cache;
}

function ageMs(){
  try{return Date.now()-fs.statSync(FILE).mtimeMs;}catch(_){return Infinity;}
}

// не бросает: не получилось — работаем на старой копии (или на запасной таблице клиента)
async function ensureFresh(){
  if(ageMs()<TTL_MS)return false;
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try{await refresh();return true;}
    catch(e){logger.warn(`[items] не удалось обновить локализацию предметов: ${e.message}`);return false;}
    finally{inFlight=null;}
  })();
  return inFlight;
}

// Предметы из справочника клиента игры в формате каталога (utils/itemCatalog.js).
function bundleItems(){
  const it=read()?.items;
  if(!it)return [];
  return Object.entries(it).map(([id,v])=>({item_id:Number(id),type:v.type,name:v.name,rarity:null}));
}

// Название предмета каталога {type,name} так же, как его собирает игра. null — не нашли.
function titleOf(it){
  const L=read()?.sections;
  if(!L||!it)return null;
  const slug=it.name||'';
  switch(it.type){
    case 'booster':{
      const r=L.boosters?.rarities?.[slug];
      return r&&L.boosters.suffix?`${r} ${L.boosters.suffix}`:null;
    }
    case 'booster_pack':{
      const t=L.booster_packs?.types?.[slug];
      const suf=slug.startsWith('policy_')?L.booster_packs?.policy_suffix:L.booster_packs?.suffix;
      return t&&suf?`${t} ${suf}`:null;
    }
    case 'policy_shard':return L.policy_shards?.types?.[slug.replace(/^shard_/,'')]||null;
    case 'mystery_policy':return L.mystery_policies?.types?.[slug.replace(/^mystery_/,'')]||null;
    case 'consumable':return L.consumables?.types?.[slug]||null;
    case 'masterplan':return L.masterplans?.name||null;
    case 'component':return L.components?.name||null;
    case 'snowflake':return L.snowflakes?.name||null;
    case 'ticket':return L.tickets?.name||null;
    default:return L.consumables?.types?.[slug]||null;
  }
}

module.exports={refresh,ensureFresh,read,ageMs,titleOf,bundleItems,extract,extractItems};
