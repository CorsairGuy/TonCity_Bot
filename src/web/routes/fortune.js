'use strict';
const path=require('path');
const fs=require('fs');
const logger=require('../../utils/logger');
const opRegistry=require('../lib/opRegistry');

module.exports=function(app,ctx){
  const{apiForAcc,midErr}=ctx;

  app.get('/api/fortune-raw',async(req,res)=>{
    try{
      const{FortuneLog}=require('../../db/index');
      const rows=await FortuneLog.findAll({limit:3,order:[['id','DESC']]});
      res.json(rows.map(r=>({id:r.id,account:r.account,reward_raw:r.reward})));
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/fortune-log',async(req,res)=>{
    try{
      const{FortuneLog}=require('../../db/index');
      const{Op}=require('sequelize');
      const date=req.query.date;// YYYY-MM-DD, default today
      const d=date?new Date(date):new Date();
      const start=new Date(d);start.setHours(0,0,0,0);
      const end=new Date(d);end.setHours(23,59,59,999);
      const rows=await FortuneLog.findAll({where:{spun_at:{[Op.between]:[start,end]}},order:[['spun_at','ASC']]});
      res.json({ok:true,rows:rows.map(r=>({id:r.id,account:r.account,spun_at:r.spun_at,reward:r.reward?JSON.parse(r.reward):null}))});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/fortune-items-summary',async(req,res)=>{
    try{
      const{FortuneLog}=require('../../db/index');
      const rows=await FortuneLog.findAll({order:[['spun_at','ASC']]});
      const totals={};// item_id -> {item_id, amount}
      for(const row of rows){
        let r=row.reward?JSON.parse(row.reward):null;
        if(r?.reward&&typeof r.reward==='object')r=r.reward;
        if(!r)continue;
        const t=r.reward_type||r.type||'';
        if(t!=='item'&&r.item_id==null&&r.reward_id==null)continue;
        const id=r.item_id??r.reward_id;
        if(id==null)continue;
        const qty=parseInt(r.amount)||1;
        if(!totals[id])totals[id]={item_id:id,amount:0};
        totals[id].amount+=qty;
      }
      res.json({ok:true,items:Object.values(totals).sort((a,b)=>a.item_id-b.item_id)});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  const fortuneToday=()=>new Date().toISOString().slice(0,10);
  async function saveFortuneStatus(accId,accName,cd,crystals){
    try{
      const{FortuneStatus}=require('../../db/index');
      await FortuneStatus.upsert({account_id:accId,account:accName,can_draw:cd?.can_draw?1:0,cost:cd?.cost??0,spins_made:cd?.spins_made??0,crystals:crystals??0,status_date:fortuneToday(),updated_at:new Date()},{conflictFields:['account_id']});
    }catch(_){}
  }

  // сохранённый статус из БД (без обращения к игре) — для отображения при загрузке страницы
  app.get('/api/fortune/status',async(req,res)=>{
    try{
      const{FortuneStatus}=require('../../db/index');
      const rows=await FortuneStatus.findAll();
      const t=fortuneToday();
      const results=rows.filter(r=>r.status_date===t).map(r=>({id:r.account_id,name:r.account,ok:true,can_draw:!!r.can_draw,cost:r.cost,spins_made:r.spins_made,crystals:parseFloat(r.crystals)||0}));
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.get('/api/fortune/can-draw-all',async(req,res)=>{
    try{
      const results=await opRegistry.run('fortuneCanDrawAll',async()=>{
        const{Account}=require('../../db/index');
        const all=await Account.findAll({order:[['id','ASC']]});
        // только аккаунты с Павильоном удачи на карте (наличие из /progress/ в special_buildings)
        const accs=all.filter(a=>String(a.special_buildings||'').split(',').includes('fortune'));
        return Promise.all(accs.map(async acc=>{
          if(!acc.access_token)return{id:acc.id,name:acc.name,ok:false,error:'no token',can_draw:false,cost:0,spins_made:0,crystals:parseFloat(acc.crystals)||0};
          try{
            const gameApi=apiForAcc(acc);
            const cd=await gameApi.get('/fortune-pavilion/can-draw');
            const crystals=parseFloat(acc.crystals)||0;
            await saveFortuneStatus(acc.id,acc.name,cd,crystals);
            return{id:acc.id,name:acc.name,ok:true,can_draw:cd?.can_draw??false,cost:cd?.cost??0,spins_made:cd?.spins_made??0,crystals};
          }catch(e){return{id:acc.id,name:acc.name,ok:false,error:String(e.message),can_draw:false,cost:0,spins_made:0,crystals:parseFloat(acc.crystals)||0};}
        }));
      });
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post('/api/fortune/spin',async(req,res)=>{
    try{
      const{account_id}=req.body||{};
      if(!account_id)return res.status(400).json({ok:false,error:'account_id обязателен'});
      const{Account,FortuneLog}=require('../../db/index');
      const acc=await Account.findByPk(account_id);
      if(!acc?.access_token)return res.status(404).json({ok:false,error:'Аккаунт не найден'});
      const ApiClient=require('../../api/client');
      const gameApi=apiForAcc(acc);
      const spins=[];
      let crystalsSpent=0;
      const accCrystals=parseFloat(acc.crystals)||0;
      // один прокрут за нажатие (не цикл — иначе крутит и платные подряд)
      const cd=await gameApi.get('/fortune-pavilion/can-draw');
      if(cd?.can_draw){
        const cost=cd.cost??0;
        if(!(cost>0&&accCrystals<cost)){
          const type=cost>0?'paid':'free';
          const result=await gameApi.post('/fortune-pavilion/daily-draw',{type});
          await FortuneLog.create({account:acc.name,spun_at:new Date(),reward:result?JSON.stringify(result):null});
          if(cost>0)crystalsSpent+=cost;
          spins.push({type,cost,reward:result});
        }
      }
      if(crystalsSpent>0)await acc.update({crystals:Math.max(0,accCrystals-crystalsSpent)});
      const finalCd=await gameApi.get('/fortune-pavilion/can-draw');
      await saveFortuneStatus(acc.id,acc.name,finalCd,Math.max(0,accCrystals-crystalsSpent));
      res.json({ok:true,spins:spins.length,crystals_spent:crystalsSpent,results:spins,can_draw:finalCd,crystals_remaining:Math.max(0,accCrystals-crystalsSpent)});
    }catch(e){res.status(500).json({ok:false,error:midErr(e)});}
  });

  app.post('/api/fortune/spin-all',async(req,res)=>{
    try{
      const{Account,FortuneLog}=require('../../db/index');
      const ApiClient=require('../../api/client');
      const all=await Account.findAll({order:[['id','ASC']]});
      // только аккаунты с Павильоном удачи
      const accs=all.filter(a=>String(a.special_buildings||'').split(',').includes('fortune'));
      const results=[];
      for(const acc of accs){
        if(!acc.access_token){results.push({name:acc.name,ok:false,error:'no token'});continue;}
        try{
          const gameApi=apiForAcc(acc);
          const spins=[];
          let crystalsSpent=0;
          const accCrystals=parseFloat(acc.crystals)||0;
          // один прокрут на аккаунт за нажатие
          const cd=await gameApi.get('/fortune-pavilion/can-draw');
          if(cd?.can_draw){
            const cost=cd.cost??0;
            if(!(cost>0&&accCrystals<cost)){
              const type=cost>0?'paid':'free';
              const result=await gameApi.post('/fortune-pavilion/daily-draw',{type});
              await FortuneLog.create({account:acc.name,spun_at:new Date(),reward:result?JSON.stringify(result):null});
              if(cost>0)crystalsSpent+=cost;
              const r=result?.reward&&typeof result.reward==='object'?result.reward:result;
              spins.push({type,cost,reward:r});
            }
          }
          if(crystalsSpent>0)await acc.update({crystals:Math.max(0,accCrystals-crystalsSpent)});
          // сохраняем актуальный статус (после прокрута перезапрашиваем, иначе берём исходный)
          const finalCd=spins.length?await gameApi.get('/fortune-pavilion/can-draw').catch(()=>cd):cd;
          await saveFortuneStatus(acc.id,acc.name,finalCd,Math.max(0,accCrystals-crystalsSpent));
          results.push({name:acc.name,ok:true,spins:spins.length,crystals_spent:crystalsSpent,reward:spins[0]?.reward});
        }catch(e){results.push({name:acc.name,ok:false,error:midErr(e)});}
      }
      res.json({ok:true,results});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
  });
};
