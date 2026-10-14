'use strict';
const logger=require('../utils/logger');
async function runTechFactory(api,name){
  try{
    // TODO: implement after game update
    logger.info(`[${name}] [techfactory] not yet available`);
  }catch(e){logger.error(`[${name}] [techfactory]: ${e.message}`);}
}
module.exports={runTechFactory};
