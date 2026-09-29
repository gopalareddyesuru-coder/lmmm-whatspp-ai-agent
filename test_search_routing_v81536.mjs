import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function extract(start,end,env){const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a);return vm.runInNewContext(`(${app.slice(a,b).trim()})`,env);}
const intent=extract('function documentQuestionIntentV81511(','function documentSessionValueV81511(',{});
for(const q of ['BH4 item number','equipment item 20','Ltp','FART drawings','BP1 jobs'])assert(intent(q),q);
const rank=extract('function rankSearchRowsV81524(','function universalEvidenceV81513(',{
  searchTextV81524:r=>String(r.content||'').toLowerCase(),
  chargingAssetV81533:q=>q.includes('LTP')?{}:null,
  searchTermMatchV81524:(body,term)=>body.includes(term),
  exactDrawingTokenV81512:()=>false
});
const request={terms:['lever','pusher'],question:'LTP jobs',exact:null,bloomPusher:false,date:null};
const rows=rank([{kind:'Source maintenance history',key:'charging:one',content:'Lever type pusher replaced on 2020-01-01',date:'2020-01-01'}],request,'JOBS');
assert.equal(rows.length,1,'Charging history survives ranking without runtime error');
console.log('Search routing and charging result regression passed.');
