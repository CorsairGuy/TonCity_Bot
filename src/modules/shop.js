'use strict';
const logger=require('../utils/logger');
const {ShopSnapshot}=require('../db/index');
async function runShop(api,name){
  try{
    const [boosters,packs]=await Promise.all([
      api.get('/shop/offers/booster').catch(()=>null),
      api.get('/shop/offers/booster_pack').catch(()=>null),
    ]);
    const now=new Date();
    if(Array.isArray(boosters)){
      await ShopSnapshot.upsert({account:name,type:'booster',data:JSON.stringify(boosters),updated_at:now},{conflictFields:['account','type']});
    }
    if(Array.isArray(packs)){
      await ShopSnapshot.upsert({account:name,type:'booster_pack',data:JSON.stringify(packs),updated_at:now},{conflictFields:['account','type']});
    }
    logger.info(`[${name}] [shop] saved ${boosters?.length||0} boosters, ${packs?.length||0} packs`);
  }catch(e){logger.error(`[${name}] [shop]: ${e.message}`);}
}
module.exports={runShop};
