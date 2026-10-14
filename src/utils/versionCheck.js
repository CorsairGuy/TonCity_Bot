'use strict';
// Проверка версии бота и каналов обновлений на GitHub (только чтение, без токена).
// Локальная версия — коммит из env APP_COMMIT (зашит в образ) или из .git в корне проекта (без
// бинарника git: читаем HEAD/refs/packed-refs). Канал — тег образа BOT_TAG (selfUpdate.currentTag):
//   ветка (main/latest, dev…) — голова ветки; stable — последний релиз; 1.0 — закреплённый релиз;
//   sha-<коммит> — закреплённая сборка. Для плавающих каналов считаем, сколько новых коммитов и
//   собран ли уже образ (.github/workflows/docker.yml), для закреплённых — есть ли релизы новее.
// Лимит GitHub без токена — 60 запросов/час на IP, поэтому ответ кэшируется на CACHE_MS,
// ручная проверка идёт на GitHub всегда, кроме повторного клика в пределах MIN_FORCE_MS.
const fs=require('fs');
const path=require('path');
const axios=require('axios');
const logger=require('./logger');
const{currentTag}=require('./selfUpdate');

const REPO=process.env.UPDATE_REPO||'CorsairGuy/TonCity_Bot';
const ROOT=path.resolve(__dirname,'..','..');
const CACHE_MS=30*60*1000;
const MIN_FORCE_MS=10*1000;      // ручная проверка: условные запросы с ETag (304) лимит GitHub не тратят
const GH='https://api.github.com/repos/'+REPO;
const REPO_URL='https://github.com/'+REPO;
const WORKFLOW='.github/workflows/docker.yml';

const BUILD_MS=3*60*1000;         // пока образ собирается — проверяем чаще, чтобы «Обновить» появилась сразу после сборки
const ERROR_MS=5*60*1000;         // GitHub не ответил — повторим через 5 минут
let cache=null,cacheAt=0,cacheTtl=CACHE_MS,inFlight=null;

function readLocalCommit(){
  const env=(process.env.APP_COMMIT||'').trim();
  if(/^[0-9a-f]{7,40}$/i.test(env))return{sha:env.toLowerCase(),branch:null,ref:(process.env.APP_REF||'').trim()||null,source:'env'};
  const gitDir=path.join(ROOT,'.git');
  try{
    const head=fs.readFileSync(path.join(gitDir,'HEAD'),'utf8').trim();
    if(/^[0-9a-f]{40}$/i.test(head))return{sha:head.toLowerCase(),branch:null,ref:null,source:'git'}; // detached HEAD
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
    return /^[0-9a-f]{40}$/i.test(sha||'')?{sha:sha.toLowerCase(),branch,ref:branch,source:'git'}:null;
  }catch(_){return null;}
}

// Лимит без ключа — 60 запросов в час на IP сервера. Экономим его так:
//  • условные запросы: ответ запоминается с ETag (и на диске, переживает перезапуски бота), повторный
//    запрос с If-None-Match получает 304 «не изменилось», а 304 в лимит GitHub не засчитывается;
//  • упёрлись в лимит — до его сброса (x-ratelimit-reset) к GitHub не ходим вовсе, показываем
//    последние известные данные;
//  • GITHUB_TOKEN в .env (необязательно, любой токен без прав) поднимает лимит до 5000 в час.
const ETAG_FILE=path.join(ROOT,'config','github-cache.json');
let etags=null,etagsDirty=null,limitedUntil=0;
const loadEtags=()=>{if(!etags){try{etags=JSON.parse(fs.readFileSync(ETAG_FILE,'utf8'))||{};}catch(_){etags={};}}return etags;};
const saveEtags=()=>{ // пишем не на каждый запрос, а пачкой
  if(etagsDirty)return;
  etagsDirty=setTimeout(()=>{etagsDirty=null;try{fs.writeFileSync(ETAG_FILE+'.tmp',JSON.stringify(etags));fs.renameSync(ETAG_FILE+'.tmp',ETAG_FILE);}catch(_){}},2000);
};
const hhmm=(ms)=>new Date(ms).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:process.env.TZ||'Asia/Yekaterinburg'});
class RateLimitError extends Error{}
async function gh(url){
  if(Date.now()<limitedUntil)throw new RateLimitError(`лимит GitHub API исчерпан, следующая проверка после ${hhmm(limitedUntil)}`);
  const store=loadEtags(),prev=store[url];
  const headers={Accept:'application/vnd.github+json','User-Agent':'toncity-bot-version-check'};
  const token=(process.env.GITHUB_TOKEN||'').trim();
  if(token)headers.Authorization='Bearer '+token;
  if(prev&&prev.etag)headers['If-None-Match']=prev.etag;
  const r=await axios.get(GH+url,{timeout:10000,headers,validateStatus:s=>s<500});
  if(r.status===304&&prev)return{status:200,data:prev.data};
  if((r.status===403||r.status===429)&&(r.headers['x-ratelimit-remaining']==='0'||r.headers['retry-after'])){
    const reset=+r.headers['x-ratelimit-reset']*1000||Date.now()+(+r.headers['retry-after']||600)*1000;
    limitedUntil=Math.max(reset,Date.now()+60*1000);
    logger.warn(`[version] лимит GitHub API исчерпан до ${hhmm(limitedUntil)}${token?'':' (без GITHUB_TOKEN — 60 запросов в час)'}`);
    throw new RateLimitError(`лимит GitHub API исчерпан, следующая проверка после ${hhmm(limitedUntil)}`);
  }
  if(r.status===200&&r.headers.etag){store[url]={etag:r.headers.etag,data:r.data};saveEtags();}
  return r;
}
const ghOk=async(url)=>{
  const r=await gh(url);
  if(r.status!==200)throw new Error(`GitHub ответил ${r.status} на ${url}`);
  return r.data;
};

