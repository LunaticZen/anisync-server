// AniSync Video Sync Adapter - Injected into anime pages
(function(){
  var C=JSON.parse(localStorage.getItem('anisync_adapter')||'{}');
  if(!C.server||!C.room||!C.user) return;
  var SERVER=C.server, ROOM_CODE=C.room, USER=C.user, roomId=C.roomId||'';
  var video=null, sock=null, ignore=false;

  // Load Socket.IO
  var s=document.createElement('script');
  s.src=SERVER+'/socket.io/socket.io.js';
  s.onload=function(){
    sock=io(SERVER,{auth:{username:USER},transports:['websocket','polling']});
    sock.on('connect',function(){
      sock.emit('room:join',{code:ROOM_CODE},function(r){
        if(r.success){roomId=r.room.id;setStatus('Bağlandı ✓');}
      });
    });
    sock.on('sync:play',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;video.currentTime=d.time;
      video.play().catch(function(){}).finally(function(){setTimeout(function(){ignore=false},500)});
    });
    sock.on('sync:pause',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;video.currentTime=d.time;video.pause();
      setTimeout(function(){ignore=false},500);
    });
    sock.on('sync:seek',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;video.currentTime=d.time;
      setTimeout(function(){ignore=false},500);
    });
    findVideo();
    createBar();
  };
  document.head.appendChild(s);

  function findVideo(){
    video=document.querySelector('video');
    if(video){hookVideo();return;}
    var obs=new MutationObserver(function(){
      var v=document.querySelector('video');
      if(v){video=v;obs.disconnect();hookVideo();}
    });
    obs.observe(document.body,{childList:true,subtree:true});
    var iv=setInterval(function(){
      if(video){clearInterval(iv);return;}
      var v=document.querySelector('video');
      if(v){video=v;clearInterval(iv);hookVideo();return;}
      document.querySelectorAll('iframe').forEach(function(f){
        try{var v2=f.contentDocument.querySelector('video');
        if(v2){video=v2;clearInterval(iv);hookVideo();}}catch(e){}
      });
    },2000);
  }

  function hookVideo(){
    setStatus('Video bulundu ▶');
    video.addEventListener('play',function(){
      if(ignore)return;
      sock.emit('sync:play',{roomId:roomId,time:video.currentTime,generation:Date.now()});
    });
    video.addEventListener('pause',function(){
      if(ignore)return;
      sock.emit('sync:pause',{roomId:roomId,time:video.currentTime,generation:Date.now()});
    });
    video.addEventListener('seeked',function(){
      if(ignore)return;
      sock.emit('sync:seek',{roomId:roomId,time:video.currentTime,generation:Date.now()});
    });
  }

  function createBar(){
    var d=document.createElement('div');d.id='anisync-bar';
    d.innerHTML='<div style="position:fixed;top:0;left:0;right:0;z-index:999999;background:rgba(10,10,15,0.92);backdrop-filter:blur(12px);padding:8px 16px;display:flex;align-items:center;gap:12px;border-bottom:2px solid rgba(168,85,247,0.4);font-family:sans-serif;">'
      +'<button id="as-back" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;">←</button>'
      +'<span style="color:#a855f7;font-weight:700;font-size:14px;">AniSync</span>'
      +'<span id="as-status" style="color:#888;font-size:12px;">Bağlanıyor...</span>'
      +'<span style="flex:1"></span>'
      +'<span id="as-time" style="color:#fff;font-family:monospace;font-size:14px;">0:00</span>'
      +'</div>';
    document.body.appendChild(d);
    document.body.style.marginTop='44px';
    document.getElementById('as-back').onclick=function(){
      sock.disconnect();window.location.href=SERVER;
    };
    setInterval(function(){
      if(!video)return;
      var m=Math.floor(video.currentTime/60);
      var ss=Math.floor(video.currentTime%60).toString().padStart(2,'0');
      var el=document.getElementById('as-time');
      if(el)el.textContent=m+':'+ss;
    },1000);
  }

  function setStatus(t){var e=document.getElementById('as-status');if(e)e.textContent=t;}
})();
