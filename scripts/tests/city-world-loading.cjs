'use strict';
// Реальные участки CityWorld: просмотр без редактора, стабильность Sets и следование камеры.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/pages/CityWorld.tsx'),'utf8');
function block(a,b){const i=src.indexOf(a),j=src.indexOf(b,i);assert(i>=0&&j>i,a);return src.slice(i,j);}
function context(extra={}){return vm.createContext({Set,Map,JSON,Promise,...extra});}
function run(s,c){return vm.runInContext(esbuild.transformSync(s,{loader:'ts',target:'es2022'}).code,c);}
function fn(s,name,c){return run(`(()=>{${s};return ${name};})()`,c);}
const hook=block('function useStableMapSet','// Просмотру хватает');
const ref={current:undefined},c=context({useRef:v=>{if(ref.current===undefined)ref.current=v;return ref;}}),stable=fn(hook,'useStableMapSet',c);
const initial=new Set(['a','b']);assert.equal(stable(initial),initial);assert.equal(stable(new Set(['b','a'])),initial);
const changed=new Set(['b','c']);assert.equal(stable(changed),changed);assert.equal(stable(null),null);
const empty=new Set();assert.equal(stable(empty),empty);assert.equal(stable(new Set()),empty);assert.equal(stable(null),null);
console.log('PASS: равные наборы сохраняют ссылку; изменения, пустой Set и null различаются');
const mountedSrc=block('  const mounted = useMemo','  const mountedKey');
function mounted(extra={}){
 const c=context({cur:'A',mode:'view',statsByCity:new Map([['A',{}]]),touched:[],states:{},latestStates:{current:{}},offOf:new Map([['A',{}],['B',{}]]),rows:[],useMemo:f=>f(),...extra});
 const list=run(`(()=>{${mountedSrc};return mounted;})()`,c);return Array.from(list);
}
assert.deepEqual(mounted(),[]);assert.deepEqual(mounted({mode:'upgrade'}),['A']);
assert.deepEqual(mounted({statsByCity:new Map()}),['A']);
assert.deepEqual(mounted({touched:['B']}),['B']);assert.deepEqual(mounted({states:{A:{draft:true},B:{draft:true}}}),['A','B']);
assert.deepEqual(mounted({states:{A:{draft:false}},latestStates:{current:{A:{draft:true,mode:'view'}}}}),['A']);
assert.deepEqual(mounted({latestStates:{current:{A:{draft:false,mode:'queue'}}}}),['A']);
assert.deepEqual(mounted({latestStates:{current:{A:{draft:false,mode:'view'}}}}),[]);
assert.deepEqual(mounted({cur:null,mode:'queue',rows:[{account:'B',queue:[{}]}]}),['B']);
const warmSrc=block('  const withWarm =','  const withWarmKey');
for(const mode of ['view','queue']){
 const c=context({mode,warm:'B',offOf:new Map([['B',{}]]),mounted:[]});
 assert.deepEqual(Array.from(run(`(()=>{${warmSrc};return withWarm;})()`,c)),mode==='view'?[]:['B']);
}
console.log('PASS: просмотр не монтирует редактор/предзагрузку; действия, черновики, очередь и fallback сохранены');
const onViewSrc=block('  const onView =','  useEffect(() => () => clearTimeout(viewTimer.current)');
for(const [mode,clicked,overview,expected] of [['view',null,false,1],['queue',null,false,0],['view','A',false,0],['view',null,true,0]]){
 const calls=[],timers=[],c=context({useCallback:f=>f,viewRef:{current:null},cameraMoving:{current:false},viewTimer:{current:null},modeRef:{current:mode},clickedCity:{current:clicked},overviewFlight:{current:overview},settleView:{current:idle=>calls.push(idle)},startTransition:f=>f(),clearTimeout(){},setTimeout(f,ms){timers.push([f,ms]);return 1;}});
 const onView=fn(onViewSrc,'onView',c),view={cx:1,cy:2,tile:3,W:100,H:100};onView(view);
 assert.equal(c.viewRef.current,view);assert.equal(c.cameraMoving.current,true);assert.equal(calls.length,expected);
 if(expected)assert.equal(calls[0],false);assert.equal(timers[0][1],140);timers[0][0]();assert.equal(calls.at(-1),undefined);
}
console.log('PASS: готовые показатели следуют за движением сразу; действия и наезд по клику ждут завершения');
const settleSrc=block('  settleView.current =','  const onView =');
{
 const choices=[],warms=[],c=context({settleView:{current:null},cameraMoving:{current:true},overviewFlight:{current:false},viewRef:{current:{cx:1,cy:1,tile:3,W:100}},SPAN:22,ENTER_SHARE:.5,LEAVE_SHARE:.42,WARM_SHARE:.3,modeRef:{current:'view'},shareRef:{current:0},centreRef:{current:null},clickedCity:{current:null},movingRef:{current:null},curRef:{current:null},curAuto:{current:false},nearestCity:()=>0,cities:[{account:'A'}],setWarm:a=>warms.push(a),choose:(...args)=>choices.push(args)});
 run(settleSrc,c);c.settleView.current(false);assert.equal(c.cameraMoving.current,true);assert.deepEqual(choices,[['A',true]]);assert.equal(warms.length,0);
 c.settleView.current();assert.equal(c.cameraMoving.current,false);
}
console.log('PASS: обновление просмотра не объявляет движущуюся камеру неподвижной и не запускает загрузку');
const goAllSrc=block('  const goAll =','  const goAllRef =');
{
 const calls=[],c=context({clickedCity:{current:'A'},overviewFlight:{current:false},choose:(...args)=>calls.push(args),zoomedIn:()=>true,lookAll:animate=>calls.push(animate)});
 fn(goAllSrc,'goAll',c)();assert.equal(c.clickedCity.current,null);assert.equal(c.overviewFlight.current,true);assert.deepEqual(calls,[[null,false],true]);
}
console.log('PASS: «Все города» блокирует повторный выбор города на промежуточных кадрах отъезда');

