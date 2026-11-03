'use strict';
// TON City 2.5: расчёт AddMarginDialog. Плечо не опускается ниже1x,
// поддерживающая маржа max(0.5% маржи,0.5) совпадает с текущим клиентом игры.
function previewMargin(position,balance,amount=0){
  const margin=Number(position?.margin),notional=Number(position?.notional),entry=Number(position?.entry_price),crystals=Number(balance),add=Number(amount);
  if(![margin,notional,entry,crystals,add].every(Number.isFinite)||margin<=0||notional<=0||entry<=0||crystals<0||!['long','short'].includes(position?.side))throw new Error('Не удалось проверить позицию и баланс');
  const maxAmount=Math.max(0,Math.min(Math.floor(crystals),Math.floor(notional-margin)));
  if(!Number.isSafeInteger(add)||add<0||add>maxAmount)throw new Error(`Допустимая сумма: от 1 до ${maxAmount} кристаллов`);
  const newMargin=margin+add,ratio=(newMargin-Math.max(newMargin*.005,.5))/notional;
  return{balance:crystals,maxAmount,amount:add,margin,new_margin:newMargin,effective_leverage:notional/newMargin,liquidation_price:entry*(position.side==='short'?1+ratio:1-ratio)};
}
async function readMargin(api,positionId,amount=0){
  const [positions,progress]=await Promise.all([api.get('/satoshi-tower/positions'),api.get('/progress/')]);
  if(!Array.isArray(positions?.open))throw new Error('Игра не вернула открытые позиции');
  const position=positions.open.find(p=>String(p.id)===String(positionId));
  if(!position)throw new Error('Открытая позиция этого аккаунта не найдена');
  return{position,...previewMargin(position,progress?.crystals,amount)};
}
// Сохраняем сумму TP/SL, заданную в процентах: увеличение маржи не должно
// незаметно увеличивать допустимый денежный убыток. Ценовые уровни не меняются.
function preservedMarginTriggers(row,newMargin){
  const old=Number(row?.margin),next=Number(newMargin);const out={};
  if(!(old>0)||!(next>0)||!Number.isFinite(old)||!Number.isFinite(next))return out;
  for(const key of ['tp_pnl_pct','sl_pnl_pct'])if(row[key]!=null&&Number.isFinite(Number(row[key])))out[key]=Number(row[key])*old/next;
  return out;
}
module.exports={previewMargin,readMargin,preservedMarginTriggers};
