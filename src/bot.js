'use strict';
const {runDailyLogin}=require('./modules/tasks');
const {runFortune}=require('./modules/fortune');
const {runJourney}=require('./modules/journey');
const {runWordle}=require('./modules/wordle');
const {runStaking}=require('./modules/staking');
const {runInventory}=require('./modules/inventory');
const {runPolicies}=require('./modules/policies');
const {runSatoshi}=require('./modules/satoshi');
const {runBuilders}=require('./modules/builders');
const {runMarket}=require('./modules/market');
const {runPromocodes}=require('./modules/promocodes');
const {runTownhall}=require('./modules/townhall');
const {runShop}=require('./modules/shop');
const {runAchievements}=require('./modules/achievements');
const {runLoyalty}=require('./modules/loyalty');
const {runAuditorium,runTechFactory}=require('./modules/guildBuildings');
const {runCapital}=require('./modules/capital');
const {runQuestAutomation}=require('./modules/questAutomation');
const {isDone,markDone}=require('./modules/dailyStatus');
const logger=require('./utils/logger');
const {getConfig}=require('./config');
const {sleep}=require('./utils/helpers');

async function _run(label,accountId,fn){
  if(isDone(accountId,label))return;
  await fn();
  markDone(accountId,label);
}

async function runAccount(api,account){
  const id=account.id;
  const name=account.name;
  const f=getConfig().features;
  if(f.dailyLogin){await _run('dailyLogin',id,()=>runDailyLogin(api,name));await sleep(500);}
  if(f.fortune){await _run('fortune',id,()=>runFortune(api,name));await sleep(500);}
  // Путь мэра — больше НЕ здесь: синхронизирован с циклом прокачки города (modules/progress.js
  // runProgress вызывает runJourney сам, на каждом свежем /progress/, без лишнего запроса к игре —
  // см. комментарий в journey.js). Дорога верности — своим суточным циклом (index.js
  // runLoyaltyLoop, раз в день на UTC-полночь, как вордли), тоже не отсюда.
  // ВАЖНО: inventory/policies/satoshi/promocodes раньше НЕ были гейтены isDone — при каждом
  // рестарте бота (index.js делает безусловный "initial run" runAllAccounts() на старте, см.
  // index.js) они выполнялись заново с нуля, вместо того чтобы пропуститься как уже сделанные
  // сегодня. При частых рестартах (активная разработка в течение дня) это раз за разом съедало
  // всё время цикла на аккаунт, и он просто не успевал дойти до auditorium/techfactory/
  // questAutomation (квесты — последний шаг) — со стороны выглядело, будто автовыполнение
  // квестов "выключено", хотя настройки были включены всё это время.
  if(f.inventory){await _run('inventory',id,()=>runInventory(api,name));await sleep(500);}
  // КРИТИЧЕСКИЙ БАГ (найден и исправлен 2026-07-17): здесь раньше стоял вызов несуществующей
  // функции runBoosterAutomation(api,name) — modules/boosterAutomation.js экспортирует только
  // runBoosterAutomationLoop (непрерывный цикл на аккаунт, уже отдельно запущен в index.js —
  // автоактивация ускорителей и так не нуждается в этом одноразовом вызове). Вызов несуществующей
  // функции кидал ReferenceError ПРЯМО ЗДЕСЬ на КАЖДОМ аккаунте, КАЖДЫЙ раз — Promise.allSettled
  // в index.js runAllAccounts молча глотал ошибку, и всё, что шло ПОСЛЕ этой строки (политики,
  // сатоши, рынок, промокоды, аудиториум, фабрика, автовыполнение квестов) — не выполнялось НИ
  // РАЗУ ни для одного аккаунта. Просто убрали битый вызов — реальная автоактивация ускорителей
  // не пострадает, она работает отдельным циклом.
  if(f.policies){await _run('policies',id,()=>runPolicies(api,name));await sleep(500);}
  if(f.satoshi){await _run('satoshi',id,()=>runSatoshi(api,name));await sleep(500);}
  if(f.market){await _run('market',id,()=>runMarket(api,name));await sleep(500);}
  await _run('promocodes',id,()=>runPromocodes(api,name));
  await _run('auditorium',id,()=>runAuditorium(api,name));
  await _run('techfactory',id,()=>runTechFactory(api,name));
  // Гильд-квесты — раньше это создание/заклейм жило ТОЛЬКО в непрерывном runQuestLoop, который
  // гоняется исключительно у лидера гильдии (role!=='Leader' → return). У обычных участников
  // гильдии личный прогресс квеста никогда не проверялся и не заклеймивался — своя награда за
  // выполненное личное условие просто зависала навсегда, даже если общее условие гильдии тоже
  // выполнено. runCapital НЕ ограничена ролью (создание квестов внутри неё уже само гейтится
  // Leader/Officer) — теперь каждый аккаунт раз в день сам проверяет и клеймит свою награду.
  if(f.capital){await _run('capital-quests',id,()=>runCapital(api,name));await sleep(500);}
  const qa=getConfig().questAutomation||{};
  if(qa.ads||qa.staking||qa.sudoku||qa.minesweeper||qa.quiz||qa.boosters)await _run('questAutomation',id,()=>runQuestAutomation(api,name,account));
}
module.exports={runAccount};
