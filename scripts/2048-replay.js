'use strict';
// Разбор записанных партий 2048 (utils/game2048Recorder.js) для анализа и улучшения алгоритма.
// К игре и БД не обращается — можно запускать где угодно, хоть при работающем боте.
//
//   node scripts/2048-replay.js [файлы или папки...]     сводка по партиям (по умолчанию logs/2048)
//     --agree           насколько ТЕКУЩИЙ bestMove согласен с записанными ходами бота на тех же
//                       позициях (после правки алгоритма видно, где он стал ходить иначе)
//     --ndjson <файл>   все ходы построчно: {file,account,algo,i,board,dir,spawn,next,ms,depth,score}
//                       — удобно грузить в Python/pandas
//     --sim <N>         сыграть N партий офлайн текущим алгоритмом (спавн 2 — 90%, 4 — 10%, как в
//                       игре) и сравнить с записанными; --seed <число> — повторяемые спавны
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const{bestMove,move,DIRS,ALGO_VERSION}=require('../src/modules/game2048');

const args=process.argv.slice(2);
const opt=k=>{const i=args.indexOf(k);if(i<0)return null;const v=args[i+1];args.splice(i,2);return v;};
const flag=k=>{const i=args.indexOf(k);if(i<0)return false;args.splice(i,1);return true;};
const ndjsonOut=opt('--ndjson'),simN=Number(opt('--sim')||0),seed=opt('--seed'),agree=flag('--agree');
const defaultDir=path.join(process.cwd(),'logs','2048');
const inputs=args.length?args:fs.existsSync(defaultDir)?[defaultDir]:[];

function collect(p,out=[]){
  if(!fs.existsSync(p)){console.error(`нет такого пути: ${p}`);return out;}
  if(fs.statSync(p).isDirectory())for(const f of fs.readdirSync(p).sort())collect(path.join(p,f),out);
  else if(/\.json(\.gz)?$/.test(p))out.push(p);
  return out;
}
function load(file){
  const buf=fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz')?zlib.gunzipSync(buf):buf).toString('utf8'));
}

// очки за ход — сумма значений слитых плиток (как в классической 2048); сверяется с итоговым счётом
function gain(board,dir){
  let g=0;
  for(let i=0;i<4;i++){
    const line=dir==='left'?board[i]:dir==='right'?[...board[i]].reverse()
      :dir==='up'?[0,1,2,3].map(r=>board[r][i]):[3,2,1,0].map(r=>board[r][i]);
    const t=line.filter(v=>v);
    for(let k=0;k<t.length;k++)if(t[k+1]!==undefined&&t[k]===t[k+1]){g+=t[k]*2;k++;}
  }
  return g;
}
const maxTile=b=>Math.max(...b.flat());
const empties=b=>b.flat().filter(v=>!v).length;
const unflat=a=>[0,1,2,3].map(r=>a.slice(r*4,r*4+4));

// проигрывает партию и отдаёт позиции: {board(до хода),dir,spawn,next(после),ms,depth,score}
function replay(rec){
  const dirs=rec.dirs||DIRS;
  let b=rec.start.board.map(r=>[...r]),score=rec.start.score||0;
  const steps=[];
  for(const m of rec.moves){
    const[d,cell,val,ms,depth,full]=m;
    const before=b,dir=d>=0?dirs[d]:null;
    if(dir){score+=gain(b,dir);b=move(b,dir).board;}
    if(cell>=0)b[Math.floor(cell/4)][cell%4]=val;
    if(full)b=unflat(full);
    steps.push({board:before,dir,spawn:cell>=0?[cell,val]:null,next:b,ms,depth,score,resync:!!full});
  }
  return{steps,board:b,score};
}

const pct=(a,b)=>b?`${(a/b*100).toFixed(1)}%`:'—';
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const fmtN=n=>Math.round(n).toLocaleString('ru-RU');

const files=inputs.flatMap(p=>collect(p));
const out=ndjsonOut?fs.createWriteStream(ndjsonOut):null;
const byAlgo=new Map();
let agreeAll=0,agreeTotal=0;
const agreeByEmpty=new Map();

