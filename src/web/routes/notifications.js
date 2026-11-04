'use strict';
const logger=require('../../utils/logger');
const{loadSettings,saveSettings}=require('../../config');

// Уведомления (страница «Уведомления»): одна лента из гильдейских рассылок игры и событий бота.
// Чтение — только из БД и памяти процесса: рассылки гильдий лежат в game_extra_cache (их же пишет
// gameExtras.js), события бота собираются из таблиц и состояния (мёртвые аккаунты, обновление,
// техработы, продажи на рынке). Игру зовут только «Обновить с игры», «Отметить прочитанными»
// (mark-as-read игры) и удаление/отправка рассылки (ручки gameExtras.js).
// Что прочитано, скрыто и отложено у событий бота — в settings.json: ui.notify {readAt,guildReadAt,dismissed,snoozed}.

const SNOOZE_MS=4*3600*1000;
const SALES_DAYS=3;
const CUR={toncoin:'GRAM',gram:'GRAM',crystals:'алм.',coins:'монет'};
const listOf=d=>Array.isArray(d)?d:Array.isArray(d?.notifications)?d.notifications:Array.isArray(d?.items)?d.items:Array.isArray(d?.results)?d.results:[];
const atOf=n=>n?.created_at||n?.createdAt||n?.sent_at||n?.date||null;
const parse=s=>{try{return JSON.parse(s);}catch{return null;}};
const errText=e=>{const d=e?.response?.data;const m=d&&(d.detail||d.error||d.message);return m?(typeof m==='string'?m:JSON.stringify(m)):(e?.message||String(e));};

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;
  const db=()=>require('../../db/index');
  const state=()=>({readAt:null,guildReadAt:{},dismissed:[],snoozed:{},...(loadSettings().ui?.notify||{})});
  function saveState(patch){
    const cur=loadSettings();
    const ui=cur.ui||{};
    // массивы и словари пишем целиком: mergeDeep не умеет удалять ключи
    saveSettings({...cur,ui:{...ui,notify:{...state(),...patch}}});
  }
  async function cacheRows(kind){
    const rows=await db().seq.query('SELECT account_id,data,updated_at FROM game_extra_cache WHERE kind=? AND ref=?',{replacements:[kind,''],type:require('sequelize').QueryTypes.SELECT}); // без type драйвер mariadb падает на delete meta
    return new Map(rows.map(r=>[Number(r.account_id),{data:parse(r.data),updated_at:r.updated_at}]));
  }
  async function writeCache(accountId,kind,data){
    await db().seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
      {replacements:[accountId,kind,'',JSON.stringify(data??null),new Date()]});
  }
  // гильдии своих аккаунтов: {guild_id,title,accounts:[{id,name,role}]}
  async function guilds(){
    const{Account,GuildSnapshot}=db();
    const accs=await Account.findAll({attributes:['id','name']});
    const byName=new Map(accs.map(a=>[a.name,a.id]));
    const snaps=await GuildSnapshot.findAll({attributes:['account','guild_id','guild_title','role']});
    const map=new Map();
    for(const s of snaps){
      const id=byName.get(s.account);if(!id||!s.guild_id)continue;
      const g=map.get(s.guild_id)||{guild_id:Number(s.guild_id),title:s.guild_title||`Гильдия ${s.guild_id}`,accounts:[]};
      g.accounts.push({id,name:s.account,role:s.role||null});
      map.set(s.guild_id,g);
    }
    // лидер, затем офицеры: от их имени читаем и пишем
    const rank=r=>r==='Leader'?0:/officer/i.test(r||'')?1:2;
    for(const g of map.values())g.accounts.sort((a,b)=>rank(a.role)-rank(b.role)||a.name.localeCompare(b.name));
    return[...map.values()].sort((a,b)=>a.title.localeCompare(b.title));
  }

  app.get('/api/notifications',async(req,res)=>{
    try{
      const st=state(),now=Date.now();
      const dismissed=new Set(st.dismissed||[]);
      const hidden=id=>dismissed.has(id)||(st.snoozed?.[id]&&new Date(st.snoozed[id]).getTime()>now);
      const gs=await guilds();
      const[lists,unread,canSend]=await Promise.all([cacheRows('guild-notifications'),cacheRows('notifications-unread'),cacheRows('notify-can-send')]);
      const items=[];
      const outGuilds=gs.map(g=>{
        // рассылка одна на гильдию — берём самый свежий снимок среди её аккаунтов
        let best=null;
        for(const a of g.accounts){const c=lists.get(a.id);if(c&&(!best||new Date(c.updated_at)>new Date(best.updated_at)))best={...c,account_id:a.id};}
        const hasUnread=g.accounts.some(a=>unread.get(a.id)?.data?.has_unread);
        const readAt=st.guildReadAt?.[g.guild_id]?new Date(st.guildReadAt[g.guild_id]).getTime():0;
        const send=g.accounts.map(a=>({a,c:canSend.get(a.id)?.data})).find(x=>x.c===true||x.c?.can_send===true||x.c?.allowed===true);
        let n=0;
        for(const x of listOf(best?.data)){
          const at=atOf(x),t=at?new Date(at).getTime():0;
          const u=hasUnread&&(!readAt||t>readAt);
          if(u)n++;
          items.push({id:`g:${g.guild_id}:${x.id}`,src:'guild',guild_id:g.guild_id,guild:g.title,notification_id:x.id,
            title:x.title||'Рассылка гильдии',text:x.text||x.message||'',author:x.author_name||x.sender_name||x.author?.username||null,
            at,unread:u,kind:'guild',act:null});
        }
        return{guild_id:g.guild_id,title:g.title,accounts:g.accounts,updated_at:best?.updated_at||null,unread:n,
          sender_id:send?.a.id??null,can_send:!!send};
      });

      // ── события бота ──
      const{Account,MarketSale}=db();
      const{isRefreshDead}=require('../../modules/session');
      const botRead=st.readAt?new Date(st.readAt).getTime():0;
      const push=(o)=>{if(!hidden(o.id))items.push({...o,unread:!o.at||new Date(o.at).getTime()>botRead});};
      for(const a of await Account.findAll({attributes:['id','name']})){
        if(isRefreshDead(a.id))push({id:`dead:${a.id}`,src:'accounts',account:a.name,account_id:a.id,kind:'alert',at:null,
          title:'Аккаунт вылетел',text:'Игра отклонила токен, бот больше не заходит в этот аккаунт. Нужна новая ссылка из бота игры.',
          act:{label:'Обновить ссылку',href:'/accounts'}});
      }
      try{
        const v=await require('../../utils/versionCheck').getVersionInfo({maxAge:Infinity});
        if(v?.status==='behind')push({id:`update:${v.remote?.sha||v.behindBy}`,src:'update',kind:'success',at:v.remote?.date||null,
          title:'Доступна новая версия бота',text:v.behindBy?`Новых изменений: ${v.behindBy}.`:'Канал обновлений ушёл вперёд.',
          act:{label:'Обновить',href:'/settings'}});
      }catch{}
      const m=require('../../utils/maintenance').status();
      if(m.active)push({id:`maint:${m.since}`,src:'maintenance',kind:'attention',at:m.since?new Date(m.since).toISOString():null,
        title:'Техработы в игре',text:'Бот поставил запросы к игре на паузу и сам продолжит, когда игра ответит.',act:null});
      const since=new Date(now-SALES_DAYS*86400000);
      const sales=await MarketSale.findAll({where:{sold_at:{[require('sequelize').Op.gte]:since}},order:[['sold_at','DESC']],limit:100});
      for(const s of sales)push({id:`sale:${s.id}`,src:'market',account:s.account,kind:'info',at:s.sold_at,item_id:s.item_id,
        title:'Продано на рынке',text:`${s.qty>1?`${s.qty} шт. · `:''}${s.price!=null?`${+s.price} ${CUR[s.currency]??s.currency??''}`:''}${s.counterparty?` · покупатель ${s.counterparty}`:''}`,act:null});

      items.sort((a,b)=>(b.at?new Date(b.at).getTime():now)-(a.at?new Date(a.at).getTime():now));
      res.json({ok:true,guilds:outGuilds,items});
    }catch(e){logger.warn(`[notify] лента: ${errText(e)}`);res.status(500).json({ok:false,error:errText(e)});}
  });

  // прочитать: события бота — локально; гильдия — ещё и mark-as-read в игре от аккаунтов с непрочитанным
  app.post('/api/notifications/read',async(req,res)=>{
    try{
      const src=String(req.body?.source||'all');
      const now=new Date().toISOString();
      const st=state();
      const errors=[];
      if(src==='all'||src==='bot'||!/^\d+$/.test(src))saveState({readAt:now});
      if(src==='all'||/^\d+$/.test(src)){
        const unread=await cacheRows('notifications-unread');
        const gr={...(st.guildReadAt||{})};
        for(const g of await guilds()){
          if(src!=='all'&&String(g.guild_id)!==src)continue;
          gr[g.guild_id]=now;
          for(const a of g.accounts){
            if(!unread.get(a.id)?.data?.has_unread)continue;
            try{
              const acc=await db().Account.findByPk(a.id);
              await apiForAcc(acc).post('/guilds/management/notifications/mark-as-read',{});
              await writeCache(a.id,'notifications-unread',{has_unread:false});
            }catch(e){errors.push(`${a.name}: ${errText(e)}`);}
          }
        }
        saveState({guildReadAt:gr});
      }
      res.json({ok:true,errors});
    }catch(e){res.status(500).json({ok:false,error:errText(e)});}
  });
  // убрать событие бота из ленты (рассылку гильдии удаляет notification-delete в gameExtras.js)
  app.post('/api/notifications/dismiss',(req,res)=>{
    const id=String(req.body?.id||'');
    if(!id||id.startsWith('g:'))return res.status(400).json({ok:false,error:'Неверный идентификатор'});
    const d=[...(state().dismissed||[]).filter(x=>x!==id),id].slice(-500);
    saveState({dismissed:d});res.json({ok:true});
  });
  // напомнить позже: событие пропадает на 4 часа
  app.post('/api/notifications/snooze',(req,res)=>{
    const id=String(req.body?.id||'');
    if(!id)return res.status(400).json({ok:false,error:'Неверный идентификатор'});
    const now=Date.now(),s={};
    for(const[k,v]of Object.entries(state().snoozed||{}))if(new Date(v).getTime()>now)s[k]=v;
    s[id]=new Date(now+SNOOZE_MS).toISOString();
    saveState({snoozed:s});res.json({ok:true,until:s[id]});
  });
  // обновить с игры: список рассылок (от лидера/офицера), флаг непрочитанного у каждого аккаунта, право отправки
  app.post('/api/notifications/refresh',async(req,res)=>{
    try{
      const only=req.body?.guild_id!=null?Number(req.body.guild_id):null;
      const errors=[];
      for(const g of await guilds()){
        if(only!=null&&g.guild_id!==only)continue;
        let listed=false;
        for(const a of g.accounts){
          try{
            const acc=await db().Account.findByPk(a.id);if(!acc?.access_token)continue;
            const api=apiForAcc(acc);
            if(!listed){await writeCache(a.id,'guild-notifications',await api.get(`/guilds/management/${g.guild_id}/notifications`));listed=true;}
            await writeCache(a.id,'notifications-unread',await api.get('/guilds/management/notifications/unread'));
            try{await writeCache(a.id,'notify-can-send',await api.get(`/guilds/management/${g.guild_id}/can-send-notification`));}catch{}
          }catch(e){errors.push(`${a.name}: ${errText(e)}`);}
        }
      }
      res.json({ok:true,errors});
    }catch(e){res.status(500).json({ok:false,error:errText(e)});}
  });
};
