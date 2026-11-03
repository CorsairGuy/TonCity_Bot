'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const read=p=>fs.readFileSync(path.join(root,p),'utf8'),ctx={module:{exports:{}},require:name=>JSON.parse(read('src/web/client/src/'+name))};
vm.runInNewContext(esbuild.transformSync(read('src/web/client/src/cityIsland.ts'),{loader:'ts',format:'cjs'}).code,ctx);
const {d1IslandRects,mainIslandRects,D1_ISLAND_SPRITES,MAIN_ISLAND_SPRITES,islandClipRect}=ctx.module.exports;
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
let total=0,edges=0;
for(const district of ['d1','main']){
 const manifest=JSON.parse(read(`src/web/client/src/data/${district}-island.json`));
 const runtime=JSON.parse(read(`src/web/sprites/${district}-island/island.json`));assert.deepEqual(manifest,runtime);
 const proof=JSON.parse(read(`src/web/sprites/${district}-island/provenance.json`));
 const bytes=fs.readFileSync(path.join(root,`src/web/sprites/${district}-island/${proof.atlas.file}`));total+=bytes.length;
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),proof.atlas.sha256);
 assert.equal(bytes.toString('ascii',12,16),'VP8X');assert(bytes[20]&16);
 assert.equal(bytes.readUIntLE(24,3)+1,manifest.meta.rasterSize.w);assert.equal(bytes.readUIntLE(27,3)+1,manifest.meta.rasterSize.h);
 const place=district==='d1'?d1IslandRects:mainIslandRects,sprites=district==='d1'?D1_ISLAND_SPRITES:MAIN_ISLAND_SPRITES;
 const rects=place(200,100,90,52);assert.equal(rects.length,district==='d1'?12:11);
 const urls=new Set(Object.values(sprites).map(s=>s.pngUrl));assert.equal(urls.size,1);assert.equal(new Set(rects.map(r=>r.id)).size,rects.length);
 for(let i=0;i<rects.length;i++){
  const t=manifest.tiles[i],r=rects[i],f=sprites[r.id].frame;
  assert.deepEqual(JSON.parse(JSON.stringify(f)),t.rasterRect);assert.equal(f.w,t.textureW);assert.equal(f.h,t.textureH);
  assert(f.x>=0&&f.y>=0&&f.x+f.w<=manifest.meta.rasterSize.w&&f.y+f.h<=manifest.meta.rasterSize.h);
  assert(r.x0<=r.core.x0&&r.x1>=r.core.x1&&r.y0<=r.core.y0&&r.y1>=r.core.y1);
  if(district==='d1'){
   near(r.core.x0,200+(t.coreSourceRect.x-(3444.3-376.5))*90/753);
   near(r.core.y0,100+(t.coreSourceRect.y-(-173.9-217))*52/434);
  }else{
   near(r.core.x0,200+(5508.5-9773*.851/2+t.coreSourceRect.x*.851-5311.75)*90/376.5);
   near(r.core.y0,100+(7223-5183*.851/2+t.coreSourceRect.y*.851-2713)*52/217);
  }
  const shifted=place(1325,-550,90,52)[i];near(shifted.x0-r.x0,1125);near(shifted.y0-r.y0,-650);
  for(let j=0;j<rects.length;j++){
   const u=manifest.tiles[j];if(t.y!==u.y||t.x+t.w!==u.x)continue;
   near(r.core.x1,rects[j].core.x0);edges++;
   for(const scale of [.13,.23,.51,.87,1.31,1.97,3.94,5.91]){
    const m={a:scale,d:scale,e:.37,f:-.23},a=islandClipRect(r.core,m),b=islandClipRect(rects[j].core,m);
    near(a.x1,b.x0);near((a.x1*m.a+m.e),Math.round(a.x1*m.a+m.e));
   }
  }
 }
}
assert(total<3_000_000);console.log(`PASS shared atlas geometry, neighbour gutters, pixel-aligned seam coverage, alpha/SHA256, 23 unique frames / 2 URLs / ${total} bytes`);
// Смена района удаляет старые DOM-куски, но не сбрасывает кэш неизменившейся карты.
const canvas=read('src/web/client/src/components/CityActionsCanvas.tsx');
const a=canvas.indexOf('    if (s.layerMapKey !== loadKey)'),b=canvas.indexOf('    s.roadMap =',a);assert(a>=0&&b>a);
const state={layerMapKey:'city:world:main',layers:new Map([[1,{}],[2,{}]]),coarseImg:new Map([[0,{}]]),coarseDirty:new Set([0]),cityParts:[{}]},dropped=[];
const swap=()=>vm.runInNewContext(canvas.slice(a,b),{s:state,loadKey:'city:world:d1',dropLayer:r=>{dropped.push(r);state.layers.delete(r);}});
swap();assert.deepEqual(dropped,[1,2]);assert.equal(state.coarseImg.size,0);assert.equal(state.cityParts.length,0);swap();assert.deepEqual(dropped,[1,2]);
// Обзор включает скалы при сохранённом шаге между городами.
const world=read('src/web/client/src/pages/CityWorld.tsx'),fitSource=world.slice(world.indexOf('  const fitTile ='),world.indexOf('  const enterTile ='));
for(const count of [1,4,7]){
 const cols=Math.ceil(Math.sqrt(count)),offOf=new Map(Array.from({length:count},(_,i)=>[String(i),{ox:i%cols*25,oy:Math.floor(i/cols)*25}]));
 const fit=vm.runInNewContext(esbuild.transformSync(fitSource,{loader:'ts'}).code+';fitTile()',{boxSize:()=>({W:1200,H:800}),cities:Array(count),cols,offOf,district:'main',STEP:25,SPAN:22,TH_K:434/753,mainIslandRects,Math});
 const cx=(fit.cx-fit.cy+1)/2,cy=(fit.cx+fit.cy+1)*434/753/2;
 for(const o of offOf.values())for(const r of mainIslandRects((o.ox-o.oy)/2,(o.ox+o.oy)*434/753/2,1,434/753)){
  for(const x of [r.x0,r.x1])assert(Math.abs((x-cx)*fit.tile)<600);
  for(const y of [r.y0,r.y1])assert(Math.abs((y-cy)*fit.tile)<400);
 }
}
console.log('PASS district cache reset and full-cliff overview for 1/4/7 cities with original spacing');
