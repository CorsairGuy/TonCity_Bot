'use strict';
// Общие для modules/capital.js и modules/capitalProgress.js хелперы столицы — вынесены в
// отдельный файл, чтобы избежать циклического require между этими двумя модулями.
const fs=require('fs'),path=require('path');

function loadCapBuildingsMap(){
  try{
    const fp=path.join(process.cwd(),'config','capital_buildings.txt');
    if(fs.existsSync(fp)){
      const list=JSON.parse(fs.readFileSync(fp,'utf8'));
      return new Map(list.map(b=>[b.id,b]));
    }
  }catch(_){}
  return new Map();
}

// уровень штабквартиры (hall) — от него зависят lvl-ограничения остальных зданий (getMaxAllowedLevel)
function capHallLevel(current,capMap){
  const now=Date.now();
  const hallBuilding=current.find(b=>{const info=capMap.get(b.id);return info?.type==='hall';});
  const hallIsUpgrading=hallBuilding&&hallBuilding.end&&new Date(hallBuilding.end).getTime()>now;
  return hallBuilding?Math.max(0,Number(hallBuilding.level||0)-(hallIsUpgrading?1:0)):0;
}

function getMaxAllowedLevel(capInfo,hallLevel){
  if(capInfo.levels_per_hall_lvl===null||capInfo.levels_per_hall_lvl===undefined)return 99;
  const r=capInfo.hall_lvl_required??1;
  return Math.max(0,(hallLevel+1-r)*capInfo.levels_per_hall_lvl);
}

// формулы цены — реверс подтверждён (были в modules/capital.js runCapBuildings до переноса сюда):
// CAP_COM_* здания считаются экспоненциально от уровня, остальные — итеративным произведением rate/k.
function capUpgradePrice(buildingId,info,lvl,econStrength){
  if(buildingId.startsWith('CAP_COM_'))return Math.round(info.base_price*Math.exp(0.5*lvl)*econStrength);
  let p=info.base_price;
  for(let k=1;k<lvl;k++)p*=(info.rate||1)/k;
  return Math.round(p*econStrength);
}

function capBuyPrice(info,count,econStrength){
  return Math.round(info.base_price*Math.pow(info.coefficient??1,count)*econStrength);
}

// ДЛИТЕЛЬНОСТЬ апгрейда столицы — подтверждено реверсом бандла (класс qp.getUpgradeDuration):
// коммерческие здания (type==="commercial", т.е. CAP_COM_*) растут ЭКСПОНЕНЦИАЛЬНО от
// base_construction_duration с потолком 2 суток (172800с); все остальные (hall/beneficial) —
// ЛИНЕЙНО (base_construction_duration + construction_increment·(lvl-2)) с потолком 7 суток
// (604800с). ЭТО ДРУГИЕ формула/потолок, чем у городских зданий (там экспонента от
// construction_increment с потолком 24ч, см. web/cityStats.js upgradeDuration) — раньше здесь была
// грубая линейная оценка без потолка вообще, что давало заниженное время на поздних уровнях
// (напр. показывало ~15ч вместо реальных 40+ч). Важно: в отличие от города, у столицы НЕТ бонусов
// гильдии/политик/ускорителей на время стройки — qp.getUpgradeDuration в бандле их не применяет
// вообще, только эта чистая формула.
const CAP_UPGRADE_TIME_CAP_COMMERCIAL_SEC=2*24*3600;
const CAP_UPGRADE_TIME_CAP_OTHER_SEC=7*24*3600;
function capUpgradeDurationEstimate(info,lvl){
  const base=info.base_construction_duration||0;
  if(info.type==='commercial'){
    if(!base)return 0;
    const capLevel=Math.floor(Math.log2(CAP_UPGRADE_TIME_CAP_COMMERCIAL_SEC/base))+2;
    return lvl>capLevel?CAP_UPGRADE_TIME_CAP_COMMERCIAL_SEC:base*Math.pow(2,lvl-2);
  }
  const inc=info.construction_increment||0;
  if(!inc)return base;
  const capLevel=Math.floor((CAP_UPGRADE_TIME_CAP_OTHER_SEC-base)/inc)+2;
  return lvl>capLevel?CAP_UPGRADE_TIME_CAP_OTHER_SEC:base+inc*(lvl-2);
}

// подмешивает is_upgradable в живые постройки (сырые данные игры не несут этого поля вообще) —
// нужно фронту, чтобы решить, рисовать ли бейдж уровня/подсветку на тайле (CityActionsCanvas.tsx
// badgeFor: !is_upgradable → бейдж не рисуется, как у спецзданий города). БЕЗ этого подмешивания
// бейджи пропадали на карте столицы при каждом живом обновлении (SSE) — REST-эндпоинт
// /api/capital-snapshots (web/routes/plans.js) энричил постройки сам, а вот capitalLive.broadcast
// рассылал сырые данные как есть, и следующее же SSE-сообщение перезатирало энриченный снимок.
function enrichCapitalBuildings(buildings,buildingsMap){
  return buildings.map(b=>{
    const meta=buildingsMap.get(b.id);
    return{...b,is_upgradable:meta?meta.is_upgradable===true:false};
  });
}

module.exports={loadCapBuildingsMap,capHallLevel,getMaxAllowedLevel,capUpgradePrice,capBuyPrice,capUpgradeDurationEstimate,enrichCapitalBuildings};
