// ═══════════════════════════════════════════════════════════════
// AniSync Adapter v3 — Auto-injected into anime pages
// Features: Polling sync, chat overlay, ad blocking
// Supports: animecix, tranimeizle, and any HTML5 video site
// ═══════════════════════════════════════════════════════════════
(function(){
  if(document.getElementById('anisync-root'))return;
  var C;
  try{C=JSON.parse(localStorage.getItem('anisync_adapter')||'{}');}catch(e){return;}
  if(!C.server||!C.room||!C.user)return;

  var SERVER=C.server,ROOM_CODE=C.room,USER=C.user,roomId=C.roomId||'';
  var video=null,sock=null,ignore=false,chatOpen=false,messages=[];
  var videoCheckInterval=null,connected=false;

  // ── Ad Blocking ──
  var adCSS=document.createElement('style');
  adCSS.textContent='[class*="ad-"],[class*="ads-"],[id*="ad-"],[id*="ads-"],'
    +'[class*="banner"],[class*="popup"],[class*="reklam"],[id*="reklam"],'
    +'.adsbygoogle,ins.adsbygoogle,[class*="AdContainer"],[class*="ad_wrapper"],'
    +'div[data-ad],div[data-ads],iframe[src*="doubleclick"],iframe[src*="googlesyndication"]'
    +'{display:none!important;height:0!important;overflow:hidden!important;}';
  document.head.appendChild(adCSS);

  // ── Load Socket.IO ──
  var s=document.createElement('script');
  s.src=SERVER+'/socket.io/socket.io.js';
  s.onload=init;
  s.onerror=function(){setStatus('Socket.IO yüklenemedi','#f87171');};
  document.head.appendChild(s);

  function init(){
    createUI();
    setStatus('Bağlanıyor...','#fbbf24');

    sock=io(SERVER,{auth:{username:USER},transports:['websocket','polling'],reconnection:true});

    sock.on('connect',function(){
      connected=true;
      sock.emit('room:join',{code:ROOM_CODE},function(r){
        if(r&&r.success){roomId=r.room.id;setStatus('Bağlandı ✓','#34d399');}
        else setStatus('Oda bulunamadı','#f87171');
      });
    });
    sock.on('disconnect',function(){connected=false;setStatus('Bağlantı kesildi','#f87171');});
    sock.on('reconnect',function(){setStatus('Yeniden bağlandı','#34d399');});

    // ── Sync Events ──
    sock.on('sync:play',function(d){applySync(d,function(){video.play().catch(function(){});});});
    sock.on('sync:pause',function(d){applySync(d,function(){video.pause();});});
    sock.on('sync:seek',function(d){applySync(d,null);});

    sock.on('sync:timecheck',function(d){
      if(!video||d.userId===USER)return;
      var drift=Math.abs(video.currentTime-d.time);
      if(drift>1.5){
        ignore=true;
        video.currentTime=d.time;
        if(d.playing&&video.paused)video.play().catch(function(){});
        if(!d.playing&&!video.paused)video.pause();
        setTimeout(function(){ignore=false;},600);
        setStatus('Düzeltildi ('+drift.toFixed(1)+'s)','#fbbf24');
        setTimeout(function(){if(connected)setStatus('Senkron ✓','#34d399');},2000);
      }
    });

    // ── Chat ──
    sock.on('chat:message',function(d){
      messages.push(d);if(messages.length>50)messages.shift();
      renderChat();
      // Flash chat button
      var btn=document.getElementById('as-chat-btn');
      if(btn&&!chatOpen){btn.style.background='rgba(236,72,153,0.5)';setTimeout(function(){btn.style.background='rgba(168,85,247,0.2)';},1500);}
    });

    // ── Start video search ──
    startVideoSearch();

    // ── Emit timecheck every 3s ──
    setInterval(function(){
      if(!video||!roomId||!sock)return;
      sock.emit('sync:timecheck',{roomId:roomId,time:video.currentTime,playing:!video.paused,userId:USER});
    },3000);
  }

  function applySync(d,action){
    if(!video||d.originUserId===USER||d.userId===USER)return;
    ignore=true;
    video.currentTime=d.time;
    if(action)action();
    setTimeout(function(){ignore=false;},600);
  }

  // ── Video Finder — aggressive search for SPA sites like animecix ──
  function startVideoSearch(){
    if(findAndHook())return;

    // MutationObserver for dynamically added videos
    var obs=new MutationObserver(function(){if(findAndHook())obs.disconnect();});
    obs.observe(document.documentElement,{childList:true,subtree:true});

    // Polling fallback — check every 1.5s for 2 minutes
    var attempts=0;
    videoCheckInterval=setInterval(function(){
      attempts++;
      if(findAndHook()){clearInterval(videoCheckInterval);obs.disconnect();return;}
      if(attempts>80){clearInterval(videoCheckInterval);setStatus('Video bulunamadı','#f87171');}
    },1500);
  }

  function findAndHook(){
    if(video)return true;
    // Direct video elements
    var vids=document.querySelectorAll('video');
    for(var i=0;i<vids.length;i++){
      if(vids[i].src||vids[i].querySelector('source')||vids[i].readyState>0||vids[i].currentSrc){
        video=vids[i];hookVideo();return true;
      }
    }
    // Any video at all
    if(vids.length>0){video=vids[0];hookVideo();return true;}
    // Check inside iframes
    var frames=document.querySelectorAll('iframe');
    for(var j=0;j<frames.length;j++){
      try{
        var fv=frames[j].contentDocument;
        if(fv){
          var v=fv.querySelector('video');
          if(v){video=v;hookVideo();return true;}
        }
      }catch(e){}
    }
    return false;
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
    // Also watch for video element being replaced (SPA navigation)
    var checkReplaced=setInterval(function(){
      if(!document.body.contains(video)){
        video=null;setStatus('Video aranıyor...','#fbbf24');
        clearInterval(checkReplaced);
        startVideoSearch();
      }
    },3000);
  }

  // ── UI ──
  function createUI(){
    var root=document.createElement('div');root.id='anisync-root';
    root.innerHTML=
      '<div id="as-bar" style="position:fixed;top:0;left:0;right:0;z-index:999999;'
      +'background:linear-gradient(180deg,rgba(10,10,15,0.97),rgba(10,10,15,0.92));'
      +'backdrop-filter:blur(16px);padding:8px 12px;display:flex;align-items:center;gap:8px;'
      +'border-bottom:2px solid rgba(168,85,247,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;'
      +'box-shadow:0 4px 16px rgba(0,0,0,0.4);height:42px;">'
      +'<button id="as-back" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:2px 8px;line-height:1;">←</button>'
      +'<span style="color:#a855f7;font-weight:800;font-size:13px;letter-spacing:0.5px;">AniSync</span>'
      +'<span id="as-dot" style="width:7px;height:7px;border-radius:50%;background:#fbbf24;flex-shrink:0;"></span>'
      +'<span id="as-status" style="color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Bağlanıyor...</span>'
      +'<span style="flex:1"></span>'
      +'<span id="as-time" style="color:#fff;font-family:monospace;font-size:14px;font-weight:600;">0:00</span>'
      +'<button id="as-chat-btn" style="background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);'
      +'border-radius:20px;color:#fff;padding:4px 12px;font-size:11px;cursor:pointer;white-space:nowrap;">💬 Chat</button>'
      +'</div>'
      +'<div id="as-chat" style="display:none;position:fixed;bottom:0;right:0;width:300px;max-height:55vh;z-index:999999;'
      +'background:rgba(10,10,15,0.97);backdrop-filter:blur(16px);'
      +'border-top:1px solid rgba(168,85,247,0.3);border-left:1px solid rgba(168,85,247,0.3);'
      +'border-radius:16px 0 0 0;font-family:-apple-system,sans-serif;flex-direction:column;">'
      +'<div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:#a855f7;font-weight:700;">💬 Sohbet</div>'
      +'<div id="as-msgs" style="flex:1;overflow-y:auto;padding:10px;max-height:35vh;font-size:12px;color:#ccc;"></div>'
      +'<div style="padding:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:6px;">'
      +'<input id="as-input" placeholder="Mesaj yaz..." style="flex:1;background:rgba(255,255,255,0.08);'
      +'border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:8px 14px;color:#fff;font-size:12px;outline:none;">'
      +'<button id="as-send" style="background:#a855f7;border:none;border-radius:50%;color:#fff;width:32px;height:32px;font-size:14px;cursor:pointer;">→</button>'
      +'</div></div>';
    document.body.appendChild(root);

    // Push page content down
    document.body.style.paddingTop='42px';

    document.getElementById('as-back').onclick=function(){
      sock.disconnect();
      localStorage.removeItem('anisync_adapter');
      window.location.href=SERVER;
    };
    document.getElementById('as-chat-btn').onclick=function(){
      chatOpen=!chatOpen;
      document.getElementById('as-chat').style.display=chatOpen?'flex':'none';
      document.getElementById('as-chat-btn').style.background=chatOpen?'rgba(168,85,247,0.5)':'rgba(168,85,247,0.2)';
    };
    document.getElementById('as-send').onclick=sendChat;
    document.getElementById('as-input').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();sendChat();}};

    // Update time display
    setInterval(function(){
      if(!video)return;
      var m=Math.floor(video.currentTime/60);
      var ss=Math.floor(video.currentTime%60).toString().padStart(2,'0');
      var el=document.getElementById('as-time');
      if(el)el.textContent=m+':'+ss;
    },500);
  }

  function sendChat(){
    var inp=document.getElementById('as-input');
    var t=(inp.value||'').trim();if(!t||!sock)return;
    sock.emit('chat:message',{roomId:roomId,text:t});
    inp.value='';
  }

  function renderChat(){
    var el=document.getElementById('as-msgs');if(!el)return;
    var html='';
    messages.slice(-40).forEach(function(m){
      var isMe=m.userId===USER||m.username===USER;
      var c=isMe?'#a855f7':'#22d3ee';
      var name=m.displayName||m.username||'?';
      html+='<div style="margin-bottom:6px;line-height:1.4;">'
        +'<span style="color:'+c+';font-weight:600;font-size:11px;">'+name+'</span> '
        +'<span style="color:#ddd;">'+m.text+'</span></div>';
    });
    el.innerHTML=html;
    el.scrollTop=el.scrollHeight;
  }

  function setStatus(t,color){
    var el=document.getElementById('as-status');if(el){el.textContent=t;el.style.color=color||'#888';}
    var dot=document.getElementById('as-dot');if(dot)dot.style.background=color||'#888';
  }
})();
