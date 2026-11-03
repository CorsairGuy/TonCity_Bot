'use strict';
// node scripts/tools/main-island-convert.cjs <game-assets/tiles> <basis_transcoder.js> [output] [reference.png]
// Python Pillow нужен только для offline-подготовки. Runtime использует один готовый WebP-атлас.
require('./shared-island-convert.cjs')({manifest:'floating_island.json',kind:'main',scale:0.85})
  .catch(e=>{console.error(e);process.exitCode=1;});
