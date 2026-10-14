'use strict';
const logger=require('../utils/logger');
const {MinigameLog}=require('../db/index');

async function logResult(account,won,reward){
  try{
    const played_at=new Date().toISOString().slice(0,10);
    await MinigameLog.upsert({account,game:'sudoku',played_at,won:!!won,reward},{conflictFields:['account','game','played_at']});
  }catch(e){logger.warn(`[${account}] [sudoku] logResult (запись в minigame_log не удалась — статус "сыграно" не сохранится): ${e.message}`);}
}

// Классический бэктрекинг с MRV-эвристикой (на каждом шаге берём пустую клетку с наименьшим
// числом допустимых значений — резко сокращает перебор). Для валидного судоку 9×9 отрабатывает
// мгновенно и гарантированно находит решение (в отличие от эвристик/угадывания — ошибиться нельзя,
// т.к. любая тупиковая ветка просто откатывается).
function solveBoard(board){
  const g=board.map(row=>row.slice());
  const isValid=(r,c,v)=>{
    for(let i=0;i<9;i++){if(g[r][i]===v)return false;if(g[i][c]===v)return false;}
    const br=Math.floor(r/3)*3,bc=Math.floor(c/3)*3;
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(g[br+i][bc+j]===v)return false;
    return true;
  };
  const findBestEmpty=()=>{
    let best=null,bestCount=10;
    for(let r=0;r<9;r++)for(let c=0;c<9;c++){
      if(g[r][c]!==0)continue;
      let count=0;
      for(let v=1;v<=9;v++)if(isValid(r,c,v))count++;
      if(count<bestCount){bestCount=count;best=[r,c];if(count<=1)return best;}
    }
    return best;
  };
  const solve=()=>{
    const empty=findBestEmpty();
    if(!empty)return true;
    const[r,c]=empty;
    for(let v=1;v<=9;v++){
      if(isValid(r,c,v)){
        g[r][c]=v;
        if(solve())return true;
        g[r][c]=0;
      }
    }
    return false;
  };
  return solve()?g:null;
}

// Решает ежедневное «Судоку» и забирает награду. Награда даётся раз в день на аккаунт.
// Сложность по умолчанию максимальная (master) ради максимальной награды.
// После обновления игры сервер больше не отдаёт готовое решение (`solution`) — решаем сами.
async function solveSudoku(api,name,difficulty='master'){
  const today=new Date().toISOString().slice(0,10);
  let g=await api.get('/sudoku/').catch(()=>null);
  const existsToday=!!g&&g.created_at_date===today&&Array.isArray(g.board);
  if(existsToday&&g.is_won){await logResult(name,true,g.reward??null);return{won:true,skipped:true,reward:g.reward??null};}
  // сервер разрешает ровно одну генерацию в день — если сегодняшняя игра уже существует, но не
  // решена (например прошлый прогон прервался посреди решения — сеть/таймаут — и не дошёл до
  // logResult), НЕ вызываем /sudoku/generate повторно (это 409 "разрешена только одна игра в день"),
  // а продолжаем решать УЖЕ СУЩЕСТВУЮЩЕЕ поле. Раньше это было незамечено: ошибка 409 прерывала
  // функцию до logResult, и аккаунт оставался "непойманным" (в игре — сыграно, у нас — нет) до конца дня.
  if(!existsToday){
    await api.post('/sudoku/generate',{difficulty});
    g=await api.get('/sudoku/');
  }
  const b=g?.board;
  if(!b)throw new Error('нет поля');
  const sol=g?.solution||solveBoard(b);
  if(!sol)throw new Error('не удалось решить (невалидное поле?)');
  let last;
  for(let y=0;y<9;y++){
    for(let x=0;x<9;x++){
      if(b[y][x]!==0)continue;
      // ретраи на переходные ошибки — единичный сетевой сбой посреди 81-клеточного решения
      // раньше обрывал всю функцию до logResult, оставляя игру решённой в игре, но не у нас
      for(let tries=0;tries<5;tries++){
        try{last=await api.post('/sudoku/',{row:y,col:x,value:sol[y][x],is_hint:false});break;}
        catch(e){if(tries===4)throw e;await new Promise(r=>setTimeout(r,1500));}
      }
      if(last&&last.is_won)break;
    }
    if(last&&last.is_won)break;
  }
  g=await api.get('/sudoku/');
  if(!g?.is_won)throw new Error('не решено');
  await logResult(name,true,g.reward??null);
  logger.info(`[${name}] [sudoku] выиграно (${difficulty}), награда ${g.reward}`);
  return{won:true,reward:g.reward??null};
}
module.exports={solveSudoku};
