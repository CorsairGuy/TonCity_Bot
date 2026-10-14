'use strict';
const logger=require('../utils/logger');
async function runAuditorium(api,name){
  try{
    // TODO: implement after game update
    logger.info(`[${name}] [auditorium] not yet available`);
  }catch(e){logger.error(`[${name}] [auditorium]: ${e.message}`);}
}
module.exports={runAuditorium};
