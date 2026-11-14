'use strict';
// Только события: первый запуск, ручное «Обновить» гильдий и смена членства через бота.
// TTL, таймеров и периодических запросов здесь нет. Цикл города читает локальную версию.
const{wake}=require('./cityWake');
const values=new Map(),pending=new Map();
function normalize(data){
  const b=data?.benefits||{};
  return{discount:Number(b.upgrades_discount)||0,buildDiscount:Number(b.building_purchases_discount)||0,
    additionalBuilder:Math.max(0,Math.floor(Number(b.additional_builder)||0)),reducedUpgradeTimes:Number(b.reduced_upgrade_times)||0};
}
function current(name){return values.get(name);}
function publish(name,data){
  const value={...normalize(data),revision:(values.get(name)?.revision||0)+1};
  values.set(name,value);wake(name);return value;
}
async function ensure(api,name){
  if(values.has(name))return values.get(name);
  if(pending.has(name))return pending.get(name);
  const p=(async()=>{
    let data;try{data=await api.get('/guilds/benefits');}catch{}
    // Ручное обновление могло закончиться, пока первый запрос ожидал сеть.
    return values.get(name)||publish(name,data);
  })().finally(()=>pending.delete(name));
  pending.set(name,p);return p;
}
async function refreshBuilderSnapshot(api,name){
  // Только чтение: runBuilders здесь использовать нельзя — он умеет покупать строителей.
  const[d,prog]=await Promise.all([api.get('/builders/'),api.get('/progress/')]);
  const{BuilderSnapshot,CitySnapshot,Account}=require('../db/index');
  const max_builders=d?.max_builders??null,max_coins=d?.max_coins??0,max_stars=d?.max_stars??0,cnt_coins=d?.cnt_coins??0,cnt_stars=d?.cnt_stars??0;
  if(!Number.isFinite(max_builders))throw new Error('Не удалось получить актуальное число строителей');
  await BuilderSnapshot.upsert({account:name,count:(max_builders??0)-max_coins-max_stars+cnt_coins+cnt_stars,
    max_builders,max_coins,max_stars,cnt_coins,cnt_stars,price_coins:d?.coins??null,price_stars:d?.stars??null,updated_at:new Date()},{conflictFields:['account']});
  const data=prog?.progress?.data,buildings=data?.buildings,sections=prog?.progress?.unlocked_sections;
  if(Array.isArray(buildings)){
    const row={account:name,buildings:JSON.stringify(buildings),updated_at:new Date()};
    if(Array.isArray(sections))row.unlocked_sections=JSON.stringify(sections);
    await CitySnapshot.upsert(row,{conflictFields:['account']});
    require('./cityLive').broadcast(name,buildings,sections);
  }
  const balance={};
  if(data?.coins!=null)balance.balance=String(data.coins);
  if(data?.crystals!=null)balance.crystals=String(data.crystals);
  if(Object.keys(balance).length)await Account.update(balance,{where:{name}});
  return prog;
}
async function syncGuildBonuses(api,name,guild){
  // При потере членства сбрасываем бонус сразу, даже если следующий запрос завершится ошибкой.
  const started=publish(name,null).revision;
  let data=null;
  if(guild?.id){
    data=await api.get('/guilds/benefits');
    if(current(name).revision!==started)throw new Error('Гильдия изменилась во время обновления — повторите обновление');
    publish(name,data);
  }
  await refreshBuilderSnapshot(api,name);
  return{data,value:current(name)};
}
module.exports={normalize,current,publish,ensure,syncGuildBonuses,refreshBuilderSnapshot};
