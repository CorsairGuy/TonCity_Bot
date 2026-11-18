'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'tc-catalog-test-'));
const config=path.join(temp,'config');fs.mkdirSync(config);
fs.writeFileSync(path.join(config,'buildings.txt'),JSON.stringify([{id:'fallback',base_price:1}]));
process.chdir(temp);
const catalog=require(path.join(root,'src/utils/buildingCatalog'));
const make=(prefix)=>Array.from({length:12},(_,i)=>({id:`${prefix}${i}`,base_price:i+1}));
let calls=0;const api={get:async p=>{assert.equal(p,'/buildings/');calls++;return{buildings:calls===1?make('A'):make('B')};}};
(async()=>{
 await catalog.refresh(api);await catalog.refresh(api);
 const live=JSON.parse(fs.readFileSync(path.join(config,'buildings-live.json'),'utf8'));
 const observed=JSON.parse(fs.readFileSync(path.join(config,'buildings-observed.json'),'utf8'));
 assert.equal(live.length,12);assert.equal(observed.length,24);
 assert.equal(catalog.statisticsFallback(live).length,13);
 assert.equal(calls,2,'один запрос на каждое явное обновление');
 fs.writeFileSync(path.join(config,'buildings-observed.json'),'{broken');
 await assert.rejects(catalog.refresh(api));
 assert.equal(fs.readFileSync(path.join(config,'buildings-observed.json'),'utf8'),'{broken');
 assert.equal(JSON.parse(fs.readFileSync(path.join(config,'buildings-live.json'),'utf8')).length,12);
 console.log('PASS building catalog: partial responses retained for stats, live catalog separate, damaged archive preserved');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 process.chdir(root);
 for(const f of ['buildings.txt','buildings-live.json','buildings-observed.json'])try{fs.unlinkSync(path.join(config,f));}catch(_){}
 try{fs.rmdirSync(config);fs.rmdirSync(temp);}catch(_){}
});
