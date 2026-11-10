'use strict';
const logger=require('../../utils/logger');

// Городской розыгрыш (civic_draw) — часть ответа /progress/diversity, которую собирает
// modules/townhall.js в отдельную таблицу civic_draw_status (страница "Разнообразие" не трогается).
// Ручной и автоматический сбор используют общий account lock и обновляют снимок после POST.
module.exports=function(app,ctx){
  const{makeApiForAccount}=ctx;

  app.get('/api/civic-draw',async(req,res)=>{
    try{
      const{Account,CivicDrawStatus}=require('../../db/index');
      const accs=await Account.findAll({attributes:['id','name']});
      const accIdByName=Object.fromEntries(accs.map(a=>[a.name,a.id]));
      const rows=await CivicDrawStatus.findAll({order:[['account','ASC']]});
      const accounts=rows
        .filter(r=>accIdByName[r.account]!=null)
        .map(r=>({
          account_id:accIdByName[r.account],
          account:r.account,
          draws_per_day:r.draws_per_day,
          draws_ready:r.draws_ready,
          draw_progress:r.draw_progress,
          claimable:!!r.claimable,
          odds:(()=>{try{return JSON.parse(r.odds||'[]');}catch(_){return [];}})(),
          ready_at:r.ready_at,
          timer_source:r.timer_source??'unknown',
          grants:(()=>{try{return JSON.parse(r.grants||'[]');}catch(_){return[];}})(),
          updated_at:r.updated_at,
        }));
      res.json({ok:true,accounts});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/civic-draw/:accountId/grants/claim',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(req.params.accountId);
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'Аккаунт не найден или нет токена'});
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const out=await require('../../modules/townhall').claimPolicyGrant(api,acc.name,req.body?.def_id);
      res.status(out.ok?200:409).json(out);
    }catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  app.post('/api/civic-draw/:accountId/claim-all',async(req,res)=>{
    try{
      const{Account}=require('../../db/index');
      const acc=await Account.findByPk(req.params.accountId);
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'Аккаунт не найден или нет токена'});
      const api=await makeApiForAccount(acc.id,{noLock:true});
      const{cd,...out}=await require('../../modules/townhall').collectCivicRewards(api,acc.name);
      res.json(out);
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
  app.post('/api/civic-draw/claim-all',async(req,res)=>{
    try{
      const{Account,CivicDrawStatus}=require('../../db/index');
      const all=await CivicDrawStatus.findAll();
      const due=t=>t&&Number.isFinite(Date.parse(t))&&Date.parse(t)+5000<=Date.now();
      const rows=all.filter(r=>{
        let grants=[];try{grants=JSON.parse(r.grants||'[]');}catch{}
        return r.claimable||(r.timer_source==='server'&&due(r.ready_at))||grants.some(g=>Number(g.ready)>0||due(g.ready_at));
      });
      const accs=await Account.findAll({where:{name:rows.map(r=>r.account)},attributes:['id','name','access_token']});
      const results=[];
      // Последовательно: не создаём всплеск запросов на всех аккаунтах.
      for(const acc of accs.filter(a=>a.access_token)){
        try{const api=await makeApiForAccount(acc.id,{noLock:true});const{cd,...out}=await require('../../modules/townhall').collectCivicRewards(api,acc.name);results.push({account:acc.name,...out});}
        catch(e){results.push({account:acc.name,ok:false,error:e.message});}
      }
      res.json({ok:true,results,succeeded:results.filter(r=>r.ok).length,total:results.length});
    }catch(e){logger.warn(`[civic-draw] ${e.message}`);res.status(500).json({ok:false,error:e.message});}
  });
};
