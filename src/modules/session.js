'use strict';
const axios=require('axios');
const {Account}=require('../db/index');
const cfg=require('../config');
const logger=require('../utils/logger');
const reqSign=require('../utils/reqSign');
const wsSession=require('../utils/wsSession');

// id особых зданий на карте → короткий ключ фичи (для фильтрации аккаунтов по наличию здания)
const SPECIAL_BUILDINGS={
  'SPE_central_market.png':'market',
  'SPE_fortune_pavilion.png':'fortune',
  'SPE_wisdom_stronghold.png':'wisdom',
  'SPE_federal_reserve.png':'reserve',
  'SPE_satoshi_tower.png':'satoshi',
};
// Из массива зданий /progress/ (data.buildings) достаём CSV особых зданий аккаунта.
function extractSpecialBuildings(data){
  if(!Array.isArray(data?.buildings))return null; // нет массива — не трогаем существующее значение
  const owned=new Set();
  for(const b of data.buildings){const k=SPECIAL_BUILDINGS[b?.id];if(k)owned.add(k);}
  return [...owned].join(',');
}

function _saveStats(account,name,d){
  try{
    const data=d.progress?.data||{};
    const params=Array.isArray(d.progress?.params)?d.progress.params:[];
    // params отсортированы от новейшего timestamp к старейшему
    // final = params[0] (после всех апгрейдов), current = params[last] (прямо сейчас)
    const pFinal=params[0]||{};
    const pCurrent=params[params.length-1]||pFinal;
    const upd={};
    if(data.coins!==undefined)upd.balance=String(data.coins);
    if(data.crystals!==undefined)upd.crystals=String(data.crystals);
    // текущие показатели
    const safe=v=>isFinite(v)?v:null;
    if(pCurrent.profit!==undefined&&safe(pCurrent.profit)!==null)upd.profit=String(Math.round(pCurrent.profit));
    if(pCurrent.population!==undefined&&safe(pCurrent.population)!==null)upd.population=String(Math.round(pCurrent.population));
    if(pCurrent.happiness!==undefined&&safe(pCurrent.happiness)!==null)upd.happiness=String((pCurrent.happiness*100).toFixed(1));
    // финальные показатели (после всех апгрейдов)
    if(pFinal.profit!==undefined&&safe(pFinal.profit)!==null)upd.profit_final=String(Math.round(pFinal.profit));
    if(pFinal.population!==undefined&&safe(pFinal.population)!==null)upd.population_final=String(Math.round(pFinal.population));
    if(pFinal.happiness!==undefined&&safe(pFinal.happiness)!==null)upd.happiness_final=String((pFinal.happiness*100).toFixed(1));
    // особые здания (рынок/павильон/оплот/резерв) — для фильтрации аккаунтов и building-gate запросов
    const special=extractSpecialBuildings(data);
    if(special!==null){upd.special_buildings=special;account.special_buildings=special;require('../utils/buildingReg').setForAccount(account.id,special);}
    if(Object.keys(upd).length)
      Account.update(upd,{where:{id:account.id}}).catch(e=>logger.warn(`[${name}] [session] stats save: ${e.message}`));
  }catch(_){}
}

async function saveStakedStats(account,name,entries){
  try{
    if(entries.length>0)logger.info(`[${name}] [staking] entry sample: ${JSON.stringify(entries[0])}`);
    const getAmt=e=>Number(e.amount_to_collect??e.amount??e.staked_amount??e.stake_amount??0);
    const coins=entries.filter(e=>e.currency==='coins').reduce((s,e)=>s+getAmt(e),0);
    const crystals=entries.filter(e=>e.currency==='crystals').reduce((s,e)=>s+getAmt(e),0);
    await Account.update({staked_coins:String(coins),staked_crystals:String(crystals)},{where:{id:account.id}});
  }catch(e){logger.warn(`[${name}] [session] staked save: ${e.message}`);}
}

