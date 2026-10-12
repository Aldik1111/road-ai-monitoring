import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import {MODEL,modelPath,modelReady} from './model.mjs';
import {decodeDetections} from './detection.mjs';

let decoder;
process.on('disconnect',()=>{decoder?.kill();process.exit(1);});
process.on('SIGTERM',()=>{decoder?.kill();process.exit(1);});
process.once('message',async({id,video,output,duration})=>{
  let session;
  try{
    if(!modelReady())throw new Error('DETECTOR_UNAVAILABLE');
    sharp.concurrency(1);
    session=await ort.InferenceSession.create(modelPath,{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});
    decoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-threads','1','-filter_threads','1','-i',video,'-t','601','-map','0:v:0','-an','-sn','-dn','-vf','fps=2:start_time=0,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=0x727272,setsar=1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    decoder.stderr.resume(); // Decoder diagnostics are not exposed to clients.
    const exited=new Promise(resolve=>{decoder.once('error',()=>resolve(-1));decoder.once('close',resolve);});
    const frameBytes=640*640*3,frames=[];let pending=Buffer.alloc(0),index=0;
    for await(const chunk of decoder.stdout){
      pending=Buffer.concat([pending,chunk]);
      while(pending.length>=frameBytes){
        const rgb=pending.subarray(0,frameBytes);pending=pending.subarray(frameBytes);
        if(index>=1200)throw new Error('INVALID_DURATION');
        const resized=await sharp(rgb,{raw:{width:640,height:640,channels:3}}).resize(320,320,{kernel:'linear'}).raw().toBuffer();
        const input=new Float32Array(3*320*320);
        for(let p=0;p<320*320;p++)for(let c=0;c<3;c++)input[c*320*320+p]=resized[p*3+c]/255;
        const result=await session.run({images:new ort.Tensor('float32',input,[1,3,320,320])});
        const detections=decodeDetections(result[session.outputNames[0]],MODEL.threshold);
        if(frames.length+detections.length>2000)throw new Error('DETECTOR_TOO_MANY');
        if(detections.length){
          const filename=createHash('sha256').update(`${id}:${index}`).digest('hex')+'.jpg';
          writeFileSync(join(output,filename),await sharp(rgb,{raw:{width:640,height:640,channels:3}}).jpeg({quality:85}).toBuffer());
          detections.forEach((d,n)=>frames.push({id:`${id}-f${index}-${n}`,trip_id:id,time_ms:index*500,frame_uri:`/files/${filename}`,bbox:d.bbox,class:'pothole',score:d.score,model_version:MODEL.version,origin:'model'}));
        }
        index++;
        if(index===1||index%10===0)process.send?.({type:'progress',processed_frames:index,progress:Math.min(99,Math.round(index/(duration*2)*100))});
      }
    }
    const exit=await exited;
    if(exit!==0||pending.length||index<4)throw new Error('DETECTOR_VIDEO');
    process.send?.({type:'result',frames,processed_frames:index,sampled_duration:index/2});
  }catch(error){
    const allowed=['DETECTOR_UNAVAILABLE','DETECTOR_MODEL_FORMAT','INVALID_DURATION','DETECTOR_TOO_MANY','DETECTOR_VIDEO'];
    process.send?.({type:'error',code:allowed.includes(error.message)?error.message:'DETECTOR_FAILED'});
  }finally{decoder?.kill();await session?.release();process.disconnect();}
});
