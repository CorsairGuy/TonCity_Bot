'use strict';
// Состояние бота, разделяемое между веб-сервером и циклами прокачки.
// Хранится в config/bot-state.json, читается заново при каждом обращении,
// чтобы переключение паузы из веба сразу влияло на работающие циклы.
const fs=require('fs'),path=require('path');
const FP=path.join(process.cwd(),'config','bot-state.json');
function read(){
  try{return JSON.parse(fs.readFileSync(FP,'utf8'))||{};}
  catch(_){return{};}
}
function write(state){
  const tmp=FP+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(state,null,2),'utf8');
  fs.renameSync(tmp,FP);
  return state;
}
function isCityPaused(){return !!read().cityPaused;}
function setCityPaused(v){const s=read();s.cityPaused=!!v;return write(s);}
module.exports={read,write,isCityPaused,setCityPaused};
