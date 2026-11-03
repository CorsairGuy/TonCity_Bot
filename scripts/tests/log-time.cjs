'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const code=esbuild.transformSync(fs.readFileSync(path.join(root,'src/web/client/src/logTime.ts'),'utf8'),{loader:'ts',format:'cjs'}).code;
const ctx={module:{exports:{}}};vm.runInNewContext(code,ctx);const format=ctx.module.exports.localLogLine;
const original=process.env.TZ;
try{
 for(const [tz,date] of [['UTC','2026-11-03 23:30:00'],['Asia/Yekaterinburg','2026-11-04 04:30:00'],['America/New_York','2026-11-03 18:30:00']]){
  process.env.TZ=tz;
  for(const stamp of ['2026-11-03 23:30:00','2026-11-03T23:30:00.000Z','2026-11-04T04:30:00+05:00'])assert.equal(format(`${stamp} [INFO] message\nstack`),`${date} [INFO] message\nstack`);
 }
 process.env.TZ='America/New_York';
 assert.equal(format('2026-07-03T23:30:00.000Z [WARN] summer'),'2026-07-03 19:30:00 [WARN] summer');
 for(const line of ['    at stack:1','plain message','2026-13-03 23:30:00 [ERROR] invalid'])assert.equal(format(line),line);
}finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
console.log('PASS UTC, browser zones, day rollover, DST, legacy/ISO, stack preservation');
