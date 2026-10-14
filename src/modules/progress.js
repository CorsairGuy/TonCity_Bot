'use strict';
const {GlobalUpgradePlan,CitySnapshot}=require('../db/index');
const cityPlans=require('../db/cityPlans');
const logger=require('../utils/logger');
const {globalLock}=require('../utils/lock');
const {sleep,fmt,withRetry}=require('../utils/helpers');
const {isCityPaused}=require('../utils/botState');
const {waitOrWake}=require('../utils/cityWake');
const cityLive=require('../utils/cityLive');
const {buildingsMap:cityBuildingsMap,upgradeStep,upgradeDuration,effectiveUpgradeDuration,computeCityStats}=require('../web/cityStats');
const {logAction,updateAction}=require('./cityActionLog');

// Прокачка города управляется пользовательскими целями со страницы "Города" → "Карта" (см.
// web/routes/cityStrategy.js), в порядке приоритета:
//  1. Ручная очередь (city_upgrade_queue: строка на клетку) — конкретные здания, назначенные "улучшить
//     следующими"; разбирается строителями первой, по одному зданию на строителя, запись
//     вычёркивается из очереди навсегда, как только на неё реально запущен апгрейд.
//  2. Личный план (city_upgrade_target: строка на клетку, с target_level) — цель привязана к КОНКРЕТНОЙ
//     клетке, не к семье здания, иначе один клик по карте задавал бы цель сразу всем экземплярам
//     семьи.
//  3. Общий план по семействам (GlobalUpgradePlan: [{family_id,target_level}]) — не привязан к
//     аккаунту, действует на любой город, где есть здание этого семейства, НО только если для
//     конкретной клетки нет личной цели (см. resolveEffectiveTargets ниже).
// Раньше здесь была автоматика по эталонному плану фазы (config/city-refplans.json) — убрана
// целиком по решению пользователя: позиция здания ни на что не влияет (все формулы — cityStats.js
// — чистые функции количества/уровня, без позиционной составляющей), поэтому сопоставление сетки
// решало не существующую для игры задачу. Строительство/перемещение/снос теперь разовые живые
// действия (см. cityStrategy.js), сюда не относятся — здесь только цикл улучшений.

// Прогресс стройки (для веб-панели): раньше пытались сами запоминать момент старта апгрейда — но
// это не работало для улучшений, запущенных НАПРЯМУЮ в игре (не через бота). Оказалось, не нужно:
// в бандле игры (deserialize(): s.constructionBegin=n.start?...) видно, что сырой ответ /progress/
// уже содержит поле "start" (точное время начала стройки) наравне с "end" — сервер сам его отдаёт,
// вне зависимости от того, кто запустил улучшение. Раз мы просто прокидываем buildings как есть
// (JSON.stringify(current) без фильтрации полей), start уже сохраняется в CitySnapshot сам по себе —
// клиент считает duration=end-start точно, без формул и без знания о бустах ускорения вообще.

// та же формула, что modules/session.js _saveStats использует для Account.profit (params
// отсортированы от новейшего к старейшему, "текущее" — последний элемент) — переиспользуем уже
// полученный ответ /progress/ вместо отдельного запроса/чтения БД для проверки Пути мэра.
function extractCurrentProfit(prog){
  const params=Array.isArray(prog?.progress?.params)?prog.progress.params:[];
  const v=params[params.length-1]?.profit;
  return (typeof v==='number'&&isFinite(v))?v:null;
}

// prog.progress.unlocked_sections — игра отдаёт это готовым прямо в /progress/ (сверено реверсом
// бандла + живым запросом 22.07.2026), никакого отдельного запроса не нужно, см. CitySnapshot.
function unlockedSectionsOf(prog){
  const list=prog?.progress?.unlocked_sections;
  // ВАЖНО: если игра списка не дала (нет поля, другая форма ответа, сбой), возвращаем undefined,
  // а НЕ "[]". Пустой массив — это утверждение «не разблокировано НИЧЕГО», и карта на нём запирает
  // весь город; отсутствие поля — это «не знаю», и тогда замки просто не рисуются (CityMapCity:
  // null/undefined ⇒ без замков). Поле с undefined в upsert не кладём вообще, поэтому уже
  // сохранённый хороший список не затирается.
  return Array.isArray(list)?JSON.stringify(list):undefined;
}

// Строка снимка города: секции добавляются, ТОЛЬКО если игра их прислала.
function citySnapshotPayload(name,buildings,prog){
  const sections=unlockedSectionsOf(prog);
  const row={account:name,buildings:JSON.stringify(buildings),updated_at:new Date()};
  if(sections!==undefined)row.unlocked_sections=sections;
  return row;
}

function describeError(e){
  const status=e?.response?.status;
  const statusText=e?.response?.statusText;
  const data=e?.response?.data;
  const body=typeof data==='string'?data:(data?JSON.stringify(data):'');
  return [e?.message,status?`status ${status}`:'',statusText||'',body].filter(Boolean).join(': ');
}

async function loadGuildBonuses(api){
  try{
    const d=await api.get('/guilds/benefits');
    return{
      discount:Number(d?.benefits?.upgrades_discount||0),
      // "Камни Основания" (столичное здание гильдии) — +N строителей всем участникам. Подтверждено
      // реверсом бандла (additional_builder в том же объекте benefits), но НЕ прибавляется клиентом
      // игры к счётчику строителей нигде явно — по факту у аккаунтов с этим бонусом /progress/
      // отдаёт builders БЕЗ него, поэтому прибавляем сами.
      additionalBuilder:Math.floor(Number(d?.benefits?.additional_builder)||0),
      // "бонус от столицы" на время улучшений (по факту дают столичные здания гильдии, напр. Часовая
      // башня) — сверено с бандлом: S0().upgradeTimeReduction=1-reduced_upgrade_times, множитель
      // применяется к базовой длительности улучшения (см. cityStats.js effectiveUpgradeDuration).
      reducedUpgradeTimes:Number(d?.benefits?.reduced_upgrade_times||0),
    };
  }catch(_){return{discount:0,additionalBuilder:0,reducedUpgradeTimes:0};}
}

