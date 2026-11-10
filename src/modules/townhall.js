'use strict';
const logger=require('../utils/logger');
const {TownhallAirdrop,TownhallDiversity,CivicDrawStatus}=require('../db/index');
const {wake}=require('../utils/cityWake');
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
    if(diversity?.civic_draw)await saveCivicDraw(name,diversity.civic_draw,now);
    logger.info(`[${name}] [townhall] score: ${airdrop?.allocation?Object.entries(airdrop.allocation).filter(([k,v])=>typeof v==='number'&&k!=='user_id').reduce((a,[,v])=>a+v,0).toFixed(2):'—'}, diversity: ${diversity?.score?.toFixed(1)||'—'}%`);
  }catch(e){logger.error(`[${name}] [townhall]: ${e.message}`);}
}
// Абсолютные сроки из ответа 2.5; null означает отсутствие точного таймера.
function exactReadyAt(seconds,now){
  const ms=now.getTime()+seconds*1000;
  return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0&&Number.isFinite(ms)&&Math.abs(ms)<=8640000000000000?new Date(ms):null;
}
function normalizeGrants(grants,now=new Date()){
  if(!Array.isArray(grants))return[];
  return grants.filter(g=>g&&['string','number'].includes(typeof g.def_id)).map(g=>({...g,
    ready:Number.isFinite(Number(g.ready))?Math.max(0,Number(g.ready)):0,amount:Number.isFinite(Number(g.amount))?Math.max(0,Number(g.amount)):0,
    ready_at:exactReadyAt(g.next_in_seconds,now)?.toISOString()??null}));
}
async function saveCivicDraw(name,cd,now=new Date()){
  const exact=exactReadyAt(cd.next_draw_in_seconds,now);
  const timerSource=exact?'server':'unknown';
  const readyAt=cd.claimable?now:exact;
  const grants=normalizeGrants(cd.grants,now);
  await CivicDrawStatus.upsert({account:name,draws_per_day:cd.draws_per_day??null,draws_ready:cd.draws_ready??null,
    draw_progress:cd.draw_progress??null,claimable:!!cd.claimable,odds:JSON.stringify(cd.odds||[]),
    max_draws:cd.max_draws??null,at_cap:!!cd.at_cap,ready_at:readyAt,timer_source:timerSource,
    grants:JSON.stringify(grants),updated_at:now},{conflictFields:['account']});
  wake(`civic:${name}`);
  require('../web/lib/panelEvents').emit('civic-draw',{account:name});
}

// Свежее состояние розыгрыша одним GET (без /airdrop/, который нужен только странице Мэрии).
// null — игра не ответила или розыгрыша у аккаунта нет.
async function fetchCivicDraw(api,name){
  const diversity=await api.get('/progress/diversity');
  if(!diversity?.civic_draw)return null;
  await saveCivicDraw(name,diversity.civic_draw);
  return diversity.civic_draw;
}

