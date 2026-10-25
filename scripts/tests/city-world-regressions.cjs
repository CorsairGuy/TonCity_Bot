'use strict';
// Выполнение настоящих обработчиков CityWorld с управляемыми состоянием и API.
// Запуск после npm ci фронта: node scripts/tests/city-world-regressions.cjs.
// Эти сценарии не заменяют проверку полной страницы в браузере.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodePath=require('node:path');
const root=nodePath.resolve(__dirname,'../..');
const esbuild=require(nodePath.join(root,'src/web/client/node_modules/esbuild'));
const path=nodePath.join(root,'src/web/client/src/pages/CityWorld.tsx');
const src=fs.readFileSync(path,'utf8');
const results=[];
function block(start,end){const a=src.indexOf(start);assert(a>=0,start);const b=src.indexOf(end,a);assert(b>a,end);return src.slice(a,b);}
function ctx(extra){return vm.createContext({console,Set,Map,JSON,Promise,setTimeout,clearTimeout,...extra});}
function run(s,c){return vm.runInContext(esbuild.transformSync(s,{loader:'ts',target:'es2022'}).code,c);}
function fn(s,name,c){return run(`(()=>{${s}; return ${name};})()`,c);}
function plain(x){return JSON.parse(JSON.stringify(x));}
async function test(name,body){await body();results.push({name,status:'passed'});console.log('PASS',name);}
(async()=>{
const deliverSrc=block('  const deliver =','  const route =');
const cancelSrc=block('  // Смена инструмента отменяет','  // город загрузился').replace(/^[\s\S]*?useEffect\(\(\) => \{/,'').replace(/\}, \[pickTool\]\);\s*$/,'');
const onPickSrc=block('  const onPick =','  const onUnlockCell =');
await test('pending queue→demolish and buildA→buildB are cancelled; unlock preserved',()=>{
 for(const [oldMode,newMode] of [['queue','demolish'],['build','build']]){
 const c=ctx({pending:{current:new Map([['A',{picks:[{x:4,y:5,revision:0}]}],['B',{picks:[{x:2,y:3,revision:0}],unlock:'section-2'}]])},pickRevision:{current:{value:1}},modeRef:{current:newMode},settle:{current:new Set()},touched:['A','B'],flashes:[],batch:{current:null}});
 c.setTouched=f=>c.touched=f(c.touched);c.showFlash=(...a)=>c.flashes.push(a);
 const deliver=fn(deliverSrc,'deliver',c);run(cancelSrc,c);
 let picks=0,unlocks=0;const st={mode:newMode,validSet:new Set(['4_5','2_3']),onPick:()=>picks++,onUnlockCell:()=>unlocks++};
 deliver('A',st);deliver('B',st);
 assert.equal(picks,0);assert.equal(unlocks,1);assert.deepEqual(c.touched,['B']);assert.equal(c.flashes.length,1);
 }
});
await test('matching revision waits for matching child mode then delivers once',()=>{
 const c=ctx({pending:{current:new Map([['A',{picks:[{x:4,y:5,revision:3}]}]])},pickRevision:{current:{value:3}},modeRef:{current:'queue'},settle:{current:new Set()}});
 const deliver=fn(deliverSrc,'deliver',c);let picks=0;
 const st={mode:'demolish',validSet:new Set(['4_5']),onPick:()=>picks++};
 deliver('A',st);assert.equal(picks,0);assert(c.pending.current.has('A'));
 st.mode='queue';deliver('A',st);deliver('A',st);assert.equal(picks,1);assert(!c.pending.current.has('A'));
});
await test('same-tick tool change prevents microtask routing stale pick',()=>{
 const tasks=[],c=ctx({useCallback:f=>f,farPlanPick:{current:null},toLocal:()=>({account:'A',x:4,y:5}),batch:{current:null},pickRevision:{current:{value:0}},pending:{current:new Map()},curRef:{current:null},offOf:new Map(),cityAtCell:()=>0,choose:()=>{throw Error('stale choose');},route:()=>{throw Error('stale route');},queueMicrotask:f=>tasks.push(f)});
 const pick=fn(onPickSrc,'onPick',c);pick(4,5);c.pickRevision.current.value=1;tasks[0]();assert.equal(c.pending.current.size,0);
});
const applySrc=block('  const applyBoosters =','  // ── всё для общей карты');
function boosterContext(additions){const c=ctx({boosterSaving:false,boosterAdd:additions,boosters:{A:{stock:[],queue:['oldA'],active:[]},B:{stock:[],queue:['oldB'],active:[]}},boosterRetryBase:{current:new Map()},api:{},flashes:[],plural:(_n,a)=>a});c.setBoosterSaving=v=>c.boosterSaving=v;c.setBoosterAdd=f=>c.boosterAdd=f(c.boosterAdd);c.setBoosters=f=>c.boosters=f(c.boosters);c.showFlash=(...a)=>c.flashes.push(a);return c;}
await test('partial save keeps failed B, preserves newly added drafts, retry is idempotent after ambiguous save',async()=>{
 const a={account:'A',name:'boostA'},b={account:'B',name:'boostB'},later={account:'A',name:'later'};const c=boosterContext([a,b]),calls=[];
 c.api.saveBoosterQueue=async(account,order)=>{calls.push({account,order:plain(order)});if(account==='A'){c.boosterAdd=[...c.boosterAdd,later];return{ok:true};}return{ok:false,error:'connection lost after server accepted'};};
 await fn(applySrc,'applyBoosters',c)();assert.deepEqual(c.boosterAdd,[b,later]);assert.deepEqual(plain(c.boosters.A.queue),['oldA','boostA']);assert.deepEqual(plain(c.boosterRetryBase.current.get('B')),['oldB']);assert.equal(c.boosterSaving,false);
 // Simulate a manual stock reload observing B's successful server write despite lost response.
 c.boosters.B.queue=['oldB','boostB'];c.api.saveBoosterQueue=async(account,order)=>{calls.push({account,order:plain(order)});return{ok:true};};
 await fn(applySrc,'applyBoosters',c)();
 assert.deepEqual(calls.findLast(x=>x.account==='B').order,['oldB','boostB']);
 assert.deepEqual(calls.findLast(x=>x.account==='A').order,['oldA','boostA','later']);
 assert.equal(c.boosterAdd.length,0);assert.equal(c.boosterRetryBase.current.size,0);
});
const forecastSrc=block('  const forecastAccounts =','\n  useEffect(() => {\n    if (cur) return;');
await test('forecast actual dependency refreshes A→A+B→B and caps worker concurrency at 2',async()=>{
 const c=ctx({cities:[],forecastRun:{current:0},api:{},forecast:[],forecastLoading:false}),called=[];let memo=null,prevDeps=null,inflight=0,max=0;
 c.useCallback=(f,deps)=>{if(!prevDeps||deps.some((x,i)=>x!==prevDeps[i])){memo=f;prevDeps=deps;}return memo;};
 c.setForecast=x=>c.forecast=x;c.setForecastLoading=x=>c.forecastLoading=x;
 c.api.cityForecast=async a=>{called.push(a);max=Math.max(max,++inflight);await new Promise(r=>setTimeout(r,5));inflight--;return{ok:true,events:[{start:a==='A'?20:10}]};};
 for(const names of [['A'],['A','B'],['B']]){c.cities=names.map(account=>({account}));called.length=0;const load=fn(forecastSrc,'loadForecast',c);await load();assert.deepEqual(called.sort(),[...names].sort());assert.deepEqual(plain(c.forecast.map(e=>e.account)).sort(),[...names].sort());}
 assert.equal(max,2);assert.equal(c.forecastLoading,false);
});
await test('stale forecast results do not overwrite newer city run',async()=>{
 const pending=new Map(),c=ctx({cities:[{account:'A'}],forecastRun:{current:0},api:{},forecast:[],forecastLoading:false,useCallback:f=>f});c.setForecast=x=>c.forecast=x;c.setForecastLoading=x=>c.forecastLoading=x;
 c.api.cityForecast=a=>new Promise(resolve=>pending.set(a,resolve));
 const old=fn(forecastSrc,'loadForecast',c)();c.cities=[{account:'B'}];const fresh=fn(forecastSrc,'loadForecast',c)();pending.get('B')({ok:true,events:[{start:1}]});await fresh;pending.get('A')({ok:true,events:[{start:0}]});await old;assert.deepEqual(plain(c.forecast.map(e=>e.account)),['B']);assert.equal(c.forecastLoading,false);
});
await test('removing all forecast cities clears old results/loading and invalidates an in-flight run',async()=>{
 const waiting=new Map(),c=ctx({cities:[{account:'A'}],cur:null,mode:'forecast',forecastRun:{current:0},api:{},forecast:[{account:'old',start:0}],forecastLoading:false,useCallback:f=>f});
 c.setForecast=x=>c.forecast=x;c.setForecastLoading=x=>c.forecastLoading=x;
 c.api.cityForecast=a=>new Promise(resolve=>waiting.set(a,resolve));
 c.loadLog=()=>{};c.loadForecast=fn(forecastSrc,'loadForecast',c);let cleanup;c.useEffect=f=>{cleanup=f();};
 const effect=block('  useEffect(() => {\n    if (cur) return;','  // ── реконструкция');
 run(effect,c);assert.equal(c.forecastLoading,true);cleanup();c.cities=[];run(effect,c);
 assert.equal(c.forecastLoading,false);assert.equal(c.forecast.length,0);
 waiting.get('A')({ok:true,events:[{start:1}]});await new Promise(r=>setTimeout(r,0));assert.equal(c.forecast.length,0);assert.equal(c.forecastLoading,false);
});
await test('child section updates preserve row identity when unchanged and remove locks after unlock',()=>{
 const rows=[{account:'A',unlockedSections:['start'],buildings:[]},{account:'B',unlockedSections:['start'],buildings:[]}];
 const c=ctx({useCallback:f=>f,latestStates:{current:{}},activeRef:{current:new Set()},rows});c.setRows=f=>c.rows=f(c.rows);
 const onMap=fn(block('  const onMap =','  const [touched,'),'onMap',c);
 onMap({account:'A',unlockedSections:['start']});assert.equal(c.rows,rows);
 onMap({account:'A',unlockedSections:null});assert.equal(c.rows,rows);
 onMap({account:'A',unlockedSections:['start','next']});assert.deepEqual(plain(c.rows[0].unlockedSections),['start','next']);assert.equal(c.rows[1],rows[1]);
 const updated=c.rows;onMap({account:'A',unlockedSections:['start','next']});assert.equal(c.rows,updated);
 onMap({account:'A',unlockedSections:['start']});assert.equal(c.rows,updated);assert.deepEqual(plain(c.rows[0].unlockedSections),['start','next']);
});
await test('global city events propagate sections including empty arrays; old events preserve known sections',()=>{
 const c=ctx({rows:[{account:'A',unlockedSections:['start'],buildings:[]}],useEffect:f=>f(),onServerEvent:(_name,callback)=>{c.event=callback;return()=>{};}});c.setRows=f=>c.rows=f(c.rows);
 run(block('  useEffect(() => onServerEvent<','  const [refreshing,'),c);
 c.event({account:'A',buildings:[{id:'new'}]});assert.deepEqual(plain(c.rows[0].unlockedSections),['start']);
 c.event({account:'A',buildings:[],unlockedSections:['start','next']});assert.deepEqual(plain(c.rows[0].unlockedSections),['start','next']);
 c.event({account:'A',buildings:[],unlockedSections:[]});assert.deepEqual(plain(c.rows[0].unlockedSections),[]);
});
console.log(`${results.length} regression scenarios passed (actual CityWorld handlers; controlled state/API, no game requests).`);
})().catch(e=>{console.error(e);process.exitCode=1;});