// бонус строителей и множитель цены улучшений от надетых в кабинете мэра политик (/policies/cabinet,
// см. policyEffects.ts) — один живой запрос на оба эффекта, каждая инстанция уже несёт готовые к
// применению значения (масштабированные по уровню политики), без доп. вычислений.
// upgradeCostMultiplier — сверено с бандлом игры (getPriceForLevel(): basePriceFormula(n)·
// Gc().upgradeCostMultiplier, а ПОВЕРХ этого при самом апгрейде (levelUp()) умножается ЕЩЁ и на
// гильдийскую скидку S0().upgradeDiscount — те же ДВА независимых множителя, что и у цены постройки
// (build_cost политик + building_purchases_discount гильдии), просто с другой парой полей).
async function loadPolicyEffects(api){
  try{
    const cab=await api.get('/policies/cabinet');
    let builderBonus=0,upgradeCostSum=0,constructionTimeSum=0;
    for(const slot of cab?.slots||[]){
      for(const e of slot?.instance?.effects||[]){
        if(e?.stat==='concurrent_builders'&&e?.mode==='add')builderBonus+=Number(e.value)||0;
        if(e?.stat==='upgrade_cost'&&e?.mode==='mult')upgradeCostSum+=Number(e.value)||0;
        // constructionTimeMultiplier — сверено с бандлом (Gc().constructionTimeMultiplier=
        // policyMultiplier('construction_time')), та же схема, что upgrade_cost/build_cost
        if(e?.stat==='construction_time'&&e?.mode==='mult')constructionTimeSum+=Number(e.value)||0;
      }
    }
    return{builderBonus:Math.floor(builderBonus),upgradeCostMultiplier:Math.max(0,1+upgradeCostSum),constructionTimeMultiplier:Math.max(0,1+constructionTimeSum)};
  }catch(_){return{builderBonus:0,upgradeCostMultiplier:1,constructionTimeMultiplier:1};}
}

// текущий активный ускоритель + флаг "стоит автопродление" — для прогноза (вкладка "Прогноз"). Если
// автопродление включено, бонус действует не бесконечно, а ровно на столько, на сколько реально
// хватит уже купленных ускорителей этого типа: конец текущего инстанса + (сколько ещё штук в
// наличии) × (длительность одной активации). Как только запас закончится — бот больше нечем будет
// продлевать, дальше улучшения снова идут без ускорения.
async function loadConstructionBoostMods(api,account){
  try{
    const{getDurationBoosterInfo}=require('./boosterAutomation');
    const info=await getDurationBoosterInfo(api);
    if(!info?.name)return null;
    const{BoosterAutomation,Inventory}=require('../db/index');
    const auto=await BoosterAutomation.findOne({where:{account,booster_name:info.name}});
    if(!auto?.enabled)return{multiplier:info.multiplier,endsAt:info.endsAt};
    const[row,storage]=await Promise.all([
      Inventory.findOne({where:{account,name:info.name,type:'booster'}}),
      api.get('/storage/allitemdata').catch(()=>null),
    ]);
    // активировать можно и marketable, и locked (soulbound/непродаваемые) экземпляры — locked
    // только запрещает продажу на рынке, на использование по прямому назначению не влияет
    const available=Math.max(0,(Number(row?.marketable)||0)+(Number(row?.locked)||0));
    const rawItems=storage?.items;
    const items=Array.isArray(rawItems)?rawItems:Object.values(rawItems||{});
    const item=items.find(i=>String(i?.item_id??i?.id)===String(info.name));
    // длительность ОДНОЙ активации — отдаёт сама игра (item.booster.duration), в наносекундах (та
    // же единица, что и duration_ns в /shop-live/boosters, см. web/routes/economy.js normalizeShopOffers)
    const perInstanceMs=item?.booster?.duration?Number(item.booster.duration)/1e6:0;
    if(!available||!perInstanceMs)return{multiplier:info.multiplier,endsAt:info.endsAt};
    return{multiplier:info.multiplier,endsAt:info.endsAt+available*perInstanceMs};
  }catch(_){return null;}
}

// ВНИМАНИЕ: значение НЕ применяется автоматически (см. web/routes/cityStrategy.js) — только
// показывается как диагностика. Причина: отличить «стройка шла под ускорителем» от «сервер дал
// ивентовый бонус» задним числом нечем. Проверено на живых снимках: у аккаунта, который постоянно
// держит ускорители, медиана отношений даёт 0.20 — это буст, а не ивент; примени такое, и прогноз
// соврёт в пять раз. Отношения возвращаются как есть, вместе с распределением.
//
// СЕРВЕРНЫЙ множитель времени строек (ивенты). В клиенте игры его НЕТ: getUpgradeDuration (реверс
// бандла entry-*.js, класс городского здания) учитывает ровно три вещи — базу
// construction_increment·2^(lvl-2) с потолком 24ч, гильдийский upgradeTimeReduction (=1-reduced_
// upgrade_times) и политиковый constructionTimeMultiplier, плюс ПОСЛЕДНИЙ активный ускоритель.
// Значит бонус ивента применяет сервер, и никакая формула на клиенте его предсказать не может.
// Зато его видно ПО ФАКТУ: игра отдаёт у каждой идущей стройки start и end. Сверяем фактическую
// длительность с нашей предсказанной и берём медиану отношений — этот коэффициент и есть всё, что
// сервер сделал сверх формулы. Стройки, попавшие под ускоритель, из выборки исключаем (там своя
// математика окна), как и явно протухшие.
function measureActualVsPredicted(current,buildingsMap,{reducedUpgradeTimes=0,constructionTimeMultiplier=1}={},boosterWindowsList=null){
  try{
    const ratios=[];
    const windows=Array.isArray(boosterWindowsList)?boosterWindowsList:[];
    for(const b of current){
      if(!b?.start||!b?.end)continue;
      const info=buildingsMap.get(b.id);
      if(!info)continue;
      const startMs=new Date(b.start).getTime(),endMs=new Date(b.end).getTime();
      if(!(endMs>startMs))continue;
      // под ускорителем — пропускаем: там длительность считается по окну, а не по чистой формуле
      if(windows.some(w=>w.fromMs<endMs&&w.toMs>startMs))continue;
      const base=upgradeDuration(info,Number(b.level||0));
      if(!base)continue;
      const predicted=base*(1-reducedUpgradeTimes)*(constructionTimeMultiplier||1);
      if(predicted<=0)continue;
      ratios.push(((endMs-startMs)/1000)/predicted);
    }
    if(!ratios.length)return{samples:0,median:null,spread:null};
    ratios.sort((a,b)=>a-b);
    return{
      samples:ratios.length,
      median:ratios[Math.floor(ratios.length/2)],
      spread:[ratios[0],ratios[ratios.length-1]],
    };
  }catch(_){return{samples:0,median:null,spread:null};}
}

