'use strict';
const axios=require('axios');
const fs=require('fs');
const path=require('path');
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {sleep,sleepUntilUtcMidnight}=require('../utils/helpers');
const {WordleLog}=require('../db/index');
const solver=require('./wordleSolver');

// --- словарь ---
const WORDS_PATH=path.join(process.cwd(),'config','wordle-words.txt');
function _loadWords(){
  try{
    return fs.readFileSync(WORDS_PATH,'utf8')
      .split(/\r?\n/)
      .map(w=>w.trim().toLowerCase())
      .filter(w=>w.length===5&&/^[а-яёa-z]+$/.test(w));
  }catch(e){logger.warn(`[wordle] не удалось загрузить словарь: ${e.message}`);return[];}
}
let WORDS=_loadWords();
logger.info(`[wordle] словарь загружен: ${WORDS.length} слов`);

const REJECTED_PATH=path.join(process.cwd(),'logs','wordle_rejected.json');
function _loadRejected(){
  try{if(fs.existsSync(REJECTED_PATH))return new Set(JSON.parse(fs.readFileSync(REJECTED_PATH,'utf8')));}catch(_){}
  return new Set();
}
function _saveRejected(){
  try{fs.writeFileSync(REJECTED_PATH,JSON.stringify([...rejectedWords]),'utf8');}catch(_){}
}

async function _tgPost(token,method,body){
  try{
    const res=await axios.post(`https://api.telegram.org/bot${token}/${method}`,body,{
      headers:{'Content-Type':'application/json'},timeout:15000});
    return res.data;
  }catch(e){
    const d=e.response?.data?JSON.stringify(e.response.data):e.message;
    logger.warn(`[wordle] TG ${method} failed: ${d}`);
  }
}

async function _sendWordleResult(word){
  const cfg=getConfig();
  const token=cfg.telegram?.wordleBot||cfg.telegram?.botToken;
  const chatId=cfg.telegram?.wordleChatId||cfg.telegram?.marketChatId;
  const threadId=cfg.telegram?.wordleThreadId||null;
  if(!token||!chatId){logger.warn('[wordle] telegram не настроен, пропуск отправки');return;}
  const text=`WORDLE: ${word.toUpperCase()}`;
  const body={chat_id:chatId,text};
  if(threadId&&String(threadId)!=='1')body.message_thread_id=String(threadId);
  const data=await _tgPost(token,'sendMessage',body);
  if(data?.ok)logger.info(`[wordle] результат отправлен в Telegram`);
}

// --- shared state ---
const sharedState={
  date:null,word:null,usedWords:[],history:[],stuck:false,
};
const rejectedWords=_loadRejected();

// Выбирает догадку энтропийным подбором (modules/wordleSolver.js). Если ни одно слово словаря не сходится
// с ответами игры (загадано слово не из словаря), бот больше не гадает: попытки остаются для ручной подачи.
async function _pickGuess(){
  if(sharedState.word)return sharedState.word;
  if(sharedState.stuck)return null;
  try{
    const r=await solver.bestGuess(WORDS,sharedState.history,new Set([...sharedState.usedWords,...rejectedWords]));
    if(r){logger.info(`[wordle] подходящих слов: ${r.left}, догадка "${r.guess}"${r.pool?` (первое слово, случайное из: ${r.pool.join(', ')})`:''}`);return r.guess;}
    logger.warn('[wordle] ни одно слово словаря не подходит под ответы игры — загадано слово не из словаря, попытки оставлены для ручной подачи');
  }catch(e){logger.error(`[wordle] подбор слова: ${e.message}`);}
  sharedState.stuck=true;
  return null;
}

function _applyFeedback(feedback){
  const word=Array.isArray(feedback)?feedback.slice().sort((a,b)=>a.position-b.position).map(f=>f.letter).join(''):'';
  const pattern=solver.patternOfFeedback(feedback);
  if(word.length===5&&pattern!=null&&!sharedState.history.some(h=>h.word===word))sharedState.history.push({word,pattern});
}

// --- игровая логика ---

// Бот использует не больше 5 попыток на аккаунт — 6-я оставлена для ручного ввода слова через UI.
const MAX_BOT_ATTEMPTS=5;

