'use strict';
const logger=require('../utils/logger');
const {getConfig}=require('../config');

// Квест-осознанная автоматика (переписано 21.07.2026 — раньше действия выполнялись БЕЗУСЛОВНО раз
// в день, если тумблер включён, совершенно не глядя, нужны ли они для чего-то). Теперь сначала
// смотрим реальный список гильд-квестов аккаунта (один живой GET, см. modules/capital.js
// fetchOwnGuildQuests) и запускаем действие ТОЛЬКО если есть активный незавершённый квест
// подходящего типа, где личное условие ещё не выполнено. После действий — свежая проверка+заклейм
// (modules/capital.js collectReadyQuests), чтобы награда не зависала до завтрашнего runCapital.
//
// Каталог реальных типов квестов (собран из живых данных БД, 16 штук): ad_views, minigame_wins,
// staking_amount, staking_count — покрыты ниже. daily_login/daily_draw_reward — НЕ нуждаются в
// отдельной автоматике: ежедневный вход и колесо фортуны и так крутятся каждый день независимо от
// квестов (см. bot.js f.dailyLogin/f.fortune), их личный прогресс продвигается сам, остаётся только
// вовремя заклеймить (это уже делает collectReadyQuests). booster_activate — БЫЛ автоматизирован
// здесь, убрано 22.07.2026 (см. комментарий у extractRarity ниже) — теперь кнопка на странице.
// Остальные типы (market_purchases/market_volume/market_trades, guild_boost, crystal_purchase,
// invitations, item_acquire, booster_combine) — СОЗНАТЕЛЬНО не автоматизируются (тратят алмазы/
// монеты без явного бюджета от пользователя, либо технически невозможны боту — приглашения,
// привязка кошелька), их видно на странице "Квесты" как есть, заклейм — если условие выполнится
// каким-то другим путём.
function questActive(qList,type){
  return qList.some(q=>!q.is_collected&&q.type===type&&(q.personal_progress||0)<(q.personal_threshold||0));
}

async function runAdsAutomation(api,name){
  try{
    const{getDailyAdsStatus,runDailyAds}=require('./dailyads');
    const status=await getDailyAdsStatus(api,name);
    if(status.limit_reached){logger.info(`[${name}] [quest-auto] реклама: лимит уже исчерпан сегодня`);return;}
    await runDailyAds(api,name);
  }catch(e){logger.warn(`[${name}] [quest-auto] реклама: ${e.message}`);}
}

async function runStakingAutomation(api,name,account){
  try{
    const{runStaking}=require('./staking');
    await runStaking(api,name,account); // сам проверяет занятость слотов и баланс перед новым стейком
  }catch(e){logger.warn(`[${name}] [quest-auto] стейкинг: ${e.message}`);}
}

// общая проверка "уже играно сегодня" для мини-игр Оплота Мудрости (MinigameLog — уникальность
// по account+game+played_at, см. db/index.js) — сами solve*-функции такой проверки не делают.
async function alreadyPlayedToday(name,game){
  const{MinigameLog}=require('../db/index');
  const played_at=new Date().toISOString().slice(0,10);
  const row=await MinigameLog.findOne({where:{account:name,game,played_at}});
  return !!row;
}

async function runSudokuAutomation(api,name){
  try{
    if(await alreadyPlayedToday(name,'sudoku')){logger.info(`[${name}] [quest-auto] судоку: уже сыграно сегодня`);return;}
    const{solveSudoku}=require('./sudoku');
    await solveSudoku(api,name);
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [quest-auto] судоку: нет Оплота Мудрости — пропуск`);return;}
    logger.warn(`[${name}] [quest-auto] судоку: ${e.message}`);
  }
}

async function runMinesweeperAutomation(api,name){
  try{
    if(await alreadyPlayedToday(name,'minesweeper')){logger.info(`[${name}] [quest-auto] сапёр: уже сыграно сегодня`);return;}
    const{solveMinesweeper}=require('./minesweeper');
    await solveMinesweeper(api,name);
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [quest-auto] сапёр: нет Оплота Мудрости — пропуск`);return;}
    logger.warn(`[${name}] [quest-auto] сапёр: ${e.message}`);
  }
}

// В дневном цикле (index.js runAllAccounts) все аккаунты стартуют ОДНОВРЕМЕННО
// (Promise.allSettled без задержки между ними) — если много аккаунтов запускают викторину в один
// момент, все они одновременно натыкаются на ЕЩЁ НЕ ВЫУЧЕННЫЕ вопросы (база ответов общая и
// самообучается, см. modules/quiz.js) и вынуждены угадывать параллельно, вместо того чтобы более
// поздние аккаунты пользовались уже найденными правильными ответами предыдущих — итог: реальный
// счёт (score) у авто-прогона часто оказывался 0, хотя награда всё равно выдавалась за прохождение.
// Кнопка "Решить" на странице обычно нажимается позже (когда база уже частично выучена), поэтому
// у неё счёт был настоящим — разница была именно в одновременном старте, не в самой логике решения.
// Здесь — глобальный (на все аккаунты) гейт: не чаще одного старта раз в 5 секунд.
let lastQuizStart=0;
async function throttleQuizStart(){
  const wait=Math.max(0,lastQuizStart+5000-Date.now());
  if(wait>0)await new Promise(r=>setTimeout(r,wait));
  lastQuizStart=Date.now();
}

