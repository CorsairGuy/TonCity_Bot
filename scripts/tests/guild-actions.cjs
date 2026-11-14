'use strict';
const assert=require('node:assert/strict'),{leaveGuild,depositGuild}=require('../../src/modules/guildActions');
function fixture({role='Member',balance=100,fail=false,applied=true,refreshFail=false}={}){
 let left=false,posted=false;const calls=[];
 const api={get:async p=>{
  calls.push(['GET',p]);
  if(p==='/users/me/guild'){if(posted&&refreshFail)throw Error('refresh lost');return{guild:left?null:{id:7,title:'Fixture',role}};}
  if(p==='/progress/')return{progress:{data:{coins:balance,crystals:balance}}};
  throw Error(p);
 },post:async(p,b)=>{calls.push(['POST',p,b]);posted=true;if(applied&&p==='/guilds/leave')left=true;if(fail)throw Error('connection lost');return{amount:b.amount,new_balance:balance-(b.amount||0)};}};
 return{api,calls};
}
(async()=>{
 for(const role of ['Member','Officer','Leader']){
  const f=fixture({role});const out=await leaveGuild(f.api,{expected_guild_id:'7',confirm_leader:role==='Leader'});
  assert.equal(out.ok,true);assert.equal(out.membership.guild,null);assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/leave',{}]]);
 }
 const leader=fixture({role:'Leader'});await assert.rejects(leaveGuild(leader.api,{expected_guild_id:7}),/подтверждение/);assert(!leader.calls.some(c=>c[0]==='POST'));
 for(const applied of [true,false]){const f=fixture({fail:true,applied}),out=await leaveGuild(f.api,{expected_guild_id:7});assert.equal(out.ok,applied);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);}
 const lost=fixture({refreshFail:true});const out=await leaveGuild(lost.api,{expected_guild_id:7});assert.equal(out.ok,true);assert.equal(out.membership,undefined);assert.equal(out.refresh_error,'refresh lost');
 for(const currency of ['coins','crystals']){const f=fixture();assert.equal((await depositGuild(f.api,{expected_guild_id:7,currency,amount:25})).ok,true);assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/7/treasury/deposit',{amount:25,currency}]]);}
 for(const amount of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'25',null]){const f=fixture();await assert.rejects(depositGuild(f.api,{expected_guild_id:7,currency:'coins',amount}));assert(!f.calls.some(c=>c[0]==='POST'));}
 for(const patch of [{currency:'renown'},{expected_guild_id:8},{amount:101}]){const f=fixture();await assert.rejects(depositGuild(f.api,{expected_guild_id:7,currency:'coins',amount:25,...patch}));assert(!f.calls.some(c=>c[0]==='POST'));}
 const absent={get:async()=>({guild:null})};await assert.rejects(leaveGuild(absent,{expected_guild_id:7}),/не состоит/);
 const denied=fixture({role:'Leader',fail:true,applied:false});assert.equal((await leaveGuild(denied.api,{expected_guild_id:7,confirm_leader:true})).ok,false,'server rejection of leader exit is preserved');
 const payment=fixture({fail:true});await assert.rejects(depositGuild(payment.api,{expected_guild_id:7,currency:'crystals',amount:25}),/connection lost/);assert.equal(payment.calls.filter(c=>c[0]==='POST').length,1);
 console.log('PASS guild actions: all roles, leader confirmation/server rejection, membership changes, amounts/currencies/balance, resync and no ambiguous POST retry');
})().catch(e=>{console.error(e);process.exitCode=1;});