// ОКНА УСКОРИТЕЛЕЙ на будущее — для вкладки «Прогноз»: не только тот буст, что активен сейчас, но
// и вся очередь активации (BoosterQueue, вкладка «Ускорители»), у каждой позиции свой множитель и
// своя длительность. Пример: сейчас лега, дальше по очереди эпик и два мифика — прогноз должен
// считать каждый отрезок по своему множителю, иначе после конца текущего буста он занижает скорость.
//
// Модель последовательная: следующая позиция начинается там, где заканчивается предыдущая. Это
// прямо следует из правила игры, зашитого в boosterAutomation.js: пока активен ХОТЬ ОДИН
// ускоритель, активировать можно ТОЛЬКО тот же тип — значит другой тип физически ждёт конца
// текущего окна. Стакование одинакового типа (active_limit>1) как «умножение» НЕ моделируем —
// поведение игры на этот счёт не проверено, поэтому одинаковые позиции просто продлевают время.
// САМОКАЛИБРОВКА. `multiplier` из API НЕ равен делителю времени: замерено 07.08 на живых стройках —
// при базе 86400 и гильдийских ×0.88 («работа» 76032с) игра поставила 22293.504с, т.е. делитель
// легендарного 3.4105; под мификом пользователь видит ~4ч20м, делитель 4.874. Отношение этих двух
// делителей = 10/7 в точности, т.е. связь с API-множителем линейная, но коэффициент неизвестен.
// Вместо того чтобы его угадывать, ИЗМЕРЯЕМ: у идущих сейчас строек, целиком накрытых текущим
// окном, делитель = «работа»/(end-start). Полученный коэффициент k = делитель/множитель_API
// переносим на остальные окна очереди. Плюс этого подхода — он же автоматически вбирает любой
// СЕРВЕРНЫЙ бонус (ивенты), которого в клиентской формуле игры нет вообще.
function measureCurrentDivisor(current,buildingsMap,{reducedUpgradeTimes=0,constructionTimeMultiplier=1},boosterEndsAt){
  const now=Date.now(),vals=[];
  for(const b of current||[]){
    if(!b?.start||!b?.end)continue;
    const endMs=new Date(b.end).getTime(),startMs=new Date(b.start).getTime();
    if(!(endMs>startMs)||endMs<=now)continue;      // только идущие сейчас
    if(boosterEndsAt&&endMs>boosterEndsAt)continue; // окно должно накрывать стройку целиком
    const info=buildingsMap.get(b.id);
    if(!info)continue;
    const work=upgradeDuration(info,Number(b.level||0))*(1-reducedUpgradeTimes)*(constructionTimeMultiplier||1);
    if(work<=0)continue;
    vals.push(work/((endMs-startMs)/1000));
  }
  if(vals.length<2)return null;
  vals.sort((a,b)=>a-b);
  const med=vals[Math.floor(vals.length/2)];
  // разброс больше 5% — значит в выборку попали стройки с частичным покрытием, доверять нельзя
  if(!(med>0)||vals[vals.length-1]/vals[0]>1.05)return null;
  return med;
}

async function loadBoosterTimeline(api,account,calib=null){
  try{
    const{getDurationBoosterInfo}=require('./boosterAutomation');
    const{BoosterQueue}=require('../db/index');
    const[info,storage,qrows]=await Promise.all([
      getDurationBoosterInfo(api).catch(()=>null),
      api.get('/storage/allitemdata').catch(()=>null),
      BoosterQueue.findAll({where:{account},order:[['pos','ASC'],['id','ASC']]}).catch(()=>[]),
    ]);
    const raw=storage?.items;
    const items=Array.isArray(raw)?raw:Object.values(raw||{});
    // множитель и длительность ОДНОГО экземпляра отдаёт сама игра (booster.multiplier / .duration в
    // наносекундах), запас — quantity (активировать можно и soulbound-экземпляры)
    const meta=new Map();
    for(const it of items){
      const id=String(it?.item_id??it?.id??'');
      if(!id||!it?.booster)continue;
      meta.set(id,{
        multiplier:Number(it.booster.multiplier)||1,
        durationMs:Number(it.booster.duration||0)/1e6,
        stock:Math.max(0,Number(it.quantity)||0),
      });
    }
    const now=Date.now();
    const segments=[];
    let cursor=now;
    // k — во сколько раз реальный делитель отличается от множителя из API (см. measureCurrentDivisor)
    let k=1,measured=null;
    if(info&&info.multiplier>1&&info.endsAt>now&&calib?.current&&calib?.buildingsMap){
      measured=measureCurrentDivisor(calib.current,calib.buildingsMap,calib,info.endsAt);
      if(measured&&info.multiplier>0)k=measured/info.multiplier;
    }
    if(info&&info.multiplier>1&&info.endsAt>now){
      segments.push({fromMs:now,toMs:info.endsAt,multiplier:measured||info.multiplier,api_multiplier:info.multiplier,name:info.name,measured:!!measured});
      cursor=info.endsAt;
    }
    const spent=new Map();
    for(const q of qrows){
      const m=meta.get(String(q.booster_name));
      if(!m||!m.durationMs||m.multiplier<=1)continue; // тип неизвестен/нет данных — позиция для прогноза бесполезна
      const used=spent.get(q.booster_name)||0;
      if(used>=m.stock)continue;                      // экземпляров уже не осталось — активировать будет нечего
      spent.set(q.booster_name,used+1);
      segments.push({fromMs:cursor,toMs:cursor+m.durationMs,multiplier:m.multiplier*k,api_multiplier:m.multiplier,name:q.booster_name,measured:k!==1});
      cursor+=m.durationMs;
    }
    // ЛОГ КАЛИБРОВКИ: сырые множители из игры рядом с окнами. Нужен, чтобы сопоставить
    // `multiplier` из API с ФАКТИЧЕСКИМ делителем времени, посчитанным по start/end реальных
    // строек (07.08: у легендарного факт дал 3.4105 при базе 86400 и гильдийских 0.88 —
    // если в API окажется другое число, значит между ними есть преобразование).
    if(segments.length){
      logger.info(`[${account}] [forecast] окна ускорителей (k=${k.toFixed(4)}${measured?', замерено':', без замера'}): `+segments.map(w=>
        `${w.name??'?'} API×${w.api_multiplier}→делитель ${Number(w.multiplier).toFixed(3)} до ${new Date(w.toMs).toISOString().slice(11,19)}`).join(' → '));
    }
    return segments.length?segments:null;
  }catch(_){return null;}
}

