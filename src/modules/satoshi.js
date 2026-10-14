'use strict';
const {SatoshiPosition,SatoshiPositionHistory}=require('../db/index');
const logger=require('../utils/logger');
const satoshiEvents=require('../utils/satoshiEvents');

// Открытие/закрытие позиции возвращает new_balance ПРЯМО в ответе (см. reverse стора "trading":
// t.setCrystals(A.new_balance)) — не нужен отдельный запрос за балансом, просто пишем в БД.
async function applyBalance(accountId,newBalance){
  if(newBalance==null)return;
  try{const{Account}=require('../db/index');await Account.update({crystals:String(newBalance)},{where:{id:accountId}});}
  catch(e){logger.warn(`[satoshi] balance update: ${e.message}`);}
}

// Башня Сатоши: трейдинг GRAM/USDT с плечом за кристаллы. Эндпоинты подтверждены реверсом
// клиента (chunks/satoshi_tower-*, стор "trading" в entry.js): GET /satoshi-tower/positions
// отдаёт ОДНИМ запросом {open,history,history_cursor,history_has_more,mark_price} — синкаем
// открытые (полная замена набора) и закрытые (копим бессрочно по id, без дублей).
async function runSatoshi(api,name){
  try{
    const data=await api.get('/satoshi-tower/positions').catch(()=>null);
    if(!data)return;
    const open=data.open||[];
    const history=data.history||[];

    const openIds=open.map(p=>p.id);
    const{Op}=require('sequelize');
    await SatoshiPosition.destroy({where:{account:name,id:{[Op.notIn]:openIds.length?openIds:['__none__']}}});
    for(const p of open){
      const payload={
        account:name,side:p.side,leverage:p.leverage??null,margin:p.margin??null,notional:p.notional??null,
        entry_price:p.entry_price??null,liquidation_price:p.liquidation_price??null,
        // игровой TP/SL (обновление 31.07.2026) — задаётся при открытии, потом только читается
        game_tp_price:p.take_profit_price??null,game_sl_price:p.stop_loss_price??null,
        opened_at:p.opened_at?new Date(p.opened_at):null,updated_at:new Date(),
      };
      const[row,created]=await SatoshiPosition.findOrCreate({where:{id:p.id},defaults:{id:p.id,...payload}});
      if(!created)await row.update(payload);
    }
    for(const p of history){
      const payload={
        account:name,side:p.side,leverage:p.leverage??null,margin:p.margin??null,notional:p.notional??null,
        entry_price:p.entry_price??null,close_price:p.close_price??null,liquidation_price:p.liquidation_price??null,
        realized_pnl:p.realized_pnl??null,fee:p.fee??null,payout:p.payout??null,status:p.status??null,
        opened_at:p.opened_at?new Date(p.opened_at):null,closed_at:p.closed_at?new Date(p.closed_at):null,
      };
      const[row,created]=await SatoshiPositionHistory.findOrCreate({where:{id:p.id},defaults:{id:p.id,...payload}});
      if(!created)await row.update(payload);
    }
    logger.info(`[${name}] [satoshi] синхронизировано (открыто ${open.length}, закрыто ${history.length})`);
    satoshiEvents.positionsChanged(name); // страница обновится сама, без ручного "Обновить"
  }catch(e){
    if(e?.noBuilding)return;
    logger.warn(`[${name}] [satoshi]: ${e.message}`);
  }
}
module.exports={runSatoshi,applyBalance};
