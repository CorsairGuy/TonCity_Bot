'use strict';
// Настоящие removeQueue, refreshState и cityLive: контролируем только БД и транспорт API.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),plain=x=>JSON.parse(JSON.stringify(x));
const events=[],sse=[],other=[];
const liveCtx={module:{exports:{}},require:name=>{assert.equal(name,'../web/lib/panelEvents');return{emit:(type,payload)=>events.push([type,plain(payload)])};}};
vm.runInNewContext(read('src/utils/cityLive.js'),liveCtx);const live=liveCtx.module.exports;
const receiver={write:text=>sse.push(JSON.parse(text.slice(6).trim()))};
live.subscribe('A',receiver);live.subscribe('B',{write:text=>other.push(text)});
for(const queue of [undefined,null,{},[]]){
 live.broadcast('A',[],undefined,queue);const payload=events.at(-1)[1];
 assert.equal(Object.hasOwn(payload,'queue'),Array.isArray(queue));
 assert.equal(Object.hasOwn(sse.at(-1),'queue'),Array.isArray(queue));
 if(Array.isArray(queue))assert.deepEqual(payload.queue,[]);
}
assert.equal(other.length,0);events.length=0;sse.length=0;
const progress=read('src/modules/progress.js'),start=progress.indexOf('    const persistQueue=async(consumed)=>{'),end=progress.indexOf('    while(true){',start);
const helpers=progress.slice(start,end);assert(helpers.includes('cityLive.broadcast(name,current,currentSections,queue)'));
assert(!progress.slice(0,start).includes('cityLive.broadcast(name,current,currentSections,queue)'),'pre-plan broadcasts must not read uninitialised queue');
const cbStart=progress.indexOf('        const ok=await runProgressAction(name,'),callback=progress.slice(cbStart,progress.indexOf('        if(ok){',cbStart));
async function scenario(kind){
 let rows=[{id:1,account:'A',x:1,y:2,pos:0},{id:2,account:'A',x:1,y:2,pos:1},{id:3,account:'A',x:3,y:4,pos:2},{id:4,account:'B',x:1,y:2,pos:0}],deletes=0,posts=0,gets=0;
 const Queue={findAll:async({where})=>rows.filter(r=>r.account===where.account).sort((a,b)=>a.pos-b.pos||a.id-b.id),destroy:async({where})=>{deletes++;if(kind==='db-failure')throw Error('DB delete failed');const before=rows.length;rows=rows.filter(r=>!where.id.includes(r.id));return before-rows.length;}};
 const db={seq:{transaction:async fn=>fn({})},CityUpgradeQueue:Queue,CityUpgradeTarget:{findAll:async()=>[]},CityReconstructPlan:{findAll:async()=>[]}};
 const plansCtx={module:{exports:{}},require:()=>db};vm.runInNewContext(read('src/db/cityPlans.js'),plansCtx);const plans=plansCtx.module.exports;
 const initialQueue=(await plans.loadPlans('A')).queue;
 const warnings=[],ctx={initialQueue,name:'A',cityPlans:plans,logger:{warn:m=>warnings.push(m),info:()=>{}},current:[],currentSections:[],builders:3,builderBonus:0,CitySnapshot:{upsert:async()=>{}},citySnapshotPayload:()=>({}),cityLive:live,
  api:{get:async()=>{gets++;return{progress:{data:{coins:123,buildings:[{id:'RES_test.png',x:1,y:2,level:2}]},unlocked_sections:['core'],builders:3}};},post:async()=>{posts++;if(kind==='timeout')throw Error('ECONNABORTED');if(kind==='http-failure')throw Error('HTTP 500');return kind==='unconfirmed'?{}:{coins:123};}},
  withRetry:async fn=>fn(),require:name=>{assert.equal(name,'../config');return{getConfig:()=>({features:{journey:false}})}},
  cityMutation:{run:async(_,fn)=>fn(),revision:()=>0},mapRevision:0,b:{id:'RES_test.png',x:1,y:2,level:1},nextLvl:2,sleep:async()=>{},consumedQueueKeys:['1,2'],runProgressAction:async(_,__,fn)=>{try{await fn();return true;}catch{return false;}}};
 const funcs=vm.runInNewContext(`(()=>{let queue=initialQueue;${helpers}\nreturn{persistQueue,refreshState,getQueue:()=>queue};})()`,ctx);ctx.persistQueue=funcs.persistQueue;
 const ok=await vm.runInNewContext(`(async()=>{${callback}\nreturn ok;})()`,ctx);
 assert.equal(posts,1,'POST is never retried');
 const consumed=kind==='success';assert.equal(deletes,kind==='success'||kind==='db-failure'?1:0);
 assert.equal(rows.filter(r=>r.account==='A'&&r.x===1).length,consumed?1:2,'only one duplicate consumed');assert.equal(rows.filter(r=>r.account==='B').length,1);
 await funcs.refreshState();assert.equal(gets,1,'queue event reuses existing refresh');
 const expected=consumed?[{x:1,y:2},{x:3,y:4}]:initialQueue;
 assert.deepEqual(plain(funcs.getQueue()),plain(expected));assert.deepEqual(events.at(-1),['city',{account:'A',buildings:[{id:'RES_test.png',x:1,y:2,level:2}],unlockedSections:['core'],queue:plain(expected)}]);
 assert.deepEqual(sse.at(-1),{buildings:[{id:'RES_test.png',x:1,y:2,level:2}],unlockedSections:['core'],queue:plain(expected)});
 if(consumed){
  for(const cell of [{x:1,y:2},{x:3,y:4}]){
   ctx.b={id:'RES_test.png',...cell,level:1};ctx.consumedQueueKeys=[`${cell.x},${cell.y}`];
   assert.equal(await vm.runInNewContext(`(async()=>{${callback}\nreturn ok;})()`,ctx),true);
   await funcs.refreshState();
  }
  assert.deepEqual(plain(funcs.getQueue()),[]);assert.deepEqual(events.at(-1)[1].queue,[]);assert.deepEqual(sse.at(-1).queue,[]);
  assert.equal(rows.filter(r=>r.account==='A').length,0);assert.equal(rows.filter(r=>r.account==='B').length,1);
 }
 if(kind==='db-failure')assert.equal(warnings.length,1);
 if(kind==='timeout'||kind==='http-failure')assert.equal(ok,false);
}
(async()=>{for(const kind of ['success','timeout','http-failure','unconfirmed','db-failure'])await scenario(kind);
 live.unsubscribe('A',receiver);const count=sse.length;live.broadcast('A',[],undefined,[]);assert.equal(sse.length,count);
 assert.equal(other.length,0);console.log('PASS optional/empty queue events in global + per-city SSE, actual DB duplicate removal, actual refreshState and upgrade callback: confirmed success only, no extra GET/POST retry, failures keep queue');
})().catch(e=>{console.error(e);process.exitCode=1;});
