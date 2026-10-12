import { test } from 'node:test';
import assert from 'node:assert/strict';
import {runtimeConfig,requestOriginAllowed,roles} from '../lib/runtime.mjs';

const secure = () => ({NODE_ENV:'production',PUBLIC_ORIGIN:'https://road.example.com',...Object.fromEntries(roles.map(role=>[`${role.toUpperCase()}_PASSWORD`,`${role}-unique-long-test-password`]))});
test('public startup rejects missing credentials, shared passwords and HTTP origin',()=>{
 assert.throws(()=>runtimeConfig({NODE_ENV:'production'}),/ORIGIN/);
 assert.throws(()=>runtimeConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://road.example.com'}),/OPERATOR_PASSWORD/);
 assert.throws(()=>runtimeConfig({...secure(),PUBLIC_ORIGIN:'http://road.example.com'}),/HTTPS/);
 assert.throws(()=>runtimeConfig({...secure(),WORKER_PASSWORD:'RoadDemo2026!'}),/WORKER_PASSWORD/);
 assert.throws(()=>runtimeConfig({...secure(),WORKER_PASSWORD:secure().ADMIN_PASSWORD}),/different passwords/);
 assert.throws(()=>runtimeConfig({HOST:'0.0.0.0'}),/OPERATOR_PASSWORD/);
});
test('HTTPS reverse proxy requests use configured public origin rather than forwarded headers',()=>{
 const config=runtimeConfig(secure());
 assert.equal(config.host,'0.0.0.0');assert.equal(config.maxVideoMB,32);
 assert.equal(requestOriginAllowed({headers:{host:'internal:10000',origin:'https://road.example.com'}},config),true);
 assert.equal(requestOriginAllowed({headers:{host:'internal:10000',origin:'https://evil.example','x-forwarded-host':'evil.example'}},config),false);
 assert.equal(runtimeConfig({...secure(),PUBLIC_ORIGIN:'',RENDER_EXTERNAL_URL:'https://road.onrender.com'}).origin,'https://road.onrender.com');
 assert.equal(runtimeConfig({}).host,'127.0.0.1');
});
