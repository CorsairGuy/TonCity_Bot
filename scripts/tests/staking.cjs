'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');
const load=Module._load;
let saved=[],updates=[],posts=[],config='';
const db={upsert:async e=>saved.push(e),update:async (...args)=>updates.push(args),destroy:async()=>{}};
Module._load=function(request,parent,...rest){
  if(parent?.filename.endsWith('modules\\staking.js')||parent?.filename.endsWith('modules/staking.js')){
    if(request==='../config')return {getConfig:()=>({stakingConfig:config})};
    if(request==='../utils/logger')return {info(){},warn(){},error(){}};
    if(request==='../utils/lock')return {globalLock:{run:fn=>fn()}};
    if(request==='../utils/helpers')return {sleep:async()=>{},textToNumber:Number};
    if(request==='./session')return {saveStakedStats:async()=>{}};
    if(request==='../db/index')return {StakingEntry:db};
    if(request==='sequelize')return {Op:{notIn:Symbol('notIn')}};
  }
  return load.call(this,request,parent,...rest);
};
const {runStaking,collectReady,saveEntriesToDb}=require('../../src/modules/staking');
Module._load=load;
// sequelize is required lazily in saveEntriesToDb.
Module._load=function(request,parent,...rest){if(request==='sequelize')return {Op:{notIn:Symbol.for('notIn')}};return load.call(this,request,parent,...rest);};
const apiFor=reply=>({get:async()=>reply,post:async(...args)=>{posts.push(args);return {currency:'coins',amount:10};}});
(async()=>{
  const start=Date.now();
  await collectReady(apiFor({entries:[{id:1,currency:'coins',collect_in_seconds:60},{id:2,currency:'coins',collect_in_seconds:0},{id:3,can_collect_at:'bad'}]}),'a');
  assert(saved[0].can_collect_at.getTime()>=start+60000);
  assert(saved[0].can_collect_at.getTime()<=Date.now()+60000);
  assert.equal(saved[2].can_collect_at,null);
  assert.deepEqual(posts.map(x=>x[1]),[{entry_id:2}]);
  saved=[];updates=[];posts=[];
  await collectReady(apiFor({unexpected:true}),'a');
  assert.equal(updates.length,0);assert.equal(posts.length,0);
  await collectReady({get:async()=>{throw Error('timeout');},post:async()=>posts.push(1)},'a');
  assert.equal(posts.length,0);
  await assert.rejects(saveEntriesToDb('a',[{}]),/некорректный/);
  config='100 coins 7';
  await runStaking(apiFor({entries:[]}),'a');
  assert.equal(posts.length,0);
  const valid={entries:[],stakes_per_currency:3,coin_amounts:[100],coin_terms:[{days:7,rate:0.05}],staking_rate_multiplier:2,whale_slots:[]};
  const api={get:async p=>p==='/progress/'?{progress:{data:{coins:1000}}}:valid,post:async(...args)=>{posts.push(args);return {};}};
  await runStaking(api,'a');
  assert.deepEqual(posts.map(x=>x[1]),[{currency:'coins',amount:100,duration:7}]);
  posts=[];valid.entries=[{id:1,currency:'coins'},{id:2,currency:'coins'},{id:3,currency:'coins'}];
  await runStaking(api,'a');assert.equal(posts.length,0);
  valid.entries=[];valid.coin_amounts=[];valid.whale_slots=[{amount:100,in_use:false}];
  await runStaking(api,'a');assert.equal(posts.length,1);
  posts=[];valid.whale_slots[0].in_use=true;
  await runStaking(api,'a');assert.equal(posts.length,0);
  saved=[];
  await saveEntriesToDb('a',[{id:4,can_collect_at:'2026-01-01T00:00:00Z'}]);
  assert.equal(saved[0].can_collect_at.toISOString(),'2026-01-01T00:00:00.000Z');
  console.log('PASS staking: deadlines, invalid responses, timeout, server terms, limits and whale slots');
})().catch(e=>{console.error(e);process.exitCode=1;});
