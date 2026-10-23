'use strict';
// Запись партий 2048 для анализа алгоритма (features.game2048Record, переключатель на странице 2048).
// Партия целиком копится в памяти и пишется ОДНИМ файлом в конце игры — по ходу партии диск не
// трогаем вовсе: logs/2048/ГГГГ-ММ-ДД/<аккаунт>-<ЧЧММСС>-<итог>.json.gz (дата и время UTC).
// Папка logs/ подключена с хоста, файлы сразу видны рядом с логами бота.
//
// Формат (v:1) — gzip-JSON:
//   {v,algo,account,startedAt,finishedAt,result,error?,start:{board,score},end:{board,score,max_tile,
//    game_status,reward},moves:[[d,cell,val,ms,depth],...]}
//   d — индекс направления в dirs (up,down,left,right); cell — клетка, где выпала новая плитка
//   (r*4+c), val — её значение (2/4); ms — сколько думал алгоритм (у человека — пауза между ходами);
//   depth — глубина поиска, 0 = ход человека из модалки. Если выпавшую плитку не удалось однозначно
//   вычислить (ресинк после сбоя хода), cell=-1, val=0, а 6-м элементом идёт вся доска после хода
//   (16 чисел по строкам). Доски восстанавливаются проигрыванием ходов: наш move() — порт игрового 1:1.
// Ходы человека и бота одного аккаунта пишутся в одну партию (можно начать руками и нажать «Решить»).
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const logger=require('./logger');

const DIR_DIR=path.join(process.cwd(),'logs','2048');
const IDLE_MS=30*60_000; // ручную партию, брошенную посреди игры, сохраняем как unfinished

const sessions=new Map(); // accountId -> {name,rec,board,lastAt,idle}

function enabled(){
  try{return!!require('../config').getConfig().features?.game2048Record;}catch(_){return false;}
}
const flat=b=>b.flat();
const clone=b=>b.map(r=>[...r]);

// новая плитка: клетка, пустая после нашего хода и непустая в ответе сервера, а остальное совпадает
function findSpawn(sim,after){
  let spawn=null;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    if(sim[r][c]===after[r][c])continue;
    if(sim[r][c]!==0||spawn||(after[r][c]!==2&&after[r][c]!==4))return null;
    spawn=[r*4+c,after[r][c]];
  }
  return spawn;
}

function open(accountId,name,board,score){
  let s=sessions.get(accountId);
  if(s)return s;
  if(!board||!enabled())return null;
  const{ALGO_VERSION,DIRS}=require('../modules/game2048');
  s={name,board:clone(board),lastAt:Date.now(),idle:null,
    rec:{v:1,algo:ALGO_VERSION,dirs:DIRS,account:name,startedAt:new Date().toISOString(),
      start:{board:clone(board),score:score??0},moves:[]}};
  sessions.set(accountId,s);
  armIdle(accountId,s);
  return s;
}

function armIdle(accountId,s){
  if(s.idle)clearTimeout(s.idle);
  s.idle=setTimeout(()=>finish(accountId,null,{result:'unfinished'}),IDLE_MS);
  s.idle.unref&&s.idle.unref();
}

// Известно текущее состояние (открыли модалку, загрузили партию для «Решить»): начинает запись,
// если её ещё нет. Партию уже законченную не начинаем.
function touch(accountId,name,st){
  if(!st?.board||st.game_status!=='ongoing')return;
  const s=open(accountId,name,st.board,st.score);
  if(s){s.board=clone(st.board);}
}

// Ход сделан, st — ответ сервера. ms — время раздумья (бот) или null (человек: пауза между ходами).
function record(accountId,name,dir,st,{ms=null,depth=0}={}){
  if(!st?.board)return;
  let s=sessions.get(accountId);
  if(!s){
    // ход без известной доски «до» (модалка открыта до включения записи) — начинаем с доски «после»
    open(accountId,name,st.board,st.score);
    return finishIfOver(accountId,st);
  }
  const{move,DIRS}=require('../modules/game2048');
  const d=DIRS.indexOf(dir);
  const now=Date.now();
  const t=ms??(now-s.lastAt);
  const spawn=findSpawn(move(s.board,dir).board,st.board);
  s.rec.moves.push(spawn?[d,spawn[0],spawn[1],Math.round(t),depth]:[d,-1,0,Math.round(t),depth,flat(st.board)]);
  s.board=clone(st.board);s.lastAt=now;
  armIdle(accountId,s);
  finishIfOver(accountId,st);
}

// Доска заменена целиком без известного хода (ресинк после сбоя POST) — пишем как ход с d=-1
function resync(accountId,st){
  const s=sessions.get(accountId);
  if(!s||!st?.board)return;
  s.rec.moves.push([-1,-1,0,0,0,flat(st.board)]);
  s.board=clone(st.board);
}

function finishIfOver(accountId,st){
  if(st?.game_status&&st.game_status!=='ongoing')finish(accountId,st);
}

function build(s,st,{result,error}={}){
  const rec=s.rec;
  rec.finishedAt=new Date().toISOString();
  rec.result=result||(st?.game_status==='won'?'won':st?.game_status&&st.game_status!=='ongoing'?'lost':'unfinished');
  if(error)rec.error=error;
  rec.end={board:st?.board||s.board,score:st?.score??null,max_tile:st?.max_tile??null,game_status:st?.game_status??null,reward:st?.reward??null};
  const safe=String(s.name).replace(/[^\p{L}\p{N}_.-]+/gu,'_').slice(0,60)||'acc';
  const file=path.join(DIR_DIR,rec.finishedAt.slice(0,10),`${safe}-${rec.finishedAt.slice(11,19).replace(/:/g,'')}-${rec.result}.json.gz`);
  return{rec,file};
}

// Закрывает запись и пишет файл. st — последнее состояние сервера (null — взять последнюю доску).
function finish(accountId,st,opts={}){
  const s=sessions.get(accountId);
  if(!s)return;
  sessions.delete(accountId);
  if(s.idle)clearTimeout(s.idle);
  if(!s.rec.moves.length)return; // ходов не было — писать нечего
  const{rec,file}=build(s,st,opts);
  zlib.gzip(JSON.stringify(rec),{level:9},(err,buf)=>{
    if(err)return logger.warn(`[2048] запись партии: ${err.message}`);
    fs.promises.mkdir(path.dirname(file),{recursive:true})
      .then(()=>fs.promises.writeFile(file,buf))
      .then(()=>logger.info(`[${s.name}] [2048] партия записана: ${path.relative(process.cwd(),file)} (${rec.moves.length} ходов, ${(buf.length/1024).toFixed(1)} КБ)`))
      .catch(e=>logger.warn(`[2048] запись партии ${file}: ${e.message}`));
  });
}

// При остановке бота дописываем начатые партии синхронно (unfinished), чтобы не терять их
function flushAllSync(){
  for(const[accountId,s]of sessions){
    sessions.delete(accountId);
    if(!s.rec.moves.length)continue;
    try{
      const{rec,file}=build(s,null,{result:'unfinished'});
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,zlib.gzipSync(JSON.stringify(rec),{level:9}));
    }catch(_){}
  }
}

module.exports={touch,record,resync,finish,flushAllSync,enabled};