// личный план (targets) + ручная очередь (queue) + запланированные реконструкции (reconstructPlan)
// аккаунта. С 19.08 лежат ПОСТРОЧНО (строка = клетка) в city_upgrade_target/city_upgrade_queue/
// city_reconstruct_plan — см. db/cityPlans.js. Раньше это были три JSON-блоба в одной строке
// city_strategy: любое сохранение переписывало весь список, а на базе без UNIQUE(account) upsert
// вставлял частичную строку и план пропадал целиком.
async function loadStrategy(account){
  try{return await cityPlans.loadPlans(account);}
  catch(_){return{targets:[],queue:[],reconstructPlan:[]};}
}

// общий (глобальный) план по семействам зданий — не привязан к аккаунту, см. web/routes/cityStrategy.js
async function loadGlobalPlan(){
  try{
    const rows=await GlobalUpgradePlan.findAll();
    const m=new Map();
    for(const r of rows){
      const lvl=Number(r.target_level)||0;
      if(r.family_id&&lvl)m.set(r.family_id,lvl);
    }
    return m;
  }catch(_){return new Map();}
}

// сводит личный план (по клетке) и общий план (по ТОЧНОМУ id здания) в единый список целей по
// клетке — личная цель для клетки всегда важнее общего правила. Общий план матчится по ТОЧНОМУ b.id
// (без нормализации через familyId) — звёздные тиры настраиваются НЕЗАВИСИМО от базового здания и
// друг от друга (см. GlobalUpgradePlan.tsx): правило "Городской банк" применяется, пока здание не
// эволюционировало ни в один тир, "Городской банк ★2" — отдельное правило, включается только когда
// b.id реально сменился на этот тир. Если для конкретного тира правила нет — общий план для него
// просто не действует (никакого наследования между тирами).
function resolveEffectiveTargets(current,personalTargets,globalPlan){
  const personal=new Map(personalTargets.map(t=>[`${Number(t.x)},${Number(t.y)}`,t]));
  const result=[...personalTargets];
  if(!globalPlan.size)return result;
  for(const b of current){
    const key=`${Number(b.x)},${Number(b.y)}`;
    if(personal.has(key))continue; // личная цель для этой клетки уже задана — общий план её не трогает
    const lvl=globalPlan.get(b.id);
    if(lvl)result.push({x:b.x,y:b.y,target_level:lvl});
  }
  return result;
}

// выбор кандидатов на апгрейд: сначала ручная очередь (в порядке очереди — конкретные здания,
// назначенные "улучшить следующими"), затем цели плана (личный + общий, уже сведённые
// resolveEffectiveTargets). Для целей плана — ищем ЗДАНИЕ НА ЭТОЙ КОНКРЕТНОЙ КЛЕТКЕ, ниже целевого
// уровня и не занятое стройкой, сортируем по времени улучшения от меньшего к большему (формула —
// сверена с бандлом getBaseUpgradeDuration, см. cityStats.js upgradeDuration) — короткие апгрейды
// стартуют первыми, чтобы строители быстрее возвращались в оборот; при равном времени — по
// возрастанию текущего уровня здания (сначала ур.3, потом ур.4). Бюджет общий для очереди и плана
// (coins*0.8): если на очередного кандидата не хватает — просто переходим к следующему по списку,
// не прерывая набор. Возвращает {picked,consumedQueueKeys} — consumedQueueKeys нужно вычеркнуть из
// персистентной очереди (она одноразовая, в отличие от плана, который остаётся до достижения цели).
function pickStrategyTargets(current,queue,targets,buildingsMap,discount,policyMult,freeB,coins,now=Date.now()){
  const budget=coins*0.8;
  const result=[],consumedQueueKeys=[];
  // одна и та же клетка не может получить два запуска апгрейда за один проход (после первого она
  // "занята стройкой" только в глазах игры на СЛЕДУЮЩЕЙ загрузке /progress/, а не прямо сейчас в
  // уже прочитанном current) — актуально для очереди: одно и то же здание можно поставить в неё
  // несколько раз подряд (несколько последовательных апгрейдов), но выдать ему нужно СТРОГО по
  // одному апгрейду за заход, остальные его повторы в этом же проходе просто пропускаем.
  const pickedKeys=new Set();
  let left=budget;

  // ОЧЕРЕДЬ — ПРИОРИТЕТ ПО СТРОИТЕЛЯМ, а не исключительный шлюз (правило подтверждено
  // пользователем 04.08): очередь забирает столько свободных строителей, сколько может занять
  // ПРЯМО СЕЙЧАС, а всё, что осталось, уходит в план. Запись, которая уже строится, своего
  // строителя УЖЕ занимает — держать из-за неё второго простаивающим неправильно (был такой
  // промежуточный вариант, откатан: одна запись в очереди строилась, а второй строитель стоял).
  // Если строителей не хватило на всю очередь — план в этом проходе не получит их всё равно,
  // потому что цикл ниже ограничен тем же freeB.
  // Причины пропуска копим, чтобы вызывающий мог их залогировать: жалоба «очередь пропускает

  // здания без причины» разбиралась вслепую именно потому, что все пропуски были молчаливыми.

  const skipped=[];

  for(const q of queue){

    if(result.length>=freeB)break;

    const key=`${Number(q.x)},${Number(q.y)}`;

    if(pickedKeys.has(key))continue; // это же здание уже получило апгрейд в этом проходе — ждём следующего захода

    const b=current.find(c=>Number(c.x)===Number(q.x)&&Number(c.y)===Number(q.y));

    if(!b){skipped.push(`(${q.x},${q.y}) нет здания на клетке`);continue;}

    if(b.end&&new Date(b.end).getTime()>now)continue; // уже строится — свой строитель у него есть, идём дальше

    const lvl=Number(b.level||0);

    const info=buildingsMap.get(b.id);

    if(!info){skipped.push(`(${q.x},${q.y}) ${b.id} нет в каталоге зданий`);continue;}

    const price=Math.round(upgradeStep(info,lvl)*policyMult*(1-discount));

    if(price>left){skipped.push(`(${q.x},${q.y}) ${b.id} ур.${lvl}: цена ${fmt(price)} > остатка бюджета ${fmt(left)}`);continue;}

    result.push({...b,upgrade_price:price});

    consumedQueueKeys.push(key);

    pickedKeys.add(key);

    left-=price;

  }

  const candidates=[];
  for(const t of targets){
    const key=`${Number(t.x)},${Number(t.y)}`;
    if(pickedKeys.has(key))continue; // уже улучшается по очереди в этом же проходе
    const targetLevel=Number(t.target_level)||0;
    if(!targetLevel)continue;
    const b=current.find(c=>Number(c.x)===Number(t.x)&&Number(c.y)===Number(t.y));
    if(!b)continue; // здание снесено/перемещено куда-то ещё — цель тихо недостижима
    if(b.end&&new Date(b.end).getTime()>now)continue;
    const lvl=Number(b.level||0);
    if(lvl>=targetLevel)continue;
    const info=buildingsMap.get(b.id);
    if(!info)continue;
    candidates.push({key,b,info,lvl});
  }
  candidates.sort((x,y)=>upgradeDuration(x.info,x.lvl)-upgradeDuration(y.info,y.lvl)||x.lvl-y.lvl);
  for(const{key,b,info,lvl}of candidates){
    if(result.length>=freeB)break;
    if(pickedKeys.has(key))continue; // несколько personal/global-целей на одну клетку в одном проходе не бывает, но на всякий случай
    const price=Math.round(upgradeStep(info,lvl)*policyMult*(1-discount));
    if(price>left)continue; // не хватает баланса — переходим к следующему по времени кандидату
    result.push({...b,upgrade_price:price});
    pickedKeys.add(key);
    left-=price;
  }
  return{picked:result,consumedQueueKeys,skipped};
}

