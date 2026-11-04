'use strict';
const logger=require('../../utils/logger');
const{loadSettings,saveSettings}=require('../../config');

// Чат гильдии (2.5, chunks/chat-*.js, сборка 14184):
//   GET  /guilds/{gid}/chat/messages[?before=<id>] → {messages:[{id,user_id,name,role,text,created_at}],has_more,
//        viewer:{user_id,role,can_moderate,mute,mutes:[{user_id,name,mute:{until,ends_in_seconds}}]}}
//   POST …/chat/messages {text≤500}, POST …/chat/read {message_id}, POST …/chat/messages/{id}/delete,
//   POST …/chat/mutes {user_id,duration:'1h'|'1d'|'7d'|'30d'}, POST …/chat/mutes/{user_id}/lift.
// Страница читает только БД: лента гильдии — game_extra_cache (account_id=0, kind 'guild-chat', ref=gid),
// права и мут каждого аккаунта — (account_id, 'guild-chat-viewer', gid). Игру зовут «Обновить», «Ранее»,
// отправка и модерация; новые сообщения приходят живьём по WS одного аккаунта гильдии (wsSession) и
// рассылаются вкладкам событием 'guild-chat'. Мутации не повторяются: итог — по перечитанной ленте.
// Прочитанное — settings.json ui.chatRead {gid: id последнего прочитанного сообщения}.
const KEEP=1000;
const MAX_TEXT=500;
const DURATIONS=new Set(['1h','1d','7d','30d']);
const parse=s=>{try{return JSON.parse(s);}catch{return null;}};
const errText=e=>{const d=e?.response?.data;const m=d&&(d.detail||d.error||d.message);return m?(typeof m==='string'?m:JSON.stringify(m)):(e?.message||String(e));};
const bad=(m,status=400)=>Object.assign(new Error(m),{status});

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;
  const db=()=>require('../../db/index');
  const SELECT=()=>({type:require('sequelize').QueryTypes.SELECT});
  const guildAccounts=()=>require('../lib/guildAccounts').guildAccounts();
  const emit=(data)=>{try{require('../lib/panelEvents').emit('guild-chat',data);}catch(_){}};

  async function readCache(accountId,kind,ref){
    const r=await db().seq.query('SELECT data,updated_at FROM game_extra_cache WHERE account_id=? AND kind=? AND ref=?',{replacements:[accountId,kind,String(ref)],...SELECT()});
    return r[0]?{data:parse(r[0].data),updated_at:r[0].updated_at}:null;
  }
  async function writeCache(accountId,kind,ref,data){
    await db().seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
      {replacements:[accountId,kind,String(ref),JSON.stringify(data??null),new Date()]});
  }
  // лента гильдии: сообщения по id без дублей, по возрастанию, не больше KEEP последних
  function mergeMessages(old,add){
    const m=new Map();
    for(const x of old||[])if(x?.id!=null)m.set(String(x.id),x);
    for(const x of add||[])if(x?.id!=null)m.set(String(x.id),x);
    return[...m.values()].sort((a,b)=>Number(a.id)-Number(b.id)).slice(-KEEP);
  }
  // запись в ленту под общей очередью: живые события WS и ответы игры не затирают друг друга
  let chain=Promise.resolve();
  function updateFeed(gid,fn){
    const run=chain.then(async()=>{
      const cur=(await readCache(0,'guild-chat',gid))?.data||{messages:[],has_more:true};
      const next=fn(cur);
      if(next)await writeCache(0,'guild-chat',gid,next);
      return next||cur;
    });
    chain=run.catch(()=>{});
    return run;
  }
  const chatRead=()=>({...(loadSettings().ui?.chatRead||{})});
  function setRead(gid,id){
    const cur=loadSettings();const ui=cur.ui||{};
    saveSettings({...cur,ui:{...ui,chatRead:{...(ui.chatRead||{}),[gid]:Number(id)}}});
  }
  async function guildOf(gid){
    const g=(await guildAccounts()).find(x=>x.guild_id===Number(gid));
    if(!g)throw bad('Среди аккаунтов нет участников этой гильдии',404);
    return g;
  }
  async function accountIn(g,accountId){
    const a=accountId!=null?g.accounts.find(x=>x.id===Number(accountId)):g.accounts[0];
    if(!a)throw bad('Аккаунт не состоит в этой гильдии');
    const acc=await db().Account.findByPk(a.id);
    if(!acc?.access_token||acc.access_token==='placeholder')throw bad(`У аккаунта ${a.name} нет токена`);
    return acc;
  }
  async function pull(acc,gid,before){
    const d=await apiForAcc(acc).get(`/guilds/${gid}/chat/messages`,before?{before}:undefined);
    if(d?.viewer)await writeCache(acc.id,'guild-chat-viewer',gid,d.viewer);
    return d;
  }

  // ── живые сообщения: один аккаунт на гильдию держит подписку на своём WS ──
  const live=new Map(); // gid -> accountId
  function onWs(gid){
    return msg=>{
      const t=msg.type;
      if(t==='guild_chat_message'&&msg.message?.id!=null){
        updateFeed(gid,cur=>({...cur,messages:mergeMessages(cur.messages,[msg.message])}))
          .then(()=>emit({guild_id:gid,type:'message',message:msg.message})).catch(e=>logger.warn(`[chat] ${gid}: ${e.message}`));
      }else if(t==='guild_chat_deleted'&&msg.message_id!=null){
        updateFeed(gid,cur=>({...cur,messages:(cur.messages||[]).filter(x=>String(x.id)!==String(msg.message_id))}))
          .then(()=>emit({guild_id:gid,type:'deleted',message_id:msg.message_id})).catch(()=>{});
      }else if(t==='guild_chat_mute'){
        emit({guild_id:gid,type:'mute',user_id:msg.user_id,name:msg.name,mute:msg.mute});
      }
    };
  }
  async function syncLive(){
    try{
      const ws=require('../../utils/wsSession');
      const gs=await guildAccounts();
      const want=new Map(gs.filter(g=>g.accounts.length).map(g=>[g.guild_id,g.accounts[0].id]));
      for(const[gid,accId]of live)if(want.get(gid)!==accId){ws.subscribeGuildChat(accId,null);live.delete(gid);}
      for(const[gid,accId]of want)if(live.get(gid)!==accId){ws.subscribeGuildChat(accId,gid,onWs(gid));live.set(gid,accId);}
    }catch(e){logger.warn(`[chat] подписка на чаты: ${e.message}`);}
  }
  // после старта сессий бота и раз в 10 минут — состав гильдий меняется вместе со снимками
  setTimeout(()=>{syncLive();setInterval(syncLive,10*60000).unref?.();},60000).unref?.();

  // список гильдий для сайдбара: последнее сообщение и непрочитанные — из БД
  app.get('/api/guild-chat',async(req,res)=>{
    try{
      const read=chatRead();
      const out=[];
      for(const g of await guildAccounts()){
        const feed=(await readCache(0,'guild-chat',g.guild_id));
        const msgs=feed?.data?.messages||[];
        const viewers=await Promise.all(g.accounts.map(a=>readCache(a.id,'guild-chat-viewer',g.guild_id)));
        const mine=new Set(viewers.map(v=>v?.data?.user_id).filter(x=>x!=null).map(String));
        const lastRead=Number(read[g.guild_id]||0);
        const unread=msgs.filter(m=>Number(m.id)>lastRead&&!mine.has(String(m.user_id))).length;
        out.push({guild_id:g.guild_id,title:g.title,accounts:g.accounts,last:msgs[msgs.length-1]||null,unread,updated_at:feed?.updated_at||null});
      }
      res.json({ok:true,guilds:out});
    }catch(e){logger.warn(`[chat] список: ${errText(e)}`);res.status(500).json({ok:false,error:errText(e)});}
  });

  // лента гильдии из БД + права каждого своего аккаунта
  app.get('/api/guild-chat/:gid',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const feed=await readCache(0,'guild-chat',g.guild_id);
      const viewers={};
      for(const a of g.accounts){const v=await readCache(a.id,'guild-chat-viewer',g.guild_id);if(v?.data)viewers[a.id]=v.data;}
      res.json({ok:true,guild:g,messages:feed?.data?.messages||[],has_more:feed?.data?.has_more??true,viewers,
        last_read:Number(chatRead()[g.guild_id]||0),updated_at:feed?.updated_at||null});
    }catch(e){res.status(e.status||500).json({ok:false,error:errText(e)});}
  });

  // обновить с игры: свежая страница ленты и права всех своих аккаунтов
  app.post('/api/guild-chat/:gid/refresh',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const errors=[];let first=null;
      for(const a of g.accounts){
        try{
          const acc=await db().Account.findByPk(a.id);if(!acc?.access_token||acc.access_token==='placeholder')continue;
          const d=await pull(acc,g.guild_id);
          if(!first){first=d;await updateFeed(g.guild_id,cur=>({...cur,messages:mergeMessages(cur.messages,d?.messages),has_more:cur.messages?.length?cur.has_more:!!d?.has_more}));}
        }catch(e){errors.push(`${a.name}: ${errText(e)}`);}
      }
      syncLive();
      res.json({ok:true,errors});
    }catch(e){res.status(e.status||500).json({ok:false,error:errText(e)});}
  });

  // подгрузить более ранние сообщения
  app.post('/api/guild-chat/:gid/older',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const acc=await accountIn(g,req.body?.account_id);
      const cur=(await readCache(0,'guild-chat',g.guild_id))?.data;
      const before=cur?.messages?.[0]?.id;
      const d=await pull(acc,g.guild_id,before);
      await updateFeed(g.guild_id,c=>({...c,messages:mergeMessages(c.messages,d?.messages),has_more:!!d?.has_more}));
      res.json({ok:true,added:(d?.messages||[]).length,has_more:!!d?.has_more});
    }catch(e){res.status(e.status||500).json({ok:false,error:errText(e)});}
  });

  app.post('/api/guild-chat/:gid/send',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const text=String(req.body?.text??'').trim();
      if(!text)throw bad('Пустое сообщение');
      if(text.length>MAX_TEXT)throw bad(`Сообщение длиннее ${MAX_TEXT} символов`);
      const acc=await accountIn(g,req.body?.account_id);
      const r=await apiForAcc(acc).post(`/guilds/${g.guild_id}/chat/messages`,{text});
      logger.info(`[${acc.name}] [chat] сообщение в чат гильдии ${g.guild_id}`);
      const msg=r?.message||(r?.id!=null?r:null);
      if(msg)await updateFeed(g.guild_id,cur=>({...cur,messages:mergeMessages(cur.messages,[msg])}));
      else{try{const d=await pull(acc,g.guild_id);await updateFeed(g.guild_id,cur=>({...cur,messages:mergeMessages(cur.messages,d?.messages)}));}catch(_){}}
      res.json({ok:true,message:msg});
    }catch(e){logger.warn(`[chat] отправка: ${errText(e)}`);res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});}
  });

  // прочитано: локально и в игре у каждого своего аккаунта (одна попытка, без повторов)
  app.post('/api/guild-chat/:gid/read',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const msgs=(await readCache(0,'guild-chat',g.guild_id))?.data?.messages||[];
      const last=msgs[msgs.length-1];
      if(!last)return res.json({ok:true});
      setRead(g.guild_id,last.id);
      const errors=[];
      for(const a of g.accounts){
        try{const acc=await db().Account.findByPk(a.id);if(acc?.access_token&&acc.access_token!=='placeholder')await apiForAcc(acc).post(`/guilds/${g.guild_id}/chat/read`,{message_id:Number(last.id)});}
        catch(e){errors.push(`${a.name}: ${errText(e)}`);}
      }
      res.json({ok:true,errors});
    }catch(e){res.status(e.status||500).json({ok:false,error:errText(e)});}
  });

  // модерация — от аккаунта с правом can_moderate
  app.post('/api/guild-chat/:gid/delete',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const acc=await accountIn(g,req.body?.account_id);
      const id=Number(req.body?.message_id);if(!Number.isInteger(id)||id<=0)throw bad('Неверное сообщение');
      await apiForAcc(acc).post(`/guilds/${g.guild_id}/chat/messages/${id}/delete`,{});
      logger.info(`[${acc.name}] [chat] удалено сообщение ${id} в гильдии ${g.guild_id}`);
      await updateFeed(g.guild_id,cur=>({...cur,messages:(cur.messages||[]).filter(x=>Number(x.id)!==id)}));
      res.json({ok:true});
    }catch(e){res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});}
  });
  app.post('/api/guild-chat/:gid/mute',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const acc=await accountIn(g,req.body?.account_id);
      const user_id=Number(req.body?.user_id),duration=String(req.body?.duration||'');
      if(!Number.isInteger(user_id)||user_id<=0)throw bad('Неверный участник');
      if(!DURATIONS.has(duration))throw bad('Неверный срок');
      await apiForAcc(acc).post(`/guilds/${g.guild_id}/chat/mutes`,{user_id,duration});
      logger.info(`[${acc.name}] [chat] запрет писать ${duration} участнику ${user_id} в гильдии ${g.guild_id}`);
      try{await pull(acc,g.guild_id);}catch(_){}
      res.json({ok:true});
    }catch(e){res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});}
  });
  app.post('/api/guild-chat/:gid/unmute',async(req,res)=>{
    try{
      const g=await guildOf(req.params.gid);
      const acc=await accountIn(g,req.body?.account_id);
      const user_id=Number(req.body?.user_id);if(!Number.isInteger(user_id)||user_id<=0)throw bad('Неверный участник');
      await apiForAcc(acc).post(`/guilds/${g.guild_id}/chat/mutes/${user_id}/lift`,{});
      logger.info(`[${acc.name}] [chat] снят запрет писать с ${user_id} в гильдии ${g.guild_id}`);
      try{await pull(acc,g.guild_id);}catch(_){}
      res.json({ok:true});
    }catch(e){res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});}
  });
};