function _resetIfNewDay(){
  const today=new Date().toISOString().slice(0,10);
  if(sharedState.date!==today){
    sharedState.date=today;
    sharedState.word=null;
    sharedState.usedWords=[];
    sharedState.history=[];
    sharedState.stuck=false;
    // перезагрузим словарь в начале нового дня
    WORDS=_loadWords();
  }
}

async function _guessOnce(api,name,word){
  try{
    const r=await api.post('/wordle/guess',{word});
    logger.info(`[${name}] [wordle] guess "${word}" → attempts:${r?.stats?.attempts} won:${r?.stats?.won}`);
    return{ok:true,data:r};
  }catch(e){
    const msg=e.message||'';
    const notInDict=msg.includes('нет в словаре')||msg.includes('5 букв');
    logger.error(`[${name}] [wordle] guess "${word}": ${msg}`);
    return{ok:false,notInDict};
  }
}

async function _solveForAccount(api,name,maxAttempts){
  let statsResp;
  try{statsResp=await api.get('/wordle/stats');}catch(e){logger.warn(`[${name}] [wordle] stats error: ${e.message}`);return false;}
  if(statsResp?.won)return false;

  const prevAttempts=Array.isArray(statsResp?.stats)?statsResp.stats:[];
  if(prevAttempts.length>=maxAttempts)return false;

  if(sharedState.word){
    logger.info(`[${name}] [wordle] используем найденное слово "${sharedState.word}"`);
    await sleep(3000);
    await _guessOnce(api,name,sharedState.word);
    return true;
  }

  for(let tries=0;tries<20;tries++){
    const guess=await _pickGuess();
    if(!guess)return false;

    await sleep(3000);
    const res=await _guessOnce(api,name,guess);
    sharedState.usedWords.push(guess);

    if(!res.ok){
      if(res.notInDict){
        rejectedWords.add(guess);
        _saveRejected();
        logger.warn(`[wordle] "${guess}" не в словаре, исключаем навсегда`);
        continue;
      }
      return false;
    }

    const r=res.data;
    if(r.feedback)_applyFeedback(r.feedback);
    if(r.stats?.won){
      sharedState.word=guess;
      logger.info(`[${name}] [wordle] СЛОВО НАЙДЕНО: "${guess}"`);
      await _sendWordleResult(guess);
    }
    return true;
  }
  return false;
}

// Слова попыток из ответа /wordle/stats (игра отдаёт только попытки текущего игрового дня)
function _wordsFromStats(s){
  const arr=Array.isArray(s?.stats)?s.stats:[];
  return arr.map(a=>Array.isArray(a.feedback)?a.feedback.slice().sort((x,y)=>x.position-y.position).map(f=>f.letter).join(''):'').filter(x=>x.length===5);
}

// Пишет строку WordleLog за день строго по ответу игры: слова и победа — только этого дня
async function _saveLog(name,date,s){
  const words=_wordsFromStats(s);
  try{await WordleLog.upsert({account:name,played_at:date,won:s?.won?1:0,attempts:words.length,words:JSON.stringify(words)});}
  catch(e){logger.warn(`[wordle] [${name}] сохранение в БД: ${e.message}`);}
}

