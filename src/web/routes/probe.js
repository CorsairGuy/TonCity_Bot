'use strict';
// Проверка живых ответов игры после обновления 2.5 — ТОЛЬКО GET и ТОЛЬКО внутри работающего бота
// (тот же ApiClient: подпись, WS, предохранитель техработ, apiLock, авто-refresh). Отдельным
// скриптом это не делаем: второй процесс к боевой базе ротирует refresh_token и роняет аккаунты.
// Сырые ответы — в config/probe-live.json (в git не попадает), на страницу — только форма ответа.
// Заодно сверяет живой каталог /buildings/ со статичным config/buildings.txt: каких зданий нет в
// резервном каталоге — их полные параметры из ответа игры можно скачать готовым buildings.txt.
const fs=require('fs'),path=require('path');
const logger=require('../../utils/logger');

const OUT=path.join(process.cwd(),'config','probe-live.json');
const STATIC=path.join(process.cwd(),'config','buildings.txt');
const errText=e=>{const d=e?.response?.data;const m=d&&(d.detail||d.error||d.message);return m?(typeof m==='string'?m:JSON.stringify(m)):(e?.message||String(e));};

// форма ответа: ключи до глубины 2, у массивов — длина и форма первого элемента
function shape(v,depth=0){
  if(Array.isArray(v))return v.length?[`×${v.length}`,depth<2?shape(v[0],depth+1):'…']:['×0'];
  if(v&&typeof v==='object'){
    if(depth>=2)return`{${Object.keys(v).length} ключей}`;
    const o={};for(const k of Object.keys(v).slice(0,40))o[k]=shape(v[k],depth+1);return o;
  }
  return v===null?'null':typeof v;
}
const listOf=raw=>Array.isArray(raw)?raw:(Array.isArray(raw?.buildings)?raw.buildings:null);
function readStatic(){try{return JSON.parse(fs.readFileSync(STATIC,'utf8'));}catch(_){return null;}}
function readOut(){try{return JSON.parse(fs.readFileSync(OUT,'utf8'));}catch(_){return null;}}

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;
  const db=()=>require('../../db/index');
  let running=false;

  async function pickAccounts(){
    const {isRefreshDead}=require('../../modules/session');
    const accs=(await db().Account.findAll())
      .filter(a=>a.access_token&&a.access_token!=='placeholder'&&!isRefreshDead(a.id));
    const has=(a,k)=>String(a.special_buildings||'').split(',').includes(k);
    return{main:accs[0]||null,market:accs.find(a=>has(a,'market'))||null,all:accs};
  }

  app.post('/api/diag/probe',async(req,res)=>{
    if(running)return res.status(409).json({ok:false,error:'Проверка уже идёт'});
    running=true;
    const results=[],raw={};
    const call=async(acc,label,p,params)=>{
      if(!acc){results.push({label,account:null,ok:false,error:'нет подходящего аккаунта'});return null;}
      try{
        const d=await apiForAcc(acc).get(p,params);
        raw[label]=d;results.push({label,account:acc.name,ok:true,shape:shape(d)});return d;
      }catch(e){results.push({label,account:acc.name,ok:false,status:e?.response?.status??e.status??null,error:errText(e)});return null;}
    };
    try{
      const{main,market,all}=await pickAccounts();
      if(!main)return res.status(400).json({ok:false,error:'Нет аккаунтов с живым токеном'});
      await call(main,'GET /progress/','/progress/');
      const catalog=await call(main,'GET /buildings/','/buildings/');
      await call(main,'GET /capitals/buildings/','/capitals/buildings/');
      await call(main,'GET /progress/diversity','/progress/diversity');
      await call(main,'GET /policies/','/policies/');
      await call(main,'GET /championships/overview','/championships/overview');
      await call(main,'GET /tech-factory/overview','/tech-factory/overview');
      // гильдия: первый аккаунт, который в ней состоит (взносы и чат — по id гильдии)
      let guildAcc=null,gid=null;
      for(const a of all.slice(0,5)){
        try{const m=await apiForAcc(a).get('/users/me/guild');if(m?.guild?.id){guildAcc=a;gid=m.guild.id;raw['GET /users/me/guild']=m;break;}}catch(_){}
      }
      if(gid){
        await call(guildAcc,'GET /guilds/{id}/fees',`/guilds/${gid}/fees`);
        await call(guildAcc,'GET /guilds/{id}/chat/messages',`/guilds/${gid}/chat/messages`);
      }else results.push({label:'гильдия',account:null,ok:false,error:'среди первых 5 аккаунтов нет состоящих в гильдии'});
      await call(market,'GET /market/user/negotiation-offers','/market/user/negotiation-offers');
      await call(market,'GET /market/user/listing-rules','/market/user/listing-rules');
      // сверка с резервным каталогом
      const live=listOf(catalog),stat=readStatic();
      let missing=null;
      if(live&&Array.isArray(stat)){const ids=new Set(stat.map(b=>b.id));missing=live.filter(b=>b&&b.id&&!ids.has(b.id)).map(b=>b.id);}
      const out={at:new Date().toISOString(),results,missing_buildings:missing,raw};
      fs.writeFileSync(OUT,JSON.stringify(out,null,1),'utf8');
      logger.info(`[probe] проверка ответов игры: ${results.filter(r=>r.ok).length}/${results.length} успешно${missing?`, нет в резервном каталоге: ${missing.length}`:''}`);
      res.json({ok:true,at:out.at,results,missing_buildings:missing});
    }catch(e){res.status(500).json({ok:false,error:errText(e)});}
    finally{running=false;}
  });

  // последний результат без похода в игру
  app.get('/api/diag/probe',(req,res)=>{
    const d=readOut();
    if(!d)return res.json({ok:true,at:null,results:[],missing_buildings:null});
    res.json({ok:true,at:d.at,results:d.results,missing_buildings:d.missing_buildings});
  });

  // резервный каталог с добавленными зданиями из последней проверки: существующие записи не
  // меняются (цены в живом каталоге бывают со скидкой события), дописываются только новые id
  app.get('/api/diag/probe/buildings.txt',(req,res)=>{
    const d=readOut(),stat=readStatic(),live=listOf(d?.raw?.['GET /buildings/']);
    if(!live||!Array.isArray(stat))return res.status(404).json({ok:false,error:'Сначала запустите проверку'});
    const ids=new Set(stat.map(b=>b.id));
    const merged=stat.concat(live.filter(b=>b&&b.id&&!ids.has(b.id)));
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="buildings.txt"');
    res.send(JSON.stringify(merged,null,2));
  });
};
