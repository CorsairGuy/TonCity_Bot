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
  let skipped=0;
  for(const it of items||[]){
    if(!it?.def_id){skipped++;continue;}
    // БАГ (исправлено 31.07.2026): раньше стояло `if(!it.def_id||!it.definition)continue` — запись
    // БЕЗ definition молча пропускалась целиком, и политика не попадала в библиотеку вообще, хотя
    // аккаунт ей владеет (жалоба: эпический «Промышленник» есть на аккаунте, а в библиотеке нет).
    // Теперь definition необязателен: часть полей игра кладёт и на верхний уровень записи, а сама
    // строка каталога имеет смысл даже с одним def_id+rarity — лучше показать политику с неполными
    // данными, чем не показать вовсе.
    const d=it.definition||it;
    // Собираем ТОЛЬКО непустые поля: «облегчённая» запись (без definition) не должна затирать уже
    // сохранённые нормальные имя/описание/эффекты, пришедшие из более полного источника.
    const payload={updated_at:new Date()};
    if(it.rarity!=null)payload.rarity=it.rarity;
    if(d.name!=null)payload.name=JSON.stringify(d.name);
    if(d.description!=null)payload.description=JSON.stringify(d.description);
    if(d.icon_key!=null)payload.icon_key=d.icon_key;
    if(d.theme!=null)payload.theme=d.theme;
    if(d.badge!=null)payload.badge=d.badge;
    if(d.badge_n!=null)payload.badge_n=d.badge_n;
    if(it.max_level!=null)payload.max_level=it.max_level;
    if(Array.isArray(it.effects)&&it.effects.length)payload.effects=JSON.stringify(it.effects);
    // ключ — ПАРА (def_id, rarity): одна политика существует в разных редкостях с тем же def_id,
    // и при ключе только по def_id строка перезаписывалась чужой редкостью (см. db/index.js)
    const rarity=it.rarity??'unknown';
    const[row,created]=await PolicyDefCatalog.findOrCreate({where:{def_id:it.def_id,rarity},defaults:{def_id:it.def_id,rarity,seen_account:name,...payload}});
    if(!created)await row.update(payload); // обновляем описание/эффекты свежими данными
  }
  return skipped;
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
    // редкость берём ИЗ ЛОТА (o.item_rarity) — она и определяет, какой вариант политики продаётся
    const rarity=o.item_rarity??p.rarity??'unknown';
    const payload={
      rarity,
      name:JSON.stringify(p.name??null),
      icon_key:p.icon_key??null,
      theme:p.theme??null,
      max_level:p.max_level??null,
      effects:JSON.stringify(p.effects??[]),
      updated_at:new Date(),
    };
    try{
      const[row,created]=await PolicyDefCatalog.findOrCreate({where:{def_id:p.def_id,rarity},defaults:{def_id:p.def_id,rarity,seen_account:seenName,description:JSON.stringify(null),...payload}});
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
    // кабинет мэра несёт тот же блок civic_draw, что и /progress/diversity — освежаем снимок
    // розыгрыша и будильник автосбора без отдельного запроса. Форма в кабинете живым ответом не
    // сверена, поэтому берём только если поля на месте (иначе просто пропускаем).
    const cd=cabData?.civic_draw;
    if(cd&&typeof cd.claimable==='boolean'&&typeof cd.draws_per_day==='number'&&typeof cd.draw_progress==='number'){
      await require('./townhall').saveCivicDraw(name,cd).catch(e=>logger.warn(`[${name}] [policies] civic_draw: ${e.message}`));
    }
    const list=Array.isArray(listData)?listData:(listData?.instances||listData?.policies||[]);
    // economy: {unlocked,min_population,craft_costs:{rarity:cost}} — та же /policies/, раньше
    // отбрасывалось (брали только .instances). Нужно кнопке "Создать тайную политику" — знать,
    // сколько осколков реально требуется на редкость, прежде чем её включать.
    const economy=Array.isArray(listData)?null:(listData?.economy??null);
    // ВАЖНО: в снимок пишем ТОЛЬКО реально полученные куски. Раньше payload собирался безусловно,
    // и если падал/таймаутил один запрос из трёх (каждый со своим .catch(()=>null)), а хоть один
    // другой отвечал — на месте упавшего в БД записывалась ПУСТОТА: `list:'[]'` стирал все карты
    // политик аккаунта, библиотека обнулялась в {discovered:0,total:0}. Снаружи это выглядело как
    // «нажал Обновить — политики пропали / не обновляются».
    const payload={updated_at:new Date()};
    if(listData!=null)payload.list=JSON.stringify(list);
    if(libData!=null)payload.library=JSON.stringify(libData);
    if(cabData!=null)payload.cabinet=JSON.stringify(cabData);
    if(economy!=null)payload.economy=JSON.stringify(economy);
    const defaults={
      account:name,
      list:JSON.stringify(list),
      library:JSON.stringify(libData||{discovered:0,total:0,sections:[]}),
      cabinet:JSON.stringify(cabData||{slots:[],civic_draw:null}),
      economy:JSON.stringify(economy),
      updated_at:new Date(),
    };
    const[row,created]=await PolicySnapshot.findOrCreate({where:{account:name},defaults});
    if(!created)await row.update(payload);
    if(listData==null)logger.warn(`[${name}] [policies] /policies/ не ответила — список владений оставлен прежним`);

    // ВРЕМЕННЫЙ debug-дамп (13.10.2026): прогноз осколков на повышение редкости в панели не бьётся
    // с реальным ответом сервера ("недостаточно осколков редкости" при have>=need по подсчёту
    // панели) — нужен сырой raw JSON promotion-блока, чтобы увидеть, какие поля реально шлёт игра
    // (возможно, нужны осколки ЦЕЛЕВОЙ редкости, а не текущей). Удалить после диагностики.
    for(const it of list){
      if(it?.promotion)logger.warn(`[${name}] [policies][DEBUG] ${it.def_id} rarity=${it.rarity} level=${it.level}/${it.max_level} promotion=${JSON.stringify(it.promotion)}`);
    }

    // копим общий каталог описаний — из владений и из библиотеки (сколько бы аккаунт ни открыл).
    // БАГ (исправлено 31.07.2026): раньше было просто `flatMap(s=>s.entries||[])` — и РЕДКОСТЬ
    // ТЕРЯЛАСЬ, потому что в ответе игры она лежит на уровне СЕКЦИИ (`sections[].rarity`), а не у
    // самой записи. В каталог такие политики попадали с `rarity:null` и не показывались НИ В ОДНОЙ
    // группе библиотеки (жалоба: Квартирмейстер обычный/необычный есть в игре, а на странице нет —
    // редкий и эпический при этом видны, т.к. они есть во владениях, где редкость у инстанса есть).
    const libEntries=(libData?.sections||[]).flatMap(s=>(s.entries||[]).map(e=>({...e,rarity:e.rarity??s.rarity})));
    // …и из КАБИНЕТА: политика, поставленная в слот мэра, лежит в cabinet.slots[].instance. Раньше
    // этот источник не харвестился вообще — если экземпляр политики есть только в кабинете, в
    // библиотеку она не попадала.
    const cabInstances=(cabData?.slots||[]).map(s=>s?.instance).filter(Boolean);
    await harvestDefs(list,name).catch(e=>logger.warn(`[${name}] [policies] harvest list: ${e.message}`));
    await harvestDefs(libEntries,name).catch(e=>logger.warn(`[${name}] [policies] harvest library: ${e.message}`));
    await harvestDefs(cabInstances,name).catch(e=>logger.warn(`[${name}] [policies] harvest cabinet: ${e.message}`));

    // в лог — сколько записей пришло из каждого источника: если библиотека вдруг «похудела»,
    // сразу видно, какой источник просел, без разбора вслепую
    logger.info(`[${name}] [policies] синхронизировано (владений ${list.length}, библиотека ${libEntries.length}, кабинет ${cabInstances.length})`);
  }catch(e){
    if(e?.noBuilding)return;
    logger.warn(`[${name}] [policies]: ${e.message}`);
  }
}
module.exports={runPolicies,harvestMarketPolicies};
