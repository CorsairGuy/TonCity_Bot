'use strict';
// Настоящая математика окна и метаданные очереди; без браузера, БД и игровых аккаунтов.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../..'),esbuild=require(path.join(ROOT,'src/web/client/node_modules/esbuild'));
const source=fs.readFileSync(path.join(ROOT,'src/web/client/src/components/MapPanelWindow.tsx'),'utf8');
const start=source.indexOf('export const PANEL_ROW_HEIGHT'),end=source.indexOf('// Монтируем лишь');
assert(start>=0&&end>start);
const code=source.slice(start,end).replaceAll('export ','');
const sandbox={Map,Set};vm.createContext(sandbox);
vm.runInContext(esbuild.transformSync(code+'\nthis.windowOf=panelWindow;this.indices=panelWindowIndices;this.step=PANEL_ROW_STEP;this.gap=PANEL_ROW_GAP;this.offsets=panelOffsets;this.variableWindow=variablePanelWindow;this.nextFocus=nextPanelFocus;',{loader:'ts',target:'es2022'}).code,sandbox);
const plain=a=>JSON.parse(JSON.stringify(a));
assert.equal(sandbox.step,60);assert.equal(64*sandbox.step-sandbox.gap,3832);
assert.deepEqual(plain(sandbox.windowOf(0,0,500)),{start:0,end:0});
assert.deepEqual(plain(sandbox.windowOf(64,0,300)),{start:0,end:6});
assert.deepEqual(plain(sandbox.windowOf(64,600,300)),{start:9,end:16});
assert.deepEqual(plain(sandbox.windowOf(64,3600,300)),{start:59,end:64});
assert.deepEqual(plain(sandbox.windowOf(64,-600,300)),{start:0,end:0});
assert.deepEqual(plain(sandbox.indices(64,59,64,[0,63,null,100,-1])),[0,59,60,61,62,63]);
assert.equal(sandbox.indices(200000,10000,10010,[0,199999]).length,12);
for(let count=0;count<100;count++)for(let offset=-400;offset<7000;offset+=61){
 const r=sandbox.windowOf(count,offset,450);assert(r.start>=0&&r.end>=r.start&&r.end<=count);
 const indices=sandbox.indices(count,r.start,r.end,[0,count-1]);assert(indices.every((i,n)=>i>=0&&i<count&&(n===0||indices[n-1]<i)));
}
console.log('PASS: окно сохраняет полную высоту/абсолютные индексы, ограничивает DOM и закрепляет drag/focus');
const panels=fs.readFileSync(path.join(ROOT,'src/web/client/src/pages/cityMapPanels.tsx'),'utf8');
const queueStart=panels.indexOf('export function QueuePanel('),a=panels.indexOf('  const positions = useMemo(',queueStart),b=panels.indexOf('\n  return (',a);
assert(queueStart>=0&&a>queueStart&&b>a);
const positions=esbuild.transformSync(`(()=>{${panels.slice(a,b)};return positions;})()`,{loader:'ts',target:'es2022'}).code;
let seed=773;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
for(let fixture=0;fixture<128;fixture++){
 const owned=Array.from({length:48},(_,i)=>({x:i%12,y:Math.floor(i/12),id:'b'+i,level:1+(i%20)}));
 owned.push({...owned[0],level:999}); // прежний find выбирал первое здание на клетке
 const queue=Array.from({length:64+fixture},()=>({x:Math.floor(rand()*14),y:Math.floor(rand()*5)}));
 const actual=vm.runInNewContext(positions,{queue,owned,Map,useMemo:f=>f()});
 const expected=queue.map((q,i)=>{const b=owned.find(o=>o.x===q.x&&o.y===q.y);const prior=queue.slice(0,i).filter(p=>p.x===q.x&&p.y===q.y).length;return{b,from:b?(Number(b.level)||0)+prior:null};});
 assert.deepEqual(plain(actual),plain(expected));
 const range=sandbox.windowOf(queue.length,Math.max(0,queue.length*60-450),450);
 for(const i of sandbox.indices(queue.length,range.start,range.end,[0]))assert.deepEqual(plain(actual[i]),plain(expected[i]));
}
console.log('PASS: уровни/повторы всей очереди совпадают с прежней формулой, в том числе в последнем окне');

// Смесь заголовков и карточек: координаты и видимость сверяем с прямым обходом.
for(let count=0;count<100;count++) {
 const heights=Array.from({length:count},(_,i)=>i%9===0?20:52);
 const offsets=sandbox.offsets(count,i=>heights[i]);
 assert.equal(offsets.length,count+1);
 for(let i=0;i<count;i++)assert.equal(offsets[i+1]-offsets[i],heights[i]+8);
 for(let top=-500;top<(offsets[count]||0)+500;top+=79){
  const r=sandbox.variableWindow(offsets,top,450);
  assert(r.start>=0&&r.end>=r.start&&r.end<=count);
  for(let i=0;i<count;i++)if(offsets[i]+heights[i]>top&&offsets[i]<top+450)assert(i>=r.start&&i<r.end);
  assert(r.end-r.start<=Math.ceil(450/28)+4);
 }
}
console.log('PASS: смешанные высоты/заголовки, пустые и полностью невидимые списки, ограниченное окно');

assert.equal(sandbox.nextFocus(500,0,1,i=>i===499),499);
assert.equal(sandbox.nextFocus(500,499,-1,i=>i===0),0);
assert.equal(sandbox.nextFocus(500,-1,1,()=>false),null);
assert.equal(sandbox.nextFocus(500,500,-1,i=>i===250),250);
console.log('PASS: Tab/Shift+Tab пропускают недоступные действия без монтирования пропущенных строк');
// Настоящий effect диапазона: RAF не делает синхронный render списка во время ввода карты.
const effectStart=source.indexOf('  useEffect(() => {\n    if (small) return;');
const effectEnd=source.indexOf('  }, [offsets, small, scrollViewport]);',effectStart);
assert(effectStart>=0&&effectEnd>effectStart);
const effectCode=source.slice(effectStart+'  useEffect('.length,effectEnd)+'  }';
const frames=[],transitions=[],changes=[],listeners=new Map();let observer;
const viewport={clientHeight:300,firstElementChild:null,getBoundingClientRect:()=>({top:0}),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
const effectContext={small:false,ref:{current:{getBoundingClientRect:()=>({top:-600})}},scrollViewport:viewport,
 offsets:sandbox.offsets(500,52),variablePanelWindow:sandbox.variableWindow,
 requestAnimationFrame:fn=>(frames.push(fn),frames.length),cancelAnimationFrame:()=>{},
 ResizeObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){}},
 startTransition:fn=>transitions.push(fn),setRange:fn=>changes.push(plain(fn({start:0,end:1})))};
const cleanup=vm.runInNewContext(esbuild.transformSync('('+effectCode+')()',{loader:'ts',target:'es2022'}).code,effectContext);
assert.equal(frames.length,1);frames.shift()();assert.equal(changes.length,0);assert.equal(transitions.length,1);
transitions.shift()();assert(changes[0].start>0&&changes[0].end<30);
cleanup();observer();assert.equal(frames.length,0);assert.equal(listeners.size,0);
console.log('PASS: фактический RAF/ResizeObserver effect применяет диапазон фоном и отключается при размонтировании');
