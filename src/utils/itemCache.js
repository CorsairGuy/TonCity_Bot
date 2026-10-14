'use strict';
// Общий in-memory кэш данных предметов, заполняется ботом при запуске
// accId (число) → { listing_limits: [...], active_boosters: [...], ts: Date }
const _cache={};
function set(accId,data){_cache[String(accId)]=Object.assign({ts:new Date()},data);}
function get(accId){return _cache[String(accId)]||null;}
function getAll(){return _cache;}
module.exports={set,get,getAll};
