'use strict';
// Допуск определяется личным ответом игры, а не снимком лидера.
async function inspect(api,guildId,campaignId){
  const membership=await api.get('/users/me/guild');
  if(String(membership?.guild?.id??'')!==String(guildId))return{eligible:false,reason:'Аккаунт не состоит в этой гильдии'};
  const overview=await api.get('/guild-campaigns/overview');
  if(!Array.isArray(overview?.active))throw new Error('Игра не вернула список активных кампаний');
  const campaign=overview.active.find(c=>String(c.id)===String(campaignId));
  if(!campaign)return{eligible:false,reason:'Кампания недоступна этому аккаунту'};
  const side=campaign.my_side==='attacker'?campaign.attacker:campaign.my_side==='defender'?campaign.defender:null;
  if(String(side?.guild_id??'')!==String(guildId))return{eligible:false,reason:'Гильдия кампании не совпадает'};
  if(campaign.my_deployed===true)return{eligible:false,deployed:true,reason:'Уже в кампании'};
  if(campaign.can_deploy!==true)return{eligible:false,reason:'Игра не разрешает участие: проверьте срок членства, занятость и наличие мест'};
  return{eligible:true};
}
async function deploy(api,guildId,campaignId){
  const before=await inspect(api,guildId,campaignId);
  if(!before.eligible)return{ok:false,...before};
  let error;
  try{await api.post('/guild-campaigns/deploy',{campaign_id:campaignId});}catch(e){error=e;}
  try{
    const after=await inspect(api,guildId,campaignId);
    if(after.deployed)return{ok:true};
    return{ok:false,reason:error?.message||'Игра не подтвердила участие'};
  }catch(e){return{ok:false,reason:'Результат неизвестен: не удалось обновить состояние. Проверьте кампанию перед повтором'};}
}
module.exports={inspect,deploy};
