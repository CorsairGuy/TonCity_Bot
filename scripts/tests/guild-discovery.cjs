'use strict';
const assert=require('node:assert/strict'),{detail,allowed,joinGuild,guildId}=require('../../src/modules/guildDiscovery');
function fixture({type='open',member=null,status='none',fail=false,applied=true,population=100,capacity=10,gid=7}={}){
 let current=member,pending=status;const calls=[];
 const api={get:async p=>{calls.push(['GET',p]);if(p===`/guilds/${gid}`)return{guild:{id:gid,title:'Test',members_count:3}};if(p===`/guilds/management/${gid}`)return{settings:{guild_type:type,member_capacity:capacity,application_criteria_population:50,application_criteria_profit:5}};if(p==='/users/me/guild')return{guild:current};if(p==='/progress/metrics')return{population,profit:10};if(p==='/users/me/')return{user:{id:42}};if(p===`/guilds/management/${gid}/status/42`)return{status:pending};throw Error(p);},post:async(p,b)=>{calls.push(['POST',p,b]);if(applied){if(type==='open')current={id:gid,title:'Test',role:'Member'};else pending='pending';}if(fail)throw Error('timeout');return{status:type==='open'?'joined':'application_submitted'};}};return{api,calls};
}
(async()=>{
 for(const value of [0,1.5,'bad',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>guildId(value));
 const gid=-100260674352;assert.equal(guildId(String(gid)),gid);const negative=fixture({gid}),nr=await joinGuild(negative.api,gid,'open');assert.equal(nr.ok,true);assert.deepEqual(negative.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/join',{id:gid}]]);
 for(const type of ['open','application']){const f=fixture({type}),d=await detail(f.api,7);assert.equal(allowed(d),null);const r=await joinGuild(f.api,7,type);assert(r.ok);assert.equal(r.status,type==='open'?'joined':'application_submitted');assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/join',{id:7}]]);}
 for(const options of [{member:{id:8}},{status:'pending'},{type:'closed'},{population:10},{capacity:3}]){const f=fixture(options);await assert.rejects(joinGuild(f.api,7,'open'));assert(!f.calls.some(c=>c[0]==='POST'));}
 const changed=fixture({type:'application'});await assert.rejects(joinGuild(changed.api,7,'open'),/изменились/);assert(!changed.calls.some(c=>c[0]==='POST'));
 for(const type of ['open','application'])for(const applied of [true,false]){const f=fixture({type,applied,fail:true}),r=await joinGuild(f.api,7,type);assert.equal(r.ok,applied);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);}
 console.log('PASS discovery: contracts, open/application/pending/closed, existing guild, criteria/capacity, changed consent, ambiguous POST resync without retry');
})().catch(e=>{console.error(e);process.exitCode=1;});
// GET страницы/снимка регистрирует маршруты без создания игрового клиента.
(async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),routes={};let gameCalls=0,dbReads=0;
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../src/web/routes/guilds.js'),'utf8'),{module,exports:module.exports,require:n=>{
  if(n==='path')return path;if(n==='fs')return fs;if(n==='../../utils/logger')return{warn(){}};if(n==='../lib/opRegistry')return{run:(k,fn)=>fn()};
  if(n==='../../db/index')return{Account:{findAll:async()=>[{id:1,name:'Fixture'}]},seq:{query:async()=>{dbReads++;return[{data:JSON.stringify({query:'saved',results:[],page:1,has_more:false})}];}}};if(n==='sequelize')return{QueryTypes:{SELECT:'SELECT'}};throw Error(n);
 },Number,JSON,Date,Math,String,Map,Set,Promise});
 module.exports({get:(p,fn)=>routes[p]=fn,post(){},patch(){},delete(){}},{apiForAcc:()=>{gameCalls++;throw Error('unexpected game request');}});
 let result;await routes['/api/guild-discovery']({query:{account:1}},{json:r=>result=r,status(){return this;}});assert.equal(result.ok,true);assert.equal(result.data.query,'saved');assert.equal(dbReads,1);assert.equal(gameCalls,0);console.log('PASS discovery initial read: DB only, no game client');
})().catch(e=>{console.error(e);process.exitCode=1;});
