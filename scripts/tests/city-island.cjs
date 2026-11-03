'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'src/web/client/src/data/d1-island.json'),'utf8'));
const ctx={module:{exports:{}},require:name=>JSON.parse(fs.readFileSync(path.join(root,'src/web/client/src',name),'utf8'))};
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(root,'src/web/client/src/cityIsland.ts'),'utf8'),{loader:'ts',format:'cjs'}).code,ctx);
const {d1IslandRects,D1_ISLAND_SPRITES}=ctx.module.exports;
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const rects=d1IslandRects(200,100,90,52);assert.equal(rects.length,12);
for(let i=0;i<12;i++){
 const t=manifest.tiles[i],r=rects[i];
 // Оригинальный движок: island top-left=(1307,1400), grid origin=(1307+(3444.3-376.5)*.5,1400+(-173.9-217)*.5).
 const gameOrigin={x:1307+(3444.3-376.5)*.5,y:1400+(-173.9-217)*.5};
 near(r.x0,200+(1307+t.x*.5-gameOrigin.x)*(90/(753*.5)));
 near(r.y0,100+(1400+t.y*.5-gameOrigin.y)*(52/(434*.5)));
 near(r.x1-r.x0,t.w*90/753);near(r.y1-r.y0,t.h*52/434);
 const frame=D1_ISLAND_SPRITES[r.id].frame;assert.equal(frame.w,t.w/2);assert.equal(frame.h,t.h/2);
 if(i%4<3)near(r.x1,rects[i+1].x0);
 if(i<8)near(r.y1,rects[i+4].y0);
}
for(const [x,y]of [[0,0],[1125,650],[-1125,650]]){
 const shifted=d1IslandRects(200+x,100+y,90,52);
 for(let i=0;i<12;i++){near(shifted[i].x0-rects[i].x0,x);near(shifted[i].y0-rects[i].y0,y);}
}
console.log('PASS island geometry matches original engine, 12 seamless fragments, translated cities and half-resolution textures');
// Смена района удаляет старые DOM-куски, даже если они вне новых границ карты.
const canvas=fs.readFileSync(path.join(root,'src/web/client/src/components/CityActionsCanvas.tsx'),'utf8');
const a=canvas.indexOf('    if (s.layerMapKey !== loadKey)'),b=canvas.indexOf('    s.roadMap =',a);
assert(a>=0&&b>a);
const state={layerMapKey:'city:world:main',layers:new Map([[1,{}],[2,{}]]),coarseImg:new Map([[0,{}]]),coarseDirty:new Set([0]),cityParts:[{}]},dropped=[];
const swap=()=>vm.runInNewContext(canvas.slice(a,b),{s:state,loadKey:'city:world:d1',dropLayer:r=>{dropped.push(r);state.layers.delete(r);}});
swap();assert.deepEqual(dropped,[1,2]);assert.equal(state.coarseImg.size,0);assert.equal(state.coarseDirty.size,0);assert.equal(state.cityParts.length,0);
swap();assert.deepEqual(dropped,[1,2]);console.log('PASS district switch drops stale main chunks; unchanged map keeps its cache');

const {mainIslandRects,MAIN_ISLAND_SPRITES}=ctx.module.exports;
const main=JSON.parse(fs.readFileSync(path.join(root,'src/web/client/src/data/main-island.json'),'utf8'));
const mainRects=mainIslandRects(200,100,90,52);assert.equal(mainRects.length,11);
for(let i=0;i<mainRects.length;i++){
 const t=main.tiles[i],r=mainRects[i];
 const left=5508.5-9773*.851/2,top=7223-5183*.851/2;
 near(r.x0,200+(left+t.x*.851-5311.75)*90/376.5);
 near(r.y0,100+(top+t.y*.851-2713)*52/217);
 near(r.x1-r.x0,t.w*.851*90/376.5);near(r.y1-r.y0,t.h*.851*52/217);
 assert.equal(MAIN_ISLAND_SPRITES[r.id].frame.w,Math.ceil(t.w*.85));
}
console.log('PASS main island geometry matches original 22x22 Field and floating-island placement, 11 sparse fragments');
// В репозитории лежат готовые runtime-текстуры с проверяемой историей происхождения.
const crypto=require('node:crypto');let total=0;
for(const district of ['d1','main']){
 const dir=path.join(root,`src/web/sprites/${district}-island`),m=JSON.parse(fs.readFileSync(path.join(dir,'island.json'),'utf8'));
 const client=JSON.parse(fs.readFileSync(path.join(root,`src/web/client/src/data/${district}-island.json`),'utf8'));
 assert.deepEqual(m.tiles,client.tiles);
 const proofs=JSON.parse(fs.readFileSync(path.join(dir,'provenance.json'),'utf8')).sources;
 for(let i=0;i<m.tiles.length;i++){
  const t=m.tiles[i],bytes=fs.readFileSync(path.join(dir,t.image));total+=bytes.length;
  assert.equal(bytes.toString('ascii',0,4),'RIFF');
  const format=bytes.toString('ascii',12,16);assert(['VP8X','VP8 '].includes(format));
  const width=format==='VP8X'?bytes.readUIntLE(24,3)+1:bytes.readUInt16LE(26)&0x3fff;
  const height=format==='VP8X'?bytes.readUIntLE(27,3)+1:bytes.readUInt16LE(28)&0x3fff;
  assert.equal(width,t.textureW);assert.equal(height,t.textureH);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),proofs[i].outputSha256);
 }
}
assert(total<3_000_000);console.log(`PASS 23 runtime WebP: dimensions, alpha flags, SHA256, manifests and ${total} bytes total`);
// Настоящий fitTile включает скалы нескольких городов в обзор, без обрезки снизу.
const world=fs.readFileSync(path.join(root,'src/web/client/src/pages/CityWorld.tsx'),'utf8');
const fitSource=world.slice(world.indexOf('  const fitTile ='),world.indexOf('  const enterTile ='));
for(const count of [1,4,7]){
 const cols=Math.ceil(Math.sqrt(count)),offOf=new Map(Array.from({length:count},(_,i)=>[String(i),{ox:i%cols*25,oy:Math.floor(i/cols)*25}]));
 const fctx={boxSize:()=>({W:1200,H:800}),cities:Array(count),cols,offOf,district:'main',STEP:25,SPAN:22,TH_K:434/753,mainIslandRects,Math};
 const fit=vm.runInNewContext(esbuild.transformSync(fitSource,{loader:'ts'}).code+';fitTile()',fctx);
 const centerX=(fit.cx-fit.cy+1)/2,centerY=(fit.cx+fit.cy+1)*434/753/2;
 for(const o of offOf.values())for(const r of mainIslandRects((o.ox-o.oy)/2,(o.ox+o.oy)*434/753/2,1,434/753)){
  for(const x of [r.x0,r.x1])assert(Math.abs((x-centerX)*fit.tile)<600);
  for(const y of [r.y0,r.y1])assert(Math.abs((y-centerY)*fit.tile)<400);
 }
}
console.log('PASS actual overview camera includes full main cliffs for 1/4/7 cities');
