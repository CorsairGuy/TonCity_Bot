'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),{QueryTypes}=require(path.join(root,'node_modules/sequelize'));
const Query=require(path.join(root,'node_modules/sequelize/lib/dialects/mariadb/query'));
const criteria={criteria:[{id:'COM_atlas_foundry.png',criteria_met:false}]};
function response(){const rows=[{account:'A',criteria:JSON.stringify(criteria)}];Object.defineProperty(rows,'meta',{value:[],configurable:false});return rows;}
function format(type){const q=new Query({}, {options:{}},{type,raw:true,logging:false});q.sql='SELECT account,criteria FROM city_build_criteria';return q.formatResults(response());}
assert.throws(()=>format(QueryTypes.RAW),/Cannot delete property 'meta'/);
let reads=0;
const seq={query:async(sql,options)=>{
 assert.match(sql,/^SELECT /);assert.equal(options.type,QueryTypes.SELECT);reads++;
 return format(options.type);
}};
const ctx={module:{exports:{}},require:name=>{
 if(name==='../db/index')return {seq};
 if(name==='sequelize')return {QueryTypes};
 throw Error(`Unexpected dependency/network access: ${name}`);
}};
vm.runInNewContext(fs.readFileSync(path.join(root,'src/utils/cityLiveData.js'),'utf8'),ctx);
(async()=>{
 const all=await ctx.module.exports.loadAllBuildCriteria();
 assert.equal(JSON.stringify(all.get('A')),JSON.stringify(criteria));
 const one=await ctx.module.exports.loadBuildCriteria('A');
 assert.equal(JSON.stringify(one),JSON.stringify(criteria));assert.equal(reads,2);
 console.log('PASS actual MariaDB formatter: RAW reproduces meta error; both SELECT readers succeed using DB only');
})().catch(e=>{console.error(e);process.exitCode=1;});
