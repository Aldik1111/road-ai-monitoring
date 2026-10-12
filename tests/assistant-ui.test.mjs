import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

test('chat sends selected language, escapes model text, restores history and clears account state',async()=>{
  const listeners={}, posted=[], history=[];let locale='ru', redraws=0;
  const context={console,AbortSignal,crypto:{randomUUID},document:{addEventListener:(type,fn)=>listeners[type]=fn},FormData:class {get(){return 'Как загрузить видео?';}},
    fetch:async(_,options)=>{
      if(options?.method==='POST') {posted.push(JSON.parse(options.body));const r={question:posted[0].question,answer:'<script>bad()</script>'};history.push(r);return Response.json(r);}
      return Response.json({configured:true,model:'test-model',dailyLimit:50,remaining:49,history});
    },
    getUser:()=>({id:'operator'}),getLanguage:()=>locale,escape:v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'),redraw:()=>redraws++};
  vm.createContext(context);
  vm.runInContext(readFileSync('public/assistant-ui.js','utf8')+'\nglobalThis.ui=createAssistantUI({getUser,getLanguage,escape,redraw});',context);
  await context.ui.load();assert.match(context.ui.view(),/Отправить/);
  locale='kk';assert.match(context.ui.view(),/Жіберу/);
  listeners.submit({target:{id:'assistant-form'},preventDefault(){}});
  for(let i=0;i<20 && redraws<2;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(posted.length,1);assert.equal(posted[0].language,'kk');
  assert.match(context.ui.view(),/&lt;script&gt;/);assert.doesNotMatch(context.ui.view(),/<script>/);
  context.ui.reset();assert.doesNotMatch(context.ui.view(),/bad\(\)/);
});