if(files.length)console.log(`Партий: ${files.length}\n`);
for(const file of files){
  let rec;
  try{rec=load(file);}catch(e){console.log(`${path.basename(file)}: не читается (${e.message})`);continue;}
  const{steps,board,score}=replay(rec);
  const endOk=JSON.stringify(board)===JSON.stringify(rec.end?.board);
  const scoreOk=rec.end?.score==null||rec.end.score===score;
  const bot=steps.filter(s=>s.depth>0),human=steps.filter(s=>s.dir&&s.depth===0);
  const resyncs=steps.filter(s=>s.resync).length;
  console.log(`${path.basename(file)}  алгоритм v${rec.algo}  ${rec.result}  ходов ${steps.length} (бот ${bot.length}, человек ${human.length})  `
    +`счёт ${fmtN(rec.end?.score??score)}  макс ${maxTile(board)}  думал ср. ${avg(bot.map(s=>s.ms)).toFixed(0)} мс`
    +(resyncs?`  ресинков ${resyncs}`:'')+(endOk?'':'  ⚠ доска не сошлась')+(scoreOk?'':`  ⚠ счёт ${score}≠${rec.end.score}`));
  const a=byAlgo.get(rec.algo)||{games:0,won:0,scores:[],tiles:[],moves:[],ms:[]};
  a.games++;if(rec.result==='won')a.won++;
  a.scores.push(rec.end?.score??score);a.tiles.push(maxTile(board));a.moves.push(steps.length);a.ms.push(...bot.map(s=>s.ms));
  byAlgo.set(rec.algo,a);
  steps.forEach((s,i)=>{
    if(out)out.write(JSON.stringify({file:path.basename(file),account:rec.account,algo:rec.algo,i,board:s.board,dir:s.dir,spawn:s.spawn,next:s.next,ms:s.ms,depth:s.depth,score:s.score})+'\n');
    if(agree&&s.dir&&s.depth>0){
      const same=bestMove(s.board)===s.dir;
      agreeTotal++;if(same)agreeAll++;
      const e=empties(s.board),r=agreeByEmpty.get(e)||[0,0];r[0]+=same;r[1]++;agreeByEmpty.set(e,r);
    }
  });
}
if(out)out.end(()=>console.log(`\nХоды записаны в ${ndjsonOut}`));

if(byAlgo.size){
  console.log('\nПо версиям алгоритма:');
  for(const[v,a]of[...byAlgo].sort((x,y)=>x[0]-y[0]))
    console.log(`  v${v}: партий ${a.games}, побед ${a.won} (${pct(a.won,a.games)}), счёт ср. ${fmtN(avg(a.scores))}, `
      +`макс. плитка ср. ${fmtN(avg(a.tiles))}, ходов ср. ${fmtN(avg(a.moves))}, думал ср. ${avg(a.ms).toFixed(0)} мс`);
}
if(agree){
  console.log(`\nСогласие текущего алгоритма (v${ALGO_VERSION}) с записанными ходами бота: ${agreeAll}/${agreeTotal} (${pct(agreeAll,agreeTotal)})`);
  for(const[e,[s,t]]of[...agreeByEmpty].sort((x,y)=>x[0]-y[0]))console.log(`  пустых клеток ${String(e).padStart(2)}: ${pct(s,t)} из ${t}`);
}

// офлайн-партии текущим алгоритмом: оценка правки без игры на живых аккаунтах
if(simN>0){
  let st=seed!=null?Number(seed)>>>0:(Math.random()*2**32)>>>0;
  const rnd=()=>{st=(st+0x6D2B79F5)>>>0;let t=st;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/2**32;}; // mulberry32
  const spawn=b=>{
    const free=[];for(let r=0;r<4;r++)for(let c=0;c<4;c++)if(!b[r][c])free.push([r,c]);
    const[r,c]=free[Math.floor(rnd()*free.length)];b[r][c]=rnd()<0.9?2:4;
  };
  const res={won:0,scores:[],tiles:[],moves:[],ms:[]};
  for(let g=0;g<simN;g++){
    let b=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],score=0,n=0;
    spawn(b);spawn(b);
    for(;;){
      const t0=process.hrtime.bigint();
      const dir=bestMove(b);
      res.ms.push(Number(process.hrtime.bigint()-t0)/1e6);
      if(!dir)break;
      score+=gain(b,dir);b=move(b,dir).board;spawn(b);n++;
      if(maxTile(b)>=2048)break; // в игре партия заканчивается победой на плитке 2048
    }
    const won=maxTile(b)>=2048;if(won)res.won++;
    res.scores.push(score);res.tiles.push(maxTile(b));res.moves.push(n);
    console.log(`  сим ${g+1}/${simN}: ${won?'победа':'поражение'}, счёт ${fmtN(score)}, макс ${maxTile(b)}, ходов ${n}`);
  }
  console.log(`\nОфлайн v${ALGO_VERSION}: ${simN} партий, побед ${res.won} (${pct(res.won,simN)}), счёт ср. ${fmtN(avg(res.scores))}, `
    +`макс. плитка ср. ${fmtN(avg(res.tiles))}, ходов ср. ${fmtN(avg(res.moves))}, думал ср. ${avg(res.ms).toFixed(1)} мс`
    +(seed!=null?` (seed ${seed})`:''));
}
if(!files.length&&!simN)console.log('Записанных партий нет. Включите «Запись партий» на странице 2048 или запустите --sim N.');