const reloadSrc=block('  const reloadSnapshot =','  const load =');
const refreshSrc=block('  const refresh = async () => {','  return <><CityHead');
(async()=>{
 {
  const changes=[],c=context({useCallback:f=>f,api:{cityWorld:async()=>({ok:false,error:'world failed'})},startTransition:f=>f(),setRows:r=>changes.push(r),setOrder:r=>changes.push(r),setLoadErr:r=>changes.push(r),setLoaded:r=>changes.push(r)});
  await assert.rejects(fn(reloadSrc,'reloadSnapshot',c)(),/world failed/);assert.equal(changes.length,0);
 }
 for(const ok of [true,false]){
  const sent=[],errors=[],busy=[],updated=[],c=context({props:{name:'A'},api:{cityRefresh:async a=>{sent.push(a);return{ok,error:'failed'};}},onUpdated:async()=>updated.push(true),setError:e=>errors.push(e),setRefreshing:b=>busy.push(b)});
  await fn(refreshSrc,'refresh',c)();assert.deepEqual(sent,['A']);assert.deepEqual(busy,[true,false]);assert.equal(updated.length,ok?1:0);assert.equal(errors.at(-1),ok?'':'failed');
 }
 console.log('PASS: кнопка обновления snapshot-панели обновляет выбранный город и показывает ошибку');
})().catch(e=>{console.error(e);process.exitCode=1;});

// Стабильный callback редактора читает актуальное действие, а не замыкание первого render.
{
 const calls=[],ref={current:()=>calls.push('old')};
 const callbackSrc=block('  const editorBack =','  const selectPanel =');
 const callback=fn(callbackSrc,'editorBack',context({useCallback:f=>f,goAllRef:ref}));
 callback();ref.current=()=>calls.push('new');callback();assert.deepEqual(calls,['old','new']);
}
console.log('PASS: memo-редактор сохраняет живой callback возврата без повторного render от публикации модели');

{
 let reads=0;const tip={style:{}},box={getBoundingClientRect:()=>{reads++;return{left:10,top:20};}};
 const code=block('  const onMapMouse =','  useEffect(() => {\n    if (!hoverCity');
 for(const mode of ['view','queue','log','forecast','demolish','build']){
  const move=fn(code,'onMapMouse',context({mode,buildHover:'A',buildFamily:'b',buildInfo:new Map([['A',{}]]),tipRef:{current:tip},mapBoxRef:{current:box}}));
  move({clientX:30,clientY:40});assert.equal(reads,mode==='build'?1:0);
 }
 assert.equal(tip.style.transform,'translate(36px, 36px)');
}
console.log('PASS: скрытая строительная подсказка не читает layout во время свайпа других вкладок');
