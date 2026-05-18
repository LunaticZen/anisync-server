// ═══════════════════════════════════════════════════════════════
// AniSync Adapter v2 — Full-featured video sync overlay
// Polling + Seek correction, mini chat, ad blocking
// ═══════════════════════════════════════════════════════════════
(function(){
  var C=JSON.parse(localStorage.getItem('anisync_adapter')||'{}');
  if(!C.server||!C.room||!C.user) return;
  var SERVER=C.server,ROOM_CODE=C.room,USER=C.user,roomId=C.roomId||'';
  var video=null,sock=null,ignore=false,chatOpen=false,messages=[];

  // ── Ad Blocking CSS ──
  var adCSS=document.createElement('style');
  adCSS.textContent=[
    '[class*="ad-"]','[class*="ads-"]','[id*="ad-"]','[id*="ads-"]',
    '[class*="banner"]','[class*="popup"]','[class*="modal-overlay"]',
    '[class*="reklam"]','[id*="reklam"]',
    'iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]',
    'iframe[src*="adservice"]','iframe[src*="advertisement"]',
    '.adsbygoogle','ins.adsbygoogle',
    '[class*="AdContainer"]','[class*="ad_wrapper"]',
    'div[data-ad]','div[data-ads]',
  ].join(',')+'{ display:none!important; visibility:hidden!important; height:0!important; overflow:hidden!important; }';
  document.head.appendChild(adCSS);

  // Remove ad scripts
  setTimeout(function(){
    document.querySelectorAll('script[src*="ads"],script[src*="adservice"],script[src*="doubleclick"],script[src*="googlesyndication"]').forEach(function(s){s.remove();});
    document.querySelectorAll('[class*="overlay"]:not(#anisync-root),[class*="popup"]:not(#anisync-root)').forEach(function(el){
      if(el.id&&el.id.indexOf('anisync')>=0)return;
      var r=el.getBoundingClientRect();
      if(r.width>200&&r.height>200&&getComputedStyle(el).position==='fixed'){el.style.display='none';}
    });
  },3000);

  // ── Load Socket.IO ──
  var s=document.createElement('script');
  s.src=SERVER+'/socket.io/socket.io.js';
  s.onload=init;
  document.head.appendChild(s);

  function init(){
    sock=io(SERVER,{auth:{username:USER},transports:['websocket','polling']});
    sock.on('connect',function(){
      sock.emit('room:join',{code:ROOM_CODE},function(r){
        if(r.success){roomId=r.room.id;setStatus('Bağlandı ✓','#34d399');}
        else setStatus('Oda bulunamadı','#f87171');
      });
    });
    sock.on('disconnect',function(){setStatus('Bağlantı kesildi','#f87171');});

    // Sync events
    sock.on('sync:play',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;
      video.currentTime=d.time;
      video.play().catch(function(){}).finally(function(){setTimeout(function(){ignore=false},600)});
    });
    sock.on('sync:pause',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;video.currentTime=d.time;video.pause();
      setTimeout(function(){ignore=false},600);
    });
    sock.on('sync:seek',function(d){
      if(!video||d.originUserId===USER)return;
      ignore=true;video.currentTime=d.time;
      setTimeout(function(){ignore=false},600);
    });

    // Polling sync correction — every 3s compare times
    sock.on('sync:timecheck',function(d){
      if(!video||d.userId===USER)return;
      var drift=Math.abs(video.currentTime-d.time);
      if(drift>1.5){
        ignore=true;
        video.currentTime=d.time;
        if(d.playing&&video.paused)video.play().catch(function(){});
        if(!d.playing&&!video.paused)video.pause();
        setTimeout(function(){ignore=false},600);
        setStatus('Düzeltildi ('+drift.toFixed(1)+'s)','#fbbf24');
        setTimeout(function(){setStatus('Senkron ✓','#34d399');},2000);
      }
    });

    // Chat
    sock.on('chat:message',function(d){
      messages.push(d);if(messages.length>50)messages.shift();
      renderChat();
    });

    findVideo();
    createUI();

    // Emit timecheck every 3 seconds
    setInterval(function(){
      if(!video||!roomId)return;
      sock.emit('sync:timecheck',{roomId:roomId,time:video.currentTime,playing:!video.paused,userId:USER});
    },3000);
  }

  // ── Video Finder ──
  function findVideo(){
    function check(){
      // Check main document
      var v=document.querySelector('video');
      if(v&&v.src){video=v;hookVideo();return true;}
      // Check all videos including those without src (blob etc)
      var vids=document.querySelectorAll('video');
      for(var i=0;i<vids.length;i++){
        if(vids[i].readyState>0||vids[i].src||vids[i].querySelector('source')){
          video=vids[i];hookVideo();return true;
        }
      }
      // Check iframes
      var frames=document.querySelectorAll('iframe');
      for(var j=0;j<frames.length;j++){
        try{
          var fv=frames[j].contentDocument.querySelector('video');
          if(fv){video=fv;hookVideo();return true;}
        }catch(e){}
      }
      return false;
    }
    if(check())return;
    var obs=new MutationObserver(function(){if(check())obs.disconnect();});
    obs.observe(document.body,{childList:true,subtree:true});
    // Fallback polling
    var iv=setInterval(function(){if(check()){clearInterval(iv);}},2000);
  }

  function hookVideo(){
    setStatus('Video bulundu ▶','#34d399');
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

  // ── UI ──
  function createUI(){
    var root=document.createElement('div');root.id='anisync-root';
    root.innerHTML=
      '<div id="as-bar" style="position:fixed;top:0;left:0;right:0;z-index:999999;background:rgba(10,10,15,0.95);backdrop-filter:blur(12px);padding:6px 12px;display:flex;align-items:center;gap:10px;border-bottom:2px solid rgba(168,85,247,0.5);font-family:-apple-system,sans-serif;font-size:13px;">'
      +'<button id="as-back" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:2px 6px;line-height:1;">←</button>'
      +'<span style="color:#a855f7;font-weight:700;">AniSync</span>'
      +'<span id="as-dot" style="width:6px;height:6px;border-radius:50%;background:#888;"></span>'
      +'<span id="as-status" style="color:#888;font-size:11px;">Bağlanıyor...</span>'
      +'<span style="flex:1"></span>'
      +'<span id="as-time" style="color:#fff;font-family:monospace;font-size:14px;">0:00</span>'
      +'<button id="as-chat-btn" style="background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);border-radius:8px;color:#fff;padding:4px 10px;font-size:12px;cursor:pointer;">💬</button>'
      +'</div>'
      +'<div id="as-chat" style="display:none;position:fixed;bottom:0;right:0;width:280px;max-height:50vh;z-index:999999;background:rgba(10,10,15,0.95);backdrop-filter:blur(12px);border-top:1px solid rgba(168,85,247,0.3);border-left:1px solid rgba(168,85,247,0.3);border-radius:12px 0 0 0;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;">'
      +'<div style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.1);font-size:12px;color:#a855f7;font-weight:600;">💬 Sohbet</div>'
      +'<div id="as-msgs" style="flex:1;overflow-y:auto;padding:8px;max-height:30vh;font-size:12px;color:#ccc;"></div>'
      +'<div style="padding:6px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:4px;">'
      +'<input id="as-input" placeholder="Mesaj..." style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 8px;color:#fff;font-size:12px;outline:none;">'
      +'<button id="as-send" style="background:#a855f7;border:none;border-radius:6px;color:#fff;padding:4px 10px;font-size:12px;cursor:pointer;">→</button>'
      +'</div></div>';
    document.body.appendChild(root);
    document.body.style.marginTop='40px';

    document.getElementById('as-back').onclick=function(){sock.disconnect();window.location.href=SERVER;};
    document.getElementById('as-chat-btn').onclick=function(){
      chatOpen=!chatOpen;
      document.getElementById('as-chat').style.display=chatOpen?'flex':'none';
    };
    document.getElementById('as-send').onclick=sendChat;
    document.getElementById('as-input').onkeydown=function(e){if(e.key==='Enter')sendChat();};

    // Time display
    setInterval(function(){
      if(!video)return;
      var m=Math.floor(video.currentTime/60);
      var ss=Math.floor(video.currentTime%60).toString().padStart(2,'0');
      document.getElementById('as-time').textContent=m+':'+ss;
    },500);
  }

  function sendChat(){
    var inp=document.getElementById('as-input');
    var t=inp.value.trim();if(!t)return;
    sock.emit('chat:message',{roomId:roomId,text:t});
    inp.value='';
  }

  function renderChat(){
    var el=document.getElementById('as-msgs');if(!el)return;
    var html='';
    messages.slice(-30).forEach(function(m){
      var c=m.userId===USER?'#a855f7':'#22d3ee';
      html+='<div style="margin-bottom:4px;"><span style="color:'+c+';font-weight:600;">'+m.username+'</span> <span>'+m.text+'</span></div>';
    });
    el.innerHTML=html;
    el.scrollTop=el.scrollHeight;
  }

  function setStatus(t,color){
    var el=document.getElementById('as-status');if(el)el.textContent=t;
    var dot=document.getElementById('as-dot');if(dot)dot.style.background=color||'#888';
  }
})();
