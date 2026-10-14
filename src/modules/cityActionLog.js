'use strict';
const {CityActionLog}=require('../db/index');
const logger=require('../utils/logger');

// Лог действий по городу (страница "Карта города" → вкладка "Лог") — маленький переиспользуемый
// хелпер, вызывается из modules/progress.js (апгрейд/реконструкция по плану) и web/routes/
// cityStrategy.js (разовые build/move/demolish/reconstruct/renovate/booster_activate). Намеренно
// НЕ падает наружу при ошибке записи — лог вспомогательный, не должен ронять реальное действие.
async function logAction(account,type,fields={}){
  try{
    return await CityActionLog.create({account,type,created_at:new Date(),...fields});
  }catch(e){logger.warn(`[${account}] [city-action-log] ${type}: ${e.message}`);return null;}
}

// Уточнить уже записанную строку (напр. проставить ФАКТИЧЕСКУЮ длительность стройки, когда игра
// отдала её end). Тоже не бросает наружу: лог вспомогательный.
async function updateAction(row,fields={}){
  if(!row)return;
  try{await row.update(fields);}
  catch(e){logger.warn(`[city-action-log] update: ${e.message}`);}
}

module.exports={logAction,updateAction};
