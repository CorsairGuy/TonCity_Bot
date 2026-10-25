'use strict';
// Optional dependency: npm install --no-save playwright, or PLAYWRIGHT_MODULE=/path/to/playwright-core.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.CITY_FIXTURE_URL||'http://127.0.0.1:5200';
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
 try {
  for(const mode of ['queue','plan','pending','build','move','demolish','reconstruct','renovate','boosters','log','forecast']){
   const page=await browser.newPage({viewport:{width:900,height:800}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`${origin}/?mode=${mode}`); await page.waitForFunction(()=>window.ready);
   await page.waitForFunction(()=>document.querySelector('[data-panel-window]')?.children.length>3);
   await page.evaluate(()=>{const viewport=document.querySelector('[data-overlayscrollbars-viewport]');viewport.scrollTop=viewport.scrollHeight;});
   await page.waitForFunction(()=>[...document.querySelectorAll('[data-panel-row]')].some(e=>Number(e.dataset.panelRow)>=499));
   await page.waitForTimeout(100);
   const stats=await page.evaluate(()=>({count:document.querySelectorAll('[data-panel-row]').length,text:document.body.innerText,overlaps:[...document.querySelectorAll('[data-panel-window]')].flatMap(host=>{const rows=[...host.children].map(e=>e.getBoundingClientRect()).sort((a,b)=>a.top-b.top);return rows.slice(1).filter((r,i)=>rows[i].bottom>r.top+0.5).length;})}));
   assert(stats.count<40,`${mode}: ${stats.count} mounted rows`);assert(stats.overlaps.every(n=>n===0),`${mode}: overlapping rows`);
   assert(stats.text.includes('499'),`${mode}: last record missing`);
   if(['pending','move','queue','demolish'].includes(mode)){
    const row=page.locator('[data-panel-row="499"]').last();await row.hover();await row.getByRole('button').last().click();
    assert.deepEqual(await page.evaluate(()=>window.calls),[['remove',499]],`${mode}: absolute removal ID`);
   }
   if(mode==='plan'){
    const row=page.locator('[data-panel-row="499"]').last();assert.equal(await row.evaluate(e=>e.getBoundingClientRect().height),52);
    await row.locator('[data-mq-host]').click();assert.deepEqual(await page.evaluate(()=>window.calls),[['mark',['499,0'],true]],'plan: exact cell key');
   }
   if(mode==='boosters'){
    await page.locator('[data-panel-row="499"]').last().getByRole('button').click();assert.deepEqual(await page.evaluate(()=>window.calls),[['add','499']]);
   }
   assert.deepEqual(errors,[],`${mode}: browser errors`);console.log(`PASS ${mode}: ${stats.count} DOM rows / 500 records, last record and geometry`);await page.close();
  }
  const page=await browser.newPage();await page.goto(`${origin}/?mode=queue`);await page.waitForTimeout(500);
  await page.locator('[data-panel-row="0"]').hover();await page.locator('[data-panel-row="0"] button').last().focus();
  await page.keyboard.press('Tab');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-panel-row]')?.dataset.panelRow),'1');
  await page.keyboard.press('Shift+Tab');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-panel-row]')?.dataset.panelRow),'0');
  await page.evaluate(()=>{window.dragData=new DataTransfer();document.querySelector('[data-panel-row="0"] [draggable]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.dragData}));document.querySelector('[data-overlayscrollbars-viewport]').scrollTop=1e9;});
  await page.waitForTimeout(100);assert(await page.locator('[data-panel-row="0"]').count());
  await page.evaluate(()=>document.querySelector('[data-panel-row="499"] [draggable]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:window.dragData})));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['reorder',0,499]]);console.log('PASS keyboard + pinned drag, reorder absolute index');
  await page.goto(`${origin}/?mode=disabled`);await page.waitForTimeout(500);
  await page.locator('[data-panel-row="0"] button').focus();
  await page.keyboard.press('Tab');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-panel-row]')?.dataset.panelRow),'30');
  await page.keyboard.press('Tab');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-panel-row]')?.dataset.panelRow),'49');
  await page.keyboard.press('Shift+Tab');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-panel-row]')?.dataset.panelRow),'30');
  console.log('PASS keyboard skips disabled booster stock rows (0→30→49→30)');
  await page.goto(`${origin}/?mode=groups`);await page.waitForTimeout(500);
  const outer=page.locator('[data-panel-window]').first();await outer.locator(':scope > [data-panel-row="0"] [data-panel-row="49"] button').focus();
  const focused=()=>page.evaluate(()=>{let e=document.activeElement,a=[];while(e){if(e.dataset.panelRow!=null)a.push(Number(e.dataset.panelRow));e=e.parentElement;}return a;});
  await page.keyboard.press('Tab');await page.waitForTimeout(50);assert.deepEqual(await focused(),[0,1]);await page.keyboard.press('Shift+Tab');await page.waitForTimeout(50);assert.deepEqual(await focused(),[49,0]);
  await page.evaluate(()=>document.querySelector('[data-overlayscrollbars-viewport]').scrollTop=1e9);await page.waitForTimeout(100);
  await outer.locator(':scope > [data-panel-row="35"] [data-panel-row="49"] button').click();assert.deepEqual(await page.evaluate(()=>window.calls),[['remove',1799]]);
  assert(await page.locator('[data-panel-row]').count()<60);console.log('PASS 36 nested groups: cross-group keyboard + last-group absolute ID');await page.close();
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