// тег образа для ветки — как в docker.yml: символы вне [A-Za-z0-9_.-] → «-»
const branchTag=(name)=>String(name).replace(/[^A-Za-z0-9_.-]/g,'-');
const releaseTag=(tagName)=>String(tagName).replace(/^v/,'');
const HIDDEN_BRANCH=/^(claude|dependabot)\//; // такие ветки не собираются

// канал по тегу образа
function channelOf(tag,branches,releases){
  if(tag==='latest'||tag==='main')return{kind:'branch',name:'main',tag};
  if(tag==='stable')return{kind:'stable',name:'stable',tag};
  const sha=tag.match(/^sha-([0-9a-f]{7,40})$/i);
  if(sha)return{kind:'commit',name:sha[1].slice(0,7),sha:sha[1].toLowerCase(),tag};
  const rel=releases.find(r=>r.tag===tag);
  if(rel)return{kind:'release',name:rel.version,tag};
  const br=branches.find(b=>b.tag===tag);
  if(br)return{kind:'branch',name:br.name,tag};
  return /^\d/.test(tag)?{kind:'release',name:tag,tag}:{kind:'branch',name:tag,tag};
}

// запуск сборки образа для коммита и ссылки (ветка или тег релиза)
async function buildOf(sha,ref){
  try{
    const runs=await gh(`/actions/runs?head_sha=${sha}&per_page=20`);
    if(runs.status!==200)return null;
    const all=(runs.data.workflow_runs||[]).filter(w=>w.path===WORKFLOW&&w.event!=='pull_request');
    const run=all.find(w=>w.head_branch===ref)||all[0];
    return run?{status:run.status,conclusion:run.conclusion,url:run.html_url}:null;
  }catch(_){return null;}
}

