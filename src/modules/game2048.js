'use strict';
// MinigameLog берём лениво в logResult: модуль подключает и scripts/2048-replay.js, которому БД не нужна

// Версия алгоритма выбора хода — пишется в каждую запись партии (utils/game2048Recorder.js), чтобы
// при анализе отличать партии разных версий. Менять при любой правке поиска хода.
const ALGO_VERSION=6;

// Механика 2048 подтверждена реверсом бандла игры (chunks/game2048-*.js): доска 4x4 (0=пусто),
// направления 'up'|'down'|'left'|'right', POST /game2048/ {direction}. Функции ниже (extractLine/
// mergeLine/move/canMove) — прямой порт игровых ke()/Te()/Ce() 1:1, чтобы наш локальный симулятор
// для поиска ходов давал ТЕ ЖЕ результаты, что и настоящий сервер игры.
function extractLine(board,dir,i){
  if(dir==='left')return[...board[i]];
  if(dir==='right')return[...board[i]].reverse();
  if(dir==='up')return[board[0][i],board[1][i],board[2][i],board[3][i]];
  return[board[3][i],board[2][i],board[1][i],board[0][i]]; // down
}
function mergeLine(line){
  const t=line.filter(v=>v!==0);
  const out=[];
  for(let i=0;i<t.length;i++){
    if(t[i+1]!==undefined&&t[i]===t[i+1]){out.push(t[i]*2);i++;}
    else out.push(t[i]);
  }
  while(out.length<4)out.push(0);
  return out;
}
function putLine(board,dir,i,line){
  if(dir==='left')board[i]=line;
  else if(dir==='right')board[i]=[...line].reverse();
  else if(dir==='up')for(let r=0;r<4;r++)board[r][i]=line[r];
  else for(let r=0;r<4;r++)board[3-r][i]=line[r]; // down
}
function move(board,dir){
  const nb=board.map(r=>[...r]);
  let changed=false;
  for(let i=0;i<4;i++){
    const line=extractLine(board,dir,i);
    const merged=mergeLine(line);
    for(let k=0;k<4;k++)if(line[k]!==merged[k])changed=true;
    putLine(nb,dir,i,merged);
  }
  return{board:nb,changed};
}
function canMove(board,dir){return move(board,dir).changed;}

const DIRS=['up','down','left','right'];

// ── поиск хода, v6 ────────────────────────────────────────────────────────────────────────────
// Expectimax на C++, собранный в WASM (vendor/game2048/build.sh → game2048.wasm, 23 КБ, без импортов;
// сторонний код под MIT, лицензия — vendor/game2048/LICENSE). Глубина — «разных плиток на доске − 2,
// не меньше 3», ветки с вероятностью < 1e-4 отсекаются. Змейки и прочих надстроек нет (решение
// пользователя 23.10.2026). Офлайн на 40 одинаковых партиях: 40 побед, ~66 мс на ход, худший ~3,5 с;
// в партии без остановки на 2048 дошёл до 8192 (v5 со змейкой — до 4096). Ход считается в отдельном
// потоке (game2048Worker.js), чтобы не тормозить процесс бота.
let wasmInst=null;
function wasm(){
  if(!wasmInst){
    const fs=require('fs'),path=require('path');
    wasmInst=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'game2048.wasm'))),{});
    wasmInst.exports._initialize();
  }
  return wasmInst.exports;
}
// доска для WASM — 64-битное число, клетка (r,c) — ранг (log2) в 4 битах со сдвигом 4·(4r+c)
function encode(board){
  let x=0n;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    const v=board[r][c];
    if(v)x|=BigInt(Math.log2(v))<<BigInt(4*(4*r+c));
  }
  return x;
}
// глубина поиска (для записи партий) — та же формула, что внутри WASM
function searchDepth(board){
  return Math.max(3,new Set(board.flat().filter(v=>v)).size-2);
}
// возвращает лучший ход ('up'|'down'|'left'|'right') или null, если ходов нет; порядок ходов в WASM
// совпадает с DIRS
function bestMove(board){
  const m=wasm().best_move(encode(board));
  return m>=0?DIRS[m]:null;
}

async function logResult(account,st){
  try{
    const{MinigameLog}=require('../db/index');
    const played_at=new Date().toISOString().slice(0,10);
    await MinigameLog.upsert({account,game:'2048',played_at,won:st?.game_status==='won',reward:st?.reward??null,score:st?.score??null},{conflictFields:['account','game','played_at']});
  }catch(_){}
}

// Автоигры больше нет по решению пользователя — 2048 играется ТОЛЬКО вручную (кнопка в модалке или
// в таблице "Оплот Мудрости", см. web/routes/minigames.js). bestMove/canMove/logResult используются
// именно этими ручными путями (для кнопки "Решить" и записи результата в лог миниигр).
// move/searchDepth/ALGO_VERSION — для записи партий и офлайн-анализа (scripts/2048-replay.js).
module.exports={bestMove,canMove,logResult,move,searchDepth,DIRS,ALGO_VERSION};
