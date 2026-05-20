// ═══════════════════════════════════════════════════════════════
// AniSync Cloud Server — Render.com Deployment
// Express + Socket.IO + In-Memory + Keep-Alive
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ─── In-Memory State ──────────────────────────────────────────

const rooms = new Map();
const codeToId = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode(len = 6) {
  let c = '';
  for (let i = 0; i < len; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function uniqueCode() {
  for (let i = 0; i < 20; i++) { const c = genCode(); if (!codeToId.has(c)) return c; }
  return genCode(8);
}

function formatRoom(room) {
  return {
    id: room.id, code: room.code, name: room.name,
    isPublic: true, hasPassword: false, hostId: room.hostId,
    maxMembers: 10, memberCount: room.members.size,
    createdAt: room.createdAt, currentAnime: null, tags: [],
    members: [...room.members.entries()].map(([userId, m]) => ({
      userId, username: m.username, displayName: m.username, avatarUrl: null,
      role: m.role, joinedAt: m.joinedAt,
      presence: { isConnected: true, isBuffering: false, currentTime: 0, lastHeartbeat: Date.now() },
    })),
    settings: {
      syncMode: 'host-authority', allowGuestControl: false,
      bufferingPolicy: 'wait-threshold', driftThresholdMs: 500,
      maxMembers: 10, chatEnabled: true, slowMode: 0,
    },
    syncState: room.syncState,
  };
}

// ─── Express App ──────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve web UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Proxy endpoint — fetch anime page, inject adapter.js ──
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url parameter required');
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Referer': targetUrl,
      },
      redirect: 'follow',
    });
    const contentType = response.headers.get('content-type') || '';
    // Only proxy HTML pages
    if (!contentType.includes('text/html')) {
      // For non-HTML (images, css, js etc), redirect to original
      return res.redirect(targetUrl);
    }
    let html = await response.text();
    // Get base URL for relative paths
    const urlObj = new URL(targetUrl);
    const baseUrl = urlObj.origin;
    // Inject <base> tag so relative URLs resolve correctly
    if (!html.includes('<base')) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}/">`);
    }
    // Inject adapter.js before </body>
    const adapterScript = `<script src="/adapter.js?t=${Date.now()}"></script>`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', adapterScript + '</body>');
    } else {
      html += adapterScript;
    }
    // Remove X-Frame-Options and CSP from our response
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.status(502).send(`<html><body style="background:#0a0a0f;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Site yüklenemedi</h2><p>${err.message}</p><p style="color:#888;font-size:12px;">${targetUrl}</p></div></body></html>`);
  }
});
app.get('/app/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Health endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    rooms: rooms.size,
    timestamp: Date.now(),
  });
});

// ─── Socket.IO Server ────────────────────────────────────────

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', credentials: true },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
});

// Auth: just username
io.use((socket, next) => {
  const username = socket.handshake.auth?.username;
  if (!username || typeof username !== 'string' || username.trim().length < 1) {
    return next(new Error('USERNAME_REQUIRED'));
  }
  socket.userId = username.trim();
  socket.username = username.trim();
  next();
});

