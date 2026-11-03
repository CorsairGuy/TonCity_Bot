'use strict';
// Ответы до/после TON City 2.5, настоящая очередь и чтение старого DB-снимка; без игры/БД.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),limits=require(path.join(root,'src/utils/techFactoryLimits'));
const cases=[
 [{limit:null,used:999,limit_count:1},null,true],
 [{limit:{used:2,count:3,window:'week'}},{used:2,count:3,window:'week'},true],
 [{limit:{used:3,count:3,window:'day'}},{used:3,count:3,window:'day'},false],
 [{limit:{used:0,count:0,window:'week'}},{used:0,count:0,window:'week'},false],
 [{used:4,limit_count:5,limit_window:'day'},{used:4,count:5,window:'day'},true],
 [{used:5,limit_count:5,limit_window:'week'},{used:5,count:5,window:'week'},false],
 [{},{},true],
 [{limit:{}},{used:0,count:0,window:null},false],
 [{limit:{count:-1}},{used:0,count:0,window:null},false],
 [{limit:'bad'},{used:0,count:0,window:null},false],
];
for(const[tier,expected,available]of cases){const n=limits.normalizeTechFactoryTier(tier);assert.deepEqual(n.limit,Object.keys(expected??{}).length?expected:null);assert.equal(n.limit_available,available);assert.deepEqual(limits.normalizeTechFactoryTier(n),n);}
const category=tier=>[{id:'new-category',name:{ru:'Новая категория'},machines:[{id:'unknown-new-machine',tiers:[{level:1,unlocked:true,output:{item_id:43,quantity:2},...tier}]}]}];
let stored;
function loadModule(db){
 const ctx={module:{exports:{}},exports:{},require:name=>{
  if(name==='../utils/logger')return{info(){},warn(){},error(){}};
  if(name==='../utils/helpers')return{sleep:async()=>{}};
  if(name==='../utils/cityWake')return{waitOrWake:async()=>{}};
  if(name==='../utils/accountLoops'){let n=0;return{isStopped:()=>n++>0};}
  if(name==='../utils/techFactoryLimits')return limits;
  if(name==='../db/index')return db;
  throw Error(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/modules/guildBuildings.js'),'utf8'),ctx);return ctx.module.exports;
}
(async()=>{
 for(const[tier,expected]of[[{limit:null},1],[{limit:{used:1,count:1,window:'day'}},0],[{used:2,limit_count:3},1],[{limit:{}},0]]){
  const calls=[];let removed=0;
  const db={TechFactoryStatus:{upsert:async row=>{stored=row;}},TechFactoryQueue:{findOne:async()=>({machine_id:'unknown-new-machine',level:1,destroy:async()=>{removed++;}})}};
  const api={get:async()=>({has_factory:true,categories:category(tier)}),post:async(p,b)=>calls.push([p,b])};
  await loadModule(db).runTechFactoryLoop(api,'A',1);
  assert.equal(calls.length,expected);assert.equal(removed,1);
  if(expected)assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['/tech-factory/start',{machine_id:'unknown-new-machine',level:1}]);
  const snapshot=JSON.parse(stored.categories);assert.equal(snapshot[0].machines[0].tiers[0].limit_available,!!expected);assert.equal(snapshot[0].machines[0].tiers[0].output.item_id,43);
 }
 const handlers=new Map(),app={get:(p,fn)=>handlers.set(p,fn),post(){},delete(){}};
 const db={Account:{findByPk:async()=>({name:'A',access_token:'fixture'})},TechFactoryStatus:{findOne:async()=>({categories:JSON.stringify(category({used:2,limit_count:2,limit_window:'week'}))})},TechFactoryQueue:{findAll:async()=>[]}};
 const context={module:{exports:{}},require:name=>{
  if(name==='../../utils/logger')return{};if(name==='../../utils/techFactoryLimits')return limits;if(name==='../../db/index')return db;throw Error(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/web/routes/guildBuildings.js'),'utf8'),context);context.module.exports(app,{apiForAcc:()=>{throw Error('GET snapshot must not request game');},midErr:String});
 let result;await handlers.get('/api/tech-factory/:accountId/overview')({params:{accountId:1}},{json:value=>{result=value;},status(){return this;}});
 assert.equal(result.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(result.categories[0].machines[0].tiers[0].limit)),{used:2,count:2,window:'week'});assert.equal(result.categories[0].machines[0].tiers[0].limit_available,false);
 console.log('PASS factory: null/object/legacy/missing/malformed limits, unknown machines, real queue guards and DB snapshot normalization');
})().catch(e=>{console.error(e);process.exitCode=1;});
