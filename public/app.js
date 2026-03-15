const state = {
  token: null,
  me: null,
  rooms: { channels: [], dms: [] },
  users: [],
  activeRoomId: null,
  messages: [],
  replyTo: null,
  typingMap: new Map(),
  socket: null,
  settings: {
    theme: localStorage.getItem('corelogic.theme') || 'dark',
    compactMode: localStorage.getItem('corelogic.compact') === '1',
    showSeconds: localStorage.getItem('corelogic.seconds') === '1'
  }
};

const $ = (id) => document.getElementById(id);

initUi();

function initUi() {
  applyTheme(state.settings.theme);
  document.body.classList.toggle('compact-mode', state.settings.compactMode);
  $('compact-mode').checked = state.settings.compactMode;
  $('show-seconds').checked = state.settings.showSeconds;

  $('open-auth').onclick = () => $('auth-modal').classList.remove('hidden');
  $('close-auth').onclick = () => $('auth-modal').classList.add('hidden');

  $('register').onclick = () => auth('register');
  $('login').onclick = () => auth('login');

  $('open-settings').onclick = () => {
    fillSettingsForm();
    $('settings-modal').classList.remove('hidden');
  };
  $('close-settings').onclick = () => $('settings-modal').classList.add('hidden');

  $('save-profile').onclick = saveProfile;

  $('compact-mode').addEventListener('change', (e) => {
    state.settings.compactMode = e.target.checked;
    document.body.classList.toggle('compact-mode', state.settings.compactMode);
    localStorage.setItem('corelogic.compact', state.settings.compactMode ? '1' : '0');
  });

  $('show-seconds').addEventListener('change', (e) => {
    state.settings.showSeconds = e.target.checked;
    localStorage.setItem('corelogic.seconds', state.settings.showSeconds ? '1' : '0');
    renderMessages();
  });

  [...$('theme-options').querySelectorAll('button')].forEach((btn) => {
    btn.onclick = () => applyTheme(btn.dataset.theme);
  });

  $('new-channel').onclick = async () => {
    const title = prompt('Название канала');
    if (!title) return;
    await api('/api/channels', { method: 'POST', body: JSON.stringify({ title }) });
  };

  $('new-dm').onclick = async () => {
    const username = prompt('Логин пользователя для ЛС');
    if (!username) return;
    const target = state.users.find((u) => u.username === username);
    if (!target) return alert('Пользователь не найден');
    const room = await api('/api/dms', { method: 'POST', body: JSON.stringify({ memberId: target.id }) });
    loadRooms({ ...state.rooms, dms: [...state.rooms.dms.filter((d) => d.id !== room.id), room] });
  };

  $('search').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (!q) return ($('search-results').innerHTML = '');
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('search-results').innerHTML = `<h4>Найдено</h4>${results
      .map(
        (r) =>
          `<div class="search-item" data-room-id="${r.roomId}"><b>${escapeHtml(r.roomTitle)}</b><div>${escapeHtml(r.message.text)}</div></div>`
      )
      .join('')}`;

    [...$('search-results').querySelectorAll('.search-item')].forEach((el) => {
      el.onclick = () => openRoom(el.dataset.roomId);
    });
  });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('message-input').value.trim();
    if (!text || !state.activeRoomId) return;
    state.socket.emit('message:send', { roomId: state.activeRoomId, text, replyTo: state.replyTo?.id || null });
    $('message-input').value = '';
    setReply(null);
    state.socket.emit('typing:stop', { roomId: state.activeRoomId });
  });

  $('message-input').addEventListener('input', () => {
    if (!state.activeRoomId || !state.socket) return;
    state.socket.emit('typing:start', { roomId: state.activeRoomId });
    clearTimeout(window.typingTimeout);
    window.typingTimeout = setTimeout(() => state.socket.emit('typing:stop', { roomId: state.activeRoomId }), 800);
  });
}

function fillSettingsForm() {
  if (!state.me) return;
  $('profile-nick').value = state.me.displayName || state.me.username;
  $('profile-bio').value = state.me.bio || '';
  $('profile-avatar-icon').value = state.me.avatarIcon || '🙂';
  $('profile-avatar-color').value = state.me.avatarColor || '#5865f2';
}

