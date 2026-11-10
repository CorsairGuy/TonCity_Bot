'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const read=p=>fs.readFileSync(path.join(root,p),'utf8'),world=read('src/web/client/src/pages/CityWorld.tsx'),canvas=read('src/web/client/src/components/CityActionsCanvas.tsx');
const slice=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const code=s=>esbuild.transformSync(s,{loader:'tsx',jsx:'transform',format:'cjs'}).code;
const loadSrc=slice(world,'  const load = useCallback','  useEffect(() => { load(); }');
const source={rows:[{account:'A'}],order:['A']};
async function scenario(fail){
 let release;const gate=new Promise(r=>release=r),calls=[];
 const ctx={useCallback:f=>f,startTransition:f=>f(),Promise,Error,String,Object,
  api:{cityWorld:async()=>fail==='snapshot'?{ok:false,error:'snapshot failed'}:{ok:true,...source},buildingsList:async()=>{await gate;return{ok:fail!=='catalog',buildings:[]};},globalUpgradePlan:async()=>({ok:true,plan:[]}),sections:async()=>({ok:true,sections:[]}),policies:async()=>({ok:true,byAccount:{}})}};
 for(const name of ['DataPending','LoadErr','Rows','Order','Catalog','GlobalPlan','Sections','Cabinets','Loaded','ResourcesLoaded'])ctx['set'+name]=v=>calls.push([name,v]);
 const load=vm.runInNewContext(code(loadSrc)+';load',ctx),pending=load();await Promise.resolve();assert(!calls.some(([name])=>name==='Rows'));release();await pending;
 if(fail){assert(calls.some(([n,v])=>n==='LoadErr'&&v));assert(!calls.some(([n])=>n==='Rows'));}
 else{assert.deepEqual(calls.find(([n])=>n==='Rows')[1],source.rows);assert(calls.some(([n,v])=>n==='ResourcesLoaded'&&v===true));assert.deepEqual(calls.at(-1),['DataPending',false]);}
}
(async()=>{
 await scenario(null);await scenario('snapshot');await scenario('catalog');
 // Сигнал готовности передаётся существующим loader effect, а не в render Canvas.
 let ready=false,interval,cleared=0;const callbacks=[],effects=[];
 const ctx={React:{createElement:()=>({})},Box:()=>null,MapLoader:()=>null,useRef:x=>({current:x}),useState:f=>[f(),()=>{}],useEffect:f=>effects.push(f),setInterval:f=>(interval=f,1),clearInterval:()=>cleared++};
 const overlay=vm.runInNewContext(code(slice(canvas,'function MapLoadOverlay(','export function CityActionsCanvas'))+';MapLoadOverlay',ctx);
 overlay({tick:()=>ready?null:{pct:.5,text:'Sprites'},runKey:'main',onState:s=>callbacks.push(s)});assert.equal(callbacks.length,0);
 effects[0]();assert.equal(callbacks[0].pct,.5);ready=true;interval();assert.equal(callbacks.at(-1),null);assert.equal(cleared,1);
 assert.match(world,/useState\(false\);\n  const \[startupProgress/);assert.match(world,/data-map-startup-content aria-hidden=\{!startupReady\}/);assert.match(world,/data-map-sidebar/);
 console.log('PASS atomic startup data, snapshot/catalog errors, first-frame callback after effect, initially hidden center and separate sidebar');
})().catch(e=>{console.error(e);process.exitCode=1;});
