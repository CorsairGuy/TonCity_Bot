'use strict';
const gramExchangeFeed=require('../../utils/gramExchangeFeed');
const gameGramFeed=require('../../utils/gameGramFeed');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

// Башня Сатоши — эндпоинты подтверждены реверсом клиента (стор "trading", chunks/satoshi_tower-*):
//   GET  /satoshi-tower/config              — {max_leverage,min_margin,min_fee,fee_rate,max_open_positions}
//   GET  /satoshi-tower/positions           — {open:[...],history:[...],history_cursor,history_has_more,mark_price}
//   POST /satoshi-tower/positions           — {side:'long'|'short',leverage,margin}
//   POST /satoshi-tower/positions/close     — {position_id}
// Курс/свечи — ДВА живых источника, оба через WebSocket:
//   source=exchange (по умолчанию) — реальные биржи Binance→OKX→KuCoin (utils/gramExchangeFeed.js)
//   source=game                    — сама игра, push через WS "дежурного" аккаунта (utils/gameGramFeed.js,
//                                     вариант А — доп. соединений не открываем, WS у аккаунта и так обязателен)
// TP/SL — фича бота (игра не поддерживает): храним в БД, проверяет utils/satoshiAutoClose.js по курсу игры.

let configCache={ts:0,data:null};
const CONFIG_TTL=5*60*1000;

function feedFor(source){ return source==='game'?gameGramFeed:gramExchangeFeed; }

