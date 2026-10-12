import {readFileSync,writeFileSync} from 'node:fs';
const directory=new URL('./data/private/',import.meta.url);
try {
  const state=JSON.parse(readFileSync(new URL('share-state.json',directory),'utf8'));
  if(state.status==='stopped') console.log('The tunnel is already stopped.');
  else if(state.stopToken) {writeFileSync(new URL('share-stop.txt',directory),state.stopToken);console.log('Stop requested. The tunnel and server will stop within one second.');}
  else throw new Error('Older launcher: stop with Ctrl+C in its terminal.');
} catch(error) {console.error(error.message);process.exitCode=1;}
