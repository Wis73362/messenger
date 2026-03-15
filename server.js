const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const users = new Map();
const sessions = new Map();
const socketsByUser = new Map();

const channels = new Map();
const dms = new Map();
const messagesByRoom = new Map();

const now = () => new Date().toISOString();

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function createDefaultData() {
  const lobby = {
    id: 'channel-general',
    type: 'channel',
    title: '💬 general',
    description: 'Общий канал для обсуждений',
    createdAt: now()
  };

  const updates = {
    id: 'channel-updates',
    type: 'channel',
    title: '📢 updates',
    description: 'Новости продукта и анонсы',
    createdAt: now()
  };

  channels.set(lobby.id, lobby);
  channels.set(updates.id, updates);
  messagesByRoom.set(lobby.id, []);
  messagesByRoom.set(updates.id, []);

  const systemMessage = (roomId, text) => {
    messagesByRoom.get(roomId).push({
      id: uuid(),
      roomId,
      senderId: 'system',
      senderName: 'CoreLogic Bot',
      text,
      createdAt: now(),
      editedAt: null,
      replyTo: null,
      pinned: false,
      reactions: {}
    });
  };

  systemMessage(lobby.id, 'Добро пожаловать в CoreLogic! Настройте профиль и выберите любимую тему интерфейса.');
  systemMessage(updates.id, 'Доступны каналы, ЛС, реакции, ответы, профиль и контекстные действия для сообщений.');
}

