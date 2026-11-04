'use strict';
// Архив публичного бандла игры и сравнение двух архивов.
// Качает только статику game.toncity.io (index.html, _nuxt/*.js|css|wasm) без токенов и игрового API.
//   node scripts/tools/game-bundle.js save [папка]   — скачать текущую сборку (по умолчанию bundles/<дата>-<сборка>)
//   node scripts/tools/game-bundle.js diff <старая> <новая>  — отчёт: файлы, пути API, id зданий
// Архивы в git не хранятся (bundles/ в .gitignore). Сохранять перед каждым обновлением игры и после него.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const BASE='https://game.toncity.io';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const REF_RE=/["'`](\.{1,2}\/|\/_nuxt\/)?((?:chunks\/|js\/)?[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8}-\d{5}\.(?:js|css|wasm))/g;

async function fetchBuf(url){
  for(let i=0;i<3;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':UA}});
      if(r.status===404)return null;
      if(!r.ok)throw new Error('HTTP '+r.status);
      return Buffer.from(await r.arrayBuffer());
    }catch(e){if(i===2)throw new Error(url+': '+e.message);await new Promise(r=>setTimeout(r,2000*(i+1)));}
  }
}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

async function save(outArg){
  const html=(await fetchBuf(BASE+'/')).toString('utf8');
  const buildId=(html.match(/buildId:"([^"]+)"/)||[])[1]||null;
  const entry=(html.match(/_nuxt\/js\/(entry-[^"']+\.js)/)||[])[1]||null;
  const tag=(entry||'unknown').replace(/\.js$/,'');
  const out=path.resolve(outArg||path.join('bundles',new Date().toISOString().slice(0,10)+'-'+tag));
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'index.html'),html);
  const seen=new Set(),queue=[],files=[],missing=[];
  const add=p=>{p=path.posix.normalize(p).replace(/^\/+/,'');if(!p.startsWith('_nuxt/'))p='_nuxt/'+p;if(!seen.has(p)){seen.add(p);queue.push(p);}};
  for(const m of html.matchAll(/\/(_nuxt\/[^"'\s)]+\.(?:js|css|wasm))/g))add(m[1]);
  while(queue.length){
    const p=queue.shift();
    let buf=await fetchBuf(BASE+'/'+p);
    // ссылки без префикса папки пробуем рядом и в соседней папке (js/ ↔ chunks/)
    if(!buf){const alt=p.includes('/js/')?p.replace('/js/','/chunks/'):p.replace('/chunks/','/js/');if(!seen.has(alt)){seen.add(alt);buf=await fetchBuf(BASE+'/'+alt);if(buf){files.push(store(out,alt,buf));scan(alt,buf,add);continue;}}missing.push(p);continue;}
    files.push(store(out,p,buf));scan(p,buf,add);
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest={savedAt:new Date().toISOString(),url:BASE,buildId,entry,files,missing,lastModified:null};
  try{const r=await fetch(BASE+'/',{method:'HEAD',headers:{'user-agent':UA}});manifest.lastModified=r.headers.get('last-modified');}catch{}
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,1));
  const bytes=files.reduce((s,f)=>s+f.bytes,0);
  console.log(`Сохранено ${files.length} файлов, ${(bytes/1048576).toFixed(1)} МБ → ${out}`);
  console.log(`Сборка ${buildId||'?'}, entry ${entry||'?'}; не найдено ссылок: ${missing.length}`);
}
function store(out,p,buf){const fp=path.join(out,p);fs.mkdirSync(path.dirname(fp),{recursive:true});fs.writeFileSync(fp,buf);return{path:p,bytes:buf.length,sha256:sha(buf)};}
function scan(p,buf,add){
  if(!p.endsWith('.js'))return;
  const dir=path.posix.dirname(p);
  for(const m of buf.toString('utf8').matchAll(REF_RE)){
    const pre=m[1]||'',ref=m[2];
    if(pre==='/_nuxt/')add('_nuxt/'+ref);
    else if(pre)add(path.posix.join(dir,pre+ref));
    else add(/^(chunks|js)\//.test(ref)?'_nuxt/'+ref:path.posix.join(dir,ref));
  }
}

// ---- сравнение ----
// Имена чанков меняются целиком при любой правке зависимостей (хэш + номер сборки),
// поэтому сравниваем по «стему» и по содержимому без хэшей ссылок.
const stem=f=>path.posix.basename(f).replace(/-[A-Za-z0-9_-]{8}-\d{5}(\.\w+)$/,'$1');
const norm=t=>t.replace(/-[A-Za-z0-9_-]{8}-\d{5}\.(js|css|wasm)/g,'.$1');
function load(dir){
  const man=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const byStem=new Map();
  for(const f of man.files){const s=stem(f.path);if(!byStem.has(s))byStem.set(s,[]);byStem.get(s).push(f.path);}
  const text=new Map();
  for(const f of man.files)if(/\.(js|css)$/.test(f.path))text.set(f.path,fs.readFileSync(path.join(dir,f.path),'utf8'));
  return{dir,man,byStem,text};
}
function setOf(b,re){const s=new Set();for(const t of b.text.values())for(const m of t.matchAll(re))s.add(m[1]||m[0]);return s;}
function delta(a,b){return{added:[...b].filter(x=>!a.has(x)).sort(),removed:[...a].filter(x=>!b.has(x)).sort()};}
function diff(oldDir,newDir){
  const A=load(oldDir),B=load(newDir);
  const out=[];
  out.push(`# Сравнение бандлов`,`Старый: ${A.man.entry} (${A.man.buildId}), сохранён ${A.man.savedAt}`,`Новый:  ${B.man.entry} (${B.man.buildId}), сохранён ${B.man.savedAt}`,'');
  const st=delta(new Set(A.byStem.keys()),new Set(B.byStem.keys()));
  const changed=[];
  for(const s of A.byStem.keys()){
    if(!B.byStem.has(s)||/\.wasm$/.test(s))continue;
    const ta=A.byStem.get(s).map(p=>A.text.get(p)?norm(A.text.get(p)):'').sort().join('\n');
    const tb=B.byStem.get(s).map(p=>B.text.get(p)?norm(B.text.get(p)):'').sort().join('\n');
    if(ta!==tb)changed.push(`${s} (${ta.length}→${tb.length} байт)`);
  }
  const wasm=[];
  for(const [s,ps] of B.byStem)if(/\.wasm$/.test(s)&&A.byStem.has(s)){
    const ha=A.man.files.filter(f=>A.byStem.get(s).includes(f.path)).map(f=>f.sha256).sort().join();
    const hb=B.man.files.filter(f=>ps.includes(f.path)).map(f=>f.sha256).sort().join();
    if(ha!==hb)wasm.push(s);
  }
  const section=(title,d)=>{out.push(`## ${title}`);if(!d.added.length&&!d.removed.length)out.push('без изменений');for(const x of d.added)out.push('+ '+x);for(const x of d.removed)out.push('- '+x);out.push('');};
  section('Файлы (по имени без хэша)',st);
  out.push('## Изменённые файлы',...(changed.length?changed:['нет']),'');
  out.push('## WASM с другим содержимым',...(wasm.length?wasm:['нет']),'');
  section('Пути API в строках',delta(setOf(A,/["'`](\/(?:[a-z][a-z0-9_-]*\/?){1,5})["'`]/g),setOf(B,/["'`](\/(?:[a-z][a-z0-9_-]*\/?){1,5})["'`]/g)));
  section('Id зданий (XXX_имя)',delta(setOf(A,/\b([A-Z]{3}_[a-z][a-z0-9_]*)\b/g),setOf(B,/\b([A-Z]{3}_[a-z][a-z0-9_]*)\b/g)));
  console.log(out.join('\n'));
}

const [cmd,a,b]=process.argv.slice(2);
if(cmd==='save')save(a).catch(e=>{console.error(e.message);process.exit(1);});
else if(cmd==='diff'&&a&&b)diff(a,b);
else{console.log('node scripts/tools/game-bundle.js save [папка] | diff <старая> <новая>');process.exit(cmd?1:0);}
