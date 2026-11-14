'use strict';
const logger=require('../../utils/logger');

// Возможности игры, которые бот раньше не показывал (сверка бандла 2.5, issue #207).
// Чтение: страница берёт последний ответ из game_extra_cache (без запроса в игру), игру зовёт только
// POST …/refresh (кнопка «Обновить»). Действия — только вручную, без повторов (ApiClient не повторяет
// изменяющие запросы), после действия перечитываем нужный снимок.
// Пути и тела запросов — из entry-HgskWCcp-14184.js (карта API клиента) и чанков страниц.
const READ={
  metrics:{path:()=>'/progress/metrics'},
  rank:{path:()=>'/leaderboard/global/me'},
  'pack-info':{path:(r)=>`/booster-packs/info/${num(r)}`,shared:true},
  'guild-gifts':{path:(r,g)=>`/guilds/${g}/gifts`,guild:true},
  'guild-gifts-history':{path:(r,g)=>`/guilds/${g}/gifts/history`,params:r=>({before:num(r)}),guild:true},
  treasury:{path:(r,g)=>`/guilds/${g}/treasury`,guild:true},
  'treasury-actions':{path:(r,g)=>`/guilds/${g}/treasury/actions`,guild:true},
  'treasury-lb':{guild:true,multi:g=>({coins:`/guilds/${g}/treasury/leaderboard/coins`,crystals:`/guilds/${g}/treasury/leaderboard/crystals`})},
  renown:{path:(r,g)=>`/guilds/${g}/renown`,guild:true},
  'renown-actions':{path:(r,g)=>`/guilds/${g}/renown/actions`,guild:true},
  'renown-lb':{path:(r,g)=>`/guilds/${g}/renown/leaderboard`,guild:true},
  'satoshi-history':{path:()=>'/satoshi-tower/positions/history'},
  'gram-tx':{path:()=>'/market/toncoin/transactions',params:()=>({page:1,page_size:50})},
  achievements:{path:()=>'/achievements/'},
  'guild-achievements':{path:(r,g)=>`/achievements/guild/${g}`,guild:true},
  'guild-notifications':{path:(r,g)=>`/guilds/management/${g}/notifications`,guild:true},
  'notifications-unread':{path:()=>'/guilds/management/notifications/unread'},
  'notify-can-send':{path:(r,g)=>`/guilds/management/${g}/can-send-notification`,guild:true},
};
function num(v){const n=Number(v);if(!Number.isInteger(n)||n<=0)throw Object.assign(new Error('Неверный идентификатор'),{status:400});return n;}
const errText=e=>{const d=e?.response?.data;return(d&&(d.detail||d.error||d.message))?String(typeof(d.detail||d.error||d.message)==='string'?(d.detail||d.error||d.message):JSON.stringify(d.detail||d.error||d.message)):(e?.message||String(e));};

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;
  const db=()=>require('../../db/index');
  const sendingGifts=new Set();
  const bad=(message,status=400)=>Object.assign(new Error(message),{status});
  const admin=g=>['Superuser','Leader','Officer'].includes(g?.role);
  async function giftGuild(api,expected){
    const g=(await api.get('/users/me/guild'))?.guild;
    if(!g?.id)throw bad('Аккаунт не состоит в гильдии',409);
    if(expected!=null&&String(g.id)!==String(expected))throw bad('Гильдия изменилась — обновите подарки и подтвердите заново',409);
    const role=await api.get(`/guilds/${g.id}/role`);
    return{...g,role:role?.role};
  }
  const giftData=(data,g)=>{
    if(!data||!Array.isArray(data.items)||!Array.isArray(data.members)||!Array.isArray(data.history?.gifts)||!Number.isFinite(data.balance))throw bad('Игра вернула неполное состояние подарков',502);
    return{...data,guild_id:String(g.id),can_send:admin(g)&&data.can_send!==false,captured_at:new Date().toISOString()};
  };

  async function account(id){
    const acc=await db().Account.findByPk(num(id));
    if(!acc?.access_token)throw Object.assign(new Error('Аккаунт не найден'),{status:404});
    return acc;
  }
  async function guildOf(acc){
    const s=await db().GuildSnapshot.findOne({where:{account:acc.name}});
    if(!s?.guild_id)throw Object.assign(new Error('Аккаунт не в гильдии (нет снимка гильдии — обновите «Гильдии»)'),{status:409});
    return Number(s.guild_id);
  }
  async function readCache(accountId,kind,ref){
    const rows=await db().seq.query('SELECT data,updated_at FROM game_extra_cache WHERE account_id=? AND kind=? AND ref=? LIMIT 1',{replacements:[accountId,kind,ref],type:require('sequelize').QueryTypes.SELECT}); // без type драйвер mariadb падает на delete meta
    if(!rows.length)return null;
    let data=null;try{data=JSON.parse(rows[0].data);}catch{}
    return{data,updated_at:rows[0].updated_at};
  }
  async function writeCache(accountId,kind,ref,data){
    const now=new Date();
    await db().seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
      {replacements:[accountId,kind,ref,JSON.stringify(data??null),now]});
    return now;
  }
  const fail=(res,e)=>res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});

  // ── чтение ────────────────────────────────────────────────────────────────
  app.get('/api/extras/:kind',async(req,res)=>{
    try{
      const def=READ[req.params.kind];if(!def)return res.status(404).json({ok:false,error:'Неизвестный раздел'});
      const ref=String(req.query.ref??'');
      const accountId=def.shared?0:num(req.query.account);
      let c=await readCache(accountId,req.params.kind,ref);
      if(req.params.kind==='guild-gifts'&&c){
        const acc=await account(accountId),membership=await db().GuildSnapshot.findOne({where:{account:acc.name}});
        if(String(c.data?.guild_id??'')!==String(membership?.guild_id??''))c=null;
      }
      res.json({ok:true,data:c?.data??null,updated_at:c?.updated_at??null});
    }catch(e){fail(res,e);}
  });
  // все аккаунты сразу (таблица «Мои аккаунты» в рейтинге и т.п.)
  app.get('/api/extras/:kind/all',async(req,res)=>{
    try{
      if(!READ[req.params.kind])return res.status(404).json({ok:false,error:'Неизвестный раздел'});
      const rows=await db().seq.query('SELECT account_id,data,updated_at FROM game_extra_cache WHERE kind=? AND ref=?',{replacements:[req.params.kind,String(req.query.ref??'')],type:require('sequelize').QueryTypes.SELECT}); // без type драйвер mariadb падает на delete meta
      res.json({ok:true,rows:rows.map(r=>{let d=null;try{d=JSON.parse(r.data);}catch{}return{account_id:r.account_id,data:d,updated_at:r.updated_at};})});
    }catch(e){fail(res,e);}
  });
  app.post('/api/extras/:kind/refresh',async(req,res)=>{
    const kind=req.params.kind,def=READ[kind];
    if(!def)return res.status(404).json({ok:false,error:'Неизвестный раздел'});
    try{
      const ref=String(req.body?.ref??'');
      const acc=await account(req.body?.account_id);
      const api=apiForAcc(acc);
      const g=kind.startsWith('guild-gifts')?await giftGuild(api):null;
      const gid=g?g.id:def.guild?await guildOf(acc):null;
      let data;
      if(def.multi){data={};for(const[k,p]of Object.entries(def.multi(gid)))data[k]=await api.get(p);}
      else data=await api.get(def.path(ref,gid),def.params?def.params(ref):{});
      if(kind==='guild-gifts')data=giftData(data,g);
      const updated_at=await writeCache(def.shared?0:acc.id,kind,ref,data);
      res.json({ok:true,data,updated_at});
    }catch(e){
      if(!e.noBuilding)logger.warn(`[extras] ${kind}: ${errText(e)}`);
      fail(res,e);
    }
  });

  // ── действия (только вручную) ─────────────────────────────────────────────
  async function act(req,res,fn){
    try{
      const acc=await account(req.body?.account_id);
      const r=await fn(acc,apiForAcc(acc));
      res.json({ok:true,...(r&&typeof r==='object'?{data:r}:{})});
    }catch(e){logger.warn(`[extras] ${req.path}: ${errText(e)}`);fail(res,e);}
  }
  app.post('/api/extras/guild-gifts-send',async(req,res)=>{
    let lock;
    try{
      const acc=await account(req.body?.account_id),api=apiForAcc(acc);
      lock=acc.id;
      if(sendingGifts.has(lock)){lock=null;throw bad('Отправка подарков уже выполняется',409);}
      sendingGifts.add(lock);
      const g=await giftGuild(api,num(req.body?.expected_guild_id));
      if(!admin(g))throw bad('Отправлять подарки могут лидер и офицеры',403);
      const before=giftData(await api.get(`/guilds/${g.id}/gifts`),g);
      if(before?.can_send===false)throw bad('Игра запретила отправку подарков',403);
      const gifts=req.body?.gifts;
      if(!Array.isArray(gifts)||!gifts.length||gifts.length>1000)throw bad('Выберите получателей подарков');
      const users=new Set();let cost=0;
      for(const gift of gifts){
        const uid=num(gift?.user_id);if(users.has(uid))throw bad('Получатель указан дважды');users.add(uid);
        const member=before.members?.find(m=>Number(m.user_id)===uid);
        if(!member||!Number.isFinite(member.eligible_in_seconds)||member.eligible_in_seconds>0)throw bad('Получатель ещё не может получать подарки — обновите список',409);
        if(!Array.isArray(gift.items)||!gift.items.length)throw bad('Укажите предметы получателя');
        const items=new Set();
        for(const line of gift.items){
          const id=num(line?.item_id),quantity=line?.quantity;
          if(items.has(id)||!Number.isSafeInteger(quantity)||quantity<=0)throw bad('Некорректное количество подарков');items.add(id);
          const item=before.items?.find(i=>Number(i.item_id)===id),remaining=Number(member.remaining?.[String(id)]);
          if(!item||!Number.isFinite(item.price)||item.price<0||!Number.isFinite(remaining)||quantity>remaining)throw bad('Ассортимент или недельный лимит изменился — обновите подарки',409);
          cost+=item.price*quantity;
        }
      }
      if(!Number.isFinite(cost)||cost!==req.body.expected_cost)throw bad('Стоимость изменилась — обновите подарки и подтвердите заново',409);
      if(!Number.isFinite(before.balance)||cost>before.balance)throw bad('Недостаточно алмазов в казне',409);
      let error=null,after=null;
      try{await api.post(`/guilds/${g.id}/gifts`,{gifts:gifts.map(gift=>({user_id:Number(gift.user_id),items:gift.items.map(i=>({item_id:Number(i.item_id),quantity:i.quantity}))}))});}catch(e){error=e;}
      // После неоднозначного POST перечитываем состояние, но расходующий запрос не повторяем.
      try{after=giftData(await api.get(`/guilds/${g.id}/gifts`),g);await writeCache(acc.id,'guild-gifts','',after);}catch(e){logger.warn(`[${acc.name}] [guild-gifts] обновление: ${errText(e)}`);}
      res.json({ok:!error,error:error?`${errText(error)}. Перед повтором проверьте историю подарков.`:undefined,data:after,refresh_error:after?undefined:'Не удалось обновить снимок подарков'});
    }catch(e){fail(res,e);}
    finally{if(lock!=null)sendingGifts.delete(lock);}
  });
  // предпросмотр снятия политики: штраф (penalty) или null — изменяющий только по методу, состояние не трогает
  app.post('/api/extras/policy-unequip-preview',(req,res)=>act(req,res,(acc,api)=>api.post('/policies/unequip/preview',{instance_id:num(req.body.instance_id)})));
  // взнос личного Почёта в казну Почёта гильдии
  app.post('/api/extras/renown-deposit',(req,res)=>act(req,res,async(acc,api)=>{
    const amount=Math.floor(Number(req.body.amount));
    if(!(amount>0))throw Object.assign(new Error('Сумма должна быть больше 0'),{status:400});
    const gid=await guildOf(acc);
    const r=await api.post(`/guilds/${gid}/renown/deposit`,{amount});
    logger.info(`[${acc.name}] [renown] взнос ${amount} Почёта в гильдию ${gid}`);
    return r;
  }));
  // гильдейские уведомления игры
  app.post('/api/extras/notifications-mark-read',(req,res)=>act(req,res,(acc,api)=>api.post('/guilds/management/notifications/mark-as-read',{})));
  app.post('/api/extras/notification-delete',(req,res)=>act(req,res,async(acc,api)=>{const gid=await guildOf(acc);return api.del(`/guilds/management/${gid}/notifications/${num(req.body.notification_id)}`);}));
  app.post('/api/extras/notification-send',(req,res)=>act(req,res,async(acc,api)=>{
    const title=String(req.body.title??'').trim(),text=String(req.body.text??'').trim();
    if(!title||!text)throw Object.assign(new Error('Нужны заголовок и текст'),{status:400});
    if(text.length>200)throw Object.assign(new Error('Текст длиннее 200 символов'),{status:400});
    const gid=await guildOf(acc);
    const r=await api.post(`/guilds/management/${gid}/notifications`,{title,text});
    logger.info(`[${acc.name}] [guild] рассылка гильдии ${gid}: «${title}»`);
    return r;
  }));
};
