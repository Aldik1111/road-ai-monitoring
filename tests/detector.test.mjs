import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeDetections,groupDetections} from '../lib/detection.mjs';
import {detectVideo} from '../lib/detector.mjs';
import {modelReady,MODEL} from '../lib/model.mjs';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

test('YOLO decoding excludes manholes, suppresses duplicate boxes and rejects incompatible exports',()=>{
 const data=new Float32Array(6*2100);
 const box=(index,values)=>values.forEach((v,c)=>data[c*2100+index]=v);
 box(0,[160,160,80,80,.9,.1]);box(1,[161,160,80,80,.8,.1]);
 box(2,[60,60,40,40,.7,.9]);box(3,[290,290,40,40,.8,.1]);
 const result=decodeDetections({dims:[1,6,2100],data});
 assert.equal(result.length,2);assert.equal(result[0].bbox.x,.375);assert.equal(result[0].bbox.width,.25);
 assert.throws(()=>decodeDetections({dims:[1,84,2100],data}),/DETECTOR_MODEL_FORMAT/);
});
test('tracking keeps two nearby simultaneous potholes separate and joins consecutive matches',()=>{
 const a={x:.2,y:.4,width:.2,height:.2},b={x:.6,y:.4,width:.2,height:.2};
 const frames=[{time_ms:0,bbox:a},{time_ms:0,bbox:b},{time_ms:500,bbox:b},{time_ms:500,bbox:a},{time_ms:4000,bbox:a}];
 assert.deepEqual(groupDetections(frames).map(g=>g.length),[2,2,1]);
});
test('real FFmpeg + ONNX inference processes video, reports progress and rejects corrupt MP4',{skip:!modelReady(),timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'road-detector-'));
 try{
  const video=join(dir,'fixture.mp4');
  const encoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=640x360:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true});
  assert.equal(encoded.status,0,encoded.stderr.toString());
  const progress=[];const result=await detectVideo({id:'test',video,output:dir,duration:2},p=>progress.push(p));
  assert.equal(result.processed_frames,4);assert.equal(result.frames.length,0);assert.ok(progress.length>0);
  writeFileSync(video,'0000ftypisom invalid data');
  await assert.rejects(detectVideo({id:'bad',video,output:dir,duration:2},()=>{}),{code:'DETECTOR_VIDEO'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
