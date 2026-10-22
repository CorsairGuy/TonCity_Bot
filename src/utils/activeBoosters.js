'use strict';
// Активные ускорители аккаунта по последнему живому GET /boosters/active (плюс свои активации).
// Только в памяти: вкладке «Ускорители» нужен активный тип, даже если его последний экземпляр уже
// ушёл со склада и строки Inventory нет. Освежают цикл очереди, синхронизация склада, «Проверить»
// и активации. После перезапуска пусто до первого из них — тогда вкладка берёт данные из Inventory.
// имя аккаунта → { ts, ends: Map<id типа, [end ms]> }
const _byAccount=new Map();
function set(name,endsByType){_byAccount.set(name,{ts:Date.now(),ends:new Map([...endsByType].map(([id,arr])=>[String(id),[...arr]]))});}
function get(name){return _byAccount.get(name)||null;}
function add(name,id,endMs){
  const cur=_byAccount.get(name);
  if(!cur||!endMs)return;
  const arr=cur.ends.get(String(id))||[];
  arr.push(endMs);
  cur.ends.set(String(id),arr);
}
module.exports={set,get,add};
