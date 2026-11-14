'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const mutation=require(path.join(root,'src/utils/cityMutation'));
const data={target:[{account:'A',x:1,y:2,target_level:20}],recon:[{account:'A',x:1,y:2}],queue:[{account:'A',x:1,y:2,pos:0},{account:'A',x:1,y:2,pos:1}]};
function model(key){
 const matches=(r,w)=>Object.entries(w).every(([k,v])=>r[k]===v);
 const wrap=r=>({...r,update:async v=>Object.assign(r,v)});
 return {findOne:async({where})=>{const r=data[key].find(r=>matches(r,where));return r&&wrap(r);},findAll:async({where})=>data[key].filter(r=>matches(r,where)).map(wrap),destroy:async({where})=>{data[key]=data[key].filter(r=>!matches(r,where));}};
}
const db={seq:{transaction:async fn=>fn({})},CityUpgradeTarget:model('target'),CityReconstructPlan:model('recon'),CityUpgradeQueue:model('queue')};
const plansCtx={module:{exports:{}},require:()=>db};vm.runInNewContext(read('src/db/cityPlans.js'),plansCtx);
const plans=plansCtx.module.exports;
(async()=>{
 assert.equal(await plans.moveCell('A',{x:1,y:2},{x:1004,y:5}),4);
 assert.equal(data.target[0].target_level,20);assert.deepEqual(data.queue.map(r=>r.pos),[0,1]);
 for(const rows of Object.values(data))for(const row of rows){assert.equal(row.x,1004);assert.equal(row.y,5);}
 const src=read('src/web/routes/cityStrategy.js'),start=src.indexOf("  app.post('/api/city-actions/:account/move'");
 const route=src.slice(start,src.indexOf('  // ── Снос',start));
 for(const fail of [false,true]){
  const events=[];let handler;
  const ctx={app:{post:(_,fn)=>handler=fn},findAccountByName:async()=>({id:1,name:'A'}),makeApiForAccount:async()=>({post:async()=>{events.push('POST');return {coins:1};}}),resyncSnapshot:async()=>events.push('resync'),logAction:async()=>events.push('log'),logger:{error:()=>{}},require:name=>name.endsWith('cityMutation')?mutation:name.endsWith('cityPlans')?{moveCell:async()=>{events.push('plans');if(fail)throw Error('DB failed');}}:{wake:()=>events.push('wake')}};
  vm.runInNewContext(route,ctx);
  let status=200,result;const res={status:n=>{status=n;return res;},json:r=>result=r};
  await handler({body:{from:{x:1,y:2},to:{x:1004,y:5}},params:{account:'A'}},res);
  assert.equal(events.filter(e=>e==='POST').length,1);assert(events.indexOf('plans')<events.indexOf('resync'));
  assert.equal(result.ok,!fail);assert.equal(status,fail?500:200);
 }
 // Перемещение, уже запущенный апгрейд и независимые города.
 let release;const gate=new Promise(r=>release=r),events=[];
 const oldRevision=mutation.revision('race');
 const move=mutation.run('race',async()=>{mutation.changed('race');events.push('move');await gate;mutation.changed('race');});
 const upgrade=mutation.run('race',async()=>{assert.notEqual(mutation.revision('race'),oldRevision);events.push('stale skipped');});
 await mutation.run('other',async()=>events.push('other'));
 assert.deepEqual(events,['move','other']);release();await Promise.all([move,upgrade]);assert.equal(events.at(-1),'stale skipped');
 // Настоящий планировщик не отправляет специальные здания из старой очереди/цели.
 const progress=read('src/modules/progress.js'),a=progress.indexOf('function pickStrategyTargets('),b=progress.indexOf('\nfunction ',a+1);
 const pick=vm.runInNewContext(progress.slice(a,b)+'\n;pickStrategyTargets',{fmt:String,upgradeStep:()=>1,upgradeDuration:()=>1});
 const buildings=[{id:'SPE_federal_reserve.png',x:7,y:12,level:1},{id:'SPE_fortune_pavilion.png',x:7,y:13,level:1},{id:'RES_test.png',x:1,y:1,level:1}];
 buildings.push({id:'SPE_future_unknown.png',x:8,y:8,level:1});
 const bankIds=['COM_bank.png','COM_bank_1_star.png','COM_bank_2_star.png','COM_bank_3_star.png'];
 buildings.push(...bankIds.map((id,i)=>({id,x:2,y:i,level:1})));
 const definitions=JSON.parse(read('config/buildings.txt'));
 const catalog=new Map(definitions.map(b=>[b.id,b]));
 catalog.set('RES_test.png',{category:'residential'});
 // Новый SPE_ должен блокироваться даже при неверной категории каталога.
 catalog.set('SPE_future_unknown.png',{category:'commercial'});
 const result=pick(buildings,buildings,buildings.map(b=>({...b,target_level:20})),catalog,0,1,10,100);
 assert.deepEqual(Array.from(result.picked,b=>b.id).sort(),['RES_test.png',...bankIds].sort());
 const targetsOnly=pick(buildings,[],buildings.map(b=>({...b,target_level:20})),catalog,0,1,10,100);
 assert.deepEqual(Array.from(targetsOnly.picked,b=>b.id).sort(),['RES_test.png',...bankIds].sort());
 // Выполняем настоящий callback отправки: отменённая пачка не тратит очередь.
 const cbStart=progress.indexOf('        const ok=await runProgressAction(name,');
 const cb=progress.slice(cbStart,progress.indexOf('        if(ok){',cbStart));
 for(const stale of [false,true]){
  const calls=[],account='callback'+stale,rev=mutation.revision(account);
  if(stale)mutation.changed(account);
  const c={guildBonuses:{current:()=>({revision:0})},batchGuildRevision:0,cityMutation:mutation,name:account,b:{id:'RES_test.png',x:1,y:2,level:1},nextLvl:2,mapRevision:rev,
   runProgressAction:async(_,__,fn)=>{try{await fn();return true;}catch{return false;}},sleep:async()=>{},
   api:{post:async()=>{calls.push('POST');return {coins:1};}},logger:{info:()=>{}},consumedQueueKeys:['1,2'],persistQueue:async()=>calls.push('consume')};
  const ok=await vm.runInNewContext('(async()=>{'+cb+';return ok;})()',c);
  assert.equal(ok,!stale);assert.deepEqual(calls,stale?[]:['POST','consume']);
 }
 console.log('PASS move transfers targets/reconstruction/repeated queue; persistence failure surfaced without POST retry; per-city serialization/revisions; specials excluded');
})().catch(e=>{console.error(e);process.exitCode=1;});
