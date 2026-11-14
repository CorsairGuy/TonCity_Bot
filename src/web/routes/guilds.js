'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

module.exports=function(app,ctx){
  const{apiForAcc,makeApiForAccount}=ctx;

  // Взнос персональный: даже обычный участник видит и оплачивает только свой долг.
  async function feeAccount(id){
    const{Account}=require('../../db/index');
    const accountId=Number(id);
    if(!Number.isSafeInteger(accountId)||accountId<=0)throw Object.assign(new Error('Некорректный аккаунт'),{status:400});
    const acc=await Account.findByPk(accountId);
    if(!acc?.access_token||acc.access_token==='placeholder')throw Object.assign(new Error('Аккаунт не найден'),{status:404});
    return acc;
  }
  app.get('/api/guild-fees/:accountId',async(req,res)=>{
    try{
      const acc=await feeAccount(req.params.accountId);
      const data=await require('../../modules/guildFees').readGuildFees(apiForAcc(acc));
      res.json({ok:true,...data});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild-fees/:accountId/pay',async(req,res)=>{
    try{
      const acc=await feeAccount(req.params.accountId);
      const result=await opRegistry.run(`guildFeesPay:${acc.id}`,()=>require('../../modules/guildFees').payGuildFees(apiForAcc(acc),req.body||{}));
      const{progress,...data}=result;
      if(progress)require('../../modules/session').saveStats(acc,acc.name,progress);
      res.json(data);
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  app.post('/api/guilds/:accountId/leave',async(req,res)=>{
    try{
      const acc=await feeAccount(req.params.accountId);
      const out=await opRegistry.run(`guildLeave:${acc.id}`,async()=>{
        const api=apiForAcc(acc);
        const result=await require('../../modules/guildActions').leaveGuild(api,req.body||{});
        if(result.membership&&String(result.membership.guild?.id??'')!==String(req.body?.expected_guild_id??'')){
          const{GuildSnapshot}=require('../../db/index'),g=result.membership.guild;
          // Удаляем только подтверждённые старые членства; ошибка GET не стирает снимки.
          await GuildSnapshot.destroy({where:{account:acc.name}});
          if(g?.id)await GuildSnapshot.upsert({account:acc.name,guild_id:String(g.id),guild_title:g.title||'',role:g.role||'',benefits:null,updated_at:new Date()},{conflictFields:['account','guild_id']});
        }
        if(result.ok){
          if(result.membership){
            try{await require('../../utils/guildBonuses').syncGuildBonuses(api,acc.name,result.membership.guild);}
            catch(e){result.refresh_error=[result.refresh_error,e.message].filter(Boolean).join('; ');}
          }else require('../../utils/guildBonuses').publish(acc.name,null);
        }
        const{membership,...data}=result;return data;
      });
      res.json(out);
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.post('/api/guilds/:accountId/deposit',async(req,res)=>{
    try{
      const acc=await feeAccount(req.params.accountId),b=req.body||{};
      const out=await opRegistry.run(`guildDeposit:${acc.id}:${b.expected_guild_id}:${b.currency}:${b.amount}`,async()=>{
        const api=apiForAcc(acc);
        try{return await require('../../modules/guildActions').depositGuild(api,b);}
        finally{
          // В том числе после неоднозначного POST: актуализируем личный баланс без повтора взноса.
          try{await require('../../modules/session').saveStats(acc,acc.name,await api.get('/progress/'));}catch(e){logger.warn(`[${acc.name}] [guild-deposit] баланс: ${e.message}`);}
        }
      });
      res.json(out);
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });

  async function discoveryCache(accId,ref,data){
    const{seq}=require('../../db/index');
    if(data!==undefined){await seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',{replacements:[accId,'guild-discovery',ref,JSON.stringify(data),new Date()]});return data;}
    const rows=await seq.query('SELECT data FROM game_extra_cache WHERE account_id=? AND kind=? AND ref=? LIMIT 1',{replacements:[accId,'guild-discovery',ref],type:require('sequelize').QueryTypes.SELECT});
    return rows.length?JSON.parse(rows[0].data):null;
  }
  app.get('/api/guild-discovery',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const accounts=await Account.findAll({attributes:['id','name']});
      const data=req.query.account?await discoveryCache(Number(req.query.account),'search'):null;
      res.json({ok:true,accounts,data});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild-discovery/search',async(req,res)=>{
    try{
      const acc=await feeAccount(req.body?.account_id),api=apiForAcc(acc);
      const query=String(req.body?.query??'').trim().slice(0,100),page=Math.max(1,Math.min(1000,Math.floor(Number(req.body?.page)||1)));
      const r=await api.get('/guilds/popular',{search:query,page});
      const data={query,page,results:Array.isArray(r?.results)?r.results:[],has_more:!!r?.next};
      await discoveryCache(acc.id,'search',data);res.json({ok:true,data});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/guild-discovery/detail',async(req,res)=>{
    try{
      const acc=await feeAccount(req.body?.account_id),svc=require('../../modules/guildDiscovery');
      const data=await svc.detail(apiForAcc(acc),req.body?.guild_id);
      await discoveryCache(acc.id,String(svc.guildId(req.body?.guild_id)),data);
      res.json({ok:true,data,reason:svc.allowed(data)});
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/guild-discovery/join',async(req,res)=>{
    try{
      const acc=await feeAccount(req.body?.account_id),svc=require('../../modules/guildDiscovery'),id=svc.guildId(req.body?.guild_id);
      const out=await opRegistry.run(`guildJoin:${acc.id}`,async()=>{
        const api=apiForAcc(acc),r=await svc.joinGuild(api,id,req.body?.expected_type);
        if(r.current){
          await discoveryCache(acc.id,String(id),r.current);
          if(r.ok&&String(r.current.membership?.id??'')===String(id)){
            const{GuildSnapshot}=require('../../db/index'),g=r.current.membership;
            await GuildSnapshot.destroy({where:{account:acc.name}});
            await GuildSnapshot.upsert({account:acc.name,guild_id:String(g.id),guild_title:g.title||'',role:g.role||'',benefits:null,updated_at:new Date()},{conflictFields:['account','guild_id']});
            try{
              const{data:benefits}=await require('../../utils/guildBonuses').syncGuildBonuses(api,acc.name,g);
              await GuildSnapshot.update({benefits:JSON.stringify(benefits)},{where:{account:acc.name,guild_id:String(g.id)}});
            }catch(e){r.refresh_error=[r.refresh_error,e.message].filter(Boolean).join('; ');}
          }
        }
        return r;
      });
      res.json(out);
    }catch(e){res.status(e.status||500).json({ok:false,error:midErr(e)});}
  });

  // ── МИД live endpoints ───────────────────────────────────────────────────
  async function midApi(guildId){
    const{GuildSnapshot,Account}=require('../../db/index');
    const row=await GuildSnapshot.findOne({where:{guild_id:guildId,role:'Leader'}});
    if(!row)throw new Error('Аккаунт-лидер не найден');
    const acc=await Account.findOne({where:{name:row.account}});
    if(!acc?.access_token)throw new Error('Токен не найден');
    return apiForAcc(acc);
  }
  // Кандидаты для ЧТЕНИЯ (не для дипломатических действий, те leader-only в самой игре) — лидер
  // первым, затем остальные свои аккаунты в гильдии. Раньше midApi() всегда брал только лидера
  // без фолбэка: если у ЕГО аккаунта временный сбой (протухший WS/сигнатура), весь /refresh падал,
  // хотя другие свои аккаунты в той же гильдии видят те же самые общегильдийные МИД-данные.
  async function midReadCandidates(guildId){
    const{GuildSnapshot,Account}=require('../../db/index');
    const rows=await GuildSnapshot.findAll({where:{guild_id:guildId}});
    if(!rows.length)return[];
    const ordered=[...rows].sort((a,b)=>(a.role==='Leader'?0:1)-(b.role==='Leader'?0:1));
    const names=[...new Set(ordered.map(r=>r.account))];
    const accs=await Account.findAll({where:{name:names}});
    const byName=new Map(accs.filter(a=>a.access_token).map(a=>[a.name,a]));
    return names.map(n=>byName.get(n)).filter(Boolean);
  }
  // ошибку МИД всегда возвращаем строкой (иначе фронт получает объект → пустой флеш)
  function midErr(e){
    const d=e?.response?.data;
    if(typeof d==='string')return d;
    if(d&&typeof d==='object')return d.error||d.message||JSON.stringify(d);
    return e?.message||'Ошибка';
  }

  app.get('/api/mid-live/:guildId/overview',async(req,res)=>{
    try{
      const{MidSnapshot}=require('../../db/index');
      const row=await MidSnapshot.findOne({where:{guild_id:req.params.guildId}});
      if(!row)return res.json({ok:false,error:'Нет данных — нажмите Обновить'});
      const parsed=JSON.parse(row.data||'{}');
      res.json({ok:true,...parsed,updated_at:row.updated_at});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/mid-live/:guildId/refresh',async(req,res)=>{
    try{
      const guildId=req.params.guildId;
      const combined=await opRegistry.run(`midRefresh:${guildId}`,async()=>{
        const{MidSnapshot}=require('../../db/index');
        const candidates=await midReadCandidates(guildId);
        if(!candidates.length)throw new Error('Ни один свой аккаунт не найден в этой гильдии');
        let result=null,lastErr=null;
        for(const acc of candidates){
          try{
            const gameApi=apiForAcc(acc);
            // scouting удалён из игры (обновление 06.07.2026), заменён Кампаниями Гильдий
            // (/guild-campaigns/overview — реверснуто из chunks/foreign_ministry-*.js + CampaignCard-*.js)
            const[overview,alliances,requests,enemies,invitations,campaigns]=await Promise.all([
              gameApi.get(`/foreign-ministry/overview?guild_id=${guildId}`),
              gameApi.get(`/foreign-ministry/alliances?guild_id=${guildId}`),
              gameApi.get(`/foreign-ministry/alliances/requests?guild_id=${guildId}`),
              gameApi.get(`/foreign-ministry/enemies?guild_id=${guildId}`),
              gameApi.get(`/foreign-ministry/invitations?guild_id=${guildId}`).catch(()=>null),
              gameApi.get(`/guild-campaigns/overview`).catch(()=>null),
            ]);
            result={overview,alliances,requests,enemies,invitations,campaigns};
            break;
          }catch(e){
            lastErr=e;
            if(!(e.wsNotReady||e.noSeed||e.status===403))throw e; // не транзитная ошибка — не пробуем другой аккаунт впустую
          }
        }
        if(!result)throw lastErr||new Error('не удалось обновить МИД ни с одного аккаунта гильдии');
        const existing=await MidSnapshot.findOne({where:{guild_id:guildId}});
        const guildTitle=existing?.guild_title||guildId;
        await MidSnapshot.upsert({guild_id:guildId,guild_title:guildTitle,data:JSON.stringify(result),updated_at:new Date()},{conflictFields:['guild_id']});
        return result;
      });
      res.json({ok:true,...combined,updated_at:new Date()});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/mid-live/:guildId/search',async(req,res)=>{
    try{
      const gameApi=await midApi(req.params.guildId);
      // bypass apiLock for search — no state changes, just read
      gameApi.setNoLock(true);
      const{q='',type='alliances'}=req.query;
      const endpoint=type==='enemies'?'enemies':'alliances';
      const qs=String(q).trim();
      const page=parseInt(req.query.page)||1;
      const data=await gameApi.get(`/foreign-ministry/search/${endpoint}?guild_id=${req.params.guildId}&search=${encodeURIComponent(qs)}&page=${page}`);
      res.json({ok:true,guilds:data?.guilds||[],total:data?.total??null});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // helper: POST к foreign-ministry с guild_id в query
  const fmPost=(api,guildId,sub,body)=>api.post(`/foreign-ministry/${sub}?guild_id=${guildId}`,body||{});

  app.post('/api/mid-live/:guildId/alliance/send',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{target_guild_id}=req.body||{};
      if(!target_guild_id)return res.status(400).json({ok:false,error:'target_guild_id обязателен'});
      const data=await fmPost(api,req.params.guildId,'alliances/request',{target_guild_id});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/mid-live/:guildId/alliance/accept',async(req,res)=>{
    try{const api=await midApi(req.params.guildId);const data=await fmPost(api,req.params.guildId,'alliances/accept',{request_id:req.body?.request_id});res.json({ok:true,data});}
    catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/alliance/reject',async(req,res)=>{
    try{const api=await midApi(req.params.guildId);const data=await fmPost(api,req.params.guildId,'alliances/reject',{request_id:req.body?.request_id});res.json({ok:true,data});}
    catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/alliance/cancel',async(req,res)=>{
    try{const api=await midApi(req.params.guildId);const data=await fmPost(api,req.params.guildId,'alliances/cancel',{request_id:req.body?.request_id});res.json({ok:true,data});}
    catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/alliance/break',async(req,res)=>{
    try{const api=await midApi(req.params.guildId);const data=await fmPost(api,req.params.guildId,'alliances/break',{ally_guild_id:req.body?.ally_guild_id});res.json({ok:true,data});}
    catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/alliance/upgrade',async(req,res)=>{
    try{const api=await midApi(req.params.guildId);const data=await fmPost(api,req.params.guildId,'alliances/upgrade',{ally_guild_id:req.body?.ally_guild_id});res.json({ok:true,data});}
    catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/mid-live/:guildId/enemy/add',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{enemy_guild_id,tariff_level='10'}=req.body||{};
      if(!enemy_guild_id)return res.status(400).json({ok:false,error:'enemy_guild_id обязателен'});
      const data=await fmPost(api,req.params.guildId,'enemies/add',{enemy_guild_id,tariff_level:String(tariff_level)});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/enemy/remove',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{enemy_guild_id}=req.body||{};
      if(!enemy_guild_id)return res.status(400).json({ok:false,error:'enemy_guild_id обязателен'});
      const data=await fmPost(api,req.params.guildId,'enemies/remove',{enemy_guild_id});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/enemy/update-tariff',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{enemy_guild_id,tariff_level}=req.body||{};
      if(!enemy_guild_id)return res.status(400).json({ok:false,error:'enemy_guild_id обязателен'});
      const data=await fmPost(api,req.params.guildId,'enemies/update-tariff',{enemy_guild_id,tariff_level:String(tariff_level)});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  // Кампании Гильдий (guild-campaigns) — замена удалённого scouting (06.07.2026).
  // target_guild_id ищем через уже существующий /search?type=enemies (та же ручка,
  // которой пользуется диалог старта кампании в самой игре — реверс chunks/foreign_ministry-*.js).
  app.get('/api/mid-live/:guildId/campaigns/preview',async(req,res)=>{
    try{
      const target=Number(req.query.target_guild_id);
      if(!Number.isSafeInteger(target)||target<=0)return res.status(400).json({ok:false,error:'Выберите целевую гильдию'});
      const api=await midApi(req.params.guildId);
      const data=await api.get('/guild-campaigns/preview',{target_guild_id:target});
      if(!data||!Number.isFinite(data.size_handicap)||!Number.isFinite(data.repeat_handicap))return res.status(502).json({ok:false,error:'Игра не вернула коэффициенты кампании'});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/campaigns/start',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{target_guild_id,duration_hours}=req.body||{};
      if(!target_guild_id)return res.status(400).json({ok:false,error:'target_guild_id обязателен'});
      const data=await api.post('/guild-campaigns/start',{target_guild_id,duration_hours:Number(duration_hours)||24});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/campaigns/deploy',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{campaign_id}=req.body||{};
      if(!campaign_id)return res.status(400).json({ok:false,error:'campaign_id обязателен'});
      const data=await api.post('/guild-campaigns/deploy',{campaign_id});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  app.post('/api/mid-live/:guildId/campaigns/call-to-arms',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{campaign_id}=req.body||{};
      if(!campaign_id)return res.status(400).json({ok:false,error:'campaign_id обязателен'});
      const data=await api.post('/guild-campaigns/call-to-arms',{campaign_id});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  // Добровольцы союзника (ally_calls из /guild-campaigns/overview) и оповещение своих участников о
  // кампании — пути и тела из бандла 2.5 (chunks/_id_-*.js: volunteer/withdraw/decide, notify-targets/notify).
  // Только по кнопке, без повторов; ответ игры отдаём как есть, страница перечитывает МИД.
  const campaignPost=(sub,build)=>app.post(`/api/mid-live/:guildId/campaigns/${sub}`,async(req,res)=>{
    try{
      const campaign_id=Number(req.body?.campaign_id);
      if(!Number.isSafeInteger(campaign_id)||campaign_id<=0)return res.status(400).json({ok:false,error:'campaign_id обязателен'});
      const body=build(campaign_id,req.body||{});
      if(body instanceof Error)return res.status(400).json({ok:false,error:body.message});
      const api=await midApi(req.params.guildId);
      res.json({ok:true,data:await api.post(`/guild-campaigns/${sub}`,body)});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });
  campaignPost('volunteer',id=>({campaign_id:id}));
  campaignPost('volunteer/withdraw',id=>({campaign_id:id}));
  campaignPost('volunteer/decide',(id,b)=>{const u=Number(b.user_id);return Number.isSafeInteger(u)&&u>0?{campaign_id:id,user_id:u,approve:!!b.approve}:new Error('user_id обязателен');});
  campaignPost('notify',(id,b)=>{const ids=(Array.isArray(b.user_ids)?b.user_ids:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0);return ids.length?{campaign_id:id,user_ids:ids}:new Error('Не выбраны участники');});
  app.get('/api/mid-live/:guildId/campaigns/notify-targets',async(req,res)=>{
    try{
      const id=Number(req.query.campaign_id);
      if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({ok:false,error:'campaign_id обязателен'});
      const api=await midApi(req.params.guildId);
      res.json({ok:true,data:await api.get('/guild-campaigns/notify-targets',{campaign_id:id})});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/mid-live/:guildId/invitations/buy',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{package_index}=req.body||{};
      const data=await fmPost(api,req.params.guildId,'invitations/buy',{package_index:Number(package_index)});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  // ── управление гильдией: аккаунт-менеджер (лидер/офицер) + заявки ────────────
  async function guildManagerApi(guildId,accountId){
    const{GuildSnapshot,Account}=require('../../db/index');
    if(accountId!=null){
      const id=Number(accountId);
      if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Неверный аккаунт управления'),{status:400});
      const acc=await Account.findByPk(id);
      if(!acc?.access_token||acc.access_token==='placeholder')throw Object.assign(new Error('Аккаунт не найден или без токена'),{status:404});
      const membership=await GuildSnapshot.findOne({where:{account:acc.name,guild_id:guildId}});
      if(!['Leader','Officer'].includes(membership?.role))throw Object.assign(new Error('Выбранный аккаунт не является лидером или офицером этой гильдии'),{status:403});
      return makeApiForAccount(acc.id,{noLock:true});
    }
    const rows=await GuildSnapshot.findAll({where:{guild_id:guildId,role:['Leader','Officer']}});
    for(const r of rows){
      const acc=await Account.findOne({where:{name:r.account}});
      if(acc&&acc.access_token&&acc.access_token!=='placeholder')return makeApiForAccount(acc.id,{noLock:true});
    }
    throw new Error('нет аккаунта-лидера/офицера с токеном для этой гильдии');
  }
  app.get('/api/guild/:guildId/applications',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      const d=await api.get(`/guilds/management/${req.params.guildId}/applications`);
      res.json({ok:true,applications:d?.applications||[]});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/applications/:appId/approve',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      const r=await api.post(`/guilds/management/${req.params.guildId}/applications/${req.params.appId}/approve`,{});
      res.json({ok:true,result:r});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/applications/:appId/reject',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      const r=await api.post(`/guilds/management/${req.params.guildId}/applications/${req.params.appId}/reject`,{});
      res.json({ok:true,result:r});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  // участники гильдии + действия (повысить/понизить/кикнуть/сделать лидером)
  const GUILD_MEMBER_ACTIONS={promote:'/guilds/members/promote',demote:'/guilds/members/demote',kick:'/guilds/members/kick','promote-to-leader':'/guilds/members/promote-to-leader'};
  app.get('/api/guild/:guildId/members',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      // ответ игры — DRF-пагинация {results:[...],next:<url|null>,count}. Листаем все страницы по ?page=N.
      const all=[];
      for(let page=1;page<=200;page++){
        const d=await api.get(`/guilds/${req.params.guildId}/members?page=${page}`);
        const k=d&&typeof d==='object'?Object.keys(d).find(x=>Array.isArray(d[x])):null;
        const items=Array.isArray(d?.results)?d.results:(k?d[k]:[]);
        all.push(...items);
        if(!d?.next||!items.length)break;
      }
      res.json({ok:true,members:all});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/members/:action',async(req,res)=>{
    try{
      const action=req.params.action;
      const p=GUILD_MEMBER_ACTIONS[action];
      if(!p)return res.status(400).json({ok:false,error:'неизвестное действие'});
      const{user_id}=req.body||{};
      if(!user_id)return res.status(400).json({ok:false,error:'user_id обязателен'});
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      // игра шлёт guild_id ЧИСЛОМ (в бандле guildId:{default:0}); строка отклоняется валидацией
      const r=await api.post(p,{guild_id:Number(req.params.guildId),user_id:Number(user_id)});
      res.json({ok:true,result:r});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  // настройки гильдии: чтение + сохранение (PATCH)
  app.get('/api/guild/:guildId/settings',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      const d=await api.get(`/guilds/management/${req.params.guildId}`);
      res.json({ok:true,settings:d?.settings||{}});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
  app.patch('/api/guild/:guildId/settings',async(req,res)=>{
    try{
      const b=req.body||{};
      // тело уже сформировано клиентом ровно как в UI игры (пустые поля = null)
      const payload={
        guild_type:b.guild_type,
        auto_kick:b.auto_kick??'none',
        application_criteria_population:b.application_criteria_population??null,
        application_criteria_profit:b.application_criteria_profit??null,
        membership_fee_type:b.membership_fee_type??null,
        membership_fee_amount:b.membership_fee_amount??null,
        membership_fee_duration:b.membership_fee_duration??null,
        membership_fee_currency:b.membership_fee_currency??null,
      };
      const api=await guildManagerApi(req.params.guildId,req.query.account_id);
      const r=await api.patch(`/guilds/management/${req.params.guildId}`,payload);
      res.json({ok:true,result:r});
    }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
  });
};
