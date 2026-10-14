'use strict';
const axios=require('axios');
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');
const {getConfig,loadSettings,saveSettings}=require('../config');

const QUERIES=[
  {key:'masterplan_c',   p:{categories:'masterplan',                      currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'masterplan_t',   p:{categories:'masterplan',                      currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'component_c',    p:{categories:'component',                       currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'b_mythic_c',     p:{categories:'booster',rarities:'mythic',       currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'b_mythic_t',     p:{categories:'booster',rarities:'mythic',       currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'b_legendary_c',  p:{categories:'booster',rarities:'legendary',    currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'b_legendary_t',  p:{categories:'booster',rarities:'legendary',    currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'b_epic_c',       p:{categories:'booster',rarities:'epic',         currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'p_eternal_c',    p:{categories:'pack',   rarities:'eternal',      currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'p_eternal_t',    p:{categories:'pack',   rarities:'eternal',      currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'p_mythic_c',     p:{categories:'pack',   rarities:'mythic',       currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'p_mythic_t',     p:{categories:'pack',   rarities:'mythic',       currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'p_legendary_c',  p:{categories:'pack',   rarities:'legendary',    currency:'crystals',sort:'price_asc',page:1,page_size:5}},
  {key:'p_legendary_t',  p:{categories:'pack',   rarities:'legendary',    currency:'ton',     sort:'price_asc',page:1,page_size:5}},
  {key:'p_epic_c',       p:{categories:'pack',   rarities:'epic',         currency:'crystals',sort:'price_asc',page:1,page_size:5}},
];

const I1='⠀⠀⠀';
const I2='⠀⠀⠀⠀⠀⠀';

function pickRandom(arr){return arr[Math.floor(Math.random()*arr.length)];}
// Выбираем случайный аккаунт, ПРОПУСКАЯ подтверждённо-мёртвые (refresh в кулдауне): на мёртвом
// запрос всё равно упадёт в «нет seed» и засорит лог. Если живых не осталось — берём любого (пусть
// сам решает по месту). api._accountId проставлен в фабрике клиента.
function pickLiveRandom(arr){
  const{isRefreshDead}=require('./session');
  const live=arr.filter(c=>{const id=c.api&&c.api._accountId;return id==null||!isRefreshDead(id);});
  return pickRandom(live.length?live:arr);
}

// ── Пер-аккаунтный лимит на /market/direct ──────────────────────────────────
// apiLock — ОДИН общий лимитер (2 rps) на все аккаунты, он НЕ мешает выбрать один и тот же аккаунт
// несколько запросов подряд. Сервер на это отвечает 403 "Direct API access is not allowed"
// (err.directDenied). Здесь держим два ограничителя ПО КАЖДОМУ аккаунту:
//   • кулдаун после отказа — провинившийся аккаунт не трогаем MKT_COOLDOWN_MS;
//   • минимальный интервал между двумя запросами одного аккаунта — MKT_MIN_GAP_MS.
const _mktCooldown=new Map(); // accountId -> ts(ms), до которого аккаунт не выбираем
const _mktLastHit=new Map();  // accountId -> ts(ms) последнего запроса к рынку с этого аккаунта
const MKT_COOLDOWN_MS=2*60*1000; // бан аккаунта после "direct denied" / прочего 403
const MKT_MIN_GAP_MS=6*1000;     // не чаще одного запроса в 6с с одного аккаунта

function mktAvailable(id){
  if(id==null)return true;
  const cd=_mktCooldown.get(id);
  if(cd&&cd>Date.now())return false;
  const last=_mktLastHit.get(id);
  if(last&&Date.now()-last<MKT_MIN_GAP_MS)return false;
  return true;
}
function mktPenalize(id,name){
  if(id==null)return;
  _mktCooldown.set(id,Date.now()+MKT_COOLDOWN_MS);
  logger.info(`[market-prices] [${name||('acc '+id)}] на кулдауне ${Math.round(MKT_COOLDOWN_MS/1000)}с (пер-аккаунт лимит рынка)`);
}
// Выбор аккаунта для рынка: живой + не на кулдауне + соблюдён min-gap + ещё не пробованный в этой
// серии попыток. Если под все условия никто не подходит — последовательно ослабляем требования,
// чтобы запрос всё же ушёл (лучше рискнуть 403, чем оставить категорию пустой).
function pickMarketAccount(clients,tried){
  const{isRefreshDead}=require('./session');
  const live=clients.filter(c=>{const id=c.api&&c.api._accountId;return id==null||!isRefreshDead(id);});
  let pool=live.filter(c=>{const id=c.api&&c.api._accountId;return mktAvailable(id)&&!tried.has(id);});
  if(!pool.length)pool=live.filter(c=>{const id=c.api&&c.api._accountId;return !tried.has(id);});
  if(!pool.length)pool=live.length?live:clients;
  return pickRandom(pool);
}

function minPrice(r,key){
  const offers=r.get(key);
  if(!offers||!offers.length)return null;
  return offers[0].display_price;
}

function priceLine(r,cKey,tKey,indent){
  const lines=[];
  const c=minPrice(r,cKey);
  const t=tKey?minPrice(r,tKey):null;
  if(c!=null)lines.push(`${indent}${c} crystals`);
  if(t!=null)lines.push(`${indent}${t} ton`);
  if(!lines.length)lines.push(`${indent}нет лотов`);
  return lines;
}

function formatMessage(r){
  const now=new Date();
  const msk=new Date(now.getTime()+3*60*60*1000);
  const day=msk.getUTCDate();
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const month=months[msk.getUTCMonth()];
  const h=String(msk.getUTCHours()).padStart(2,'0');
  const m=String(msk.getUTCMinutes()).padStart(2,'0');

  const lines=['Лучшие цены на рынке:',''];

  lines.push('мастерплан:');
  for(const l of priceLine(r,'masterplan_c','masterplan_t',I1))lines.push(l);
  lines.push('');

  lines.push('компонент:');
  for(const l of priceLine(r,'component_c',null,I1))lines.push(l);
  lines.push('');

  lines.push('мифический ускоритель:');
  for(const l of priceLine(r,'b_mythic_c','b_mythic_t',I1))lines.push(l);
  lines.push('');

  lines.push('легендарный ускоритель:');
  for(const l of priceLine(r,'b_legendary_c','b_legendary_t',I1))lines.push(l);
  lines.push('');

  lines.push('эпический ускоритель:');
  for(const l of priceLine(r,'b_epic_c',null,I1))lines.push(l);
  lines.push('');

  lines.push('зимний набор:');
  for(const l of priceLine(r,'p_eternal_c','p_eternal_t',I1))lines.push(l);
  lines.push('');

  lines.push('вечный набор:');
  for(const l of priceLine(r,'p_mythic_c','p_mythic_t',I1))lines.push(l);
  lines.push('');

  lines.push('ультимейт набор:');
  for(const l of priceLine(r,'p_legendary_c','p_legendary_t',I1))lines.push(l);
  lines.push('');

  lines.push('премиум набор:');
  for(const l of priceLine(r,'p_epic_c',null,I1))lines.push(l);
  lines.push('');

  lines.push(`${day} ${month} в ${h}:${m} [МСК]`);

  return lines.join('\n');
}

// Парсит текст сообщения в словарь {категория+подкатегория|валюта: цена}
function parsePrices(text){
  const prices={};
  if(!text)return prices;
  let category='',sub='';
  for(const line of text.split('\n')){
    const clean=line.trim().toLowerCase();
    if(!clean||clean.includes('нет лотов'))continue;
    const isCrystals=clean.includes(' crystals');
    const isTon=clean.includes(' ton');
    if(isCrystals||isTon){
      const currency=isCrystals?'crystals':'ton';
      const m=clean.replace(',','.').match(/(\d+(\.\d+)?)/);
      if(m)prices[category+sub+'|'+currency]=parseFloat(m[0]);
    }else if(clean.includes(':')){
      const name=clean.replace(':','').trim();
      if(!line.includes('⠀⠀⠀')){category=name;sub='';}
      else{sub=name;}
    }
  }
  return prices;
}

// Сравнивает старый и новый текст, добавляет ↘/↗, возвращает {dropped, report}
function processPriceChanges(oldText,newText){
  const oldPrices=parsePrices(oldText);
  let dropped=false;
  let category='',sub='';
  const outLines=[];

  for(const line of newText.split('\n')){
    const clean=line.trim().toLowerCase();
    const isCrystals=clean.includes(' crystals');
    const isTon=clean.includes(' ton');

    if((isCrystals||isTon)&&!clean.includes(':')){
      const currency=isCrystals?'crystals':'ton';
      const m=clean.replace(',','.').match(/(\d+(\.\d+)?)/);
      let suffix='';
      if(m){
        const newPrice=parseFloat(m[0]);
        const oldPrice=oldPrices[category+sub+'|'+currency];
        if(oldPrice!==undefined){
          const diff=Math.round((newPrice-oldPrice)*100)/100;
          if(newPrice<oldPrice){suffix=` ↘ ${Math.abs(diff)}`;dropped=true;}
          else if(newPrice>oldPrice){suffix=` ↗ ${diff}`;}
        }
      }
      outLines.push(line+suffix);
    }else if(clean.includes(':')&&!isCrystals&&!isTon){
      const name=clean.replace(':','').trim();
      if(!line.includes('⠀⠀⠀')){category=name;sub='';}
      else{sub=name;}
      outLines.push(line);
    }else{
      outLines.push(line);
    }
  }

  return{dropped,report:outLines.join('\n')};
}

let _messageId=null;
let _lastText=null;

function saveMessageId(id){
  const s=loadSettings();
  if(!s.telegram)s.telegram={};
  s.telegram.marketMessageId=id;
  saveSettings(s);
  _messageId=id;
}

async function tgPost(token,method,body,retries=3){
  for(let i=0;i<retries;i++){
    try{
      const res=await axios.post(`https://api.telegram.org/bot${token}/${method}`,body,{
        headers:{'Content-Type':'application/json'},
        timeout:15000,
      });
      return res.data;
    }catch(e){
      const detail=e.response?.data?JSON.stringify(e.response.data):e.message;
      if(i<retries-1){
        logger.warn(`[market-prices] TG ${method} failed (попытка ${i+1}/${retries}): ${detail}`);
        await sleep(5000);
      }else{
        throw new Error(`TG ${method} failed: ${detail}`);
      }
    }
  }
}

async function sendNew(token,chatId,threadId,text){
  const body={chat_id:chatId,text,parse_mode:'HTML'};
  if(threadId)body.message_thread_id=String(threadId);
  const data=await tgPost(token,'sendMessage',body,1);
  if(data.ok&&data.result?.message_id){
    saveMessageId(data.result.message_id);
    logger.info(`[market-prices] sent new message ${_messageId}`);
  }else{
    logger.warn(`[market-prices] sendMessage not ok: ${JSON.stringify(data)}`);
  }
}

async function sendOrEdit(token,chatId,threadId,text){
  // Сравниваем с прошлым текстом — добавляем стрелки и определяем dropped
  // Если _lastText нет (первая итерация) — стрелки не добавляем, dropped=false
  let finalText=text;
  let dropped=false;
  if(_lastText){
    const result=processPriceChanges(_lastText,text);
    dropped=result.dropped;
    finalText=result.report;
  }

  if(_messageId){
    if(dropped){
      // Цена снизилась — удаляем старое, отправляем новое (даёт уведомление)
      logger.info(`[market-prices] price dropped, delete+resend`);
      try{await tgPost(token,'deleteMessage',{chat_id:chatId,message_id:_messageId});}
      catch(e){logger.warn(`[market-prices] deleteMessage failed: ${e.message}`);}
      _messageId=null;
      await sleep(1000);
      await sendNew(token,chatId,threadId,finalText);
    }else{
      // Цены не снизились — тихо редактируем
      try{
        const data=await tgPost(token,'editMessageText',{chat_id:chatId,message_id:_messageId,text:finalText,parse_mode:'HTML'});
        if(data.ok){logger.info(`[market-prices] edited message ${_messageId}`);_lastText=text;return;}
        logger.warn(`[market-prices] editMessageText not ok: ${JSON.stringify(data)}`);
      }catch(e){
        const isNetworkError=e.message.includes('timeout')||e.message.includes('ECONNRESET')||e.message.includes('ENOTFOUND');
        if(isNetworkError){
          logger.warn(`[market-prices] editMessageText network error, пропускаем итерацию: ${e.message}`);
          return;
        }
        // Сообщение удалено или недоступно — шлём новое
        logger.warn(`[market-prices] editMessageText failed (${e.message}), resending`);
        _messageId=null;
        await sendNew(token,chatId,threadId,finalText);
      }
    }
  }else{
    await sendNew(token,chatId,threadId,finalText);
  }

  _lastText=text;
}

async function runMarketPriceLoop(clients){
  if(!clients||!clients.length){logger.warn('[market-prices] no clients, loop not started');return;}
  _messageId=loadSettings()?.telegram?.marketMessageId||null;
  if(_messageId)logger.info(`[market-prices] loaded saved message_id=${_messageId}, will edit on first iteration`);
  logger.info(`[market-prices] loop started (${clients.length} accounts)`);
  while(true){
    try{
      const cfg=getConfig();
      const token=cfg.telegram?.marketBot||cfg.telegram?.botToken;
      const chatId=cfg.telegram?.marketChatId;
      const threadId=cfg.telegram?.marketThreadId||null;
      // без токена/чата слать всё равно некуда — считаем мониторинг выключенным, как если бы
      // переключатель в Настройках был выставлен в "выкл" (не только сам пост в Telegram, а весь
      // цикл проверки курсов рынка — незачем дёргать игру ради данных, которые некому показать)
      if(cfg.features?.marketMonitoring===false||!token||!chatId){
        await sleep(60*1000); // короткий сон — быстро подхватит включение/донастройку в Настройках
        continue;
      }

      const results=new Map();
      for(const q of QUERIES){
        // до 3 попыток с РАЗНЫМИ аккаунтами: если у выбранного нет Центрального рынка
        // (403 «нет здания»), пробуем другого, а не роняем запрос.
        let done=false;
        const tried=new Set(); // аккаунты, уже пробованные в этой серии попыток — не берём повторно
        for(let attempt=0;attempt<3&&!done;attempt++){
          const{api,name}=pickMarketAccount(clients,tried);
          const accId=api&&api._accountId;
          if(accId!=null)tried.add(accId);
          try{
            await sleep(500+Math.random()*1500);
            if(accId!=null)_mktLastHit.set(accId,Date.now()); // фиксируем обращение к рынку для min-gap
            let data=await api.get('/market/direct',q.p);
            if(data?.is_warned){
              logger.info(`[market-prices] is_warned [${name}], unwarn + retry`);
              await api.post('/market/unwarn');
              await sleep(1000);
              _mktLastHit.set(accId,Date.now());
              data=await api.get('/market/direct',q.p);
            }
            const offers=(data?.offers||[]).filter(o=>o.status!=='sold');
            results.set(q.key,offers);
            logger.info(`[market-prices] ${q.key}: ${offers.length} offers via [${name}]`);
            done=true;
          }catch(e){
            if(e?.noBuilding)continue; // нет рынка у этого аккаунта — тихо пробуем другого
            if(e?.directDenied){ // пер-аккаунт лимит рынка: ставим аккаунт на кулдаун и берём другого
              mktPenalize(accId,name);
              continue;
            }
            logger.warn(`[market-prices] ${q.key} failed via [${name}]: ${e.message}`);
            if(e?.status===403)mktPenalize(accId,name); // прочий 403 по аккаунту — тоже придержим
            if(e?.wsNotReady||e?.noSeed||e?.status===403)continue; // временный сбой конкретного аккаунта — пробуем другого, а не бросаем всю выборку
            break;
          }
        }
        if(!done)results.set(q.key,[]);
      }

      const text=formatMessage(results);
      await sendOrEdit(token,chatId,threadId,text);
    }catch(e){
      logger.error(`[market-prices] ${e.message}`);
    }

    const delayMs=(3+Math.random()*2)*60*1000;
    logger.info(`[market-prices] next check in ${Math.round(delayMs/1000)}s`);
    await sleep(delayMs);
  }
}

module.exports={runMarketPriceLoop};
