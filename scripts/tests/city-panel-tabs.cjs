'use strict';
// Исполняем реальные панели с виртуальным окном, которое просит произвольные строки:
// бюджет нельзя считать только на видимых карточках, действия должны сохранять исходные ID.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../..'),ts=require(path.join(ROOT,'src/web/client/node_modules/typescript'));
const source=fs.readFileSync(path.join(ROOT,'src/web/client/src/pages/cityMapPanels.tsx'),'utf8');
const ast=ts.createSourceFile('panels.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=['PlanPanel','QueuePanel','PendingList','MovePanel','DemolishPanel','ReconstructPanel','RenovatePanel','BoostersPanel','LogPanel','ForecastPanel','dayTitle','byDay','dayPanelItems','planSum','cmpKeys'];
const context={exports:{},Map,Date,Math,Set,useState:initial=>[initial,()=>{}],useEffect:()=>{},useMemo:f=>f(),
 h:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),Fragment:'fragment',
 pctOf:(n,d)=>d?n/d*100:0,fillOf:x=>x,fmt:String,fmtUp:String,fmtTimeLeft:String,catalogItemImg:String,
 ITEMS_BY_ID:{},SWAP:{},PENDING_ICON:{},PENDING_BADGE:{},LOG_TYPE:{upgrade:['Улучшение','up','success.emphasis']},
 withPlace:(place,sub)=>place?`${place} · ${sub}`:sub};
