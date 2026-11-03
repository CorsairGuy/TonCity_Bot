'use strict';
// Для расходования подходят и привязанные предметы. marketable — только продажный остаток.
function cityResourceAmounts(items){
  if(!Array.isArray(items))throw new Error('Игра не вернула склад');
  const quantity=id=>items.filter(i=>String(i.id)===id).reduce((n,i)=>n+Math.max(0,Number(i.quantity)||0),0);
  return{components:quantity('13'),masterplans:quantity('12')};
}
async function syncCityResources(api,account){
  const data=await api.get('/storage/allitemdata');
  const amounts=cityResourceAmounts(data?.items);
  const{Inventory}=require('../db/index');
  for(const id of ['12','13']){
    const item=data.items.find(i=>String(i.id)===id),quantity=Math.max(0,Number(item?.quantity)||0),locked=Math.min(quantity,Math.max(0,Number(item?.soulbound)||0));
    const values={marketable:quantity-locked,locked};
    const[row,created]=await Inventory.findOrCreate({where:{account,name:id},defaults:{account,name:id,...values}});
    if(!created)await row.update(values);
  }
  return amounts;
}
module.exports={cityResourceAmounts,syncCityResources};
