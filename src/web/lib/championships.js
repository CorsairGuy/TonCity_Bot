'use strict';
// Контракты и права сверены с championships-* клиента TON City 2.5 (build 14184).
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function identifier(value,label='ID'){
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
  if(typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value))return value;
  fail(`${label}: неверное значение`);
}
function overview(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.squads))fail('Игра вернула неизвестный формат чемпионатов',502);
  if(value.viewer!=null&&(!Array.isArray(value.viewer.applied_squad_ids)||value.viewer.user_id==null))fail('Неизвестный формат участника чемпионатов',502);
  return value;
}
function command(data,input){
  overview(data);
  const v=data.viewer,c=data.config;
  if(!v)fail('Для участия нужна гильдия',403);
  const action=input.action;
  const configKeys=['min_squad_size','max_squad_size','name_min_length','name_max_length'];
  if(!c||configKeys.some(k=>!Number.isInteger(c[k])||c[k]<1)||c.min_squad_size>c.max_squad_size||c.name_min_length>c.name_max_length)fail('Не получены правила текущего сезона',503);
  const name=()=>{if(typeof input.name!=='string')fail('Введите название отряда');const n=input.name.trim().replace(/\s+/g,' ');if(n.length<c.name_min_length||n.length>c.name_max_length)fail(`Название: от ${c.name_min_length} до ${c.name_max_length} символов`);return n;};
  if(action==='create'){
    if(v.squad_id!=null)fail('Вы уже состоите в отряде',403);
    return{path:'/championships/squads',body:{name:name()}};
  }
  const allowed=['rename','apply','withdrawApplication','accept','decline','kick','move','leave','leader','disband','submit','recall','approve','reject','withdraw'];
  if(!allowed.includes(action))fail('Неизвестное действие');
  const sid=identifier(input.squadId,'Отряд'),s=data.squads.find(x=>same(x.id,sid));
  if(!s||!Array.isArray(s.members))fail('Отряд не найден — обновите данные',404);
  const leader=same(s.leader_id,v.user_id),mine=same(v.squad_id,s.id),admin=v.is_guild_admin===true;
  const forming=s.status==='forming',submitted=s.status==='submitted',fielded=s.status==='fielded';
  const room=s.members.length<c.max_squad_size,applied=v.applied_squad_ids.some(id=>same(id,s.id));
  const requireRight=(ok,message='Действие недоступно для ваших прав или состояния отряда')=>{if(!ok)fail(message,403);};
  const base=`/championships/squads/${encodeURIComponent(sid)}`;
  let body={},suffix=action;
  if(action==='apply')requireRight(v.squad_id==null&&forming&&room&&!applied);
  else if(action==='withdrawApplication'){requireRight(applied);suffix='withdraw-application';}
  else if(action==='rename'){requireRight(leader&&forming);body={name:name()};}
  else if(action==='leave')requireRight(mine&&!leader&&(forming||submitted));
  else if(action==='disband')requireRight(leader&&(forming||submitted));
  else if(action==='submit')requireRight(leader&&forming&&s.members.length>=c.min_squad_size&&s.members.length<=c.max_squad_size);
  else if(action==='recall')requireRight(leader&&submitted);
  else if(action==='approve')requireRight(admin&&submitted&&s.members.length>=c.min_squad_size&&s.members.length<=c.max_squad_size);
  else if(action==='reject')requireRight(admin&&submitted);
  else if(action==='withdraw')requireRight(admin&&fielded);
  else{
    const uid=identifier(input.memberId,'Участник');
    const member=s.members.find(x=>same(x.user_id,uid));
    if(action==='accept'||action==='decline'){
      requireRight(leader&&Array.isArray(s.applications)&&s.applications.some(x=>same(x.user_id,uid))&&(action==='decline'||forming&&room));
      suffix=`applications/${encodeURIComponent(uid)}/${action}`;
    }else if(action==='leader'){
      requireRight(leader&&forming&&member&&!same(uid,s.leader_id));body={user_id:member.user_id};
    }else if(action==='kick'){
      requireRight(leader&&forming&&member&&!same(uid,s.leader_id));suffix=`members/${encodeURIComponent(uid)}/kick`;
    }else if(action==='move'){
      const targetId=identifier(input.toSquadId,'Другой отряд'),target=data.squads.find(x=>same(x.id,targetId));
      requireRight(admin&&forming&&member&&!same(uid,s.leader_id)&&target&&!same(target.id,s.id)&&target.status==='forming'&&Array.isArray(target.members)&&target.members.length<c.max_squad_size);
      suffix=`members/${encodeURIComponent(uid)}/move`;body={to_squad_id:target.id};
    }
  }
  return{path:`${base}/${suffix}`,body};
}
module.exports={identifier,overview,command};
