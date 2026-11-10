'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const base=path.resolve(__dirname,'../../src/web/client');
const ts=require(path.join(base,'node_modules/typescript'));
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(base,'src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const sources=[],timers=[],events=[];
class FakeEventSource{static CLOSED=2;constructor(){sources.push(this);this.listeners={};}addEventListener(type,fn){this.listeners[type]=fn;}}
const connector={exports:{}};
vm.runInNewContext(compile('serverEventsConnect.ts'),{module:connector,exports:connector.exports,EventSource:FakeEventSource,setTimeout:(fn,ms)=>timers.push({fn,ms}),Date});
connector.exports.connect((type,data)=>events.push({type,data}));
sources[0].onopen();assert.equal(events.at(-1).type,'connection');
sources[0].listeners['civic-draw']({data:'{"account":"A"}'});assert.equal(events.at(-1).data.account,'A');
sources[0].readyState=2;sources[0].onerror();assert.equal(timers[0].ms,2000);timers.shift().fn();sources[1].onopen();assert.equal(events.filter(e=>e.type==='connection').length,2);
let broadcast;const self={};
vm.runInNewContext(compile('serverEvents.worker.ts'),{exports:{},require:()=>({connect:fn=>broadcast=fn}),self,Set,Map});
const messages=[];const port=()=>({start(){},postMessage:m=>messages.push(m)});
self.onconnect({ports:[port()]});broadcast('connection',{});broadcast('civic-draw',{account:'A'});messages.length=0;self.onconnect({ports:[port()]});assert.equal(messages.length,0,'new tabs must not replay stale draw/connection events');
// Execute actual readiness predicate, including the five-second safety margin.
const source=fs.readFileSync(path.join(base,'src/pages/CivicDraw.tsx'),'utf8');
const predicate=source.slice(source.indexOf('export function canCollectRewards'),source.indexOf('\nfunction timeLeftText'));
const scope={exports:{}};vm.runInNewContext(ts.transpileModule(predicate,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,scope);
const can=scope.exports.canCollectRewards,now=Date.now(),row={claimable:false,timer_source:'server',ready_at:new Date(now).toISOString(),grants:[]};
assert.equal(can(row,now+4999),false);assert.equal(can(row,now+5000),true);assert.equal(can({...row,timer_source:'forecast'},now+6000),false);assert.equal(can({...row,ready_at:null,grants:[{ready:1}]},now),true);
console.log('PASS SSE reconnect notifications, SharedWorker no stale replay, exact timer grace and policy-only collection readiness');
