'use strict';
// MinigameLog берём лениво в logResult: модуль подключает и scripts/2048-replay.js, которому БД не нужна

// Версия алгоритма выбора хода — пишется в каждую запись партии (utils/game2048Recorder.js), чтобы
// при анализе отличать партии разных версий. Менять при любой правке evaluate/expectimax/bestMove.
const ALGO_VERSION=4;

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

// ── поиск хода, v2 ────────────────────────────────────────────────────────────────────────────
// v1 (змейка по сырым значениям плиток + expectimax глубины 3–5) запирал мелкие плитки: вес «змейки»
// считался по самим значениям, поэтому всё решали 1024/512 в углу, а двойка в соседней клетке того
// же ряда почти не стоила очков, пока не становилось поздно (офлайн: 74% побед на 100 партиях).
// v2 — известная сильная схема для 2048 (эвристика nneonneo/2048-ai): оценка по РАНГАМ плиток
// (log2) построчно и постолбцово — монотонность в степени 4 (любая «яма» в ряду дорогая, даже от
// мелкой плитки, поэтому её выгоднее дорастить, чем оставить), пустые клетки, соседние одинаковые
// плитки, штраф за сумму рангов. Змейка при этом складывается сама: монотонные строки и столбцы
// и есть змейка. Поиск — expectimax на 3–4 случайных спавна вперёд с отсечением маловероятных
// веток и кэшем позиций. Подобрано прогоном офлайн-партий (scripts/2048-replay.js --sim).
// v3 — к оценке v2 добавлен штраф змейки (по просьбе пользователя: собирать цепочку по убыванию,
// как вручную). Перед каждым ходом из 8 змеек (4 угла × по строкам/по столбцам) выбирается та, что
// лучше ложится на доску (лексикографически: крупнейший ранг в голове, дальше как можно крупнее по
// порядку), и в оценке каждой позиции перебора за каждое место, где по ходу змейки следующая
// клетка больше предыдущей (пустая тоже считается), вычитается SNAKE_W·(больший⁴ − меньший⁴) по
// рангам. Офлайн на 100 одинаковых партиях: v2 — 100 побед, 9,8 мс/ход, длина змейки 5,10;
// v3 — 99 побед, ~59 мс/ход (пик ~0,7 с), длина 5,35. Сильнее штраф — меньше побед (30/40 при
// ×100), поэтому вес не поднимать без прогона. Из-за цены расчёта ход считается в отдельном потоке
// (game2048Worker.js), чтобы не тормозить процесс бота.
// v4 — змейка как «задача №2»: v3 считал раскладку «1024-512-256-16 в первом столбце, во втором
// 64-32-16-8 растёт вверх» даже чуть лучше правильной (там, где 16 в углу, должна расти 128, во
// втором столбце снизу вверх 64, 32, 16...). Добавлен бонус SNAKE_VAL_W·Σ ранг·0,5^k по местам
// змейки: каждое следующее место весит вдвое меньше предыдущего, поэтому выгодно растить плитку
// именно на следующем месте змейки, а не сбоку. Порядок (штраф и бонус) требуется только в первых
// двух линиях змейки (SNAKE_LEN=8), третью и четвёртую бот заполняет как выгоднее (по просьбе
// пользователя), штраф втрое сильнее v3. Офлайн на 40 одинаковых партиях: v3 — 40 побед, 48 мс/ход,
// 2,64 нарушения порядка в первых двух линиях; v4 — 40 побед, 33 мс/ход, 2,09 нарушения.
// Доска внутри — 4 строки по 16 бит, клетка = ранг в 4 битах (младший полубайт — столбец 0);
// ход по строке — готовые таблицы на все 65536 строк, поэтому одна позиция считается быстро.
const H={lost:200000,monoPow:4,mono:47,sumPow:3.5,sum:11,merges:700,empty:270};
const WIN_RANK=11,WIN_SCORE=1e15; // плитка 2048 — партия выиграна сразу, дальше игра не идёт
// проигрыш (ходов нет) хуже любой позиции: со штрафом змейки оценка бывает отрицательной
const LOST_SCORE=-1e12;
const SNAKE_W=150,SNAKE_POW=4,SNAKE_VAL_W=1e7,SNAKE_LEN=8;
const CPROB_MIN=0.0001,CACHE_DEPTH=15;
const ROW_LEFT=new Uint16Array(65536),ROW_RIGHT=new Uint16Array(65536),ROW_HEUR=new Float64Array(65536);
const revRow=r=>((r&15)<<12)|((r>>4&15)<<8)|((r>>8&15)<<4)|(r>>12&15);
(function buildTables(){
  for(let row=0;row<65536;row++){
    const l=[row&15,row>>4&15,row>>8&15,row>>12&15];
    let sum=0,empty=0,merges=0,prev=0,counter=0;
    for(const r of l){
      sum+=Math.pow(r,H.sumPow);
      if(!r){empty++;continue;}
      if(prev===r)counter++;
      else if(counter>0){merges+=1+counter;counter=0;}
      prev=r;
    }
    if(counter>0)merges+=1+counter;
    let ml=0,mr=0;
    for(let i=1;i<4;i++){
      if(l[i-1]>l[i])ml+=Math.pow(l[i-1],H.monoPow)-Math.pow(l[i],H.monoPow);
      else mr+=Math.pow(l[i],H.monoPow)-Math.pow(l[i-1],H.monoPow);
    }
    ROW_HEUR[row]=H.lost+H.empty*empty+H.merges*merges-H.mono*Math.min(ml,mr)-H.sum*sum;
    const t=l.filter(v=>v),o=[];
    for(let i=0;i<t.length;i++){
      if(i+1<t.length&&t[i]===t[i+1]&&t[i]<15){o.push(t[i]+1);i++;}
      else o.push(t[i]);
    }
    while(o.length<4)o.push(0);
    ROW_LEFT[row]=o[0]|(o[1]<<4)|(o[2]<<8)|(o[3]<<12);
  }
  for(let row=0;row<65536;row++)ROW_RIGHT[row]=revRow(ROW_LEFT[revRow(row)]);
})();

