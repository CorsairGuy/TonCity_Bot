'use strict';
// Отправка служебных уведомлений в основной тред чата (тот же, что и вордли).
// Механизм и выбор токена/чата/треда — как в src/modules/wordle.js.
const axios=require('axios');
const logger=require('./logger');
const{getConfig}=require('../config');

async function sendToMainThread(text){
  const cfg=getConfig();
  const token=cfg.telegram?.wordleBot||cfg.telegram?.marketBot||cfg.telegram?.botToken;
  const chatId=cfg.telegram?.maintenanceChatId||cfg.telegram?.wordleChatId||cfg.telegram?.marketChatId;
  const threadId=cfg.telegram?.maintenanceThreadId||cfg.telegram?.wordleThreadId||null;
  if(!token||!chatId){logger.warn('[tg] telegram не настроен, пропуск отправки');return;}
  const body={chat_id:chatId,text};
  if(threadId&&String(threadId)!=='1')body.message_thread_id=String(threadId);
  try{
    const res=await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,body,
      {headers:{'Content-Type':'application/json'},timeout:15000});
    if(res.data?.ok)logger.info('[tg] уведомление отправлено в основной тред');
    return res.data;
  }catch(e){
    const d=e.response?.data?JSON.stringify(e.response.data):e.message;
    logger.warn(`[tg] sendMessage failed: ${d}`);
  }
}

module.exports={sendToMainThread};
