'use strict';
const logger=require('../utils/logger');
const {MinigameLog}=require('../db/index');

async function getReward(api){
  try{const r=await api.get('/minesweeper/reward');return r?.reward??null;}catch(_){return null;}
}

async function logResult(account,won,reward){
  try{
    const played_at=new Date().toISOString().slice(0,10);
    await MinigameLog.upsert({account,game:'minesweeper',played_at,won:!!won,reward},{conflictFields:['account','game','played_at']});
  }catch(e){logger.warn(`[${account}] [minesweeper] logResult (запись в minigame_log не удалась — статус "сыграно" не сохранится): ${e.message}`);}
}

// Реальный ответ игры (снят из DevTools 09.07.2026, POST /minesweeper/):
//   field: { width, height, num_mines, mines:[] (пустой — список мин БОЛЬШЕ НЕ отдаётся),
//            squares[y][x]: { is_mine, state:'revealed'|'unrevealed', adjacent_mines } }
// adjacent_mines присутствует у ВСЕХ клеток (0 по умолчанию на скрытых) — единственный надёжный
// признак вскрытости именно state==='revealed'. Раньше сервер отдавал field.mines напрямую, теперь
// нет — решаем логическим выводом (CSP): для каждой вскрытой клетки с числом N смотрим на её
// непомеченных соседей; если известных мин среди них уже N — остальные непомеченные безопасны;
// если непомеченных соседей ровно N минус известные мины — все они мины. Плюс правило разности
// множеств (A.cells ⊂ B.cells → мины в B\A = B.remaining−A.remaining) — сильно повышает долю
// клеток, решаемых БЕЗ единой угадайки. Когда гарантированных ходов не остаётся — берём клетку
// с наименьшей честно оценённой вероятностью мины (не блеф) — минесвипер, в отличие от судоку,
// не всегда решается однозначно (иногда неизбежен 50/50), но ни одна "точная" клетка не ошибается.
const isRevealed=cell=>cell?.state==='revealed';

function neighborsOf(x,y,w,h){
  const out=[];
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;
    const nx=x+dx,ny=y+dy;
    if(nx>=0&&nx<w&&ny>=0&&ny<h)out.push([nx,ny]);
  }
  return out;
}
const key=(x,y)=>`${x},${y}`;
const parseKey=k=>k.split(',').map(Number);

function deduce(field,knownMines){
  const w=field.width,h=field.height,squares=field.squares;
  const safe=new Set(),mines=new Set(knownMines);
  const constraints=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const cell=squares?.[y]?.[x];
    if(!isRevealed(cell))continue;
    const n=cell.adjacent_mines;
    const unk=[];let knownAdjMines=0;
    for(const[nx,ny]of neighborsOf(x,y,w,h)){
      const k=key(nx,ny);
      const ncell=squares?.[ny]?.[nx];
      if(mines.has(k))knownAdjMines++;
      else if(!isRevealed(ncell))unk.push(k);
    }
    if(!unk.length)continue;
    constraints.push({cells:new Set(unk),remaining:n-knownAdjMines});
  }
  // Применить newly-known safe/mines ко всем ограничениям: убрать клетку из cells, и если это
  // была мина — ОБЯЗАТЕЛЬНО уменьшить remaining на 1 (иначе остальные выводы в этом же прогоне
  // опираются на устаревшее число и могут ошибочно объявить мину безопасной клеткой).
  const applyKnown=()=>{
    for(const c of constraints){
      for(const s of [...c.cells])if(safe.has(s))c.cells.delete(s);
      for(const m of [...c.cells])if(mines.has(m)){c.cells.delete(m);c.remaining--;}
    }
  };
  let changed=true,iterations=0;
  while(changed&&iterations<40){
    changed=false;iterations++;
    applyKnown();
    for(const c of constraints){
      if(!c.cells.size)continue;
      if(c.remaining<=0){for(const k of c.cells)if(!safe.has(k)){safe.add(k);changed=true;}}
      else if(c.remaining>=c.cells.size){for(const k of c.cells)if(!mines.has(k)){mines.add(k);changed=true;}}
    }
    if(changed)continue; // сначала дожать одноточечный вывод до предела, потом уже подмножества
    for(const a of constraints){
      if(!a.cells.size)continue;
      for(const b of constraints){
        if(a===b||!b.cells.size||a.cells.size>=b.cells.size)continue;
        let subset=true;
        for(const c of a.cells)if(!b.cells.has(c)){subset=false;break;}
        if(!subset)continue;
        const diffCells=[...b.cells].filter(c=>!a.cells.has(c));
        const diffRemaining=b.remaining-a.remaining;
        if(diffRemaining===0){for(const c of diffCells)if(!safe.has(c)){safe.add(c);changed=true;}}
        else if(diffRemaining===diffCells.length){for(const c of diffCells)if(!mines.has(c)){mines.add(c);changed=true;}}
      }
    }
  }
  applyKnown();
  return{safe,mines,constraints:constraints.filter(c=>c.cells.size>0)};
}

