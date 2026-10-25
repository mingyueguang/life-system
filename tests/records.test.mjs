import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('record provenance, idempotency, corrections, unknown values, history and incremental reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-records-'));process.env.DATABASE_PATH=join(dir,'life.sqlite');
 const {body,failure}=await import('../server/http.mjs');
 await assert.rejects(body(new Request('http://test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"a":1,}'})),e=>{assert.equal(e.code,'INVALID_JSON');assert.equal(typeof e.details[0].position,'number');assert.ok(!JSON.stringify(e.details).includes('"a"'));return true});
 const {db,closeDb}=await import('../server/database.mjs');const {saveRecord,readRecords}=await import('../server/records.mjs');
 try{
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner','test@example.test','hash','date');
 const id=randomUUID(),request_id=randomUUID();const input={id,request_id,kind:'sleep',version:0,data:{date:'2026-10-25',note:'感觉没有睡好'},metadata:{source:{method:'user_report',original_text:'感觉没有睡好'},certainty:'reported'}};
 const first=saveRecord('owner','ai-A',input);assert.equal(first.record.data.hours,null);assert.equal(first.record.data.target,null);assert.equal(first.record.metadata.source.original_text,'感觉没有睡好');assert.equal(saveRecord('owner','ai-A',input).duplicate,true);
 assert.throws(()=>saveRecord('owner','ai-A',{...input,data:{note:'不同内容'}}),e=>e.status===409);
 const second=saveRecord('owner','ai-B',{id,request_id:randomUUID(),kind:'sleep',version:1,data:{date:'2026-10-25',hours:6.5}});assert.equal(second.record.metadata.source.original_text,'感觉没有睡好');
 assert.throws(()=>saveRecord('owner','ai-C',{...input,request_id:randomUUID(),version:1}),e=>e.status===409);
 let h=readRecords('owner',new URLSearchParams({id,history:'true'}));assert.equal(h.history.length,2);assert.equal(h.history[1].actor,'ai-A');assert.equal(h.history[1].record.data.hours,null);
 const archived=saveRecord('owner','website',{id,kind:'sleep',version:2,data:second.record.data,deleted:true});assert.equal(readRecords('owner',new URLSearchParams()).records.length,0);
 assert.equal(readRecords('owner',new URLSearchParams({since:'2000-01-01T00:00:00Z'})).records[0].deleted,true);
 saveRecord('owner','website',{id,kind:'sleep',version:3,data:second.record.data});assert.equal(readRecords('owner',new URLSearchParams({from:'2026-10-25',to:'2026-10-25'})).records.length,1);
 const unknown=saveRecord('owner','ai-A',{id:randomUUID(),kind:'unclassified',version:0,data:{text:'今天心情不错'}}).record;
 assert.throws(()=>saveRecord('owner','ai-A',{id:unknown.id,kind:'mood',version:1,data:{text:'今天心情不错'}}),e=>e.status===409);
 const mood=saveRecord('owner','website',{id:unknown.id,kind:'mood',version:1,reclassify:true,data:{text:'今天心情不错'}}).record;assert.equal(mood.data.rating,null);assert.equal(mood.data.date,'');assert.equal(readRecords('owner',new URLSearchParams({from:'2026-10-25',to:'2026-10-25'})).records.length,1);
 saveRecord('owner','ai-A',{id:randomUUID(),kind:'profile',version:0,data:{topic:'训练目标',status:'missing'}});assert.equal(readRecords('owner',new URLSearchParams({status:'missing'})).records.length,1);
 assert.throws(()=>saveRecord('owner','ai-A',{id:randomUUID(),kind:'phone_usage',version:0,data:{minutes:1500}}));
 assert.throws(()=>saveRecord('owner','ai-A',{id:randomUUID(),kind:'exercise',version:0,data:{title:'走路'},metadata:{related_ids:[randomUUID()]}}),e=>e.status===400);
 const legacy=randomUUID();db().prepare('INSERT INTO records(id,user_id,kind,payload,version,updated_at,deleted) VALUES(?,?,?,?,?,?,?)').run(legacy,'owner','exercise',JSON.stringify({date:'2026-10-01',title:'散步',minutes:20,steps:0,note:''}),4,'2026-10-01T00:00:00.000Z',0);
 saveRecord('owner','website',{id:legacy,kind:'exercise',version:4,data:{date:'2026-10-01',title:'散步',minutes:25}});h=readRecords('owner',new URLSearchParams({id:legacy,history:'true'}));assert.deepEqual(h.history.map(x=>x.record.version),[5,4]);assert.equal(h.history[1].record.metadata.source.method,'unknown');
 closeDb();assert.equal(readRecords('owner',new URLSearchParams({id})).record.version,4);
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