// per-account refresh lock: если refresh уже идёт — ждём его, не запускаем второй.
// БАГ, который тут был: ждущий вызов получал true от ЧУЖОГО _doRefreshOnce, но свой api/account
// (разные экземпляры — у web-роутов и у дневного цикла бота свои Account/ApiClient на тот же id)
// так и оставались со СТАРЫМ токеном. Следующий их запрос слал уже отозванный сервером
// refresh_token → "Invalid or expired refresh token", хотя аккаунт совершенно живой. Токен
// в игре одноразовый (rotating) — после первого успешного рефреша старый refresh_token недействителен.
const _refreshInFlight=new Map();

// Аккаунты с ПОДТВЕРЖДЁННО мёртвым refresh_token (401 "Invalid or expired refresh token").
// Такой токен не оживёт: помогает только новая ссылка из бота игры (/api/accounts/add). Поэтому
// после 401 сеть больше не трогаем совсем, пока в БД не появится свежий токен (doRefresh проверяет
// это дешёвым чтением БД) или панель не снимет отметку явно (clearDeadCooldown). Раньше отметка
// жила 10 минут, и каждые 10 минут на мёртвый аккаунт уходили заведомо проваленные refresh+exchange.
// Отметка в памяти: после перезапуска бота аккаунт проверяется рефрешем ещё один раз.
const _refreshDead=new Set();

async function _syncTokensFromDb(api,account){
  try{
    const fresh=await Account.findByPk(account.id,{attributes:['access_token','refresh_token']});
    if(fresh?.access_token&&fresh.access_token!==account.access_token){
      api.setToken(fresh.access_token);
      account.access_token=fresh.access_token;
      account.refresh_token=fresh.refresh_token;
      return true;
    }
  }catch(_){}
  return false;
}

async function doRefresh(api,account){
  const name=account.name;
  if(_refreshDead.has(account.id)){
    // 13.10.2026: БАГ — аккаунт попадал в "подтверждённо мёртв" (refresh 401),
    // пользователь тут же переавторизовывал его через веб-панель (/api/accounts/add — свежий
    // access_token/refresh_token УЖЕ лежат в БД), но все циклы аккаунта продолжали получать
    // noSeedError — doRefresh выходил здесь, даже не заглянув в БД. Жалоба: "отправил
    // новую ссылку авторизации, а должно заработать мгновенно". Дешёвая проверка БД (без похода в
    // игру) — если токен там СВЕЖЕЕ закрытого в памяти, отметка больше не актуальна: снимаем его и
    // ПРОВАЛИВАЕМСЯ дальше в обычный _doRefreshOnce (не просто копируем токен) — нужен настоящий
    // сетевой refresh свежим refresh_token, чтобы получить НОВЫЙ session_seed (reqSign) и поднять WS
    // заново (wsSession.notifyRefreshed), иначе подписанные запросы всё равно будут падать без seed.
    const synced=await _syncTokensFromDb(api,account);
    if(!synced)return false; // в БД всё ещё старый токен — аккаунт мёртв, ждём новую ссылку
    _refreshDead.delete(account.id);
  }
  if(_refreshInFlight.has(account.id)){
    logger.info(`[${name}] [session] refresh already in progress, waiting…`);
    const ok=await _refreshInFlight.get(account.id);
    // подтягиваем токен, который обновил ДРУГОЙ вызов — иначе у этого api/account останется старый
    if(ok)await _syncTokensFromDb(api,account);
    return ok;
  }
  const promise=_doRefreshOnce(api,account).finally(()=>_refreshInFlight.delete(account.id));
  _refreshInFlight.set(account.id,promise);
  return promise;
}