// прогноз действий бота (страница "Карта города" → вкладка "Прогноз") — ЧИСТАЯ функция, без единого
// API-вызова: дискретно-событийная симуляция, которая на каждом шаге вызывает ТЕ ЖЕ
// resolveEffectiveTargets/pickStrategyTargets, что и реальный runProgress — поэтому показывает
// буквально те решения, которые бот примет (очередь → личный план → общий план, тот же бюджет
// coins*0.8, та же сортировка по времени апгрейда), а не отдельную "похожую" эвристику.
// cityProfitPerHour — накопление монет со временем (computeCityStats(current,buildingsMap).profit
// из web/cityStats.js), иначе прогноз остановился бы на первом же апгрейде, на который прямо сейчас
// не хватает денег. НЕ ограничено фиксированным горизонтом времени (раньше было 3 суток) — считает
// ВСЕ запланированные улучшения (очередь+личный+общий план), пока они не будут исчерпаны либо не
// упрёмся в MAX_ITERATIONS (защита от зависания, а не намеренный лимит). durationMods —
// {reducedUpgradeTimes, constructionTimeMultiplier, booster:{multiplier,endsAt}|null,
//  boosterTimeline:[{fromMs,toMs,multiplier}]|null — вся очередь активации, см. loadBoosterTimeline}, см.
// cityStats.js effectiveUpgradeDuration — те же бонусы, что реально действуют в игре на время стройки.
function simulateFutureActions(current,queue,personalTargets,globalPlan,buildingsMap,discount,policyMult,builders,coins,cityProfitPerHour,durationMods=null){
  // _preBuilt — стройка шла ещё до начала симуляции: её уровень игра уже учла (см. ниже)
  const sim=current.map(b=>({...b,_busyUntil:b.end?new Date(b.end).getTime():0,_preBuilt:!!b.end}));
  let simQueue=queue.map(q=>({...q}));
  let simCoins=coins,simTime=Date.now();
  const events=[];
  const MAX_ITERATIONS=5000;
  let iterations=0;

  while(iterations++<MAX_ITERATIONS){
    // "завершаем" стройки, чьё время уже прошло к этому моменту симуляции — иначе повторные записи
    // в очереди того же здания считались бы с одного и того же устаревшего уровня
      // ВАЖНО: у здания, которое УЖЕ строилось на момент старта прогноза, игра отдаёт УЖЕ НОВЫЙ
      // уровень (постройка помечается end в будущем, а level инкрементируется сразу — на этом же
      // строится обнуление profit «в стройке», см. cityStats). Поэтому такие стройки завершаем
      // БЕЗ повторного +1, иначе прогноз показывал бы «16→17» там, где идёт 15→16, — каждая строка
      // уезжала на уровень вперёд (замечено 13.08).
      for(const b of sim){
        if(!b._busyUntil||b._busyUntil>simTime)continue;
        if(!b._preBuilt)b.level=(Number(b.level)||0)+1;
        b._busyUntil=0;b._preBuilt=false;
      }
    const busyCount=sim.filter(b=>b._busyUntil>simTime).length;
    const free=builders-busyCount;
    if(free<=0){
      const busyUntils=sim.filter(b=>b._busyUntil>simTime).map(b=>b._busyUntil);
      if(!busyUntils.length)break; // строителей нет вообще — дальше нечего прогнозировать
      simTime=Math.min(...busyUntils);
      continue;
    }
    // представление current для pickStrategyTargets/resolveEffectiveTargets — b.end как ISO-строка,
    // ровно как приходит с живого /progress/, чтобы код не пришлось дублировать под "плоские числа"
    const currentView=sim.map(b=>({...b,end:b._busyUntil>simTime?new Date(b._busyUntil).toISOString():null}));
    const effectiveTargets=resolveEffectiveTargets(currentView,personalTargets,globalPlan);
    const{picked,consumedQueueKeys}=pickStrategyTargets(currentView,simQueue,effectiveTargets,buildingsMap,discount,policyMult,free,simCoins,simTime);
    if(consumedQueueKeys.length){
      const toRemove=[...consumedQueueKeys];
      simQueue=simQueue.filter(q=>{
        const key=`${Number(q.x)},${Number(q.y)}`;
        const idx=toRemove.indexOf(key);
        if(idx===-1)return true;
        toRemove.splice(idx,1);
        return false;
      });
    }
    if(!picked.length){
      // нечего запускать прямо сейчас — если дело в деньгах (а не в отсутствии целей вообще),
      // прокручиваем время вперёд с накоплением прибыли и пробуем снова
      if(cityProfitPerHour>0){simTime+=3600000;simCoins+=cityProfitPerHour;continue;}
      break; // денег больше не будет и целей нет — дальше нечего прогнозировать
    }
    for(const b of picked){
      const info=buildingsMap.get(b.id);
      const lvl=Number(b.level||0);
      const durationMs=info?Math.round(effectiveUpgradeDuration(info,lvl,durationMods,simTime)*1000):0;
      // множитель окна, действующего на МОМЕНТ СТАРТА этого апгрейда — чтобы в панели было видно,
      // под каким ускорителем посчитана строка, и расхождение с игрой сразу локализовалось
      const win=(durationMods?.boosterTimeline||[]).find(w=>w.fromMs<=simTime&&w.toMs>simTime);
      const boostMult=win?win.multiplier:(durationMods?.booster?.endsAt>simTime?durationMods.booster.multiplier:null);
      const idx=sim.findIndex(s=>Number(s.x)===Number(b.x)&&Number(s.y)===Number(b.y));
      if(idx===-1)continue;
      sim[idx]._busyUntil=simTime+durationMs;
      simCoins-=b.upgrade_price||0;
      events.push({x:b.x,y:b.y,building_id:b.id,level_from:lvl,level_to:lvl+1,start:simTime,end:simTime+durationMs,duration_ms:durationMs,boost_multiplier:boostMult??null,boost_name:win?.name??null});
    }
  }
  return events.sort((a,b)=>a.start-b.start);
}

