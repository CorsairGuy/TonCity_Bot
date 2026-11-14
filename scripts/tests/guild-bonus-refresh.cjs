'use strict';
// Настоящий цикл и registry, подменяются только внешние I/O и подбор целей.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
function load(file,deps,extra={}){const module={exports:{}};vm.runInNewContext(read(file),{module,exports:module.exports,require:k=>{assert(k in deps,'dependency '+k);return deps[k];},Map,Promise,Number,Math,Date,JSON,Error,...extra});return module.exports;}
(async()=>{
 const wakes=[],saved=[],accountUpdates=[],snapshots=[];let sourceBonus=1,benefitGets=0;
 const registry=load('src/utils/guildBonuses.js',{'./cityWake':{wake:n=>wakes.push(n)},'../db/index':{BuilderSnapshot:{upsert:async r=>saved.push(r)},CitySnapshot:{upsert:async r=>snapshots.push(r)},Account:{update:async r=>accountUpdates.push(r)}},'./cityLive':{broadcast(){}}});
 const api={get:async p=>{if(p==='/guilds/benefits'){benefitGets++;return{benefits:{additional_builder:sourceBonus,upgrades_discount:.1}};}if(p==='/builders/')return{max_builders:9,max_coins:0,max_stars:0};if(p==='/progress/')return{progress:{builders:9,data:{coins:100,crystals:10,buildings:[]}}};throw Error(p);}};
 await registry.ensure(api,'A');await registry.ensure(api,'A');assert.equal(benefitGets,1,'initial fetch only, no TTL');
 sourceBonus=0;await registry.syncGuildBonuses(api,'A',{id:2});assert.equal(registry.current('A').additionalBuilder,0);assert.equal(saved.at(-1).count,9);assert.equal(accountUpdates.at(-1).balance,'100');assert.equal(snapshots.length,1);
 const before=benefitGets;await registry.syncGuildBonuses(api,'A',null);assert.equal(benefitGets,before,'leaving has no benefits request');assert.equal(registry.current('A').additionalBuilder,0);
 // Результат старого запроса не может переписать новое ручное обновление.
 let release;const gate=new Promise(r=>release=r);const pending=registry.ensure({get:async()=>{await gate;return{benefits:{additional_builder:10}};}},'race');registry.publish('race',{benefits:{additional_builder:0}});release();await pending;assert.equal(registry.current('race').additionalBuilder,0);
 for(const changeDuringPost of [false,true]){
  const name='loop'+changeDuringPost;registry.publish(name,{benefits:{additional_builder:1,upgrades_discount:.1}});
  let paused=false,progressGets=0,posts=0,waits=0,discountSeen;
  const busy=Array.from({length:9},(_,x)=>({id:'RES_busy.png',x,y:0,level:1,end:new Date(Date.now()+3600000).toISOString()}));
  const current=()=>({progress:{builders:9,data:{coins:100,buildings:[...busy,{id:'RES_target.png',x:10,y:0,level:1}]}}});
  const loopApi={get:async p=>{if(p==='/policies/cabinet')return{};assert.equal(p,'/progress/','guild effects must not be polled inside loop');progressGets++;if(!changeDuringPost&&progressGets===2)registry.publish(name,{benefits:{additional_builder:0,upgrades_discount:.2}});return current();},post:async()=>{posts++;paused=true;return{coins:90};}};
  const strategies={targets:[{x:10,y:0,target_level:2}],queue:[]};
  const testDeps={loadStrategy:async()=>strategies,loadGlobalPlan:async()=>new Map(),runPendingReconstructions:async()=>false,runPendingBuilds:async()=>false,pickStrategyTargets:(current,queue,targets,map,discount,policy,free)=>{discountSeen=discount;assert.equal(free,1);return{picked:[current.at(-1)],consumedQueueKeys:[]};}};
  const deps={'../db/index':{GlobalUpgradePlan:{},CitySnapshot:{upsert:async()=>{}}},'../db/cityPlans':{},'../utils/guildBonuses':registry,'../utils/logger':{info(){},warn(){},error(){}},'../utils/lock':{globalLock:{run:async fn=>fn()}},'../utils/helpers':{sleep:async ms=>{if(changeDuringPost&&ms===500){registry.publish(name,{benefits:{additional_builder:0}});}},fmt:String,withRetry:async fn=>fn()},'../utils/botState':{isCityPaused:()=>paused},'../utils/cityWake':{waitOrWake:async()=>{waits++;assert.equal(posts,0);if(changeDuringPost)paused=true;else registry.publish(name,{benefits:{additional_builder:1,upgrades_discount:.3}});}},'../utils/cityLive':{broadcast(){}},'../utils/cityMutation':{revision:()=>0,run:async(n,fn)=>fn()},'../web/cityStats':{buildingsMap:()=>new Map(),upgradeDuration:()=>0},'./cityActionLog':{logAction:async()=>null},'../utils/cityResources':{},'../utils/buildingCatalog':{ensureFresh:async()=>{}},'../utils/cityLiveData':{syncBuildCriteria:async()=>{}},'../config':{getConfig:()=>({features:{journey:false}})}};
  const module={exports:{}};vm.runInNewContext(read('src/modules/progress.js')+'\n({loadStrategy,loadGlobalPlan,runPendingReconstructions,runPendingBuilds,pickStrategyTargets}=testDeps);',{module,exports:module.exports,require:k=>{assert(k in deps,'dep '+k);return deps[k];},testDeps,Date,Map,Set,Math,Number,JSON,Promise,Error});
  await module.exports.runProgress(loopApi,name);
  assert.equal(posts,changeDuringPost?0:1);assert.equal(waits,1,'10→9 busy must wait, not retry POST');if(!changeDuringPost)assert.equal(discountSeen,.3,'new discounts used after 9→10');
 }
 assert(wakes.length>0);console.log('PASS manual-only guild effects: 10→9→10 within real loop, discounts, stale batch cancel, no polling/purchases, snapshots and old-request race');
})().catch(e=>{console.error(e);process.exitCode=1;});
