import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

test('upload → grouped review → unique order → assignment → evidence → return → acceptance; persistence and permissions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'road-ai-test-'));let child,base;
 async function start(extra={}){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,ROAD_AI_SKIP_ENV:'1',DETECTOR_DISABLED:'1',OPENAI_API_KEY:'',DATA_DIR:dir,PORT:'0',...extra},stdio:['ignore','pipe','pipe']});base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),10000);child.stdout.on('data',b=>{const m=b.toString().match(/port=(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});child.on('error',reject);});}
 async function stop(){if(child && child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
 async function call(path,{method='GET',data,cookie,key=randomUUID()}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'Idempotency-Key':key}:{}),...(data&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{})},body:data instanceof FormData?data:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const login=async role=>(await call('/login',{method:'POST',data:{username:role,password:'RoadDemo2026!'}})).cookie;
 function trip(demo=true){const f=new FormData();f.set('video',new Blob([Buffer.from('0000ftypisom00000000')],{type:'video/mp4'}),'fixture.mp4');f.set('gps',new Blob([readFileSync('public/sample-gps.csv')]),'gps.csv');f.set('started_at','2026-10-12T09:00:00+05:00');f.set('duration','16');f.set('camera_description','Test camera');f.set('route_name','Test route');f.set('demo',String(demo));return f;}
 async function ready(id,cookie){for(let i=0;i<30;i++){const r=await call('/trips/'+id,{cookie});if(['ready','failed'].includes(r.data.status))return r.data;await new Promise(r=>setTimeout(r,100));}throw new Error('processing timeout');}
 try{await start();assert.equal((await call('/state')).status,401);const operator=await login('operator'),dispatcher=await login('dispatcher'),worker=await login('worker');
 assert.equal((await call('/assistant')).status,401);
 const chat=await call('/assistant',{cookie:operator});assert.equal(chat.data.configured,false);assert.deepEqual(chat.data.history,[]);
 const disabled=await call('/assistant',{method:'POST',cookie:operator,data:{question:'Как загрузить видео?',language:'ru'}});assert.equal(disabled.status,503);assert.equal(disabled.data.code,'ASSISTANT_NOT_CONFIGURED');
 assert.equal((await call('/assistant',{method:'POST',cookie:operator,data:null})).status,400);
 const script=await fetch(base+'/assistant-ui.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
 const envFile=await fetch(base+'/.env');assert.equal(envFile.status,404);
 const bad=trip();bad.set('gps',new Blob(['invalid']),'bad.csv');assert.equal((await call('/trips',{method:'POST',cookie:operator,data:bad})).status,400);
 const missing=trip();missing.set('started_at','2026-10-12T10:00:00+05:00');assert.equal((await call('/trips',{method:'POST',cookie:operator,data:missing})).data.code,'TIME_MISMATCH');
 const uploaded=await call('/trips',{method:'POST',data:trip(),cookie:operator});assert.equal(uploaded.status,200);const id=uploaded.data.id;assert.equal((await ready(id,operator)).status,'ready');
 let s=(await call('/state',{cookie:operator})).data;assert.equal(s.candidates.length,3);assert.equal(s.candidates[0].origin,'test');const [c,reject,merge]=s.candidates;
 assert.equal((await call(`/candidates/${c.id}/decision`,{method:'POST',cookie:worker,data:{decision:'confirmed'}})).status,403);
 assert.equal((await call(`/candidates/${reject.id}/decision`,{method:'POST',cookie:operator,data:{decision:'rejected'}})).data.code,'REASON_REQUIRED');
 await call(`/candidates/${reject.id}/decision`,{method:'POST',cookie:operator,data:{decision:'survey_required',reason:'Check GPS'}});
 await call(`/candidates/${reject.id}/decision`,{method:'POST',cookie:operator,data:{decision:'rejected',reason:'No defect'}});
 const original=c.original_position;await call(`/candidates/${c.id}/position`,{method:'POST',cookie:operator,data:{lat:44.9,lon:65.5,reason:'On-site correction'}});
 const key=randomUUID();const confirm=()=>call(`/candidates/${c.id}/decision`,{method:'POST',cookie:operator,key,data:{decision:'confirmed'}});assert.equal((await confirm()).status,200);assert.equal((await confirm()).status,200);
 await call(`/candidates/${c.id}/decision`,{method:'POST',cookie:operator,data:{decision:'confirmed'}});
 await call(`/candidates/${merge.id}/decision`,{method:'POST',cookie:operator,data:{decision:'merged',target_id:c.id,reason:'Same defect'}});
 await call(`/trips/${id}/retry`,{method:'POST',cookie:operator,data:{}});await ready(id,operator);s=(await call('/state',{cookie:operator})).data;assert.equal(s.orders.length,1);assert.equal(s.candidates.length,3);assert.deepEqual(s.candidates.find(x=>x.id===c.id).original_position,original);
 const order=s.orders[0];const update=(cookie,status,extra={})=>call('/orders/'+order.id,{method:'PATCH',cookie,data:{status,...extra}});
 assert.equal((await update(worker,'closed')).status,409);assert.equal((await update(operator,'assigned',{assignee:'worker',due_at:new Date(Date.now()+86400000).toISOString()})).status,403);
 assert.equal((await update(dispatcher,'assigned',{assignee:'worker',due_at:new Date(Date.now()+86400000).toISOString()})).status,200);assert.equal((await update(worker,'in_progress')).status,200);
 assert.equal((await update(worker,'in_review',{reason:'Done'})).data.code,'EVIDENCE_REQUIRED');const photo=new FormData();photo.set('photo',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')]),'after.png');assert.equal((await call(`/orders/${order.id}/photo`,{method:'POST',cookie:worker,data:photo})).status,200);
 assert.equal((await update(worker,'in_review',{reason:'Repaired'})).status,200);assert.equal((await update(worker,'closed')).status,403);assert.equal((await update(dispatcher,'in_progress')).data.code,'REASON_REQUIRED');await update(dispatcher,'in_progress',{reason:'Finish edges'});await update(worker,'in_review',{reason:'Edges done'});assert.equal((await update(operator,'closed')).status,200);
 const real=await call('/trips',{method:'POST',cookie:operator,data:trip(false)});assert.equal((await ready(real.data.id,operator)).error,'DETECTOR_UNAVAILABLE');
 const media=await fetch(base+uploaded.data.video_uri,{headers:{cookie:operator,range:'bytes=4-7'}});assert.equal(media.status,206);assert.equal(await media.text(),'ftyp');
 await stop();await start();const newLogin=await login('operator');s=(await call('/state',{cookie:newLogin})).data;assert.equal(s.orders[0].status,'closed');assert.ok(s.orders[0].history.length>=8);assert.equal(s.candidates.length,3);
 await stop();const passwords=Object.fromEntries(['operator','dispatcher','worker','admin'].map(role=>[`${role.toUpperCase()}_PASSWORD`,`${role}-long-unique-test-secret`]));
 await start({NODE_ENV:'production',PUBLIC_ORIGIN:'https://road.example.com',...passwords});
 assert.equal((await call('/state',{cookie:newLogin})).status,401,'password rotation invalidates old sessions');
 assert.equal((await call('/login',{method:'POST',data:{username:'operator',password:'RoadDemo2026!'}})).status,401);
 assert.equal((await call('/config')).data.demoLogin,false);
 const productionLogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://road.example.com'},body:JSON.stringify({username:'operator',password:passwords.OPERATOR_PASSWORD})});
 assert.equal(productionLogin.status,200);assert.match(productionLogin.headers.get('set-cookie'),/; Secure/);
 const csrf=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal(csrf.status,403);
 assert.equal((await fetch(base+'/healthz')).status,200);
 }finally{await stop();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('road-ai-test-'));rmSync(dir,{recursive:true,force:true});}
});
