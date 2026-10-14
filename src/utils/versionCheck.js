'use strict';
// Проверка новой версии бота на GitHub (только чтение, без токена).
// Локальная версия — коммит из .git в корне проекта (без бинарника git: читаем HEAD/refs/packed-refs)
// или из env APP_COMMIT. Удалённая — публичный GitHub API: последний коммит ветки, сравнение
// локального коммита с ним (сколько новых коммитов) и последний релиз, если есть.
// Лимит GitHub без токена — 60 запросов/час на IP, поэтому ответ кэшируется на CACHE_MS,
// ручная проверка — не чаще раза в MIN_FORCE_MS.
const fs=require('fs');
const path=require('path');
const axios=require('axios');
const logger=require('./logger');

const REPO=process.env.UPDATE_REPO||'CorsairGuy/TonCity_Bot';
const BRANCH=process.env.UPDATE_BRANCH||'main';
const ROOT=path.resolve(__dirname,'..','..');
const CACHE_MS=30*60*1000;
const MIN_FORCE_MS=60*1000;
const GH='https://api.github.com/repos/'+REPO;

let cache=null,cacheAt=0,inFlight=null;

function readLocalCommit(){
  const env=(process.env.APP_COMMIT||'').trim();
  if(/^[0-9a-f]{7,40}$/i.test(env))return{sha:env.toLowerCase(),branch:null,source:'env'};
  const gitDir=path.join(ROOT,'.git');
  try{
    const head=fs.readFileSync(path.join(gitDir,'HEAD'),'utf8').trim();
    if(/^[0-9a-f]{40}$/i.test(head))return{sha:head.toLowerCase(),branch:null,source:'git'}; // detached HEAD
    const m=head.match(/^ref:\s*(\S+)/);
    if(!m)return null;
    const ref=m[1],branch=ref.replace(/^refs\/heads\//,'');
    let sha=null;
    try{sha=fs.readFileSync(path.join(gitDir,ref),'utf8').trim();}catch(_){}
    if(!sha){
      try{
        const packed=fs.readFileSync(path.join(gitDir,'packed-refs'),'utf8');
        const line=packed.split('\n').find(l=>l.endsWith(' '+ref));
        if(line)sha=line.split(' ')[0];
      }catch(_){}
    }
    return /^[0-9a-f]{40}$/i.test(sha||'')?{sha:sha.toLowerCase(),branch,source:'git'}:null;
  }catch(_){return null;}
}

const gh=(url)=>axios.get(GH+url,{timeout:10000,headers:{Accept:'application/vnd.github+json','User-Agent':'toncity-bot-version-check'},validateStatus:s=>s<500});

async function check(){
  const local=readLocalCommit();
  const out={ok:true,repo:REPO,branch:BRANCH,repoUrl:'https://github.com/'+REPO,local,remote:null,release:null,
    status:'unknown',behindBy:null,compareUrl:null,checkedAt:Date.now(),error:null};
  const r=await gh('/commits/'+encodeURIComponent(BRANCH));
  if(r.status!==200)throw new Error(r.status===403?'лимит GitHub API исчерпан, повторите позже':`GitHub ответил ${r.status}`);
  const c=r.data||{};
  out.remote={sha:c.sha,message:String(c.commit?.message||'').split('\n')[0],date:c.commit?.committer?.date||c.commit?.author?.date||null,url:c.html_url};
  if(local){
    if(local.sha===c.sha||(local.sha.length<40&&c.sha.startsWith(local.sha))){out.status='current';out.behindBy=0;}
    else{
      // base=локальный коммит, head=ветка: ahead_by — сколько новых коммитов на GitHub
      const cmp=await gh(`/compare/${local.sha}...${c.sha}`);
      if(cmp.status===200){
        const st=cmp.data.status;
        out.behindBy=cmp.data.ahead_by;
        out.compareUrl=cmp.data.html_url;
        out.status=st==='identical'?'current':st==='ahead'?'behind':st==='behind'?'ahead':'diverged';
      }else out.status='unknown_local'; // локального коммита нет на GitHub (локальные правки)
    }
  }
  try{
    const rel=await gh('/releases/latest');
    if(rel.status===200)out.release={tag:rel.data.tag_name,name:rel.data.name,date:rel.data.published_at,url:rel.data.html_url};
  }catch(_){}
  return out;
}

// force — ручная проверка из панели (кэш игнорируется, но не чаще MIN_FORCE_MS)
async function getVersionInfo({force=false}={}){
  const age=Date.now()-cacheAt;
  if(cache&&(age<CACHE_MS)&&!(force&&age>=MIN_FORCE_MS))return cache;
  if(inFlight)return inFlight;
  inFlight=check().then(v=>{cache=v;cacheAt=Date.now();return v;}).catch(e=>{
    logger.warn(`[version] проверка обновлений не удалась: ${e.message}`);
    const v={...(cache||{ok:true,repo:REPO,branch:BRANCH,repoUrl:'https://github.com/'+REPO,local:readLocalCommit(),remote:null,release:null,status:'unknown',behindBy:null,compareUrl:null}),
      checkedAt:Date.now(),error:e.message};
    cache=v;cacheAt=Date.now()-CACHE_MS+5*60*1000; // при ошибке повторим через 5 минут
    return v;
  }).finally(()=>{inFlight=null;});
  return inFlight;
}

module.exports={getVersionInfo,readLocalCommit};
