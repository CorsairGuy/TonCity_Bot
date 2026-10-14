'use strict';
// Выполнение заданий «Летнего карнавала» за аккаунт: досмотреть рекламу и выиграть мини-игры до
// порога, который требует само событие. Задания и их пороги берём из /anniversary-event/ (у каждой
// ступени есть progress/required) — ничего не хардкодим: если игра завтра попросит не 4 победы,
// а 3 или 6, раннер сам это увидит.
//
// Почему фоновый реестр, а не обычный HTTP-обработчик: одна викторина решается ~2.5 минуты, а
// «сделать всем» — это десятки аккаунтов подряд. Такой запрос не переживёт ни таймаут прокси, ни
// перезагрузку страницы. Схема ровно как у quizProgress/adsProgress/game2048Progress: работа живёт
// в процессе бота, страница только спрашивает статус (/api/anniversary/tasks/status).
const logger=require('../../utils/logger');
const{sleep}=require('../../utils/helpers');

// Порядок игр — от гарантированных и быстрых к долгим и негарантированным:
// сапёр/судоку решаются солверами наверняка и за секунды, викторина — верно, но ~2.5 мин,
// вордли зависит от слова дня, 2048 «победой» считается только 2048-я плитка, поэтому она последняя.
const GAME_ORDER=['minesweeper','sudoku','quiz','wordle','2048'];
const GAME_TITLE={minesweeper:'Сапёр',sudoku:'Судоку',quiz:'Викторина',wordle:'Вордли','2048':'2048'};
// Пауза между просмотрами рекламы — как в modules/dailyads.js (игра не засчитывает подряд).
const AD_GAP_MS=10_000;
// Сколько аккаунтов обрабатываем одновременно в режиме «всем». Больше нет смысла: каждая мини-игра
// — это десятки запросов подряд, а игру мы уже роняли параллелизмом (см. web/lib/accountSweep.js).
const CONCURRENCY=3;
// Потолки времени. Без них ОДНА зависшая мини-игра (напр. викторина, которая ждёт ответа игры)
// намертво занимает воркер, и очередь встаёт: 14.08 из 48 поставленных аккаунтов отработали два,
// дальше тишина. Промис отменить нельзя — но ждать его вечно мы не обязаны: по таймауту идём
// дальше, а «повисшая» игра доигрывает сама себе в фоне.
const GAME_TIMEOUT_MS={minesweeper:3*60_000,sudoku:3*60_000,quiz:8*60_000,wordle:5*60_000,'2048':12*60_000};
const ACCOUNT_BUDGET_MS=25*60_000;
function withTimeout(p,ms,label){
  let t;
  return Promise.race([
    Promise.resolve(p).finally(()=>clearTimeout(t)),
    new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(`${label}: не уложилось в ${Math.round(ms/60000)} мин`)),ms);}),
  ]);
}

const registry=new Map();   // accountId -> {name,step,wins,needed,ads,adsNeeded,running,error,startedAt,finishedAt}
const queue=[];             // ожидающие аккаунты
let workers=0;

function list(){
  return[...registry.entries()].map(([account_id,e])=>({account_id,...e}));
}
function get(accountId){return registry.get(Number(accountId));}

// ── что именно требует событие ────────────────────────────────────────────────
function allTasks(board){
  const t=board?.tasks||{};
  return[...(t.regular||[]),...(t.exclusive||[]),...(t.meta||[])];
}
// первая незабранная ступень задания — та же логика, что показывает игра
function activeTier(task){
  const tiers=task?.tiers||[];
  const tier=tiers.find(x=>!x.claimed);
  return tier||null;
}
// сколько ещё нужно «единиц» задания (побед/просмотров). null — задания нет или оно уже закрыто.
function remainingFor(board,match){
  const task=allTasks(board).find(t=>match(String(t.identifier||'')));
  if(!task)return null;
  const tier=activeTier(task);
  if(!tier)return null;
  if(tier.completed)return 0;
  if(tier.required==null)return 1;                    // задание без числового порога
  return Math.max(0,Number(tier.required)-Number(tier.progress||0));
}
const adsRemaining=board=>remainingFor(board,id=>id.includes('watch_ad'));
const winsRemaining=board=>remainingFor(board,id=>id.includes('minigame'));
const guildRemaining=board=>remainingFor(board,id=>id.includes('guild_contribute'));
const loginRemaining=board=>remainingFor(board,id=>id.includes('daily_login'));

// ── победы за сегодня, чтобы не переигрывать уже сыгранное ───────────────────
async function wonToday(accountName){
  const{MinigameLog,WordleLog}=require('../../db/index');
  const played_at=new Date().toISOString().slice(0,10);
  const won=new Set();
  const rows=await MinigameLog.findAll({where:{account:accountName,played_at}}).catch(()=>[]);
  for(const r of rows)if(r.won)won.add(r.game);
  const w=await WordleLog.findOne({where:{account:accountName,played_at}}).catch(()=>null);
  if(w?.won)won.add('wordle');
  return won;
}

