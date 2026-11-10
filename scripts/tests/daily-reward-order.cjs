'use strict';
// Настоящий AccountRewards рендерится с группированным ответом API: дни должны идти 1–28.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),client=path.join(root,'src/web/client/node_modules');
const React=require(path.join(client,'react')),{renderToStaticMarkup}=require(path.join(client,'react-dom/server'));
const esbuild=require(path.join(client,'esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/pages/Daily.tsx'),'utf8');
const Box=({children})=>React.createElement('div',null,children);
const fakeIcon=kind=>()=>React.createElement('span',{'data-kind':kind});
const utils={fmt:String,fmtDate:String,sortByName:x=>x,ITEMS_BY_ID:{2:{tag:'test-item',name:'Test item',scale:1}},itemImgSrc:()=>'/items/test-item.png'};
const ctx={module:{exports:{}},require:name=>{
 if(name==='react')return React;if(name==='react/jsx-runtime')return require(path.join(client,'react/jsx-runtime'));
 if(name==='@primer/react')return {Box,Text:Box,Tooltip:Box};if(name==='../utils')return utils;
 if(name==='../components/Icons')return {CoinIcon:fakeIcon('coins'),CrystalIcon:fakeIcon('crystals')};
 return {};
}};
vm.runInNewContext(esbuild.transformSync(src+'\nexport { AccountRewards };',{loader:'tsx',format:'cjs',jsx:'automatic'}).code,ctx);
for(const stringDays of [false,true]){
 const ordered=Array.from({length:28},(_,i)=>Object.freeze({day:stringDays?String(i+1):i+1,reward_type:i===6?'crystals':(i+1)%7===0?'item':'coins',amount:100+i,item_id:(i+1)%7===0&&i!==6?2:null,source:i<8?'actual':'upcoming',is_today:i===7}));
 const grouped=Object.freeze([...ordered.filter(d=>d.reward_type==='coins'),...ordered.filter(d=>d.reward_type==='crystals'),...ordered.filter(d=>d.reward_type==='item')]);
 const original=grouped.slice(),html=renderToStaticMarkup(React.createElement(ctx.module.exports.AccountRewards,{data:{name:'Test',streak:8,last_login:null,days:grouped}}));
 const labels=[...html.matchAll(/>День (\d+)<\/span>/g)].map(m=>Number(m[1]));
 assert.deepEqual(labels,Array.from({length:28},(_,i)=>i+1));assert.deepEqual(grouped,original);
 assert.equal((html.match(/ dr-today/g)||[]).length,1);assert.equal((html.match(/ dr-future/g)||[]).length,20);
 assert.equal((html.match(/data-kind="crystals"/g)||[]).length,1);assert.equal((html.match(/alt="Test item"/g)||[]).length,3);
}
console.log('PASS actual reward cards: numeric day 1–28 across coins/crystals/items; input unchanged; active/future states and item content preserved');
