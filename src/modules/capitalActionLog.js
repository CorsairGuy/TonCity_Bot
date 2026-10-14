'use strict';
const {CapitalActionLog}=require('../db/index');
const logger=require('../utils/logger');

// Лог действий по столице (страница "Карта города" → тип столица → вкладка "Лог") — та же схема,
// что modules/cityActionLog.js, ключ guild_id вместо account.
async function logCapitalAction(guildId,type,fields={}){
  try{
    await CapitalActionLog.create({guild_id:guildId,type,created_at:new Date(),...fields});
  }catch(e){logger.warn(`[capital:${guildId}] [capital-action-log] ${type}: ${e.message}`);}
}

module.exports={logCapitalAction};
