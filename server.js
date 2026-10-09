const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// Opcjonalny klucz do wyszukiwarki GIFów (darmowy: developers.giphy.com)
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

const MAX_NICK_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_AVATAR_CHARS = 30000; // avatar jako mały data-URL (klient zmniejsza go do 128x128)

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Render używa tego endpointu do sprawdzania, czy aplikacja działa.
app.get('/health', (req, res) => res.send('OK'));

app.get('/api/config', (req, res) => {
  res.json({ gifSearch: Boolean(GIPHY_API_KEY), maxFileBytes: MAX_FILE_BYTES });
});

// Proxy do Giphy – klucz zostaje na serwerze i nie trafia do przeglądarki.
const gifCache = new Map();
app.get('/api/gifs', async (req, res) => {
  if (!GIPHY_API_KEY) return res.status(503).json({ error: 'no_key' });

  const q = String(req.query.q || '').trim().slice(0, 50);
  const cacheKey = q.toLowerCase();
  const cached = gifCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return res.json(cached.data);

  const params = new URLSearchParams({ api_key: GIPHY_API_KEY, limit: '24', rating: 'pg-13' });
  if (q) params.set('q', q);

  try {
    const r = await fetch(`https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`);
    if (!r.ok) throw new Error(`Giphy ${r.status}`);
    const json = await r.json();
    const data = (json.data || [])
      .map((g) => ({
        id: g.id,
        preview: g.images?.fixed_width_small?.url || g.images?.fixed_width?.url,
        url: g.images?.fixed_height?.url,
      }))
      .filter((g) => g.preview && g.url);

    if (gifCache.size > 200) gifCache.clear();
    gifCache.set(cacheKey, { time: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('Błąd Giphy:', err.message);
    res.status(502).json({ error: 'giphy_failed' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: MAX_FILE_BYTES + 512 * 1024,
});

// socket.id -> { nick, avatar }
const users = new Map();
let messageCounter = 0;

// ---------- Walidacja ----------
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanFileName(value) {
  if (typeof value !== 'string') return 'plik';
  const name = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 100);
  return name || 'plik';
}

function safeMime(value) {
  if (typeof value === 'string' && value.length <= 100 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)) {
    return value.toLowerCase();
  }
  return 'application/octet-stream';
}

function validAvatar(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AVATAR_CHARS &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}

function validImageUrl(value) {
  if (typeof value !== 'string' || value.length > 600) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /\.(gif|png|jpe?g|webp)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Prosty limit zapytań: maksymalnie `max` zdarzeń w oknie `windowMs`.
function rateLimited(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.buckets = socket.data.buckets || {};
  const recent = (socket.data.buckets[key] || []).filter((t) => now - t < windowMs);
  socket.data.buckets[key] = recent;
  if (recent.length >= max) return true;
  recent.push(now);
  return false;
}

// ---------- Wysyłanie do klientów ----------
function broadcastUsers() {
  io.emit(
    'users',
    Array.from(users.values()).map(({ nick, avatar }) => ({ nick, avatar }))
  );
}

function systemMessage(text) {
  io.emit('system', { text, time: Date.now() });
}

function emitMessage(socket, nick, extra) {
  io.emit('message', {
    id: ++messageCounter,
    senderId: socket.id,
    nick,
    time: Date.now(),
    ...extra,
  });
}

io.on('connection', (socket) => {
  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const nick = cleanText(payload && payload.nick, MAX_NICK_LENGTH);
    if (!nick) return reply({ ok: false, error: 'Podaj nick.' });

    const taken = Array.from(users.entries()).some(
      ([id, u]) => id !== socket.id && u.nick.toLowerCase() === nick.toLowerCase()
    );
    if (taken) return reply({ ok: false, error: 'Ten nick jest już zajęty.' });

    const avatar = validAvatar(payload.avatar) ? payload.avatar : null;
    const alreadyIn = users.has(socket.id);
    users.set(socket.id, { nick, avatar });

    reply({ ok: true, nick, id: socket.id });
    if (!alreadyIn) systemMessage(`${nick} dołączył(a) do czatu`);
    broadcastUsers();
  });

  socket.on('avatar', (value, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false });
    if (value !== null && !validAvatar(value)) {
      return reply({ ok: false, error: 'Nieprawidłowy avatar.' });
    }
    user.avatar = value;
    reply({ ok: true });
    broadcastUsers();
  });

  socket.on('message', (rawText) => {
    const user = users.get(socket.id);
    const text = cleanText(rawText, MAX_MESSAGE_LENGTH);
    if (!user || !text) return;
    if (rateLimited(socket, 'msg', 10, 10000)) return;
    emitMessage(socket, user.nick, { kind: 'text', text });
  });

  socket.on('gif', (url, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (!validImageUrl(url)) {
      return reply({ ok: false, error: 'Podaj bezpieczny link (https) do obrazka lub GIFa.' });
    }
    if (rateLimited(socket, 'gif', 5, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo GIFów naraz.' });
    }
    emitMessage(socket, user.nick, { kind: 'gif', url });
    reply({ ok: true });
  });

  socket.on('file', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });

    const data = payload && payload.data;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      return reply({ ok: false, error: 'Nieprawidłowy plik.' });
    }
    if (data.length > MAX_FILE_BYTES) {
      return reply({ ok: false, error: 'Plik jest za duży (maksymalnie 5 MB).' });
    }
    if (rateLimited(socket, 'file', 3, 15000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo plików naraz.' });
    }

    // Plik nie jest nigdzie zapisywany – serwer tylko przekazuje go dalej.
    emitMessage(socket, user.nick, {
      kind: 'file',
      name: cleanFileName(payload.name),
      mime: safeMime(payload.mime),
      size: data.length,
      data,
    });
    reply({ ok: true });
  });

  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.broadcast.emit('typing', { nick: user.nick, isTyping: Boolean(isTyping) });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    socket.broadcast.emit('typing', { nick: user.nick, isTyping: false });
    systemMessage(`${user.nick} opuścił(a) czat`);
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Serwer czatu działa na porcie ${PORT}`);
  if (!GIPHY_API_KEY) console.log('Brak GIPHY_API_KEY – wyszukiwarka GIFów wyłączona (działa wklejanie linków).');
});
