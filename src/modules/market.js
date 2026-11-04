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
      // 2.5: один лот на N штук (quantity ≤ max_quantity правила) и обязательный listing_days (как клиент игры, дефолт 3).
      // Лот одним запросом: изменяющий запрос не повторяется, обрыв не превращается в дубль.
      const qty=Math.max(1,Math.min(def.qty,free,lim.max_quantity??free));
      await globalLock.run(async()=>{await sleep(1500);const r=await api.post('/market/direct',{market_id:lim.market_id,price:def.price,currency:'crystals',anonymous_sale:true,listing_days:3,quantity:qty});if(r?.success)logger.info(`[${name}] Выставлено ${def.n} ×${qty} за ${def.price} кристаллов`);});
      await sleep(2000);
    }
  }catch(e){
    if(e?.noBuilding){logger.info(`[${name}] [market] нет Центрального рынка — пропуск`);return;}
    logger.error(`[${name}] [market]: ${e.message}`);
  }
}
module.exports={runMarket};
