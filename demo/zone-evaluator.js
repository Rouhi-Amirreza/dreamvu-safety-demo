/* Image-zone replay over saved, observed feet. Mirrors edge/zones.py dwell and gap rules. */
(function(root){
  'use strict';
  function contains(point,polygon){let inside=false;const [x,y]=point;for(let i=0;i<polygon.length;i++){const [ax,ay]=polygon[i], [bx,by]=polygon[(i+1)%polygon.length];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;}return inside;}
  function evaluate(frames,zone){
    const state=new Map(),observations=[],events=[];
    for(const frame of frames){const current={},seen=new Set(),t=frame.t;
      for(const p of frame.people){if(p.pending||seen.has(p.id))continue;seen.add(p.id);
        const point=p.held?null:p.footpoint;
        const inside=point?contains(point,zone.polygon):null;
        current[p.id]={inside,point,reason:point?'observed_feet':p.held?'retained_observation':p.footpointReason||'feet_not_observed'};
        if(p.held)continue;
        let st=state.get(p.id);if(!st){st={inside:null,since:t,last:t,announced:false,everInside:false,lastInside:null,gapBefore:false,seenOutside:false};state.set(p.id,st);}
        const stale=t-st.last>.6;
        if(inside===null){if(stale)st.inside=null;st.gapBefore=true;st.last=t;continue;}
        if(inside!==st.inside||stale)st.since=t;
        st.inside=inside;st.last=t;const dwelt=t-st.since>=.2-1e-9;
        if(!inside)st.seenOutside=true;
        let kind=null;
        if(inside&&dwelt&&!st.announced){kind=!st.everInside&&!st.seenOutside?'presence':st.gapBefore&&st.lastInside!==null&&t-st.lastInside<=3?'reacquired':'entry';st.announced=true;st.everInside=true;st.gapBefore=false;}
        if(inside)st.lastInside=t;
        if(!inside&&dwelt&&st.announced){st.announced=false;kind='exit';}
        if(kind)events.push({event:'zone_'+kind,t,source_time_s:frame.source,person:p.id,zone_name:zone.name,zone_id:zone.id,severity:kind==='entry'?'Warning':'Info',geometry_status:'interactive_image_zone',evidence:{footpoint_normalized:point}});
      }
      observations.push(current);
    }
    return {observations,events};
  }
  const api={contains,evaluate};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DreamVuZones=api;
})(typeof window!=='undefined'?window:{});
