'use strict';
// Перемещение и отправка апгрейда одного города не должны пересекаться.
// Ревизия отменяет уже рассчитанную пачку после изменения координат.
const tails=new Map(),revisions=new Map();
const revision=account=>revisions.get(account)||0;
function changed(account){revisions.set(account,revision(account)+1);}
async function run(account,fn){
  const previous=tails.get(account)||Promise.resolve();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const tail=previous.then(()=>gate);
  tails.set(account,tail);
  await previous;
  try{return await fn();}
  finally{release();if(tails.get(account)===tail)tails.delete(account);}
}
module.exports={run,revision,changed};
