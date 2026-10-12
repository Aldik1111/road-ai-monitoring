import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const MODEL={
  repository:'tahaUgan/pothole-yolo11n', revision:'5cc2892b1366ca3c70d4ef4b13f1a940dddb2cc5',
  file:'pothole2v_320.onnx', sha256:'c91b4211d06c915ae94519de9def87461703d612569d3ce239bf69bd7baa8c26',
  version:'tahaUgan-yolo11n-5cc2892-320', license:'CC-BY-4.0 (publisher declaration)',
  threshold:0.45, inputSize:320, sampleFPS:2
};
export const modelPath=fileURLToPath(new URL('../models/pothole2v_320.onnx',import.meta.url));
export function modelReady(){return existsSync(modelPath) && createHash('sha256').update(readFileSync(modelPath)).digest('hex')===MODEL.sha256;}
