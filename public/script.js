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

let myNick = null;
let lastSenderId = null;
let typingTimeout = null;
const typingUsers = new Set();

// ---------- Pomocnicze ----------
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

function addSystem(text) {
  messagesEl.appendChild(el('div', 'system', text));
  lastSenderId = null;
  scrollToBottom();
}

function addMessage({ senderId, nick, text, time }) {
  const own = senderId === socket.id;
  const first = senderId !== lastSenderId;

  const wrap = el('div', 'msg' + (own ? ' msg--own' : '') + (first ? ' msg--first' : ''));
  if (first && !own) wrap.appendChild(el('span', 'msg__author', nick));
  wrap.appendChild(el('div', 'msg__bubble', text));
  wrap.appendChild(el('span', 'msg__time', formatTime(time)));

  messagesEl.appendChild(wrap);
  lastSenderId = senderId;
  scrollToBottom();
}

function renderTyping() {
  const names = Array.from(typingUsers);
  if (names.length === 0) typingEl.textContent = '';
  else if (names.length === 1) typingEl.textContent = `${names[0]} pisze…`;
  else typingEl.textContent = `${names.join(', ')} piszą…`;
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

socket.on('users', (list) => {
  onlineEl.textContent = `${list.length} online`;
});

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