// Один claim на аккаунт за раз: автосбор и кнопки панели могли бы оба увидеть claimable:true и
// послать два claim подряд — второй игра отклонит.
const claimLocks=new Map();
async function withClaimLock(name,fn){
  while(claimLocks.has(name))await claimLocks.get(name).catch(()=>{});
  const p=Promise.resolve().then(fn);
  claimLocks.set(name,p);
  try{return await p;}finally{if(claimLocks.get(name)===p)claimLocks.delete(name);}
}
// Объединяем одновременные нажатия/автосбор одного grant, затем сериализуем с обычным розыгрышем.
const grantClaims=new Map();
function claimPolicyGrant(api,name,defId){
  if(!['string','number'].includes(typeof defId)||!String(defId).trim()||String(defId).length>128)
    return Promise.reject(new Error('Некорректная политика'));
  const key=JSON.stringify([name,String(defId)]);
  if(grantClaims.has(key))return grantClaims.get(key);
  const task=withClaimLock(name,async()=>{
    const cd=await fetchCivicDraw(api,name);
    const grant=cd?.grants?.find(g=>String(g.def_id)===String(defId)&&Number.isFinite(Number(g.ready))&&Number(g.ready)>0);
    if(!grant||!Number.isFinite(Number(grant.ready))||!(Number(grant.ready)>0))return{ok:false,notReady:true,error:'Награда политики ещё не готова — снимок обновлён'};
    let result,error;
    try{result=await api.post('/policies/civic-draw/grants/claim',{def_id:grant.def_id});}
    catch(e){error=e;}
    // Ни ошибка, ни обрыв не повторяют POST: сначала выясняем состояние и обновляем склад.
    const after=await fetchCivicDraw(api,name).catch(()=>null);
    await require('./inventory').runInventory(api,name).catch(()=>{});
    if(error)return{ok:false,error:error.message||String(error),ambiguous:true,refreshed:!!after};
    return{ok:true,result,refreshed:!!after};
  }).finally(()=>{if(grantClaims.get(key)===task)grantClaims.delete(key);});
  grantClaims.set(key,task);return task;
}
// Одна операция для кнопок и автоматики. После каждого POST перечитываем серверные таймеры.
async function collectCivicRewards(api,name,{draws=true,grants=true}={}){
  return withClaimLock(name,async()=>{
    let cd=await fetchCivicDraw(api,name),got=0,drawCount=0,grantCount=0,error=null,ambiguous=false,attempted=false;
    const results=[];
    async function claim(path,body,kind){
      let result,failed;
      const before=cd;
      attempted=true;
      try{result=await api.post(path,body);}catch(e){failed=e;}
      const after=await fetchCivicDraw(api,name).catch(()=>null);
      cd=after;
      if(failed){
        ambiguous=true;error=failed.message||String(failed);
        const consumed=after&&(kind==='draw'
          ?Number(after.draws_ready)<Number(before.draws_ready)
          :Number(after.grants?.find(g=>String(g.def_id)===String(body.def_id))?.ready??0)<Number(before.grants?.find(g=>String(g.def_id)===String(body.def_id))?.ready??0));
        if(consumed){got++;if(kind==='draw')drawCount++;else grantCount++;}
        return false; // POST не повторяем даже после неизвестного ответа.
      }
      got++;if(kind==='draw')drawCount+=Math.max(1,Number(result?.draws_consumed)||1);else grantCount++;results.push({kind,result});
      if(!after){error='Награда получена, но новые таймеры не загрузились';return false;}
      return true;
    }
    try{
      if(draws)for(let i=0;i<Math.min(10,Math.max(1,Number(cd?.max_draws)||3))&&cd?.claimable===true;i++){
        if(!await claim('/policies/civic-draw/claim',{},'draw'))break;
      }
      if(grants&&!error){
        const ids=[...new Set((cd?.grants??[]).filter(g=>Number(g.ready)>0).map(g=>g.def_id))];
        for(const def_id of ids){
          if(!cd?.grants?.some(g=>String(g.def_id)===String(def_id)&&Number(g.ready)>0))continue;
          if(!await claim('/policies/civic-draw/grants/claim',{def_id},'grant'))break;
        }
      }
    }finally{
      if(attempted)await require('./inventory').runInventory(api,name).catch(e=>logger.warn(`[${name}] [civic-draw] склад: ${e.message}`));
    }
    return{ok:got>0&&!error,got,draws:drawCount,grants:grantCount,notReady:!got&&!error,ambiguous,refreshed:!!cd,error:error||(!got?'Награды ещё не готовы — состояние обновлено':undefined),result:results.find(r=>r.kind==='draw')?.result,cd};
  });
}
module.exports={collectCivicRewards,runTownhall,saveCivicDraw,fetchCivicDraw,withClaimLock,claimPolicyGrant,normalizeGrants,exactReadyAt};
