'use strict';
// Ручные действия: актуальное членство проверяем перед единственным POST.
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function membership(api,expected){
  const data=await api.get('/users/me/guild'),guild=data?.guild;
  if(!guild?.id)throw fail('Аккаунт не состоит в гильдии',409);
  if(String(guild.id)!==String(expected))throw fail('Гильдия изменилась — обновите страницу и подтвердите действие заново',409);
  return guild;
}
async function leaveGuild(api,body){
  const guild=await membership(api,body.expected_guild_id);
  if(guild.role==='Leader'&&body.confirm_leader!==true)throw fail('Выход лидера может расформировать гильдию — требуется подтверждение',409);
  let error=null;
  try{await api.post('/guilds/leave',{});}catch(e){error=e;}
  let current,refreshError;
  try{current=await api.get('/users/me/guild');}catch(e){refreshError=e.message;}
  const left=current&&String(current.guild?.id??'')!==String(guild.id);
  return{ok:!error||!!left,error:error&&!left?error.message:undefined,membership:current,refresh_error:refreshError,already:!!error&&!!left};
}
async function depositGuild(api,body){
  const{currency,amount}=body;
  if(!['coins','crystals'].includes(currency)||typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<=0)throw fail('Укажите положительную целую сумму монет или алмазов');
  const guild=await membership(api,body.expected_guild_id);
  const progress=await api.get('/progress/'),balance=Number(progress?.progress?.data?.[currency]);
  if(!Number.isFinite(balance)||balance<amount)throw fail('Недостаточно средств для взноса');
  // Не повторяем платёж после таймаута: снимок баланса обновляет вызывающий маршрут.
  const result=await api.post(`/guilds/${guild.id}/treasury/deposit`,{amount,currency});
  return{ok:true,result,guild_id:String(guild.id)};
}
module.exports={leaveGuild,depositGuild};
