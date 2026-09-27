import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const start=app.indexOf('async function universalSearchV81513(');
const end=app.indexOf('async function searchLanguageV81515(',start);
assert(start>=0&&end>start);
const queries=[];
const env={
  universalTermsV81513:()=>({primary:'GEARBOX',exact:null,terms:['gearbox']}),
  hasAuthorityV874:async()=>true,
  isOwner:from=>from==='owner',
  adminOverrideV850:async()=>null,
  accessibleDocumentsV81511:async()=>[],
  canonicalArea:()=> 'BAR MILL',canonicalSection:()=> 'Mechanical',normWA:x=>x,
  pool:{query:async sql=>{queries.push(sql);return {rows:[]};}},
  sourceArchiveRowsV81517:()=>[],
  exactDrawingTokenV81512:()=>false,
  console
};
const search=vm.runInNewContext(`(${app.slice(start,end).trim()})`,env);
await search('approved-user',{employee_number:'123125',area_of_working:'BAR MILL',section_department:'Mechanical'},'gearbox');
assert.equal(queries.some(sql=>sql.includes('FROM lmmm_source_review')),false,
  'Unverified archive must not be queried by an ordinary approved user');
queries.length=0;
await search('owner',{employee_number:'123125',area_of_working:'BAR MILL',section_department:'Mechanical'},'gearbox');
assert.equal(queries.filter(sql=>sql.includes('FROM lmmm_source_review')).length,1);
console.log('Permission test passed: only owner queries unverified source review table.');
