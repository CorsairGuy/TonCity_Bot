'use strict';
// Общий offline-процесс для островов: исходные RGBA → одна premultiplied-alpha LANCZOS
// фильтрация → один WebP encode. Кадры с соседним gutter нарезает существующий mapSprites.
// Независимый resize/encode отдельных фрагментов здесь намеренно не используется.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const prepare=String.raw`
from PIL import Image
import sys,json,math,os
source=json.load(open(sys.argv[1]));temp=sys.argv[2];output=sys.argv[3];scale=float(sys.argv[4]);gutter=16
w=source['meta']['sourceSize']['w'];h=source['meta']['sourceSize']['h'];rw=math.ceil(w*scale);rh=math.ceil(h*scale)
full=Image.new('RGBA',(w,h))
for tile in source['tiles']:
    rgba=Image.frombytes('RGBA',(tile['w'],tile['h']),open(os.path.join(temp,str(tile['index'])+'.rgba'),'rb').read())
    full.paste(rgba,(tile['x'],tile['y']))
full=full.convert('RGBa').resize((rw,rh),Image.Resampling.LANCZOS).convert('RGBA')
atlas=os.path.join(output,'island.webp')
full.save(atlas,'WEBP',quality=92,alpha_quality=100,exact=True,method=6)
decoded=Image.open(atlas).convert('RGBA')
assert full.getchannel('A').tobytes()==decoded.getchannel('A').tobytes(),'Alpha changed during shared encoding'
if len(sys.argv)>5 and sys.argv[5]:
    os.makedirs(os.path.dirname(sys.argv[5]),exist_ok=True)
    decoded.save(sys.argv[5])
def rounded(v): return math.floor(v+0.5)
def original(rect): return dict(x=rect['x']*w/rw,y=rect['y']*h/rh,w=rect['w']*w/rw,h=rect['h']*h/rh)
tiles=[]
for tile in source['tiles']:
    cx=rounded(tile['x']*rw/w);cy=rounded(tile['y']*rh/h)
    cx1=rounded((tile['x']+tile['w'])*rw/w);cy1=rounded((tile['y']+tile['h'])*rh/h)
    core=dict(x=cx,y=cy,w=cx1-cx,h=cy1-cy)
    x0=max(0,cx-gutter);y0=max(0,cy-gutter);x1=min(rw,cx1+gutter);y1=min(rh,cy1+gutter)
    rect=dict(x=x0,y=y0,w=x1-x0,h=y1-y0)
    tiles.append(dict(tile,image='island.webp',textureW=x1-x0,textureH=y1-y0,frame=rect,rasterRect=rect,coreRasterRect=core,sourceRect=original(rect),coreSourceRect=original(core)))
meta=dict(source['meta'],sourceScale=scale,rasterSize=dict(w=rw,h=rh),gutter=gutter,sharedAtlas=True)
with open(os.path.join(output,'island.json'),'w') as file:
    json.dump(dict(meta=meta,tiles=tiles),file,indent=2)
    file.write('\n')
`;
module.exports=async function convert({manifest,kind,scale}){
 const [input,basisPath,outArg,referenceArg]=process.argv.slice(2);
 if(!input||!basisPath)throw Error('Нужны каталог оригинальных KTX2 и basis_transcoder.js');
 const output=path.resolve(outArg||`src/web/sprites/${kind}-island`);
 const manifestBytes=fs.readFileSync(path.join(input,manifest)),source=JSON.parse(manifestBytes);
 const m=await require(path.resolve(basisPath))({wasmBinary:fs.readFileSync(path.join(path.dirname(basisPath),'basis_transcoder.wasm'))});
 m.initializeBasis();fs.mkdirSync(output,{recursive:true});
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),`toncity-${kind}-island-`)),sources=[];
 try{
  fs.writeFileSync(path.join(temp,'source.json'),manifestBytes);
  for(const tile of source.tiles){
   const bytes=fs.readFileSync(path.join(input,tile.image)),f=new m.KTX2File(new Uint8Array(bytes));
   try{
    if(f.getWidth()!==tile.w||f.getHeight()!==tile.h||!f.isValid()||!f.startTranscoding())throw Error(`Неверный KTX2: ${tile.image}`);
    const rgba=new Uint8Array(f.getImageTranscodedSizeInBytes(0,0,0,13));
    if(!f.transcodeImage(rgba,0,0,0,13,0,-1,-1))throw Error(`Не декодирован ${tile.image}`);
    fs.writeFileSync(path.join(temp,`${tile.index}.rgba`),rgba);
    sources.push({image:tile.image,sha256:hash(bytes),rgbaSha256:hash(rgba),hasAlpha:!!f.getHasAlpha()});
   }finally{f.close();f.delete();}
  }
  execFileSync('python3',['-c',prepare,path.join(temp,'source.json'),temp,output,String(scale),referenceArg?path.resolve(referenceArg):'']);
  const atlas=fs.readFileSync(path.join(output,'island.webp')),atlasHash=hash(atlas),atlasFile=`island-atlas-${atlasHash.slice(0,12)}.webp`;
  fs.renameSync(path.join(output,'island.webp'),path.join(output,atlasFile));
  const result=JSON.parse(fs.readFileSync(path.join(output,'island.json'),'utf8'));
  for(const tile of result.tiles)tile.image=atlasFile;
  fs.writeFileSync(path.join(output,'island.json'),JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(path.join(output,'provenance.json'),JSON.stringify({source:`https://game.toncity.io/assets/tiles/${kind==='d1'?'d1/':''}${manifest}`,sourceManifestSha256:hash(manifestBytes),decoder:'Original game Basis Universal transcoder, RGBA32 level 0',encoding:'One shared premultiplied-alpha LANCZOS resize and WebP quality92/method6 encode; alpha verified lossless after resize; shared raster frames with 16px neighbour gutters',atlas:{file:atlasFile,sha256:atlasHash},sources},null,2)+'\n');
  // Старые независимо кодированные файлы больше не используются.
  for(const file of fs.readdirSync(output))if(/^island-(?:\d+|atlas-[a-f0-9]+)\.webp$/.test(file)&&file!==atlasFile)fs.unlinkSync(path.join(output,file));
  console.log(`${kind}: shared atlas ${atlas.length} bytes, ${source.tiles.length} frames`);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
};
