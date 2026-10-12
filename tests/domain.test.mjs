import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGPS,positionAt,groupFrames,timestamp} from '../lib/domain.mjs';
test('GPS rejects missing fields, invalid coordinates, unsorted times and missing timezone',()=>{
 for(const csv of ['lat,lon\n1,2','timestamp,lat,lon\n2026-10-12T04:00:00Z,91,4\n2026-10-12T04:00:01Z,1,2','timestamp,lat,lon\n2026-10-12T04:00:01Z,1,2\n2026-10-12T04:00:00Z,1,2'])assert.throws(()=>parseGPS(csv));
 assert.throws(()=>timestamp('2026-10-12T04:00:00'));
});
test('GPS interpolation never assigns a reliable position across gaps or unknown accuracy',()=>{
 const points=parseGPS('timestamp,lat,lon,accuracy_m\n2026-10-12T04:00:00Z,44,65,5\n2026-10-12T04:00:02Z,46,67,5');
 assert.deepEqual(positionAt(points,'2026-10-12T04:00:01Z').position,{lat:45,lon:66});
 assert.equal(positionAt(points.map(p=>({...p,accuracy_m:null})),'2026-10-12T04:00:01Z').position,null);
 assert.equal(positionAt([points[0],{...points[1],timestamp:'2026-10-12T04:00:10Z'}],'2026-10-12T04:00:01Z').quality,'gap');
 assert.equal(positionAt(points,'2026-10-12T03:59:59Z').position,null);
});
test('neighboring frames are grouped while separated detections remain distinct',()=>{
 const frames=[1000,1600,7000].map(time_ms=>({time_ms,bbox:{x:.3,y:.5}}));
 assert.deepEqual(groupFrames(frames).map(g=>g.length),[2,1]);
});
