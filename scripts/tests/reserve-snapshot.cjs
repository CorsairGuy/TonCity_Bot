'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module'),load=Module._load;
let gameCalls=0,posts=0,applied=false;
const account={id:1,name:'Fixture',access_token:'fixture',balance:1000,crystals:0,update:async()=>{}};
Module._load=function(name,parent,...args){
  if(parent?.filename.endsWith('routes\\economy.js')||parent?.filename.endsWith('routes/economy.js')){
    if(name==='../../db/index')return {StakingEntry:{findAll:async()=>[]},Account:{findAll:async()=>[],findByPk:async()=>account}};
    if(name==='../../modules/staking')return {saveEntriesToDb:async()=>{}};
    if(name==='sequelize')return {Op:{}};
  }
  return load.call(this,name,parent,...args);
};
const routes={};const app={get:(p,f)=>{routes[`GET ${p}`]=f;},post:(p,f)=>{routes[`POST ${p}`]=f;},delete(){},patch(){},put(){}};
const game={get:async p=>{gameCalls++;if(p==='/progress/')return{progress:{data:{coins:900}}};return{entries:applied?[{id:7,currency:'coins',amount_staked:100}]:[],stakes_per_currency:3,coin_amounts:[100],coin_terms:[{days:7}],whale_slots:[]};},post:async()=>{posts++;applied=true;throw Error('timeout');}};
require('../../src/web/routes/economy')(app,{makeApiForAccount:async()=>game});
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}});
(async()=>{
  let res=response();await routes['GET /api/staking']({query:{}},res);assert.equal(res.body.ok,true);
  res=response();await routes['GET /api/staking/:accountId/snapshot']({params:{accountId:'2147483647'}},res);assert.equal(res.body.ok,false);
  assert.equal(gameCalls,0,'открытие страницы и выбор аккаунта не обращаются к игре');
  res=response();await routes['POST /api/staking/stake']({body:{account_id:1,currency:'coins',amount:101,duration:7}},res);assert.equal(posts,0);assert.equal(res.body.ok,false);
  res=response();await routes['POST /api/staking/stake']({body:{account_id:1,currency:'coins',amount:100,duration:7}},res);assert.equal(posts,1);assert.equal(res.body.ok,true,'таймаут проверяется по состоянию после единственного POST');
  console.log('PASS reserve: local list and snapshot do not access the game');
})().catch(e=>{console.error(e);process.exitCode=1;});
