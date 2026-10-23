'use strict';
// Общий (на процесс) реестр сейчас автоигранных партий 2048 — та же схема, что quizProgress.js/
// adsProgress.js: игра крутится в фоне НЕЗАВИСИМО от конкретного SSE-соединения (закрытие вкладки/
// переход на другую страницу больше не останавливает бота — раньше solve-stream сам ловил
// req.on('close') и прерывал цикл ходов, из-за чего "Решить" работало только пока вкладка открыта).
// При повторном открытии страницы/модалки фронт просто подписывается на уже идущую партию вместо
// повторного запуска — entry.board всегда хранит самое свежее состояние доски для мгновенного
// "довеска" новому подписчику (см. solve-stream в web/routes/minigames.js).
const logger=require('../../utils/logger');
const{withRetry}=require('../../utils/helpers');

// Сколько ждём ответ на ход и на чтение состояния. Обычно игра отвечает за доли секунды, а на
// частые ходы иногда молчит до общего таймаута клиента (30 с) — это её защита от частых запросов.
// Ход при этом, как правило, уже применён, поэтому не ждём до конца, а обрываем и перечитываем доску.
const MOVE_TIMEOUT_MS=5000,STATE_TIMEOUT_MS=8000;

const registry=new Map(); // accountId -> {board,score,max_tile,game_status,subscribers:Set<Response>,stopped,promise}

function broadcast(accountId,data){
  const entry=registry.get(accountId);
  if(!entry)return;
  const line=`data: ${JSON.stringify(data)}\n\n`;
  for(const res of entry.subscribers){try{res.write(line);}catch(_){}}
}

function list(){
  return[...registry.entries()].map(([accountId,e])=>({account_id:accountId,board:e.board,score:e.score,max_tile:e.max_tile,game_status:e.game_status}));
}

function get(accountId){return registry.get(accountId);}

// "Стоп" — явный флаг, проверяемый между ходами (не завязан на закрытие HTTP-соединения, см.
// заголовок файла). Цикл доигрывает текущий уже отправленный ход и завершается сам.
function stop(accountId){
  const entry=registry.get(accountId);
  if(entry)entry.stopped=true;
}

function start(accountId,name,makeApiForAccount){
  const existing=registry.get(accountId);
  if(existing)return existing;
  const entry={board:null,score:0,max_tile:0,game_status:'ongoing',subscribers:new Set(),stopped:false,promise:null};
  registry.set(accountId,entry);
  let engine=null;
  entry.promise=(async()=>{
    try{
      const{logResult}=require('../../modules/game2048');
      const perAccountRateLimit=require('./perAccountRateLimit');
      // запросы автоигры идут через общий apiLock (решение 23.10.2026): партии многих аккаунтов
      // одновременно не должны упираться в рейт-лимит игры. Ход считается в своём потоке на партию
      // (modules/game2048Worker.js), поэтому расчёт не держит ни apiLock, ни процесс бота.
      const api=await makeApiForAccount(accountId);
      engine=require('../../modules/game2048Worker').create();
      const limiter=perAccountRateLimit.forAccount(accountId);
      // withRetry — иначе один транзитный сетевой сбой (ECONNABORTED/таймаут, реально наблюдалось в
      // логах: "POST: /game2048/: нет ответа от сервера (ECONNABORTED)") убивал всю фоновую партию
      // целиком (catch ниже помечал её 'done' с ошибкой) после буквально пары ходов — снаружи это
      // выглядело как "бот перестал играть"/"поле не обновляется", хотя дело было не в SSE вообще.
      let st=await withRetry(()=>limiter.run(()=>api.get('/game2048/',{},{timeout:STATE_TIMEOUT_MS})),3,2000,`${name} 2048 load`);
      entry.board=st.board;entry.score=st.score;entry.max_tile=st.max_tile;entry.game_status=st.game_status;
      broadcast(accountId,{type:'snapshot',board:st.board,score:st.score,max_tile:st.max_tile,game_status:st.game_status});
      while(st?.game_status==='ongoing'&&!entry.stopped){
        const{dir}=await engine.bestMove(st.board);
        if(!dir)break;
        await new Promise(r=>setTimeout(r,400));
        if(entry.stopped)break;
        // ХОД, в отличие от загрузки состояния, НЕ идемпотентен — если сервер его принял, но ответ
        // просто не дошёл (та же ECONNABORTED), повторная отправка ЭТОГО ЖЕ хода рискует применить
        // его дважды подряд и испортить партию. Поэтому при сбое POST'а не ретраим сам ход, а
        // перечитываем реальное состояние с сервера (как делает модалка при открытии,
        // GET /game2048/) и просто продолжаем цикл с него — bestMove на следующей итерации сам
        // выберет ход заново от актуальной доски.
        let animated=true;
        try{
          st=await limiter.run(()=>api.post('/game2048/',{direction:dir},{timeout:MOVE_TIMEOUT_MS}));
        }catch(e){
          logger.warn(`[${name}] [2048] move failed (${e.message}) — resync вместо повтора хода`);
          st=await withRetry(()=>limiter.run(()=>api.get('/game2048/',{},{timeout:STATE_TIMEOUT_MS})),3,2000,`${name} 2048 resync`);
          animated=false;
        }
        entry.board=st.board;entry.score=st.score;entry.max_tile=st.max_tile;entry.game_status=st.game_status;
        broadcast(accountId,animated
          ?{type:'move',direction:dir,board:st.board,score:st.score,max_tile:st.max_tile,game_status:st.game_status}
          :{type:'snapshot',board:st.board,score:st.score,max_tile:st.max_tile,game_status:st.game_status});
      }
      if(st?.game_status&&st.game_status!=='ongoing')await logResult(name,st);
      broadcast(accountId,{type:'done',ok:true,game_status:st?.game_status,reward:st?.reward,stopped:entry.stopped});
    }catch(e){
      logger.warn(`[${name}] [2048] solve: ${e.message}`);
      broadcast(accountId,{type:'done',ok:false,error:e.message});
    }finally{
      if(engine)engine.close();
      for(const res of entry.subscribers){try{res.end();}catch(_){}}
      registry.delete(accountId);
    }
  })();
  entry.promise.catch(()=>{});
  return entry;
}

module.exports={start,stop,get,list,broadcast};
