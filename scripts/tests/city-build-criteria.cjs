'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const source=p=>fs.readFileSync(path.join(root,p),'utf8');
const child=source('src/web/client/src/pages/CityMapCity.tsx'),world=source('src/web/client/src/pages/CityWorld.tsx');
const ctx={module:{exports:{}},fmt:String};
vm.runInNewContext(esbuild.transformSync(child.slice(child.indexOf('interface BuildCriterion'),child.indexOf('// цена постройки k-го')),{loader:'ts',format:'cjs'}).code,ctx);
const {isCriteriaUnmet,criteriaReason}=ctx.module.exports;
const id='COM_atlas_foundry.png',A={account:'A'},B={account:'B'};
const criteria={criteria:[{id,criteria_met:false,type:'population',population:{population:10,population_required:100}}]};
const byCity={A:criteria,B:{criteria:[{id,criteria_met:true}]}};
const picker=world.slice(world.indexOf('          const scope ='),world.indexOf('          return <BuildItem',world.indexOf('          const scope =')));
function select(curRow){return vm.runInNewContext(esbuild.transformSync(picker,{loader:'ts'}).code+';({count:open.length,reason,price})',{curRow,cities:[A,B],b:{id},famLimitHit:()=>false,cityBuildCriteria:r=>byCity[r.account],isCriteriaUnmet,criteriaReason,cityBuildPrice:()=>123});}
assert.equal(select(A).count,0);assert.equal(select(A).reason,'Нужно 100 нас.');
assert.equal(select(B).count,1);assert.equal(select(undefined).count,1);
criteria.criteria[0].criteria_met=true;assert.equal(select(A).count,1);
assert.equal(isCriteriaUnmet({criteria:[{id:'COM_genesis_labs.png',criteria_met:false}]},id),false);
// Проверяем пакетное чтение сохранённых условий без игрового API.
const liveCtx={module:{exports:{}},require:name=>name==='sequelize'?{QueryTypes:{SELECT:'SELECT'}}:{seq:{query:async()=>[{account:'A',criteria:JSON.stringify(criteria)},{account:'B',criteria:'invalid'}]}}};
vm.runInNewContext(source('src/utils/cityLiveData.js'),liveCtx);
liveCtx.module.exports.loadAllBuildCriteria().then(rows=>{
 assert.equal(rows.get('A').criteria[0].criteria_met,true);assert.equal(rows.has('B'),false);
 console.log('PASS shared criteria: visible blocked row, reason, per-city availability, overview, unlock and batched DB read');
}).catch(e=>{console.error(e);process.exitCode=1;});
