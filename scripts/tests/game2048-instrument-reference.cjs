'use strict';
// Только разработка: наблюдение за оценками неизменённого эталонного WASM.
// Установленный отдельно wabt передаётся --wabt=/path/to/wabt; в Docker бота он не нужен.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const REFERENCE_SHA256='45ba979f37a9b84fa26f34b768b7b9bf2b16dee50cebfc35702c4c4120badcf2';
async function instrument(input,output,wabtPath){
  const bytes=fs.readFileSync(input);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),REFERENCE_SHA256,'Неизвестный эталон: сначала проверить точки наблюдения заново');
  const wabt=await require(wabtPath)();
  const module=wabt.readWasm(Uint8Array.from(bytes),{readDebugNames:false});
  const wat=module.toText({foldExprs:false,inlineExport:false});
  module.destroy();
  assert.match(wat,/\(export "best_move" \(func 6\)\)/);
  const begin=wat.indexOf('  (func (;6;)');
  const end=wat.indexOf('  (func (;7;)',begin);
  assert.ok(begin>=0&&end>begin);
  let fn=wat.slice(begin,end),captures=0;
  const directions=[0,0,0,0];
  // Захват после END корневого блока: наблюдается и нулевой результат невозможного хода.
  // Порядок инструкций, локальные переменные, арифметика и условия остаются прежними.
  fn=fn.replace(/(i32\.const ([0-3])\n\s+(?:local\.get 0|i64\.const 0)\n\s+call 3[\s\S]*?f32\.demote_f64\n\s+local\.set (\d+)\n(\s+)end)(?=\n)/g,(all,_code,dir,local,indent)=>{
    captures++;directions[Number(dir)]++;
    return `${all}\n${indent}local.get ${local}\n${indent}global.set $__root_score_${dir}`;
  });
  assert.equal(captures,8,'Ожидались 4 корня для обычной доски и 4 для ветки пустой доски');
  assert.deepEqual(directions,[2,2,2,2]);
  let observed=wat.slice(0,begin)+fn+wat.slice(end);
  const extra=`\n  (global $__root_score_0 (mut f32) (f32.const 0))
  (global $__root_score_1 (mut f32) (f32.const 0))
  (global $__root_score_2 (mut f32) (f32.const 0))
  (global $__root_score_3 (mut f32) (f32.const 0))
  ;; best_move(board) должен быть вызван до чтения score_bits(board, direction).
  (func (export "score_bits") (param i64 i32) (result i32)
    global.get $__root_score_0
    i32.reinterpret_f32
    global.get $__root_score_1
    i32.reinterpret_f32
    global.get $__root_score_2
    i32.reinterpret_f32
    global.get $__root_score_3
    i32.reinterpret_f32
    local.get 1
    i32.const 2
    i32.eq
    select
    local.get 1
    i32.const 1
    i32.eq
    select
    local.get 1
    i32.const 0
    i32.eq
    select)
`;
  // Добавляем после исходных объявлений: числовые индексы функций и global 0 сохраняются.
  const moduleEnd=observed.lastIndexOf(')');
  assert.ok(moduleEnd>0);
  observed=observed.slice(0,moduleEnd)+extra+observed.slice(moduleEnd);
  const parsed=wabt.parseWat('observed-reference.wat',observed);
  parsed.resolveNames();parsed.validate();
  const result=parsed.toBinary({log:false,write_debug_names:false});
  parsed.destroy();
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  fs.writeFileSync(output,Buffer.from(result.buffer));
  return{referenceSHA256:REFERENCE_SHA256,captures,output};
}
if(require.main===module){
  const args=process.argv.slice(2),wabtArg=args.find(x=>x.startsWith('--wabt='));
  const positional=args.filter(x=>!x.startsWith('--'));
  if(positional.length!==2||!wabtArg){console.error('Usage: node game2048-instrument-reference.cjs REFERENCE.wasm OBSERVED.wasm --wabt=/path/to/wabt');process.exit(1);}
  instrument(positional[0],positional[1],wabtArg.slice(7)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={instrument,REFERENCE_SHA256};
