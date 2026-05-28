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
const BOOT_TIME = Date.now();

// ─── In-Memory State ──────────────────────────────────────────

const rooms = new Map();
const codeToId = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Grace period: track disconnected users who might reconnect
// Key: `${roomId}:${userId}`, Value: { timeout, room, memberData }
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 30000; // 30 seconds grace period

// Pending join requests: users waiting for host approval
// Key: `${roomId}:${userId}`, Value: { userId, username, avatar, socketId, timestamp }
const pendingJoins = new Map();

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
    theme: room.theme || 'night',
    members: [...room.members.entries()].map(([userId, m]) => ({
      userId, username: m.username, displayName: m.username, avatar: m.avatar || null,
      role: m.role, joinedAt: m.joinedAt,
      presence: { isConnected: !m.disconnected, isBuffering: false, currentTime: 0, lastHeartbeat: Date.now() },
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
    bootTime: BOOT_TIME,
    coldStartAge: Math.floor((Date.now() - BOOT_TIME) / 1000),
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

  // ── Duplicate Socket Prevention ──
  // If same userId connects with a new socket, disconnect old ones
  for (const [id, existingSocket] of io.sockets.sockets) {
    if (id !== socket.id && existingSocket.userId === userId && existingSocket.connected) {
      console.log(`[WS] Disconnecting duplicate socket for ${username}: ${id}`);
      existingSocket.roomId = undefined; // Prevent handleLeave from triggering grace period
      existingSocket.disconnect(true);
    }
  }

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
      theme: 'night', // Default theme
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

    // Check if this user is reconnecting (cancel grace period timer)
    const graceKey = `${roomId}:${userId}`;
    if (disconnectTimers.has(graceKey)) {
      clearTimeout(disconnectTimers.get(graceKey).timeout);
      disconnectTimers.delete(graceKey);
      console.log(`[Room] ${username} reconnected within grace period`);
    }

    // If user is already in the room (reconnect), just update socket
    if (room.members.has(userId)) {
      const existingMember = room.members.get(userId);
      existingMember.avatar = socket.avatar || existingMember.avatar;
      existingMember.disconnected = false;
      socket.join(roomId);
      socket.roomId = roomId;
      // Notify others that this user is back online
      socket.to(roomId).emit('room:member-reconnected', {
        userId, username, avatar: existingMember.avatar,
      });
      console.log(`[Room] ${username} rejoined ${room.name} (same user)`);
      cb({ success: true, room: formatRoom(room), syncState: room.syncState, currentUrl: room.currentUrl });
      return;
    }

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

  // ── Room Rejoin (after reconnect) ──
  socket.on('room:rejoin', (data, cb) => {
    const roomId = data.roomId;
    if (!roomId || !rooms.has(roomId)) {
      cb({ success: false, error: 'Oda bulunamadı' });
      return;
    }
    const room = rooms.get(roomId);

    // Cancel any pending disconnect timer
    const graceKey = `${roomId}:${userId}`;
    if (disconnectTimers.has(graceKey)) {
      clearTimeout(disconnectTimers.get(graceKey).timeout);
      disconnectTimers.delete(graceKey);
      console.log(`[Room] ${username} rejoin cancelled grace timer`);
    }

    // If user is still in room members
    if (room.members.has(userId)) {
      const member = room.members.get(userId);
      member.disconnected = false;
      member.avatar = socket.avatar || member.avatar;
      socket.join(roomId);
      socket.roomId = roomId;
      // Broadcast reconnection to others
      socket.to(roomId).emit('room:member-reconnected', { userId, username, avatar: member.avatar });
      console.log(`[Room] ${username} rejoined ${room.name} (still member)`);
      cb({ success: true, room: formatRoom(room), syncState: room.syncState, currentUrl: room.currentUrl });
    } else {
      // User was fully removed, rejoin as new member
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
      console.log(`[Room] ${username} rejoined ${room.name} (as new member)`);
      cb({ success: true, room: formatRoom(room), syncState: room.syncState, currentUrl: room.currentUrl });
    }
  });

  // ── Room Leave ──
  socket.on('room:leave', () => handleLeave(socket, false));

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

  // ── Polling Sync (time correction) ──
  socket.on('sync:timecheck', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
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
      timestamp: Date.now(),
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
      rooms: publicRooms.map(r => {
        // Collect member avatars (first 5)
        const memberAvatars = [];
        for (const [uid, m] of r.members) {
          if (m.avatar) memberAvatars.push(m.avatar);
          if (memberAvatars.length >= 5) break;
        }
        // Count pending requests for this room
        let pendingCount = 0;
        for (const key of pendingJoins.keys()) {
          if (key.startsWith(r.id + ':')) pendingCount++;
        }
        const hostMember = r.members.get(r.hostId);
        return {
          id: r.id, code: r.code, name: r.name, isPublic: true,
          hasPassword: false, hostId: r.hostId, maxMembers: 10,
          memberCount: r.members.size, createdAt: r.createdAt,
          currentAnime: null, tags: [], hostName: r.hostId,
          hostAvatar: hostMember?.avatar || null,
          memberAvatars,
          pendingCount,
        };
      }),
      total: publicRooms.length, page: 1, hasMore: false,
    });
  });

  // ── Join Request (approval system for ongoing rooms) ──
  socket.on('room:request-join', (data, cb) => {
    const roomId = data.roomId;
    if (!roomId || !rooms.has(roomId)) {
      if (cb) cb({ success: false, error: 'Oda bulunamadı' });
      return;
    }
    const room = rooms.get(roomId);
    if (room.members.size >= 10) {
      if (cb) cb({ success: false, error: 'Oda dolu' });
      return;
    }
    // Already a member?
    if (room.members.has(userId)) {
      if (cb) cb({ success: false, error: 'Zaten bu odadasın' });
      return;
    }
    const pendingKey = `${roomId}:${userId}`;
    // Already pending?
    if (pendingJoins.has(pendingKey)) {
      if (cb) cb({ success: true, status: 'already_pending' });
      return;
    }
    // Store pending request
    pendingJoins.set(pendingKey, {
      userId, username, avatar: socket.avatar,
      socketId: socket.id, roomId, timestamp: Date.now(),
    });
    // Notify host
    const hostSockets = [...io.sockets.sockets.values()].filter(s => s.userId === room.hostId && s.roomId === roomId);
    for (const hs of hostSockets) {
      hs.emit('room:join-request', {
        userId, username, avatar: socket.avatar,
        roomId, roomName: room.name, timestamp: Date.now(),
      });
    }
    console.log(`[Room] ${username} requested to join ${room.name}`);
    if (cb) cb({ success: true, status: 'pending', roomName: room.name, hostName: room.hostId });
  });

  // ── Approve Join Request (host only) ──
  socket.on('room:approve-join', (data) => {
    const roomId = data.roomId;
    const targetUserId = data.userId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return; // Only host can approve
    const pendingKey = `${roomId}:${targetUserId}`;
    const pending = pendingJoins.get(pendingKey);
    if (!pending) return;
    pendingJoins.delete(pendingKey);
    // Find the pending user's socket
    const targetSocket = io.sockets.sockets.get(pending.socketId);
    if (!targetSocket || !targetSocket.connected) {
      console.log(`[Room] Approved ${pending.username} but they disconnected`);
      return;
    }
    // Add to room
    room.members.set(targetUserId, {
      username: pending.username, avatar: pending.avatar,
      role: 'viewer', joinedAt: new Date().toISOString(),
    });
    targetSocket.join(roomId);
    targetSocket.roomId = roomId;
    // Notify the approved user
    targetSocket.emit('room:join-approved', {
      room: formatRoom(room), syncState: room.syncState, currentUrl: room.currentUrl,
    });
    // Notify room members
    targetSocket.to(roomId).emit('room:member-joined', {
      member: {
        userId: targetUserId, username: pending.username, displayName: pending.username,
        avatar: pending.avatar || null, role: 'viewer', joinedAt: new Date().toISOString(),
        presence: { isConnected: true, isBuffering: false, currentTime: 0, lastHeartbeat: Date.now() },
      },
    });
    io.to(roomId).emit('chat:system', { text: `${pending.username} odaya katıldı` });
    console.log(`[Room] ${pending.username} approved to join ${room.name} by ${username}`);
  });

  // ── Reject Join Request (host only) ──
  socket.on('room:reject-join', (data) => {
    const roomId = data.roomId;
    const targetUserId = data.userId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;
    const pendingKey = `${roomId}:${targetUserId}`;
    const pending = pendingJoins.get(pendingKey);
    if (!pending) return;
    pendingJoins.delete(pendingKey);
    // Notify the rejected user
    const targetSocket = io.sockets.sockets.get(pending.socketId);
    if (targetSocket && targetSocket.connected) {
      targetSocket.emit('room:join-rejected', { roomId, roomName: room.name, reason: 'Host tarafından reddedildi' });
    }
    console.log(`[Room] ${pending.username} rejected from ${room.name} by ${username}`);
  });

  // ── Cancel Join Request (requester cancels) ──
  socket.on('room:cancel-request', (data) => {
    const pendingKey = `${data.roomId}:${userId}`;
    if (pendingJoins.has(pendingKey)) {
      pendingJoins.delete(pendingKey);
      // Notify host that request was cancelled
      const room = rooms.get(data.roomId);
      if (room) {
        const hostSockets = [...io.sockets.sockets.values()].filter(s => s.userId === room.hostId && s.roomId === data.roomId);
        for (const hs of hostSockets) {
          hs.emit('room:request-cancelled', { userId, username });
        }
      }
      console.log(`[Room] ${username} cancelled join request`);
    }
  });

  // ── Avatar Update (live broadcast) ──
  socket.on('user:update-avatar', (data) => {
    const newAvatar = data?.avatar || null;
    socket.avatar = newAvatar;
    for (const [roomId, room] of rooms.entries()) {
      const member = room.members.get(userId);
      if (member) {
        member.avatar = newAvatar;
        socket.to(roomId).emit('user:avatar-changed', { userId, avatar: newAvatar });
      }
    }
  });

  // ── Username Update ──
  socket.on('user:update-username', (data) => {
    const newUsername = (data?.username || '').trim().slice(0, 20);
    if (!newUsername) return;
    socket.username = newUsername;
    // Note: userId stays the same (original username), but display can change
    console.log(`[User] ${username} display name changed to ${newUsername}`);
  });

  // ── Room Theme ──
  socket.on('room:set-theme', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    if (!room.members.has(userId)) return; // Must be member
    room.theme = data.themeId || 'night';
    io.to(data.roomId).emit('room:theme-changed', { themeId: room.theme, changedBy: username });
    console.log(`[Room] Theme changed to '${room.theme}' in ${room.name} by ${username}`);
  });

  // ── Disconnect — with grace period ──
  socket.on('disconnect', () => {
    console.log(`[WS] Disconnected: ${username}`);
    handleLeave(socket, true); // true = use grace period
  });
});