async function saveProfile() {
  try {
    const payload = {
      displayName: $('profile-nick').value.trim(),
      bio: $('profile-bio').value.trim(),
      avatarIcon: $('profile-avatar-icon').value.trim() || '🙂',
      avatarColor: $('profile-avatar-color').value
    };
    const updated = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(payload) });
    state.me = updated;
    syncMeUi();
    $('settings-modal').classList.add('hidden');
  } catch (err) {
    alert(err.message || 'Не удалось сохранить профиль');
  }
}

function applyTheme(theme) {
  state.settings.theme = theme;
  localStorage.setItem('corelogic.theme', theme);
  document.body.dataset.theme = theme;
  [...$('theme-options').querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
}

async function auth(mode) {
  const username = $('username').value.trim();
  const password = $('password').value.trim();
  try {
    const data = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).then((r) => r.json());

    if (data.error) throw new Error(data.error);
    state.token = data.token;
    state.me = data.user;
    state.rooms = data.rooms;
    $('auth-modal').classList.add('hidden');
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
    await bootstrap();
  } catch (e) {
    $('auth-error').textContent = e.message;
  }
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  state.users = data.users;
  state.rooms = data.rooms;
  state.me = data.user;
  syncMeUi();
  loadRooms(state.rooms);
  renderOnline(data.online);
  connectSocket();
}

function syncMeUi() {
  $('me-name').textContent = state.me.displayName || state.me.username;
  $('me-status').textContent = state.me.bio || 'В сети';
  $('avatar').style.background = state.me.avatarColor;
  $('avatar').textContent = state.me.avatarIcon || '🙂';
}

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('room:new', ({ room, roomType }) => {
    if (roomType === 'channel') state.rooms.channels.push(room);
    else state.rooms.dms.push(room);
    loadRooms(state.rooms);
  });

  state.socket.on('message:new', (message) => {
    if (message.roomId !== state.activeRoomId) return;
    state.messages.push(message);
    renderMessages();
  });

  state.socket.on('message:updated', (message) => {
    const i = state.messages.findIndex((m) => m.id === message.id);
    if (i >= 0) state.messages[i] = message;
    renderMessages();
  });

  state.socket.on('message:deleted', ({ messageId }) => {
    state.messages = state.messages.filter((m) => m.id !== messageId);
    renderMessages();
  });

  state.socket.on('profile:updated', (user) => {
    const index = state.users.findIndex((u) => u.id === user.id);
    if (index >= 0) state.users[index] = user;
    if (state.me?.id === user.id) {
      state.me = user;
      syncMeUi();
    }
    renderOnline(state.users.filter((u) => u.status === 'online'));
  });

  state.socket.on('presence:init', (list) => renderOnline(list.filter((u) => u.status === 'online')));
  state.socket.on('presence:update', ({ id, status }) => {
    const user = state.users.find((u) => u.id === id);
    if (user) user.status = status;
    renderOnline(state.users.filter((u) => u.status === 'online'));
  });

  state.socket.on('typing:update', ({ roomId, username, typing }) => {
    if (roomId !== state.activeRoomId) return;
    if (typing) state.typingMap.set(username, true);
    else state.typingMap.delete(username);
    $('typing').textContent = state.typingMap.size ? `${[...state.typingMap.keys()].join(', ')} печатает...` : '';
  });
}

function loadRooms(rooms) {
  const render = (arr, id) => {
    $(id).innerHTML = arr
      .map((room) => `<li class="${state.activeRoomId === room.id ? 'active' : ''}" data-room="${room.id}">${escapeHtml(room.title)}</li>`)
      .join('');
    [...$(id).querySelectorAll('li')].forEach((li) => {
      li.onclick = () => openRoom(li.dataset.room);
    });
  };
  render(rooms.channels, 'channels');
  render(rooms.dms, 'dms');
}

async function openRoom(roomId) {
  state.activeRoomId = roomId;
  state.typingMap.clear();
  $('typing').textContent = '';
  loadRooms(state.rooms);
  state.socket?.emit('room:join', { roomId });
  const room = [...state.rooms.channels, ...state.rooms.dms].find((r) => r.id === roomId);
  $('room-title').textContent = room ? room.title : 'Чат';
  state.messages = await api(`/api/rooms/${roomId}/messages`);
  renderMessages();
}