for(const node of ast.statements){
 if(ts.isImportDeclaration(node))for(const e of node.importClause?.namedBindings?.elements??[])if(!(e.name.text in context))context[e.name.text]=e.name.text;
 if(ts.isFunctionDeclaration(node)&&node.name&&!names.includes(node.name.text)&&!(node.name.text in context))context[node.name.text]=node.name.text;
 if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations){const name=d.name.getText(ast);if(!(name in context))context[name]=name;}
}
context.MapPanelWindow='window';
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
vm.runInNewContext(ts.transpileModule(declarations,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,jsxFactory:'h',jsxFragmentFactory:'Fragment'}}).outputText,context);
function find(node,type){if(!node)return; if(Array.isArray(node)){for(const n of node){const x=find(n,type);if(x)return x;}}else if(typeof node==='object'){if(node.type===type)return node;for(const value of Object.values(node.props??{})){const x=find(value,type);if(x)return x;}}}
function windowOf(name,props){const root=context.exports[name](props),window=find(root,'window');assert(window,`${name}: нет окна`);return window.props;}
const labelFor=id=>id;
// Поздняя карточка должна видеть траты всех предыдущих, даже если их никогда не рисовали.
const cells=Array.from({length:70},(_,i)=>({x:i,y:0,level:1,req:10,queued:true,planned:false,ready:true}));
let window=windowOf('ReconstructPanel',{groups:[{id:'b',name:'B',comp:2,gain:1,cells}],components:8,summary:false});
assert.equal(window.count,70);assert.equal(window.children(60).props.trail.props.short,true);assert.equal(window.children(0).props.trail.props.short,false);
window=windowOf('RenovatePanel',{masterplans:6,items:cells.map(c=>({...c,marked:true,cost:2,nextId:'b',nextName:'B'})),summary:false});
assert.equal(window.count,70);assert.equal(window.children(69).props.trail.props.short,true);assert.equal(window.children(0).props.trail.props.short,false);
// Действия последнего окна адресуют полный список, а не видимый индекс 0..N.
let removed;const rows=Array.from({length:80},(_,i)=>({id:1000+i,kind:'build',label:'Постройка: B',sprite:'b'}));
window=windowOf('PendingList',{rows,labelFor,disabled:false,onRemove:id=>removed=id});
window.children(79).props.trail.props.onClick();assert.equal(removed,1079);
window=windowOf('MovePanel',{from:null,moves:rows.map(r=>({id:r.id,sprite:'b',from:{x:1,y:2},to:{x:3,y:4}})),labelFor,disabled:false,onRemove:id=>removed=id});
window.children(79).props.trail.props.onClick();assert.equal(removed,1079);
window=windowOf('DemolishPanel',{tiles:rows.map((r,i)=>({...r,name:'B',loss:i,level:1,x:i,y:0})),lossPerHour:100,popLoss:0,income:1000,disabled:false,summary:false,onRemove:id=>removed=id});
find(window.children(79),'IconButton').props.onClick();assert.equal(removed,1000); // порядок по потерям сохранён
// План и очередь также сохраняют исходные клетки и номера после прокрутки.
let marked;
window=windowOf('PlanPanel',{targets:cells.map(c=>({x:c.x,y:c.y,target_level:10})),owned:cells.map(c=>({...c,id:'b'})),labelFor,upgradeCost:()=>1,onHover:()=>{},removed:new Set(),onMarkRemoved:(ids,on)=>marked={ids,on}});
find(window.children(69),'Row').props.onClick();assert.deepEqual(Array.from(marked.ids),['69,0']);assert.equal(marked.on,true);
window=windowOf('QueuePanel',{queue:cells,owned:cells.map(c=>({...c,id:'b'})),labelFor,prices:cells.map(()=>2),balance:20,summary:false,onRemove:i=>removed=i,onReorder:()=>{}});
assert.equal(window.count,70);find(window.children(69),'IconButton').props.onClick();assert.equal(removed,69);
// Тот же номер у перетаскивания/удаления ускорителя, даже если первые строки скрыты.
const dragState=[null,()=>{}];context.useState=()=>dragState;
window=windowOf('BoostersPanel',{boosters:[],active:[],loading:false,queue:rows.map(r=>({name:String(r.id),label:'B'})),onRemoveAt:i=>removed=i,onReorder:()=>{},onAdd:()=>{}});
// Первое окно active пустое; найдём нужное по count во всём дереве.
function allWindows(node,out=[]){if(Array.isArray(node))node.forEach(n=>allWindows(n,out));else if(node&&typeof node==='object'){if(node.type==='window')out.push(node.props);allWindows(node.props?.children,out);}return out;}
const boosterWindows=allWindows(context.exports.BoostersPanel({boosters:[],active:[],loading:false,queue:rows.map(r=>({name:String(r.id),label:'B'})),onRemoveAt:i=>removed=i,onReorder:()=>{},onAdd:()=>{}}));
window=boosterWindows.find(w=>w.count===80);assert(window);find(window.children(79),'IconButton').props.onClick();assert.equal(removed,79);
// Дни и строки не меняют порядок, число/дату группы или полноту большого лога/прогноза.
const history=rows.map((r,i)=>({...r,type:'upgrade',building_id:'b',created_at:new Date(Date.UTC(2026,0,i<40?1:2,0,i%40)).toISOString(),level_from:i,level_to:i+1}));
window=windowOf('LogPanel',{rows:history,loading:false,label:()=>'',labelFor});
assert.equal(window.count,82);assert.equal(window.rowHeight(0),20);assert.equal(window.rowHeight(1),52);assert.equal(window.rowHeight(41),20);
assert.equal(window.children(81).props.sub,'79 → 80');
const items=context.exports.dayPanelItems(history,r=>new Date(r.created_at).getTime());
assert.equal(items[0].count,40);assert.equal(items[41].count,40);assert.deepEqual(Array.from(items.filter(i=>i.row).map(i=>i.row.id)),history.map(r=>r.id));
window=windowOf('ForecastPanel',{events:history.map(r=>({...r,start:Date.parse(r.created_at),duration_ms:100,boost_multiplier:2,boost_name:'X'})),loading:false,labelFor});
assert.equal(window.count,82);assert.equal(window.children(81).props.trail.props.ms,Date.parse(history[79].created_at));
console.log('PASS: все длинные вкладки используют окно; полные бюджеты, ID действий, порядок и группировка дней сохранены');
