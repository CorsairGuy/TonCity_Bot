'use strict';
// MinigameLog берём лениво в logResult: модуль подключает и scripts/2048-replay.js, которому БД не нужна

// Версия алгоритма выбора хода — пишется в каждую запись партии (utils/game2048Recorder.js), чтобы
// при анализе отличать партии разных версий. Менять при любой правке evaluate/expectimax/bestMove.
const ALGO_VERSION=1;

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

// ── эвристика позиции (без хода) — общепринятые для 2048-солверов компоненты ──────────────────
function emptyCells(board){let c=0;for(const r of board)for(const v of r)if(v===0)c++;return c;}
function monotonicity(board){
  const totals=[0,0,0,0]; // up,down,left,right
  for(let r=0;r<4;r++)for(let c=0;c<3;c++){
    const a=board[r][c],b=board[r][c+1];
    if(a>b)totals[2]+=Math.log2(a||1)-Math.log2(b||1);
    else if(b>a)totals[3]+=Math.log2(b||1)-Math.log2(a||1);
  }
  for(let c=0;c<4;c++)for(let r=0;r<3;r++){
    const a=board[r][c],b=board[r+1][c];
    if(a>b)totals[0]+=Math.log2(a||1)-Math.log2(b||1);
    else if(b>a)totals[1]+=Math.log2(b||1)-Math.log2(a||1);
  }
  return -Math.min(totals[0],totals[1])-Math.min(totals[2],totals[3]);
}
function smoothness(board){
  let s=0;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    if(!board[r][c])continue;
    const v=Math.log2(board[r][c]);
    if(c<3&&board[r][c+1])s-=Math.abs(v-Math.log2(board[r][c+1]));
    if(r<3&&board[r+1][c])s-=Math.abs(v-Math.log2(board[r+1][c]));
  }
  return s;
}
// "змейка" — общепринятый сильный статический вес для 2048: не просто "держать макс. плитку в
// углу" (это позволяет остальной доске быть в каком угодно бардаке), а весовая матрица, по которой
// значения должны убывать ЗМЕЙКОЙ через всю доску — тогда крупные плитки выстраиваются в непрерывную
// цепочку от угла, а не просто одна плитка торчит в углу при хаосе вокруг. Берём максимум по всем
// 4 вариантам (змейка может идти из любого угла в зависимости от текущей раскладки).
function buildSnakeWeights(){
  const ranks=[[15,14,13,12],[8,9,10,11],[7,6,5,4],[0,1,2,3]]; // путь змейки: ряд0 →, ряд1 ←, ряд2 →, ряд3 ←
  const w=ranks.map(row=>row.map(r=>Math.pow(2,r)));
  const flipH=m=>m.map(row=>[...row].reverse());
  const flipV=m=>[...m].reverse();
  return[w,flipH(w),flipV(w),flipV(flipH(w))];
}
const SNAKE_WEIGHTS=buildSnakeWeights();
function snakeScore(board){
  let best=-Infinity;
  for(const w of SNAKE_WEIGHTS){
    let s=0;
    for(let r=0;r<4;r++)for(let c=0;c<4;c++)s+=board[r][c]*w[r][c];
    if(s>best)best=s;
  }
  return best;
}
function evaluate(board){
  return snakeScore(board)+emptyCells(board)*1000+monotonicity(board)*50+smoothness(board)*10;
}

// ── expectimax: наш ход (max) чередуется со "случайным" ходом игры (спавн 2 90% / 4 10%) ───────
function expectimax(board,depth,ourTurn){
  if(depth<=0)return evaluate(board);
  if(ourTurn){
    let best=-Infinity;
    for(const dir of DIRS){
      const r=move(board,dir);
      if(!r.changed)continue;
      const v=expectimax(r.board,depth-1,false);
      if(v>best)best=v;
    }
    return best===-Infinity?evaluate(board):best;
  }
  const empties=[];
  for(let r=0;r<4;r++)for(let c=0;c<4;c++)if(board[r][c]===0)empties.push([r,c]);
  if(!empties.length)return evaluate(board);
  // при большом числе пустых клеток берём подвыборку — иначе ветвление экспоненциально дорого,
  // а на исход почти не влияет (клетки эквивалентны по вкладу в среднем)
  const sample=empties.length>6?empties.filter((_,i)=>i%2===0):empties;
  let total=0;
  for(const[r,c]of sample){
    for(const[val,prob]of[[2,0.9],[4,0.1]]){
      const nb=board.map(row=>[...row]);
      nb[r][c]=val;
      total+=prob*expectimax(nb,depth-1,true);
    }
  }
  return total/sample.length;
}

// глубже к эндшпилю (меньше пустых клеток — меньше ветвление, можно смотреть дальше)
function searchDepth(board){
  const empties=emptyCells(board);
  return empties<=3?5:empties<=6?4:3;
}
function bestMove(board){
  const depth=searchDepth(board);
  let best=null,bestScore=-Infinity;
  for(const dir of DIRS){
    const r=move(board,dir);
    if(!r.changed)continue;
    const score=expectimax(r.board,depth-1,false);
    if(score>bestScore){bestScore=score;best=dir;}
  }
  return best;
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
// move/searchDepth/evaluate/ALGO_VERSION — для записи партий и офлайн-анализа (scripts/2048-replay.js).
module.exports={bestMove,canMove,logResult,move,searchDepth,evaluate,DIRS,ALGO_VERSION};