async function runWordleOnce(clients){
  _resetIfNewDay();
  // дата фиксируется на старте прохода: проход, перешедший через полночь, пишет в свой день
  const day=sharedState.date;
  logger.info('[wordle] сбор истории попыток со всех аккаунтов...');

  for(const{api,name}of clients){
    try{
      const s=await api.get('/wordle/stats');
      if(s?.won&&!sharedState.word){
        const last=Array.isArray(s.stats)?s.stats[s.stats.length-1]:null;
        if(last?.feedback){
          const w=last.feedback.slice().sort((a,b)=>a.position-b.position).map(f=>f.letter).join('');
          if(w.length===5)sharedState.word=w;
        }
      }
      const prev=Array.isArray(s?.stats)?s.stats:[];
      for(const attempt of prev){
        if(!Array.isArray(attempt.feedback))continue;
        _applyFeedback(attempt.feedback);
        const w=attempt.feedback.slice().sort((a,b)=>a.position-b.position).map(f=>f.letter).join('');
        if(w.length===5&&!sharedState.usedWords.includes(w))sharedState.usedWords.push(w);
      }
    }catch(e){logger.warn(`[wordle] [${name}] stats error: ${e.message}`);}
    await sleep(300);
  }
  logger.info(`[wordle] словарь: ${WORDS.length} слов | использовано: ${sharedState.usedWords.length} | слово: ${sharedState.word?`"${sharedState.word}"`:'не найдено'}`);

  for(let round=0;round<MAX_BOT_ATTEMPTS;round++){
    if(sharedState.word)break;
    logger.info(`[wordle] раунд ${round+1}/${MAX_BOT_ATTEMPTS}`);
    let anyActive=false;
    for(const{api,name}of clients){
      try{
        if(await _solveForAccount(api,name,MAX_BOT_ATTEMPTS))anyActive=true;
      }catch(e){logger.error(`[wordle] [${name}] ${e.message}`);}
      await sleep(500);
    }
    if(!anyActive){logger.info(sharedState.stuck?'[wordle] подбор остановлен: слова нет в словаре':'[wordle] все попытки исчерпаны');break;}
  }

  if(sharedState.word){
    logger.info(`[wordle] подаём "${sharedState.word}" на оставшиеся аккаунты`);
    for(const{api,name}of clients){
      try{await _solveForAccount(api,name,MAX_BOT_ATTEMPTS);}
      catch(e){logger.error(`[wordle] [${name}] ${e.message}`);}
      await sleep(500);
    }
  }

  // итог дня — из свежего /wordle/stats каждого аккаунта, а не из накопленного в памяти
  for(const{api,name}of clients){
    try{await _saveLog(name,day,await api.get('/wordle/stats'));}
    catch(e){logger.warn(`[wordle] [${name}] stats для журнала: ${e.message}`);}
    await sleep(300);
  }
  logger.info('[wordle] подбор завершён');
}

async function runWordleLoop(clients){
  logger.info('[wordle-loop] запуск');
  while(true){
    try{await runWordleOnce(clients);}
    catch(e){logger.error(`[wordle-loop] ${e.message}`);}
    await sleepUntilUtcMidnight();
  }
}

async function runWordle(api,name){
  await _solveForAccount(api,name,MAX_BOT_ATTEMPTS);
}

// Подаёт конкретное слово вручную на все аккаунты (6-я попытка из UI).
// Не подаёт, если аккаунт уже выиграл или исчерпал все 6 попыток.
async function submitWordAll(clients,word){
  const w=String(word||'').trim().toLowerCase();
  const results=[];
  if(w.length!==5||!/^[а-яёa-z]+$/.test(w))return{ok:false,error:'нужно слово из 5 букв',results};
  _resetIfNewDay();
  const day=sharedState.date;
  const saveLog=(name,s)=>_saveLog(name,day,s);
  for(const{api,name}of clients){
    try{
      const s=await api.get('/wordle/stats').catch(()=>null);
      if(s?.won){await saveLog(name,s);results.push({name,ok:true,skipped:'уже выиграл'});continue;}
      const prev=Array.isArray(s?.stats)?s.stats:[];
      if(prev.length>=6){await saveLog(name,s);results.push({name,ok:false,error:'попытки исчерпаны (6/6)'});continue;}
      const r=await _guessOnce(api,name,w);
      if(r.ok){
        const won=!!r.data?.stats?.won;
        if(won&&!sharedState.word)sharedState.word=w;
        // перечитываем актуальные stats и пишем в БД, чтобы таблица показывала реальные слова/победу
        const fresh=await api.get('/wordle/stats').catch(()=>null);
        await saveLog(name,fresh||s);
        results.push({name,ok:true,won,attempts:r.data?.stats?.attempts??(prev.length+1)});
      }else{
        results.push({name,ok:false,error:r.notInDict?'нет в словаре':'ошибка'});
      }
    }catch(e){results.push({name,ok:false,error:e.message});}
    await sleep(400);
  }
  return{ok:true,word:w,results};
}

module.exports={runWordle,runWordleOnce,runWordleLoop,submitWordAll};