module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  // Надёжный POST для торговых действий (открытие/закрытие позиции, условный ордер). Гейт игры
  // пускает REST только при ЖИВОМ авторизованном WS аккаунта; если WS в момент запроса в окне
  // переподключения (напр. аккаунтом параллельно пользуется живой человек — сервер вышибает WS),
  // запрос падает 403 "Direct API access"/"Invalid request signature". Раньше это сразу ловил юзер
  // ("иногда не создаётся позиция"). Теперь: до запроса поднимаем сессию (ensureSession прогревает
  // WS+seed), и при транзиентной ошибке гейта форсим реконнект и повторяем — до attempts раз.
  async function tradePost(acc,path,body,attempts=5){
    const wsSession=require('../../utils/wsSession');
    const{ensureSession}=require('../../modules/session');
    let lastErr;
    for(let i=0;i<attempts;i++){
      const api=await makeApiForAccount(acc.id,{noLock:true});
      if(i===0){try{await ensureSession(api,acc);}catch(_){}}// прогрев WS/seed перед первой попыткой
      try{ return{api,result:await api.post(path,body)}; }
      catch(e){
        lastErr=e;
        const transient=e.wsNotReady||e.noSeed||e.badSignature||e.status===403;
        if(!transient||i===attempts-1)throw e;
        try{wsSession.forceReconnect(acc.id);}catch(_){}
        await new Promise(r=>setTimeout(r,1200*(i+1))); // ждём переавторизацию WS (с новым seed)
      }
    }
    throw lastErr;
  }

  app.get('/api/satoshi/price',async(req,res)=>{
    try{
      const feed=feedFor(req.query.source);
      await feed.ensureStarted();
      res.json({ok:true,...feed.getPrice()});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/satoshi/candles',async(req,res)=>{
    try{
      const timeframe=String(req.query.timeframe||'1h');
      const limit=Math.min(1000,parseInt(req.query.limit)||300);
      const candles=await feedFor(req.query.source).getCandles(timeframe,limit);
      res.json({ok:true,candles});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // конфиг торговли (плечо/маржа/комиссия) — общий для игры, берём с любого рабочего аккаунта и кэшируем
  app.get('/api/satoshi/config',async(req,res)=>{
    try{
      const now=Date.now();
      if(configCache.data&&now-configCache.ts<CONFIG_TTL)return res.json({ok:true,config:configCache.data});
      const{Account}=require('../../db/index');
      const{Op}=require('sequelize');
      // конфиг доступен только аккаунтам с Башней Сатоши на карте (аналогично Рынку/Павильону удачи)
      const accs=await Account.findAll({where:{access_token:{[Op.not]:null},special_buildings:{[Op.like]:'%satoshi%'}},attributes:['id'],limit:5});
      let config=null;
      for(const acc of accs){
        try{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          config=await api.get('/satoshi-tower/config');
          if(config)break;
        }catch(_){}
      }
      if(!config)return res.status(502).json({ok:false,error:'Не удалось получить конфиг ни с одного аккаунта'});
      configCache={ts:now,data:config};
      res.json({ok:true,config});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // данные читаются из БД (снимок пишет src/modules/satoshi.js в дневном цикле бота или по
  // кнопке "Обновить" → POST /api/refresh/satoshi) — аналогично страницам "Предметы"/"Политики".
  //
  // Раньше один эндпоинт /api/satoshi/positions отдавал ОТКРЫТЫЕ (маленькие, живые — обновляются
  // на каждый positions-changed) И ЗАКРЫТЫЕ позиции (у активно торгующего флота — тысячи строк)
  // одним ответом. Это значило: любое обновление открытых позиций (тик цены, чужое авто-закрытие
  // по TP/SL) тянуло за собой ВСЮ историю закрытых, хотя фронт всё равно показывает её по 30 за
  // раз через пагинацию. Разделяем на три независимых пути: открытые (живые, без пагинации — их
  // мало), закрытые (пагинация СЕРВЕРНАЯ — отдаём только запрошенную страницу) и сводная
  // прибыль (день/неделя — считается агрегатом в БД, не требует тянуть сами строки на фронт).
  function mapPositionRow(r,accIdByName){
    return{
      id:r.id,account:r.account,account_id:accIdByName[r.account]??null,side:r.side,
      leverage:r.leverage,margin:r.margin,notional:r.notional,entry_price:r.entry_price,
      liquidation_price:r.liquidation_price,opened_at:r.opened_at,
    };
  }

  app.get('/api/satoshi/open',async(req,res)=>{
    try{
      const{Account,SatoshiPosition}=require('../../db/index');
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const rows=await SatoshiPosition.findAll({order:[['opened_at','DESC']]});
      const open=rows.map(r=>({
        ...mapPositionRow(r,accIdByName),
        tp_price:r.tp_price,sl_price:r.sl_price,tp_pnl_pct:r.tp_pnl_pct,sl_pnl_pct:r.sl_pnl_pct,
        game_tp_price:r.game_tp_price,game_sl_price:r.game_sl_price,
      }));
      res.json({ok:true,open});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // серверная пагинация: страница=page (с нуля), размер=pageSize — фронт запрашивает только ту
  // страницу, которую реально показывает, а не всю таблицу разом
  app.get('/api/satoshi/history',async(req,res)=>{
    try{
      const{Account,SatoshiPositionHistory}=require('../../db/index');
      const page=Math.max(0,parseInt(req.query.page)||0);
      const pageSize=Math.min(200,Math.max(1,parseInt(req.query.pageSize)||30));
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const{count,rows}=await SatoshiPositionHistory.findAndCountAll({
        order:[['closed_at','DESC']],limit:pageSize,offset:page*pageSize,
      });
      const history=rows.map(r=>({
        ...mapPositionRow(r,accIdByName),
        close_price:r.close_price,realized_pnl:r.realized_pnl,fee:r.fee,payout:r.payout,
        status:r.status,closed_at:r.closed_at,
      }));
      res.json({ok:true,history,total:count,page,pageSize});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // дневная/недельная прибыль по ВСЕМ закрытым позициям — считаем SUM прямо в БД, не тянем строки.
  // fee может быть NULL (modules/satoshi.js пишет p.fee??null) — SUM(realized_pnl-fee) без COALESCE
  // давал NULL для таких строк, а SUM() молча ИСКЛЮЧАЕТ NULL-строки целиком (не считает fee нулевой,
  // а выкидывает всю позицию из суммы) — раньше на фронте было realized_pnl-(fee??0), т.е. null-fee
  // считался нулевым, а не поводом выбросить позицию. COALESCE(fee,0) возвращает то же поведение.
  // Через ORM .findOne({attributes:[[fn...]], raw:true}), а не сырой seq.query — так возврат
  // предсказуемо плоский объект {net}, без риска перепутать вложенность [rows,metadata] сырого
  // драйвера mariadb (это и оказалось реальной причиной, почему счётчики всегда показывали 0).
  app.get('/api/satoshi/profit-summary',async(req,res)=>{
    try{
      const{SatoshiPositionHistory}=require('../../db/index');
      const{fn,literal,Op}=require('sequelize');
      const dayAgo=new Date(Date.now()-24*60*60*1000);
      const weekAgo=new Date(Date.now()-7*24*60*60*1000);
      const netSum=async(since)=>{
        const row=await SatoshiPositionHistory.findOne({
          attributes:[[fn('SUM',literal('realized_pnl-COALESCE(fee,0)')),'net']],
          where:{closed_at:{[Op.gte]:since}},
          raw:true,
        });
        return Number(row?.net)||0;
      };
      const[daily,weekly]=await Promise.all([netSum(dayAgo),netSum(weekAgo)]);
      res.json({ok:true,daily,weekly});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // "Обновить баланс" — только аккаунты с Башней Сатоши на карте. /progress/ уже даёт crystals,
  // переиспользуем session.saveStats (тот же путь, что и обычный дневной цикл бота)
  app.post('/api/satoshi/refresh-balances',async(req,res)=>{
    try{
      const{updated,total}=await opRegistry.run('satoshiRefreshBalances',async()=>{
        const{Account}=require('../../db/index');
        const{Op}=require('sequelize');
        const{saveStats}=require('../../modules/session');
        const accs=await Account.findAll({where:{access_token:{[Op.not]:null},special_buildings:{[Op.like]:'%satoshi%'}}});
        const results=await Promise.allSettled(accs.map(async acc=>{
          const api=await makeApiForAccount(acc.id,{noLock:true});
          const d=await api.get('/progress/');
          if(d?.progress)saveStats(acc,acc.name,d);
        }));
        return{updated:results.filter(r=>r.status==='fulfilled').length,total:accs.length};
      });
      res.json({ok:true,updated,total});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Макс. плечо ПЕР-АККАУНТ: /satoshi-tower/config пер-аккаунтный, max_leverage отражает
  // применённые политики (базово 10×, политика на плечо поднимает до 20× и т.п. — клиент игры не
  // хардкодит потолок, берёт config.max_leverage). Собираем по всем satoshi-аккаунтам, кэш 10 мин
  // (меняется редко — только при применении/снятии политики). Модалки ордеров/позиций используют
  // это, чтобы разрешить 20× там, где политика есть, и капить до 10× на остальных.
  let _levCache={ts:0,data:null};
  app.get('/api/satoshi/leverage-limits',async(req,res)=>{
    try{
      if(req.query.fresh!=='1'&&_levCache.data&&Date.now()-_levCache.ts<10*60*1000)return res.json({ok:true,..._levCache.data});
      const{Account}=require('../../db/index');const{Op}=require('sequelize');
      const accs=await Account.findAll({where:{access_token:{[Op.not]:null},special_buildings:{[Op.like]:'%satoshi%'}}});
      const limits={};
      await Promise.allSettled(accs.map(async acc=>{
        try{const api=await makeApiForAccount(acc.id,{noLock:true});const c=await api.get('/satoshi-tower/config');if(c&&c.max_leverage!=null)limits[acc.id]=Number(c.max_leverage);}catch(_){}
      }));
      const data={limits,default:10};
      _levCache={ts:Date.now(),data};
      res.json({ok:true,...data});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Игровой (серверный) TP/SL — обновление игры 31.07.2026. Вся математика уровней (перевод
  // процентов ROI в цену, границы игры, правило «только ужесточение») вынесена в общий модуль,
  // потому что нужна и здесь, и в modules/satoshiPendingOrders.js — см. utils/satoshiTriggers.js.
  const{buildOpenTriggers,pnlPctToPrice,isTightening}=require('../../utils/satoshiTriggers');

  // Предпросмотр уровней, которые РЕАЛЬНО уйдут в игру при открытии. Игра принимает только
  // абсолютную цену, а у нас ввод может быть в ROI%/«% движения курса» — считаем ТЕМ ЖЕ кодом,
  // что и само открытие (utils/satoshiTriggers), чтобы показанное и отправленное не разъехались.
  app.post('/api/satoshi/trigger-preview',async(req,res)=>{
    try{
      const{side,leverage,margin,price,tp_price,sl_price,tp_pnl_pct,sl_pnl_pct}=req.body||{};
      if(side!=='long'&&side!=='short')return res.status(400).json({ok:false,error:'side должен быть long или short'});
      let entry=Number(price)||null;
      if(!(entry>0)){ // цену не передали — берём текущую из кэша конфига/живого запроса
        const{Account}=require('../../db/index');const{Op}=require('sequelize');
        const acc=await Account.findOne({where:{access_token:{[Op.not]:null},special_buildings:{[Op.like]:'%satoshi%'}},attributes:['id']});
        if(acc){try{const a=await makeApiForAccount(acc.id,{noLock:true});const p=await a.get('/satoshi-tower/price');entry=Number(p?.price)||null;}catch(_){}}
      }
      const cfg=configCache.data;
      const t=buildOpenTriggers(cfg,{side,entry,margin,leverage,tp_price,sl_price,tp_pnl_pct,sl_pnl_pct});
      res.json({ok:true,entry,take_profit_price:t.take_profit_price??null,stop_loss_price:t.stop_loss_price??null});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/satoshi/:accountId/open',async(req,res)=>{
    try{
      const{side,leverage,margin,tp_price,sl_price,tp_pnl_pct,sl_pnl_pct}=req.body||{};
      if(side!=='long'&&side!=='short')return res.status(400).json({ok:false,error:'side должен быть long или short'});
      if(!(leverage>0)||!(margin>0))return res.status(400).json({ok:false,error:'leverage и margin обязательны и должны быть положительными'});
      const{Account,SatoshiPosition}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name','special_buildings']});
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      if(!String(acc.special_buildings||'').split(',').includes('satoshi'))
        return res.status(400).json({ok:false,error:'У этого аккаунта нет Башни Сатоши на карте'});
      const before=new Set((await SatoshiPosition.findAll({where:{account:acc.name},attributes:['id']})).map(r=>r.id));

      // Игровой TP/SL: считаем цены ДО открытия (игра принимает их только в этом запросе).
      // Точку отсчёта берём как текущую цену — фактическая entry_price может чуть отличаться
      // (позиция открывается по цене сервера в момент обработки), поэтому потом ещё подрезаем.
      const cfg=configCache.data||await (async()=>{try{const a=await makeApiForAccount(acc.id,{noLock:true});return await a.get('/satoshi-tower/config');}catch(_){return null;}})();
      let refPrice=null;
      try{const a=await makeApiForAccount(acc.id,{noLock:true});const p=await a.get('/satoshi-tower/price');refPrice=Number(p?.price)||null;}catch(_){}
      const openBody={
        side,leverage:Number(leverage),margin:Number(margin),
        ...buildOpenTriggers(cfg,{side,entry:refPrice,margin,leverage,tp_price,sl_price,tp_pnl_pct,sl_pnl_pct}),
      };
      const{api,result}=await tradePost(acc,'/satoshi-tower/positions',openBody);
      const satoshiMod=require('../../modules/satoshi');
      await satoshiMod.applyBalance(acc.id,result?.new_balance);
      await satoshiMod.runSatoshi(api,acc.name).catch(()=>{});

      // бот-side поля пишем ВСЕГДА, даже когда игровой TP/SL встал: они работают «на ужесточение»
      // (закрыть раньше игрового) и покрывают правку уровней после открытия, чего игра не умеет
      const hasTpSl=tp_price!=null||sl_price!=null||tp_pnl_pct!=null||sl_pnl_pct!=null;
      if(hasTpSl){
        const after=await SatoshiPosition.findAll({where:{account:acc.name}});
        const created=after.find(r=>!before.has(r.id));
        if(created){
          if(created.side!==side)
            logger.warn(`[${acc.name}] [satoshi] запросили side=${side}, игра открыла side=${created.side} (id ${created.id})`);
          await created.update({
            tp_price:tp_price!=null?Number(tp_price):null,
            sl_price:sl_price!=null?Number(sl_price):null,
            tp_pnl_pct:tp_pnl_pct!=null?Number(tp_pnl_pct):null,
            sl_pnl_pct:sl_pnl_pct!=null?Number(sl_pnl_pct):null,
          });
        }
      }
      res.json({ok:true,result});
    }catch(e){
      logger.warn(`[satoshi] open (side=${req.body?.side} lev=${req.body?.leverage} margin=${req.body?.margin}) failed: ${e.message}`);
      res.status(500).json({ok:false,error:e.message});
    }
  });

  app.post('/api/satoshi/:accountId/close',async(req,res)=>{
    try{
      const{position_id}=req.body||{};
      if(position_id==null)return res.status(400).json({ok:false,error:'position_id обязателен'});
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name']});
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const{api,result}=await tradePost(acc,'/satoshi-tower/positions/close',{position_id:Number(position_id)});
      const satoshiMod=require('../../modules/satoshi');
      await satoshiMod.applyBalance(acc.id,result?.new_balance);
      await satoshiMod.runSatoshi(api,acc.name).catch(()=>{});
      res.json({ok:true,result});
    }catch(e){
      logger.warn(`[satoshi] close (position_id=${req.body?.position_id}) failed: ${e.message}`);
      res.status(500).json({ok:false,error:e.message});
    }
  });

  // Редактирование TP/SL уже открытой позиции — по-прежнему только в нашей БД: у игры эндпоинта на
  // правку нет, её TP/SL зафиксирован в момент открытия.
  //
  // ОТСЮДА ГЛАВНОЕ ОГРАНИЧЕНИЕ ГИБРИДА: бот способен только УЖЕСТОЧИТЬ уровень — закрыть позицию
  // РАНЬШЕ игрового триггера. Ослабить (отодвинуть TP дальше / SL ниже) невозможно: игра закроет
  // позицию на своём уровне раньше, чем бот успеет что-либо сделать. Поэтому такие правки не
  // принимаем молча, а честно отклоняем с объяснением — иначе пользователь думал бы, что уровень
  // сдвинут, а игра всё равно закроет по своему.
  //   LONG : «строже» = TP НИЖЕ игрового, SL ВЫШЕ игрового
  //   SHORT: «строже» = TP ВЫШЕ игрового, SL НИЖЕ игрового
  // (сама проверка — isTightening в utils/satoshiTriggers.js)
  app.patch('/api/satoshi/positions/:id',async(req,res)=>{
    try{
      const{SatoshiPosition}=require('../../db/index');
      const row=await SatoshiPosition.findByPk(Number(req.params.id));
      if(!row)return res.status(404).json({ok:false,error:'Позиция не найдена (возможно уже закрыта)'});
      const{tp_price,sl_price,tp_pnl_pct,sl_pnl_pct}=req.body||{};
      const body=req.body||{};
      const payload={};
      if('tp_price'in body)payload.tp_price=tp_price!=null?Number(tp_price):null;
      if('sl_price'in body)payload.sl_price=sl_price!=null?Number(sl_price):null;
      if('tp_pnl_pct'in body)payload.tp_pnl_pct=tp_pnl_pct!=null?Number(tp_pnl_pct):null;
      if('sl_pnl_pct'in body)payload.sl_pnl_pct=sl_pnl_pct!=null?Number(sl_pnl_pct):null;
      // проценты ROI тоже приводим к цене — сравнивать с игровым уровнем можно только в ценах
      const cfg=configCache.data;
      // знак: тейк — прибыль (+), стоп — убыток (−); sl_pnl_pct хранится положительным
      const toPrice=(pct)=>pnlPctToPrice(cfg,{side:row.side,entry:row.entry_price,margin:row.margin,leverage:row.leverage,pct});
      const effTp=payload.tp_price??(payload.tp_pnl_pct!=null?toPrice(Math.abs(payload.tp_pnl_pct)):null);
      const effSl=payload.sl_price??(payload.sl_pnl_pct!=null?toPrice(-Math.abs(payload.sl_pnl_pct)):null);
      if(!isTightening(row.side,'tp',row.game_tp_price,effTp))
        return res.status(400).json({ok:false,error:`Игровой тейк-профит уже стоит на ${row.game_tp_price} и его нельзя изменить — бот может закрыть только РАНЬШЕ. Чтобы отодвинуть уровень, закройте позицию и откройте заново.`});
      if(!isTightening(row.side,'sl',row.game_sl_price,effSl))
        return res.status(400).json({ok:false,error:`Игровой стоп-лосс уже стоит на ${row.game_sl_price} и его нельзя изменить — бот может закрыть только РАНЬШЕ. Чтобы отодвинуть уровень, закройте позицию и откройте заново.`});
      await row.update(payload);
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ── Условные ордера ("открыть по цене") — фича бота, следит за биржевым курсом
  // (utils/satoshiPendingOrders.js), настоящее открытие в игре — только при срабатывании ──────

  app.get('/api/satoshi/pending',async(req,res)=>{
    try{
      const{SatoshiPendingOrder,Account}=require('../../db/index');
      const{Op}=require('sequelize');
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      // triggered — уже стал реальной позицией (см. историю), cancelled — снят пользователем (в т.ч.
      // отменённый "зависший" failed-ордер новой кнопкой ниже) — оба больше не нужны в этом списке
      const rows=await SatoshiPendingOrder.findAll({where:{status:{[Op.notIn]:['triggered','cancelled']}},order:[['created_at','DESC']]});
      res.json({ok:true,orders:rows.map(r=>({
        id:r.id,account:r.account,account_id:accIdByName[r.account]??null,side:r.side,leverage:r.leverage,margin:r.margin,
        trigger_price:r.trigger_price,ref_price:r.ref_price,tp_price:r.tp_price,sl_price:r.sl_price,
        tp_pnl_pct:r.tp_pnl_pct,sl_pnl_pct:r.sl_pnl_pct,status:r.status,error:r.error,created_at:r.created_at,
      }))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/satoshi/:accountId/pending',async(req,res)=>{
    try{
      const{side,leverage,margin,trigger_price,tp_price,sl_price,tp_pnl_pct,sl_pnl_pct}=req.body||{};
      if(side!=='long'&&side!=='short')return res.status(400).json({ok:false,error:'side должен быть long или short'});
      if(!(leverage>0)||!(margin>0))return res.status(400).json({ok:false,error:'leverage и margin обязательны и должны быть положительными'});
      if(!(trigger_price>0))return res.status(400).json({ok:false,error:'trigger_price обязателен'});
      const{Account,SatoshiPendingOrder}=require('../../db/index');
      const acc=await Account.findByPk(Number(req.params.accountId),{attributes:['id','name','special_buildings']});
      if(!acc)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      if(!String(acc.special_buildings||'').split(',').includes('satoshi'))
        return res.status(400).json({ok:false,error:'У этого аккаунта нет Башни Сатоши на карте'});
      const refPrice=gramExchangeFeed.getPrice().price||null;
      const row=await SatoshiPendingOrder.create({
        account:acc.name,side,leverage:Number(leverage),margin:Number(margin),trigger_price:Number(trigger_price),
        ref_price:refPrice,tp_price:tp_price!=null?Number(tp_price):null,sl_price:sl_price!=null?Number(sl_price):null,
        tp_pnl_pct:tp_pnl_pct!=null?Number(tp_pnl_pct):null,sl_pnl_pct:sl_pnl_pct!=null?Number(sl_pnl_pct):null,
        status:'pending',created_at:new Date(),
      });
      res.json({ok:true,id:row.id});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.delete('/api/satoshi/pending/:id',async(req,res)=>{
    try{
      const{SatoshiPendingOrder}=require('../../db/index');
      const row=await SatoshiPendingOrder.findByPk(Number(req.params.id));
      if(!row)return res.status(404).json({ok:false,error:'Ордер не найден'});
      await row.update({status:'cancelled'});
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
