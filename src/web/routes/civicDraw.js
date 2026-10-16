'use strict';
const logger=require('../../utils/logger');

// Городской розыгрыш (civic_draw) — часть ответа /progress/diversity, которую собирает
// modules/townhall.js в отдельную таблицу civic_draw_status (страница "Разнообразие" не трогается).
// Claim выполняется через уже существующий POST /api/policies/:accountId/action {action:'civic-draw-claim'}
// (эндпоинт /policies/civic-draw/claim подтверждён реверсом chunks/townhall-*).
module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  app.get('/api/civic-draw',async(req,res)=>{
    try{
      const{Account,CivicDrawStatus}=require('../../db/index');
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const rows=await CivicDrawStatus.findAll({order:[['account','ASC']]});
      const accounts=rows
        .filter(r=>accIdByName[r.account]!=null)
        .map(r=>({
          account_id:accIdByName[r.account],
          account:r.account,
          draws_per_day:r.draws_per_day,
          draws_ready:r.draws_ready,
          draw_progress:r.draw_progress,
          claimable:!!r.claimable,
          odds:(()=>{try{return JSON.parse(r.odds||'[]');}catch(_){return [];}})(),
          ready_at:r.ready_at,
          updated_at:r.updated_at,
        }));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  // ready_at — линейный прогноз, посчитанный и сохранённый modules/townhall.js на каждом синке
  // (с защитой от сдвига назад между снимками, см. его комментарий). Используем как есть для отбора
  // кандидатов; сама попытка claim всё равно защищена live-перепроверкой перед отправкой (см. ниже).
  function isLiveReady(r){
    return !!r.claimable||(r.draws_ready??0)>0||(r.ready_at!=null&&new Date(r.ready_at).getTime()<=Date.now());
  }

  // Прогноз ready_at — линейный, но не идеально точный (сырой прогресс между снимками иногда чуть
  // колеблется, см. townhall.js), поэтому перед РЕАЛЬНЫМ claim всё равно перепроверяем актуальный
  // claimable живым запросом — чтобы не слать заведомо обречённый запрос, если прогноз чуть соврал.
  async function fetchLiveClaimable(api){
    const diversity=await api.get('/progress/diversity').catch(()=>null);
    return diversity?.civic_draw?.claimable===true;
  }

  // сбор награды сразу со всех аккаунтов, у которых по live-оценке уже готов розыгрыш
  app.post('/api/civic-draw/claim-all',async(req,res)=>{
    try{
      const{Account,CivicDrawStatus}=require('../../db/index');
      const all=await CivicDrawStatus.findAll();
      const rows=all.filter(isLiveReady);
      const accs=await Account.findAll({where:{name:rows.map(r=>r.account)},attributes:['id','name','access_token']});
      const eligible=accs.filter(a=>a.access_token);
      const results=await Promise.allSettled(eligible.map(async acc=>{
        const api=await makeApiForAccount(acc.id,{noLock:true});
        const{runTownhall,withClaimLock}=require('../../modules/townhall');
        // под тем же замком, что и автосбор (modules/civicDrawAuto.js) — без двойного claim
        return withClaimLock(acc.name,async()=>{
          if(!await fetchLiveClaimable(api)){
            // оценка на странице устарела/ошиблась — не шлём обречённый claim, а сразу освежаем
            // снимок в БД, чтобы следующая попытка (или бейдж "готово: N") уже был точным
            await runTownhall(api,acc.name).catch(()=>{});
            return{account:acc.name,ok:false,error:'Розыгрыш ещё не готов по факту в игре (оценка на странице устарела) — снимок обновлён',notReady:true};
          }
          try{return{account:acc.name,ok:true,result:await api.post('/policies/civic-draw/claim',{})};}
          finally{await runTownhall(api,acc.name).catch(()=>{});}
        });
      }));
      const mapped=results.map((r,i)=>r.status==='fulfilled'?r.value:{account:eligible[i].name,ok:false,error:r.reason?.message||String(r.reason)});
      // notReady — ожидаемый исход (live-перепроверка поймала устаревшую оценку до отправки claim),
      // не варнинг; логируем только реальные сбои (сетевые ошибки, отказ игры и т.п.)
      for(const m of mapped)if(!m.ok&&!m.notReady)logger.warn(`[civic-draw] claim-all: ${m.account}: ${m.error}`);
      const ok=mapped.filter(m=>m.ok).length;
      res.json({ok:true,results:mapped,succeeded:ok,total:mapped.length});
    }catch(e){
      logger.warn(`[civic-draw] claim-all: ${e.message}`);
      res.status(500).json({ok:false,error:e.message});
    }
  });
};
