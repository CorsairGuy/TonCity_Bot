'use strict';
const logger=require('../utils/logger');
const {TownhallAirdrop,TownhallDiversity,CivicDrawStatus}=require('../db/index');
async function runTownhall(api,name){
  try{
    const [airdrop,diversity]=await Promise.all([
      api.get('/airdrop/').catch(()=>null),
      api.get('/progress/diversity').catch(()=>null),
    ]);
    const now=new Date();
    if(airdrop?.allocation){
      const al=airdrop.allocation;
      await TownhallAirdrop.upsert({account:name,city:al.city??null,activity:al.activity??null,friends:al.friends??null,transactions:al.transactions??null,achievements:al.achievements??null,percentile:airdrop.percentile??null,updated_at:now},{conflictFields:['account']});
    }
    if(diversity?.score!=null){
      // "Бонус к доходу" пуст ("—" на странице), пока население города < 1,000,000 — эффект
      // разнообразия ещё не разблокирован игрой (подтверждено самой игрой, не баг), см.
      // reference_game_formulas.md. income_bonus придёт настоящим числом сам, как только откроется.
      await TownhallDiversity.upsert({account:name,score:diversity.score,variety_score:diversity.variety_score??null,profit_score:diversity.profit_score??null,unique_types:diversity.unique_types??null,total_buildings:diversity.total_buildings??null,income_bonus:diversity.income_bonus??null,updated_at:now},{conflictFields:['account']});
    }
    // Городской розыгрыш (civic_draw) — тот же ответ /progress/diversity, отдельная таблица.
    // ready_at — линейный прогноз "когда будет готов следующий розыгрыш" (абсолютное время),
    // считаем на КАЖДОМ синке из текущих draws_ready/draw_progress/draws_per_day. Сырой прогресс
    // между снимками иногда чуть колеблется (не идеально монотонен) — поэтому НЕ даём прогнозу
    // сдвигаться назад: берём максимум с уже сохранённым ready_at, кроме случая явного
    // подтверждения готовности прямо сейчас (тогда доверяем игре безусловно).
    if(diversity?.civic_draw){
      const cd=diversity.civic_draw;
      const baseUnits=(cd.draws_ready??0)+(cd.draw_progress??0);
      const rate=cd.draws_per_day??0;
      const readyNow=baseUnits>=1||!!cd.claimable;
      let readyAt=null;
      if(readyNow){
        readyAt=now;
      }else{
        const newReadyAt=rate>0?new Date(now.getTime()+((1-baseUnits)/rate)*86400000):null;
        const prev=await CivicDrawStatus.findOne({where:{account:name},attributes:['ready_at']});
        const prevReadyAt=prev?.ready_at?new Date(prev.ready_at):null;
        readyAt=newReadyAt&&prevReadyAt?new Date(Math.max(newReadyAt.getTime(),prevReadyAt.getTime())):(newReadyAt??prevReadyAt);
      }
      await CivicDrawStatus.upsert({account:name,draws_per_day:cd.draws_per_day??null,draws_ready:cd.draws_ready??null,draw_progress:cd.draw_progress??null,claimable:!!cd.claimable,odds:JSON.stringify(cd.odds||[]),ready_at:readyAt,updated_at:now},{conflictFields:['account']});
    }
    logger.info(`[${name}] [townhall] score: ${airdrop?.allocation?Object.entries(airdrop.allocation).filter(([k,v])=>typeof v==='number'&&k!=='user_id').reduce((a,[,v])=>a+v,0).toFixed(2):'—'}, diversity: ${diversity?.score?.toFixed(1)||'—'}%`);
  }catch(e){logger.error(`[${name}] [townhall]: ${e.message}`);}
}
module.exports={runTownhall};
