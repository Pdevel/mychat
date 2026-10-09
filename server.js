const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_NICK_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Render używa tego endpointu do sprawdzania, czy aplikacja działa.
app.get('/health', (req, res) => res.send('OK'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// socket.id -> nick (tylko użytkownicy, którzy dołączyli do czatu)
const users = new Map();

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function broadcastUsers() {
  io.emit('users', Array.from(users.values()));
}

function systemMessage(text) {
  io.emit('system', { text, time: Date.now() });
}

io.on('connection', (socket) => {
  socket.on('join', (rawNick, ack) => {
    const nick = cleanText(rawNick, MAX_NICK_LENGTH);
    if (!nick) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Podaj nick.' });
      return;
    }
    const taken = Array.from(users.values()).some(
      (n) => n.toLowerCase() === nick.toLowerCase()
    );
    if (taken) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Ten nick jest już zajęty.' });
      return;
    }

    users.set(socket.id, nick);
    if (typeof ack === 'function') ack({ ok: true, nick, id: socket.id });
    systemMessage(`${nick} dołączył(a) do czatu`);
    broadcastUsers();
  });

  socket.on('message', (rawText) => {
    const nick = users.get(socket.id);
    const text = cleanText(rawText, MAX_MESSAGE_LENGTH);
    if (!nick || !text) return;

    io.emit('message', {
      senderId: socket.id,
      nick,
      text,
      time: Date.now(),
    });
  });

  socket.on('typing', (isTyping) => {
    const nick = users.get(socket.id);
    if (!nick) return;
    socket.broadcast.emit('typing', { nick, isTyping: Boolean(isTyping) });
  });

  socket.on('disconnect', () => {
    const nick = users.get(socket.id);
    if (!nick) return;
    users.delete(socket.id);
    socket.broadcast.emit('typing', { nick, isTyping: false });
    systemMessage(`${nick} opuścił(a) czat`);
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Serwer czatu działa na porcie ${PORT}`);
});
