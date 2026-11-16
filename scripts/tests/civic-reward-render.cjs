'use strict';
// Реальные GrantRow/ItemThumb/utils рендерятся с точным symbolic reward из клиента игры.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),src=path.join(root,'src/web/client/src'),client=path.join(root,'src/web/client/node_modules');
const React=require(path.join(client,'react')),{renderToStaticMarkup}=require(path.join(client,'react-dom/server')),esbuild=require(path.join(client,'esbuild'));
const cache=new Map();let requested=[];
function load(file){if(cache.has(file))return cache.get(file).exports;const module={exports:{}};cache.set(file,module);const code=esbuild.transformSync(fs.readFileSync(file,'utf8'),{loader:file.endsWith('.tsx')?'tsx':'ts',format:'cjs',jsx:'automatic'}).code;vm.runInNewContext(code,{module,exports:module.exports,Map,Set,Date,Number,String,Math,require:name=>{
 if(name==='react')return React;if(name==='react/jsx-runtime')return require(path.join(client,'react/jsx-runtime'));
 if(name==='@primer/react'){const component=({as='div',children,src,alt})=>React.createElement(as,{src,alt},children);return{Box:component,Text:props=>component({...props,as:'span'})};}
 if(name==='@primer/octicons-react')return{GiftIcon:()=>React.createElement('span',{'data-generic-reward':true})};
 if(name.endsWith('/utils'))return load(path.join(src,'utils.ts'));
 if(name.endsWith('/hooks/useItemCatalog')){const hooks=load(path.join(src,'hooks/useItemCatalog.ts'));return{...hooks,useItemCatalog:ids=>{requested.push(...ids);return new Map();}};}
 if(name.endsWith('/components/ItemThumb'))return load(path.join(src,'components/ItemThumb.tsx'));
 return{};
 }});return module.exports;}
const{GrantRow,policyGrantReward}=load(path.join(src,'pages/CivicDraw.tsx'));
function render(kind,reward){return renderToStaticMarkup(React.createElement(GrantRow,{grant:{def_id:'founder_charter',kind,reward,amount:2,ready:1,ready_at:null},now:Date.now()}));}
for(const[reward,name,icon]of[['masterplan','Мастерплан','masterplan.png'],['component','Компонент','component.png'],[12,'Мастерплан','masterplan.png'],['13','Компонент','component.png']]){const html=render('item',reward);assert(html.includes(name+' ×2'));assert(html.includes(icon));assert(!html.includes('NaN'));}
for(const kind of ['shard','shards','policy_shard'])assert(render(kind,'rare').includes('shard_rare.png'));
const shard=render('shard','legendary');assert(shard.includes('Легендарная осколки ×2'));assert(shard.includes('shard_legendary.png'));
const generic=render('item','future_resource');assert(generic.includes('future_resource'));assert(generic.includes('data-generic-reward'));assert(!generic.includes('shard_future_resource'));assert(!generic.includes('NaN'));
for(const reward of ['',0,-1,'Infinity','0x12','NaN']){assert.equal(policyGrantReward({kind:'item',reward}).type,'unknown');render('item',reward);}
assert(requested.every(id=>Number.isSafeInteger(id)&&id>0),'catalog must never receive NaN/invalid IDs');
console.log('PASS actual policy reward rendering: symbolic masterplan/component, numeric IDs, shard icon, unknown fallback, no NaN catalog IDs');