function handleLeave(socket, useGrace = false) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const { userId, username } = socket;

  // If explicit leave (user clicked Leave), remove immediately
  if (!useGrace) {
    performLeave(room, roomId, socket);
    return;
  }

  // Grace period: mark user as disconnected but keep in room
  const member = room.members.get(userId);
  if (!member) return;
  member.disconnected = true;

  // Notify others that user went offline (but still in room)
  socket.to(roomId).emit('presence:room-update', {
    userId, presence: { isConnected: false, isBuffering: false, currentTime: 0, lastHeartbeat: Date.now() },
  });

  socket.leave(roomId);
  socket.roomId = undefined;

  // Set timer to fully remove after grace period
  const graceKey = `${roomId}:${userId}`;

  // Clear any existing timer for this user
  if (disconnectTimers.has(graceKey)) {
    clearTimeout(disconnectTimers.get(graceKey).timeout);
  }

  const timeout = setTimeout(() => {
    disconnectTimers.delete(graceKey);
    // Check if user is still disconnected (didn't reconnect)
    const currentRoom = rooms.get(roomId);
    if (!currentRoom) return;
    const currentMember = currentRoom.members.get(userId);
    if (!currentMember || !currentMember.disconnected) return;

    // Actually remove the user now
    console.log(`[Room] Grace period expired for ${username} in ${currentRoom.name}`);
    currentRoom.members.delete(userId);

    if (currentRoom.members.size === 0) {
      rooms.delete(roomId);
      codeToId.delete(currentRoom.code);
      console.log(`[Room] Closed: ${currentRoom.name}`);
    } else {
      if (currentRoom.hostId === userId) {
        const newHost = currentRoom.members.keys().next().value;
        currentRoom.hostId = newHost;
        currentRoom.members.get(newHost).role = 'host';
        io.to(roomId).emit('room:host-transferred', { newHostId: newHost });
      }
      io.to(roomId).emit('room:member-left', { userId, reason: 'timeout' });
      io.to(roomId).emit('chat:system', { text: `${username} bağlantısı koptu` });
    }
  }, DISCONNECT_GRACE_MS);

  disconnectTimers.set(graceKey, { timeout, userId, username });
  console.log(`[Room] ${username} disconnected, grace period ${DISCONNECT_GRACE_MS / 1000}s started`);
}

