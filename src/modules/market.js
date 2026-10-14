'use strict';
const {getConfig}=require('../config');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
async function runMarket(api,name){
  const cfg=getConfig();
  if(!cfg.sellItems)return;
  try{
    const defs=cfg.sellItems.split(',').map(s=>{const p=s.trim().split(':');return{n:p[0]?.trim(),price:parseInt(p[1]||0),qty:parseInt(p[2]||1)};}).filter(d=>d.n&&d.price>0);
    const all=(await api.get('/storage/allitemdata'))?.items||[];
    const lims=(await api.get('/market/user/listing-rules'))?.rules||[]; // building-gated: без Рынка бросит noBuilding
    for(const def of defs){
      const item=all.find(i=>(i.name||'').toLowerCase().includes(def.n.toLowerCase()));
      if(!item)continue;
      const free=Math.max(0,(item.quantity||0)-(item.soulbound||0));
      if(free<=0)continue;
      const lim=lims.find(l=>l.item_id==item.id);
      if(!lim?.can_list||lim?.market_id==null)continue;
      for(let i=0;i<Math.min(def.qty,free);i++){
        await globalLock.run(async()=>{await sleep(1500);const r=await api.post('/market/direct',{market_id:lim.market_id,price:def.price,currency:'crystals',anonymous_sale:true});if(r?.success)logger.info(`[${name}] Listed ${def.n} for ${def.price} crystals`);});
        await sleep(2000);
      }
    }
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [market] нет Центрального рынка — пропуск`);return;}
    logger.error(`[${name}] [market]: ${e.message}`);
  }
}
module.exports={runMarket};
