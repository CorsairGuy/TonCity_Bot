'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'src/web/client/node_modules/esbuild'));
const src=fs.readFileSync(path.join(root,'src/web/client/src/cityDistricts.ts'),'utf8');
const ctx={module:{exports:{}}};
vm.runInNewContext(esbuild.transformSync(src.slice(src.indexOf('const UNRELEASED_CITY_BUILDINGS')),{loader:'ts',format:'cjs'}).code,ctx);
const can=ctx.module.exports.canPurchaseCityBuilding;
for(const id of ['COM_atlas_foundry.png','COM_genesis_labs.png','COM_aurelian_skyport_1_star.png'])assert.equal(can({id,is_purchasable:true}),false);
for(const id of ['COM_aurelian_skyport.png','COM_bloom_market.png']){
 assert.equal(can({id,is_purchasable:true}),true);
 for(const flag of [false,undefined,'false'])assert.equal(can({id,is_purchasable:flag}),false);
}
for(const page of ['CityWorld','CityMapCity'])assert.match(fs.readFileSync(path.join(root,`src/web/client/src/pages/${page}.tsx`),'utf8'),/buildingDistrict\(b\) === district && canPurchaseCityBuilding\(b\)/);
console.log('PASS unreleased buildings hidden in both pickers; skyport/D1 available; server flag and stars respected');
