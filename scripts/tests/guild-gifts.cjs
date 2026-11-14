'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/web/routes/gameExtras.js'),'utf8');
function fixture({role='Leader',gid=7,fail=false,can_send=true,balance=100,eligible=0}={}){
 const routes={},calls=[],cache=new Map();let after=false;
 const state=()=>({balance,can_send,resets_in_seconds:1000,items:[{item_id:43,price:5,weekly_limit:3}],members:[{user_id:11,name:'Member',eligible_in_seconds:eligible,remaining:{43:after?1:3}}],history:{gifts:[],has_more:false}});
 const api={get:async(p,params)=>{calls.push(['GET',p,params]);if(p==='/users/me/guild')return{guild:{id:gid,role}};if(p.endsWith('/role'))return{role};if(p.endsWith('/gifts'))return state();if(p.endsWith('/history'))return{gifts:[],has_more:false};throw Error(p);},post:async(p,b)=>{calls.push(['POST',p,b]);after=true;if(fail)throw Error('response lost');return state();}};
 const db={Account:{findByPk:async()=>({id:1,name:'A',access_token:'fixture'})},GuildSnapshot:{findOne:async()=>({guild_id:gid})},seq:{query:async(sql,{replacements:r})=>{if(sql.startsWith('SELECT'))return cache.has(r.join('|'))?[cache.get(r.join('|'))]:[];cache.set(r.slice(0,3).join('|'),{data:r[3],updated_at:r[4]});}}};
 const module={exports:{}};
 vm.runInNewContext('(function(require,module,exports){'+source+'\n})',{Number,Set,Date,JSON,Object,Array,String}).call(null,n=>{if(n==='../../modules/guildDiscovery')return require('../../src/modules/guildDiscovery');if(n==='../../utils/logger')return{warn(){},info(){}};if(n==='../../db/index')return db;if(n==='sequelize')return{QueryTypes:{SELECT:'SELECT'}};throw Error(n);},module,module.exports);
 module.exports({get:(p,fn)=>routes['GET '+p]=fn,post:(p,fn)=>routes['POST '+p]=fn},{apiForAcc:()=>api});
 const run=async(key,{body={},params={},query={}}={})=>{let status=200,data;await routes[key]({body,params,query,path:key},{status:n=>{status=n;return{json:d=>data=d};},json:d=>data=d});return{status,data};};
 return{run,calls,cache};
}
const body={account_id:1,expected_guild_id:7,expected_cost:10,gifts:[{user_id:11,items:[{item_id:43,quantity:2}]}]};
(async()=>{
 let f=fixture();let r=await f.run('GET /api/extras/:kind',{params:{kind:'guild-gifts'},query:{account:1}});assert.equal(r.data.data,null);assert.equal(f.calls.length,0,'opening gifts must read DB only');
 r=await f.run('POST /api/extras/:kind/refresh',{params:{kind:'guild-gifts'},body:{account_id:1}});assert.equal(r.data.data.can_send,true);assert.equal(r.data.data.guild_id,'7');assert.equal(f.calls.length,3);
 r=await f.run('GET /api/extras/:kind',{params:{kind:'guild-gifts'},query:{account:1}});assert.equal(r.data.data.balance,100);assert.equal(f.calls.length,3,'cached read does not call game');
 r=await f.run('POST /api/extras/guild-gifts-send',{body});assert.equal(r.data.ok,true);assert.deepEqual(f.calls.filter(c=>c[0]==='POST').map(c=>JSON.parse(JSON.stringify(c))),[['POST','/guilds/7/gifts',{gifts:body.gifts}]]);assert.equal(r.data.data.members[0].remaining[43],1);
 const gid=-100260674352;f=fixture({gid});r=await f.run('POST /api/extras/guild-gifts-send',{body:{...body,expected_guild_id:gid}});assert.equal(r.data.ok,true);assert.equal(f.calls.find(c=>c[0]==='POST')[1],`/guilds/${gid}/gifts`);
 for(const options of [{role:'Member'},{can_send:false},{gid:8},{balance:9},{eligible:60}]){f=fixture(options);r=await f.run('POST /api/extras/guild-gifts-send',{body});assert.equal(r.data.ok,false);assert(!f.calls.some(c=>c[0]==='POST'));}
 for(const patch of [{expected_cost:11},{expected_guild_id:undefined},{gifts:[{user_id:11,items:[{item_id:43,quantity:4}]}]},{gifts:[{user_id:11,items:[{item_id:43,quantity:1.5}]}]},{gifts:[...body.gifts,...body.gifts]},{gifts:[{user_id:11,items:[{item_id:999,quantity:1}]}]}]){f=fixture();r=await f.run('POST /api/extras/guild-gifts-send',{body:{...body,...patch}});assert.equal(r.data.ok,false);assert(!f.calls.some(c=>c[0]==='POST'));}
 f=fixture({fail:true});r=await f.run('POST /api/extras/guild-gifts-send',{body});assert.equal(r.data.ok,false);assert.equal(r.data.data.members[0].remaining[43],1);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1,'ambiguous spending POST never retries');assert.equal(f.calls.at(-1)[1],'/guilds/7/gifts');
 f=fixture({role:'Officer'});r=await f.run('POST /api/extras/guild-gifts-send',{body});assert.equal(r.data.ok,true);
 f=fixture();r=await f.run('POST /api/extras/:kind/refresh',{params:{kind:'guild-gifts-history'},body:{account_id:1,ref:99}});assert.equal(r.data.ok,true);assert.equal(f.calls.at(-1)[2].before,99);
 console.log('PASS guild gifts routes: DB-only reads, explicit refresh, roles, expected guild/cost, weekly limits, eligibility, balance, exact payload, post-resync and no ambiguous retry');
})().catch(e=>{console.error(e);process.exitCode=1;});
