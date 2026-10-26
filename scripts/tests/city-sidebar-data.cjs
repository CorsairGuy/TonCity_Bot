'use strict';
// Исполняем настоящие загрузчики/цену очереди из CityMapCity без React DOM и игровых аккаунтов.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../..');
const ts=require(path.join(ROOT,'src/web/client/node_modules/typescript'));
const source=fs.readFileSync(path.join(ROOT,'src/web/client/src/pages/CityMapCity.tsx'),'utf8');
const ast=ts.createSourceFile('CityMapCity.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='CityMapCity');
assert(component);
const options={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020};
function compileExpression(node,context){return vm.runInNewContext(ts.transpileModule(`(${node.getText(ast)})`,{compilerOptions:options}).outputText,context);}
function effectContaining(text){
  let found;
  component.body.forEachChild(function visit(node){
    if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0].getText(ast).includes(text))found=node.arguments[0];
    node.forEachChild(visit);
  });
  assert(found,`Не найден эффект ${text}`);return found;
}
function callback(name){
  let found;
  component.body.forEachChild(function visit(node){
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found=node.initializer.arguments[0];
    node.forEachChild(visit);
  });
  assert(found,`Не найден callback ${name}`);return found;
}
function declaration(name,file=ast){const n=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(n,name);return n;}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function environment(embedded=true){
  const transitions=[],events=[],values={setRows:[{account:'A',unlockedSections:['start','new']}]};let lane=0,nextLane=0;
  const context={exports:{},account:'A',accountRef:{current:'A'},props:{slots:embedded?{}:undefined},
    startTransition:fn=>transitions.push(fn),computePolicyMultiplier:()=>1,fetch:()=>Promise.resolve({json:()=>Promise.resolve({coords:[{x:1,y:2}]})})};
  for(const name of [...source.matchAll(/\b(set[A-Z]\w*)\(/g)].map(m=>m[1])){
    context[name]=value=>{values[name]=typeof value==='function'?value(values[name]??0):value;events.push({name,value:values[name],lane});};
  }
  context.showFlash=(...args)=>events.push({name:'flash',value:args,lane});
  const jobs={};context.api={};
  for(const name of ['city','buildingsList','cityStrategy','policies','cityGuildBenefits','accounts','cityBuildCriteria','cityDiversity','cityResources','globalUpgradePlan','sections','cityBoosters','cityActionLog','cityForecast']){
    jobs[name]=deferred();context.api[name]=()=>jobs[name].promise;
  }
  context.allCounted=(ps,step)=>Promise.all(ps.map(p=>p.then(value=>{step();return value;})));
  vm.runInNewContext(ts.transpileModule(declaration('mergeUnlockedSections').getText(ast),{compilerOptions:options}).outputText,context);
  context.mergeUnlockedSections=context.exports.mergeUnlockedSections;
  return{context,jobs,events,values,transitions,flush(){while(transitions.length){lane=++nextLane;transitions.shift()();lane=0;}}};
}
function resolveInitial(e){
  const responses={city:{ok:true,rows:[{account:'A',buildings:[],unlockedSections:['start']}]},buildingsList:{ok:true,buildings:[]},cityStrategy:{ok:true,targets:[],queue:[]},policies:{ok:true,byAccount:{}},cityGuildBenefits:{ok:true,building_purchases_discount:0,upgrades_discount:0,income_boost:0},accounts:{ok:true,accounts:[{name:'A',balance:12}]},cityBuildCriteria:{ok:true,criteria:{}},cityDiversity:{ok:true,income_bonus:0}};
  for(const [name,value] of Object.entries(responses))e.jobs[name].resolve(value);
}
async function main(){
  for(const embedded of [true,false]){
    const e=environment(embedded);compileExpression(effectContaining('allCounted('),e.context)();e.events.length=0;
    resolveInitial(e);await tick();assert.equal(e.events.length,0,'Ответ применился обычным обновлением');
    e.flush();assert(e.events.length);assert(e.events.every(x=>x.lane>0));
    assert.equal(e.values.setLoading,false);assert.equal(e.values.setBalance,12);
    assert.deepEqual(JSON.parse(JSON.stringify(e.values.setRows[0].unlockedSections)),['start','new']);
    assert.equal(e.events.filter(x=>x.name==='setDataDone').length,embedded?0:9);
    const done=e.events.find(x=>x.name==='setLoading'&&x.value===false);
    assert.equal(done.lane,e.events.find(x=>x.name==='setRows').lane,'Данные и готовность ушли разными обновлениями');
  }
  {
    const e=environment(false),cleanup=compileExpression(effectContaining('allCounted('),e.context)();e.events.length=0;
    resolveInitial(e);await tick();assert(e.transitions.length);cleanup();e.flush();assert.equal(e.events.length,0,'Отменённый ответ применился после смены города');
  }
  {
    const e=environment();compileExpression(effectContaining('allCounted('),e.context)();e.events.length=0;
    e.jobs.city.reject(Error('load failed'));await tick();assert.equal(e.events.length,0);e.flush();
    assert.match(e.values.setLoadErr,/load failed/);assert.equal(e.values.setLoading,false);assert(e.events.every(x=>x.lane>0));
  }
  for(const [name,apiName,data] of [['loadResources','cityResources',{ok:true,components:3,masterplans:4}],['loadBoosters','cityBoosters',{ok:true,boosters:[],active:[],queue:[]}],['loadActionLog','cityActionLog',{ok:true,rows:[]}],['loadForecast','cityForecast',{ok:true,events:[]}]]){
    for(const stale of [false,true]){
      const e=environment();compileExpression(callback(name),e.context)();e.events.length=0;
      e.jobs[apiName].resolve(data);await tick();assert.equal(e.events.length,0);if(stale)e.context.accountRef.current='B';e.flush();
      assert.equal(e.events.length>0,!stale,`${name}: проверка актуального аккаунта`);assert(e.events.every(x=>x.lane>0));
    }
  }
  for(const [needle,apiName,data] of [['api.globalUpgradePlan()','globalUpgradePlan',{ok:true,plan:[]}],['api.sections()','sections',{ok:true,sections:[]}]]){
    const e=environment(),cleanup=compileExpression(effectContaining(needle),e.context)();e.jobs[apiName].resolve(data);await tick();
    assert.equal(e.events.length,0);cleanup();e.flush();assert.equal(e.events.length,0);
  }
  for(const [name,apiName,loading] of [['loadBoosters','cityBoosters','setBoostersLoading'],['loadActionLog','cityActionLog','setActionLogLoading'],['loadForecast','cityForecast','setForecastLoading']]){
    const e=environment();compileExpression(callback(name),e.context)();e.events.length=0;e.jobs[apiName].reject(Error('tab failure'));await tick();assert.equal(e.events.length,0);e.flush();
    assert.equal(e.values[loading],false);assert.equal(e.events.filter(x=>x.name==='flash').length,1);assert(e.events.every(x=>x.lane>0));
  }
  console.log('PASS: actual initial/tab/resource loaders use transitions, embedded progress stays silent, data+ready atomic, stale results cancelled');
  const stats={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ROOT,'src/web/client/src/cityStats.ts'),'utf8'),{compilerOptions:options}).outputText,stats);
  const pricesContext={exports:{},upgradeStep:stats.exports.upgradeStep};
  vm.runInNewContext(ts.transpileModule(declaration('manualQueuePricesFor').getText(ast),{compilerOptions:options}).outputText,pricesContext);
  const actual=pricesContext.exports.manualQueuePricesFor;
  function original(queue,owned,map,mult){return queue.map((q,i)=>{const b=owned.find(o=>o.x===q.x&&o.y===q.y),info=b?map.get(b.id):undefined;if(!b||!info)return null;return Math.round(stats.exports.upgradeStep(info,(Number(b.level)||0)+queue.slice(0,i).filter(p=>p.x===q.x&&p.y===q.y).length)*mult);});}
  const map=new Map([['bank',{id:'bank',base_price:13}],['COM_grand_arcanum_2_star.png',{id:'COM_grand_arcanum_2_star.png',base_price:17}]]);
  const owned=[{id:'bank',x:1,y:1,level:'3'},{id:'COM_grand_arcanum_2_star.png',x:2,y:1,level:2},{id:'missing',x:3,y:1,level:4},{id:'missing',x:1,y:1,level:100}];
  let seed=1024;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let n=0;n<128;n++){
    const queue=Array.from({length:n},()=>({x:1+rand()%5,y:1})),mult=n%2?0.73:1;
    assert.deepEqual(Array.from(actual(queue,owned,map,mult)),original(queue,owned,map,mult));
  }
  const queue=Array.from({length:10000},()=>({x:1,y:1}));
  queue.slice=()=>{throw Error('Quadratic queue scan');};owned.find=()=>{throw Error('Repeated owned scan');};
  assert.equal(actual(queue,owned,map,1).length,10000);
  console.log('PASS: real queue price helper matches original including repeats, missing catalog/coordinates and first duplicate building; large queue avoids repeated scans');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