createDefaultData();

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const userId = sessions.get(token);
  if (!userId || !users.has(userId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = users.get(userId);
  req.token = token;
  next();
}

function roomSummary(userId) {
  const allChannels = [...channels.values()].map((c) => ({ ...c, unread: 0 }));
  const allDms = [...dms.values()]
    .filter((dm) => dm.members.includes(userId))
    .map((dm) => ({
      ...dm,
      unread: 0,
      counterpart: dm.members.find((id) => id !== userId)
    }));

  return { channels: allChannels, dms: allDms };
}

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if ([...users.values()].some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const user = {
    id: uuid(),
    username,
    displayName: username,
    password,
    bio: 'Новый участник CoreLogic',
    avatarColor: `hsl(${Math.floor(Math.random() * 360)} 80% 60%)`,
    avatarIcon: '🙂',
    createdAt: now(),
    status: 'offline'
  };

  users.set(user.id, user);

  const token = uuid();
  sessions.set(token, user.id);

  return res.json({ token, user: publicUser(user), rooms: roomSummary(user.id) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = [...users.values()].find((u) => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = uuid();
  sessions.set(token, user.id);
  return res.json({ token, user: publicUser(user), rooms: roomSummary(user.id) });
});

app.patch('/api/profile', auth, (req, res) => {
  const { displayName, bio, avatarColor, avatarIcon } = req.body;

  if (displayName && displayName.length > 24) return res.status(400).json({ error: 'Display name too long' });
  if (bio && bio.length > 80) return res.status(400).json({ error: 'Bio too long' });

  if (typeof displayName === 'string' && displayName.trim()) req.user.displayName = displayName.trim();
  if (typeof bio === 'string') req.user.bio = bio.trim();
  if (typeof avatarColor === 'string' && avatarColor) req.user.avatarColor = avatarColor;
  if (typeof avatarIcon === 'string' && avatarIcon) req.user.avatarIcon = avatarIcon.slice(0, 2);

  io.emit('profile:updated', publicUser(req.user));
  res.json(publicUser(req.user));
});

app.get('/api/bootstrap', auth, (req, res) => {
  const online = [...users.values()].filter((u) => u.status === 'online').map((u) => ({ id: u.id, username: u.username }));
  res.json({
    user: publicUser(req.user),
    rooms: roomSummary(req.user.id),
    users: [...users.values()].map((u) => publicUser(u)),
    online
  });
});

app.get('/api/rooms/:roomId/messages', auth, (req, res) => {
  const { roomId } = req.params;
  if (!messagesByRoom.has(roomId)) return res.json([]);

  const room = channels.get(roomId) || dms.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.type === 'dm' && !room.members.includes(req.user.id)) {
    return res.status(403).json({ error: 'No access' });
  }

  res.json(messagesByRoom.get(roomId));
});

app.post('/api/channels', auth, (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const channel = { id: `channel-${uuid()}`, type: 'channel', title, description: description || '', createdAt: now() };
  channels.set(channel.id, channel);
  messagesByRoom.set(channel.id, []);
  io.emit('room:new', { room: channel, roomType: 'channel' });
  res.json(channel);
});

app.post('/api/dms', auth, (req, res) => {
  const { memberId } = req.body;
  if (!memberId || !users.has(memberId)) return res.status(400).json({ error: 'Valid memberId required' });
  if (memberId === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const existing = [...dms.values()].find((room) => {
    const m = room.members;
    return m.includes(req.user.id) && m.includes(memberId) && m.length === 2;
  });

  if (existing) return res.json(existing);

  const dm = {
    id: `dm-${uuid()}`,
    type: 'dm',
    title: `💬 ${req.user.displayName || req.user.username} & ${users.get(memberId).displayName || users.get(memberId).username}`,
    members: [req.user.id, memberId],
    createdAt: now()
  };

  dms.set(dm.id, dm);
  messagesByRoom.set(dm.id, []);
  dm.members.forEach((userId) => {
    const sock = socketsByUser.get(userId);
    if (sock) io.to(sock).emit('room:new', { room: dm, roomType: 'dm' });
  });

  res.json(dm);
});

app.get('/api/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  const results = [];
  for (const [roomId, list] of messagesByRoom) {
    const room = channels.get(roomId) || dms.get(roomId);
    if (!room) continue;
    if (room.type === 'dm' && !room.members.includes(req.user.id)) continue;
    list.forEach((m) => {
      if (m.text.toLowerCase().includes(q)) {
        results.push({ roomId, roomTitle: room.title, message: m });
      }
    });
  }
  res.json(results.slice(-50).reverse());
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const userId = sessions.get(token);
  if (!userId || !users.has(userId)) return next(new Error('Unauthorized'));
  socket.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const user = users.get(socket.userId);
  socketsByUser.set(user.id, socket.id);
  user.status = 'online';

  socket.emit('presence:init', [...users.values()].map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, status: u.status })));
  socket.broadcast.emit('presence:update', { id: user.id, status: 'online' });

  [...channels.keys(), ...[...dms.values()].filter((dm) => dm.members.includes(user.id)).map((dm) => dm.id)].forEach((roomId) => {
    socket.join(roomId);
  });

  socket.on('room:join', ({ roomId }) => {
    socket.join(roomId);
  });

  socket.on('typing:start', ({ roomId }) => {
    socket.to(roomId).emit('typing:update', { roomId, userId: user.id, username: user.displayName || user.username, typing: true });
  });

  socket.on('typing:stop', ({ roomId }) => {
    socket.to(roomId).emit('typing:update', { roomId, userId: user.id, username: user.displayName || user.username, typing: false });
  });

  socket.on('message:send', ({ roomId, text, replyTo }) => {
    if (!messagesByRoom.has(roomId) || !text?.trim()) return;
    const room = channels.get(roomId) || dms.get(roomId);
    if (!room) return;
    if (room.type === 'dm' && !room.members.includes(user.id)) return;

    const message = {
      id: uuid(),
      roomId,
      senderId: user.id,
      senderName: user.displayName || user.username,
      text: text.trim(),
      createdAt: now(),
      editedAt: null,
      replyTo: replyTo || null,
      pinned: false,
      reactions: {}
    };

    messagesByRoom.get(roomId).push(message);
    io.to(roomId).emit('message:new', message);
  });

  socket.on('message:edit', ({ roomId, messageId, text }) => {
    const list = messagesByRoom.get(roomId);
    if (!list) return;
    const msg = list.find((m) => m.id === messageId && m.senderId === user.id);
    if (!msg || !text?.trim()) return;
    msg.text = text.trim();
    msg.editedAt = now();
    io.to(roomId).emit('message:updated', msg);
  });

  socket.on('message:delete', ({ roomId, messageId }) => {
    const list = messagesByRoom.get(roomId);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === messageId && m.senderId === user.id);
    if (idx < 0) return;
    const [deleted] = list.splice(idx, 1);
    io.to(roomId).emit('message:deleted', { roomId, messageId: deleted.id });
  });

  socket.on('message:pin', ({ roomId, messageId }) => {
    const list = messagesByRoom.get(roomId);
    if (!list) return;
    const msg = list.find((m) => m.id === messageId);
    if (!msg) return;
    msg.pinned = !msg.pinned;
    io.to(roomId).emit('message:updated', msg);
  });

  socket.on('message:react', ({ roomId, messageId, emoji }) => {
    const list = messagesByRoom.get(roomId);
    if (!list) return;
    const msg = list.find((m) => m.id === messageId);
    if (!msg || !emoji) return;

    msg.reactions[emoji] = msg.reactions[emoji] || [];
    if (msg.reactions[emoji].includes(user.id)) {
      msg.reactions[emoji] = msg.reactions[emoji].filter((id) => id !== user.id);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(user.id);
    }

    io.to(roomId).emit('message:updated', msg);
  });

  socket.on('disconnect', () => {
    socketsByUser.delete(user.id);
    user.status = 'offline';
    socket.broadcast.emit('presence:update', { id: user.id, status: 'offline' });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CoreLogic Messenger running on http://localhost:${PORT}`);
});
