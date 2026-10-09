const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
// Opcjonalny klucz do wyszukiwarki GIFów (darmowy: developers.giphy.com)
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

// Po ilu dniach wiadomości i pliki są usuwane (można zmienić zmienną RETENTION_DAYS).
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) > 0 ? Number(process.env.RETENTION_DAYS) : 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 100; // ile ostatnich wiadomości dostaje nowo dołączona osoba

const store = createStore({
  retentionMs: RETENTION_MS,
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  maxStorageBytes: (Number(process.env.MAX_STORAGE_MB) || 300) * 1024 * 1024,
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'mychat',
});

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
  res.json({
    gifSearch: Boolean(GIPHY_API_KEY),
    maxFileBytes: MAX_FILE_BYTES,
    retentionMs: RETENTION_MS,
    retentionDays: RETENTION_DAYS,
  });
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

async function emitMessage(socket, nick, extra) {
  const msg = {
    id: crypto.randomUUID(),
    senderId: socket.id,
    nick,
    time: Date.now(),
    ...extra,
  };
  io.emit('message', msg);
  try {
    await store.add(msg);
  } catch (err) {
    console.error('Nie udało się zapisać wiadomości:', err.message);
  }
}

io.on('connection', (socket) => {
  socket.on('join', async (payload, ack) => {
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

    if (!alreadyIn) {
      // Historia z ostatnich dni (pliki bez zawartości – pobierane na żądanie przez 'getFile').
      try {
        socket.emit('history', await store.recent(Date.now() - RETENTION_MS, HISTORY_LIMIT));
      } catch (err) {
        console.error('Nie udało się wczytać historii:', err.message);
        socket.emit('history', []);
      }
      systemMessage(`${nick} dołączył(a) do czatu`);
    }
    broadcastUsers();
  });

  socket.on('getFile', async (id, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (typeof id !== 'string' || id.length > 64) return reply({ ok: false, error: 'Nieprawidłowy plik.' });
    if (rateLimited(socket, 'getFile', 20, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo pobrań naraz.' });
    }
    try {
      const data = await store.fileData(id);
      if (!data) return reply({ ok: false, error: 'Ten plik wygasł lub został usunięty.' });
      reply({ ok: true, data });
    } catch (err) {
      console.error('Błąd odczytu pliku:', err.message);
      reply({ ok: false, error: 'Nie udało się pobrać pliku.' });
    }
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

  socket.on('file', async (payload, ack) => {
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
    await emitMessage(socket, user.nick, {
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

async function start() {
  await store.init();
  console.log(`Historia: ${store.label}, wiadomości i pliki usuwane po ${RETENTION_DAYS} dn.`);

  // Co 10 minut usuwamy przeterminowane wiadomości i pliki.
  setInterval(() => {
    store.prune().catch((err) => console.error('Błąd czyszczenia historii:', err.message));
  }, 10 * 60 * 1000).unref();

  // Przy zamykaniu (np. nowe wdrożenie na Renderze) zapisz stan historii.
  const shutdown = async () => {
    await store.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => {
    console.log(`Serwer czatu działa na porcie ${PORT}`);
    if (!GIPHY_API_KEY) console.log('Brak GIPHY_API_KEY – wyszukiwarka GIFów wyłączona (działa wklejanie linków).');
  });
}

start().catch((err) => {
  console.error('Nie udało się uruchomić serwera:', err);
  process.exit(1);
});
