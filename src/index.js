'use strict';
require('dotenv').config();
const cfg=require('./config');
const {getConfig}=require('./config');
const logger=require('./utils/logger');
const {init,Account}=require('./db/index');
const {runAccount}=require('./bot');
const {runProgress}=require('./modules/progress');
const {isCityPaused}=require('./utils/botState');
const {waitOrWake}=require('./utils/cityWake');
const {runQuestLoop,runCapUpgradeLoop,collectCapitalResources}=require('./modules/capital');
const {collectReady}=require('./modules/staking');
const {runMarketPriceLoop}=require('./modules/marketPrices');
const {runWordleOnce,runWordleLoop}=require('./modules/wordle');
const {runLoyalty}=require('./modules/loyalty');
const {runBoosterAutomationLoop}=require('./modules/boosterAutomation');
const {apiForAcc}=require('./web/lib/api');
const ApiClient=require('./api/client');
const {ensureSession,doRefresh,saveStats}=require('./modules/session');
const {sleep,sleepUntilUtcMidnight}=require('./utils/helpers');
const {startWebServer}=require('./web/server');

async function runAllAccounts(clients){
  if(!clients?.length){logger.warn('No accounts in DB.');return;}
  logger.info(`[daily] запуск ${clients.length} аккаунтов`);
  const results=await Promise.allSettled(clients.map(({api,account})=>runAccount(api,account)));
  // раньше ошибки runAccount тонули молча в allSettled — реальный краш (напр. вызов
  // несуществующей функции) мог месяцами обрывать цикл ВСЕМ аккаунтам на одном и том же шаге,
  // и это было незаметно ни в одном логе. Теперь падения видно явно.
  const failed=results.filter(r=>r.status==='rejected');
  if(failed.length)logger.error(`[daily] ошибки в runAccount: ${failed.length}/${clients.length}, например: ${failed[0].reason?.message||failed[0].reason}`);
  logger.info('[daily] все аккаунты обработаны');
}

async function runDailyLoop(clients){
  while(true){
    await sleepUntilUtcMidnight();
    try{await runAllAccounts(clients);}
    catch(e){logger.error(`[daily] ${e.message}`);}
  }
}

// Дорога верности — раз в день, на UTC-полночь, тем же паттерном, что вордли (runWordleLoop) —
// условие уровня просто "прошло N дней", не привязано ни к какому другому циклу бота, поэтому
// отдельный суточный таймер здесь уместен (в отличие от Пути мэра, синхронизированного с прокачкой
// города, см. modules/progress.js). Живой запрос внутри runLoyalty делается не каждый день, а
// только когда локальная оценка (streak+дни) говорит, что порог следующего уровня похож на взятый —
// см. modules/loyalty.js.
async function runLoyaltyLoop(clients){
  while(true){
    for(const{api,account}of clients){
      try{await runLoyalty(api,account.name);}
      catch(e){logger.error(`[${account.name}] [loyalty-loop] ${e.message}`);}
    }
    await sleepUntilUtcMidnight();
  }
}

async function cityUpgradeLoop(api,name){
  logger.info(`[${name}] [city-loop] started`);
  while(true){
    try{
      if(isCityPaused()){await sleep(30000);continue;}
      await runProgress(api,name,{upgrading:true,buying:true});
      // раньше спал ровно 6ч независимо ни от чего — если пользователь сохранял новую цель
      // улучшения в момент, когда цикл уже ушёл сюда спать (например "целей не было" на прошлом
      // проходе), новая цель не подхватывалась до конца этих 6ч, даже если строители свободны
      // прямо сейчас. web/routes/cityStrategy.js будит конкретный аккаунт при сохранении целей —
      // waitOrWake просыпается раньше таймера, если пришёл сигнал.
      logger.info(`[${name}] [city-loop] nothing to upgrade, sleeping up to 6h (or until targets change)`);
      await waitOrWake(name,6*60*60*1000);
    }catch(e){
      if(e?.cause?.response?.status===401||e?.message?.includes('status 401')){logger.error(`[${name}] [city-loop] auth failed, stopping loop`);return;}
      logger.error(`[${name}] [city-loop] ${e.message}`);await sleep(60000);
    }
  }
}

