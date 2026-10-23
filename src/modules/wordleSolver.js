'use strict';
// Энтропийный подбор слова для вордли (подход 3Blue1Brown / jonhoo/roget): ход — слово из всего словаря,
// которое в среднем даёт больше всего информации о загаданном. Кандидаты — слова, у которых раскраска
// всех прошлых догадок совпала бы с ответом игры буква в букву (с учётом повторов букв).
// Замер на config/wordle-words.txt: в среднем 3,84 догадки против 4,46 у прежнего частотного подбора.
const ALLGREEN=242;

// Индексы букв слов для быстрого счёта раскраски
function _encode(words){
  const map=new Map();const enc=new Uint8Array(words.length*5);
  words.forEach((w,i)=>{for(let p=0;p<5;p++){const c=w[p];if(!map.has(c))map.set(c,map.size);enc[i*5+p]=map.get(c);}});
  return{enc,letters:map.size};
}

// Раскраска как у игры: 2 — на месте, 1 — есть в слове, 0 — нет; позиция 0 — младший разряд (основание 3)
const _cnt=new Int8Array(256);
function _pattern(enc,g,a){
  const G=g*5,A=a*5;const res=[0,0,0,0,0];
  for(let p=0;p<5;p++){if(enc[G+p]===enc[A+p])res[p]=2;else _cnt[enc[A+p]]++;}
  for(let p=0;p<5;p++){if(res[p])continue;const c=enc[G+p];if(_cnt[c]>0){res[p]=1;_cnt[c]--;}}
  for(let p=0;p<5;p++)_cnt[enc[A+p]]=0;
  return res[0]+3*res[1]+9*res[2]+27*res[3]+81*res[4];
}

// Ответ игры (feedback[{position,status}]) → число раскраски; null, если ответ неполный
function patternOfFeedback(feedback){
  if(!Array.isArray(feedback)||feedback.length!==5)return null;
  const d={correct:2,present:1,absent:0};let p=0;
  for(const f of feedback){const v=d[f.status];const pos=Number(f.position)-1;if(v==null||pos<0||pos>4)return null;p+=v*3**pos;}
  return p;
}

let _cache={words:null,enc:null,idx:null,first:new Map()};
function _prep(words){
  if(_cache.words!==words){
    const{enc}=_encode(words);
    _cache={words,enc,idx:new Map(words.map((w,i)=>[w,i])),first:new Map()};
  }
  return _cache;
}

// Кандидаты: слова словаря (кроме исключённых), согласные со всей историей [{word,pattern}]
function candidates(words,history,exclude=new Set()){
  const{enc,idx}=_prep(words);
  const hist=history.map(h=>({g:idx.get(h.word),p:h.pattern})).filter(h=>h.g!=null&&h.p!=null);
  const out=[];
  for(let i=0;i<words.length;i++){
    if(exclude.has(words[i]))continue;
    let ok=true;
    for(const h of hist)if(_pattern(enc,h.g,i)!==h.p){ok=false;break;}
    if(ok)out.push(i);
  }
  return out;
}

const _yield=()=>new Promise(r=>setImmediate(r));

// Лучшая догадка. history — [{word,pattern}] всех аккаунтов за день, exclude — слова, которые
// нельзя подавать (уже поданы или игра их не принимает). Возвращает {guess,left} или null.
// Первый ход по полному словарю — ~43 млн раскрасок, поэтому счёт асинхронный с паузами для event loop,
// а пятёрка лучших слов кэшируется на словарь; первым идёт случайное из неё. Замер на словаре 6618 слов:
// коран 3,847 догадки в среднем, карет 3,846, норка 3,871, ранок 3,872, киноа 3,886 — случайный выбор
// стоит ~0,02 догадки против всегда одного слова.
const FIRST_POOL=5;
async function bestGuess(words,history,exclude=new Set(),rng=Math.random){
  const c=_prep(words);const{enc}=c;
  const C=candidates(words,history,exclude);
  if(!C.length)return null;
  if(C.length<=2)return{guess:words[C[0]],left:C.length};
  const firstKey=history.length?null:[...exclude].sort().join(',');
  const pickFirst=pool=>({guess:pool[Math.floor(rng()*pool.length)],left:C.length,pool});
  if(firstKey!=null&&c.first.has(firstKey))return pickFirst(c.first.get(firstKey));
  const inC=new Uint8Array(words.length);for(const i of C)inC[i]=1;
  const hist=new Int32Array(243);const n=C.length;
  let bg=-1,bs=-Infinity;const top=[];
  for(let g=0;g<words.length;g++){
    if((g&63)===0&&n>200)await _yield();
    if(exclude.has(words[g]))continue;
    hist.fill(0);
    for(let k=0;k<n;k++)hist[_pattern(enc,g,C[k])]++;
    let s=0;for(let p=0;p<243;p++){const h=hist[p];if(h)s-=h/n*Math.log2(h/n);}
    // кандидат может сразу оказаться ответом — небольшой бонус при равной информации
    if(inC[g])s+=1e-6+0.5/n;
    if(s>bs){bs=s;bg=g;}
    if(firstKey!=null){top.push([s,g]);top.sort((a,b)=>b[0]-a[0]);if(top.length>FIRST_POOL)top.pop();}
  }
  if(bg<0)return null;
  if(firstKey!=null){const pool=top.map(([,g])=>words[g]);c.first.set(firstKey,pool);return pickFirst(pool);}
  return{guess:words[bg],left:n};
}

module.exports={bestGuess,candidates,patternOfFeedback,ALLGREEN,_pattern,_prep};
