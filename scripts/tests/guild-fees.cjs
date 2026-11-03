'use strict';
// Проверяем настоящий сервис взносов с подписанным API-двойником, не игровыми аккаунтами.
const assert=require('node:assert/strict'),{feeState,readGuildFees,payGuildFees}=require('../../src/modules/guildFees');
const fees=(status='due',required=100,deposited=30,currency='coins')=>({current:{ends_in_seconds:600,terms:{currency}},me:{required,deposited,status},members:null});
for(const status of ['paid','exempt','next_period'])assert.equal(feeState(fees(status)).payable,false);
assert.equal(feeState(fees('due',100,30)).remaining,70);
assert.equal(feeState(fees('due',1.3,.2)).remaining,2);
assert.equal(feeState(fees('due',100,100)).payable,false);
assert.equal(feeState(fees('due',100,30,'unknown')).payable,false);
assert.equal(feeState({current:null,me:null}).payable,false);
assert.equal(feeState({...fees(),current:{ends_in_seconds:0,terms:{currency:'coins'}}}).payable,false);
assert.equal(feeState(fees('due','bad',30)).remaining,null);
function fixture({balance=100,fail=false,applied=true,guild='7'}={}){
 let paid=false;const calls=[];
 const api={get:async p=>{
  calls.push(['GET',p]);
  if(p==='/users/me/guild')return{guild:{id:guild,title:'Fixture'}};
  if(p===`/guilds/${guild}/fees`)return fees(paid?'paid':'due',100,paid?100:30);
  if(p==='/progress/')return{progress:{data:{coins:paid?balance-70:balance,crystals:100}}};
  throw Error(p);
 },post:async(p,b)=>{calls.push(['POST',p,b]);if(applied)paid=true;if(fail)throw Error('connection lost');return{};}};
 return{api,calls};
}
(async()=>{
 const f=fixture(),state=await readGuildFees(f.api);
 const expected={expected_guild_id:state.guild_id,expected_amount:state.remaining,expected_currency:state.currency,expected_deadline:state.deadline};
 const result=await payGuildFees(f.api,expected);assert.equal(result.ok,true);assert.equal(result.remaining,0);assert.equal(result.payable,false);
 assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/7/treasury/deposit',{amount:70,currency:'coins'}]]);
 // Второе нажатие после первой оплаты не делает повторный платёж.
 await assert.rejects(payGuildFees(f.api,expected),/Нет доступного/);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 for(const patch of [{expected_amount:71},{expected_currency:'crystals'},{expected_deadline:0},{expected_guild_id:'8'}]){
  const x=fixture();await assert.rejects(payGuildFees(x.api,{...expected,...patch}),/изменился/);assert.equal(x.calls.filter(c=>c[0]==='POST').length,0);
 }
 const poor=fixture({balance:69});await assert.rejects(payGuildFees(poor.api,expected),/Недостаточно/);assert.equal(poor.calls.filter(c=>c[0]==='POST').length,0);
 for(const applied of [true,false]){
  const x=fixture({fail:true,applied}),r=await payGuildFees(x.api,expected);
  assert.equal(r.ok,applied);assert.equal(x.calls.filter(c=>c[0]==='POST').length,1);
  assert.equal(r.remaining,applied?0:70);if(applied)assert.equal(r.already,true);
 }
 console.log('PASS fees: partial debt, statuses, explicit amount/currency/guild/deadline confirmation, balance, refresh and ambiguous POST without retry');
})().catch(e=>{console.error(e);process.exitCode=1;});
