import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('all screens render in both languages with empty and populated server state',()=>{
 const source=readFileSync('public/app.js','utf8').split('try{publicConfig=await api')[0];
 const elements={'#app':{innerHTML:''},'#toast':{style:{}}};
 const context={localStorage:{getItem:()=>null},document:{documentElement:{},querySelector:s=>elements[s]||null,addEventListener:()=>{}},setTimeout:()=>{},console};
 vm.createContext(context);vm.runInContext(source,context);
 vm.runInContext(`
   if(JSON.stringify(Object.keys(dictionary.ru).sort())!==JSON.stringify(Object.keys(dictionary.kk).sort()))throw new Error('Translation keys differ');
   const trip={id:'trip1',route_name:'<script>unsafe</script>',camera_description:'Camera',created_at:'2026-10-12T04:00:00Z',started_at:'2026-10-12T04:00:00Z',video_uri:'/files/demo.mp4',demo:true,status:'ready'};
   const c={id:'candidate1',trip_id:'trip1',best_frame:{frame_uri:'/demo-frame.svg',time_ms:1600,score:.8,model_version:'demo-fixture-v1'},frame_detection_ids:['frame1','frame2'],original_position:{lat:44.8,lon:65.4},edited_position:null,position_quality:'approximate',review_status:'pending',history:[]};
   const o={id:'order1',candidate_id:'candidate1',status:'new',assignee:'worker',history:[],comments:[]};
   state={trips:[trip],candidates:[c],orders:[o],metrics:{trips:1,pending:1,open:1,closed:0,confirmed:0,rejected:0,merged:0,surveys:0,processing_ms:2}};
   for(const locale of ['kk','ru']) {
     lang=locale;user=null;render();
     for(const role of ['operator','dispatcher','worker','admin']) {
       user={id:role,role};
       for(const screen of ['overview','trips','upload','queue','candidate','orders','order','trip']) {
         page=screen;selected=screen==='candidate'?c.id:screen==='order'?o.id:trip.id;
         render();
         if(document.querySelector('#app').innerHTML.includes('<script>unsafe</script>'))throw new Error('Unescaped user content');
       }
       for(const status of ['assigned','in_progress','in_review','closed']) {o.status=status;page='order';selected=o.id;render();}
     }
     state={trips:[],candidates:[],orders:[],metrics:{trips:0,pending:0,open:0,closed:0,confirmed:0,rejected:0,merged:0,surveys:0,processing_ms:null}};
     for(const screen of ['overview','trips','queue','orders']){page=screen;render();}
     state={trips:[trip],candidates:[c],orders:[o],metrics:{trips:1,pending:1,open:1,closed:0,confirmed:0,rejected:0,merged:0,surveys:0,processing_ms:2}};
   }
 `,context);
 assert.equal(context.document.documentElement.lang,'ru');
});
