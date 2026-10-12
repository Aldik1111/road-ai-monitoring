import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import {modelReady,MODEL} from '../lib/model.mjs';

test('real video upload and GPS → async detector → persisted empty result; retry and web responsiveness',{skip:!modelReady(),timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'road-detector-api-'));let child;
 try{
  const video=join(dir,'fixture.mp4');
  assert.equal(spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=640x360:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true}).status,0);
  child=spawn(process.execPath,['server.mjs'],{env:{...process.env,ROAD_AI_SKIP_ENV:'1',OPENAI_API_KEY:'',DETECTOR_DISABLED:'0',NODE_ENV:'development',HOST:'127.0.0.1',PUBLIC_ORIGIN:'',PORT:'0',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);child.stdout.on('data',chunk=>{const port=/port=(\d+)/.exec(chunk);if(port){clearTimeout(timer);resolve('http://127.0.0.1:'+port[1]);}});child.once('error',reject);});
  let cookie;
  async function call(path,method='GET',data){const r=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'Idempotency-Key':randomUUID()}:{}),...(data&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{})},body:data instanceof FormData?data:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  cookie=(await call('/api/login','POST',{username:'operator',password:'RoadDemo2026!'})).cookie;
  assert.equal((await call('/api/config')).data.detector.available,true);
  const form=new FormData();form.set('video',new Blob([readFileSync(video)],{type:'video/mp4'}),'fixture.mp4');
  form.set('gps',new Blob(['timestamp,lat,lon,accuracy_m\n2026-10-12T04:00:00Z,44,65,5\n2026-10-12T04:00:02Z,44.001,65.001,5']),'gps.csv');
  Object.entries({started_at:'2026-10-12T04:00:00Z',duration:'2',route_name:'Synthetic blank test, no real road',camera_description:'Test video',demo:'false'}).forEach(([k,v])=>form.set(k,v));
  const uploaded=await call('/api/trips','POST',form);assert.equal(uploaded.status,200);
  let ready;for(let i=0;i<100;i++){ready=(await call('/api/trips/'+uploaded.data.id)).data;assert.notEqual(ready.status,'failed',ready.error);assert.equal((await call('/healthz')).status,200);if(ready.status==='ready')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(ready.status,'ready');assert.equal(ready.demo,false);assert.equal(ready.model_version,MODEL.version);assert.equal(ready.candidate_count,0);assert.equal(ready.progress,100);assert.equal(ready.processed_frames,4);
  const image=await sharp({create:{width:800,height:450,channels:3,background:'#000000'}}).png().toBuffer();
  function photo(bytes=image){const f=new FormData();f.set('photo',new Blob([bytes],{type:'image/png'}),'road.png');f.set('lat','44.8');f.set('lon','65.4');f.set('route_name','Photo test');f.set('started_at','2026-10-12T04:00:00Z');return f;}
  assert.equal((await call('/api/photos','POST',photo(Buffer.from('invalid')))).status,400);
  const badCoords=photo();badCoords.set('lat','');assert.equal((await call('/api/photos','POST',badCoords)).status,400);
  const savedCookie=cookie;cookie=(await call('/api/login','POST',{username:'worker',password:'RoadDemo2026!'})).cookie;
  assert.equal((await call('/api/photos','POST',photo())).status,403);cookie=savedCookie;
  const uploadedPhoto=await call('/api/photos','POST',photo());assert.equal(uploadedPhoto.status,200);assert.equal(uploadedPhoto.data.media_type,'photo');assert.deepEqual(uploadedPhoto.data.manual_position,{lat:44.8,lon:65.4});
  let photoReady;for(let i=0;i<100;i++){photoReady=(await call('/api/trips/'+uploadedPhoto.data.id)).data;assert.notEqual(photoReady.status,'failed',photoReady.error);if(photoReady.status==='ready')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(photoReady.status,'ready');assert.equal(photoReady.processed_frames,1);assert.equal(photoReady.candidate_count,0);assert.equal(photoReady.demo,false);
  const photoResponse=await fetch(base+photoReady.photo_uri,{headers:{cookie}});assert.equal(photoResponse.status,200);
  const metadata=await sharp(Buffer.from(await photoResponse.arrayBuffer())).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.exif,undefined);
  await call('/api/trips/'+ready.id+'/retry','POST',{});await new Promise(r=>setTimeout(r,650));
  const state=(await call('/api/state')).data;assert.equal(state.trips[0].status,'ready');assert.equal(state.candidates.length,0);
 }finally{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}rmSync(dir,{recursive:true,force:true});}
});
