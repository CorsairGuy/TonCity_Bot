'use strict';
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep}=require('../utils/helpers');
const {BuilderSnapshot}=require('../db/index');
async function runBuilders(api,name){
  try{
    const[d,prog]=await Promise.all([api.get('/builders/'),api.get('/progress/')]);
    try{
      const max_builders=d?.max_builders??null,max_coins=d?.max_coins??0,max_stars=d?.max_stars??0,cnt_coins=d?.cnt_coins??0,cnt_stars=d?.cnt_stars??0;
      const count=(max_builders??0)-max_coins-max_stars+cnt_coins+cnt_stars;
      await BuilderSnapshot.upsert({account:name,count,price_coins:d?.coins??null,price_stars:d?.stars??null,max_builders,cnt_coins,max_coins,cnt_stars,max_stars,updated_at:new Date()},{conflictFields:['account']});
    }catch(_){}
    const cc=d?.coins,sc=d?.stars,c=Number(prog?.progress?.data?.coins||0),cr=Number(prog?.progress?.data?.crystals||0);
    if(cc&&c>0&&(cc/c*100)<33){await globalLock.run(async()=>{await sleep(300);await api.post('/builders/purchase',{type:'coins'});logger.info(`[${name}] [builder] bought (coins)`);});}
    else if(sc&&cr>0&&(sc/cr*100)<33){await globalLock.run(async()=>{await sleep(300);await api.post('/builders/purchase',{type:'stars'});logger.info(`[${name}] [builder] bought (crystals)`);});}
    else{logger.info(`[${name}] [builder]: too expensive`);}
  }catch(e){logger.error(`[${name}] [builder]: ${e.message}`);}
}
module.exports={runBuilders};
