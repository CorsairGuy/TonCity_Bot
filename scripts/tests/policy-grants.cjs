'use strict';
// Исполняем реальные модули с подменой только I/O: БД, часы и игровой API.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
function moduleWith(file,dependencies){const module={exports:{}};const run=vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(path.join(root,file),'utf8')+'\n})',{Map,Set,Promise,Date,Number,Math,JSON,Error});run(name=>{assert(name in dependencies,'unexpected dependency '+name);return dependencies[name];},module,module.exports);return module.exports;}
const saved=[],events=[],wakes=[];let previous=null,inventory=0;
const db={CivicDrawStatus:{findOne:async()=>previous,upsert:async row=>{saved.push(row);previous=row;}},TownhallAirdrop:{},TownhallDiversity:{}};
const town=moduleWith('src/modules/townhall.js',{'../utils/logger':{info(){},warn(){},error(){}},'../db/index':db,'../utils/cityWake':{wake:k=>wakes.push(k)},'../web/lib/panelEvents':{emit:(...args)=>events.push(args)},'./inventory':{runInventory:async()=>{inventory++;}}});
(async()=>{
 const now=new Date('2026-11-03T00:00:00Z');
 previous={ready_at:new Date(now.getTime()+9999999),timer_source:'forecast'};
 await town.saveCivicDraw('A',{claimable:false,draws_ready:0,draw_progress:.2,draws_per_day:1,next_draw_in_seconds:30,grants:[{def_id:'daily',kind:'item',reward:43,amount:2,ready:0,next_in_seconds:10}]},now);
 let row=saved.at(-1);assert.equal(row.ready_at.getTime(),+now+30000);assert.equal(row.timer_source,'server');assert.equal(JSON.parse(row.grants)[0].ready_at,new Date(+now+10000).toISOString());assert.equal(events.at(-1)[0],'civic-draw');
 await town.saveCivicDraw('A',{claimable:false,draws_per_day:1,next_draw_in_seconds:5},now);assert.equal(saved.at(-1).ready_at.getTime(),+now+5000,'exact timer must move earlier');
 previous={ready_at:new Date(+now+90000000),timer_source:'forecast'};
 await town.saveCivicDraw('A',{claimable:false,draw_progress:.5,draws_per_day:1},now);assert.equal(saved.at(-1).ready_at,null,'missing server timer must not invent a forecast');assert.equal(saved.at(-1).timer_source,'unknown');
 await town.saveCivicDraw('A',{claimable:false,draws_per_day:1,next_draw_in_seconds:null},now);assert.equal(saved.at(-1).ready_at,null,'explicit unknown timer does not use guessed fallback');
 let ready=2,posts=0,release;const gate=new Promise(r=>release=r);const api={get:async()=>({civic_draw:{claimable:false,grants:[{def_id:'daily',kind:'item',reward:43,amount:1,ready:0},{def_id:'daily',kind:'shard',reward:'rare',amount:2,ready,next_in_seconds:60}]}}),post:async(url,body)=>{assert.equal(url,'/policies/civic-draw/grants/claim');assert.equal(body.def_id,'daily');posts++;await gate;ready=0;return{shards:{rare:4}};}};
 const a=town.claimPolicyGrant(api,'A','daily'),b=town.claimPolicyGrant(api,'A','daily');assert.equal(a,b,'concurrent same claim shares attempt');release();assert((await a).ok);assert((await b).ok);assert.equal(posts,1);assert.equal(inventory,1);
 const notReady=await town.claimPolicyGrant(api,'A','daily');assert.equal(notReady.notReady,true);assert.equal(posts,1);
 ready=1;api.post=async()=>{posts++;ready=0;throw new Error('response lost');};const result=await town.claimPolicyGrant(api,'A','daily');assert.equal(result.ambiguous,true);assert.equal(posts,2);assert.equal(result.refreshed,true);assert.equal(JSON.parse(saved.at(-1).grants)[1].ready,0);
 await assert.rejects(town.claimPolicyGrant(api,'A',{}),/Некорректная/);
 // Разные grants сериализованы общим account lock с обычным draw.
 let active=0,maxActive=0;await Promise.all([town.withClaimLock('A',async()=>{active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;}),town.withClaimLock('A',async()=>{active++;maxActive=Math.max(maxActive,active);active--;})]);assert.equal(maxActive,1);
 let features={civicDraw:false,policyGrants:false};const auto=moduleWith('src/modules/civicDrawAuto.js',{'../utils/logger':{info(){},warn(){},error(){}},'../config':{getConfig:()=>({features})},'../utils/cityWake':{},'../utils/accountLoops':{},'./townhall':town});
 const timerRow={ready_at:new Date(+now+30000),timer_source:'server',grants:JSON.stringify([{def_id:'daily',ready:0,ready_at:new Date(+now+5000)}])};assert.equal(auto.plan(timerRow,0,+now),86400000);
 features={civicDraw:false,policyGrants:true};assert.equal(auto.plan(timerRow,0,+now),10000);assert.equal(auto.plan({...timerRow,grants:JSON.stringify([{ready:1}])},0,+now),0);assert.equal(auto.plan(timerRow,+now+15*60000,+now),15*60000);assert.equal(auto.plan(timerRow,+now+15*60000,+now+15*60000),0);
 features={civicDraw:true,policyGrants:false};assert.equal(auto.plan(timerRow,0,+now),35000);
 // Общий сбор: после КАЖДОГО POST новый GET, новые сроки сохраняются и публикуются.
 let draw=1,grant=1,calls=[];inventory=0;
 const combined={get:async()=>{calls.push('GET');return{civic_draw:{claimable:draw>0,draws_ready:draw,max_draws:3,next_draw_in_seconds:120,grants:[{def_id:'p',ready:grant,next_in_seconds:240}]}};},post:async(url)=>{calls.push(url);if(url.endsWith('/grants/claim'))grant=0;else draw=0;return{draws_consumed:1};}};
 const combinedResult=await town.collectCivicRewards(combined,'B');
 assert.equal(combinedResult.ok,true);assert.equal(combinedResult.draws,1);assert.equal(combinedResult.grants,1);assert.equal(inventory,1);
 assert.deepEqual(calls,['GET','/policies/civic-draw/claim','GET','/policies/civic-draw/grants/claim','GET']);assert.equal(JSON.parse(saved.at(-1).grants)[0].ready,0);assert.equal(saved.at(-1).timer_source,'server');
 draw=1;grant=1;calls=[];
 await town.collectCivicRewards(combined,'B',{draws:false});assert.equal(draw,1);assert.equal(grant,0);assert(!calls.includes('/policies/civic-draw/claim'),'policy-only automation must not claim ordinary draws');
 draw=1;grant=1;calls=[];
 combined.post=async url=>{calls.push(url);draw=0;throw new Error('timeout after acceptance');};
 const lost=await town.collectCivicRewards(combined,'B');assert.equal(lost.ambiguous,true);assert.equal(lost.draws,1);assert.equal(grant,1);assert.deepEqual(calls,['GET','/policies/civic-draw/claim','GET'],'no retry after ambiguous POST');
 draw=1;grant=0;calls=[];
 combined.post=async url=>{calls.push(url);await Promise.resolve();draw=0;return{draws_consumed:1};};
 await Promise.all([town.collectCivicRewards(combined,'B'),town.collectCivicRewards(combined,'B')]);assert.equal(calls.filter(c=>c!=='GET').length,1,'manual/auto claims serialized and rechecked');
 // Реальный цикл: истечение паузы приводит к попытке, а не к очередным 15 минутам.
 let stopped=false,attempts=0,waits=[];const loop=moduleWith('src/modules/civicDrawAuto.js',{
 '../utils/logger':{info(){},warn(){},error(){}},'../config':{getConfig:()=>({features:{civicDraw:true}})},
 '../utils/cityWake':{waitOrWake:async(k,ms)=>{waits.push(ms);throw new Error('unexpected wait');}},
 '../utils/accountLoops':{isStopped:()=>stopped},'../db/index':{CivicDrawStatus:{findOne:async()=>({claimable:true})}},
 './townhall':{collectCivicRewards:async()=>{attempts++;stopped=true;return{got:1,cd:{claimable:false}};}}});
 await loop.runCivicDrawLoop({},'A',1);assert.equal(attempts,1);assert.equal(waits.length,0);
 console.log('PASS exact/fallback timers, separate grants, live readiness, deduplicated account locks, ambiguous response resync, inventory/SSE, opt-in automation and backoff');
})().catch(e=>{console.error(e);process.exitCode=1;});
