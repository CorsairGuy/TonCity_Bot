'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const repo=require('node:path').resolve(__dirname,'../..');
const events=[],stream=[];
const liveModule={exports:{}};
vm.runInNewContext(fs.readFileSync(repo+'/src/utils/cityLive.js','utf8'),{
  module:liveModule,require:p=>{assert.equal(p,'../web/lib/panelEvents');return{emit:(type,payload)=>events.push({type,payload})};},
});
const live=liveModule.exports;
live.subscribe('A',{write:s=>stream.push(JSON.parse(s.slice(6)))});
live.broadcast('A',[{id:'bank'}],['start','new']);
assert.deepEqual(JSON.parse(JSON.stringify(events[0])),{type:'city',payload:{account:'A',buildings:[{id:'bank'}],unlockedSections:['start','new']}});
assert.deepEqual(stream[0],{buildings:[{id:'bank'}],unlockedSections:['start','new']});
live.broadcast('A',[],undefined);
assert.equal(Object.hasOwn(events[1].payload,'unlockedSections'),false);
live.broadcast('A',[],[]);
assert.deepEqual(JSON.parse(JSON.stringify(events[2].payload.unlockedSections)),[]);
live.broadcast('A',[],null);
assert.equal(Object.hasOwn(events[3].payload,'unlockedSections'),false);

// Execute the actual resync helper against mocked game/DB to cover a successful unlock
// followed by a failed refresh, without touching any live account or database.
const route=fs.readFileSync(repo+'/src/web/routes/cityStrategy.js','utf8');
const start=route.indexOf('  async function resyncSnapshot('),end=route.indexOf('  // живые обновления построек',start);
assert.ok(start>=0&&end>start);
const writes=[],broadcasts=[];
let saved={buildings:JSON.stringify([{id:'bank',x:1,y:1}]),unlocked_sections:JSON.stringify(['start'])};
const db={CitySnapshot:{
  async upsert(row){writes.push(row);saved={...saved,...row};},
  async update(row){writes.push(row);saved={...saved,...row};},
  async findOne(){return saved;},
}};
const resync=vm.runInNewContext('('+route.slice(start,end).trim()+')',{
  require:p=>{assert.equal(p,'../../db/index');return db;},
  logger:{info(){},warn(){}},cityLive:{broadcast:(...args)=>broadcasts.push(args)},
});
(async()=>{
  const result=await resync({get:async()=>{throw Error('simulated refresh timeout');}},'A',['start','new']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.unlockedSections)),['start','new']);
  assert.deepEqual(JSON.parse(saved.unlocked_sections),['start','new']);
  assert.deepEqual(JSON.parse(JSON.stringify(broadcasts[0])),['A',[{id:'bank',x:1,y:1}],['start','new']]);
  const fresh=await resync({get:async()=>({progress:{data:{buildings:[]},unlocked_sections:['start']}})},'A',['start','new']);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.unlockedSections)),['start','new']);
  const newer=await resync({get:async()=>({progress:{data:{buildings:[]},unlocked_sections:['start','concurrent']}})},'A',['start','new']);
  assert.deepEqual([...newer.unlockedSections].sort(),['concurrent','new','start']);
  const fallback=await resync({get:async()=>{throw Error('another timeout');}},'A',['start','new']);
  assert.deepEqual([...fallback.unlockedSections].sort(),['concurrent','new','start']);
  const oldSender=await resync({get:async()=>({progress:{data:{buildings:[]}}})},'A');
  assert.equal(oldSender.unlockedSections,null);
  assert.equal(Object.hasOwn(writes.at(-1),'unlocked_sections'),false);
  const client=fs.readFileSync(repo+'/src/web/client/src/pages/CityMapCity.tsx','utf8');
  const helperStart=client.indexOf('export function mergeUnlockedSections('),helperEnd=client.indexOf('export interface CityMapState',helperStart);
  const ts=require(repo+'/src/web/client/node_modules/typescript');
  const js=ts.transpileModule(client.slice(helperStart,helperEnd),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const context={exports:{}};vm.runInNewContext(js,context);
  const merge=context.exports.mergeUnlockedSections;
  const current=['start','new'];
  assert.equal(merge(current,['start']),current);
  assert.equal(merge(current,undefined),current);
  assert.deepEqual(JSON.parse(JSON.stringify(merge(current,['start','concurrent']))),['start','new','concurrent']);
  assert.deepEqual(JSON.parse(JSON.stringify(merge(null,[]))),[]);
  console.log('PASS: global/local SSE sections, unknown vs [], concurrent unlocks, failed refresh fallback and stale child snapshot');
})().catch(e=>{console.error(e);process.exitCode=1;});
