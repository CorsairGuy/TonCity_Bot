'use strict';
// Реальные правила/план/исполнитель/таймер, без БД и покупок в игре.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),ts=require(root+'/src/web/client/node_modules/typescript');
const{matchesAutobuyItem,verifyAutobuyItem}=require(root+'/src/web/lib/marketAutobuy');
assert(matchesAutobuyItem({item_id:43},{item_id:'43'}));assert(!matchesAutobuyItem({item_id:38},{item_id:43}));assert(!matchesAutobuyItem({},{item_id:43}));assert(matchesAutobuyItem({item_id:38},{item_id:null}));
const source=fs.readFileSync(root+'/src/web/routes/market.js','utf8'),ast=ts.createSourceFile('market.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function fn(name){let found;function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n;n.forEachChild(walk);}walk(ast);assert(found,name);return found.getText(ast);}
const code=ts.transpileModule(['abPlan','abExecute','abRunRule'].map(fn).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture({future=false,actual=43}={}){
 const offers=[{id:38,item_id:38,display_price:1,status:'active',listing_currency:'crystals'}, {id:43,item_id:43,display_price:10,status:'active',listing_currency:'crystals'}].map(o=>({...o,available_at:future?new Date(10000).toISOString():null}));
 const posts=[],timers=[],updates=[],rule={id:1,item_id:43,currency:'crystals',max_price:10,max_budget:100,spent:0,account_ids:'[1]',include_escrow:true,enabled:true};
 const db={MarketAutobuy:{findByPk:async()=>rule,update:async v=>updates.push(v)},Account:{findAll:async()=>[{id:1,name:'A',crystals:1000}]}};
 const ctx={matchesAutobuyItem,verifyAutobuyItem,require:p=>{assert.equal(p,'../../db/index');return db;},abBalances:async()=>new Map([[1,1000]]),randomTokenedApi:async()=>({}),abFetchOffers:async()=>offers,makeApiForAccount:async()=>({get:async()=>({...offers[1],item_id:actual}),post:async(p,b)=>posts.push([p,b])}),abScheduled:new Set(),setTimeout:fn=>timers.push(fn),Date:class extends Date{static now(){return 0;}},logger:{info(){},warn(){}},Map,Set,Promise,JSON,Number};
 vm.createContext(ctx);vm.runInContext(code,ctx);return{ctx,posts,timers,updates,rule};
}
(async()=>{
 let f=fixture();await f.ctx.abRunRule(f.rule);assert.deepEqual(JSON.parse(JSON.stringify(f.posts)),[['/market/direct/buy',{offer_id:43}]]);assert.equal(f.updates[0].spent,10);
 f=fixture({actual:38});await f.ctx.abRunRule(f.rule);assert.equal(f.posts.length,0);assert.equal(f.updates.length,0);
 f=fixture({future:true});await f.ctx.abRunRule(f.rule);assert.equal(f.posts.length,0);assert.equal(f.timers.length,1);await f.timers[0]();assert.deepEqual(JSON.parse(JSON.stringify(f.posts)),[['/market/direct/buy',{offer_id:43}]]);
 f=fixture({future:true});await f.ctx.abRunRule(f.rule);f.rule.item_id=38;await f.timers[0]();assert.equal(f.posts.length,0);
 f=fixture({future:true,actual:38});await f.ctx.abRunRule(f.rule);await f.timers[0]();assert.equal(f.posts.length,0);
 for(const patch of [{display_price:11},{listing_currency:'ton'},{your_offer:true},{status:'sold'}])await assert.rejects(verifyAutobuyItem({get:async()=>({item_id:43,display_price:10,listing_currency:'crystals',status:'active',...patch})},43,{item_id:43,currency:'crystals'},10));
 // Новый предмет и существующая защита bound сохраняются в реальных исходниках UI/продажи.
 const utils=fs.readFileSync(root+'/src/web/client/src/utils.ts','utf8');assert.match(utils,/43: \{ tag: 'key', name: 'Ключ'/);assert.match(utils,/key: 'mythic'/);
 const inventory=fs.readFileSync(root+'/src/modules/market.js','utf8');
 for(const [quantity,soulbound,expected]of[[5,5,0],[5,3,2]]){
  const sold=[],saleContext={module:{exports:{}},require:p=>({
   '../config':{getConfig:()=>({sellItems:'key:1:10'})},'../utils/logger':{info(){},error(e){throw Error(e);}},
   '../utils/lock':{globalLock:{run:f=>f()}},'../utils/helpers':{sleep:async()=>{}}
  })[p]};vm.runInNewContext(inventory,saleContext);
  await saleContext.module.exports.runMarket({get:async p=>p.includes('allitemdata')?{items:[{id:43,name:'key',quantity,soulbound}]}:{rules:[{item_id:43,market_id:1,can_list:true}]},post:async(p,b)=>(sold.push([p,b]),{success:true})},'A');assert.equal(sold.length,expected);
 }

 console.log('PASS: exact43 vs38, live identity/price/currency checks, normal and escrow, rule edit before timer, key UI and bound-sale guard');
})().catch(e=>{console.error(e);process.exitCode=1;});
