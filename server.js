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
      userId, username: m.username, displayName: m.username, avatar: m.avatar || null,
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

// Auth: username + avatar
io.use((socket, next) => {
  const username = socket.handshake.auth?.username;
  if (!username || typeof username !== 'string' || username.trim().length < 1) {
    return next(new Error('USERNAME_REQUIRED'));
  }
  socket.userId = username.trim();
  socket.username = username.trim();
  socket.avatar = socket.handshake.auth?.avatar || null;
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
      members: new Map([[userId, { username, avatar: socket.avatar, role: 'host', joinedAt: new Date().toISOString() }]]),
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

    room.members.set(userId, { username, avatar: socket.avatar, role: 'viewer', joinedAt: new Date().toISOString() });
    socket.join(roomId);
    socket.roomId = roomId;

    socket.to(roomId).emit('room:member-joined', {
      member: {
        userId, username, displayName: username, avatar: socket.avatar || null,
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
    console.log(`[Sync] PLAY from ${userId} at ${data.time}s in room ${data.roomId}`);
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
    console.log(`[Sync] PAUSE from ${userId} at ${data.time}s`);
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
    console.log(`[Sync] SEEK from ${userId} to ${data.time}s`);
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

  // ── Avatar Update (live broadcast) ──
  socket.on('user:update-avatar', (data) => {
    const newAvatar = data?.avatar || null;
    socket.avatar = newAvatar;
    // Update in all rooms this user is in
    for (const [roomId, room] of rooms.entries()) {
      const member = room.members.get(userId);
      if (member) {
        member.avatar = newAvatar;
        socket.to(roomId).emit('user:avatar-changed', { userId, avatar: newAvatar });
      }
    }
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
