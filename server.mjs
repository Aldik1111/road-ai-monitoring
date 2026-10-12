import './lib/env.mjs';
import http from 'node:http';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, requireValue, timestamp, parseGPS, positionAt, groupFrames } from './lib/domain.mjs';
import { runtimeConfig, requestOriginAllowed, roles } from './lib/runtime.mjs';
import {MODEL,modelReady} from './lib/model.mjs';
import {detectVideo,stopDetectors} from './lib/detector.mjs';
import {groupDetections} from './lib/detection.mjs';
import { createAssistant } from './lib/assistant.mjs';

const config = runtimeConfig();
const detectorAvailable=process.env.DETECTOR_DISABLED!=='1' && modelReady();
const root = dirname(fileURLToPath(import.meta.url));
const data = resolve(process.env.DATA_DIR || join(root, 'data/private'));
mkdirSync(join(data, 'files'), { recursive: true });
const db = new DatabaseSync(join(data, 'road.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS orders_unique (candidate_id TEXT PRIMARY KEY, order_id TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, actor TEXT, expires INTEGER);
 CREATE TABLE IF NOT EXISTS requests (actor TEXT, key TEXT, path TEXT, result TEXT, PRIMARY KEY(actor,key));`);
const all = kind => db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r => JSON.parse(r.body));
const get = (kind,id) => { const r=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id); requireValue(r, 'NOT_FOUND',404); return JSON.parse(r.body); };
const save = (kind,r) => db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind,r.id,JSON.stringify(r));
const now = () => new Date().toISOString();
for (const role of roles) {
  const existing=all('user').find(u=>u.id===role);
  if(existing && (!config.remote || timingSafeEqual(Buffer.from(existing.hash,'hex'),scryptSync(config.passwords[role],existing.salt,32)))) continue;
  const salt=randomBytes(16).toString('hex');
  save('user',{id:role,role,salt,hash:scryptSync(config.passwords[role],salt,32).toString('hex')});
  db.prepare('DELETE FROM sessions WHERE actor=?').run(role);
}
function actor(req) {
  const token = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const s = db.prepare('SELECT actor FROM sessions WHERE token=? AND expires>?').get(token || '',Date.now());
  requireValue(s,'UNAUTHORIZED',401); return get('user',s.actor);
}
function allow(user, ...permitted) { requireValue(permitted.includes(user.role),'FORBIDDEN',403); }
function event(entity, action, user, from, to, reason='') {
  entity.history ||= []; entity.history.push({entity_id:entity.id,action,actor_id:user.id,time:now(),from,to,reason});
}
async function body(req) {
  const pathname=new URL(req.url,'http://localhost').pathname;
  const limit = pathname === '/api/trips' ? (config.maxVideoMB+6)*1024*1024 : pathname.includes('/photo') ? 11*1024*1024 : 1024*1024;
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; requireValue(size<=limit,'FILE_TOO_LARGE',413); chunks.push(chunk); }
  const bytes=Buffer.concat(chunks);
  if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
    try { return await new Request('http://localhost',{method:'POST',headers:{'content-type':req.headers['content-type']},body:bytes}).formData(); }
    catch { throw new AppError('INVALID_FILE'); }
  }
  try { return bytes.length ? JSON.parse(bytes) : {}; } catch { throw new AppError('INVALID_INPUT'); }
}
const json = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
function stream(req,res,path,type) {
  const size=statSync(path).size; const range=req.headers.range;
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'};
  if (range) {
    const match=/^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {res.writeHead(416,{'Content-Range':`bytes */${size}`}); return res.end();}
    const start=Number(match[1]),end=Math.min(match[2]?Number(match[2]):size-1,size-1);
    if(start>end || start>=size) {res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
    res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});createReadStream(path,{start,end}).pipe(res);
  } else { res.writeHead(200,{...headers,'Content-Length':size}); createReadStream(path).pipe(res); }
}
function metrics() {
  const trips=all('trip'), candidates=all('candidate'),orders=all('order');
  const average=xs=>xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length):null;
  return {trips:trips.length,pending:candidates.filter(c=>c.review_status==='pending').length,
    confirmed:candidates.filter(c=>c.review_status==='confirmed').length,rejected:candidates.filter(c=>c.review_status==='rejected').length,
    merged:candidates.filter(c=>c.review_status==='merged').length,surveys:candidates.filter(c=>c.review_status==='survey_required').length,
    open:orders.filter(o=>o.status!=='closed').length,closed:orders.filter(o=>o.status==='closed').length,
    overdue:orders.filter(o=>o.status!=='closed'&&o.due_at&&Date.parse(o.due_at)<Date.now()).length,
    processing_ms:average(trips.filter(t=>t.completed_at).map(t=>Date.parse(t.completed_at)-Date.parse(t.processing_at))),
    capture_to_order_ms:average(orders.map(o=>Date.parse(o.created_at)-Date.parse(get('candidate',o.candidate_id).captured_at))),
    usable_video_ratio:null,detector:detectorAvailable?MODEL.version:'unavailable',origin:candidates.some(c=>c.origin==='model')?'mixed':'test'};
}
async function processTrip(id) {
  let trip=get('trip',id);trip.status='processing';trip.processing_at=now();trip.progress=0;trip.processed_frames=0;save('trip',trip);
  try {
    // Published results are immutable on retry: preserve operator decisions and order links.
    if(trip.result_complete){trip.status='ready';trip.progress=100;trip.error=null;save('trip',trip);return;}
    let frames;
    if(trip.demo){
      frames=[1000,1600,7000,7600,13000].filter(ms=>ms/1000<trip.duration).map((ms,i)=>({id: id+'-f'+i,trip_id:id,time_ms:ms,frame_uri:'/demo-frame.svg',bbox:{x:.37,y:.56,width:.24,height:.18},class:'pothole',score:.72+i*.04,model_version:'demo-fixture-v1',origin:'test'}));
    }else{
      requireValue(detectorAvailable,'DETECTOR_UNAVAILABLE');
      const result=await detectVideo({id,photo:trip.media_type==='photo'?join(data,'files',id+'.jpg'):null,video:join(data,'files',id+'.mp4'),output:join(data,'files'),duration:trip.duration},progress=>{
        trip.processed_frames=progress.processed_frames;trip.progress=progress.progress;save('trip',trip);
      });
      frames=result.frames;trip.processed_frames=result.processed_frames;trip.sampled_duration=result.sampled_duration;trip.model_version=MODEL.version;
    }
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const frame of frames)save('frame',frame);
      const groups=trip.demo?groupFrames(frames):groupDetections(frames);
      for(const [index,group] of groups.entries()){
        const candidateId=id+'-c'+index;
        if(all('candidate').some(c=>c.id===candidateId))continue;
        const best=group.reduce((a,b)=>a.score>b.score?a:b),captured_at=new Date(Date.parse(trip.started_at)+best.time_ms).toISOString(),pos=trip.media_type==='photo'?{position:trip.manual_position,quality:'manual'}:positionAt(trip.gps,captured_at);
        save('candidate',{id:candidateId,trip_id:id,frame_detection_ids:group.map(f=>f.id),best_frame:best,captured_at,original_position:pos.position,edited_position:null,position_quality:pos.quality,review_status:'pending',linked_defect_id:null,origin:trip.demo?'test':'model',history:[]});
      }
      trip.status='ready';trip.progress=100;trip.result_complete=true;trip.detection_count=frames.length;trip.candidate_count=groups.length;trip.completed_at=now();trip.error=null;save('trip',trip);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }catch(e){trip.status='failed';trip.error=e.code||'PROCESSING_FAILED';save('trip',trip);}
}
for(const trip of all('trip')) if(['uploaded','processing'].includes(trip.status)) {trip.status='queued';save('trip',trip);}
let processing=false;
const timer=setInterval(async()=>{if(processing)return;const trip=all('trip').find(t=>t.status==='queued');if(trip){processing=true;try{await processTrip(trip.id);}finally{processing=false;}}},500);
const loginAttempts=new Map();
const assistant=createAssistant({db,all,metrics});
const server=http.createServer(async(req,res)=>{
 try {
  res.setHeader('X-Content-Type-Options','nosniff');
  const url=new URL(req.url,'http://localhost'), path=url.pathname;
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  if(config.production) {
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Strict-Transport-Security','max-age=31536000');
  }
  if(path==='/healthz' && req.method==='GET') {db.prepare('SELECT 1').get();return json(res,200,{status:'ok'});}
  if(path==='/api/config' && req.method==='GET') return json(res,200,{demoLogin:!config.remote,maxVideoMB:config.maxVideoMB,detector:{available:detectorAvailable,model:MODEL.version,sampleFPS:MODEL.sampleFPS,threshold:MODEL.threshold}});
  if(req.method!=='GET') requireValue(requestOriginAllowed(req,config),'FORBIDDEN',403);
  if(path==='/api/login' && req.method==='POST') {
    const b=await body(req);
    // Key by account rather than a spoofable forwarded IP behind the hosting proxy.
    const ip=roles.includes(b.username)?b.username:'unknown'; const attempt=loginAttempts.get(ip)||{count:0,at:Date.now()};
    if(Date.now()-attempt.at>60000) {attempt.count=0;attempt.at=Date.now();}
    requireValue(attempt.count<20,'RATE_LIMIT',429);attempt.count++;loginAttempts.set(ip,attempt);
    const user=all('user').find(u=>u.id===b.username);
    requireValue(user && typeof b.password==='string' && b.password.length<200 && timingSafeEqual(Buffer.from(user.hash,'hex'),scryptSync(b.password,user.salt,32)),'BAD_LOGIN',401);
    const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,user.id,Date.now()+12*3600000);
    res.setHeader('Set-Cookie',`sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${config.production?'; Secure':''}`);return json(res,200,{id:user.id,role:user.role});
  }
  if(path.startsWith('/api/') || path.startsWith('/files/')) {
    const user=actor(req);
    if(path==='/api/assistant' && req.method==='GET') return json(res,200,assistant.state(user.id));
    if(path==='/api/assistant' && req.method==='POST') return json(res,200,await assistant.ask(user.id,req.headers['idempotency-key'],await body(req)));
    if(path==='/api/me') return json(res,200,{id:user.id,role:user.role});
    if(path==='/api/logout' && req.method==='POST') {db.prepare('DELETE FROM sessions WHERE token=?').run(/sid=([a-f0-9]+)/.exec(req.headers.cookie)?.[1]||'');res.setHeader('Set-Cookie','sid=; Path=/; Max-Age=0');return json(res,200,{});}
    if(path.startsWith('/files/') && req.method==='GET') {const name=path.slice(7);requireValue(/^[a-f0-9-]+\.(mp4|csv|png|jpg)$/.test(name),'NOT_FOUND',404);const file=join(data,'files',name);requireValue(existsSync(file),'NOT_FOUND',404);return stream(req,res,file,{'.mp4':'video/mp4','.csv':'text/csv','.png':'image/png','.jpg':'image/jpeg'}[extname(file)]);}
    if(req.method==='GET') {
      if(path==='/api/state') return json(res,200,{trips:all('trip').map(({gps,...t})=>t),candidates:all('candidate'),orders:all('order'),metrics:metrics(),users:all('user').map(({id,role})=>({id,role}))});
      if(path==='/api/metrics') return json(res,200,metrics());
      const match=/^\/api\/(trips|candidates|orders)(?:\/([^/]+))?$/.exec(path);
      if(match) {const kind={trips:'trip',candidates:'candidate',orders:'order'}[match[1]];return json(res,200,match[2]?get(kind,match[2]):all(kind));}
      throw new AppError('NOT_FOUND',404);
    }
    const b=await body(req), key=req.headers['idempotency-key'];
    requireValue(typeof key==='string' && key.length>=8 && key.length<=100,'IDEMPOTENCY_REQUIRED');
    const cached=db.prepare('SELECT path,result FROM requests WHERE actor=? AND key=?').get(user.id,key);
    if(cached) {requireValue(cached.path===path,'INVALID_INPUT');return json(res,200,JSON.parse(cached.result));}
    // Finish asynchronous file reads before entering the synchronous SQLite transaction.
    let videoBytes, gpsText, photoBytes, normalizedPhoto;
    if(b instanceof FormData) {
      if(path==='/api/trips') {
        const video=b.get('video'),gps=b.get('gps');
        if(video && typeof video.arrayBuffer==='function') videoBytes=Buffer.from(await video.arrayBuffer());
        if(gps && typeof gps.text==='function') gpsText=await gps.text();
      } else if(path.endsWith('/photo') || path==='/api/photos') {
        const photo=b.get('photo');if(photo && typeof photo.arrayBuffer==='function')photoBytes=Buffer.from(await photo.arrayBuffer());
      }
    }
    if(path==='/api/photos'){
      allow(user,'operator','admin');requireValue(b instanceof FormData,'INVALID_INPUT');
      const file=b.get('photo');requireValue(file && /\.(jpe?g|png)$/i.test(file.name||'') && photoBytes?.length>0,'INVALID_FILE');
      requireValue(photoBytes.length<=10*1024*1024,'FILE_TOO_LARGE',413);
      try{
        const meta=await sharp(photoBytes,{limitInputPixels:40000000}).metadata();
        requireValue(['jpeg','png'].includes(meta.format) && (meta.pages||1)===1,'INVALID_FILE');
        normalizedPhoto=await sharp(photoBytes,{limitInputPixels:40000000}).rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).flatten({background:'#727272'}).jpeg({quality:90}).toBuffer();
      }catch{throw new AppError('INVALID_FILE');}
    }
    // Another upload with the same key may have completed during the file reads.
    const completed=db.prepare('SELECT path,result FROM requests WHERE actor=? AND key=?').get(user.id,key);
    if(completed) {requireValue(completed.path===path,'INVALID_INPUT');return json(res,200,JSON.parse(completed.result));}
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      if(path==='/api/photos' && req.method==='POST'){
        allow(user,'operator','admin');
        const latText=String(b.get('lat')||'').trim(),lonText=String(b.get('lon')||'').trim(),lat=Number(latText),lon=Number(lonText);
        requireValue(latText && lonText && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180,'INVALID_INPUT');
        const route_name=String(b.get('route_name')||'').trim(),started_at=timestamp(b.get('started_at'));
        requireValue(route_name.length>0 && route_name.length<=120);
        const id=randomUUID(),photo_uri='/files/'+id+'.jpg';
        writeFileSync(join(data,'files',id+'.jpg'),normalizedPhoto);
        result={id,media_type:'photo',photo_uri,manual_position:{lat,lon},started_at,duration:0,route_name,camera_description:'',gps:[],demo:false,status:'queued',created_at:now(),error:null,history:[]};
        event(result,'upload',user,null,'queued');save('trip',result);
      }else if(path==='/api/trips' && req.method==='POST') {
        allow(user,'operator','admin');requireValue(b instanceof FormData,'INVALID_INPUT');
        const video=b.get('video'),gpsFile=b.get('gps');
        requireValue(video && typeof video.arrayBuffer==='function' && /\.mp4$/i.test(video.name) && video.size>12,'INVALID_FILE');
        requireValue(video.size<=config.maxVideoMB*1024*1024,'FILE_TOO_LARGE',413);
        requireValue(gpsFile && typeof gpsFile.text==='function' && /\.csv$/i.test(gpsFile.name) && gpsFile.size<=5*1024*1024,'INVALID_GPS');
        const bytes=videoBytes;requireValue(bytes.toString('ascii',4,8)==='ftyp','INVALID_FILE');
        const gps=parseGPS(gpsText),started_at=timestamp(b.get('started_at')),duration=Number(b.get('duration'));
        requireValue(Number.isFinite(duration)&&duration>=2&&duration<=600,'INVALID_DURATION');
        requireValue(Math.abs(Date.parse(gps[0].timestamp)-Date.parse(started_at))<=2000 && Date.parse(gps.at(-1).timestamp)>=Date.parse(started_at)+1000,'TIME_MISMATCH');
        const route_name=String(b.get('route_name')||'').trim(),camera_description=String(b.get('camera_description')||'').trim();
        requireValue(route_name.length>0&&route_name.length<=120&&camera_description.length>0&&camera_description.length<=300);
        const id=randomUUID(),video_uri=`/files/${id}.mp4`,gps_uri=`/files/${id}.csv`;
        writeFileSync(join(data,'files',`${id}.mp4`),bytes);writeFileSync(join(data,'files',`${id}.csv`),gpsText);
        result={id,video_uri,gps_uri,started_at,duration,route_name,camera_description,gps,demo:b.get('demo')==='true',status:'queued',created_at:now(),error:null,history:[]};
        event(result,'upload',user,null,'queued');save('trip',result);
      } else if(/^\/api\/trips\/[^/]+\/retry$/.test(path) && req.method==='POST') {
        allow(user,'operator','admin');result=get('trip',path.split('/')[3]);requireValue(['failed','ready'].includes(result.status),'INVALID_TRANSITION',409);
        event(result,'retry',user,result.status,'queued');result.status='queued';result.error=null;save('trip',result);
      } else if(/^\/api\/candidates\/[^/]+\/(decision|position)$/.test(path) && req.method==='POST') {
        allow(user,'operator','admin');result=get('candidate',path.split('/')[3]);
        if(path.endsWith('/position')) {
          requireValue(typeof b.lat==='number'&&typeof b.lon==='number'&&Number.isFinite(b.lat)&&Number.isFinite(b.lon)&&Math.abs(b.lat)<=90&&Math.abs(b.lon)<=180);
          requireValue(typeof b.reason==='string'&&b.reason.trim().length>0,'REASON_REQUIRED');
          event(result,'position',user,result.edited_position||result.original_position,{lat:b.lat,lon:b.lon},b.reason);result.edited_position={lat:b.lat,lon:b.lon};
        } else {
          requireValue(['confirmed','rejected','merged','survey_required'].includes(b.decision));
          if(result.review_status!==b.decision) {
            requireValue(['pending','survey_required'].includes(result.review_status),'INVALID_TRANSITION',409);
            if(b.decision!=='confirmed') requireValue(typeof b.reason==='string'&&b.reason.trim(),'REASON_REQUIRED');
            if(b.decision==='merged') {const target=get('candidate',b.target_id);requireValue(target.id!==result.id&&target.review_status==='confirmed','INVALID_TARGET');result.linked_defect_id=target.id;}
            if(b.decision==='confirmed') {
              const order={id:randomUUID(),candidate_id:result.id,kind:'repair',status:'new',assignee:null,due_at:null,created_at:now(),after_photo:null,comments:[],history:[]};
              db.prepare('INSERT INTO orders_unique VALUES(?,?)').run(result.id,order.id);event(order,'create',user,null,'new');save('order',order);result.linked_defect_id=result.id;
            }
            event(result,'decision',user,result.review_status,b.decision,b.reason||'');result.review_status=b.decision;
          }
        }
        save('candidate',result);
      } else if(/^\/api\/orders\/[^/]+\/photo$/.test(path) && req.method==='POST') {
        allow(user,'worker');result=get('order',path.split('/')[3]);requireValue(result.assignee===user.id,'FORBIDDEN',403);requireValue(result.status==='in_progress','INVALID_TRANSITION',409);
        requireValue(b instanceof FormData,'INVALID_FILE');const photo=b.get('photo');requireValue(photo && typeof photo.arrayBuffer==='function' && photo.size<=8*1024*1024,'INVALID_FILE');
        const bytes=photoBytes;const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;requireValue(png||jpg,'INVALID_FILE');
        const name=`${randomUUID()}.${png?'png':'jpg'}`;writeFileSync(join(data,'files',name),bytes);result.after_photo=`/files/${name}`;event(result,'photo',user,result.status,result.status);save('order',result);
      } else if(/^\/api\/orders\/[^/]+$/.test(path) && req.method==='PATCH') {
        result=get('order',path.split('/')[3]);const from=result.status,to=b.status;
        if(to==='assigned') {allow(user,'dispatcher','admin');requireValue(['new','assigned'].includes(from),'INVALID_TRANSITION',409);requireValue(get('user',b.assignee).role==='worker');result.assignee=b.assignee;result.due_at=timestamp(b.due_at);requireValue(Date.parse(result.due_at)>Date.now(),'INVALID_TIME');}
        else if(from==='assigned'&&to==='in_progress' || from==='in_progress'&&to==='in_review') {allow(user,'worker');requireValue(result.assignee===user.id,'FORBIDDEN',403);if(to==='in_review') requireValue(result.after_photo&&typeof b.reason==='string'&&b.reason.trim(),'EVIDENCE_REQUIRED');}
        else if(from==='in_review'&&['closed','in_progress'].includes(to)) {allow(user,'operator','dispatcher','admin');if(to==='in_progress') requireValue(typeof b.reason==='string'&&b.reason.trim(),'REASON_REQUIRED');}
        else throw new AppError('INVALID_TRANSITION',409);
        event(result,'status',user,from,to,b.reason||'');result.status=to;if(b.reason)result.comments.push({actor_id:user.id,time:now(),text:b.reason});save('order',result);
      } else throw new AppError('NOT_FOUND',404);
      db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(user.id,key,path,JSON.stringify(result));db.exec('COMMIT');
    } catch(e) {db.exec('ROLLBACK');throw e;}
    return json(res,200,result);
  }
  requireValue(req.method==='GET','NOT_FOUND',404);
  const staticFiles={'/':'index.html','/assistant-ui.js':'assistant-ui.js','/app.js':'app.js','/style.css':'style.css','/demo-frame.svg':'demo-frame.svg','/sample-gps.csv':'sample-gps.csv'};
  requireValue(staticFiles[path],'NOT_FOUND',404);
  const file=join(root,'public',staticFiles[path]);return stream(req,res,file,{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.csv':'text/csv'}[extname(file)]);
 } catch(e) {if(!res.headersSent)json(res,e.status||500,{code:e.code||'SERVER_ERROR',message:e.code||'SERVER_ERROR',retryable:!e.status});else res.end();if(!e.status)console.error(e);}
});
server.listen(Number(process.env.PORT||3000),config.host,()=>console.log(`Road AI: ${config.origin || `http://${config.host}:${server.address().port}`} [port=${server.address().port}]`));
function shutdown(){clearInterval(timer);stopDetectors();server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
