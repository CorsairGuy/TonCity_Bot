'use strict';
const opRegistry=require('../lib/opRegistry');
const contract=require('../lib/championships');
const busy=new Set();
function text(e){const d=e?.response?.data;return typeof d==='string'?d:d?.error||d?.message||e?.message||'Ошибка чемпионатов';}
// GET безопасно ограничиваем по ожиданию; поздний ответ никогда не продолжает мутацию.
function read(api){
  let timer;
  return Promise.race([api.get('/championships/overview',{}, {timeout:20000}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Превышено время ожидания чемпионатов')),45000);})]).then(contract.overview).finally(()=>clearTimeout(timer));
}
function accountId(value){if(typeof value!=='number'&&!(typeof value==='string'&&/^[1-9]\d*$/.test(value))){const e=new Error('Выберите аккаунт');e.status=400;throw e;}const id=Number(value);if(!Number.isSafeInteger(id)||id<=0){const e=new Error('Выберите аккаунт');e.status=400;throw e;}return id;}
module.exports=function(app,ctx){
  app.get('/api/championships',async(req,res)=>{
    try{const id=accountId(req.query.accountId),api=await ctx.makeApiForAccount(id,{noLock:true});res.json({ok:true,data:await read(api)});}
    catch(e){res.status(e.status||500).json({ok:false,error:text(e)});}
  });
  app.post('/api/championships/action',async(req,res)=>{
    let key,locked=false;
    try{
      const id=accountId(req.body?.accountId);key=`championships:${id}`;
      // Разные действия нельзя присоединять к одному opRegistry Promise как повтор refresh.
      if(busy.has(key))return res.status(409).json({ok:false,error:'Предыдущее действие чемпионатов ещё выполняется'});
      busy.add(key);locked=true;
      const reply=await opRegistry.run(key,async()=>{
        const api=await ctx.makeApiForAccount(id,{noLock:true});
        const current=await read(api),cmd=contract.command(current,req.body||{});
        try{
          await api.post(cmd.path,cmd.body); // мутацию при неоднозначном ответе НЕ повторяем
        }catch(e){
          let data=null;try{data=await read(api);}catch(_){}
          return{ok:false,error:text(e),data,resynced:!!data,needsRefresh:!data};
        }
        try{return{ok:true,data:await read(api)};}
        catch(e){return{ok:true,needsRefresh:true,error:'Действие отправлено, но состояние не обновилось: '+text(e)};}
      });
      res.json(reply);
    }catch(e){res.status(e.status||500).json({ok:false,error:text(e)});}
    finally{if(locked)busy.delete(key);}
  });
};