async function _doRefreshOnce(api,account){
  const name=account.name;
  try{
    // если другой процесс уже обновил токен — берём из БД и не делаем рефреш
    const fresh=await Account.findByPk(account.id,{attributes:['access_token','refresh_token']});
    if(fresh&&fresh.access_token&&fresh.access_token!==account.access_token){
      logger.info(`[${name}] [session] token already refreshed by another process`);
      api.setToken(fresh.access_token);
      account.access_token=fresh.access_token;
      account.refresh_token=fresh.refresh_token;
      _refreshDead.delete(account.id);
      return true;
    }
    const sentRt=account.refresh_token; // фиксируем токен, которым рефрешим — сравним с БД при 401
    const r=await axios.post(`${cfg.baseUrl}/web-auth/refresh`,{refresh_token:account.refresh_token},{
      timeout:30000,headers:{'content-type':'application/json','accept':'application/json'},
    });
    const b=r.data;
    if(!b.access_token){logger.error(`[${name}] [session] refresh failed: ${JSON.stringify(b)}`);return false;}
    api.setToken(b.access_token);
    reqSign.setSeed(account.id,b.session_seed); // seed для подписи запросов (X-Req-Token)
    account.access_token=b.access_token;
    if(b.refresh_token)account.refresh_token=b.refresh_token;
    await Account.update({access_token:b.access_token,refresh_token:account.refresh_token},{where:{id:account.id}});
    wsSession.notifyRefreshed(account.id,()=>account.access_token); // токен/seed сменились → переоткрыть WS
    logger.info(`[${name}] [session] token refreshed`);
    _refreshDead.delete(account.id);
    return true;
  }catch(e){
    const status=e?.response?.status;
    const body=typeof e?.response?.data==='string'?e.response.data:JSON.stringify(e?.response?.data||{});
    // ГОНКА РОТАЦИИ (первопричина вылета аккаунтов): пока мы делали refresh, ДРУГОЙ вызов/процесс мог
    // уже успешно рефрешнуть этот аккаунт. Игра ротирует refresh_token на каждый успешный refresh —
    // наш стал невалиден именно потому, что его ротировал победитель. Прежде чем объявлять аккаунт
    // мёртвым — перечитываем БД: если там уже лежит ДРУГОЙ токен
    // (не тот, что мы слали), значит рефреш уже сделан успешно — просто принимаем свежий токен.
    if(status===401){
      try{
        const fresh=await Account.findByPk(account.id,{attributes:['access_token','refresh_token']});
        if(fresh&&fresh.refresh_token&&fresh.refresh_token!==sentRt&&fresh.access_token){
          api.setToken(fresh.access_token);
          account.access_token=fresh.access_token;
          account.refresh_token=fresh.refresh_token;
          _refreshDead.delete(account.id);
          logger.info(`[${name}] [session] refresh 401, но токен уже ротирован другим вызовом — принят свежий из БД`);
          return true;
        }
      }catch(_){}
    }
    logger.error(`[${name}] [session] refresh error: ${e.message}${status?` status ${status}`:''}${body?` ${body}`:''}`);
    // Код из ссылки game.toncity.io/auth одноразовый и живёт ~10 минут, поэтому повторно его не
    // обмениваем: протухший аккаунт оживит только новая ссылка из бота игры.
    if(status===401){
      _refreshDead.add(account.id);
      logger.warn(`[${name}] [session] refresh_token протух — нужна новая ссылка авторизации из бота игры`);
    }
    return false;
  }
}

