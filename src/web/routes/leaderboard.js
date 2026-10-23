'use strict';
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

// Рейтинги игры (21.10.2026). Два раздела, оба общие на всю игру — читаем с любого живого аккаунта:
//   GET /leaderboard/global   — «Величайшие мэры»: топ-500 {population:[...],profit:[...],me:{rank_population,rank_profit,...}}
//   GET /leaderboard/          — лиги мэров: массив топ-100 каждой лиги {user_id,first_name,last_name,small_url,profit,league,rank}
//   GET /guilds/leaderboard    — лиги гильдий: {leaderboard:[{id,title,photo_small,population,profit,league,rank}]}
//   GET /cities/{user_id}      — чужой город («Посетить город» в профиле игрока, chunks/_id_-*.js страницы /cities/:id):
//                                {user,buildings,unlocked_sections,profit_per_hour,happiness,diversity,income_boost,...}
// Пути и поля — из бандла игры (chunks/global_leaderboard-*.js, leaderboard-*.js, карта роутов apiRoutes.leaderboard).
// Свои аккаунты в списках метим по tg_uid из JWT (игровой user_id = id в Telegram) и запасным путём по имени:
// имя аккаунта бот берёт из /users/me/ как "first_name last_name".
const TTL=10*60_000;
const FETCH_TIMEOUT=90_000;
const cache=new Map(); // kind -> {at,data}
const CITY_TTL=5*60_000,CITY_MAX=50;
const cityCache=new Map(); // user_id -> {at,data}, не больше CITY_MAX последних

function withTimeout(p,ms,label){
  let t;
  return Promise.race([
    Promise.resolve(p).finally(()=>clearTimeout(t)),
    new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(`${label}: не уложился в ${Math.round(ms/1000)}с`)),ms);}),
  ]);
}
function jwtUid(token){
  try{const p=JSON.parse(Buffer.from(String(token).split('.')[1],'base64url').toString());return p.tg_uid??p.sub??p.user_id??null;}
  catch{return null;}
}
const num=v=>{const n=Number(v);return isFinite(n)?n:null;};
const fullName=e=>[e?.first_name,e?.last_name].filter(Boolean).join(' ').trim();

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;

  async function liveAccounts(){
    const{Account}=require('../../db/index');
    return(await Account.findAll({order:[['id','ASC']]})).filter(a=>a.access_token);
  }
  // общий рейтинг читается с первого аккаунта, который ответит; техработы не перебираем
  async function fetchAny(paths){
    const accs=await liveAccounts();
    if(!accs.length)throw new Error('Нет аккаунтов с токеном');
    let lastErr=null;
    for(const acc of accs.slice(0,5)){
      try{
        const api=apiForAcc(acc),out=[];
        for(const p of paths)out.push(await api.get(p));
        return out;
      }catch(e){
        lastErr=e;
        if(e.name==='MaintenanceError')throw e;
        logger.warn(`[${acc.name}] [leaderboard] ${paths.join(', ')}: ${e.message}`);
      }
    }
    throw lastErr;
  }
  // сопоставление записи рейтинга со своим аккаунтом
  async function ownMatcher(){
    const accs=await liveAccounts();
    const byUid=new Map(),byName=new Map();
    for(const a of accs){
      const uid=jwtUid(a.access_token);
      if(uid!=null)byUid.set(String(uid),a.name);
      byName.set(a.name,a.name);
    }
    return{accs,match:e=>byUid.get(String(e?.user_id))||byName.get(fullName(e))||null};
  }
  const player=(e,i,match)=>({
    user_id:e.user_id,name:fullName(e)||`#${e.user_id}`,small_url:e.small_url||null,league:e.league||null,
    population:num(e.population),profit:num(e.profit),rank:num(e.rank)??i+1,account:match(e),
  });
  const ownStats=accs=>accs.map(a=>({account:a.name,population:num(a.population),profit:num(a.profit)}));

  async function loadGlobal(){
    const[d]=await fetchAny(['/leaderboard/global']);
    const{accs,match}=await ownMatcher();
    const pop=(d?.population||[]).map((e,i)=>player(e,i,match));
    const prof=(d?.profit||[]).map((e,i)=>player(e,i,match));
    return{population:pop,profit:prof,own:ownStats(accs)};
  }
  async function loadLeagues(){
    const[p,g]=await fetchAny(['/leaderboard/','/guilds/leaderboard']);
    const{accs,match}=await ownMatcher();
    const{GuildSnapshot}=require('../../db/index');
    const ownGuilds=new Set((await GuildSnapshot.findAll({attributes:['guild_id']})).map(r=>String(r.guild_id)));
    // как в игре: в списки лиги попадают только места до 100-го (свой аккаунт игра присылает и дальше)
    const players=(Array.isArray(p)?p:p?.leaderboard||[]).filter(e=>!(num(e.rank)>100)).map((e,i)=>player(e,i,match));
    const guilds=(g?.leaderboard||[]).filter(e=>!(num(e.rank)>100)).map((e,i)=>({
      id:e.id,title:e.title||`#${e.id}`,photo:e.photo_small||null,league:e.league||null,
      population:num(e.population),profit:num(e.profit),rank:num(e.rank)??i+1,own:ownGuilds.has(String(e.id)),
    }));
    return{players,guilds,own:ownStats(accs)};
  }

  function route(kind,loader){
    app.get(`/api/leaderboard/${kind}`,async(req,res)=>{
      try{
        const c=cache.get(kind);
        if(c&&!req.query.force&&Date.now()-c.at<TTL)return res.json({ok:true,updated_at:c.at,...c.data});
        const data=await opRegistry.run(`leaderboard:${kind}`,()=>withTimeout(loader(),FETCH_TIMEOUT,`рейтинг ${kind}`));
        const at=Date.now();
        cache.set(kind,{at,data});
        res.json({ok:true,updated_at:at,...data});
      }catch(e){
        const c=cache.get(kind);
        // игра недоступна — отдаём прошлый снимок с пометкой, панель покажет ошибку поверх него
        if(c)return res.json({ok:true,stale:true,error:e.message,updated_at:c.at,...c.data});
        res.status(500).json({ok:false,error:e.message});
      }
    });
  }
  // чужой город для просмотра карты (только чтение)
  app.get('/api/leaderboard/city/:userId',async(req,res)=>{
    const id=String(req.params.userId);
    if(!/^\d+$/.test(id))return res.status(400).json({ok:false,error:'Неверный id игрока'});
    try{
      const c=cityCache.get(id);
      if(c&&!req.query.force&&Date.now()-c.at<CITY_TTL)return res.json({ok:true,updated_at:c.at,...c.data});
      const data=await opRegistry.run(`leaderboard:city:${id}`,async()=>{
        const[d]=await withTimeout(fetchAny([`/cities/${id}`]),FETCH_TIMEOUT,'город игрока');
        const u=d?.user||{};
        return{
          user:{id:u.id??Number(id),name:fullName(u)||u.username||`#${id}`,small_url:u.small_url||u.avatar_small||u.photo_url||null},
          buildings:Array.isArray(d?.buildings)?d.buildings:[],
          unlocked_sections:Array.isArray(d?.unlocked_sections)?d.unlocked_sections:null,
          profit_per_hour:num(d?.profit_per_hour),happiness:num(d?.happiness),income_boost:num(d?.income_boost),
        };
      });
      const at=Date.now();
      cityCache.delete(id);cityCache.set(id,{at,data});
      if(cityCache.size>CITY_MAX)cityCache.delete(cityCache.keys().next().value);
      res.json({ok:true,updated_at:at,...data});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  route('global',loadGlobal);
  route('leagues',loadLeagues);
};