async function _doCollectCapital(clients){
  logger.info('[capital-collect] сбор ресурсов столицы...');
  await Promise.allSettled(clients.map(async({api,account})=>{
    try{
      const g=await api.get('/users/me/guild');
      if(g?.guild?.role!=='Leader')return;
      const guildId=String(g.guild.id);
      const prog=await api.get(`/capitals/progress/${guildId}`);
      await collectCapitalResources(api,account.name,guildId,prog);
    }catch(e){logger.warn(`[${account.name}] [capital-collect] ${e.message}`);}
  }));
}

async function stakingLoop(clients){
  const{StakingEntry}=require('./db/index');
  const{Op}=require('sequelize');
  while(true){
    logger.info(`[staking-loop] сбор готовых наград (${clients.length} аккаунтов)...`);
    await Promise.allSettled(clients.map(async({api,account})=>{
      try{await collectReady(api,account.name);}
      catch(e){logger.warn(`[${account.name}] [staking-loop] ${e.message}`);}
    }));
    // Найти ближайшую дату сбора из БД
    const next=await StakingEntry.findOne({
      where:{collected:false,can_collect_at:{[Op.gt]:new Date()}},
      order:[['can_collect_at','ASC']],
    }).catch(()=>null);
    const waitMs=next
      ?Math.max(new Date(next.can_collect_at).getTime()-Date.now()+5000,60000)
      :6*60*60*1000; // если нет записей — спим 6 часов
    logger.info(`[staking-loop] следующий сбор через ${Math.round(waitMs/60000)} мин`);
    await sleep(waitMs);
  }
}

async function collectCapitalLoop(clients){
  await _doCollectCapital(clients);
  while(true){
    await sleep(12*60*60*1000);
    await _doCollectCapital(clients);
  }
}

async function collectProfitLoop(clients){
  while(true){
    await sleep(6*60*60*1000);
    logger.info(`[profit] сбор прибыли (${clients.length} аккаунтов)...`);
    await Promise.allSettled(clients.map(async({api,account})=>{
      try{
        const d=await api.get('/progress/');
        if(d?.progress){
          const params=Array.isArray(d.progress.params)?d.progress.params:[];
          const profit=params[0]?.profit;
          if(profit!==undefined)logger.info(`[${account.name}] [profit] +${Math.round(profit)}`);
          saveStats(account,account.name,d);
        }
      }catch(e){logger.warn(`[${account.name}] [profit] ${e.message}`);}
    }));
  }
}

// РЕАКТИВНЫЙ детектор конца техработ. Пока игра РАБОТАЕТ — игру НЕ трогаем совсем
// (лишних запросов не создаём): НАЧАЛО техработ ловится первым же ответом 503 от обычных
// запросов циклов/панели. Но КОНЕЦ техработ сам не поймается — во время паузы предохранитель
// блокирует обычные запросы, поэтому пробу слать некому. Значит, и ТОЛЬКО пока пауза активна,
// этот цикл шлёт «пробу» /progress/, пока игра не вернётся, после чего снова засыпает.
// Реальный запрос уходит не чаще раза в PROBE_INTERVAL (5 мин) — гейтит acquire(); остальные
// попытки — дешёвый локальный отказ. Аккаунт один стабильный: техработы глобальны, случайный смысла не даёт.
async function maintenanceWatchLoop(clients){
  const{status}=require('./utils/maintenance');
  const valid=clients.filter(c=>c.account?.access_token&&c.account.access_token!=='placeholder');
  if(!valid.length){logger.warn('[maintenance-watch] нет аккаунтов с токеном — авто-выход из паузы отключён');return;}
  const{api}=valid[0];
  while(true){
    // в норме status().active=false → игру не трогаем; в техработы пробуем (реальный запрос — раз в 5 мин)
    if(status().active){try{await api.get('/progress/');}catch(_){/* MaintenanceError/ошибка — состояние уже учтено */}}
    await sleep(60000);
  }
}

