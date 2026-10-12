import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {MODEL,modelPath,modelReady} from './lib/model.mjs';

if(modelReady()) console.log('Pothole model is installed and verified.');
else {
  const url=`https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${MODEL.file}`;
  console.log('Downloading pinned pothole ONNX model (10.5 MB)...');
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Model download failed: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==MODEL.sha256)throw new Error('Model checksum mismatch');
  mkdirSync(dirname(modelPath),{recursive:true});writeFileSync(modelPath+'.download',bytes);renameSync(modelPath+'.download',modelPath);
  console.log('Model verified and installed.');
}
