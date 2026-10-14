'use strict';
const {CityActionLog}=require('../db/index');
const logger=require('../utils/logger');

// Лог действий по городу (страница "Карта города" → вкладка "Лог") — маленький переиспользуемый
// хелпер, вызывается из modules/progress.js (апгрейд/реконструкция по плану) и web/routes/
// cityStrategy.js (разовые build/move/demolish/reconstruct/renovate/booster_activate). Намеренно
// НЕ падает наружу при ошибке записи — лог вспомогательный, не должен ронять реальное действие.
async function logAction(account,type,fields={}){
  try{
    await CityActionLog.create({account,type,created_at:new Date(),...fields});
  }catch(e){logger.warn(`[${account}] [city-action-log] ${type}: ${e.message}`);}
}

module.exports={logAction};
