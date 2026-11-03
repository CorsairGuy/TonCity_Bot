'use strict';
// Категория+редкость не определяют предмет: ключ43 и камень38 оба consumable/mythic.
function matchesAutobuyItem(offer,rule){
  if(rule.item_id==null||rule.item_id==='')return true;
  const id=Number(rule.item_id);
  return Number.isSafeInteger(id)&&id>=0&&offer?.item_id!=null&&Number(offer.item_id)===id;
}
async function verifyAutobuyItem(api,offerId,rule,maxPrice){
  if(rule.item_id==null||rule.item_id==='')return;
  const data=await api.get(`/market/direct/${offerId}`),offer=data?.offer||data;
  if(!matchesAutobuyItem(offer,rule))throw new Error('Предмет лота изменился или не совпадает с правилом');
  const price=Number(offer.display_price);
  if(!Number.isFinite(price)||price<0||price>Number(maxPrice))throw new Error('Цена лота изменилась или недоступна');
  if(offer.listing_currency!==rule.currency||offer.status!=='active'||offer.your_offer===true||offer.can_buy===false)throw new Error('Лот больше не доступен для этого правила');
}
module.exports={matchesAutobuyItem,verifyAutobuyItem};
