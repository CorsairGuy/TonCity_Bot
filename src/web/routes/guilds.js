'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

module.exports=function(app,ctx){
  const{apiForAcc,makeApiForAccount}=ctx;

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

  app.post('/api/mid-live/:guildId/invitations/buy',async(req,res)=>{
    try{
      const api=await midApi(req.params.guildId);
      const{package_index}=req.body||{};
      const data=await fmPost(api,req.params.guildId,'invitations/buy',{package_index:Number(package_index)});
      res.json({ok:true,data});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  // ── управление гильдией: аккаунт-менеджер (лидер/офицер) + заявки ────────────
  async function guildManagerApi(guildId){
    const{GuildSnapshot,Account}=require('../../db/index');
    const rows=await GuildSnapshot.findAll({where:{guild_id:guildId,role:['Leader','Officer']}});
    for(const r of rows){
      const acc=await Account.findOne({where:{name:r.account}});
      if(acc&&acc.access_token&&acc.access_token!=='placeholder')return makeApiForAccount(acc.id,{noLock:true});
    }
    throw new Error('нет аккаунта-лидера/офицера с токеном для этой гильдии');
  }
  app.get('/api/guild/:guildId/applications',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId);
      const d=await api.get(`/guilds/management/${req.params.guildId}/applications`);
      res.json({ok:true,applications:d?.applications||[]});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/applications/:appId/approve',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId);
      const r=await api.post(`/guilds/management/${req.params.guildId}/applications/${req.params.appId}/approve`,{});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/applications/:appId/reject',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId);
      const r=await api.post(`/guilds/management/${req.params.guildId}/applications/${req.params.appId}/reject`,{});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // участники гильдии + действия (повысить/понизить/кикнуть/сделать лидером)
  const GUILD_MEMBER_ACTIONS={promote:'/guilds/members/promote',demote:'/guilds/members/demote',kick:'/guilds/members/kick','promote-to-leader':'/guilds/members/promote-to-leader'};
  app.get('/api/guild/:guildId/members',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId);
      // ответ игры — DRF-пагинация {results:[...],next:<url|null>,count}. Листаем все страницы по ?page=N.
      const all=[];
      for(let page=1;page<=200;page++){
        const d=await api.get(`/guilds/${req.params.guildId}/members?page=${page}`);
        const k=d&&typeof d==='object'?Object.keys(d).find(x=>Array.isArray(d[x])):null;
        const items=Array.isArray(d?.results)?d.results:(k?d[k]:[]);
        all.push(...items);
        if(!d?.next||!items.length)break; // next пустой или страница пуста — конец
      }
      res.json({ok:true,members:all});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/guild/:guildId/members/:action',async(req,res)=>{
    try{
      const action=req.params.action;
      const p=GUILD_MEMBER_ACTIONS[action];
      if(!p)return res.status(400).json({ok:false,error:'неизвестное действие'});
      const{user_id}=req.body||{};
      if(!user_id)return res.status(400).json({ok:false,error:'user_id обязателен'});
      const api=await guildManagerApi(req.params.guildId);
      // игра шлёт guild_id ЧИСЛОМ (в бандле guildId:{default:0}); строка отклоняется валидацией
      const r=await api.post(p,{guild_id:Number(req.params.guildId),user_id:Number(user_id)});
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  // настройки гильдии: чтение + сохранение (PATCH)
  app.get('/api/guild/:guildId/settings',async(req,res)=>{
    try{
      const api=await guildManagerApi(req.params.guildId);
      const d=await api.get(`/guilds/management/${req.params.guildId}`);
      res.json({ok:true,settings:d?.settings||{}});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
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
      const api=await guildManagerApi(req.params.guildId);
      const r=await api.patch(`/guilds/management/${req.params.guildId}`,payload);
      res.json({ok:true,result:r});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
