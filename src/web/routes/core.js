'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const axios=require('axios');
const{loadSettings,saveSettings,DEFAULTS,mergeDeep}=require('../../config');
const BASE_URL='https://game.toncity.io/api';

// Раскодировать payload JWT access_token (без проверки подписи — она нам не нужна, важен только
// claim игрока). Реальная структура токена TON City (проверено декодом живых токенов из БД):
//   { exp, iat, tg_uid }  — НИКАКОГО имени внутри нет, только Telegram user id (tg_uid).
function decodeJwtPayload(token){
  if(!token||typeof token!=='string')return null;
  const parts=token.split('.');
  if(parts.length<2)return null;
  try{
    return JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
  }catch(_){return null;}
}
// Стабильный идентификатор реального игрового аккаунта для дедупа. Раньше искали sub/user_id/uid/id —
// таких полей в токене НЕТ, поэтому дедуп молча всегда возвращал null и откатывался на дедуп по имени
// (из-за чего и появлялись дубли). Настоящее поле — tg_uid.
function decodeJwtSubject(token){
  const p=decodeJwtPayload(token);
  if(!p)return null;
  return p.tg_uid||p.sub||p.user_id||p.uid||p.id||null;
}

module.exports=function(app,ctx){
  // Каталог предметов игры (id → тип/имя/редкость) + иконки: нужен, чтобы новые предметы
  // (билеты, летний/алмазный набор, камни реформ) показывались нормально, а не как «#40».
  // Обновляется не чаще раза в 12ч и любым живым аккаунтом — каталог общий для всех.
  app.get('/api/items',async(req,res)=>{
    try{
      const itemCatalog=require('../../utils/itemCatalog');
      if(itemCatalog.ageMs()>=12*60*60*1000){
        try{
          const{Account}=require('../../db/index');
          const{Op}=require('sequelize');
          const acc=await Account.findOne({where:{access_token:{[Op.not]:null}},attributes:['id']});
          if(acc)await itemCatalog.ensureFresh(await ctx.makeApiForAccount(acc.id,{noLock:true}));
        }catch(_){/* не вышло — отдадим то, что уже есть */}
      }
      // Параметр ?ids= клиент всё ещё присылает, но ничего поштучно мы больше НЕ спрашиваем:
      // такого эндпоинта у игры нет (см. utils/itemCatalog.js). Отдаём то, что собрано из
      // /storage/allitemdata; неизвестные id клиент подписывает из своей статической таблицы.
      // Название — из локализации игры (бандл game.toncity.io, utils/itemLocale.js): так новые предметы
      // события подписываются сразу, без правки таблиц в клиенте. Первый раз ждём загрузку, дальше
      // обновляем раз в сутки в фоне.
      const itemLocale=require('../../utils/itemLocale');
      if(itemLocale.ageMs()===Infinity)await itemLocale.ensureFresh();
      else itemLocale.ensureFresh();
      // Каталог аккаунтов знает только предметы, что лежат у кого-то на складе; остальные (награды
      // событий, витрины) добираем из справочника клиента игры. Живые данные аккаунтов главнее.
      const byId=new Map(itemLocale.bundleItems().map(it=>[it.item_id,it]));
      for(const it of itemCatalog.read()){
        const b=byId.get(it.item_id);
        byId.set(it.item_id,b?{...b,...Object.fromEntries(Object.entries(it).filter(([,v])=>v!=null))}:it);
      }
      const items=[...byId.values()].sort((a,b)=>a.item_id-b.item_id).map(it=>({...it,title:itemLocale.titleOf(it),tag:itemCatalog.tagOf(it)}));
      res.json({ok:true,items});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  const{makeApiForAccount}=ctx;

  // статус техработ игры (автопауза запросов) — для баннера в панели
  const PROCESS_STARTED=Date.now()-Math.round(process.uptime()*1000);
  // версия бота и каналы обновлений с GitHub (кэш 30 мин, ?force=1 — ручная проверка, не чаще раза в минуту)
  // ответ проверки + состояние обновлятеля и настройки автообновления (общий для запроса и рассылки)
  const versionPayload=v=>{
    const upd=require('../../utils/selfUpdate');
    const s=mergeDeep(DEFAULTS,loadSettings());
    return{...v,canUpdate:upd.isConfigured()&&!upd.updaterInfo().busy,startedAt:PROCESS_STARTED,updater:upd.updaterInfo(),history:upd.history(),auto:!!(s.update&&s.update.auto)};
  };
  app.get('/api/version',async(req,res)=>{
    try{res.json(versionPayload(await require('../../utils/versionCheck').getVersionInfo({force:req.query.force==='1'})));}
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // рассылка свежих проверок версии всем открытым вкладкам (SSE): как только сервер узнал о новой
  // версии — сам, ручной проверкой из любой вкладки или автообновлением, — плашка обновляется везде.
  // Браузер держит одно такое соединение на все вкладки (лидер, см. client hooks/useVersionFeed.ts).
  app.get('/api/version/stream',(req,res)=>{
    const vc=require('../../utils/versionCheck');
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders&&res.flushHeaders();
    const send=v=>{try{res.write(`data: ${JSON.stringify(versionPayload(v))}\n\n`);}catch(_){}};
    // ping раз в 25 с — прокси не закрывают «молчащее» соединение
    const ping=setInterval(()=>{try{res.write(': ping\n\n');}catch(_){}},25000);
    vc.events.on('checked',send);
    req.on('close',()=>{clearInterval(ping);vc.events.off('checked',send);});
  });

  // лёгкая проверка «какой процесс бота сейчас отвечает» без GitHub: панель опрашивает её с любой
  // страницы и перезагружается, когда бот перезапустился на новой версии
  app.get('/api/build',(req,res)=>{
    try{
      const u=require('../../utils/selfUpdate').updaterInfo(),l=u.busy&&u.last;
      // пока идёт обновление — этап и прогресс скачивания образа для полосы в плашке версии
      res.json({ok:true,commit:process.env.APP_COMMIT||null,startedAt:PROCESS_STARTED,busy:u.busy,
        update:l?{state:l.state,message:l.message||null,progress:l.progress||null}:null});
    }
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // обновление или смена канала через обновлятель (сервис updater). body: {tag?, force?}; без tag —
  // свежий образ текущего канала. Не стартует посреди ручных «Обновить» (opRegistry), если не
  // передан force. Если образ новый, бот перезапустится раньше ответа — панель это ждёт.
  app.post('/api/update',async(req,res)=>{
    try{
      const upd=require('../../utils/selfUpdate');
      const tag=req.body&&req.body.tag?String(req.body.tag).trim():upd.currentTag();
      if(!upd.TAG_RE.test(tag))return res.status(400).json({ok:false,error:'недопустимый тег образа'});
      if(!upd.isConfigured())return res.status(400).json({ok:false,error:'обновлятель не запущен (нужен сервис updater из docker-compose.yml)'});
      const busy=require('../lib/opRegistry').activeKeys();
      if(busy.length&&!(req.body&&req.body.force))return res.status(409).json({ok:false,busy,error:`идут операции: ${busy.join(', ')}`});
      const r=await upd.requestSwitch(tag,tag===upd.currentTag()?'manual':'switch');
      require('../../utils/versionCheck').invalidate();
      res.json({ok:true,...r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/maintenance',(req,res)=>{
    try{res.json({ok:true,...require('../../utils/maintenance').status()});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // статус фоновых "Обновить"-операций (см. web/lib/opRegistry.js) — кнопка "Обновить" на любой
  // странице спрашивает это при монтировании, чтобы восстановить состояние загрузки после
  // перезагрузки страницы, если операция всё ещё выполняется на сервере.
  app.get('/api/op-status',(req,res)=>{
    const keys=String(req.query.keys||'').split(',').filter(Boolean);
    res.json({ok:true,running:require('../lib/opRegistry').statusOf(keys)});
  });

  app.get('/api/config',(req,res)=>{
    try{
      const s=loadSettings();
      const merged=mergeDeep(DEFAULTS,s);
      if(merged.web){const{passwordHash,sessionSecret,...web}=merged.web;merged.web=web;} // не отдаём секреты наружу
      res.json({ok:true,settings:merged});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/config',(req,res)=>{
    try{
      const current=loadSettings();
      const next=mergeDeep(current,req.body);
      saveSettings(next);
      logger.info('Web UI: settings saved');
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/accounts/add',async(req,res)=>{
    try{
      const{url,name}=req.body||{};
      if(!url)return res.status(400).json({ok:false,error:'URL не указан'});
      let token=url.trim();
      try{const u=new URL(token);const t=u.searchParams.get('token');if(t)token=t;}catch(_){}
      if(!token)return res.status(400).json({ok:false,error:'Не удалось извлечь токен из URL'});

      const headers={'content-type':'application/json','accept':'application/json',
        'referer':`https://game.toncity.io/auth?token=${token}`,'origin':'https://game.toncity.io',
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'};

      const exch=await axios.post(`${BASE_URL}/web-auth/exchange`,{token},{headers,timeout:30000});
      const exchData=exch.data||{};
      const{access_token,refresh_token,session_seed}=exchData;
      if(!access_token)return res.status(400).json({ok:false,error:'Обмен токена не удался: '+JSON.stringify(exchData)});

      const{Account}=require('../../db/index');
      // Дедуп по РЕАЛЬНОМУ ID игрового аккаунта (tg_uid из JWT свежего access_token), а не по имени.
      // Игра ротирует refresh_token на КАЖДЫЙ рефреш — две строки БД одного и того же аккаунта
      // неизбежно инвалидируют токены друг друга ("Invalid or expired refresh token" навсегда).
      const newSubject=decodeJwtSubject(access_token); // = tg_uid
      let existing=null;
      if(newSubject){
        const candidates=await Account.findAll({attributes:['id','name','access_token']});
        const hit=candidates.find(c=>decodeJwtSubject(c.access_token)===newSubject);
        if(hit)existing=await Account.findByPk(hit.id);
      }

      // Имя. В JWT его НЕТ (payload = {exp,iat,tg_uid}), поэтому источники имени, по приоритету:
      //   1) имя, введённое пользователем в форме добавления (если он его указал);
      //   2) имя уже существующей записи (при обновлении токенов — не затираем);
      //   3) временный плейсхолдер account_XXXXXXXX (стабильно от tg_uid) — заменится на настоящее
      //      имя ниже, при прогреве подписанной сессии (users/me через ЖИВОЙ WS + X-Req-Token).
      const typedName=(name&&String(name).trim())||'';
      const hex=require('crypto').createHash('md5').update(String(newSubject||access_token)).digest('hex').slice(0,8);
      const accountName=typedName||existing?.name||`account_${hex}`; // account_XXXXXXXX ⇒ PLACEHOLDER_NAME_RE

      let acc=existing,created=false,oldName=existing?.name||null;
      if(!acc){
        // не нашли по tg_uid — резервно дедупим по имени (на случай старых записей без токена/tg_uid)
        const r=await Account.findOrCreate({where:{name:accountName},defaults:{name:accountName,access_token,refresh_token}});
        acc=r[0];created=r[1];
        if(!created)oldName=acc.name;
      }
      // при обновлении существующей записи имя НЕ трогаем (кроме случая, когда пользователь явно
      // ввёл новое в форме) — иначе затрём уже подтянутое настоящее имя плейсхолдером
      if(!created){
        const upd={access_token,refresh_token};
        const renameFrom=(typedName&&typedName!==acc.name)?acc.name:null;
        if(renameFrom)upd.name=typedName;
        await acc.update(upd);
        // ручное переименование существующего аккаунта тоже переносит его строки-снимки на новое имя
        if(renameFrom)await require('../../utils/renameAccount').renameAccountRefs(renameFrom,typedName);

        // БАГ (13.10.2026): переавторизация УЖЕ ИМЕНОВАННОГО аккаунта (не плейсхолдера) обновляла
        // access_token/refresh_token в БД, но ничего не делала с живой сессией — ни seed для подписи
        // (reqSign), ни переоткрытие WS (wsSession). Прогрев ниже (seed+ensureSession) запускается
        // ТОЛЬКО для новых аккаунтов-плейсхолдеров (нужно узнать настоящее имя) — уже именованный
        // аккаунт, у которого давно крутятся фоновые циклы, просто продолжал долбиться старым
        // мёртвым seed'ом (см. modules/session.js _refreshDead), и статус на
        // странице Аккаунты висел "Подключается…" сколько угодно после нажатия "Добавить". Явно
        // сбрасываем сюда — seed сразу, WS принудительно переоткрываем, кулдаун снимаем.
        if(session_seed)require('../../utils/reqSign').setSeed(acc.id,session_seed);
        try{require('../../modules/session').clearDeadCooldown(acc.id);}catch(_){}
        try{require('../../utils/wsSession').notifyRefreshed(acc.id,()=>acc.access_token);}catch(_){}
      }

      // Прогреваем ПОДПИСАННУЮ сессию ровно как клиент игры: seed из ответа exchange → живой
      // авторизованный WS (jwt_auth, подписан тем же seed) → и только теперь users/me проходит
      // с X-Req-Token без ошибок. Это заменяет прежний голый axios-вызов users/me (Bearer без
      // подписи/WS), который после обновления игры отклонялся. ensureSession() внутри вызовет
      // maybeRenameAccount и заменит плейсхолдер на настоящее имя.
      //
      // ВАЖНО: прогрев НЕ держит HTTP-ответ. ensureSession ходит через общий apiLock (сериализует
      // запросы всего бота) + ждёт авторизации WS — это могут быть десятки секунд, и раньше именно
      // из-за await весь /add «висел». Поэтому запускаем прогрев в фоне и ждём его не дольше
      // NAME_WAIT: успел — вернём настоящее имя сразу; не успел — вернём плейсхолдер, а прогрев
      // доедет сам и имя подтянется (видно после обновления списка аккаунтов).
      if(!typedName&&/^account_[0-9a-f]{8}$/i.test(acc.name)){
        const reqSign=require('../../utils/reqSign');
        const{ensureSession}=require('../../modules/session');
        if(session_seed)reqSign.setSeed(acc.id,session_seed); // избегаем лишнего refresh — seed уже есть
        const warm=(async()=>{
          // noLock: добавление — разовое ручное действие, его запросы (users/me, progress) НЕ должны
          // стоять в общей очереди apiLock за циклами бота (именно это и приводило к «зависанию»).
          const api=await makeApiForAccount(acc.id,{noLock:true});
          await ensureSession(api,acc); // поднимет WS и вызовет maybeRenameAccount (подписанный users/me)
          await acc.reload();
        })().catch(e=>logger.warn(`[${acc.name}] фоновый прогрев сессии при добавлении: ${e.message}`));
        const NAME_WAIT=6000;
        await Promise.race([warm,new Promise(r=>setTimeout(r,NAME_WAIT))]);
      }

      const finalName=acc.name;
      const mergedDuplicate=oldName!=null&&oldName!==finalName;
      const stillPlaceholder=/^account_[0-9a-f]{8}$/i.test(finalName);
      logger.info(`Web UI: account ${finalName} ${created?'added':mergedDuplicate?`updated (объединён с "${oldName}", id ${acc.id})`:'updated'}${stillPlaceholder?' — имя подтянется при первой сессии':''}`);
      // Поднимаем фоновые циклы прямо сейчас: иначе аккаунт, добавленный на работающем боте,
      // молчал бы до перезапуска процесса (циклы раздаются один раз при старте, см. index.js).
      try{require('../../utils/accountLoops').startFor(acc);}catch(e){logger.warn(`[${finalName}] циклы: ${e.message}`);}
      res.json({ok:true,name:finalName,created,placeholder:stillPlaceholder});
    }catch(e){
      const status=e?.response?.status;
      const body=e?.response?.data?JSON.stringify(e.response.data):'';
      res.status(500).json({ok:false,error:`${e.message}${status?' ('+status+')':''}${body?' '+body:''}`});
    }
  });

  // при удалении аккаунта снимаем отметку в реестре циклов — повторное добавление снова их поднимет
  app.delete('/api/accounts/:id',async(req,res)=>{
    try{
      const{Account,Inventory,GuildSnapshot}=require('../../db/index');
      const acc=await Account.findByPk(req.params.id);
      await Account.destroy({where:{id:req.params.id}});
      try{require('../../utils/accountLoops').forget(req.params.id);}catch(_){}
      // чистим инвентарь удалённого аккаунта, чтобы не осталось карточек-призраков
      if(acc)await Inventory.destroy({where:{account:acc.name}}).catch(()=>{});
      // и его запись(и) GuildSnapshot — иначе если это был лидер гильдии, страница "Столицы"
      // продолжала бы показывать эту гильдию осиротевшей записью (см. /api/capital-snapshots,
      // фильтрует по наличию живого лидера через GuildSnapshot+Account)
      if(acc)await GuildSnapshot.destroy({where:{account:acc.name}}).catch(()=>{});
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // Точный (не эвристический) детектор задвоенных аккаунтов — раскодирует JWT access_token
  // (payload, без проверки подписи — она нам не нужна, важен только subject-claim) и группирует
  // по идентификатору игрового пользователя. Если два разных account.id в нашей БД декодируются
  // в ОДИН и тот же subject — это ОДИН и тот же реальный игровой аккаунт, добавленный дважды
  // (см. project-architecture: уязвимость добавления без пароля). Это и есть вероятная причина
  // постоянных "Invalid or expired refresh token": игра ротирует refresh_token на КАЖДЫЙ рефреш,
  // и если рефреш+ротация происходит попеременно из ДВУХ разных строк БД для одного и того же
  // игрового аккаунта — тот, кто рефрешит вторым, инвалидирует токен первого, и наоборот, по кругу.
  app.get('/api/accounts/duplicates',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const rows=await Account.findAll({attributes:['id','name','access_token']});
      const bySubject=new Map();
      for(const r of rows){
        const sub=decodeJwtSubject(r.access_token);
        if(!sub)continue;
        if(!bySubject.has(sub))bySubject.set(sub,[]);
        bySubject.get(sub).push({id:r.id,name:r.name});
      }
      const groups=[...bySubject.values()].filter(g=>g.length>1);
      res.json({ok:true,groups});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  const{Account}=require('../../db/index');
  const wsSession=require('../../utils/wsSession');
  const{isRefreshDead}=require('../../modules/session');
  const pn=v=>{const n=parseFloat(v);return isFinite(n)?n:null;};
  function mapAccountRow(r){
    const special=String(r.special_buildings||'').split(',').filter(Boolean);
    return{
      id:r.id,name:r.name,
      balance:pn(r.balance),crystals:pn(r.crystals),
      profit:pn(r.profit),population:pn(r.population),happiness:pn(r.happiness),
      profit_final:pn(r.profit_final),population_final:pn(r.population_final),happiness_final:pn(r.happiness_final),
      staked_coins:pn(r.staked_coins),staked_crystals:pn(r.staked_crystals),
      hasToken:!!(r.access_token&&r.access_token!=='placeholder'),
      // особые здания на карте (для фильтрации страниц: fortune/wisdom/market/reserve)
      buildings:special,
      // реальный статус сессии (WS) на этот момент — не просто "есть токен в БД", т.к. токен
      // не удаляется сам по себе при протухании. 'active'/'dead'/'connecting'/'unknown'.
      // Протухший refresh_token — сразу 'dead': WS у такого аккаунта засыпает без новых отказов
      // авторизации, и по одному WS он навсегда висел бы как 'connecting'.
      sessionStatus:isRefreshDead(r.id)?'dead':wsSession.getStatus(r.id).state,
    };
  }
  app.get('/api/accounts',async(req,res)=>{
    try{
      // ?name= — один аккаунт (карта города берёт только свой баланс, не весь флот)
      const where=req.query.name?{name:String(req.query.name)}:undefined;
      const rows=await Account.findAll({where,order:[['id','ASC']]});
      res.json({ok:true,accounts:rows.map(mapAccountRow)});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // точечное обновление ОДНОГО аккаунта (напр. после WS-события positions-changed на Башне Сатоши) —
  // чтобы не тянуть api.accounts() целиком (весь флот, десятки записей) ради баланса одного аккаунта
  app.get('/api/accounts/:id',async(req,res)=>{
    try{
      const r=await Account.findByPk(req.params.id);
      if(!r)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      res.json({ok:true,account:mapAccountRow(r)});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/inventory',async(req,res)=>{
    try{
      const{Inventory,Account}=require('../../db/index');
      const{Op}=require('sequelize');
      const items=require('../../../config/items.json');
      const accs=await Account.findAll({attributes:['id','name']});
      // чистим «осиротевшие» строки инвентаря (аккаунт удалён/отсутствует) —
      // иначе от них остаются некликабельные карточки-призраки
      const accNames=accs.map(a=>a.name);
      await Inventory.destroy({where:{account:{[Op.notIn]:accNames.length?accNames:['__none__']}}}).catch(()=>{});
      const rows=await Inventory.findAll({order:[['account','ASC'],['name','ASC']]});
      // map name → db id
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const byAccount={};
      const totals={};
      let totalItems=0;
      const accValues={};
      // осколки политик/тайные политики живут на странице "Политики", не среди обычных предметов
      // (с 15.10.2026 туда же ушли камни реформ, id 36-38)
      const POLICY_ITEM_TYPES=new Set(['policy_shard','mystery_policy']);
      const REFORM_STONE_IDS=new Set(['36','37','38']);
      for(const r of rows){
        if(POLICY_ITEM_TYPES.has(r.type)||REFORM_STONE_IDS.has(String(r.name)))continue;
        if(!byAccount[r.account])byAccount[r.account]=[];
        const qty=Number(r.marketable||0)+Number(r.locked||0);
        const free=Number(r.marketable||0);
        const label=(items[String(r.name)]?.name)||String(r.name);
        byAccount[r.account].push({
          id:r.name,name:label,
          marketable:free,locked:Number(r.locked||0),qty,
          sell_price:r.sell_price??null,
          sell_currency:r.sell_currency??null,
          booster_active_limit:r.booster_active_limit??null,
          booster_currently_active:r.booster_currently_active??null,
        });
        if(!totals[label])totals[label]={marketable:0,locked:0};
        totals[label].marketable+=free;
        totals[label].locked+=Number(r.locked||0);
        totalItems+=qty;
        // накапливаем стоимость
        if(r.sell_price&&free>0){
          if(!accValues[r.account])accValues[r.account]={coins:0,crystals:0};
          if(r.sell_currency==='crystals')accValues[r.account].crystals+=r.sell_price*free;
          else accValues[r.account].coins+=r.sell_price*free;
        }
      }
      res.json({ok:true,byAccount,totals,total:totalItems,uniqueTypes:Object.keys(totals).length,accIdByName,accValues});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // кэш логов: избегаем повторного чтения диска при авто-обновлении
  let _logCache={key:'',ts:0,logs:[]};

  function tailFile(fp,maxBytes=131072){
    // читаем только последние maxBytes байт файла (не весь файл целиком)
    const fd=fs.openSync(fp,'r');
    const size=fs.fstatSync(fd).size;
    const start=Math.max(0,size-maxBytes);
    const buf=Buffer.alloc(size-start);
    fs.readSync(fd,buf,0,buf.length,start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean);
  }

  app.get('/api/logs',(req,res)=>{
    try{
      const lines=parseInt(req.query.lines||'200');
      const key=String(lines);
      const now=Date.now();
      if(_logCache.key===key&&now-_logCache.ts<3000)
        return res.json({ok:true,logs:_logCache.logs});

      const ld=path.join(process.cwd(),'logs');
      const all=fs.readdirSync(ld).filter(f=>/^bot\d*\.log$/.test(f));
      // порядок файлов — по времени последней записи, а не по номеру в имени: winston без tailable
      // пишет в bot.log → bot1.log → bot2.log…, а после каждого перезапуска процесса счётчик
      // сбрасывается и запись снова идёт в bot.log (потом дописывает в старые bot1.log…). Номер в
      // имени поэтому ничего не говорит о свежести, и сортировка по нему показывала логи недельной
      // давности вместо последних.
      const mt=f=>{try{return fs.statSync(path.join(ld,f)).mtimeMs;}catch{return 0;}};
      const mtimes=Object.fromEntries(all.map(f=>[f,mt(f)]));
      all.sort((a,b)=>mtimes[b]-mtimes[a]); // от свежего к старому
      let collected=[];
      for(const f of all){
        const rows=tailFile(path.join(ld,f));
        collected=rows.concat(collected);
        if(collected.length>=lines)break;
      }
      const logs=collected.slice(-lines);
      _logCache={key,ts:now,logs};
      res.json({ok:true,logs});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // живой хвост логов (SSE, без поллинга) — /api/logs выше используется только для разовой
  // подгрузки истории при открытии страницы, новые строки летят сюда прямо в момент записи лога
  // (см. utils/logStream.js, utils/logger.js BroadcastTransport)
  app.get('/api/logs/stream',(req,res)=>{
    const logStream=require('../../utils/logStream');
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    logStream.subscribe(res);
    req.on('close',()=>{logStream.unsubscribe(res);});
  });

};
