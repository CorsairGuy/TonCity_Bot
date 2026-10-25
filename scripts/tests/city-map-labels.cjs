'use strict';
// Реальные функции Canvas: корректность бейджей, линейная работа и отсутствие лишней инвалидации.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/components/CityActionsCanvas.tsx'),'utf8');
function block(start,end){const a=src.indexOf(start),b=src.indexOf(end,a);assert(a>=0&&b>a,start);return src.slice(a,b);}
function execute(code,extra={}){const c=vm.createContext({Map,Set,...extra});vm.runInContext(esbuild.transformSync(code,{loader:'ts',target:'es2022'}).code,c);return c;}
const helpers=block('function buildMapLabels(', '// сколько карта ждёт ночной набор');
const c=execute(helpers+'\nthis.build=buildMapLabels; this.same=sameMapLabels;');
function oldLabel(b,type,queue,targets,globalPlan){
  if(!b.level)return null;
  const upgradable=type==='capital'?b.is_upgradable===true:!b.id.startsWith('SPE_');
  if(!upgradable)return null;
  const n=queue.filter(q=>q.x===b.x&&q.y===b.y).length,levels=[b.level];
  if(n>0)levels.push(b.level+n);
  const personal=targets.find(t=>t.x===b.x&&t.y===b.y);
  const target=personal?.target_level??globalPlan.find(g=>g.family_id===b.id)?.target_level;
  if(target&&target>levels[levels.length-1])levels.push(target);
  return levels.join('-');
}
function check(buildings,type,queue=[],targets=[],global=[]){
  const expected=new Map(buildings.map(b=>[`${b.x}_${b.y}`,oldLabel(b,type,queue,targets,global)]));
  const result=c.build(buildings,type,queue,targets,global);assert.deepEqual([...result],[...expected]);return result;
}
const buildings=[
  {id:'RES_A',x:0,y:0,level:19},{id:'RES_A',x:1,y:0,level:20},
  {id:'SPE_A',x:2,y:0,level:5},{id:'RES_A',x:3,y:0,level:0},
  {id:'RES_B',x:-3,y:12,level:1},{id:'RES_A',x:4,y:0,level:5,is_upgradable:true},
  {id:'RES_A',x:5,y:0,level:5,is_upgradable:false},{id:'RES_A',x:6,y:0,level:5,is_upgradable:1},
];
const queue=[{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:1,y:0},{x:-3,y:12},{x:900,y:900}];
const targets=[{x:0,y:0,target_level:25},{x:0,y:0,target_level:99},{x:1,y:0,target_level:20},
  {x:4,y:0,target_level:0},{x:-3,y:12,target_level:null}];
