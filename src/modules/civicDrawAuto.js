'use strict';
// Автосбор городского розыгрыша (Мэрия → «Городской розыгрыш»).
//
// Игра копит розыгрыши до max_draws (3), дальше прогресс стоит. Точного времени готовности в ответе
// нет — только скорость draws_per_day и текущий draw_progress, поэтому цикл живёт «будильником»:
//   1. спит до прогноза ready_at (+MARGIN) — по снимку из БД, без запросов к игре;
//   2. проснулся → один GET /progress/diversity; claim шлём ТОЛЬКО при живом claimable:true;
//   3. игра ещё не готова → пересчёт по свежему прогрессу, но не раньше MIN_RETRY, а при повторных
//      промахах пауза растёт (15 → 30 → 60 … мин, потолок MAX_RETRY);
//   4. сон никогда не дольше, чем до заполнения max_draws минус CAP_GUARD — накопление не теряем.
// Свежий снимок, записанный кем угодно (панель, дневной проход политик), будит цикл через
// cityWake (`civic:${name}`): будильник пересчитывается без лишнего запроса.
// Claim — мутация: не повторяется никогда, итог проверяем перечитыванием состояния.
const logger=require('../utils/logger');
const {getConfig}=require('../config');
const {waitOrWake}=require('../utils/cityWake');
const accountLoops=require('../utils/accountLoops');
const {fetchCivicDraw,withClaimLock}=require('./townhall');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR;
const MARGIN=10*MIN;      // запас после прогноза: опоздание ничего не стоит, ранний claim — отказ
const MIN_RETRY=15*MIN;   // пауза после «ещё не готово»
const MAX_RETRY=3*HOUR;   // потолок нарастающей паузы
const CAP_GUARD=6*HOUR;   // проснуться не позже чем за 6 ч до заполнения max_draws
const OFF_POLL=10*MIN;    // при выключенной галочке — только локальная проверка настроек
const ERR_RETRY=30*MIN;   // игра не ответила / техработы

function enabled(){return getConfig().features?.civicDraw!==false;}

// сколько мс до заполнения max_draws по снимку (null — посчитать нельзя)
function msToCap(row,now){
  const rate=Number(row.draws_per_day)||0,max=Number(row.max_draws)||0;
  if(rate<=0||max<=0)return null;
  const units=(row.draws_ready??0)+(row.draw_progress??0);
  const since=row.updated_at?now-new Date(row.updated_at).getTime():0;
  return Math.max(0,(max-units)/rate*DAY-since);
}

// когда проверять по снимку: 0 — уже пора (живой claimable или наступивший прогноз)
function plan(row,misses,now){
  if(!row)return 0;
  let wait;
  if(row.claimable)wait=0;
  else if(row.ready_at)wait=Math.max(0,new Date(row.ready_at).getTime()+MARGIN-now);
  else wait=DAY;            // скорости нет (розыгрыш не открыт) — раз в сутки
  const backoff=misses>0?Math.min(MIN_RETRY*2**(misses-1),MAX_RETRY):0;
  wait=Math.max(wait,backoff);
  // близко к потолку — проверяем раньше прогноза, но после промахов не чаще нарастающей паузы
  // (иначе застрявший на 3/3 аккаунт опрашивался бы каждые 15 минут)
  const cap=msToCap(row,now);
  if(cap!=null)wait=Math.min(wait,Math.max(cap-CAP_GUARD,backoff));
  return Math.min(wait,DAY);
}

// забрать всё готовое: claim → перечитать → пока игра говорит claimable (не больше max_draws раз).
// Возвращает {got, cd} — сколько собрано и последнее известное состояние.
async function claimReady(api,name,cd){
  let got=0;
  const limit=Math.max(1,Number(cd.max_draws)||3);
  for(let i=0;i<limit&&cd?.claimable===true;i++){
    let res=null,err=null;
    try{res=await api.post('/policies/civic-draw/claim',{});}catch(e){err=e;}
    const before=cd;
    cd=await fetchCivicDraw(api,name).catch(()=>null);
    if(err){
      // вердикт по состоянию, а не по коду ответа: игра могла выдать награду и ответить ошибкой
      const consumed=cd&&(cd.draws_ready??0)<(before.draws_ready??0);
      logger.warn(`[${name}] [civic-draw] claim: ${err.message}${consumed?' — но розыгрыш списан, считаем собранным':''}`);
      if(!consumed)break;
      got++;
    }else{
      got++;
      const shards=Object.entries({...res?.shards}).filter(([,v])=>v).map(([k,v])=>`${k}×${v}`);
      const qm=Object.entries({...res?.quartermaster_shards}).filter(([,v])=>v).map(([k,v])=>`${k}×${v}`);
      logger.info(`[${name}] [civic-draw] награда собрана${shards.length?`, осколки: ${shards.join(', ')}`:''}${qm.length?`, квартирмейстер: ${qm.join(', ')}`:''}`);
    }
    if(!cd)break;
  }
  return{got,cd};
}

async function runCivicDrawLoop(api,name,accountId){
  const{CivicDrawStatus}=require('../db/index');
  const key=`civic:${name}`;
  let misses=0;
  logger.info(`[${name}] [civic-draw] автосбор запущен`);
  while(true){
    if(accountLoops.isStopped(accountId)){logger.info(`[${name}] [civic-draw] аккаунт удалён, останавливаюсь`);return;}
    if(!enabled()){await waitOrWake(key,OFF_POLL);continue;}
    try{
      const row=await CivicDrawStatus.findOne({where:{account:name}});
      const wait=plan(row,misses,Date.now());
      if(wait>0){
        // разбудили свежим снимком (claimable/новый прогноз) — пересчитываем план без запроса
        await waitOrWake(key,wait);
        if(!enabled())continue;
        const fresh=await CivicDrawStatus.findOne({where:{account:name}});
        if(plan(fresh,misses,Date.now())>0)continue;
      }
      const r=await withClaimLock(name,async()=>{
        const live=await fetchCivicDraw(api,name);
        if(live?.claimable!==true)return{got:0,cd:live};
        return claimReady(api,name,live);
      });
      // розыгрыша у аккаунта нет (не открыт) — снимок не обновился, ждём сутки или свежий снимок
      if(!r.cd&&!r.got){misses=0;await waitOrWake(key,DAY);continue;}
      if(r.got>0&&r.cd?.claimable!==true)misses=0;
      else{
        // проверяли по прогнозу, а забрать нечего (прогноз соврал) или claim отказал —
        // следующая проверка с нарастающей паузой, не долбим игру
        misses++;
        logger.info(`[${name}] [civic-draw] ${r.cd?.claimable===true?'claim не прошёл':'ещё не готов'}, повтор не раньше чем через ${Math.round(Math.min(MIN_RETRY*2**(misses-1),MAX_RETRY)/MIN)} мин`);
      }
    }catch(e){
      if(e?.cause?.response?.status===401||e?.message?.includes('status 401')){logger.error(`[${name}] [civic-draw] auth failed, останавливаюсь`);return;}
      logger.warn(`[${name}] [civic-draw] ${e.message} — повтор через ${ERR_RETRY/MIN} мин`);
      await waitOrWake(key,ERR_RETRY);
    }
  }
}

module.exports={runCivicDrawLoop,plan};