async function runProgressAction(name,label,work){
  try{
    await globalLock.run(work);
    return true;
  }catch(e){
    logger.error(`[${name}] [progress] ${label} failed: ${describeError(e)}`);
    return false;
  }
}

// запланированные реконструкции (вкладка "Реконструкция" → "Запланировать", таблица
// city_reconstruct_plan) — не привязаны к строителям (реконструкция не занимает строителя,
// это мгновенный сброс уровня, не стройка), поэтому проверяются НЕЗАВИСИМО от builders/targets:
// как только здание на этой клетке достигнет required_lvl и не будет занято текущей стройкой,
// сразу шлём [{type:'reconstruct',id,x,y}] и вычёркиваем запись (одноразовая, как и очередь
// улучшений). Если условие ещё не выполнено — запись просто остаётся ждать следующего вызова.
async function runPendingReconstructions(api,name,current,buildingsMap){
  let plan;
  try{plan=(await cityPlans.loadPlans(name)).reconstructPlan;}catch(_){return false;}
  if(!plan.length)return false;
  const now=Date.now();
  const done=[];          // выполнено или стало недостижимо — вычёркиваем ТОЧЕЧНО, по своей строке
  let changed=false;
  for(const p of plan){
    const b=current.find(c=>Number(c.x)===Number(p.x)&&Number(c.y)===Number(p.y));
    if(!b){done.push(p);continue;} // здание снесено/перемещено куда-то ещё — план на него недостижим
    const info=buildingsMap.get(b.id);
    if(!info||!info.is_reconstructible||info.required_lvl==null){done.push(p);continue;} // больше не реконструируемо (напр. эволюционировало)
    const busy=b.end&&new Date(b.end).getTime()>now;
    if(busy||Number(b.level||0)<info.required_lvl)continue; // ещё не готово — строка просто остаётся ждать
    const ok=await runProgressAction(name,`reconstruct ${b.id} at (${b.x},${b.y})`,async()=>{
      await sleep(1000);
      await api.post('/progress/',[{type:'reconstruct',id:b.id,x:b.x,y:b.y}]);
      logger.info(`[${name}] [progress] reconstruct ${b.id} at (${b.x},${b.y}) — план выполнен`);
    });
    if(ok){
      changed=true;
      done.push(p);
      await logAction(name,'reconstruct',{x:b.x,y:b.y,building_id:b.id,level_from:Number(b.level||0)});
    }
    // не получилось (напр. не хватило components) — строку не трогаем, попробуем в следующий заход
  }
  if(done.length){
    // удаляем ровно свои клетки: то, что пользователь добавил в план прямо во время прохода,
    // остаётся нетронутым (раньше здесь переписывался весь список и такие правки терялись)
    try{await cityPlans.removeReconstruct(name,done);}
    catch(e){logger.warn(`[${name}] [progress] не удалось обновить план реконструкций: ${e.message}`);}
  }
  return changed;
}

