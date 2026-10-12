import './lib/env.mjs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';

const root=dirname(fileURLToPath(import.meta.url));
const privateDir=join(root,'data','private');
mkdirSync(privateDir,{recursive:true});
const executable=process.env.CLOUDFLARED_PATH || join(root,'.tools','cloudflared.exe');
if(!existsSync(executable)) {
  if(process.platform!=='win32' || process.arch!=='x64') throw new Error('Set CLOUDFLARED_PATH to your installed cloudflared executable');
  console.log('Downloading official Cloudflare cloudflared for Windows...');
  const releaseResponse=await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest');
  if(!releaseResponse.ok) throw new Error('Cannot obtain official Cloudflare release');
  const release=await releaseResponse.json();
  const asset=release.assets.find(a=>a.name==='cloudflared-windows-amd64.exe');
  if(!asset?.digest?.startsWith('sha256:')) throw new Error('Release has no SHA256 digest');
  const response=await fetch(asset.browser_download_url);
  if(!response.ok) throw new Error('Download failed');
  const bytes=Buffer.from(await response.arrayBuffer());
  if('sha256:'+createHash('sha256').update(bytes).digest('hex')!==asset.digest) throw new Error('Cloudflare download checksum mismatch');
  mkdirSync(dirname(executable),{recursive:true});writeFileSync(executable,bytes);
}

const port=Number(process.env.SHARE_PORT||3010);
await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error(`Port ${port} is busy. Stop the previous share process first.`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
const passwordPath=join(privateDir,'share-passwords.json');
const roleNames=['operator','dispatcher','worker','admin'];
let passwords;
if(existsSync(passwordPath)) passwords=JSON.parse(readFileSync(passwordPath,'utf8'));
else { passwords=Object.fromEntries(roleNames.map(role=>[role,randomBytes(24).toString('base64url')]));writeFileSync(passwordPath,JSON.stringify(passwords,null,2),{mode:0o600}); }
for(const role of roleNames) if(typeof passwords[role]!=='string'||passwords[role].length<16)throw new Error('Invalid saved share passwords');
let server,stopping=false,stopPoll;
const stopToken=randomBytes(16).toString('hex');
const tunnel=spawn(executable,['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`,'--protocol','http2'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
const statePath=join(privateDir,'share-state.json');
function saveState(status,url=null){writeFileSync(statePath,JSON.stringify({status,url,pid:process.pid,tunnelPid:tunnel.pid,serverPid:server?.pid,port,stopToken,updated_at:new Date().toISOString()},null,2));}
saveState('connecting');
function stop(code=0){if(stopping)return;stopping=true;clearTimeout(timeout);clearInterval(stopPoll);server?.kill();tunnel.kill();saveState('stopped');process.exitCode=code;}
const timeout=setTimeout(()=>{console.error('Cloudflare did not provide a URL within 60 seconds.');stop(1);},60000);
stopPoll=setInterval(()=>{try{if(readFileSync(join(privateDir,'share-stop.txt'),'utf8')===stopToken)stop();}catch{}},1000);
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
tunnel.on('error',error=>{console.error(error.message);stop(1);});
tunnel.on('exit',code=>{if(!stopping){console.error('Tunnel exited:',code);stop(code||1);}});
let logBuffer='',started=false;
async function inspect(chunk){
  const text=chunk.toString();process.stdout.write(text);logBuffer=(logBuffer+text).slice(-12000);
  const url=logBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
  if(started||!url)return;started=true;clearTimeout(timeout);
  const env={...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:url,DATA_DIR:privateDir,MAX_VIDEO_MB:'32',...Object.fromEntries(roleNames.map(role=>[role.toUpperCase()+'_PASSWORD',passwords[role]]))};
  server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>process.stdout.write(chunk));server.stderr.on('data',chunk=>process.stderr.write(chunk));
  server.on('error',error=>{console.error(error.message);stop(1);});server.on('exit',code=>{if(!stopping){console.error('Application exited:',code);stop(code||1);}});
  saveState('starting',url);
  for(let i=0;i<40&&!stopping;i++) {
    try {const r=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)});if(r.ok){
      saveState('running',url);
      const accessPath=join(privateDir,'SHARE-ACCESS.txt');
      writeFileSync(accessPath,`Road AI — private access details\n\nURL: ${url}\n\n${roleNames.map(role=>`${role}: ${passwords[role]}`).join('\n')}\n\nShare only the password for the required role. Keep admin private.\nThe computer, application and tunnel must stay running.\n`,{mode:0o600});
      console.log(`\nShare URL: ${url}\nPasswords: ${accessPath}\nKeep this process running. Press Ctrl+C to stop.\n`);return;
    }}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!stopping){console.error('Application health check failed');stop(1);}
}
tunnel.stdout.on('data',chunk=>{inspect(chunk).catch(error=>{console.error(error.message);stop(1);});});
tunnel.stderr.on('data',chunk=>{inspect(chunk).catch(error=>{console.error(error.message);stop(1);});});