function encode(board){
  return board.map(r=>r.reduce((acc,v,c)=>acc|((v?Math.log2(v):0)<<(4*c)),0));
}
// Горячий путь поиска — без массивов: доска передаётся четырьмя числами, результат хода кладётся в
// M0..M3 (иначе аллокации на каждом узле замедляют поиск в разы).
let M0=0,M1=0,M2=0,M3=0;
// d: 0 up, 1 down, 2 left, 3 right — как DIRS. Столбец собирается как строка (сверху вниз = слева
// направо), прогоняется через ту же таблицу и раскладывается обратно.
function bMove(a,b,c,e,d){
  if(d===2){M0=ROW_LEFT[a];M1=ROW_LEFT[b];M2=ROW_LEFT[c];M3=ROW_LEFT[e];return;}
  if(d===3){M0=ROW_RIGHT[a];M1=ROW_RIGHT[b];M2=ROW_RIGHT[c];M3=ROW_RIGHT[e];return;}
  const T=d===0?ROW_LEFT:ROW_RIGHT;
  let n0=0,n1=0,n2=0,n3=0;
  for(let sh=0;sh<16;sh+=4){
    const col=T[(a>>sh&15)|((b>>sh&15)<<4)|((c>>sh&15)<<8)|((e>>sh&15)<<12)];
    n0|=(col&15)<<sh;n1|=(col>>4&15)<<sh;n2|=(col>>8&15)<<sh;n3|=(col>>12&15)<<sh;
  }
  M0=n0;M1=n1;M2=n2;M3=n3;
}
// 8 змеек: путь по клеткам r*4+c от головы. Ряд змейки 0 идёт от угла, ряд 1 — обратно и т.д.
const SNAKE_PATHS=[];
for(const[cr,cc]of[[0,0],[0,3],[3,0],[3,3]])for(const byRow of[true,false]){
  const p=[];
  for(let i=0;i<4;i++)for(let j=0;j<4;j++){
    const along=i%2===0?j:3-j;
    let r=byRow?i:along,c=byRow?along:i;
    if(cr===3)r=3-r;
    if(cc===3)c=3-c;
    p.push(r*4+c);
  }
  SNAKE_PATHS.push(p);
}
const RANK_POW=Array.from({length:16},(_,r)=>Math.pow(r,SNAKE_POW));
const SNAKE_DEC=Array.from({length:16},(_,k)=>Math.pow(0.5,k)); // вес места в змейке для SNAKE_VAL_W
let snakePath=SNAKE_PATHS[0]; // змейка текущего хода, выбирается в bestMove
function pickSnake(a,b,c,e){
  const rows=[a,b,c,e];
  let best=-Infinity;
  for(const p of SNAKE_PATHS){
    let sc=0;
    for(let k=0;k<16;k++){const q=p[k];sc+=(rows[q>>2]>>(4*(q&3))&15)*Math.pow(16,15-k);}
    if(sc>best){best=sc;snakePath=p;}
  }
}
function heur(a,b,c,e){
  let h=ROW_HEUR[a]+ROW_HEUR[b]+ROW_HEUR[c]+ROW_HEUR[e];
  for(let sh=0;sh<16;sh+=4)h+=ROW_HEUR[(a>>sh&15)|((b>>sh&15)<<4)|((c>>sh&15)<<8)|((e>>sh&15)<<12)];
  let pen=0,val=0,prev=-1;
  for(let k=0;k<SNAKE_LEN;k++){
    const q=snakePath[k];
    const x=(q<4?a:q<8?b:q<12?c:e)>>(4*(q&3))&15;
    if(prev>=0&&x>prev)pen+=RANK_POW[x]-RANK_POW[prev];
    val+=x*SNAKE_DEC[k];
    prev=x;
  }
  return h-SNAKE_W*pen+SNAKE_VAL_W*val;
}
function maxRank(a,b,c,e){
  let m=0;
  for(let sh=0;sh<16;sh+=4){
    const v=Math.max(a>>sh&15,b>>sh&15,c>>sh&15,e>>sh&15);
    if(v>m)m=v;
  }
  return m;
}