async function playGame(game,accountId,name,makeApiForAccount){
  const api=await makeApiForAccount(accountId,{noLock:true});
  if(game==='minesweeper')return require('../../modules/minesweeper').solveMinesweeper(api,name);
  if(game==='sudoku')return require('../../modules/sudoku').solveSudoku(api,name,'master');
  if(game==='quiz'){
    // через общий реестр викторины: если её уже решают из «Оплота Мудрости», второй запуск не
    // создаётся — просто дожидаемся текущего
    const entry=require('./quizProgress').start(accountId,name,makeApiForAccount,false);
    await entry.promise;
    return{won:true};
  }
  if(game==='wordle'){
    // runWordle решает вордли ИМЕННО за этот аккаунт (runWordleOnce — коллективный проход по всем
    // клиентам сразу, для одиночного запуска не подходит). Победу читаем по факту из /wordle/stats:
    // слово дня может и не поддаться за отведённые попытки.
    await require('../../modules/wordle').runWordle(api,name);
    const s=await api.get('/wordle/stats').catch(()=>null);
    return{won:!!s?.won};
  }
  if(game==='2048'){
    const entry=require('./game2048Progress').start(accountId,name,makeApiForAccount);
    await entry.promise;
    return{won:entry.game_status==='won'};
  }
  return{won:false};
}

// Взнос в Казну Гильдии — задание «Пополнить Казну Гильдии». Игре важен САМ ФАКТ взноса, а не
// сумма, поэтому кладём минимум (1 монету): POST /guilds/{id}/treasury/deposit {amount,currency}
// (путь и тело сверены с бандлом, чанк treasury-*). Гильдию берём из своего же снимка GuildSnapshot.
const GUILD_DEPOSIT_COINS=1;
async function depositToGuild(api,name){
  const{GuildSnapshot}=require('../../db/index');
  const row=await GuildSnapshot.findOne({where:{account:name}});
  const guildId=row?.guild_id;
  if(!guildId)throw new Error('аккаунт не состоит в гильдии (нет GuildSnapshot)');
  return api.post(`/guilds/${guildId}/treasury/deposit`,{amount:GUILD_DEPOSIT_COINS,currency:'coins'});
}

