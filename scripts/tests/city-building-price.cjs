'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/pages/CityWorld.tsx'),'utf8');
const child=fs.readFileSync(path.join(root,'src/web/client/src/pages/CityMapCity.tsx'),'utf8');
const slice=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const familyId=id=>id.replace(/_\d+_star\.png$/i,'.png');
const buildPriceAt=vm.runInNewContext(esbuild.transformSync(slice(child,'export function buildPriceAt','// множитель цены от надетых политик').replace('export ',''),{loader:'ts'}).code+';buildPriceAt');
const A={account:'A',buildings:[]},B={account:'B',buildings:[]};
const info={id:'COM_bloom_market.png',base_price:100,base_price_factor:2};
const liveState={buildings:[{id:info.id},{id:'COM_bloom_market_1_star.png'},{id:info.id}],buildMult:0.5};
const context={useCallback:f=>f,live:a=>a==='A'?liveState:undefined,cabinets:{},computePolicyMultiplier:()=>1,buildPriceAt,familyId};
const fn=vm.runInNewContext(esbuild.transformSync(slice(src,'  const cityBuildPrice =','  // выбранное здание по каждому городу:'),{loader:'ts'}).code+';cityBuildPrice',context);
assert.equal(fn(A,info),400);assert.equal(fn(B,info),100);
// Исполняем выбор области и цены из настоящего списка строительства.
const picker=slice(src,'          const scope =','          return <BuildItem');
function price(curRow){return vm.runInNewContext(esbuild.transformSync(picker,{loader:'ts'}).code+';({price,count:open.length})',{curRow,cities:[A,B],b:info,cityBuildPrice:fn,famLimitHit:r=>r.account==='A'&&liveState.buildings.length>=4,Math});}
assert.equal(price(A).price,400);assert.equal(price(undefined).price,100);
liveState.buildings.push({id:info.id});assert.equal(price(A).count,0);assert.equal(price(undefined).count,1);
delete liveState.buildMult;A.guild={building_purchases_discount:0.25};assert.equal(fn(A,info),1200);
console.log('PASS selected city, star family, queued buildings, overview minimum, limits and guild discount');
