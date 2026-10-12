export function iou(a,b){
  const intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return intersection/(a.width*a.height+b.width*b.height-intersection || 1);
}
// YOLO11 export: [1, 4 + 2 classes, 2100 anchors], pixel xywh, no objectness channel.
export function decodeDetections(tensor,threshold=0.45){
  if(tensor.dims.length!==3 || tensor.dims[0]!==1 || tensor.dims[1]!==6 || tensor.dims[2]!==2100)throw new Error('DETECTOR_MODEL_FORMAT');
  const values=tensor.data,n=tensor.dims[2],boxes=[];
  for(let i=0;i<n;i++){
    const score=values[4*n+i],other=values[5*n+i];
    if(!Number.isFinite(score) || score<threshold || other>score)continue;
    const [cx,cy,w,h]=[values[i],values[n+i],values[2*n+i],values[3*n+i]].map(v=>v/320);
    if(![cx,cy,w,h].every(Number.isFinite)||w<=0||h<=0)continue;
    const x=Math.max(0,cx-w/2),y=Math.max(0,cy-h/2),right=Math.min(1,cx+w/2),bottom=Math.min(1,cy+h/2);
    if(right<=x||bottom<=y)continue;
    boxes.push({score,bbox:{x,y,width:right-x,height:bottom-y}});
  }
  const selected=[];
  for(const box of boxes.sort((a,b)=>b.score-a.score)){
    if(selected.every(other=>iou(box.bbox,other.bbox)<0.45))selected.push(box);
    if(selected.length===30)break;
  }
  return selected;
}

export function groupDetections(frames){
  const groups=[];
  for(const frame of [...frames].sort((a,b)=>a.time_ms-b.time_ms)){
    let best=null,overlap=0.2;
    for(const group of groups){
      const previous=group.at(-1),dt=frame.time_ms-previous.time_ms;
      if(dt<=0||dt>1200)continue;
      const match=iou(frame.bbox,previous.bbox);
      if(match>overlap){best=group;overlap=match;}
    }
    if(best)best.push(frame);else groups.push([frame]);
  }
  return groups;
}
