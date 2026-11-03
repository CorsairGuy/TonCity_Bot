'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),helpers=require(path.join(root,'src/utils/satoshiMargin'));
const base={id:7,side:'long',entry_price:100,margin:100,notional:1000,leverage:10,liquidation_price:90.05};
assert.equal(helpers.previewMargin(base,500,50).maxAmount,500);assert.equal(helpers.previewMargin(base,500,50).new_margin,150);
assert.equal(helpers.previewMargin(base,500,50).liquidation_price,85.075);
assert(Math.abs(helpers.previewMargin({...base,side:'short'},500,50).liquidation_price-114.925)<1e-10);
for(const value of [-1,.5,Infinity,NaN,501])assert.throws(()=>helpers.previewMargin(base,500,value));
assert.equal(helpers.previewMargin({...base,margin:1000},500).maxAmount,0);
assert.deepEqual(helpers.preservedMarginTriggers({margin:100,tp_pnl_pct:20,sl_pnl_pct:10,tp_price:200},200),{tp_pnl_pct:10,sl_pnl_pct:5});
function fixture({ambiguous=false,missing=false}={}){
 const routes=new Map(),posts=[],syncs=[];let balance=500;
 const pos={...base},row={...base,account:'A',tp_pnl_pct:20,sl_pnl_pct:10,async update(p){Object.assign(this,p);}};
 const api={async get(url){if(url==='/progress/')return{progress:{data:{crystals:balance}}};if(url==='/satoshi-tower/positions')return{open:missing?[]:[{...pos}]};throw Error(url);},async post(url,body){posts.push({url,body});pos.margin+=body.amount;balance-=body.amount;if(ambiguous)throw Error('connection lost');return{position:{...pos},new_balance:balance};}};
 const db={Account:{async findByPk(id){return id===1?{id:1,name:'A',special_buildings:'satoshi'}:null;}},SatoshiPosition:{async findByPk(){return row;}}};
 const inFlight=new Map(),ops={statusOf:keys=>Object.fromEntries(keys.map(k=>[k,inFlight.has(k)])),run(key,fn){const p=Promise.resolve().then(fn);inFlight.set(key,p);return p.finally(()=>inFlight.delete(key));}};
 const context={module:{exports:{}},exports:{},setTimeout,clearTimeout,require:name=>{
  if(name==='../../utils/satoshiMargin')return helpers;
  if(name==='../../utils/satoshiTriggers')return require(path.join(root,'src/utils/satoshiTriggers'));
  if(name==='../../web/lib/opRegistry'||name==='../lib/opRegistry')return ops;
  if(name==='../../db/index')return db;
  if(name==='../../modules/session')return{ensureSession:async()=>{}};
  if(name==='../../modules/satoshi')return{applyBalance:async()=>{},runSatoshi:async()=>syncs.push(true)};
  if(name.includes('logger'))return{warn(){},info(){}};
  if(name.includes('Feed'))return{};
  throw Error(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/web/routes/satoshi.js'),'utf8'),context);
 const app={};for(const method of ['get','post','patch','delete'])app[method]=(url,fn)=>routes.set(method+' '+url,fn);
 context.module.exports(app,{makeApiForAccount:async()=>api});
 async function call(endpoint,body,accountId=1){const res={code:200,status(n){this.code=n;return this;},json(data){this.data=data;return this;}};await routes.get('post /api/satoshi/:accountId/'+endpoint)({params:{accountId},body},res);return res;}
 return{call,posts,row,pos,syncs,ops};
}
(async()=>{
 const a=fixture();const p=await a.call('margin-preview',{position_id:7});assert(p.data.ok);assert.equal(p.data.maxAmount,500);assert.equal(a.posts.length,0);
 for(const amount of [0,-1,1.5,501]){const r=await a.call('margin',{position_id:7,amount});assert(!r.data.ok);assert.equal(a.posts.length,0);}
 const badAccount=await a.call('margin',{position_id:7,amount:1},2);assert(!badAccount.data.ok);assert.equal(a.posts.length,0);
 const ok=await a.call('margin',{position_id:7,amount:50});assert(ok.data.ok);assert.equal(a.posts.length,1);assert.equal(a.posts[0].url,'/satoshi-tower/positions/margin');assert.equal(a.posts[0].body.amount,50);
 assert.equal(a.row.margin,150);assert(Math.abs(a.row.tp_pnl_pct*150-20*100)<1e-9);assert(Math.abs(a.row.sl_pnl_pct*150-10*100)<1e-9);assert.equal(a.syncs.length,1);
 const b=fixture({ambiguous:true});const failed=await b.call('margin',{position_id:7,amount:50});assert(!failed.data.ok);assert.match(failed.data.error,/Повтор не выполнен/);assert.equal(b.posts.length,1);assert.equal(b.row.margin,150);assert.equal(b.syncs.length,1);
 const c=fixture({missing:true});assert(!(await c.call('margin',{position_id:7,amount:1})).data.ok);assert.equal(c.posts.length,0);
 const concurrent=fixture();const first=concurrent.call('margin',{position_id:7,amount:1});const duplicate=await concurrent.call('margin',{position_id:7,amount:1});assert.equal(duplicate.code,409);await first;assert.equal(concurrent.posts.length,1);
 a.row.account='B';assert(!(await a.call('margin',{position_id:7,amount:1})).data.ok);assert.equal(a.posts.length,1);
 console.log('PASS: fresh balance/ownership/limits, preview without POST, one mutation, ambiguous resync without retry, preserved monetary TP/SL');
})().catch(e=>{console.error(e);process.exitCode=1;});
