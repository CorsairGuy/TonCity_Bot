'use strict';
// Гильдии своих аккаунтов по снимкам GuildSnapshot: [{guild_id,title,accounts:[{id,name,role}]}].
// Аккаунты внутри гильдии — лидер, затем офицеры: от их имени читаем и пишем.
async function guildAccounts(){
  const{Account,GuildSnapshot}=require('../../db/index');
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
  const rank=r=>r==='Leader'?0:/officer/i.test(r||'')?1:2;
  for(const g of map.values())g.accounts.sort((a,b)=>rank(a.role)-rank(b.role)||a.name.localeCompare(b.name));
  return[...map.values()].sort((a,b)=>a.title.localeCompare(b.title));
}
module.exports={guildAccounts};