// ── основной проход по одному аккаунту ───────────────────────────────────────
async function runAccount(accountId,name,makeApiForAccount,{ad=true,minigames=true,guild=false,login=false}){
  const st=registry.get(accountId);
  const startedAt=Date.now();
  const api=await makeApiForAccount(accountId,{noLock:true});
  const board=await api.get('/anniversary-event/');

  if(ad){
    const need=adsRemaining(board);
    st.adsNeeded=need??0;
    if(need){
      st.step='смотрю рекламу';
      for(let i=0;i<need;i++){
        const r=await api.post('/daily-ads/',{});
        if(!r||!('balance' in r)){logger.warn(`[${name}] [carnival] реклама не засчитана: ${JSON.stringify(r)}`);break;}
        st.ads=(st.ads||0)+1;
        if(i<need-1)await sleep(AD_GAP_MS);
      }
      // счётчик рекламы в БД после просмотра иначе останется старым (страница «Ежедневная реклама»
      // читает именно снимок)
      try{
        const{DailyAdsSnapshot}=require('../../db/index');
        const s=await require('../../modules/dailyads').getDailyAdsStatus(api,name);
        await DailyAdsSnapshot.upsert({account:name,...s,updated_at:new Date()},{conflictFields:['account']});
      }catch(_){}
    }
  }

  if(login){
    // «Ежедневный вход» события засчитывается обычным ежедневным входом игры (POST /daily-login/).
    // ВАЖНО: если вход за сегодня уже забран (это делает и суточный цикл бота), повторный запрос
    // игра не примет — и раньше мы всё равно бодро писали «выполнено», хотя не отправляли ничего,
    // а на странице задание так и оставалось невыполненным (жалоба 14.08). Теперь: смотрим статус,
    // жмём только если не забрано, и в любом случае ПРОВЕРЯЕМ доску — если игра не засчитала,
    // честно говорим об этом в статусе.
    const need=loginRemaining(board);
    if(need){
      st.step='ежедневный вход';
      const status=await api.get('/daily-login/').catch(()=>null);
      const lastLogin=status?.daily_login?.last_login??null;
      const alreadyToday=lastLogin?!require('../../utils/helpers').isDifferentDay(lastLogin):false;
      if(!alreadyToday)await require('../../modules/tasks').runDailyLogin(api,name);
      else{
        // Вход за сегодня забран, но НЕ нами (например руками в игре) — в DailyLog записи нет,
        // и страница продолжала бы предлагать «Выполнить». Отмечаем факт у себя: по этой записи
        // (actionsDoneToday в routes/anniversary.js) сразу показывается «Забрать».
        try{
          const{DailyLog}=require('../../db/index');
          await DailyLog.upsert({account:name,logged_at:new Date().toISOString().slice(0,10)},{conflictFields:['account','logged_at']});
        }catch(_){}
      }
      const after=await api.get('/anniversary-event/').catch(()=>null);
      const left=after?loginRemaining(after):null;
      if(left){
        st.error=alreadyToday
          ?'вход за сегодня уже был забран — событие его не засчитало, заберите награду в игре'
          :'игра не засчитала ежедневный вход';
        logger.warn(`[${name}] [carnival] вход НЕ засчитан событием (last_login=${lastLogin}, уже сегодня=${alreadyToday})`);
      }else{
        logger.info(`[${name}] [carnival] ежедневный вход засчитан${alreadyToday?' (был забран ранее)':''}`);
      }
    }
  }

  if(guild){
    const need=guildRemaining(board);
    if(need){
      st.step='взнос в казну гильдии';
      await depositToGuild(api,name);
      // отмечаем факт в логе действий: по нему страница поймёт, что «Выполнить» уже нажимали
      // сегодня, и покажет «Забрать» (см. actionsDoneToday в routes/anniversary.js)
      await require('../../modules/cityActionLog').logAction(name,'guild_deposit',{detail:JSON.stringify({coins:GUILD_DEPOSIT_COINS})});
      logger.info(`[${name}] [carnival] взнос в казну: ${GUILD_DEPOSIT_COINS} монета`);
    }
  }

  if(minigames){
    // без «Оплота Мудрости» мини-игр у аккаунта просто нет — не тратим попытки и говорим честно
    const{Account}=require('../../db/index');
    const acc=await Account.findByPk(accountId,{attributes:['special_buildings']});
    if(!String(acc?.special_buildings||'').split(',').includes('wisdom')){
      st.step='готово';
      st.error='нет Оплота Мудрости — мини-игры недоступны';
      return;
    }
    const need=winsRemaining(board);
    st.needed=need??0;
    if(need){
      const already=await wonToday(name);
      let wins=0;
      for(const game of GAME_ORDER){
        if(wins>=need)break;
        if(already.has(game))continue;               // сегодня уже выиграна — событие её и так зачло
        if(Date.now()-startedAt>ACCOUNT_BUDGET_MS){st.error='не уложились в отведённое время';break;}
        st.step=`играю: ${GAME_TITLE[game]}`;
        try{
          const r=await withTimeout(playGame(game,accountId,name,makeApiForAccount),GAME_TIMEOUT_MS[game]||5*60_000,GAME_TITLE[game]);
          if(r?.won){wins++;st.wins=wins;logger.info(`[${name}] [carnival] победа: ${GAME_TITLE[game]} (${wins}/${need})`);}
          else logger.info(`[${name}] [carnival] ${GAME_TITLE[game]}: победы нет`);
        }catch(e){logger.warn(`[${name}] [carnival] ${GAME_TITLE[game]}: ${e.message}`);}
      }
      if(wins<need)st.error=`не хватило побед: ${wins} из ${need} (сегодня доступные игры кончились)`;
    }
  }
  st.step='готово';
}

// ── очередь ──────────────────────────────────────────────────────────────────
function enqueue(accountId,name,makeApiForAccount,opts={}){
  accountId=Number(accountId);
  const existing=registry.get(accountId);
  if(existing&&existing.running)return existing;      // уже работаем над этим аккаунтом
  // kinds — какие именно виды заданий сейчас выполняются. Страница по ним понимает, какую кнопку
  // держать в спиннере, и делает это ПОСЛЕ перезагрузки тоже: состояние живёт в процессе бота, а не
  // во вкладке (тот же приём, что у quizProgress/adsProgress).
  const kinds=['login','ad','guild','minigames'].filter(k=>opts[k==='minigames'?'minigames':k]);
  const entry={name,kinds,step:'в очереди',wins:0,needed:null,ads:0,adsNeeded:null,running:true,error:null,startedAt:Date.now(),finishedAt:null};
  registry.set(accountId,entry);
  queue.push({accountId,name,makeApiForAccount,opts});
  pump();
  return entry;
}

function pump(){
  while(workers<CONCURRENCY&&queue.length){
    const job=queue.shift();
    workers++;
    (async()=>{
      const st=registry.get(job.accountId);
      try{
        st.step='начинаю';
        await runAccount(job.accountId,job.name,job.makeApiForAccount,job.opts);
      }catch(e){
        st.error=e.message;
        logger.warn(`[${job.name}] [carnival] ${e.message}`);
      }finally{
        st.running=false;
        st.finishedAt=Date.now();
        workers--;
        pump();
      }
    })();
  }
}

// строки старше получаса убираем, чтобы список статуса не рос вечно
function prune(){
  const cutoff=Date.now()-30*60_000;
  for(const[id,e]of registry)if(!e.running&&e.finishedAt&&e.finishedAt<cutoff)registry.delete(id);
}

module.exports={enqueue,list,get,prune,adsRemaining,winsRemaining,guildRemaining,loginRemaining};