// Аккаунты, добавленные когда users/me/ был недоступен (или раньше — до того как /api/accounts/add
// стал это требовать), получили технические имена account_XXXXXXXX. При первой рабочей сессии
// пробуем подтянуть настоящее имя и переименовать — раньше это работало сразу при добавлении,
// сейчас добавление с недоступным users/me вообще отклоняется, но старые записи так и остаются
// безымянными, если не проверять их при следующем запуске.
const PLACEHOLDER_NAME_RE=/^account_[0-9a-f]{8}$/i;
async function maybeRenameAccount(api,account){
  if(!PLACEHOLDER_NAME_RE.test(account.name))return;
  try{
    const me=await api.get('/users/me/');
    const u=me?.user||me;
    const parts=[u?.first_name,u?.last_name].filter(Boolean);
    const realName=parts.length?parts.join(' '):(u?.username||'');
    if(!realName||realName===account.name)return;
    const clash=await Account.findOne({where:{name:realName}});
    if(clash){logger.warn(`[${account.name}] [session] переименование пропущено — имя "${realName}" уже занято (id ${clash.id})`);return;}
    const oldName=account.name;
    await Account.update({name:realName},{where:{id:account.id}});
    logger.info(`[${account.name}] [session] переименован в "${realName}"`);
    account.name=realName;
    wsSession.setName(account.id,realName);
    // переносим все строки-снимки (позиции Башни Сатоши, инвентарь, снапшоты…) со старого имени
    // на новое, иначе они «осиротевают» (висят под account_XXXXXXXX, не привязаны к аккаунту)
    await require('../utils/renameAccount').renameAccountRefs(oldName,realName);
  }catch(e){logger.warn(`[${account.name}] [session] rename check: ${e.message}`);}
}

async function ensureSession(api,account){
  const name=account.name;
  wsSession.setName(account.id,name);
  api.setRefreshFn(()=>doRefresh(api,account));
  if(!account.access_token&&!account.refresh_token){logger.warn(`[${name}] [session] no tokens in DB`);return null;}
  // Нужен session_seed (для подписи запросов и WS-хендшейка). В памяти его нет после старта —
  // он приходит только в ответе exchange/refresh, поэтому обновляемся, если seed ещё не получен.
  if(!reqSign.hasSeed(account.id)&&account.refresh_token)await doRefresh(api,account);
  // Сервер пускает REST только при активном WS — поднимаем его до первого запроса.
  const wsOk=await wsSession.ensureReady(account.id,()=>account.access_token,()=>doRefresh(api,account));
  if(!wsOk)logger.warn(`[${name}] [session] WS не готов — запросы могут отклоняться (403 direct access)`);
  try{
    const d=await api.get('/progress/');
    if(d?.progress){
      _saveStats(account,name,d);
      logger.info(`[${name}] [session] active`);
      await maybeRenameAccount(api,account);
      return{accessToken:account.access_token,refreshToken:account.refresh_token};
    }
  }catch(_){}
  if(!account.refresh_token){logger.error(`[${name}] [session] no refresh token`);return null;}
  logger.info(`[${name}] [session] refreshing…`);
  const ok=await doRefresh(api,account);
  if(!ok)return null;
  await wsSession.ensureReady(account.id,()=>account.access_token);
  await maybeRenameAccount(api,account);
  return{accessToken:account.access_token,refreshToken:account.refresh_token};
}

// Аккаунт с ПОДТВЕРЖДЁННО мёртвым refresh_token — группам, выбирающим
// «любой аккаунт» для чтения (market-prices, витрина рынка и т.п.), нет смысла его выбирать:
// запрос всё равно упадёт в «нет seed». Позволяет не долбить мёртвый аккаунт и не спамить лог.
function isRefreshDead(accountId){return _refreshDead.has(Number(accountId));}

// Явный сброс отметки «мёртв» (13.10.2026) — зовётся сразу после переавторизации аккаунта через веб-панель
// (/api/accounts/add), когда в БД только что сохранился заведомо свежий access_token/refresh_token.
// doRefresh и сам снимает кулдаун при обнаружении более свежего токена в БД (см. выше), но явный
// вызов отсюда снимает её МГНОВЕННО, не дожидаясь следующей попытки запроса от фонового цикла.
function clearDeadCooldown(accountId){_refreshDead.delete(Number(accountId));}

module.exports={ensureSession,doRefresh,saveStakedStats,saveStats:_saveStats,isRefreshDead,clearDeadCooldown};
