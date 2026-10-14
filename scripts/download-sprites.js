'use strict';
const https=require('https');
const fs=require('fs');
const path=require('path');

const BASES={
  tiles:'https://game.toncity.io/assets/tiles/',
  capital:'https://game.toncity.io/assets/capital/',
};
const OUT=path.join(__dirname,'..','src','web','sprites');
['tiles','capital'].forEach(d=>fs.mkdirSync(path.join(OUT,d),{recursive:true}));

function get(url){
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{'user-agent':'Mozilla/5.0'}},res=>{
      if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve(Buffer.concat(chunks)));
    }).on('error',reject);
  });
}

function save(url,dest){
  return new Promise((resolve,reject)=>{
    if(fs.existsSync(dest)){process.stdout.write('.');return resolve();}
    https.get(url,{headers:{'user-agent':'Mozilla/5.0'}},res=>{
      if(res.statusCode!==200){res.resume();return reject(new Error(`HTTP ${res.statusCode}`));}
      const tmp=dest+'.tmp';
      const f=fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish',()=>f.close(()=>{fs.renameSync(tmp,dest);process.stdout.write('+');resolve();}));
      f.on('error',reject);
    }).on('error',reject);
  });
}

(async()=>{
  const spriteMap={};
  const downloads=[];

  for(const[key,base] of Object.entries(BASES)){
    console.log(`\nLoading ${key} manifest...`);
    const manifest=JSON.parse(await get(base+'manifest.json'));
    const files=Array.isArray(manifest)?manifest:Object.values(manifest);
    console.log(`  ${files.length} atlas files`);
    for(const fn of files){
      const data=JSON.parse(await get(base+fn));
      const pngName=data.meta.image.replace('.ktx2','.png');
      const local=`${key}/${pngName}`;
      downloads.push({url:base+pngName,dest:path.join(OUT,local)});
      for(const[id,info] of Object.entries(data.frames||{})){
        spriteMap[id]={atlas:local,frame:info.frame};
      }
    }
  }

  fs.writeFileSync(path.join(OUT,'sprite-map.json'),JSON.stringify(spriteMap,null,2),'utf8');
  console.log(`\nSprite map: ${Object.keys(spriteMap).length} sprites -> sprite-map.json`);

  console.log(`\nDownloading ${downloads.length} PNG files:`);
  let ok=0,fail=0;
  for(const{url,dest} of downloads){
    try{await save(url,dest);ok++;}
    catch(e){console.error(`\nFAIL ${url}: ${e.message}`);fail++;}
  }
  console.log(`\n\nDone: ${ok} downloaded/skipped, ${fail} failed`);
})();
