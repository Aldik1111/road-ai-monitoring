import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AppError} from './domain.mjs';

const workers=new Set();
export function stopDetectors(){for(const worker of workers)worker.disconnect();}
export function detectVideo(options,onProgress){
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(key.toUpperCase())));
    const worker=fork(fileURLToPath(new URL('./detector-worker.mjs',import.meta.url)),[],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    workers.add(worker);let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timeout);workers.delete(worker);if(error){if(worker.connected)worker.disconnect();reject(new AppError(error));}else resolve(result);};
    const timeout=setTimeout(()=>finish('DETECTOR_TIMEOUT'),15*60*1000);
    worker.on('error',()=>finish('DETECTOR_FAILED'));
    worker.on('exit',()=>finish('DETECTOR_FAILED'));
    worker.on('message',message=>{
      if(settled)return;
      if(message.type==='progress')onProgress(message);
      if(message.type==='error')finish(message.code);
      if(message.type==='result')finish(null,message);
    });
    worker.send(options);
  });
}
