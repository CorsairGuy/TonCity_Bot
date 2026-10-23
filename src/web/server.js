'use strict';
const express=require('express');
const path=require('path');
const fs=require('fs');
const logger=require('../utils/logger');
const{apiForAcc,makeApiForAccount,midErr}=require('./lib/api');

function startWebServer(port){
  const app=express();

  // ВРЕМЕННАЯ ДИАГНОСТИКА (13.10.2026, снять после локализации причины зависания панели после
  // рекламы+сапёра): два независимых индикатора —
  //  1) лаг event loop (если Node САМ занят синхронной работой — тут будет видно НЕЗАВИСИМО от
  //     того, какой запрос это вызвал);
  //  2) долгие HTTP-запросы (если дело не в event loop, а в очереди/ожидании — тут будет видно,
  //     КАКОЙ именно запрос висит и сколько).
  let lastTick=Date.now();
  setInterval(()=>{
    const now=Date.now();
    const lag=now-lastTick-1000;
    if(lag>200)logger.warn(`[diag] event-loop лаг ${lag}мс — Node занят синхронной работой`);
    lastTick=now;
  },1000).unref();
  app.use((req,res,next)=>{
    const t0=Date.now();
    res.on('finish',()=>{
      const ms=Date.now()-t0;
      if(ms>2000)logger.warn(`[diag] долгий запрос ${req.method} ${req.originalUrl} — ${ms}мс`);
    });
    next();
  });

  app.use(express.json());
  // иконки предметов: заранее скачанные и докачанные ботом по тегу (см. utils/itemCatalog.js)
  app.use('/items',express.static(path.join(__dirname,'..','items')));
  app.use('/sprites',express.static(path.join(__dirname,'sprites')));

  const distDir=path.join(__dirname,'dist');
  if(fs.existsSync(distDir))app.use(express.static(distDir));

  // ── защита API паролем (сессионная кука) ───────────────────────────────────
  const auth=require('./auth');
  const AUTH_OPEN=new Set(['/api/auth/status','/api/login','/api/logout']);
  app.use((req,res,next)=>{
    if(!req.path.startsWith('/api/'))return next();      // статика/SPA — открыто
    if(AUTH_OPEN.has(req.path))return next();
    if(!auth.isPasswordSet())return next();              // первый запуск: пока пароль не задан
    if(auth.isAuthed(req))return next();
    return res.status(401).json({ok:false,error:'unauthorized'});
  });
  app.get('/api/auth/status',(req,res)=>{
    res.json({ok:true,required:auth.isPasswordSet(),authed:!auth.isPasswordSet()||auth.isAuthed(req)});
  });
  app.post('/api/login',(req,res)=>{
    const ip=req.ip||req.socket?.remoteAddress||'?';
    const lock=auth.loginLockMs(ip);
    if(lock>0)return res.status(429).json({ok:false,error:`слишком много попыток, подождите ${Math.ceil(lock/1000)}с`});
    if(!auth.isPasswordSet())return res.status(400).json({ok:false,error:'пароль не задан'});
    if(!auth.verifyPassword(req.body&&req.body.password)){auth.noteLoginFail(ip);return res.status(401).json({ok:false,error:'неверный пароль'});}
    auth.noteLoginOk(ip);
    auth.setSessionCookie(res,req,auth.makeToken());
    res.json({ok:true});
  });
  app.post('/api/logout',(req,res)=>{auth.clearSessionCookie(res);res.json({ok:true});});
  // установка/смена пароля (при заданном пароле эндпоинт уже за middleware → нужна сессия)
  app.post('/api/password',(req,res)=>{
    try{
      const b=req.body||{};
      auth.setPassword(b.password);
      auth.setSessionCookie(res,req,auth.makeToken());
      res.json({ok:true});
    }catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  // ── группы роутов (src/web/routes/*.js) ─────────────────────────────────────
  // Общие хелперы передаём через ctx; сами группы регистрируют свои /api/*.
  const ctx={apiForAcc,makeApiForAccount,midErr};
  require('./routes/core')(app,ctx);        // system/config/accounts/inventory/logs + item-действия
  require('./routes/plans')(app,ctx);       // референсы города/столицы, фазы, секции, координаты, снимки карт
  require('./routes/minigames')(app,ctx);   // вордли, сапёр, судоку, викторина, статус миниигр
  require('./routes/fortune')(app,ctx);     // павильон удачи
  require('./routes/dashboards')(app,ctx);  // магазин/мэрия/путь/достижения/промо/гильдии/спецздания/строители
  require('./routes/market')(app,ctx);      // центральный рынок: статистика/лоты/автоскупка/снайп/листинги (+воркеры)
  require('./routes/guilds')(app,ctx);      // инфо/МИД live/настройки/управление гильдией
  require('./routes/economy')(app,ctx);     // дорога верности, склад live, магазин live, стейкинг, реклама
  require('./routes/policies')(app,ctx);    // политики: библиотека/кабинет мэра
  require('./routes/civicDraw')(app,ctx);   // городской розыгрыш (Мэрия) — данные из civic_draw_status
  require('./routes/satoshi')(app,ctx);     // Башня Сатоши: трейдинг GRAM/USDT (курс — с реальных бирж)
  require('./routes/questTiers')(app,ctx);  // Уровни гильдейских квестов (guild-quests/tiers)
  require('./routes/guildBuildings')(app,ctx); // Технофабрика/Вечный аудиториум (спецздания гильдии, персональные действия)
  require('./routes/cityStrategy')(app,ctx); // Действия по городу: цели улучшений + разовые build/move/demolish
  require('./routes/capitalStrategy')(app,ctx); // Действия по столице: та же система, что и у города
  require('./routes/anniversary')(app,ctx); // Годовщина: Летний карнавал/Дорога наград/Предложение дня (событие 10-23.08)
  require('./routes/midway')(app,ctx);      // Карнавальная аллея: балаганы по дням, «Четыре в ряд» на билеты (19-24.08)
  require('./routes/leaderboard')(app,ctx); // рейтинги игры: «Величайшие мэры» и лиги мэров/гильдий
  require('./routes/refresh')(app,ctx);     // ручной прогон модулей /api/refresh/:module

  app.post('/api/restart',(req,res)=>{
    res.json({ok:true,message:'Restarting...'});
    setTimeout(()=>process.exit(0),500);
  });

  // SPA fallback — всё что не API отдаёт React-приложение
  app.get('*',(req,res)=>{
    const spa=path.join(distDir,'index.html');
    if(fs.existsSync(spa))return res.sendFile(spa);
    res.status(503).send('Frontend не собран. Выполните: cd src/web/client && npm run build');
  });

  const bindHost=process.env.WEB_BIND||'127.0.0.1';
  // ready резолвится ТОЛЬКО когда порт реально занят этим процессом (успешный listen). main() ждёт
  // его ДО прогрева сессий/refresh — иначе второй экземпляр во время ретрая бинда успел бы порефрешить
  // токены параллельно с первым (та самая гонка ротации). Пока порт не наш — refresh не начинаем.
  let resolveReady; const ready=new Promise(r=>{resolveReady=r;});
  const httpServer=app.listen(port,bindHost,()=>{
    const shown=(bindHost==='0.0.0.0'||bindHost==='::')?'localhost':bindHost;
    logger.info(`Web UI: http://${shown}:${port} (bind ${bindHost})`);
    if(!auth.isPasswordSet())logger.warn('[web] ПАРОЛЬ НЕ ЗАДАН — задайте его в Настройках. Сейчас панель открыта без пароля!');
    if(bindHost!=='127.0.0.1'&&bindHost!=='localhost')logger.warn(`[web] панель слушает ${bindHost} (доступна по сети). Обязательно задайте пароль и используйте HTTPS (reverse proxy / SSH-туннель).`);
    require('../utils/versionCheck').warmUp(); // проверка обновлений сразу после запуска
    resolveReady(httpServer);
  });
  // Порт как singleton-замок: если он занят (EADDRINUSE) — значит работает другой экземпляр бота
  // (напр. осиротевший старый процесс, которого nodemon не добил при рестарте на Windows). Раньше
  // эта ошибка уходила в uncaughtException (только логировалась, процесс НЕ выходил), и второй
  // экземпляр продолжал крутить лупы и РЕФРЕШИТЬ ТОКЕНЫ параллельно — два процесса ротировали
  // одноразовый refresh_token друг под другом, и аккаунты «вылетали» (Invalid or expired refresh).
  //
  // НО при НОРМАЛЬНОМ рестарте старый процесс ещё ~1-4с освобождает порт (graceful shutdown),
  // поэтому сразу выходить нельзя (режим перезапуска при правках не поднимет упавший скрипт — бот ляжет). Поэтому
  // РЕТРАЙ-бинд: ждём освобождения порта до BIND_RETRY_MAX*500мс. Если порт занят дольше — это
  // реально ВТОРОЙ живой экземпляр, тогда выходим, чтобы не трогать токены параллельно.
  const BIND_RETRY_MAX=24; // ~12с
  let bindAttempts=0;
  httpServer.on('error',(e)=>{
    if(e && e.code==='EADDRINUSE'){
      bindAttempts++;
      if(bindAttempts<=BIND_RETRY_MAX){
        if(bindAttempts===1)logger.warn(`[web] порт ${port} занят — жду, пока прежний процесс освободит его (рестарт?)…`);
        setTimeout(()=>{try{httpServer.listen(port,bindHost);}catch(_){}},500);
        return;
      }
      logger.error(`[web] порт ${port} занят дольше ${Math.round(BIND_RETRY_MAX*500/1000)}с — уже работает другой экземпляр бота. Выходим, чтобы не рефрешить токены параллельно (это убивает аккаунты).`);
      process.exit(1);
    }
    logger.error(`[web] ошибка HTTP-сервера: ${e?.message||e}`);
    process.exit(1);
  });
  // фоновые воркеры рынка регистрируются модулем routes/market и стартуют после listen
  try{if(app.__startAutobuyWorker)app.__startAutobuyWorker();}catch(e){logger.warn(`[autobuy] worker start: ${e.message}`);}
  try{if(app.__startSnipeScheduler)app.__startSnipeScheduler();}catch(e){logger.warn(`[snipe] scheduler start: ${e.message}`);}

  // ── Башня Сатоши: живые фиды (биржа + игра) → браузер по WS ──────────────────
  // Биржевой курс рассылается всем открытым вкладкам всегда (лёгкий, нужен разным страницам).
  // Курс ИГРЫ — только вкладкам, которые сами явно подписались {type:'subscribe',source:'game'}
  // (это делает только страница "Торговля" — см. useSatoshiFeed на фронте). Бэкенд при этом всё
  // равно держит фид игры постоянно для авто-закрытия TP/SL (utils/satoshiAutoClose.js), просто
  // не транслирует его в браузер, если никто не смотрит на страницу торговли.
  try{
    const WebSocketServer=require('ws').Server;
    const gramExchangeFeed=require('../utils/gramExchangeFeed');
    const gameGramFeed=require('../utils/gameGramFeed');
    const satoshiAutoClose=require('../modules/satoshiAutoClose');
    const satoshiPendingOrders=require('../modules/satoshiPendingOrders');
    const satoshiEvents=require('../utils/satoshiEvents');

    const wss=new WebSocketServer({server:httpServer,path:'/ws/satoshi'});
    wss.on('connection',ws=>{
      ws.satoshiSources=new Set();
      const send=msg=>{try{if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(msg));}catch(_){}};
      send({source:'exchange',type:'snapshot',price:gramExchangeFeed.getPrice()});
      ws.on('message',raw=>{
        let msg;try{msg=JSON.parse(raw.toString());}catch(_){return;}
        if(msg.type==='subscribe'&&(msg.source==='exchange'||msg.source==='game')){
          ws.satoshiSources.add(msg.source);
          if(msg.source==='game')send({source:'game',type:'snapshot',price:gameGramFeed.getPrice()});
        }else if(msg.type==='unsubscribe'){
          ws.satoshiSources.delete(msg.source);
        }
      });
    });
    const broadcast=(source,msg)=>{
      const s=JSON.stringify(msg);
      for(const c of wss.clients){try{if(c.readyState===c.OPEN&&c.satoshiSources?.has(source))c.send(s);}catch(_){}}
    };
    // биржевой курс шлём всем без разбора подписки (дёшево, не требует явного subscribe)
    const broadcastAll=msg=>{const s=JSON.stringify(msg);for(const c of wss.clients){try{if(c.readyState===c.OPEN)c.send(s);}catch(_){}}};

    gramExchangeFeed.onTick(price=>broadcastAll({source:'exchange',type:'tick',price}));
    gramExchangeFeed.onCandle(({timeframe,candle})=>broadcastAll({source:'exchange',type:'candle',timeframe,candle}));
    gameGramFeed.onPriceTick(price=>broadcast('game',{source:'game',type:'tick',price}));
    gameGramFeed.onCandle(({timeframe,candle})=>broadcast('game',{source:'game',type:'candle',timeframe,candle}));
    // позиция открылась/закрылась (в т.ч. авто по TP/SL или условному ордеру) — толкаем всем
    // открытым вкладкам, чтобы таблицы обновлялись сами, без перезагрузки страницы
    satoshiEvents.onPositionsChanged(({account})=>broadcastAll({type:'positions-changed',account}));

    gramExchangeFeed.ensureStarted().catch(e=>logger.warn(`[satoshi] exchange feed: ${e.message}`));
    gameGramFeed.ensureStarted().catch(e=>logger.warn(`[satoshi] game feed: ${e.message}`));
    satoshiAutoClose.start();
    satoshiPendingOrders.start();
  }catch(e){logger.warn(`[satoshi] live-фиды не запущены: ${e.message}`);}
  return ready; // main() ждёт успешного бинда (= мы единственный экземпляр) ДО прогрева сессий/refresh
}

module.exports={startWebServer};