async function startAccountLoops(api,account){
  const name=account.name;
  try{
    const f=getConfig().features;
    const loops=[];
    if(f.upgrading)loops.push(cityUpgradeLoop(api,name));
    if(f.capital)loops.push(runCapUpgradeLoop(api,name));
    if(f.capital)loops.push(runQuestLoop(api,name));
    // автоактивация ускорителей — отдельный непрерывный цикл (не гейтится features, включается per-
    // аккаунт из UI): once-in-a-day runAccount не годился ("всегда держать активным" требует знать
    // ТОЧНОЕ время окончания текущего буста, см. modules/boosterAutomation.js).
    //
    // КРИТИЧНО: свой ОТДЕЛЬНЫЙ noLock-клиент, а не общий `api` этого аккаунта — общий `api` идёт
    // через apiLock (RateLimiter{rps:2,concurrency:1}), который ОДИН на ВСЕ аккаунты И ВСЕ модули
    // разом. Если хоть один запрос через него зависнет дольше своего таймаута/не отпустит слот —
    // concurrency:1 значит вообще ВСЁ (все аккаунты, весь бот) встаёт намертво до перезапуска
    // процесса — именно это и произошло: лог оборвался сразу после массового старта этих циклов
    // на ~50+ аккаунтах разом. noLock изолирует зависание одного аккаунта только этим циклом этого
    // аккаунта, не трогая остальной бот (тот же подход, что у автозакрытия TP/SL Башни Сатоши).
    if(account.access_token&&account.access_token!=='placeholder'){
      try{loops.push(runBoosterAutomationLoop(apiForAcc(account,{noLock:true}),name));}
      catch(e){logger.warn(`[${name}] booster-loop init: ${e.message}`);}
    }
    if(loops.length)await Promise.allSettled(loops);
  }catch(e){logger.error(`[${name}] loops fatal: ${e.message}`);}
}

async function main(){
  await init();
  // КРИТИЧНО: дожидаемся успешного бинда порта (= мы единственный живой экземпляр) ДО любого
  // прогрева сессий/refresh. Если порт занят другим экземпляром — startWebServer сам выйдет
  // (process.exit) после ретраев, и до refresh-ов дело не дойдёт. Так исключается гонка ротации
  // refresh_token между накладывающимися процессами (первопричина вылета аккаунтов).
  await startWebServer(cfg.webPort);
  const accounts=await Account.findAll({order:[['id','ASC']]});
  const clients=accounts.map(a=>{
    const api=new ApiClient(a.access_token||'placeholder');
    api.setAccountId(a.id);
    api.setRefreshFn(()=>doRefresh(api,a));
    return{api,account:a};
  });
  // 0. проверяем сессии всех аккаунтов ДО любых операций
  logger.info(`[session] проверка ${clients.length} аккаунтов...`);
  for(const{api,account}of clients){
    await ensureSession(api,account);
    await sleep(300);
  }
  logger.info('[session] все сессии проверены');
  // цикл рынка — только аккаунты, у которых на карте есть Центральный рынок (наличие берём из /progress/,
  // сохранённого в special_buildings при проверке сессии выше). Иначе запросы летят в 403 «нет здания».
  const hasBuilding=(acc,key)=>String(acc.special_buildings||'').split(',').includes(key);
  const marketClients=clients.filter(c=>hasBuilding(c.account,'market'));
  logger.info(`[market-prices] аккаунтов с Центральным рынком: ${marketClients.length}/${clients.length}`);
  runMarketPriceLoop(marketClients.map(c=>({api:c.api,name:c.account.name}))).catch(e=>logger.error(`market-prices fatal: ${e.message}`));
  maintenanceWatchLoop(clients).catch(e=>logger.error(`maintenance-watch fatal: ${e.message}`));
  // 1. параллельно: сессии + логин + фортуна и т.д. (без вордли)
  await runAllAccounts(clients).catch(e=>logger.error(`[daily] initial run: ${e.message}`));
  // 2. строго последовательно: вордли (1 аккаунт = 1 слово) — только аккаунты с Оплотом Мудрости
  const wisdomClients=clients.filter(c=>hasBuilding(c.account,'wisdom'));
  logger.info(`[wordle] аккаунтов с Оплотом Мудрости: ${wisdomClients.length}/${clients.length}`);
  const wordleClients=wisdomClients.map(c=>({api:c.api,name:c.account.name,account:c.account}));
  await runWordleOnce(wordleClients).catch(e=>logger.error(`wordle-once fatal: ${e.message}`));
  runWordleLoop(wordleClients).catch(e=>logger.error(`wordle-loop fatal: ${e.message}`));
  runLoyaltyLoop(clients).catch(e=>logger.error(`loyalty-loop fatal: ${e.message}`));
  runDailyLoop(clients).catch(e=>logger.error(`daily-loop fatal: ${e.message}`));
  collectProfitLoop(clients).catch(e=>logger.error(`profit-loop fatal: ${e.message}`));
  collectCapitalLoop(clients).catch(e=>logger.error(`capital-collect-loop fatal: ${e.message}`));
  stakingLoop(clients).catch(e=>logger.error(`staking-loop fatal: ${e.message}`));
  clients.forEach(({api,account})=>startAccountLoops(api,account).catch(e=>logger.error(`[${account.name}] loops: ${e.message}`)));
}

