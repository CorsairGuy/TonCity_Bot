'use strict';
const logger=require('../../utils/logger');

// Переговорные предложения рынка (2.5, chunks/market_profile-*.js и market_utils-*.js, сборка 14184):
// GET /market/user/negotiation-offers → {received:[...],sent:[...]}; входящее принять/отклонить —
// POST /market/negotiation/accept|reject {offer_id}, своё отозвать — POST /market/negotiation/offer/cancel
// {offer_id} (не раньше revocable_at). Страница читает последний ответ из game_extra_cache (kind
// 'negotiation-offers'), в игру ходит только «Обновить» и действия; действия не повторяются.
const KIND='negotiation-offers';
const errText=e=>{const d=e?.response?.data;const m=d&&(d.detail||d.error||d.message);return m?(typeof m==='string'?m:JSON.stringify(m)):(e?.message||String(e));};
const num=v=>{const n=Number(v);if(!Number.isInteger(n)||n<=0)throw Object.assign(new Error('Неверный идентификатор'),{status:400});return n;};

module.exports=function(app,ctx){
  const{apiForAcc}=ctx;
  const db=()=>require('../../db/index');
  const SELECT=()=>({type:require('sequelize').QueryTypes.SELECT});
  async function write(accountId,data){
    await db().seq.query('INSERT INTO game_extra_cache (account_id,kind,ref,data,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
      {replacements:[accountId,KIND,'',JSON.stringify(data??null),new Date()]});
  }
  // аккаунты с Центральным рынком (без здания игра отвечает 403 «нет здания»)
  async function marketAccounts(){
    const accs=await db().Account.findAll({attributes:['id','name','access_token','special_buildings']});
    return accs.filter(a=>a.access_token&&a.access_token!=='placeholder'&&String(a.special_buildings||'').split(',').includes('market'));
  }
  async function pull(acc){const d=await apiForAcc(acc).get('/market/user/negotiation-offers');await write(acc.id,d);return d;}

  app.get('/api/market/offers',async(req,res)=>{
    try{
      const accs=await marketAccounts();
      const rows=await db().seq.query('SELECT account_id,data,updated_at FROM game_extra_cache WHERE kind=? AND ref=?',{replacements:[KIND,''],...SELECT()});
      const by=new Map(rows.map(r=>[Number(r.account_id),r]));
      const received=[],sent=[];let updated_at=null;
      for(const a of accs){
        const r=by.get(a.id);if(!r)continue;
        let d=null;try{d=JSON.parse(r.data);}catch{}
        if(!updated_at||new Date(r.updated_at)<new Date(updated_at))updated_at=r.updated_at;
        for(const o of d?.received||[])received.push({...o,account_id:a.id,account:a.name});
        for(const o of d?.sent||[])sent.push({...o,account_id:a.id,account:a.name});
      }
      res.json({ok:true,accounts:accs.map(a=>({id:a.id,name:a.name,loaded:by.has(a.id)})),received,sent,updated_at});
    }catch(e){res.status(500).json({ok:false,error:errText(e)});}
  });
  app.post('/api/market/offers/refresh',async(req,res)=>{
    const errors=[];
    try{
      for(const a of await marketAccounts()){
        try{await pull(a);}catch(e){if(!e.noBuilding)errors.push(`${a.name}: ${errText(e)}`);}
      }
      res.json({ok:true,errors});
    }catch(e){res.status(500).json({ok:false,error:errText(e)});}
  });
  const ACT={accept:'/market/negotiation/accept',reject:'/market/negotiation/reject',revoke:'/market/negotiation/offer/cancel'};
  app.post('/api/market/offers/:action',async(req,res)=>{
    const path=ACT[req.params.action];
    if(!path)return res.status(404).json({ok:false,error:'Неизвестное действие'});
    try{
      const acc=await db().Account.findByPk(num(req.body?.account_id));
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const offer_id=num(req.body?.offer_id);
      const r=await apiForAcc(acc).post(path,{offer_id});
      logger.info(`[${acc.name}] [market] предложение ${offer_id}: ${req.params.action}`);
      // свежий список после действия; его сбой не делает действие неудачным
      try{await pull(acc);}catch{}
      res.json({ok:true,data:r??null});
    }catch(e){logger.warn(`[market] предложение ${req.params.action}: ${errText(e)}`);res.status(e.status||e?.response?.status||500).json({ok:false,error:errText(e)});}
  });
};
