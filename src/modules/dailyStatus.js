'use strict';
const fs=require('fs');
const path=require('path');

const STATUS_PATH=path.join(process.cwd(),'logs','daily_status.json');

function _today(){return new Date().toISOString().slice(0,10);}

function _load(){
  try{if(fs.existsSync(STATUS_PATH))return JSON.parse(fs.readFileSync(STATUS_PATH,'utf8'));}catch(_){}
  return {};
}

function _save(data){
  try{fs.writeFileSync(STATUS_PATH,JSON.stringify(data),'utf8');}catch(_){}
}

function isDone(accountId,task){
  const data=_load();
  const today=_today();
  return data[accountId]?.date===today&&Array.isArray(data[accountId].tasks)&&data[accountId].tasks.includes(task);
}

function markDone(accountId,task){
  const data=_load();
  const today=_today();
  if(!data[accountId]||data[accountId].date!==today)data[accountId]={date:today,tasks:[]};
  if(!data[accountId].tasks.includes(task))data[accountId].tasks.push(task);
  _save(data);
}

module.exports={isDone,markDone};