io.on('connection', (socket) => {
  const { userId, username } = socket;
  console.log(`[WS] Connected: ${username} (${socket.id})`);

  // ── Time Sync ──
  socket.on('time:ping', (data, cb) => {
    if (cb) cb({ clientSendTime: data.clientSendTime, serverTime: Date.now(), serverSendTime: Date.now() });
  });

  // ── Room Create ──
  socket.on('room:create', (data, cb) => {
    const code = uniqueCode();
    const id = genId();
    const room = {
      id, code, name: (data.name || 'Oda').trim().slice(0, 50),
      hostId: userId,
      members: new Map([[userId, { username, role: 'host', joinedAt: new Date().toISOString() }]]),
      syncState: { isPlaying: false, currentTime: 0, playbackSpeed: 1, generation: 0, lastEventAt: Date.now() },
      currentUrl: null,
      createdAt: new Date().toISOString(),
    };
    rooms.set(id, room);
    codeToId.set(code, id);
    socket.join(id);
    socket.roomId = id;
    console.log(`[Room] Created: ${room.name} (${code}) by ${username}`);
    cb({ success: true, room: formatRoom(room) });
  });

  // ── Room Join ──
  socket.on('room:join', (data, cb) => {
    const roomId = codeToId.get((data.code || '').toUpperCase());
    if (!roomId || !rooms.has(roomId)) { cb({ success: false, error: 'Oda bulunamadı' }); return; }
    const room = rooms.get(roomId);
    if (room.members.size >= 10) { cb({ success: false, error: 'Oda dolu' }); return; }

    room.members.set(userId, { username, role: 'viewer', joinedAt: new Date().toISOString() });
    socket.join(roomId);
    socket.roomId = roomId;

    socket.to(roomId).emit('room:member-joined', {
      member: {
        userId, username, displayName: username, avatarUrl: null,
        role: 'viewer', joinedAt: new Date().toISOString(),
        presence: { isConnected: true, isBuffering: false, currentTime: 0, lastHeartbeat: Date.now() },
      },
    });
    socket.to(roomId).emit('chat:system', { text: `${username} odaya katıldı` });
    console.log(`[Room] ${username} joined ${room.name} (${room.code})`);
    cb({ success: true, room: formatRoom(room), syncState: room.syncState, currentUrl: room.currentUrl });
  });

  // ── Room Leave ──
  socket.on('room:leave', () => handleLeave(socket));

  // ── Sync Events ──
  socket.on('sync:play', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.syncState.isPlaying = true;
    room.syncState.currentTime = data.time;
    room.syncState.generation++;
    room.syncState.lastEventAt = Date.now();
    io.to(data.roomId).emit('sync:play', {
      time: data.time, generation: room.syncState.generation,
      originUserId: userId, serverTimestamp: Date.now(),
    });
  });

  socket.on('sync:pause', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.syncState.isPlaying = false;
    room.syncState.currentTime = data.time;
    room.syncState.generation++;
    room.syncState.lastEventAt = Date.now();
    io.to(data.roomId).emit('sync:pause', {
      time: data.time, generation: room.syncState.generation,
      originUserId: userId, serverTimestamp: Date.now(),
    });
  });

  socket.on('sync:seek', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.syncState.currentTime = data.time;
    room.syncState.generation++;
    room.syncState.lastEventAt = Date.now();
    io.to(data.roomId).emit('sync:seek', {
      time: data.time, generation: room.syncState.generation,
      originUserId: userId, serverTimestamp: Date.now(),
    });
  });

  socket.on('sync:heartbeat', (data) => {
    io.to(data.roomId).emit('presence:room-update', {
      userId, presence: { isConnected: true, isBuffering: data.isBuffering, currentTime: data.currentTime, lastHeartbeat: Date.now() },
    });
  });

  socket.on('sync:request-state', (data, cb) => {
    const room = rooms.get(data.roomId);
    if (room && cb) cb(room.syncState);
  });

  // ── URL Sync (anime link sharing) ──
  socket.on('sync:url-changed', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.currentUrl = data.url;
    console.log(`[Sync] URL changed in ${room.name}: ${data.url}`);
    io.to(data.roomId).emit('sync:url-changed', {
      url: data.url,
      originUserId: userId,
      serverTimestamp: Date.now(),
    });
  });

  // ── Polling Sync (time correction every 3s) ──
  socket.on('sync:timecheck', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    // Broadcast to all OTHER members for drift correction
    socket.to(data.roomId).emit('sync:timecheck', {
      time: data.time,
      playing: data.playing,
      userId: userId,
      serverTimestamp: Date.now(),
    });
  });

  // ── Chat ──
  socket.on('chat:message', (data) => {
    const msg = {
      id: genId(), roomId: data.roomId, userId, username, displayName: username,
      avatarUrl: null, text: (data.text || '').slice(0, 500), type: data.type || 'text',
      reactions: [], createdAt: new Date().toISOString(), editedAt: null,
    };
    io.to(data.roomId).emit('chat:message', msg);
  });

  socket.on('chat:typing', (data) => {
    socket.to(data.roomId).emit('chat:typing', { userId, username, isTyping: data.isTyping });
  });

  // ── Discovery ──
  socket.on('rooms:discover', (_data, cb) => {
    const publicRooms = [...rooms.values()].filter(r => r.members.size > 0);
    cb({
      rooms: publicRooms.map(r => ({
        id: r.id, code: r.code, name: r.name, isPublic: true,
        hasPassword: false, hostId: r.hostId, maxMembers: 10,
        memberCount: r.members.size, createdAt: r.createdAt,
        currentAnime: null, tags: [], hostName: r.hostId,
      })),
      total: publicRooms.length, page: 1, hasMore: false,
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[WS] Disconnected: ${username}`);
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.members.delete(socket.userId);
  socket.leave(roomId);
  socket.roomId = undefined;

  if (room.members.size === 0) {
    rooms.delete(roomId);
    codeToId.delete(room.code);
    console.log(`[Room] Closed: ${room.name}`);
  } else {
    if (room.hostId === socket.userId) {
      const newHost = room.members.keys().next().value;
      room.hostId = newHost;
      room.members.get(newHost).role = 'host';
      io.to(roomId).emit('room:host-transferred', { newHostId: newHost });
    }
    socket.to(roomId).emit('room:member-left', { userId: socket.userId, reason: 'left' });
    socket.to(roomId).emit('chat:system', { text: `${socket.username} ayrıldı` });
  }
}

// ─── Keep-Alive: Self-ping every 10 minutes ──────────────────

setInterval(() => {
  const url = RENDER_URL + '/api/health';
  fetch(url).then(r => r.json()).then(data => {
    console.log(`[Keep-Alive] OK — uptime: ${data.uptime}s, rooms: ${data.rooms}`);
  }).catch(err => {
    console.log(`[Keep-Alive] Ping failed: ${err.message}`);
  });
}, 10 * 60 * 1000); // 10 dakika

// ─── Cleanup stale rooms every 30 minutes ────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.members.size === 0) {
      rooms.delete(id);
      codeToId.delete(room.code);
      console.log(`[Cleanup] Removed empty room: ${room.name}`);
    }
  }
}, 30 * 60 * 1000);

// ─── Start Server ─────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════');
  console.log(`  AniSync Server v1.0.0`);
  console.log(`  Port: ${PORT}`);
  console.log(`  URL: ${RENDER_URL}`);
  console.log(`  Keep-Alive: every 10 minutes`);
  console.log('═══════════════════════════════════════');
});
