'use strict';
const {Op}=require('sequelize');
const {Inventory,Account}=require('../db/index');
const logger=require('../utils/logger');
const itemCache=require('../utils/itemCache');

// Синхронизация склада аккаунта в БД. Паки автоматически НЕ открываются —
// только вручную со страницы инвентаря (веб-эндпоинт /api/storage-live/.../open-pack).
// rethrow:true — ошибку синхронизации пробросить вызывающему (ручная кнопка должна её показать)
async function runInventory(api,name,{rethrow=false}={}){
  try{
    const all=await api.get('/storage/allitemdata');
    const items=all?.items||[];
    const presentIds=items.map(i=>String(i.id));
    // удаляем из БД предметы которых больше нет в инвентаре. Кроме ускорителей, которые сейчас
    // активны: последний экземпляр уходит со склада при активации, а строка нужна вкладке
    // «Ускорители» и циклу очереди, чтобы видеть активный тип. Запас у неё обнуляем, удалится
    // она на первой синхронизации после окончания.
    const gone={account:name,name:{[Op.notIn]:presentIds.length?presentIds:['__none__']}};
    const now=new Date();
    const stillActive={type:'booster',booster_active_until:{[Op.gt]:now}};
    // не через Op.not: NULL в type/booster_active_until дал бы NULL вместо «удалить»
    const notActive={[Op.or]:[{type:null},{type:{[Op.ne]:'booster'}},{booster_active_until:null},{booster_active_until:{[Op.lte]:now}}]};
    const deleted=await Inventory.destroy({where:{...gone,...notActive}});
    if(deleted)logger.info(`[${name}] [inventory] удалено ${deleted} устаревших записей`);
    await Inventory.update({marketable:0,locked:0},{where:{...gone,...stillActive}});
    for(const item of items){
      const qty=item.quantity||0,soul=item.soulbound||0,free=Math.max(0,qty-soul);
      const n=String(item.id);
      const extra={
        type:item.type??null,
        sell_price:item.sell_price??null,
        sell_currency:item.sell_currency??null,
        booster_active_limit:item.booster?.active_limit??null,
        booster_currently_active:item.booster?.currently_active??null,
      };
      const[inv,created]=await Inventory.findOrCreate({where:{account:name,name:n},defaults:{account:name,name:n,marketable:free,locked:soul,...extra}});
      if(!created)await inv.update({marketable:free,locked:soul,...extra});
    }
    logger.info(`[${name}] [inventory] синхронизировано (${items.length} предметов)`);

    // кэшируем правила листинга (только при наличии Рынка) и active-boosters для UI
    try{
      const acc=await Account.findOne({where:{name},attributes:['id','special_buildings']});
      if(acc){
        const hasMarket=String(acc.special_buildings||'').split(',').includes('market');
        // бусты не привязаны к зданию — тянем всегда; правила листинга — только с Рынком
        const activeResp=await api.get('/boosters/active').catch(()=>null);
        // правила комбинирования ({from_rarity,to_rarity,required_amount}) — статическая константа
        // игры, кэшируем в фоновой синхронизации, чтобы страница "Квесты" могла показать "нужно N,
        // есть M" и гасить кнопку "Комбинировать" БЕЗ живого запроса к игре при каждом открытии
        const combResp=await api.get('/boosters/combination-rules').catch(()=>null);
        let listingRules=[];
        if(hasMarket){
          const rulesResp=await api.get('/market/user/listing-rules').catch(()=>null); // {rules:[...]}
          listingRules=rulesResp?.rules||[];
        }
        itemCache.set(acc.id,{
          listing_limits:listingRules,
          active_boosters:Array.isArray(activeResp)?activeResp:[],
          combination_rules:Array.isArray(combResp)?combResp:(combResp?.rules||combResp?.combination_rules||[]),
        });
      }
    }catch(e){logger.warn(`[${name}] [inventory] itemCache: ${e.message}`);}
  }catch(e){logger.error(`[${name}] [inventory]: ${e.message}`);if(rethrow)throw e;}
}
module.exports={runInventory};