// ВАЖНО: викторина отвечает на вопросы через ОБЩИЙ apiLock (см. utils/lock.js — один лимитер
// 2rps/concurrency:1 на ВСЕ аккаунты и ВСЕ модули разом), если использовать сюда переданный `api`
// (обычный клиент дневного цикла аккаунта, БЕЗ noLock). У викторины на сервере жёсткое окно на
// ответ по каждому вопросу (см. modules/quiz.js: READING_MS/POST_MS) — если POST /quiz/answer
// застрял в общей очереди позади десятков других запросов (сессии, рынок, другие аккаунты) и
// улетел в сеть с опозданием, сервер это окно уже закрыл, ответ не засчитывается. Со стороны это
// выглядит как "викторина просто запускается и ничего не отвечает, счёт всегда 0" — при этом
// кнопка "Решить" на странице всегда работала, потому что уже дёргает noLock-клиент
// (см. web/lib/quizProgress.js). Здесь — тот же приём: свой noLock-клиент для этого же аккаунта,
// в обход общей очереди, вместо переиспользования рейт-лимитированного `api` дневного цикла.
async function runQuizAutomation(name,accountId){
  try{
    if(await alreadyPlayedToday(name,'quiz')){logger.info(`[${name}] [quest-auto] викторина: уже решена сегодня`);return;}
    await throttleQuizStart();
    const{makeApiForAccount}=require('../web/lib/api');
    const quizApi=await makeApiForAccount(accountId,{noLock:true});
    const{solveQuiz}=require('./quiz');
    await solveQuiz(quizApi,name);
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [quest-auto] викторина: нет Оплота Мудрости — пропуск`);return;}
    logger.warn(`[${name}] [quest-auto] викторина: ${e.message}`);
  }
}

// Требуемая редкость ускорителя парсится из ТЕКСТА квеста ("Активируйте один эпический
// ускоритель"), а НЕ из поля q.rarity — живыми данными подтверждено, что q.rarity это тир/редкость
// самого КВЕСТА (награды), она НЕ совпадает с редкостью нужного ускорителя (пример из реальной БД:
// описание "Activate one epic booster", а q.rarity="rare" — если бы полагались на q.rarity,
// активировали бы не тот ускоритель). "необычн" проверяем РАНЬШЕ "обычн" — иначе regex /обычн/
// матчит и "необычный" тоже (подстрока).
const RARITY_WORDS=[
  [/эпическ/i,'epic'],[/легендарн/i,'legendary'],[/мифическ/i,'mythic'],
  [/необычн/i,'uncommon'],[/редк/i,'rare'],[/вечн/i,'eternal'],[/обычн/i,'common'],
];
function extractRarity(text){
  if(!text)return null;
  for(const[re,tag]of RARITY_WORDS)if(re.test(text))return tag;
  return null;
}

// Активация ускорителя под квест booster_activate — БОЛЬШЕ НЕ автоматика (убрано 22.07.2026 по
// просьбе пользователя): активация ускорителя — намеренное решение игрока (тратит инвентарь,
// блокирует другие типы на часы/сутки), не то, что бот должен решать за него фоновым циклом. Вместо
// этого — кнопка "Активировать" на странице "Квесты" (см. web/routes/dashboards.js
// POST /api/guild-quests/:accountId/activate-booster), которая вызывает
// modules/boosterAutomation.js activateBoosterForRarity(api,name,rarity) с ТЕМ ЖЕ правилом игры
// (пока активен один тип — нельзя активировать другой), rarity извлекается той же extractRarity
// ниже из текста квеста.

// вызывается раз в день на аккаунт (см. bot.js) — сама решает, что включено в настройках и что
// реально нужно прямо сейчас (гильд-квесты аккаунта)
async function runQuestAutomation(api,name,account){
  const qa=getConfig().questAutomation||{};
  if(!qa.ads&&!qa.staking&&!qa.sudoku&&!qa.minesweeper&&!qa.quiz)return;

  const{fetchOwnGuildQuests,collectReadyQuests}=require('./capital');
  let ctx;
  try{ctx=await fetchOwnGuildQuests(api);}
  catch(e){logger.warn(`[${name}] [quest-auto] список квестов: ${e.message}`);return;}
  if(!ctx){logger.info(`[${name}] [quest-auto] не в гильдии — нечего делать`);return;}
  const{qList}=ctx;

  let actedAny=false;
  if(qa.ads&&questActive(qList,'ad_views')){await runAdsAutomation(api,name);actedAny=true;}
  if(qa.staking&&(questActive(qList,'staking_amount')||questActive(qList,'staking_count'))){await runStakingAutomation(api,name,account);actedAny=true;}
  if(qa.sudoku&&questActive(qList,'minigame_wins')){await runSudokuAutomation(api,name);actedAny=true;}
  if(qa.minesweeper&&questActive(qList,'minigame_wins')){await runMinesweeperAutomation(api,name);actedAny=true;}
  if(qa.quiz&&questActive(qList,'minigame_wins')){await runQuizAutomation(name,account.id);actedAny=true;}

  if(!actedAny){logger.info(`[${name}] [quest-auto] нет активных квестов под включённые действия — пропуск`);return;}

  // действия выше двигают ЛИЧНЫЙ прогресс — проверяем свежее состояние и клеймим прямо сейчас, не
  // дожидаясь завтрашнего runCapital (см. bot.js)
  try{
    const fresh=await fetchOwnGuildQuests(api);
    if(fresh)await collectReadyQuests(api,name,fresh.qList);
  }catch(e){logger.warn(`[${name}] [quest-auto] заклейм после действий: ${e.message}`);}
}

module.exports={runQuestAutomation,extractRarity};
