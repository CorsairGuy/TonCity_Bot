'use strict';
// Общая витрина квестов: только снимки БД при открытии. Живые чтения — по явному refresh.
const logger=require('../utils/logger');
const KIND='guild-quests-status',DAY=86400000;
const millis=value=>{if(value==null||value==='')return NaN;const n=Number(value);return value!=null&&value!==''&&Number.isFinite(n)&&n>1e9?(n<1e12?n*1000:n):new Date(value).getTime();};
const stamp=row=>Number.isFinite(millis(row?.updated_at))?millis(row.updated_at):0;
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
function latestMemberships(accounts,rows){
  const names=new Set(accounts.map(a=>a.name)),latest=new Map();
  for(const row of rows){if(!names.has(row.account)||!row.guild_id)continue;const old=latest.get(row.account);if(!old||stamp(row)>=stamp(old))latest.set(row.account,row);}
  return latest;
}
function questArray(row){const data=parse(row?.quests);return Array.isArray(data)?data:null;}
function buildGroups(accounts,memberships,snapshots,statuses=[],now=Date.now()){
  const current=latestMemberships(accounts,memberships),byName=new Map(accounts.map(a=>[a.name,a])),groups=new Map();
  const states=new Map(statuses.map(s=>[String(s.ref),{...parse(s.data),updated_at:s.updated_at}]));
  for(const member of current.values()){
    const gid=String(member.guild_id),group=groups.get(gid)||{guild_id:gid,guild_title:member.guild_title||gid,members:[]};
    group.members.push(member);groups.set(gid,group);
  }
  return [...groups.values()].map(g=>{
    const all=snapshots.filter(s=>String(s.guild_id)===g.guild_id&&questArray(s)!==null).sort((a,b)=>stamp(b)-stamp(a));
    const state=states.get(g.guild_id);
    const own=s=>String(current.get(s.account)?.guild_id??'')===g.guild_id&&byName.has(s.account);
    const active=s=>questArray(s).some(q=>!q.expires_at||millis(q.expires_at)>now);
    // Подтверждённый пустой ответ авторитетен; отсутствие доступа не затирает старый список.
    const sinceReady=state?.status==='ready'?all.filter(s=>stamp(s)>=stamp(state)):all;
    const authoritative=state?.status==='ready'?all.find(s=>byName.get(s.account)?.id===state.account_id&&stamp(s)>=stamp(state)):null;
    const canonical=sinceReady.find(s=>own(s)&&active(s))||sinceReady.find(active)||authoritative||sinceReady.find(s=>own(s)&&questArray(s).length)||sinceReady.find(own)||null;
    const personal=g.members.map(m=>{
      const blocked=state?.blocked_accounts?.includes(byName.get(m.account)?.id);
      const joined=millis(state?.joined_at?.[byName.get(m.account)?.id]);
      const snapshot=all.find(s=>s.account===m.account&&(!Number.isFinite(joined)||stamp(s)>=joined)&&(!blocked||(Number.isFinite(joined)&&stamp(s)>=joined+DAY)));
      return{account:m.account,account_id:byName.get(m.account)?.id??null,quests:snapshot?questArray(snapshot):[],updated_at:snapshot?.updated_at};
    });
    const source=canonical&&own(canonical)?byName.get(canonical.account):null;
    let error=state?.status&&state.status!=='ready'?state.error:undefined;
    if(state?.status==='membership_wait'&&state.eligible_at&&millis(state.eligible_at)<=now)error='Срок ожидания 24 часа истёк — нажмите «Обновить»';
    if(!canonical&&!error)error='Нет сохранённого списка квестов — нажмите «Обновить»';
    return{guild_id:g.guild_id,guild_title:g.guild_title,account:source?.name,account_id:source?.id??null,
      quests:canonical?questArray(canonical):[],accounts:personal,updated_at:canonical?.updated_at,
      read_status:state?.status??(canonical?'ready':'no_snapshot'),eligible_at:state?.eligible_at,error};
  }).sort((a,b)=>a.guild_title.localeCompare(b.guild_title,'ru'));
}
async function statusRows(db){return db.seq.query('SELECT ref,data,updated_at FROM game_extra_cache WHERE kind=? AND account_id=?',{replacements:[KIND,0],type:require('sequelize').QueryTypes.SELECT});}
async function saveStatus(db,gid,data,now){await db.seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',{replacements:[0,KIND,String(gid),JSON.stringify(data),now]});}
async function readGroups(){
  const db=require('../db/index');
  const[accounts,memberships,snapshots,statuses]=await Promise.all([db.Account.findAll({attributes:['id','name','crystals']}),db.GuildSnapshot.findAll(),db.GuildQuestSnapshot.findAll(),statusRows(db)]);
  return{groups:buildGroups(accounts,memberships,snapshots,statuses),accounts};
}
function readyAt(guild){const joined=millis(guild?.joined_at);return Number.isFinite(joined)?joined+DAY:null;}
async function refreshGroups(makeApiForAccount){
  const db=require('../db/index'),{Op}=require('sequelize');
  const accounts=await db.Account.findAll({order:[['id','ASC']]}),before=await db.GuildSnapshot.findAll();
  const confirmed=new Map(),clients=new Map(),failures=[];
  // Членство проверяем у каждого аккаунта: иначе невозможно обнаружить выход последнего участника.
  for(const acc of accounts){
    if(!acc.access_token||acc.access_token==='placeholder')continue;
    try{
      const api=await makeApiForAccount(acc.id,{noLock:true});clients.set(acc.name,api);
      const response=await api.get('/users/me/guild');
      if(!response||!Object.prototype.hasOwnProperty.call(response,'guild'))throw new Error('Сервер не вернул членство');
      const guild=response.guild;
      if(!guild?.id){await db.GuildSnapshot.destroy({where:{account:acc.name}});confirmed.set(acc.name,null);continue;}
      const gid=String(guild.id),same=before.filter(s=>s.account===acc.name&&String(s.guild_id)===gid).sort((a,b)=>stamp(b)-stamp(a))[0];
      await db.GuildSnapshot.upsert({account:acc.name,guild_id:gid,guild_title:guild.title||'',role:guild.role||'',benefits:same?.benefits??null,updated_at:new Date()},{conflictFields:['account','guild_id']});
      await db.GuildSnapshot.destroy({where:{account:acc.name,guild_id:{[Op.ne]:gid}}});
      confirmed.set(acc.name,guild);
    }catch(e){failures.push({name:acc.name,ok:false,error:`Не удалось проверить членство: ${e.message}`});logger.warn(`[${acc.name}] [quests] membership: ${e.message}`);}
  }
  const current=latestMemberships(accounts,await db.GuildSnapshot.findAll()),snapshots=await db.GuildQuestSnapshot.findAll();
  const grouped=new Map();
  for(const member of current.values()){
    const gid=String(member.guild_id);if(!grouped.has(gid))grouped.set(gid,[]);
    grouped.get(gid).push(accounts.find(a=>a.name===member.account));
  }
  const results=[];
  for(const[gid,members]of grouped){
    const now=Date.now(),nowDate=new Date(now),title=current.get(members[0].name)?.guild_title||gid;
    const available=members.filter(a=>confirmed.get(a.name)&&String(confirmed.get(a.name).id)===gid);
    const candidates=available.filter(a=>readyAt(confirmed.get(a.name))==null||readyAt(confirmed.get(a.name))<=now);
    const lastGood=snapshots.filter(s=>String(s.guild_id)===gid&&questArray(s)?.length&&available.some(a=>a.name===s.account)).sort((a,b)=>stamp(b)-stamp(a))[0];
    candidates.sort((a,b)=>((a.name===lastGood?.account)?-1:(b.name===lastGood?.account)?1:0)||(readyAt(confirmed.get(a.name))??Infinity)-(readyAt(confirmed.get(b.name))??Infinity)||a.id-b.id);
    const membershipData={blocked_accounts:available.filter(a=>readyAt(confirmed.get(a.name))>now).map(a=>a.id),joined_at:Object.fromEntries(available.filter(a=>confirmed.get(a.name).joined_at).map(a=>[a.id,confirmed.get(a.name).joined_at]))};
    let result;
    if(!candidates.length){
      const waits=available.map(a=>readyAt(confirmed.get(a.name))).filter(t=>Number.isFinite(t)&&t>now);
      const eligible=waits.length?new Date(Math.min(...waits)).toISOString():undefined;
      const error=eligible?'Квесты недоступны: свои участники находятся в гильдии меньше 24 часов':'Нет доступного аккаунта для чтения квестов';
      const status=eligible?'membership_wait':'unavailable';
      await saveStatus(db,gid,{...membershipData,status,error,eligible_at:eligible},nowDate);
      results.push({guild_id:gid,name:title,ok:false,error,status,eligible_at:eligible});continue;
    }
    const errors=[];
    for(const acc of candidates){
      let data;
      try{
        data=await clients.get(acc.name).get(`/guild-quests/guild/${gid}`);
        if(!Array.isArray(data?.quests)||data.membership_eligible===false)throw new Error('Сервер не предоставил список квестов этому участнику');
      }catch(e){errors.push(`${acc.name}: ${e.message}`);continue;}
      // Один успешный GET на гильдию. Личный прогресс сохраняем только для его владельца.
      try{
        const captured=new Date();
        await db.GuildQuestSnapshot.upsert({guild_id:gid,guild_title:title,account:acc.name,quests:JSON.stringify(data.quests),updated_at:captured},{conflictFields:['guild_id','account']});
        await saveStatus(db,gid,{...membershipData,status:'ready',account_id:acc.id},captured);
        result={guild_id:gid,name:acc.name,ok:true,count:data.quests.length,status:'ready'};
      }catch(e){result={guild_id:gid,name:acc.name,ok:false,error:`Не удалось сохранить квесты: ${e.message}`,status:'unavailable'};}
      break;
    }
    if(!result){const error=`Не удалось получить квесты: ${errors.join('; ')}`;await saveStatus(db,gid,{...membershipData,status:'unavailable',error},nowDate);result={guild_id:gid,name:title,ok:false,error,status:'unavailable'};}
    results.push(result);
  }
  // Исторические квесты могут остаться для диагностики; выдача фильтруется по текущему членству.
  return[...results,...failures];
}
module.exports={latestMemberships,buildGroups,readGroups,refreshGroups,readyAt};
