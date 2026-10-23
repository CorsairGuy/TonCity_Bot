'use strict';
require('dotenv').config();
const fs=require('fs'),path=require('path');

const SETTINGS_PATH=path.join(process.cwd(),'config','settings.json');

const DEFAULTS={
  features:{dailyLogin:true,fortune:true,journey:true,builders:true,inventory:true,policies:true,satoshi:true,
    upgrading:true,buying:true,capital:true,staking:false,wordle:false,market:false,
    // мониторинг цен Центрального рынка (проверка курсов + пост в Telegram, modules/marketPrices.js)
    // — отдельный флаг от "market" выше (тот нигде не читается, легаси), включён по умолчанию,
    // т.к. цикл и так уже был безусловно запущен всегда — переключатель добавлен на странице Настроек
    marketMonitoring:true,
    // автосбор городского розыгрыша (modules/civicDrawAuto.js), переключатель — на странице розыгрыша
    civicDraw:true,
    // запись партий 2048 в logs/2048/ для анализа алгоритма (utils/game2048Recorder.js), переключатель —
    // на странице 2048; нужна на время отладки алгоритма, поэтому по умолчанию выключена
    game2048Record:false},
  // автовыполнение гильдейских квестов (страница "Квесты" → значок настроек) — КВЕСТ-ОСОЗНАННОЕ:
  // каждое действие сначала смотрит, есть ли у аккаунта живой незавершённый квест нужного типа
  // (см. modules/questAutomation.js QUEST_TYPE_MAP), и только тогда выполняется — реклама/стейкинг
  // больше не гоняются вслепую каждый день, если под них нет реального квеста. boosters — активация
  // ускорителя нужной редкости под квест типа booster_activate (новое, раньше не было вообще).
  questAutomation:{ads:false,sudoku:false,minesweeper:false,quiz:false,staking:false,boosters:false},
  // ui — мелкие пользовательские настройки веб-панели, хранятся на сервере, а не только в
  // localStorage браузера: у iOS Safari для PWA (добавлено на главный экран) localStorage может
  // очищаться после ~недели простоя (ITP), см. App.tsx SidebarNav. navOpenGroups — какие группы
  // бокового меню развёрнуты. mapDayNight — время суток на карте города: auto (по часам устройства),
  // day, night.
  ui:{navOpenGroups:[],mapDayNight:'auto'},
  // обновления бота (Настройки → Обновления, utils/autoUpdate.js). Сам канал (тег образа) живёт в
  // BOT_TAG в .env — его меняет обновлятель; здесь только «ставить новое само» для плавающих каналов
  // (ветка, stable). Закреплённая версия не обновляется никогда.
  update:{auto:true},
  logLevel:'info',
  growthModePopulation:2500000,
  staking:{amount:0,currency:'coins',duration:30},sellItems:[],promoCodes:[],
  // botToken — общий токен бота (задаётся в веб-панели, "Настройки"), используется всеми тремя
  // видами уведомлений ниже, если для конкретного вида не указан свой отдельный токен
  // (wordleBot/marketBot — legacy override, оставлены для обратной совместимости).
  telegram:{botToken:'',
    maintenanceChatId:'',maintenanceThreadId:'',
    marketBot:'',marketChatId:'',marketThreadId:'',
    wordleBot:'',wordleChatId:'',wordleThreadId:''},
};

function loadSettings(){
  try{
    if(fs.existsSync(SETTINGS_PATH))return JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf8'));
  }catch(_){}
  return {};
}

function saveSettings(data){
  fs.writeFileSync(SETTINGS_PATH,JSON.stringify(data,null,2),'utf8');
}

function mergeDeep(def,over){
  const out={...def};
  for(const k of Object.keys(over||{})){
    if(over[k]!==null&&typeof over[k]==='object'&&!Array.isArray(over[k])&&typeof def[k]==='object')
      out[k]=mergeDeep(def[k],over[k]);
    else if(over[k]!==undefined)out[k]=over[k];
  }
  return out;
}

function getConfig(){
  const s=mergeDeep(DEFAULTS,loadSettings());
  const st=s.staking||{};
  const stakingConfig=st.amount>0?`${st.amount} ${st.currency} ${st.duration}`:'';
  const sellItems=Array.isArray(s.sellItems)?s.sellItems.map(i=>`${i.name}:${i.price}:${i.qty||1}`).join(','):'';
  return{
    db:{host:process.env.DB_HOST||'localhost',port:parseInt(process.env.DB_PORT||process.env.DB_EXPOSED_PORT||'3306'),
        user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'root',name:process.env.DB_NAME||'db_main'},
    webPort:parseInt(process.env.WEB_PORT||'3000'),
    logLevel:s.logLevel,
    growthModePopulation:s.growthModePopulation??2500000,
    features:s.features,
    questAutomation:s.questAutomation,
      stakingConfig,sellItems,
    promoCodes:Array.isArray(s.promoCodes)?s.promoCodes.filter(Boolean):[],
    tgBotToken:process.env.TG_BOT_TOKEN||'',
    telegram:s.telegram||{},
    baseUrl:'https://game.toncity.io/api',
  };
}

module.exports=getConfig();
module.exports.getConfig=getConfig;
module.exports.saveSettings=saveSettings;
module.exports.loadSettings=loadSettings;
module.exports.DEFAULTS=DEFAULTS;
module.exports.mergeDeep=mergeDeep;
