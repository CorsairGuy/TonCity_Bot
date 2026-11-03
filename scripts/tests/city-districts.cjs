'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(root+'/src/web/client/node_modules/esbuild'),ts=require(root+'/src/web/client/node_modules/typescript');
const built=esbuild.buildSync({entryPoints:[root+'/src/web/client/src/cityDistricts.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const moduleBox={exports:{}};vm.runInNewContext(built,{module:moduleBox,exports:moduleBox.exports});const d=moduleBox.exports;
const all=[{id:'RES_house.png',x:3,y:4},{id:'RES_rootweave.png',x:1004,y:5}];
assert.equal(d.districtCoordsFor('main').length,141);assert.equal(d.districtCoordsFor('d1').length,30);
for(const district of ['main','d1'])for(const off of [0,25,50]){
 const list=d.projectDistrict(all,district,off,25);assert.equal(list.length,1);assert(list[0].x>=off&&list[0].x<off+22);assert.equal(list[0].x-off+d.districtOffset(district),district==='d1'?1004:3);
}
assert.equal(all[1].x,1004);assert.equal(all.length,2);assert.equal(d.buildingDistrict({id:'RES_rootweave.png'}),'d1');assert.equal(d.buildingDistrict({id:'RES_house.png'}),'main');
const sections=JSON.parse(fs.readFileSync(root+'/config/city_sections.json'));assert.equal(sections.length,23);assert.deepEqual(sections.filter(s=>s.unlockCost.keys).map(s=>s.unlockCost.keys),[10,20,30]);
const client=fs.readFileSync(root+'/src/web/client/src/pages/CityMapCity.tsx','utf8'),ast=ts.createSourceFile('client.tsx',client,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let cb;
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='onUnlockCell')cb=n.initializer.arguments[0];n.forEachChild(visit);}visit(ast);assert(cb);
const source=ts.transpileModule('('+cb.getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
async function check(extra,id){const messages=[],calls=[];const context={account:'A',sections,unlockingSection:false,currentStats:{population:2e8},unlockedSections:['d1_core'],keys:30,balance:1e15,walletRest:{crystals:50000},fmt:String,showFlash:(...v)=>messages.push(v),ask:async(...v)=>{messages.push(v);return false;},setUnlockingSection(){},setRows(){},refreshMap(){},api:{cityActionUnlockSection:(...v)=>calls.push(v)},...extra};await vm.runInNewContext(source,context)(id);assert.equal(calls.length,0);return messages;}
(async()=>{
 let m=await check({},'d1_wing_a');assert(m[0][1].includes('10 ключей'));
 m=await check({keys:9},'d1_wing_a');assert(m[0][0].includes('Недостаточно ключей'));
 m=await check({currentStats:{population:1e8}},'d1_wing_a');assert(m[0][0].includes('125000000'));
 m=await check({},'unknown');assert(m[0][0].includes('Неизвестная секция'));
 m=await check({unlockedSections:[]},'d1_wing_a');assert(m[0][0].includes('Сначала'));
 const {atlasEntries}=require(root+'/scripts/download-sprites');assert.throws(()=>atlasEntries({meta:{image:'a.png',size:{w:10,h:10}},frames:{bad:{frame:{x:9,y:0,w:2,h:1}}}},'d1'),/frame/);
 console.log('PASS: raw district projection, two accounts isolation, aggregate source unchanged, building district, six sections/key costs, real unlock guards/cancel, atlas bounds');
})().catch(e=>{console.error(e);process.exitCode=1;});
