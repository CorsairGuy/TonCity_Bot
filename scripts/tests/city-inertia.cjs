'use strict';
// Реальные обработчики камеры без React/БД/API: проверяем непрерывность render-position.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/components/CityActionsCanvas.tsx'),'utf8');
function part(a,b){const i=src.indexOf(a),j=src.indexOf(b,i+1);assert(i>=0&&j>i);return src.slice(i,j);}
const routines=part('  function clampPan()','  // ширина спрайта под максимальный зум')+part('  function syncLayer(','  // подписи бейджей');
for(const dpr of [1,1.25,2,3])for(const dt of [16,1000/120]){
 let now=1000,frames=0;const layer={dataset:{},style:{}},s={ox:-400.13,oy:-200.31,scale:.8,dpr,cols:40,rows:40,layerR:.8*dpr,layers:new Map([[.8*dpr,layer]]),nightHold:true,pan:[],inertia:null};
 const context=vm.createContext({state:{current:s},wrapRef:{current:{clientWidth:900,clientHeight:700}},performance:{now:()=>now},TW:90,TH:52,INERTIA_FRICTION:.98,INERTIA_MIN:.01,layerFor:()=>layer,requestRedraw:()=>frames++});
 vm.runInContext(esbuild.transformSync(routines,{loader:'ts'}).code,context);
 const sync=()=>{vm.runInContext('syncLayer(900,700)',context);const m=layer.style.transform.match(/translate\(([^p]+)px,([^p]+)px\)/);assert(m);assert(Math.abs(Number(m[1])-s.ox)<1e-9,`DPR${dpr}: buildings snapped ${m[1]} vs camera ${s.ox}`);assert(Math.abs(Number(m[2])-s.oy)<1e-9);};
 // Одинаковый механизм после mouseup и touchend: startInertia читает историю протяжки.
 s.pan=[{x:s.ox-50,y:s.oy-25,t:now-100}];vm.runInContext('startInertia()',context);assert(s.inertia);
 let smallSteps=0,lastX=s.ox;
 while(s.inertia&&now<10000){now+=dt;vm.runInContext('stepInertia()',context);sync();assert(s.ox>=lastX);if(s.ox-lastX>0&&s.ox-lastX<1/dpr)smallSteps++;lastX=s.ox;}
 assert(!s.inertia);assert(smallSteps>10);const final={x:s.ox,y:s.oy};now+=1000;vm.runInContext('stepInertia()',context);sync();assert.equal(s.ox,final.x);assert.equal(s.oy,final.y);
 // После новой протяжки сохраняется её точная дробная позиция; у края скорость оси гаснет.
 s.ox=-300.271;s.oy=-220.193;sync();s.ox=780;s.pan=[{x:730,y:s.oy,t:now-100}];vm.runInContext('startInertia()',context);now+=dt;vm.runInContext('stepInertia()',context);assert.equal(s.ox,780);assert(!s.inertia||s.inertia.vx===0);sync();assert(frames>0);
}
console.log('PASS actual inertia + layer renderer: continuous fractional tail, stable stop, new drag, clamp, DPR1/1.25/2/3 at 60/120Hz');
