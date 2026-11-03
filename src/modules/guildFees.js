'use strict';
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
function feeState(fees,now=Date.now()){
  const current=fees?.current,me=fees?.me,currency=current?.terms?.currency;
  const required=Number(me?.required),deposited=Number(me?.deposited),seconds=Number(current?.ends_in_seconds);
  const known=Number.isFinite(required)&&required>=0&&Number.isFinite(deposited)&&deposited>=0;
  const remaining=known?Math.max(0,Math.ceil(required-deposited)):null;
  const deadline=Number.isFinite(seconds)&&seconds>=0?now+seconds*1000:null;
  const payable=me?.status==='due'&&remaining>0&&deadline>now&&['coins','crystals'].includes(currency);
  return{fees,remaining,currency:currency??null,deadline,payable};
}
async function readGuildFees(api){
  const membership=await api.get('/users/me/guild');
  const guild=membership?.guild;
  if(!guild?.id)throw failure('Аккаунт не состоит в гильдии',404);
  const fees=await api.get(`/guilds/${guild.id}/fees`);
  return{guild_id:String(guild.id),guild_title:guild.title||'',...feeState(fees)};
}
async function payGuildFees(api,expected){
  const state=await readGuildFees(api);
  if(!state.payable)throw failure('Нет доступного к оплате взноса — обновите состояние');
  if(String(expected?.expected_guild_id)!==state.guild_id||Number(expected?.expected_amount)!==state.remaining||expected?.expected_currency!==state.currency||!Number.isFinite(Number(expected?.expected_deadline))||Math.abs(Number(expected.expected_deadline)-state.deadline)>10000)throw failure('Взнос или период изменился — обновите и подтвердите оплату заново',409);
  const before=await api.get('/progress/');
  const balance=Number(before?.progress?.data?.[state.currency]);
  if(!Number.isFinite(balance)||balance<state.remaining)throw failure('Недостаточно средств для оплаты взноса');
  if(state.deadline<=Date.now())throw failure('Период взноса завершился — обновите состояние',409);
  let error=null;
  try{await api.post(`/guilds/${state.guild_id}/treasury/deposit`,{amount:state.remaining,currency:state.currency});}
  catch(e){error=e;}
  // После неоднозначного ответа не повторяем POST: сначала проверяем фактический долг.
  let fresh=null,progress=null,refreshError=null;
  try{fresh=await readGuildFees(api);}catch(e){refreshError=e.message;}
  try{progress=await api.get('/progress/');}catch(e){refreshError=refreshError||e.message;}
  if(error&&!(fresh&&fresh.guild_id===state.guild_id&&fresh.remaining===0))return{ok:false,error:error.message,...(fresh||{}),progress,refresh_error:refreshError};
  return{ok:true,...(fresh||{}),paid_amount:state.remaining,already:!!error,progress,refresh_error:refreshError};
}
module.exports={feeState,readGuildFees,payGuildFees};
