'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const read=p=>fs.readFileSync(path.join(root,p),'utf8'),ctx={module:{exports:{}}};
vm.runInNewContext(esbuild.transformSync(read('src/web/client/src/cityQueue.ts'),{loader:'ts',format:'cjs'}).code,ctx);
const {reconcileUpgradeQueue,sameUpgradeQueue}=ctx.module.exports,plain=x=>JSON.parse(JSON.stringify(x));
const A={x:1,y:2},B={x:3,y:4},C={x:5,y:6},D={x:7,y:8};
for(const [local,previous,next,expected] of [
 [[A,B],[A,B],[B],[B]],[[A,A,B],[A,A,B],[A,B],[A,B]],[[A,B,C],[A,B],[B],[B,C]],
 [[A,A],[A],[],[A]],[[B,A],[A,B],[A],[A]],[[B],[A,B],[B],[B]],
 [[A,C],[A],[A,B],[A,C,B]],[[C],[A],[],[C]],[[A,C],[A],[A],[A,C]],
]){
 const frozen=a=>Object.freeze(a.map(x=>Object.freeze({...x})));
 assert.deepEqual(plain(reconcileUpgradeQueue(frozen(local),frozen(previous),frozen(next))),expected);
}
const src=read('src/web/client/src/pages/CityMapCity.tsx'),start=src.indexOf('  // Живые здания и подтверждённая очередь'),end=src.indexOf('  // ── Ускорители/Лог/Прогноз',start);
for(const slots of [true,false]){
 let handler,local=[A,B,C],saved=[A,B],rows=[{account:'A',buildings:[]}];const ref={current:saved};
 const c={account:'A',props:{slots},useEffect:fn=>fn(),onServerEvent:(_,fn)=>handler=fn,EventSource:class{constructor(){handler=d=>this.onmessage({data:JSON.stringify(d)});}close(){}},savedQueueRef:ref,queueEventRef:{current:null},
  setRows:f=>rows=f(rows),setManualQueue:f=>local=f(local),setSavedManualQueue:q=>saved=q,sameUpgradeQueue,reconcileUpgradeQueue,mergeUnlockedSections:(_,n)=>n};
 vm.runInNewContext(esbuild.transformSync(src.slice(start,end),{loader:'ts'}).code,c);
 handler({account:'A',buildings:[{id:'built'}],queue:[B]});assert.deepEqual(plain(local),[B,C]);assert.deepEqual(plain(saved),[B]);
 handler({account:'A',buildings:[],queue:[]});assert.deepEqual(plain(local),[C]);assert.deepEqual(plain(saved),[]);
 handler({account:'A',buildings:[]});assert.deepEqual(plain(local),[C]);
 if(slots){handler({account:'B',buildings:[],queue:[D]});assert.deepEqual(plain(local),[C]);}
}
console.log('PASS actual shared/per-city SSE: consumed entries disappear, duplicates/dirty additions/reorder preserved, empty/missing queue and account isolation');

// SSE во время загрузки не откатывается старым ответом cityStrategy после других справочников.
const initStart=src.indexOf('      if (t.ok) {'),initEnd=src.indexOf('      setCoordsSet',initStart);
for(const fresh of [null,[]]){
 let local,saved;const noop=()=>{};
 vm.runInNewContext(esbuild.transformSync(src.slice(initStart,initEnd),{loader:'ts'}).code,{t:{ok:true,targets:[],queue:[A,B]},queueEventRef:{current:fresh},setTargets:noop,setSavedTargets:noop,setPlanRemoved:noop,setManualQueue:q=>local=q,setSavedManualQueue:q=>saved=q,setReconstructPlan:noop,setBuildPlan:noop,Set});
 assert.deepEqual(plain(local),fresh===null?[A,B]:[]);assert.deepEqual(plain(saved),plain(local));
}
console.log('PASS in-flight load preserves newer SSE queue, including empty queue');
