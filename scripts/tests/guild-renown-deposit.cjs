'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/web/routes/gameExtras.js'),'utf8');
function fixture({gid=-1007,balance=100,fail=false,refreshFail=false,hold=false}={}){
 const routes={},calls=[],cache=new Map();let posted=false,release;
 const gate=new Promise(r=>release=r);
 const api={get:async p=>{calls.push(['GET',p]);if(p==='/users/me/guild')return{guild:gid?{id:gid}:null};if(p.endsWith('/renown')){if(posted&&refreshFail)throw Error('resync lost');return{balance:posted?balance-20:balance,guild_balance:posted?70:50,guild_earned:50};}return[];},post:async(p,b)=>{calls.push(['POST',p,JSON.parse(JSON.stringify(b))]);posted=true;if(hold)await gate;if(fail)throw Error('response lost');return{amount:20};}};
 const db={Account:{findByPk:async()=>({id:1,name:'A',access_token:'fixture'})},seq:{query:async(sql,{replacements:r})=>{if(sql.startsWith('SELECT'))return cache.has(r.join('|'))?[cache.get(r.join('|'))]:[];cache.set(r.slice(0,3).join('|'),{data:r[3],updated_at:r[4]});}}};
 const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,require:n=>n==='../../utils/logger'?{warn(){},info(){}}:n==='../../db/index'?db:n==='sequelize'?{QueryTypes:{SELECT:'SELECT'}}:(()=>{throw Error(n)})(),Number,Set,Date,JSON,Object,Array,String});
 module.exports({get:(p,fn)=>routes['GET '+p]=fn,post:(p,fn)=>routes['POST '+p]=fn},{apiForAcc:()=>api});
 const run=async body=>{let status=200,data;await routes['POST /api/extras/renown-deposit']({body},{status:n=>{status=n;return{json:d=>data=d};},json:d=>data=d});return{status,data};};return{calls,cache,run,release};
}
const body={account_id:1,expected_guild_id:-1007,amount:20};
(async()=>{
 let f=fixture(),r=await f.run(body);assert(r.data.ok);assert.equal(r.data.data.balance,80);assert.equal(r.data.data.guild_id,'-1007');assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[['POST','/guilds/-1007/renown/deposit',{amount:20}]]);assert.equal(f.cache.size,3);
 for(const amount of [0,-1,1.2,NaN,Infinity,'20',null,Number.MAX_SAFE_INTEGER+1]){f=fixture();r=await f.run({...body,amount});assert.equal(r.data.ok,false);assert(!f.calls.some(c=>c[0]==='POST'));}
 for(const args of [{gid:-1008},{gid:null},{balance:19},{balance:null}]){f=fixture(args);r=await f.run(body);assert.equal(r.data.ok,false);assert(!f.calls.some(c=>c[0]==='POST'));}
 f=fixture({fail:true});r=await f.run(body);assert.equal(r.data.ok,false);assert.equal(r.data.data.balance,80);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);assert.equal(f.cache.size,3,'ambiguous outcome still refreshes all snapshots');
 f=fixture({refreshFail:true});r=await f.run(body);assert.equal(r.data.ok,true);assert.equal(r.data.data,null);assert(r.data.refresh_error);
 f=fixture({hold:true});const first=f.run(body);await new Promise(r=>setTimeout(r,0));const second=await f.run(body);assert.equal(second.status,409);f.release();assert((await first).data.ok);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1,'parallel request rejected, does not unlock first');
 f=fixture();r=await f.run({account_id:1,amount:20});assert(r.data.ok,'legacy caller without expected guild remains compatible');
 console.log('PASS renown deposit: signed guild, actual membership/balance, integer validation, single POST, ambiguous resync, partial refresh, account lock and legacy compatibility');
})().catch(e=>{console.error(e);process.exitCode=1;});
