'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/web/sprites'),map=JSON.parse(fs.readFileSync(path.join(root,'sprite-map.json'))),sizes=new Map();
const expected=['RES_cascade_residences','RES_titan_gate','RES_polaris_arcology','COM_aurelian_skyport','COM_genesis_labs','COM_atlas_foundry','SER_biosphere_reserve','SER_longevity_institute','SER_rescue_command','SER_sentinel_command'];
for(const id of expected){assert(map[id+'.png'],id);assert(!map[id+'.png'].atlas.includes('/d1/'),id);}
for(const [id,sprite]of Object.entries(map)){
 const file=path.resolve(root,sprite.atlas);assert(file.startsWith(root+path.sep));
 if(!sizes.has(file)){const fd=fs.openSync(file,'r'),header=Buffer.alloc(24);try{assert.equal(fs.readSync(fd,header,0,24,0),24);}finally{fs.closeSync(fd);}assert.equal(header.toString('hex',0,8),'89504e470d0a1a0a');sizes.set(file,[header.readUInt32BE(16),header.readUInt32BE(20)]);}
 const[w,h]=sizes.get(file),f=sprite.frame;assert([f.x,f.y,f.w,f.h].every(Number.isFinite),id);assert(f.x>=0&&f.y>=0&&f.w>0&&f.h>0&&f.x+f.w<=w&&f.y+f.h<=h,id);
}
assert(map['RES_rootweave.png'].atlas.startsWith('tiles/d1/'));
console.log(`PASS: 10 new main sprites, D1 namespace, ${Object.keys(map).length} frames inside ${sizes.size} valid PNG atlases`);
