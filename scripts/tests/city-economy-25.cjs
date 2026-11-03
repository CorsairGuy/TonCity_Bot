'use strict';
// Общие формулы backend/frontend, новые районы, смешанные уровни и привязанные ресурсы.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),server=require(path.join(root,'src/web/cityStats'));
const esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const ts=fs.readFileSync(path.join(root,'src/web/client/src/cityStats.ts'),'utf8');
const client={module:{exports:{}}};vm.runInNewContext(esbuild.transformSync(ts,{loader:'ts',format:'cjs',target:'es2022'}).code,client);
const ui=client.module.exports,plain=x=>JSON.parse(JSON.stringify(x));
const catalog=JSON.parse(fs.readFileSync(path.join(root,'config/buildings.txt'),'utf8'));
for(const info of catalog)for(const level of [1,2,4,5,18,19,30]){
 assert.equal(ui.upgradeStep(info,level),server.upgradeStep(info,level));
 assert.deepEqual(plain(ui.reconstructYieldAt(info,level)),server.reconstructYieldAt(info,level));
 assert.equal(ui.renovationComponentsAt(info,level),server.renovationComponentsAt(info,level));
}
const ids=['RES_rootweave.png','RES_bough_towers.png','RES_worldtree.png','COM_bloom_market.png','COM_amber_vault.png','COM_eden_consortium.png','SER_heartwood.png'];
for(const id of ids){
 const category=id.startsWith('RES')?'residential':id.startsWith('COM')?'commercial':'service';
 const info={id,category,service_category:'park',base_population:10,base_profit:10,base_price:10,service_coverage:10,star_lvl:null};
 for(const level of [1,2,10,30]){
  assert.equal(server.upgradeStep(info,level),10*Math.exp(.4*level));
  if(category==='residential')assert.equal(server.popAtLevel(info,level),10*Math.pow(level,.67));
  if(category==='commercial')assert.equal(server.profitAtLevel(info,level,1e12),10*Math.pow(level,1.1));
  if(category==='service')assert.equal(server.coverageAtLevel(info,level),10*Math.pow(level,.67));
  const map=new Map([[id,info]]),buildings=[{id,x:1003,y:3,level}];
  assert.deepEqual(plain(ui.computeCityStats(buildings,map)),server.computeCityStats(buildings,map));
 }
}
const info={masterplans_to_get:3,components_required:10,required_lvl:20,star_lvl:null};
for(const [level,masterplans,components] of [[19,3,10],[20,3,10],[21,3,10],[22,4,13],[24,5,16]]){
 assert.deepEqual(server.reconstructYieldAt(info,level),{masterplans,components});
}
assert.deepEqual(server.reconstructYieldAt({...info,masterplans_to_get:0},30),{masterplans:0,components:10});
for(const [star,mult]of [[null,1],[1,3],[2,10],[3,0]])for(const level of [19,20,21,30])assert.equal(server.renovationComponentsAt({...info,star_lvl:star},level),Math.max(0,level-20)*mult);
// Разные уровни одного типа не могут получить один групповой ценник.
const mixed=[20,22,24].map(level=>server.reconstructYieldAt(info,level));
assert.equal(mixed.reduce((n,c)=>n+c.components,0),39);assert.equal(mixed.reduce((n,c)=>n+c.masterplans,0),12);
for(const max_construction_seconds of [null,0,3600,172800])for(const level of [1,10,50]){
 const building={construction_increment:60,max_construction_seconds};
 assert.equal(ui.upgradeDuration(building,level,Date.UTC(2026,10,3)),server.upgradeDuration(building,level,Date.UTC(2026,10,3)));
}
assert.equal(server.upgradeDuration({construction_increment:60,max_construction_seconds:3600},50),3600);
// Старые особые формулы не менялись, включая порог цены Arcanum.
const arcanum={id:'COM_grand_arcanum_2_star.png',category:'commercial',base_price:100,base_profit:100,star_lvl:2};
for(const level of [4,5])assert.equal(server.upgradeStep(arcanum,level),100*Math.exp((level<=4?.45:.48)*level));
const{cityResourceAmounts}=require(path.join(root,'src/utils/cityResources'));
assert.deepEqual(cityResourceAmounts([{id:12,quantity:40,soulbound:40},{id:13,quantity:10,soulbound:4}]),{masterplans:40,components:10});
assert.throws(()=>cityResourceAmounts(null),/склад/);
console.log('PASS: JS/TS mirror, seven D1 overrides, reconstruction boundaries/rounding/zero, renovation stars, mixed costs, per-building time cap and bound resources');
