/* Static scene player. Clean video + source-frame observations; no inference in the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const catalog = window.DREAMVU_CATALOG.filter(scene => !scene.hidden);
  const layers = {
    detection: ['Person detection', 'Outlines and detection confidence'],
    tracking: ['Person tracking', 'Persistent IDs and recent paths'],
    counting: ['People counting', 'Current count and person markers'],
    proximity: ['Apparent proximity', 'Color by apparent body size'],
    pose: ['Body pose', 'Visible joints and skeletons'],
    posture: ['Posture', 'Standing, sitting, crouching or lying'],
    helmet: ['Helmet checks', 'Helmet, no helmet, or uncertain'],
    approach: ['Approach direction', 'Movement inferred from apparent size'],
    zones: ['Zone presence', 'Zone occupancy, entry and exit'],
    ground: ['360° floor geometry', 'Floor consistency from body rays'],
    events: ['Event replay', 'Recorded events from enabled layers'],
    health: ['Observation freshness', 'Age, interruption and recovery'],
    views: ['Perspective views', 'Open the overlapping camera views']
  };
  const colors = ['#6bd7ce','#f4b65e','#81a9ff','#ed95d0','#b6da72','#c2a2ff','#ffa17e','#65c5ed'];
  const postColors = {standing:'#81a9ff',sitting:'#bd9cf2',crouching:'#edb45c',lying:'#f07888',unknown:'#a6b4c8'};
  const bones = [[5,7],[7,9],[6,8],[8,10],[5,6],[11,12],[5,11],[6,12],[11,13],[13,15],[12,14],[14,16],[0,5],[0,6]];
  const video = $('source-video'), canvas = $('scene-canvas'), ctx = canvas.getContext('2d');
  const dialog = $('studio');
  let scene=null, data=null, enabled=new Set(), selected=null, currentIndex=-1, currentFrame=null;
  let savedLayers=null, requestToken=0, openButton=null, hitTargets=[], radarTargets=[], lastUI=0, activeFilter='all', displayTiles={}, viewHeight=0, displayedEvents=[];
  const cache=new Map();
  let customZone=null, customZoneFrames=[], customZoneEvents=[], zoneDrawing=false, zonePoints=[];
  const escape = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const label = id => id.startsWith('pending') ? 'Confirming' : 'P'+(id.startsWith('G') ? Number(id.slice(1)) : id.split(':').pop());
  const identityColor = id => colors[(Number(id.replace(/\D/g,''))||0)%colors.length];
  const clock = value => {const s=Math.max(0,Number(value)||0);return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;};
  const proximity = p => p.size!=null ? (p.size>=35 ? 'near' : p.size>=15 ? 'mid' : 'far') : p.imageHeight!=null ? (p.imageHeight>=.4?'near':p.imageHeight>=.17?'mid':'far') : null;
  const color = p => p.pending ? '#a6b4c8' : enabled.has('proximity') ? ({near:'#eead51',mid:'#6596ff',far:'#48ccc0'}[proximity(p)]||'#a6b4c8') : enabled.has('tracking') ? identityColor(p.id) : '#71a7ff';
  function representatives(frame) {
    const map=new Map();
    for (const p of frame.people) {
      const key=p.pending ? `${p.id}/${p.view}` : p.id;
      const old=map.get(key);
      const quality=q=>(q.held?-10000:0)+Math.min(q.margin,40)+(q.score||0)*10;
      if (!old || quality(p)>quality(old)) map.set(key,p);
    }
    return [...map.values()];
  }
  function renderLibrary() {
    const list=catalog.filter(c=>activeFilter==='all'||c.group===activeFilter);
    $('scene-count').textContent=`${list.length} scenes to explore`;
    $('scene-grid').innerHTML=list.map((c,i)=>`<button class="scene-card ${i===0&&activeFilter==='all'?'featured':''}" data-scene="${c.id}" aria-label="Open ${escape(c.title)}"><div class="poster"><img src="demo/assets/${c.id}/poster.jpg" alt="${escape(c.subtitle)}" ${i<2?'fetchpriority="high"':'loading="lazy"'}><span class="format-badge">${escape(c.format)}</span><span class="play-orb" aria-hidden="true">▶</span></div><div class="card-copy"><h3>${escape(c.title)}</h3><p>${escape(c.subtitle)}</p><div class="tags">${c.tags.map(t=>`<span>${escape(t)}</span>`).join('')}</div></div></button>`).join('');
  }
  $('scene-grid').addEventListener('click',e=>{const button=e.target.closest('[data-scene]');if(button)openScene(button.dataset.scene,button);});
  document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
    activeFilter=button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',b===button);});renderLibrary();
  }));
  $('credits').innerHTML=catalog.map(c=>`<p><strong>${escape(c.title)}</strong><br>${escape(c.credit)}</p>`).join('');
  renderLibrary();

  function loadData(id) {
    if (window.DREAMVU_DATA?.[id]) return Promise.resolve(window.DREAMVU_DATA[id]);
    if(cache.has(id))return cache.get(id);
    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=`demo/assets/${id}/data.js?v=person-verification-beb3f603307b`;
      script.onload=async()=>{try{const sceneData=window.DREAMVU_DATA?.[id];if(!sceneData)throw new Error('Scene observations are missing.');for(const file of sceneData.frameScripts||[]){await new Promise((done,fail)=>{const chunk=document.createElement('script');chunk.src=`demo/assets/${id}/${file}`;chunk.onload=done;chunk.onerror=()=>fail(new Error('Could not load scene observations. Please reload and try again.'));document.head.appendChild(chunk);});}resolve(sceneData);}catch(error){cache.delete(id);delete window.DREAMVU_DATA[id];reject(error);}};
      script.onerror=()=>{cache.delete(id);script.remove();reject(new Error('Could not open the saved observations. Check that the demo/assets folder is present beside this page.'));};
      document.head.appendChild(script);
    });cache.set(id,promise);return promise;
  }
  async function openScene(id,button=null) {
    const chosen=catalog.find(c=>c.id===id);if(!chosen)return;
    const token=++requestToken;video.pause();scene=chosen;data=null;selected=null;savedLayers=null;currentFrame=null;currentIndex=-1;setMobileLayers(false);
    customZone=null;customZoneFrames=[];customZoneEvents=[];zoneDrawing=false;zonePoints=[];
    openButton=button||openButton;enabled.clear();hitTargets=[];
    $('scene-title').textContent=chosen.title;$('scene-subtitle').textContent=chosen.subtitle;$('scene-format').textContent=chosen.format;
    $('scene-purpose').textContent=chosen.purpose;$('source-credit').textContent=chosen.credit;$('scene-limits').textContent=chosen.limits;
    $('loading').hidden=false;$('video-error').hidden=true;$('layer-list').innerHTML='';$('insights').innerHTML='';$('person-chips').innerHTML='';
    $('event-list').innerHTML='';$('event-count').textContent='';$('events-panel').hidden=true;$('event-markers').hidden=true;$('radar-panel').hidden=true;$('player-count').hidden=true;
    $('active-layer-count').textContent='';$('available-layer-count').textContent='Loading capabilities…';$('mode-label').textContent='Recording';$('zone-editor').hidden=true;
    $('person-inspector').innerHTML='<div class="inspector-idle"><span class="target-icon">⌖</span><h3>Follow one person.</h3><p>Select a marker in the video or a person below it to see their observations.</p></div>';
    $('proximity-note').hidden=true;$('proximity-info').setAttribute('aria-expanded','false');
    $('time-label').textContent='0:00 / 0:00';$('seek').value=0;$('speed').value='1';$('proximity-legend').hidden=true;
    canvas.width=1280;canvas.height=640;ctx.fillStyle='#10223b';ctx.fillRect(0,0,1280,640);
    if(!dialog.open){dialog.showModal();document.body.style.overflow='hidden';}
    dialog.scrollTop=0;history.replaceState(null,'',`#scene=${encodeURIComponent(id)}`);
    try {
      const loaded=await loadData(id);if(token!==requestToken)return;data=loaded;
      const cols=data.views.length===4?2:Math.min(3,data.views.length), tile=Math.floor(1280/cols);
      displayTiles=Object.fromEntries(data.views.map((v,j)=>[v.id,[(j%cols)*tile,Math.floor(j/cols)*tile,tile,tile]]));
      viewHeight=Math.ceil(data.views.length/cols)*tile;
      enabled=new Set(chosen.defaults.filter(k=>visibleLayers().includes(k)&&data.available.includes(k)));
      renderLayers();$('seek').max=data.duration;
      $('highlight').textContent=`Highlight ${clock(Math.min(chosen.moment,data.duration))}`;
      video.src=`demo/assets/${id}/clean.mp4`;video.poster=`demo/assets/${id}/poster.jpg`;video.load();
      // Opening a card starts from the beginning; event rows provide precise jumps.
      video.playbackRate=1; video.currentTime=0;
      video.play().catch(()=>{});
      updateUI(true);
    } catch(error){if(token!==requestToken)return;showError(error.message);}
  }
  function showError(message){$('loading').hidden=true;$('video-error').hidden=false;$('error-message').textContent=message;}
  function closeScene(){++requestToken;video.pause();dialog.close();document.body.style.overflow='';history.replaceState(null,'',location.pathname+location.search);data=null;scene=null;openButton?.focus();}
  $('close-studio').addEventListener('click',closeScene);
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeScene();});
  $('retry-scene').addEventListener('click',()=>scene&&openScene(scene.id));
  video.addEventListener('loadeddata',()=>{if(!data)return;$('loading').hidden=true;draw();updateUI(true);});
  video.addEventListener('error',()=>{if(data)showError('The clean video could not load. Open this page through the local showcase server or check its media files.');});
  video.addEventListener('play',()=>{$('play').textContent='Ⅱ';$('play').setAttribute('aria-label','Pause video');});
  video.addEventListener('pause',()=>{$('play').textContent='▶';$('play').setAttribute('aria-label','Play video');});
  video.addEventListener('ended',()=>updateUI(true));
  video.addEventListener('seeked',()=>{currentIndex=-1;draw();updateUI(true);});
  $('play').addEventListener('click',()=>video.paused?video.play().catch(()=>{}):video.pause());
  $('restart').addEventListener('click',()=>{video.currentTime=0;video.play().catch(()=>{});});
  $('highlight').addEventListener('click',()=>{if(data){video.currentTime=Math.min(scene.moment,data.duration-.05);dialog.scrollTop=0;draw();updateUI(true);}});
  function setMobileLayers(open){$('scene-controls').classList.toggle('mobile-open',open);$('mobile-layers').setAttribute('aria-expanded',open);}
  $('mobile-layers').addEventListener('click',()=>{const open=!$('scene-controls').classList.contains('mobile-open');setMobileLayers(open);if(open)dialog.scrollTo({top:0,behavior:'instant'});});
  $('close-layers').addEventListener('click',()=>{setMobileLayers(false);$('mobile-layers').focus();});
  $('seek').addEventListener('input',e=>{video.currentTime=Number(e.target.value);draw();updateUI(true);});
  $('speed').addEventListener('change',e=>video.playbackRate=Number(e.target.value));
  $('fullscreen').addEventListener('click',()=>{const target=$('picture');if(document.fullscreenElement)document.exitFullscreen?.();else target.requestFullscreen?.();});
  dialog.addEventListener('keydown',e=>{
    if(e.target.matches('input,select,button,summary,a'))return;
    if(e.code==='Space'){e.preventDefault();$('play').click();}
    if(e.code==='ArrowRight'){e.preventDefault();video.currentTime=Math.min(data?.duration||0,video.currentTime+5);}
    if(e.code==='ArrowLeft'){e.preventDefault();video.currentTime=Math.max(0,video.currentTime-5);}
  });
  function visibleLayers(){return Object.keys(layers);}
  function unavailableReason(k){if(['views','ground'].includes(k)&&data?.projection==='planar')return 'Requires a 360° recording; this clip is 2D.';return 'Full capability analysis has not loaded for this recording.';}
  function renderLayers() {
    $('layer-list').innerHTML=visibleLayers().map(k=>{const available=data.available.includes(k);return `<button class="layer-toggle" role="switch" aria-checked="${enabled.has(k)}" aria-label="${escape(layers[k][0])}" data-layer="${k}" ${available?'':`disabled title="${escape(unavailableReason(k))}"`}><span class="layer-copy"><strong>${escape(layers[k][0])}</strong><small>${escape(available?layers[k][1]:unavailableReason(k))}</small></span><span class="switch" aria-hidden="true"></span></button>`;}).join('');
    $('available-layer-count').textContent=`${visibleLayers().filter(k=>data.available.includes(k)).length} available · ${visibleLayers().length} total`;
    syncLayerState();
  }
  function syncLayerState(){
    if(!enabled.has('zones')){zoneDrawing=false;zonePoints=[];}
    document.querySelectorAll('[data-layer]').forEach(b=>b.setAttribute('aria-checked',enabled.has(b.dataset.layer)));
    $('active-layer-count').textContent=`${enabled.size} layers on`;
    $('mobile-layer-count').textContent=enabled.size;
    $('raw-button').setAttribute('aria-pressed',!enabled.size);
    $('proximity-legend').hidden=!enabled.has('proximity');
    $('player-count').hidden=!enabled.has('counting');
    if(!enabled.has('proximity'))$('proximity-note').hidden=true;
    $('mode-label').textContent=enabled.has('views')?'Perspective views':data?.projection==='planar'?'Camera view':'360° panorama';
    $('events-panel').hidden=!enabled.has('events');
    $('event-markers').hidden=!enabled.has('events');
    $('radar-panel').hidden=data?.projection==='planar'||!['counting','tracking','proximity'].some(k=>enabled.has(k));
    $('proximity-note').textContent=`Color uses ${data?.projection==='planar'?'visible body height in the image':'angular body size'}, not measured distance. Posture, body height and occlusion affect the estimate. No distances in meters are available for these clips.`;
    syncZoneEditor();
    if(data)renderEvents();
  }
  $('layer-list').addEventListener('click',e=>{const b=e.target.closest('[data-layer]');if(!b||b.disabled)return;const k=b.dataset.layer;enabled.has(k)?enabled.delete(k):enabled.add(k);savedLayers=null;syncLayerState();draw();updateUI(true);});
  $('reset-layers').addEventListener('click',()=>{if(!data)return;enabled=new Set(scene.defaults.filter(k=>visibleLayers().includes(k)&&data.available.includes(k)));savedLayers=null;syncLayerState();draw();updateUI(true);});
  $('raw-button').addEventListener('click',()=>{if(!data)return;if(enabled.size){savedLayers=new Set(enabled);enabled.clear();}else{enabled=savedLayers||new Set(scene.defaults.filter(k=>visibleLayers().includes(k)&&data.available.includes(k)));savedLayers=null;}syncLayerState();draw();updateUI(true);});
  $('proximity-info').addEventListener('click',()=>{const show=$('proximity-note').hidden;$('proximity-note').hidden=!show;$('proximity-info').setAttribute('aria-expanded',show);});

  function activeZones(){return customZone?[customZone]:(data?.zones||[]);}
  function personZones(p){if(customZone)return {[customZone.id]:customZoneFrames[currentIndex]?.[p.id]||{inside:null,point:null}};return p.zones||(p.zone&&data?.zones?.length?{[data.zones[0].id]:p.zone}:{});}
  function isInside(p){return !p.held&&!p.pending&&Object.values(personZones(p)).some(z=>z.inside===true);}
  function syncZoneEditor(){
    const planar=data?.projection==='planar';$('zone-editor').hidden=!enabled.has('zones');
    $('draw-zone').hidden=!planar||zoneDrawing;$('finish-zone').hidden=!zoneDrawing;$('finish-zone').disabled=zonePoints.length<3;$('cancel-zone').hidden=!zoneDrawing;$('clear-zone').hidden=!customZone||zoneDrawing;
    $('zone-editor-title').textContent=zoneDrawing?`Place zone corners · ${zonePoints.length} selected`:activeZones().length?(customZone?'Your image zone':'Scene zones'):'Define an image zone';
    $('zone-editor-note').textContent=zoneDrawing?'Click at least three corners on the video, then use this zone.':!planar?'Camera-relative front and rear sectors, gated by apparent body size. These are angular regions, not calibrated distance zones.':customZone?'Occupancy and crossings replay from saved, observed feet. This polygon stays fixed to the image, not the physical world.':activeZones().length?'The saved warehouse boundary follows the fixed rack-aisle entrance. You can also draw your own.':'Draw a region to apply zone presence and entry/exit to this clip. The region follows image coordinates; a moving camera does not preserve a site boundary.';
  }
  $('draw-zone').addEventListener('click',()=>{video.pause();zoneDrawing=true;zonePoints=[];syncZoneEditor();setMobileLayers(false);dialog.scrollTop=0;draw();});
  $('cancel-zone').addEventListener('click',()=>{zoneDrawing=false;zonePoints=[];syncZoneEditor();draw();});
  $('finish-zone').addEventListener('click',()=>{if(zonePoints.length<3)return;customZone={id:'custom_image',name:'Your image zone',kind:'floor_polygon',polygon:zonePoints.slice()};const result=window.DreamVuZones.evaluate(data.frames,customZone);customZoneFrames=result.observations;customZoneEvents=result.events;zoneDrawing=false;zonePoints=[];syncLayerState();draw();updateUI(true);});
  $('clear-zone').addEventListener('click',()=>{customZone=null;customZoneFrames=[];customZoneEvents=[];syncLayerState();draw();updateUI(true);});

  function selectedFrame(){if(!data)return null;const i=Math.min(data.frames.length-1,Math.max(0,Math.floor(video.currentTime*data.hz+1e-5)));currentIndex=i;return data.frames[i];}
  function viewPosition(p,point){const tile=displayTiles[p.view];return [tile[0]+point[0]*tile[2],tile[1]+point[1]*tile[3]];}
  function position(p,point){return enabled.has('views')?viewPosition(p,point):[point[0]*canvas.width,point[1]*canvas.height];}
  function personCentre(p){return position(p,enabled.has('views')?[(p.box[0]+p.box[2])/2,(p.box[1]+p.box[3])/2]:p.centre);}
  function pathPolygon(points,stroke,width=2,fill=null,wrap=false){
    if(!points?.length)return;ctx.beginPath();ctx.moveTo(...points[0]);let broken=false;
    for(let i=1;i<points.length;i++){if(wrap&&Math.abs(points[i][0]-points[i-1][0])>canvas.width/2){ctx.moveTo(...points[i]);broken=true;}else ctx.lineTo(...points[i]);}
    if(!broken)ctx.closePath();ctx.lineWidth=width;ctx.strokeStyle=stroke;ctx.stroke();if(fill&&!broken){ctx.fillStyle=fill;ctx.fill();}
  }
  function boxPoints(p,head=false){
    if(enabled.has('views')){const b=head?p.helmet?.box:p.box;if(!b)return null;return [[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]].map(q=>position(p,q));}
    return (head?p.helmet?.poly:p.poly)?.map(q=>position(p,q));
  }
  let labelsPlaced=[];
  function pill(text,x,y,accent='#81a9ff',options={}){
    const fs=(options.size||17)*(enabled.has('views')?Math.max(1,canvas.height/860):1);ctx.font=`600 ${fs}px "Avenir Next",sans-serif`;const tw=ctx.measureText(text).width,w=tw+14,h=fs+12;
    x=Math.max(4,Math.min(canvas.width-w-4,x));y=Math.max(4,Math.min(canvas.height-h-4,y));
    if(options.avoid){let attempt=0;while(attempt<5&&labelsPlaced.some(r=>!(x+w<r[0]||x>r[2]||y+h<r[1]||y>r[3]))){y=Math.max(4,y-h-3);attempt++;}labelsPlaced.push([x,y,x+w,y+h]);}
    ctx.fillStyle=options.solid?accent:'rgba(12,30,50,.88)';ctx.beginPath();ctx.roundRect(x,y,w,h,5);ctx.fill();
    ctx.fillStyle=options.solid?'#10223b':accent;ctx.fillText(text,x+7,y+fs+3);return h;
  }
  function drawTrails(people){
    if(!enabled.has('tracking'))return;
    const step=Math.max(1,Math.round(data.hz/5)), start=Math.max(0,currentIndex-Math.round(data.hz*2));
    for(const p of people){if(p.pending)continue;let prev=null;ctx.beginPath();
      for(let i=start;i<=currentIndex;i+=step){const candidates=data.frames[i].people.filter(q=>q.id===p.id&&!q.held&&(!enabled.has('views')||q.view===p.view));const q=candidates.find(q=>q.view===p.view)||candidates[0];if(!q)continue;const xy=personCentre(q);if(!prev||(!enabled.has('views')&&Math.abs(xy[0]-prev[0])>canvas.width/2))ctx.moveTo(...xy);else ctx.lineTo(...xy);prev=xy;}
      ctx.strokeStyle=color(p);ctx.globalAlpha=p.id===selected ? .85 : .48;ctx.lineWidth=2;ctx.stroke();ctx.globalAlpha=1;
    }
  }
  function drawZone(frame){
    if(!enabled.has('zones'))return;
    for(const zone of activeZones()){const inside=representatives(frame).filter(p=>!p.held&&!p.pending&&personZones(p)[zone.id]?.inside===true);const col=inside.length?'#f1818d':'#7ab7ff';
      if(zone.kind==='bearing_sector'){
        if(enabled.has('views'))continue;
        const [lo,hi]=zone.bearing_range_deg,segments=lo<=hi?[[lo,hi]]:[[lo,180],[-180,hi]];
        for(const [a,b]of segments){const x=(a+180)/360*canvas.width,w=(b-a)/360*canvas.width;ctx.fillStyle=inside.length?'#e4516528':'#438dff24';ctx.fillRect(x,0,w,canvas.height);ctx.strokeStyle=col;ctx.setLineDash([9,6]);ctx.strokeRect(x,2,w,canvas.height-4);ctx.setLineDash([]);pill(`${zone.name} · ${inside.length}`,x+10,canvas.height-42,col,{size:15});}
      }else{const poly=zone.polygon.map(q=>[q[0]*canvas.width,q[1]*canvas.height]);ctx.setLineDash([9,6]);pathPolygon(poly,col,3,inside.length?'#e451651c':'#438dff1a');ctx.setLineDash([]);pill(`${zone.name} · ${inside.length} inside`,poly[0][0],poly[0][1]-40,col,{size:16});}
    }
    if(zoneDrawing&&zonePoints.length){const poly=zonePoints.map(q=>[q[0]*canvas.width,q[1]*canvas.height]);pathPolygon(poly,'#ffe38b',3,'#ffe38b22');poly.forEach((q,i)=>{ctx.beginPath();ctx.arc(...q,7,0,Math.PI*2);ctx.fillStyle='#ffe38b';ctx.fill();pill(String(i+1),q[0]+10,q[1]-12,'#ffe38b',{size:17});});}
  }
  function draw(){
    if(!dialog.open||!data||video.readyState<2)return;
    const frame=selectedFrame();currentFrame=frame;const crop=data.atlas.main;
    const height=enabled.has('views')?viewHeight:crop[3];
    if(canvas.width!==1280||canvas.height!==height){canvas.width=1280;canvas.height=height;}
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(enabled.has('views'))for(const v of data.views)ctx.drawImage(video,...data.atlas.tiles[v.id],...displayTiles[v.id]);
    else ctx.drawImage(video,...crop,0,0,canvas.width,canvas.height);
    hitTargets=[];labelsPlaced=[];
    if(!enabled.size)return;
    const people=enabled.has('views')?frame.people:representatives(frame);drawZone(frame);drawTrails(people);
    for(const p of people){const col=color(p),xy=personCentre(p),chosen=p.id===selected;
      const drawPerson=['detection','tracking','counting','proximity','pose','posture','helmet','approach','zones','fall','ground'].some(k=>enabled.has(k));
      if(!drawPerson)continue;
      ctx.globalAlpha=p.held ? .68 : 1;ctx.setLineDash(p.held||p.pending?[6,5]:[]);
      if(enabled.has('detection')||chosen){pathPolygon(boxPoints(p),chosen?'#ffffff':col,chosen?3:1.8,null,!enabled.has('views')&&data.projection!=='planar');}
      ctx.setLineDash([]);
      if(enabled.has('pose')&&p.joints&&!p.held){const joints=enabled.has('views')?p.viewJoints:p.joints;
        for(const [a,b]of bones){if(joints[a][2]<.3||joints[b][2]<.3)continue;const aa=position(p,joints[a]),bb=position(p,joints[b]);if(!enabled.has('views')&&data.projection!=='planar'&&Math.abs(aa[0]-bb[0])>canvas.width/2)continue;
          ctx.beginPath();ctx.moveTo(...aa);ctx.lineTo(...bb);ctx.strokeStyle=a%2?'#5de3d4':'#ffc675';ctx.lineWidth=3;ctx.stroke();}
        joints.forEach(q=>{if(q[2]<.3)return;ctx.beginPath();ctx.arc(...position(p,q),3,0,Math.PI*2);ctx.fillStyle='#ffffff';ctx.fill();});
      }
      const [x,y]=xy;
      if(enabled.has('counting')||enabled.has('tracking')||enabled.has('proximity')){ctx.beginPath();ctx.arc(x,y,chosen?9:6,0,Math.PI*2);ctx.fillStyle=col;ctx.strokeStyle=col;ctx.lineWidth=2;p.held?ctx.stroke():ctx.fill();}
      let top=enabled.has('views')?position(p,[p.box[0],p.box[1]]):boxPoints(p)?.[0]||xy;
      let labelY=top[1]-31,labelX=top[0];
      if(enabled.has('tracking')||enabled.has('counting')){pill(label(p.id),x+9,y-20,col,{size:15,avoid:true});}
      if(enabled.has('detection')&&!enabled.has('tracking')&&!enabled.has('counting'))pill(`${Math.round((p.score||0)*100)}%`,labelX,labelY,col,{size:14,avoid:true});
      if(enabled.has('posture')&&p.posture){const state=p.posture.label||'unknown';const name=state==='unknown'?'Posture uncertain':state[0].toUpperCase()+state.slice(1);pill(name,labelX,labelY-30,postColors[state]||'#a6b4c8',{size:17,avoid:true});}
      if(enabled.has('helmet')&&p.helmet){const h=p.helmet, hc=h.label==='missing'?'#ff7b88':h.label==='worn'?'#73dfbb':'#b0bdcf';
        ctx.setLineDash(p.held||h.head_box_fresh===false?[5,4]:[]);pathPolygon(boxPoints(p,true),hc,h.label==='missing'?4:2,null,!enabled.has('views')&&data.projection!=='planar');ctx.setLineDash([]);
        pill(h.label==='missing'?'No helmet':h.label==='worn'?'Helmet on':'Helmet uncertain',labelX,labelY,hc,{size:h.label==='missing'?19:16,avoid:true,solid:h.label==='missing'});
      }
      if(enabled.has('approach')&&!p.held&&['approaching','receding'].includes(p.motion?.range_trend)){
        const near=p.motion.range_trend==='approaching';pill(near?'↓ Approaching estimate':'↑ Receding estimate',labelX,labelY+40,near?'#f2bb67':'#6fd4d9',{size:16,avoid:true});
      }
      if(enabled.has('zones')&&!p.held&&!p.pending){const fp=p.footpoint||Object.values(personZones(p)).find(z=>z.point)?.point;if(fp&&!enabled.has('views')){const q=fp.map((z,i)=>z*(i?canvas.height:canvas.width));ctx.beginPath();ctx.arc(...q,6,0,Math.PI*2);ctx.fillStyle=isInside(p)?'#f17e8b':'#7addc4';ctx.fill();}if(isInside(p))pill('Inside zone',x+8,y+24,'#ff8c98',{size:16});}
      if(enabled.has('fall')&&p.fall){const names={suspected:'Possible fall',fallen:'Fall detected',down:'Person down',on_floor:'On the floor'};pill(names[p.fall.state]||p.fall.state,labelX,labelY-65,p.fall.state==='suspected'?'#f5c06e':'#ff8291',{size:18,avoid:true});}
      if(enabled.has('ground')&&p.ground&&['floor','floor_or_bend','upright','unsure'].includes(p.ground.verdict)){const names={floor:'Floor consistent',floor_or_bend:'Floor or bent over',upright:'Upright geometry',unsure:'Floor check uncertain'};pill(names[p.ground.verdict],labelX,labelY-96,p.ground.verdict==='floor'?'#ff8c98':'#a6ceef',{size:16,avoid:true});}
      ctx.globalAlpha=1;if(!p.pending)hitTargets.push({id:p.id,x,y,points:boxPoints(p)});
    }
    if(enabled.has('views'))for(const v of data.views){const tile=displayTiles[v.id];const names={front:'Front',right:'Right',back:'Back',left:'Left',yaw0:'Front',yaw60:'Front-right',yaw120:'Back-right',yaw180:'Back',yaw240:'Back-left',yaw300:'Front-left'};pill(`${names[v.id]||v.id} · ${v.yaw}°`,tile[0]+10,tile[1]+10,'#fff',{size:data.views.length===4?30:26});}
    let bannerY=18;
    if(enabled.has('fall')){const alerts=representatives(frame).filter(p=>!p.pending&&!p.held&&['fallen','down'].includes(p.fall?.state)&&!p.fall.duplicate_of).length;pill(`Fall monitoring · ${alerts} active alerts`,18,bannerY,alerts?'#ff9aa7':'#b9d4ff',{size:17});bannerY+=34;}
    if(enabled.has('ground')){pill(frame.calibration?.height_m?'Floor geometry · height estimated from people':'Floor geometry · waiting for height evidence',18,bannerY,'#a6ceef',{size:16});bannerY+=34;}
    const recent=displayedEvents.filter(e=>e.t<=video.currentTime&&video.currentTime-e.t<2.8).slice(-1)[0];
    if(enabled.has('events')&&recent)pill(eventText(recent),18,bannerY,isCritical(recent)?'#ff9aa7':'#b9d4ff',{size:19});
    if(enabled.has('health')){const stale=frame.health.stale;const msg=stale?`Inference feed stale · ${Number(frame.health.age||0).toFixed(1)} s old`:'Observations current';pill(msg,18,canvas.height-48,stale?'#ff8b9a':'#8adbc7',{size:19});if(stale){ctx.strokeStyle='#f47688';ctx.lineWidth=5;ctx.strokeRect(3,3,canvas.width-6,canvas.height-6);}}
  }
  function eventText(e){const who=e.person?`Person ${label(e.person)}`:'Camera';const name=e.zone_name||'the zone';
    const map={zone_entry:`${who} entered ${name}`,zone_exit:`${who} left ${name}`,zone_presence:`${who} already inside ${name}`,zone_reacquired:`${who} seen again in ${name}`,helmet_missing:`${who} · no helmet`,helmet_restored:`${who} · helmet seen`,posture_changed:`${who} · ${e.previous||'unknown'} → ${e.current||'unknown'}`,fall_detected:`${who} · fall detected`,person_down:`${who} · person down`,person_recovered:`${who} · upright again`};
    if(e.event==='health'){const k=e.health_kind||e.kind;return {observations_stale:'Inference observations are stale',feed_gap:'Inference feed gap recorded',feed_recovered:'Fresh observations restored',out_of_order_frame:'Out-of-order frame'}[k]||'Feed health changed';}return map[e.event]||e.event.replaceAll('_',' ');
  }
  const isCritical=e=>['helmet_missing','fall_detected','person_down'].includes(e.event)||e.severity==='Critical';
  function renderEvents(){
    const eventLayer=e=>e.event==='health'?'health':e.event.startsWith('zone_')?'zones':e.event.startsWith('helmet_')?'helmet':e.event.startsWith('posture_')?'posture':['fall_detected','person_down','person_recovered'].includes(e.event)?'fall':null;
    const sourceEvents=customZone?[...data.events.filter(e=>!e.event.startsWith('zone_')),...customZoneEvents].sort((a,b)=>a.t-b.t):data.events;
    const evs=sourceEvents.filter(e=>(!eventLayer(e)||enabled.has(eventLayer(e)))&&(e.event!=='health'||['observations_stale','feed_gap','feed_recovered'].includes(e.health_kind||e.kind)));
    displayedEvents=evs;
    $('event-count').textContent=`${evs.length} events · active layers`;
    $('event-list').innerHTML=evs.length?evs.map((e,i)=>`<button class="event-row ${isCritical(e)?'critical':''}" data-time="${e.t}" data-event="${i}"><span class="event-time">${clock(e.t)}</span><i class="event-icon"></i><span>${escape(eventText(e))}</span><span class="replay-arrow" aria-hidden="true">↶</span></button>`).join(''):'<p class="event-empty">No recorded events for the active layers. Enable another feature to explore its events.</p>';
    $('event-markers').innerHTML=evs.map(e=>`<span class="event-marker ${isCritical(e)?'critical':''}" style="left:${Math.min(99.7,e.t/data.duration*100)}%"></span>`).join('');
  }
  $('event-list').addEventListener('click',e=>{const b=e.target.closest('[data-time]');if(!b)return;video.currentTime=Math.round(Number(b.dataset.time)*data.hz)/data.hz+1e-6;dialog.scrollTop=0;draw();updateUI(true);});
  function sparkline(){const list=data.frames.slice(Math.max(0,currentIndex-Math.round(data.hz*10)),currentIndex+1), max=Math.max(1,...list.map(f=>f.count));const xy=list.map((f,i)=>`${(i/Math.max(1,list.length-1)*320).toFixed(1)},${(35-f.count/max*30).toFixed(1)}`).join(' ');return `<svg class="spark" viewBox="0 0 320 40" preserveAspectRatio="none" aria-label="Tracked count over the preceding ten seconds"><path d="M0 37H320" stroke="#e3ebf5"/><polyline points="${xy}" stroke="#3979e7" stroke-width="2" vector-effect="non-scaling-stroke" fill="none"/></svg>`;}
  function renderInsights(frame,reps){
    const known=reps.filter(p=>!p.pending), posts={},he={worn:0,missing:0,unknown:0};known.forEach(p=>{if(p.posture)posts[p.posture.label]=(posts[p.posture.label]||0)+1;if(p.helmet)he[p.helmet.label||'unknown']++;});
    let html='';
    if(enabled.has('counting'))html+=`<div class="big-reading"><strong>${frame.count}</strong><span>people currently tracked</span></div><p class="sub-reading">${frame.fresh} observed now · ${frame.retained} briefly retained${frame.pending?` · ${frame.pending} unconfirmed observations`:''}</p>${sparkline()}`;
    if(enabled.has('helmet'))html+=`<div class="reading-split"><span class="alarm"><strong>${he.missing}</strong>No helmet</span><span class="good"><strong>${he.worn}</strong>Helmet on</span><span><strong>${he.unknown}</strong>Uncertain</span></div>`;
    if(enabled.has('zones')){const inside=known.filter(isInside).length;html+=activeZones().length?`<div class="big-reading"><strong>${inside}</strong><span>inside active zones</span></div><p class="sub-reading">${known.filter(p=>Object.values(personZones(p)).some(z=>z.inside===null)).length} uncertain positions · ${data.projection==='planar'?'observed feet in image coordinates':'camera-relative angular sectors'}</p>`:'<p class="sub-reading">Zone evaluation is ready. Draw a zone on the video to see occupancy and crossings.</p>';}
    if(enabled.has('posture'))html+=`<div class="posture-bars">${Object.entries(posts).map(([k,n])=>`<span style="flex:${n};background:${postColors[k]||'#a6b4c8'}" title="${escape(k)}: ${n}"></span>`).join('')}</div><div class="reading-split">${Object.entries(posts).map(([k,n])=>`<span><strong>${n}</strong>${escape(k==='unknown'?'Uncertain':k[0].toUpperCase()+k.slice(1))}</span>`).join('')}</div>`;
    if(enabled.has('health'))html+=`<div class="status-strip ${frame.health.stale?'stale':''}">${frame.health.stale?'Inference feed stale':'Observations current'}</div><div class="big-reading"><strong>${Number(frame.health.age||0).toFixed(1)}</strong><span>seconds since the last observation</span></div><p class="sub-reading">Stale after ${Number(data.staleAfter||2.5/data.hz).toFixed(2)} s${data.injectedGap?' · deliberate interruption from 12 to 16 s':' · evaluated throughout this recording'}</p>`;
    if(enabled.has('pose'))html+=`<p class="sub-reading">${known.reduce((n,p)=>n+(!p.held?(p.joints?.filter(q=>q[2]>=.3).length||0):0),0)} visible joints across ${known.filter(p=>!p.held&&p.joints).length} observed people · 17 possible per body</p>`;
    if(enabled.has('approach')){const movements={approaching:0,receding:0,steady:0,uncertain:0};known.filter(p=>!p.held).forEach(p=>{const m=p.motion?.range_trend;movements[Object.hasOwn(movements,m)?m:'uncertain']++;});html+=`<div class="reading-split"><span><strong>${movements.approaching}</strong>Approaching</span><span><strong>${movements.receding}</strong>Receding</span><span><strong>${movements.steady}</strong>Stable size</span><span><strong>${movements.uncertain}</strong>Insufficient trend</span></div><p class="sub-reading">Trend in apparent size; camera movement and posture can affect it.</p>`;}
    if(enabled.has('fall')){const episodes=known.filter(p=>!p.held&&p.fall&&!p.fall.duplicate_of);html+=`<div class="reading-split"><span class="alarm"><strong>${episodes.filter(p=>p.fall.state==='fallen').length}</strong>Fall alerts</span><span class="alarm"><strong>${episodes.filter(p=>p.fall.state==='down').length}</strong>Person down</span><span><strong>${episodes.filter(p=>['suspected','on_floor'].includes(p.fall.state)).length}</strong>Floor episodes</span></div><p class="sub-reading">Monitoring is active even when no fall occurs. Stillness thresholds: 10 s after a fall, 30 s if found lying.</p>`;}
    if(enabled.has('ground')){const gs=known.filter(p=>p.ground&&!p.held);html+=`<div class="reading-split"><span><strong>${gs.filter(p=>p.ground.verdict==='floor').length}</strong>Floor consistent</span><span><strong>${gs.filter(p=>p.ground.verdict==='upright').length}</strong>Upright geometry</span><span><strong>${gs.filter(p=>p.ground.verdict==='floor_or_bend').length}</strong>Floor or bent</span></div><p class="sub-reading">${frame.calibration?.height_m?`Camera height estimated from ${frame.calibration.people} tracked people. This is not supplied camera calibration.`:'Insufficient height evidence: the floor check can abstain. No camera height is invented.'}</p>`;}
    if(enabled.has('proximity')){const bands={near:0,mid:0,far:0};known.forEach(p=>{const k=proximity(p);if(k)bands[k]++;});html+=`<div class="reading-split"><span><strong>${bands.near}</strong>Larger in view</span><span><strong>${bands.mid}</strong>Medium</span><span><strong>${bands.far}</strong>Smaller in view</span></div>`;}
    if(!html&&enabled.size){const count=known.filter(p=>!p.held).length;html=`<div class="big-reading"><strong>${count}</strong><span>identities observed now</span></div><p class="sub-reading">${frame.retained} briefly retained · ${frame.pending} unconfirmed observations</p>`;if(enabled.has('pose'))html+=`<p class="sub-reading">${known.reduce((n,p)=>n+(p.joints?.filter(q=>q[2]>=.3).length||0),0)} visible joints · 17 possible per body</p>`;if(enabled.has('tracking'))html+='<p class="sub-reading">P labels are persistent IDs. They do not indicate the total count.</p>';}
    if(!enabled.size)html='<p class="empty-layer-message">Clean footage, with every overlay off.<br>Use the switches to explore the recorded observations.</p>';
    $('insights').innerHTML=html;
    $('person-chips').innerHTML=enabled.size?known.slice(0,12).map(p=>`<button class="person-chip ${selected===p.id?'selected':''}" data-person="${escape(p.id)}"><i style="background:${color(p)}"></i>${label(p.id)}</button>`).join(''):'';
  }
  function renderInspector(reps){
    if(!selected)return;const p=reps.find(p=>p.id===selected);if(!p){$('person-inspector').innerHTML=`<div class="person-heading"><h3>Person ${escape(label(selected))}</h3><button data-clear-person aria-label="Clear selected person">×</button></div><p class="inspector-note">Not observed in this frame. Seek or continue playback to follow this identity.</p>`;return;}
    const entries=[['Detection confidence',p.score==null?'—':`${Math.round(p.score*100)}%`]];
    if(p.bearing!=null)entries.push(['Bearing',`${Number(p.bearing).toFixed(0)}°`]);
    if(p.size!=null)entries.push(['Angular body height',`${Number(p.size).toFixed(1)}°`]);
    if(p.posture)entries.push(['Posture',p.posture.label==='unknown'?'Uncertain':p.posture.label]);
    if(p.helmet)entries.push(['Helmet',{worn:'On',missing:'Not detected',unknown:'Uncertain'}[p.helmet.label]||'Uncertain']);
    if(p.motion?.range_trend)entries.push(['Movement',p.motion.range_trend]);
    if(activeZones().length)entries.push(['Zone',isInside(p)?'Inside':Object.values(personZones(p)).some(z=>z.inside===null)?'Uncertain':'Outside']);
    if(enabled.has('fall')&&p.fall)entries.push(['Floor state',p.fall.state],['Stillness',`${Number(p.fall.still_s||0).toFixed(1)} s`]);
    if(p.ground)entries.push(['Floor geometry',p.ground.verdict||'Not established']);
    $('person-inspector').innerHTML=`<div class="person-heading"><h3>Person ${escape(label(p.id))}</h3><button data-clear-person aria-label="Clear selected person">×</button></div><p class="observed-state ${p.held?'held':''}">${p.held?'Last observation briefly retained':'Observed in this frame'}</p><dl>${entries.map(([a,b])=>`<dt>${escape(a)}</dt><dd>${escape(b)}</dd>`).join('')}</dl><p class="inspector-note">Identity is a tracking label, not facial recognition.${p.size!=null?' Apparent size does not establish metric distance.':''}</p>`;
  }
  $('person-inspector').addEventListener('click',e=>{if(e.target.closest('[data-clear-person]')){selected=null;$('person-inspector').innerHTML='<div class="inspector-idle"><span class="target-icon">⌖</span><h3>Follow one person.</h3><p>Select a marker to inspect it.</p></div>';draw();updateUI(true);}});
  function selectPerson(id){selected=id;draw();updateUI(true);if(matchMedia('(max-width:760px)').matches){setMobileLayers(true);dialog.scrollTop=0;const rail=$('scene-controls');rail.scrollTop=rail.scrollHeight;}}
  $('person-chips').addEventListener('click',e=>{const b=e.target.closest('[data-person]');if(b)selectPerson(b.dataset.person);});
  canvas.addEventListener('click',e=>{const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*canvas.width,y=(e.clientY-r.top)/r.height*canvas.height;if(zoneDrawing){zonePoints.push([Math.max(0,Math.min(1,x/canvas.width)),Math.max(0,Math.min(1,y/canvas.height))]);syncZoneEditor();draw();return;}const hits=hitTargets.map(h=>({...h,d:Math.hypot(x-h.x,y-h.y)})).sort((a,b)=>a.d-b.d);if(hits[0]&&hits[0].d<90)selectPerson(hits[0].id);});
  function drawRadar(reps){const rc=$('radar'),rctx=rc.getContext('2d'),cx=200,cy=139,R=104;radarTargets=[];rctx.clearRect(0,0,400,280);rctx.lineWidth=1;
    for(const rr of [R,R*.66,R*.33]){rctx.beginPath();rctx.arc(cx,cy,rr,0,Math.PI*2);rctx.strokeStyle='#dce6f3';rctx.stroke();}
    rctx.setLineDash([3,5]);rctx.beginPath();rctx.moveTo(cx,cy-R);rctx.lineTo(cx,cy+R);rctx.moveTo(cx-R,cy);rctx.lineTo(cx+R,cy);rctx.strokeStyle='#dce6f3';rctx.stroke();rctx.setLineDash([]);
    rctx.font='12px "Avenir Next",sans-serif';rctx.fillStyle='#7b8ea6';rctx.textAlign='center';rctx.fillText('Front',cx,19);rctx.fillText('Back',cx,268);rctx.fillText('Left',56,144);rctx.fillText('Right',348,144);
    rctx.beginPath();rctx.arc(cx,cy,6,0,Math.PI*2);rctx.fillStyle='#173650';rctx.fill();
    for(const p of reps){if(p.pending||p.bearing==null)continue;const a=p.bearing*Math.PI/180,rr=R*Math.max(.16,Math.min(1,1-((p.size||6)-6)/65));const x=cx+Math.sin(a)*rr,y=cy-Math.cos(a)*rr;
      rctx.beginPath();rctx.arc(x,y,p.id===selected?7:4.5,0,Math.PI*2);rctx.fillStyle=color(p);rctx.strokeStyle=color(p);rctx.lineWidth=2;p.held?rctx.stroke():rctx.fill();if(p.id===selected){rctx.fillStyle='#173650';rctx.font='600 12px "Avenir Next",sans-serif';rctx.fillText(label(p.id),x,y-12);}radarTargets.push({x,y,id:p.id});
    }
  }
  $('radar').addEventListener('click',e=>{const r=e.currentTarget.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*400,y=(e.clientY-r.top)/r.height*280;const hit=radarTargets.map(p=>({...p,d:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.d-b.d)[0];if(hit?.d<18)selectPerson(hit.id);});
  function updateUI(force=false){if(!data||!dialog.open)return;const now=performance.now();if(!force&&now-lastUI<160)return;lastUI=now;const f=selectedFrame();currentFrame=f;const reps=representatives(f);
    $('time-label').textContent=`${clock(video.currentTime)} / ${clock(data.duration)}`;$('seek').value=video.currentTime;$('evidence-time').textContent=clock(video.currentTime);
    $('player-count').textContent=`${f.count} people tracked`;$('player-count').title=`${f.fresh} observed now; ${f.retained} briefly retained`;
    renderInsights(f,reps);renderInspector(reps);if(!$('radar-panel').hidden)drawRadar(reps);
    document.querySelectorAll('.event-row').forEach(b=>{const dt=video.currentTime-Number(b.dataset.time);b.classList.toggle('upcoming',dt<0);b.classList.toggle('current',dt>=0&&dt<2.8);});
  }
  function tick(){if(dialog.open&&data){draw();updateUI();}requestAnimationFrame(tick);}requestAnimationFrame(tick);
  function openFromHash(){const match=location.hash.match(/^#scene=([^&]+)/);if(match)openScene(decodeURIComponent(match[1]));}
  window.addEventListener('hashchange',openFromHash);openFromHash();
})();