async function check(){
  const local=readLocalCommit();
  const tag=currentTag();
  const[branchesRaw,releasesRaw]=await Promise.all([ghOk('/branches?per_page=100'),ghOk('/releases?per_page=30')]);
  const branches=(branchesRaw||[]).filter(b=>!HIDDEN_BRANCH.test(b.name))
    .map(b=>({name:b.name,tag:b.name==='main'?'main':branchTag(b.name),sha:b.commit&&b.commit.sha}))
    .sort((a,b)=>(a.name==='main'?-1:b.name==='main'?1:a.name.localeCompare(b.name)));
  const releases=(releasesRaw||[]).filter(r=>!r.draft).map(r=>({
    version:releaseTag(r.tag_name),tagName:r.tag_name,tag:releaseTag(r.tag_name),name:r.name||r.tag_name,
    date:r.published_at||r.created_at,prerelease:!!r.prerelease,url:r.html_url,notes:String(r.body||'').slice(0,4000)}))
    .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  const stableRel=releases.find(r=>!r.prerelease)||null;
  const channel=channelOf(tag,branches,releases);
  const out={ok:true,repo:REPO,repoUrl:REPO_URL,local,channel,branches,releases,
    stable:stableRel?{version:stableRel.version,date:stableRel.date}:null,
    branch:channel.kind==='branch'?channel.name:null,
    remote:null,release:stableRel?{tag:stableRel.tagName,name:stableRel.name,date:stableRel.date,url:stableRel.url}:null,
    status:'unknown',behindBy:null,compareUrl:null,build:null,currentRelease:null,checkedAt:Date.now(),error:null};

  // голова плавающего канала: ветка или последний релиз
  let headRef=null;
  if(channel.kind==='branch')headRef=channel.name;
  else if(channel.kind==='stable'&&stableRel)headRef=stableRel.tagName;
  if(headRef){
    const c=await ghOk('/commits/'+encodeURIComponent(headRef));
    out.remote={sha:c.sha,ref:headRef,message:String(c.commit?.message||'').split('\n')[0],date:c.commit?.committer?.date||c.commit?.author?.date||null,url:c.html_url};
    if(local){
      if(local.sha===c.sha||(local.sha.length<40&&c.sha.startsWith(local.sha))){out.status='current';out.behindBy=0;}
      else{
        // base=локальный коммит, head=канал: ahead_by — сколько новых коммитов на GitHub
        const cmp=await gh(`/compare/${local.sha}...${c.sha}`);
        if(cmp.status===200){
          const st=cmp.data.status;
          out.behindBy=cmp.data.ahead_by;
          out.compareUrl=cmp.data.html_url;
          // на stable откат на более старый релиз — тоже «новое» для канала
          out.status=st==='identical'?'current':st==='ahead'?'behind':channel.kind==='stable'?'behind':st==='behind'?'ahead':'diverged';
        }else out.status='unknown_local'; // локального коммита нет на GitHub (локальные правки)
      }
    }
    // готов ли образ головы канала — ставить имеет смысл только после сборки
    if(out.status==='behind'||out.status==='unknown')out.build=await buildOf(c.sha,headRef);
    if(channel.kind==='stable'&&out.status==='current')out.currentRelease=stableRel.version;
  }else if(channel.kind==='release'||channel.kind==='commit'){
    out.status='pinned';
    if(channel.kind==='release')out.currentRelease=channel.name;
  }
  // релизы новее текущего (для закреплённой версии и stable) — метка «Новая» в списке
  const cur=out.currentRelease&&releases.find(r=>r.version===out.currentRelease);
  for(const r of releases)r.isNew=!!(cur&&Date.parse(r.date)>Date.parse(cur.date));
  out.newerReleases=releases.filter(r=>r.isNew&&!r.prerelease).length;
  return out;
}

// force — ручная проверка из панели: кэш (и ошибочный тоже) игнорируется, если ему больше
// MIN_FORCE_MS. Ответ из кэша помечается cached:true, чтобы панель не выдавала его за свежую проверку.
async function getVersionInfo({force=false,maxAge=CACHE_MS}={}){
  const age=Date.now()-cacheAt;
  if(cache&&(age<Math.min(maxAge,cacheTtl))&&!(force&&age>=MIN_FORCE_MS))return{...cache,cached:true};
  if(inFlight)return inFlight;
  inFlight=check().then(v=>{
    cache=v;cacheAt=Date.now();
    cacheTtl=v.build&&v.build.status!=='completed'?BUILD_MS:CACHE_MS;
    return v;
  }).catch(e=>{
    logger.warn(`[version] проверка обновлений не удалась: ${e.message}`);
    const v={...(cache||{ok:true,repo:REPO,repoUrl:REPO_URL,local:readLocalCommit(),channel:channelOf(currentTag(),[],[]),
      branches:[],releases:[],stable:null,branch:null,remote:null,release:null,status:'unknown',behindBy:null,compareUrl:null,build:null,newerReleases:0}),
      checkedAt:Date.now(),error:e.message};
    cache=v;cacheAt=Date.now();cacheTtl=Math.max(ERROR_MS,limitedUntil-Date.now());
    return v;
  }).finally(()=>{inFlight=null;});
  return inFlight;
}

// после смены канала кэш устарел
const invalidate=()=>{cache=null;cacheAt=0;};

// сразу после запуска бота: панель, открытая после старта, получает готовый ответ, а не ждёт GitHub
function warmUp(){getVersionInfo().catch(()=>{});}

module.exports={getVersionInfo,readLocalCommit,invalidate,warmUp,channelOf,branchTag};
