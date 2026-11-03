'use strict';
// Настоящие контракты и маршруты; без БД, токенов и игровых мутаций.
const assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),contract=require(path.join(root,'src/web/lib/championships'));
const base=()=>({config:{season:1,min_squad_size:2,max_squad_size:4,name_min_length:3,name_max_length:12},viewer:{user_id:10,squad_id:1,applied_squad_ids:[],is_guild_admin:false},squads:[{id:1,name:'One',leader_id:10,status:'forming',members:[{user_id:10,name:'A'},{user_id:20,name:'B'}],applications:[{user_id:30,name:'C'}]},{id:2,name:'Two',leader_id:40,status:'forming',members:[{user_id:40,name:'D'}]}]});
const cmd=(action,input={},data=base())=>contract.command(data,{action,squadId:1,...input});
assert.deepEqual(cmd('rename',{name:' New   Name '}),{path:'/championships/squads/1/rename',body:{name:'New Name'}});
assert.deepEqual(cmd('leader',{memberId:20}),{path:'/championships/squads/1/leader',body:{user_id:20}});
assert.equal(cmd('accept',{memberId:30}).path,'/championships/squads/1/applications/30/accept');
assert.equal(cmd('decline',{memberId:30}).path,'/championships/squads/1/applications/30/decline');
assert.equal(cmd('kick',{memberId:20}).path,'/championships/squads/1/members/20/kick');
assert.equal(cmd('submit').path,'/championships/squads/1/submit');
assert.equal(cmd('disband').path,'/championships/squads/1/disband');
for(const action of ['recall','approve','reject']){
 const d=base();d.squads[0].status='submitted';d.viewer.is_guild_admin=true;
 assert.equal(cmd(action,{},d).path,`/championships/squads/1/${action}`);
}
const d=base();d.viewer.is_guild_admin=true;
assert.deepEqual(cmd('move',{memberId:20,toSquadId:2},d),{path:'/championships/squads/1/members/20/move',body:{to_squad_id:2}});
d.squads[0].status='fielded';assert.equal(cmd('withdraw',{},d).path,'/championships/squads/1/withdraw');
const applicant=base();applicant.viewer={user_id:99,squad_id:null,applied_squad_ids:[],is_guild_admin:false};
assert.deepEqual(cmd('create',{name:' Team '},applicant),{path:'/championships/squads',body:{name:'Team'}});
assert.equal(cmd('apply',{},applicant).path,'/championships/squads/1/apply');
applicant.viewer.applied_squad_ids=[1];assert.equal(cmd('withdrawApplication',{},applicant).path,'/championships/squads/1/withdraw-application');
const member=base();member.viewer.user_id=20;assert.equal(cmd('leave',{},member).path,'/championships/squads/1/leave');
for(const action of ['rename','kick','leader','disband','submit','approve','reject','withdraw','move'])assert.throws(()=>cmd(action,{name:'Wrong',memberId:10,toSquadId:2},member));
member.squads[0].status='fielded';assert.throws(()=>cmd('leave',{},member));
assert.throws(()=>cmd('anything'),/Неизвестное/);assert.throws(()=>cmd('apply',{squadId:'1/../../'}),/неверное/);
assert.throws(()=>cmd('rename',{name:'xx'}),/Название/);assert.throws(()=>cmd('rename',{name:'x'.repeat(13)}),/Название/);
const full=base();full.config.max_squad_size=2;assert.throws(()=>cmd('accept',{memberId:30},full));
const small=base();small.config.min_squad_size=3;assert.throws(()=>cmd('submit',{},small));
const unknown=base();unknown.config=null;assert.throws(()=>cmd('submit',{},unknown),/правила/);
const future=base();future.squads[0].status='unknown';assert.throws(()=>cmd('disband',{},future));
console.log('PASS: exact paths/payloads, server config boundaries, viewer roles, roster state/size, invalid IDs/actions');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function main(){
 const handlers={},calls=[];let readData=applicant,readCount=0,postError=null,readErrorAfterPost=false,postDone=false,gate=null;
 const api={async get(p){calls.push(['get',p]);readCount++;if(readErrorAfterPost&&postDone)throw Error('refresh failed');return structuredClone(readData);},async post(p,b){calls.push(['post',p,b]);if(gate)await gate.promise;postDone=true;if(postError)throw postError;return structuredClone(readData);}};
 require(path.join(root,'src/web/routes/championships'))({get:(p,h)=>handlers['GET '+p]=h,post:(p,h)=>handlers['POST '+p]=h},{makeApiForAccount:async(id,opts)=>{assert.equal(id,7);assert.deepEqual(opts,{noLock:true});return api;}});
 const invoke=async(method,body={})=>{let status=200,payload;await handlers[method]({body,query:body},{status(n){status=n;return this;},json(d){payload=d;return this;}});return{status,payload};};
 let r=await invoke('GET /api/championships',{accountId:7});assert(r.payload.ok);assert.equal(r.payload.data.viewer.user_id,99);
 calls.length=0;gate=deferred();postDone=false;
 const first=invoke('POST /api/championships/action',{accountId:7,action:'create',name:'New'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await invoke('POST /api/championships/action',{accountId:7,action:'create',name:'Other'})).status,409);
 assert.equal((await invoke('POST /api/championships/action',{accountId:7,action:'create',name:'Third'})).status,409,'rejected duplicate must not release first request lock');
 gate.resolve();assert((await first).payload.ok);gate=null;
 assert.equal(calls.filter(c=>c[0]==='post').length,1);assert.equal(calls.filter(c=>c[0]==='get').length,2);
 // Ambiguous answer: one POST only, followed by GET, no blind retry.
 postDone=false;postError=Error('socket hang up');calls.length=0;
 r=await invoke('POST /api/championships/action',{accountId:7,action:'create',name:'New'});
 assert.equal(r.payload.ok,false);assert.equal(r.payload.resynced,true);assert.equal(calls.filter(c=>c[0]==='post').length,1);assert.equal(calls.at(-1)[0],'get');
 postError=null;postDone=false;readErrorAfterPost=true;
 r=await invoke('POST /api/championships/action',{accountId:7,action:'create',name:'New'});assert.equal(r.payload.ok,true);assert.equal(r.payload.needsRefresh,true);
 readErrorAfterPost=false;postDone=false;readData=member;calls.length=0;
 r=await invoke('POST /api/championships/action',{accountId:7,action:'leave',squadId:1,is_guild_admin:true});assert.equal(r.status,403);assert.equal(calls.filter(c=>c[0]==='post').length,0);
 readData=applicant;r=await invoke('POST /api/championships/action',{accountId:7,action:'create',name:'Again'});assert(r.payload.ok,'validation error must release owned lock');
 r=await invoke('POST /api/championships/action',{accountId:0,action:'create',name:'Again'});assert.equal(r.status,400);
 console.log('PASS: actual route fresh authorization, account operation lock, duplicate rejection, ambiguous POST resync, refresh failure and lock cleanup');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
