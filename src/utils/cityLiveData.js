'use strict';
// Данные игры для панели города, которые бот держит в БД (решение 24.10.2026): панель при открытии
// города в игру не ходит. Условия построек (/buildings/criteria) пишет цикл прокачки города (раз в
// проход) и кнопка «Обновить» на странице «Города»; бонусы гильдии (/guilds/benefits) лежат в
// GuildSnapshot.benefits — их пишут квесты гильдии (capital.js) и та же кнопка.
const{seq,GuildSnapshot}=require('../db/index');

async function syncBuildCriteria(api,name){
  const d=await api.get('/buildings/criteria');
  await seq.query('INSERT INTO city_build_criteria (account,criteria,updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE criteria=VALUES(criteria),updated_at=VALUES(updated_at)',
    {replacements:[name,JSON.stringify(d??null)]});
  return d;
}
async function loadBuildCriteria(name){
  const[rows]=await seq.query('SELECT criteria FROM city_build_criteria WHERE account=?',{replacements:[name]});
  if(!rows.length||rows[0].criteria==null)return null;
  try{return JSON.parse(rows[0].criteria);}catch{return null;}
}
// строка гильдии уже есть (её создают квесты гильдии) — обновляем только бонусы
async function syncGuildBenefits(api,name){
  const d=await api.get('/guilds/benefits');
  await GuildSnapshot.update({benefits:JSON.stringify(d),updated_at:new Date()},{where:{account:name}});
  return d;
}
async function loadGuildBenefits(name){
  const row=await GuildSnapshot.findOne({where:{account:name},order:[['updated_at','DESC']]});
  let b=null;try{b=row?.benefits?JSON.parse(row.benefits):null;}catch{}
  return b&&typeof b==='object'?(b.benefits??b):null;
}

module.exports={syncBuildCriteria,loadBuildCriteria,syncGuildBenefits,loadGuildBenefits};
