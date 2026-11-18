'use strict';
const assert=require('node:assert/strict');
const {inspect,deploy}=require('../../src/modules/campaignDeploy');
function fixture({guild=1,can=true,deployed=false,postError=false,applied=true,readError=false}={}){
  let posts=0;
  const api={get:async path=>{
    if(path==='/users/me/guild')return{guild:{id:guild}};
    if(readError&&posts)throw Error('offline');
    return{active:[{id:4,my_side:'defender',defender:{guild_id:1},my_deployed:deployed,can_deploy:can}]};
  },post:async(path,body)=>{posts++;assert.equal(path,'/guild-campaigns/deploy');assert.deepEqual(body,{campaign_id:4});if(applied)deployed=true;if(postError)throw Error('timeout');}};
  return{api,count:()=>posts};
}
(async()=>{
  for(const opts of [{guild:2},{can:false},{deployed:true}]){const f=fixture(opts);assert.equal((await deploy(f.api,1,4)).ok,false);assert.equal(f.count(),0);}
  for(const opts of [{},{postError:true,applied:true}]){const f=fixture(opts);assert.equal((await deploy(f.api,1,4)).ok,true);assert.equal(f.count(),1);}
  for(const opts of [{postError:true,applied:false},{readError:true}]){const f=fixture(opts);assert.equal((await deploy(f.api,1,4)).ok,false);assert.equal(f.count(),1);}
  const f=fixture();assert.equal((await inspect(f.api,1,5)).eligible,false);
  console.log('PASS campaign deploy: membership, personal eligibility, one POST and resync');
})().catch(e=>{console.error(e);process.exitCode=1;});
