'use strict';
// Побитовое сравнение WASM-солвера с сохранённым эталоном. Никаких запросов к игре.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'../..');
const {move,DIRS}=require(path.join(ROOT,'src/modules/game2048'));

function help(){
  console.log(`node scripts/tests/game2048-exact.cjs --reference OLD.wasm --candidate NEW.wasm
  [--reference-scores OLD-debug.wasm --candidate-scores NEW-debug.wasm]
  [--boards 128 --games 2 --steps 10000 --repeats 3 --warmup 16 --benchmark-boards 256 --seed 2048]
  [--corpus boards.json --write-corpus boards.json --json result.json]

Эталон — сохранённый исходный бинарник, не пересобранная замена.
Debug-модули должны экспортировать score_bits(board:i64, direction:i32):i32
(читает оценки последнего best_move без повторного вычисления).
Без debug-модулей сравниваются ходы; с ними — также ВСЕ биты четырёх float-оценок.
--boards: число синтетических досок сверх обязательных краевых случаев.
--benchmark-boards: равномерная выборка корпуса для тайминга; 0 — весь корпус.
--games: полные партии с одинаковыми seed до 2048/проигрыша. --steps — страховочный
лимит; достижение лимита считается ошибкой, а не успешной полной партией.
Тайминг не включает генерацию/кодирование/проверку оценок; пары чередуют порядок.
Проверка конечного корпуса не является математическим доказательством для всех досок.`);
}
function options(argv){
  const out={boards:128,games:2,steps:10000,repeats:3,warmup:16,'benchmark-boards':256,seed:2048};
  const names=new Set(['reference','candidate','reference-scores','candidate-scores','boards','games','steps','repeats','warmup','benchmark-boards','seed','corpus','write-corpus','json']);
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--help'){help();process.exit(0);}
    const key=argv[i].replace(/^--/,'');
    assert(names.has(key)&&argv[i].startsWith('--'),`Неизвестный аргумент ${argv[i]}`);
    assert(i+1<argv.length,`Нет значения ${argv[i]}`);out[key]=argv[++i];
  }
  for(const k of ['boards','games','steps','repeats','warmup','benchmark-boards','seed']){
    out[k]=Number(out[k]);assert(Number.isSafeInteger(out[k])&&out[k]>=0,`Некорректное --${k}`);
  }
  assert(out.steps>0&&out.repeats>0,'steps/repeats должны быть положительными');
  assert(out.reference&&out.candidate,'Нужны --reference и --candidate; --help показывает параметры');
  assert(!!out['reference-scores']===!!out['candidate-scores'],'Нужны оба debug-модуля');
  return out;
}
function load(file,kind='move'){
  const bytes=fs.readFileSync(path.resolve(file)),module=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[],`${file}: неожиданные импорты WASM`);
  const instance=new WebAssembly.Instance(module,{});instance.exports._initialize();
  assert.equal(typeof instance.exports.best_move,'function',`${file}: нет best_move`);
  if(kind==='score')assert.equal(typeof instance.exports.score_bits,'function',`${file}: нет score_bits`);
  return{file:path.resolve(file),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),exports:instance.exports};
}
function rng(seed){let x=seed>>>0;return()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;};}
function encode(board){
  assert(Array.isArray(board)&&board.length===4&&board.every(r=>Array.isArray(r)&&r.length===4),'Нужна доска4×4');
  let packed=0n;
  for(let i=0;i<16;i++){
    const value=board[i>>2][i&3],rank=value?Math.log2(value):0;
    assert(Number.isInteger(value)&&value>=0&&Number.isInteger(rank)&&rank<=15&&(!value||value>=2),`Недопустимая клетка ${value}`);
    packed|=BigInt(rank)<<BigInt(i*4);
  }
  return packed;
}
function spawn(board,random){
  const empty=[];for(let i=0;i<16;i++)if(!board[i>>2][i&3])empty.push(i);
  if(!empty.length)return false;
  const i=empty[Math.floor(random()*empty.length)];board[i>>2][i&3]=random()<0.9?2:4;return true;
}
function synthetic(count,random){
  const out=[0n,1n,1n<<60n,0x1212212112122121n,0x1111111111111111n,0x0123456789abcdefn];
  // Последняя строка меняется при одинаковых первых трёх: целевой случай коллизий старого hash.
  for(let row=0;row<16;row++)out.push(0x112233445566n|(BigInt(row)<<48n));
  for(let n=0;n<count;n++){
    const board=Array.from({length:4},()=>Array(4).fill(0));
    const occupied=n%3===0?14+(n%2):3+Math.floor(random()*13),positions=Array.from({length:16},(_,i)=>i);
    for(let i=15;i>0;i--){const j=Math.floor(random()*(i+1));[positions[i],positions[j]]=[positions[j],positions[i]];}
    for(let i=0;i<occupied;i++){const p=positions[i];board[p>>2][p&3]=2**(1+Math.floor(random()*(n%4===0?10:6)));}
    out.push(encode(board));
  }
  return out;
}
function summary(values){
  const sorted=[...values].sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]??0;
  return{count:sorted.length,totalMs:values.reduce((a,b)=>a+b,0),medianMs:at(0.5),p95Ms:at(0.95),p99Ms:at(0.99),maxMs:sorted.at(-1)??0};
}
function bitsHex(n){return (n>>>0).toString(16).padStart(8,'0');}
function main(){
  const o=options(process.argv.slice(2));
  const baseline=load(o.reference),candidate=load(o.candidate);
  const oldScores=o['reference-scores']?load(o['reference-scores'],'score'):null,newScores=o['candidate-scores']?load(o['candidate-scores'],'score'):null;
  let moveChecks=0,scoreChecks=0;
  const corpus=[],unique=new Set();
  function remember(packed){assert(packed>=0n&&packed<=0xffffffffffffffffn,'Доска вне диапазона unsigned64');const key=packed.toString(16).padStart(16,'0');if(!unique.has(key)){unique.add(key);corpus.push(packed);}}
  function check(packed,context){
    const a=baseline.exports.best_move(packed),b=candidate.exports.best_move(packed);moveChecks++;
    assert.equal(b,a,`${context}: ход отличается, board=0x${packed.toString(16)} reference=${a} candidate=${b}`);
    assert(a>=-1&&a<=3,`${context}: некорректный ход ${a}`);
    if(oldScores){
      // Debug и release должны выбирать тот же ход; оценки считаются в отдельных instances.
      assert.equal(oldScores.exports.best_move(packed),a,`${context}: debug-reference отличается от исходного бинарника`);
      assert.equal(newScores.exports.best_move(packed),b,`${context}: debug-candidate отличается от release`);
      for(let dir=0;dir<4;dir++){
        const x=oldScores.exports.score_bits(packed,dir)>>>0,y=newScores.exports.score_bits(packed,dir)>>>0;scoreChecks++;
        assert.equal(y,x,`${context}: float-биты dir=${dir}, board=0x${packed.toString(16)} old=0x${bitsHex(x)} new=0x${bitsHex(y)}`);
      }
    }
    return a;
  }
  const input=o.corpus?JSON.parse(fs.readFileSync(o.corpus,'utf8')).map(x=>typeof x==='string'?BigInt(`0x${x.replace(/^0x/,'')}`):encode(x)):synthetic(o.boards,rng(o.seed));
  for(let i=0;i<input.length;i++){remember(input[i]);check(input[i],`corpus[${i}]`);}
  const games=[];
  for(let g=0;g<o.games;g++){
    const seed=(o.seed+Math.imul(g+1,0x9e3779b9))>>>0,random=rng(seed),board=Array.from({length:4},()=>Array(4).fill(0));
    spawn(board,random);spawn(board,random);let current=board,steps=0,won=false,ended=false;
    for(;steps<o.steps;steps++){
      const packed=encode(current),dir=check(packed,`game[${g}] step[${steps}]`);remember(packed);
      if(dir<0){ended=true;break;}
      const next=move(current,DIRS[dir]);assert(next.changed,`game[${g}]: солвер выбрал недопустимый ход ${dir}`);current=next.board;
      if(current.some(r=>r.some(v=>v>=2048))){won=true;ended=true;steps++;break;}
      spawn(current,random);
    }
    assert(ended,`game[${g}]: лимит ${o.steps} ходов; партия не завершена`);
    games.push({seed,steps,won,maxTile:Math.max(...current.flat()),lastBoard:encode(current).toString(16).padStart(16,'0')});
    console.log(`PASS game ${g+1}/${o.games}: seed=${seed}, steps=${steps}, max=${games.at(-1).maxTile}`);
  }
  if(o['write-corpus'])fs.writeFileSync(o['write-corpus'],JSON.stringify(corpus.map(b=>b.toString(16).padStart(16,'0')),null,2)+'\n');
  // Свежие benchmark-instances: проверка/диагностика не прогревает их таблицы несимметрично.
  const timedOld=load(o.reference),timedNew=load(o.candidate),timings={reference:[],candidate:[]},pairs=[];
  function sample(items,limit){const n=limit?Math.min(items.length,limit):items.length;return Array.from({length:n},(_,i)=>items[n===1?0:Math.floor(i*(items.length-1)/(n-1))]);}
  const timedCorpus=sample(corpus,o['benchmark-boards']);
  const warmup=o.warmup?sample(timedCorpus,o.warmup):[];
  for(const b of warmup){timedOld.exports.best_move(b);timedNew.exports.best_move(b);}
  function timed(module,packed){const start=performance.now();const dir=module.exports.best_move(packed);return{dir,ms:performance.now()-start};}
  for(let repeat=0;repeat<o.repeats;repeat++){
    for(let i=0;i<timedCorpus.length;i++){
      const b=timedCorpus[i],reverse=(repeat+i)%2;let oldResult,newResult;
      if(reverse){newResult=timed(timedNew,b);oldResult=timed(timedOld,b);}else{oldResult=timed(timedOld,b);newResult=timed(timedNew,b);}
      assert.equal(newResult.dir,oldResult.dir,`benchmark[${repeat},${i}]: различие хода`);
      timings.reference.push(oldResult.ms);timings.candidate.push(newResult.ms);pairs.push({board:b.toString(16).padStart(16,'0'),repeat,referenceMs:oldResult.ms,candidateMs:newResult.ms});
    }
  }
  const result={node:process.version,arch:process.arch,platform:process.platform,baseline:{file:baseline.file,sha256:baseline.sha256},candidate:{file:candidate.file,sha256:candidate.sha256},identicalBinary:baseline.sha256===candidate.sha256,options:o,checks:{moves:moveChecks,floatScores:scoreChecks},games,uniqueBoards:corpus.length,benchmark:{boards:timedCorpus.length,reference:summary(timings.reference),candidate:summary(timings.candidate),memoryBytes:{reference:timedOld.exports.memory.buffer.byteLength,candidate:timedNew.exports.memory.buffer.byteLength},pairs}};
  result.benchmark.totalSpeedup=result.benchmark.reference.totalMs/(result.benchmark.candidate.totalMs||1);
  if(o.json)fs.writeFileSync(o.json,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,benchmark:{...result.benchmark,pairs:undefined}},null,2));
  console.log(`PASS: ${moveChecks} ходов${oldScores?`, ${scoreChecks} float-оценок побитово`:''}; ${games.length} полных seed-партий. Корпус конечен; доказательство семантики изменений — отдельно.`);
}
try{main();}catch(error){console.error(error.stack||error);process.exitCode=1;}