const global=[{family_id:'RES_A',target_level:30},{family_id:'RES_A',target_level:100},{family_id:'RES_B',target_level:4}];
const city=check(buildings,'city',queue,targets,global);
assert.equal(city.get('0_0'),'19-22-25');assert.equal(city.get('1_0'),'20-21');
assert.equal(city.get('2_0'),null);assert.equal(city.get('3_0'),null);assert.equal(city.get('4_0'),'5');assert.equal(city.get('-3_12'),'1-2-4');
check(buildings,'capital',queue,targets,global);check([],'city');check([buildings[0],{...buildings[0],level:30}],'city',queue,targets,global);
// Независимые случайные данные с дубликатами проверяют старую find/filter-семантику.
let seed=178;function random(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
for(let round=0;round<100;round++){
  const bs=Array.from({length:80},(_,i)=>({id:(i%7?'RES_':'SPE_')+random(5),x:random(30)-15,y:random(30)-15,level:random(30),is_upgradable:random(3)===0}));
  const qs=Array.from({length:200},()=>({x:random(30)-15,y:random(30)-15}));
  const ts=Array.from({length:120},()=>({x:random(30)-15,y:random(30)-15,target_level:random(40)}));
  const gs=Array.from({length:20},()=>({family_id:'RES_'+random(5),target_level:random(40)}));
  check(bs,round%2?'city':'capital',qs,ts,gs);
}
console.log('PASS labels: queue multiplicity, first personal/global target, priority, special/capital buildings, duplicates, 100 seeded fixtures');
// Бюджет чтений зависит от числа входных записей, а не произведения buildings×plans.
const n=6000;let reads=0;const maxReads=20*n;
function row(x){return{get x(){assert(++reads<=maxReads,'Превышен линейный бюджет чтений');return x;},get y(){assert(++reads<=maxReads);return 0;}};}
const bs=Array.from({length:n},(_,x)=>({...row(x),id:'RES_A',level:1}));
const qs=Array.from({length:n},(_,x)=>row(x));
const ts=Array.from({length:n},(_,x)=>Object.assign(row(x),{target_level:3}));
reads=0;const large=c.build(bs,'city',qs,ts,[{family_id:'RES_A',target_level:4}]);
assert.equal(large.size,n);assert.equal(large.get('0_0'),'1-2-3');assert.equal(large.get(`${n-1}_0`),'1-2-3');assert(reads<=maxReads);
console.log(`PASS linear work: ${n} buildings + ${n} queue entries + ${n} targets, ${reads} coordinate reads`);
const old=new Map([['A',null],['B','1-2']]);assert(c.same(old,new Map([['B','1-2'],['A',null]])));
assert(!c.same(old,new Map([['A',null],['C','1-2']])));assert(!c.same(old,new Map([['A',null],['B','1-3']])));
const rebuild=block('  function rebuildLabels()', '  function drawTile(');
const state={current:{blist:buildings,type:'city',queue,targets,globalPlan:global,labels:city,labelsDirty:true}};
const d=execute(helpers+rebuild+'\nthis.rebuild=rebuildLabels;', {state});
assert.equal(d.rebuild(),false);assert.equal(state.current.labels,city);assert.equal(state.current.labelsDirty,false);
state.current.queue=[...queue,{x:0,y:0}];state.current.labelsDirty=true;
assert.equal(d.rebuild(),true);assert.equal(state.current.labels.get('0_0'),'19-23-25');
console.log('PASS same labels retain identity; changed queue updates actual Canvas labels');
const redrawLabels=block('    // стройка закончилась по времени', '    // масштаб кусков:');
const invalidations=[];state.current.nextEndMs=Infinity;state.current.labelsDirty=true;
const redrawContext=vm.createContext({state,rebuildLabels:d.rebuild,listChanged:full=>invalidations.push(full)});
vm.runInContext(esbuild.transformSync(`const s=state.current;${redrawLabels}`,{loader:'ts'}).code,redrawContext);
assert.equal(invalidations.length,0,'Неизменившиеся бейджи пересобрали draw-list');
state.current.targets=[{x:0,y:0,target_level:31},...targets];state.current.labelsDirty=true;
vm.runInContext(esbuild.transformSync(`{const s=state.current;${redrawLabels}}`,{loader:'ts'}).code,redrawContext);
assert.deepEqual(invalidations,[false]);
console.log('PASS unchanged labels skip actual redraw invalidation; new target invalidates');

// Выполняются именно эффекты Canvas, с записью их зависимостей и запросов перерисовки.
const effects=block('  useEffect(() => { listChanged(false); }, [mode]);','  // пелена:');
const dimSource=src.match(/^const DIM_INAPPLICABLE_MODES = .*$/m);assert(dimSource);
const dim=execute(dimSource[0]+'\nthis.modes=DIM_INAPPLICABLE_MODES;').modes;
const callbacks=[],dirty=[],redraw=[];
const e=execute(effects,{state:{current:{labelsDirty:false}},mode:'view',validSet:new Set(),lockedCells:new Map(),pickedSet:new Set(),targets:[],queue:[],globalPlan:[],
  DIM_INAPPLICABLE_MODES:dim,useEffect:(fn,deps)=>callbacks.push({fn,deps}),listChanged:x=>dirty.push(x),requestRedraw:()=>redraw.push(1)});
callbacks[1].fn();assert.equal(dirty.length,0,'validSet затронул неподвижную картинку в Просмотре');
for(const mode of ['view','build','move','boosters','log','forecast']){e.mode=mode;callbacks[1].fn();assert.equal(dirty.length,0);}
for(const mode of ['upgrade','queue','reconstruct','renovate','skip']){e.mode=mode;callbacks[1].fn();}
assert.equal(dirty.length,5);
callbacks[3].fn();assert.equal(e.state.current.labelsDirty,false,'Выделение запустило пересчёт бейджей');
callbacks[4].fn();assert.equal(e.state.current.labelsDirty,true);
console.log('PASS validSet only invalidates applicable modes; pickedSet redraw does not rebuild labels');
