'use strict';
// Один контракт для очереди и панели, включая сохранённые снимки до TON City 2.5.
// Явный null в новой форме важнее оставшихся legacy-полей: лимита больше нет.
function techFactoryLimit(tier){
  if(tier?.limit===null)return null;
  const nested=tier&&Object.prototype.hasOwnProperty.call(tier,'limit');
  const source=nested?tier.limit:{used:tier?.used,count:tier?.limit_count,window:tier?.limit_window};
  if(!nested&&source.count==null)return null;
  const count=source?.count==null?NaN:Number(source.count),used=Number(source?.used??0);
  // Неизвестный/повреждённый явный лимит не разрешает расходовать ресурсы.
  if(!Number.isFinite(count)||count<0||!Number.isFinite(used)||used<0)return{used:0,count:0,window:null};
  return{used,count,window:typeof source.window==='string'?source.window:null};
}
function normalizeTechFactoryTier(tier){
  const limit=techFactoryLimit(tier);
  return{...tier,limit,limit_available:limit===null||limit.used<limit.count};
}
function normalizeTechFactoryCategories(categories){
  return(Array.isArray(categories)?categories:[]).map(c=>({...c,machines:(Array.isArray(c.machines)?c.machines:[]).map(m=>({...m,tiers:(Array.isArray(m.tiers)?m.tiers:[]).map(normalizeTechFactoryTier)}))}));
}
module.exports={techFactoryLimit,normalizeTechFactoryTier,normalizeTechFactoryCategories};