function performLeave(room, roomId, socket) {
  const { userId, username } = socket;

  // Cancel any grace timer
  const graceKey = `${roomId}:${userId}`;
  if (disconnectTimers.has(graceKey)) {
    clearTimeout(disconnectTimers.get(graceKey).timeout);
    disconnectTimers.delete(graceKey);
  }

  room.members.delete(userId);
  socket.leave(roomId);
  socket.roomId = undefined;

  if (room.members.size === 0) {
    rooms.delete(roomId);
    codeToId.delete(room.code);
    console.log(`[Room] Closed: ${room.name}`);
  } else {
    if (room.hostId === userId) {
      const newHost = room.members.keys().next().value;
      room.hostId = newHost;
      room.members.get(newHost).role = 'host';
      io.to(roomId).emit('room:host-transferred', { newHostId: newHost });
    }
    socket.to(roomId).emit('room:member-left', { userId, reason: 'left' });
    socket.to(roomId).emit('chat:system', { text: `${username} ayrıldı` });
  }
}

// ─── Keep-Alive: Self-ping every 5 minutes ───────────────────

setInterval(() => {
  const url = RENDER_URL + '/api/health';
  fetch(url).then(r => r.json()).then(data => {
    console.log(`[Keep-Alive] OK — uptime: ${data.uptime}s, rooms: ${data.rooms}`);
  }).catch(err => {
    console.log(`[Keep-Alive] Ping failed: ${err.message}`);
  });
}, 5 * 60 * 1000);

// ─── Cleanup stale rooms every 30 minutes ────────────────────

setInterval(() => {
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
  console.log(`  AniSync Server v1.1.0`);
  console.log(`  Port: ${PORT}`);
  console.log(`  URL: ${RENDER_URL}`);
  console.log(`  Grace Period: ${DISCONNECT_GRACE_MS / 1000}s`);
  console.log(`  Keep-Alive: every 5 minutes`);
  console.log('═══════════════════════════════════════');
});
