'use strict';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function guildId(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)throw fail('Некорректный ID гильдии');return id;}
async function detail(api,value){
  const id=guildId(value);
  const[g,s,my,metrics,me]=await Promise.all([api.get(`/guilds/${id}`),api.get(`/guilds/management/${id}`),api.get('/users/me/guild'),api.get('/progress/metrics'),api.get('/users/me/')]);
  const uid=me?.id??me?.user?.id;
  const status=uid?(await api.get(`/guilds/management/${id}/status/${uid}`))?.status:null;
  return{guild:g?.guild??null,settings:s?.settings??null,membership:my?.guild??null,metrics,status};
}
function allowed(d){
  const s=d.settings,g=d.guild;
  if(!g||!s)return'Нет данных об условиях вступления';
  if(d.membership?.id)return'Аккаунт уже состоит в гильдии — сначала выйдите из неё';
  if(d.status==='pending')return'Заявка уже отправлена';
  if(!['open','application'].includes(s.guild_type))return'Гильдия закрыта для вступления';
  if(Number.isFinite(Number(s.member_capacity))&&s.member_capacity!=null&&Number(g.members_count)>=Number(s.member_capacity))return'В гильдии нет свободных мест';
  if(Number(d.metrics?.population??0)<Number(s.application_criteria_population??0)||Number(d.metrics?.profit??0)<Number(s.application_criteria_profit??0))return'Аккаунт не соответствует требованиям гильдии';
  return null;
}
async function joinGuild(api,value,expectedType){
  const id=guildId(value),before=await detail(api,id),reason=allowed(before);
  if(reason)throw fail(reason,409);
  if(before.settings.guild_type!==expectedType)throw fail('Условия вступления изменились — обновите и подтвердите заново',409);
  let result,error;
  try{result=await api.post('/guilds/join',{id});}catch(e){error=e;}
  let current,refresh_error;
  try{current=await detail(api,id);}catch(e){refresh_error=e.message;}
  const joined=String(current?.membership?.id??'')===String(id),pending=current?.status==='pending';
  return{ok:!error||joined||pending,error:error&&!joined&&!pending?error.message:undefined,status:joined?'joined':pending||result?.status==='application_submitted'?'application_submitted':result?.status??'joined',current,refresh_error};
}
module.exports={guildId,detail,allowed,joinGuild};
