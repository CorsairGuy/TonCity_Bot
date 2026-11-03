'use strict';
// Реальный модуль и общая база: один аккаунт ошибается, следующий уже знает ответ.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/modules/quiz.js'),'utf8');
function fixture(){
 const rows=new Map(),posts=[];
 const db={QuizAnswer:{
  async upsert(row){rows.set(`${row.question_id}:${row.answer_id}`,{...row});},
  async findAll({where={}}={}){return [...rows.values()].filter(r=>Object.entries(where).every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));},
  async destroy({where}){for(const[k,r]of rows)if(Object.entries(where).every(([key,v])=>Array.isArray(v)?v.includes(r[key]):r[key]===v))rows.delete(k);},
 },MinigameLog:{async upsert(){}}};
 const mod={exports:{}};vm.runInNewContext(source,{module:mod,exports:mod.exports,require:name=>{
  if(name==='../db/index')return db;
  if(name==='../utils/helpers')return{sleep:async()=>{}};
  if(name==='../utils/logger')return{info(){},warn(){}};
  throw Error(name);
 }});
 async function play(response,prune=true){
  const q={id:17,text:'Вопрос',answers:[{id:1},{id:2},{id:3}]};let reads=0;
  const api={async get(){return ++reads===1?{game_started:true,questions:[q]}:{game_complete:true,reward:10,total_score:1};},async post(url,body){assert.equal(url,'/quiz/answer');posts.push({...body});return response;}};
  await mod.exports.solveQuiz(api,'fixture',null,prune);
 }
 return{rows,posts,play};
}
(async()=>{
 const a=fixture();await a.play({is_correct:false,correct_answer_ids:['2',3,3,999,null,{},true]});
 assert.deepEqual([...a.rows.values()].map(r=>[r.answer_id,r.status]),[[2,'correct'],[3,'correct']]);
 assert.equal(a.posts[0].answer_id,1);await a.play({is_correct:true});assert.equal(a.posts[1].answer_id,2);
 const b=fixture();await b.play({is_correct:false});assert.equal(b.rows.get('17:1').status,'wrong');assert.equal(b.rows.size,1);
 const c=fixture();await c.play({is_correct:false,correct_answer_ids:'2'});assert.equal(c.rows.size,1);assert.equal(c.rows.get('17:1').status,'wrong');
 const d=fixture();d.rows.set('17:999',{question_id:17,answer_id:999,status:'correct'});await d.play({is_correct:false,correct_answer_ids:[2]},false);
 assert.equal(d.posts[0].answer_id,1);assert.equal(d.rows.get('17:1').status,'wrong');assert.equal(d.rows.get('17:2').status,'correct');
 console.log('PASS: раскрытые ответы учат общую базу, ID проверены по вопросу, устаревший cache не отправляется, legacy/prune fallback сохранён');
})().catch(e=>{console.error(e);process.exitCode=1;});
