'use strict';
// Обновляет атласы по содержимому: одинаковое имя PNG не означает прежние пиксели.
const https=require('https'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const BASES={tiles:'https://game.toncity.io/assets/tiles/',d1:'https://game.toncity.io/assets/tiles/d1/',capital:'https://game.toncity.io/assets/capital/'};
const OUT=path.join(__dirname,'..','src','web','sprites');
function get(url){return new Promise((resolve,reject)=>{
  const req=https.get(url,{headers:{'user-agent':'Mozilla/5.0'}},res=>{
    if(res.statusCode!==200){res.resume();return reject(new Error(`HTTP ${res.statusCode} ${url}`));}
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
  });req.setTimeout(60000,()=>req.destroy(new Error('Таймаут скачивания атласа')));req.on('error',reject);
});}
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function replaceChanged(dest,data){
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  if(fs.existsSync(dest)&&hash(fs.readFileSync(dest))===hash(data))return false;
  const tmp=dest+'.tmp';fs.writeFileSync(tmp,data);fs.renameSync(tmp,dest);return true;
}
function atlasEntries(data,folder,namespace=''){
  const image=path.basename(data.meta.image.replace(/\.ktx2$/i,'.png'));
  const w=Number(data.meta.size?.w),h=Number(data.meta.size?.h),entries={};
  for(const[id,info]of Object.entries(data.frames||{})){
    const f=info.frame;
    if(!f||![f.x,f.y,f.w,f.h].every(Number.isFinite)||f.x<0||f.y<0||f.w<=0||f.h<=0||(w&&f.x+f.w>w)||(h&&f.y+f.h>h))throw new Error(`Некорректный frame: ${id}`);
    const value={atlas:`${folder}/${image}`,frame:f};
    entries[namespace+id]=value;
    // Постройки в API именуются без префикса d1, окружение использует namespace.
    if(namespace&&/^(RES_|COM_|SER_)/.test(id))entries[id]=value;
  }
  return{image,entries};
}
async function main(){
  const spriteMap={},downloads=[];
  for(const[key,base]of Object.entries(BASES)){
    console.log(`Loading ${key} manifest...`);
    const manifest=JSON.parse(await get(base+'manifest.json'));
    const files=Array.isArray(manifest)?manifest:Object.values(manifest);
    for(const fn of files){
      const data=JSON.parse(await get(base+fn));
      const folder=key==='d1'?'tiles/d1':key,{image,entries}=atlasEntries(data,folder,key==='d1'?'d1/':'');
      Object.assign(spriteMap,entries);downloads.push({url:base+image,dest:path.join(OUT,folder,image)});
    }
  }
  // Не публикуем новый sprite-map до успешного скачивания всех PNG.
  let changed=0;
  for(const{url,dest}of downloads){if(replaceChanged(dest,await get(url)))changed++;}
  replaceChanged(path.join(OUT,'sprite-map.json'),Buffer.from(JSON.stringify(spriteMap,null,2)+'\n'));
  console.log(`Done: ${downloads.length} PNG, updated ${changed}; ${Object.keys(spriteMap).length} sprites`);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={atlasEntries,replaceChanged};
