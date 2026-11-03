'use strict';
// node scripts/tools/d1-island-convert.cjs <game-assets/tiles/d1> <basis_transcoder.js> [output] [reference.png]
// Python Pillow нужен только для offline-подготовки. Runtime использует один готовый WebP-атлас.
require('./shared-island-convert.cjs')({manifest:'island.json',kind:'d1',scale:0.5})
  .catch(e=>{console.error(e);process.exitCode=1;});
