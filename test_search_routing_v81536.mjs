import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function extract(start,end,env){const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a);return vm.runInNewContext(`(${app.slice(a,b).trim()})`,env);}
const intent=extract('function documentQuestionIntentV81511(','function documentSessionValueV81511(',{});
for(const q of ['BH4 item number','equipment item 20','Item 19','Ltp','FART drawings','BP1 jobs'])assert(intent(q),q);
const manualIndex={items:Array.from({length:125},(_,i)=>({item_number:i+1,equipment:null}))};
manualIndex.items[18]={item_number:19,equipment:'Guide tables between BH1 and BH4',source_file:'BDM O&M.pdf',source_page:27};
manualIndex.items[24]={item_number:25,equipment:'Horizontal 2-hi mill stand BH4',source_file:'BDM O&M.pdf',source_page:29};
const sent=[];
const itemAnswer=extract('async function answerManualItemNumberV81535(','async function answerManualItemNameV81535(',{
  hasAuthorityV874:async()=>true,isOwner:()=>true,readManualItemSearchIndexV81535:()=>manualIndex,
  geminiGenerateWithFallbackV892:async body=>{
    const prompt=body.contents[0].parts[0].text;
    assert(prompt.includes('table can be turned 90 degrees'));
    return {response:{json:async()=>({candidates:[{content:{parts:[{text:'Function: Guides are adjustable to the passline.\nOperation: The table can be turned 90 degrees for roll change.\nDrawings: 1/7816760.'}]}}]})}};
  },
  pool:{query:async(_sql,params)=>{
    assert.deepEqual(Array.from(params[1]),['page:27','page:28'],'Stop before the next equipment item');
    return {rows:[{location:'page:27',source_text:'ITEM 19 - GUIDE TABLES. List of Drawings: 1/7816760.'},
      {location:'page:28',source_text:'Technical Data & Functional Description: guides adjustable by screws; table cm be turned 90 degrees for roll change.'}]};
  }},sendText:async(_from,msg)=>sent.push(msg),console
});
assert(await itemAnswer('owner',{},'Item 19'));
assert(sent[0].includes('Function:')&&sent[0].includes('1/7816760')&&!sent[0].includes('Page 27:'));
const rank=extract('function rankSearchRowsV81524(','function universalEvidenceV81513(',{
  searchTextV81524:r=>String(r.content||'').toLowerCase(),
  chargingAssetV81533:q=>q.includes('LTP')?{}:null,
  searchTermMatchV81524:(body,term)=>body.includes(term),
  exactDrawingTokenV81512:()=>false
});
const request={terms:['lever','pusher'],question:'LTP jobs',exact:null,bloomPusher:false,date:null};
const rows=rank([{kind:'Source maintenance history',key:'charging:one',content:'Lever type pusher replaced on 2020-01-01',date:'2020-01-01'}],request,'JOBS');
assert.equal(rows.length,1,'Charging history survives ranking without runtime error');
const bpRequest={terms:['bloom','pusher'],question:'bloom pusher 1 jobs',exact:null,bloomPusher:true,bpNumber:'1',date:null};
const bpRank=rank([
  {kind:'Source maintenance history',key:'bp-mechanical:a',content:'BLOOM PUSHER BP-1; CAR 1; SS1; recorded guide wheel history date: 2019-07-31',date:'2019-07-31'},
  {kind:'Source maintenance history',key:'review:h',source:'hyd cyl history(2).accdb',content:'AREA: BDM | CELLAR: 1 | EQPT: BLOOM PUSHER | SUB EQPT: CYLINDER | ASSEMBLY: CYL-4 | DATE OF FIX: 2026-01-29T00:00 | REASONS FOR FIX: ROD SEAL LEAK',date:'2026-01-29'},
  {kind:'Source maintenance history',key:'bp-mechanical:b',content:'BLOOM PUSHER BP-2; CAR 1; SS1; recorded guide wheel history date: 2019-07-31',date:'2019-07-31'}
],bpRequest,'JOBS');
assert.equal(bpRank.length,2,'BP-1 keeps unit-unconfirmed hydraulic records while excluding explicit BP-2');
const balance=extract('function balanceBpMaintenanceRowsV81532(','function dedupeMaintenanceResultsV81537(',{});
assert.equal(balance(bpRank,bpRequest,'JOBS')[1].key,'review:h','Numbered BP jobs show both disciplines');
const dedupe=extract('function dedupeMaintenanceResultsV81537(','function dateForSearchV81524(',{});
assert.equal(dedupe([bpRank[1],{...bpRank[1],key:'review:reimport'}]).length,1,'Reimports collapse');
const catalog=extract('async function searchScopedSourceCatalogV81524(','async function chargingHistoryRowsV81533(',{
  isOwner:()=>true,hasAuthorityV874:async()=>true,
  pool:{query:async(sql,params)=>{
    assert.deepEqual(Array.from(params).slice(1),['%pusher%','%bloom%','pusher'],'Manual topic words must not displace equipment terms');
    assert(sql.includes("to_tsvector('simple'"),'Search must use the existing full-text index');
    return {rows:[{source_key:'manual:114',source_file:'1702906388 Charging Equipement Full Discription.pdf',location:'page:114',content_type:'GENERAL_SOURCE',source_text:'BLOOM PUSHER 2.12.6 Lubrication and Maintenance. All wheels and friction bearings must be manually greased.'}]};
  }}
});
const manual=await catalog('owner',{}, {terms:['bloom','pusher','procedure'],question:'Bloom pusher maintenance procedure',exact:null},'MANUALS');
assert.equal(manual.rows.length,1,'Manual content imported as GENERAL_SOURCE is retrievable');
console.log('Search routing and charging result regression passed.');