process.on('unhandledRejection',(reason)=>{
  logger.error(`[unhandledRejection] ${reason?.stack||reason}`);
});
process.on('uncaughtException',(err)=>{
  logger.error(`[uncaughtException] ${err?.stack||err}`);
});

// Быстрый и чистый выход по сигналу от nodemon (SIGINT) / системы (SIGTERM). Без этого старый
// процесс на Windows мог не умереть вовремя: держал порт, WS-сессии и таймеры, продолжая рефрешить
// токены, пока nodemon уже поднимал новый экземпляр → два процесса ротировали одноразовый
// refresh_token друг под другом и аккаунты вылетали. Закрываем WS + БД и выходим, с жёстким
// потолком (не зависаем на закрытии соединений).
let _shuttingDown=false;
function gracefulShutdown(sig){
  if(_shuttingDown)return; _shuttingDown=true;
  logger.info(`[shutdown] получен ${sig} — закрываю WS/БД и выхожу`);
  const done=()=>{try{process.exit(0);}catch(_){process.exit(0);}};
  const hardTimer=setTimeout(()=>{logger.warn('[shutdown] таймаут — принудительный выход');process.exit(0);},4000);
  hardTimer.unref&&hardTimer.unref();
  try{require('./utils/wsSession').closeAll();}catch(_){}
  Promise.resolve()
    .then(()=>require('./db/index').seq.close())
    .catch(()=>{})
    .finally(done);
}
process.on('SIGINT',()=>gracefulShutdown('SIGINT'));
process.on('SIGTERM',()=>gracefulShutdown('SIGTERM'));

setInterval(()=>{
  const m=process.memoryUsage();
  const used=Math.round(m.heapUsed/1024/1024);
  const total=Math.round(m.heapTotal/1024/1024);
  const rss=Math.round(m.rss/1024/1024);
  const pct=Math.round(used/total*100);
  if(pct>80)logger.warn(`[memory] HIGH: heap ${used}/${total}MB (${pct}%), RSS ${rss}MB`);
  else logger.info(`[memory] heap ${used}/${total}MB (${pct}%), RSS ${rss}MB`);
},5*60*1000);

main().catch(e=>{logger.error(`Fatal: ${e.stack||e.message}`);process.exit(1);});