function renderMessages() {
  $('messages').innerHTML = state.messages
    .map((m) => {
      const reply = m.replyTo ? state.messages.find((x) => x.id === m.replyTo) : null;
      const reactions = Object.entries(m.reactions || {})
        .map(([emoji, ids]) => `<button class="reaction-btn" data-react="${emoji}" data-mid="${m.id}">${emoji} ${ids.length}</button>`)
        .join('');

      const timeOpts = state.settings.showSeconds
        ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' };

      return `<div class="message" data-mid="${m.id}">
        <div class="msg-main">
          <div class="author-row"><b>${escapeHtml(m.senderName)}</b> ${m.pinned ? '<span class="pin">📌</span>' : ''}</div>
          <div class="meta">${new Date(m.createdAt).toLocaleTimeString([], timeOpts)} ${m.editedAt ? '· изменено' : ''}</div>
          ${reply ? `<div class="reply">Ответ на: ${escapeHtml(reply.text)}</div>` : ''}
          <div class="msg-text">${escapeHtml(m.text)}</div>
          <div class="reactions">${reactions}</div>
        </div>
        <button class="message-menu-trigger icon-btn" data-action="toggle-menu" data-mid="${m.id}" title="Действия">
          <svg viewBox="0 0 24 24"><path d="M6 12A2 2 0 1 0 6 12ZM12 12A2 2 0 1 0 12 12ZM18 12A2 2 0 1 0 18 12Z"/></svg>
        </button>
        <div class="context-menu hidden" id="menu-${m.id}">
          <button data-action="reply" data-mid="${m.id}">↩ Ответить</button>
          <button data-action="react" data-mid="${m.id}">✨ Реакция</button>
          <button data-action="pin" data-mid="${m.id}">${m.pinned ? '📌 Снять пин' : '📌 Закрепить'}</button>
          ${m.senderId === state.me.id ? `<button data-action="edit" data-mid="${m.id}">✏ Редактировать</button><button data-action="delete" data-mid="${m.id}" class="danger">🗑 Удалить</button>` : ''}
        </div>
      </div>`;
    })
    .join('');

  [...$('messages').querySelectorAll('button')].forEach((btn) => {
    const mid = btn.dataset.mid;
    if (!mid) return;

    if (btn.dataset.react) {
      btn.onclick = () => state.socket.emit('message:react', { roomId: state.activeRoomId, messageId: mid, emoji: btn.dataset.react });
      return;
    }

    const action = btn.dataset.action;
    btn.onclick = (event) => {
      event.stopPropagation();
      const msg = state.messages.find((m) => m.id === mid);
      if (!msg) return;

      if (action === 'toggle-menu') {
        closeAllMenus();
        const menu = $(`menu-${mid}`);
        menu.classList.toggle('hidden');
        return;
      }
      closeAllMenus();
      if (action === 'reply') setReply(msg);
      if (action === 'react') state.socket.emit('message:react', { roomId: state.activeRoomId, messageId: mid, emoji: '🔥' });
      if (action === 'pin') state.socket.emit('message:pin', { roomId: state.activeRoomId, messageId: mid });
      if (action === 'edit') {
        const text = prompt('Новый текст', msg.text);
        if (text) state.socket.emit('message:edit', { roomId: state.activeRoomId, messageId: mid, text });
      }
      if (action === 'delete') state.socket.emit('message:delete', { roomId: state.activeRoomId, messageId: mid });
    };
  });

  document.addEventListener('click', closeAllMenus, { once: true });
  $('messages').scrollTop = $('messages').scrollHeight;
}

function closeAllMenus() {
  [...document.querySelectorAll('.context-menu')].forEach((el) => el.classList.add('hidden'));
}

function setReply(message) {
  state.replyTo = message;
  if (!message) return $('reply-box').classList.add('hidden');
  $('reply-box').classList.remove('hidden');
  $('reply-box').textContent = `Ответ на: ${message.senderName} — ${message.text}`;
}

function renderOnline(users) {
  $('online-list').innerHTML =
    users
      .map((u) => `<li>${escapeHtml(u.displayName || u.username)} <span class="online-dot">●</span></li>`)
      .join('') || '<li>Никого</li>';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
