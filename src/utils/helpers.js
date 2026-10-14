'use strict';
const logger=require('./logger');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function isDifferentDay(iso){
  if(!iso)return true;
  const d=new Date(iso),n=new Date();
  return!(d.getUTCFullYear()===n.getUTCFullYear()&&d.getUTCMonth()===n.getUTCMonth()&&d.getUTCDate()===n.getUTCDate());
}
async function withRetry(fn,retries=3,delay=2000,label='op'){
  for(let i=0;i<retries;i++){try{return await fn();}catch(e){if(i===retries-1)throw e;logger.warn(`[${label}] retry ${i+1}: ${e.message}`);await sleep(delay);}}
}
function textToNumber(s){
  if(typeof s==='number')return s;
  const v=String(s).trim().toUpperCase(),n=parseFloat(v.replace(/[KMBT]/g,''));
  if(v.endsWith('T'))return n*1e12;if(v.endsWith('B'))return n*1e9;
  if(v.endsWith('M'))return n*1e6;if(v.endsWith('K'))return n*1e3;return n;
}
function fmt(n){const v=Number(n);if(v>=1e9)return(v/1e9).toFixed(1).replace(/\.0$/,'')+'B';if(v>=1e6)return(v/1e6).toFixed(1).replace(/\.0$/,'')+'M';if(v>=1e3)return(v/1e3).toFixed(1).replace(/\.0$/,'')+'K';return String(Math.round(v));}
function msUntilUtcMidnight(){
  const now=new Date();
  const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,0,0,10));
  return next-now;
}
async function sleepUntilUtcMidnight(){
  const ms=msUntilUtcMidnight();
  const h=Math.round(ms/3600000*10)/10;
  logger.info(`[daily] следующий запуск через ${h}ч (00:00:10 UTC)`);
  await sleep(ms);
}
module.exports={sleep,isDifferentDay,withRetry,textToNumber,fmt,sleepUntilUtcMidnight};
