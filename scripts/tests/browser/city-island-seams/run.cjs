'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const b=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});try{
 const p=await b.newPage(),errors=[],requests=[];p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push(r.url()));
 const origin=process.env.ISLAND_FIXTURE_URL||'http://127.0.0.1:5212';await p.goto(origin);await p.waitForFunction(()=>window.ready);
 const synthetic=await p.evaluate(()=>window.synthetic());assert(synthetic.beforeErrors>0,'fixture must reproduce the original edge-filtering artifact');assert.equal(synthetic.afterErrors,0);assert(synthetic.maxAfterError<=1);
 for(const district of ['main','d1'])for(const scale of [.23,.51,.87,1.31,1.97])for(const dpr of [1,2,3]){
  const image=await p.evaluate(args=>window.renderIsland(...args),[district,scale,dpr]);
  if(process.env.ISLAND_SCREENSHOTS&&scale===1.31&&dpr===1){fs.mkdirSync(process.env.ISLAND_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.ISLAND_SCREENSHOTS,`${district}.png`),Buffer.from(image.split(',')[1],'base64'));}
 }
 assert.deepEqual(errors,[]);assert(requests.every(u=>!/^https?:/.test(u)||u.startsWith(origin+'/')));
 assert.equal(requests.filter(u=>u.includes('island-atlas-')).length,2,'one shared atlas request per district');
 console.log('PASS',JSON.stringify(synthetic),'30 real-island renders, 2 shared downloads, no JS errors/external requests');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1);});
