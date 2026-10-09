// Połączenie z serwerem, z którego została załadowana strona (działa lokalnie i na Renderze).
const socket = io();

const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const loginForm = document.getElementById('login-form');
const nickInput = document.getElementById('nick-input');
const loginError = document.getElementById('login-error');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const typingEl = document.getElementById('typing');
const statusEl = document.getElementById('status');
const onlineEl = document.getElementById('online-count');
const membersTitleEl = document.getElementById('members-title');
const membersListEl = document.getElementById('members-list');
const meAvatarEl = document.getElementById('me-avatar');
const meNameEl = document.getElementById('me-name');

const GROUP_WINDOW_MS = 5 * 60 * 1000; // wiadomości tej samej osoby w 5 min są grupowane

let myNick = null;
let lastSenderId = null;
let lastMessageTime = 0;
let typingTimeout = null;
const typingUsers = new Set();

// ---------- Pomocnicze ----------
const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#ed4245', '#1abc9c', '#9b59b6', '#e67e22'];

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent = ochrona przed XSS
  return node;
}

function makeAvatar(nick, extraClass) {
  const a = el('div', 'avatar' + (extraClass ? ' ' + extraClass : ''), nick.charAt(0).toUpperCase());
  a.style.background = colorFor(nick);
  return a;
}

function addSystem(text) {
  const leave = text.includes('opuścił');
  messagesEl.appendChild(el('div', 'system' + (leave ? ' system--leave' : ''), text));
  lastSenderId = null;
  scrollToBottom();
}

function addMessage({ senderId, nick, text, time }) {
  const first = senderId !== lastSenderId || time - lastMessageTime > GROUP_WINDOW_MS;
  const wrap = el('div', 'msg' + (first ? ' msg--first' : ''));

  if (first) {
    wrap.appendChild(makeAvatar(nick, 'msg__avatar'));
    const head = el('div', 'msg__head');
    const author = el('span', 'msg__author', nick);
    author.style.color = colorFor(nick);
    head.appendChild(author);
    head.appendChild(el('span', 'msg__time', formatTime(time)));
    wrap.appendChild(head);
  } else {
    wrap.appendChild(el('span', 'msg__hovertime', formatTime(time)));
  }
  wrap.appendChild(el('div', 'msg__text', text));

  messagesEl.appendChild(wrap);
  lastSenderId = senderId;
  lastMessageTime = time;
  scrollToBottom();
}

function renderTyping() {
  const names = Array.from(typingUsers);
  if (names.length === 0) typingEl.textContent = '';
  else if (names.length === 1) typingEl.textContent = `${names[0]} pisze…`;
  else typingEl.textContent = `${names.join(', ')} piszą…`;
}

function renderMembers(list) {
  onlineEl.textContent = `${list.length} online`;
  membersTitleEl.textContent = `ONLINE — ${list.length}`;
  membersListEl.replaceChildren(
    ...list.map((nick) => {
      const row = el('div', 'member');
      row.appendChild(makeAvatar(nick, 'avatar--sm avatar--online'));
      const name = el('span', 'member__name', nick);
      name.style.color = colorFor(nick);
      row.appendChild(name);
      return row;
    })
  );
}

// ---------- Logowanie ----------
function join(nick) {
  socket.emit('join', nick, (res) => {
    if (!res || !res.ok) {
      loginError.textContent = (res && res.error) || 'Nie udało się dołączyć.';
      myNick = null;
      loginScreen.classList.remove('hidden');
      chatScreen.classList.add('hidden');
      return;
    }
    myNick = res.nick;
    loginError.textContent = '';
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    meNameEl.textContent = myNick;
    meAvatarEl.textContent = myNick.charAt(0).toUpperCase();
    meAvatarEl.style.background = colorFor(myNick);
    messageInput.focus();
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = nickInput.value.trim();
  if (!nick) return;
  join(nick);
});

// ---------- Wysyłanie ----------
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket.connected) return;
  socket.emit('message', text);
  socket.emit('typing', false);
  clearTimeout(typingTimeout);
  messageInput.value = '';
  messageInput.focus();
});

messageInput.addEventListener('input', () => {
  socket.emit('typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', false), 1500);
});

// ---------- Zdarzenia z serwera ----------
socket.on('message', addMessage);
socket.on('system', (m) => addSystem(m.text));
socket.on('users', renderMembers);

socket.on('typing', ({ nick, isTyping }) => {
  if (isTyping) typingUsers.add(nick);
  else typingUsers.delete(nick);
  renderTyping();
});

socket.on('connect', () => {
  statusEl.textContent = 'połączono';
  // Po utracie połączenia (np. uśpienie serwera na Renderze) dołącz ponownie automatycznie.
  if (myNick) join(myNick);
});

socket.on('disconnect', () => {
  statusEl.textContent = 'rozłączono – próba ponownego połączenia…';
  typingUsers.clear();
  renderTyping();
});
