'use strict';
const {RateLimiter}=require('../../utils/lock');

// Рейт-лимитер НА КОНКРЕТНЫЙ аккаунт (не общий apiLock — тот один на ВСЕ аккаунты разом, concurrency:1,
// а значит игра в 2048 одного аккаунта стояла бы в очереди позади рыночных/квестовых запросов ДРУГИХ
// аккаунтов, что для живой, наблюдаемой глазами игры неприемлемо). concurrency:1 — как и у реального
// клиента игры (per-move lock, см. modules/game2048.js) — гарантирует, что для ОДНОГО аккаунта
// никогда не будет двух запросов к /game2048/ одновременно, а разные аккаунты друг друга не ждут.
const limiters=new Map();
function forAccount(accountId){
  const key=Number(accountId);
  let l=limiters.get(key);
  if(!l){l=new RateLimiter({rps:3,concurrency:1});limiters.set(key,l);}
  return l;
}

module.exports={forAccount};
