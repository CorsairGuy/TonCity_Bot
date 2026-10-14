'use strict';
const {PolicySnapshot,PolicyDefCatalog}=require('../db/index');
const logger=require('../utils/logger');

// Синхронизация системы Политик (добавлена в игру 06.07.2026, открывается при 1M населения).
// Пишем снимок в БД, чтобы страница "Политики" читала данные аналогично "Предметам" —
// без живого запроса к игре на каждое открытие страницы.

// Полного каталога всех ~300 политик клиент игры не хранит локально (сервер отдаёт только уже
// открытые аккаунтом). Поэтому копим общий каталог описаний в БД из данных ВСЕХ аккаунтов бота —
// каждая инстанция (владение) и каждая запись библиотеки несёт полное определение (name/description/
// icon_key/theme/effects), просто складываем их в policy_def_catalog по def_id.
async function harvestDefs(items,name){
  for(const it of items||[]){
    if(!it?.def_id||!it?.definition)continue;
    const d=it.definition;
    const payload={
      rarity:it.rarity??null,
      name:JSON.stringify(d.name??null),
      description:JSON.stringify(d.description??null),
      icon_key:d.icon_key??null,
      theme:d.theme??null,
      badge:d.badge??null,
      badge_n:d.badge_n??null,
      max_level:it.max_level??null,
      effects:JSON.stringify(it.effects??[]),
      updated_at:new Date(),
    };
    const[row,created]=await PolicyDefCatalog.findOrCreate({where:{def_id:it.def_id},defaults:{def_id:it.def_id,seen_account:name,...payload}});
    if(!created)await row.update(payload); // обновляем описание/эффекты свежими данными
  }
}

// Витрина рынка (/market/offers) для лотов категории policy отдаёт ПОЛНОЕ определение политики
// прямо в поле offer.policy ({def_id,name:{en,ru},theme,icon_key,max_level,effects,...}) — форма
// чуть иная, чем у /policies/* (там всё под .definition, и есть description). Складываем это в тот
// же общий каталог, чтобы библиотека политик знала и о политиках, которых нет ни на одном аккаунте,
// но которые «засветились» на рынке. description маркет не отдаёт — при обновлении НЕ затираем уже
// сохранённое из /policies/* описание (не кладём description в payload апдейта).
async function harvestMarketPolicies(offers,seenName='рынок'){
  for(const o of offers||[]){
    const p=o?.policy;
    if(!p?.def_id)continue;
    const payload={
      rarity:o.item_rarity??p.rarity??null,
      name:JSON.stringify(p.name??null),
      icon_key:p.icon_key??null,
      theme:p.theme??null,
      max_level:p.max_level??null,
      effects:JSON.stringify(p.effects??[]),
      updated_at:new Date(),
    };
    try{
      const[row,created]=await PolicyDefCatalog.findOrCreate({where:{def_id:p.def_id},defaults:{def_id:p.def_id,seen_account:seenName,description:JSON.stringify(null),...payload}});
      if(!created)await row.update(payload); // description намеренно не в payload — не затираем
    }catch(_){}
  }
}

async function runPolicies(api,name){
  try{
    const[listData,libData,cabData]=await Promise.all([
      api.get('/policies/').catch(()=>null),
      api.get('/policies/library').catch(()=>null),
      api.get('/policies/cabinet').catch(()=>null),
    ]);
    // фича не открыта (нет населения) или недоступна — тихо пропускаем, не пишем пустой снимок поверх
    if(!listData&&!libData&&!cabData)return;
    const list=Array.isArray(listData)?listData:(listData?.instances||listData?.policies||[]);
    // economy: {unlocked,min_population,craft_costs:{rarity:cost}} — та же /policies/, раньше
    // отбрасывалось (брали только .instances). Нужно кнопке "Создать тайную политику" — знать,
    // сколько осколков реально требуется на редкость, прежде чем её включать.
    const economy=Array.isArray(listData)?null:(listData?.economy??null);
    const payload={
      list:JSON.stringify(list),
      library:JSON.stringify(libData||{discovered:0,total:0,sections:[]}),
      cabinet:JSON.stringify(cabData||{slots:[],civic_draw:null}),
      economy:JSON.stringify(economy),
      updated_at:new Date(),
    };
    const[row,created]=await PolicySnapshot.findOrCreate({where:{account:name},defaults:{account:name,...payload}});
    if(!created)await row.update(payload);

    // копим общий каталог описаний — из владений и из библиотеки (сколько бы аккаунт ни открыл)
    const libEntries=(libData?.sections||[]).flatMap(s=>s.entries||[]);
    await harvestDefs(list,name).catch(()=>{});
    await harvestDefs(libEntries,name).catch(()=>{});

    logger.info(`[${name}] [policies] синхронизировано (${list.length} политик)`);
  }catch(e){
    if(e?.noBuilding)return;
    logger.warn(`[${name}] [policies]: ${e.message}`);
  }
}
module.exports={runPolicies,harvestMarketPolicies};
