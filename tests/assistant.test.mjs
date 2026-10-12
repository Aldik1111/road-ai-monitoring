import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {assistantConfig, createAssistant, askOpenAI, projectContext} from '../lib/assistant.mjs';

const all=kind=>kind==='trip'?[{id:'t1',route_name:'Demo road',status:'ready',demo:true,gps:['private'],password:'secret',video_uri:'/private'}]:[];
const metrics=()=>({trips:1,detector:'unavailable',origin:'test'});
const config={apiKey:'fake-test-only',model:'gpt-4.1-mini',dailyLimit:3};
test('assistant limits, actor isolation, durable history and idempotent retries',async()=>{
  const db=new DatabaseSync(':memory:');let calls=0;
  const provider=async()=>{calls++;return {answer:'Тестовые данные',model:config.model};};
  const service=createAssistant({db,all,metrics,config,provider});
  const b={question:'Какие поездки?',language:'ru'};
  const result=await service.ask('operator','request-1',b);
  assert.equal(result.answer,'Тестовые данные');
  assert.deepEqual(await service.ask('operator','request-1',b),result);assert.equal(calls,1);
  assert.equal(service.state('operator').history.length,1);assert.equal(service.state('worker').history.length,0);
  await assert.rejects(service.ask('operator','request-1',{...b,question:'different'}),{code:'INVALID_INPUT'});
  await assert.rejects(service.ask('operator','request-x',{...b,language:'xx'}),{code:'INVALID_INPUT'});
  await assert.rejects(service.ask('operator','request-x',{...b,question:'a'.repeat(2001)}),{code:'INVALID_INPUT'});
  await service.ask('worker','request-1',b);await service.ask('operator','request-2',b);
  await assert.rejects(service.ask('operator','request-3',b),{code:'ASSISTANT_LIMIT'});
  const restarted=createAssistant({db,all,metrics,config,provider});
  assert.equal(restarted.state('operator').history.length,2);assert.equal(restarted.state('worker').remaining,0);
  assert.equal(JSON.stringify(restarted.state('operator')).includes(config.apiKey),false);db.close();
});
test('concurrency reserves budget, provider failures are sanitized and retries are not billed again',async()=>{
  const db=new DatabaseSync(':memory:');let release;
  const service=createAssistant({db,all,metrics,config,provider:()=>new Promise((_,reject)=>{release=reject;})});
  const b={question:'Сұрақ',language:'kk'};
  const first=service.ask('operator','request-1',b);
  await assert.rejects(service.ask('operator','request-1',b),{code:'ASSISTANT_BUSY'});
  await assert.rejects(service.ask('operator','request-2',b),{code:'ASSISTANT_BUSY'});
  assert.equal(service.state('operator').remaining,2);
  release(new Error('secret provider payload'));
  await assert.rejects(first,{code:'ASSISTANT_PROVIDER'});
  await assert.rejects(service.ask('operator','request-1',b),{code:'ASSISTANT_PROVIDER'});
  assert.equal(service.state('operator').remaining,2);db.close();
});
test('OpenAI request uses bounded read-only context, selected language, no storage and correct text extraction',async()=>{
  const context=projectContext(all,metrics);
  assert.equal(JSON.stringify(context).includes('private'),false);assert.equal(JSON.stringify(context).includes('secret'),false);
  const result=await askOpenAI({config,question:'Сұрақ',language:'kk',context,history:[]},async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const request=JSON.parse(options.body);
    assert.equal(request.store,false);assert.equal(request.max_output_tokens,800);assert.match(request.instructions,/Kazakh/);
    assert.match(request.instructions,/Accuracy on local roads is not measured/);assert.equal(request.tools,undefined);
    return Response.json({status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:'Жауап'}]}],usage:{input_tokens:30,output_tokens:5}});
  });
  assert.equal(result.answer,'Жауап');assert.equal(result.usage.output_tokens,5);
  for(const [status,code] of [[401,'ASSISTANT_KEY'],[429,'ASSISTANT_RATE'],[404,'ASSISTANT_MODEL'],[500,'ASSISTANT_PROVIDER']]) {
    await assert.rejects(askOpenAI({config,question:'q',language:'ru',context,history:[]},async()=>Response.json({error:{message:'secret'}},{status})),{code});
  }
  await assert.rejects(askOpenAI({config,question:'q',language:'ru',context,history:[]},async()=>Response.json({status:'incomplete',output:[]})),{code:'ASSISTANT_INCOMPLETE'});
});
test('missing key disables paid requests and invalid configuration fails closed',async()=>{
  const db=new DatabaseSync(':memory:');const service=createAssistant({db,all,metrics,config:{...config,apiKey:''}});
  assert.equal(service.state('admin').configured,false);
  await assert.rejects(service.ask('admin','request-1',{question:'q',language:'ru'}),{code:'ASSISTANT_NOT_CONFIGURED'});
  assert.equal(service.state('admin').remaining,3);
  assert.throws(()=>assistantConfig({ASSISTANT_DAILY_LIMIT:'NaN'}));db.close();
});
