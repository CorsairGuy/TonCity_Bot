'use strict';
// node scripts/tools/main-island-convert.cjs <game-assets/tiles> <basis_transcoder.js> [output]
// Оригинальный Basis WASM лежит рядом с переданным basis_transcoder.js. Python Pillow нужен
// только при подготовке ассетов: в runtime используются готовые прозрачные WebP (0.85x, quality92, alpha без потерь после resample).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const [input,basisPath,outArg]=process.argv.slice(2);
if(!input||!basisPath)throw Error('Нужны каталог оригинальных ассетов главного острова и basis_transcoder.js');
const output=path.resolve(outArg||'src/web/sprites/main-island');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
(async()=>{
 const manifestBytes=fs.readFileSync(path.join(input,'floating_island.json')),source=JSON.parse(manifestBytes);
 const m=await require(path.resolve(basisPath))({wasmBinary:fs.readFileSync(path.join(path.dirname(basisPath),'basis_transcoder.wasm'))});
 m.initializeBasis();fs.mkdirSync(output,{recursive:true});
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'toncity-main-island-'));
 const tiles=[],sources=[];
 try{
  for(const tile of source.tiles){
   const bytes=fs.readFileSync(path.join(input,tile.image)),f=new m.KTX2File(new Uint8Array(bytes));
   try{
    const width=f.getWidth(),height=f.getHeight();
    if(width!==tile.w||height!==tile.h||!f.isValid()||!f.startTranscoding())throw Error(`Неверный KTX2: ${tile.image}`);
    const rgba=new Uint8Array(f.getImageTranscodedSizeInBytes(0,0,0,13)); // Basis cTFRGBA32
    if(!f.transcodeImage(rgba,0,0,0,13,0,-1,-1))throw Error(`Не декодирован ${tile.image}`);
    const raw=path.join(temp,'tile.rgba'),name=`island-${tile.index}.webp`;
    fs.writeFileSync(raw,rgba);
    execFileSync('python3',['-c',
     'from PIL import Image\nimport sys, math\ni=Image.frombytes("RGBA",(int(sys.argv[2]),int(sys.argv[3])),open(sys.argv[1],"rb").read())\ni=i.convert("RGBa").resize((math.ceil(i.width*0.85),math.ceil(i.height*0.85)),Image.Resampling.LANCZOS).convert("RGBA")\ni.save(sys.argv[4],"WEBP",quality=92,alpha_quality=100,exact=True,method=6)\nr=Image.open(sys.argv[4]).convert("RGBA")\nassert i.getchannel("A").tobytes()==r.getchannel("A").tobytes(), "Alpha changed during encoding"\nassert i.size==r.size\n',
     raw,String(width),String(height),path.join(output,name)]);
    tiles.push({...tile,image:name,textureW:Math.ceil(width*0.85),textureH:Math.ceil(height*0.85)});
    sources.push({image:tile.image,sha256:hash(bytes),output:name,outputSha256:hash(fs.readFileSync(path.join(output,name))),rgbaSha256:hash(rgba),hasAlpha:!!f.getHasAlpha()});
   }finally{f.close();f.delete();}
  }
  fs.writeFileSync(path.join(output,'island.json'),JSON.stringify({meta:{...source.meta,sourceScale:0.85},tiles},null,2)+'\n');
  fs.writeFileSync(path.join(output,'provenance.json'),JSON.stringify({source:'https://game.toncity.io/assets/tiles/floating_island.json',sourceManifestSha256:hash(manifestBytes),decoder:'Original game Basis Universal transcoder, RGBA32 level 0',encoding:'WebP quality92, method6, 0.85x premultiplied-alpha LANCZOS; alpha verified lossless after resample',sources},null,2)+'\n');
  console.log(`${tiles.length} fragments: ${sources.reduce((n,t)=>n+fs.statSync(path.join(output,t.output)).size,0)} bytes`);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