function bestGuess(field,mines,constraints,totalMines){
  const w=field.width,h=field.height,squares=field.squares;
  const hidden=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const cell=squares?.[y]?.[x];
    const k=key(x,y);
    if(!isRevealed(cell)&&!mines.has(k))hidden.push(k);
  }
  if(!hidden.length)return null;
  const frontier=new Set(constraints.flatMap(c=>[...c.cells]));
  const outside=hidden.filter(k=>!frontier.has(k));
  if(outside.length&&totalMines!=null){
    const minesLeft=Math.max(0,totalMines-mines.size);
    const outsideProb=minesLeft/hidden.length; // грубая, но честная нижняя оценка риска вне фронта
    let bestConstraintProb=1;
    for(const c of constraints)bestConstraintProb=Math.min(bestConstraintProb,c.remaining/c.cells.size);
    if(outsideProb<=bestConstraintProb)return outside[0];
  } else if(outside.length){
    return outside[0]; // нет данных по общему числу мин — вне фронта статистически безопаснее
  }
  let best=null,bestProb=2;
  for(const c of constraints){
    const p=c.remaining/c.cells.size;
    if(p<bestProb){bestProb=p;best=[...c.cells][0];}
  }
  return best||hidden[0];
}

// Решает ежедневного «Сапёра» и забирает награду (~1M монет).
// Мины генерируются только после первого клика → первый клик всегда безопасен (0,0).
async function solveMinesweeper(api,name){
  let st=await api.get('/minesweeper/');
  let field=st?.field;
  let status=st?.game_status;
  if(status==='won'){const reward=await getReward(api);await logResult(name,true,reward);return{won:true,skipped:true,reward};}
  if(status==='lost'){await logResult(name,false,0);return{won:false,skipped:true,reward:0};}
  if(!field)throw new Error('нет поля');

  const revealCell=async(x,y)=>{
    const r=await api.post('/minesweeper/',{x,y,is_flag:false});
    field=r?.field||field;status=r?.game_status;
  };

  const anyRevealed=()=>{
    for(let y=0;y<field.height;y++)for(let x=0;x<field.width;x++)if(isRevealed(field.squares?.[y]?.[x]))return true;
    return false;
  };
  if(!anyRevealed())await revealCell(0,0); // безопасный первый клик — мины ещё не сгенерированы
  if(!field)throw new Error('нет поля после первого клика');

  const totalMines=field.num_mines??null;
  let guard=field.width*field.height+10,moves=0,stoppedNoTarget=false;
  while(status!=='won'&&status!=='lost'&&guard-->0){
    const{safe,mines,constraints}=deduce(field,new Set());
    const target=[...safe][0]??bestGuess(field,mines,constraints,totalMines);
    if(!target){stoppedNoTarget=true;break;}
    const[x,y]=parseKey(target);
    await revealCell(x,y);
    moves++;
  }
  if(status!=='won'&&status!=='lost'&&stoppedNoTarget)
    logger.warn(`[${name}] [minesweeper] солвер остановился без хода (ходов=${moves})`);
  if(status!=='won')throw new Error(`не выиграно (${status})`);
  const reward=await getReward(api);
  await logResult(name,true,reward);
  logger.info(`[${name}] [minesweeper] выиграно, награда ${reward}`);
  return{won:true,reward};
}
module.exports={solveMinesweeper};
