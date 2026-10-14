'use strict';
// Общие фабрики игрового API-клиента для аккаунта + формат ошибки МИД.
// Вынесено из server.js, чтобы группы роутов (routes/*.js) переиспользовали через ctx.
const ApiClient=require('../../api/client');

// Единая фабрика игрового API-клиента для аккаунта: ВСЕГДА ставит функцию рефреша
// сессии (на 401 клиент сам обновит токен через doRefresh и повторит запрос).
function apiForAcc(acc,{noLock=false}={}){
  const{doRefresh}=require('../../modules/session');
  if(!acc||!acc.access_token)throw new Error('Аккаунт не найден или нет токена');
  const c=new ApiClient(acc.access_token);
  c.setAccountId(acc.id);
  c.setRefreshFn(()=>doRefresh(c,acc));
  // building-gate: наличие зданий из БД (special_buildings) — чтобы веб не слал запрос без здания
  if(acc.special_buildings!==undefined&&acc.special_buildings!==null)require('../../utils/buildingReg').setForAccount(acc.id,acc.special_buildings);
  if(noLock)c.setNoLock(true);
  return c;
}
async function makeApiForAccount(accountId,{noLock=false}={}){
  const{Account}=require('../../db/index');
  const acc=await Account.findByPk(accountId);
  return apiForAcc(acc,{noLock});
}
// ошибку МИД всегда возвращаем строкой (иначе фронт получает объект → пустой флеш)
function midErr(e){
  const d=e?.response?.data;
  if(typeof d==='string')return d;
  if(d&&typeof d==='object')return d.error||d.message||JSON.stringify(d);
  return e?.message||'Ошибка';
}

module.exports={apiForAcc,makeApiForAccount,midErr};