function moveNode(a,b,c,e,s,cprob,depth){
  let best=LOST_SCORE;
  for(let d=0;d<4;d++){
    bMove(a,b,c,e,d);
    if(M0===a&&M1===b&&M2===c&&M3===e)continue;
    const n0=M0,n1=M1,n2=M2,n3=M3;
    const v=maxRank(n0,n1,n2,n3)>=WIN_RANK?WIN_SCORE:chanceNode(n0,n1,n2,n3,s,cprob,depth);
    if(v>best)best=v;
  }
  return best; // ходов нет — проигрыш
}
function chanceNode(a,b,c,e,s,cprob,depth){
  if(cprob<CPROB_MIN||depth>=s.limit)return heur(a,b,c,e);
  let inner=null;
  const hi=(a*65536+b),lo=(c*65536+e);
  if(depth<CACHE_DEPTH){
    inner=s.cache.get(hi);
    if(inner){
      const v=inner.get(lo);
      if(v!==undefined&&v[0]<=depth)return v[1];
    }else{inner=new Map();s.cache.set(hi,inner);}
  }
  let empties=0;
  const rows=[a,b,c,e];
  for(let i=0;i<4;i++)for(let sh=0;sh<16;sh+=4)if(!(rows[i]>>sh&15))empties++;
  if(!empties)return heur(a,b,c,e);
  const p=cprob/empties;
  let total=0;
  for(let i=0;i<4;i++)for(let sh=0;sh<16;sh+=4){
    if(rows[i]>>sh&15)continue;
    const t2=1<<sh,t4=2<<sh;
    let v2,v4;
    if(i===0){v2=moveNode(a|t2,b,c,e,s,p*0.9,depth+1);v4=moveNode(a|t4,b,c,e,s,p*0.1,depth+1);}
    else if(i===1){v2=moveNode(a,b|t2,c,e,s,p*0.9,depth+1);v4=moveNode(a,b|t4,c,e,s,p*0.1,depth+1);}
    else if(i===2){v2=moveNode(a,b,c|t2,e,s,p*0.9,depth+1);v4=moveNode(a,b,c|t4,e,s,p*0.1,depth+1);}
    else{v2=moveNode(a,b,c,e|t2,s,p*0.9,depth+1);v4=moveNode(a,b,c,e|t4,s,p*0.1,depth+1);}
    total+=0.9*v2+0.1*v4;
  }
  const score=total/empties;
  if(inner)inner.set(lo,[depth,score]);
  return score;
}

// 3 спавна вперёд, в тесноте (≤2 пустых клеток) — 4. Офлайн на 300 партиях: 299 побед, 8,5 мс на
// ход в среднем, пик ~170 мс; глубина 3 везде — 298 побед и 3,4 мс.
function searchDepth(board){
  let empties=0;
  for(const r of board)for(const v of r)if(!v)empties++;
  return empties<=2?4:3;
}
// возвращает лучший ход ('up'|'down'|'left'|'right') или null, если ходов нет
function bestMove(board){
  const[a,b,c,e]=encode(board);
  pickSnake(a,b,c,e);
  const s={limit:searchDepth(board),cache:new Map()};
  let best=null,bestScore=-Infinity;
  for(let d=0;d<4;d++){
    bMove(a,b,c,e,d);
    if(M0===a&&M1===b&&M2===c&&M3===e)continue;
    const n0=M0,n1=M1,n2=M2,n3=M3;
    const score=maxRank(n0,n1,n2,n3)>=WIN_RANK?WIN_SCORE:chanceNode(n0,n1,n2,n3,s,1,0);
    if(score>bestScore){bestScore=score;best=DIRS[d];}
  }
  return best;
}
function evaluate(board){const r=encode(board);pickSnake(...r);return heur(...r);}
// змейка, которую бот выберет для этой доски: первые SNAKE_LEN клеток (r*4+c) от головы — для
// подсветки в окне 2048 (клетки, куда бот собирает цепочку сейчас)
function snakeOf(board){pickSnake(...encode(board));return snakePath.slice(0,SNAKE_LEN);}

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
module.exports={bestMove,canMove,logResult,move,searchDepth,evaluate,snakeOf,DIRS,ALGO_VERSION};
