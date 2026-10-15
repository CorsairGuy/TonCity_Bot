'use strict';
const {createLogger,format,transports}=require('winston');
const Transport=require('winston-transport');
const {MESSAGE}=require('triple-beam');
const cfg=require('../config'),path=require('path'),fs=require('fs');
const logStream=require('./logStream');
const ld=path.join(process.cwd(),'logs');
if(!fs.existsSync(ld))fs.mkdirSync(ld,{recursive:true});

// транслирует строку в момент самой записи лога (см. logStream.js) — живой хвост страницы "Логи"
// без поллинга и без перечитывания файла с диска; info[MESSAGE] — уже отформатированная строка,
// та же самая, что летит в файл (единый формат format.printf выше применяется до транспортов).
class BroadcastTransport extends Transport{
  log(info,callback){logStream.broadcast(info[MESSAGE]);callback();}
}

module.exports=createLogger({
  level:cfg.logLevel,
  format:format.combine(format.timestamp({format:'YYYY-MM-DD HH:mm:ss'}),format.errors({stack:true}),
    format.printf(({timestamp,level,message,stack})=>`${timestamp} [${level.toUpperCase()}] ${stack||message}`)),
  transports:[
    new transports.Console({format:format.combine(format.colorize(),format.timestamp({format:'HH:mm:ss'}),
      format.printf(({timestamp,level,message})=>`${timestamp} [${level}] ${message}`))}),
    // tailable: активный файл всегда bot.log, при ротации старые сдвигаются в bot1.log…bot4.log
    new transports.File({filename:path.join(ld,'bot.log'),maxFiles:5,maxsize:5242880,tailable:true}),
    new BroadcastTransport(),
  ],
});
