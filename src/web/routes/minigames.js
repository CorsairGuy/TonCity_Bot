'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');

module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;
  // только аккаунты с Оплотом Мудрости на карте (наличие из /progress/ в special_buildings)
  const hasWisdom=a=>String(a.special_buildings||'').split(',').includes('wisdom');

  app.get('/api/wordle-status',async(req,res)=>{
    try{
      const{WordleLog}=require('../../db/index');
      const date=req.query.date||new Date().toISOString().slice(0,10);
      const rows=await WordleLog.findAll({where:{played_at:date},order:[['account','ASC']]});
      res.json({ok:true,date,rows:rows.map(r=>({account:r.account,won:!!r.won,attempts:r.attempts,words:r.words?JSON.parse(r.words):[]}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ручной ввод слова на все аккаунты (6-я попытка)
  app.post('/api/wordle/guess-all',async(req,res)=>{
    try{
      const word=req.body&&req.body.word;
      if(!word)return res.status(400).json({ok:false,error:'word обязателен'});
      const{Account}=require('../../db/index');
      const{submitWordAll}=require('../../modules/wordle');
      const accs=(await Account.findAll({order:[['id','ASC']]})).filter(hasWisdom);
      const clients=[];
      for(const acc of accs){
        if(!acc.access_token||acc.access_token==='placeholder')continue;
        clients.push({api:await makeApiForAccount(acc.id,{noLock:true}),name:acc.name});
      }
      if(!clients.length)return res.status(400).json({ok:false,error:'нет аккаунтов с токеном'});
      const r=await submitWordAll(clients,word);
      res.json(r);
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Оплот Мудрости: Сапёр и Судоку (авто-решение + награда) ─────────────────
  async function solveMinigameAll(res,solveFn){
    try{
      const{Account}=require('../../db/index');
      const accs=(await Account.findAll({order:[['id','ASC']]})).filter(hasWisdom);
      const results=[];
      for(const acc of accs){
        if(!acc.access_token||acc.access_token==='placeholder'){results.push({id:acc.id,name:acc.name,ok:false,error:'нет токена'});continue;}
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const r=await solveFn(api,acc.name);
          results.push({id:acc.id,name:acc.name,ok:true,...r});
        }catch(e){results.push({id:acc.id,name:acc.name,ok:false,error:e.message});}
      }
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  }
  app.post('/api/minesweeper/solve',async(req,res)=>{
    try{
      const{account_id}=req.body||{};
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const{solveMinesweeper}=require('../../modules/minesweeper');
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(account_id,{attributes:['name']});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await solveMinesweeper(api,acc?.name||String(account_id));
      res.json({ok:true,...r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/minesweeper/solve-all',(req,res)=>{
    const{solveMinesweeper}=require('../../modules/minesweeper');
    solveMinigameAll(res,(api,name)=>solveMinesweeper(api,name));
  });
  app.post('/api/sudoku/solve',async(req,res)=>{
    try{
      const{account_id,difficulty}=req.body||{};
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const{solveSudoku}=require('../../modules/sudoku');
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(account_id,{attributes:['name']});
      const api=await makeApiForAccount(Number(account_id),{noLock:true});
      const r=await solveSudoku(api,acc?.name||String(account_id),difficulty||'master');
      res.json({ok:true,...r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/sudoku/solve-all',(req,res)=>{
    const{solveSudoku}=require('../../modules/sudoku');
    const difficulty=(req.body&&req.body.difficulty)||'master';
    solveMinigameAll(res,(api,name)=>solveSudoku(api,name,difficulty));
  });
  // Викторина решается долго (~2.5 мин/аккаунт) → запускаем в фоне через общий реестр
  // quizProgress (см. web/lib/quizProgress.js): решение крутится независимо от конкретного
  // SSE-соединения, поэтому прогресс переживает перезагрузку страницы — при повторном открытии
  // фронт сначала спрашивает /api/quiz/live, кто сейчас решает, и просто подписывается заново
  // вместо повторного запуска (см. solve-stream ниже — если решение уже идёт, новый запуск
  // не создаётся).
  const quizProgress=require('../lib/quizProgress');

  app.post('/api/quiz/solve',async(req,res)=>{
    const{account_id}=req.body||{};
    if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
    try{
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(account_id,{attributes:['name']});
      quizProgress.start(Number(account_id),acc?.name||String(account_id),makeApiForAccount);
      res.json({ok:true,started:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // кто сейчас решает и на каком вопросе — для восстановления прогресса после перезагрузки страницы
  app.get('/api/quiz/live',(req,res)=>{
    res.json({ok:true,rows:quizProgress.list()});
  });

  app.get('/api/quiz/solve-stream',async(req,res)=>{
    const accountId=parseInt(req.query&&req.query.account_id);
    if(!accountId)return res.status(400).json({ok:false,error:'account_id required'});
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    let entry=quizProgress.get(accountId);
    if(!entry){
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(accountId);
      if(!acc){res.write(`data: ${JSON.stringify({type:'done',ok:false,error:'Аккаунт не найден'})}\n\n`);return res.end();}
      entry=quizProgress.start(accountId,acc.name,makeApiForAccount);
    }else if(entry.current){
      // уже идёт (переоткрыли страницу) — сразу отдаём текущий прогресс, не дожидаясь след. вопроса
      res.write(`data: ${JSON.stringify({type:'progress',current:entry.current,total:entry.total})}\n\n`);
    }
    entry.subscribers.add(res);
    req.on('close',()=>{entry.subscribers.delete(res);});
  });

  app.post('/api/quiz/solve-all',(req,res)=>{
    (async()=>{
      try{
        const{Account}=require('../../db/index');
        const{cleanupWrongAnswers}=require('../../modules/quiz');
        const accs=(await Account.findAll({order:[['id','ASC']]})).filter(hasWisdom);
        const running=[];
        for(const acc of accs){
          if(!acc.access_token||acc.access_token==='placeholder')continue;
          // параллельно, без pruneWrong (чистим неверные общим проходом в конце)
          const entry=quizProgress.start(acc.id,acc.name,makeApiForAccount,false);
          running.push(entry.promise.catch(()=>{}));
          await new Promise(r=>setTimeout(r,30000)); // следующий аккаунт через 30 секунд
        }
        await Promise.all(running);
        await cleanupWrongAnswers(); // удалить неверные по вопросам с известным верным
      }catch(_){}
    })();
    res.json({ok:true,started:true});
  });

  // ── Оплот Мудрости: 2048 — ручная игра (модалка) + автоигра ("Решить", из таблицы или из
  // модалки). Механика (доска 4x4, направления up/down/left/right, POST /game2048/ {direction})
  // подтверждена реверсом бандла игры — там же (chunks/game2048-*.js) подтверждено, что реальный
  // клиент игры держит per-move lock (`l.value`) и НИКОГДА не шлёт следующий ход, пока не пришёл
  // ответ на предыдущий + 150мс на анимацию — наши паузы (400мс в "Решить") и так медленнее этого.
  //
  // Ручные ходы из модалки — {noLock:true}: сознательно НЕ идём через общий apiLock (он один на ВСЕ аккаунты разом,
  // concurrency:1 — 2048 одного аккаунта стояла бы в очереди позади рыночных/квестовых запросов
  // ДРУГИХ аккаунтов, а игра должна отвечать сразу). Вместо этого — свой лимитер НА КОНКРЕТНЫЙ
  // аккаунт (perAccountRateLimit, concurrency:1) — разные аккаунты друг друга не ждут, а для одного
  // и того же аккаунта гарантированно не бывает двух запросов к /game2048/ одновременно.
  // Автоигра «Решить» (с 23.10.2026) наоборот ходит через общий apiLock, чтобы партии многих
  // аккаунтов разом не упирались в рейт-лимит игры, а ход считает в своём потоке (game2048Progress.js).
  //
  // "Решить" крутится в фоне НЕЗАВИСИМО от конкретного SSE-соединения (см. web/lib/
  // game2048Progress.js) — закрытие вкладки/переход на другую страницу больше не останавливает
  // автоигру. solve-stream ниже либо стартует новую партию, либо (если она уже идёт — запущена из
  // таблицы или из модалки этого же аккаунта раньше) просто подписывается на неё и сразу отдаёт
  // текущее состояние доски одним 'snapshot'-событием, чтобы клиент мог мгновенно "довесить" вид
  // без ре-анимации всех прошлых ходов.
  const VALID_DIRS=new Set(['up','down','left','right']);
  const {logResult}=require('../../modules/game2048');
  const perAccountRateLimit=require('../lib/perAccountRateLimit');
  const game2048Progress=require('../lib/game2048Progress');
  const game2048Recorder=require('../../utils/game2048Recorder');

  // ВАЖНО: /live должен быть зарегистрирован РАНЬШE /:accountId — Express матчит роуты в порядке
  // регистрации, а не по специфичности. Раньше /live стоял НИЖЕ /:accountId, из-за чего запрос
  // к /api/game2048/live матчился как /:accountId с accountId="live" (Number("live")=NaN),
  // makeApiForAccount(NaN,...) падал, и клиент получал голый 500 вместо списка идущих партий —
  // именно это ломало восстановление "кто сейчас играет" после перезагрузки страницы.
  app.get('/api/game2048/live',(req,res)=>{
    res.json({ok:true,rows:game2048Progress.list()});
  });

  app.get('/api/game2048/:accountId',async(req,res)=>{
    try{
      const{withRetry}=require('../../utils/helpers');
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      // транзитные сетевые сбои (ECONNABORTED и т.п.) у игры бывают регулярно — без ретрая они
      // всплывали прямо в браузер как голый 500 при открытии модалки
      const st=await withRetry(()=>perAccountRateLimit.forAccount(req.params.accountId).run(()=>api.get('/game2048/')),3,1500,`game2048 state ${req.params.accountId}`);
      // запись партии (если включена) начинается с доски, которую человек видит при открытии модалки
      if(game2048Recorder.enabled()&&!game2048Progress.get(Number(req.params.accountId))){
        const{Account}=require('../../db/index');
        const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['name']}).catch(()=>null);
        game2048Recorder.touch(Number(req.params.accountId),acc?.name||String(req.params.accountId),st);
      }
      res.json({ok:true,board:st.board,score:st.score,max_tile:st.max_tile,game_status:st.game_status});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/game2048/:accountId/move',async(req,res)=>{
    try{
      const{direction}=req.body||{};
      if(!VALID_DIRS.has(direction))return res.status(400).json({ok:false,error:'direction обязателен (up/down/left/right)'});
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['name']});
      const api=await makeApiForAccount(Number(req.params.accountId),{noLock:true});
      const st=await perAccountRateLimit.forAccount(req.params.accountId).run(()=>api.post('/game2048/',{direction}));
      game2048Recorder.record(Number(req.params.accountId),acc?.name||String(req.params.accountId),direction,st);
      if(st?.game_status&&st.game_status!=='ongoing')await logResult(acc?.name||String(req.params.accountId),st);
      res.json({ok:true,board:st.board,score:st.score,max_tile:st.max_tile,game_status:st.game_status,reward:st.reward});
    }catch(e){res.status(500).json({ok:false,error:e?.response?.data?.error||e.message});}
  });

  app.get('/api/game2048/:accountId/solve-stream',async(req,res)=>{
    const accountId=Number(req.params.accountId);
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    let entry=game2048Progress.get(accountId);
    if(!entry){
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(accountId,{attributes:['name']});
      entry=game2048Progress.start(accountId,acc?.name||String(accountId),makeApiForAccount);
    }
    if(entry.board){
      res.write(`data: ${JSON.stringify({type:'snapshot',board:entry.board,score:entry.score,max_tile:entry.max_tile,game_status:entry.game_status})}\n\n`);
    }
    entry.subscribers.add(res);
    req.on('close',()=>{entry.subscribers.delete(res);});
  });

  // "Стоп" — явно останавливает фоновую партию (закрытие SSE само по себе больше НЕ останавливает
  // игру, см. заголовок раздела), доигрывает уже отправленный ход и завершается
  app.post('/api/game2048/:accountId/stop',(req,res)=>{
    game2048Progress.stop(Number(req.params.accountId));
    res.json({ok:true});
  });

  app.get('/api/minigame-status',async(req,res)=>{
    try{
      const{MinigameLog}=require('../../db/index');
      const date=req.query.date||new Date().toISOString().slice(0,10);
      const where={played_at:date};
      if(req.query.game)where.game=req.query.game;
      // раньше без ORDER BY при дублях строк (см. миграцию uniq_minigame в db/index.js) отдавался
      // произвольный порядок — на странице статус "сыграно" мигал туда-сюда между обновлениями.
      // id DESC + первое вхождение на аккаунт=игра ниже гарантируют одну и ту же (самую свежую)
      // запись каждый раз, даже если в БД ещё остались старые дубли до применения миграции.
      const rows=await MinigameLog.findAll({where,order:[['id','DESC']]});
      const seen=new Set();
      const out=[];
      for(const r of rows){
        const key=`${r.account}:${r.game}`;
        if(seen.has(key))continue;
        seen.add(key);
        out.push({account:r.account,game:r.game,won:!!r.won,reward:r.reward,score:r.score});
      }
      res.json({ok:true,date,rows:out});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