async function runProgress(api,name,opts={}){
  // Цены берём из локального каталога (config/buildings-live.json). 13.10.2026: кнопки «Обновить»
  // для него в панели НЕТ (бэкенд-ручка /api/refresh/buildings есть, фронт её никогда не вызывал) —
  // поэтому каталог висел на снимке от 27.09 три недели: событийная скидка в нём могла не совпадать
  // с текущими ценами игры, бот считал апгрейд доступным по старым цифрам, а игра на реальной
  // (другой) цене отказывала в сохранении generic-ошибкой «Не удалось сохранить данные прогресса»
  // (отличить от «не хватает строителей/бюджета» по сообщению нельзя — игра не детализирует причину).
  // ensureFresh (а не ensureExists) сам переспрашивает /buildings/ раз в TTL_MS (6ч, см.
  // buildingCatalog.js) без всякой кнопки — именно это и было задумано комментарием там же
  // («Устаревшее авто-обновление по TTL... нигде не вызывается»), просто никогда не включено.
  await require('../utils/buildingCatalog').ensureFresh(api).catch(()=>{});
  const{upgrading=true}=opts;
  if(isCityPaused()){logger.info(`[${name}] [progress] прокачка на паузе — пропускаю`);return;}
  try{
    const buildingsMap=cityBuildingsMap();
    const[{discount,additionalBuilder},{builderBonus:policyBuilderBonus,upgradeCostMultiplier}]=await Promise.all([loadGuildBonuses(api),loadPolicyEffects(api)]);
    const builderBonus=additionalBuilder+policyBuilderBonus;
    let prog;
    try{
      prog=await withRetry(()=>api.get('/progress/'),2,1500,`${name} progress load`);
    }catch(e){
      // ВАЖНО: не «нечего улучшать», а СБОЙ. Раньше здесь был голый return, и вызывающий
      // cityUpgradeLoop честно считал, что целей нет, после чего засыпал ДО ШЕСТИ ЧАСОВ. Один
      // отвалившийся WS в 03:42 UTC 21.08 стоил трёх часов простоя посреди ивента: цикл ожил
      // только когда пользователь нажал «Сохранить» и разбудил его вручную.
      logger.error(`[${name}] [progress] load failed: ${describeError(e)}`);
      const err=new Error(`не удалось загрузить /progress/: ${e.message}`);
      err.transient=true;      // цикл повторит через минуту, а не уснёт на 6 часов
      throw err;
    }
    const data=prog?.progress?.data||{},coins=data.coins||0,builders=(prog?.progress?.builders||1)+builderBonus;
    let current=Array.isArray(data.buildings)?data.buildings:[];
    try{await CitySnapshot.upsert(citySnapshotPayload(name,current,prog),{conflictFields:['account']});}catch(e){logger.warn(`[${name}] [progress] снимок города не сохранён: ${e.message}`);}
    cityLive.broadcast(name,current);
    const busy=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now()).length;
    logger.info(`[${name}] [progress] coins: ${fmt(coins)} | builders: ${builders-busy}/${builders}${builderBonus?` (+${builderBonus} бонус)`:''} | buildings: ${current.length} | discount: ${Math.round(discount*100)}%`);

    // Путь мэра — синхронизирован с этим же живым /progress/ (никакого отдельного запроса к игре,
    // см. modules/journey.js): проверяем на каждом свежем ответе, в т.ч. если ниже дальше цикл
    // выйдет рано (нет целей улучшений) — профит всё равно мог измениться с прошлого раза.
    if(require('../config').getConfig().features.journey){
      try{await require('./journey').runJourney(api,name,extractCurrentProfit(prog));}catch(e){logger.warn(`[${name}] [progress] journey check: ${e.message}`);}
    }

    // запланированные реконструкции не занимают строителя (не стройка, а мгновенный сброс) —
    // проверяются НЕЗАВИСИМО от builders/targets, поэтому делаем это до всех ранних return ниже
    if(await runPendingReconstructions(api,name,current,buildingsMap)){
      try{await CitySnapshot.upsert(citySnapshotPayload(name,current,prog),{conflictFields:['account']});}catch(e){logger.warn(`[${name}] [progress] снимок города не сохранён: ${e.message}`);}
      cityLive.broadcast(name,current);
    }

    let{targets:personalTargets,queue:initialQueue}=await loadStrategy(name);
    let globalPlan=await loadGlobalPlan();
    if(!personalTargets.length&&!initialQueue.length&&!globalPlan.size){
      logger.info(`[${name}] [progress] нет настроенных целей улучшений — простой`);
      return;
    }
    if(!upgrading||builders<=0)return;
    let queue=initialQueue.slice();
    // Вычёркиваем ровно потреблённые записи ИЗ ТЕКУЩЕГО значения в БД, а не переписываем колонку
    // своей копией: пользователь мог добавить в очередь новые клетки прямо во время прохода, и
    // запись целиком затёрла бы их.
    // Вычёркиваем ровно потреблённые клетки СВОИМИ строками, а не переписываем список: пользователь
    // мог добавить в очередь новые клетки прямо во время прохода, и перезапись затёрла бы их.
    const persistQueue=async(consumed)=>{
      try{
        const cells=consumed.map(k=>{const[x,y]=String(k).split(',');return{x:Number(x),y:Number(y)};});
        await cityPlans.removeQueue(name,cells);
        queue=(await cityPlans.loadPlans(name)).queue;
      }catch(e){logger.warn(`[${name}] [progress] не удалось сохранить очередь: ${e.message}`);}
    };

    const refreshState=async()=>{
      const latest=await withRetry(()=>api.get('/progress/'),2,1500,`${name} progress refresh`);
      const latestData=latest?.progress?.data||{};
      current=Array.isArray(latestData.buildings)?latestData.buildings:[];
      // раньше CitySnapshot писался только ОДИН раз в начале цикла (см. выше) — пока бот улучшает
      // здания несколько итераций подряд (ждёт строителей, запускает следующее и т.д.), веб-панель
      // (таблица городов, карта города) весь этот период показывала устаревший снимок из начала
      // цикла, не видя уже запущенные апгрейды. Пишем свежий снимок при каждом обновлении состояния,
      // а не только при первой загрузке.
      try{await CitySnapshot.upsert(citySnapshotPayload(name,current,latest),{conflictFields:['account']});}catch(e){logger.warn(`[${name}] [progress] снимок города не сохранён: ${e.message}`);}
      cityLive.broadcast(name,current);
      // тот же живой ответ — тут профит мог измениться относительно прошлого refreshState (именно
      // здесь цикл узнаёт о завершившемся апгрейде), см. комментарий у первого вызова выше
      if(require('../config').getConfig().features.journey){
        try{await require('./journey').runJourney(api,name,extractCurrentProfit(latest));}catch(e){logger.warn(`[${name}] [progress] journey check: ${e.message}`);}
      }
      return{coins:latestData.coins||0,builders:(latest?.progress?.builders||(builders-builderBonus))+builderBonus};
    };

    while(true){
      if(isCityPaused()){logger.info(`[${name}] [progress] прокачка на паузе — выхожу из цикла`);break;}
      // ПЕРЕЧИТЫВАЕМ стратегию КАЖДЫЙ проход. Цикл живёт часами: он ждёт освобождения строителя
      // внутри waitOrWake (в логах бывает «builders busy, waiting 17504s»), а очередь/цели
      // загружались ОДИН раз перед while — всё, что пользователь добавлял в ручную очередь за это
      // время, цикл просто не видел и продолжал работать по плану. Сохранение через панель будит
      // цикл (cityWake), но будить его без перечитывания было бессмысленно: он просыпался со
      // старым списком в памяти. Отсюда жалоба «ручная очередь игнорируется».
      try{
        const fresh=await loadStrategy(name);
        personalTargets=fresh.targets;
        queue=fresh.queue;
        globalPlan=await loadGlobalPlan();
      }catch(e){logger.warn(`[${name}] [progress] не удалось перечитать стратегию: ${e.message}`);}
      const state=await refreshState();
      await runPendingReconstructions(api,name,current,buildingsMap); // здание могло дойти до required_lvl прямо во время этого цикла апгрейдов
      const busyNow=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now()).length;
      const free=Math.max(0,state.builders-busyNow);
      if(free<=0){
        const nextEnd=current
          .filter(b=>b.end&&new Date(b.end).getTime()>Date.now())
          .map(b=>new Date(b.end).getTime())
          .sort((a,b)=>a-b)[0];
        const waitMs=nextEnd?Math.max(5000,nextEnd-Date.now()+2000):30000;
        logger.info(`[${name}] [progress] builders busy, waiting ${Math.ceil(waitMs/1000)}s`);
        // waitOrWake, а не голый sleep — активация ускорителя (modules/boosterAutomation.js)
        // сокращает уже идущие стройки и после этого зовёт cityWake.wake(name); без waitOrWake
        // этот sleep досиживал бы до СТАРОГО (посчитанного ДО ускорения) времени окончания,
        // хотя стройки уже могли закончиться раньше — апгрейды запускались бы с большой
        // задержкой вместо того, чтобы продолжить сразу же, как только освободился строитель.
        await waitOrWake(name,waitMs);
        continue;
      }
      const effectiveTargets=resolveEffectiveTargets(current,personalTargets,globalPlan);
      const{picked,consumedQueueKeys,skipped}=pickStrategyTargets(current,queue,effectiveTargets,buildingsMap,discount,upgradeCostMultiplier,free,state.coins);

      // почему очередь пропустила записи — видно в логе, а не только в поведении

      if(skipped&&skipped.length)logger.info(`[${name}] [progress] очередь пропустила: ${skipped.join('; ')}`);
      // ВАЖНО: одно и то же здание может стоять в очереди НЕСКОЛЬКО раз подряд (несколько
      // последовательных апгрейдов) — consumedQueueKeys содержит ключ клетки РОВНО столько раз,
      // сколько её реально запустили в этом проходе (обычно 1); persistQueue убирает строго по
      // ОДНОЙ записи на каждый потреблённый ключ, а не все записи с таким ключом разом.
      if(consumedQueueKeys.length)await persistQueue(consumedQueueKeys);
      if(!picked.length){
        const stillBusy=current.filter(b=>b.end&&new Date(b.end).getTime()>Date.now());
        if(stillBusy.length){
          const nextEnd=Math.min(...stillBusy.map(b=>new Date(b.end).getTime()));
          const waitMs=Math.max(5000,nextEnd-Date.now()+2000);
          logger.info(`[${name}] [progress] нет доступных апгрейдов по целям, жду ${Math.ceil(waitMs/1000)}s строителя`);
          // тот же приём, что и выше — активация ускорителя может сократить это ожидание
          await waitOrWake(name,waitMs);
          continue;
        }
        logger.info(`[${name}] [progress] цели сейчас недостижимы (нет зданий/не хватает денег) — завершаю цикл`);
        break;
      }
      // Запускаем ВСЮ пачку подряд, по одному тяжёлому обновлению состояния НА ПАЧКУ, а не на
      // каждый апгрейд. Раньше после каждого запуска шёл полный refreshState() (GET /progress/ +
      // broadcast + проверка «Пути мэра»), и пачка из N свободных строителей растягивалась на N
      // тяжёлых кругов — строители простаивали по несколько минут, хотя работа для них была.
      // Промежуточный refresh не нужен для корректности: pickStrategyTargets уже набирает пачку
      // под НАКОПИТЕЛЬНЫЙ бюджет (left) и не больше числа свободных строителей, т.е. деньги на всю
      // пачку заведомо посчитаны заранее. Пауза между POST-ами оставлена — она держит темп в рамках
      // лимита запросов игры, из-за которого нельзя слать апгрейды вплотную.
      let launched=0;
      // строки лога этой пачки — после обновления состояния проставим им РЕАЛЬНУЮ длительность
      const pending=[];
      logger.info(`[${name}] [progress] запускаю пачку: ${picked.length} апгрейд(ов) на ${free} свободных строителей`);
      for(const b of picked){
        const nextLvl=(Number(b.level)||1)+1;
        const ok=await runProgressAction(name,`upgrade ${b.id} at (${b.x},${b.y}) to lvl ${nextLvl}`,async()=>{
          await sleep(500);
          const r=await api.post('/progress/',[{type:'upgrade',id:b.id,x:b.x,y:b.y}]);
          if(r?.coins!==undefined)logger.info(`[${name}] [progress] upgraded ${b.id} | LVL ${b.level} -> ${nextLvl}`);
        });
        if(ok){
          launched++;
          const info=buildingsMap.get(b.id);
          // ПРЕДВАРИТЕЛЬНАЯ длительность — голая формула без гильдии/политик/ускорителей, поэтому
          // в логе появлялись «12ч 0м» там, где по факту стройка шла 1ч40м. Пишем её только как
          // заглушку, а ниже (после refreshState) заменяем на честную: end, который отдала игра,
          // минус момент запуска. Игра — единственный источник, который знает про все модификаторы,
          // включая серверные ивентовые (клиентская формула их не видит, см. cityStats).
          const row=await logAction(name,'upgrade',{x:b.x,y:b.y,building_id:b.id,level_from:Number(b.level||0),level_to:nextLvl,duration_ms:info?Math.round(upgradeDuration(info,Number(b.level||0))*1000):null});
          if(row)pending.push({row,x:Number(b.x),y:Number(b.y),startedAt:Date.now()});
        }
      }
      // одно обновление после всей пачки — дальше while сам пересчитает свободных строителей и,
      // если они ещё есть и цели остались, сразу запустит следующую пачку без ожидания
      if(launched){
        try{
          await refreshState();
          // фактическая длительность: сколько игра реально отвела на стройку этой клетки
          for(const p of pending){
            const b=current.find(c=>Number(c.x)===p.x&&Number(c.y)===p.y);
            const endMs=b?.end?new Date(b.end).getTime():0;
            if(endMs>p.startedAt)await updateAction(p.row,{duration_ms:endMs-p.startedAt});
          }
        }catch(e){logger.error(`[${name}] [progress] refresh failed after batch: ${describeError(e)}`);}
      }
      if(!launched){
        logger.info(`[${name}] [progress] апгрейды не запустились, жду 30s`);
        await sleep(30000);
      }
    }
  }catch(e){logger.error(`[${name}] [progress] ${describeError(e)}`);}
}
module.exports={
  runProgress,
  // экспортировано для web/routes/cityStrategy.js (прогноз) — переиспользуют ту же логику, что
  // реальный цикл, вместо дублирования
  loadStrategy,loadGlobalPlan,loadGuildBonuses,loadPolicyEffects,loadConstructionBoostMods,loadBoosterTimeline,measureActualVsPredicted,
  resolveEffectiveTargets,pickStrategyTargets,simulateFutureActions,
};
